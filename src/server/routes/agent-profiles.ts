import { Router, type Request, type Response } from 'express';
import * as queries from '../db/queries.js';
import { isAgentCliTool } from '../services/effort-profiles.js';
import { normalizeAgentProfile, toApiAgentProfile } from '../services/agent-profiles.js';

const router = Router();

router.get('/agent-profiles', (req: Request, res: Response) => {
  const cliTool = req.query.cliTool;
  if (cliTool !== undefined && !isAgentCliTool(cliTool)) { res.status(400).json({ error: 'Unknown cliTool' }); return; }
  res.json(queries.getAgentProfiles(cliTool).map(toApiAgentProfile));
});

router.post('/agent-profiles', (req: Request, res: Response) => {
  try {
    const value = normalizeAgentProfile(req.body ?? {});
    const row = queries.createAgentProfile(value.cliTool, value.name, value.modelValue, value.effortValue, value.isEnabled);
    res.status(201).json(toApiAgentProfile(row));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes('UNIQUE') ? 409 : 400).json({ error: message.includes('UNIQUE') ? 'A profile with this name already exists for the agent' : message });
  }
});

router.get('/agent-profiles/:id', (req: Request<{ id: string }>, res: Response) => {
  const row = queries.getAgentProfileById(req.params.id);
  if (!row) { res.status(404).json({ error: 'Profile not found' }); return; }
  res.json(toApiAgentProfile(row));
});

router.patch('/agent-profiles/:id', (req: Request<{ id: string }>, res: Response) => {
  const existing = queries.getAgentProfileById(req.params.id);
  if (!existing) { res.status(404).json({ error: 'Profile not found' }); return; }
  try {
    const value = normalizeAgentProfile(req.body ?? {}, existing);
    if (value.cliTool !== existing.cli_tool) { res.status(400).json({ error: 'Profile agent cannot be changed' }); return; }
    const row = queries.updateAgentProfile(existing.id, { name: value.name, model_value: value.modelValue, effort_value: value.effortValue, is_enabled: value.isEnabled ? 1 : 0 });
    res.json(toApiAgentProfile(row!));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes('UNIQUE') ? 409 : 400).json({ error: message.includes('UNIQUE') ? 'A profile with this name already exists for the agent' : message });
  }
});

router.delete('/agent-profiles/:id', (req: Request<{ id: string }>, res: Response) => {
  if (!queries.getAgentProfileById(req.params.id)) { res.status(404).json({ error: 'Profile not found' }); return; }
  const usage = queries.getAgentProfileUsage(req.params.id);
  const usageCount = Object.values(usage).reduce((sum, count) => sum + count, 0);
  if (usageCount) { res.status(409).json({ error: 'Profile is in use. Disable it or reassign records first.', usageCount, usage }); return; }
  queries.deleteAgentProfile(req.params.id);
  res.status(204).end();
});

export default router;
