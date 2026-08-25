import cron, { type ScheduledTask } from 'node-cron';
import * as queries from '../db/queries.js';
import { orchestrator } from './orchestrator.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { logger } from '../logging/logger.js';

export class Scheduler {
  private jobs: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /**
   * Initialize all active schedules on server startup.
   */
  initialize(): void {
    const activeSchedules = queries.getActiveSchedules();
    for (const schedule of activeSchedules) {
      if (schedule.schedule_type === 'once') {
        this.registerOnceJob(schedule);
      } else {
        this.registerJob(schedule);
      }
    }
    if (activeSchedules.length > 0) {
      logger.info('scheduler.initialized', {
        scope: '[scheduler]',
        msg: `${activeSchedules.length} active schedule(s)`,
        count: activeSchedules.length,
      });
    }
  }

  /**
   * Register a cron job for a schedule.
   */
  registerJob(schedule: queries.Schedule): void {
    // Unregister existing job if any
    this.unregisterJob(schedule.id);

    if (!cron.validate(schedule.cron_expression)) {
      logger.error('scheduler.invalid-cron', {
        scope: '[scheduler]',
        msg: `invalid cron expression for schedule "${schedule.title}"`,
        scheduleId: schedule.id,
        cron: schedule.cron_expression,
      });
      return;
    }

    const task = cron.schedule(schedule.cron_expression, () => {
      this.executeSchedule(schedule.id, 'scheduled').catch((err) => {
        logger.error('scheduler.execution-error', {
          scope: '[scheduler]',
          msg: `schedule "${schedule.title}" execution failed`,
          scheduleId: schedule.id,
          err,
        });
      });
    });

    this.jobs.set(schedule.id, task);
  }

  /**
   * Register a one-time scheduled job using setTimeout.
   */
  registerOnceJob(schedule: queries.Schedule): void {
    this.unregisterJob(schedule.id);

    if (!schedule.run_at) {
      logger.error('scheduler.missing-run-at', {
        scope: '[scheduler]',
        msg: `one-time schedule "${schedule.title}" has no run_at time`,
        scheduleId: schedule.id,
      });
      return;
    }

    const runAtMs = new Date(schedule.run_at).getTime();
    const delay = runAtMs - Date.now();

    if (delay <= 0) {
      // run_at is in the past — execute immediately
      logger.warn('scheduler.late-run', {
        scope: '[scheduler]',
        msg: `one-time schedule "${schedule.title}" run_at is in the past, executing now`,
        scheduleId: schedule.id,
      });
      this.executeSchedule(schedule.id, 'scheduled').catch((err) => {
        logger.error('scheduler.execution-error', {
          scope: '[scheduler]',
          msg: `one-time schedule "${schedule.title}" execution failed`,
          scheduleId: schedule.id,
          err,
        });
      });
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(schedule.id);
      this.executeSchedule(schedule.id, 'scheduled').catch((err) => {
        logger.error('scheduler.execution-error', {
          scope: '[scheduler]',
          msg: `one-time schedule "${schedule.title}" execution failed`,
          scheduleId: schedule.id,
          err,
        });
      });
    }, delay);

    this.timers.set(schedule.id, timer);
    logger.info('scheduler.registered', {
      scope: '[scheduler]',
      msg: `one-time schedule "${schedule.title}" registered, fires in ${Math.round(delay / 1000)}s`,
      scheduleId: schedule.id,
      delaySeconds: Math.round(delay / 1000),
    });
  }

  /**
   * Unregister a cron job or timer.
   */
  unregisterJob(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
    }
    const timer = this.timers.get(scheduleId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(scheduleId);
    }
  }

  /**
   * Core execution logic shared by scheduled and manual runs.
   */
  private async executeSchedule(scheduleId: string, source: 'scheduled' | 'manual'): Promise<void> {
    const schedule = queries.getScheduleById(scheduleId);
    if (!schedule || (source === 'scheduled' && !schedule.is_active)) return;

    const now = new Date().toISOString();

    // Check skip-if-running condition
    if (schedule.skip_if_running) {
      const scheduleTodos = queries.getTodosByScheduleId(scheduleId);
      const hasRunning = scheduleTodos.some((t) => ['running', 'waiting_executor', 'waiting_resource'].includes(t.status));
      if (hasRunning) {
        const run = queries.createScheduleRun(scheduleId, null, 'skipped', 'previous_run_still_active');
        broadcaster.broadcast({
          type: 'schedule:run-skipped',
          scheduleId,
          runId: run.id,
          reason: 'previous_run_still_active',
        });
        queries.updateScheduleLastRun(scheduleId, now);
        return;
      }
    }

    // Create todo from schedule template
    const todoTitle = `[Schedule] ${schedule.title} - ${now}`;
    const todo = queries.createTodo(
      schedule.project_id,
      todoTitle,
      schedule.description ?? undefined,
      0,
      schedule.cli_tool ?? undefined,
      schedule.cli_model ?? undefined,
      scheduleId,
      undefined,
      schedule.max_turns ?? undefined,
      schedule.use_worktree,
      schedule.memory_inject_mode ?? undefined,
      schedule.memory_node_ids,
      schedule.memory_raw_file_paths,
      undefined,
      schedule.execution_profile_id,
      schedule.cli_effort,
      schedule.cli_model_id,
      schedule.resource_requirements,
      schedule.review_enabled ?? 0,
      schedule.review_profile_id,
      schedule.rework_profile_id,
      schedule.max_review_rounds ?? 3,
    );

    // Create run record
    const run = queries.createScheduleRun(scheduleId, todo.id, 'triggered');

    // Update last run
    queries.updateScheduleLastRun(scheduleId, now);

    // Broadcast
    broadcaster.broadcast({
      type: 'schedule:run-triggered',
      scheduleId,
      runId: run.id,
      todoId: todo.id,
    });

    // Auto-deactivate one-time schedules after execution
    if (schedule.schedule_type === 'once') {
      queries.updateScheduleStatus(schedule.id, 0);
      this.unregisterJob(schedule.id);
      broadcaster.broadcast({ type: 'schedule:status-changed', scheduleId: schedule.id, isActive: false });
    }

    // Start the todo
    try {
      await orchestrator.startTodo(todo.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('scheduler.start-failed', {
        scope: '[scheduler]',
        msg: `schedule "${schedule.title}" failed to start its task`,
        scheduleId: schedule.id,
        message,
      });
      queries.updateScheduleRun(run.id, { status: 'failed', completed_at: new Date().toISOString() });
    }
  }

  /**
   * Manually trigger a schedule run (for testing / on-demand).
   */
  async triggerSchedule(scheduleId: string): Promise<queries.ScheduleRun | null> {
    const schedule = queries.getScheduleById(scheduleId);
    if (!schedule) return null;

    await this.executeSchedule(scheduleId, 'manual');

    // Return the latest run
    const runs = queries.getScheduleRunsByScheduleId(scheduleId, 1);
    return runs[0] ?? null;
  }

  /**
   * Activate a schedule and register its cron job.
   */
  activateSchedule(scheduleId: string): queries.Schedule | undefined {
    const schedule = queries.updateScheduleStatus(scheduleId, 1);
    if (schedule) {
      if (schedule.schedule_type === 'once') {
        this.registerOnceJob(schedule);
      } else {
        this.registerJob(schedule);
      }
      broadcaster.broadcast({ type: 'schedule:status-changed', scheduleId, isActive: true });
    }
    return schedule;
  }

  /**
   * Pause a schedule and unregister its cron job.
   */
  pauseSchedule(scheduleId: string): queries.Schedule | undefined {
    const schedule = queries.updateScheduleStatus(scheduleId, 0);
    if (schedule) {
      this.unregisterJob(scheduleId);
      broadcaster.broadcast({ type: 'schedule:status-changed', scheduleId, isActive: false });
    }
    return schedule;
  }

  /**
   * Stop all cron jobs (for server shutdown).
   */
  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

export const scheduler = new Scheduler();
