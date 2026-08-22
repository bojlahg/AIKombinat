import { Router, Request, Response } from 'express';
import * as queries from '../db/queries.js';
import { refreshModelCatalog } from '../services/model-sync.js';
import { isAgentCliTool } from '../services/provider-types.js';

const router = Router();

// GET /api/models - get all models grouped by tool
router.get('/models', (_req: Request, res: Response) => {
  try {
    const allModels = queries.getAllModels();
    const result: Record<string, { value: string; label: string; id: string; status: string; supportedEfforts: string[] | null; lastSeenAt: string | null; lastCheckedAt: string | null; source: string }[]> = {};
    for (const [tool, models] of Object.entries(allModels)) {
      result[tool] = models.map((m) => ({
        value: m.model_value,
        label: m.model_label,
        id: m.id,
        status: m.status,
        supportedEfforts: m.supported_efforts ? JSON.parse(m.supported_efforts) : null,
        lastSeenAt: m.last_seen_at,
        lastCheckedAt: m.last_checked_at,
        source: m.source,
      }));
    }
    res.json(result);
  } catch (err) {
    console.error('Failed to fetch models:', err);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

router.post('/models/refresh', async (_req: Request, res: Response) => {
  try {
    const results = await Promise.all((['claude', 'codex', 'antigravity'] as const).map(async (tool) => {
      const result = await refreshModelCatalog(tool, { version: queries.getCliVersion(tool)?.last_version ?? '' });
      return { tool, success: result.primarySucceeded, source: result.source, authoritative: result.authoritative, added: result.added ?? 0, updated: result.updated ?? 0, restored: result.restored ?? 0, markedMissing: result.markedMissing ?? 0 };
    }));
    const success = results.every((result) => result.success);
    res.status(success ? 200 : 503).json({ success, results, ...(!success ? { error: 'One or more live model discovery requests failed; cached catalogs were retained.' } : {}) });
  } catch (err) {
    console.error('Failed to refresh models:', err);
    res.status(500).json({ error: 'Failed to refresh models' });
  }
});

router.post('/models/refresh/:cliTool', async (req: Request<{ cliTool: string }>, res: Response) => {
  if (!isAgentCliTool(req.params.cliTool)) {
    res.status(400).json({ error: 'Unknown cliTool' }); return;
  }
  try {
    const tool = req.params.cliTool;
    const result = await refreshModelCatalog(tool, { version: queries.getCliVersion(tool)?.last_version ?? '' });
    const body = { success: result.primarySucceeded, source: result.source, authoritative: result.authoritative, added: result.added ?? 0, updated: result.updated ?? 0, restored: result.restored ?? 0, markedMissing: result.markedMissing ?? 0 };
    if (!result.primarySucceeded) {
      res.status(503).json({ ...body, error: `Live ${tool} model discovery failed; the cached catalog was retained.` });
      return;
    }
    res.json(body);
  } catch (err) {
    console.error(`Failed to refresh ${req.params.cliTool} models:`, err);
    res.status(500).json({ error: `Failed to refresh ${req.params.cliTool} models` });
  }
});

// POST /api/models - add a custom model
router.post('/models', (req: Request, res: Response) => {
  try {
    const cliTool = req.body?.cliTool ?? req.body?.cli_tool;
    const modelValue = req.body?.modelValue ?? req.body?.model_value;
    const modelLabel = req.body?.modelLabel ?? req.body?.model_label;
    const supportedEfforts = req.body?.supportedEfforts ?? req.body?.supported_efforts;
    if (!isAgentCliTool(cliTool) || typeof modelValue !== 'string' || !modelValue.trim() || typeof modelLabel !== 'string' || !modelLabel.trim()) {
      res.status(400).json({ error: 'cliTool, modelValue, and modelLabel are required' });
      return;
    }
    if (supportedEfforts !== undefined && supportedEfforts !== null && (!Array.isArray(supportedEfforts) || supportedEfforts.some((value) => typeof value !== 'string' || !value.trim()))) {
      res.status(400).json({ error: 'supportedEfforts must be an array of native effort strings or null' }); return;
    }
    const model = queries.addModel(cliTool, modelValue.trim(), modelLabel.trim(), supportedEfforts ?? null);
    res.status(201).json(toApiModel(model));
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Model already exists for this tool' });
      return;
    }
    console.error('Failed to add model:', err);
    res.status(500).json({ error: 'Failed to add model' });
  }
});

router.patch('/models/:id', (req: Request<{ id: string }>, res: Response) => {
  const existing = queries.getModelById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'Model not found' }); return; }
  const modelLabel = req.body?.modelLabel ?? req.body?.model_label;
  const supportedEfforts = req.body?.supportedEfforts ?? req.body?.supported_efforts;
  if (modelLabel !== undefined && (typeof modelLabel !== 'string' || !modelLabel.trim())) {
    res.status(400).json({ error: 'modelLabel must be a non-empty string' }); return;
  }
  if (supportedEfforts !== undefined && supportedEfforts !== null && (!Array.isArray(supportedEfforts) || supportedEfforts.some((value) => typeof value !== 'string' || !value.trim()))) {
    res.status(400).json({ error: 'supportedEfforts must be an array of native effort strings or null' }); return;
  }
  const updated = queries.updateModel(existing.id, {
    ...(modelLabel !== undefined ? { model_label: modelLabel.trim() } : {}),
    ...(supportedEfforts !== undefined ? { supported_efforts: supportedEfforts } : {}),
  });
  res.json(toApiModel(updated!));
});

// DELETE /api/models/:id - remove a custom model
router.delete('/models/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const model = queries.getModelById(req.params.id);
    if (!model) { res.status(404).json({ error: 'Model not found' }); return; }
    const usage = queries.getModelUsage(model.id);
    const usageCount = usage.execution_profiles + usage.todos + usage.schedules + usage.sessions + usage.discussion_agents;
    if (usageCount) {
      res.status(409).json({ error: 'Model is in use', usageCount, usage }); return;
    }
    const removed = queries.removeModel(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove model:', err);
    res.status(500).json({ error: 'Failed to remove model' });
  }
});

function toApiModel(model: queries.CliModel) {
  return {
    id: model.id,
    cliTool: model.cli_tool,
    value: model.model_value,
    label: model.model_label,
    supportedEfforts: model.supported_efforts ? JSON.parse(model.supported_efforts) : null,
    status: model.status,
    source: model.source,
    lastSeenAt: model.last_seen_at,
    lastCheckedAt: model.last_checked_at,
  };
}

export default router;
