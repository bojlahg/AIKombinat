import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
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
import { logger } from '../logging/logger.js';
import { tag } from '../logging/context.js';
import { clampLine } from '../logging/truncate.js';
import { createGit } from '../lib/git.js';
import { parseReviewResult } from './review-result-parser.js';
import type { ReviewResult, ReviewIssue } from './review-result.js';
import { resourceManager } from './resource-manager.js';

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export interface AdvanceRoundResult {
  action: 'start_review' | 'start_rework' | 'completed' | 'failed' | 'max_rounds_reached' | 'superseded';
  nextRound?: TodoExecutionRound;
  reviewResult?: ReviewResult;
  reason?: string;
}

export interface ReviewBaseline {
  repositoryIdentity: string;
  workDir: string;
  baseCommit: string;
  startingHead: string;
  startedAt: string;
}

export interface ReviewedArtifact {
  baselineCommit: string;
  reviewedHeadCommit: string;
  worktreeStateHash: string;
  diffHash: string;
  changedFiles: string[];
  truncated: boolean;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let bytes = 0;
  let text = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    text += character;
    bytes += size;
  }
  return { text, truncated: true };
}

export class ReviewPipelineService {
  async captureBaseline(todoId: string, workDir: string, requireClean: boolean): Promise<ReviewBaseline> {
    const todo = getTodoById(todoId);
    if (!todo) throw new Error('Todo not found while capturing review baseline');
    if (todo.review_baseline) return JSON.parse(todo.review_baseline) as ReviewBaseline;

    const git = createGit(workDir);
    const porcelain = await git.raw(['status', '--porcelain=v1', '--untracked-files=all']);
    const hasPorcelainEntries = porcelain.split(/\r?\n/).some((line) => /^[ MADRCU?!]{2} /.test(line));
    if (requireClean && hasPorcelainEntries) {
      throw new Error('Review-enabled execution in the project root requires a clean Git working tree');
    }
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const reportedRoot = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    const root = reportedRoot ? path.resolve(reportedRoot) : path.resolve(workDir);
    const baseline: ReviewBaseline = {
      repositoryIdentity: root,
      workDir: path.resolve(workDir),
      baseCommit: head,
      startingHead: head,
      startedAt: new Date().toISOString(),
    };
    updateTodo(todoId, { review_baseline: JSON.stringify(baseline) });
    logger.info('review.baseline.captured', {
      msg: 'immutable review baseline captured', todoId, baseCommit: head,
    });
    return baseline;
  }

  /**
   * Ensure that an initial implementation round exists when review_enabled = 1.
   */
  ensureInitialRound(todoId: string): TodoExecutionRound | undefined {
    const todo = getTodoById(todoId);
    if (!todo || !todo.review_enabled) return undefined;

    const activeRound = getActiveExecutionRound(todoId);
    if (activeRound) return activeRound;

    const existingRounds = getExecutionRoundsByTodoId(todoId);
    if (existingRounds.length > 0) {
      return undefined;
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
  async collectReviewArtifact(todo: Todo, project: Project): Promise<{ summary: string; identity: ReviewedArtifact | null }> {
    if (!project.is_git_repo) {
      return { summary: 'REVIEW EVIDENCE UNAVAILABLE: not a Git repository.', identity: null };
    }

    const workDir = todo.worktree_path || project.path;
    const git = createGit(workDir);

    try {
      if (!todo.review_baseline) {
        logger.error('review.evidence.unavailable', { msg: 'review baseline is unavailable', todoId: todo.id });
        return { summary: 'REVIEW EVIDENCE UNAVAILABLE: immutable task baseline was not captured (legacy task).', identity: null };
      }
      const baseline = JSON.parse(todo.review_baseline) as ReviewBaseline;
      if (path.resolve(workDir) !== path.resolve(baseline.workDir)) {
        return { summary: 'REVIEW EVIDENCE UNAVAILABLE: task work directory changed after baseline capture.', identity: null };
      }
      const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
      const committed = await git.diff([`${baseline.baseCommit}..HEAD`]);
      const staged = await git.diff(['--cached']);
      const unstaged = await git.diff([]);
      const statSummary = [
        await git.diff([`${baseline.baseCommit}..HEAD`, '--stat']),
        await git.diff(['--cached', '--stat']),
        await git.diff(['--stat']),
      ].filter(Boolean).join('\n');
      const untrackedRaw = await git.raw(['ls-files', '--others', '--exclude-standard', '-z']);
      const untracked = untrackedRaw.split('\0').filter(Boolean).sort();
      const untrackedEvidence = untracked.map((relative) => {
        const absolute = path.resolve(workDir, relative);
        if (!absolute.startsWith(path.resolve(workDir) + path.sep) || !fs.existsSync(absolute)) return `### Untracked: ${relative}\n(unavailable)`;
        const data = fs.readFileSync(absolute);
        return data.includes(0)
          ? `### Untracked binary: ${relative} (${data.length} bytes)`
          : `### Untracked: ${relative}\n${data.toString('utf8')}`;
      }).join('\n\n');
      const fullDiff = [committed, staged, unstaged, untrackedEvidence].filter(Boolean).join('\n\n');
      const changedRaw = await git.raw(['diff', '--name-only', `${baseline.baseCommit}..HEAD`]);
      const workingChanged = await git.raw(['diff', '--name-only']);
      const stagedChanged = await git.raw(['diff', '--cached', '--name-only']);
      const changedFiles = Array.from(new Set(
        [...changedRaw.split(/\r?\n/), ...workingChanged.split(/\r?\n/), ...stagedChanged.split(/\r?\n/), ...untracked]
          .filter(Boolean),
      )).sort();
      const bounded = truncateUtf8(fullDiff, 50 * 1024);
      const diffHash = createHash('sha256').update(fullDiff).digest('hex');
      const worktreeStateHash = createHash('sha256')
        .update(JSON.stringify({ baseline: baseline.baseCommit, head, diffHash, changedFiles }))
        .digest('hex');
      const identity: ReviewedArtifact = {
        baselineCommit: baseline.baseCommit,
        reviewedHeadCommit: head,
        worktreeStateHash,
        diffHash,
        changedFiles,
        truncated: bounded.truncated,
      };
      logger.info('review.artifact', {
        msg: 'review artifact collected', todoId: todo.id, baselineCommit: baseline.baseCommit,
        reviewedHeadCommit: head, diffHash, changedFileCount: changedFiles.length, truncated: bounded.truncated,
      });
      return { summary: [
        '### Git Diff Summary',
        statSummary.trim() || (changedFiles.length ? changedFiles.join('\n') : 'No changed files.'),
        `Artifact: baseline=${baseline.baseCommit} head=${head} diffHash=${diffHash}`,
        bounded.truncated ? 'WARNING: Diff content is truncated; file list and artifact hash describe the complete state.' : 'Diff content is complete.',
        '### Git Diff Content',
        bounded.text.trim() || 'No code changes detected (confirmed empty artifact).',
      ].join('\n\n'), identity };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('review.evidence.unavailable', { msg: 'review evidence collection failed', todoId: todo.id, message: clampLine(message) });
      return { summary: `REVIEW EVIDENCE UNAVAILABLE: ${message}`, identity: null };
    }
  }

  async collectDiffSummary(todo: Todo, project: Project): Promise<string> {
    return (await this.collectReviewArtifact(todo, project)).summary;
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
    sections.push('This is a read-only review. Do not modify files, run mutating commands, commit, or push. Inspect the supplied immutable artifact and return only the structured review result.');
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

- Return \"verdict\": \"approved\" with an empty \"issues\": [] array if the implementation fulfills the task and has no blocking/major flaws.
- Return \"verdict\": \"needs_changes\" with actionable issues if bugs, omissions, or blocking deficiencies exist.`);

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
    const { todo, reviewResult } = params;

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
   * Asynchronous preparation (diff summary / prompts) is done first,
   * then database updates execute inside a synchronous transaction.
   */
  async advanceRoundOnSuccess(
    todoId: string,
    currentRoundId: string,
    processOutput = '',
    options?: { isCancelled?: () => boolean }
  ): Promise<AdvanceRoundResult> {
    if (options?.isCancelled?.()) {
      return { action: 'superseded', reason: 'cancelled_or_stopped' };
    }
    const todo = getTodoById(todoId);
    if (!todo) return { action: 'failed', reason: 'todo_not_found' };

    const project = getProjectById(todo.project_id);
    if (!project) return { action: 'failed', reason: 'project_not_found' };

    const currentRound = getExecutionRoundById(currentRoundId);
    if (!currentRound) return { action: 'failed', reason: 'round_not_found' };

    const db = getDatabase();
    const now = new Date().toISOString();

    if (currentRound.phase === 'implementation') {
      const reviewProfileId = todo.review_profile_id ?? project.default_review_profile_id;
      if (!reviewProfileId) {
        const errorMsg = 'Configuration error: Review profile is not configured (todo.review_profile_id is null and project has no default_review_profile_id).';
        logger.error('review.profile-missing', {
          scope: tag('todo', todo.title),
          msg: 'implementation finished but the review phase cannot start: no review profile is configured',
          todoId,
          roundId: currentRoundId,
          phase: 'review',
          round: currentRound.round_index,
          detail: 'Set a review profile on the task, or a default review profile on the project.',
        });
        db.transaction(() => {
          updateExecutionRound(currentRoundId, {
            status: 'failed',
            error_message: errorMsg,
            finished_at: now,
          });
          updateTodo(todoId, { pipeline_phase: 'review' });
          updateTodoStatus(todoId, 'failed');
          createTaskLog(todoId, 'error', errorMsg, currentRound.round_index);
        })();

        const updatedCurrent = getExecutionRoundById(currentRoundId)!;
        broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
        return { action: 'failed', reason: 'review_profile_missing' };
      }

      if (options?.isCancelled?.()) return { action: 'superseded', reason: 'cancelled_or_stopped' };
      const reviewArtifact = await this.collectReviewArtifact(todo, project);
      const diffSummary = reviewArtifact.summary;
      if (options?.isCancelled?.()) return { action: 'superseded', reason: 'cancelled_or_stopped' };
      const reviewPrompt = this.buildReviewPrompt({
        todo,
        project,
        roundIndex: currentRound.round_index + 1,
        attemptNumber: 1,
        maxAttempts: todo.max_review_rounds,
        diffSummary,
      });

      const nextRunToken = uuidv4();
      let nextRound: TodoExecutionRound | undefined;

      let aborted = false;
      db.transaction(() => {
        const freshTodo = getTodoById(todoId);
        const freshRound = getExecutionRoundById(currentRoundId);
        const activeRound = getActiveExecutionRound(todoId);
        if (
          options?.isCancelled?.() ||
          !freshTodo ||
          freshTodo.status === 'stopped' ||
          freshTodo.status === 'failed' ||
          !freshRound ||
          freshRound.status === 'stopped' ||
          freshRound.status === 'failed' ||
          activeRound?.id !== currentRoundId
        ) {
          aborted = true;
          return;
        }

        updateExecutionRound(currentRoundId, {
          status: 'completed',
          finished_at: now,
        });

        nextRound = createExecutionRound(
          todoId,
          'review',
          currentRound.round_index + 1,
          nextRunToken,
          {
            status: 'pending',
            inputPayload: reviewPrompt,
            artifactIdentity: reviewArtifact.identity ? JSON.stringify(reviewArtifact.identity) : null,
          }
        );
        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'pending');
        createTaskLog(todoId, 'info', `Implementation phase completed. Starting Review Round 1 of ${todo.max_review_rounds}.`, nextRound.round_index);
      })();

      if (aborted) {
        return { action: 'superseded', reason: 'cancelled_or_stopped' };
      }

      const updatedCurrent = getExecutionRoundById(currentRoundId)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
      if (nextRound) broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });

      return { action: 'start_review', nextRound };
    }

    if (currentRound.phase === 'review') {
      const currentArtifact = await this.collectReviewArtifact(todo, project);
      const expectedArtifact = currentRound.artifact_identity;
      const actualArtifact = currentArtifact.identity ? JSON.stringify(currentArtifact.identity) : null;
      if (!expectedArtifact || !actualArtifact || expectedArtifact !== actualArtifact) {
        const reason = !expectedArtifact
          ? 'Review artifact identity is unavailable.'
          : 'Code changed after review evidence was captured; the review result cannot approve the new state.';
        db.transaction(() => {
          updateExecutionRound(currentRoundId, {
            status: 'failed', error_message: reason, finished_at: now,
          });
          updateTodoStatus(todoId, 'failed');
          createTaskLog(todoId, 'error', reason, currentRound.round_index);
        })();
        logger.error('review.artifact.changed', {
          msg: reason, todoId, roundId: currentRoundId,
        });
        return { action: 'failed', reason: 'review_artifact_changed' };
      }
      const parseResult = parseReviewResult(processOutput);

      if (!parseResult.ok) {
        let aborted = false;
        db.transaction(() => {
          const freshTodo = getTodoById(todoId);
          const freshRound = getExecutionRoundById(currentRoundId);
          const activeRound = getActiveExecutionRound(todoId);
          if (
            options?.isCancelled?.() ||
            !freshTodo ||
            freshTodo.status === 'stopped' ||
            freshTodo.status === 'failed' ||
            !freshRound ||
            freshRound.status === 'stopped' ||
            freshRound.status === 'failed' ||
            activeRound?.id !== currentRoundId
          ) {
            aborted = true;
            return;
          }

          updateExecutionRound(currentRoundId, {
            status: 'failed',
            result_payload: parseResult.rawText,
            error_message: parseResult.error,
            finished_at: now,
          });
          updateTodo(todoId, { pipeline_phase: 'review' });
          updateTodoStatus(todoId, 'failed');
          createTaskLog(todoId, 'error', `Review failed: ${parseResult.error}`, currentRound.round_index);
        })();

        if (aborted) {
          return { action: 'superseded', reason: 'cancelled_or_stopped' };
        }

        const updatedCurrent = getExecutionRoundById(currentRoundId)!;
        broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });

        logger.error('review.result.invalid', {
          scope: tag('todo', todo.title),
          msg: 'review produced an unusable result',
          todoId,
          roundId: currentRoundId,
          round: currentRound.round_index,
          message: clampLine(parseResult.error),
        });
        return { action: 'failed', reason: 'review_invalid_result' };
      }

      const reviewData = parseResult.data;

      if (reviewData.verdict === 'approved') {
        let aborted = false;
        db.transaction(() => {
          const freshTodo = getTodoById(todoId);
          const freshRound = getExecutionRoundById(currentRoundId);
          const activeRound = getActiveExecutionRound(todoId);
          if (
            options?.isCancelled?.() ||
            !freshTodo ||
            freshTodo.status === 'stopped' ||
            freshTodo.status === 'failed' ||
            !freshRound ||
            freshRound.status === 'stopped' ||
            freshRound.status === 'failed' ||
            activeRound?.id !== currentRoundId
          ) {
            aborted = true;
            return;
          }

          updateExecutionRound(currentRoundId, {
            status: 'completed',
            result_payload: JSON.stringify(reviewData),
            finished_at: now,
          });
          updateTodo(todoId, { pipeline_phase: 'review' });
          updateTodoStatus(todoId, 'completed');
          createTaskLog(todoId, 'info', `Review approved: ${reviewData.summary}`, currentRound.round_index);
        })();

        if (aborted) {
          return { action: 'superseded', reason: 'cancelled_or_stopped' };
        }

        const updatedCurrent = getExecutionRoundById(currentRoundId)!;
        broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
        logger.info('review.approved', {
          scope: tag('todo', todo.title),
          msg: `review round ${currentRound.round_index} approved`,
          todoId,
          roundId: currentRoundId,
          round: currentRound.round_index,
        });
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'completed' });
        return { action: 'completed', reviewResult: reviewData };
      }

      // Verdict is needs_changes
      const allRounds = getExecutionRoundsByTodoId(todoId);
      const completedReviewRounds = allRounds.filter((r) => r.phase === 'review' && (r.status === 'completed' || r.id === currentRoundId));

      if (completedReviewRounds.length >= todo.max_review_rounds) {
        let aborted = false;
        db.transaction(() => {
          const freshTodo = getTodoById(todoId);
          const freshRound = getExecutionRoundById(currentRoundId);
          const activeRound = getActiveExecutionRound(todoId);
          if (
            options?.isCancelled?.() ||
            !freshTodo ||
            freshTodo.status === 'stopped' ||
            freshTodo.status === 'failed' ||
            !freshRound ||
            freshRound.status === 'stopped' ||
            freshRound.status === 'failed' ||
            activeRound?.id !== currentRoundId
          ) {
            aborted = true;
            return;
          }

          updateExecutionRound(currentRoundId, {
            status: 'completed',
            result_payload: JSON.stringify(reviewData),
            finished_at: now,
          });
          updateTodo(todoId, { pipeline_phase: 'review' });
          updateTodoStatus(todoId, 'failed');
          createTaskLog(
            todoId,
            'error',
            `Maximum review rounds reached (${todo.max_review_rounds}). Last review requested changes: ${reviewData.summary}`,
            currentRound.round_index
          );
        })();

        if (aborted) {
          return { action: 'superseded', reason: 'cancelled_or_stopped' };
        }

        const updatedCurrent = getExecutionRoundById(currentRoundId)!;
        broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
        logger.error('review.max-rounds-reached', {
          scope: tag('todo', todo.title),
          msg: 'review/rework did not converge before the round limit',
          todoId,
          roundId: currentRoundId,
          round: currentRound.round_index,
          issues: reviewData.issues.length,
        });
        return { action: 'max_rounds_reached', reviewResult: reviewData };
      }

      // Transition to Rework
      const reworkPrompt = this.buildReworkPrompt({
        todo,
        reviewResult: reviewData,
        roundIndex: currentRound.round_index + 1,
      });

      const nextRunToken = uuidv4();
      let nextRound: TodoExecutionRound | undefined;

      let aborted = false;
      db.transaction(() => {
        const freshTodo = getTodoById(todoId);
        const freshRound = getExecutionRoundById(currentRoundId);
        const activeRound = getActiveExecutionRound(todoId);
        if (
          !freshTodo ||
          freshTodo.status === 'stopped' ||
          freshTodo.status === 'failed' ||
          !freshRound ||
          freshRound.status === 'stopped' ||
          freshRound.status === 'failed' ||
          activeRound?.id !== currentRoundId
        ) {
          aborted = true;
          return;
        }

        updateExecutionRound(currentRoundId, {
          status: 'completed',
          result_payload: JSON.stringify(reviewData),
          finished_at: now,
        });

        nextRound = createExecutionRound(
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
        updateTodoStatus(todoId, 'pending');
        createTaskLog(
          todoId,
          'info',
          `Review requested changes (${reviewData.issues.length} issues). Starting Rework round.`,
          nextRound.round_index
        );
      })();

      if (aborted) {
        return { action: 'superseded', reason: 'cancelled_or_stopped' };
      }

      const updatedCurrent = getExecutionRoundById(currentRoundId)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
      if (nextRound) broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });

      logger.warn('review.needs-changes', {
        scope: tag('todo', todo.title),
        msg: `review requested changes (${reviewData.issues.length} issue(s)) - starting rework`,
        todoId,
        roundId: currentRoundId,
        round: currentRound.round_index,
        issues: reviewData.issues.length,
      });
      return { action: 'start_rework', nextRound, reviewResult: reviewData };
    }

    if (currentRound.phase === 'rework') {
      if (options?.isCancelled?.()) {
        return { action: 'superseded', reason: 'cancelled_or_stopped' };
      }
      const reviewProfileId = todo.review_profile_id ?? project.default_review_profile_id;
      if (!reviewProfileId) {
        const errorMsg = 'Configuration error: Review profile is not configured (todo.review_profile_id is null and project has no default_review_profile_id).';
        db.transaction(() => {
          updateExecutionRound(currentRoundId, {
            status: 'failed',
            error_message: errorMsg,
            finished_at: now,
          });
          updateTodo(todoId, { pipeline_phase: 'review' });
          updateTodoStatus(todoId, 'failed');
          createTaskLog(todoId, 'error', errorMsg, currentRound.round_index);
        })();

        const updatedCurrent = getExecutionRoundById(currentRoundId)!;
        broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
        return { action: 'failed', reason: 'review_profile_missing' };
      }

      const allRounds = getExecutionRoundsByTodoId(todoId);
      const completedReviewRounds = allRounds.filter((r) => r.phase === 'review' && r.status === 'completed');
      const nextAttemptNumber = completedReviewRounds.length + 1;

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

      if (options?.isCancelled?.()) return { action: 'superseded', reason: 'cancelled_or_stopped' };
      const reviewArtifact = await this.collectReviewArtifact(todo, project);
      const diffSummary = reviewArtifact.summary;
      if (options?.isCancelled?.()) return { action: 'superseded', reason: 'cancelled_or_stopped' };
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
      let nextRound: TodoExecutionRound | undefined;

      let aborted = false;
      db.transaction(() => {
        const freshTodo = getTodoById(todoId);
        const freshRound = getExecutionRoundById(currentRoundId);
        const activeRound = getActiveExecutionRound(todoId);
        if (
          !freshTodo ||
          freshTodo.status === 'stopped' ||
          freshTodo.status === 'failed' ||
          !freshRound ||
          freshRound.status === 'stopped' ||
          freshRound.status === 'failed' ||
          activeRound?.id !== currentRoundId
        ) {
          aborted = true;
          return;
        }

        updateExecutionRound(currentRoundId, {
          status: 'completed',
          finished_at: now,
        });

        nextRound = createExecutionRound(
          todoId,
          'review',
          currentRound.round_index + 1,
          nextRunToken,
          {
            status: 'pending',
            inputPayload: reviewPrompt,
            artifactIdentity: reviewArtifact.identity ? JSON.stringify(reviewArtifact.identity) : null,
          }
        );
        updateTodo(todoId, { pipeline_phase: 'review' });
        updateTodoStatus(todoId, 'pending');
        createTaskLog(
          todoId,
          'info',
          `Rework phase completed. Starting Review Round ${nextAttemptNumber} of ${todo.max_review_rounds}.`,
          nextRound.round_index
        );
      })();

      if (aborted) {
        return { action: 'superseded', reason: 'cancelled_or_stopped' };
      }

      const updatedCurrent = getExecutionRoundById(currentRoundId)!;
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedCurrent });
      if (nextRound) broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });

      return { action: 'start_review', nextRound };
    }

    return { action: 'failed', reason: 'unknown_phase' };
  }

  /**
   * Handle failure of an active round.
   */
  handleRoundFailure(todoId: string, currentRoundId: string, errorMessage?: string): void {
    const failedRound = getExecutionRoundById(currentRoundId);
    logger.error('review.round.failed', {
      scope: tag('todo', getTodoById(todoId)?.title ?? todoId),
      msg: `${failedRound?.phase ?? 'execution'} round failed`,
      todoId,
      roundId: currentRoundId,
      ...(failedRound ? { phase: failedRound.phase, round: failedRound.round_index } : {}),
      message: clampLine(errorMessage ?? 'Process execution failed.'),
    });
    const now = new Date().toISOString();
    const db = getDatabase();
    db.transaction(() => {
      updateExecutionRound(currentRoundId, {
        status: 'failed',
        error_message: errorMessage ?? 'Process execution failed.',
        finished_at: now,
      });
      updateTodoStatus(todoId, 'failed');
    })();

    const updatedRound = getExecutionRoundById(currentRoundId);
    if (updatedRound) {
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedRound });
    }
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed', mode: 'error' });
  }

  /**
   * Handle stopping an active round.
   */
  handleRoundStop(todoId: string, currentRoundId: string): void {
    const now = new Date().toISOString();
    const db = getDatabase();
    db.transaction(() => {
      updateExecutionRound(currentRoundId, {
        status: 'stopped',
        finished_at: now,
      });
      updateTodoStatus(todoId, 'stopped');
    })();

    const updatedRound = getExecutionRoundById(currentRoundId);
    if (updatedRound) {
      broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedRound });
    }
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'stopped' });
  }

  /**
   * Manual override: Approve review.
   */
  manualApprove(todoId: string): Todo {
    const todo = getTodoById(todoId);
    if (!todo) throw new Error('Todo not found');

    if (!todo.review_enabled) {
      throw new InvalidTransitionError('Review is not enabled for this task.');
    }

    if (todo.status === 'completed') {
      throw new InvalidTransitionError('Task is already completed.');
    }

    const activeRound = getActiveExecutionRound(todoId);
    if (activeRound && (activeRound.status === 'running' || activeRound.status.startsWith('waiting_'))) {
      throw new InvalidTransitionError('Cannot manually approve while execution is in progress or waiting.');
    }

    const allRounds = getExecutionRoundsByTodoId(todoId);
    const latestRound = allRounds[allRounds.length - 1];

    if (!latestRound) {
      throw new InvalidTransitionError('No execution rounds exist for this task.');
    }

    if (latestRound.phase !== 'review') {
      throw new InvalidTransitionError(`Cannot approve during ${latestRound.phase} phase. Manual approval is only allowed after a completed review.`);
    }

    if (!latestRound.result_payload) {
      throw new InvalidTransitionError('Cannot approve review: No review result payload found.');
    }

    let reviewResult: ReviewResult;
    try {
      reviewResult = JSON.parse(latestRound.result_payload) as ReviewResult;
    } catch {
      throw new InvalidTransitionError('Invalid review result payload.');
    }

    if (reviewResult.verdict !== 'needs_changes') {
      throw new InvalidTransitionError(`Review verdict is already "${reviewResult.verdict}".`);
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    db.transaction(() => {
      if (activeRound && activeRound.status === 'pending') {
        updateExecutionRound(activeRound.id, {
          status: 'completed',
          finished_at: now,
        });
      }
      updateTodo(todoId, { pipeline_phase: 'review' });
      updateTodoStatus(todoId, 'completed');
      createTaskLog(todoId, 'info', `Manual override: Approved review (${reviewResult.summary}).`, latestRound.round_index);
    })();

    if (activeRound && activeRound.status === 'pending') {
      const updatedRound = getExecutionRoundById(activeRound.id);
      if (updatedRound) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedRound });
    }

    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'completed' });
    return getTodoById(todoId)!;
  }

  /**
   * Manual override: Request Rework.
   */
  manualRework(todoId: string): { todo: Todo; round: TodoExecutionRound } {
    const todo = getTodoById(todoId);
    if (!todo) throw new Error('Todo not found');

    if (!todo.review_enabled) {
      throw new InvalidTransitionError('Review is not enabled for this task.');
    }

    const activeRound = getActiveExecutionRound(todoId);
    if (activeRound) {
      throw new InvalidTransitionError('A round is already active or in progress for this task.');
    }

    const allRounds = getExecutionRoundsByTodoId(todoId);
    const latestRound = allRounds[allRounds.length - 1];

    if (!latestRound) {
      throw new InvalidTransitionError('Cannot request rework: No execution rounds exist.');
    }

    if (latestRound.phase !== 'review' || latestRound.status !== 'completed') {
      throw new InvalidTransitionError('Manual rework is only allowed after a completed review phase.');
    }

    if (!latestRound.result_payload) {
      throw new InvalidTransitionError('No review result payload found on the latest review round.');
    }

    let reviewResult: ReviewResult;
    try {
      reviewResult = JSON.parse(latestRound.result_payload) as ReviewResult;
    } catch {
      throw new InvalidTransitionError('Invalid review result payload.');
    }

    if (reviewResult.verdict !== 'needs_changes') {
      throw new InvalidTransitionError('Manual rework requires a review verdict of "needs_changes".');
    }

    const reworkPrompt = this.buildReworkPrompt({
      todo,
      reviewResult,
      roundIndex: latestRound.round_index + 1,
    });

    const nextRunToken = uuidv4();
    let nextRound: TodoExecutionRound | undefined;
    const db = getDatabase();

    db.transaction(() => {
      nextRound = createExecutionRound(
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
    })();

    if (nextRound) broadcaster.broadcast({ type: 'todo:round-created', todoId, round: nextRound });
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'pending' });

    return { todo: getTodoById(todoId)!, round: nextRound! };
  }

  /**
   * Reconcile rounds on startup to handle crashes or interrupted transitions.
   * Live PID processes are preserved; dead/missing PID runs are marked failed.
   */
  reconcileOnStartup(): void {
    const db = getDatabase();
    const runningRounds = db.prepare(
      `SELECT * FROM todo_execution_rounds WHERE status = 'running'`
    ).all() as TodoExecutionRound[];

    const now = new Date().toISOString();
    for (const round of runningRounds) {
      const todo = getTodoById(round.todo_id);
      if (!todo) {
        updateExecutionRound(round.id, {
          status: 'failed',
          finished_at: now,
          error_message: 'Todo no longer exists.',
        });
        continue;
      }

      let isAlive = false;
      if (todo.process_pid && todo.process_pid > 0) {
        try {
          process.kill(todo.process_pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }

      if (isAlive && todo.status === 'running') {
        // Process is still alive — preserve running state
        continue;
      }

      // Process is dead
      logger.warn('review.round.reconciled', {
        scope: tag('todo', todo.title),
        msg: `${round.phase} round ${round.round_index} was interrupted by a restart - marking it failed`,
        todoId: todo.id,
        roundId: round.id,
        phase: round.phase,
        round: round.round_index,
        pid: todo.process_pid ?? undefined,
      });
      db.transaction(() => {
        updateExecutionRound(round.id, {
          status: 'failed',
          error_message: 'Process terminated unexpectedly (server restarted or process exited).',
          finished_at: now,
        });
        updateTodoStatus(todo.id, 'failed');
        updateTodo(todo.id, { process_pid: 0, execution_snapshot: null });
      })();

      if (round.run_token) {
        resourceManager.releaseRun(round.run_token);
      }
      resourceManager.releaseOwner('todo', todo.id);

      const updated = getExecutionRoundById(round.id);
      if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId: todo.id, round: updated });
      broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'failed' });
    }

    // Check for any non-terminal review_enabled todo with no active round
    const nonTerminalReviewTodos = db.prepare(
      `SELECT * FROM todos WHERE review_enabled = 1 AND status IN ('pending', 'running')`
    ).all() as Todo[];

    for (const todo of nonTerminalReviewTodos) {
      const activeRound = getActiveExecutionRound(todo.id);
      if (!activeRound) {
        const allRounds = getExecutionRoundsByTodoId(todo.id);
        if (allRounds.length === 0) {
          this.ensureInitialRound(todo.id);
        }
      }
    }
  }
}

export const reviewPipeline = new ReviewPipelineService();
