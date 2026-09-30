import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api/orchestrators';
import { getProfiles, type ExecutionProfile } from '../api/executionProfiles';
import { useI18n } from '../i18n';
import type { TranslationKey } from '../i18n/types';
import type { WsEvent } from '../hooks/useWebSocket';

const defaults = { title: '', objective: '', primary_execution_profile_id: '', max_turns: 32, max_children: 24, max_concurrent_children: 4, max_active_resource_requests: 2 };
const caps = { max_turns: 128, max_children: 100, max_concurrent_children: 16, max_active_resource_requests: 8 };
export default function OrchestratorPanel({ projectId, onEvent, connected }: { projectId: string; onEvent: (handler: (event: WsEvent) => void) => () => void; connected: boolean }) {
  const { t } = useI18n();
  const [list, setList] = useState<api.Orchestration[]>([]);
  const [selected, setSelected] = useState('');
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [form, setForm] = useState(defaults);
  const [creating, setCreating] = useState(false);
  const [messages, setMessages] = useState<api.Message[]>([]);
  const [children, setChildren] = useState<api.Child[]>([]);
  const [resources, setResources] = useState<api.Reservation[]>([]);
  const [turns, setTurns] = useState<api.Turn[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : t('orchestrator.error'));
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const rows = await api.list(projectId);
    if (generation.current !== current) return;
    setList(rows);
    if (!selected) { if (rows.length) setSelected(rows[0].id); return; }
    const detail = await Promise.all([api.messages(selected), api.children(selected), api.resources(selected), api.turns(selected)]);
    if (generation.current !== current) return;
    setMessages(detail[0]); setChildren(detail[1]); setResources(detail[2]); setTurns(detail[3]);
  }, [projectId, selected]);
  useEffect(() => { void refresh().catch(fail); return () => { generation.current++; }; }, [refresh, connected]);
  useEffect(() => { getProfiles(false).then(rows => setProfiles(rows.filter(profile => profile.isEnabled && profile.executors?.some(executor => executor.isEnabled && executor.cliTool === 'claude')))).catch(fail); }, [projectId]);
  useEffect(() => onEvent(event => { if (event.projectId === projectId && event.type.startsWith('orchestrator:')) void refresh().catch(fail); }), [onEvent, projectId, refresh]);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(''); try { await operation(); await refresh(); } catch (error) { fail(error); } finally { setBusy(false); } };
  const status = (value: string) => t(`orchestrator.status.${value}` as TranslationKey);
  const current = list.find(item => item.id === selected);
  const inputClass = 'w-full rounded-xl bg-theme-bg-secondary px-3 py-2 text-theme-text border border-theme-border';
  const buttonClass = 'btn-secondary px-3 py-2 rounded-full disabled:opacity-50';
  return <section className="card-static p-5 space-y-5">
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{t('orchestrator.title')}</h2><button className={buttonClass} onClick={() => setCreating(!creating)}>{t('orchestrator.new')}</button></div>
    {error && <p role="alert" className="text-status-error">{error}</p>}
    {creating && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void act(async () => { const created = await api.create(projectId, form); setSelected(created.id); setCreating(false); setForm(defaults); }); }}>
      <label className="block">{t('orchestrator.name')}<input required maxLength={256} className={inputClass} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label className="block">{t('orchestrator.objective')}<textarea required rows={4} className={inputClass} value={form.objective} onChange={event => setForm({ ...form, objective: event.target.value })} /></label>
      <label className="block">{t('orchestrator.profile')}<select required className={inputClass} value={form.primary_execution_profile_id} onChange={event => setForm({ ...form, primary_execution_profile_id: event.target.value })}><option value="">{t('orchestrator.selectProfile')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      {!profiles.length && <p className="text-theme-muted">{t('orchestrator.noProfiles')}</p>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{(Object.keys(caps) as (keyof typeof caps)[]).map(key => <label key={key}>{t(`orchestrator.${key}` as TranslationKey)}<input type="number" min={1} max={caps[key]} required className={inputClass} value={form[key]} onChange={event => setForm({ ...form, [key]: Number(event.target.value) })} /></label>)}</div>
      <button disabled={busy} className={buttonClass}>{t('orchestrator.create')}</button>
    </form>}
    {!list.length && <p className="text-theme-muted">{t('orchestrator.empty')}</p>}
    <div className="flex flex-wrap gap-2">{list.map(item => <button className={`${buttonClass} ${selected === item.id ? 'bg-theme-active' : ''}`} key={item.id} onClick={() => { setSelected(item.id); setMessages([]); setChildren([]); setResources([]); setTurns([]); }}>{item.title} · {status(item.status)}</button>)}</div>
    {current && <div className="space-y-5">
      <div className="flex flex-wrap gap-3 items-center"><h3 className="font-semibold">{current.title}</h3><span>{status(current.status)}</span><span className="text-theme-muted">{profiles.find(profile => profile.id === current.primary_execution_profile_id)?.name}</span>
        {(['start','pause','resume','cancel'] as const).filter(action => action === 'start' ? current.status === 'pending' && !current.turn_count : action === 'resume' ? ['paused','failed'].includes(current.status) : !['completed','cancelled','failed','paused'].includes(current.status)).map(action => <button disabled={busy} key={action} className={buttonClass} onClick={() => void act(() => api.control(current.id, action))}>{t(`orchestrator.${action}`)}</button>)}
      </div>
      <p className="whitespace-pre-wrap">{current.objective}</p>
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="space-y-3"><h3 className="font-semibold">{t('orchestrator.chat')}</h3><div className="max-h-96 overflow-y-auto space-y-3">{messages.map(item => <div className="rounded-xl bg-theme-bg-secondary p-3" key={item.id}><p className="text-xs text-theme-muted">{t(`orchestrator.role.${item.role}` as TranslationKey)}</p><p className="whitespace-pre-wrap">{item.content}</p></div>)}</div>
          <form onSubmit={event => { event.preventDefault(); void act(async () => { await api.send(current.id, message); setMessage(''); }); }} className="space-y-2"><label>{t('orchestrator.message')}<textarea className={inputClass} rows={3} value={message} onChange={event => setMessage(event.target.value)} required /></label><button disabled={busy || !message.trim()} className={buttonClass}>{t('orchestrator.send')}</button></form>
        </div>
        <div className="space-y-3"><h3 className="font-semibold">{t('orchestrator.plan')}</h3><p className="whitespace-pre-wrap">{current.current_plan || t('orchestrator.noCheckpoint')}</p><h3 className="font-semibold">{t('orchestrator.state')}</h3><p className="whitespace-pre-wrap">{current.state_summary || t('orchestrator.noCheckpoint')}</p>
          <p>{t('orchestrator.turns')}: {current.turn_count}/{current.max_turns} · {t('orchestrator.children')}: {current.child_count}/{current.max_children}</p>
          {current.waiting_reason && <p>{t('orchestrator.waiting')}: {current.waiting_reason}</p>}
          {current.wake_condition_json && <pre className="text-xs whitespace-pre-wrap">{current.wake_condition_json}</pre>}
          {['paused','failed'].includes(current.status) && <label>{t('orchestrator.max_turns')}<input type="number" min={current.turn_count + 1} max={128} defaultValue={current.max_turns} onBlur={event => { const value = Number(event.target.value); if (value !== current.max_turns) void act(() => api.update(current.id, { max_turns: value })); }} className={inputClass} /></label>}
        </div>
      </div>
      <h3 className="font-semibold">{t('orchestrator.children')}</h3><div className="space-y-2">{children.map(child => <div className="rounded-xl bg-theme-bg-secondary p-3" key={child.id}><Link className="text-accent" to={`/projects/${projectId}?tab=tasks&todo=${child.todo_id}`}>{child.title}</Link> · {status(child.status)}{child.pipeline_phase && <span> · {t(`review.pipeline.phase.${child.pipeline_phase}` as TranslationKey)}</span>}<p className="text-sm text-theme-muted">{child.execution_profile_name} {child.executor} {child.model}</p>{child.resource_binding && <p className="text-xs">{child.resource_binding.id}</p>}<p className="text-sm text-theme-muted">{child.summary}</p>{child.latest_error && <p className="text-status-error">{child.latest_error}</p>}</div>)}</div>
      <h3 className="font-semibold">{t('orchestrator.resources')}</h3><div className="space-y-2">{resources.map(resource => <div className="rounded-xl bg-theme-bg-secondary p-3" key={resource.request_id}><p>{resource.purpose} · {status(resource.status)}</p><pre className="text-xs whitespace-pre-wrap">{JSON.stringify(resource.requirements, null, 2)}</pre>{resource.binding && <p>{resource.binding.id} · {resource.binding.capacity.cpu_threads} CPU · {resource.binding.capacity.memory_bytes} B</p>}{resource.claim_expires_at && <p>{t('orchestrator.expiry')}: {new Date(resource.claim_expires_at).toLocaleString()}</p>}{resource.claimed_todo_id && <Link to={`/projects/${projectId}?tab=tasks&todo=${resource.claimed_todo_id}`}>{t('orchestrator.claimedChild')}</Link>}{['bound','waiting'].includes(resource.status) && !resource.claimed_todo_id && <button className={buttonClass} disabled={busy} onClick={() => void act(() => api.release(current.id, resource.request_id))}>{t('orchestrator.release')}</button>}</div>)}</div>
      <h3 className="font-semibold">{t('orchestrator.turns')}</h3><div className="space-y-2">{turns.map(turn => <div key={turn.id} className="text-sm">#{turn.turn_index} · {status(turn.status)} · PID {turn.process_pid}{turn.error_message && <p className="text-status-error">{turn.error_message}</p>}</div>)}</div>
    </div>}
  </section>;
}
