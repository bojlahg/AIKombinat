import fs from 'node:fs';
import path from 'node:path';

export const acceptanceNotice = 'THIS RUN IS ACCEPTANCE EVIDENCE, NOT COMPARATIVE QUALITY EVIDENCE.';
export function smokeProfileEligible(candidates: Array<{ enabled: boolean; current: boolean; runtimeState: string; authorized: boolean }>) {
  const selected = candidates.find(candidate => candidate.enabled && candidate.runtimeState === 'available');
  return !!selected?.current && selected.authorized;
}
export interface Candidate {
  todoId: string;
  assignmentId: string;
  armId: string;
  control: boolean;
  bucket: number;
  integrity: string;
}
export async function selectCandidates(
  create: () => Promise<Candidate>,
  withdraw: (candidate: Candidate) => Promise<void>,
  candidates: Candidate[],
) {
  let control: Candidate | undefined, experiment: Candidate | undefined;
  try {
    while (candidates.length < 12 && (!control || !experiment)) {
      const candidate = await create();
      candidates.push(candidate);
      if (candidate.control) control ??= candidate;
      else experiment ??= candidate;
    }
    if (!control || !experiment) throw new Error('assignment_distribution_unlucky');
  } catch (error) {
    for (const candidate of candidates) await withdraw(candidate);
    throw error;
  }
  const extras = candidates.filter(candidate => candidate !== control && candidate !== experiment);
  for (const candidate of extras) await withdraw(candidate);
  return { control, experiment, extras };
}

export function assertInside(root: string, target: string) {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTarget = fs.realpathSync(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path is outside disposable smoke root');
  }
}

export function writeReport(root: string, report: Record<string, unknown>) {
  const target = path.join(root, 'report.json');
  fs.writeFileSync(target, JSON.stringify({ ...report, notice: acceptanceNotice }, null, 2) + '\n', { mode: 0o600 });
}

export async function withCleanup<T>(run: () => Promise<T>, cleanup: () => Promise<void>) {
  try { return await run(); }
  finally { await cleanup(); }
}

export function parseOptions(args: string[]) {
  const options = { keep: false, serve: false, timeout: 900, implementationProfile: '', singleReviewProfile: '', consensusPolicy: '' };
  for (const arg of args) {
    if (arg === '--keep') options.keep = true;
    else if (arg === '--serve') options.serve = options.keep = true;
    else {
      const match = /^--(implementation-profile|single-review-profile|consensus-policy|timeout)=(.+)$/.exec(arg);
      if (!match) throw new Error(`Unknown smoke option: ${arg}`);
      if (match[1] === 'timeout') {
        const seconds = Number(match[2]);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('Invalid timeout');
        options.timeout = seconds;
      } else if (match[1] === 'implementation-profile') options.implementationProfile = match[2];
      else if (match[1] === 'single-review-profile') options.singleReviewProfile = match[2];
      else options.consensusPolicy = match[2];
    }
  }
  return options;
}
