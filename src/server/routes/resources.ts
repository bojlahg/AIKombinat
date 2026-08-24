import { Router } from 'express';
import { resourceManager } from '../services/resource-manager.js';

const router = Router();

router.get('/resources', (_req, res) => {
  try {
    res.json({ resources: resourceManager.getStatus() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
