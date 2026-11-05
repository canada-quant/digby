/**
 * PIN (FO firing 96, 2026-10-07) — journal_failure_fanout_4h must print the
 * cross-chat fanout rollup of the journal-failure window NATIVELY, so no
 * firing ever hand-counts "how many distinct chats hit guard strikes this
 * window" again.
 *
 * THE GAP THIS PINS: the f94 bake gave journal_failures_4h a per-row
 * recurrence_7d, answering "is THIS chat a repeat offender" — but the
 * fleet-wide question stayed with the eye. f96 paid exactly that tax: 9 rows
 * across 5 distinct chats (29dd7893, 1c2b28d6, 4d9661a7, 0037460b, bb8f1073),
 * every row individually under the recurrence >= 20 bar, and the distinct-chat
 * count derived BY HAND from the 15-row list. The exact by-eye burden the f64
 * doctrine exists to remove.
 *
 * THE FIX (firing 96, 27th f64 bake): a journal_failure_fanout_4h section —
 * ONE row per window: distinct_chats, rows, top_chat (the noisiest chat,
 * ties broken by newest failure) and top_chat_recurrence_7d (that chat's FULL
 * 7d failure-row count). Verdict ladder: ESCALATE at distinct_chats >= 8;
 * 'top_recurrence' at distinct_chats >= 4 AND top_chat_recurrence_7d >= 20
 * (points the eye at the journal_failures_4h recurring row); else ok. Zero
 * failure rows in the window prints nothing (section vanishes, same shape as
 * the other *_4h sections).
 *
 * CALIBRATION (measure-first, box A probe-f96-fanout.js, 2026-10-07T22:4xZ):
 * 37 non-empty 4h buckets over 7 days — median distinct_chats 4, p90 ~7.8,
 * max 13 (the 2026-10-06 00:00 guard-era bucket). A bar at 8 trips on 3/37
 * buckets, each a real fleet-wide fanout event; busy-but-healthy windows stay
 * below it. Same top-heavy-distribution discipline as f94's recurrence bar
 * (>= 20, not the median).
 *
 * Live validation (box A, pre-deploy, probe-f96-section.js verbatim SQL,
 * 2026-10-07T22:46Z): the current window prints distinct_chats=5, rows=9,
 * top_chat=1c2b28d6, top_chat_recurrence_7d=24, verdict top_recurrence — the
 * rollup caught what f96's hand adjudication under-called ("ok"): the top
 * offender IS over the f94 recurrence bar, and the rung points at its
 * journal_failures_4h recurring row (its per-row recurrence_7d prints 23 —
 * self-excluding — vs the rollup's 24, this window's own rows included).
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f95 pins): the
 * shipped audit declares the section, its verdict ladder and bars, and a JS
 * model of the ladder reproduces the live window plus synthetic regimes.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92–f95 pin tests declare top-level fs/path the same way)

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const AUDIT = path.join(repoRoot(__dirname), 'scripts/framework-audit/audit-live-state.js');
const src = fs.readFileSync(AUDIT, 'utf8');

/** The section's SQL, extracted from the shipped audit verbatim. */
function sectionSql(): string {
  const m = src.match(/sec\('journal_failure_fanout_4h', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('journal_failure_fanout_4h section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

describe('PIN f96: journal_failure_fanout_4h rollup bake (27th f64 bake)', () => {
  test('the section exists and is a single-row rollup (aggregate outer, no GROUP BY in the outer query)', () => {
    expect(sql).toContain('AS distinct_chats');
    expect(sql).toContain('AS top_chat');
    expect(sql).toContain('AS top_chat_recurrence_7d');
    expect(sql).toContain("AS verdict FROM (");
    // the outer query must not GROUP BY (one row per window, not per chat)
    const outer = sql.slice(0, sql.indexOf('END AS verdict'));
    expect(sql.indexOf('END AS verdict')).toBeGreaterThan(-1); // anchor found
    expect(outer).not.toContain('GROUP BY');
  });

  test('ESCALATE bar counts the ADJUDICATED population (f101 correction: escalate_chats >= 2 — two dead-end chats; the raw >= 8 distinct_chats bar fired 4x/7d on guard-note storms with zero adjudicated chats)', () => {
    expect(sql).toMatch(/WHEN f\.escalate_chats >= 2 THEN 'ESCALATE'/);
    expect(sql).toContain('AS escalate_chats');
    // the raw count is kept for context, not as the ESCALATE key
    expect(sql).toMatch(/WHEN f\.distinct_chats >= 4 AND f\.top_chat_recurrence_7d >= 20 THEN 'top_recurrence'/);
    expect(sql.indexOf("'ESCALATE'")).toBeLessThan(sql.indexOf("'top_recurrence'"));
  });

  test("the 'top_recurrence' rung points at the f94 per-row recurring seam", () => {
    expect(sql).toMatch(/WHEN f\.distinct_chats >= 4 AND f\.top_chat_recurrence_7d >= 20 THEN 'top_recurrence'/);
    // and it tests AFTER the ESCALATE rung (branch order)
    expect(sql.indexOf("'ESCALATE'")).toBeLessThan(sql.indexOf("'top_recurrence'"));
  });

  test('the fanout counts DISTINCT full chatIds over the 4h window, failures-array non-empty', () => {
    expect(sql).toMatch(/COUNT\(DISTINCT j\."chatId"\)::int AS distinct_chats/);
    expect(sql).toContain(`j."createdAt" > now() - interval '4 hours'`);
    expect(sql).toContain('array_length(j.failures, 1) > 0');
  });

  test('top_chat breaks ties by newest failure (count DESC, createdAt DESC, LIMIT 1)', () => {
    expect(sql).toMatch(/GROUP BY j2\."chatId" ORDER BY COUNT\(\*\) DESC, MAX\(j2\."createdAt"\) DESC LIMIT 1/);
  });

  test('top_chat_recurrence_7d counts the top chat over 7 days on the FULL chatId join — never LEFT(,8) on a JOIN (the f79 trap; the one ::text,8 is the top_chat DISPLAY column)', () => {
    expect(sql).toMatch(/j2\."chatId" = \(SELECT j3\."chatId"/);
    expect(sql).toContain(`j2."createdAt" > now() - interval '7 days'`);
    // the JOIN predicate must use the full id: no truncated chatId comparison.
    // NB: the SQL is a single line, so an "= .*" look-right regex would falsely
    // match the ">= 8 THEN" verdict rung against the display column — only the
    // truncation-immediately-before-= shape is the trap.
    expect(sql).not.toMatch(/"chatId"::text,8\)\s*=/);
  });

  test('the verdict CASE reads subquery aliases (f61 rule: SELECT aliases are not visible to sibling arms)', () => {
    // the outer CASE must reference f.* — not restate the aggregates
    const iCase = sql.indexOf('CASE WHEN f.escalate_chats');
    const iEnd = sql.indexOf('END AS verdict', iCase);
    expect(iCase).toBeGreaterThan(-1);
    expect(iEnd).toBeGreaterThan(iCase);
    const verdictCase = sql.slice(iCase, iEnd);
    expect(verdictCase).not.toContain('COUNT(DISTINCT');
  });

  test('the pre-existing journal_failures_4h per-row bake (f94) is intact', () => {
    const m = src.match(/sec\('journal_failures_4h', \(\) => q\(`([^`]+)`\)\)/);
    expect(m).toBeTruthy();
    const rowSql = m![1];
    expect(rowSql).toContain('AS recurrence_7d');
    expect(rowSql).toContain("'live:agent_behavior:recurring'");
  });
});

/**
 * JS model of the shipped verdict ladder. Inputs mirror what the SQL reads:
 * the window's failure rows as chat-id strings, each chat's full 7d
 * failure-row count, and the ADJUDICATED escalate-chats population (chats
 * whose rows are run-missing / dead-end — the f101-corrected key).
 */
function fanoutVerdict(windowRowsByChat: Record<string, number>, recurrence7dByChat: Record<string, number>, escalateChats = 0): {
  distinct_chats: number;
  escalate_chats: number;
  rows: number;
  top_chat: string | null;
  top_chat_recurrence_7d: number;
  verdict: string;
} {
  const chats = Object.keys(windowRowsByChat);
  if (chats.length === 0) {
    // zero rows: the section prints nothing
    return { distinct_chats: 0, escalate_chats: 0, rows: 0, top_chat: null, top_chat_recurrence_7d: 0, verdict: '(absent)' };
  }
  const rows = Object.values(windowRowsByChat).reduce((a, b) => a + b, 0);
  // top chat: most rows, ties broken by newest failure — the model takes the
  // first max (callers pass chat order as the tiebreak, newest first)
  const top = chats.reduce((best, c) => (windowRowsByChat[c] > windowRowsByChat[best] ? c : best), chats[0]);
  const topRec = recurrence7dByChat[top] ?? 0;
  let verdict: string;
  if (escalateChats >= 2) verdict = 'ESCALATE';
  else if (chats.length >= 4 && topRec >= 20) verdict = 'top_recurrence';
  else verdict = 'ok';
  return { distinct_chats: chats.length, escalate_chats: escalateChats, rows, top_chat: top, top_chat_recurrence_7d: topRec, verdict };
}

describe('PIN f96: JS model of the fanout ladder', () => {
  test('reproduces the live f96 window: 5 chats, 9 rows, top 1c2b28d6 recurrence 24, verdict top_recurrence', () => {
    const live = fanoutVerdict(
      { '29dd7893': 2, '1c2b28d6': 3, '4d9661a7': 2, '0037460b': 1, bb8f1073: 1 },
      { '29dd7893': 2, '1c2b28d6': 24, '4d9661a7': 2, '0037460b': 8, bb8f1073: 26 },
    );
    expect(live).toEqual({
      distinct_chats: 5,
      escalate_chats: 0,
      rows: 9,
      top_chat: '1c2b28d6',
      top_chat_recurrence_7d: 24,
      verdict: 'top_recurrence',
    });
  });

  test('a quiet window (1 chat) stays ok', () => {
    expect(fanoutVerdict({ bb8f1073: 1 }, { bb8f1073: 26 }).verdict).toBe('ok');
  });

  test('fanout >= 4 with a recurring top offender prints top_recurrence (points at the f94 row)', () => {
    const v = fanoutVerdict(
      { a: 1, b: 1, c: 1, bb8f1073: 2 },
      { a: 1, b: 2, c: 3, bb8f1073: 26 },
    );
    expect(v.verdict).toBe('top_recurrence');
    expect(v.top_chat).toBe('bb8f1073');
  });

  test('fanout >= 4 with NO recurring offender stays ok (busy-but-healthy window)', () => {
    const v = fanoutVerdict({ a: 1, b: 1, c: 1, d: 2 }, { a: 3, b: 5, c: 7, d: 9 });
    expect(v.distinct_chats).toBe(4);
    expect(v.verdict).toBe('ok');
  });

  test('fleet-wide dead-end fanout (>= 2 adjudicated chats) ESCALATEs regardless of any single recurrence', () => {
    const windowRows: Record<string, number> = {};
    for (let i = 0; i < 8; i++) windowRows['chat' + i] = 1;
    const v = fanoutVerdict(windowRows, {}, 2);
    expect(v.distinct_chats).toBe(8);
    expect(v.escalate_chats).toBe(2);
    expect(v.verdict).toBe('ESCALATE');
  });

  test('f101 regression: the raw >= 8 guard-note storm does NOT escalate when every row is watch-only (10/11 rows live:agent_behavior, 0 adjudicated chats)', () => {
    const windowRows: Record<string, number> = {};
    for (let i = 0; i < 13; i++) windowRows['chat' + i] = 1 + (i % 3);
    const v = fanoutVerdict(windowRows, {}, 0);
    expect(v.distinct_chats).toBe(13);
    expect(v.escalate_chats).toBe(0);
    expect(v.verdict).toBe('ok');
  });

  test('f101 regression: ONE dead-end chat (a singleton the firing probes) stays ok at the rollup rung', () => {
    const v = fanoutVerdict({ a: 2, b: 1, c: 1, d: 1 }, {}, 1);
    expect(v.verdict).toBe('ok');
  });
});
