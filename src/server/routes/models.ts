import { Router, Request, Response } from 'express';
import * as queries from '../db/queries.js';
import { checkAllTools, clearCache } from '../services/cli-status.js';

const router = Router();

// GET /api/models - get all models grouped by tool
router.get('/models', (_req: Request, res: Response) => {
  try {
    const allModels = queries.getAllModels();
    const result: Record<string, { value: string; label: string; id: string; isDefault: boolean; deprecated: boolean; availabilityStatus: string; supportedEfforts: string[] | null; lastCheckedAt: string | null; source: string }[]> = {};
    for (const [tool, models] of Object.entries(allModels)) {
      result[tool] = models.map((m) => ({
        value: m.model_value,
        label: m.model_label,
        id: m.id,
        isDefault: m.is_default === 1,
        deprecated: m.deprecated === 1,
        availabilityStatus: m.availability_status,
        supportedEfforts: m.supported_efforts ? JSON.parse(m.supported_efforts) : null,
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
    clearCache();
    await checkAllTools();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to refresh models:', err);
    res.status(500).json({ error: 'Failed to refresh models' });
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
