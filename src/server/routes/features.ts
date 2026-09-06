import { Router, Request, Response } from 'express';
import { getFeatureFlags } from '../services/features.js';

const router = Router();

// GET /api/features - client-visible experimental feature flags.
//
// The client must never read server env directly; it learns the authoritative
// feature state here. A stale client that missed this response is still safe:
// every forum mutation route enforces the same flag server-side.
router.get('/features', (_req: Request, res: Response) => {
  res.json(getFeatureFlags());
});

export default router;
