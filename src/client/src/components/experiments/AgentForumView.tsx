import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  MessageSquare,
  Users,
  Plus,
  Trash2,
  Edit2,
  Play,
  Square,
  CornerDownRight,
  GitBranch,
  List,
  Sliders,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Loader2,
  AlertTriangle,
  X,
  Sparkles,
} from 'lucide-react';
import type { AgentForum, AgentForumDetail, AgentForumMessage, AgentForumMember, Project } from '../../types';
import { DEFAULT_AGENT_FORUM_RULES } from '../../types';
import type { WsEvent } from '../../hooks/useWebSocket';
import * as forumsApi from '../../api/agentForums';
import * as projectsApi from '../../api/projects';
import { useI18n } from '../../i18n';
import { useToast } from '../../hooks/useToast';
import { Skeleton } from '../Skeleton';
import Modal from '../Modal';
import ExecutionConfigurationPicker from '../ExecutionConfigurationPicker';
import MarkdownContent from '../MarkdownContent';
import IconButton from '../IconButton';
import type { CliTool } from '../../cli-tools';

interface AgentForumViewProps {
  onEvent: (cb: (event: WsEvent) => void) => () => void;
  connected: boolean;
}

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

// AgentForum is a forum of equal peers. The defaults deliberately assign nobody
// the reviewer/critic/judge seat — the forum rules already require every
// participant to object or add independently when there is something to say.
// Users remain free to configure custom roles per participant.
const NEUTRAL_PEER_ROLE = 'participant';

const DEFAULT_MEMBERS = [
  {
    name: 'Claude',
    role: NEUTRAL_PEER_ROLE,
    system_prompt: 'You are an equal participant in this discussion. Contribute where you can add value, and disagree when you disagree.',
    cli_tool: 'claude',
    avatar_color: '#8b5cf6',
  },
  {
    name: 'Codex',
    role: NEUTRAL_PEER_ROLE,
    system_prompt: 'You are an equal participant in this discussion. Contribute where you can add value, and disagree when you disagree.',
    cli_tool: 'codex',
    avatar_color: '#10b981',
  },
  {
    name: 'Antigravity',
    role: NEUTRAL_PEER_ROLE,
    system_prompt: 'You are an equal participant in this discussion. Contribute where you can add value, and disagree when you disagree.',
    cli_tool: 'antigravity',
    avatar_color: '#f97316',
  },
];

export default function AgentForumView({ onEvent, connected }: AgentForumViewProps) {
  const { forumId } = useParams<{ forumId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { error: toastError, success: toastSuccess } = useToast();

  const [forumList, setForumList] = useState<AgentForum[]>([]);
  const [currentForum, setCurrentForum] = useState<AgentForumDetail | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'chat' | 'tree'>('chat');

  // Input & Reply state
  const [userInput, setUserInput] = useState('');
  const [replyTarget, setReplyTarget] = useState<AgentForumMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Top Bar Edit States
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [rulesDraft, setRulesDraft] = useState('');
  const [showNewForumModal, setShowNewForumModal] = useState(false);
  const [newForumTitle, setNewForumTitle] = useState('');
  const [newForumProject, setNewForumProject] = useState<string>('');

  // Member Modal
  const [showMemberModal, setShowMemberModal] = useState(false);
  const [editingMember, setEditingMember] = useState<AgentForumMember | null>(null);
  const [memberName, setMemberName] = useState('');
  const [memberRole, setMemberRole] = useState(NEUTRAL_PEER_ROLE);
  const [memberPrompt, setMemberPrompt] = useState('');
  const [memberCliTool, setMemberCliTool] = useState<CliTool | ''>('claude');
  const [memberCliModel, setMemberCliModel] = useState('');
  const [memberCliEffort, setMemberCliEffort] = useState('');
  const [memberProfileId, setMemberProfileId] = useState('');
  const [memberColor, setMemberColor] = useState(AVATAR_COLORS[0]);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load forums & projects
  const refreshForums = useCallback(async () => {
    try {
      const list = await forumsApi.listAgentForums();
      setForumList(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    projectsApi.getProjects().then(setProjects).catch(() => {});
    refreshForums().then((list) => {
      if (forumId) {
        loadForumDetail(forumId);
      } else if (list.length > 0) {
        navigate(`/experiments/agent-forum/${list[0].id}`, { replace: true });
      } else {
        setLoading(false);
      }
    });
  }, [forumId, refreshForums, navigate]);

  const loadForumDetail = async (id: string) => {
    setLoading(true);
    try {
      const detail = await forumsApi.getAgentForum(id);
      setCurrentForum(detail);
      setRulesDraft(detail.rules);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('forum.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // WebSocket event subscriptions
  useEffect(() => {
    return onEvent((event: WsEvent) => {
      const e = event as unknown as Record<string, unknown>;
      if (!currentForum) return;

      if (e.type === 'forum:status-changed' && e.forumId === currentForum.id) {
        setCurrentForum((prev) => prev ? {
          ...prev,
          status: e.status as 'idle' | 'running' | 'error',
          current_cycle: typeof e.currentCycle === 'number' ? e.currentCycle : prev.current_cycle,
          current_member_id: (e.currentMemberId as string | null) ?? null,
        } : prev);
      }

      if (e.type === 'forum:message-created' && e.forumId === currentForum.id && e.message) {
        const newMsg = e.message as AgentForumMessage;
        setCurrentForum((prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === newMsg.id)) return prev;
          return {
            ...prev,
            messages: [...prev.messages, newMsg],
          };
        });
      }

      if (e.type === 'forum:turn-started' && e.forumId === currentForum.id) {
        forumsApi.getAgentForum(currentForum.id).then(setCurrentForum).catch(() => {});
      }

      if ((e.type === 'forum:turn-completed' || e.type === 'forum:turn-failed' || e.type === 'forum:turn-skipped') && e.forumId === currentForum.id) {
        forumsApi.getAgentForum(currentForum.id).then(setCurrentForum).catch(() => {});
      }
    });
  }, [onEvent, currentForum]);

  // Auto-scroll chat
  useEffect(() => {
    if (viewMode === 'chat' && typeof chatBottomRef.current?.scrollIntoView === 'function') {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentForum?.messages, viewMode]);

  // Create new forum
  const handleCreateForum = async () => {
    if (!newForumTitle.trim()) return;
    try {
      const created = await forumsApi.createAgentForum({
        title: newForumTitle.trim(),
        project_id: newForumProject || null,
        members: DEFAULT_MEMBERS,
      });
      setShowNewForumModal(false);
      setNewForumTitle('');
      setNewForumProject('');
      await refreshForums();
      navigate(`/experiments/agent-forum/${created.id}`);
      toastSuccess(t('forum.created'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('forum.createFailed'));
    }
  };

  // Delete forum
  const handleDeleteForum = async () => {
    if (!currentForum) return;
    if (!confirm(t('forum.deleteConfirm'))) return;
    try {
      await forumsApi.deleteAgentForum(currentForum.id);
      const list = await refreshForums();
      if (list.length > 0) {
        navigate(`/experiments/agent-forum/${list[0].id}`);
      } else {
        setCurrentForum(null);
        navigate('/experiments/agent-forum');
      }
      toastSuccess(t('forum.deleted'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('forum.deleteFailed'));
    }
  };

  // Send message
  const handleSendMessage = async () => {
    if (!currentForum || !userInput.trim() || submitting || skipping || currentForum.status !== 'idle') return;
    setSubmitting(true);
    try {
      await forumsApi.postUserMessage(currentForum.id, {
        content: userInput.trim(),
        parent_message_id: replyTarget?.id ?? null,
      });
      setUserInput('');
      setReplyTarget(null);
      // Refresh forum details
      const updated = await forumsApi.getAgentForum(currentForum.id);
      setCurrentForum(updated);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('forum.sendFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Skip the user's turn: no message is posted, the agents just run another
  // cycle over the history they already have. The draft is deliberately left
  // untouched so the user can still send it later.
  const handleSkipTurn = async () => {
    if (!currentForum || submitting || skipping || currentForum.status !== 'idle') return;
    setSkipping(true);
    try {
      await forumsApi.continueAgentForum(currentForum.id);
      const updated = await forumsApi.getAgentForum(currentForum.id);
      setCurrentForum(updated);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('forum.skipFailed'));
    } finally {
      setSkipping(false);
    }
  };

  // Stop the forum cycle. Doubles as "Retry Stop" for a forum parked in `error`:
  // the backend treats a repeated Stop as a retry of the unfinished cleanup, and
  // answers 503 while it still cannot confirm the previous cycle is gone.
  const handleStopCycle = async () => {
    if (!currentForum || stopping) return;
    setStopping(true);
    try {
      await forumsApi.stopAgentForum(currentForum.id);
      const updated = await forumsApi.getAgentForum(currentForum.id);
      setCurrentForum(updated);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to stop forum');
      // Refresh anyway so the banner reflects the server's current state; the
      // forum stays in `error` and the retry button stays available.
      try {
        setCurrentForum(await forumsApi.getAgentForum(currentForum.id));
      } catch { /* keep the last known state */ }
    } finally {
      setStopping(false);
    }
  };

  // Update Max Reply Length
  const handleMaxReplyLengthChange = async (len: number) => {
    if (!currentForum || currentForum.status !== 'idle') return;
    try {
      const updated = await forumsApi.updateAgentForum(currentForum.id, { max_reply_length: len });
      setCurrentForum(updated);
      toastSuccess(`${t('forum.maxReplyLength')}: ${len}`);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to update length');
    }
  };

  // Update Project Link
  const handleProjectLinkChange = async (projectId: string) => {
    if (!currentForum || currentForum.status !== 'idle') return;
    try {
      const updated = await forumsApi.updateAgentForum(currentForum.id, { project_id: projectId || null });
      setCurrentForum(updated);
      toastSuccess(projectId ? t('forum.projectLinked') : t('forum.standaloneMode'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to update project link');
    }
  };

  // Save Rules
  const handleSaveRules = async () => {
    if (!currentForum || currentForum.status !== 'idle') return;
    try {
      const updated = await forumsApi.updateAgentForum(currentForum.id, { rules: rulesDraft });
      setCurrentForum(updated);
      setShowRulesModal(false);
      toastSuccess(t('forum.rulesSaved'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to save rules');
    }
  };

  // Member management
  const handleOpenAddMember = () => {
    setEditingMember(null);
    setMemberName('');
    setMemberRole(NEUTRAL_PEER_ROLE);
    setMemberPrompt('');
    setMemberCliTool('claude');
    setMemberCliModel('');
    setMemberCliEffort('');
    setMemberProfileId('');
    setMemberColor(AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
    setShowMemberModal(true);
  };

  const handleOpenEditMember = (m: AgentForumMember) => {
    setEditingMember(m);
    setMemberName(m.name);
    setMemberRole(m.role);
    setMemberPrompt(m.system_prompt);
    setMemberCliTool((m.cli_tool as CliTool) || '');
    setMemberCliModel(m.cli_model || '');
    setMemberCliEffort(m.cli_effort || '');
    setMemberProfileId(m.execution_profile_id || '');
    setMemberColor(m.avatar_color || AVATAR_COLORS[0]);
    setShowMemberModal(true);
  };

  const handleSaveMember = async () => {
    if (!currentForum || !memberName.trim() || currentForum.status !== 'idle') return;
    try {
      if (editingMember) {
        await forumsApi.updateAgentForumMember(currentForum.id, editingMember.id, {
          name: memberName.trim(),
          role: memberRole.trim(),
          system_prompt: memberPrompt.trim(),
          cli_tool: memberProfileId ? null : (memberCliTool || null),
          cli_model: memberProfileId ? null : (memberCliModel || null),
          cli_effort: memberProfileId ? null : (memberCliEffort || null),
          execution_profile_id: memberProfileId || null,
          avatar_color: memberColor,
        });
      } else {
        await forumsApi.addAgentForumMember(currentForum.id, {
          name: memberName.trim(),
          role: memberRole.trim(),
          system_prompt: memberPrompt.trim(),
          cli_tool: memberProfileId ? null : (memberCliTool || null),
          cli_model: memberProfileId ? null : (memberCliModel || null),
          cli_effort: memberProfileId ? null : (memberCliEffort || null),
          execution_profile_id: memberProfileId || null,
          avatar_color: memberColor,
        });
      }
      const updated = await forumsApi.getAgentForum(currentForum.id);
      setCurrentForum(updated);
      setShowMemberModal(false);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to save participant');
    }
  };

  const handleDeleteMember = async (memberId: string) => {
    if (!currentForum || currentForum.status !== 'idle') return;
    if (currentForum.members.filter((m) => m.is_active !== 0).length <= 2) {
      toastError(t('forum.minMembersWarning'));
      return;
    }
    try {
      await forumsApi.deleteAgentForumMember(currentForum.id, memberId);
      const updated = await forumsApi.getAgentForum(currentForum.id);
      setCurrentForum(updated);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  // Map for message lookups
  const messageMap = useMemo(() => {
    const map = new Map<string, AgentForumMessage>();
    currentForum?.messages.forEach((m) => map.set(m.id, m));
    return map;
  }, [currentForum?.messages]);

  // Tree nodes computation
  const treeRoots = useMemo(() => {
    const childrenMap = new Map<string, AgentForumMessage[]>();
    const roots: AgentForumMessage[] = [];
    if (!currentForum) return { roots, childrenMap };

    for (const msg of currentForum.messages) {
      if (!msg.parent_message_id) {
        roots.push(msg);
      } else {
        const arr = childrenMap.get(msg.parent_message_id) || [];
        arr.push(msg);
        childrenMap.set(msg.parent_message_id, arr);
      }
    }
    return { roots, childrenMap };
  }, [currentForum]);

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (!currentForum && forumList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-6 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center text-accent">
          <Sparkles size={32} />
        </div>
        <h2 className="text-xl font-bold text-theme-text">{t('forum.welcomeTitle')}</h2>
        <p className="text-sm text-theme-text-secondary max-w-md">
          {t('forum.welcomeDescription')}
        </p>
        <button
          onClick={() => setShowNewForumModal(true)}
          className="btn-primary flex items-center gap-2 px-4 py-2"
        >
          <Plus size={16} />
          {t('forum.newForum')}
        </button>

        {showNewForumModal && (
          <Modal open onClose={() => setShowNewForumModal(false)} size="md">
            <div className="p-5 space-y-4">
              <h3 className="text-base font-semibold text-theme-text">{t('forum.createNewTitle')}</h3>
              <div>
                <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                  {t('forum.titleLabel')}
                </label>
                <input
                  type="text"
                  value={newForumTitle}
                  onChange={(e) => setNewForumTitle(e.target.value)}
                  placeholder={t('forum.titlePlaceholder')}
                  className="input-field w-full"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                  {t('forum.projectContextLabel')}
                </label>
                <select
                  value={newForumProject}
                  onChange={(e) => setNewForumProject(e.target.value)}
                  className="input-field w-full"
                >
                  <option value="">{t('forum.standaloneOption')}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowNewForumModal(false)}
                  className="btn text-xs"
                >
                  {t('header.cancel')}
                </button>
                <button
                  onClick={handleCreateForum}
                  disabled={!newForumTitle.trim()}
                  className="btn-primary text-xs"
                >
                  {t('header.save')}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  const isRunning = currentForum?.status === 'running';
  // `error` means the previous cycle was never confirmed stopped (drain timeout
  // or an orphan process startup recovery could not kill). The backend rejects
  // every mutation until cleanup succeeds, so the UI must not offer them.
  const needsRecovery = currentForum?.status === 'error';
  const isLocked = isRunning || needsRecovery;
  // Removal is gated on ACTIVE participants: soft-disabled members still show in
  // the bar (their history is intact) but no longer count towards the quorum.
  const activeMemberCount = currentForum?.members.filter((m) => m.is_active !== 0).length ?? 0;
  const currentSpeakingMember = currentForum?.members.find((m) => m.id === currentForum.current_member_id);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] md:h-screen max-w-6xl mx-auto p-3 sm:p-5">
      {/* ── TOP CONTROL PANEL (Single screen local settings) ── */}
      <div className="glass-card rounded-2xl p-4 mb-3 border border-theme-border shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Forum Switcher & Title */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-theme-bg/60 border border-theme-border px-3 py-1.5 rounded-xl">
              <MessageSquare size={16} className="text-accent" />
              <select
                value={currentForum?.id || ''}
                onChange={(e) => navigate(`/experiments/agent-forum/${e.target.value}`)}
                className="bg-transparent text-sm font-semibold text-theme-text border-none outline-none cursor-pointer"
              >
                {forumList.map((f) => (
                  <option key={f.id} value={f.id}>{f.title}</option>
                ))}
              </select>
            </div>

            <IconButton
              onClick={() => setShowNewForumModal(true)}
              label={t('forum.newForum')}
              size="sm"
            >
              <Plus size={15} />
            </IconButton>

            <IconButton
              onClick={handleDeleteForum}
              label={t('forum.deleteForum')}
              size="sm"
              variant="danger"
            >
              <Trash2 size={15} />
            </IconButton>
          </div>

          {/* Project Context selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-theme-text-muted">{t('forum.context')}:</span>
            <select
              value={currentForum?.project_id || ''}
              onChange={(e) => handleProjectLinkChange(e.target.value)}
              disabled={isLocked}
              className="text-xs bg-theme-bg/60 border border-theme-border rounded-lg px-2.5 py-1 text-theme-text outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">{t('forum.standaloneOption')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Max Reply Length & Rules & View mode */}
          <div className="flex items-center gap-2">
            {/* Max chars selector */}
            <div className="flex items-center gap-1.5 bg-theme-bg/60 border border-theme-border px-2.5 py-1 rounded-lg text-xs">
              <span className="text-theme-text-muted">{t('forum.maxLen')}:</span>
              {[256, 512, 1024, 2048].map((len) => (
                <button
                  key={len}
                  onClick={() => handleMaxReplyLengthChange(len)}
                  disabled={isLocked}
                  className={`px-1.5 py-0.5 rounded text-2xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    currentForum?.max_reply_length === len
                      ? 'bg-accent text-white font-semibold'
                      : 'text-theme-text-secondary hover:bg-theme-hover'
                  }`}
                >
                  {len}
                </button>
              ))}
            </div>

            {/* Rules button */}
            <button
              onClick={() => setShowRulesModal(true)}
              disabled={isLocked}
              className="flex items-center gap-1.5 text-xs bg-theme-bg/60 hover:bg-theme-hover border border-theme-border px-2.5 py-1 rounded-lg text-theme-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sliders size={13} />
              {t('forum.rules')}
            </button>

            {/* Chat vs Tree toggle */}
            <div className="flex items-center bg-theme-bg/60 border border-theme-border rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('chat')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                  viewMode === 'chat'
                    ? 'bg-theme-hover text-theme-text font-semibold shadow-xs'
                    : 'text-theme-text-muted hover:text-theme-text'
                }`}
                title={t('forum.chatView')}
              >
                <List size={13} />
                {t('forum.chat')}
              </button>
              <button
                onClick={() => setViewMode('tree')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                  viewMode === 'tree'
                    ? 'bg-theme-hover text-theme-text font-semibold shadow-xs'
                    : 'text-theme-text-muted hover:text-theme-text'
                }`}
                title={t('forum.treeView')}
              >
                <GitBranch size={13} />
                {t('forum.tree')}
              </button>
            </div>
          </div>
        </div>

        {/* Participants bar */}
        <div className="flex items-center justify-between pt-2 border-t border-theme-border/50 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-theme-text-muted flex items-center gap-1">
              <Users size={14} />
              {t('forum.participants')}:
            </span>
            {currentForum?.members.map((m) => (
              <div
                key={m.id}
                onClick={() => { if (!isLocked) handleOpenEditMember(m); }}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg bg-theme-bg/80 border border-theme-border transition-colors ${
                  isLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-accent'
                } ${m.is_active === 0 ? 'opacity-50 line-through' : ''} ${
                  currentForum.current_member_id === m.id ? 'ring-2 ring-accent ring-offset-1 animate-pulse' : ''
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: m.avatar_color || '#6366f1' }}
                />
                <span className="font-medium text-theme-text">{m.name}</span>
                <span className="text-2xs text-theme-text-muted">({m.role})</span>
              </div>
            ))}
            <button
              onClick={handleOpenAddMember}
              disabled={isLocked}
              className="flex items-center gap-1 text-2xs px-2 py-1 rounded-lg border border-dashed border-theme-border hover:border-accent text-theme-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus size={11} />
              {t('forum.addParticipant')}
            </button>
          </div>

          {isRunning && (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs text-status-success font-medium">
                <Loader2 size={13} className="animate-spin" />
                {currentSpeakingMember
                  ? t('forum.agentSpeaking').replace('{name}', currentSpeakingMember.name)
                  : t('forum.cycleRunning')}
              </span>
              <button
                onClick={handleStopCycle}
                className="btn-danger text-2xs py-0.5 px-2 flex items-center gap-1"
              >
                <Square size={10} />
                {t('discussions.pause')}
              </button>
            </div>
          )}

          {needsRecovery && (
            <div className="flex items-center gap-2">
              <span
                className="flex items-center gap-1.5 text-xs text-status-error font-medium"
                title={t('forum.recoveryHint')}
              >
                <AlertTriangle size={13} />
                {t('forum.recoveryRequired')}
              </span>
              <button
                onClick={handleStopCycle}
                disabled={stopping}
                className="btn-danger text-2xs py-0.5 px-2 flex items-center gap-1 disabled:opacity-50"
              >
                {stopping ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                {t('forum.retryStop')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── MAIN CONVERSATION / TREE AREA ── */}
      <div className="flex-1 overflow-y-auto rounded-2xl bg-theme-card/70 border border-theme-border p-4 space-y-3 mb-3">
        {currentForum && currentForum.messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-theme-text-secondary py-12 space-y-2">
            <MessageSquare size={36} className="text-theme-text-muted opacity-50" />
            <p className="text-sm">{t('forum.noMessagesYet')}</p>
            <p className="text-xs text-theme-text-muted">{t('forum.noMessagesHint')}</p>
          </div>
        )}

        {/* Chat View */}
        {viewMode === 'chat' && currentForum && currentForum.messages.map((msg) => {
          const isUser = msg.author_type === 'user';
          const member = msg.author_id ? currentForum.members.find((m) => m.id === msg.author_id) : null;
          const parentMsg = msg.parent_message_id ? messageMap.get(msg.parent_message_id) : null;

          return (
            <div
              key={msg.id}
              id={`msg-${msg.id}`}
              className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'} group`}
            >
              {!isUser && (
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-sm"
                  style={{ backgroundColor: member?.avatar_color || '#6366f1' }}
                >
                  {msg.author_name.charAt(0).toUpperCase()}
                </div>
              )}

              <div className={`max-w-[85%] space-y-1 ${isUser ? 'items-end' : 'items-start'}`}>
                {/* Header info */}
                <div className={`flex items-center gap-2 text-2xs ${isUser ? 'justify-end' : ''}`}>
                  <span className="font-semibold text-theme-text">{msg.author_name}</span>
                  {msg.author_role && (
                    <span className="text-theme-text-muted">({msg.author_role})</span>
                  )}
                  {parentMsg && (
                    <span className="text-accent flex items-center gap-0.5 bg-accent/10 px-1.5 py-0.5 rounded">
                      <CornerDownRight size={10} />
                      {t('forum.repliedTo')} @{parentMsg.author_name}
                    </span>
                  )}
                  <span className="text-theme-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                    {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {/* Message Bubble */}
                <div
                  className={`rounded-2xl p-3.5 text-sm transition-shadow ${
                    isUser
                      ? 'bg-accent text-white shadow-soft rounded-tr-xs'
                      : 'bg-theme-bg border border-theme-border text-theme-text rounded-tl-xs shadow-xs'
                  }`}
                >
                  <MarkdownContent content={msg.content} />
                </div>

                {/* Inline Action */}
                <div className={`flex items-center gap-2 pt-0.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <button
                    onClick={() => {
                      setReplyTarget(msg);
                      textareaRef.current?.focus();
                    }}
                    className="text-2xs text-theme-text-muted hover:text-accent flex items-center gap-1 transition-colors opacity-60 group-hover:opacity-100"
                  >
                    <CornerDownRight size={11} />
                    {t('forum.reply')}
                  </button>
                </div>
              </div>

              {isUser && (
                <div className="w-8 h-8 rounded-xl bg-accent text-white flex items-center justify-center text-xs font-bold flex-shrink-0 shadow-sm">
                  U
                </div>
              )}
            </div>
          );
        })}

        {/* Tree View */}
        {viewMode === 'tree' && currentForum && (
          <div className="space-y-4">
            {treeRoots.roots.map((root) => (
              <TreeNode
                key={root.id}
                message={root}
                childrenMap={treeRoots.childrenMap}
                members={currentForum.members}
                onReply={(msg) => {
                  setReplyTarget(msg);
                  textareaRef.current?.focus();
                }}
              />
            ))}
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* ── BOTTOM USER INPUT AREA ── */}
      <div className="glass-card rounded-2xl p-3 border border-theme-border shadow-sm space-y-2">
        {replyTarget && (
          <div className="flex items-center justify-between bg-accent/10 border border-accent/20 px-3 py-1.5 rounded-xl text-xs text-accent">
            <span className="flex items-center gap-1.5 truncate">
              <CornerDownRight size={13} />
              {t('forum.replyingTo')} <b>@{replyTarget.author_name}</b>: "{replyTarget.content.slice(0, 60)}..."
            </span>
            <button
              onClick={() => setReplyTarget(null)}
              className="text-accent hover:text-accent/80 p-0.5"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendMessage();
            }
          }}
          placeholder={
            needsRecovery
              ? t('forum.recoveryRequired')
              : isRunning
              ? t('forum.cycleRunning')
              : replyTarget
              ? `${t('forum.replyToPlaceholder')} @${replyTarget.author_name}...`
              : t('forum.inputPlaceholder')
          }
          disabled={isLocked || submitting || skipping}
          rows={2}
          className="input-field w-full resize-none text-sm py-2"
        />

        <div className="flex gap-2 justify-end">
          {/* Skip does not touch the draft: no message is sent and nothing is
              cleared, the agents just take another cycle. */}
          <button
            onClick={handleSkipTurn}
            disabled={isLocked || submitting || skipping}
            className="btn-secondary px-4 py-2.5 flex items-center justify-center gap-1.5 h-[42px] disabled:opacity-50"
          >
            {skipping ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <span>{t('forum.skipTurn')}</span>
            )}
          </button>

          <button
            onClick={handleSendMessage}
            disabled={!userInput.trim() || isLocked || submitting || skipping}
            className="btn-primary px-4 py-2.5 flex items-center justify-center gap-1.5 h-[42px] disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <span>{t('forum.send')}</span>
            )}
          </button>
        </div>
      </div>

      {/* ── RULES MODAL ── */}
      {showRulesModal && (
        <Modal open onClose={() => setShowRulesModal(false)} size="lg">
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-theme-text">{t('forum.rulesTitle')}</h3>
              <button
                onClick={() => setRulesDraft(DEFAULT_AGENT_FORUM_RULES)}
                className="text-xs text-accent hover:underline flex items-center gap-1"
              >
                <RotateCcw size={12} />
                {t('effort.resetRecommended')}
              </button>
            </div>
            <p className="text-xs text-theme-text-secondary">
              {t('forum.rulesHint')}
            </p>
            <textarea
              value={rulesDraft}
              onChange={(e) => setRulesDraft(e.target.value)}
              rows={12}
              className="input-field w-full font-mono text-xs leading-relaxed"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowRulesModal(false)} className="btn text-xs">
                {t('header.cancel')}
              </button>
              <button onClick={handleSaveRules} disabled={isLocked} className="btn-primary text-xs">
                {t('header.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── NEW FORUM MODAL ── */}
      {showNewForumModal && (
        <Modal open onClose={() => setShowNewForumModal(false)} size="md">
          <div className="p-5 space-y-4">
            <h3 className="text-base font-semibold text-theme-text">{t('forum.createNewTitle')}</h3>
            <div>
              <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                {t('forum.titleLabel')}
              </label>
              <input
                type="text"
                value={newForumTitle}
                onChange={(e) => setNewForumTitle(e.target.value)}
                placeholder={t('forum.titlePlaceholder')}
                className="input-field w-full"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                {t('forum.projectContextLabel')}
              </label>
              <select
                value={newForumProject}
                onChange={(e) => setNewForumProject(e.target.value)}
                className="input-field w-full"
              >
                <option value="">{t('forum.standaloneOption')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowNewForumModal(false)} className="btn text-xs">
                {t('header.cancel')}
              </button>
              <button
                onClick={handleCreateForum}
                disabled={!newForumTitle.trim()}
                className="btn-primary text-xs"
              >
                {t('header.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MEMBER EDIT MODAL ── */}
      {showMemberModal && (
        <Modal open onClose={() => setShowMemberModal(false)} size="lg">
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-theme-text">
                {editingMember ? t('agents.edit') : t('agents.add')}
              </h3>
              {editingMember && currentForum && activeMemberCount > 2 && !isLocked && (
                <button
                  onClick={() => {
                    handleDeleteMember(editingMember.id);
                    setShowMemberModal(false);
                  }}
                  className="btn-danger text-xs py-1 px-2.5 flex items-center gap-1"
                >
                  <Trash2 size={12} />
                  {t('common.delete')}
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                  {t('agents.name')}
                </label>
                <input
                  type="text"
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  className="input-field w-full"
                  placeholder="e.g. Claude"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                  {t('agents.role')}
                </label>
                <input
                  type="text"
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value)}
                  className="input-field w-full"
                  placeholder="e.g. Architect"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                {t('agents.systemPrompt')}
              </label>
              <textarea
                value={memberPrompt}
                onChange={(e) => setMemberPrompt(e.target.value)}
                rows={4}
                className="input-field w-full text-xs"
                placeholder={t('agents.systemPromptPlaceholder')}
              />
            </div>

            {/* Execution Model Picker */}
            <ExecutionConfigurationPicker
              executionProfileId={memberProfileId || null}
              cliTool={memberCliTool}
              cliModel={memberCliModel}
              cliEffort={memberCliEffort}
              allowEmptyTool={false}
              onChange={(val) => {
                setMemberCliTool((val.cliTool as CliTool) || 'claude');
                setMemberCliModel(val.cliModel || '');
                setMemberCliEffort(val.cliEffort || '');
                setMemberProfileId(val.executionProfileId || '');
              }}
            />

            {/* Avatar Color */}
            <div>
              <label className="block text-xs font-medium text-theme-text-secondary mb-1">
                {t('agents.color')}
              </label>
              <div className="flex gap-2 flex-wrap items-center">
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold mr-2"
                  style={{ backgroundColor: memberColor }}
                >
                  {memberName ? memberName.charAt(0).toUpperCase() : '?'}
                </span>
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setMemberColor(c)}
                    className={`w-6 h-6 rounded-full transition-transform ${
                      memberColor === c ? 'scale-125 ring-2 ring-accent' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-theme-border">
              <button onClick={() => setShowMemberModal(false)} className="btn text-xs">
                {t('header.cancel')}
              </button>
              <button
                onClick={handleSaveMember}
                disabled={!memberName.trim() || isLocked}
                className="btn-primary text-xs"
              >
                {t('header.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Tree view recursive renderer
function TreeNode({
  message,
  childrenMap,
  members,
  onReply,
  depth = 0,
}: {
  message: AgentForumMessage;
  childrenMap: Map<string, AgentForumMessage[]>;
  members: AgentForumMember[];
  onReply: (msg: AgentForumMessage) => void;
  depth?: number;
}) {
  const { t } = useI18n();
  const children = childrenMap.get(message.id) || [];
  const isUser = message.author_type === 'user';
  const member = message.author_id ? members.find((m) => m.id === message.author_id) : null;

  return (
    <div className={`relative ${depth > 0 ? 'ml-6 pl-4 border-l-2 border-theme-border/60 mt-3' : ''}`}>
      <div className="bg-theme-bg border border-theme-border rounded-xl p-3 shadow-xs space-y-1.5">
        <div className="flex items-center justify-between text-2xs">
          <div className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{ backgroundColor: isUser ? '#3b82f6' : (member?.avatar_color || '#6366f1') }}
            />
            <span className="font-semibold text-theme-text">{message.author_name}</span>
            {message.author_role && (
              <span className="text-theme-text-muted">({message.author_role})</span>
            )}
          </div>
          <span className="text-theme-text-muted">
            {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <div className="text-xs text-theme-text leading-relaxed">
          <MarkdownContent content={message.content} />
        </div>

        <div className="flex justify-end pt-1">
          <button
            onClick={() => onReply(message)}
            className="text-2xs text-accent hover:underline flex items-center gap-1"
          >
            <CornerDownRight size={11} />
            {t('forum.reply')}
          </button>
        </div>
      </div>

      {children.length > 0 && (
        <div className="space-y-2">
          {children.map((child) => (
            <TreeNode
              key={child.id}
              message={child}
              childrenMap={childrenMap}
              members={members}
              onReply={onReply}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
