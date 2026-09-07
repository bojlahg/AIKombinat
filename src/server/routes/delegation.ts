import { Router, type Request, type Response } from 'express';
import { getExecutionProfileById } from '../db/queries.js';
import { authenticateParentExecution, getDelegationStatistics } from '../delegation/store.js';
import { decideHookOperation, formatHookResponse } from '../delegation/policy.js';
import { bulkReadService } from '../delegation/bulk-read.js';
import { getDelegationSettings, updateDelegationSettings } from '../delegation/settings.js';
import { getDelegationHookStatus, installDelegationHook, removeDelegationHook, type DelegationHookProvider } from '../delegation/hook-installer.js';
import { DelegationFileError } from '../delegation/file-access.js';

export const internalDelegationRouter = Router();
export const delegationRouter = Router();

function authenticatedParent(req: Request, res: Response) {
  const executionId = String(req.header('x-aikombinat-execution-id') ?? '');
  const capability = String(req.header('x-aikombinat-delegation-capability') ?? '');
  const parent = authenticateParentExecution(executionId, capability);
  if (!parent || (parent.status !== 'starting' && parent.status !== 'running')) {
    res.status(401).json({ error: 'Unknown or inactive delegation execution context.' });
    return null;
  }
  return parent;
}

internalDelegationRouter.post('/hook/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (provider !== 'claude' && provider !== 'codex') return res.status(404).json({ error: 'Unsupported hook provider.' });
  const parent = authenticatedParent(req, res);
  if (!parent) return;
  try {
    const depth = Number(req.header('x-aikombinat-delegation-depth') ?? '0');
    const decision = await decideHookOperation(provider, parent, req.body, Number.isFinite(depth) ? depth : 0);
    res.json({ output: formatHookResponse(provider, decision) });
  } catch {
    // Synchronous hooks are optimization only: unexpected server failures fail open.
    res.json({ output: null });
  }
});

internalDelegationRouter.post('/bulk-read', async (req: Request, res: Response) => {
  const parent = authenticatedParent(req, res);
  if (!parent) return;
  try {
    res.json(await bulkReadService.run(parent, req.body ?? {}));
  } catch (err) {
    const status = err instanceof DelegationFileError && ['delegation_sensitive_path', 'delegation_outside_workspace'].includes(err.code) ? 403 : 400;
    res.status(status).json({
      status: 'failed',
      error_code: err instanceof DelegationFileError ? err.code : 'delegation_error',
      message: err instanceof Error ? err.message : String(err),
      fallback_granted: false,
    });
  }
});

function settingsResponse() {
  const settings = getDelegationSettings();
  const profile = settings.workerExecutionProfileId ? getExecutionProfileById(settings.workerExecutionProfileId) : null;
  return {
    ...settings,
    workerProfile: profile ? {
      id: profile.id,
      name: profile.name,
      executors: profile.executors.map((executor) => ({
        provider: executor.cli_tool,
        model: executor.model_label,
        effort: executor.effort_value,
        enabled: !!executor.is_enabled,
      })),
    } : null,
  };
}

delegationRouter.get('/delegation', (_req, res) => res.json(settingsResponse()));
delegationRouter.put('/delegation/settings', (req, res) => {
  try {
    updateDelegationSettings(req.body ?? {});
    res.json(settingsResponse());
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

delegationRouter.get('/delegation/hooks', async (_req, res) => {
  res.json(await Promise.all([getDelegationHookStatus('claude'), getDelegationHookStatus('codex')]));
});

function providerParam(req: Request, res: Response): DelegationHookProvider | null {
  if (req.params.provider === 'claude' || req.params.provider === 'codex') return req.params.provider;
  res.status(404).json({ error: 'Unsupported hook provider.' });
  return null;
}

delegationRouter.post('/delegation/hooks/:provider/install', async (req, res) => {
  const provider = providerParam(req, res);
  if (!provider) return;
  try { res.json(await installDelegationHook(provider)); }
  catch (err) { res.status(409).json({ error: err instanceof Error ? err.message : String(err) }); }
});

delegationRouter.post('/delegation/hooks/:provider/remove', async (req, res) => {
  const provider = providerParam(req, res);
  if (!provider) return;
  try { res.json(await removeDelegationHook(provider)); }
  catch (err) { res.status(409).json({ error: err instanceof Error ? err.message : String(err) }); }
});

delegationRouter.get('/delegation/statistics', (req, res) => {
  const todoId = typeof req.query.todoId === 'string' ? req.query.todoId : undefined;
  res.json(getDelegationStatistics(todoId));
});

export default delegationRouter;
