/**
 * PIN (FO firing 92, 2026-10-07) — hook_lag_by_target_4h must classify a busy
 * CHAT LANE itself, not leave the adjudication to a per-firing hand probe.
 *
 * THE GAP THIS PINS: chat lanes — supervisors included — write NO agent_runs
 * rows (the f75/f90 lesson), so the section's busy:ran arm (agent_runs
 * in-window) never matched for them. Every recent firing paid the same manual
 * crossmodel_messages probe to adjudicate the resulting bare 'ESCALATE':
 * f90 (99e63f86, 5 assistant msgs), f91 (both ESCALATEs), and f92 itself
 * (41bd202a, p90 99 min, 14 assistant msgs hourly 03–06h, last 06:28Z). The
 * standing verdict dictionary already names the probe — "chat lanes prove
 * busy:ran via crossmodel_messages (assistant rows in window), NOT
 * agent_runs" — but the section never baked it, the exact by-eye burden the
 * f64 bake doctrine exists to remove.
 *
 * THE FIX (firing 92, 23rd f64 bake): a busy:chatlane arm — an in-window
 * assistant row on the target chat means the chat was ANSWERING while the
 * hook waited (queue-behind-busy). Its own label (not 'busy:ran') so the
 * provenance — chat lane, not an agent_run — is visible in the readout.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f62 journal pin): the
 * shipped audit declares the arm, its inputs (role='assistant', 4h window,
 * FULL joined targetChatId — never the truncated LEFT(,8) id, the f79 trap),
 * and its branch order (AFTER the agent_runs busy:ran arm so a coding lane
 * proves busyness the cheaper way first; BEFORE busy:rider so an answering
 * chat outranks a queued-message marker); a JS model of the same classifier
 * reproduces this firing's live row (41bd202a) plus the synthetic cases.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f62/f61/f59/f60 pin tests declare top-level fs/path the same way)

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const AUDIT = path.join(repoRoot(__dirname), 'scripts/framework-audit/audit-live-state.js');

/** The section's SQL, extracted from the shipped audit verbatim. */
function sectionSql(src: string): string {
  const m = src.match(/sec\('hook_lag_by_target_4h', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('hook_lag_by_target_4h section not found in audit-live-state.js');
  return m[1];
}

/**
 * JS model of the shipped CASE classifier (same branch order as the SQL).
 * Inputs mirror what the SQL's EXISTS arms read for one target chat:
 *   chatExists — the crossmodel_chats liveness join
 *   agentRunsInWindow — agent_runs rows created in the last 4 h
 *   assistantRowsInWindow — crossmodel_messages role='assistant' rows in the
 *     last 4 h (the NEW busy:chatlane input)
 *   riderMarkersInWindow — [QUEUED WHILE BUSY] user rows (origin hook/schedule)
 *   p90min — the delivery-latency p90 band
 */
function classify(opts: {
  chatExists: boolean;
  agentRunsInWindow: boolean;
  assistantRowsInWindow: boolean;
  riderMarkersInWindow: boolean;
  p90min: number;
}): string {
  if (opts.p90min <= 30) return 'ok';
  if (!opts.chatExists) return 'dead_target';
  if (opts.agentRunsInWindow) return 'busy:ran';
  if (opts.assistantRowsInWindow) return 'busy:chatlane';
  if (opts.riderMarkersInWindow) return 'busy:rider';
  if (opts.p90min <= 60) return 'slow';
  return 'ESCALATE';
}

describe('audit hook_lag_by_target_4h busy:chatlane arm (FO firing 92)', () => {
  const auditSrc = fs.readFileSync(AUDIT, 'utf8');
  const sql = sectionSql(auditSrc);

  it('the audit still ships the hook_lag_by_target_4h section (sec-wired, read-only)', () => {
    expect(sql.length).toBeGreaterThan(200);
    expect(auditSrc).toContain("sec('hook_lag_by_target_4h'");
    expect(sql).toContain("e.status='delivered'");
    expect(sql).toContain("interval '4 hours'");
  });

  it('TEXTUAL: the busy:chatlane arm reads in-window ASSISTANT rows on the FULL joined target id', () => {
    // the f92 bake: role='assistant' on crossmodel_messages, 4h window, and the
    // join key is h."targetChatId" (the full UUID) — never LEFT(,8), the f79 trap
    expect(sql).toMatch(
      /WHEN EXISTS \(SELECT 1 FROM crossmodel_messages m3 WHERE m3\."chatId" = h\."targetChatId" AND m3\.role = 'assistant' AND m3\."createdAt" > now\(\) - interval '4 hours'\) THEN 'busy:chatlane'/
    );
  });

  it('TEXTUAL: branch order — busy:ran (agent_runs) BEFORE busy:chatlane, busy:chatlane BEFORE busy:rider', () => {
    const ran = sql.indexOf("'busy:ran'");
    const chatlane = sql.indexOf("'busy:chatlane'");
    const rider = sql.indexOf("'busy:rider'");
    expect(ran).toBeGreaterThan(-1);
    expect(chatlane).toBeGreaterThan(ran); // a coding lane proves busyness the cheaper way first
    expect(rider).toBeGreaterThan(chatlane); // an answering chat outranks a queued-message marker
  });

  it('TEXTUAL: the pre-existing arms are intact (ok band, dead_target, busy:rider, slow, ESCALATE)', () => {
    for (const arm of ["<= 30 THEN 'ok'", "'dead_target'", "'busy:rider'", "'slow'", "'ESCALATE'"]) {
      expect(sql).toContain(arm);
    }
  });

  it('BEHAVIORAL: this firing\'s live row (41bd202a) classifies busy:chatlane, not ESCALATE', () => {
    // f92 live state: p90 99 min, target chat exists, ZERO agent_runs rows
    // (chat lane), 14 assistant msgs in-window, no rider markers.
    expect(
      classify({ chatExists: true, agentRunsInWindow: false, assistantRowsInWindow: true, riderMarkersInWindow: false, p90min: 99 })
    ).toBe('busy:chatlane');
  });

  it('BEHAVIORAL: a busy CODING lane still prefers the agent_runs arm (busy:ran first)', () => {
    expect(
      classify({ chatExists: true, agentRunsInWindow: true, assistantRowsInWindow: true, riderMarkersInWindow: true, p90min: 99 })
    ).toBe('busy:ran');
  });

  it('BEHAVIORAL: the non-busy bands are unchanged (ok / dead_target / busy:rider / slow / ESCALATE)', () => {
    expect(classify({ chatExists: true, agentRunsInWindow: false, assistantRowsInWindow: false, riderMarkersInWindow: false, p90min: 20 })).toBe('ok');
    expect(classify({ chatExists: false, agentRunsInWindow: false, assistantRowsInWindow: true, riderMarkersInWindow: false, p90min: 99 })).toBe('dead_target');
    expect(classify({ chatExists: true, agentRunsInWindow: false, assistantRowsInWindow: false, riderMarkersInWindow: true, p90min: 99 })).toBe('busy:rider');
    expect(classify({ chatExists: true, agentRunsInWindow: false, assistantRowsInWindow: false, riderMarkersInWindow: false, p90min: 45 })).toBe('slow');
    expect(classify({ chatExists: true, agentRunsInWindow: false, assistantRowsInWindow: false, riderMarkersInWindow: false, p90min: 75 })).toBe('ESCALATE');
  });
});
