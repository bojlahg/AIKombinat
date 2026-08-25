import React, { useState } from 'react';
import type { Todo, TodoExecutionRound, ReviewResult, ReviewIssueSeverity, RoundPhase } from '../types';
import { useI18n } from '../i18n';
import {
  CheckCircle,
  AlertCircle,
  XCircle,
  Clock,
  RotateCcw,
  Square,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  FileCode,
  Loader2,
} from 'lucide-react';

interface ReviewTimelineProps {
  todo: Todo;
  rounds: TodoExecutionRound[];
  onApprove?: () => void;
  onRequestRework?: () => void;
  onStopLoop?: () => void;
  onRetryRound?: (round: TodoExecutionRound) => void;
  loadingAction?: string | null;
}

function parseResultPayload(raw: string | null): ReviewResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.verdict === 'approved' || parsed.verdict === 'needs_changes')) {
      return parsed as ReviewResult;
    }
  } catch { /* ignore */ }
  return null;
}

function getSeverityBadge(severity: ReviewIssueSeverity, t: (key: string) => string) {
  switch (severity) {
    case 'blocking':
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-900/40 text-red-300 border border-red-700/50">
          {t('review.pipeline.severity.blocking')}
        </span>
      );
    case 'major':
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-900/40 text-amber-300 border border-amber-700/50">
          {t('review.pipeline.severity.major')}
        </span>
      );
    case 'minor':
    default:
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-slate-800 text-slate-300 border border-slate-700">
          {t('review.pipeline.severity.minor')}
        </span>
      );
  }
}

function getRoundDisplayTitle(round: TodoExecutionRound, allRounds: TodoExecutionRound[], t: (key: string) => string): string {
  const sorted = [...allRounds].sort((a, b) => a.round_index - b.round_index);

  const getRoot = (r: TodoExecutionRound): TodoExecutionRound => {
    let curr = r;
    while (curr.retry_of_round_id) {
      const parent = sorted.find((p) => p.id === curr.retry_of_round_id);
      if (!parent || parent.id === curr.id) break;
      curr = parent;
    }
    return curr;
  };

  const attempt = round.attempt_index && round.attempt_index > 1 ? round.attempt_index : 1;
  const retrySuffix = attempt > 1 ? ` · ${t('review.pipeline.retryAttempt').replace('{attempt}', String(attempt))}` : '';

  if (round.phase === 'implementation') {
    return `${t('review.pipeline.phase.implementation')}${retrySuffix}`;
  }

  if (round.phase === 'review') {
    const root = getRoot(round);
    const rootReviewRounds = sorted.filter((r) => r.phase === 'review' && !r.retry_of_round_id && r.round_index <= root.round_index);
    const logicalNum = rootReviewRounds.length > 0 ? rootReviewRounds.length : 1;
    return `${t('review.pipeline.phase.review')} #${logicalNum}${retrySuffix}`;
  }

  if (round.phase === 'rework') {
    const root = getRoot(round);
    const rootReworkRounds = sorted.filter((r) => r.phase === 'rework' && !r.retry_of_round_id && r.round_index <= root.round_index);
    const logicalNum = rootReworkRounds.length > 0 ? rootReworkRounds.length : 1;
    return `${t('review.pipeline.phase.rework')} #${logicalNum}${retrySuffix}`;
  }

  return round.phase;
}

function getRetryButtonText(phase: RoundPhase, t: (key: string) => string): string {
  switch (phase) {
    case 'implementation':
      return t('review.pipeline.action.retryImplementation');
    case 'review':
      return t('review.pipeline.action.retryReview');
    case 'rework':
      return t('review.pipeline.action.retryRework');
    default:
      return t('review.pipeline.action.retryPhase');
  }
}

export default function ReviewTimeline({
  todo,
  rounds,
  onApprove,
  onRequestRework,
  onStopLoop,
  onRetryRound,
  loadingAction,
}: ReviewTimelineProps) {
  const { t } = useI18n();
  const [expandedIssues, setExpandedIssues] = useState<Record<string, boolean>>({});

  const toggleIssueExpand = (roundId: string) => {
    setExpandedIssues((prev) => ({ ...prev, [roundId]: !prev[roundId] }));
  };

  const sortedRounds = [...rounds].sort((a, b) => a.round_index - b.round_index);
  const activeRound = sortedRounds.find(
    (r) => ['running', 'waiting_executor', 'waiting_quota', 'waiting_resource', 'pending'].includes(r.status)
  );
  const latestRound = sortedRounds[sortedRounds.length - 1];

  const canApprove =
    onApprove &&
    (todo.status === 'failed' || todo.status === 'stopped' || (latestRound?.phase === 'review' && latestRound?.status === 'completed'));
  const canRequestRework =
    onRequestRework &&
    !activeRound &&
    latestRound?.phase === 'review' &&
    todo.status !== 'running';
  const canStop = onStopLoop && ['running', 'waiting_executor', 'waiting_resource'].includes(todo.status);
  const canRetryAnyRound = !activeRound && todo.status !== 'running' && todo.status !== 'waiting_executor' && todo.status !== 'waiting_resource' && Boolean(onRetryRound);

  return (
    <div className="space-y-4 text-xs font-sans text-slate-200">
      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-sm text-slate-100">{t('review.pipeline.title')}</span>
          {todo.pipeline_phase && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-300 border border-slate-700">
              {t(`review.pipeline.phase.${todo.pipeline_phase}`)}
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {canApprove && (
            <button
              onClick={onApprove}
              disabled={!!loadingAction}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium shadow-sm transition-colors cursor-pointer"
            >
              {loadingAction === 'approve' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle className="w-3.5 h-3.5" />
              )}
              {t('review.pipeline.action.approve')}
            </button>
          )}

          {canRequestRework && (
            <button
              onClick={onRequestRework}
              disabled={!!loadingAction}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium shadow-sm transition-colors cursor-pointer"
            >
              {loadingAction === 'rework' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              {t('review.pipeline.action.requestRework')}
            </button>
          )}

          {canStop && (
            <button
              onClick={onStopLoop}
              disabled={!!loadingAction}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-900/40 hover:bg-red-900/60 border border-red-700/50 disabled:opacity-50 text-red-300 font-medium transition-colors cursor-pointer"
            >
              {loadingAction === 'stop' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
              {t('review.pipeline.action.stopLoop')}
            </button>
          )}
        </div>
      </div>

      {/* Rounds List */}
      {sortedRounds.length === 0 ? (
        <div className="py-4 text-center text-slate-500 italic">
          {t('review.pipeline.emptyRounds')}
        </div>
      ) : (
        <div className="space-y-3">
          {sortedRounds.map((round) => {
            const result = parseResultPayload(round.result_payload);
            const isIssuesOpen = expandedIssues[round.id] ?? true;
            const roundTitle = getRoundDisplayTitle(round, sortedRounds, t);
            const isTerminalFailedOrStopped = round.status === 'failed' || round.status === 'stopped';
            const isLatest = latestRound?.id === round.id;
            const showRoundRetry = isTerminalFailedOrStopped && canRetryAnyRound && isLatest;

            return (
              <div
                key={round.id}
                className={`p-3 rounded-lg border transition-colors ${
                  round.status === 'running'
                    ? 'bg-slate-900/80 border-blue-600/50 ring-1 ring-blue-500/20'
                    : round.status === 'failed'
                    ? 'bg-slate-900/60 border-red-900/50'
                    : round.status === 'completed'
                    ? 'bg-slate-900/40 border-slate-800'
                    : 'bg-slate-900/20 border-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {round.status === 'running' ? (
                      <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                    ) : round.status === 'completed' ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    ) : round.status === 'failed' ? (
                      <XCircle className="w-4 h-4 text-red-400" />
                    ) : round.status === 'stopped' ? (
                      <Square className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Clock className="w-4 h-4 text-slate-500" />
                    )}

                    <span className="font-semibold text-slate-200 uppercase tracking-wide text-[11px]">
                      {roundTitle}
                    </span>

                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-medium uppercase ${
                        round.status === 'running'
                          ? 'bg-blue-900/40 text-blue-300 border border-blue-700/50'
                          : round.status === 'completed'
                          ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50'
                          : round.status === 'failed'
                          ? 'bg-red-900/40 text-red-300 border border-red-700/50'
                          : round.status === 'waiting_executor' || round.status === 'waiting_resource' || round.status === 'waiting_quota'
                          ? 'bg-amber-900/40 text-amber-300 border border-amber-700/50'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {round.status}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-slate-500">
                    <span>
                      {round.finished_at
                        ? new Date(round.finished_at).toLocaleTimeString()
                        : round.started_at
                        ? new Date(round.started_at).toLocaleTimeString()
                        : ''}
                    </span>
                    {showRoundRetry && (
                      <button
                        onClick={() => onRetryRound?.(round)}
                        disabled={!!loadingAction}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600/80 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium cursor-pointer transition-colors shadow-sm"
                      >
                        {loadingAction === `retry-${round.id}` ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3 h-3" />
                        )}
                        {getRetryButtonText(round.phase, t)}
                      </button>
                    )}
                  </div>
                </div>

                {/* Error message */}
                {round.error_message && (
                  <div className="mt-2 p-2 rounded bg-red-950/40 border border-red-900/50 text-red-300 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                    <span className="flex-1">{round.error_message}</span>
                  </div>
                )}

                {/* Structured Review Verdict & Summary */}
                {result && (
                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {result.verdict === 'approved' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-600/50 font-semibold text-xs">
                            <CheckCircle className="w-3.5 h-3.5" />
                            {t('review.pipeline.verdict.approved')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-600/50 font-semibold text-xs">
                            <AlertCircle className="w-3.5 h-3.5" />
                            {t('review.pipeline.verdict.needs_changes')}
                          </span>
                        )}
                      </div>

                      {result.issues && result.issues.length > 0 && (
                        <button
                          onClick={() => toggleIssueExpand(round.id)}
                          className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors text-[11px] cursor-pointer"
                        >
                          <span>{t('review.pipeline.issues').replace('{count}', String(result.issues.length))}</span>
                          {isIssuesOpen ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {result.summary && (
                      <p className="text-slate-300 text-xs leading-relaxed bg-slate-950/40 p-2 rounded border border-slate-800/50">
                        {result.summary}
                      </p>
                    )}

                    {/* Expandable Issues List */}
                    {result.issues && result.issues.length > 0 && isIssuesOpen && (
                      <div className="space-y-1.5 mt-2 pl-2 border-l-2 border-slate-800">
                        {result.issues.map((issue, idx) => (
                          <div
                            key={idx}
                            className="p-2 rounded bg-slate-950/60 border border-slate-800/80 space-y-1"
                          >
                            <div className="flex items-center gap-2">
                              {getSeverityBadge(issue.severity, t)}
                              <span className="text-slate-200 font-medium">{issue.description}</span>
                            </div>
                            {issue.files && issue.files.length > 0 && (
                              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 pl-1 pt-0.5">
                                <FileCode className="w-3 h-3 text-slate-500" />
                                <span className="font-mono text-slate-400">{issue.files.join(', ')}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
