import { get, post, put, del } from './client';
import type { Todo, TaskLog, DiffResult, TaskResult, ImageMeta, TodoExecutionRound } from '../types';

export function getTodos(projectId: string): Promise<Todo[]> {
  return get(`/api/projects/${projectId}/todos`);
}

export function createTodo(
  projectId: string,
  data: {
    title: string;
    description?: string;
    priority?: number;
    cli_tool?: string;
    cli_model?: string;
    cli_model_id?: string | null;
    cli_effort?: string | null;
    execution_profile_id?: string | null;
    execution_profile?: string;
    depends_on?: string;
    max_turns?: number | null;
    use_worktree?: number | null;
    memory_inject_mode?: 'none' | 'all' | 'selected' | 'auto';
    memory_node_ids?: string[];
    memory_raw_file_paths?: string[];
    resource_requirements?: string[];
    review_enabled?: number;
    review_profile_id?: string | null;
    rework_profile_id?: string | null;
    max_review_rounds?: number;
  }
): Promise<Todo> {
  return post(`/api/projects/${projectId}/todos`, data);
}

export function updateTodo(
  id: string,
  data: {
    title?: string;
    description?: string;
    priority?: number;
    cli_tool?: string;
    cli_model?: string;
    cli_model_id?: string | null;
    cli_effort?: string | null;
    execution_profile_id?: string | null;
    execution_profile?: string;
    depends_on?: string | null;
    max_turns?: number | null;
    position_x?: number;
    position_y?: number;
    use_worktree?: number | null;
    memory_inject_mode?: 'none' | 'all' | 'selected' | 'auto';
    memory_node_ids?: string[];
    memory_raw_file_paths?: string[];
    resource_requirements?: string[];
    review_enabled?: number;
    review_profile_id?: string | null;
    rework_profile_id?: string | null;
    max_review_rounds?: number;
    pipeline_phase?: 'implementation' | 'review' | 'rework' | null;
  }
): Promise<Todo> {
  return put(`/api/todos/${id}`, data);
}

export function deleteTodo(id: string): Promise<void> {
  return del(`/api/todos/${id}`);
}

export function startTodo(id: string, mode: 'headless' | 'interactive' | 'verbose' = 'headless'): Promise<Todo> {
  return post(`/api/todos/${id}/start`, { mode });
}

export function stopTodo(id: string): Promise<Todo> {
  return post(`/api/todos/${id}/stop`);
}

export function getTodoLogs(id: string): Promise<TaskLog[]> {
  return get(`/api/todos/${id}/logs`);
}

export function getTodoDiff(id: string): Promise<DiffResult> {
  return get(`/api/todos/${id}/diff`);
}

export function getTodoResult(id: string): Promise<TaskResult> {
  return get(`/api/todos/${id}/result`);
}

export function mergeTodo(id: string): Promise<{ success: boolean; result?: unknown }> {
  return post(`/api/todos/${id}/merge`);
}

export function mergeChain(id: string): Promise<{ success: boolean; result?: unknown; mergedCount: number; mergedIds: string[] }> {
  return post(`/api/todos/${id}/merge-chain`);
}

export function cleanupTodo(id: string, deleteBranch = true): Promise<{ success: boolean; worktreeRemoved: boolean; branchDeleted: boolean }> {
  return post(`/api/todos/${id}/cleanup`, { delete_branch: deleteBranch });
}

export function retryTodo(id: string, mode: 'headless' | 'interactive' | 'verbose' = 'headless'): Promise<Todo> {
  return post(`/api/todos/${id}/retry`, { mode });
}

export function continueTodo(id: string, prompt: string, mode: 'headless' | 'interactive' | 'verbose' = 'headless'): Promise<Todo> {
  return post(`/api/todos/${id}/continue`, { prompt, mode });
}

export function uploadTodoImages(id: string, images: Array<{ name: string; data: string }>): Promise<{ images: ImageMeta[] }> {
  return post(`/api/todos/${id}/images`, { images });
}

export function deleteTodoImage(todoId: string, imageId: string): Promise<void> {
  return del(`/api/todos/${todoId}/images/${imageId}`);
}

export function getTodoImageUrl(todoId: string, imageId: string): string {
  return `/api/todos/${todoId}/images/${imageId}`;
}

export function getTodoRounds(todoId: string): Promise<TodoExecutionRound[]> {
  return get(`/api/todos/${todoId}/rounds`);
}

export function approveReview(todoId: string): Promise<Todo> {
  return post(`/api/todos/${todoId}/review/approve`);
}

export function requestRework(todoId: string): Promise<{ todo: Todo; round: TodoExecutionRound }> {
  return post(`/api/todos/${todoId}/review/rework`);
}

export function stopReviewLoop(todoId: string): Promise<Todo> {
  return post(`/api/todos/${todoId}/review/stop`);
}
