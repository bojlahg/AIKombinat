import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({
  retryExecutionRound: vi.fn(),
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
