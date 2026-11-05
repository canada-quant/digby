/**
 * PIN (FO firing 94, 2026-10-07) — journal_failures_4h must COUNT per-chat
 * recurrence instead of leaving "a recurring strike on the SAME chat needs
 * the deeper look" as prose the operator re-derives by eye every firing.
 *
 * THE GAP THIS PINS: f87 baked the failure_class/verdict ladder into the
 * section, but its own comment still named the recurrence bar in prose
 * ("only a repeated strike on the SAME chat needs a deeper look"). f94 paid
 * exactly that tax: bb8f1073 printed 5 in-window rows and the count was done
 * BY HAND before this bake. The exact by-eye burden the f64 doctrine exists
 * to remove.
 *
 * THE FIX (firing 94, 25th f64 bake): a computed `recurrence_7d` column +
 * a `live:agent_behavior:recurring` verdict rung at recurrence_7d >= 20.
 * Measure-first calibration (box A probe, 2026-10-07T14:44Z): the 7d
 * per-chat failure-row distribution tops out at bb8f1073=24, 1c2b28d6=18,
 * b92ef13f=16, b811d9f7=13 — 20 (sustained ~3/day for a week) isolates the
 * one truly recurring chat without firing on the busy-but-healthy middle of
 * the pack. recurrence_7d counts PRIOR same-chat failure rows in 7d
 * (j2.id <> j.id — a row never counts itself).
 *
 * Live validation (box A, pre-deploy, probe-f94-section.js verbatim SQL):
 * bb8f1073 rows print recurrence_7d=23 and re-class from
 * live:agent_behavior → live:agent_behavior:recurring; 1c2b28d6 rows print
 * recurrence_7d=17 and STAY live:agent_behavior (the 20-bar does not fire).
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92/f93 pins): the
 * shipped audit declares the recurrence column, the >= 20 rung inside the
 * verdict CASE, rung order dead_chat → live:agent_behavior:recurring →
 * live:agent_behavior → chat_stale_7d, the FULL j."chatId" join (never
 * LEFT(,8), the f79 trap), and a JS model of the same ladder reproduces the
 * live rows plus synthetics.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92/f93 pin tests declare top-level fs/path the same way)

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
  const m = src.match(/sec\('journal_failures_4h', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('journal_failures_4h section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

describe('PIN f94: journal_failures_4h recurrence bake (25th f64 bake)', () => {
  test('the section exists and carries the computed recurrence column', () => {
    expect(sql).toContain('AS recurrence_7d');
    expect(sql).toContain('AS verdict');
    expect(sql).toContain("'live:agent_behavior:recurring'");
  });

  test('the recurrence rung bar is >= 20, baked not prose', () => {
    expect(sql).toMatch(/\) >= 20 THEN 'live:agent_behavior:recurring'/);
  });

  test('run order inside the completed arm: dead_chat → recurring → live:agent_behavior → chat_stale_7d', () => {
    const iDead = sql.indexOf("'dead_chat'");
    const iRecurring = sql.indexOf("'live:agent_behavior:recurring'");
    const iLive = sql.indexOf("'live:agent_behavior'");
    const iStale = sql.indexOf("'chat_stale_7d'");
    expect(iDead).toBeGreaterThan(-1);
    expect(iRecurring).toBeGreaterThan(iDead);
    expect(iLive).toBeGreaterThan(iRecurring);
    expect(iStale).toBeGreaterThan(iLive);
  });

  test('recurrence joins the FULL j."chatId" — never the truncated LEFT(,8) id (the f79 trap)', () => {
    expect(sql).toMatch(/j2\."chatId" = j\."chatId"/);
    expect(sql).not.toMatch(/j2\."chatId"::text,8/);
    // the window: 7 days back, excluding the row itself
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain('j2.id <> j.id');
    // only failure-bearing rows count
    expect(sql).toMatch(/j2\.failures, 1\) > 0/);
  });

  test('the pre-existing ladder is intact (f61/f87/f89 rungs unchanged)', () => {
    expect(sql).toContain("'guard_note_strike'");
    expect(sql).toContain("'live:retried'");
    expect(sql).toContain("'ESCALATE'");
    expect(sql).toContain("'run_missing'");
    // the retry subquery still guards against matching the dead run itself
    expect(sql).toMatch(/r2\.id <> j\."runId"/);
    expect(sql).toMatch(/r2\."createdAt" > j\."createdAt"/);
    // f101: a CONCURRENT sibling that was in flight at journal time (created
    // before the row, still running/queued now, or finished AFTER the journal
    // row) also counts as live:retried — the c919294b class (run 45c4f136
    // failed 18:17:03Z; its sibling 701e3409 was created 18:17:03.065Z —
    // 4.5s before the journal row — and completed 18:50Z; a status-only
    // subquery missed it once it completed, printing a false ESCALATE).
    expect(sql).toMatch(/r3\."sessionId" = j\."chatId"/);
    expect(sql).toMatch(/r3\."createdAt" <= j\."createdAt"/);
    expect(sql).toMatch(/r3\.status IN \('running','queued'\) OR \(r3\."finishedAt" IS NOT NULL AND r3\."finishedAt" > j\."createdAt"\)/);
  });

  test('the row filter is unchanged: 4h window, non-empty failures, LIMIT 15', () => {
    expect(sql).toContain("interval '4 hours'");
    expect(sql).toMatch(/array_length\(j\.failures, 1\) > 0/);
    expect(sql).toContain('LIMIT 15');
  });
});

/**
 * JS model of the shipped verdict ladder (completed-run arm only — the arm
 * the recurrence rung lives in). Inputs mirror what the SQL reads for one
 * journal row: chatAlive (a crossmodel_messages row in 7 days) and
 * recurrence7d (prior same-chat failure rows in 7 days).
 */
function classifyCompleted(chatExists: boolean, recurrence7d: number): string {
  if (!chatExists) return 'dead_chat';
  if (recurrence7d >= 20) return 'live:agent_behavior:recurring';
  return 'live:agent_behavior';
}

describe('PIN f94: behavioral model vs the live box-A rows (probe-f94-section.js)', () => {
  // Live validation 2026-10-07T14:44Z, SECTION_OK:
  //   bb8f1073 recurrence_7d=23 → live:agent_behavior:recurring (was counted by eye at f94)
  //   1c2b28d6 recurrence_7d=17 → live:agent_behavior (the bar does NOT fire)
  test('bb8f1073 live row: 23 prior strikes on a live chat → live:agent_behavior:recurring', () => {
    expect(classifyCompleted(true, 23)).toBe('live:agent_behavior:recurring');
  });

  test('1c2b28d6 live row: 17 prior strikes stays live:agent_behavior (under the 20 bar)', () => {
    expect(classifyCompleted(true, 17)).toBe('live:agent_behavior');
  });

  test('exactly 20 fires the recurring rung (the bar is >= 20)', () => {
    expect(classifyCompleted(true, 19)).toBe('live:agent_behavior');
    expect(classifyCompleted(true, 20)).toBe('live:agent_behavior:recurring');
  });

  test('dead chat outranks recurrence (dead_chat arm first)', () => {
    expect(classifyCompleted(false, 50)).toBe('dead_chat');
  });

  test('a first-time strike on a live chat stays live:agent_behavior', () => {
    expect(classifyCompleted(true, 0)).toBe('live:agent_behavior');
  });
});
