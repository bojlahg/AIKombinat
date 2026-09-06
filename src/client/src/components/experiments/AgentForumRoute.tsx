import { Navigate } from 'react-router-dom';
import AgentForumView from './AgentForumView';
import type { WsEvent } from '../../hooks/useWebSocket';

interface AgentForumRouteProps {
  enabled: boolean;
  onEvent: (cb: (event: WsEvent) => void) => () => void;
  connected: boolean;
}

/**
 * Gate for the paused AgentForum V1 experiment.
 *
 * While disabled, a stale deep-link must never mount the forum view (which
 * would fetch forum state and offer Send/Skip/Start controls) — it redirects
 * safely instead. The server still rejects any mutation that reaches it.
 */
export default function AgentForumRoute({ enabled, onEvent, connected }: AgentForumRouteProps) {
  if (!enabled) return <Navigate to="/" replace />;
  return <AgentForumView onEvent={onEvent} connected={connected} />;
}
