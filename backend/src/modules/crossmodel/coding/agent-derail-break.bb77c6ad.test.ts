/**
 * Replay pin — ticket bb77c6ad (mishap, auto-filed at breaker trip
 * 2026-10-22T08:01:53Z; session 19dd22bc-59ef-42db-845b-92f381a932ae
 * "P2: year milestones · Scratch build + verify", run
 * d38eb043-4acc-4311-948c-e9682db7535d; first streak this run).
 *
 * THE INCIDENT: THREE consecutive edit_file refusals, all the IDENTICAL text —
 * "old_string not found in scratch/curriculum/krmoe/kr_extract.py. Read the
 * file and match exactly." — with VARYING new_string payloads (a rewritten
 * `walk_band` docstring; two variants of a `# Expected unique-code counts…`
 * comment block), i.e. the model re-deriving its edit anchor from memory
 * instead of re-reading the file between attempts.
 *
 * VERDICT (this lane, 2026-10-23, evidence-led): MODEL BEHAVIOR — no
 * deterministic framework defect.
 *   · The refusal is edit_file's authored text-mismatch envelope (tools.ts
 *     count === 0), and its failure-shape is BY DESIGN: commit 96f59ca6c
 *     (ticket d2e6b0fb, PR #1815, 2026-10-19) anchored exactly this marker in
 *     FAILURE_MARKERS so a varying-anchor edit loop COUNTS as failure to the
 *     derail breaker — before that, this exact loop shape (varying old_string
 *     under aligned narration) tripped NO breaker leg at all. The streak
 *     filing is the fix working, not a defect.
 *   · The refusal's remedy ("Read the file and match exactly") is correct and
 *     actionable; the model declined it three times — model behavior.
 *   · Self-heal is receipt-proven (get_run_receipts, run d38eb043, observed
 *     2026-10-23): the SAME run later produced verify receipt b8948536
 *     (ok:true) at 12:43:45Z and merges 64efef69 (#104), ab998010 (#105) at
 *     12:44/12:53Z, and session chatTurns show merge 86a6f8a4 (#103) and
 *     ba8077b2 (#116) — no perma-withhold, no run-end; the lane finished its
 *     deliverables.
 *
 * No platform code change; this pin replays the filed failure text against
 * looksLikeToolFailure (the classifier that fed the breaker) and asserts the
 * d2e6b0fb marker still fires, plus the anchor discipline: the marker text
 * QUOTED mid-string (a lane reading this very file, or a doc quoting the
 * refusal) must NOT be failure-shaped.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import { looksLikeToolFailure } from './learnings-index.service';

// The ticket's filed failure text — verbatim (all three were identical).
const FILED_REFUSAL =
  'old_string not found in scratch/curriculum/krmoe/kr_extract.py. Read the file and match exactly.';

describe('replay bb77c6ad — varying-anchor edit_file miss is failure-shaped (d2e6b0fb)', () => {
  it('the filed refusal is failure-shaped to the breaker (streak filing is by design)', () => {
    expect(looksLikeToolFailure(FILED_REFUSAL)).toBe(true);
  });

  it('the marker stays path-general: a spaced path still fires (the .+ class, not \\S+)', () => {
    expect(
      looksLikeToolFailure('old_string not found in docs/my notes draft.md. Read the file and match exactly.'),
    ).toBe(true);
  });

  it('anchor discipline: the refusal QUOTED mid-string is never failure-shaped (a successful read of this file)', () => {
    const quoted = `The pin replays this filed text: "${FILED_REFUSAL}" — note it sits mid-string.`;
    expect(looksLikeToolFailure(quoted)).toBe(false);
  });

  it('a near-miss paraphrase of the authored envelope is NOT failure-shaped (marker precision)', () => {
    // The authored envelope is exact; a model-narrated approximation must not
    // rack phantom streak failures.
    expect(looksLikeToolFailure('The old_string was not found; I will read the file next.')).toBe(false);
  });
});
