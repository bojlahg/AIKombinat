import { useState, useEffect, useRef, useCallback } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { CliTool } from '../cli-tools';
import type { ImageMeta, MemoryInjectMode, Todo } from '../types';
import type { VaultInjectMode } from '../api/vault';
import { getTodoImageUrl } from '../api/todos';
import { getProfiles, type ExecutionProfile } from '../api/executionProfiles';
import ExecutionConfigurationPicker from './ExecutionConfigurationPicker';
import ResourceRequirementPicker from './ResourceRequirementPicker';

function parseRawFilePaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}
import VaultInjectControl from './VaultInjectControl';

export interface PendingImage {
  id: string;
  name: string;
  data: string; // base64 data URL
  preview: string;
}

interface TodoFormProps {
  onSave: (title: string, description: string, cliTool?: string, newImages?: PendingImage[], dependsOn?: string, maxTurns?: number, useWorktree?: number | null, memoryInjectMode?: MemoryInjectMode, memoryNodeIds?: string[], memoryRawFilePaths?: string[], cliModel?: string, cliEffort?: string | null, executionProfileId?: string | null, resourceRequirements?: string[], reviewEnabled?: number, reviewProfileId?: string | null, reworkProfileId?: string | null, maxReviewRounds?: number) => void;
  onCancel: () => void;
  initialTitle?: string;
  initialDescription?: string;
  initialCliTool?: string;
  initialCliModel?: string;
  initialCliEffort?: string | null;
  initialExecutionProfileId?: string | null;
  initialDependsOn?: string;
  initialMaxTurns?: number;
  initialUseWorktree?: number | null;
  initialMemoryInjectMode?: MemoryInjectMode;
  initialMemoryRawFilePaths?: string | null;
  initialResourceRequirements?: string | null;
  initialReviewEnabled?: number;
  initialReviewProfileId?: string | null;
  initialReworkProfileId?: string | null;
  initialMaxReviewRounds?: number;
  projectId?: string;
  projectCliTool?: string;
  projectIsGitRepo?: boolean;
  projectUseWorktree?: boolean;
  existingImages?: ImageMeta[];
  todoId?: string;
  onDeleteImage?: (imageId: string) => void;
  availableTodos?: Todo[];
}

let imageCounter = 0;

export default function TodoForm({
  onSave,
  onCancel,
  initialTitle = '',
  initialDescription = '',
  initialCliTool,
  initialCliModel,
  initialCliEffort,
  initialExecutionProfileId,
  initialDependsOn,
  initialMaxTurns,
  initialUseWorktree = null,
  initialMemoryInjectMode = 'none',
  initialMemoryRawFilePaths = null,
  initialResourceRequirements = null,
  initialReviewEnabled = 0,
  initialReviewProfileId = null,
  initialReworkProfileId = null,
  initialMaxReviewRounds = 3,
  projectId,
  projectCliTool = 'claude',
  projectIsGitRepo = false,
  projectUseWorktree = true,
  existingImages = [],
  todoId,
  onDeleteImage,
  availableTodos = [],
}: TodoFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [cliTool, setCliTool] = useState<CliTool>((initialCliTool as CliTool) || (projectCliTool as CliTool) || 'claude');
  const [cliModel, setCliModel] = useState(initialCliModel ?? '');
  const [cliEffort, setCliEffort] = useState(initialCliEffort ?? '');
  const [executionProfileId, setExecutionProfileId] = useState(initialExecutionProfileId ?? '');
  const [dependsOn, setDependsOn] = useState(initialDependsOn ?? '');
  const [maxTurns, setMaxTurns] = useState(initialMaxTurns?.toString() ?? '');
  const [useWorktreeMode, setUseWorktreeMode] = useState<'inherit' | 'force-on' | 'force-off'>(
    initialUseWorktree === 1 ? 'force-on' : initialUseWorktree === 0 ? 'force-off' : 'inherit'
  );
  const [memoryInjectMode, setMemoryInjectMode] = useState<MemoryInjectMode>(initialMemoryInjectMode);
  const [vaultPaths, setVaultPaths] = useState<string[]>(parseRawFilePaths(initialMemoryRawFilePaths));
  const [resourceRequirements, setResourceRequirements] = useState<string[]>(parseRawFilePaths(initialResourceRequirements));
  const [reviewEnabled, setReviewEnabled] = useState<boolean>(initialReviewEnabled === 1);
  const [reviewProfileId, setReviewProfileId] = useState<string>(initialReviewProfileId ?? '');
  const [reworkProfileId, setReworkProfileId] = useState<string>(initialReworkProfileId ?? '');
  const [maxReviewRounds, setMaxReviewRounds] = useState<number>(initialMaxReviewRounds ?? 3);
  const [availableProfiles, setAvailableProfiles] = useState<ExecutionProfile[]>([]);

  useEffect(() => {
    getProfiles(false).then(setAvailableProfiles).catch(() => {});
  }, []);
  const [includeLinked, setIncludeLinked] = useState<boolean>(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [existingImgs, setExistingImgs] = useState<ImageMeta[]>(existingImages);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  const addImagesFromFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result as string;
        const id = `pending-${++imageCounter}`;
        setPendingImages(prev => [...prev, {
          id,
          name: file.name,
          data,
          preview: data,
        }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageItems.push(items[i]);
      }
    }

    if (imageItems.length === 0) return;

    e.preventDefault();
    const files: File[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    addImagesFromFiles(files);
  }, [addImagesFromFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files) {
      addImagesFromFiles(e.dataTransfer.files);
    }
  }, [addImagesFromFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const removePendingImage = (id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  };

  const removeExistingImage = (imageId: string) => {
    if (onDeleteImage) {
      onDeleteImage(imageId);
    }
    setExistingImgs(prev => prev.filter(img => img.id !== imageId));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const parsedMaxTurns = maxTurns ? parseInt(maxTurns, 10) : undefined;
    const useWorktreeValue: number | null = useWorktreeMode === 'force-on' ? 1 : useWorktreeMode === 'force-off' ? 0 : null;
    onSave(title.trim(), description.trim(), cliTool, pendingImages.length > 0 ? pendingImages : undefined, dependsOn || undefined, parsedMaxTurns || undefined, useWorktreeValue, memoryInjectMode, [], vaultPaths, executionProfileId ? undefined : cliModel || undefined, executionProfileId ? null : cliEffort || null, executionProfileId || null, resourceRequirements, reviewEnabled ? 1 : 0, reviewProfileId || null, reworkProfileId || null, maxReviewRounds);
  };

  const totalImages = existingImgs.length + pendingImages.length;

  return (
    <form onSubmit={handleSubmit} className="card p-5 border-accent/30">
      <div className="mb-3">
        <input
          type="text"
          placeholder={t('todoForm.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input-field"
          autoFocus
        />
      </div>
      <div className="mb-4">
        <textarea
          ref={textareaRef}
          placeholder={t('todoForm.descPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          rows={3}
          className="input-field min-h-[76px] max-h-[320px] resize-y [field-sizing:content]"
        />
        <div className="flex items-center gap-2 mt-1.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium text-warm-400 hover:text-warm-600 hover:bg-warm-100 transition-colors"
          >
            <ImageIcon size={14} />
            {t('todoForm.addImage')}
          </button>
          <span className="text-2xs text-warm-300">
            {t('todoForm.pasteHint')}
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImagesFromFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* Image previews */}
      {totalImages > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-xs font-semibold text-warm-500 uppercase tracking-wider">
              {t('todoForm.images')}
            </h4>
            <span className="text-2xs text-warm-400">({totalImages})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Existing images (already uploaded) */}
            {existingImgs.map(img => (
              <div key={img.id} className="relative group">
                <img
                  src={todoId ? getTodoImageUrl(todoId, img.id) : ''}
                  alt={img.originalName}
                  className="h-20 w-20 object-cover rounded-lg border border-warm-200"
                />
                <button
                  type="button"
                  onClick={() => removeExistingImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-status-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 rounded-b-lg px-1 py-0.5">
                  <span className="text-[8px] text-white truncate block">{img.originalName}</span>
                </div>
              </div>
            ))}
            {/* Pending images (not yet uploaded) */}
            {pendingImages.map(img => (
              <div key={img.id} className="relative group">
                <img
                  src={img.preview}
                  alt={img.name}
                  className="h-20 w-20 object-cover rounded-lg border border-accent/30"
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-status-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 rounded-b-lg px-1 py-0.5">
                  <span className="text-[8px] text-white truncate block">{img.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execution Configuration */}
      <ExecutionConfigurationPicker
        executionProfileId={executionProfileId || null}
        cliTool={cliTool}
        cliModel={cliModel}
        cliEffort={cliEffort}
        onChange={(val) => {
          setCliTool(val.cliTool as CliTool);
          setCliModel(val.cliModel);
          setCliEffort(val.cliEffort ?? '');
          setExecutionProfileId(val.executionProfileId ?? '');
        }}
        className="mb-4"
      />

      <ResourceRequirementPicker value={resourceRequirements} onChange={setResourceRequirements} className="mb-4" />

      {/* Max Turns */}
      {!executionProfileId && cliTool === 'claude' && (
        <div className="mb-4">
          <label className="block text-xs font-medium text-warm-500 mb-1.5">
            {t('todoForm.maxTurns')}
          </label>
          <input
            type="number"
            min="1"
            max="500"
            placeholder={t('todoForm.maxTurnsPlaceholder')}
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            className="input-field text-sm w-32"
          />
          <p className="text-2xs text-warm-400 mt-1">
            {t('todoForm.maxTurnsHint')}
          </p>
        </div>
      )}

      {/* Worktree override (git repos only) */}
      {projectIsGitRepo && (
        <div className="mb-4">
          <label className="block text-xs font-medium text-warm-500 mb-1.5">
            {t('todoForm.worktreeMode')}
          </label>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="useWorktreeMode"
                checked={useWorktreeMode === 'inherit'}
                onChange={() => setUseWorktreeMode('inherit')}
              />
              <span>
                {t('todoForm.worktreeInherit')}
                <span className="text-2xs text-warm-400 ml-1">
                  ({projectUseWorktree ? t('todoForm.worktreeProjectDefaultOn') : t('todoForm.worktreeProjectDefaultOff')})
                </span>
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="useWorktreeMode"
                checked={useWorktreeMode === 'force-on'}
                onChange={() => setUseWorktreeMode('force-on')}
              />
              <span>{t('todoForm.worktreeForceOn')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="useWorktreeMode"
                checked={useWorktreeMode === 'force-off'}
                onChange={() => setUseWorktreeMode('force-off')}
              />
              <span>{t('todoForm.worktreeForceOff')}</span>
            </label>
          </div>
          {(useWorktreeMode === 'force-off' || (useWorktreeMode === 'inherit' && !projectUseWorktree)) && (
            <p className="text-2xs text-status-warning mt-1.5">
              {t('todoForm.worktreeMainWarning')}
            </p>
          )}
        </div>
      )}

      {/* Dependency Selection */}
      {availableTodos.length > 0 && (
        <div className="mb-4">
          <label className="block text-xs font-medium text-warm-500 mb-1.5">
            {t('todoForm.dependsOn')}
          </label>
          <select
            value={dependsOn}
            onChange={(e) => setDependsOn(e.target.value)}
            className="input-field text-sm"
          >
            <option value="">{t('todoForm.noDependency')}</option>
            {availableTodos.map((todo) => (
              <option key={todo.id} value={todo.id}>
                {todo.title} ({t(`status.${todo.status}` as 'status.pending')})
              </option>
            ))}
          </select>
          {dependsOn && (
            <p className="text-2xs text-warm-400 mt-1">
              {t('todoForm.dependsOnHint')}
            </p>
          )}
        </div>
      )}

      {projectId && (
        <div className="mb-4">
          <VaultInjectControl
            projectId={projectId}
            mode={memoryInjectMode as VaultInjectMode}
            selectedPaths={vaultPaths}
            includeLinked={includeLinked}
            onChange={(m, paths, linked) => {
              setMemoryInjectMode(m as MemoryInjectMode);
              setVaultPaths(paths);
              setIncludeLinked(linked);
            }}
          />
        </div>
      )}

      {/* Review & Rework Pipeline Configuration */}
      <div className="mb-4 p-3 rounded-lg border border-theme-border bg-theme-card/30">
        <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-warm-700">
          <input
            type="checkbox"
            checked={reviewEnabled}
            onChange={(e) => setReviewEnabled(e.target.checked)}
            className="rounded border-warm-300 text-accent focus:ring-accent"
          />
          <span>{t('review.pipeline.enable')}</span>
        </label>
        <p className="text-2xs text-warm-400 mt-1 pl-6">
          {t('review.pipeline.enableHelp')}
        </p>

        {reviewEnabled && (
          <div className="mt-3 pl-6 space-y-3 pt-2 border-t border-theme-border/60">
            <div>
              <label className="block text-xs font-medium text-warm-500 mb-1">
                {t('review.pipeline.reviewProfile')}
              </label>
              <select
                value={reviewProfileId}
                onChange={(e) => setReviewProfileId(e.target.value)}
                className="input-field text-sm w-full"
              >
                <option value="">{t('todoForm.worktreeInherit')} ({t('review.pipeline.projectDefaultProfile')})</option>
                {availableProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-warm-400 mt-0.5">
                {t('review.pipeline.reviewProfileHelp')}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-warm-500 mb-1">
                {t('review.pipeline.reworkProfile')}
              </label>
              <select
                value={reworkProfileId}
                onChange={(e) => setReworkProfileId(e.target.value)}
                className="input-field text-sm w-full"
              >
                <option value="">{t('todoForm.worktreeInherit')} ({t('review.pipeline.phase.implementation')})</option>
                {availableProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-warm-400 mt-0.5">
                {t('review.pipeline.reworkProfileHelp')}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-warm-500 mb-1">
                {t('review.pipeline.maxRounds')}
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={maxReviewRounds}
                onChange={(e) => setMaxReviewRounds(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                className="input-field text-sm w-24"
              />
              <p className="text-2xs text-warm-400 mt-0.5">
                {t('review.pipeline.maxRoundsHelp')}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-3 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="btn-ghost text-sm"
        >
          {t('todoForm.cancel')}
        </button>
        <button
          type="submit"
          disabled={!title.trim()}
          className="btn-primary text-sm"
        >
          {t('todoForm.save')}
        </button>
      </div>
    </form>
  );
}
