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

export function useAgentForumEnabled(active = true): boolean {
  return useFeatures(active).agentForum;
}
