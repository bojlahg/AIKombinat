import { useEffect, useState } from 'react';
import { getResources } from '../api/resources';
import type { ResourceStatus, ResourceRequirements, FabricRequirements, ResourceConstraints } from '../types';
import { useI18n } from '../i18n';

interface ResourceRequirementPickerProps {
  value: ResourceRequirements;
  onChange: (value: ResourceRequirements) => void;
  className?: string;
}

export default function ResourceRequirementPicker({ value, onChange, className = '' }: ResourceRequirementPickerProps) {
  const [resources, setResources] = useState<ResourceStatus[]>([]);
  const [nodes, setNodes] = useState<Array<{ id: string; name: string }>>([]);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    getResources().then((response) => {
      if (!cancelled) { setResources(response.resources); setNodes(response.nodes ?? []); }
    }).catch(() => { /* form remains usable without optional requirements */ });
    return () => { cancelled = true; };
  }, []);

  const legacy = Array.isArray(value) ? value : (value.requires.resources ?? []).flatMap(resource => resource.key ? [resource.key] : []);
  const known = new Set(resources.map((resource) => resource.key));
  const unknown = legacy.filter((key) => !known.has(key as ResourceStatus['key']));
  const fabric: FabricRequirements = Array.isArray(value) ? { version: 2, requires: { resources: value.map(key => ({ kind: 'custom', count: 1, key })) }, prefers: {} } : value;
  const update = (section: 'requires' | 'prefers', key: keyof ResourceConstraints, entry: unknown) => {
    const next = { ...fabric[section], [key]: entry }; if (entry === undefined) delete next[key];
    onChange({ ...fabric, [section]: next });
  };
  const setLegacy = (keys: string[]) => Array.isArray(value) ? onChange(keys) : update('requires', 'resources', [...(value.requires.resources ?? []).filter(resource => !resource.key), ...keys.map(key => ({ kind: 'custom', count: 1, key }))]);
  const gpu = fabric.requires.resources?.find(resource => resource.kind === 'gpu');
  const updateGpu = (patch: object) => update('requires', 'resources', [...(fabric.requires.resources ?? []).filter(resource => resource !== gpu), { kind: 'gpu', count: 1, same_node: true, ...gpu, ...patch }]);
  const numeric = (raw: string) => raw ? Number(raw) : undefined;

  return (
    <fieldset className={className}>
      <legend className="block text-xs font-medium text-warm-500 mb-1.5">{t('resources.label')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {resources.map((resource) => (
          <label key={resource.key} className="flex items-center gap-2 text-xs text-warm-600 cursor-pointer">
            <input
              type="checkbox"
              checked={legacy.includes(resource.key)}
              onChange={(event) => setLegacy(event.target.checked
                ? [...legacy, resource.key]
                : legacy.filter((key) => key !== resource.key))}
              className="rounded border-warm-300 text-accent focus:ring-accent"
            />
            <span>{resource.label}</span>
            {resource.available === 0 && <span className="text-status-warning">{t('resources.busy')}</span>}
          </label>
        ))}
        {unknown.map((key) => (
          <label key={key} className="flex items-center gap-2 text-xs text-status-warning">
            <input type="checkbox" checked readOnly className="rounded border-warm-300" />
            <span>{key} ({t('resources.unknown')})</span>
          </label>
        ))}
      </div>
      <details className="mt-3 text-xs text-theme-muted" open={!Array.isArray(value)}>
        <summary className="cursor-pointer text-accent">{t('fabric.requirements')}</summary>
        <div className="grid grid-cols-2 gap-3 mt-3">
          {(['os', 'distro', 'arch'] as const).map(field => <label key={field}>{t(`fabric.${field}`)}<input className="input w-full" value={fabric.requires.platform?.[field] ?? ''} onChange={event => update('requires', 'platform', { ...fabric.requires.platform, [field]: event.target.value || undefined })} /></label>)}
          <label>{t('fabric.gpuCount')}<input className="input w-full" type="number" min="0" max="64" value={gpu?.count ?? 0} onChange={event => Number(event.target.value) > 0 ? updateGpu({ count: Number(event.target.value) }) : update('requires', 'resources', fabric.requires.resources?.filter(resource => resource !== gpu))} /></label>
          <label>{t('fabric.gpuModel')}<input className="input w-full" value={gpu?.model ?? ''} onChange={event => updateGpu({ model: event.target.value || undefined })} /></label>
          <label>{t('fabric.minVram')}<input className="input w-full" type="number" min="0" value={gpu?.min_vram_bytes ? gpu.min_vram_bytes / 1024 ** 3 : ''} onChange={event => updateGpu({ min_vram_bytes: event.target.value ? Number(event.target.value) * 1024 ** 3 : undefined })} /></label>
          <label>{t('fabric.cpuThreads')}<input className="input w-full" type="number" min="0" value={fabric.requires.cpu?.threads ?? ''} onChange={event => update('requires', 'cpu', { ...fabric.requires.cpu, threads: numeric(event.target.value) })} /></label>
          <label>{t('fabric.physicalCores')}<input className="input w-full" type="number" min="0" value={fabric.requires.cpu?.min_physical_cores ?? ''} onChange={event => update('requires', 'cpu', { ...fabric.requires.cpu, min_physical_cores: numeric(event.target.value) })} /></label>
          <label>{t('fabric.memoryGb')}<input className="input w-full" type="number" min="0" value={fabric.requires.memory?.bytes ? fabric.requires.memory.bytes / 1024 ** 3 : ''} onChange={event => update('requires', 'memory', event.target.value ? { bytes: Number(event.target.value) * 1024 ** 3 } : undefined)} /></label>
          <label>{t('fabric.storageGb')}<input className="input w-full" type="number" min="0" value={fabric.requires.storage?.min_free_bytes ? fabric.requires.storage.min_free_bytes / 1024 ** 3 : ''} onChange={event => update('requires', 'storage', event.target.value ? { min_free_bytes: Number(event.target.value) * 1024 ** 3 } : undefined)} /></label>
          <label>{t('fabric.preferredNode')}<select className="input w-full" value={fabric.prefers.node_id ?? ''} onChange={event => update('prefers', 'node_id', event.target.value || undefined)}><option value="">{t('fabric.noPreference')}</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
          <label>{t('fabric.preferredGpu')}<input className="input w-full" value={fabric.prefers.resources?.[0]?.model ?? ''} onChange={event => update('prefers', 'resources', event.target.value ? [{ kind: 'gpu', count: 1, model: event.target.value }] : undefined)} /></label>
        </div>
        <p className="mt-2">{t('fabric.sameNode')}</p>
        <details className="mt-2"><summary>{t('fabric.json')}</summary><pre className="overflow-auto text-xs">{JSON.stringify(fabric, null, 2)}</pre></details>
      </details>
    </fieldset>
  );
}
