import { Router, type Request, type Response } from 'express';
import * as queries from '../db/queries.js';

const router = Router();
const SLUG = /^[a-z0-9_-]+$/;

export function executorInput(value: unknown): queries.ExecutionProfileInput['executors'] {
  if (!Array.isArray(value)) throw new Error('executors must be an array');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`executor ${index + 1} must be an object`);
    const item = raw as Record<string, unknown>;
    const cliModelId = item.cliModelId ?? item.cli_model_id;
    if (typeof cliModelId !== 'string' || !cliModelId) throw new Error(`executor ${index + 1} requires cliModelId`);
    const model = queries.getModelById(cliModelId);
    if (!model) throw new Error(`executor ${index + 1} references an unknown model`);
    const rawEffort = item.effortValue ?? item.effort_value;
    const effort = typeof rawEffort === 'string' && rawEffort.trim() ? rawEffort.trim() : null;
    return {
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      cli_model_id: model.id,
      effort_value: effort,
      priority: Number.isInteger(item.priority) ? Number(item.priority) : index,
      is_enabled: item.isEnabled === false || item.is_enabled === 0 || item.is_enabled === false ? 0 : 1,
    };
  });
}

function profileInput(body: Record<string, unknown>, partial = false): Partial<queries.ExecutionProfileInput> {
  const result: Partial<queries.ExecutionProfileInput> = {};
  if (!partial || body.slug !== undefined) {
    if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) throw new Error('slug must contain only lowercase a-z, 0-9, - and _');
    result.slug = body.slug;
  }
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('name is required');
    result.name = body.name.trim();
  }
  if (!partial || body.description !== undefined) {
    if (typeof body.description !== 'string') throw new Error('description is required');
    result.description = body.description.trim();
  }
  const enabled = body.isEnabled ?? body.is_enabled;
  const sortOrder = body.sortOrder ?? body.sort_order;
  if (enabled !== undefined) result.is_enabled = enabled === false || enabled === 0 ? 0 : 1;
  if (sortOrder !== undefined) result.sort_order = Number.isInteger(sortOrder) ? Number(sortOrder) : 0;
  if (body.executors !== undefined) result.executors = executorInput(body.executors);
  return result;
}

function toApi(profile: queries.ExecutionProfile, compact = false) {
  const base = { id: profile.id, slug: profile.slug, name: profile.name, description: profile.description, isEnabled: profile.is_enabled === 1, sortOrder: profile.sort_order };
  if (compact) return base;
  return { ...base, executors: profile.executors.map((executor) => ({
    id: executor.id,
    cliModelId: executor.cli_model_id,
    cliTool: executor.cli_tool,
    modelValue: executor.model_value,
    modelLabel: executor.model_label,
    modelStatus: executor.model_status,
    supportedEfforts: executor.supported_efforts ? JSON.parse(executor.supported_efforts) : null,
    effortValue: executor.effort_value,
    priority: executor.priority,
    isEnabled: executor.is_enabled === 1,
  })) };
}

router.get('/execution-profiles', (req: Request, res: Response) => {
  const includeDisabled = req.query.includeDisabled === 'true';
  const full = req.query.detail === 'full';
  res.json(queries.getExecutionProfiles({ includeDisabled }).map((profile) => toApi(profile, !full)));
});

router.post('/execution-profiles', (req: Request, res: Response) => {
  try {
    const input = profileInput(req.body ?? {}) as queries.ExecutionProfileInput;
    res.status(201).json(toApi(queries.createExecutionProfile(input)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid profile';
    res.status(message.includes('UNIQUE constraint') ? 409 : 400).json({ error: message });
  }
});

router.get('/execution-profiles/:id', (req: Request<{ id: string }>, res: Response) => {
  const profile = queries.getExecutionProfileById(req.params.id);
  if (!profile) { res.status(404).json({ error: 'Execution profile not found' }); return; }
  res.json(toApi(profile));
});

router.patch('/execution-profiles/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    if (!queries.getExecutionProfileById(req.params.id)) { res.status(404).json({ error: 'Execution profile not found' }); return; }
    res.json(toApi(queries.updateExecutionProfile(req.params.id, profileInput(req.body ?? {}, true))!));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid profile';
    res.status(message.includes('UNIQUE constraint') ? 409 : 400).json({ error: message });
  }
});

router.delete('/execution-profiles/:id', (req: Request<{ id: string }>, res: Response) => {
  if (!queries.getExecutionProfileById(req.params.id)) { res.status(404).json({ error: 'Execution profile not found' }); return; }
  const usage = queries.getExecutionProfileUsage(req.params.id);
  const usageCount = Object.values(usage).reduce((sum, count) => sum + count, 0);
  if (usageCount) { res.status(409).json({ error: 'Execution profile is in use', usageCount, usage }); return; }
  queries.deleteExecutionProfile(req.params.id);
  res.json({ success: true });
});

export default router;
