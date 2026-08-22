import { Router, type Request, type Response } from 'express';
import {
  getMappingWarnings,
  areMappingValuesAllowed,
  getProfiles,
  isAgentCliTool,
  isEffortLevel,
  resetProfile,
  saveProfile,
  validateMapping,
} from '../services/effort-profiles.js';

const router = Router();

router.get('/agent-effort-profiles', (_req: Request, res: Response) => {
  res.json(getProfiles().map((profile) => ({ ...profile, warnings: getMappingWarnings(profile.mapping) })));
});

router.patch('/agent-effort-profiles/:cliTool', (req: Request<{ cliTool: string }>, res: Response) => {
  const { cliTool } = req.params;
  const { defaultLevel, mapping } = req.body ?? {};
  if (!isAgentCliTool(cliTool)) {
    res.status(400).json({ error: 'Unknown cliTool' }); return;
  }
  if (!isEffortLevel(defaultLevel) || !validateMapping(mapping) || !areMappingValuesAllowed(cliTool, mapping)) {
    res.status(400).json({ error: 'defaultLevel must be 1..5 and mapping must contain exactly non-empty levels 1..5' }); return;
  }
  const profile = saveProfile(cliTool, defaultLevel, mapping);
  res.json({ ...profile, warnings: getMappingWarnings(profile.mapping) });
});

router.post('/agent-effort-profiles/:cliTool/reset', (req: Request<{ cliTool: string }>, res: Response) => {
  if (!isAgentCliTool(req.params.cliTool)) {
    res.status(400).json({ error: 'Unknown cliTool' }); return;
  }
  const profile = resetProfile(req.params.cliTool);
  res.json({ ...profile, warnings: [] });
});

export default router;
