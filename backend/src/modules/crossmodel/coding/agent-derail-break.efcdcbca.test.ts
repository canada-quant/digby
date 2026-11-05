/**
 * Replay pin — ticket efcdcbca (mishap, auto-filed at breaker trip
 * 2026-10-22T19:46:06Z; session b4d89c80-763b-482e-abf2-0f2f49b3f25f
 * "2/6 Re-verify memory budget fresh · Verify…", run
 * 5bd86a40-e767-493b-a004-12107da6de42; first streak this run; the lane's
 * reasoning named finish_run).
 *
 * THE INCIDENT: TWO filed edit_file refusals, both the IDENTICAL text —
 * "old_string not found in .digby/rules/00-current-state.md. Read the file
 * and match exactly." — with VARYING new_string payloads (a `## ⚠ CURRENT
 * BANNER (2026-10-22 ~19:45Z …)` state banner, and a full-file rewrite
 * starting `# Current state (always injected)`). The target is the lane's
 * OWN injected state file, whose on-disk content is rewritten by every
 * firing of the lane's 4h cadence — a structurally MOVING anchor.
 *
 * VERDICT (this lane, 2026-10-23, evidence-led): MODEL BEHAVIOR — no
 * deterministic framework defect.
 *   · Same class as bb77c6ad: the refusal is edit_file's authored count === 0
 *     envelope, failure-shaped BY DESIGN since d2e6b0fb (96f59ca6c, PR #1815)
 *     so a varying-anchor edit loop counts to the breaker. The filing is the
 *     guard working.
 *   · The anchor moved underneath the model (the state file is rewritten
 *     each firing), but the tool's remedy — read the file, match exactly —
 *     is exactly right for a moving target, and the model did not take it
 *     before the trip. Model behavior, not a preflight/guard defect.
 *   · Self-heal is receipt-proven (get_run_receipts, chat b4d89c80, observed
 *     2026-10-23): AFTER the 19:46Z streak the same session committed
 *     917dc650 (git_commit 4e92d14, 23:27Z) and c753c64 (23:45Z) on branch
 *     digby/b4d89c80-verify-guard, pushed 6d5deae5 + 62cad5e6, opened and
 *     MERGED PR #14 (merge fe706062, example-org/cql-accelerator, 23:46Z) and
 *     completed further runs through 00:30Z Oct 23. No perma-withhold.
 *
 * No platform code change; this pin replays the filed text against
 * looksLikeToolFailure and pins the d2e6b0fb marker + anchor discipline for
 * the dotfile-path shape this ticket filed.
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

// The ticket's filed failure text — verbatim (both filed rows identical).
const FILED_REFUSAL =
  'old_string not found in .digby/rules/00-current-state.md. Read the file and match exactly.';

describe('replay efcdcbca — moving-anchor (own state file) edit_file miss is failure-shaped', () => {
  it('the filed refusal is failure-shaped to the breaker (streak filing is by design)', () => {
    expect(looksLikeToolFailure(FILED_REFUSAL)).toBe(true);
  });

  it('anchor discipline: the refusal QUOTED mid-string is never failure-shaped', () => {
    const quoted = `Earlier the lane saw: "${FILED_REFUSAL}" and should have re-read the file.`;
    expect(looksLikeToolFailure(quoted)).toBe(false);
  });

  it('a successful read of a state file that merely MENTIONS old_string is not failure-shaped', () => {
    const readResult = '# Current state (always injected)\n\nThe edit replaces old_string with new_string in .digby/rules/00-current-state.md.\n';
    expect(looksLikeToolFailure(readResult)).toBe(false);
  });
});
