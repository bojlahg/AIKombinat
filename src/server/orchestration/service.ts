import { providerQuotaService } from '../services/provider-quota.js';
import { classifyProviderFailure } from '../services/failure-classifier.js';
import { attemptedAccounts, quotaChain, setQuotaChain, recordFailover, bindFailoverTarget, QUOTA_RECOVERY_PROMPT } from '../services/account-failover.js';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import * as queries from '../db/queries.js';
import { executorPool } from '../services/executor-pool.js';
import { executionSnapshot } from '../services/execution-config.js';
import { orchestrator as todoOrchestrator } from '../services/orchestrator.js';
import { isProcessAlive, readProcessIdentity, verifyProcessIdentity, parseProcessIdentity, terminateProcessTree } from '../utils/process-tree.js';
import { todoLifecycle } from '../utils/todo-lifecycle.js';
import { logger } from '../logging/logger.js';
import * as store from './store.js';
import { reconcileResources, releaseResource, resourceSnapshot } from './resources.js';
import { launchPrimary, type PrimaryExecution, type PrimaryLauncher } from './primary.js';
import { eventSnapshot, serializeContext } from './context-budget.js';

function processMayBeAlive(pid: number): boolean {
  if (isProcessAlive(pid)) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function buildContext(id: string, turnId: string): string {
  const parent = store.getOrchestration(id);
  const messages = getDatabase().prepare('SELECT role, content FROM orchestrator_messages WHERE orchestrator_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 12').all(id);
  const activeIds = new Set(store.activeChildren(id).map(child => child.id));
  const children = store.children(id).map(job => { const child = store.childStatus(id, job.id); return { child_job_id: child.id, todo_id: child.todo_id, title: child.title, status: child.status, pipeline_phase: child.pipeline_phase, summary: child.summary }; });
  const resources = store.holds(id).map(resourceSnapshot);
  const activeResource = (resource: typeof resources[number]) => ['waiting', 'bound', 'claimed'].includes(resource.status);
  return serializeContext({ objective: parent.objective, state_summary: parent.state_summary, current_plan: parent.current_plan,
    budgets: { max_turns: parent.max_turns, turn_count: parent.turn_count, max_children: parent.max_children, child_count: parent.child_count, max_concurrent_children: parent.max_concurrent_children, max_active_resource_requests: parent.max_active_resource_requests },
    children: children.filter(child => activeIds.has(child.child_job_id)),
    resources: resources.filter(activeResource), events: store.events(id).filter(event => event.assigned_turn_id === turnId).map(eventSnapshot),
    corrective_retry: store.getTurn(turnId).retry_count > 0 ? 'Previous primary failed or exited without yield/finish. Inspect durable state, reuse idempotency keys, and end with exactly one terminal action.' : undefined },
  messages, children.filter(child => !activeIds.has(child.child_job_id)).reverse(), resources.filter(resource => !activeResource(resource)).reverse());
}
export class OrchestratorAgentService {
  private enabled = false;
  private dispatching = false;
  private requested = false;
  private active = new Map<string, PrimaryExecution>();
  private launching = new Set<string>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeQuota: (() => void) | null = null;
  private readonly wakeListener = () => this.wake();
  constructor(private readonly launcher: PrimaryLauncher = launchPrimary) {}
  async initialize(): Promise<void> {
    await this.recover();
    store.reconcileChildren();
    reconcileResources();
    this.enabled = true;
    this.unsubscribeQuota = providerQuotaService.onAvailability(this.wakeListener);
    todoLifecycle.on('status', this.wakeListener);
    store.orchestrationSignals.on('wake', this.wakeListener);
    this.wake();
  }
  wake(): void {
    if (!this.enabled) return;
    this.requested = true;
    if (this.dispatching) return;
    this.dispatching = true;
    setImmediate(() => (this.enabled ? this.dispatch() : Promise.resolve()).catch(error => logger.error('orchestrator.dispatch.failed', { err: error })).finally(() => { this.dispatching = false; if (this.requested) this.wake(); }));
  }
  private async dispatch(): Promise<void> {
    do {
      this.requested = false;
      store.reconcileChildren();
      reconcileResources();
      for (const parent of store.listOrchestrations()) {
        if (parent.status === 'cancelling') { await this.cancel(parent.id); continue; }
        if (['paused', ...store.terminalStatuses].includes(parent.status)) continue;
        if (parent.status === 'waiting_event' && store.requestTurn(parent.id)) logger.info('orchestrator.wake', { orchestratorId: parent.id });
        const turn = store.turns(parent.id).find(item => ['pending', 'waiting_executor', 'waiting_quota'].includes(item.status));
        if (turn) await this.admit(parent.id, turn.id);
      }
      this.armExpiry();
    } while (this.requested && this.enabled);
  }
  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const expires = store.listOrchestrations().flatMap(parent => store.holds(parent.id)).filter(hold => hold.status === 'bound' && hold.claim_expires_at).map(hold => Date.parse(hold.claim_expires_at!));
    this.expiryTimer = expires.length ? setTimeout(() => this.wake(), Math.max(1, Math.min(...expires) - Date.now())) : null;
    this.expiryTimer?.unref();
  }
  async start(id: string): Promise<void> {
    const parent = store.getOrchestration(id);
    if (parent.status !== 'pending') throw new Error('orchestrator_not_pending');
    store.validateProfile(parent.primary_execution_profile_id, true);
    store.updateOrchestration(id, { started_at: store.now() });
    store.requestTurn(id, 'start'); this.wake();
  }
  private async admit(id: string, turnId: string): Promise<void> {
    if (this.active.has(turnId)) return;
    let execution: PrimaryExecution | undefined;
    try {
      const parent = store.getOrchestration(id);
      store.validateProfile(parent.primary_execution_profile_id, true);
      const chain = quotaChain('orchestrator', turnId);
      const previousAttempt = chain ? store.turns(id).filter(row => row.id !== turnId && quotaChain('orchestrator', row.id) === chain).at(-1) : undefined;
      const previousSnapshot = previousAttempt?.execution_snapshot ? JSON.parse(previousAttempt.execution_snapshot) : null;
      const selection = await executorPool.selectExecutor({ preferredCandidateId: previousSnapshot?.executorCandidateId, onlyCandidateId: previousSnapshot?.accountPolicy && previousSnapshot.accountPolicy !== 'automatic' ? previousSnapshot.executorCandidateId : undefined, excludedProviderAccountIds: attemptedAccounts('orchestrator', id, chain), executionProfileId: parent.primary_execution_profile_id, allowedCliTools: ['claude'], reserveOwnerId: turnId });
      const fresh = store.getOrchestration(id), turn = store.getTurn(turnId);
      if (!this.enabled || ['paused','cancelling', ...store.terminalStatuses].includes(fresh.status) || !['pending','waiting_executor','waiting_quota'].includes(turn.status)) { executorPool.releaseReservation(turnId, true); return; }
      if (selection.status === 'waiting_executor' || selection.status === 'waiting_quota') {
        store.updateTurn(turnId, { status: selection.status }); store.updateOrchestration(id, { status: selection.status }); store.publish('status-changed', id); return;
      }
      if (!selection.selectedConfig) throw new Error('no_eligible_claude_executor');
      const context = (chain ? QUOTA_RECOVERY_PROMPT + '\n\n' : '') + buildContext(id, turnId);
      bindFailoverTarget('orchestrator', id, chain, selection.selectedConfig.providerAccountId);
      store.updateTurn(turnId, { status: 'running', input_context_hash: store.hash(context), execution_snapshot: JSON.stringify(executionSnapshot(selection.selectedConfig)), started_at: store.now() });
      store.updateOrchestration(id, { status: 'running' });
      this.launching.add(turnId);
      execution = await this.launcher({ orchestratorId: id, turnId, projectPath: queries.getProjectById(parent.project_id)!.path, config: selection.selectedConfig, context });
      this.active.set(turnId, execution);
      store.updateTurn(turnId, { process_pid: execution.pid });
      const identity = execution.pid ? await readProcessIdentity(execution.pid) : null;
      store.updateTurn(turnId, { process_identity: identity ? JSON.stringify(identity) : null });
      this.launching.delete(turnId);
      executorPool.releaseReservation(turnId);
      logger.info('orchestrator.turn.started', { orchestratorId: id, turnId, pid: execution.pid, model: selection.selectedConfig.effectiveModel });
      store.publish('turn-started', id);
      if (['cancelling','paused'].includes(store.getOrchestration(id).status)) await this.stopPrimary(id);
      void execution.exit.then(result => this.exited(id, turnId, result)).catch(error => logger.error('orchestrator.turn.exit-failed', { orchestratorId: id, turnId, err: error }));
    } catch (error) {
      this.launching.delete(turnId);
      executorPool.releaseReservation(turnId, true);
      if (execution?.pid && processMayBeAlive(execution.pid)) {
        store.updateOrchestration(id, { status: 'paused', waiting_reason: 'primary_recovery_required' });
        void execution.exit.then(result => this.exited(id, turnId, result)).catch(error => logger.error('orchestrator.turn.exit-failed', { orchestratorId: id, turnId, err: error }));
        return;
      }
      await execution?.revoke();
      this.active.delete(turnId);
      this.failTurn(id, turnId, 'failed', error instanceof Error ? error.message : 'primary_error');
    }
  }
  private async exited(id: string, turnId: string, result: { code: number; output: string; error: string }): Promise<void> {
    const execution = this.active.get(turnId);
    await execution?.revoke(); this.active.delete(turnId);
    const turn = store.getTurn(turnId), parent = store.getOrchestration(id);
    if (!['running','starting','stopped'].includes(turn.status)) return;
    store.updateTurn(turnId, { process_pid: 0, process_identity: null });
    executorPool.notifyCapacityReleased();
    if (['paused','cancelling','cancelled'].includes(parent.status) || turn.status === 'stopped') {
      store.updateTurn(turnId, { status: 'stopped', finished_at: store.now() });
      getDatabase().prepare('UPDATE orchestrator_events SET assigned_turn_id = NULL WHERE assigned_turn_id = ? AND consumed_at IS NULL').run(turnId);
      if (parent.status === 'cancelling') await this.cancel(id);
    } else if (this.handleQuotaExit(id, turnId, result)) {
      store.publish('turn-finished', id); store.publish('status-changed', id); this.wake(); return;
    } else if (result.code !== 0 || !turn.terminal_action) this.failTurn(id, turnId, result.code === 0 ? 'protocol_error' : 'failed', result.code === 0 ? 'primary_exited_without_terminal_action' : 'primary_process_failed');
    else {
      const snapshot = JSON.parse(turn.execution_snapshot ?? '{}');
      if (snapshot.providerAccountId) providerQuotaService.markAccountAvailable(snapshot.providerAccountId);
      if (quotaChain('orchestrator', turnId) && snapshot.accountPolicy === 'automatic') logger.info('execution.account-failover.completed', { ownerType: 'orchestrator', ownerId: id, turnId, toAccountId: snapshot.providerAccountId });
      getDatabase().transaction(() => {
        const timestamp = store.now();
        store.updateTurn(turnId, { status: 'completed', finished_at: timestamp });
        getDatabase().prepare('UPDATE orchestrator_events SET consumed_at = ? WHERE assigned_turn_id = ?').run(timestamp, turnId);
        const pendingWakeEvent = store.events(id).some(event => !event.assigned_turn_id && !event.consumed_at && store.matches(event, parent));
        if (turn.terminal_action === 'finish' && !pendingWakeEvent) store.updateOrchestration(id, { status: 'completed', finished_at: timestamp, waiting_reason: null });
        else store.updateOrchestration(id, { status: 'waiting_event' });
        try {
          const response = JSON.parse(result.output);
          if (response.modelUsage && typeof response.modelUsage === 'object') {
            store.updateTurn(turnId, { execution_snapshot: JSON.stringify({ ...JSON.parse(turn.execution_snapshot ?? '{}'), reportedModels: Object.keys(response.modelUsage).slice(0, 16) }) });
          }
          if (typeof response.result === 'string') {
            const output = Buffer.from(response.result).subarray(0, 32768).toString('utf8');
            store.updateTurn(turnId, { assistant_output: output });
            if (turn.terminal_action === 'yield' && output.trim()) store.addMessage(id, output, 'assistant', turnId);
          }
        } catch { /* Provider envelopes are optional; hidden reasoning is never persisted. */ }
      }).immediate();
      logger.info(turn.terminal_action === 'finish' ? 'orchestrator.finished' : 'orchestrator.turn.completed', { orchestratorId: id, turnId });
    }
    store.publish('turn-finished', id); store.publish('status-changed', id); this.wake();
  }
  private handleQuotaExit(id: string, turnId: string, result: { code: number; output: string; error: string }): boolean {
    const turn = store.getTurn(turnId);
    const snapshot = JSON.parse(turn.execution_snapshot ?? '{}');
    if (!snapshot.providerAccountId || result.code === 0 || turn.terminal_action) return false;
    const classification = classifyProviderFailure(snapshot.agent, result.code, `${result.output}\n${result.error}`.slice(-65536));
    if (classification.category !== 'quota_exhausted' && classification.category !== 'rate_limited') return false;
    getDatabase().transaction(() => {
      const chain = quotaChain('orchestrator', turnId) ?? turnId;
      store.updateTurn(turnId, { status: 'failed', error_message: `account_quota_failover: ${classification.category}`, finished_at: store.now() });
      providerQuotaService.markAccountExhausted(snapshot.providerAccountId, { source: 'runtime_rejection', reason: classification.reason, resetAt: classification.resetAt });
      const allowed = snapshot.accountPolicy !== 'automatic' || recordFailover('orchestrator', id, chain, turnId, { ...snapshot, cliTool: snapshot.agent }, classification);
      if (!allowed) {
        store.updateOrchestration(id, { status: 'failed', waiting_reason: 'failover_budget_exhausted' });
        getDatabase().prepare('UPDATE orchestrator_events SET assigned_turn_id=NULL WHERE assigned_turn_id=? AND consumed_at IS NULL').run(turnId);
        return;
      }
      const nextId = randomUUID();
      const nextIndex = Math.max(...store.turns(id).map(row => row.turn_index)) + 1;
      getDatabase().prepare(`INSERT INTO orchestrator_turns
        (id,orchestrator_id,turn_index,status,trigger_type,retry_count,quota_chain_id,created_at)
        VALUES (?,?,?,'pending','account_quota_failover',?,?,?)`).run(nextId, id, nextIndex, turn.retry_count, chain, store.now());
      setQuotaChain('orchestrator', turnId, chain);
      getDatabase().prepare('UPDATE orchestrator_events SET assigned_turn_id=? WHERE assigned_turn_id=? AND consumed_at IS NULL').run(nextId, turnId);
      store.updateOrchestration(id, { status: 'pending', waiting_reason: 'account_quota_failover' });
    }).immediate();
    return true;
  }
  private failTurn(id: string, turnId: string, status: string, reason: string): void {
    getDatabase().transaction(() => {
      const turn = store.getTurn(turnId), parent = store.getOrchestration(id);
      if (turn.process_pid > 0) { store.updateOrchestration(id, { status: 'paused', waiting_reason: 'primary_recovery_required' }); return; }
      store.updateTurn(turnId, { status, finished_at: store.now(), error_message: reason.slice(0, 1024) });
      getDatabase().prepare('UPDATE orchestrator_events SET assigned_turn_id = NULL WHERE assigned_turn_id = ? AND consumed_at IS NULL').run(turnId);
      if (['paused','cancelling', ...store.terminalStatuses].includes(parent.status)) return;
      store.updateOrchestration(id, { status: turn.retry_count ? 'failed' : 'pending', waiting_reason: reason.slice(0, 1024) });
      if (!turn.retry_count) store.requestTurn(id, 'corrective_retry', 1);
      logger.warn(status === 'protocol_error' ? 'orchestrator.turn.protocol-error' : 'orchestrator.turn.failed', { orchestratorId: id, turnId, reason: reason.slice(0, 1024) });
    }).immediate();
    store.publish('status-changed', id); this.wake();
  }
  private async stopPrimary(id: string): Promise<boolean> {
    for (const turn of store.turns(id).filter(turn => turn.process_pid > 0 || ['pending','starting','running','waiting_executor','waiting_quota'].includes(turn.status))) {
      if (this.launching.has(turn.id)) return false;
      await this.active.get(turn.id)?.revoke();
      if (turn.process_pid > 0 && processMayBeAlive(turn.process_pid)) {
        const verdict = await verifyProcessIdentity(turn.process_pid, parseProcessIdentity(turn.process_identity));
        if (verdict === 'unverifiable' || verdict === 'match' && !await terminateProcessTree(turn.process_pid)) return false;
      }
      await this.active.get(turn.id)?.revoke();
      this.active.delete(turn.id);
      store.updateTurn(turn.id, { status: 'stopped', process_pid: 0, process_identity: null, finished_at: store.now() });
      getDatabase().prepare('UPDATE orchestrator_events SET assigned_turn_id = NULL WHERE assigned_turn_id = ? AND consumed_at IS NULL').run(turn.id);
      executorPool.releaseReservation(turn.id, true);
    }
    return true;
  }
  async pause(id: string): Promise<void> {
    const parent = store.getOrchestration(id);
    if (store.terminalStatuses.includes(parent.status) || parent.status === 'cancelling') throw new Error('orchestrator_terminal');
    store.updateOrchestration(id, { status: 'paused' });
    await this.stopPrimary(id);
    for (const hold of store.holds(id).filter(row => ['bound','waiting'].includes(row.status))) releaseResource(id, hold.id);
    store.publish('status-changed', id); this.wake();
  }
  async resume(id: string): Promise<void> {
    const parent = store.getOrchestration(id);
    if (!['paused','failed'].includes(parent.status)) throw new Error('orchestrator_not_paused');
    if (store.turns(id).some(turn => turn.process_pid > 0 || ['starting','running'].includes(turn.status))) throw new Error('primary_recovery_required');
    store.validateProfile(parent.primary_execution_profile_id, true);
    store.updateOrchestration(id, { status: 'waiting_event', waiting_reason: null });
    const sourceId = randomUUID(); store.addEvent(id, 'system.resumed', 'system', sourceId, `resume:${sourceId}`, {}); this.wake();
  }
  async cancel(id: string): Promise<void> {
    const parent = store.getOrchestration(id);
    if (['completed','cancelled'].includes(parent.status)) return;
    store.updateOrchestration(id, { status: 'cancelling' });
    let resolved = await this.stopPrimary(id);
    for (const child of store.activeChildren(id)) {
      try { await todoOrchestrator.stopTodo(child.todo_id); } catch { resolved = false; }
    }
    for (const hold of store.holds(id).filter(row => ['bound','waiting'].includes(row.status))) releaseResource(id, hold.id);
    if (resolved && !store.activeChildren(id).length && !store.turns(id).some(turn => turn.process_pid > 0)) {
      store.updateOrchestration(id, { status: 'cancelled', finished_at: store.now() });
      logger.info('orchestrator.cancelled', { orchestratorId: id });
    }
    store.publish('status-changed', id);
  }
  async recover(): Promise<void> {
    for (const parent of store.listOrchestrations()) {
      for (const turn of store.turns(parent.id)) {
        if (turn.process_pid > 0 && processMayBeAlive(turn.process_pid)) {
          const verdict = await verifyProcessIdentity(turn.process_pid, parseProcessIdentity(turn.process_identity));
          if (verdict !== 'mismatch') { store.updateOrchestration(parent.id, { status: parent.status === 'cancelling' ? 'cancelling' : 'paused', waiting_reason: 'primary_recovery_required' }); continue; }
        }
        if (turn.process_pid > 0 || ['running','starting'].includes(turn.status)) {
          store.updateTurn(turn.id, { process_pid: 0, process_identity: null });
          this.failTurn(parent.id, turn.id, 'failed', 'interrupted_primary');
        }
      }
    }
  }
  async shutdown(): Promise<void> {
    this.enabled = false;
    this.unsubscribeQuota?.(); this.unsubscribeQuota = null;
    todoLifecycle.off('status', this.wakeListener); store.orchestrationSignals.off('wake', this.wakeListener);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    for (const parent of store.listOrchestrations()) {
      if (!store.turns(parent.id).some(turn => this.active.has(turn.id) || this.launching.has(turn.id))) continue;
      store.updateOrchestration(parent.id, { status: 'paused', waiting_reason: 'controller_shutdown' });
      await this.stopPrimary(parent.id);
    }
  }
}
export const orchestratorAgent = new OrchestratorAgentService();
