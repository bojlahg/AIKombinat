import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/connection.js';
import {
  type Todo,
  type TodoExecutionRound,
  getTodoById,
  getExecutionRoundById,
  getLatestExecutionRound,
  getActiveExecutionRound,
  getNextExecutionRoundIndex,
  createExecutionRound,
  updateTodo,
  updateTodoStatus,
  createTaskLog,
} from '../db/queries.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { orchestrator } from './orchestrator.js';
import { resourceManager } from './resource-manager.js';
import { executorPool } from './executor-pool.js';

export class TodoNotFoundError extends Error {
  constructor(message = 'Todo not found') {
    super(message);
    this.name = 'TodoNotFoundError';
  }
}

export class RoundNotFoundError extends Error {
  constructor(message = 'Execution round not found') {
    super(message);
    this.name = 'RoundNotFoundError';
  }
}

export class RetryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryConflictError';
  }
}

export class ExecutionRoundRetryService {
  /**
   * Retry a failed or stopped execution round.
   * Creates a new execution round while keeping the source round immutable in history.
   */
  async retryExecutionRound(
    todoId: string,
    roundId: string
  ): Promise<{ todo: Todo; round: TodoExecutionRound }> {
    const todo = getTodoById(todoId);
    if (!todo) {
      throw new TodoNotFoundError('Todo not found');
    }

    if (!todo.review_enabled) {
      throw new RetryConflictError('Review is not enabled for this task.');
    }

    if (todo.status !== 'failed' && todo.status !== 'stopped') {
      throw new RetryConflictError(`Task is not retryable from status ${todo.status}. Only failed or stopped tasks can be retried.`);
    }

    const sourceRound = getExecutionRoundById(roundId);
    if (!sourceRound) {
      throw new RoundNotFoundError('Execution round not found');
    }

    if (sourceRound.todo_id !== todoId) {
      throw new RetryConflictError('Execution round does not belong to this task.');
    }

    if (sourceRound.status !== 'failed' && sourceRound.status !== 'stopped') {
      throw new RetryConflictError(`Execution round is not retryable from status ${sourceRound.status}.`);
    }

    const latestRound = getLatestExecutionRound(todoId);
    if (!latestRound || latestRound.id !== roundId) {
      throw new RetryConflictError('Only the latest failed/stopped execution round can be retried.');
    }

    if (orchestrator.isStopping(todoId)) {
      throw new RetryConflictError('Task is currently stopping.');
    }

    if (todo.process_pid && todo.process_pid > 0) {
      try {
        process.kill(todo.process_pid, 0);
        throw new RetryConflictError('Task has a running process and cannot be retried until it exits.');
      } catch (err) {
        if (err instanceof RetryConflictError) throw err;
        // Process is dead, proceed
      }
    }

    const activeRound = getActiveExecutionRound(todoId);
    if (activeRound) {
      throw new RetryConflictError('Another execution round is already active for this task.');
    }

    if (!sourceRound.input_payload || !sourceRound.input_payload.trim()) {
      throw new RetryConflictError('Cannot retry this execution round because its persisted input payload is missing.');
    }

    const db = getDatabase();
    let newRound: TodoExecutionRound | undefined;

    db.transaction(() => {
      const freshTodo = getTodoById(todoId);
      if (!freshTodo) throw new TodoNotFoundError('Todo not found');

      if (freshTodo.status !== 'failed' && freshTodo.status !== 'stopped') {
        throw new RetryConflictError(`Task is not retryable from status ${freshTodo.status}. Only failed or stopped tasks can be retried.`);
      }

      const freshRound = getExecutionRoundById(roundId);
      if (!freshRound) throw new RoundNotFoundError('Execution round not found');

      if (freshRound.status !== 'failed' && freshRound.status !== 'stopped') {
        throw new RetryConflictError(`Execution round is not retryable from status ${freshRound.status}.`);
      }

      const freshLatest = getLatestExecutionRound(todoId);
      if (!freshLatest || freshLatest.id !== roundId || (freshLatest.status !== 'failed' && freshLatest.status !== 'stopped')) {
        throw new RetryConflictError('Only the latest failed/stopped execution round can be retried.');
      }

      const freshActive = getActiveExecutionRound(todoId);
      if (freshActive) {
        throw new RetryConflictError('Another execution round is already active for this task.');
      }

      const nextRoundIndex = getNextExecutionRoundIndex(todoId);
      const attemptIndex = (freshRound.attempt_index && freshRound.attempt_index >= 1 ? freshRound.attempt_index : 1) + 1;
      const newRunToken = uuidv4();

      newRound = createExecutionRound(
        todoId,
        freshRound.phase,
        nextRoundIndex,
        newRunToken,
        {
          status: 'pending',
          inputPayload: freshRound.input_payload,
          retryOfRoundId: freshRound.id,
          attemptIndex,
        }
      );

      updateTodo(todoId, {
        pipeline_phase: freshRound.phase,
        process_pid: 0,
        execution_snapshot: null,
      });
      updateTodoStatus(todoId, 'pending');

      createTaskLog(
        todoId,
        'info',
        `Retry triggered for ${freshRound.phase} phase (Attempt ${attemptIndex}).`,
        nextRoundIndex
      );
    })();

    if (!newRound) {
      throw new Error('Failed to create retry round.');
    }

    // Release any stale resources / reservations from previous runs
    resourceManager.releaseOwner('todo', todoId);
    executorPool.releaseReservation(todoId);

    broadcaster.broadcast({ type: 'todo:round-created', todoId, round: newRound });
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'pending' });

    // Trigger orchestrator execution path
    await orchestrator.startTodo(todoId);

    return {
      todo: getTodoById(todoId)!,
      round: newRound,
    };
  }
}

export const executionRoundRetryService = new ExecutionRoundRetryService();
