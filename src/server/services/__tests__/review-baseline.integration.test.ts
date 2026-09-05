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
});
