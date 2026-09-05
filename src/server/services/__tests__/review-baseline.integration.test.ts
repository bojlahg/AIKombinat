import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));
vi.mock('../../websocket/broadcaster.js', () => ({ broadcaster: { broadcast: vi.fn() } }));

const queries = await import('../../db/queries.js');
const { reviewPipeline } = await import('../review-pipeline.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(repo: string, relative: string, content: string, message: string): string {
  const absolute = path.join(repo, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  git(repo, 'add', '--', relative);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('review immutable Git baseline', () => {
  let workspace: TestWorkspace;
  let repo: string;
  let project: queries.Project;
  let todo: queries.Todo;

  beforeEach(() => {
    workspace = createTestWorkspace('review-baseline');
    repo = workspace.createSubdir('repo');
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'tests@aikombinat.local');
    git(repo, 'config', 'user.name', 'AIKombinat Tests');
    commitFile(repo, 'tracked.txt', 'baseline\n', 'baseline');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    project = queries.createProject('Review Repo', repo, 'main', 1);
    todo = queries.createTodo(project.id, 'Review task');
    queries.updateTodo(todo.id, { review_enabled: 1 });
    todo = queries.getTodoById(todo.id)!;
  });

  afterEach(() => {
    testDb.close();
    workspace.cleanup();
  });

  it('reviews committed, staged, unstaged, and untracked state from the captured SHA on main', async () => {
    const baseline = await reviewPipeline.captureBaseline(todo.id, repo, true);
    const implementationHead = commitFile(repo, 'implementation.txt', 'implementation B\n', 'implementation');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged content\n');
    git(repo, 'add', '--', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'unstaged content\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked content Привет 😀\n');

    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    expect(artifact.identity?.baselineCommit).toBe(baseline.baseCommit);
    expect(artifact.identity?.reviewedHeadCommit).toBe(implementationHead);
    expect(artifact.identity?.changedFiles).toEqual([
      'implementation.txt', 'staged.txt', 'tracked.txt', 'untracked.txt',
    ]);
    expect(artifact.summary).toContain('implementation B');
    expect(artifact.summary).toContain('staged content');
    expect(artifact.summary).toContain('unstaged content');
    expect(artifact.summary).toContain('untracked content Привет 😀');
  });

  it('rejects a dirty shared project root instead of attributing existing changes to the task', async () => {
    fs.writeFileSync(path.join(repo, 'preexisting.txt'), 'user change\n');
    await expect(reviewPipeline.captureBaseline(todo.id, repo, true))
      .rejects.toThrow('requires a clean Git working tree');
    expect(queries.getTodoById(todo.id)?.review_baseline).toBeNull();
  });

  it('keeps the original baseline across accumulated worktree implementation and rework commits', async () => {
    const worktree = workspace.resolvePath('task-worktree');
    git(repo, 'worktree', 'add', '-b', 'task-review', worktree);
    queries.updateTodo(todo.id, { worktree_path: worktree, branch_name: 'task-review' });
    const baseline = await reviewPipeline.captureBaseline(todo.id, worktree, false);
    commitFile(worktree, 'implementation.txt', 'B\n', 'implementation B');
    const reworkHead = commitFile(worktree, 'rework.txt', 'C\n', 'rework C');

    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    expect(artifact.identity?.baselineCommit).toBe(baseline.baseCommit);
    expect(artifact.identity?.reviewedHeadCommit).toBe(reworkHead);
    expect(artifact.identity?.changedFiles).toEqual(['implementation.txt', 'rework.txt']);
    expect(artifact.summary).toContain('B');
    expect(artifact.summary).toContain('C');
  });

  it('keeps the captured baseline when the default branch advances later', async () => {
    const worktree = workspace.resolvePath('moving-main-worktree');
    git(repo, 'worktree', 'add', '-b', 'task-moving-main', worktree);
    queries.updateTodo(todo.id, { worktree_path: worktree, branch_name: 'task-moving-main' });
    const baseline = await reviewPipeline.captureBaseline(todo.id, worktree, false);
    commitFile(repo, 'main-only.txt', 'default branch advanced\n', 'advance main');
    commitFile(worktree, 'task-only.txt', 'task state\n', 'task implementation');

    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    expect(artifact.identity?.baselineCommit).toBe(baseline.baseCommit);
    expect(artifact.identity?.changedFiles).toEqual(['task-only.txt']);
    expect(artifact.summary).not.toContain('default branch advanced');
  });

  it('creates a valid identity for a confirmed empty artifact', async () => {
    const baseline = await reviewPipeline.captureBaseline(todo.id, repo, true);
    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);

    expect(artifact.identity).not.toBeNull();
    expect(artifact.identity?.baselineCommit).toBe(baseline.baseCommit);
    expect(artifact.identity?.changedFiles).toEqual([]);
    expect(artifact.summary).toContain('confirmed empty artifact');
  });

  it('fails closed when a legacy task has no immutable baseline', async () => {
    const artifact = await reviewPipeline.collectReviewArtifact(todo, project);
    expect(artifact.identity).toBeNull();
    expect(artifact.summary).toContain('REVIEW EVIDENCE UNAVAILABLE');
  });

  it('fails closed when Git evidence collection errors', async () => {
    await reviewPipeline.captureBaseline(todo.id, repo, true);
    fs.renameSync(path.join(repo, '.git'), path.join(repo, '.git-hidden'));
    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    expect(artifact.identity).toBeNull();
    expect(artifact.summary).toContain('REVIEW EVIDENCE UNAVAILABLE');
  });

  it.skipIf(process.platform === 'win32')('does not follow an untracked symlink outside the repository', async () => {
    await reviewPipeline.captureBaseline(todo.id, repo, true);
    const secret = workspace.resolvePath('outside-secret.txt');
    fs.writeFileSync(secret, 'TOP_SECRET_OUTSIDE_CONTENT\n');
    fs.symlinkSync(secret, path.join(repo, 'outside-link.txt'));

    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    expect(artifact.identity?.untrackedFiles[0]?.kind).toBe('symlink');
    expect(artifact.summary).toContain('Untracked symlink: outside-link.txt');
    expect(artifact.summary).not.toContain('TOP_SECRET_OUTSIDE_CONTENT');
  });

  it('bounds a huge untracked text preview while retaining complete content identity', async () => {
    await reviewPipeline.captureBaseline(todo.id, repo, true);
    const huge = 'large text evidence\n'.repeat(20_000);
    fs.writeFileSync(path.join(repo, 'huge.txt'), huge);

    const artifact = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    const file = artifact.identity?.untrackedFiles.find((entry) => entry.path === 'huge.txt');
    expect(file).toMatchObject({ kind: 'text', size: Buffer.byteLength(huge) });
    expect(file?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(artifact.summary, 'utf8')).toBeLessThan(60 * 1024);
    expect(artifact.summary).toContain('[untracked preview truncated]');
    expect(artifact.summary).not.toContain(huge);
  });

  it('hashes huge binary content and changes identity after a same-size mutation', async () => {
    await reviewPipeline.captureBaseline(todo.id, repo, true);
    const binaryPath = path.join(repo, 'asset.bin');
    fs.writeFileSync(binaryPath, Buffer.alloc(256 * 1024, 0x00));
    const first = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);
    fs.writeFileSync(binaryPath, Buffer.alloc(256 * 1024, 0xff));
    const second = await reviewPipeline.collectReviewArtifact(queries.getTodoById(todo.id)!, project);

    expect(first.identity?.untrackedFiles[0]).toMatchObject({ kind: 'binary', size: 256 * 1024 });
    expect(first.summary).toContain('Binary content omitted');
    expect(first.identity?.untrackedFiles[0].sha256).not.toBe(second.identity?.untrackedFiles[0].sha256);
    expect(first.identity?.worktreeStateHash).not.toBe(second.identity?.worktreeStateHash);
  });
});
