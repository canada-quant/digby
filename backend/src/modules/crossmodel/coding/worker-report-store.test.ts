/**
 * Ticket 95210e7e — a completed FOREGROUND delegation's report must survive a
 * mid-turn server restart (deploy), and the [COMPLETED DELEGATIONS THIS RUN]
 * resume note must name that durable copy instead of a 200-char head.
 *
 * Evidence the ticket carries: a reviewer had finished, a deploy restarted the
 * server, and the regenerated turn's note listed it as COMPLETED with only its
 * first sentence — `.digby/session/worker-reports/` held no file because the
 * write existed only on the OVER-CAP path, session memory holds only tool
 * outputs, and delegate_status covers background handles only. The review had
 * to be re-derived by hand against the live system.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  persistWorkerReport, workerReportRelPath, WORKER_REPORT_DIR,
} from './worker-report-store';
import { renderCompletedDelegationsNote, COMPLETED_DELEGATIONS_MARKER, NOTE_REPORT_BUDGET_CHARS } from './delegation';

let worktree: string;
beforeAll(async () => { worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-worker-reports-')); });
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });

/** A reviewer verdict shaped like the one the ticket lost: findings in the SECOND half. */
const verdict = [
  'The selector fix itself is real, landed, and correct — the predicate is in the right place and the guard fires.',
  'But the second half of the diff has problems:',
  '1. finding one: the retry path swallows a rejection.',
  '2. finding two: the cap is applied before the boundary search.',
  '3. finding three: no test pins the empty-report case.',
  'VERDICT: request changes — findings 1-3 must be fixed.',
].join('\n');

describe('persistWorkerReport (ticket 95210e7e)', () => {
  test('a NORMAL-sized report is written to disk (the pre-fix bug: only over-cap reports were persisted)', async () => {
    // 900 chars is far under the 12,000 clip cap — the class that was lost.
    const short = verdict.slice(0, 900);
    expect(short.length).toBeLessThan(12_000);
    const rel = await persistWorkerReport({ worktree, role: 'reviewer', title: 'Adversarial review', ordinal: 1, report: short });

    expect(rel).not.toBeNull();
    expect(rel!.startsWith(`${WORKER_REPORT_DIR}/`)).toBe(true);
    expect(rel!).toMatch(/-reviewer-1-[0-9a-f]{6}\.md$/);
    const body = await fs.readFile(path.join(worktree, rel!), 'utf8');
    expect(body).toContain('Adversarial review (reviewer worker report)');
    expect(body).toContain(short); // the WHOLE report, byte for byte
  });

  test('the full report lands on disk beyond the clip cap too — nothing is truncated on the durable copy', async () => {
    const long = `${verdict}\n${'filler evidence line.\n'.repeat(900)}`;
    expect(long.length).toBeGreaterThan(12_000);
    const rel = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 2, report: long });
    const body = await fs.readFile(path.join(worktree, rel!), 'utf8');
    expect(body).toContain('VERDICT: request changes — findings 1-3 must be fixed.');
    expect(body.length).toBeGreaterThanOrEqual(long.length);
  });

  test('the report survives a RESTART: a fresh read from a new process finds the complete verdict', async () => {
    // Same worktree, no in-memory state — this is what the resumed run sees.
    const rel = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 3, report: verdict });
    const reread = await fs.readFile(path.join(worktree, rel!), 'utf8');
    expect(reread).toContain('finding three: no test pins the empty-report case.'); // the lost second half
    expect(reread).toContain('VERDICT: request changes');
  });

  test('ordinals keep two same-role reports apart', async () => {
    const a = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 11, report: 'A report', now: new Date('2026-11-05T02:00:00Z'), rand: 'aaaaaa' });
    const b = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 12, report: 'B report', now: new Date('2026-11-05T02:00:00Z'), rand: 'bbbbbb' });
    expect(a).not.toBe(b);
    expect(a!).toMatch(/-reviewer-11-aaaaaa\.md$/);
    expect(b!).toMatch(/-reviewer-12-bbbbbb\.md$/);
  });

  test('empty report / no worktree → null (nothing to write, never a throw)', async () => {
    expect(await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 4, report: '   ' })).toBeNull();
    expect(await persistWorkerReport({ worktree: '', role: 'reviewer', ordinal: 5, report: 'x' })).toBeNull();
  });

  test('a filesystem failure is swallowed (persistence must never break a run)', async () => {
    // A regular FILE where the directory must go → mkdir fails fast with
    // ENOTDIR, so the write returns null instead of throwing into the run.
    const notADir = path.join(worktree, 'not-a-dir');
    await fs.writeFile(notADir, 'x', 'utf8');
    const rel = await persistWorkerReport({ worktree: notADir, role: 'reviewer', ordinal: 6, report: verdict });
    expect(rel).toBeNull();
  });

  test('the path shape is <ts>-<role>-<n>-<rand>.md', () => {
    const rel = workerReportRelPath('reviewer', 7, new Date('2026-11-05T02:19:22.042Z'), 'abc123');
    expect(rel).toBe(`${WORKER_REPORT_DIR}/2026-11-05T02-19-22-042Z-reviewer-7-abc123.md`);
    const evil = workerReportRelPath('reviewer/../evil', 1, new Date(), 'abc123');
    expect(evil.startsWith(`${WORKER_REPORT_DIR}/`)).toBe(true);
    expect(evil).not.toContain('..'); // sanitised, not merely prefixed
  });

  test('COLLISION PROOF (review finding 2): same role + same ordinal + same millisecond never overwrite', async () => {
    // delegate_parallel prepares every task before awaiting any, so same-role
    // workers in one batch share a millisecond. Before the random suffix the
    // second write SILENTLY replaced the first while the note still pointed at
    // the survivor — a lost verdict that looks like success.
    const now = new Date('2026-11-05T03:00:00.000Z');
    const a = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 3, report: 'WORKER A verdict', now });
    const b = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 3, report: 'WORKER B verdict', now });
    expect(a).not.toBe(b);
    expect(await fs.readFile(path.join(worktree, a!), 'utf8')).toContain('WORKER A verdict');
    expect(await fs.readFile(path.join(worktree, b!), 'utf8')).toContain('WORKER B verdict');
  });

  test('the writer leaves a self-ignore marker so a fresh clone never stages reports (review finding 3)', async () => {
    const rel = await persistWorkerReport({ worktree, role: 'reviewer', ordinal: 21, report: 'x' });
    const marker = await fs.readFile(path.join(worktree, WORKER_REPORT_DIR, '.gitignore'), 'utf8');
    expect(marker.trim()).toBe('*');
    expect(rel).not.toBeNull();
  });
});

describe('renderCompletedDelegationsNote — the resume note names the durable report (ticket 95210e7e)', () => {
  test('a durable copy turns the note into a POINTER, not a head fragment', () => {
    const note = renderCompletedDelegationsNote([{
      title: 'Adversarial review', role: 'reviewer', status: 'done',
      summary: verdict, reportPath: '.digby/session/worker-reports/2026-11-05T02-00-00Z-reviewer-1.md',
    }]);
    expect(note).toContain(COMPLETED_DELEGATIONS_MARKER);
    expect(note).toContain('FULL REPORT (durable): .digby/session/worker-reports/2026-11-05T02-00-00Z-reviewer-1.md');
    expect(note).toContain('read_file it for the complete text');
    expect(note).toContain('do NOT re-derive this work');
    // Pre-fix, the note was a 200-char slice; the pointer replaces that.
    expect(note).not.toContain('second half of the diff has problems:\n1.'); // not the raw block
  });

  test('NO durable copy → the note carries the report INLINE (it is the only surviving copy)', () => {
    const note = renderCompletedDelegationsNote([{
      title: 'Adversarial review', role: 'reviewer', status: 'done', summary: verdict, report: verdict,
    }]);
    // The whole verdict — findings in the SECOND half included — survives.
    expect(note).toContain('finding one: the retry path swallows a rejection.');
    expect(note).toContain('finding three: no test pins the empty-report case.');
    expect(note).toContain('VERDICT: request changes — findings 1-3 must be fixed.');
  });

  test('an over-budget inline report is bounded AND says so plainly (never a silent head)', () => {
    const huge = `HEAD-MARKER\n${'y'.repeat(30_000)}\nTAIL-MARKER`;
    const note = renderCompletedDelegationsNote([{ title: 'Big', role: 'explorer', status: 'done', summary: huge, report: huge }]);
    expect(note).toContain('HEAD-MARKER');
    expect(note).not.toContain('TAIL-MARKER');
    expect(note).toMatch(/more chars were cut from this note and no durable copy exists/);
    expect(note).toContain('treat the worker\'s report as PARTIAL');
  });

  test('the inline budget is shared across entries, so one huge report cannot starve the rest', () => {
    const huge = 'z'.repeat(50_000);
    const note = renderCompletedDelegationsNote([
      { title: 'First', role: 'explorer', status: 'done', summary: huge, report: huge },
      { title: 'Second', role: 'reviewer', status: 'done', summary: 'Second-half finding survived.', report: 'Second-half finding survived.' },
    ]);
    expect(note).toContain('Second-half finding survived.');
    expect(note).toContain('- Second ');
  });

  test('the note strips the worker JSON status footer itself (review finding 5: previously unpinned)', () => {
    // The budget must go to findings, not to envelope syntax. Pre-fix this was
    // only true because the CALLER happened to pass prose — mutating the caller
    // back to the raw text kept every test green, so nothing pinned it.
    const raw = 'SECOND-HALF FINDING: the retry swallows a rejection.\n```json\n{"status":"done"}\n```';
    const note = renderCompletedDelegationsNote([{ title: 'Rev', role: 'reviewer', status: 'done', summary: raw, report: raw }]);
    expect(note).toContain('SECOND-HALF FINDING: the retry swallows a rejection.'); // prose kept
    expect(note).not.toContain('```json');
    expect(note).not.toContain('"status":"done"');
  });

  test('a summary-only entry (legacy shape) still renders — backward compatible', () => {
    const note = renderCompletedDelegationsNote([{ title: 'Verify pass', role: 'verifier', status: 'done', summary: 'All green.' }]);
    expect(note).toContain('- Verify pass (verifier) → done: All green.');
  });

  // ── Mutation-proven gaps (independent adversarial review, ticket 95210e7e) ──
  // Each of these stayed GREEN with its behaviour deleted before the test existed.

  test('POINTER BRANCH IS CHARGED (review finding 1): 12 durable entries cannot inject ~9 KB of heads', () => {
    // Pre-fix the pointer branch never decremented `budget`, so slice(-12) × a
    // 600-char head = 7.2 KB of provenance injected into EVERY dispatch
    // checkpoint, immediately before the largest prompt the loop builds.
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `w${i}`, role: 'reviewer', status: 'done',
      summary: 's'.repeat(2_000),
      reportPath: `.digby/session/worker-reports/x-${i}.md`,
    }));
    const note = renderCompletedDelegationsNote(many);
    // 8,000 chars of budget + 12 pointer lines (~130 chars each) + labels.
    expect(note.length).toBeLessThan(11_000);
    const heads = note.split('\n').filter(l => l.startsWith('- '));
    expect(heads).toHaveLength(12);
    expect(heads.every(l => l.length <= 900)).toBe(true); // head is budget-bounded, not a flat 600
  });

  test('STARVATION FLOOR (review finding 7): one huge report cannot collapse a later verdict to a 200-char head', () => {
    // The whole point of the ticket: a multi-entry note must never reduce a
    // worker's verdict to its first sentence. A shared budget with no floor did
    // exactly that for entry 2+ — reintroducing the original defect.
    const huge = 'z'.repeat(50_000);
    const note = renderCompletedDelegationsNote([
      { title: 'First', role: 'explorer', status: 'done', summary: huge, report: huge },
      { title: 'Second', role: 'reviewer', status: 'done', summary: 'FINDING: retry swallows a rejection.', report: 'FINDING: retry swallows a rejection.' },
    ]);
    expect(note).toContain('FINDING: retry swallows a rejection.');
    expect(note).not.toContain('the rest was not retained');
  });

  test('the note never exceeds the documented budget by more than its pointer overhead', () => {
    const body = 'q'.repeat(20_000);
    const note = renderCompletedDelegationsNote([{ title: 'Big', role: 'explorer', status: 'done', summary: body, report: body }]);
    expect(note.length).toBeLessThan(NOTE_REPORT_BUDGET_CHARS + 1_500); // budget + preamble + tail marker
  });
});
