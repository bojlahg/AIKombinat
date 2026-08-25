import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

// We need to mock the connection module so queries use our in-memory DB
let testDb: Database.Database;

vi.mock('../connection.js', () => ({
  getDatabase: () => testDb,
}));

// Import queries AFTER mock setup
const queries = await import('../queries.js');

describe('Database Queries', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace('db-queries');
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);
  });

  afterEach(() => {
    testDb.close();
    workspace.cleanup();
  });

  // ── Projects ──

  describe('Projects', () => {
    it('should create a project', () => {
      const projPath = workspace.resolvePath('test-project');
      const project = queries.createProject('Test Project', projPath);
      expect(project).toBeDefined();
      expect(project.id).toBeTruthy();
      expect(project.name).toBe('Test Project');
      expect(project.path).toBe(projPath);
      expect(project.default_branch).toBe('main');
      expect(project.max_concurrent).toBe(3);
    });

    it('should create a project with custom default branch', () => {
      const project = queries.createProject('Test', workspace.resolvePath('test'), 'develop');
      expect(project.default_branch).toBe('develop');
    });

    it('should get all projects', () => {
      queries.createProject('Project A', workspace.resolvePath('a'));
      queries.createProject('Project B', workspace.resolvePath('b'));
      const all = queries.getAllProjects();
      expect(all).toHaveLength(2);
    });

    it('should get project by id', () => {
      const created = queries.createProject('Test', workspace.resolvePath('test-by-id'));
      const found = queries.getProjectById(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Test');
    });

    it('should return undefined for non-existent project', () => {
      const found = queries.getProjectById('non-existent-id');
      expect(found).toBeUndefined();
    });

    it('should update a project', () => {
      const project = queries.createProject('Old Name', workspace.resolvePath('test-update'));
      const updated = queries.updateProject(project.id, { name: 'New Name', max_concurrent: 5 });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('New Name');
      expect(updated!.max_concurrent).toBe(5);
    });

    it('should return project unchanged when no updates provided', () => {
      const project = queries.createProject('Test', workspace.resolvePath('test-no-update'));
      const same = queries.updateProject(project.id, {});
      expect(same!.name).toBe('Test');
    });

    it('should sync non-running todos and schedules that still match previous project CLI defaults', () => {
      const project = queries.createProject('Test', workspace.resolvePath('test-sync'));
      queries.updateProject(project.id, { cli_tool: 'claude', claude_model: 'claude-opus-4-6' });

      const pendingTodo = queries.createTodo(project.id, 'Pending task', undefined, 0, 'claude', 'claude-opus-4-6');
      const runningTodo = queries.createTodo(project.id, 'Running task', undefined, 0, 'claude', 'claude-opus-4-6');
      const customTodo = queries.createTodo(project.id, 'Custom task', undefined, 0, 'codex', 'o3');
      queries.updateTodoStatus(runningTodo.id, 'running');

      const schedule = queries.createSchedule(project.id, 'Nightly', undefined, '0 0 * * *', 'claude', 'claude-opus-4-6');
      const customSchedule = queries.createSchedule(project.id, 'Custom', undefined, '0 1 * * *', 'codex', 'o3');

      const result = queries.syncProjectCliDefaults(
        project.id,
        'claude',
        'claude-opus-4-6',
        'antigravity',
        'antigravity-default'
      );

      expect(result.updatedTodos).toBe(1);
      expect(result.updatedSchedules).toBe(1);

      expect(queries.getTodoById(pendingTodo.id)?.cli_tool).toBe('antigravity');
      expect(queries.getTodoById(pendingTodo.id)?.cli_model).toBe('antigravity-default');
      expect(queries.getTodoById(runningTodo.id)?.cli_tool).toBe('claude');
      expect(queries.getTodoById(customTodo.id)?.cli_tool).toBe('codex');
      expect(queries.getScheduleById(schedule.id)?.cli_tool).toBe('antigravity');
      expect(queries.getScheduleById(customSchedule.id)?.cli_tool).toBe('codex');
    });

    it('should delete a project', () => {
      const project = queries.createProject('Test', workspace.resolvePath('test-delete'));
      const deleted = queries.deleteProject(project.id);
      expect(deleted).toBe(true);
      expect(queries.getProjectById(project.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent project', () => {
      const deleted = queries.deleteProject('non-existent');
      expect(deleted).toBe(false);
    });

    it('should enforce unique path constraint', () => {
      queries.createProject('A', workspace.resolvePath('unique'));
      expect(() => queries.createProject('B', workspace.resolvePath('unique'))).toThrow();
    });
  });

  // ── Todos ──

  describe('Todos', () => {
    let projectId: string;

    beforeEach(() => {
      const project = queries.createProject('Test Project', workspace.resolvePath(`test-${Date.now()}`));
      projectId = project.id;
    });

    it('should create a todo', () => {
      const todo = queries.createTodo(projectId, 'Fix bug');
      expect(todo).toBeDefined();
      expect(todo.title).toBe('Fix bug');
      expect(todo.status).toBe('pending');
      expect(todo.priority).toBe(0);
      expect(todo.project_id).toBe(projectId);
    });

    it('should create a todo with description and priority', () => {
      const todo = queries.createTodo(projectId, 'Feature', 'Add login', 5);
      expect(todo.description).toBe('Add login');
      expect(todo.priority).toBe(5);
    });

    it('should get todos by project id', () => {
      queries.createTodo(projectId, 'Task 1');
      queries.createTodo(projectId, 'Task 2');
      const todos = queries.getTodosByProjectId(projectId);
      expect(todos).toHaveLength(2);
    });

    it('should get todo by id', () => {
      const created = queries.createTodo(projectId, 'Task');
      const found = queries.getTodoById(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Task');
    });

    it('should update a todo', () => {
      const todo = queries.createTodo(projectId, 'Old Title');
      const updated = queries.updateTodo(todo.id, { title: 'New Title', priority: 10 });
      expect(updated!.title).toBe('New Title');
      expect(updated!.priority).toBe(10);
    });

    it('should update todo status', () => {
      const todo = queries.createTodo(projectId, 'Task');
      const updated = queries.updateTodoStatus(todo.id, 'running');
      expect(updated!.status).toBe('running');
    });

    it('should get todos by status', () => {
      queries.createTodo(projectId, 'Task 1');
      queries.createTodo(projectId, 'Task 2');
      const todo3 = queries.createTodo(projectId, 'Task 3');
      queries.updateTodoStatus(todo3.id, 'running');

      const pending = queries.getTodosByStatus('pending');
      expect(pending).toHaveLength(2);

      const running = queries.getTodosByStatus('running');
      expect(running).toHaveLength(1);
    });

    it('should delete a todo', () => {
      const todo = queries.createTodo(projectId, 'Task');
      expect(queries.deleteTodo(todo.id)).toBe(true);
      expect(queries.getTodoById(todo.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent todo', () => {
      expect(queries.deleteTodo('non-existent')).toBe(false);
    });

    it('should cascade delete todos when project is deleted', () => {
      const todo = queries.createTodo(projectId, 'Task');
      queries.deleteProject(projectId);
      expect(queries.getTodoById(todo.id)).toBeUndefined();
    });
  });

  // ── Task Logs ──

  describe('Task Logs', () => {
    let todoId: string;

    beforeEach(() => {
      const project = queries.createProject('Test', workspace.resolvePath(`log-test-${Date.now()}`));
      const todo = queries.createTodo(project.id, 'Task');
      todoId = todo.id;
    });

    it('should create a task log', () => {
      const log = queries.createTaskLog(todoId, 'output', 'Hello world');
      expect(log).toBeDefined();
      expect(log.todo_id).toBe(todoId);
      expect(log.log_type).toBe('output');
      expect(log.message).toBe('Hello world');
    });

    it('should get task logs by todo id', () => {
      queries.createTaskLog(todoId, 'output', 'Line 1');
      queries.createTaskLog(todoId, 'error', 'Line 2');
      queries.createTaskLog(todoId, 'commit', 'commit abc123');

      const logs = queries.getTaskLogsByTodoId(todoId);
      expect(logs).toHaveLength(3);
      expect(logs[0].log_type).toBe('output');
      expect(logs[2].log_type).toBe('commit');
    });

    it('should clean old logs', () => {
      queries.createTaskLog(todoId, 'output', 'Recent log');
      // Manually insert an old log
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      testDb.prepare(
        `INSERT INTO task_logs (id, todo_id, log_type, message, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run('old-log-id', todoId, 'output', 'Old log', oldDate);

      const deleted = queries.cleanOldLogs(30);
      expect(deleted).toBe(1);

      const remaining = queries.getTaskLogsByTodoId(todoId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].message).toBe('Recent log');
    });
  });

  // ── Session Raw Chunks ──

  describe('trimSessionRawChunks', () => {
    let sessionId: string;

    beforeEach(() => {
      const project = queries.createProject('Chunks', workspace.resolvePath('chunks'));
      sessionId = queries.createSession(project.id, 'chunk session').id;
    });

    it('keeps everything when under the cap', () => {
      queries.appendSessionRawChunk(sessionId, Buffer.alloc(100));
      queries.appendSessionRawChunk(sessionId, Buffer.alloc(100));
      expect(queries.trimSessionRawChunks(sessionId, 300)).toBe(0);
      expect(queries.getSessionRawChunks(sessionId)).toHaveLength(2);
    });

    it('drops oldest chunks until the newest suffix fits the cap', () => {
      for (let i = 0; i < 5; i++) {
        queries.appendSessionRawChunk(sessionId, Buffer.alloc(100, i));
      }
      // Cap of 250 keeps the newest two (200 bytes); the third would overflow.
      expect(queries.trimSessionRawChunks(sessionId, 250)).toBe(3);
      const rows = queries.getSessionRawChunks(sessionId);
      expect(rows.map(r => r.seq)).toEqual([3, 4]);
    });

    it('getRecentSessionRawText reads only a bounded subset since minSeq', () => {
      // Append 500 chunks of 100 bytes each
      for (let i = 0; i < 500; i++) {
        queries.appendSessionRawChunk(sessionId, Buffer.from(`chunk-${i.toString().padStart(4, '0')}\n`));
      }

      // Query only since chunk 450 (minSeq = 450) with 1024 bytes max
      const textSince450 = queries.getRecentSessionRawText(sessionId, 1024, 450);
      expect(textSince450).toContain('chunk-0450');
      expect(textSince450).toContain('chunk-0499');
      expect(textSince450).not.toContain('chunk-0449');

      // Cap to 50 bytes (roughly last 4 chunks)
      const smallTail = queries.getRecentSessionRawText(sessionId, 50, 450);
      expect(smallTail).toContain('chunk-0499');
      expect(smallTail).not.toContain('chunk-0450');
    });

    it('bounds eligible chunks by maxChunks and retains newest in chronological order', () => {
      // Append 300 chunks (all eligible with minSeq = 0 or minSeq omitted)
      for (let i = 0; i < 300; i++) {
        queries.appendSessionRawChunk(sessionId, Buffer.from(`chunk-${i.toString().padStart(4, '0')}\n`));
      }

      // Default maxChunks is 200, large maxBytes allows full 200 chunks (each is ~11 bytes)
      const text = queries.getRecentSessionRawText(sessionId, 64 * 1024, 0, 200);

      // Chunks 0..99 must be excluded because maxChunks = 200 retains newest (100..299)
      expect(text).not.toContain('chunk-0000');
      expect(text).not.toContain('chunk-0099');
      expect(text).toContain('chunk-0100');
      expect(text).toContain('chunk-0299');

      // Verify chronological order
      const idx100 = text.indexOf('chunk-0100');
      const idx200 = text.indexOf('chunk-0200');
      const idx299 = text.indexOf('chunk-0299');
      expect(idx100).toBeLessThan(idx200);
      expect(idx200).toBeLessThan(idx299);
    });

    it('bounds single chunk larger than maxBytes to requested tail', () => {
      const largeContent = 'PREFIX_HEADER_' + 'x'.repeat(1000) + '_TAIL_SUFFIX';
      queries.appendSessionRawChunk(sessionId, Buffer.from(largeContent));

      const maxBytes = 50;
      const text = queries.getRecentSessionRawText(sessionId, maxBytes);
      expect(text.length).toBe(maxBytes);
      expect(text).toContain('_TAIL_SUFFIX');
      expect(text).not.toContain('PREFIX_HEADER_');
      expect(text).toBe(largeContent.slice(largeContent.length - maxBytes));
    });
  });

  describe('getRecentTaskLogText', () => {
    let todoId: string;

    beforeEach(() => {
      const project = queries.createProject('Test Log Boundary', workspace.resolvePath(`log-bound-${Date.now()}`));
      todoId = queries.createTodo(project.id, 'Log Boundary Task').id;
    });

    it('reads only logs created after minRowid', () => {
      queries.createTaskLog(todoId, 'output', 'Run 1: error quota limit reached');
      const startRowid = queries.getMaxTaskLogRowid(todoId);

      queries.createTaskLog(todoId, 'output', 'Run 2: normal line 1');
      queries.createTaskLog(todoId, 'error', 'Run 2: git command not found');

      const currentRunOutput = queries.getRecentTaskLogText(todoId, startRowid, 1024);
      expect(currentRunOutput).toContain('Run 2: normal line 1');
      expect(currentRunOutput).toContain('Run 2: git command not found');
      expect(currentRunOutput).not.toContain('quota limit reached');
    });

    it('retains newest task logs under maxRows and maxBytes limits in chronological order', () => {
      // Insert 250 log rows
      for (let i = 0; i < 250; i++) {
        queries.createTaskLog(todoId, 'output', `log-row-${i.toString().padStart(4, '0')}`);
      }

      // Request maxRows = 50 with large maxBytes
      const textLimitedRows = queries.getRecentTaskLogText(todoId, undefined, 64 * 1024, 50);
      expect(textLimitedRows).not.toContain('log-row-0000');
      expect(textLimitedRows).not.toContain('log-row-0199');
      expect(textLimitedRows).toContain('log-row-0200');
      expect(textLimitedRows).toContain('log-row-0249');

      // Verify chronological reconstruction
      const idx200 = textLimitedRows.indexOf('log-row-0200');
      const idx225 = textLimitedRows.indexOf('log-row-0225');
      const idx249 = textLimitedRows.indexOf('log-row-0249');
      expect(idx200).toBeLessThan(idx225);
      expect(idx225).toBeLessThan(idx249);

      // Request with tight maxBytes
      const textLimitedBytes = queries.getRecentTaskLogText(todoId, undefined, 60, 200);
      expect(textLimitedBytes.length).toBeLessThanOrEqual(60);
      expect(textLimitedBytes).toContain('log-row-0249');
      expect(textLimitedBytes).not.toContain('log-row-0200');
    });
  });
});
