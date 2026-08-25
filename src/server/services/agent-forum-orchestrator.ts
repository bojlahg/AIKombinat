import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeManager } from './claude-manager.js';
import { getAdapter, type CliTool, type SandboxMode } from './cli-adapters.js';
import { isAgentCliTool } from './provider-types.js';
import { executionSnapshot, resolveExecutionConfig } from './execution-config.js';
import { broadcaster } from '../websocket/broadcaster.js';
import * as queries from '../db/queries.js';
import { executorPool } from './executor-pool.js';
import { orchestrator, configureClaudeSandboxPermissions } from './orchestrator.js';
import { providerQuotaService } from './provider-quota.js';
import { classifyProviderFailure } from './failure-classifier.js';
import type { ResolvedExecutionConfig } from './execution-config.js';
import { assertTestRuntimePathAllowed } from '../utils/test-fs-guard.js';
import { extractStructuredReplies, type AgentForumReply } from './agent-forum-extractor.js';

export interface AvailableTargetInfo {
  id: string;
  authorName: string;
  authorRole: string;
  authorType: 'user' | 'agent';
  snippet: string;
}

export class AgentForumOrchestrator {
  private activePids: Map<string, number> = new Map();
  private abortControllers: Map<string, boolean> = new Map();

  /**
   * User posts a message and starts a sequential cycle.
   */
  async postUserMessage(
    forumId: string,
    content: string,
    parentMessageId?: string | null,
  ): Promise<queries.AgentForumMessage> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) throw new Error('Agent forum not found');

    if (forum.status === 'running') {
      throw new Error('Forum is currently running an agent cycle. Please wait for it to complete.');
    }

    if (parentMessageId) {
      const parentMsg = queries.getAgentForumMessageById(parentMessageId);
      if (!parentMsg || parentMsg.forum_id !== forumId) {
        throw new Error('Parent message not found in this forum');
      }
    }

    const userMsg = queries.createAgentForumMessage(
      forumId,
      'user',
      null,
      'User',
      'User',
      content.trim(),
      parentMessageId,
    );

    broadcaster.broadcast({
      type: 'forum:message-created',
      forumId,
      message: userMsg,
    });

    // Start cycle in background
    this.runCycle(forumId).catch((err) => {
      console.error(`[agent-forum] Cycle error in forum ${forumId}:`, err);
    });

    return userMsg;
  }

  /**
   * Stop an active forum cycle.
   */
  async stopForum(forumId: string): Promise<void> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) throw new Error('Agent forum not found');

    this.abortControllers.set(forumId, true);

    const pid = this.activePids.get(forumId);
    if (pid) {
      await claudeManager.stopClaude(pid);
      this.activePids.delete(forumId);
    }

    queries.updateAgentForum(forumId, {
      status: 'idle',
      current_member_id: null,
    });

    broadcaster.broadcast({
      type: 'forum:status-changed',
      forumId,
      status: 'idle',
      currentCycle: forum.current_cycle,
      currentMemberId: null,
    });

    orchestrator.wakeWaitingExecutors().catch(() => {});
  }

  /**
   * Runs a complete sequential cycle of all members in round-robin order.
   */
  async runCycle(forumId: string): Promise<void> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) return;

    const members = queries.getAgentForumMembers(forumId);
    if (members.length < 2) {
      console.warn(`[agent-forum] Forum ${forumId} has fewer than 2 members. Skipping cycle.`);
      return;
    }

    const nextCycleNumber = forum.current_cycle + 1;
    this.abortControllers.set(forumId, false);

    queries.updateAgentForum(forumId, {
      status: 'running',
      current_cycle: nextCycleNumber,
      current_member_id: null,
    });

    broadcaster.broadcast({
      type: 'forum:status-changed',
      forumId,
      status: 'running',
      currentCycle: nextCycleNumber,
      currentMemberId: null,
    });

    // Determine round-robin member rotation for this cycle
    const memberCount = members.length;
    const offset = (nextCycleNumber - 1) % memberCount;
    const orderedMembers: queries.AgentForumMember[] = [];
    for (let i = 0; i < memberCount; i++) {
      orderedMembers.push(members[(offset + i) % memberCount]);
    }

    try {
      for (let turnOrder = 0; turnOrder < orderedMembers.length; turnOrder++) {
        if (this.abortControllers.get(forumId)) {
          break;
        }

        const member = orderedMembers[turnOrder];
        await this.runMemberTurn(forumId, member, nextCycleNumber, turnOrder);
      }
    } finally {
      this.activePids.delete(forumId);
      this.abortControllers.delete(forumId);

      const finalForum = queries.getAgentForumById(forumId);
      if (finalForum && finalForum.status === 'running') {
        queries.updateAgentForum(forumId, {
          status: 'idle',
          current_member_id: null,
        });

        broadcaster.broadcast({
          type: 'forum:status-changed',
          forumId,
          status: 'idle',
          currentCycle: nextCycleNumber,
          currentMemberId: null,
        });

        orchestrator.wakeWaitingExecutors().catch(() => {});
      }
    }
  }

  /**
   * Runs a single turn for a specific member in the forum.
   */
  private async runMemberTurn(
    forumId: string,
    member: queries.AgentForumMember,
    cycleNumber: number,
    turnOrder: number,
  ): Promise<void> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) return;

    const project = forum.project_id ? (queries.getProjectById(forum.project_id) ?? null) : null;
    let workDir: string;
    if (project) {
      workDir = project.path;
    } else {
      workDir = path.join(os.tmpdir(), 'aikombinat-forum', forumId);
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
      }
    }

    const turn = queries.createAgentForumTurn(forumId, member.id, cycleNumber, turnOrder);

    queries.updateAgentForum(forumId, { current_member_id: member.id });
    broadcaster.broadcast({
      type: 'forum:status-changed',
      forumId,
      status: 'running',
      currentCycle: cycleNumber,
      currentMemberId: member.id,
    });

    queries.updateAgentForumTurn(turn.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    broadcaster.broadcast({
      type: 'forum:turn-started',
      forumId,
      turnId: turn.id,
      memberId: member.id,
      memberName: member.name,
      cycleNumber,
      turnOrder,
    });

    // 1. Determine available reply targets for this member
    const allMessages = queries.getAgentForumMessages(forumId);
    const alreadyRepliedTargets = queries.getAgentRepliedTargetMessageIds(forumId, member.id);

    const availableTargets: AvailableTargetInfo[] = [];
    const availableTargetIds = new Set<string>();

    for (const msg of allMessages) {
      // Agent cannot reply to its own messages
      if (msg.author_id === member.id) continue;
      // Agent cannot reply to same message more than once in entire conversation
      if (alreadyRepliedTargets.has(msg.id)) continue;

      const snippet = msg.content.length > 80 ? `${msg.content.slice(0, 80)}...` : msg.content;
      availableTargets.push({
        id: msg.id,
        authorName: msg.author_name,
        authorRole: msg.author_role,
        authorType: msg.author_type,
        snippet,
      });
      availableTargetIds.add(msg.id);
    }

    // 2. Build prompt
    const prompt = this.buildTurnPrompt(forum, member, project, allMessages, availableTargets);

    // 3. Resolve execution configuration & quota
    const cliTool = (member.cli_tool || project?.cli_tool || 'claude') as CliTool;
    const cliModel = member.cli_model ?? undefined;
    let executionConfig: ResolvedExecutionConfig | null = null;
    let resolvedCliTool = cliTool;

    if (member.execution_profile_id) {
      const selection = await executorPool.selectExecutor({
        executionProfileId: member.execution_profile_id,
        excludeDiscussionId: forumId,
        reserveOwnerId: forumId,
      });

      if (selection.status === 'waiting_executor' || selection.status === 'no_candidates') {
        const errorMsg = selection.status === 'waiting_executor'
          ? `[executor-pool] Waiting for executor capacity (profile "${selection.profileName}")`
          : `[executor-pool] No eligible executors for profile "${selection.profileName}"`;

        queries.updateAgentForumTurn(turn.id, {
          status: 'failed',
          error_message: errorMsg,
          completed_at: new Date().toISOString(),
        });

        broadcaster.broadcast({
          type: 'forum:turn-failed',
          forumId,
          turnId: turn.id,
          memberId: member.id,
          memberName: member.name,
          error: errorMsg,
        });
        return;
      }

      executionConfig = selection.selectedConfig!;
      resolvedCliTool = executionConfig.cliTool;
    } else {
      if (isAgentCliTool(cliTool) || member.cli_model_id || member.cli_effort) {
        executionConfig = resolveExecutionConfig({
          cliTool,
          model: cliModel,
          cliModelId: member.cli_model_id,
          cliEffort: member.cli_effort,
        });
        resolvedCliTool = executionConfig.cliTool;
      }

      if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
        const quota = providerQuotaService.getQuotaState(resolvedCliTool);
        if (quota.state === 'exhausted') {
          const adapter = getAdapter(resolvedCliTool);
          const errorMsg = `Provider quota exhausted for ${adapter.displayName} (${quota.reason || 'quota exhausted'})`;

          queries.updateAgentForumTurn(turn.id, {
            status: 'failed',
            error_message: errorMsg,
            completed_at: new Date().toISOString(),
          });

          broadcaster.broadcast({
            type: 'forum:turn-failed',
            forumId,
            turnId: turn.id,
            memberId: member.id,
            memberName: member.name,
            error: errorMsg,
          });
          return;
        }
      }

      const reserved = executorPool.reserveSlot(forumId, resolvedCliTool, { excludeDiscussionId: forumId });
      if (!reserved) {
        const adapter = getAdapter(resolvedCliTool);
        const errorMsg = `Provider concurrency limit reached for ${adapter.displayName}`;

        queries.updateAgentForumTurn(turn.id, {
          status: 'failed',
          error_message: errorMsg,
          completed_at: new Date().toISOString(),
        });

        broadcaster.broadcast({
          type: 'forum:turn-failed',
          forumId,
          turnId: turn.id,
          memberId: member.id,
          memberName: member.name,
          error: errorMsg,
        });
        return;
      }
    }

    const snapshotStr = executionConfig
      ? JSON.stringify(executionSnapshot(executionConfig))
      : JSON.stringify({ configuration: 'manual', agent: resolvedCliTool });

    queries.updateAgentForumTurn(turn.id, { execution_snapshot: snapshotStr });
    executorPool.releaseReservation(forumId);

    const cliOptions = project?.claude_options || undefined;
    const maxTurns = 5;

    try {
      assertTestRuntimePathAllowed(workDir);
      const sandboxMode: SandboxMode = (project?.sandbox_mode as SandboxMode) || 'strict';

      if (sandboxMode === 'strict' && resolvedCliTool === 'claude' && project && workDir !== project.path) {
        try {
          configureClaudeSandboxPermissions(workDir);
        } catch { /* ignore */ }
      }

      const launchModel = executionConfig?.effectiveModel ?? executionConfig?.model;
      const launchEffort = (resolvedCliTool === 'antigravity' && executionConfig?.effectiveModel && executionConfig.effectiveModel !== executionConfig.model)
        ? undefined
        : executionConfig?.effort.nativeEffort;

      const result = await claudeManager.startClaude(
        workDir,
        prompt,
        launchModel,
        cliOptions,
        'headless',
        resolvedCliTool,
        maxTurns,
        project ? project.path : workDir,
        sandboxMode,
        undefined,
        undefined,
        undefined,
        launchEffort,
      );

      this.activePids.set(forumId, result.pid);

      const outputBuffer: string[] = [];
      if (typeof result.stdout.setEncoding === 'function') {
        result.stdout.setEncoding('utf8');
      }
      if (typeof result.stderr.setEncoding === 'function') {
        result.stderr.setEncoding('utf8');
      }

      const adapter = getAdapter(resolvedCliTool);
      const isJsonMode = adapter.outputFormat === 'stream-json';

      result.stdout.on('data', (chunk: string) => {
        if (isJsonMode) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'assistant') {
                const contentArr = evt.message?.content as Array<Record<string, unknown>> | undefined;
                if (contentArr) {
                  for (const blk of contentArr) {
                    if (blk.type === 'text' && typeof blk.text === 'string') {
                      outputBuffer.push(blk.text);
                    }
                  }
                }
              } else if (evt.type === 'content_block_delta' && evt.delta?.text) {
                outputBuffer.push(evt.delta.text);
              } else if (Array.isArray(evt.replies)) {
                outputBuffer.push(line);
              }
            } catch {
              outputBuffer.push(line);
            }
          }
        } else {
          outputBuffer.push(chunk);
        }
      });

      const exitCode = await result.exitPromise;
      this.activePids.delete(forumId);

      const fullOutput = outputBuffer.join('\n').trim();

      if (exitCode === 0) {
        if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
          providerQuotaService.markAvailable(resolvedCliTool, { source: 'execution_success' });
        }

        // Parse and validate structured output
        let validatedReplies: AgentForumReply[];
        try {
          validatedReplies = extractStructuredReplies(fullOutput, {
            availableTargetIds,
            maxReplyLength: forum.max_reply_length,
            currentAgentName: member.name,
          });
        } catch (validationErr) {
          const errMsg = validationErr instanceof Error ? validationErr.message : String(validationErr);
          queries.updateAgentForumTurn(turn.id, {
            status: 'failed',
            raw_output: fullOutput,
            error_message: errMsg,
            completed_at: new Date().toISOString(),
          });

          broadcaster.broadcast({
            type: 'forum:turn-failed',
            forumId,
            turnId: turn.id,
            memberId: member.id,
            memberName: member.name,
            error: errMsg,
          });
          return;
        }

        if (validatedReplies.length === 0) {
          // PASS — no message created
          queries.updateAgentForumTurn(turn.id, {
            status: 'passed',
            raw_output: fullOutput,
            completed_at: new Date().toISOString(),
          });

          broadcaster.broadcast({
            type: 'forum:turn-completed',
            forumId,
            turnId: turn.id,
            memberId: member.id,
            memberName: member.name,
            status: 'passed',
            repliesCount: 0,
          });
        } else {
          // Persist each reply as a message node
          for (const reply of validatedReplies) {
            const msg = queries.createAgentForumMessage(
              forumId,
              'agent',
              member.id,
              member.name,
              member.role,
              reply.content,
              reply.replyTo,
              turn.id,
            );

            broadcaster.broadcast({
              type: 'forum:message-created',
              forumId,
              message: msg,
            });
          }

          queries.updateAgentForumTurn(turn.id, {
            status: 'completed',
            raw_output: fullOutput,
            completed_at: new Date().toISOString(),
          });

          broadcaster.broadcast({
            type: 'forum:turn-completed',
            forumId,
            turnId: turn.id,
            memberId: member.id,
            memberName: member.name,
            status: 'completed',
            repliesCount: validatedReplies.length,
          });
        }
      } else {
        const classification = classifyProviderFailure(resolvedCliTool, exitCode, fullOutput);
        if (classification.category === 'quota_exhausted' || classification.category === 'rate_limited') {
          if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
            providerQuotaService.markExhausted(resolvedCliTool, {
              source: 'runtime_rejection',
              reason: classification.reason,
              resetAt: classification.resetAt,
            });
          }
        }

        const errMsg = `Process failed with exit code ${exitCode}: ${classification.reason || fullOutput.slice(-300)}`;
        queries.updateAgentForumTurn(turn.id, {
          status: 'failed',
          raw_output: fullOutput,
          error_message: errMsg,
          completed_at: new Date().toISOString(),
        });

        broadcaster.broadcast({
          type: 'forum:turn-failed',
          forumId,
          turnId: turn.id,
          memberId: member.id,
          memberName: member.name,
          error: errMsg,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      queries.updateAgentForumTurn(turn.id, {
        status: 'failed',
        error_message: errMsg,
        completed_at: new Date().toISOString(),
      });

      broadcaster.broadcast({
        type: 'forum:turn-failed',
        forumId,
        turnId: turn.id,
        memberId: member.id,
        memberName: member.name,
        error: errMsg,
      });
    }
  }

  /**
   * Builds the comprehensive prompt for an agent's turn.
   */
  private buildTurnPrompt(
    forum: queries.AgentForum,
    member: queries.AgentForumMember,
    project: queries.Project | null,
    allMessages: queries.AgentForumMessage[],
    availableTargets: AvailableTargetInfo[],
  ): string {
    // 1. Shared Project Context (if project mode)
    let projectContextBlock = '';
    if (project) {
      const filesToRead = ['AGENTS.md', 'PROJECT-MAP.md', 'README.md'];
      const sections: string[] = [];

      for (const fileName of filesToRead) {
        const filePath = path.join(project.path, fileName);
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const truncated = content.length > 8000 ? `${content.slice(0, 8000)}\n...(truncated)` : content;
            sections.push(`### ${fileName}\n${truncated}`);
          }
        } catch { /* ignore */ }
      }

      if (sections.length > 0) {
        projectContextBlock = `## Shared Project Context\nProject Name: ${project.name}\n\n${sections.join('\n\n')}\n`;
      }
    }

    // 2. Full Conversation History
    let historyBlock = '## Full Forum Conversation History\n';
    if (allMessages.length === 0) {
      historyBlock += '(No messages yet)\n';
    } else {
      const msgMap = new Map<string, queries.AgentForumMessage>(allMessages.map((m) => [m.id, m]));
      for (const msg of allMessages) {
        const replyInfo = msg.parent_message_id
          ? ` [in reply to message "${msg.parent_message_id}" by ${msgMap.get(msg.parent_message_id)?.author_name ?? 'Unknown'}]`
          : ' [root message]';
        historyBlock += `--- Message ID: ${msg.id} | Author: ${msg.author_name} (${msg.author_role || msg.author_type})${replyInfo} ---\n${msg.content}\n\n`;
      }
    }

    // 3. Available Reply Targets for this specific agent
    let targetsBlock = `## Available Reply Targets for YOU (${member.name})\n`;
    if (availableTargets.length === 0) {
      targetsBlock += 'No available targets to reply to. (You must return an empty replies list: {"replies": []})\n';
    } else {
      targetsBlock += 'You may reply ONLY to one or more of the following message IDs:\n';
      for (const target of availableTargets) {
        targetsBlock += `- ${target.id} — Author: ${target.authorName} (${target.authorRole || target.authorType}): "${target.snippet}"\n`;
      }
      targetsBlock += '\n(Note: You CANNOT reply to your own messages or to messages you already replied to previously.)\n';
    }

    const memberRole = member.role ? `a ${member.role}` : 'an AI participant';
    const systemPrompt = member.system_prompt ? `\n\nPersona Instructions:\n${member.system_prompt}` : '';

    return `You are ${member.name}, ${memberRole} participating in a structured multi-agent forum discussion.${systemPrompt}

## Forum Rules
${forum.rules}

${projectContextBlock}
${historyBlock}
${targetsBlock}
## Reply Constraints & Instructions
- Maximum length per individual reply: ${forum.max_reply_length} characters.
- You can reply to 0, 1, or multiple available target messages in this turn.
- If you have no meaningful critique, alternative, objection, answer, or new insight to add, return an empty replies list: {"replies": []}.
- DO NOT repeat what has already been said without adding new value.

## Output Format Requirement
You MUST respond with a JSON object strictly matching this schema:
\`\`\`json
{
  "replies": [
    {
      "replyTo": "<valid_message_id_from_available_targets_list>",
      "content": "<your concise reply text, max ${forum.max_reply_length} chars>"
    }
  ]
}
\`\`\`
If you have nothing to add (PASS), output:
\`\`\`json
{
  "replies": []
}
\`\`\`
Respond ONLY with the JSON object. Do not include extra conversational filler outside the JSON.`;
  }
}

export const agentForumOrchestrator = new AgentForumOrchestrator();
