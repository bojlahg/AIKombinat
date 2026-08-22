import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({
  getTodoById: vi.fn(),
  createSchedule: vi.fn(() => ({ id: 'schedule-1' })),
  deleteTodo: vi.fn(),
  registerOnceJob: vi.fn(),
  getResetsAt: vi.fn(() => 1_800_000_000),
}));

vi.mock('../../db/queries.js', () => ({
  getTodoById: mocks.getTodoById,
  createSchedule: mocks.createSchedule,
  deleteTodo: mocks.deleteTodo,
}));
vi.mock('../../services/scheduler.js', () => ({ scheduler: { registerOnceJob: mocks.registerOnceJob } }));
vi.mock('../../services/log-streamer.js', () => ({ logStreamer: { getResetsAt: mocks.getResetsAt } }));
vi.mock('../images.js', () => ({ cleanupTodoImages: vi.fn() }));

const router = (await import('../schedules.js')).default;
let server: Server;
let baseUrl: string;

const todo = {
  id: 'todo-1', project_id: 'project-1', title: 'Preserve me', description: 'Details', status: 'pending',
  cli_tool: 'codex', cli_model: 'gpt-5.1', effort_level: 4, max_turns: 23, use_worktree: 0,
  memory_inject_mode: 'selected', memory_node_ids: '["node-1"]', memory_raw_file_paths: '["guide.md"]',
};

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
  mocks.getTodoById.mockReturnValue(todo);
  mocks.createSchedule.mockReturnValue({ id: 'schedule-1' });
  mocks.getResetsAt.mockReturnValue(1_800_000_000);
});

describe('todo scheduling conversion', () => {
  it('preserves model, effort, and execution settings for a one-time schedule', async () => {
    const response = await fetch(`${baseUrl}/api/todos/todo-1/schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_at: '2027-01-02T03:04:05.000Z', keep_original: true }),
    });
    expect(response.status).toBe(201);
    expect(mocks.createSchedule).toHaveBeenCalledWith(
      'project-1', 'Preserve me', 'Details', '* * * * *', 'codex', 'gpt-5.1', 1, 'once',
      '2027-01-02T03:04:05.000Z', 4, 23, 0, 'selected', '["node-1"]', '["guide.md"]', undefined, undefined,
    );
  });

  it('preserves model, effort, and execution settings when scheduling on reset', async () => {
    const response = await fetch(`${baseUrl}/api/todos/todo-1/schedule-on-reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Continue after reset' }),
    });
    expect(response.status).toBe(201);
    expect(mocks.createSchedule).toHaveBeenCalledWith(
      'project-1', '[Reset] Continue after reset', 'Continue after reset', '* * * * *', 'codex', 'gpt-5.1', 1, 'once',
      new Date(1_800_000_000 * 1000).toISOString(), 4, 23, 0, 'selected', '["node-1"]', '["guide.md"]', undefined, undefined,
    );
  });
});
