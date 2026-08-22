import { Router, Request, Response } from 'express';
import * as queries from '../db/queries.js';
import { refreshModelCatalog } from '../services/model-sync.js';
import { isAgentCliTool } from '../services/effort-profiles.js';

const router = Router();

// GET /api/models - get all models grouped by tool
router.get('/models', (_req: Request, res: Response) => {
  try {
    const allModels = queries.getAllModels();
    const result: Record<string, { value: string; label: string; id: string; isDefault: boolean; deprecated: boolean; availabilityStatus: string; supportedEfforts: string[] | null; lastSeenAt: string | null; lastCheckedAt: string | null; source: string }[]> = {};
    for (const [tool, models] of Object.entries(allModels)) {
      result[tool] = models.map((m) => ({
        value: m.model_value,
        label: m.model_label,
        id: m.id,
        isDefault: m.is_default === 1,
        deprecated: m.deprecated === 1,
        availabilityStatus: m.availability_status,
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
      return { tool, source: result.source, authoritative: result.authoritative, primarySucceeded: result.primarySucceeded, count: result.models.length };
    }));
    const success = results.every((result) => result.primarySucceeded);
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
    const body = { success: result.primarySucceeded, source: result.source, authoritative: result.authoritative, count: result.models.length };
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
    const { cliTool, modelValue, modelLabel } = req.body;
    if (!cliTool || !modelValue || !modelLabel) {
      res.status(400).json({ error: 'cliTool, modelValue, and modelLabel are required' });
      return;
    }
    const model = queries.addModel(cliTool, modelValue, modelLabel);
    res.status(201).json({
      value: model.model_value,
      label: model.model_label,
      id: model.id,
      isDefault: model.is_default === 1,
      deprecated: model.deprecated === 1,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Model already exists for this tool' });
      return;
    }
    console.error('Failed to add model:', err);
    res.status(500).json({ error: 'Failed to add model' });
  }
});

// DELETE /api/models/:id - remove a custom model
router.delete('/models/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const removed = queries.removeModel(req.params.id);
    if (!removed) {
      res.status(400).json({ error: 'Cannot remove default model or model not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove model:', err);
    res.status(500).json({ error: 'Failed to remove model' });
  }
});

export default router;
