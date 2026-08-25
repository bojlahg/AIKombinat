import fs from 'fs';
import path from 'path';
import { assertTestRuntimePathAllowed } from '../utils/test-fs-guard.js';
import { MAX_LOG_FILE_BYTES, MAX_RETAINED_LOG_FILES, LOG_FILE_NAME, rotatedFileName } from './paths.js';
import type { LogRecord, LogSink } from './types.js';
import { renderFileLine } from './format.js';

export interface FileSinkOptions {
  dir: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
}

/**
 * Append-only sink with size-based rotation.
 *
 * Writes are buffered and flushed on the next macrotask so logging never sits
 * in the middle of an execution path, but a whole record is always written as
 * one `appendFileSync` call — concurrent messages cannot interleave mid-line.
 * `flushSync` exists for the fatal paths (uncaughtException, shutdown), which
 * must not exit with records still in memory.
 */
export class RotatingFileSink implements LogSink {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private buffer: string[] = [];
  private scheduled = false;
  private currentBytes = 0;
  private initialized = false;
  private disabled = false;
  /** Reported once; a broken log file must not spam the console forever. */
  private reportedFailure = false;

  constructor(options: FileSinkOptions) {
    this.dir = path.resolve(options.dir);
    this.fileName = options.fileName ?? LOG_FILE_NAME;
    this.maxBytes = options.maxBytes ?? MAX_LOG_FILE_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? MAX_RETAINED_LOG_FILES);
    this.filePath = path.join(this.dir, this.fileName);
  }

  get path(): string {
    return this.filePath;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  write(record: LogRecord): void {
    if (this.disabled) return;
    this.buffer.push(renderFileLine(record));
    if (this.scheduled) return;
    this.scheduled = true;
    const timer = setTimeout(() => {
      this.scheduled = false;
      this.flush();
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
  }

  flush(): void {
    if (this.disabled || this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    const chunk = `${pending.join('\n')}\n`;
    try {
      this.ensureReady();
      this.rotateIfNeeded(Buffer.byteLength(chunk, 'utf-8'));
      fs.appendFileSync(this.filePath, chunk, 'utf-8');
      this.currentBytes += Buffer.byteLength(chunk, 'utf-8');
    } catch (err) {
      this.disabled = true;
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        // Deliberately raw: the logger itself is what just failed.
        console.error(
          `[logging] File logging disabled — could not write ${this.filePath}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  close(): void {
    this.flush();
  }

  private ensureReady(): void {
    if (this.initialized) return;
    assertTestRuntimePathAllowed(this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.currentBytes = fs.statSync(this.filePath).size;
    } catch {
      this.currentBytes = 0;
    }
    this.initialized = true;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.currentBytes + incomingBytes <= this.maxBytes) return;
    if (this.currentBytes === 0) return; // a single oversized record still goes through

    // Drop the oldest, then shift every retained file one slot down.
    const oldest = path.join(this.dir, rotatedFileName(this.maxFiles - 1, this.fileName));
    assertTestRuntimePathAllowed(oldest);
    try { fs.rmSync(oldest, { force: true }); } catch { /* nothing to drop */ }

    for (let index = this.maxFiles - 2; index >= 0; index--) {
      const from = path.join(this.dir, rotatedFileName(index, this.fileName));
      const to = path.join(this.dir, rotatedFileName(index + 1, this.fileName));
      assertTestRuntimePathAllowed(from);
      assertTestRuntimePathAllowed(to);
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch { /* keep logging even if one rename loses a race */ }
    }
    this.currentBytes = 0;
  }
}
