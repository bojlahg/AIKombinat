import { Router, Request, Response } from 'express';
import * as queries from '../db/queries.js';
import { agentForumOrchestrator } from '../services/agent-forum-orchestrator.js';
import { normalizeExecutionSelection, ExecutionSelectionError } from '../services/execution-selection.js';

const router = Router();

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
    const forum = queries.createAgentForum(
      title.trim(),
      typeof rules === 'string' ? rules : undefined,
      maxReplyLength,
      typeof project_id === 'string' && project_id.trim() ? project_id.trim() : null,
    );

    // If initial members provided, create them
    if (Array.isArray(members)) {
      for (const m of members) {
        if (m && typeof m === 'object' && m.name && m.role) {
          const execution = normalizeExecutionSelection({
            cliTool: m.cli_tool,
            cliModel: m.cli_model,
            cliModelId: m.cli_model_id,
            cliEffort: m.cli_effort,
            executionProfileId: m.execution_profile_id,
          });

          queries.createAgentForumMember(
            forum.id,
            m.name,
            m.role,
            m.system_prompt || '',
            {
              cliTool: execution.cliTool,
              cliModel: execution.cliModel,
              cliModelId: execution.cliModelId,
              executionProfileId: execution.executionProfileId,
              cliEffort: execution.cliEffort,
              avatarColor: m.avatar_color,
            },
          );
        }
      }
    }

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

    if (forum.status === 'running') {
      await agentForumOrchestrator.stopForum(forum.id);
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

// POST /api/agent-forums/:id/stop - stop active agent cycle
router.post('/agent-forums/:id/stop', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const forum = queries.getAgentForumById(req.params.id);
    if (!forum) {
      res.status(404).json({ error: 'Agent forum not found' });
      return;
    }

    await agentForumOrchestrator.stopForum(forum.id);
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
    const member = queries.getAgentForumMemberById(req.params.memberId);
    if (!member || member.forum_id !== req.params.id) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

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

// DELETE /api/agent-forums/:id/members/:memberId - delete member
router.delete('/agent-forums/:id/members/:memberId', (req: Request<{ id: string; memberId: string }>, res: Response) => {
  try {
    const member = queries.getAgentForumMemberById(req.params.memberId);
    if (!member || member.forum_id !== req.params.id) {
      res.status(404).json({ error: 'Member not found' });
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
