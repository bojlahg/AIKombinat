import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export function installProcessEvidence(db: Database.Database) {
  db.exec(`CREATE TABLE smoke_processes (owner TEXT, round_id TEXT, phase TEXT, pid INTEGER, identity TEXT, snapshot TEXT, PRIMARY KEY(owner,round_id,pid));
    CREATE TABLE smoke_exits (pid INTEGER, code INTEGER, at TEXT, duration_ms INTEGER);
    CREATE TABLE smoke_review_hashes (todo_id TEXT, round_id TEXT, hash TEXT, PRIMARY KEY(todo_id,round_id));
    CREATE TABLE smoke_implementation_tests (todo_id TEXT, round_id TEXT, result TEXT, PRIMARY KEY(todo_id,round_id));
    CREATE TRIGGER smoke_todo_process AFTER UPDATE ON todos WHEN NEW.process_pid > 0 AND NEW.process_identity IS NOT NULL BEGIN
      INSERT OR REPLACE INTO smoke_processes SELECT NEW.id,r.id,r.phase,NEW.process_pid,NEW.process_identity,NEW.execution_snapshot
      FROM todo_execution_rounds r WHERE r.todo_id=NEW.id AND r.status='running'; END;
    CREATE TRIGGER smoke_reviewer_process AFTER UPDATE ON consensus_review_attempts WHEN NEW.process_pid > 0 AND NEW.process_identity IS NOT NULL BEGIN
      INSERT OR REPLACE INTO smoke_processes VALUES(NEW.id,NEW.review_job_id,'consensus_review',NEW.process_pid,NEW.process_identity,NEW.execution_snapshot); END;`);
}

export function captureReviewStartHashes(db: Database.Database, hash: (todoId: string) => string) {
  const rounds = db.prepare("SELECT id,todo_id FROM todo_execution_rounds WHERE phase='review' AND status='running'").all() as Array<{ id: string; todo_id: string }>;
  for (const round of rounds) db.prepare('INSERT OR IGNORE INTO smoke_review_hashes VALUES(?,?,?)').run(round.todo_id, round.id, hash(round.todo_id));
}

export function sourceFingerprint(file: string) {
  return Object.fromEntries(['', '-wal', '-shm'].map(suffix => [suffix || 'db', fs.existsSync(file + suffix)
    ? createHash('sha256').update(fs.readFileSync(file + suffix)).digest('hex') : null]));
}

export class RealAiBudget {
  used = 0;
  exceeded = false;
  constructor(readonly allowed: boolean, readonly limit: number) {}
  beforeSpawn() {
    if (!this.allowed) throw new Error('real_ai_not_authorized');
    if (this.used >= this.limit) { this.exceeded = true; throw new Error('real_ai_process_budget_exceeded'); }
    this.used++;
  }
}

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
  const options = { keep: false, serve: false, timeout: 900, implementationProfile: '', singleReviewProfile: '', consensusPolicy: '',
    bootstrapDisposable: false, bootstrapProvider: '', implementationModel: '', reviewModel: '',
    implementationEffort: 'provider-default', reviewEffort: 'provider-default', bootstrapAccount: '', allowRealAi: false, maxRealAiProcesses: 8 };
  for (const arg of args) {
    if (arg === '--bootstrap-disposable') options.bootstrapDisposable = true;
    else if (arg === '--allow-real-ai') options.allowRealAi = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--serve') options.serve = options.keep = true;
    else {
      const match = /^--(implementation-profile|single-review-profile|consensus-policy|timeout|bootstrap-provider|implementation-model|review-model|implementation-effort|review-effort|bootstrap-account|max-real-ai-processes)=(.+)$/.exec(arg);
      if (!match) throw new Error(`Unknown smoke option: ${arg}`);
      if (match[1] === 'max-real-ai-processes') {
        const limit = Number(match[2]);
        if (!Number.isSafeInteger(limit) || limit < 5) throw new Error('CONFIG_ERROR: process budget requires at least 5');
        options.maxRealAiProcesses = limit;
      } else if (match[1] === 'timeout') {
        const seconds = Number(match[2]);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('Invalid timeout');
        options.timeout = seconds;
      } else if (match[1] === 'implementation-profile') options.implementationProfile = match[2];
      else if (match[1] === 'single-review-profile') options.singleReviewProfile = match[2];
      else {
        const key = match[1].replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof typeof options;
        Object.assign(options, { [key]: match[2] });
      }
    }
  }
  if (options.bootstrapDisposable) {
    if (!['claude', 'codex', 'opencode'].includes(options.bootstrapProvider)) throw new Error('CONFIG_ERROR: bootstrap provider must be claude, codex or opencode');
    if (!options.implementationModel || !options.reviewModel) throw new Error('CONFIG_ERROR: explicit implementation and review models required');
    if (options.implementationProfile || options.singleReviewProfile || options.consensusPolicy) throw new Error('CONFIG_ERROR: bootstrap owns profile and policy selection');
    if (options.bootstrapAccount) throw new Error('CONFIG_ERROR: explicit account override is out of scope; only inherited credentials are copied');
  } else if (args.some(arg => /^--(?:bootstrap-provider|bootstrap-account|implementation-model|review-model|implementation-effort|review-effort)=/.test(arg))) {
    throw new Error('CONFIG_ERROR: bootstrap arguments require --bootstrap-disposable');
  }
  return options;
}
