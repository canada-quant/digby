/**
 * TICKET d7e82531 — the injected INDEPENDENT REVIEW reached the working lane
 * SEVERED mid-payload, and the findings past the cut were silently lost.
 *
 * Incident (prod 2026-11-05, coding lane 98f43520): the harness dispatched its
 * pre-finish reviewer, then injected the verdict into the audit message. The
 * lane received only the first FOUR of the reviewer's defects, ending mid-
 * defect-4 behind a bare "[… review report clipped …]". It disclosed this
 * honestly in its persisted final ("any findings beyond the four I saw never
 * reached me") and merged only what it could see.
 *
 * Two defects compounded, and the second is the one that made the loss
 * unrecoverable:
 *  1. reviewFindingsBlock clipped at a hard 6,000 — TIGHTER than the worker
 *     report carrier cap (12,000, report-clip.ts). A verdict the carrier had
 *     delivered intact was severed on the way into the audit message.
 *  2. the carrier's own clip had appended "(… N more chars — the FULL report is
 *     in .digby/session/worker-reports/<f> — read_file it for the rest)", the
 *     ONLY route to the whole review. Slicing the head again DELETED that
 *     pointer, so the lane could not fetch the missing findings even if it had
 *     tried. A second clip must never sever the first clip's lifeboat.
 *
 * MUTATION NOTE (learnings: a read-path test that the fallback tier satisfies
 * proves nothing): the cases below are written so that reverting to the old
 * `report.slice(0, 6000)` + bare marker turns them RED — the 20k verdict case
 * asserts the PATH and the closing verdict survive, and both are exactly what
 * the slice destroyed.
 */

import { reviewFindingsBlock, reviewFindingsBlockIsPartial, reviewFindingsCapChars, REVIEW_FINDINGS_MAX_CHARS, REVIEW_PARTIAL_MARKER } from './independent-review';
import { clipAtBoundary, clippedTail } from './report-clip';

/** A reviewer verdict shaped like the one the ticket lost: findings in the SECOND half. */
function verdictOf(nDefects: number, padding = 0): string {
  const defects = Array.from({ length: nDefects }, (_, i) =>
    `DEFECT ${i + 1}: ${'the devices.yaml row contradicts the measured bind address; the service answers 200 from a third host. '.repeat(1 + padding)}`,
  );
  return [
    'VERDICT: request changes — the exposure claim is wrong.',
    ...defects,
    'VERDICT (closing): defect 4 is security-relevant and blocking; findings 5+ are in the second half.',
  ].join('\n');
}

describe('ticket d7e82531 — the injected review is never severed silently', () => {
  it('an ordinary reviewer verdict (< cap) is delivered WHOLE — no second clip at all', () => {
    // Pre-fix this was the silent-loss window: > 6,000 but < 12,000 reached the
    // lane clipped even though the carrier had it complete.
    const report = verdictOf(20, 2); // comfortably past 6,000, under 12,000
    expect(report.length).toBeGreaterThan(6000);
    expect(report.length).toBeLessThan(REVIEW_FINDINGS_MAX_CHARS);

    const block = reviewFindingsBlock(report);
    expect(block).toContain('DEFECT 20');
    expect(block).toContain('VERDICT (closing)');
    expect(reviewFindingsBlockIsPartial(block)).toBe(false);
  });

  it('a report past the cap keeps its HEAD and its CLOSING VERDICT, and never cuts mid-word', () => {
    const report = verdictOf(200, 3); // ~40k
    expect(report.length).toBeGreaterThan(REVIEW_FINDINGS_MAX_CHARS * 2);

    const block = reviewFindingsBlock(report);
    expect(block).toContain('DEFECT 1');                        // the head survives
    expect(block).toContain('VERDICT (closing)');               // the verdict line survives (head-only cut lost it)
    expect(reviewFindingsBlockIsPartial(block)).toBe(true);     // and it SAYS so
    // The kept head must end on a boundary, not mid-word: the char after the
    // body's opening is never a partial token.
    expect(block).not.toMatch(/DEFECT 1: *the devices\.yaml row contra\b(?!dicts)/);
    // Bounded: the block may exceed the cap only by its framing + the partial marker.
    expect(block.length).toBeLessThan(REVIEW_FINDINGS_MAX_CHARS + 2_000);
  });

  it('THE RECOVERY POINTER SURVIVES (the defect that made the loss unrecoverable)', () => {
    // The carrier (report-clip.ts / delegation.ts) already clipped this at a
    // boundary and named the durable file. The injection must carry that tail
    // forward, not re-slice the head and drop it.
    const full = verdictOf(300, 3);
    const carrier = clipAtBoundary(full, 12_000);
    expect(carrier.omitted).toBeGreaterThan(0);
    const path = '.digby/session/worker-reports/2026-11-05T06-12-50-000Z-reviewer-1-abc123.md';
    const carried = carrier.text + clippedTail(carrier.omitted, `the FULL report is in ${path} — read_file it for the rest`);

    // Default cap == the carrier cap, so the carried report now fits: the whole
    // thing (pointer included) rides through.
    const block = reviewFindingsBlock(carried);
    expect(block).toContain(path);
    expect(block).toContain('read_file it for the rest');
    expect(reviewFindingsBlockIsPartial(block)).toBe(true); // still flagged PARTIAL by the carrier's own clip
  });

  it('a carried pointer survives even when the injection cap is TIGHTER than the carrier cap', () => {
    // The pre-fix geometry: an injection cap below the carrier's. The pointer
    // must be carried forward verbatim — it is the only route to the rest.
    const full = verdictOf(300, 3);
    const carrier = clipAtBoundary(full, 12_000);
    const path = '.digby/session/worker-reports/2026-11-05T06-12-50-000Z-reviewer-1-abc123.md';
    const carried = carrier.text + clippedTail(carrier.omitted, `the FULL report is in ${path} — read_file it for the rest`);

    const block = reviewFindingsBlock(carried, { maxChars: 4_000 });
    expect(block).toContain(path);
    expect(block).toContain('read_file it for the rest');
    // The omitted count is the SUM (carrier's + this clip's), never an undercount.
    expect(block).toMatch(/[… [\d,]+ chars NOT delivered here/);
    expect(block).toContain('PARTIAL');
  });

  it('with NO durable copy the marker tells the lane to say the review was PARTIAL', () => {
    const block = reviewFindingsBlock('x'.repeat(50_000), { maxChars: 4_000 });
    expect(block).toContain(REVIEW_PARTIAL_MARKER);
    expect(block).toContain('no durable copy');
    expect(block).toContain('PARTIAL');
    // Never a bare marker with no instruction.
    expect(block).not.toMatch(/\[… review report clipped …\]/);
  });

  it('an explicit reportPath wins over an unparseable carried tail', () => {
    const block = reviewFindingsBlock('y'.repeat(40_000), { maxChars: 3_000, reportPath: '.digby/session/worker-reports/r.md' });
    expect(block).toContain('.digby/session/worker-reports/r.md');
    expect(block).toContain('read_file it for the rest');
  });

  it('CARRIER OMISSION IS NOT SILENT (review finding B2): a carrier-clipped report still says PARTIAL', () => {
    // REPORT_CLIP_V2_DISABLED=1 makes the carrier raw-slice with NO "(… N more
    // chars)" tail. Without omittedBefore the block would present that head as a
    // complete review — a honesty regression the reviewer caught.
    const head = 'FAIL — defect 1.';
    const block = reviewFindingsBlock(head, { omittedBefore: 37_332, reportPath: '.digby/session/worker-reports/x.md' });
    expect(reviewFindingsBlockIsPartial(block)).toBe(true);
    expect(block).toContain('37332 chars');
    expect(block).toContain('.digby/session/worker-reports/x.md');
  });

  it('a QUOTED clip tail is not mis-peeled (review finding B4) — only a TERMINATING tail is ours', () => {
    // A reviewer quoting an earlier worker's clip tail must not have that
    // quotation deleted, nor its stale path offered as this review's route.
    const quoted = 'Here is what the last worker said:\n\n(… 999 more chars — the FULL report is in .digby/session/worker-reports/GHOST.md — read_file it for the rest)\n\nVERDICT: my own finding stands.';
    const block = reviewFindingsBlock(quoted, { reportPath: '.digby/session/worker-reports/REAL.md' });
    expect(block).toContain('my own finding stands.');                 // body intact
    expect(block).toContain('Here is what the last worker said:');     // quotation preserved
    expect(block).toContain('GHOST.md');                               // …including the quoted span itself
    // Nothing was actually cut, so no PARTIAL stamp and no recovery route is appended.
    expect(reviewFindingsBlockIsPartial(block)).toBe(false);
    expect(block).not.toContain('.digby/session/worker-reports/REAL.md');
    expect(block).not.toMatch(/chars NOT delivered here/);
  });

  it('the stated omission count is EXACT, not a derived complement (review finding B5)', () => {
    const body = Array.from({ length: 400 }, (_, i) => `DEFECT ${i + 1}: the row contradicts the measured bind address and answers 200.`).join('\n');
    const block = reviewFindingsBlock(body, { maxChars: 2_000, reportPath: '.digby/session/worker-reports/x.md' });
    const stated = Number((block.match(/\[… (\d+) chars NOT delivered here/) || [])[1]);
    // Reconstruct: the delivered head + tail are exactly the non-omitted chars.
    const inner = block.split('<<<\n')[1].split('\n>>>')[0];
    const mid = inner.match(/\[… (\d+) chars NOT delivered here — the review resumes below …\]/);
    expect(mid).not.toBeNull();
    const midIndex = mid ? mid.index ?? 0 : 0;
    const headPart = inner.slice(0, midIndex).trimEnd();
    const tailPart = inner.slice(midIndex + (mid ? mid[0].length : 0)).replace(/^\s+/, '').split('\n\n[… independent review')[0].trimEnd();
    expect(stated).toBe(body.length - headPart.length - tailPart.length);
  });

  it('the injection cap NEVER drops below the worker carrier cap (so a raised carrier cap cannot be re-clipped)', () => {
    // If an operator raises WORKER_REPORT_CAP_CHARS, a fixed injection cap would
    // re-create this very ticket: the carrier delivers N chars whole and the
    // injection severs it again. The cap must track the carrier.
    expect(reviewFindingsCapChars({})).toBe(REVIEW_FINDINGS_MAX_CHARS);
    expect(reviewFindingsCapChars({ WORKER_REPORT_CAP_CHARS: '30000' })).toBe(30_000);
    expect(reviewFindingsCapChars({ WORKER_REPORT_CAP_CHARS: '2000' })).toBe(REVIEW_FINDINGS_MAX_CHARS); // floor holds
  });

  it('the legacy maxChars number argument still works (call-compat)', () => {
    const blk = reviewFindingsBlock('FAIL — extra stdout line\n'.repeat(1000), 200);
    expect(blk).toMatch(/INDEPENDENT REVIEW/);
    expect(blk).toMatch(/review report clipped/);
    expect(blk).toMatch(/Do not undo a correct solution/);
  });
});