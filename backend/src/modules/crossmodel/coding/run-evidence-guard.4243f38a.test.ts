/**
 * Replay/adjudication test — ticket 4243f38a (mishap, 2026-09-10): "3×
 * tool-failure streak: final_answer on 'Re-verify Scheduled Run Confirmation'
 * — framework or model?"
 *
 * THE INCIDENT: a machine-triggered coding run (session 0afa0737, run
 * 60c8740e — a FOREIGN-REPO spark-dashboard lane) had its final answer
 * rejected 3× for `unverified_block_claim` → breaker trip → final withheld.
 * Sibling ticket aada3761 adjudicated the SAME incident from the run's own
 * journal: the struck claims block listed a verify entry citing
 * `run_command [command OK]: python3 .digby-scratch/verify_local.py …` while
 * the run's plan still showed step 6 "Local verify" IN PROGRESS — the journal
 * held NO verify-tool receipt and NO local-verify execution at all (the
 * queued continuation r1/6 ran it fresh, EXIT=0). Sightings 2-3 added
 * zero-receipt push (40-char sha) and deploy (uuid-shaped ref) entries.
 *
 * VERDICT OF RECORD (this ticket's investigation, reconciled with aada3761):
 *   - THE INCIDENT WAS MODEL BEHAVIOR — the guard was CORRECT. verify entries
 *     convict when no verify-tool receipt exists BY DESIGN
 *     (CLAIM_TYPE_TOOLS.verify = {'verify'}, ids.passed===true required: an ok
 *     `ls` must never stamp a verify claim), and file_change entries without
 *     an ok git_commit convict for the same reason (an entry with no matching
 *     receipt is fabricated until re-verified). aada3761 shipped the
 *     model-facing verify-vouching clause in all four claims-block contract
 *     texts (PR #660); run-evidence-guard.aada3761.test.ts pins the
 *     conviction semantics. This file pins that THIS ticket did not weaken
 *     them.
 *   - ONE REAL ADJACENT FRAMEWORK GAP was found and fixed here: the
 *     ticket-dispatch mandate requires ticket_update claims entries for
 *     ticket closes, but `update_feedback` left NO receipt (absent from
 *     RECEIPT_TOOLS) and CLAIM_TYPE_TOOLS.ticket_update held only
 *     'file_feedback' — so EVERY compliant dispatch-lane close self-convicted
 *     (proven pre-fix by probe: RECEIPT_TOOLS.has('update_feedback') ===
 *     false; extractReceipt(success prose) === null). Fix: update_feedback
 *     joins RECEIPT_TOOLS/PLATFORM_RECEIPT_TOOLS; its prose success shape
 *     parses via the executed-actions PROSE_SUCCESS catalogue (the ONE
 *     parsing home; the {ok:false} verified-close envelope and admin-gate
 *     prose are ok:false); ticket_update entries match update_feedback
 *     receipts. Unmatched ticket_update entries STILL convict (the channel
 *     can adjudicate them — absence means it didn't happen).
 *
 * Boundary-mocked exactly like run-evidence-guard.claims.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetValidToken: jest.Mock = jest.fn(async () => 'tok');
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import { applyClaimsBlockLane, claimsBlockLane, verdictHasFindings } from './run-evidence-guard';
import type { GuardVerdict } from './run-evidence-guard';
import { extractReceipt, RECEIPT_TOOLS } from './run-receipts';
import type { ToolReceipt } from './run-receipts';

const NOW = new Date('2026-09-10T15:00:00.000Z');
const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'aaaaaaaa-0000-4000-8000-000000000001'): ToolReceipt => ({
  id, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});
const fence = (json: string) => '```claims\n' + json + '\n```';
const mkGuarded = (finalText: string): { finalText: string; notes: string[]; verdict: GuardVerdict } => ({
  finalText, notes: [], verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
});

// The real update_feedback success/refusal shapes (platform-tools.ts).
const TICKET_ID = '4243f38a-4d45-479b-97ae-3d824db66d03';
const UPDATE_OK_PROSE = `Updated feedback ticket ${TICKET_ID}: status=done, priority=0, adminNote set. Machine-close evidence verified (replayTestPath) and recorded in the adminNote.`;
const UPDATE_REFUSAL_JSON = JSON.stringify({ ok: false, tool: 'update_feedback', reason: 'mishap_requires_replay_test', ticketId: TICKET_ID, message: '…' });
const UPDATE_ADMIN_REFUSAL = 'update_feedback is restricted to admin users (feedback triage). You are not an admin.';

describe('ticket 4243f38a — THE FIX: update_feedback receipts close the dispatch-lane ticket_update trap', () => {
  it('update_feedback is now a receipt tool; success prose → ok:true + ids.ticketId', () => {
    expect(RECEIPT_TOOLS.has('update_feedback')).toBe(true);
    const r = extractReceipt('update_feedback', { id: TICKET_ID, status: 'done' }, UPDATE_OK_PROSE, NOW);
    expect(r).toEqual(expect.objectContaining({ tool: 'update_feedback', ok: true, ids: { ticketId: TICKET_ID } }));
  });

  it('refusals are ok:false — the verified-close envelope and the admin gate prove NO update', () => {
    expect(extractReceipt('update_feedback', { id: TICKET_ID }, UPDATE_REFUSAL_JSON, NOW)?.ok).toBe(false);
    expect(extractReceipt('update_feedback', { id: TICKET_ID }, UPDATE_ADMIN_REFUSAL, NOW)?.ok).toBe(false);
  });

  it('a ticket_update entry now VERIFIES against the update_feedback receipt', () => {
    const draft = extractReceipt('update_feedback', { id: TICKET_ID, status: 'done' }, UPDATE_OK_PROSE, NOW)!;
    const receipts: ToolReceipt[] = [{ ...draft, id: 'bbbbbbbb-0000-4000-8000-000000000000', chatId: 'c1', runId: 'run1' }];
    const out = claimsBlockLane(fence(`[{"type":"ticket_update","ref":"${TICKET_ID}"}]`), receipts);
    expect(out.unverified).toEqual([]);
    expect(out.unverifiable).toEqual([]);
    expect(out.verified).toHaveLength(1);
  });

  it('ANTI-FABRICATION: ticket_update with NO ticket receipt is still CONVICTED (the channel can adjudicate it)', () => {
    const out = claimsBlockLane(fence(`[{"type":"ticket_update","ref":"${TICKET_ID}"}]`), [receipt('run_command', true)]);
    expect(out.unverified).toHaveLength(1);
    expect(out.unverified[0].type).toBe('ticket_update');
  });

  it('end to end: the dispatch-lane close (ticket_update + update_feedback receipt) earns the positive verdict', async () => {
    const draft = extractReceipt('update_feedback', { id: TICKET_ID, status: 'done' }, UPDATE_OK_PROSE, NOW)!;
    const receipts: ToolReceipt[] = [{ ...draft, id: 'cccccccc-0000-4000-8000-000000000000', chatId: 'c1', runId: 'run1' }];
    const final = `Ticket ${TICKET_ID.slice(0, 8)} closed with replay evidence.\n`
      + fence(`[{"type":"ticket_update","ref":"${TICKET_ID}"}]`);
    const composed = await applyClaimsBlockLane({
      originalText: final, guarded: mkGuarded(final), receipts, triggerKind: 'machine',
    });
    expect(composed.verdict.claimsBlockVerified).toBe(true);
    expect(verdictHasFindings(composed.verdict)).toBe(false);
    expect(composed.finalText).toContain('CLAIMS BLOCK VERIFIED');
  });
});

describe('ticket 4243f38a — VERDICT OF RECORD: the incident convictions were CORRECT (guard semantics unchanged)', () => {
  it('the incident verify entry convicts against an EMPTY journal (aada3761 semantics preserved)', () => {
    const out = claimsBlockLane(
      fence('[{"type":"verify","ref":"run_command [command OK]: python3 .digby-scratch/verify_local.py → LOCAL VERIFY PASS"}]'),
      [],
    );
    expect(out.verified).toEqual([]);
    expect(out.unverifiable).toEqual([]); // verify has no unverifiable tier — a miss is a conviction
    expect(out.unverified).toHaveLength(1);
    expect(out.unverified[0].type).toBe('verify');
  });

  it('the incident verify entry convicts against an ok run_command receipt too (tool-class discipline)', () => {
    const out = claimsBlockLane(
      fence('[{"type":"verify","ref":"run_command [command OK]: python3 .digby-scratch/verify_local.py → LOCAL VERIFY PASS"}]'),
      [receipt('run_command', true)],
    );
    expect(out.unverifiable).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('sighting-2 shapes stay convicted: a full-sha push ref and a uuid-shaped deploy ref with no receipts', () => {
    const out = claimsBlockLane(
      fence('[{"type":"push","ref":"30dd57b227b401a8cd78d06262ebf131c63b7ce2"},{"type":"deploy","ref":"c56607f8-3293-4574-a56a-78c96621339d"}]'),
      [receipt('run_command', true)],
    );
    expect(out.unverified).toHaveLength(2); // push: no git_push receipt; deploy: uuid-shaped ref is receipt-id forgery class
    expect(out.unverifiable).toEqual([]);
  });

  it('file_change without an ok git_commit stays CONVICTED (entry-without-receipt = fabricated until re-verified)', () => {
    const out = claimsBlockLane(
      fence('[{"type":"file_change","ref":"spark-dashboard/server.py"}]'),
      [receipt('run_command', true)],
    );
    expect(out.unverifiable).toEqual([]);
    expect(out.unverified).toHaveLength(1);
  });

  it('end to end: the incident block produces the unverified_block_claim finding (breaker evidence stands)', async () => {
    const final = 'Items 1–3 landed; local verify green.\n'
      + fence('[{"type":"verify","ref":"run_command [command OK]: python3 .digby-scratch/verify_local.py → LOCAL VERIFY PASS"}]');
    const composed = await applyClaimsBlockLane({
      originalText: final, guarded: mkGuarded(final),
      receipts: [receipt('run_command', true)],
      triggerKind: 'schedule',
    });
    expect(composed.verdict.unverifiedBlockClaims).toHaveLength(1);
    expect(verdictHasFindings(composed.verdict)).toBe(true);
    expect(composed.finalText).toContain('CLAIMS BLOCK UNVERIFIED]');
  });

  it('deploy descriptive refs keep their P4 v1#23 unverifiable tier (unchanged)', () => {
    const out = claimsBlockLane(
      fence('[{"type":"deploy","ref":"deploy-healthcheck run at the merge sha"}]'),
      [receipt('run_command', true)],
    );
    expect(out.unverified).toEqual([]);
    expect(out.unverifiable).toHaveLength(1);
  });
});
