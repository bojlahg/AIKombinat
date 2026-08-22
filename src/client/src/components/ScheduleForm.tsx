import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { CLI_TOOLS, type CliTool } from '../cli-tools';
import CronBuilder from './CronBuilder';
import type { ExecutionProfile } from '../api/executionProfiles';
import { effortOptions, modelOptionLabel, visibleModelOptions, type AgentCliTool, type CatalogModel } from '../execution-options';

type ScheduleType = 'recurring' | 'once';

interface ScheduleFormProps {
  onSave: (data: {
    title: string;
    description: string;
    cronExpression: string;
    cliTool?: string;
    cliModel?: string;
    cliEffort?: string | null;
    executionProfileId?: string | null;
    skipIfRunning?: boolean;
    scheduleType: ScheduleType;
    runAt?: string;
  }) => void;
  onCancel: () => void;
  initialTitle?: string;
  initialDescription?: string;
  initialCronExpression?: string;
  initialCliTool?: string;
  initialCliModel?: string | null;
  initialCliEffort?: string | null;
  initialExecutionProfileId?: string | null;
  initialSkipIfRunning?: boolean;
  initialScheduleType?: ScheduleType;
  initialRunAt?: string;
  projectCliTool?: string;
}

function getDefaultRunAt(): string {
  const now = new Date();
  now.setHours(now.getHours() + 1);
  now.setMinutes(0, 0, 0);
  // Format as local datetime for input[type=datetime-local]
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

function toLocalDatetimeValue(isoStr: string): string {
  const date = new Date(isoStr);
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

export default function ScheduleForm({
  onSave,
  onCancel,
  initialTitle = '',
  initialDescription = '',
  initialCronExpression = '',
  initialCliTool,
  initialCliModel,
  initialCliEffort,
  initialExecutionProfileId,
  initialSkipIfRunning = true,
  initialScheduleType = 'recurring',
  initialRunAt,
  projectCliTool = 'claude',
}: ScheduleFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [cronExpression, setCronExpression] = useState(initialCronExpression);
  const [cliTool, setCliTool] = useState<CliTool>((initialCliTool as CliTool) || (projectCliTool as CliTool) || 'claude');
  const [cliModel, setCliModel] = useState(initialCliModel ?? '');
  const [cliEffort, setCliEffort] = useState(initialCliEffort ?? '');
  const [executionProfileId, setExecutionProfileId] = useState(initialExecutionProfileId ?? '');
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [models, setModels] = useState<Record<string, CatalogModel[]>>({});
  const [skipIfRunning, setSkipIfRunning] = useState(initialSkipIfRunning);
  const [scheduleType, setScheduleType] = useState<ScheduleType>(initialScheduleType);
  const [runAt, setRunAt] = useState(initialRunAt ? toLocalDatetimeValue(initialRunAt) : getDefaultRunAt());
  const { t } = useI18n();
  useEffect(() => { fetch('/api/execution-profiles?includeDisabled=true', { credentials: 'include' }).then((r) => r.json()).then(setProfiles).catch(() => setProfiles([])); fetch('/api/models', { credentials: 'include' }).then((r) => r.json()).then(setModels).catch(() => setModels({})); }, []);

  const isOnce = scheduleType === 'once';
  const canSubmit = title.trim() && (isOnce ? !!runAt : !!cronExpression.trim());
  const toolModels = models[cliTool] ?? [];
  const visibleModels = visibleModelOptions(toolModels, cliModel);
  const effort = cliTool === 'raw-shell' ? null : effortOptions(cliTool as AgentCliTool, toolModels, cliModel, cliEffort);
  const modelLabel = (model: CatalogModel) => modelOptionLabel(model, { unavailable: t('effort.modelUnavailable'), deprecated: t('effort.modelDeprecated'), unknown: t('effort.modelUnknown') });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSave({
      title: title.trim(),
      description: description.trim(),
      cronExpression: isOnce ? '' : cronExpression.trim(),
      cliTool,
      cliModel: executionProfileId ? undefined : cliModel || undefined,
      cliEffort: executionProfileId ? null : cliEffort || null,
      executionProfileId: executionProfileId || null,
      skipIfRunning,
      scheduleType,
      runAt: isOnce ? new Date(runAt).toISOString() : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="card p-5">
      <div className="mb-3">
        <input
          type="text"
          placeholder={t('scheduleForm.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input-field"
          autoFocus
        />
      </div>
      <div className="mb-3">
        <textarea
          placeholder={t('scheduleForm.descPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="input-field min-h-[76px] max-h-[320px] resize-y [field-sizing:content]"
        />
      </div>

      {/* Schedule Type Toggle */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-warm-500 mb-1.5">
          {t('schedule.type')}
        </label>
        <div className="inline-flex gap-1 rounded-lg bg-warm-100 p-1">
          <button
            type="button"
            onClick={() => setScheduleType('recurring')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              scheduleType === 'recurring'
                ? 'bg-theme-card text-warm-700 shadow-sm'
                : 'text-warm-500 hover:text-warm-700'
            }`}
          >
            {t('schedule.recurring')}
          </button>
          <button
            type="button"
            onClick={() => setScheduleType('once')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              scheduleType === 'once'
                ? 'bg-theme-card text-warm-700 shadow-sm'
                : 'text-warm-500 hover:text-warm-700'
            }`}
          >
            {t('schedule.once')}
          </button>
        </div>
      </div>

      {/* Cron Expression (recurring) or DateTime picker (once) */}
      {isOnce ? (
        <div className="mb-3">
          <label className="block text-xs font-medium text-warm-500 mb-1.5">
            {t('schedule.runAtLabel')}
          </label>
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
            className="input-field text-sm font-mono"
            min={new Date().toISOString().slice(0, 16)}
          />
        </div>
      ) : (
        <div className="mb-3">
          <label className="block text-xs font-medium text-warm-500 mb-1.5">
            {t('schedule.cronExpression')}
          </label>
          <CronBuilder value={cronExpression} onChange={setCronExpression} />
        </div>
      )}

      {/* CLI Tool */}
      <div className="mb-3 grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-warm-500 mb-1.5">
            {t('scheduleForm.cliTool')}
          </label>
          <select
            value={cliTool}
            onChange={(e) => { setCliTool(e.target.value as CliTool); setCliModel(''); setCliEffort(''); setExecutionProfileId(''); }}
            className="input-field text-sm !py-2"
          >
            {CLI_TOOLS.map((tool) => (
              <option key={tool.value} value={tool.value}>{tool.label}</option>
            ))}
          </select>
        </div>
        {cliTool !== 'raw-shell' && <div><label className="block text-xs font-medium text-warm-500 mb-1.5">{t('profiles.configuration')}</label><select className="input-field text-sm !py-2" value={executionProfileId} onChange={(e) => setExecutionProfileId(e.target.value)}><option value="">{t('profiles.manual')}</option>{profiles.filter((p) => p.isEnabled || p.id === executionProfileId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.isEnabled ? '' : ` (${t('profiles.profileUnavailable')})`}</option>)}</select></div>}
        {cliTool !== 'raw-shell' && !executionProfileId && <div><label className="block text-xs font-medium text-warm-500 mb-1.5">{t('effort.model')}</label><select className="input-field text-sm !py-2" value={cliModel} onChange={(e) => setCliModel(e.target.value)}><option value="">{t('profiles.providerDefault')}</option>{visibleModels.map((model) => <option key={model.value} value={model.value}>{modelLabel(model)}</option>)}</select></div>}
        {cliTool !== 'raw-shell' && !executionProfileId && effort && <div><label className="block text-xs font-medium text-warm-500 mb-1.5">{t('effort.label')}</label><select className="input-field text-sm !py-2" value={cliEffort} onChange={(e) => setCliEffort(e.target.value)}><option value="">{t('profiles.providerDefault')}</option>{effort.values.map((value) => <option key={value} value={value}>{value}{value === cliEffort && effort.unsupportedSavedEffort ? ` (${t('effort.unsupported')})` : ''}</option>)}</select>{effort.unsupportedSavedEffort && <p className="mt-1 text-2xs text-status-warning">{t('effort.unsupportedWarning')}</p>}</div>}
      </div>

      {/* Skip if Running (only for recurring) */}
      {!isOnce && (
        <div className="mb-4">
          <label className="flex items-center gap-2 text-sm text-warm-600 cursor-pointer">
            <input
              type="checkbox"
              checked={skipIfRunning}
              onChange={(e) => setSkipIfRunning(e.target.checked)}
              className="rounded border-warm-300 text-accent focus:ring-accent"
            />
            {t('schedule.skipIfRunning')}
          </label>
        </div>
      )}

      <div className="flex gap-3 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="btn-ghost text-sm"
        >
          {t('scheduleForm.cancel')}
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn-primary text-sm"
        >
          {t('scheduleForm.save')}
        </button>
      </div>
    </form>
  );
}
