import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule } from '../../db/queries.js';

const mocks = vi.hoisted(() => ({
  cronCallback: undefined as (() => void) | undefined,
  getScheduleById: vi.fn(),
  getTodosByScheduleId: vi.fn(() => []),
  createTodo: vi.fn(() => ({ id: 'todo-1' })),
  createScheduleRun: vi.fn(() => ({
    id: 'run-1', schedule_id: 'schedule-1', todo_id: 'todo-1', status: 'triggered',
    skip_reason: null, started_at: null, completed_at: null, created_at: '2026-08-22T10:00:00.000Z',
  })),
  getScheduleRunsByScheduleId: vi.fn(),
  updateScheduleLastRun: vi.fn(),
  updateScheduleStatus: vi.fn(),
  updateScheduleRun: vi.fn(),
  startTodo: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: {
    validate: vi.fn(() => true),
    schedule: vi.fn((_expression: string, callback: () => void) => {
      mocks.cronCallback = callback;
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock('../../db/queries.js', () => ({
  getActiveSchedules: vi.fn(() => []),
  getScheduleById: mocks.getScheduleById,
  getTodosByScheduleId: mocks.getTodosByScheduleId,
  createTodo: mocks.createTodo,
  createScheduleRun: mocks.createScheduleRun,
  getScheduleRunsByScheduleId: mocks.getScheduleRunsByScheduleId,
  updateScheduleLastRun: mocks.updateScheduleLastRun,
  updateScheduleStatus: mocks.updateScheduleStatus,
  updateScheduleRun: mocks.updateScheduleRun,
}));

vi.mock('../orchestrator.js', () => ({ orchestrator: { startTodo: mocks.startTodo } }));
vi.mock('../../websocket/broadcaster.js', () => ({ broadcaster: { broadcast: mocks.broadcast } }));

import { Scheduler } from '../scheduler.js';

const pausedSchedule: Schedule = {
  id: 'schedule-1',
  project_id: 'project-1',
  title: 'Nightly',
  description: null,
  cron_expression: '0 0 * * *',
  cli_tool: 'antigravity',
  cli_model: 'gemini-2.5-pro',
  effort_level: 5,
  max_turns: 12,
  use_worktree: 1,
  memory_inject_mode: 'selected',
  memory_node_ids: '["node-1"]',
  memory_raw_file_paths: '["notes.md"]',
  is_active: 0,
  skip_if_running: 0,
  last_run_at: null,
  next_run_at: null,
  schedule_type: 'recurring',
  run_at: null,
  created_at: '2026-08-22T09:00:00.000Z',
  updated_at: '2026-08-22T09:00:00.000Z',
};

describe('Scheduler execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T10:00:00.000Z'));
    mocks.cronCallback = undefined;
    mocks.getScheduleById.mockReturnValue(pausedSchedule);
    mocks.getScheduleRunsByScheduleId.mockReturnValue([mocks.createScheduleRun()]);
    mocks.createScheduleRun.mockClear();
  });

  it('manually triggers a paused schedule', async () => {
    const scheduler = new Scheduler();

    const run = await scheduler.triggerSchedule(pausedSchedule.id);

    expect(run?.id).toBe('run-1');
    expect(mocks.createTodo).toHaveBeenCalledWith(
      'project-1',
      '[Schedule] Nightly - 2026-08-22T10:00:00.000Z',
      undefined,
      0,
      'antigravity',
      'gemini-2.5-pro',
      'schedule-1',
      undefined,
      12,
      1,
      'selected',
      '["node-1"]',
      '["notes.md"]',
      undefined,
      5,
    );
    expect(mocks.createScheduleRun).toHaveBeenCalledOnce();
    expect(mocks.startTodo).toHaveBeenCalledWith('todo-1');
  });

  it('does not run a paused schedule from the scheduler callback', async () => {
    const scheduler = new Scheduler();
    scheduler.registerJob(pausedSchedule);

    mocks.cronCallback?.();
    await vi.runAllTimersAsync();

    expect(mocks.createTodo).not.toHaveBeenCalled();
    expect(mocks.createScheduleRun).not.toHaveBeenCalled();
    expect(mocks.startTodo).not.toHaveBeenCalled();
  });
});
