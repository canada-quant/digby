/**
 * Replay/adjudication test — ticket 212b3aa0 (mishap, 2026-09-10): "3×
 * tool-failure streak: final_answer on 'Finding Flaws in Legal Bench Scores'
 * — framework or model?"
 *
 * THE INCIDENT: a machine-triggered coding run (session 619a1241, run
 * e2f9bd6d — the canlegal-bench bench lane) woke on a fleet-hook
 * supervisor-busy-skip wake at 2026-09-10T20:49Z and had its final_answer
 * rejected 3× with IDENTICAL findings — `guard findings: unproven_completion`
 * — until the derail-breaker tripped and the answer was withheld (ticket
 * auto-filed at trip, owner doctrine: self-heal + attribute).
 *
 * VERDICT OF RECORD (this ticket's investigation): DETERMINISTIC FRAMEWORK
 * DEFECT — an evidence-tier gap, with the model's claim-vocabulary habit as
 * the triggering condition:
 *   - Framework was CONSTANT between the lane's 17:52Z delivered run and the
 *     20:49Z struck run (the only deploy in between, bcbea1e73 @ 18:03Z, is
 *     the unrelated unarchive fix — 4 files, no guard code), and the wake
 *     text was byte-similar to wakes the lane answered fine at 10:12/12:42/
 *     13:15/17:52Z.
 *   - The trap: probe/benchmark claims bound ONLY to the external-action
 *     receipt class (run_command|git_|open_pull_request|github_) — in
 *     receiptMatchesClaim's coarse lane, claimHasEvidence's parts tier, and
 *     citedToolEvidencesKind's citation tier — while the platform's read-only
 *     observation tools (todo_get, get_chat_status, list_schedules,
 *     schedule_get, get_chat_messages, list_feedback, …) left NO receipts at
 *     all (absent from RECEIPT_TOOLS) and sat in NO evidence tier. The
 *     machine-wake doctrine mandates exactly those tools ("probe-first:
 *     todo_get …, get_chat_status …") and PROBE_RE matches the doctrine's own
 *     word "probe" next to ubiquitous status nouns ("active", "enabled",
 *     "healthy", "clock"). A pure fleet-monitoring run that followed its
 *     doctrine and wrote probe vocabulary was GUARANTEED a strike it could
 *     never escape by re-probing with the mandated tools — the reject-back
 *     even said "no evidence-bearing tool call this run", false under the
 *     shared zero-tool-gate vocabulary. 3 identical strikes → breaker trip.
 *   - Earlier escapes explained: the reads-only delivered answers (09:44Z,
 *     10:13Z) avoided the word "probe" entirely; every hourly pytest-audit
 *     answer carried an ok run_command receipt (date/pytest/pgrep) that
 *     coarsely exonerated all probe/benchmark claims.
 *   - Finding kinds were ONLY unproven_completion (no fabricated_quote /
 *     future_dated) — consistent with honest-but-unprovable prose claims,
 *     not confabulated quotes/clocks.
 *
 * THE FIX pinned here: PLATFORM_OBSERVE_TOOLS (evidence-tools.ts) — the
 * read-only platform/fleet observation tools — now (a) leave ok receipts
 * (RECEIPT_TOOLS + a generic extraction case: executed = evidence; "Tool
 * <name> failed:" prose and boolean-ok:false envelopes prove nothing was
 * observed), and (b) join the probe/benchmark evidence tier in
 * receiptMatchesClaim, claimHasEvidence, and citedToolEvidencesKind.
 * deploy / pr claims / commit_pushed stay external-action-only — observing the world
 * can never evidence changing it.
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

import {
  applyCompletionClaimGuard,
  claimHasEvidence,
  extractCompletionClaims,
  renderGuardRejectBackNotice,
} from './run-evidence-guard';
import type { CompletionClaim, GuardVerdict } from './run-evidence-guard';
import { extractReceipt, RECEIPT_TOOLS, receiptMatchesClaim } from './run-receipts';
import type { ToolReceipt } from './run-receipts';
import { PLATFORM_OBSERVE_TOOLS } from './evidence-tools';

const NOW = new Date('2026-09-10T21:00:00.000Z');
const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' } as const;
const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'aaaaaaaa-0000-4000-8000-000000000001'): ToolReceipt => ({
  id, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});
const claim = (kind: CompletionClaim['kind'], text = 'claim line', prNumber?: number): CompletionClaim => ({ kind, text, ...(prNumber !== undefined ? { prNumber } : {}) });

/** The incident's claim shape: doctrine vocabulary + fleet-status nouns, zero quotes/clocks. */
const INCIDENT_FINAL = [
  'Fleet-wake handling complete, all reads fresh this turn.',
  'Probe-first reads this turn: get_chat_status c0e22e36 returned running true with schedules enabled 1 and an advancing nextRunAt, so the supervisor lane is active and cycling forward.',
  'Bench-lane pause state re-confirmed from todo_get rows and the one-shot watch remains armed.',
].join('\n');

const OBSERVE_RECEIPTS: ToolReceipt[] = [
  receipt('get_chat_status', true, {}, 'aaaaaaaa-0000-4000-8000-0000000000a1'),
  receipt('todo_get', true, {}, 'aaaaaaaa-0000-4000-8000-0000000000a2'),
  receipt('list_schedules', true, {}, 'aaaaaaaa-0000-4000-8000-0000000000a3'),
];

describe('ticket 212b3aa0 — the incident shape: probe claim extraction + the tier gap', () => {
  it('extracts a probe claim from the doctrine vocabulary (probe-first + enabled/active)', () => {
    const kinds = extractCompletionClaims(INCIDENT_FINAL).map((c) => c.kind);
    expect(kinds).toContain('probe');
  });

  it('PRE-FIX this claim was unprovable: an ok platform observation receipt now matches a probe claim', () => {
    expect(receiptMatchesClaim(claim('probe'), [receipt('get_chat_status', true)])).toBe(true);
    expect(receiptMatchesClaim(claim('benchmark'), [receipt('list_schedules', true)])).toBe(true);
  });

  it('a FAILED observation read proves nothing (ok:false receipts never exonerate)', () => {
    expect(receiptMatchesClaim(claim('probe'), [receipt('get_chat_status', false)])).toBe(false);
  });

  it('the external-action escape lane still works (ok run_command evidences probe)', () => {
    expect(receiptMatchesClaim(claim('probe'), [receipt('run_command', true)])).toBe(true);
  });

  it('NO LAUNDERING: observation receipts never evidence deploy / pr_* / commit_pushed', () => {
    expect(receiptMatchesClaim(claim('deploy'), [receipt('get_chat_status', true)])).toBe(false);
    expect(receiptMatchesClaim(claim('pr_merged', 'l', 999), [receipt('get_chat_status', true)])).toBe(false);
    expect(receiptMatchesClaim(claim('pr_created', 'l', 999), [receipt('get_chat_status', true)])).toBe(false);
    expect(receiptMatchesClaim({ kind: 'commit_pushed', sha: '1539fa86b1c2', text: 'l' }, [receipt('todo_get', true)])).toBe(false);
  });

  it('RECONCILIATION (ticket 4df4bb41): infra-subject probes are NEVER evidenced by observation receipts', () => {
    // The 4df4bb41 steer-keeper shape — "box probe healthy, tailnet probe
    // active" with a fleet-reads-only journal — stays a CONVICTION: fleet
    // reads cannot observe a box. Only fleet/PLATFORM-state probes bind the
    // observation class.
    const infra = claim('probe', 'Post-close probes came back green across the fleet: box probe healthy, tailnet probe active.');
    expect(receiptMatchesClaim(infra, OBSERVE_RECEIPTS)).toBe(false);
    expect(receiptMatchesClaim(infra, [receipt('run_command', true)])).toBe(true); // the box was actually shelled
    const parts = [{ type: 'tool_call', name: 'get_feedback' } as any, { type: 'tool_call', name: 'list_schedules' } as any];
    expect(claimHasEvidence(infra, parts)).toBe(false);
    const fleetProbe = claim('probe', INCIDENT_FINAL.split('\n')[1]);
    expect(receiptMatchesClaim(fleetProbe, OBSERVE_RECEIPTS)).toBe(true);
    expect(claimHasEvidence(fleetProbe, parts)).toBe(true);
  });

  it('parts-path parity: a get_chat_status tool_call evidences probe but never deploy', () => {
    const parts = [{ type: 'tool_call', name: 'get_chat_status' } as any];
    expect(claimHasEvidence(claim('probe'), parts)).toBe(true);
    expect(claimHasEvidence(claim('benchmark'), parts)).toBe(true);
    expect(claimHasEvidence(claim('deploy'), parts)).toBe(false);
  });
});

describe('ticket 212b3aa0 — THE FIX: observation reads join RECEIPT_TOOLS with honest ok semantics', () => {
  it('every PLATFORM_OBSERVE_TOOLS member is a receipt tool', () => {
    expect(PLATFORM_OBSERVE_TOOLS.size).toBeGreaterThan(0);
    for (const t of PLATFORM_OBSERVE_TOOLS) expect(RECEIPT_TOOLS.has(t)).toBe(true);
  });

  it('executed observation (JSON payload, no ok field) → ok:true', () => {
    const r = extractReceipt('get_chat_status', { chatId: 'c1' }, JSON.stringify({ running: true, queued: { count: 0 } }), NOW);
    expect(r).toEqual(expect.objectContaining({ tool: 'get_chat_status', ok: true }));
  });

  it('the tools.ts catch-all prose failure → ok:false (nothing was observed)', () => {
    expect(extractReceipt('todo_get', { todoId: 'x' }, 'Tool todo_get failed: prisma timeout', NOW)?.ok).toBe(false);
  });

  it('B1 (reviewer): the loop-backstop hard-timeout ABORT receipts ok:false — the tool never ran', () => {
    const abort = 'Tool "get_chat_status" exceeded 240s and was aborted. Do not retry it; proceed with what you have.';
    expect(extractReceipt('get_chat_status', { chatId: 'c1' }, abort, NOW)?.ok).toBe(false);
  });

  it('B2 (reviewer): platform prose PRE-EXECUTION refusals receipt ok:false', () => {
    expect(extractReceipt('todo_get', {}, 'todo_get requires todoId.', NOW)?.ok).toBe(false);
    expect(extractReceipt('schedule_get', {}, 'schedule_get requires id.', NOW)?.ok).toBe(false);
    expect(extractReceipt('list_feedback', {}, 'list_feedback is restricted to admin users (feedback triage). You are not an admin — if you noticed a Digby-platform issue worth reporting, file it with file_feedback instead.', NOW)?.ok).toBe(false);
    expect(extractReceipt('schedule_get', { id: 'b9aa' }, 'Ambiguous schedule id prefix "b9aa" — matches 3 of your schedules. Use more characters.', NOW)?.ok).toBe(false);
    expect(extractReceipt('todo_list', { goalId: 'g', projectId: 'p' }, 'todo_list takes goalId OR projectId, not both.', NOW)?.ok).toBe(false);
  });

  it('empty-success prose ("No schedules found.") IS an executed observation → ok:true', () => {
    expect(extractReceipt('list_schedules', {}, 'No schedules found.', NOW)?.ok).toBe(true);
    expect(extractReceipt('hook_list', {}, 'No event hooks found for that filter.', NOW)?.ok).toBe(true);
  });

  it('boolean-ok:false envelopes → ok:false (preflight refusals / staged gates never executed)', () => {
    expect(extractReceipt('get_chat_status', {}, JSON.stringify({ ok: false, reason: 'tool_not_offered' }), NOW)?.ok).toBe(false);
    expect(extractReceipt('schedule_get', {}, JSON.stringify({ ok: false, needsConfirmation: true }), NOW)?.ok).toBe(false);
  });

  it('a boolean-ok:true envelope → ok:true', () => {
    expect(extractReceipt('list_feedback', {}, JSON.stringify({ ok: true, tickets: [] }), NOW)?.ok).toBe(true);
  });
});

describe('ticket 212b3aa0 — THE REPLAY: the incident final, judged end-to-end', () => {
  it('POST-FIX: the incident final + this-run observation receipts → NO unproven_completion', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: OBSERVE_RECEIPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.unprovenClaims ?? []).toEqual([]);
  });

  it('negative control: the same final with ZERO receipts still convicts (the guard keeps teeth)', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [],
    });
    expect(out.verdict.unprovenKinds).toContain('probe');
  });

  it('negative control: only FAILED observation reads still convicts', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
      receipts: [receipt('get_chat_status', false)],
    });
    expect(out.verdict.unprovenKinds).toContain('probe');
  });

  it('the reject-back notice now names the escape (actionable, not generic claim discipline)', async () => {
    const verdict: GuardVerdict = {
      unprovenKinds: ['probe'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
      unprovenClaims: [claim('probe', INCIDENT_FINAL.split('\n')[1])],
    };
    const notice = renderGuardRejectBackNotice(verdict);
    expect(notice).toContain('evidence class');
    expect(notice).toContain('platform observation read');
    expect(notice).not.toContain('no evidence-bearing tool call this run');
  });
});
