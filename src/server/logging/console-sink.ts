import { renderConsoleLine } from './format.js';
import type { LogRecord, LogSink } from './types.js';

export interface ConsoleSinkOptions {
  /** Injectable for tests; production writes to the real console. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * The terminal the user started AIKombinat from is the primary diagnostic
 * surface — warnings and errors go to stderr so a piped run can separate them.
 */
export class ConsoleSink implements LogSink {
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;

  constructor(options: ConsoleSinkOptions = {}) {
    this.out = options.out ?? ((line: string) => console.log(line));
    this.err = options.err ?? ((line: string) => console.error(line));
  }

  write(record: LogRecord): void {
    const line = renderConsoleLine(record);
    if (record.level === 'error' || record.level === 'warn') {
      this.err(line);
    } else {
      this.out(line);
    }
  }
}
