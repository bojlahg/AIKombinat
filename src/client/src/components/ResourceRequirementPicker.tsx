import { useEffect, useState } from 'react';
import { getResources } from '../api/resources';
import type { ResourceStatus } from '../types';
import { useI18n } from '../i18n';

interface ResourceRequirementPickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  className?: string;
}

export default function ResourceRequirementPicker({ value, onChange, className = '' }: ResourceRequirementPickerProps) {
  const [resources, setResources] = useState<ResourceStatus[]>([]);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    getResources().then((response) => {
      if (!cancelled) setResources(response.resources);
    }).catch(() => { /* form remains usable without optional requirements */ });
    return () => { cancelled = true; };
  }, []);

  const known = new Set(resources.map((resource) => resource.key));
  const unknown = value.filter((key) => !known.has(key as ResourceStatus['key']));

  return (
    <fieldset className={className}>
      <legend className="block text-xs font-medium text-warm-500 mb-1.5">{t('resources.label')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {resources.map((resource) => (
          <label key={resource.key} className="flex items-center gap-2 text-xs text-warm-600 cursor-pointer">
            <input
              type="checkbox"
              checked={value.includes(resource.key)}
              onChange={(event) => onChange(event.target.checked
                ? [...value, resource.key]
                : value.filter((key) => key !== resource.key))}
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
    </fieldset>
  );
}
