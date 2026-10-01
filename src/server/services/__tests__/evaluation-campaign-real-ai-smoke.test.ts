import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptanceNotice, assertInside, parseOptions, selectCandidates, withCleanup, writeReport, type Candidate } from '../../../../scripts/evaluation-campaign-real-ai-support.js';

const roots: string[] = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-campaign-logic-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function candidate(index: number, control: boolean): Candidate {
  return { todoId: `todo-${index}`, assignmentId: `assignment-${index}`, armId: control ? 'control' : 'experiment', control, bucket: control ? 0 : 1, integrity: 'clean' };
}
describe('manual real-AI smoke logic (no providers)', () => {
  it.each([[true, false], [false, true]])('detects both arms in either order: %j', async (first, second) => {
    const candidates: Candidate[] = [];
    const create = vi.fn().mockResolvedValueOnce(candidate(0, first)).mockResolvedValueOnce(candidate(1, second));
    const withdraw = vi.fn();
    const selected = await selectCandidates(create, withdraw, candidates);
    expect(selected.control.control).toBe(true); expect(selected.experiment.control).toBe(false);
    expect(create).toHaveBeenCalledTimes(2); expect(withdraw).not.toHaveBeenCalled();
  });
  it('withdraws duplicates before returning selected execution candidates', async () => {
    const candidates: Candidate[] = [];
    const create = vi.fn().mockResolvedValueOnce(candidate(0, true)).mockResolvedValueOnce(candidate(1, true)).mockResolvedValueOnce(candidate(2, false));
    const withdraw = vi.fn(async (item: Candidate) => { item.integrity = 'excluded'; });
    const selected = await selectCandidates(create, withdraw, candidates);
    expect(selected.control.todoId).toBe('todo-0'); expect(selected.experiment.todoId).toBe('todo-2');
    expect(withdraw).toHaveBeenCalledExactlyOnceWith(candidates[1]);
    expect(selected.extras.map(item => item.integrity)).toEqual(['excluded']);
    expect(selected.control.integrity).toBe('clean'); expect(selected.experiment.integrity).toBe('clean');
  });
  it('stops at 12, preserves bucket sequence, and withdraws every unused candidate', async () => {
    const candidates: Candidate[] = []; let index = 0;
    const create = vi.fn(async () => candidate(index++, false));
    const withdraw = vi.fn(async (item: Candidate) => { item.integrity = 'excluded'; });
    await expect(selectCandidates(create, withdraw, candidates)).rejects.toThrow('assignment_distribution_unlucky');
    expect(create).toHaveBeenCalledTimes(12); expect(withdraw).toHaveBeenCalledTimes(12);
    expect(candidates.map(item => item.bucket)).toEqual(Array(12).fill(1));
    expect(candidates.every(item => item.integrity === 'excluded')).toBe(true);
  });
  it('withdraws created assignments when candidate creation fails', async () => {
    const candidates: Candidate[] = [];
    const create = vi.fn().mockResolvedValueOnce(candidate(0, true)).mockRejectedValueOnce(new Error('injected'));
    const withdraw = vi.fn();
    await expect(selectCandidates(create, withdraw, candidates)).rejects.toThrow('injected');
    expect(withdraw).toHaveBeenCalledExactlyOnceWith(candidates[0]);
  });
  it.each(['PASS', 'FAIL', 'TIMEOUT', 'SKIPPED_ENVIRONMENT'])('writes reviewable machine evidence for %s', status => {
    const root = temporary();
    writeReport(root, { status, candidates: [candidate(0, true)], cleanup: { safe: true }, unknownCost: null });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ status, notice: acceptanceNotice, unknownCost: null, cleanup: { safe: true } });
    expect(report.candidates[0].bucket).toBe(0);
  });
  it.each([false, true])('runs cleanup after success or injected failure: %s', async fail => {
    const root = temporary(), events: string[] = [];
    const result = withCleanup(async () => { events.push('run'); if (fail) throw new Error('injected'); return 'PASS'; }, async () => {
      events.push('cleanup'); writeReport(root, { status: fail ? 'FAIL' : 'PASS', cleanup: { safe: true } });
    });
    if (fail) await expect(result).rejects.toThrow('injected'); else await expect(result).resolves.toBe('PASS');
    expect(events).toEqual(['run', 'cleanup']); expect(fs.existsSync(path.join(root, 'report.json'))).toBe(true);
  });
  it('rejects cleanup paths outside the root, including the root itself', () => {
    const root = temporary(), other = temporary(), inside = path.join(root, 'seed-repo'); fs.mkdirSync(inside);
    expect(() => assertInside(root, inside)).not.toThrow();
    expect(() => assertInside(root, other)).toThrow('outside'); expect(() => assertInside(root, root)).toThrow('outside');
  });
  it('validates optional flags and bounded timeouts', () => {
    expect(parseOptions([])).toMatchObject({ timeout: 900, keep: false, serve: false });
    expect(parseOptions(['--serve', '--implementation-profile=p', '--single-review-profile=r', '--consensus-policy=c', '--timeout=60']))
      .toMatchObject({ keep: true, serve: true, implementationProfile: 'p', singleReviewProfile: 'r', consensusPolicy: 'c', timeout: 60 });
    for (const arg of ['--timeout=0', '--timeout=NaN', '--timeout=90000', '--arm=control']) expect(() => parseOptions([arg])).toThrow();
  });
});
