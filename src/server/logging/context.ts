import { AsyncLocalStorage } from 'async_hooks';
import type { LogFields } from './types.js';

/**
 * Ambient execution context.
 *
 * Low-level layers (CLI spawn, quota, resource admission) are shared by every
 * feature, so they must not each grow a bespoke "who called me" parameter. A
 * feature wraps its work in `runWithLogContext` once and every record emitted
 * underneath inherits the scope and correlation IDs.
 */
export interface LogContext {
  /** Console tag, e.g. `[forum:test][Claude]`. */
  scope?: string;
  /** Correlation IDs merged into every record; explicit fields win. */
  fields?: LogFields;
}

const storage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

/** Runs `fn` with `context` merged onto whatever context is already active. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore();
  const merged: LogContext = {
    scope: joinScopes(parent?.scope, context.scope),
    fields: { ...(parent?.fields ?? {}), ...(context.fields ?? {}) },
  };
  return storage.run(merged, fn);
}

/**
 * Scopes concatenate rather than replace: a turn running inside a forum reads
 * as `[forum:test][Claude]`, matching the spec's console examples.
 */
export function joinScopes(parent: string | undefined, child: string | undefined): string | undefined {
  if (!parent) return child;
  if (!child) return parent;
  if (parent.includes(child)) return parent;
  return `${parent}${child}`;
}

/** `forum:My discussion` → `[forum:My discussion]`. */
export function tag(kind: string, label: string | null | undefined): string {
  const clean = (label ?? '').replace(/\s+/g, ' ').trim();
  const shortened = clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
  return shortened ? `[${kind}:${shortened}]` : `[${kind}]`;
}
