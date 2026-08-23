import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n';
import { CLI_TOOLS, type CliTool, type CliToolConfig } from '../cli-tools';
import { getCliStatus, type CliToolStatus } from '../api/cli-status';
import type { ExecutionProfile } from '../api/executionProfiles';
import {
  effortOptions,
  modelOptionLabel,
  visibleModelOptions,
  type AgentCliTool,
  type CatalogModel,
} from '../execution-options';

export type ExecutionMode = 'profile' | 'manual';

export interface ExecutionConfigurationValue {
  mode: ExecutionMode;
  executionProfileId: string | null;
  cliTool: string;
  cliModel: string;
  cliEffort: string | null;
}

export interface ExecutionConfigurationPickerProps {
  mode?: ExecutionMode;
  executionProfileId?: string | null;
  cliTool?: string;
  cliModel?: string;
  cliEffort?: string | null;
  onChange: (value: ExecutionConfigurationValue) => void;
  disabled?: boolean;
  allowRawShell?: boolean;
  interactiveOnly?: boolean;
  allowEmptyTool?: boolean;
  emptyToolLabel?: string;
  tools?: CliToolConfig[];
  profiles?: ExecutionProfile[];
  models?: Record<string, CatalogModel[]>;
  cliStatuses?: CliToolStatus[];
  className?: string;
}

export default function ExecutionConfigurationPicker({
  mode: controlledMode,
  executionProfileId = null,
  cliTool = 'claude',
  cliModel = '',
  cliEffort = null,
  onChange,
  disabled = false,
  allowRawShell = false,
  interactiveOnly = false,
  allowEmptyTool = false,
  emptyToolLabel,
  tools: customTools,
  profiles: externalProfiles,
  models: externalModels,
  cliStatuses: externalCliStatuses,
  className = '',
}: ExecutionConfigurationPickerProps) {
  const { t } = useI18n();

  const [internalProfiles, setInternalProfiles] = useState<ExecutionProfile[]>([]);
  const [internalModels, setInternalModels] = useState<Record<string, CatalogModel[]>>({});
  const [internalStatuses, setInternalStatuses] = useState<CliToolStatus[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(externalProfiles !== undefined);

  useEffect(() => {
    if (externalProfiles !== undefined) {
      setProfilesLoaded(true);
    }
  }, [externalProfiles]);

  useEffect(() => {
    if (!externalProfiles) {
      let cancelled = false;
      fetch('/api/execution-profiles?detail=full&includeDisabled=true', { credentials: 'include' })
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) {
            setInternalProfiles(Array.isArray(data) ? data : []);
            setProfilesLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setInternalProfiles([]);
            setProfilesLoaded(true);
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [externalProfiles]);

  useEffect(() => {
    if (!externalModels) {
      let cancelled = false;
      fetch('/api/models', { credentials: 'include' })
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) {
            setInternalModels(data || {});
          }
        })
        .catch(() => {
          if (!cancelled) {
            setInternalModels({});
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [externalModels]);

  useEffect(() => {
    if (!externalCliStatuses) {
      let cancelled = false;
      getCliStatus()
        .then((data) => {
          if (!cancelled) {
            setInternalStatuses(data || []);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setInternalStatuses([]);
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [externalCliStatuses]);

  const profiles = externalProfiles ?? internalProfiles;
  const models = externalModels ?? internalModels;
  const cliStatuses = externalCliStatuses ?? internalStatuses;

  const enabledProfiles = useMemo(() => {
    return profiles.filter((p) => p.isEnabled);
  }, [profiles]);

  const selectableProfiles = useMemo(() => {
    return profiles.filter((p) => p.isEnabled || p.id === executionProfileId);
  }, [profiles, executionProfileId]);

  const hasSelectableProfiles = enabledProfiles.length > 0 || (!!executionProfileId && selectableProfiles.length > 0);

  const currentMode: ExecutionMode = controlledMode ?? (executionProfileId ? 'profile' : 'manual');

  // Preserve previous selections when switching modes
  const lastManualToolRef = useRef<string>(cliTool || (allowEmptyTool ? '' : 'claude'));
  const lastConcreteToolRef = useRef<string>(cliTool || 'claude');
  const lastConcreteModelRef = useRef<string>(cliModel || '');
  const lastConcreteEffortRef = useRef<string | null>(cliEffort ?? null);
  const lastProfileIdRef = useRef<string>(executionProfileId || '');

  // Keep refs updated when controlled props change in their respective modes
  useEffect(() => {
    if (currentMode === 'manual') {
      lastManualToolRef.current = cliTool ?? '';
      if (cliTool) {
        lastConcreteToolRef.current = cliTool;
        lastConcreteModelRef.current = cliModel || '';
        lastConcreteEffortRef.current = cliEffort ?? null;
      }
    } else if (currentMode === 'profile') {
      if (executionProfileId) {
        lastProfileIdRef.current = executionProfileId;
      }
    }
  }, [currentMode, cliTool, cliModel, cliEffort, executionProfileId]);

  const availableTools = useMemo(() => {
    if (customTools) return customTools;
    let list = CLI_TOOLS;
    if (interactiveOnly) list = list.filter((tool) => tool.supportsInteractive);
    if (!allowRawShell) list = list.filter((tool) => tool.value !== 'raw-shell');
    return list;
  }, [customTools, interactiveOnly, allowRawShell]);

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

  const isEmptyTool = allowEmptyTool && !cliTool;
  const selectedTool = (cliTool || 'claude') as CliTool;
  const isRawShell = !isEmptyTool && selectedTool === 'raw-shell';
  const toolModels = isEmptyTool ? [] : (models[selectedTool] ?? []);
  const visibleModels = visibleModelOptions(toolModels, cliModel);
  const effort = isRawShell || isEmptyTool ? null : effortOptions(selectedTool as AgentCliTool, toolModels, cliModel, cliEffort);
  const modelLabel = (model: CatalogModel) =>
    modelOptionLabel(model, {
      unavailable: t('effort.modelUnavailable'),
      deprecated: t('effort.modelDeprecated'),
      unknown: t('effort.modelUnknown'),
    });

  const selectedProfile = useMemo(() => {
    if (!executionProfileId) return null;
    return profiles.find((p) => p.id === executionProfileId) ?? null;
  }, [profiles, executionProfileId]);

  const previewExecutors = useMemo(() => {
    if (!selectedProfile?.executors) return [];
    return selectedProfile.executors
      .filter((e) => e.isEnabled !== false)
      .slice()
      .sort((a, b) => a.priority - b.priority);
  }, [selectedProfile]);

  const actuallyEligibleExecutors = useMemo(() => {
    return previewExecutors.filter((e) => e.modelStatus !== 'missing');
  }, [previewExecutors]);

  const isProfileToggleDisabled = disabled || !profilesLoaded || !hasSelectableProfiles;

  const handleModeToggle = (nextMode: ExecutionMode) => {
    if (nextMode === currentMode || disabled) return;

    if (nextMode === 'profile') {
      if (!profilesLoaded || enabledProfiles.length === 0) return;

      const fallbackProfileId =
        lastProfileIdRef.current && enabledProfiles.some((p) => p.id === lastProfileIdRef.current)
          ? lastProfileIdRef.current
          : enabledProfiles[0]?.id || '';

      if (!fallbackProfileId) return;

      lastProfileIdRef.current = fallbackProfileId;

      onChange({
        mode: 'profile',
        executionProfileId: fallbackProfileId,
        cliTool: lastManualToolRef.current ?? cliTool,
        cliModel: '',
        cliEffort: null,
      });
    } else {
      const restoredTool = lastManualToolRef.current ?? (allowEmptyTool ? '' : 'claude');
      if (!restoredTool) {
        onChange({
          mode: 'manual',
          executionProfileId: null,
          cliTool: '',
          cliModel: '',
          cliEffort: null,
        });
      } else {
        const restoredModel = lastConcreteModelRef.current || '';
        const restoredEffort = lastConcreteEffortRef.current;

        onChange({
          mode: 'manual',
          executionProfileId: null,
          cliTool: restoredTool,
          cliModel: restoredModel,
          cliEffort: restoredEffort,
        });
      }
    }
  };

  const handleProfileChange = (profileId: string) => {
    lastProfileIdRef.current = profileId;
    onChange({
      mode: 'profile',
      executionProfileId: profileId || null,
      cliTool,
      cliModel: '',
      cliEffort: null,
    });
  };

  const handleToolChange = (tool: string) => {
    lastManualToolRef.current = tool;
    if (!tool) {
      onChange({
        mode: 'manual',
        executionProfileId: null,
        cliTool: '',
        cliModel: '',
        cliEffort: null,
      });
    } else if (tool === lastConcreteToolRef.current) {
      onChange({
        mode: 'manual',
        executionProfileId: null,
        cliTool: tool,
        cliModel: lastConcreteModelRef.current || '',
        cliEffort: lastConcreteEffortRef.current ?? null,
      });
    } else {
      lastConcreteToolRef.current = tool;
      lastConcreteModelRef.current = '';
      lastConcreteEffortRef.current = null;
      onChange({
        mode: 'manual',
        executionProfileId: null,
        cliTool: tool,
        cliModel: '',
        cliEffort: null,
      });
    }
  };

  const handleModelChange = (modelValue: string) => {
    lastConcreteModelRef.current = modelValue;
    const targetModel = toolModels.find((m) => m.value === modelValue);
    let nextEffort = cliEffort;

    if (selectedTool === 'antigravity' && targetModel?.providerVariants && Object.keys(targetModel.providerVariants).length > 0) {
      if (!cliEffort || !targetModel.supportedEfforts?.includes(cliEffort)) {
        nextEffort = targetModel.supportedEfforts?.[0] || 'medium';
      }
    }

    lastConcreteEffortRef.current = nextEffort;
    onChange({
      mode: 'manual',
      executionProfileId: null,
      cliTool,
      cliModel: modelValue,
      cliEffort: nextEffort,
    });
  };

  const handleEffortChange = (effortValue: string) => {
    const nextEffort = effortValue || null;
    lastConcreteEffortRef.current = nextEffort;
    onChange({
      mode: 'manual',
      executionProfileId: null,
      cliTool,
      cliModel,
      cliEffort: nextEffort,
    });
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Execution Mode Segmented Toggle */}
      <div>
        <label className="block text-xs font-medium text-warm-500 mb-1.5">
          {t('executionMode.label')}
        </label>
        <div className="inline-flex gap-1 rounded-lg bg-warm-100 p-1" role="group" aria-label={t('executionMode.label')}>
          <button
            type="button"
            onClick={() => handleModeToggle('profile')}
            disabled={isProfileToggleDisabled}
            title={!hasSelectableProfiles && profilesLoaded ? t('profiles.noModels') : undefined}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              currentMode === 'profile'
                ? 'bg-theme-card text-warm-700 shadow-sm'
                : isProfileToggleDisabled
                ? 'text-warm-300 cursor-not-allowed'
                : 'text-warm-500 hover:text-warm-700'
            }`}
          >
            {t('executionMode.profile')}
          </button>
          <button
            type="button"
            onClick={() => handleModeToggle('manual')}
            disabled={disabled}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              currentMode === 'manual'
                ? 'bg-theme-card text-warm-700 shadow-sm'
                : 'text-warm-500 hover:text-warm-700'
            }`}
          >
            {t('executionMode.manual')}
          </button>
        </div>
      </div>

      {/* MODE A: Profile Mode */}
      {currentMode === 'profile' && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs font-medium text-warm-500 mb-1.5">
              {t('executionMode.selectProfile')}
            </label>
            <select
              value={executionProfileId ?? ''}
              onChange={(e) => handleProfileChange(e.target.value)}
              disabled={disabled}
              className="input-field text-sm w-full"
              aria-label={t('executionMode.selectProfile')}
            >
              {selectableProfiles.length === 0 && <option value="">{t('profiles.noModels')}</option>}
              {selectableProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isEnabled ? '' : ` (${t('profiles.profileUnavailable')})`}
                </option>
              ))}
            </select>
          </div>

          {/* Profile Executor Chain Preview */}
          {selectedProfile && (
            <div className="rounded-lg border border-warm-200 bg-warm-50/70 p-3 text-xs" data-testid="profile-executor-preview">
              <div className="text-2xs font-medium uppercase tracking-wider text-warm-400 mb-1.5">
                {t('executionMode.previewTitle')}
              </div>
              {previewExecutors.length === 0 ? (
                <p className="text-status-warning font-medium flex items-center gap-1.5 text-xs py-0.5" data-testid="no-eligible-warning">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span>{t('profiles.noEligible')}</span>
                </p>
              ) : (
                <>
                  {actuallyEligibleExecutors.length === 0 && (
                    <p className="text-status-warning font-medium flex items-center gap-1.5 text-xs mb-2 py-0.5" data-testid="no-eligible-warning">
                      <AlertTriangle size={14} className="shrink-0" />
                      <span>{t('profiles.noEligible')}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 text-warm-600">
                    {previewExecutors.map((executor, idx) => {
                      const isUnavailable = executor.modelStatus === 'missing';
                      const toolLabel = CLI_TOOLS.find((t) => t.value === executor.cliTool)?.label || executor.cliTool;
                      const effortText = executor.effortValue ? ` / ${executor.effortValue}` : '';
                      return (
                        <div key={executor.id || idx} className="inline-flex items-center gap-1.5">
                          {idx > 0 && <span className="text-warm-300 select-none">→</span>}
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border font-medium text-xs ${
                              isUnavailable
                                ? 'bg-status-error/10 border-status-error/30 text-status-error'
                                : 'bg-theme-card border-warm-200 text-warm-700 shadow-2xs'
                            }`}
                          >
                            <span>{toolLabel} / {executor.modelLabel || executor.modelValue}{effortText}</span>
                            {isUnavailable && (
                              <span className="text-2xs font-semibold uppercase px-1 py-0.2 rounded bg-status-error/20 text-status-error">
                                {t('effort.modelUnavailable')}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {selectedProfile.description && (
                <p className="mt-2 text-2xs text-warm-500 border-t border-warm-200/60 pt-1.5">
                  {selectedProfile.description}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* MODE B: Manual Mode */}
      {currentMode === 'manual' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* CLI Tool */}
          <div>
            <label className="block text-xs font-medium text-warm-500 mb-1.5">
              {t('todoForm.cliTool')}
            </label>
            <select
              value={cliTool}
              onChange={(e) => handleToolChange(e.target.value)}
              disabled={disabled}
              className="input-field text-sm"
              aria-label={t('todoForm.cliTool')}
            >
              {allowEmptyTool && <option value="">{emptyToolLabel || `${t('session.cliTool')} (Default)`}</option>}
              {availableTools.map((tool) => (
                <option key={tool.value} value={tool.value}>
                  {optionLabel(tool)}
                </option>
              ))}
            </select>
          </div>

          {/* Model Selection (hidden for raw shell and empty tool) */}
          {!isRawShell && !isEmptyTool && (
            <div>
              <label className="block text-xs font-medium text-warm-500 mb-1.5">
                {t('effort.model')}
              </label>
              <select
                value={cliModel}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={disabled}
                className="input-field text-sm"
                aria-label={t('effort.model')}
              >
                <option value="">{t('effort.providerModelDefault')}</option>
                {visibleModels.map((model) => (
                  <option key={model.value} value={model.value}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Effort Selection (hidden for raw shell and empty tool) */}
          {!isRawShell && !isEmptyTool && effort && (
            <div>
              <label className="block text-xs font-medium text-warm-500 mb-1.5">
                {t('effort.label')}
              </label>
              <select
                value={cliEffort ?? ''}
                onChange={(e) => handleEffortChange(e.target.value)}
                disabled={disabled}
                className="input-field text-sm"
                aria-label={t('effort.label')}
              >
                {effort.allowProviderDefault && <option value="">{t('profiles.providerDefault')}</option>}
                {effort.values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                    {value === cliEffort && effort.unsupportedSavedEffort ? ` (${t('effort.unsupported')})` : ''}
                  </option>
                ))}
              </select>
              {effort.unsupportedSavedEffort && (
                <p className="mt-1 text-2xs text-status-warning">{t('effort.unsupportedWarning')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
