import { get, post, put, del } from './client';
import type { AgentForum, AgentForumDetail, AgentForumMember, AgentForumMessage } from '../types';

export interface CreateAgentForumInput {
  title: string;
  rules?: string;
  max_reply_length?: number;
  project_id?: string | null;
  members?: Array<{
    name: string;
    role: string;
    system_prompt?: string;
    cli_tool?: string | null;
    cli_model?: string | null;
    cli_model_id?: string | null;
    execution_profile_id?: string | null;
    cli_effort?: string | null;
    avatar_color?: string | null;
  }>;
}

export interface UpdateAgentForumInput {
  title?: string;
  rules?: string;
  max_reply_length?: number;
  project_id?: string | null;
}

export interface PostMessageInput {
  content: string;
  parent_message_id?: string | null;
}

export async function listAgentForums(projectId?: string | null): Promise<AgentForum[]> {
  const query = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId || '')}` : '';
  return get<AgentForum[]>(`/api/agent-forums${query}`);
}

export async function getAgentForum(id: string): Promise<AgentForumDetail> {
  return get<AgentForumDetail>(`/api/agent-forums/${id}`);
}

export async function createAgentForum(data: CreateAgentForumInput): Promise<AgentForumDetail> {
  return post<AgentForumDetail>('/api/agent-forums', data);
}

export async function updateAgentForum(id: string, data: UpdateAgentForumInput): Promise<AgentForumDetail> {
  return put<AgentForumDetail>(`/api/agent-forums/${id}`, data);
}

export async function deleteAgentForum(id: string): Promise<void> {
  return del(`/api/agent-forums/${id}`);
}

export async function postUserMessage(forumId: string, data: PostMessageInput): Promise<AgentForumMessage> {
  return post<AgentForumMessage>(`/api/agent-forums/${forumId}/messages`, data);
}

/**
 * The user skips their turn: the next agent cycle runs over the existing
 * history and no user message is created.
 */
export async function continueAgentForum(forumId: string): Promise<AgentForum> {
  return post<AgentForum>(`/api/agent-forums/${forumId}/continue`);
}

export async function stopAgentForum(forumId: string): Promise<AgentForum> {
  return post<AgentForum>(`/api/agent-forums/${forumId}/stop`);
}

export async function addAgentForumMember(
  forumId: string,
  data: Partial<AgentForumMember>,
): Promise<AgentForumMember> {
  return post<AgentForumMember>(`/api/agent-forums/${forumId}/members`, data);
}

export async function updateAgentForumMember(
  forumId: string,
  memberId: string,
  data: Partial<AgentForumMember>,
): Promise<AgentForumMember> {
  return put<AgentForumMember>(`/api/agent-forums/${forumId}/members/${memberId}`, data);
}

export async function deleteAgentForumMember(forumId: string, memberId: string): Promise<void> {
  return del(`/api/agent-forums/${forumId}/members/${memberId}`);
}
