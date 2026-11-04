/**
 * audit 2026-10-06 T7-6 (stanne.md #8) — the evidence guard no longer
 * contradicts itself on a relayed merge: pr_merged / pr_closed convictions
 * wait for the PR API (a merge GitHub confirms is a verified fact), and the
 * GUARD-1 sentence counts the evidence-bearing calls that DID run instead of
 * always printing "zero evidence-bearing tool calls".
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

import { applyCompletionClaimGuard, renderEvidenceGuardNote, verdictHasFindings, extractCompletionClaims } from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
const NOW = new Date('2026-10-06T02:15:00.000Z');
const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();
const ghResponse = (status: number, body?: any): any => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** The c2cd1068 harvest shape: 13 platform reads, a relayed merge. */
const READS: any[] = ['get_chat_status', 'get_run_receipts', 'todo_list', 'get_chat_messages'].map((name) => ({ type: 'tool_call', name, args: {} }));
const RELAY = 'Lane f150100b finished the gateway build: PR #3 merged into main (lane receipt f9a18f63).';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GUARD_DEFER_PR_PUSH_DISABLED;
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
});
afterAll(() => { global.fetch = realFetch; delete process.env.GUARD_DEFER_PR_PUSH_DISABLED; });

describe('T7-6 — relayed merges reconcile against the PR API before convicting', () => {
  it('a merge GitHub CONFIRMS is not convicted: no UNVERIFIED note beside "VERIFIED MERGED"', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: true, state: 'closed', merge_commit_sha: '4d57e99ccfc8aaaa', merged_at: '2026-10-06T02:03:00Z' }));
    const out = await applyCompletionClaimGuard({ finalText: RELAY, parts: READS, triggerKind: 'hook', now: NOW, ...OPTS, receipts: [] });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.finalText).toContain('VERIFIED MERGED');
    expect(out.finalText).not.toContain('[HARNESS EVIDENCE GUARD]\n');
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it('a merge GitHub REFUTES still convicts — rendered after the footer, with the real call count', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({ finalText: RELAY, parts: READS, triggerKind: 'hook', now: NOW, ...OPTS, receipts: [] });
    expect(out.verdict.unprovenKinds).toEqual(['pr_merged']);
    expect(out.verdict.refutedMergePrs).toEqual([3]);
    const noteAt = out.finalText.indexOf('[HARNESS EVIDENCE GUARD]\n');
    expect(noteAt).toBeGreaterThan(out.finalText.indexOf('Harness claim verification'));
    expect(out.finalText).toContain('made 4 evidence-bearing tool calls, but none of them evidences the completions below');
    expect(out.finalText).not.toContain('zero evidence-bearing tool calls');
  });

  it('an UNAVAILABLE PR API (no token) leaves the merge unconfirmed ⇒ still convicted', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const out = await applyCompletionClaimGuard({ finalText: RELAY, parts: READS, triggerKind: 'hook', now: NOW, ...OPTS, receipts: [] });
    expect(out.verdict.unprovenKinds).toEqual(['pr_merged']);
  });

  it('a create claim is NOT deferred (the 630fadc0 authorship class): an existing PR still flags pr_created', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const out = await applyCompletionClaimGuard({ finalText: 'Opened PR #300 with the fix.', parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts: [] });
    expect(out.verdict.unprovenKinds).toEqual(['pr_created']);
    expect(out.finalText).toContain('zero evidence-bearing tool calls'); // nothing ran: the original sentence is the true one
  });

  it('GUARD_DEFER_PR_PUSH_DISABLED=1: GUARD 1 convicts the confirmed merge again, with the legacy "zero" sentence', async () => {
    process.env.GUARD_DEFER_PR_PUSH_DISABLED = '1';
    mockFetch.mockResolvedValue(ghResponse(200, { merged: true, state: 'closed', merge_commit_sha: '4d57e99ccfc8aaaa' }));
    const out = await applyCompletionClaimGuard({ finalText: RELAY, parts: READS, triggerKind: 'hook', now: NOW, ...OPTS, receipts: [] });
    expect(out.verdict.unprovenKinds).toEqual(['pr_merged']);
    expect(out.finalText).toContain('made zero evidence-bearing tool calls');
    expect(out.finalText.indexOf('[HARNESS EVIDENCE GUARD]\n')).toBeLessThan(out.finalText.indexOf('Harness claim verification'));
  });
});

describe('renderEvidenceGuardNote — the call count', () => {
  const claims = extractCompletionClaims('Merged PR #12 into main.');
  it('omitted / 0 ⇒ the original sentence; N > 0 ⇒ the honest count', () => {
    expect(renderEvidenceGuardNote(claims, { triggerKind: 'schedule', resumed: false })).toContain('made zero evidence-bearing tool calls — NO FRESH EVIDENCE this turn.');
    expect(renderEvidenceGuardNote(claims, { triggerKind: 'schedule', resumed: false, evidenceCalls: 0 })).toContain('made zero evidence-bearing tool calls');
    expect(renderEvidenceGuardNote(claims, { triggerKind: 'schedule', resumed: false, evidenceCalls: 1 })).toContain('made 1 evidence-bearing tool call, but none of them evidences the completions below — NO FRESH EVIDENCE for these claims.');
  });
});
