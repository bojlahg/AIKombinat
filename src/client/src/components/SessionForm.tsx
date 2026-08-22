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
import EffortStars from './EffortStars';

export interface SessionFormInitial {
  title: string;
  description: string;
  cliTool: string;
  cliModel: string;
  effortLevel: number | null;
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
    effortLevel?: number | null,
  ) => void;
  onCancel: () => void;
  projectCliTool?: string;
  isGitRepo?: boolean;
  /** Default for `useWorktree` in create mode; ignored when `initial` is set. */
  projectUseWorktree?: boolean;
  projectEffortLevel?: number | null;
}

export default function SessionForm({ projectId, initial, onSave, onCancel, projectCliTool, isGitRepo, projectUseWorktree, projectEffortLevel }: SessionFormProps) {
  const { t } = useI18n();
  const isEdit = !!initial;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [cliTool, setCliTool] = useState(initial?.cliTool ?? (projectCliTool || ''));
  const [cliModel, setCliModel] = useState(initial?.cliModel ?? '');
  const [effortLevel, setEffortLevel] = useState<1 | 2 | 3 | 4 | 5 | null>(initial?.effortLevel == null ? null : Math.min(5, Math.max(1, initial.effortLevel)) as 1 | 2 | 3 | 4 | 5);
  const [models, setModels] = useState<Record<string, Array<{ value: string; label: string; deprecated?: boolean; availabilityStatus?: string }>>>({});
  const [profileDefaults, setProfileDefaults] = useState<Record<string, number>>({});
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
    fetch('/api/agent-effort-profiles', { credentials: 'include' }).then((res) => res.json()).then((items: Array<{ cliTool: string; defaultLevel: number }>) => setProfileDefaults(Object.fromEntries(items.map((item) => [item.cliTool, item.defaultLevel])))).catch(() => setProfileDefaults({}));
  }, []);

  const selectedForDefaults = cliTool || projectCliTool || 'claude';
  const inheritedEffortLevel = (projectEffortLevel ?? profileDefaults[selectedForDefaults] ?? (selectedForDefaults === 'claude' ? 3 : 2)) as 1 | 2 | 3 | 4 | 5;

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
  const selectableModels = toolModels.filter((model) => !model.deprecated && model.availabilityStatus !== 'unavailable' && model.value);
  const selectedModel = cliModel ? toolModels.find((model) => model.value === cliModel) : undefined;
  const visibleModels = selectedModel && !selectableModels.some((model) => model.value === selectedModel.value)
    ? [selectedModel, ...selectableModels]
    : cliModel && !selectedModel
      ? [{ value: cliModel, label: cliModel, availabilityStatus: 'unknown' }, ...selectableModels]
      : selectableModels;
  const modelLabel = (model: { value: string; label: string; deprecated?: boolean; availabilityStatus?: string }) => {
    if (model.availabilityStatus === 'unavailable') return `${model.label} (${t('effort.modelUnavailable')})`;
    if (model.deprecated) return `${model.label} (${t('effort.modelDeprecated')})`;
    if (model.availabilityStatus === 'unknown' && model.value === cliModel) return `${model.label} (${t('effort.modelUnknown')})`;
    return model.label;
  };
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
      cliModel || undefined,
      effortLevel,
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
          onChange={(e) => { setCliTool(e.target.value); setCliModel(''); }}
          className="input-field text-xs flex-1"
        >
          <option value="">{t('session.cliTool')} (Default)</option>
          {interactiveTools.map((tool) => (
            <option key={tool.value} value={tool.value}>{optionLabel(tool)}</option>
          ))}
        </select>
        {!isRawShell && <select value={cliModel} onChange={(e) => setCliModel(e.target.value)} className="input-field text-xs flex-1" aria-label={t('effort.model')}>
          <option value="">{t('effort.providerModelDefault')}</option>
          {visibleModels.map((model) => <option key={model.value} value={model.value}>{modelLabel(model)}</option>)}
        </select>}
      </div>
      {!isRawShell && <div><label className="mb-1 block text-xs font-medium text-warm-500">{t('effort.label')}</label><label className="mb-1 flex items-center gap-2 text-xs text-warm-500"><input type="checkbox" checked={effortLevel === null} onChange={(event) => setEffortLevel(event.target.checked ? null : inheritedEffortLevel)} />{t('effort.inheritProjectAgent')}</label><EffortStars value={effortLevel ?? inheritedEffortLevel} onChange={setEffortLevel} /></div>}
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
