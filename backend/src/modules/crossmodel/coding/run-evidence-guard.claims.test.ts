/**
 * Tests for the CLAIMS-BLOCK guard lane (audit #6 phase 1 —
 * run-evidence-guard.ts Layer 7): claimsBlockLane evaluation,
 * applyClaimsBlockLane verdict composition (positive verdict, conviction,
 * malformed advisory, GUARD-1 prose downgrade), the absent-block
 * ZERO-BEHAVIOR-CHANGE pin against the ticket-1b605132 incident fixture, the
 * forgery-layer registration of the lane's chrome, and the opt-in reject-back
 * composition.
 *
 * Boundary-mocked exactly like run-evidence-guard.test.ts: the GitHub token
 * manager is a stub and global.fetch is stubbed per case; the REAL guard +
 * claims-block modules execute.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetValidToken: jest.Mock = jest.fn(async () => 'tok');
const mockRecordLoopMetric = jest.fn();
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  applyCompletionClaimGuard, applyClaimsBlockLane, claimsBlockLane,
  verdictHasFindings, summarizeGuardVerdict, renderGuardRejectBackNotice,
  renderEvidenceGuardNote, evaluateFinalCandidateForRejectBack, guardFindingKinds,
} from './run-evidence-guard';
import { verifyClaimsBlock } from './claims-block';
import type { ClaimsBlockEntry } from './claims-block';
import type { CompletionClaim, GuardVerdict } from './run-evidence-guard';
import type { ToolReceipt } from './run-receipts';

/** The phantom final answer, adapted from ticket 1b605132 (feedback be0b5271) —
 *  the SAME incident fixture the main suite pins; here it pins that an
 *  absent claims block changes NOTHING about how that incident is handled. */
const PHANTOM = [
  'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.',
  'Blob-verified on main: 217,530/47,189 B.',
  'Box probe 03:07:22: items.jsonl 511 lines, md5 50dd0c04.',
  'Tallies: 363 PASS / 111 TRUNC.',
  'Deploy green, health check 200.',
].join('\n');

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();

const ghResponse = (status: number, body?: any): any => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' } as const;
const NOW = new Date('2026-09-02T12:00:00.000Z');

const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'): ToolReceipt => ({
  id, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});

const fence = (json: string) => '```claims\n' + json + '\n```';

/** Hand-build a guarded triple the way run-executor receives it, for
 *  unit-level composition tests (the end-to-end cases go through
 *  applyCompletionClaimGuard instead). */
const mkGuarded = (finalText: string, notes: string[], verdict: Partial<GuardVerdict>): { finalText: string; notes: string[]; verdict: GuardVerdict } => ({
  finalText, notes,
  verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], ...verdict },
});

// ── claimsBlockLane (pure evaluation) ────────────────────────────────────────

describe('claimsBlockLane', () => {
  it('absent block → present:false, empty result', () => {
    expect(claimsBlockLane('Nothing consequential this run.', [])).toEqual({
      present: false, verified: [], unverified: [], unverifiable: [], coveredKinds: [],
    });
  });

  it('malformed block → present + malformedReason, nothing verified; an UNTERMINATED fence is absent', () => {
    const unterminated = claimsBlockLane('```claims\n[{"type":"push","ref":"x"}', []);
    expect(unterminated.present).toBe(false); // no closing fence → not a block at all
    const out = claimsBlockLane(fence('[{"type":"nope","ref":"x"}]'), []);
    expect(out.present).toBe(true);
    expect(out.malformedReason).toContain('"nope"');
    expect(out.verified).toEqual([]);
    expect(out.coveredKinds).toEqual([]);
  });

  it('fully verified block → coveredKinds from the covered-class map (push → commit_pushed + commit_local)', () => {
    const out = claimsBlockLane(
      fence('[{"type":"push","ref":"1539fa86"}]'),
      [receipt('git_push', true, { branch: 'main', sha: '1539fa86b1c2' })],
    );
    expect(out.verified).toHaveLength(1);
    expect(out.unverified).toHaveLength(0);
    // Finding A1 (2026-09-27): a verified push entry also covers the prose
    // commit_local kind ("banked <sha>") — the sha IS on origin.
    expect(out.coveredKinds).toEqual(['commit_pushed', 'commit_local']);
  });

  it('a PARTIALLY verified block earns ZERO coverage — a half-fabricated block vouches for nothing', () => {
    const out = claimsBlockLane(
      fence('[{"type":"push","ref":"1539fa86"},{"type":"pr","ref":"999"}]'),
      [receipt('git_push', true, { sha: '1539fa86b1c2' })],
    );
    expect(out.verified).toHaveLength(1);
    expect(out.unverified).toHaveLength(1);
    expect(out.coveredKinds).toEqual([]);
  });

  it('verified entries of classes with no prose equivalent (ticket_update, verify) cover nothing', () => {
    const out = claimsBlockLane(
      fence('[{"type":"ticket_update","ref":"0122f6a9"},{"type":"verify","ref":"chain"}]'),
      [
        receipt('file_feedback', true, { ticketId: '0122f6a9-4de4-45ef-8888-999900001111' }),
        receipt('verify', true, { passed: true }, 'bbbbcccc-dddd-4eee-8fff-000011112222'),
      ],
    );
    expect(out.unverified).toHaveLength(0);
    expect(out.verified).toHaveLength(2);
    expect(out.coveredKinds).toEqual([]);
  });
});

// ── applyClaimsBlockLane — identity guarantees ───────────────────────────────

describe('applyClaimsBlockLane — absent block / user trigger = ZERO behavior change', () => {
  it('absent block → the guarded fields are returned REFERENCE-EQUAL', async () => {
    const guarded = mkGuarded('All quiet.', [], {});
    const out = await applyClaimsBlockLane({ originalText: 'All quiet.', guarded, receipts: [], triggerKind: 'schedule' });
    expect(out.finalText).toBe(guarded.finalText);
    expect(out.notes).toBe(guarded.notes);
    expect(out.verdict).toBe(guarded.verdict);
    expect(out.lane.present).toBe(false);
  });

  it('user trigger → identity even with a present, unverifiable block (machine-final protocol)', async () => {
    const text = `Did it.\n\n${fence('[{"type":"pr","ref":"999"}]')}`;
    const guarded = mkGuarded(text, [], {});
    const out = await applyClaimsBlockLane({ originalText: text, guarded, receipts: [], triggerKind: 'user' });
    expect(out.finalText).toBe(guarded.finalText);
    expect(out.verdict).toBe(guarded.verdict);
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it('INCIDENT PIN (ticket 1b605132): the block-less phantom final is handled byte-identically with the lane composed', async () => {
    mockFetch.mockResolvedValue(ghResponse(404)); // PR #224 fabricated, sha 404s
    const guarded = await applyCompletionClaimGuard({
      finalText: PHANTOM, parts: [], triggerKind: 'schedule', resumed: true, now: NOW, ...OPTS,
      receipts: [],
    });
    // Sanity: the incident convicts exactly as the main suite pins it.
    expect(guarded.verdict.unprovenKinds.length).toBeGreaterThan(0);
    expect(guarded.verdict.fabricatedPrs).toEqual([224]);

    const out = await applyClaimsBlockLane({
      originalText: PHANTOM, guarded, receipts: [], triggerKind: 'schedule', resumed: true,
    });
    expect(out.finalText).toBe(guarded.finalText); // reference-equal — not even re-rendered
    expect(out.notes).toBe(guarded.notes);
    expect(out.verdict).toBe(guarded.verdict);
    expect(out.lane.present).toBe(false);
  });

  it('an EMPTY (well-formed) block is neutral — identity, no notes, no findings', async () => {
    const text = `Nothing consequential.\n\n${fence('[]')}`;
    const guarded = mkGuarded(text, [], {});
    const out = await applyClaimsBlockLane({ originalText: text, guarded, receipts: [], triggerKind: 'schedule' });
    expect(out.finalText).toBe(guarded.finalText);
    expect(out.verdict).toBe(guarded.verdict);
    expect(out.lane.present).toBe(true);
  });
});

// ── applyClaimsBlockLane — positive verdict ──────────────────────────────────

describe('applyClaimsBlockLane — fully verified block (positive verdict)', () => {
  it('end-to-end: verified block → claimsBlockVerified, VERIFIED note, still no findings', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { sha: '1539fa86b1c2' })); // guard 2b confirms the sha on origin
    const text = `Pushed 1539fa86 to origin.\n\n${fence('[{"type":"push","ref":"1539fa86"}]')}`;
    const receipts = [receipt('git_push', true, { branch: 'main', sha: '1539fa86b1c2' })];
    const guarded = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts,
    });
    expect(guarded.verdict.unprovenKinds).toEqual([]); // the receipt already exonerates the prose

    const out = await applyClaimsBlockLane({ originalText: text, guarded, receipts, triggerKind: 'schedule' });
    expect(out.verdict.claimsBlockVerified).toBe(true);
    expect(verdictHasFindings(out.verdict)).toBe(false); // the positive verdict is never a finding
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]');
    expect(out.finalText).toContain('→ receipt aaaabbbb'); // 8-char receipt id in the note
    expect(out.notes.length).toBe(guarded.notes.length + 1);
    expect(guarded.notes).not.toContain(out.notes[out.notes.length - 1]); // inputs never mutated
  });
});

// ── applyClaimsBlockLane — conviction ────────────────────────────────────────

describe('applyClaimsBlockLane — unverified entries (conviction, same failure handling)', () => {
  it('unverifiable entries → verdict.unverifiedBlockClaims, a FINDING, and the UNVERIFIED note', async () => {
    const text = `Shipped it.\n\n${fence('[{"type":"push","ref":"deadbeef9"},{"type":"pr","ref":"999"}]')}`;
    const guarded = mkGuarded(text, [], {});
    const notesBefore = guarded.notes.length;
    const out = await applyClaimsBlockLane({ originalText: text, guarded, receipts: [], triggerKind: 'schedule' });
    expect(out.verdict.unverifiedBlockClaims).toEqual(['push deadbeef9', 'pr 999']);
    expect(out.verdict.claimsBlockVerified).toBeUndefined();
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]');
    expect(summarizeGuardVerdict(out.verdict)).toContain('claims-block entries with no matching receipt: push deadbeef9, pr 999');
    // Inputs never mutated:
    expect(guarded.notes.length).toBe(notesBefore);
    expect(verdictHasFindings(guarded.verdict)).toBe(false);
  });

  it('a PARTIALLY verified block still convicts and applies NO downgrade', async () => {
    const prose: CompletionClaim = { kind: 'commit_pushed', sha: '1539fa86', text: 'Pushed 1539fa86 to origin.' };
    const oldNote = renderEvidenceGuardNote([prose], { triggerKind: 'schedule', resumed: false });
    const text = `Pushed 1539fa86 to origin.\n\n${fence('[{"type":"push","ref":"1539fa86"},{"type":"pr","ref":"999"}]')}\n\n${oldNote}`;
    const guarded = mkGuarded(text, [oldNote], { unprovenKinds: ['commit_pushed'], unprovenClaims: [prose] });
    const out = await applyClaimsBlockLane({
      originalText: text, guarded,
      receipts: [receipt('git_push', true, { sha: '1539fa86b1c2' })],
      triggerKind: 'schedule',
    });
    expect(out.verdict.unverifiedBlockClaims).toEqual(['pr 999']);
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']); // untouched — no coverage from a dirty block
    expect(out.finalText).toContain('CLAIMS BLOCK UNVERIFIED');
    expect(out.finalText).toContain('1 other entry did match receipts');
  });

  it('the reject-back notice names the unverified entries and carries NO harness-only chrome', () => {
    const v: GuardVerdict = {
      unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
      unverifiedBlockClaims: ['push deadbeef9'],
    };
    const notice = renderGuardRejectBackNotice(v);
    expect(notice).toContain('typed claims-block entries with no matching receipt');
    expect(notice).toContain('push deadbeef9');
    expect(notice).not.toMatch(/\[HARNESS EVIDENCE GUARD — CLAIMS BLOCK/); // CHROME RULE
  });
});

// ── applyClaimsBlockLane — GUARD-1 prose downgrade ───────────────────────────

describe('applyClaimsBlockLane — verified block downgrades covered prose convictions', () => {
  it('END-TO-END: a url-ref pr claim verifies against the receipt and lifts the prose pr_created conviction (note surgically removed)', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' })); // guard 2 confirms the PR is real+open
    const text = `Opened PR #300 with the fix.\n\n${fence('[{"type":"pr","ref":"https://github.com/o/r/pull/300"}]')}`;
    // The receipt carries only the URL (no prNumber) — receiptMatchesClaim
    // cannot exonerate the id-only pr_created prose claim, so GUARD 1 convicts…
    const receipts = [receipt('open_pull_request', true, { url: 'https://github.com/o/r/pull/300' })];
    const guarded = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS, receipts,
    });
    expect(guarded.verdict.unprovenKinds).toEqual(['pr_created']);
    expect(guarded.finalText).toContain('NO FRESH EVIDENCE');

    // …and the verified claims block lifts exactly that conviction.
    const out = await applyClaimsBlockLane({ originalText: text, guarded, receipts, triggerKind: 'schedule' });
    expect(out.verdict.claimsBlockVerified).toBe(true);
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.unprovenClaims).toBeUndefined();
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).not.toContain('NO FRESH EVIDENCE'); // guard-1 note surgically removed
    expect(out.finalText).toContain('CLAIMS BLOCK VERIFIED');
    expect(out.finalText).toContain('covered claim class(es): pr_created');
    // The guard-2 GitHub footer SURVIVES — the downgrade touches only guard 1.
    expect(out.finalText).toContain('Harness claim verification');
    // Original guarded output untouched (new objects only):
    expect(guarded.verdict.unprovenKinds).toEqual(['pr_created']);
    expect(guarded.finalText).toContain('NO FRESH EVIDENCE');
  });

  it('ID-NARROW: a verified push of sha A does NOT downgrade a prose push claim of sha B', async () => {
    const proseB: CompletionClaim = { kind: 'commit_pushed', sha: 'deadbeef99', text: 'Pushed deadbeef99 to origin.' };
    const oldNote = renderEvidenceGuardNote([proseB], { triggerKind: 'schedule', resumed: false });
    const body = `Pushed deadbeef99 to origin.\n\n${fence('[{"type":"push","ref":"1539fa86"}]')}`;
    const guarded = mkGuarded(`${body}\n\n${oldNote}`, [oldNote], { unprovenKinds: ['commit_pushed'], unprovenClaims: [proseB] });
    const out = await applyClaimsBlockLane({
      originalText: body, guarded,
      receipts: [receipt('git_push', true, { sha: '1539fa86b1c2' })],
      triggerKind: 'schedule',
    });
    expect(out.verdict.claimsBlockVerified).toBe(true);
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']); // NOT laundered
    expect(out.verdict.unprovenClaims).toEqual([proseB]);
    expect(out.finalText).toContain(oldNote); // conviction note stays
  });

  it('PARTIAL downgrade: the guard-1 note is re-rendered over the surviving claims only', async () => {
    const proseA: CompletionClaim = { kind: 'commit_pushed', sha: '1539fa86', text: 'Pushed 1539fa86 to origin.' };
    const proseB: CompletionClaim = { kind: 'commit_pushed', sha: 'deadbeef99', text: 'Pushed deadbeef99 too.' };
    const oldNote = renderEvidenceGuardNote([proseA, proseB], { triggerKind: 'schedule', resumed: false });
    const newNote = renderEvidenceGuardNote([proseB], { triggerKind: 'schedule', resumed: false });
    const body = `Pushed 1539fa86 to origin.\nPushed deadbeef99 too.\n\n${fence('[{"type":"push","ref":"1539fa86"}]')}`;
    const guarded = mkGuarded(`${body}\n\n${oldNote}`, [oldNote], { unprovenKinds: ['commit_pushed'], unprovenClaims: [proseA, proseB] });
    const out = await applyClaimsBlockLane({
      originalText: body, guarded,
      receipts: [receipt('git_push', true, { sha: '1539fa86b1c2' })],
      triggerKind: 'schedule',
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_pushed']);
    expect(out.verdict.unprovenClaims).toEqual([proseB]); // A covered, B survives
    expect(out.notes).toContain(newNote);
    expect(out.notes).not.toContain(oldNote);
    expect(out.finalText).toContain(newNote);
    expect(out.finalText).not.toContain(oldNote);
  });

  it('CLASS-WIDE for id-less kinds: a verified deploy entry lifts a prose deploy conviction (P4 v1#23: the entry must now VERIFY by id — a coarse `ls`-vouched ref no longer counts)', async () => {
    const prose: CompletionClaim = { kind: 'deploy', text: 'Deploy green, health check 200.' };
    const oldNote = renderEvidenceGuardNote([prose], { triggerKind: 'hook', resumed: false });
    // The entry ref names the receipted push sha — a REAL id binding (the old
    // fixture's descriptive ref + generic ok run_command now lands in the
    // unverifiable tier and lifts nothing).
    const body = `Deploy green, health check 200.\n\n${fence('[{"type":"deploy","ref":"1539fa86"}]')}`;
    const guarded = mkGuarded(`${body}\n\n${oldNote}`, [oldNote], { unprovenKinds: ['deploy'], unprovenClaims: [prose] });
    const out = await applyClaimsBlockLane({
      originalText: body, guarded, receipts: [receipt('git_push', true, { sha: '1539fa86b1c2' })], triggerKind: 'hook',
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.unprovenClaims).toBeUndefined();
    expect(out.finalText).not.toContain(oldNote);
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it('P4 v1#23: an UNVERIFIABLE deploy entry (descriptive ref, generic ok receipt) lifts NOTHING — the prose conviction stands and no positive verdict is earned', async () => {
    const prose: CompletionClaim = { kind: 'deploy', text: 'Deploy green, health check 200.' };
    const oldNote = renderEvidenceGuardNote([prose], { triggerKind: 'hook', resumed: false });
    const body = `Deploy green, health check 200.\n\n${fence('[{"type":"deploy","ref":"digby.ai blue-green flip"}]')}`;
    const guarded = mkGuarded(`${body}\n\n${oldNote}`, [oldNote], { unprovenKinds: ['deploy'], unprovenClaims: [prose] });
    const out = await applyClaimsBlockLane({
      originalText: body, guarded, receipts: [receipt('run_command', true)], triggerKind: 'hook',
      recordMetric: mockRecordLoopMetric, sessionId: 's1', runId: 'r1',
    });
    expect(out.verdict.unprovenKinds).toEqual(['deploy']); // conviction survives
    expect(out.verdict.claimsBlockVerified).toBeUndefined();
    expect(out.finalText).toContain(oldNote); // the guard-1 note stays
    // Gate flip 2026-09-11: the unverifiable advisory is a guard_miss metric, not a note on the final.
    expect(out.finalText).not.toContain('CLAIMS BLOCK UNVERIFIABLE');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_miss', sessionId: 's1', runId: 'r1', meta: expect.objectContaining({ seam: 'claims_block_unverifiable', n: 1, outcome: 'observed' }),
    }));
  });

  it('NON-GUARD-1 findings are never downgraded: fabricatedPrs survive a verified block', async () => {
    const body = `Pushed 1539fa86.\n\n${fence('[{"type":"push","ref":"1539fa86"}]')}`;
    const guarded = mkGuarded(body, [], { fabricatedPrs: [999] });
    const out = await applyClaimsBlockLane({
      originalText: body, guarded,
      receipts: [receipt('git_push', true, { sha: '1539fa86b1c2' })],
      triggerKind: 'schedule',
    });
    expect(out.verdict.claimsBlockVerified).toBe(true);
    expect(out.verdict.fabricatedPrs).toEqual([999]); // GitHub-refuted truth outranks the typed self-report
    expect(verdictHasFindings(out.verdict)).toBe(true);
  });
});

// ── applyClaimsBlockLane — malformed advisory ────────────────────────────────

describe('applyClaimsBlockLane — malformed block (advisory only)', () => {
  it('appends the MALFORMED note; verdict stays finding-free and prose lanes stay authoritative', async () => {
    const text = `Done.\n\n${fence('[{"type":"push","ref":}]')}`;
    const guarded = mkGuarded(text, [], {});
    const out = await applyClaimsBlockLane({ originalText: text, guarded, receipts: [], triggerKind: 'schedule' });
    expect(out.lane.malformedReason).toBeTruthy();
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]');
    expect(out.verdict).toEqual(guarded.verdict);
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });
});

// ── Forgery-layer registration ───────────────────────────────────────────────

describe('the claims-block lane chrome joins FORGED_MARKER_RES (guard 0)', () => {
  it.each([
    ['VERIFIED banner', '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]'],
    ['UNVERIFIED banner', '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]'],
    ['MALFORMED banner', '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]'],
  ])('a model-authored final containing the %s convicts as forgery', async (_label, marker) => {
    const out = await applyCompletionClaimGuard({
      finalText: `All verified, see below.\n\n${marker}\nEverything matched receipts.`,
      parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(verdictHasFindings(out.verdict)).toBe(true);
  });
});

// ── evaluateFinalCandidateForRejectBack — opt-in composition ─────────────────

describe('evaluateFinalCandidateForRejectBack — applyClaimsBlock opt-in (default OFF)', () => {
  const BASE = {
    parts: [] as any[], triggerKind: 'schedule' as const, resumed: false,
    userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github',
  };

  it('default OFF: an unverifiable block alone does NOT reject (phase-1 zero behavior change)', async () => {
    const out = await evaluateFinalCandidateForRejectBack({
      ...BASE,
      finalText: `Housekeeping only.\n\n${fence('[{"type":"push","ref":"deadbeef9"}]')}`,
      receipts: [],
    });
    expect(out.rejected).toBe(false);
  });

  it('gate flip 2026-09-11 — opted IN: an unverifiable block alone is NOTE-ONLY and does NOT reject (was: rejects with the claims-block reason)', async () => {
    // The lane still composes (verdict.unverifiedBlockClaims + the UNVERIFIED
    // note reach the executor's finalize telemetry), but the reject-back
    // decision runs on a copy with the class cleared — every recoverable
    // exhibit was honest work in the wrong receipt shape. No env re-arms it.
    const out = await evaluateFinalCandidateForRejectBack({
      ...BASE,
      finalText: `Housekeeping only.\n\n${fence('[{"type":"push","ref":"deadbeef9"}]')}`,
      receipts: [],
      applyClaimsBlock: true,
    });
    expect(out).toEqual({ rejected: false });
  });

  it('gate flip 2026-09-11 — opted IN: a block miss riding WITH a hard finding still rejects, and the notice names ONLY the hard class', async () => {
    // Prose pr_merged with zero receipts (guard-1 conviction) + an unverifiable
    // block entry: the hard class rejects; the block class is absent from the
    // notice/summary/kinds so the model is not asked to "fix" a note-only class.
    const out = await evaluateFinalCandidateForRejectBack({
      ...BASE,
      finalText: `Merged PR #57 after green CI.\n\n${fence('[{"type":"push","ref":"deadbeef9"}]')}`,
      receipts: [],
      applyClaimsBlock: true,
    });
    expect(out.rejected).toBe(true);
    expect(out.kinds).toContain('unproven_completion');
    expect(out.kinds).not.toContain('unverified_block_claim');
    expect(out.summary).not.toContain('claims-block entries with no matching receipt');
    expect(out.notice).not.toContain('push deadbeef9');
  });

  it('opted IN: a fully verified block DOWNGRADES a would-reject guard-1 conviction into a clean pass', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { merged: false, state: 'open' }));
    const finalText = `Opened PR #300 with the fix.\n\n${fence('[{"type":"pr","ref":"https://github.com/o/r/pull/300"}]')}`;
    const receipts = [receipt('open_pull_request', true, { url: 'https://github.com/o/r/pull/300' })];

    const withoutLane = await evaluateFinalCandidateForRejectBack({ ...BASE, finalText, receipts });
    expect(withoutLane.rejected).toBe(true); // guard 1 convicts the id-only pr_created claim

    const withLane = await evaluateFinalCandidateForRejectBack({ ...BASE, finalText, receipts, applyClaimsBlock: true });
    expect(withLane.rejected).toBe(false); // the verified typed claim lifts it
  });

  it('user triggers stay never-gated regardless of the flag', async () => {
    const out = await evaluateFinalCandidateForRejectBack({
      ...BASE, triggerKind: 'user' as any,
      finalText: `Done.\n\n${fence('[{"type":"push","ref":"deadbeef9"}]')}`,
      receipts: [], applyClaimsBlock: true,
    });
    expect(out.rejected).toBe(false);
  });
});

// ── guardFindingKinds — the loop-metrics meta.kinds vocabulary (audit #12) ────

describe('guardFindingKinds', () => {
  const clean: GuardVerdict = { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] };

  it('a clean verdict (and null/undefined) yields []', () => {
    expect(guardFindingKinds(clean)).toEqual([]);
    expect(guardFindingKinds(null)).toEqual([]);
    expect(guardFindingKinds(undefined)).toEqual([]);
  });

  it('names every populated finding class exactly once, matching verdictHasFindings clause order', () => {
    const maximal: GuardVerdict = {
      unprovenKinds: ['pr_merged', 'deploy'], fabricatedPrs: [224], refutedMergePrs: [225],
      futureDated: ['12:18Z (+5m)'], forgedFooter: true,
      fabricatedShas: ['84fe3ae0'], fabricatedQuotes: ['q'],
      fabricatedDeployRuns: ['1'], refutedDeployRuns: ['2'], fabricatedTicketIds: ['t'],
      unverifiedBlockClaims: ['pr 999'],
    };
    expect(guardFindingKinds(maximal)).toEqual([
      'unproven_completion', 'fabricated_pr', 'refuted_merge', 'future_dated', 'forged_footer',
      'fabricated_sha', 'fabricated_quote', 'fabricated_deploy_run', 'refuted_deploy_run',
      'fabricated_ticket_id', 'unverified_block_claim',
    ]);
  });

  it('stays consistent with verdictHasFindings: non-empty kinds ⇔ findings', () => {
    const single: GuardVerdict = { ...clean, unverifiedBlockClaims: ['push deadbeef9'] };
    expect(guardFindingKinds(single)).toEqual(['unverified_block_claim']);
    expect(verdictHasFindings(single)).toBe(true);
    expect(verdictHasFindings(clean)).toBe(false);
    expect(guardFindingKinds(clean)).toHaveLength(0);
  });
});

// ── Ticket 6d7b379f — the finish_run vocabulary in the fence ─────────────────
//
// DETECTOR-RECALL REPLAY: this PR touches coding/run-evidence-guard.ts and
// coding/claims-block.ts (framework detectors), so it replays the claims
// lane's PRIOR true positives and asserts they STILL fire after the enum
// widening + the nag-suppression change. The relaxations must not erode
// recall:
//   1. the MALFORMED conviction path itself — a genuinely unknown type still
//      malforms the block (the live incident's notice was CORRECT about the
//      parse; the enum was wrong);
//   2. an unverified entry of every NEW type in its CONVICTION shape (a
//      forged full-uuid receipt citation, a wrong-sha commit) still convicts
//      as UNVERIFIED;
//   3. the prose-laundering guard: a commit entry with NO receipt never
//      downgrades a prose commit_pushed conviction (a local commit is not a
//      push — finding A1's receipt split holds);
//   4. the commit_local coverage is sha-narrowed: a verified commit of sha A
//      does not launder a prose banked-sha-B claim;
//   5. the unpushed-commit note still fires for an UNDECLARED strand, a
//      MALFORMED declared block, and a multi-commit strand.

describe('ticket 6d7b379f — finish_run vocabulary joins the fence', () => {
  it('the live incident shape is now a POSITIVE typed record: commit + note parses, verifies against the git_commit receipt, and earns the VERIFIED note', async () => {
    const sha = '1833febd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
    const text = `The fix is banked locally — push refused by the open gate.\n\n${fence(`[{"type":"commit","ref":"${sha}","note":"banked on digby/session-b92ef13f, push refused by oq_6fbf2dc6 — local, not claimed as pushed"}]`)}`;
    const receipts = [receipt('git_commit', true, { sha })];
    const out = await applyClaimsBlockLane({ originalText: text, guarded: mkGuarded(text, [], {}), receipts, triggerKind: 'schedule' });
    expect(out.lane.malformedReason).toBeUndefined();
    expect(out.lane.verified.map((v) => v.claim.type)).toEqual(['commit']);
    expect(out.lane.coveredKinds).toEqual(['commit_local']);
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]');
    expect(out.verdict.claimsBlockVerified).toBe(true);
  });

  it('a commit entry with NO receipt still convicts (the 4243f38a discipline: a sha-bearing claim names its evidence)', async () => {
    const text = `Banked.\n\n${fence('[{"type":"commit","ref":"1833febd1a"}]')}`;
    const out = await applyClaimsBlockLane({ originalText: text, guarded: mkGuarded(text, [], {}), receipts: [], triggerKind: 'schedule' });
    expect(out.lane.unverified.map((c) => c.type)).toEqual(['commit']);
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]');
    expect(out.verdict.unverifiedBlockClaims).toEqual(['commit 1833febd1a']);
  });

  it('DETECTOR-RECALL REPLAY 1 — a genuinely UNKNOWN claim type still malforms the block (the parse discipline the incident notice taught)', () => {
    // "merged" was never a type (merge is); the enum widening must not
    // become "accept anything".
    const out = claimsBlockLane(fence('[{"type":"merged","ref":"241"}]'), []);
    expect(out.present).toBe(true);
    expect(out.malformedReason).toContain('"merged"');
    expect(out.verified).toHaveLength(0);
  });

  it('DETECTOR-RECALL REPLAY 2 — forged full-uuid refs of the NEW types still convict (never the unverifiable tier)', () => {
    const uuid = '9c8b7a6d-1111-2222-3333-444455556666';
    for (const type of ['commit', 'schedule_armed', 'email_sent', 'state_update'] as const) {
      const out = verifyClaimsBlock([{ type, ref: uuid } as ClaimsBlockEntry], []);
      expect(out.unverified.map((c) => c.type)).toEqual([type]); // forged uuid must convict, never the unverifiable tier
      expect(out.unverifiable).toHaveLength(0);
    }
  });

  it('DETECTOR-RECALL REPLAY 3 — a verified commit entry NEVER downgrades a prose commit_pushed conviction (a local commit is not a push)', async () => {
    const sha = '1833febd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
    // Prose claims the sha was PUSHED; the fence honestly says commit-only.
    const text = `Shipped: pushed ${sha.slice(0, 8)} to origin/main.\n\n${fence(`[{"type":"commit","ref":"${sha.slice(0, 8)}"}]`)}`;
    const receipts = [receipt('git_commit', true, { sha })];
    const guarded = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    // mockFetch 404s by default → the prose push claim is unproven.
    const composed = await applyClaimsBlockLane({
      originalText: text, guarded: { finalText: guarded.finalText, notes: guarded.notes, verdict: guarded.verdict },
      receipts, triggerKind: 'schedule',
    });
    // The commit entry is verified...
    expect(composed.lane.verified.map((v) => v.claim.type)).toEqual(['commit']);
    // ...but the prose commit_pushed conviction SURVIVES (commit covers
    // commit_local only — never commit_pushed).
    expect(composed.verdict.unprovenClaims?.some((c) => c.kind === 'commit_pushed')).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY 4 — the commit→commit_local coverage is sha-narrowed: a verified commit of sha A does not launder a banked-sha-B prose claim', async () => {
    const shaA = '1833febd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
    const shaB = 'deadbeef9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
    const text = `Fully banked ${shaB.slice(0, 12)} on the session branch.\n\n${fence(`[{"type":"commit","ref":"${shaA.slice(0, 8)}"}]`)}`;
    const receipts = [receipt('git_commit', true, { sha: shaA })];
    const guarded = await applyCompletionClaimGuard({
      finalText: text, parts: [], triggerKind: 'schedule', now: NOW, ...OPTS,
    });
    const composed = await applyClaimsBlockLane({
      originalText: text, guarded: { finalText: guarded.finalText, notes: guarded.notes, verdict: guarded.verdict },
      receipts, triggerKind: 'schedule',
    });
    expect(composed.lane.verified.map((v) => v.claim.type)).toEqual(['commit']);
    // The banked-B claim (commit_local) is NOT covered by the verified
    // commit of sha A — id-narrowing holds for the new class too.
    expect(composed.verdict.unprovenClaims?.some((c) => c.kind === 'commit_local')).toBe(true);
  });
});
