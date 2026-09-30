import { canonicalJson } from '../services/resource-requirements.js';

export const ORCHESTRATOR_CONTEXT_MAX_BYTES = 256 * 1024;
export const ORCHESTRATOR_EVENT_BATCH_MAX_BYTES = 128 * 1024;
export const ORCHESTRATOR_EVENT_BATCH_MAX_COUNT = 64;

export function eventSnapshot(event: { id: string; type: string; payload_json: string }) {
  return { id: event.id, type: event.type, payload: JSON.parse(event.payload_json) as unknown };
}

export function selectEventBatch<T extends { id: string; type: string; payload_json: string }>(pending: T[]): T[] {
  const selected: T[] = [];
  let bytes = 2; // JSON array brackets, with commas accounted for below.
  for (const event of pending) {
    if (selected.length >= ORCHESTRATOR_EVENT_BATCH_MAX_COUNT) break;
    const size = Buffer.byteLength(canonicalJson(eventSnapshot(event)), 'utf8');
    if (size + 2 > ORCHESTRATOR_EVENT_BATCH_MAX_BYTES) throw new Error('orchestrator_event_budget_exceeded');
    if (bytes + size + (selected.length ? 1 : 0) > ORCHESTRATOR_EVENT_BATCH_MAX_BYTES) break;
    bytes += size + (selected.length ? 1 : 0);
    selected.push(event);
  }
  return selected;
}

export function serializeContext(
  mandatory: Record<string, unknown> & { children: unknown[]; resources: unknown[] },
  messagesNewestFirst: unknown[], terminalChildrenNewestFirst: unknown[], historicalResourcesNewestFirst: unknown[],
): string {
  const context = { ...mandatory, recent_messages: [] as unknown[], context_truncated: false,
    omitted_messages: messagesNewestFirst.length, omitted_terminal_children: terminalChildrenNewestFirst.length,
    omitted_historical_resources: historicalResourcesNewestFirst.length };
  const fits = () => Buffer.byteLength(canonicalJson(context), 'utf8') <= ORCHESTRATOR_CONTEXT_MAX_BYTES;
  if (!fits()) throw new Error('orchestrator_mandatory_context_budget_exceeded');

  function append(entries: unknown[], target: unknown[], counter: 'omitted_messages' | 'omitted_terminal_children' | 'omitted_historical_resources') {
    for (const entry of entries) {
      target.push(entry);
      if (!fits()) { target.pop(); break; }
      context[counter]--;
    }
  }
  append(messagesNewestFirst, context.recent_messages, 'omitted_messages');
  context.recent_messages.reverse();
  append(terminalChildrenNewestFirst, context.children, 'omitted_terminal_children');
  append(historicalResourcesNewestFirst, context.resources, 'omitted_historical_resources');
  context.context_truncated = !!(context.omitted_messages || context.omitted_terminal_children || context.omitted_historical_resources);
  const serialized = canonicalJson(context);
  if (Buffer.byteLength(serialized, 'utf8') > ORCHESTRATOR_CONTEXT_MAX_BYTES) throw new Error('orchestrator_context_budget_exceeded');
  return serialized;
}
