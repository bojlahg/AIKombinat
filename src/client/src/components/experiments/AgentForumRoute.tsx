import { Navigate } from 'react-router-dom';
import AgentForumView from './AgentForumView';
import { Skeleton } from '../Skeleton';
import type { WsEvent } from '../../hooks/useWebSocket';

interface AgentForumRouteProps {
  enabled: boolean | null;
  onEvent: (cb: (event: WsEvent) => void) => () => void;
  connected: boolean;
}

/**
 * Gate for the paused AgentForum V1 experiment.
 *
 * Tri-state semantics:
 * - `null` (unknown, features request still in flight): render a loading
 *   placeholder and do NOT redirect — a cold deep-link must survive until the
 *   server confirms the real state. The forum view is not mounted, so no
 *   forum API fetch and no Send/Skip controls appear yet.
 * - `false` (server confirmed disabled, or request failed -> fail closed):
 *   redirect safely home.
 * - `true`: mount the forum view.
 */
export default function AgentForumRoute({ enabled, onEvent, connected }: AgentForumRouteProps) {
  if (enabled === null) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4" data-testid="agent-forum-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (!enabled) return <Navigate to="/" replace />;
  return <AgentForumView onEvent={onEvent} connected={connected} />;
}
