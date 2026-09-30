import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n';
import Modal from '../Modal';
import type { ComputeNode, NodeConnection, NodePolicy } from '../../types';
import type { WsEvent } from '../../hooks/useWebSocket';
import * as api from '../../api/resources';
import { getTodoLogs } from '../../api/todos';
import type { TaskLog } from '../../types';

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
function LeaseOwner({ owner, busy, stop, logs }: { owner: api.LeaseView; busy: boolean; stop: (force: boolean) => void; logs: () => void }) {
  const { t } = useI18n();
  let executor = '';
  try { const snapshot = JSON.parse(owner.execution_snapshot ?? '{}'); executor = [snapshot.agent, snapshot.effectiveModel ?? snapshot.model, snapshot.profileName].filter(Boolean).join(' / '); } catch { /* optional legacy snapshot */ }
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><Link className="text-accent" to={`/projects/${owner.project_id}?${owner.owner_type === 'todo' ? 'todo=' + owner.owner_id : 'tab=sessions'}`}>{owner.owner_title}</Link><span>{executor} · PID {owner.process_pid} · {owner.acquired_at}</span>{owner.owner_type === 'todo' && <><button disabled={busy} className="btn btn-sm" onClick={logs}>{t('fabric.openLogs')}</button><button disabled={busy} className="btn btn-sm" onClick={() => stop(false)}>{t('fabric.stop')}</button><button disabled={busy} className="btn btn-sm" onClick={() => stop(true)}>{t('fabric.forceStop')}</button></>}</div>;
}
function PolicyEditor({ node, save, busy }: { node: ComputeNode; save: (policy: NodePolicy) => void; busy: boolean }) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState(node.policy);
  const [capabilityKey, setCapabilityKey] = useState('');
  const [capabilityValue, setCapabilityValue] = useState('true');
  const policyJson = JSON.stringify(node.policy);
  useEffect(() => setPolicy(JSON.parse(policyJson)), [policyJson]);
  return <form className="mt-4 grid grid-cols-3 gap-3" onSubmit={event => { event.preventDefault(); save(policy); }}>
    {(['cpu_reserve_threads', 'memory_reserve_bytes', 'storage_reserve_bytes'] as const).map(field => <label key={field} className="text-xs text-theme-muted">{t(`fabric.${field}`)}<input aria-label={t(`fabric.${field}`)} type="number" min="0" step="1" className="input w-full" value={policy[field] / (field === 'cpu_reserve_threads' ? 1 : 1024 ** 3)} onChange={event => setPolicy({ ...policy, [field]: Number(event.target.value) * (field === 'cpu_reserve_threads' ? 1 : 1024 ** 3) })} /></label>)}
    <label className="col-span-3 text-xs flex gap-2"><input type="checkbox" checked={policy.avoid_external_gpu} onChange={event => setPolicy({ ...policy, avoid_external_gpu: event.target.checked })} />{t('fabric.avoidExternal')}</label>
    <div className="col-span-3 text-xs space-y-2"><p>{t('fabric.manualCapabilities')}</p>
      {Object.entries(policy.capability_overrides).map(([key, value]) => <div key={key} className="flex gap-2 items-center"><span>{key}</span><input aria-label={key} className="input" value={String(value)} onChange={event => setPolicy({ ...policy, capability_overrides: { ...policy.capability_overrides, [key]: event.target.value === 'true' ? true : event.target.value === 'false' ? false : event.target.value } })} /><button type="button" className="btn btn-sm" onClick={() => { const next = { ...policy.capability_overrides }; delete next[key]; setPolicy({ ...policy, capability_overrides: next }); }}>{t('fabric.removeOverride')}</button></div>)}
      <div className="flex gap-2"><input aria-label={t('fabric.capabilityKey')} placeholder={t('fabric.capabilityKey')} className="input" value={capabilityKey} onChange={event => setCapabilityKey(event.target.value)} /><input aria-label={t('fabric.capabilityValue')} className="input" value={capabilityValue} onChange={event => setCapabilityValue(event.target.value)} /><button type="button" className="btn btn-sm" disabled={!/^[\w.-]{1,64}$/.test(capabilityKey)} onClick={() => { setPolicy({ ...policy, capability_overrides: { ...policy.capability_overrides, [capabilityKey]: capabilityValue === 'true' ? true : capabilityValue === 'false' ? false : capabilityValue } }); setCapabilityKey(''); }}>{t('fabric.addOverride')}</button></div>
    </div>
    <button className="btn btn-sm" disabled={busy}>{t('fabric.savePolicy')}</button>
  </form>;
}

function SshEditor({ node, hosts, close, save }: { node?: ComputeNode; hosts: string[]; close: () => void; save: (name: string, connection: NodeConnection, enabled: boolean) => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState(node?.name ?? '');
  const [enabled, setEnabled] = useState(node?.enabled ?? true);
  const [connection, setConnection] = useState<NodeConnection>(node?.connection ?? { host: '', auth_mode: 'config', workspace_root: '' });
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  return <Modal open onClose={close}><section role="dialog" aria-modal="true" aria-label={t(node ? 'fabric.editSsh' : 'fabric.addSsh')}>
    <h3 className="text-lg font-semibold mb-4">{t(node ? 'fabric.editSsh' : 'fabric.addSsh')}</h3>
    <form className="space-y-3" onSubmit={async event => { event.preventDefault(); setSaving(true); try { await save(name, connection, enabled); close(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); } }}>
      <label className="block text-sm">{t('fabric.name')}<input required className="input w-full" value={name} onChange={event => setName(event.target.value)} /></label>
      {hosts.length > 0 && <label className="block text-sm">{t('fabric.importAlias')}<select className="input w-full" value="" onChange={event => { setConnection({ ...connection, host: event.target.value }); if (!name) setName(event.target.value); }}><option value="">{t('fabric.selectHost')}</option>{hosts.map(host => <option key={host}>{host}</option>)}</select></label>}
      <label className="block text-sm">{t('fabric.host')}<input required className="input w-full" value={connection.host} onChange={event => setConnection({ ...connection, host: event.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">{t('fabric.port')}<input type="number" min="1" max="65535" className="input w-full" value={connection.port ?? ''} onChange={event => setConnection({ ...connection, port: event.target.value ? Number(event.target.value) : undefined })} /></label>
        <label className="text-sm">{t('fabric.user')}<input className="input w-full" value={connection.user ?? ''} onChange={event => setConnection({ ...connection, user: event.target.value || undefined })} /></label>
      </div>
      <label className="block text-sm">{t('fabric.auth')}<select className="input w-full" value={connection.auth_mode} onChange={event => setConnection({ ...connection, auth_mode: event.target.value as NodeConnection['auth_mode'], key_path: undefined })}>{(['config', 'agent', 'key'] as const).map(mode => <option key={mode} value={mode}>{t(`fabric.auth.${mode}`)}</option>)}</select></label>
      {connection.auth_mode === 'key' && <label className="block text-sm">{t('fabric.keyPath')}<input required className="input w-full" value={connection.key_path ?? ''} onChange={event => setConnection({ ...connection, key_path: event.target.value })} /></label>}
      <label className="block text-sm">{t('fabric.workspace')}<input required className="input w-full" value={connection.workspace_root} onChange={event => setConnection({ ...connection, workspace_root: event.target.value })} /></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('fabric.enabled')}</label>
      <p className="text-xs text-theme-muted">{t('fabric.sshSafety')}</p>
      {error && <p role="alert" className="text-status-error">{error}</p>}
      <button disabled={saving} className="btn">{t('fabric.save')}</button>
    </form>
  </section></Modal>;
}

export default function ResourcesSettingsPanel({ onEvent }: { onEvent?: (callback: (event: WsEvent) => void) => () => void }) {
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string>) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll('{' + name + '}', value), t(key));
  const [data, setData] = useState<api.FabricView>({ nodes: [], instances: [], capacity: [] });
  const [requests, setRequests] = useState<api.RequestView[]>([]), [leases, setLeases] = useState<api.LeaseView[]>([]);
  const [hosts, setHosts] = useState<string[]>([]), [editor, setEditor] = useState<ComputeNode | 'new' | null>(null);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Record<string, Array<{ id: string; diff_json: string; created_at: string }>>>({});
  const [taskLogs, setTaskLogs] = useState<{ owner: string; logs: TaskLog[] } | null>(null);
  const load = useCallback(async () => { const [fabric, requestData, leaseData] = await Promise.all([api.getFabric(), api.getResourceRequests(), api.getResourceLeases()]); setData(fabric); setRequests(requestData.requests); setLeases(leaseData.leases); }, []);
  useEffect(() => { void load().catch(error => setError(String(error))); let timer: ReturnType<typeof setTimeout> | undefined; const dispose = onEvent?.(event => { if (event.type.startsWith('resource')) { clearTimeout(timer); timer = setTimeout(() => { void load().catch(error => setError(String(error))); }, 500); } }); return () => { dispose?.(); clearTimeout(timer); }; }, [load, onEvent]);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); setMessage(''); try { await action(); await load(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <div className="p-5 space-y-4 text-theme-primary">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold mr-auto">{t('fabric.title')}</h2><button disabled={busy} className="btn btn-sm" onClick={() => setEditor('new')}>{t('fabric.addSsh')}</button><button disabled={busy} className="btn btn-sm" onClick={() => void act(async () => { const response = await api.discoverHosts(); setHosts(response.hosts); setEditor('new'); })}>{t('fabric.discover')}</button></div>
    <p className="text-xs text-theme-muted">{t('fabric.accounting')}</p>
    {busy && <p role="status" className="text-xs">{t('fabric.working')}</p>}
    {error && <p role="alert" className="text-status-error text-sm">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {data.nodes.map(node => {
      const capacity = data.capacity.find(capacity => capacity.node_id === node.id);
      return <section key={node.id} className="panel rounded-xl p-4 bg-theme-card">
        <div className="flex flex-wrap gap-2 items-center"><h3 className="font-semibold mr-auto">{node.name}</h3><span className="text-xs">{t(`fabric.state.${node.scheduler_state}`)}</span><label className="text-xs"><input aria-label={`${t('fabric.enabled')} ${node.name}`} type="checkbox" checked={node.enabled} onChange={event => void act(() => api.updateNode(node.id, { enabled: event.target.checked }))} /> {t('fabric.enabled')}</label></div>
        {node.transport === 'local' && <label className="block text-xs mt-2">{t('fabric.name')}<input className="input ml-2" defaultValue={node.name} onBlur={event => { if (event.target.value !== node.name) void act(() => api.updateNode(node.id, { name: event.target.value })); }} /></label>}
        <p className="text-xs text-theme-muted mt-1">{node.inventory ? `${node.inventory.platform.os} ${node.inventory.platform.distro ?? ''} ${node.inventory.platform.version ?? ''} · ${node.inventory.platform.arch}` : t('fabric.notScanned')}</p>
        {node.identity_changed && <p className="text-status-error text-xs">{t('fabric.identityChanged')}</p>}
        {node.last_error && <p className="text-status-warning text-xs">{node.last_error}</p>}
        {node.inventory && <div className="flex flex-wrap gap-6 my-3 text-xs">
          <div>{t('fabric.cpu')}<p>{node.inventory.cpu.model}</p><p>{tf('fabric.topology', { cores: String(node.inventory.cpu.physical_cores ?? '?'), threads: String(node.inventory.cpu.logical_threads) })}</p><p>{tf('fabric.capacity', { leased: String(capacity?.cpu.leased ?? 0), available: String(capacity?.cpu.available ?? 0), total: String(capacity?.cpu.total ?? 0) })}</p></div>
          <div>{t('fabric.ram')}<p>{tf('fabric.capacity', { leased: gb(capacity?.memory.leased ?? 0), available: gb(capacity?.memory.available ?? 0), total: gb(capacity?.memory.total ?? 0) })}</p><p>{tf('fabric.observedFree', { value: gb(node.observation?.memory_available_bytes ?? 0) })}</p></div>
        </div>}
        <div className="flex gap-2 flex-wrap mt-3">
          <button className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { const result = await api.scanNode(node.id); setMessage(result.diff.join(', ') || t('fabric.noChanges')); })}>{t(node.transport === 'local' ? 'fabric.scanLocal' : 'fabric.scanRemote')}</button>
          {node.transport === 'ssh' && <><button className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { const result = await api.testNode(node.id); setMessage(result.status === 'connected' ? t('fabric.connected') : result.error ?? result.status); })}>{t('fabric.test')}</button><button className="btn btn-sm" onClick={() => setEditor(node)}>{t('fabric.editSsh')}</button></>}
          {(['draining', 'maintenance', 'online'] as const).map(state => <button key={state} className="btn btn-sm" disabled={busy} onClick={() => void act(() => api.updateNode(node.id, { scheduler_state: state }))}>{t(`fabric.action.${state}`)}</button>)}
          <button className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { const result = await api.getScanHistory(node.id); setHistory(previous => ({ ...previous, [node.id]: result.snapshots })); })}>{t('fabric.history')}</button>
        </div>
        <PolicyEditor node={node} busy={busy} save={policy => void act(() => api.updateNodePolicy(node.id, policy))} />
        <div className="mt-3">{leases.filter(lease => lease.node_id === node.id).filter((lease, index, all) => all.findIndex(other => other.run_token === lease.run_token) === index).map(owner => <div key={owner.run_token} className="text-xs"><p>{leases.filter(lease => lease.run_token === owner.run_token).map(lease => `${lease.resource_key}: ${lease.amount}`).join(' · ')}</p><LeaseOwner owner={owner} busy={busy} logs={() => void act(async () => setTaskLogs({ owner: owner.owner_title, logs: await getTodoLogs(owner.owner_id) }))} stop={force => void act(async () => { const result = await api.stopResourceTodo(owner.owner_id, force); setMessage(result.status); })} /></div>)}</div>
        <div className="mt-4 space-y-3">{data.instances.filter(instance => instance.node_id === node.id).map(instance => {
          const owners = leases.filter(lease => lease.resource_key === instance.id || lease.resource_key === instance.legacy_key);
          const observation = node.observation?.gpus.find(gpu => gpu.hardware_uuid === instance.hardware_uuid);
          return <div key={instance.id} className="p-3 rounded-xl bg-theme-surface-2 text-xs">
            <div className="flex justify-between gap-2"><strong>{instance.model}{instance.local_index !== null ? ` #${instance.local_index}` : ''} {instance.vram_bytes ? `${gb(instance.vram_bytes)} GB` : ''}</strong><span>{instance.used ? t('fabric.leased') : instance.runtime_state === 'offline' ? t('fabric.state.offline') : instance.runtime_state === 'missing' ? t('fabric.resourceMissing') : instance.runtime_state === 'unknown' ? t('fabric.observationUnknown') : instance.externally_busy ? t('fabric.external') : t(`fabric.policy.${instance.policy}`)}</span></div>
            {instance.desired_policy && <p className="text-status-warning mt-1">{t('fabric.pendingReserve')}</p>}
            {instance.reserve_reason && <p>{instance.reserve_reason}</p>}
            {(instance.policy === 'reserved' || instance.desired_policy) && <label className="block mt-1">{t('fabric.reserveReason')}<input className="input ml-2" maxLength={128} defaultValue={instance.reserve_reason ?? ''} onBlur={event => { if (event.target.value !== (instance.reserve_reason ?? '')) void act(() => api.updateGpuPolicy(instance.id, 'reserved', !!instance.desired_policy, event.target.value)); }} /></label>}
            {observation && <p className="text-theme-muted mt-1">{tf('fabric.telemetry', { utilization: String(observation.utilization ?? '?'), memory: gb(observation.memory_used_bytes ?? 0), temperature: String(observation.temperature ?? '?'), power: String(observation.power ?? '?') })} · {observation.compute_pids.join(', ')}</p>}
            {instance.kind === 'gpu' && <div className="flex flex-wrap gap-2 mt-2">
              <button disabled={busy} className="btn btn-sm" onClick={() => void act(() => api.updateGpuPolicy(instance.id, 'reserved'))}>{t('fabric.reserve')}</button>
              <button disabled={busy} className="btn btn-sm" onClick={() => void act(() => api.updateGpuPolicy(instance.id, 'reserved', true))}>{t('fabric.reserveAfter')}</button>
              <button disabled={busy} className="btn btn-sm" onClick={() => void act(() => api.updateGpuPolicy(instance.id, 'enabled'))}>{t('fabric.unreserve')}</button>
              <button disabled={busy} className="btn btn-sm" onClick={() => void act(() => api.updateGpuPolicy(instance.id, 'disabled'))}>{t('fabric.disable')}</button>
            </div>}
            {owners.map(owner => <LeaseOwner key={owner.id} owner={owner} busy={busy} logs={() => void act(async () => setTaskLogs({ owner: owner.owner_title, logs: await getTodoLogs(owner.owner_id) }))} stop={force => void act(async () => { const result = await api.stopResourceTodo(owner.owner_id, force); setMessage(result.status); })} />)}
          </div>;
        })}</div>
        {history[node.id]?.map(snapshot => <p className="mt-2 text-xs text-theme-muted" key={snapshot.id}>{snapshot.created_at} · {snapshot.diff_json}</p>)}
        {node.inventory && <details className="mt-3 text-xs"><summary>{t('fabric.capabilities')}</summary><pre className="overflow-auto">{JSON.stringify({ detected: node.inventory.capabilities, configured: node.policy.capability_overrides }, null, 2)}</pre></details>}
      </section>;
    })}
    <section><h3 className="font-semibold text-sm mb-2">{t('fabric.requests')}</h3>{requests.filter(request => request.status === 'waiting').map(request => <div key={request.id} className="panel p-3 text-xs mb-2"><p>{request.owner_type} · {request.owner_id} · {request.created_at}</p><pre className="overflow-auto mt-2">{JSON.stringify(JSON.parse(request.reasons_json), null, 2)}</pre></div>)}</section>
    {taskLogs && <Modal open onClose={() => setTaskLogs(null)} size="xl"><h3 className="font-semibold mb-3">{taskLogs.owner}</h3><pre className="max-h-[60vh] overflow-auto text-xs whitespace-pre-wrap">{taskLogs.logs.map(log => log.message).join('\n')}</pre></Modal>}
    {editor && <SshEditor node={editor === 'new' ? undefined : editor} hosts={hosts} close={() => setEditor(null)} save={async (name, connection, enabled) => { if (editor === 'new') await api.createSshNode(name, connection, enabled); else await api.updateNode(editor.id, { name, connection, enabled }); await load(); }} />}
  </div>;
}
