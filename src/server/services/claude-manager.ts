import { spawn, ChildProcess } from 'child_process';
import { PassThrough, Readable, Writable } from 'stream';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as pty from 'node-pty';
import treeKill from 'tree-kill';
import { getAdapter, type CliAdapter, type CliTool, type CliMode, type LaunchModelSelection, type PromptPolicy, type SandboxMode } from './cli-adapters.js';
import { getToolStatus } from './cli-status.js';
import { createPtyFilterState, filterInteractivePtyOutput, type PtyFilterState } from './pty-output-filter.js';
import { assertExternalAiCliAllowed } from '../utils/cli-guard.js';
import { logger } from '../logging/logger.js';
import { redactArgs } from '../logging/redact.js';
import {
  isProcessAlive,
  readProcessIdentity,
  terminateProcessTree,
  verifyProcessIdentity,
  type ProcessIdentity,
} from '../utils/process-tree.js';

export type ClaudeMode = CliMode;

// Environment handed to spawned CLIs / PTYs. Inherits the process env but strips
// server-only secrets so an agent or raw-shell can't read them — otherwise a
// prompt-injected agent could exfiltrate SESSION_SECRET and forge session cookies.
const CHILD_ENV_BLOCKLIST = new Set(['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN']);
function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || CHILD_ENV_BLOCKLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// node-pty ships its macOS/Linux `spawn-helper` as a prebuilt binary. Some npm
// extractions drop the executable bit, so `pty.fork` fails with
// "posix_spawnp failed." and every session shows a blank terminal. Restore +x
// once before the first spawn — self-healing covers --ignore-scripts installs
// and bits lost on reinstall. No-op on Windows (no spawn-helper).
let ptyHelperEnsured = false;
function ensurePtyHelperExecutable(): void {
  if (ptyHelperEnsured) return;
  ptyHelperEnsured = true;
  if (process.platform === 'win32') return;
  try {
    const require = createRequire(import.meta.url);
    const prebuildsDir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
    for (const name of fs.readdirSync(prebuildsDir)) {
      const helper = path.join(prebuildsDir, name, 'spawn-helper');
      try {
        const st = fs.statSync(helper);
        if (!(st.mode & 0o111)) fs.chmodSync(helper, st.mode | 0o111);
      } catch { /* not present for this arch */ }
    }
  } catch { /* best-effort; manual chmod is the fallback */ }
}

interface ManagedProcess {
  kill(signal?: string): void;
  readonly pid: number;
}

export type StopResult =
  | { status: 'terminated'; pid: number; graceful: boolean }
  | { status: 'already_exited'; pid: number }
  | { status: 'unresolved'; pid: number; reason: string };

export class Utf8StreamDecoder {
  private readonly decoder = new StringDecoder('utf8');

  write(chunk: Buffer | string): string {
    return typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
  }

  end(): string {
    return this.decoder.end();
  }
}

interface RawRingBuffer {
  chunks: string[];
  bytes: number;
  max: number;
}

interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

class CliCompatibilityError extends Error {
  constructor(
    message: string,
    readonly unsupportedFlag: string,
    readonly detectedVersion: string | null,
  ) {
    super(message);
    this.name = 'CliCompatibilityError';
  }
}

export class ClaudeManager {
  private processes: Map<number, ManagedProcess> = new Map();
  private exitWaiters: Map<number, Set<() => void>> = new Map();
  private stdinStreams: Map<number, NodeJS.WritableStream> = new Map();
  private rawSubscribers: Map<number, Set<(chunk: string) => void>> = new Map();
  private rawRingBuffers: Map<number, RawRingBuffer> = new Map();
  private ptyHandles: Map<number, PtyHandle> = new Map();

  private markExited(pid: number): void {
    this.processes.delete(pid);
    const waiters = this.exitWaiters.get(pid);
    this.exitWaiters.delete(pid);
    if (waiters) for (const resolve of waiters) resolve();
  }

  whenExited(pid: number): Promise<void> {
    if (!this.processes.has(pid)) return Promise.resolve();
    return new Promise((resolve) => {
      let waiters = this.exitWaiters.get(pid);
      if (!waiters) {
        waiters = new Set();
        this.exitWaiters.set(pid, waiters);
      }
      waiters.add(resolve);
    });
  }

  private appendRing(pid: number, chunk: string): void {
    const ring = this.rawRingBuffers.get(pid);
    if (!ring) return;
    ring.chunks.push(chunk);
    ring.bytes += Buffer.byteLength(chunk, 'utf8');
    while (ring.bytes > ring.max && ring.chunks.length > 1) {
      const dropped = ring.chunks.shift()!;
      ring.bytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  /** Subscribe to the raw (un-stripped, un-filtered) PTY output for a pid. */
  subscribeRaw(pid: number, cb: (chunk: string) => void, replayHistory: boolean = false): () => void {
    let set = this.rawSubscribers.get(pid);
    if (!set) {
      set = new Set();
      this.rawSubscribers.set(pid, set);
    }
    set.add(cb);

    if (replayHistory) {
      const ring = this.rawRingBuffers.get(pid);
      if (ring && ring.chunks.length > 0) {
        const buffered = [...ring.chunks];
        for (const chunk of buffered) {
          try { cb(chunk); } catch { /* ignore */ }
        }
      }
    }

    return () => this.unsubscribeRaw(pid, cb);
  }

  unsubscribeRaw(pid: number, cb: (chunk: string) => void): void {
    const set = this.rawSubscribers.get(pid);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this.rawSubscribers.delete(pid);
  }

  /** Returns the buffered raw output (joined) for replay on (re)connect. */
  getRawHistory(pid: number): string {
    const ring = this.rawRingBuffers.get(pid);
    return ring ? ring.chunks.join('') : '';
  }

  /** Resize the PTY (cols, rows). No-op if pid is not a PTY. */
  resize(pid: number, cols: number, rows: number): boolean {
    const handle = this.ptyHandles.get(pid);
    if (!handle) return false;
    try { handle.resize(cols, rows); return true; }
    catch { return false; }
  }

  /**
   * Write raw bytes/keystrokes to the PTY without the `\n → submitSeq`
   * translation that `writeToStdin` applies. Used by xterm.js terminal input
   * where the client already sends raw key sequences (CR, arrow keys, etc).
   */
  writeStdinRaw(pid: number, data: string): boolean {
    const handle = this.ptyHandles.get(pid);
    if (!handle) return false;
    try { handle.write(data); return true; }
    catch { return false; }
  }

  /**
   * Start a CLI tool in a worktree directory.
   * Uses node-pty for tools that require a TTY (e.g. Codex),
   * falls back to child_process.spawn for others.
   *
   * `model` accepts either a bare logical model name (legacy / manual callers)
   * or a `LaunchModelSelection` carrying the already-frozen provider slug from
   * `resolveExecutionConfig()`. In the latter case the slug reaches the CLI
   * verbatim — no second trip through the logical Model Catalog.
   */
  async startClaude(
    worktreePath: string,
    prompt: string,
    model?: string | LaunchModelSelection,
    extraOptions?: string,
    mode: ClaudeMode = 'headless',
    tool: CliTool = 'claude',
    maxTurns?: number,
    projectPath?: string,
    sandboxMode: SandboxMode = 'strict',
    continueSession = false,
    ptyCols?: number,
    ptyRows?: number,
    effort?: string,
    promptPolicy?: PromptPolicy,
  ): Promise<{
    pid: number;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream | null;
    exitPromise: Promise<number>;
    command: string;
    args: string[];
    processIdentity?: ProcessIdentity | null;
  }> {
    assertExternalAiCliAllowed(tool);

    const adapter = getAdapter(tool);
    const selection: LaunchModelSelection = typeof model === 'string' ? { model } : (model ?? {});
    const args = adapter.buildArgs({ mode, prompt, ...selection, effort, extraOptions, maxTurns, workDir: worktreePath, projectPath: projectPath || worktreePath, sandboxMode, continueSession, promptPolicy });

    // Shared spawn diagnostics for every feature (todo, review, forum, session,
    // discussion). Features add their own summaries on top; none of them
    // re-implement this. The unified logger never records the prompt itself —
    // it carries project context, memory and user messages. (The separate,
    // opt-in `project.debug_logging` facility does capture it, into its own
    // per-project `.debug-logs/` file — never into logs/aikombinat.log.)
    const startedAt = Date.now();
    const launchedModel = selection.effectiveModel ?? selection.model;
    const spawnFields = {
      provider: tool,
      mode,
      sandbox: sandboxMode,
      // Report the slug that actually reaches the CLI, so cli.spawned lines up
      // with the effective model the feature already logged at admission.
      ...(launchedModel ? { model: launchedModel } : {}),
      ...(effort ? { effort } : {}),
      continueSession,
    };
    logger.debug('cli.spawn.requested', {
      msg: `${adapter.displayName} spawn requested`,
      ...spawnFields,
      command: adapter.command,
      args: redactArgs(args).join(' '),
      cwd: worktreePath,
    });

    // Pre-flight on Windows only: spawn goes through cmd.exe (shell:true), so
    // a missing CLI never fires ENOENT — cmd exits 1 with a localized (often
    // mojibake) message. POSIX already surfaces ENOENT via the 'error' event.
    //
    // Runs *inside* the spawn logging boundary below rather than ahead of it, so
    // a missing CLI produces the same single `cli.spawn.failed` record as every
    // other startup failure instead of throwing past the diagnostics.
    const assertToolCompatible = async (): Promise<void> => {
      const emittedCompatibilityFlags = (adapter.compatibilityFlags ?? [])
        .filter((flag) => args.includes(flag));
      if (process.platform !== 'win32' && emittedCompatibilityFlags.length === 0) return;
      const status = await getToolStatus(tool);
      if (status && !status.installed) {
        throw new Error(
          `${adapter.displayName} ('${adapter.command}') was not found on PATH. `
          + `Install it first — or if it was installed after AIKombinat started, restart AIKombinat to pick up the updated PATH.`
        );
      }
      if (status?.capabilities) {
        const supported = new Set(status.capabilities);
        const unsupportedFlag = emittedCompatibilityFlags.find((flag) => !supported.has(flag));
        if (unsupportedFlag) {
          throw new CliCompatibilityError(
            `${adapter.displayName} ${status.version ?? '(unknown version)'} is incompatible with this execution mode: required flag ${unsupportedFlag} is not supported. Update the CLI or select another provider.`,
            unsupportedFlag,
            status.version,
          );
        }
      }
    };

    if (adapter.requiresTty || mode === 'interactive') {
      // Empty prompt (sessions stash the real prompt in pendingInitialPrompts and
      // deliver it later via writeToStdin) must NOT produce a stdinPrompt — the
      // delayStdinUntilReady path would otherwise write '\n'→submitSeq ('\r' or
      // '\r\n') to the PTY on ready, submitting the user's startupInputBuffer
      // type-ahead as if they pressed Enter.
      const stdinPrompt = adapter.needsStdin(mode) && prompt
        ? (adapter.encodeStdinPrompt?.(prompt, mode, promptPolicy)
          ?? adapter.formatStdinPrompt(prompt, mode, promptPolicy))
        : undefined;
      const result = await this.spawnAndLog(
        async () => {
          await assertToolCompatible();
          return this.startWithPty(adapter, args, worktreePath, stdinPrompt, mode === 'interactive', ptyCols, ptyRows);
        },
        adapter,
        spawnFields,
        startedAt,
      );
      const processIdentity = await readProcessIdentity(result.pid).catch(() => null);
      return { ...result, command: adapter.command, args, processIdentity };
    }
    const result = await this.spawnAndLog(
      async () => {
        await assertToolCompatible();
        return this.startWithSpawn(adapter, args, worktreePath, prompt, mode, promptPolicy);
      },
      adapter,
      spawnFields,
      startedAt,
    );
    const processIdentity = await readProcessIdentity(result.pid).catch(() => null);
    return { ...result, command: adapter.command, args, processIdentity };
  }

  /**
   * Wraps a spawn so the process lifetime — start, pid, exit code, duration —
   * lands in the log regardless of which transport (PTY or child_process) the
   * adapter needs, and regardless of which feature asked for it.
   */
  private async spawnAndLog<T extends { pid: number; exitPromise: Promise<number> }>(
    start: () => Promise<T>,
    adapter: CliAdapter,
    spawnFields: Record<string, unknown>,
    startedAt: number,
  ): Promise<T> {
    let result: T;
    try {
      result = await start();
    } catch (err) {
      if (err instanceof CliCompatibilityError) {
        logger.error('cli.compatibility.failed', {
          msg: err.message,
          ...spawnFields,
          unsupportedFlag: err.unsupportedFlag,
          detectedVersion: err.detectedVersion,
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
      logger.error('cli.spawn.failed', {
        msg: `${adapter.displayName} failed to start`,
        ...spawnFields,
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    }

    logger.info('cli.spawned', {
      msg: `${adapter.displayName} started`,
      ...spawnFields,
      pid: result.pid,
    });

    result.exitPromise.then(
      (exitCode) => {
        logger[exitCode === 0 ? 'info' : 'warn']('cli.exited', {
          msg: `${adapter.displayName} exited with code ${exitCode}`,
          ...spawnFields,
          pid: result.pid,
          exitCode,
          durationMs: Date.now() - startedAt,
        });
      },
      (err) => {
        logger.error('cli.exit-error', {
          msg: `${adapter.displayName} process error`,
          ...spawnFields,
          pid: result.pid,
          durationMs: Date.now() - startedAt,
          err,
        });
      },
    );

    return result;
  }

  /**
   * Spawn using node-pty for CLIs that require a TTY.
   */
  private startWithPty(adapter: CliAdapter, args: string[], cwd: string, stdinPrompt?: string, interactive?: boolean, ptyCols?: number, ptyRows?: number): Promise<{
    pid: number;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream | null;
    exitPromise: Promise<number>;
  }> {
    return new Promise((resolve, reject) => {
      const command = adapter.command;
      const displayName = adapter.displayName;
      assertExternalAiCliAllowed(command);
      const delayStdin = !!adapter.delayStdinUntilReady;
      const autoRespondRules = adapter.autoRespondRules ?? [];
      const readyPattern = adapter.readyIndicatorPattern;
      // PTY submit sequence: most Ink-based TUIs accept '\r', but Antigravity
      // needs '\r\n'. Replaces a trailing '\n' on writes going to the PTY.
      const submitSeq = adapter.stdinSubmitSequence ?? '\r';

      let ptyProcess: pty.IPty;
      try {
        ensurePtyHelperExecutable();
        // On Windows, use cmd.exe to resolve .cmd shims (e.g. codex.cmd)
        const ptyCommand = process.platform === 'win32' ? 'cmd.exe' : command;
        const ptyArgs = process.platform === 'win32' ? ['/c', command, ...args] : args;
        ptyProcess = pty.spawn(ptyCommand, ptyArgs, {
          name: 'xterm-256color',
          cols: ptyCols ?? 200,
          rows: ptyRows ?? 50,
          cwd,
          env: childEnv(),
        });
      } catch (err) {
        reject(new Error(
          `Failed to spawn ${displayName}. Is it installed and on PATH? ${err instanceof Error ? err.message : String(err)}`
        ));
        return;
      }

      const pid = ptyProcess.pid;
      // Initialize raw ring buffer for this pid (256KB cap by default).
      this.rawRingBuffers.set(pid, { chunks: [], bytes: 0, max: 256 * 1024 });
      this.ptyHandles.set(pid, {
        write: (d) => { try { ptyProcess.write(d); } catch { /* exited */ } },
        resize: (cols, rows) => { try { ptyProcess.resize(cols, rows); } catch { /* exited */ } },
      });
      // ANSI escape code stripper — replaces cursor movement with spaces to preserve word gaps
      const stripAnsi = (str: string) => {
        // Step 1: Replace cursor movement/positioning sequences with a space
        // C=forward, G=column absolute, H/f=row;col position
        let result = str.replace(/\x1B\[\d*[CG]|\x1B\[\d+;\d+[Hf]/g, ' ');
        // Step 2: Strip all remaining ANSI sequences
        result = result.replace(/\x1B\[[0-9;]*[A-Za-z]|\x1B\].*?(?:\x07|\x1B\\)|\x1B[()][A-Z0-9]|\x1B[>=<]|\x1B\[[\?]?[0-9;]*[hlJKm]/g, '');
        // Step 3: Collapse runs of multiple spaces into one
        result = result.replace(/ {2,}/g, ' ');
        return result;
      };

      // Create a Readable stream from pty data (PTY merges stdout+stderr)
      const stdoutStream = new Readable({ read() {} });
      let stdinDelivered = false;
      let exited = false;

      // Trust prompt tracking: block stdin delivery only while trust prompt is visible
      let trustPending = false;
      const filterState: PtyFilterState | null = interactive ? createPtyFilterState() : null;

      ptyProcess.onData((data) => {
        // Raw byte fan-out: feeds xterm.js terminal subscribers and history ring.
        // Decoupled from stripped/filtered path used by LogViewer/auto-respond.
        const subs = this.rawSubscribers.get(pid);
        if (subs && subs.size > 0) {
          for (const cb of subs) {
            try { cb(data); } catch { /* subscriber errors must not break PTY */ }
          }
        }
        this.appendRing(pid, data);

        const clean = stripAnsi(data);

        // Run adapter-defined auto-respond rules.
        // Blocking rules (trust dialogs) pin trustPending so the initial prompt is
        // deferred until the ready indicator reappears. Non-blocking rules (update
        // notices) dismiss themselves inline without holding back the main prompt.
        for (const rule of autoRespondRules) {
          if (!rule.pattern.test(clean)) continue;
          if (rule.blocksInitialPrompt) {
            if (!trustPending && !exited) {
              trustPending = true;
              try { ptyProcess.write(rule.response); } catch { /* PTY may have exited */ }
            }
          } else if (!exited) {
            try { ptyProcess.write(rule.response); } catch { /* PTY may have exited */ }
          }
        }

        // Clear blocking flag once the CLI is back at a ready indicator AND no
        // blocking rule still matches. Reset stdinDelivered so the initial prompt
        // is (re)sent — handles Antigravity's in-process restart after trust approval.
        if (trustPending && readyPattern?.test(clean)) {
          const stillBlocking = autoRespondRules.some(r => r.blocksInitialPrompt && r.pattern.test(clean));
          if (!stillBlocking) {
            trustPending = false;
            stdinDelivered = false;
          }
        }

        // Detect CLI ready state and deliver the initial prompt via PTY stdin.
        // Non-delayed adapters send immediately in the fallback block below.
        if (delayStdin && stdinPrompt && !stdinDelivered && !exited && !trustPending) {
          const readyMatched = readyPattern?.test(clean) ?? false;
          if (readyMatched || /[›>$%⏵]\s*$/.test(clean) || /[☰○]\s*$/.test(clean)) {
            stdinDelivered = true;
            try { ptyProcess.write(stdinPrompt.replace(/\n$/, submitSeq)); } catch { /* PTY may have exited */ }
          }
        }

        // Push to stream — filter TUI noise for interactive mode
        if (filterState) {
          const filtered = filterInteractivePtyOutput(clean, filterState);
          if (filtered) stdoutStream.push(filtered);
        } else {
          stdoutStream.push(clean);
        }
      });

      // Empty stderr (PTY combines both streams)
      const stderrStream = new Readable({ read() {} });
      stderrStream.push(null);

      const managedProcess: ManagedProcess = {
        kill: () => { try { ptyProcess.kill(); } catch { /* ignore */ } },
        pid,
      };
      this.processes.set(pid, managedProcess);

      // For interactive mode, expose PTY write as a stdin stream for relay
      if (interactive) {
        const ptyWritable = new Writable({
          write(chunk: Buffer | string, _encoding: string, callback: () => void) {
            try { ptyProcess.write(chunk.toString().replace(/\n$/, submitSeq)); } catch { /* PTY may have exited */ }
            callback();
          },
        });
        this.stdinStreams.set(pid, ptyWritable);
      }

      const exitPromise = new Promise<number>((resolveExit) => {
        ptyProcess.onExit(({ exitCode }) => {
          exited = true;
          // Flush remaining filter buffer before closing stream
          if (filterState?.lineBuffer) {
            const final = filterInteractivePtyOutput('\n', filterState);
            if (final) stdoutStream.push(final);
          }
          stdoutStream.push(null);
          this.markExited(pid);
          this.stdinStreams.delete(pid);
          this.ptyHandles.delete(pid);
          setTimeout(() => {
            this.rawSubscribers.delete(pid);
            this.rawRingBuffers.delete(pid);
          }, 10_000);
          resolveExit(exitCode);
        });
      });

      // Stdin delivery: immediate for adapters without delayStdin, otherwise
      // wait for the ready indicator (handled in onData) with a 5s fallback.
      if (stdinPrompt && !delayStdin) {
        setImmediate(() => {
          if (!stdinDelivered && !exited) {
            stdinDelivered = true;
            try { ptyProcess.write(stdinPrompt.replace(/\n$/, submitSeq)); } catch { /* PTY may have exited */ }
          }
        });
      } else if (stdinPrompt && delayStdin) {
        setTimeout(() => {
          if (!stdinDelivered && !exited) {
            stdinDelivered = true;
            try { ptyProcess.write(stdinPrompt.replace(/\n$/, submitSeq)); } catch { /* PTY may have exited */ }
          }
        }, 5000);
      }

      setImmediate(() => {
        resolve({
          pid,
          stdout: stdoutStream,
          stderr: stderrStream,
          stdin: null,
          exitPromise,
        });
      });
    });
  }

  /**
   * Spawn using child_process for standard CLIs.
   */
  private startWithSpawn(adapter: ReturnType<typeof getAdapter>, args: string[], cwd: string, prompt: string, mode: CliMode, promptPolicy?: PromptPolicy): Promise<{
    pid: number;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream | null;
    exitPromise: Promise<number>;
  }> {
    assertExternalAiCliAllowed(adapter.command);
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      const needsStdin = adapter.needsStdin(mode);
      let startSettled = false;

      try {
        child = spawn(adapter.command, args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // shell needed on Windows to resolve .cmd shims (claude.cmd, agy.cmd)
          // Safe: prompts are delivered via stdin, not as command-line arguments
          shell: process.platform === 'win32',
          windowsHide: true,
          env: childEnv(),
        });
      } catch (err) {
        reject(new Error(
          `Failed to spawn ${adapter.displayName}. Is it installed and on PATH? ${err instanceof Error ? err.message : String(err)}`
        ));
        return;
      }

      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error(`Failed to get PID for ${adapter.displayName} process`));
        return;
      }

      const managedProcess: ManagedProcess = {
        kill: (signal?: string) => child.kill(signal as NodeJS.Signals),
        pid,
      };
      this.processes.set(pid, managedProcess);

      const outputDecoder = mode === 'interactive' ? undefined : adapter.createOutputDecoder?.();
      let stdout: NodeJS.ReadableStream = child.stdout!;
      let stderr: NodeJS.ReadableStream = child.stderr!;
      const utf8Decoder = outputDecoder ? new Utf8StreamDecoder() : undefined;
      let transportFailure: string | null = null;
      let lifecycleSettled = false;
      let resolveExit!: (code: number) => void;
      const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve; });
      let decodedStdout: PassThrough | undefined;
      let decodedStderr: PassThrough | undefined;

      const recordTransportFailure = (kind: string, err: unknown): void => {
        if (transportFailure) return;
        const message = err instanceof Error ? err.message : String(err);
        transportFailure = `${kind}: ${message}`;
        logger.error(kind === 'stdin' ? 'cli.stdin.failed' : 'cli.transport.failed', {
          msg: `${adapter.displayName} ${kind} transport failed`,
          provider: adapter.command,
          pid,
          message,
        });
        if (kind !== 'process') {
          try { treeKill(pid, 'SIGTERM'); } catch { /* close/exit owns final cleanup */ }
        }
      };

      const finishOnce = (code: number | null): void => {
        if (lifecycleSettled) return;
        lifecycleSettled = true;
        let effectiveCode = code ?? 1;
        if (outputDecoder && decodedStdout && decodedStderr) {
          try {
            const finalText = utf8Decoder!.end();
            if (finalText) outputDecoder.push(finalText);
            const decoded = outputDecoder.finish(effectiveCode);
            if (decoded.output) decodedStdout.write(decoded.output);
            if (decoded.diagnostic) decodedStderr.write(decoded.diagnostic);
            effectiveCode = decoded.exitCode;
          } catch (err) {
            recordTransportFailure('decoder', err);
            effectiveCode = 1;
          }
          if (transportFailure) decodedStderr.write(`\n${transportFailure}\n`);
          decodedStdout.end();
          decodedStderr.end();
        }
        this.markExited(pid);
        this.stdinStreams.delete(pid);
        resolveExit(transportFailure ? 1 : effectiveCode);
      };

      child.once('error', (err) => {
        recordTransportFailure('process', err);
        if (!startSettled) {
          startSettled = true;
          reject(new Error(`Failed to start ${adapter.displayName}. Is it installed and on PATH? ${err.message}`));
        }
        finishOnce(1);
      });
      child.once('close', finishOnce);

      child.stdin?.on('error', (err) => recordTransportFailure('stdin', err));
      child.stdout?.on('error', (err) => recordTransportFailure('stdout', err));
      child.stderr?.on('error', (err) => recordTransportFailure('stderr', err));

      if (outputDecoder) {
        decodedStdout = new PassThrough();
        decodedStderr = new PassThrough();
        stdout = decodedStdout;
        stderr = decodedStderr;

        child.stdout!.on('data', (chunk: Buffer | string) => {
          try {
            outputDecoder.push(typeof chunk === 'string' ? chunk : utf8Decoder!.write(chunk));
          } catch (err) {
            recordTransportFailure('decoder', err);
          }
        });
        child.stderr!.on('data', (chunk: Buffer | string) => {
          decodedStderr!.write(chunk);
        });
      }

      // Register every process/stream listener before prompt delivery. Writable
      // callback errors and emitted errors converge on the same lifecycle gate.
      if (needsStdin && child.stdin) {
        const encodedPrompt = adapter.encodeStdinPrompt?.(prompt, mode, promptPolicy)
          ?? adapter.formatStdinPrompt(prompt, mode, promptPolicy);
        try {
          child.stdin.write(encodedPrompt, (err) => {
            if (err) recordTransportFailure('stdin', err);
          });
          if (mode === 'interactive') this.stdinStreams.set(pid, child.stdin);
          else child.stdin.end();
        } catch (err) {
          recordTransportFailure('stdin', err);
        }
      } else if (child.stdin) {
        try { child.stdin.end(); } catch (err) { recordTransportFailure('stdin', err); }
      }

      setImmediate(() => {
        if (startSettled) return;
        startSettled = true;
        resolve({
          pid,
          stdout,
          stderr,
          stdin: child.stdin ?? null,
          exitPromise,
        });
      });
    });
  }

  /**
   * Write data to the stdin of an interactive process.
   */
  writeToStdin(pid: number, data: string): boolean {
    const stdin = this.stdinStreams.get(pid);
    if (!stdin || (stdin as any).destroyed) return false;
    stdin.write(data);
    return true;
  }

  /**
   * Stop a CLI process. Uses tree-kill to kill the entire process tree
   * (necessary on Windows where shell: true wraps CLIs in cmd.exe).
   * Sends SIGTERM first, escalates to SIGKILL after 5 seconds.
   */
  async stopClaude(pid: number, persistedIdentity?: ProcessIdentity | null): Promise<StopResult> {
    const proc = this.processes.get(pid);
    if (!proc) {
      if (!isProcessAlive(pid)) {
        logger.debug('process.stop.not-tracked', { msg: `stop requested for exited pid ${pid}`, pid });
        return { status: 'already_exited', pid };
      }
      const verdict = await verifyProcessIdentity(pid, persistedIdentity);
      if (verdict !== 'match') {
        logger.error('process.stop.unresolved', {
          msg: `refusing to signal untracked pid ${pid}: process identity ${verdict}`,
          pid, reason: `process_identity_${verdict}`,
        });
        return { status: 'unresolved', pid, reason: `process_identity_${verdict}` };
      }
      const terminated = await terminateProcessTree(pid);
      return terminated
        ? { status: 'terminated', pid, graceful: false }
        : { status: 'unresolved', pid, reason: 'termination_not_confirmed' };
    }

    const stopStartedAt = Date.now();
    logger.info('process.stop.requested', { msg: `stop requested (SIGTERM) for pid ${pid}`, pid });

    // End stdin stream before killing
    const stdin = this.stdinStreams.get(pid);
    if (stdin) {
      try { stdin.end(); } catch { /* ignore */ }
      this.stdinStreams.delete(pid);
    }

    // Try graceful tree-kill first (kills entire process tree)
    try { treeKill(pid, 'SIGTERM'); } catch { /* ignore */ }

    let forced = false;
    return new Promise<StopResult>((resolve) => {
      // Poll for process exit (exit handler in startWithSpawn/startWithPty deletes from map)
      const checkInterval = setInterval(() => {
        if (!this.processes.has(pid)) {
          clearInterval(checkInterval);
          clearTimeout(killTimer);
          clearTimeout(deadline);
          logger.info('process.stop.confirmed', {
            msg: `pid ${pid} termination confirmed`, pid,
            graceful: !forced,
            durationMs: Date.now() - stopStartedAt,
          });
          resolve({ status: 'terminated', pid, graceful: !forced });
        }
      }, 200);

      // Escalate to SIGKILL after 5 seconds if still alive
      const killTimer = setTimeout(() => {
        forced = true;
        logger.warn('process.stop.forced', {
          msg: `pid ${pid} did not exit on SIGTERM, escalating to SIGKILL`,
          pid,
          durationMs: Date.now() - stopStartedAt,
        });
        try { treeKill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }, 5000);

      // Final deadline: retain ownership when death cannot be confirmed.
      const deadline = setTimeout(() => {
        clearInterval(checkInterval);
        clearTimeout(killTimer);
        logger.error('process.stop.unresolved', {
          msg: `pid ${pid} could not be confirmed terminated within the stop deadline`,
          pid,
          durationMs: Date.now() - stopStartedAt,
        });
        resolve({ status: 'unresolved', pid, reason: 'termination_not_confirmed' });
      }, 7000);
    });
  }

  isRunning(pid: number): boolean {
    return this.processes.has(pid);
  }

  async killAll(): Promise<StopResult[]> {
    const pids = Array.from(this.processes.keys());
    if (pids.length > 0) {
      logger.info('process.kill-all', {
        msg: `terminating ${pids.length} running CLI process(es)`,
        count: pids.length,
      });
    }
    return Promise.all(pids.map((pid) => this.stopClaude(pid)));
  }
}

export const claudeManager = new ClaudeManager();
