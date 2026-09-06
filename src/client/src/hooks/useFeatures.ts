import { useEffect, useState } from 'react';
import { getFeatures, type FeatureFlags } from '../api/features';

// Fail-closed default: the AgentForum entry points stay hidden until the
// server affirmatively reports the experiment as enabled.
const DISABLED: FeatureFlags = { agentForum: false };

let cached: FeatureFlags | null = null;
let inflight: Promise<FeatureFlags> | null = null;

export function fetchFeatureFlags(): Promise<FeatureFlags> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = getFeatures().then(
      (flags) => {
        cached = { agentForum: flags.agentForum === true };
        inflight = null;
        return cached;
      },
      () => {
        // Fail closed without caching the failure: a transient network error
        // must not permanently hide (or show) the feature for this session.
        inflight = null;
        return { ...DISABLED };
      },
    );
  }
  return inflight;
}

/** Test-only reset for the module-level cache. */
export function resetFeatureFlagsCache(): void {
  cached = null;
  inflight = null;
}

export function useFeatures(active = true): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(cached ?? DISABLED);
  useEffect(() => {
    if (!active) return;
    let live = true;
    fetchFeatureFlags().then((f) => {
      if (live) setFlags(f);
    });
    return () => {
      live = false;
    };
  }, [active]);
  return flags;
}

/**
 * Tri-state gate for the paused AgentForum V1 experiment.
 *
 * - `null`  = feature state not resolved yet (cold deep-link must NOT redirect)
 * - `false` = server confirmed disabled (or the request failed: fail closed)
 * - `true`  = server confirmed enabled
 *
 * Sidebar treats `null` as hidden (falsy), the route renders a loading
 * placeholder while `null` so it never fetches forum state or flashes Home.
 */
export function useAgentForumEnabled(active = true): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(
    cached ? cached.agentForum : null,
  );
  useEffect(() => {
    if (!active) return;
    if (cached) {
      setEnabled(cached.agentForum);
      return;
    }
    let live = true;
    fetchFeatureFlags().then((f) => {
      if (live) setEnabled(f.agentForum);
    });
    return () => {
      live = false;
    };
  }, [active]);
  return enabled;
}
