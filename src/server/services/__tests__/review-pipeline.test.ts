import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

vi.mock('../../websocket/broadcaster.js', () => ({
  broadcaster: {
    broadcast: vi.fn(),
  },
}));

vi.mock('../../lib/git.js', () => ({
  createGit: () => ({
    diff: vi.fn().mockResolvedValue('diff --git a/index.ts b/index.ts\n+ console.log("hello");'),
    status: vi.fn().mockResolvedValue({
      modified: ['index.ts'],
      not_added: [],
      created: [],
      deleted: [],
    }),
    raw: vi.fn().mockResolvedValue('index.ts\n'),
  }),
  resolveLocalBaseBranch: vi.fn().mockResolvedValue('main'),
}));

const queries = await import('../../db/queries.js');
const { reviewPipeline } = await import('../review-pipeline.js');

describe('ReviewPipelineService', () => {
  let project: queries.Project;
  let reviewProfile: queries.ExecutionProfile;
  let reworkProfile: queries.ExecutionProfile;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);

    project = queries.createProject('Test Project', '/tmp/test-project');
    reviewProfile = queries.createExecutionProfile({
      slug: 'review-profile',
      name: 'Review Profile',
      description: 'Reviewer',
      isEnabled: true,
      sortOrder: 0,
      executors: [],
    });
    reworkProfile = queries.createExecutionProfile({
      slug: 'rework-profile',
      name: 'Rework Profile',
      description: 'Reworker',
      isEnabled: true,
      sortOrder: 1,
      executors: [],
    });
  });

  afterEach(() => {
    testDb.close();
  });

  it('TC-01 / TC-02: creates initial implementation round with pending status when review_enabled=1', () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1, // review_enabled
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);

    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].phase).toBe('implementation');
    expect(rounds[0].status).toBe('pending');
    expect(rounds[0].round_index).toBe(1);
    expect(rounds[0].run_token).toBeTruthy();

    const updatedTodo = queries.getTodoById(todo.id);
    expect(updatedTodo?.pipeline_phase).toBe('implementation');
  });

  it('TC-03: advances from implementation to review phase on successful implementation', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(initialRound.id, { status: 'running' });

    const result = await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);
    expect(result.action).toBe('start_review');

    // Initial round is now completed
    const completedInitial = queries.getExecutionRoundById(initialRound.id)!;
    expect(completedInitial.status).toBe('completed');

    // New review round is created
    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(2);
    const reviewRound = rounds[1];
    expect(reviewRound.phase).toBe('review');
    expect(reviewRound.round_index).toBe(2);
    expect(reviewRound.status).toBe('pending');
    expect(reviewRound.input_payload).toContain('Feature task');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.pipeline_phase).toBe('review');
    expect(updatedTodo.status).toBe('pending');
  });

  it('TC-04 / TC-05: reviewer approved verdict completes the review round and task', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    expect(reviewRound.phase).toBe('review');

    const reviewerOutput = 'Here is my review:\n```json\n{\n  "verdict": "approved",\n  "summary": "Great implementation, clean code.",\n  "issues": []\n}\n```';

    const result = await reviewPipeline.advanceRoundOnSuccess(todo.id, reviewRound.id, reviewerOutput);
    expect(result.action).toBe('completed');

    const completedReview = queries.getExecutionRoundById(reviewRound.id)!;
    expect(completedReview.status).toBe('completed');
    expect(completedReview.result_payload).toContain('approved');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('completed');
    expect(updatedTodo.pipeline_phase).toBe('review');
  });

  it('TC-06: reviewer needs_changes verdict creates rework round and transitions pipeline to rework', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;

    const reviewerOutput = JSON.stringify({
      verdict: 'needs_changes',
      summary: 'Missing input validation on handler.',
      issues: [
        {
          severity: 'blocking',
          description: 'Add bounds checking for payload size',
          files: ['src/handler.ts'],
        },
      ],
    });

    const result = await reviewPipeline.advanceRoundOnSuccess(todo.id, reviewRound.id, reviewerOutput);
    expect(result.action).toBe('start_rework');

    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(3);

    const reworkRound = rounds[2];
    expect(reworkRound.phase).toBe('rework');
    expect(reworkRound.round_index).toBe(3);
    expect(reworkRound.status).toBe('pending');
    expect(reworkRound.input_payload).toContain('Missing input validation on handler.');
    expect(reworkRound.input_payload).toContain('Add bounds checking for payload size');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.pipeline_phase).toBe('rework');
    expect(updatedTodo.status).toBe('pending');
  });

  it('TC-07: successful rework round advances to next review round (round 2)', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound1 = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(
      todo.id,
      reviewRound1.id,
      JSON.stringify({ verdict: 'needs_changes', summary: 'Fix bug', issues: [] })
    );

    const reworkRound1 = queries.getActiveExecutionRound(todo.id)!;
    expect(reworkRound1.phase).toBe('rework');

    // Rework succeeds
    const result = await reviewPipeline.advanceRoundOnSuccess(todo.id, reworkRound1.id);
    expect(result.action).toBe('start_review');

    const rounds = queries.getExecutionRoundsByTodoId(todo.id);
    expect(rounds).toHaveLength(4);

    const reviewRound2 = rounds[3];
    expect(reviewRound2.phase).toBe('review');
    expect(reviewRound2.round_index).toBe(4);
    expect(reviewRound2.status).toBe('pending');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.pipeline_phase).toBe('review');
  });

  it('TC-08: reaches max review rounds limit and fails with max_review_rounds_reached', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      1 // Max review rounds = 1
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound1 = queries.getActiveExecutionRound(todo.id)!;
    const result = await reviewPipeline.advanceRoundOnSuccess(
      todo.id,
      reviewRound1.id,
      JSON.stringify({ verdict: 'needs_changes', summary: 'Still broken', issues: [] })
    );

    expect(result.action).toBe('max_rounds_reached');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('failed');

    const logs = queries.getTaskLogsByTodoId(todo.id);
    expect(logs.some((l) => l.message.includes('Maximum review rounds reached (1)'))).toBe(true);
  });

  it('TC-16: unparseable reviewer output marks review round as failed and fails todo', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;

    const unparseableOutput = 'I looked at the code and it looks okay but maybe change something.';
    const result = await reviewPipeline.advanceRoundOnSuccess(todo.id, reviewRound.id, unparseableOutput);

    expect(result.action).toBe('failed');
    const updatedRound = queries.getExecutionRoundById(reviewRound.id)!;
    expect(updatedRound.status).toBe('failed');
    expect(updatedRound.error_message).toContain('Failed to parse reviewer output');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('failed');
  });

  it('TC-17: manualApprove marks todo and pending review rounds as completed', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(reviewRound.id, {
      status: 'completed',
      result_payload: JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Changes requested but human decides to approve',
        issues: [{ severity: 'minor', description: 'Minor naming', files: [] }],
      }),
    });
    queries.updateTodoStatus(todo.id, 'stopped');

    const updated = reviewPipeline.manualApprove(todo.id);
    expect(updated.status).toBe('completed');
  });

  it('TC-18: manualRework creates next rework round when latest review requested changes', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;
    await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);

    const reviewRound = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(reviewRound.id, {
      status: 'completed',
      result_payload: JSON.stringify({
        verdict: 'needs_changes',
        summary: 'Fix required',
        issues: [{ severity: 'major', description: 'Refactor helper', files: [] }],
      }),
    });
    queries.updateTodoStatus(todo.id, 'stopped');

    const result = reviewPipeline.manualRework(todo.id);
    expect(result.todo.pipeline_phase).toBe('rework');
    expect(result.round.phase).toBe('rework');
    expect(result.round.status).toBe('pending');
    expect(result.round.input_payload).toContain('Refactor helper');
  });

  it('TC-19: handleRoundStop marks active round as stopped', () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const round = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round.id, { status: 'running' });

    reviewPipeline.handleRoundStop(todo.id, round.id);

    const stoppedRound = queries.getExecutionRoundById(round.id)!;
    expect(stoppedRound.status).toBe('stopped');
  });

  it('TC-20: reconcileOnStartup marks stale running rounds as failed', () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const round = queries.getActiveExecutionRound(todo.id)!;
    queries.updateExecutionRound(round.id, { status: 'running' });

    reviewPipeline.reconcileOnStartup();

    const reconciled = queries.getExecutionRoundById(round.id)!;
    expect(reconciled.status).toBe('failed');
    expect(reconciled.error_message).toContain('Process terminated unexpectedly');
  });
  it('TC-09: missing review profile fails advance on implementation success with review_profile_missing', async () => {
    const todo = queries.createTodo(
      project.id,
      'Feature task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1, // review_enabled
      null, // no review_profile_id
      null,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const initialRound = queries.getActiveExecutionRound(todo.id)!;

    const result = await reviewPipeline.advanceRoundOnSuccess(todo.id, initialRound.id);
    expect(result.action).toBe('failed');
    expect(result.reason).toBe('review_profile_missing');

    const updatedTodo = queries.getTodoById(todo.id)!;
    expect(updatedTodo.status).toBe('failed');

    const logs = queries.getTaskLogsByTodoId(todo.id);
    expect(logs.some((l) => l.message.includes('Review profile is not configured'))).toBe(true);
  });

  it('TC-11 / TC-12 / TC-13: collectDiffSummary returns diff stats and modified files', async () => {
    const todo = queries.createTodo(
      project.id,
      'Diff test task',
      'Task description',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    const diffSummary = await reviewPipeline.collectDiffSummary(todo, project);
    expect(diffSummary).toContain('diff --git');
    expect(diffSummary).toContain('console.log("hello")');
  });

  it('TC-14: buildReviewPrompt formats task details, diff summary, and JSON schema instructions', () => {
    const todo = queries.createTodo(
      project.id,
      'Feature X Implementation',
      'Implement robust authentication handling',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    const prompt = reviewPipeline.buildReviewPrompt({
      todo,
      project,
      roundIndex: 2,
      attemptNumber: 1,
      maxAttempts: 3,
      diffSummary: 'diff --git a/auth.ts b/auth.ts\n+ export function login() {}',
    });

    expect(prompt).toContain('Feature X Implementation');
    expect(prompt).toContain('Implement robust authentication handling');
    expect(prompt).toContain('export function login() {}');
    expect(prompt).toContain('"verdict": "approved" | "needs_changes"');
    expect(prompt).toContain('"issues"');
  });

  it('TC-15: buildReworkPrompt includes previous review issues, severity, and instructions', () => {
    const todo = queries.createTodo(
      project.id,
      'Bug fix task',
      'Fix token race condition',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    const prompt = reviewPipeline.buildReworkPrompt({
      todo,
      reviewResult: {
        verdict: 'needs_changes',
        summary: 'Security vulnerability in token refresh',
        issues: [
          {
            severity: 'blocking',
            description: 'Validate expiry timestamp before issuing new token',
            files: ['src/auth/jwt.ts'],
          },
        ],
      },
      roundIndex: 3,
    });

    expect(prompt).toContain('Fix token race condition');
    expect(prompt).toContain('Security vulnerability in token refresh');
    expect(prompt).toContain('BLOCKING');
    expect(prompt).toContain('Validate expiry timestamp before issuing new token');
    expect(prompt).toContain('src/auth/jwt.ts');
  });

  it('TC-21: run-token isolation ensures each round has a distinct unique token', async () => {
    const todo = queries.createTodo(
      project.id,
      'Token isolation task',
      'Desc',
      1,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      'none',
      null,
      null,
      undefined,
      undefined,
      null,
      null,
      '[]',
      1,
      reviewProfile.id,
      reworkProfile.id,
      3
    );

    reviewPipeline.ensureInitialRound(todo.id);
    const round1 = queries.getActiveExecutionRound(todo.id)!;

    await reviewPipeline.advanceRoundOnSuccess(todo.id, round1.id);
    const round2 = queries.getActiveExecutionRound(todo.id)!;

    expect(round1.run_token).toBeTruthy();
    expect(round2.run_token).toBeTruthy();
    expect(round1.run_token).not.toBe(round2.run_token);
  });
});
