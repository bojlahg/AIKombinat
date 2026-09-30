import { providerQuotaService } from '../services/provider-quota.js';
import { Router } from 'express';
import { accountUsage, deleteProviderAccount, getProviderAccount, listProviderAccounts, probeProviderAccount, providerAccountAdapters, saveProviderAccount } from '../services/provider-account-service.js';
import { executorPool } from '../services/executor-pool.js';

const router = Router();
router.get('/provider-accounts', (_req, res) => res.json(listProviderAccounts().map(account => ({ ...account,
  quota: providerQuotaService.getAccountQuotaState(account.id), auth_config: JSON.parse(account.auth_config_json), active_usage: executorPool.getActiveAccountUsage(account.id),
  usage: accountUsage(account.id), strategies: providerAccountAdapters[account.provider].strategies }))));
router.get('/provider-accounts/capabilities', (_req, res) => res.json(Object.fromEntries(
  Object.entries(providerAccountAdapters).map(([provider, adapter]) => [provider, { strategies: adapter.strategies, healthProbe: provider !== 'antigravity' }]))));
router.get('/provider-accounts/:id', (req, res) => {
  const account = getProviderAccount(req.params.id);
  if (!account) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json({ ...account, quota: providerQuotaService.getAccountQuotaState(account.id), auth_config: JSON.parse(account.auth_config_json), active_usage: executorPool.getActiveAccountUsage(account.id), usage: accountUsage(account.id) });
});
router.post('/provider-accounts', (req, res) => {
  try { res.status(201).json(saveProviderAccount(req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid account' }); }
});
router.patch('/provider-accounts/:id', (req, res) => {
  try { res.json(saveProviderAccount(req.body, req.params.id)); executorPool.notifyCapacityReleased(); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid account' }); }
});
router.post('/provider-accounts/:id/test', async (req, res) => {
  try { res.json(await probeProviderAccount(req.params.id)); executorPool.notifyCapacityReleased(); }
  catch { res.status(404).json({ error: 'Account not found' }); }
});
router.delete('/provider-accounts/:id', (req, res) => {
  try { deleteProviderAccount(req.params.id, executorPool.getReservations().some(reservation => reservation.providerAccountId === req.params.id)); res.json({ success: true }); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Account is in use' }); }
});
router.get('/provider-accounts/:id/quota', (req, res) => {
  if (!getProviderAccount(req.params.id)) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(providerQuotaService.getAccountQuotaState(req.params.id));
});
router.post('/provider-accounts/:id/quota/reset', (req, res) => {
  if (!getProviderAccount(req.params.id)) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(providerQuotaService.markAccountUnknown(req.params.id));
});
router.get('/provider-quota', (_req, res) => res.json(providerQuotaService.getAllQuotaStates().map(quota => ({
  ...quota, accounts: listProviderAccounts().filter(account => account.provider === quota.tool).map(account => providerQuotaService.getAccountQuotaState(account.id)),
}))));
export default router;
