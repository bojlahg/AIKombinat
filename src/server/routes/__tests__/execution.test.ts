import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({
  retryExecutionRound: vi.fn(),
  getTodoById: vi.fn(),
  getProjectById: vi.fn(),
  updateTodoStatus: vi.fn(),
  updateTodo: vi.fn(),
  deleteTaskLogsByTodoId: vi.fn(),
  createTaskLog: vi.fn(),
  cleanupWorktree: vi.fn(),
  startTodo: vi.fn(),
}));

vi.mock('../../services/execution-round-retry.js', () => {
  class RetryConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RetryConflictError';
    }
  }
  class RoundNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RoundNotFoundError';
    }
  }
  class TodoNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TodoNotFoundError';
    }
  }

  return {
    executionRoundRetryService: {
      retryExecutionRound: mocks.retryExecutionRound,
    },
    RetryConflictError,
    RoundNotFoundError,
    TodoNotFoundError,
  };
});

vi.mock('../../db/queries.js', () => ({
  getTodoById: mocks.getTodoById,
  getProjectById: mocks.getProjectById,
  updateTodoStatus: mocks.updateTodoStatus,
  updateTodo: mocks.updateTodo,
  deleteTaskLogsByTodoId: mocks.deleteTaskLogsByTodoId,
  createTaskLog: mocks.createTaskLog,
  getExecutionRoundById: vi.fn(),
  getExecutionRoundsByTodoId: vi.fn(() => []),
  getActiveExecutionRound: vi.fn(),
  getLatestExecutionRound: vi.fn(),
}));

vi.mock('../../services/worktree-manager.js', () => ({
  worktreeManager: {
    cleanupWorktree: mocks.cleanupWorktree,
    isValidWorktree: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock('../../services/orchestrator.js', () => ({
  orchestrator: {
    startTodo: mocks.startTodo,
    stopTodo: vi.fn(),
    isStopping: vi.fn(() => false),
  },
}));

const router = (await import('../execution.js')).default;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Execution Routes - Round Retry', () => {
  it('returns 200 and todo + round when retry succeeds', async () => {
    const mockTodo = { id: 'todo-1', status: 'running' };
    const mockRound = { id: 'round-2', phase: 'implementation', status: 'running', round_index: 2, attempt_index: 2 };
    mocks.retryExecutionRound.mockResolvedValue({ todo: mockTodo, round: mockRound });

    const response = await fetch(`${baseUrl}/api/todos/todo-1/rounds/round-1/retry`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.todo).toEqual(mockTodo);
    expect(body.round).toEqual(mockRound);
    expect(mocks.retryExecutionRound).toHaveBeenCalledWith('todo-1', 'round-1');
  });

  it('returns 404 when todo or round is not found', async () => {
    const { TodoNotFoundError } = await import('../../services/execution-round-retry.js');
    mocks.retryExecutionRound.mockRejectedValue(new TodoNotFoundError('Task not found.'));

    const response = await fetch(`${baseUrl}/api/todos/nonexistent/rounds/round-1/retry`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Task not found.');
  });

  it('returns 409 when retry conflict occurs', async () => {
    const { RetryConflictError } = await import('../../services/execution-round-retry.js');
    mocks.retryExecutionRound.mockRejectedValue(new RetryConflictError('Execution round is not retryable.'));

    const response = await fetch(`${baseUrl}/api/todos/todo-1/rounds/round-1/retry`, {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('Execution round is not retryable.');
  });
});

describe('Execution Routes - Legacy Todo Retry', () => {
  it('rejects reviewed todo with 409 and mutates nothing', async () => {
    mocks.getTodoById.mockReturnValue({
      id: 'todo-reviewed',
      project_id: 'project-1',
      title: 'Reviewed task',
      status: 'failed',
      review_enabled: 1,
      worktree_path: '/path/to/worktree',
      branch_name: 'feature/branch',
    });

    const response = await fetch(`${baseUrl}/api/todos/todo-reviewed/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'headless' }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('Todo-level Retry is not supported for reviewed pipeline tasks');
    expect(mocks.cleanupWorktree).not.toHaveBeenCalled();
    expect(mocks.deleteTaskLogsByTodoId).not.toHaveBeenCalled();
    expect(mocks.updateTodoStatus).not.toHaveBeenCalled();
    expect(mocks.startTodo).not.toHaveBeenCalled();
  });

  it('permits legacy retry for non-reviewed todo', async () => {
    mocks.getTodoById.mockReturnValue({
      id: 'todo-normal',
      project_id: 'project-1',
      title: 'Normal task',
      status: 'failed',
      review_enabled: 0,
      worktree_path: '/path/to/worktree',
      branch_name: 'feature/branch',
      cli_tool: 'claude',
    });
    mocks.getProjectById.mockReturnValue({
      id: 'project-1',
      path: '/path/to/repo',
      cli_tool: 'claude',
    });

    const response = await fetch(`${baseUrl}/api/todos/todo-normal/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'headless' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe('todo-normal');
    expect(mocks.cleanupWorktree).toHaveBeenCalledWith('/path/to/repo', '/path/to/worktree', 'feature/branch');
    expect(mocks.deleteTaskLogsByTodoId).toHaveBeenCalledWith('todo-normal');
    expect(mocks.updateTodoStatus).toHaveBeenCalledWith('todo-normal', 'pending');
    expect(mocks.startTodo).toHaveBeenCalledWith('todo-normal', 'headless');
  });
});
