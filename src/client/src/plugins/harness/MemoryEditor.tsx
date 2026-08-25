import { useState, useEffect, useMemo, useRef } from 'react';
import { Maximize2, Minimize2, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { useI18n } from '../../i18n';

interface MemoryEditorProps {
  filePath: string;
  content: string;
  saving: boolean;
  onSave: (next: string) => Promise<void>;
}

// Case-insensitive start offsets of every occurrence of needle in haystack.
export function findMatches(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const result: number[] = [];
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let at = lowerHaystack.indexOf(lowerNeedle);
  while (at !== -1) {
    result.push(at);
    at = lowerHaystack.indexOf(lowerNeedle, at + lowerNeedle.length);
  }
  return result;
}

// Editor for a CLI memory/instruction file (CLAUDE.md, CLAUDE.local.md,
// AGENTS.md, …). Titled by the actual file name, with an
// expand toggle so long files can be read without scrolling a tiny box.
// Ctrl+F opens an in-editor find bar (the browser's own find cannot search
// textarea content).
export default function MemoryEditor({ filePath, content, saving, onSave }: MemoryEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(content);
  const [expanded, setExpanded] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(content);
  }, [content]);

  const dirty = draft !== content;
  const fileName = filePath.split(/[\\/]/).pop() || filePath;

  const matches = useMemo(() => findMatches(draft, query), [draft, query]);
  // draft edits can shrink the match list under a stale index.
  const safeIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0;

  // Select the match in the textarea without stealing focus — Chromium paints
  // an inactive (gray) selection, so it stays visible while typing in the bar.
  const selectRange = (start: number, length: number) => {
    const el = textareaRef.current;
    if (!el) return;
    el.setSelectionRange(start, start + length);
    // ponytail: hard-line scroll estimate; soft-wrapped long lines land slightly off
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16;
    const line = draft.slice(0, start).split('\n').length - 1;
    el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 2);
  };

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => findInputRef.current?.select());
  };

  const closeFind = () => {
    setFindOpen(false);
    textareaRef.current?.focus();
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setMatchIndex(0);
    const found = findMatches(draft, value);
    if (found.length) selectRange(found[0], value.length);
  };

  const step = (delta: number) => {
    if (!matches.length) return;
    const next = (safeIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    selectRange(matches[next], query.length);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
    }
  };

  const handleFindKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  };

  return (
    <div className="space-y-3 p-4 border border-warm-200 rounded-xl" onKeyDown={handleEditorKeyDown}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-warm-700 font-mono">{fileName}</h4>
        <div className="flex items-center gap-2 min-w-0">
          <code className="text-[10px] text-warm-400 truncate" title={filePath}>{filePath}</code>
          <button
            type="button"
            onClick={openFind}
            className="p-1 text-warm-400 hover:text-warm-600 hover:bg-warm-100 rounded transition-colors flex-shrink-0"
            title={t('harness.find.open')}
          >
            <Search size={14} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-1 text-warm-400 hover:text-warm-600 hover:bg-warm-100 rounded transition-colors flex-shrink-0"
            title={expanded ? (t('harness.memory.collapse') || 'Collapse') : (t('harness.memory.expand') || 'Expand')}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {findOpen && (
        <div className="flex items-center gap-2 px-2 py-1.5 border border-warm-200 rounded-lg bg-warm-50">
          <Search size={13} className="text-warm-400 flex-shrink-0" />
          <input
            ref={findInputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleFindKeyDown}
            placeholder={t('harness.find.placeholder')}
            spellCheck={false}
            className="flex-1 min-w-0 text-xs bg-transparent text-warm-700 focus:outline-none"
          />
          <span className="text-[11px] text-warm-400 tabular-nums flex-shrink-0">
            {query ? `${matches.length ? safeIndex + 1 : 0}/${matches.length}` : ''}
          </span>
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={!matches.length}
            className="p-0.5 text-warm-400 hover:text-warm-600 disabled:opacity-40 rounded transition-colors"
            title={t('harness.find.prev')}
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={!matches.length}
            className="p-0.5 text-warm-400 hover:text-warm-600 disabled:opacity-40 rounded transition-colors"
            title={t('harness.find.next')}
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            onClick={closeFind}
            className="p-0.5 text-warm-400 hover:text-warm-600 rounded transition-colors"
            title={t('harness.find.close')}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('harness.memory.placeholder')}
        spellCheck={false}
        className={`w-full px-3 py-2 text-xs font-mono leading-relaxed border border-warm-200 rounded-lg bg-warm-50 text-warm-700 focus:ring-1 focus:ring-accent focus:border-accent resize-y ${
          expanded ? 'h-[75vh]' : 'h-96'
        }`}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => dirty && !saving && onSave(draft)}
          disabled={!dirty || saving}
          className="px-4 py-1.5 text-xs rounded-lg bg-accent text-white hover:bg-accent-dark disabled:opacity-50 transition-colors"
        >
          {saving ? t('harness.saving') : t('harness.save')}
        </button>
        {!dirty && <span className="text-xs text-warm-400">{t('harness.noChanges')}</span>}
      </div>
    </div>
  );
}
