/**
 * Chunk-safe line reader for child-process stdout/stderr.
 *
 * Stream `data` chunks are byte-boundary events, not line-boundary events: a
 * single JSON event can arrive split across two or three chunks, and one chunk
 * can carry several complete lines plus a partial tail. Naive
 * `chunk.split('\n')` handling silently drops or corrupts those events.
 *
 * This helper keeps a persistent buffer, emits only complete lines, and carries
 * the incomplete tail into the next chunk.
 */
export interface LineReader {
  /** Emit any buffered partial line. Idempotent. */
  flush(): void;
  /**
   * Resolves once the stream has finished delivering data ('end'/'close'/
   * 'error'). Callers that also await a process exit promise should await this
   * before reading the collected output: process exit and stream drain are
   * independent events, and exit can win the race.
   *
   * Resolves immediately for objects that are not Node readable streams (e.g.
   * a bare EventEmitter), so callers never block on something that will not
   * emit 'end'.
   */
  done: Promise<void>;
}

export function readLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): LineReader {
  if (typeof stream.setEncoding === 'function') {
    stream.setEncoding('utf8');
  }

  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    const tail = buffer;
    buffer = '';
    if (tail.trim()) onLine(tail);
  };

  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onLine(line);
    }
  });

  stream.on('end', flush);

  const isReadableStream = typeof (stream as { readableEnded?: unknown }).readableEnded === 'boolean';
  const done: Promise<void> = isReadableStream
    ? new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        stream.on('end', finish);
        stream.on('close', finish);
        stream.on('error', finish);
      })
    : Promise.resolve();

  return { flush, done };
}

/**
 * Awaits stream drain without letting a stream that never closes (e.g. one
 * belonging to a force-killed process) block the caller forever.
 */
export async function drainReaders(readers: LineReader[], timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    await Promise.race([Promise.all(readers.map((r) => r.done)).then(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
