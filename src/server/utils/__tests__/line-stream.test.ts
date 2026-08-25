import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { readLines, drainReaders } from '../line-stream.js';

describe('readLines', () => {
  it('reassembles a line split across two chunks', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    const reader = readLines(stream, (line) => lines.push(line));

    stream.emit('data', '{"type":"assis');
    expect(lines).toEqual([]);
    stream.emit('data', 'tant"}\n');

    expect(lines).toEqual(['{"type":"assistant"}']);
    reader.flush();
    expect(lines).toEqual(['{"type":"assistant"}']);
  });

  it('reassembles a line split across three chunks', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));

    stream.emit('data', '{"a":');
    stream.emit('data', '1,"b"');
    stream.emit('data', ':2}\n');

    expect(lines).toEqual(['{"a":1,"b":2}']);
  });

  it('emits several complete lines and carries the partial tail over', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));

    stream.emit('data', 'one\ntwo\nthr');
    expect(lines).toEqual(['one', 'two']);

    stream.emit('data', 'ee\nfour');
    expect(lines).toEqual(['one', 'two', 'three']);

    stream.emit('data', '\n');
    expect(lines).toEqual(['one', 'two', 'three', 'four']);
  });

  it('flushes an unterminated tail on end', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));

    stream.emit('data', 'complete\nno trailing newline');
    stream.emit('end');

    expect(lines).toEqual(['complete', 'no trailing newline']);
  });

  it('flush() is idempotent', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    const reader = readLines(stream, (line) => lines.push(line));

    stream.emit('data', 'tail only');
    reader.flush();
    reader.flush();
    reader.flush();

    expect(lines).toEqual(['tail only']);
  });

  it('ignores blank lines', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));

    stream.emit('data', 'a\n\n \nb\n');

    expect(lines).toEqual(['a', 'b']);
  });

  it('handles Buffer chunks', () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));

    stream.emit('data', Buffer.from('buffered line\n', 'utf8'));

    expect(lines).toEqual(['buffered line']);
  });

  it('resolves done for real readable streams after end', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const reader = readLines(stream, (line) => lines.push(line));

    stream.write('late line\n');
    stream.end();

    await drainReaders([reader]);
    expect(lines).toEqual(['late line']);
  });

  it('resolves done immediately for non-stream emitters', async () => {
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const reader = readLines(stream, () => {});
    await expect(Promise.race([
      reader.done.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('timeout'), 50)),
    ])).resolves.toBe('resolved');
  });
});
