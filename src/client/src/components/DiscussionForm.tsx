import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import type { DiscussionAgent, MemoryInjectMode } from '../types';
import type { DiscussionInput } from '../api/discussions';
import { useI18n } from '../i18n';
import VaultInjectControl from './VaultInjectControl';
import type { VaultInjectMode } from '../api/vault';
import Button from './Button';

export interface DiscussionFormValues {
  title: string;
  description: string;
  agent_ids: string[];
  max_rounds: number;
  auto_implement: boolean;
  implement_agent_id: string;
  memory_inject_mode: MemoryInjectMode;
  memory_node_ids: string[];
  memory_raw_file_paths: string[];
  use_worktree: boolean;
}

interface DiscussionFormProps {
  agents: DiscussionAgent[];
  projectId?: string;
  initialValues?: Partial<DiscussionFormValues>;
  mode: 'create' | 'edit';
  allowAdvancedFields?: boolean;
  submitting?: boolean;
  isGitRepo?: boolean;
  /** Default for `use_worktree` in create mode; ignored when initialValues sets it. */
  projectUseWorktree?: boolean;
  onSubmit: (values: DiscussionInput) => Promise<void>;
  onCancel: () => void;
}

const DEFAULT_VALUES: DiscussionFormValues = {
  title: '',
  description: '',
  agent_ids: [],
  max_rounds: 3,
  auto_implement: false,
  implement_agent_id: '',
  memory_inject_mode: 'none',
  memory_node_ids: [],
  memory_raw_file_paths: [],
  use_worktree: true,
};

export default function DiscussionForm({
  agents,
  projectId,
  initialValues,
  mode,
  allowAdvancedFields = true,
  submitting = false,
  isGitRepo = false,
  projectUseWorktree = true,
  onSubmit,
  onCancel,
}: DiscussionFormProps) {
  const { t } = useI18n();
  const buildInitial = (): DiscussionFormValues =>
    ({ ...DEFAULT_VALUES, use_worktree: projectUseWorktree, ...initialValues });
  const [values, setValues] = useState<DiscussionFormValues>(buildInitial);
  const [includeLinked, setIncludeLinked] = useState<boolean>(false);

  useEffect(() => {
    setValues(buildInitial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValues, projectUseWorktree]);

  const setField = <K extends keyof DiscussionFormValues>(field: K, value: DiscussionFormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const getRoleLabel = (agent: DiscussionAgent) => t(`agents.roles.${agent.role}`) || agent.role;

  const selectedAgents = values.agent_ids
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is DiscussionAgent => !!agent);

  const toggleAgent = (agentId: string) => {
    setValues((prev) => {
      const nextAgentIds = prev.agent_ids.includes(agentId)
        ? prev.agent_ids.filter((id) => id !== agentId)
        : [...prev.agent_ids, agentId];

      return {
        ...prev,
        agent_ids: nextAgentIds,
        implement_agent_id: prev.implement_agent_id && !nextAgentIds.includes(prev.implement_agent_id)
          ? ''
          : prev.implement_agent_id,
      };
    });
  };

  const moveAgent = (agentId: string, direction: -1 | 1) => {
    setValues((prev) => {
      const currentIndex = prev.agent_ids.indexOf(agentId);
      const nextIndex = currentIndex + direction;
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= prev.agent_ids.length) return prev;

      const nextAgentIds = [...prev.agent_ids];
      [nextAgentIds[currentIndex], nextAgentIds[nextIndex]] = [nextAgentIds[nextIndex], nextAgentIds[currentIndex]];

      return {
        ...prev,
        agent_ids: nextAgentIds,
      };
    });
  };

  const handleSubmit = async () => {
    if (!values.title.trim() || !values.description.trim()) return;
    if (allowAdvancedFields && values.agent_ids.length < 2) return;
    if (allowAdvancedFields && values.auto_implement && !values.implement_agent_id) return;

    await onSubmit({
      title: values.title.trim(),
      description: values.description.trim(),
      agent_ids: values.agent_ids,
      max_rounds: values.max_rounds,
      auto_implement: allowAdvancedFields ? values.auto_implement : false,
      implement_agent_id: allowAdvancedFields && values.auto_implement ? values.implement_agent_id : undefined,
      memory_inject_mode: allowAdvancedFields ? values.memory_inject_mode : 'none',
      memory_node_ids: allowAdvancedFields && values.memory_inject_mode === 'selected' ? values.memory_node_ids : [],
      memory_raw_file_paths: allowAdvancedFields ? values.memory_raw_file_paths : [],
      // Only sent when the checkbox is shown (git repos); otherwise the stored value is left untouched.
      ...(isGitRepo ? { use_worktree: values.use_worktree } : {}),
    });
  };

  const canSubmit = values.title.trim()
    && values.description.trim()
    && (!allowAdvancedFields || values.agent_ids.length >= 2)
    && (!allowAdvancedFields || !values.auto_implement || !!values.implement_agent_id);

  return (
    <div className="card p-5 space-y-5">
      <div>
        <label className="block text-xs font-medium text-warm-500 mb-2">{t('discussions.titleLabel')}</label>
        <input
          type="text"
          value={values.title}
          onChange={(e) => setField('title', e.target.value)}
          className="input-field"
          placeholder={t('discussions.titlePlaceholder')}
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-warm-500 mb-2">{t('discussions.descriptionLabel')}</label>
        <textarea
          value={values.description}
          onChange={(e) => setField('description', e.target.value)}
          rows={4}
          className="input-field resize-y min-h-[80px]"
          placeholder={t('discussions.descriptionPlaceholder')}
        />
      </div>

      {allowAdvancedFields && (
        <>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-warm-500 mb-1.5">
                {t('discussions.agents')}
                <span className="ml-2 text-warm-400 font-normal">
                  {t('discussions.agentsSelectedCount').replace('{count}', String(values.agent_ids.length))}
                </span>
              </label>
              <p className="text-[11px] text-warm-400">
                {t('discussions.selectParticipantsHint')}
              </p>
            </div>

            <div className="rounded-2xl border border-accent/30 bg-accent/5 p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-warm-700">
                    {t('discussions.speakingOrder')}
                  </div>
                  <p className="text-[11px] text-warm-500 mt-1">
                    {t('discussions.speakingOrderHint')}
                  </p>
                </div>
                {selectedAgents.length >= 2 && (
                  <div className="text-2xs font-semibold text-accent-dark bg-white/70 border border-accent/30 rounded-full px-2.5 py-1">
                    {t('discussions.reorderEnabled')}
                  </div>
                )}
              </div>

              {selectedAgents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-warm-200 bg-white/70 px-4 py-5 text-center text-xs text-warm-400">
                  {t('discussions.speakingOrderEmpty')}
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedAgents.map((agent, index) => {
                    const isFirst = index === 0;
                    const isLast = index === selectedAgents.length - 1;
                    const turnLabel = isFirst
                      ? t('discussions.turnFirst')
                      : isLast
                        ? t('discussions.turnLast')
                        : t('discussions.turnNth').replace('{n}', String(index + 1));

                    return (
                      <div
                        key={agent.id}
                        className="flex flex-col gap-3 rounded-xl border border-warm-200 bg-white/85 px-3 py-3 md:flex-row md:items-center md:justify-between"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white flex-shrink-0">
                            {index + 1}
                          </div>
                          <div
                            className="w-6 h-6 rounded-full flex-shrink-0 border border-white/80 shadow-sm"
                            style={{ backgroundColor: agent.avatar_color || '#6366f1' }}
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-warm-700 truncate">{agent.name}</div>
                            <div className="text-[11px] text-warm-500">
                              {getRoleLabel(agent)} · {turnLabel}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => moveAgent(agent.id, -1)}
                            disabled={isFirst}
                          >
                            {t('discussions.earlier')}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => moveAgent(agent.id, 1)}
                            disabled={isLast}
                          >
                            {t('discussions.later')}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {agents.length === 0 ? (
              <p className="text-xs text-warm-400 py-3 px-4 bg-warm-50 rounded-xl border border-warm-150">{t('agents.empty')}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {agents.map((agent) => {
                  const selected = values.agent_ids.includes(agent.id);
                  const order = values.agent_ids.indexOf(agent.id) + 1;

                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className={`text-left rounded-2xl border px-3.5 py-3 transition-all ${
                        selected
                          ? 'border-accent bg-accent/5 shadow-sm'
                          : 'border-warm-200 bg-warm-50 hover:border-warm-300 hover:bg-warm-100'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="w-6 h-6 rounded-full flex-shrink-0 border border-white/80 shadow-sm"
                            style={{ backgroundColor: agent.avatar_color || '#6366f1' }}
                          />
                          <div className="min-w-0">
                            <div className={`text-sm font-semibold truncate ${selected ? 'text-warm-700' : 'text-warm-600'}`}>
                              {agent.name}
                            </div>
                            <div className="text-[11px] text-warm-400">{getRoleLabel(agent)}</div>
                          </div>
                        </div>

                        {selected && (
                          <div className="inline-flex items-center justify-center min-w-7 h-7 rounded-full bg-accent text-[11px] font-bold text-white flex-shrink-0">
                            {order}
                          </div>
                        )}
                      </div>

                      <div className={`mt-3 text-[11px] ${selected ? 'text-accent-dark' : 'text-warm-400'}`}>
                        {selected
                          ? t('discussions.includedAsTurn').replace('{n}', String(order))
                          : t('discussions.clickToAdd')}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-warm-500 mb-2">{t('discussions.maxRounds')}</label>
            <input
              type="number"
              min={1}
              max={10}
              value={values.max_rounds}
              onChange={(e) => setField('max_rounds', Number(e.target.value))}
              className="input-field w-24 text-center"
            />
            <p className="text-2xs text-warm-400 mt-1.5">{t('discussions.roundExplain')}</p>
          </div>

          {isGitRepo && (
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={values.use_worktree}
                  onChange={(e) => setField('use_worktree', e.target.checked)}
                  className="rounded-md border-warm-300 text-accent focus:ring-accent"
                />
                <GitBranch size={14} className="text-warm-500" />
                <span className="text-xs font-medium text-warm-500">
                  {t('discussions.worktreeIsolated')}
                </span>
              </label>
              <p className="text-2xs text-warm-400 mt-1 ml-6">
                {t('discussions.worktreeIsolatedHint')}
              </p>
            </div>
          )}

          {projectId && (
            <div>
              <VaultInjectControl
                projectId={projectId}
                mode={values.memory_inject_mode as VaultInjectMode}
                selectedPaths={values.memory_raw_file_paths}
                includeLinked={includeLinked}
                onChange={(m, paths, linked) => {
                  setValues(prev => ({
                    ...prev,
                    memory_inject_mode: m as MemoryInjectMode,
                    memory_node_ids: [],
                    memory_raw_file_paths: paths,
                  }));
                  setIncludeLinked(linked);
                }}
              />
            </div>
          )}

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={values.auto_implement}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setValues((prev) => ({
                    ...prev,
                    auto_implement: checked,
                    implement_agent_id: checked ? prev.implement_agent_id : '',
                  }));
                }}
                className="rounded-md border-warm-300 text-accent focus:ring-accent"
              />
              <span className="text-xs font-medium text-warm-500">{t('discussions.autoImplement')}</span>
            </label>
            <p className="text-2xs text-warm-400 mt-1 ml-6">{t('discussions.autoImplementHint')}</p>
            {values.auto_implement && (
              <div className="mt-2 ml-6">
                <label className="block text-xs font-medium text-warm-500 mb-1">{t('discussions.selectAgent')}</label>
                <select
                  value={values.implement_agent_id}
                  onChange={(e) => setField('implement_agent_id', e.target.value)}
                  className="input-field text-xs w-56"
                >
                  <option value="">{t('discussions.selectAgentPlaceholder')}</option>
                  {selectedAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name} ({getRoleLabel(agent)})</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex justify-end gap-3 pt-2 border-t border-warm-100">
        <button type="button" onClick={onCancel} className="btn-secondary text-xs py-2">{t('header.cancel')}</button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          className="btn-primary text-xs py-2"
        >
          {submitting ? t('header.saving') : mode === 'create' ? t('discussions.add') : t('header.save')}
        </button>
      </div>
    </div>
  );
}
