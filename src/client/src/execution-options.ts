export type AgentCliTool = 'claude' | 'codex' | 'antigravity';

export interface CatalogModel {
  id?: string;
  value: string;
  label: string;
  status?: 'available' | 'missing';
  source?: 'cli' | 'manual';
  supportedEfforts?: string[] | null;
  providerVariants?: Record<string, string> | null;
}

export const PROVIDER_EFFORT_FALLBACKS: Record<AgentCliTool, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['low', 'medium', 'high'],
};

export function visibleModelOptions(models: CatalogModel[], selectedValue?: string | null): CatalogModel[] {
  const selectable = models.filter((model) => model.value && model.status !== 'missing');
  if (!selectedValue) return selectable;
  const selected = models.find((model) => model.value === selectedValue);
  if (selected && !selectable.some((model) => model.value === selected.value)) return [selected, ...selectable];
  if (!selected) return [{ value: selectedValue, label: selectedValue, supportedEfforts: null }, ...selectable];
  return selectable;
}

export function modelOptionLabel(model: CatalogModel, labels: { unavailable: string; deprecated: string; unknown: string }): string {
  if (model.status === 'missing') return `${model.label} (${labels.unavailable})`;
  return model.label;
}

export function isGroupedAntigravityModel(cliTool: string, model?: CatalogModel | null): boolean {
  return cliTool === 'antigravity' && !!model?.providerVariants && Object.keys(model.providerVariants).length > 0;
}

export function effortOptions(
  cliTool: AgentCliTool,
  models: CatalogModel[],
  modelValue?: string | null,
  savedEffort?: string | null,
): {
  values: string[];
  unsupportedSavedEffort: boolean;
  capabilitiesKnown: boolean;
  isGrouped: boolean;
  allowProviderDefault: boolean;
  defaultEffort?: string;
} {
  const model = modelValue ? models.find((item) => item.value === modelValue) : undefined;
  const isGrouped = isGroupedAntigravityModel(cliTool, model);
  const capabilitiesKnown = !!modelValue && !!model && Array.isArray(model.supportedEfforts);
  const supported = capabilitiesKnown ? model!.supportedEfforts! : PROVIDER_EFFORT_FALLBACKS[cliTool];
  const unsupportedSavedEffort = !!savedEffort && capabilitiesKnown && !supported.includes(savedEffort);
  const values = savedEffort && !supported.includes(savedEffort) ? [savedEffort, ...supported] : [...supported];
  const allowProviderDefault = !isGrouped;
  const defaultEffort = isGrouped ? (supported[0] || 'medium') : undefined;
  return {
    values: [...new Set(values)],
    unsupportedSavedEffort,
    capabilitiesKnown,
    isGrouped,
    allowProviderDefault,
    defaultEffort,
  };
}
