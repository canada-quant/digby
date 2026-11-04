/**
 * Replay pin — ticket 63e3740e (mishap, auto-filed at breaker trip
 * 2026-10-22T23:55:49Z; session 5f90c628-d3f7-4187-8378-ed9d2ec08ee8
 * "Constant framework R&D — hunt shortfalls", run
 * bbafc5c7-7abe-4c89-8d62-9c26b1d1e2a8; first streak this run).
 *
 * THE INCIDENT: THREE consecutive edit_file refusals, all the IDENTICAL text —
 * "old_string appears 2× in docker-compose.app.yml — it must be unique. Add
 * surrounding context." — against docker-compose.app.yml's TWO near-identical
 * env-forwarding blocks (the ticket's own call args show the attempts aimed at
 * the memory-embed env block whose two sites differ only by comment
 * indentation).
 *
 * VERDICT (this lane, 2026-10-23, evidence-led): MODEL BEHAVIOR with a
 * DETERMINISTIC, CORRECTLY-REPORTED cause — no framework defect.
 *   · The refusal is edit_file's authored count > 1 envelope (tools.ts), and
 *     its failure-shape is BY DESIGN (d2e6b0fb, 96f59ca6c / PR #1815): the
 *     breaker is supposed to see an edit loop that keeps missing.
 *   · The 2× ambiguity was REAL and deterministic: docker-compose.app.yml
 *     forwards the same env names in two near-identical blocks (the emitting
 *     FO session's own live transcript, observed 2026-10-23, says "The
 *     uniqueness failures are deterministic (substring matching across the
 *     two near-identical env blocks). edit_file is off for this round — I'll
 *     do the compose insertion deterministically by line content with python
 *     instead" and then landed the insertion at lines 522 + 1417). The tool
 *     reported the true state and the true remedy (add surrounding context);
 *     the model retried the SAME un-disambiguated anchor three times before
 *     the trip — model behavior on a deterministic input property.
 *   · Self-heal is receipt-proven: the SAME session landed commit bcd71d4c1
 *     ("FO f185: unified-memory embed circuit breaker"), verified on
 *     origin/main this run (git log origin/main), plus state card 5d32060ae.
 *
 * No platform code change; this pin replays the filed text against
 * looksLikeToolFailure and pins the d2e6b0fb uniqueness marker + anchor
 * discipline (quoted text and paraphrases must never count).
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
  'old_string appears 2× in docker-compose.app.yml — it must be unique. Add surrounding context.';

describe('replay 63e3740e — 2×-uniqueness edit_file miss is failure-shaped (d2e6b0fb)', () => {
  it('the filed refusal is failure-shaped to the breaker (streak filing is by design)', () => {
    expect(looksLikeToolFailure(FILED_REFUSAL)).toBe(true);
  });

  it('the marker counts at other multiplicities (3×, 10×) — the \\d+ class', () => {
    expect(
      looksLikeToolFailure('old_string appears 3× in docker-compose.prod.yml — it must be unique. Add surrounding context.'),
    ).toBe(true);
  });

  it('anchor discipline: the refusal QUOTED mid-string is never failure-shaped', () => {
    const quoted = `The run tripped on "${FILED_REFUSAL}" — a deterministic 2× env-block ambiguity.`;
    expect(looksLikeToolFailure(quoted)).toBe(false);
  });

  it('a successful read of a compose file containing duplicated env lines is not failure-shaped', () => {
    const readResult = '      - MEMORY_EMBED_BACKFILL_DISABLED=${MEMORY_EMBED_BACKFILL_DISABLED:-}\n      - MEMORY_EMBED_BACKFILL_BATCH=${MEMORY_EMBED_BACKFILL_BATCH:-}\n';
    expect(looksLikeToolFailure(readResult)).toBe(false);
  });
});
