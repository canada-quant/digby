/**
 * Replay for feedback 5a8093f0 (2026-09-22): the owner-visible lane pace card
 * showed "Harness-measured progress: 200/30,727 (1%)" for the canlegal-bench
 * citator lane — the extractor paired the lane's availability-probe KV cell
 * (HTTP status 200 / response size 30,727 BYTES) as done/total, and the false
 * "1%" drove an owner escalation ("1% is not acceptable"), an acceleration
 * ruling, and a re-planning cycle before the misparse was traced (true state:
 * 294/665 cases verified — 44%).
 *
 * The probe reaches the extractor in two shapes through a lane's reporting
 * idiom, and neither is a work counter:
 *   - the long form        "ALIAS_API http=200 bytes=30727"
 *   - the slash-shorthand  "alias box-side 200/30727"  (status/bytes as a/b —
 *     THIS is the cell that manufactured 200/30,727: a large-total slash pair
 *     sailed past the 2026-09-17 date-guard, which only covered total ≤ 31)
 *
 * Pin: both shapes are ignored, and true progress with explicit context still
 * parses. Extraction site: parseProgressFraction in project-status.service.ts,
 * fed from an in-progress todo's progressNote ?? title.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findMany: jest.fn(), update: jest.fn(async () => ({})) },
  crossModelMessage: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  agentRun: { findMany: jest.fn() },
  codingSchedule: { findMany: jest.fn() },
  eventHook: { findFirst: jest.fn() },
  hookEvent: { findMany: jest.fn() },
  ownerQuestion: { count: jest.fn(), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: jest.fn(),
}));

import { parseProgressFraction } from './project-status.service';

describe('parseProgressFraction — availability-probe cells are never progress (feedback 5a8093f0)', () => {
  it('ignores the incident probe line in its long form ("http=200 bytes=30727")', () => {
    expect(parseProgressFraction('ALIAS_API http=200 bytes=30727')).toBeNull();
    expect(parseProgressFraction('CANON http=200 bytes=8547 · ALIAS http=200 bytes=30727')).toBeNull();
    expect(parseProgressFraction('GET /health status=200, 30727 bytes — alias up')).toBeNull();
  });

  it('ignores the slash-shorthand probe cell that manufactured "200/30,727 (1%)"', () => {
    expect(parseProgressFraction('alias box-side 200/30727')).toBeNull();
    expect(parseProgressFraction('serve cell: canon 200/8547, alias 200/30727 — both up')).toBeNull();
    // The verbatim heartbeat idiom the false card was mined from (status/bytes
    // cells beside real census KVs).
    expect(
      parseProgressFraction(
        'census metas=388 ok=294 fail=94, PIDs 0/0/0, canonical 200/8547 8 models, alias box-side 200/30727, no re-serve',
      ),
    ).toBeNull();
  });

  it('keeps counting true progress that carries explicit context (recall control)', () => {
    // The citator lane's TRUE progress line — the corrected denominator.
    expect(parseProgressFraction('294/665 cases verified')).toEqual({ done: 294, total: 665 });
    // The pre-existing harness fixtures must keep parsing.
    expect(parseProgressFraction('1668/1687,191/219 DONE')).toEqual({ done: 1668, total: 1687 });
    expect(parseProgressFraction('sweep — 1,668 / 1,687 rows done')).toEqual({ done: 1668, total: 1687 });
    // The lane's headnote-track idiom: an HTTP-status-shaped numerator beside a
    // real progress word still counts — only probe context disqualifies.
    expect(parseProgressFraction('8/58 batches = 200/1,424 records')).toEqual({ done: 200, total: 1424 });
    expect(parseProgressFraction('Step 5 of 12 steps complete')).toEqual({ done: 5, total: 12 });
  });

  it('still rejects date-shaped, ratio-shaped, and bare pairs', () => {
    expect(parseProgressFraction('Monitor fire 3 on 9/17 at 19:0xZ')).toBeNull();
    expect(parseProgressFraction('mix ratio 2/4 by volume')).toBeNull();
    expect(parseProgressFraction('meeting 3/4')).toBeNull();
    expect(parseProgressFraction('bump to v1.2/3')).toBeNull();
  });

  // Adversarial-review hardening (same ticket, second round) — the first-pass
  // guard's probe test read the whole ±24-char window, which (F1) suppressed
  // real progress beside domain vocabulary and (F2) missed bare-word probe
  // cells. The probe test now binds to the pair's OWN clause (delimited by
  // ; | • · — or newline) with a strong-progress-word override.
  it('review F2: a bare-word probe cell yields to the real counter in the next clause', () => {
    expect(parseProgressFraction('HTTP 200/30727 bytes; 294/665 cases verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('serve 200/30727 | 294/665 cases verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('status 200/30727 · 294/665 cases verified')).toEqual({ done: 294, total: 665 });
  });

  it('review F1: probe vocabulary no longer suppresses real progress with strong context', () => {
    // The canlegal citator's own domain words ("canon", "canonical") must not
    // disable its own progress bar.
    expect(parseProgressFraction('canonical citator: 294/665 cases verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('canon law citator — 294/665 cases verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('ping ok; 12/48 rows done')).toEqual({ done: 12, total: 48 });
    expect(parseProgressFraction('latency: p99 1.2s; 294/665 cases verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('probes off; 1668/1687 rows done')).toEqual({ done: 1668, total: 1687 });
    expect(parseProgressFraction('vantage worker: 1668/1687 rows done')).toEqual({ done: 1668, total: 1687 });
  });

  it('a weak word ("ok"/"ready") never rescues a probe cell', () => {
    expect(parseProgressFraction('alias box-side 200/30727 ok')).toBeNull();
    expect(parseProgressFraction('canon 200/8547 ready')).toBeNull();
  });

  // Framework Operator (5f90c628) live baseline, measured on the production
  // dist 2026-09-22 07:55Z — every DEFECT shape below parsed pre-fix; each is
  // pinned to its post-fix expectation.
  it('operator baseline: "=" -terminated probe prefixes are ignored', () => {
    expect(parseProgressFraction('CANON=200/8547')).toBeNull();
    expect(parseProgressFraction('ALIAS_API=200/30727')).toBeNull(); // underscore-joined name still matches the probe vocabulary
    expect(parseProgressFraction('ALIAS/200/30727')).toBeNull(); // '/'-prefixed numerator: lookbehind blocks it
  });

  it('operator baseline: the quoted/echoed probe pair NEVER wins over the true count (dominance killed)', () => {
    expect(parseProgressFraction('ALIAS_API=200/30727 — true count 294/665 verified ok')).toEqual({
      done: 294,
      total: 665,
    });
    expect(parseProgressFraction('CANON=200/8547 — 294/665 verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('canon=200/8547, 294/665 cases verified')).toEqual({ done: 294, total: 665 });
    expect(parseProgressFraction('294/665 verified ok, 371 fetches pending')).toEqual({ done: 294, total: 665 });
  });

  it('operator canonical fixture: the live corrective note no longer re-triggers the defect', () => {
    // Verbatim progressNote of canlegal-bench todo 69e5f568 (updated 2026-09-22
    // 06:48:33Z) — the note QUOTES the false pair, and pre-fix that quote
    // re-parsed as {200,30727}, which is why the live card still rendered
    // "200/30,727 (1%)" at 07:57Z. Post-fix the quoted pair must never win;
    // "294 ok / 371 pending" is not a fraction shape ("ok" breaks adjacency),
    // so null is the defensible acceptance (operator ruling).
    const canonical =
      'Pace corrected: worklist 665 cases, 294 ok / 371 pending (94 retry_fail + 277 unattempted) — ' +
      '"200/30,727 (1%)" was a misparse of ALIAS_API bytes=30727. GO per oq_2df71b13 (supervisor): Mac residential';
    const got = parseProgressFraction(canonical);
    expect(got).not.toEqual({ done: 200, total: 30727 });
    expect(got).toBeNull();
  });
});
