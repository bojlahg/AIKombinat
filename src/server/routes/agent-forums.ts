import { Router, Request, Response } from 'express';
import * as queries from '../db/queries.js';
import { agentForumOrchestrator, ForumNotIdleError, ForumStopIncompleteError } from '../services/agent-forum-orchestrator.js';
import { normalizeExecutionSelection, ExecutionSelectionError } from '../services/execution-selection.js';

const router = Router();

/** Fields that must not change while a cycle is running. */
const RUNNING_LOCKED_FORUM_FIELDS = ['project_id', 'rules', 'max_reply_length'] as const;

/**
 * Backend is authoritative about mutation safety.
 *
 * `running` (or a registered in-memory cycle) means changing the configuration
 * or the participant set would race the in-flight cycle — and, for participant
 * removal, could cascade into the running turn.
 *
 * `error` means a Stop that could not be confirmed or an unresolved orphan
 * process from startup recovery. Mutating a forum in that state is just as
 * unsafe: something from the previous cycle may still be alive. Both stay
 * locked until cleanup succeeds. The UI disables these controls too, but the
 * UI is not the protection.
 */
function isForumLocked(forum: queries.AgentForum): boolean {
  return forum.status === 'running'
    || forum.status === 'error'
    || agentForumOrchestrator.isCycleRegistered(forum.id);
}

function rejectIfLocked(forum: queries.AgentForum, res: Response, action: string): boolean {
  if (!isForumLocked(forum)) return false;
  const reason = forum.status === 'error' && !agentForumOrchestrator.isCycleRegistered(forum.id)
    ? 'Forum requires recovery: the previous cycle was not confirmed stopped.'
    : 'Forum is currently running an agent cycle.';
  res.status(409).json({
    error: `${reason} ${action} is not allowed until it is cleaned up.`,
    code: forum.status === 'error' ? 'forum_recovery_required' : 'forum_running',
  });
  return true;
}

// GET /api/agent-forums - list all forums
router.get('/agent-forums', (req: Request, res: Response) => {
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const forums = queries.listAgentForums(projectId);
    res.json(forums);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/agent-forums - create forum
router.post('/agent-forums', (req: Request, res: Response) => {
  try {
    const { title, rules, max_reply_length, project_id, members } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const maxReplyLength = typeof max_reply_length === 'number' && max_reply_length > 0 ? max_reply_length : 1024;

    if (members !== undefined && !Array.isArray(members)) {
      res.status(400).json({ error: 'members must be an array' });
      return;
    }

    // Validate and normalize EVERY initial member before touching the DB. A
    // malformed or misconfigured member must abort the whole create — silently
    // dropping one would break the all-or-nothing contract by producing a forum
    // with fewer participants than the caller asked for.
    const requestedMembers: unknown[] = Array.isArray(members) ? members : [];
    for (let i = 0; i < requestedMembers.length; i++) {
      const m = requestedMembers[i] as { name?: unknown; role?: unknown } | null;
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        res.status(400).json({ error: `members[${i}] must be an object` });
        return;
      }
      if (typeof m.name !== 'string' || !m.name.trim()) {
        res.status(400).json({ error: `members[${i}].name is required` });
        return;
      }
      if (typeof m.role !== 'string' || !m.role.trim()) {
        res.status(400).json({ error: `members[${i}].role is required` });
        return;
      }
    }

    const normalizedMembers = (requestedMembers as Array<Record<string, unknown>>)
      .map((m) => {
        const execution = normalizeExecutionSelection({
          cliTool: m.cli_tool,
          cliModel: m.cli_model,
          cliModelId: m.cli_model_id,
          cliEffort: m.cli_effort,
          executionProfileId: m.execution_profile_id,
        });
        return {
          name: String(m.name).trim(),
          role: String(m.role).trim(),
          systemPrompt: typeof m.system_prompt === 'string' ? m.system_prompt : '',
          cliTool: execution.cliTool,
          cliModel: execution.cliModel,
          cliModelId: execution.cliModelId,
          executionProfileId: execution.executionProfileId,
          cliEffort: execution.cliEffort,
          avatarColor: typeof m.avatar_color === 'string' ? m.avatar_color : null,
        };
      });

    const forum = queries.createAgentForumWithMembers(
      title.trim(),
      typeof rules === 'string' ? rules : undefined,
      maxReplyLength,
      typeof project_id === 'string' && project_id.trim() ? project_id.trim() : null,
      normalizedMembers,
    );

    const createdMembers = queries.getAgentForumMembers(forum.id);
    const messages = queries.getAgentForumMessages(forum.id);
    const turns = queries.getAgentForumTurns(forum.id);

    res.status(201).json({
      ...forum,
      members: createdMembers,
      messages,
      turns,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(err instanceof ExecutionSelectionError ? 400 : 500).json({ error: message });
  }
});

// GET /api/agent-forums/:id - get forum with details
router.get('/agent-forums/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    const members = queries.getAgentForumMembers(forum.id);
    const messages = queries.getAgentForumMessages(forum.id);
    const turns = queries.getAgentForumTurns(forum.id);

    res.json({
      ...forum,
      members,
      messages,
      turns,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// PUT /api/agent-forums/:id - update forum settings
router.put('/agent-forums/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    const { title, rules, max_reply_length, project_id } = req.body;

    const touchesLockedField = RUNNING_LOCKED_FORUM_FIELDS.some((field) => req.body[field] !== undefined);
    if (touchesLockedField && rejectIfLocked(forum, res, 'Changing forum configuration')) return;

    const updates: Partial<Pick<queries.AgentForum, 'title' | 'rules' | 'max_reply_length' | 'project_id'>> = {};

    if (typeof title === 'string' && title.trim()) updates.title = title.trim();
    if (typeof rules === 'string') updates.rules = rules;
    if (typeof max_reply_length === 'number' && max_reply_length > 0) updates.max_reply_length = max_reply_length;
    if (project_id !== undefined) updates.project_id = project_id || null;

    const updated = queries.updateAgentForum(forum.id, updates);
    const members = queries.getAgentForumMembers(forum.id);
    const messages = queries.getAgentForumMessages(forum.id);
    const turns = queries.getAgentForumTurns(forum.id);

    res.json({
      ...updated,
      members,
      messages,
      turns,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/agent-forums/:id - delete forum
router.delete('/agent-forums/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    // Deleting a live or unrecovered forum is only safe after the full
    // stop/cleanup lifecycle: `stopForum` cancels the cycle, terminates every
    // spawned CLI, waits for in-flight turn startup, and for a forum parked in
    // `error` retries orphan cleanup. If it cannot confirm that, nothing is
    // deleted — the persisted PID and history are exactly what lets us find and
    // reconcile the leftovers later.
    if (isForumLocked(forum)) {
      try {
        await agentForumOrchestrator.stopForum(forum.id);
      } catch (stopErr) {
        if (stopErr instanceof ForumStopIncompleteError) {
          res.status(409).json({
            error: `${stopErr.message} The forum was not deleted; retry once cleanup completes.`,
            code: 'forum_stop_incomplete',
          });
          return;
        }
        throw stopErr;
      }
    }

    queries.deleteAgentForum(forum.id);
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/agent-forums/:id/messages - user posts message & starts cycle
router.post('/agent-forums/:id/messages', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    const { content, parent_message_id } = req.body;
    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const message = await agentForumOrchestrator.postUserMessage(
      forum.id,
      content,
      typeof parent_message_id === 'string' ? parent_message_id : null,
    );

    res.status(201).json(message);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

// POST /api/agent-forums/:id/continue - user skips their turn, agents continue
//
// A skipped turn is a control action, not a message: no `agent_forum_messages`
// row is written. The next cycle runs over the history that already exists, so
// the agents can keep answering each other without another user prompt.
router.post('/agent-forums/:id/continue', (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    // The UI disables the button, but the UI is not the protection: a running
    // forum (or one awaiting recovery) is refused here, and the orchestrator
    // re-checks independently before it starts anything.
    if (rejectIfLocked(forum, res, 'Skipping your turn')) return;

    const updated = agentForumOrchestrator.continueWithoutUserMessage(forum.id);
    res.status(202).json(updated);
  } catch (err) {
    if (err instanceof ForumNotIdleError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

// POST /api/agent-forums/:id/stop - stop active agent cycle
router.post('/agent-forums/:id/stop', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    try {
      await agentForumOrchestrator.stopForum(forum.id);
    } catch (stopErr) {
      if (stopErr instanceof ForumStopIncompleteError) {
        res.status(503).json({
          error: stopErr.message,
          code: 'forum_stop_incomplete',
          forum: queries.getAgentForumById(forum.id),
        });
        return;
      }
      throw stopErr;
    }

    const updated = queries.getAgentForumById(forum.id);
    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ── Member management ──

// POST /api/agent-forums/:id/members - add member
router.post('/agent-forums/:id/members', (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    if (rejectIfLocked(forum, res, 'Adding a participant')) return;

    const { name, role, system_prompt, cli_tool, cli_model, cli_model_id, cli_effort, execution_profile_id, avatar_color } = req.body;
    if (!name || !role) {
      res.status(400).json({ error: 'name and role are required' });
      return;
    }

    const execution = normalizeExecutionSelection({
      cliTool: cli_tool,
      cliModel: cli_model,
      cliModelId: cli_model_id,
      cliEffort: cli_effort,
      executionProfileId: execution_profile_id,
    });

    const member = queries.createAgentForumMember(
      forum.id,
      name,
      role,
      system_prompt || '',
      {
        cliTool: execution.cliTool,
        cliModel: execution.cliModel,
        cliModelId: execution.cliModelId,
        executionProfileId: execution.executionProfileId,
        cliEffort: execution.cliEffort,
        avatarColor: avatar_color,
      },
    );

    res.status(201).json(member);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(err instanceof ExecutionSelectionError ? 400 : 500).json({ error: message });
  }
});

// PUT /api/agent-forums/:id/members/:memberId - update member
router.put('/agent-forums/:id/members/:memberId', (req: Request<{ id: string; memberId: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    const member = queries.getAgentForumMemberById(req.params.memberId);
    if (!member || member.forum_id !== req.params.id) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    if (rejectIfLocked(forum, res, 'Changing a participant')) return;

    const execution = req.body.cli_tool !== undefined || req.body.cli_model !== undefined || req.body.cli_model_id !== undefined || req.body.cli_effort !== undefined || req.body.execution_profile_id !== undefined
      ? normalizeExecutionSelection({
          cliTool: req.body.cli_tool !== undefined ? req.body.cli_tool : member.cli_tool,
          cliModel: req.body.cli_model !== undefined ? req.body.cli_model : (req.body.cli_model_id !== undefined || req.body.execution_profile_id !== undefined ? undefined : member.cli_model),
          cliModelId: req.body.cli_model_id !== undefined ? req.body.cli_model_id : (req.body.cli_model !== undefined || req.body.execution_profile_id !== undefined ? undefined : member.cli_model_id),
          cliEffort: req.body.cli_effort !== undefined ? req.body.cli_effort : member.cli_effort,
          executionProfileId: req.body.execution_profile_id !== undefined ? req.body.execution_profile_id : (req.body.cli_tool !== undefined || req.body.cli_model !== undefined || req.body.cli_model_id !== undefined ? undefined : member.execution_profile_id),
        })
      : null;

    const updated = queries.updateAgentForumMember(
      member.id,
      execution
        ? { ...req.body, cli_tool: execution.cliTool, cli_model: execution.cliModel, cli_model_id: execution.cliModelId, cli_effort: execution.cliEffort, execution_profile_id: execution.executionProfileId }
        : req.body,
    );

    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(err instanceof ExecutionSelectionError ? 400 : 500).json({ error: message });
  }
});

// DELETE /api/agent-forums/:id/members/:memberId - remove member
//
// Once a participant has produced history, removal is a soft-disable: they stop
// taking turns but their turns, execution snapshots and messages stay intact.
// Physically deleting such a row would destroy execution history that the
// surviving messages still reference.
router.delete('/agent-forums/:id/members/:memberId', (req: Request<{ id: string; memberId: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    const member = queries.getAgentForumMemberById(req.params.memberId);
    if (!member || member.forum_id !== req.params.id) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    if (rejectIfLocked(forum, res, 'Removing a participant')) return;

    if (queries.agentForumMemberHasHistory(member.id)) {
      const disabled = queries.setAgentForumMemberActive(member.id, false);
      res.json({ ...disabled, removal: 'soft_disabled' });
      return;
    }

    queries.deleteAgentForumMember(member.id);
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
