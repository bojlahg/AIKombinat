import { useEffect, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useI18n } from '../i18n';
import { CLI_TOOLS, type CliTool, type CliToolConfig } from '../cli-tools';
import { getCliStatus, type CliToolStatus } from '../api/cli-status';
import VaultInjectControl from './VaultInjectControl';
import type { MemoryInjectMode, SessionTag } from '../types';
import type { VaultInjectMode } from '../api/vault';
import * as tagsApi from '../api/sessionTags';
import * as settingsApi from '../api/sessionSettings';
import { forceImeHandoff } from '../ime-handoff';
import type { ExecutionProfile } from '../api/executionProfiles';
import { effortOptions, modelOptionLabel, visibleModelOptions, type CatalogModel, type AgentCliTool } from '../execution-options';

export interface SessionFormInitial {
  title: string;
  description: string;
  cliTool: string;
  cliModel: string;
  cliEffort?: string | null;
  executionProfileId?: string | null;
  useWorktree: boolean;
  memoryInjectMode: MemoryInjectMode;
  memoryNodeIds: string[];
  memoryRawFilePaths?: string[];
  tagId?: string | null;
}

interface SessionFormProps {
  projectId: string;
  /** Present → edit mode, prefills the form. Absent → create mode (defaults). */
  initial?: SessionFormInitial;
  onSave: (
    title: string,
    description: string,
    cliTool?: string,
    useWorktree?: boolean,
    memoryInjectMode?: MemoryInjectMode,
    memoryNodeIds?: string[],
    memoryRawFilePaths?: string[],
    tagId?: string | null,
    cliModel?: string,
    cliEffort?: string | null,
    executionProfileId?: string | null,
  ) => void;
  onCancel: () => void;
  projectCliTool?: string;
  isGitRepo?: boolean;
  /** Default for `useWorktree` in create mode; ignored when `initial` is set. */
  projectUseWorktree?: boolean;
}

export default function SessionForm({ projectId, initial, onSave, onCancel, projectCliTool, isGitRepo, projectUseWorktree }: SessionFormProps) {
  const { t } = useI18n();
  const isEdit = !!initial;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [cliTool, setCliTool] = useState(initial?.cliTool ?? (projectCliTool || ''));
  const [cliModel, setCliModel] = useState(initial?.cliModel ?? '');
  const [cliEffort, setCliEffort] = useState(initial?.cliEffort ?? '');
  const [executionProfileId, setExecutionProfileId] = useState(initial?.executionProfileId ?? '');
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [models, setModels] = useState<Record<string, CatalogModel[]>>({});
  const [useWorktree, setUseWorktree] = useState(initial?.useWorktree ?? !!projectUseWorktree);
  const [vaultMode, setVaultMode] = useState<VaultInjectMode>((initial?.memoryInjectMode as VaultInjectMode | undefined) ?? 'none');
  const [vaultPaths, setVaultPaths] = useState<string[]>(initial?.memoryRawFilePaths ?? []);
  const [includeLinked, setIncludeLinked] = useState<boolean>(false);
  const [tagId, setTagId] = useState<string | null>(initial?.tagId ?? null);
  const [tags, setTags] = useState<SessionTag[]>([]);
  const [cliStatuses, setCliStatuses] = useState<CliToolStatus[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  // Windows EXE + Korean IME: xterm's helper textarea retains the native HWND
  // keyboard focus after a session has been interacted with, so React's
  // autoFocus on the title input only moves DOM focus — clicks land but the
  // caret never activates. Run the shared forced handoff (OS window blur→focus
  // cycle in main, then focus the title input) — falling back to a plain
  // focus() outside Electron. Also park every xterm helper textarea out of
  // the focus traversal for the form's lifetime.
  useEffect(() => {
    fetch('/api/models', { credentials: 'include' }).then((res) => res.json()).then(setModels).catch(() => setModels({}));
    fetch('/api/execution-profiles?includeDisabled=true', { credentials: 'include' }).then((res) => res.json()).then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const selectedForDefaults = cliTool || projectCliTool || 'claude';

  useEffect(() => {
    if (!forceImeHandoff(() => titleRef.current?.focus())) {
      titleRef.current?.focus();
    }

    const helpers = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea'));
    const prevHelpers = helpers.map((h) => ({
      el: h,
      tabIndex: h.tabIndex,
      ariaHidden: h.getAttribute('aria-hidden'),
    }));
    helpers.forEach((h) => {
      h.tabIndex = -1;
      h.setAttribute('aria-hidden', 'true');
      h.blur();
    });

    return () => {
      prevHelpers.forEach(({ el, tabIndex, ariaHidden }) => {
        el.tabIndex = tabIndex;
        if (ariaHidden === null) el.removeAttribute('aria-hidden');
        else el.setAttribute('aria-hidden', ariaHidden);
      });
    };
    // Mount-time only — running this on every initial change would steal focus
    // away from the user mid-edit when the parent reuses the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    tagsApi.getSessionTags()
      .then((list) => { if (!cancelled) setTags(list); })
      .catch(() => { /* silent — settings panel surfaces errors */ });
    if (!isEdit && isGitRepo) {
      settingsApi.getSessionSettings()
        .then((s) => { if (!cancelled) setUseWorktree(s.defaultUseWorktree); })
        .catch(() => { /* keep default false */ });
    }
    return () => { cancelled = true; };
  }, [isEdit, isGitRepo]);

  // CLI install status + resolved raw-shell name, for dropdown labels.
  useEffect(() => {
    let cancelled = false;
    getCliStatus()
      .then((list) => { if (!cancelled) setCliStatuses(list); })
      .catch(() => { /* fall back to static labels */ });
    return () => { cancelled = true; };
  }, []);

  const interactiveTools = CLI_TOOLS.filter((tool) => tool.supportsInteractive);

  // Label each option from live status: raw-shell shows its actual shell
  // ("Raw Shell (PowerShell)"); uninstalled AI CLIs get a "(not installed)" tag.
  const optionLabel = (tool: CliToolConfig): string => {
    const status = cliStatuses.find((s) => s.tool === tool.value);
    if (tool.value === 'raw-shell') {
      return status?.version ? `Raw Shell (${status.version})` : tool.label;
    }
    if (status && !status.installed) {
      return `${tool.label}${t('session.cliNotInstalled')}`;
    }
    return tool.label;
  };
  const selectedTool = (cliTool || projectCliTool || 'claude') as CliTool;
  const toolModels = models[selectedTool] ?? [];
  const visibleModels = visibleModelOptions(toolModels, cliModel);
  const effort = selectedTool === 'raw-shell' ? null : effortOptions(selectedTool as AgentCliTool, toolModels, cliModel, cliEffort);
  const modelLabel = (model: CatalogModel) => modelOptionLabel(model, { unavailable: t('effort.modelUnavailable'), deprecated: t('effort.modelDeprecated'), unknown: t('effort.modelUnknown') });
  // Raw shell: no auto-submitted prompt, no wiki/memory injection.
  // Description/memory state is left untouched in the form so toggling
  // back to an AI CLI doesn't lose what the user already typed; the inputs
  // are just hidden while raw-shell is selected and the server ignores them.
  const isRawShell = selectedTool === 'raw-shell';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(
      title.trim(),
      description.trim(),
      cliTool || undefined,
      useWorktree,
      vaultMode as MemoryInjectMode,
      [],
      vaultPaths,
      tagId,
      executionProfileId ? undefined : cliModel || undefined,
      executionProfileId ? null : cliEffort || null,
      executionProfileId || null,
    );
  };

  const selectedTag = tags.find((tt) => tt.id === tagId) ?? null;

  return (
    <form
      onSubmit={handleSubmit}
      className="card p-4 space-y-3 animate-scale-in"
    >
      <input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('session.title')}
        className="input-field text-sm"
      />
      {!isRawShell && (
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('session.description')}
          className="input-field text-sm min-h-[60px] max-h-[280px] resize-y [field-sizing:content]"
          rows={2}
        />
      )}
      <div className="flex gap-2">
        <select
          value={cliTool}
          onChange={(e) => { setCliTool(e.target.value); setCliModel(''); setCliEffort(''); setExecutionProfileId(''); }}
          className="input-field text-xs flex-1"
        >
          <option value="">{t('session.cliTool')} (Default)</option>
          {interactiveTools.map((tool) => (
            <option key={tool.value} value={tool.value}>{optionLabel(tool)}</option>
          ))}
        </select>
        {!isRawShell && <select value={executionProfileId} onChange={(e) => setExecutionProfileId(e.target.value)} className="input-field text-xs flex-1" aria-label={t('profiles.configuration')}><option value="">{t('profiles.manual')}</option>{profiles.filter((p) => p.isEnabled || p.id === executionProfileId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.isEnabled ? '' : ` (${t('profiles.profileUnavailable')})`}</option>)}</select>}
        {!isRawShell && !executionProfileId && <select value={cliModel} onChange={(e) => setCliModel(e.target.value)} className="input-field text-xs flex-1" aria-label={t('effort.model')}>
          <option value="">{t('effort.providerModelDefault')}</option>
          {visibleModels.map((model) => <option key={model.value} value={model.value}>{modelLabel(model)}</option>)}
        </select>}
      </div>
      {!isRawShell && !executionProfileId && effort && <div><label className="mb-1 block text-xs font-medium text-warm-500">{t('effort.label')}</label><select value={cliEffort} onChange={(e) => setCliEffort(e.target.value)} className="input-field text-xs"><option value="">{t('profiles.providerDefault')}</option>{effort.values.map((value) => <option key={value} value={value}>{value}{value === cliEffort && effort.unsupportedSavedEffort ? ` (${t('effort.unsupported')})` : ''}</option>)}</select>{effort.unsupportedSavedEffort && <p className="mt-1 text-2xs text-status-warning">{t('effort.unsupportedWarning')}</p>}</div>}
      {executionProfileId && <p className="text-xs text-warm-500">{profiles.find((item) => item.id === executionProfileId)?.description || t('profiles.profileUnavailable')}</p>}
      {tags.length > 0 && (
        <div className="flex items-center gap-2">
          {selectedTag && (
            <span
              className="w-4 h-4 rounded-full shrink-0 border"
              style={{ backgroundColor: selectedTag.color, borderColor: 'rgba(0,0,0,0.08)' }}
            />
          )}
          <select
            value={tagId ?? ''}
            onChange={(e) => setTagId(e.target.value || null)}
            className="input-field text-xs flex-1"
          >
            <option value="">{t('session.tag.none')}</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
        </div>
      )}
      {isGitRepo && (
        <label className="flex items-center gap-2 text-xs text-warm-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => setUseWorktree(e.target.checked)}
            className="rounded border-warm-300"
          />
          <GitBranch size={14} />
          {t('session.worktree')}
        </label>
      )}
      {!isRawShell && (
        <VaultInjectControl
          projectId={projectId}
          mode={vaultMode}
          selectedPaths={vaultPaths}
          includeLinked={includeLinked}
          onChange={(m, paths, linked) => { setVaultMode(m); setVaultPaths(paths); setIncludeLinked(linked); }}
        />
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">
          {t('form.cancel')}
        </button>
        <button type="submit" className="btn-primary text-xs py-1.5 px-3">
          {isEdit ? t('session.save') : t('session.create')}
        </button>
      </div>
    </form>
  );
}
