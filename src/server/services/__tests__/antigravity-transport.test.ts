import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({ getModelByValue: () => undefined }));

const { AntigravityOutputDecoder, encodeAntigravityStdinPrompt, getAdapter } = await import('../cli-adapters.js');

describe('Antigravity headless stream-json transport', () => {
  it('encodes exactly one NDJSON user event without manual JSON assembly', () => {
    const prompt = 'Line one\n"quoted" and Привет';
    const encoded = encodeAntigravityStdinPrompt(prompt);

    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(encoded)).toEqual({
      event: 'user',
      message: { content: prompt },
    });
    expect(getAdapter('antigravity').encodeStdinPrompt?.(prompt, 'headless')).toBe(encoded);
  });

  it('ignores init and step_update, handles fragmented lines, and preserves final forum JSON exactly', () => {
    const finalResponse = '{"replies":[{"replyTo":"msg-1","content":"Привет"}]}';
    const stream = [
      JSON.stringify({ event: 'init', session: 'agy-session' }),
      JSON.stringify({ event: 'step_update', step: { text: 'thinking' } }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: finalResponse } }),
    ].join('\n') + '\n';
    const decoder = new AntigravityOutputDecoder();

    decoder.push(stream.slice(0, 19));
    decoder.push(stream.slice(19, 67));
    decoder.push(stream.slice(67, -3));
    decoder.push(stream.slice(-3));

    expect(decoder.finish(0)).toEqual({ output: finalResponse, exitCode: 0 });
  });

  it('ignores malformed lines when a valid final result follows', () => {
    const decoder = new AntigravityOutputDecoder();
    decoder.push('{not-json}\n');
    decoder.push(JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'final text' },
    }));

    expect(decoder.finish(0)).toEqual({ output: 'final text', exitCode: 0 });
  });

  it('turns provider ERROR status into a non-zero failure with bounded diagnostics', () => {
    const decoder = new AntigravityOutputDecoder();
    decoder.push(`${JSON.stringify({ event: 'step_update', detail: 'x'.repeat(2_000) })}\n`);
    decoder.push(`${JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'permission denied', response: 'must not escape' },
    })}\n`);

    const decoded = decoder.finish(0);
    expect(decoded.output).toBe('');
    expect(decoded.exitCode).toBe(1);
    expect(decoded.diagnostic).toContain('status=ERROR');
    expect(decoded.diagnostic).toContain('error=permission denied');
    expect(decoded.diagnostic).toContain('exitCode=0');
    expect(decoded.diagnostic!.length).toBeLessThan(1_200);
  });

  it('preserves the real process exit code and reports a missing result safely', () => {
    const decoder = new AntigravityOutputDecoder();
    decoder.push('malformed partial tail');

    const decoded = decoder.finish(7);
    expect(decoded.output).toBe('');
    expect(decoded.exitCode).toBe(7);
    expect(decoded.diagnostic).toContain('status=MISSING_RESULT');
    expect(decoded.diagnostic).toContain('exitCode=7');
    expect(decoded.diagnostic).toContain('malformedLines=1');
  });

  it('accepts a successful result with an empty response', () => {
    const decoder = new AntigravityOutputDecoder();
    decoder.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } }));

    expect(decoder.finish(0)).toEqual({ output: '', exitCode: 0 });
  });
});
