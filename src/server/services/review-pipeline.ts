import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/connection.js';
import {
  type Todo,
  type Project,
  type TodoExecutionRound,
  getTodoById,
  getProjectById,
  createExecutionRound,
  getExecutionRoundsByTodoId,
  getExecutionRoundById,
  getActiveExecutionRound,
  getLatestExecutionRound,
  updateExecutionRound,
  updateTodo,
  updateTodoStatus,
  createTaskLog,
} from '../db/queries.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { createGit, resolveLocalBaseBranch } from '../lib/git.js';
import { parseReviewResult } from './review-result-parser.js';
import type { ReviewResult, ReviewIssue } from './review-result.js';

export interface AdvanceRoundResult {
  action: 'start_review' | 'start_rework' | 'completed' | 'failed' | 'max_rounds_reached';
  nextRound?: TodoExecutionRound;
  reviewResult?: ReviewResult;
  reason?: string;
}

export class ReviewPipelineService {
  /**
   * Ensure that an initial implementation round exists when review_enabled = 1.
   */
  ensureInitialRound(todoId: string): TodoExecutionRound | undefined {
    const todo = getTodoById(todoId);
    if (!todo || !todo.review_enabled) return undefined;

    const existingRounds = getExecutionRoundsByTodoId(todoId);
    if (existingRounds.length > 0) {
      return existingRounds[0];
    }

    const runToken = uuidv4();
    const round = createExecutionRound(todoId, 'implementation', 1, runToken, {
      status: 'pending',
      inputPayload: todo.description ?? todo.title,
    });
    updateTodo(todoId, { pipeline_phase: 'implementation' });
    broadcaster.broadcast({ type: 'todo:round-created', todoId, round });
    return round;
  }

  /**
   * Collect git diff summary for the review phase.
   */
  async collectDiffSummary(todo: Todo, project: Project): Promise<string> {
    if (!project.is_git_repo) {
      return '(Not a Git repository — diff unavailable)';
    }

    const workDir = todo.worktree_path || project.path;
    const git = createGit(workDir);

    try {
      const baseBranch = (await resolveLocalBaseBranch(git, project.default_branch)) || project.default_branch;
      let statSummary = '';
      let diffText = '';

      try {
        statSummary = await git.diff([`${baseBranch}...HEAD`, '--stat']);
      } catch {
        statSummary = await git.diff([baseBranch, '--stat']).catch(() => '');
      }

      try {
        diffText = await git.diff([`${baseBranch}...HEAD`]);
      } catch {
        diffText = await git.diff([baseBranch]).catch(() => '');
      }

      const MAX_DIFF_BYTES = 50 * 1024;
      let truncatedDiff = diffText;
      if (Buffer.byteLength(truncatedDiff, 'utf8') > MAX_DIFF_BYTES) {
        truncatedDiff = truncatedDiff.slice(0, MAX_DIFF_BYTES) + '\n\n... (Diff truncated for review prompt length limit)';
      }

      return [
        '### Git Diff Summary',
        statSummary ? statSummary.trim() : 'No changed files stat available.',
        '### Git Diff Content',
        truncatedDiff ? truncatedDiff.trim() : 'No code changes detected in diff.',
      ].join('\n\n');
    } catch (err) {
      return `Failed to compute git diff: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Build prompt for review phase.
   */
  buildReviewPrompt(params: {
    todo: Todo;
    project: Project;
    roundIndex: number;
    attemptNumber: number;
    maxAttempts: number;
    diffSummary: string;
    previousIssues?: ReviewIssue[];
  }): string {
    const { todo, attemptNumber, maxAttempts, diffSummary, previousIssues } = params;

    const sections: string[] = [];

    sections.push('# Automated Code Review Request');
    sections.push(`You are performing Review Round ${attemptNumber} of ${maxAttempts} for the following task.`);
    sections.push(`## Task Title\n${todo.title}`);
    if (todo.description) {
      sections.push(`## Task Description\n${todo.description}`);
    }

    if (previousIssues && previousIssues.length > 0) {
      sections.push('## Previous Review Issues (Fixes expected in this round)');
      previousIssues.forEach((issue, idx) => {
        sections.push(`${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.description}${issue.files?.length ? ` (Files: ${issue.files.join(', ')})` : ''}`);
      });
    }

    sections.push(`## Changes Under Review\n${diffSummary}`);

    sections.push(`## Review Output Instructions
You MUST respond with a valid JSON object (either directly or inside a \`\`\`json markdown block).
Do not include conversational preamble outside the JSON block.

JSON Schema:
\`\`\`json
{
  "verdict": "approved" | "needs_changes",
  "summary": "Clear, concise summary of the review findings.",
  "issues": [
    {
      "severity": "blocking" | "major" | "minor",
      "description": "Specific issue description and why it fails requirements.",
      "files": ["optional/path/to/file.ts"]
    }
  ]
}
\`\`\`

- Return \`"verdict": "approved"\` with an empty \`"issues": []\` array if the implementation fulfills the task and has no blocking/major flaws.
- Return \`"verdict": "needs_changes"\` with actionable issues if bugs, omissions, or blocking deficiencies exist.`);

    return sections.join('\n\n');
  }

  /**
   * Build prompt for rework phase.
   */
  buildReworkPrompt(params: {
    todo: Todo;
    reviewResult: ReviewResult;
    roundIndex: number;
  }): string {
    const { todo, reviewResult, roundIndex } = params;

    const sections: string[] = [];

    sections.push('# Rework Request — Code Review Feedback');
    sections.push(`The automated code review for "${todo.title}" returned \`needs_changes\`.`);
    sections.push(`## Reviewer Summary\n${reviewResult.summary}`);

    sections.push('## Issues to Address:');
    reviewResult.issues.forEach((issue, idx) => {
      const fileInfo = issue.files && issue.files.length > 0 ? ` [Files: ${issue.files.join(', ')}]` : '';
      sections.push(`${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.description}${fileInfo}`);
    });

    sections.push(`## Original Task Description\n${todo.description ?? todo.title}`);

    sections.push(`## Instructions
Please fix each of the issues identified above in the codebase.
Make targeted changes to resolve the feedback without modifying unrelated code.
When done, ensure all tests pass.`);

    return sections.join('\n\n');
  }

  /**
   * Advance round on successful process completion.
   */
  async advanceRoundOnSuccess(
    todoId: string,
    currentRoundId: string,
    processOutput = ''
  ): Promise<AdvanceRoundResult> {
    const todo = getTodoById(todoId);
    if (!todo) return { action: 'failed', reason: 'todo_not_found' };

    const project = getProjectById(todo.project_id);
    if (!project) return { action: 'failed', reason: 'project_not_found' };

    const currentRound = getExecutionRoundById(currentRoundId);
    if (!currentRound) return { action: 'failed', reason: 'round_not_found' };

    const now = new Date().toISOString();

    if (currentRound.phase === 'implementation') {
      // Mark implementation round completed
      updateExecutionRound(currentRoundId, {
        status: 'completed',
        finished_at: now,
      });
      const updatedCurrent = getExecutionRoundById(currentRoundId)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });

      // Resolve review profile
      const reviewProfileId = todo.review_profile_id ?? project.default_review_profile_id;
      if (!reviewProfileId) {
        const errorMsg = 'Configuration error: Review profile is not configured (todo.review_profile_id is null and project has no default_review_profile_id).';
        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'failed');
        createTaskLog(todoId, 'error', errorMsg, currentRound.round_index);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
        return { action: 'failed', reason: 'review_profile_missing' };
      }

      const diffSummary = await this.collectDiffSummary(todo, project);
      const reviewPrompt = this.buildReviewPrompt({
        todo,
        project,
        roundIndex: currentRound.round_index + 1,
        attemptNumber: 1,
        maxAttempts: todo.max_review_rounds,
        diffSummary,
      });

      const nextRunToken = uuidv4();
      const nextRound = createExecutionRound(
        todoId,
        'review',
        currentRound.round_index + 1,
        nextRunToken,
        {
          status: 'pending',
          inputPayload: reviewPrompt,
        }
      );
      updateTodo(todoId, { pipeline_phase: 'review' });
      createTaskLog(todoId, 'info', `Implementation phase completed. Starting Review Round 1 of ${todo.max_review_rounds}.`, nextRound.round_index);
      broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });

      return { action: 'start_review', nextRound };
    }

    if (currentRound.phase === 'review') {
      const parseResult = parseReviewResult(processOutput);

      if (!parseResult.ok) {
        // Reviewer returned invalid format -> Fail review round and todo
        updateExecutionRound(currentRoundId, {
          status: 'failed',
          result_payload: parseResult.rawText,
          error_message: parseResult.error,
          finished_at: now,
        });
        const updatedCurrent = getExecutionRoundById(currentRoundId)!;
        broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });

        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'failed');
        createTaskLog(todoId, 'error', `Review failed: ${parseResult.error}`, currentRound.round_index);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });

        return { action: 'failed', reason: 'review_invalid_result' };
      }

      const reviewData = parseResult.data;
      updateExecutionRound(currentRoundId, {
        status: 'completed',
        result_payload: JSON.stringify(reviewData),
        finished_at: now,
      });
      const updatedCurrent = getExecutionRoundById(currentRoundId)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });

      if (reviewData.verdict === 'approved') {
        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'completed');
        createTaskLog(todoId, 'info', `Review approved: ${reviewData.summary}`, currentRound.round_index);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'completed' });
        return { action: 'completed', reviewResult: reviewData };
      }

      // Verdict is needs_changes
      // Count completed review rounds
      const allRounds = getExecutionRoundsByTodoId(todoId);
      const completedReviewRounds = allRounds.filter((r) => r.phase === 'review' && r.status === 'completed');

      if (completedReviewRounds.length >= todo.max_review_rounds) {
        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'failed');
        createTaskLog(
          todoId,
          'error',
          `Maximum review rounds reached (${todo.max_review_rounds}). Last review requested changes: ${reviewData.summary}`,
          currentRound.round_index
        );
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
        return { action: 'max_rounds_reached', reviewResult: reviewData };
      }

      // Transition to Rework
      const reworkPrompt = this.buildReworkPrompt({
        todo,
        reviewResult: reviewData,
        roundIndex: currentRound.round_index + 1,
      });

      const nextRunToken = uuidv4();
      const nextRound = createExecutionRound(
        todoId,
        'rework',
        currentRound.round_index + 1,
        nextRunToken,
        {
          status: 'pending',
          inputPayload: reworkPrompt,
        }
      );
      updateTodo(todoId, { pipeline_phase: 'rework' });
      createTaskLog(
        todoId,
        'info',
        `Review requested changes (${reviewData.issues.length} issues). Starting Rework round.`,
        nextRound.round_index
      );
      broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });

      return { action: 'start_rework', nextRound, reviewResult: reviewData };
    }

    if (currentRound.phase === 'rework') {
      // Mark rework round completed
      updateExecutionRound(currentRoundId, {
        status: 'completed',
        finished_at: now,
      });
      const updatedCurrent = getExecutionRoundById(currentRoundId)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });

      // Resolve review profile
      const reviewProfileId = todo.review_profile_id ?? project.default_review_profile_id;
      if (!reviewProfileId) {
        const errorMsg = 'Configuration error: Review profile is not configured (todo.review_profile_id is null and project has no default_review_profile_id).';
        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'failed');
        createTaskLog(todoId, 'error', errorMsg, currentRound.round_index);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
        return { action: 'failed', reason: 'review_profile_missing' };
      }

      const allRounds = getExecutionRoundsByTodoId(todoId);
      const completedReviewRounds = allRounds.filter((r) => r.phase === 'review' && r.status === 'completed');
      const nextAttemptNumber = completedReviewRounds.length + 1;

      // Extract issues from last review
      let previousIssues: ReviewIssue[] | undefined = undefined;
      const lastReviewRound = [...allRounds].reverse().find((r) => r.phase === 'review' && r.result_payload);
      if (lastReviewRound?.result_payload) {
        try {
          const parsed = JSON.parse(lastReviewRound.result_payload) as ReviewResult;
          if (parsed.issues) previousIssues = parsed.issues;
        } catch {
          // Ignore JSON parse error on previous payload
        }
      }

      const diffSummary = await this.collectDiffSummary(todo, project);
      const reviewPrompt = this.buildReviewPrompt({
        todo,
        project,
        roundIndex: currentRound.round_index + 1,
        attemptNumber: nextAttemptNumber,
        maxAttempts: todo.max_review_rounds,
        diffSummary,
        previousIssues,
      });

      const nextRunToken = uuidv4();
      const nextRound = createExecutionRound(
        todoId,
        'review',
        currentRound.round_index + 1,
        nextRunToken,
        {
          status: 'pending',
          inputPayload: reviewPrompt,
        }
      );
      updateTodo(todoId, { pipeline_phase: 'review' });
      createTaskLog(
        todoId,
        'info',
        `Rework phase completed. Starting Review Round ${nextAttemptNumber} of ${todo.max_review_rounds}.`,
        nextRound.round_index
      );
      broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });

      return { action: 'start_review', nextRound };
    }

    return { action: 'failed', reason: 'unknown_phase' };
  }

  /**
   * Handle failure of an active round.
   */
  handleRoundFailure(todoId: string, currentRoundId: string, errorMessage?: string): void {
    const now = new Date().toISOString();
    updateExecutionRound(currentRoundId, {
      status: 'failed',
      error_message: errorMessage ?? 'Process execution failed.',
      finished_at: now,
    });
    const updatedRound = getExecutionRoundById(currentRoundId);
    if (updatedRound) {
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedRound });
    }
    updateTodoStatus(todoId, 'failed');
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
  }

  /**
   * Handle stopping an active round.
   */
  handleRoundStop(todoId: string, currentRoundId: string): void {
    const now = new Date().toISOString();
    updateExecutionRound(currentRoundId, {
      status: 'stopped',
      finished_at: now,
    });
    const updatedRound = getExecutionRoundById(currentRoundId);
    if (updatedRound) {
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedRound });
    }
    updateTodoStatus(todoId, 'stopped');
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'stopped' });
  }

  /**
   * Manual override: Approve review.
   */
  manualApprove(todoId: string): Todo {
    const todo = getTodoById(todoId);
    if (!todo) throw new Error('Todo not found');

    const activeRound = getActiveExecutionRound(todoId);
    if (activeRound && activeRound.status === 'running') {
      throw new Error('Cannot manually approve while a process is running. Stop the process first.');
    }

    const latestRound = getLatestExecutionRound(todoId);
    const now = new Date().toISOString();

    if (latestRound && (latestRound.status === 'pending' || latestRound.status.startsWith('waiting_'))) {
      updateExecutionRound(latestRound.id, {
        status: 'completed',
        finished_at: now,
      });
      const updated = getExecutionRoundById(latestRound.id)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
    }

    updateTodo(todoId, { pipeline_phase: 'review' });
    updateTodoStatus(todoId, 'completed');
    createTaskLog(todoId, 'info', 'Manual override: Approved review loop.', latestRound?.round_index ?? 1);
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'completed' });

    return getTodoById(todoId)!;
  }

  /**
   * Manual override: Request Rework.
   */
  manualRework(todoId: string): { todo: Todo; round: TodoExecutionRound } {
    const todo = getTodoById(todoId);
    if (!todo) throw new Error('Todo not found');

    const activeRound = getActiveExecutionRound(todoId);
    if (activeRound) {
      throw new Error('A round is already active or in progress for this task.');
    }

    const allRounds = getExecutionRoundsByTodoId(todoId);
    const latestRound = allRounds[allRounds.length - 1];

    if (!latestRound) {
      throw new Error('Cannot request rework: No execution rounds exist.');
    }

    let reviewResult: ReviewResult | undefined = undefined;
    const lastReviewRound = [...allRounds].reverse().find((r) => r.phase === 'review' && r.result_payload);
    if (lastReviewRound?.result_payload) {
      try {
        reviewResult = JSON.parse(lastReviewRound.result_payload) as ReviewResult;
      } catch {
        // ignore
      }
    }

    const reworkPrompt = reviewResult
      ? this.buildReworkPrompt({ todo, reviewResult, roundIndex: latestRound.round_index + 1 })
      : `Manual Rework Request for "${todo.title}":\nPlease refine the implementation according to the project requirements.`;

    const nextRunToken = uuidv4();
    const nextRound = createExecutionRound(
      todoId,
      'rework',
      latestRound.round_index + 1,
      nextRunToken,
      {
        status: 'pending',
        inputPayload: reworkPrompt,
      }
    );

    updateTodo(todoId, { pipeline_phase: 'rework' });
    updateTodoStatus(todoId, 'pending');
    createTaskLog(todoId, 'info', 'Manual override: Triggered manual rework.', nextRound.round_index);

    broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'pending' });

    return { todo: getTodoById(todoId)!, round: nextRound };
  }

  /**
   * Reconcile rounds on startup to handle crashes or interrupted transitions.
   */
  reconcileOnStartup(): void {
    const db = getDatabase();
    const runningRounds = db.prepare(
      `SELECT * FROM todo_execution_rounds WHERE status = 'running'`
    ).all() as TodoExecutionRound[];

    const now = new Date().toISOString();
    for (const round of runningRounds) {
      updateExecutionRound(round.id, {
        status: 'failed',
        error_message: 'Server restarted while round was running.',
        finished_at: now,
      });
      updateTodoStatus(round.todo_id, 'failed');
    }
  }
}

export const reviewPipeline = new ReviewPipelineService();
