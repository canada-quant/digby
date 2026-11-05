/**
 * Replay/regression tests for feedback ticket aada3761 (mishap, fleet-integrity,
 * 2026-09-10): "Evidence guard: machine run asserted unproven completions
 * (session 0afa0737)".
 *
 * THE MISHAP BEING REPLAYED: the spark-dashboard UI lane
 * (0afa0737-88a4-4f9c-a3ae-2f125bdd08b1 — the coding session un-archived by the
 * dae56e70 fix earlier the same day) fired its relayed one-shot schedule
 * 9da6ae0d at 15:12:26Z (run 60c8740e-677f-4603-aca3-3f3681a87823). Its final's
 * ```claims fence listed a verify entry citing
 *   run_command [command OK]: python3 .digby-scratch/verify_local.py → LOCAL VERIFY …
 * while the run's OWN plan still showed step 6 "Local verify" IN PROGRESS — the
 * journal held no verify-tool receipt (and no local-verify execution at all:
 * the queued continuation r1/6 then ran it fresh, EXIT=0). verifyClaimsBlock
 * convicted the entry unverified and the final was withheld pre-delivery
 * (containedPreDelivery: true, filed 2026-09-10T15:37:23.687Z).
 *
 * These tests pin, against the REAL claims-block lane:
 *   1. the incident shape — a verify entry whose journal holds NO receipts —
 *      convicts unverified (verify has no 'unverifiable' tier: a miss is a
 *      conviction);
 *   2. replay detail: an ok run_command receipt ALSO cannot vouch a verify
 *      entry — CLAIM_TYPE_TOOLS.verify = {'verify'} by design, so an ok `ls`
 *      can never stamp a verify claim. This is the incident's deterministic
 *      core: until this ticket's fix, no model-facing contract text said so,
 *      so a lane could write an unsatisfiable-by-construction verify entry;
 *   3. CONTROL (no overreach): the SAME entry backed by a this-run verify-tool
 *      receipt with passed:true is VERIFIED (a descriptive ref matches — only
 *      full-uuid refs demand a receipt-id match);
 *   4. CONTROL: a passed:false verify receipt does NOT vouch (a failed chain
 *      proves the opposite of the claim), and neither does an ok:false one;
 *   5. CONTROL (the steered behavior): a claim-free "attempted, unverified"
 *      one-liner carries no fence — nothing to convict;
 *   6. the doctrinal fix: all four model-facing claims-block contract texts now
 *      carry the verify-vouching clause (the machine-wake firing header is
 *      asserted LIVE via machineFiringHeader; the heavy-graph sources are
 *      asserted by source text), and the header keeps its single-line,
 *      no-inner-']' invariant the strip regex depends on.
 *
 * The fix shipped with this ticket is BEHAVIORAL + DOCTRINAL (the
 * verify-vouching clause in machine-wake.ts / agent.ts / scaffolding.service.ts
 * / supervisor.service.ts); the guard itself needed no change, and these tests
 * keep it that way. claims-block.ts and machine-wake.ts are dependency-free
 * leaf modules — no mocks needed.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseClaimsBlock, verifyClaimsBlock } from './claims-block';
import type { ToolReceipt } from './run-receipts';
import { machineFiringHeader } from '../chat-agent/machine-wake';

// Ticket ed728b87 suite seam: the lane seam module (./run-evidence-guard)
// imports utils/logger → config/env, which process.exit(1)s AT IMPORT when the
// required vars are unset — the ORIGINAL suite's imports (claims-block,
// run-receipts type, machine-wake) are env-free and CI-green, so the lane
// import is deferred: seed the four required vars (??= never overrides real /
// CI env) BEFORE the lazy require. A static import would hoist above any
// top-level assignment; the deferred require runs at module evaluation, after
// the seed. No jest.mock — RECALL-10 below still exercises the REAL detector.
process.env.DATABASE_URL ??= 'postgresql://guard-test:guard-test@localhost:5432/guard-test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'guard-test-secret-placeholder-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'guard-test-refresh-placeholder-0123456789abcdef';
const { claimsBlockLane } = require('./run-evidence-guard') as typeof import('./run-evidence-guard');

/** The withheld run's wall clock (fired 15:12:26Z; contained + filed 15:37:23Z). */
const INCIDENT_NOW = new Date('2026-09-10T15:37:23.000Z');

/**
 * The flagged final's claims fence, reconstructed from the filing (the ticket
 * quotes the lane note's 80-char-truncated render "verify run_command
 * [command OK]: python3 .digby-scratch/verify_local.py → LOCAL VERIFY …"). The
 * ref tail is not load-bearing: a non-uuid ref never matches a receipt id, so
 * vouching turns entirely on the receipt TOOL CLASS.
 */
const INCIDENT_FINAL = [
  'Items 1–3 landed; local verify green.',
  '```claims',
  '[{"type":"verify","ref":"run_command [command OK]: python3 .digby-scratch/verify_local.py → LOCAL VERIFY PASS"}]',
  '```',
].join('\n');

const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'r1'): ToolReceipt => ({
  id, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: INCIDENT_NOW,
});

describe('ticket aada3761 replay — claims-block verify entry with no matching receipt (session 0afa0737, run 60c8740e)', () => {
  it('REPLAY: the incident final convicts — verify entry unverified against an EMPTY journal', () => {
    const parsed = parseClaimsBlock(INCIDENT_FINAL);
    expect(parsed.present).toBe(true);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims![0]).toMatchObject({ type: 'verify' });

    const out = verifyClaimsBlock(parsed.claims!, []);
    expect(out.verified).toEqual([]);
    expect(out.unverifiable).toEqual([]); // verify has no unverifiable tier — a miss is a conviction
    expect(out.unverified).toHaveLength(1);
    expect(out.unverified[0].type).toBe('verify');
    expect(out.unverified[0].ref).toContain('verify_local.py');
  });

  it('replay detail: an ok run_command receipt ALSO cannot vouch a verify entry (tool-class discipline)', () => {
    // Even had the run executed the script via run_command, the receipt is the
    // wrong class (CLAIM_TYPE_TOOLS.verify = {'verify'}) — by design, so an ok
    // `ls` can never stamp a verify claim.
    const parsed = parseClaimsBlock(INCIDENT_FINAL);
    const out = verifyClaimsBlock(parsed.claims!, [receipt('run_command', true)]);

    expect(out.verified).toEqual([]);
    expect(out.unverifiable).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('replay detail (review F1): even a passed:true run_command receipt cannot vouch — the TOOL-CLASS gate, not just the passed gate', () => {
    // Pins CLAIM_TYPE_TOOLS.verify = {'verify'} independently of the
    // ids.passed gate: with a hypothetical run_command receipt carrying
    // passed:true, a wrong-class CLAIM_TYPE_TOOLS.verify (e.g. {'verify',
    // 'run_command'}) WOULD vouch — this control fails on that mutation.
    // (Real run_command receipts never carry passed — run-receipts.ts.)
    const parsed = parseClaimsBlock(INCIDENT_FINAL);
    const out = verifyClaimsBlock(parsed.claims!, [
      receipt('run_command', true, { passed: true }),
    ]);

    expect(out.verified).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('CONTROL (no overreach): the SAME entry backed by a this-run verify-tool receipt (passed) is VERIFIED', () => {
    const parsed = parseClaimsBlock(INCIDENT_FINAL);
    const out = verifyClaimsBlock(parsed.claims!, [
      receipt('verify', true, { passed: true, failedStage: null }, 'rv'),
    ]);

    expect(out.unverified).toEqual([]);
    expect(out.verified).toHaveLength(1);
    expect(out.verified[0].receiptId).toBe('rv');
  });

  it('CONTROL: a passed:false verify receipt does NOT vouch — a failed chain proves the opposite of the claim', () => {
    const parsed = parseClaimsBlock(INCIDENT_FINAL);
    const out = verifyClaimsBlock(parsed.claims!, [
      receipt('verify', true, { passed: false, failedStage: 'test' }),
    ]);

    expect(out.verified).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('CONTROL: an ok:false verify receipt does NOT vouch either', () => {
    const parsed = parseClaimsBlock(INCIDENT_FINAL);
    const out = verifyClaimsBlock(parsed.claims!, [receipt('verify', false, { passed: false })]);

    expect(out.verified).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('CONTROL (steered behavior): the claim-free "attempted, unverified" one-liner parses clean — nothing to convict', () => {
    const parsed = parseClaimsBlock(
      'Local verify not executed this firing — attempted, unverified; the queued continuation will run it fresh.',
    );
    expect(parsed.present).toBe(false);
    expect(parsed.claims).toBeNull();
  });
});

describe('ticket aada3761 doctrinal fix — every model-facing claims-block contract carries the verify-vouching clause', () => {
  it('machine-wake firing header (asserted LIVE via machineFiringHeader)', () => {
    for (const origin of ['schedule', 'hook'] as const) {
      const h = machineFiringHeader(origin);
      // Pre-existing contract pieces still intact:
      expect(h).toContain('fenced claims block');
      expect(h).toContain('push | pr | merge | deploy | commit | ticket_update | message_sent | dispatch | file_change | verify | schedule_armed | email_sent | state_update');
      // The new clause:
      expect(h).toContain('a verify entry is vouched ONLY by a this-run verify-tool receipt');
      expect(h).toContain('run_command cannot vouch it');
      // The strip-regex invariant (machine-wake.ts stripMachineFiringHeader
      // matches to the FIRST ']' on the line): the header line keeps no inner ']'.
      const firstLine = h.split('\n')[0];
      expect(firstLine.indexOf(']')).toBe(firstLine.length - 1);
    }
  });

  it('coding-agent doctrine, scaffolded AGENTS.md, and supervisor wake notes (asserted by source text)', () => {
    const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
    expect(read('agent.ts')).toContain('a verify entry is vouched ONLY by a this-run verify-tool receipt');
    expect(read('scaffolding.service.ts')).toContain('A \\`verify\\` entry is vouched ONLY by a this-run \\`verify\\`-tool receipt');
    // build 2026-10-08 S-2: the supervisor wake-note contract lives in the layered role profile
    // (role-profiles.ts) — the pre-layering builder in supervisor.service.ts was deleted.
    expect(read(join('..', 'platform', 'role-profiles.ts')))
      .toContain('a \\`verify\\` entry matches only a this-run \\`verify\\`-tool receipt');
  });
});

// ── Ticket ed728b87 (2026-10-27): finish_run's scope vocabulary joins the fence ──
//
// The REPORTED FALSE POSITIVE (Schooltime lane 19dd22bc, runs 17353fe8 / 13dfa651):
// a multi-firing lane's final claimed honest work executed by an EARLIER run of
// the same chat (todo_update e7bebd4a/b890b409, message b52283bc, merge 18e5f08a)
// — the evidence guard struck them as "typed claims-block entries with no
// matching receipt" although finish_run's schema and bar text bless scope:session.
// The fix: a scoped entry that misses THIS run's receipts re-matches against the
// chat's recent receipt history (the caller's carried pool) before the miss tiers
// apply. NOT a detector relaxation — every pre-existing true positive below still
// fires; only honest cross-run receipts stop striking.
describe('ticket ed728b87 — claims-block scope:session/relayed entries resolve against the chat receipt history (DETECTOR-RECALL REPLAY)', () => {
  /** An earlier-run receipt (different runId — the carried pool's shape). */
  const carried = (tool: string, ok: boolean, ids: Record<string, unknown>, id: string): ToolReceipt => ({
    id, chatId: 'c1', runId: 'run0', tool, ok, ids,
    inputHash: null, outputHash: null, createdAt: new Date('2026-10-27T04:10:00.000Z'),
  });
  const priorReceipts = [
    carried('todo_update', true, { todoId: 'e7bebd4a' }, 'rr-1'),
    carried('todo_update', true, { todoId: 'b890b409' }, 'rr-2'),
    carried('send_chat_message', true, { chatId: 'b52283bc-59ef-42db-845b-92f381a932ae' }, 'rr-3'),
  ];

  it('RECALL-1 (verbatim incident replay): scope:session todo_update entries whose receipts live only in an earlier run verify via session', () => {
    const parsed = parseClaimsBlock([
      'Wrapped the gap audit and both todo updates from the prior firing.',
      '```claims',
      '[{"type":"ticket_update","ref":"e7bebd4a","scope":"session"},{"type":"ticket_update","ref":"b890b409","scope":"session"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    expect(out.verified).toHaveLength(2);
    expect(out.verified.every((v) => v.via === 'session')).toBe(true);
    expect(out.verified.map((v) => v.receiptId).sort()).toEqual(['rr-1', 'rr-2']);
    expect(out.unverified).toEqual([]);
    expect(out.unverifiable).toEqual([]);
  });

  it('RECALL-2 (pre-ed728b87 behavior pinned): the SAME refs WITHOUT scope stay unverified — the scope declaration is what unlocks the carried pool', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"ticket_update","ref":"e7bebd4a"},{"type":"ticket_update","ref":"b890b409"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    expect(out.verified).toEqual([]);
    expect(out.unverified).toHaveLength(2);
  });

  it('RECALL-3 (true positive still fires): an INVENTED full-uuid ref under scope:session stays unverified — scope never launders a fabricated ref', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"ticket_update","ref":"deadbeef-dead-beef-dead-beefdeadbeef","scope":"session"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    expect(out.verified).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('RECALL-4 (tier routing unchanged): a scope:session verify entry with NO carried verify receipt still strikes — verify has no unverifiable tier', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"verify","ref":"run_command [command OK]: python3 verify_local.py","scope":"session"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    expect(out.verified).toEqual([]);
    expect(out.unverifiable).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('RECALL-5 (tier routing unchanged): a scope:relayed email_sent miss lands UNVERIFIABLE (advisory), not unverified', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"email_sent","ref":"owner@digby.ai","scope":"relayed"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    expect(out.verified).toEqual([]);
    expect(out.unverified).toEqual([]);
    expect(out.unverifiable).toHaveLength(1);
  });

  it('RECALL-6 (relayed): a scope:relayed entry whose ref matches a receipt this run READ verifies via relayed', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"message_sent","ref":"rr-3","scope":"relayed"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    expect(out.verified).toHaveLength(1);
    expect(out.verified[0].via).toBe('relayed');
    expect(out.verified[0].receiptId).toBe('rr-3');
  });

  it('RECALL-7 (aliases): "scope":"previous_run" parses as session; an unknown scope value is DROPPED (unscoped), never malformed', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"ticket_update","ref":"e7bebd4a","scope":"previous_run"},{"type":"ticket_update","ref":"b890b409","scope":"this chat earlier"}]',
      '```',
    ].join('\n'));
    expect(parsed.claims![0].scope).toBe('session');
    expect(parsed.claims![1].scope).toBeUndefined();
    const out = verifyClaimsBlock(parsed.claims!, [], priorReceipts);
    // claims[0] now resolves (scope:session + ref in the carried pool);
    // claims[1]'s unknown scope was DROPPED — unscoped entry, miss convicts.
    expect(out.verified).toHaveLength(1);
    expect(out.verified[0].via).toBe('session');
    expect(out.unverified).toHaveLength(1);
    expect(out.unverified[0].ref).toBe('b890b409');
  });

  it('RECALL-8 (no-carried-pool parity): scoped entries against an ABSENT pool keep the pre-ed728b87 tiers', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"ticket_update","ref":"e7bebd4a","scope":"session"}]',
      '```',
    ].join('\n'));
    const out = verifyClaimsBlock(parsed.claims!, [], []);
    expect(out.verified).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('RECALL-9 (mixed block): this-run + carried-verified + one miss — the miss still convicts', () => {
    const parsed = parseClaimsBlock([
      '```claims',
      '[{"type":"push","ref":"1539fa86"},{"type":"ticket_update","ref":"e7bebd4a","scope":"session"},{"type":"pr","ref":"9999"}]',
      '```',
    ].join('\n'));
    const thisRun = [receipt('git_push', true, { sha: '1539fa86abc', branch: 'digby/fix-x' }, 'r-push')];
    const out = verifyClaimsBlock(parsed.claims!, thisRun, priorReceipts);
    expect(out.verified).toHaveLength(2);
    expect(out.verified.map((v) => v.via)).toEqual([undefined, 'session']);
    expect(out.unverified).toHaveLength(1);
  });

  it('RECALL-10 (lane-level): claimsBlockLane with the carried pool returns a zero-unverified lane', () => {
    const finalText = [
      'Work continues from the prior firing.',
      '```claims',
      '[{"type":"ticket_update","ref":"e7bebd4a","scope":"session"},{"type":"ticket_update","ref":"b890b409","scope":"session"}]',
      '```',
    ].join('\n');
    const lane = claimsBlockLane(finalText, [], priorReceipts);
    expect(lane.present).toBe(true);
    expect(lane.unverified).toEqual([]);
    expect(lane.verified).toHaveLength(2);
    expect(Array.isArray(lane.coveredKinds)).toBe(true);
  });

  it('RECALL-11 (doctrinal texts): every model-facing claims contract names the scope escape hatch', () => {
    const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
    expect(read(join('..', 'chat-agent', 'machine-wake.ts'))).toContain('"scope":"session"');
    expect(read('agent.ts')).toContain('"scope":"session"');
    expect(read('scaffolding.service.ts')).toContain('"scope":"session"');
    // role-profiles.ts (the supervisor wake-note layer) deliberately does NOT
    // carry the clause — its 27,910-char budget is full and supervisors are
    // told the scope hatch by the machine-wake firing header instead
    // (RECALL-11's machine-wake assertion above).
  });
});
