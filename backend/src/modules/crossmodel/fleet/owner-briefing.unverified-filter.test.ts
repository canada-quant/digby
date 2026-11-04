/**
 * BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20) — the owner briefing never states an
 * unverified action claim as fact. Pins: the deterministic path MARKS the claim "(unverified)" on its
 * project line (other lines byte-identical; a truncation never cuts the marker off); the LLM path never
 * SEES the claim (it is dropped from the prompt's note and from the grounding note); claims are read back
 * from an annotation paragraph embedded in a stored note (the dashboard bootstrap caller), and that
 * paragraph never reaches the rewrite; one briefing_unverified_filter row per posted briefing that was
 * handed claims; BRIEFING_UNVERIFIED_FILTER_DISABLED=1 restores the previous input byte-for-byte. Review fix
 * (2026-10-20): a free-form note whose every line is an unverified claim never reaches the LLM (it would see only
 * the liveness line) — the marked claim is posted deterministically.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async ({ data }: any) => ({ id: 'brief-row-1', ...data })) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  },
}));

const mockUtilityChat = jest.fn(async (..._a: any[]): Promise<string> => 'CanLaw: benchmark pack finished → summary next → tomorrow evening');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
jest.mock('../platform/supervisor-state.service', () => ({ __esModule: true, getFleetLivenessSnapshot: jest.fn(async () => null) }));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

import { generateOwnerBriefing, prepareBriefingNote, renderBriefingFromNote, renderUnverifiedOnlyBriefing } from './owner-briefing.service';
import { UNVERIFIED_MARKER, placeUnverifiedFootnote, renderUnverifiedClaimsFootnote, stripUnverifiedFootnote, type UnverifiedClaim } from '../platform/unverified-claims';
import { applyHarnessReceipts } from '../platform/harness-receipts';
import { CARRIED_FORWARD_LABEL } from '../chat-agent/structured-blocks';

const DET_NOTE = [
  '**CanLaw** — dispatched the bench rerun to the GPU lane → results tonight',
  '**Tenstorrent** — speed check passed → next comparison queued → no ETA yet',
].join('\n');
const CLAIM: UnverifiedClaim = { kind: 'dispatch', quote: 'dispatched the bench rerun to the GPU lane', source: 'action_verifier' };
// Free-form (no parseable per-project sections) → the LLM path.
const FREE_NOTE = 'CanLaw and Tenstorrent both checked in. I dispatched the summary draft to the writing lane for the morning run. The benchmark pack finished.';
const FREE_CLAIM: UnverifiedClaim = { kind: 'dispatch', quote: 'I dispatched the summary draft to the writing lane for the morning run.', source: 'zero_tool_dispatch' };

const posted = () => mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content as string;
const filterRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m?.kind === 'briefing_unverified_filter');
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  delete process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED;
});
afterEach(() => {
  delete process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED;
});

describe('deterministic path — the claim is MARKED on its project line', () => {
  it('marks the claim, leaves every other line as rendered before, and records one row', async () => {
    const ok = await generateOwnerBriefing({ chatId: 'sup-1', userId: 'u1', noteContent: DET_NOTE, unverifiedClaims: [CLAIM], sourceNoteId: 'n-1' });
    expect(ok).toBe(true);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    const lines = posted().split('\n');
    expect(lines[0]).toBe(`CanLaw: dispatched the bench rerun to the GPU lane ${UNVERIFIED_MARKER} → results tonight`);
    expect(lines[1]).toBe(renderBriefingFromNote(DET_NOTE)!.split('\n')[1]);
    await settle();
    expect(filterRows()).toHaveLength(1);
    expect(filterRows()[0]).toMatchObject({ sessionId: 'sup-1', value: 1, meta: { path: 'deterministic', supplied: 1, embedded: 0, located: 1, markedInBriefing: 1, droppedFromLlmInput: 0, sourceNoteId: 'n-1' } });
  });

  it('reads the claims back from an annotation paragraph embedded in a stored note (bootstrap caller) and never renders that paragraph', async () => {
    const footnote = renderUnverifiedClaimsFootnote([CLAIM], { zeroTool: true });
    await generateOwnerBriefing({ chatId: 'sup-2', userId: 'u1', noteContent: `${DET_NOTE}\n\n${footnote}` });
    expect(posted()).toContain(`GPU lane ${UNVERIFIED_MARKER}`);
    expect(posted()).not.toContain('ACTION VERIFIER');
    await settle();
    expect(filterRows()[0].meta).toMatchObject({ supplied: 0, embedded: 1, located: 1 });
  });

  it('a truncated long project line keeps its marker', () => {
    const long = `**CanLaw** — ${'progress detail '.repeat(20)}then dispatched the bench rerun to the GPU lane`;
    const { markedNote } = prepareBriefingNote(long, [CLAIM]);
    const line = renderBriefingFromNote(markedNote)!;
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line.endsWith(`… ${UNVERIFIED_MARKER}`)).toBe(true);
    // Without a claim the same note renders exactly as before (no marker logic touched it).
    expect(renderBriefingFromNote(prepareBriefingNote(long, []).markedNote)).toBe(renderBriefingFromNote(long));
  });

  it('an unlocated claim changes nothing (its row records located 0; a note handed none writes no row)', async () => {
    await generateOwnerBriefing({ chatId: 'sup-3', userId: 'u1', noteContent: DET_NOTE, unverifiedClaims: [{ ...CLAIM, quote: 'merged the release branch into main' }] });
    expect(posted()).toBe(renderBriefingFromNote(DET_NOTE));
    await settle();
    // Handed but unlocated: the row says so (located 0) — the telemetry of a claim the note no longer carries.
    expect(filterRows()[0].meta).toMatchObject({ supplied: 1, located: 0, markedInBriefing: 0 });
    jest.clearAllMocks();
    redisStore.clear();
    await generateOwnerBriefing({ chatId: 'sup-4', userId: 'u1', noteContent: DET_NOTE });
    expect(posted()).toBe(renderBriefingFromNote(DET_NOTE));
    await settle();
    expect(filterRows()).toHaveLength(0);
  });
});

describe('LLM path — the claim never reaches the rewrite', () => {
  it('drops the claim from the prompt note; the rest of the note is still there', async () => {
    await generateOwnerBriefing({ chatId: 'sup-5', userId: 'u1', noteContent: FREE_NOTE, unverifiedClaims: [FREE_CLAIM] });
    const [messages] = mockUtilityChat.mock.calls[0];
    expect(messages[1].content).not.toContain('dispatched the summary draft');
    expect(messages[1].content).toContain('CanLaw and Tenstorrent both checked in.');
    expect(messages[1].content).toContain('The benchmark pack finished.');
    await settle();
    expect(filterRows()[0].meta).toMatchObject({ path: 'llm', located: 1, droppedFromLlmInput: 1 });
  });

  it('an embedded annotation paragraph never reaches the rewrite prompt', async () => {
    const footnote = renderUnverifiedClaimsFootnote([FREE_CLAIM], { zeroTool: true });
    await generateOwnerBriefing({ chatId: 'sup-6', userId: 'u1', noteContent: `${FREE_NOTE}\n\n${footnote}` });
    const [messages] = mockUtilityChat.mock.calls[0];
    expect(messages[1].content).not.toContain('ACTION VERIFIER');
    expect(messages[1].content).not.toContain('dispatched the summary draft');
  });
});

describe('REVIEW FIX (2026-10-20): a free-form note whose EVERY line is an unverified claim', () => {
  it('never reaches the LLM (it would see only the liveness line and could answer "Nothing new"): the marked claim is posted deterministically', async () => {
    mockUtilityChat.mockResolvedValueOnce('Nothing new on any project since the last update.');
    const note = 'I dispatched the bench rerun to the eval lane 7fbd168c.';
    const claim: UnverifiedClaim = { kind: 'dispatch', quote: note, source: 'zero_tool_dispatch' };
    expect(prepareBriefingNote(note, [claim]).droppedNote).toBe('');
    const ok = await generateOwnerBriefing({ chatId: 'sup-9', userId: 'u1', noteContent: note, unverifiedClaims: [claim] });
    expect(ok).toBe(true);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(posted()).toBe(`I dispatched the bench rerun to the eval lane ${UNVERIFIED_MARKER}.`); // id scrubbed like every rendered body
    expect(posted()).not.toContain('Nothing new');
    await settle();
    expect(filterRows()[0].meta).toMatchObject({ path: 'deterministic', located: 1, markedInBriefing: 1, droppedFromLlmInput: 0, unverifiedOnly: true });
  });

  it('renderUnverifiedOnlyBriefing: one line per marked line (markup scrubbed, quotes / code / tables skipped, marker kept on a clip); null when nothing renders', () => {
    const marked = [
      `- I dispatched the bench rerun ${UNVERIFIED_MARKER}.`,
      `> quoted I messaged the lane ${UNVERIFIED_MARKER}`,
      `| a | b ${UNVERIFIED_MARKER} |`,
      `**I armed ${'the nightly watch '.repeat(20)}${UNVERIFIED_MARKER}.**`,
    ].join('\n');
    const out = renderUnverifiedOnlyBriefing(marked)!.split('\n');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(`I dispatched the bench rerun ${UNVERIFIED_MARKER}.`);
    expect(out[1].length).toBeLessThanOrEqual(240);
    expect(out[1].endsWith(`… ${UNVERIFIED_MARKER}`)).toBe(true);
    expect(renderUnverifiedOnlyBriefing('plain line with no marker')).toBeNull();
    expect(renderUnverifiedOnlyBriefing('')).toBeNull();
  });

  it('a note with other content still takes the LLM path (the claim dropped, the rest kept)', async () => {
    await generateOwnerBriefing({ chatId: 'sup-10', userId: 'u1', noteContent: FREE_NOTE, unverifiedClaims: [FREE_CLAIM] });
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
  });
});

// Review fix (2026-10-20) — the REAL appended note: a supervisor machine wake's note carries the harness
// appendix (applyHarnessReceipts — here the zero-call no-op line) with the footnote placed in front of it.
// The no-op line parsed as the model's 'WAKE: no-op': a free-form note briefed "Nothing new" (skipped on
// project scope) and the unverified-only branch above could never run (droppedNote kept the harness text).
describe('REVIEW FIX (2026-10-20): the harness appendix is never the model\'s words', () => {
  const NOOP = 'WAKE: no-op (harness: 0 lane actions)';
  const persistedNote = (note: string, claims: UnverifiedClaim[]): { text: string; footnote: string } => {
    const applied = applyHarnessReceipts(note, { actions: [], reportUps: [], notExecuted: [] });
    expect(applied.appendix).toBe(NOOP);
    const footnote = claims.length ? renderUnverifiedClaimsFootnote(claims, { zeroTool: true, briefingFiltered: true }) : '';
    return { text: footnote ? placeUnverifiedFootnote(applied.text, footnote, applied.appendix) : applied.text, footnote };
  };
  afterEach(() => {
    delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    delete mockPrisma.crossModelChat;
  });

  it('a zero-tool dispatch claim under the no-op appendix posts the claim, marked — the live input and the stored note (bootstrap) alike, never "Nothing new"', async () => {
    const note = 'I dispatched the bench rerun to the eval lane 7fbd168c.';
    const claim: UnverifiedClaim = { kind: 'dispatch', quote: note, source: 'zero_tool_dispatch' };
    const { text, footnote } = persistedNote(note, [claim]);
    expect(text).toBe(`${note}\n\n${footnote}\n\n${NOOP}`);
    // The note minus the footnote (the round-3 integrated live input — the appendix still on it).
    const live = stripUnverifiedFootnote(text, footnote);
    expect(prepareBriefingNote(live, [claim]).droppedNote).toBe('');
    expect(await generateOwnerBriefing({ chatId: 'sup-h1', userId: 'u1', noteContent: live, unverifiedClaims: [claim] })).toBe(true);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(posted()).toBe(`I dispatched the bench rerun to the eval lane ${UNVERIFIED_MARKER}.`);
    await settle();
    expect(filterRows()[0].meta).toMatchObject({ path: 'deterministic', located: 1, unverifiedOnly: true });
    // The whole persisted note (fleet.service's bootstrap caller): the claim is read back from the footnote.
    jest.clearAllMocks();
    redisStore.clear();
    expect(await generateOwnerBriefing({ chatId: 'sup-h2', userId: 'u1', noteContent: text })).toBe(true);
    expect(posted()).toBe(`I dispatched the bench rerun to the eval lane ${UNVERIFIED_MARKER}.`);
    expect(posted()).not.toContain('Nothing new');
  });

  it('a read-only free-form progress note under the no-op appendix reaches the rewrite (fleet) and still briefs on project scope', async () => {
    const note = 'CanLaw eval landed at 0.81 on the det-v2 suite; the lane queued the next run.';
    const { text } = persistedNote(note, []);
    mockUtilityChat.mockResolvedValueOnce('CanLaw: eval landed at 0.81 → next run queued');
    expect(await generateOwnerBriefing({ chatId: 'sup-h3', userId: 'u1', noteContent: text })).toBe(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(mockUtilityChat.mock.calls[0][0][1].content).not.toContain('(harness');
    expect(posted()).toBe('CanLaw: eval landed at 0.81 → next run queued');
    jest.clearAllMocks();
    redisStore.clear();
    mockPrisma.crossModelChat = { findUnique: jest.fn(async () => ({ isProjectSupervisor: true })) };
    mockUtilityChat.mockResolvedValueOnce('CanLaw: eval landed at 0.81 → next run queued');
    expect(await generateOwnerBriefing({ chatId: 'sup-h4', userId: 'u1', noteContent: text })).toBe(true);
    expect(posted()).toBe('CanLaw: eval landed at 0.81 → next run queued');
  });

  it('a note that is ONLY the harness record stays the record; SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1 keeps the appendix in the briefing\'s view', () => {
    expect(prepareBriefingNote(NOOP).note).toBe(NOOP);
    const { text } = persistedNote('CanLaw eval landed at 0.81.', []);
    expect(prepareBriefingNote(text).note).toBe('CanLaw eval landed at 0.81.');
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    expect(prepareBriefingNote(text).note).toBe(text);
  });
  it('a stored row whose carried-forward section follows the appendix: the appendix still goes, the section stays (the bootstrap caller never briefs a read-only note as "Nothing new")', async () => {
    const note = 'CanLaw eval landed at 0.81 on the det-v2 suite; the lane queued the next run.';
    const carried = `---\n${CARRIED_FORWARD_LABEL}\n\n[DISPATCH-NEEDED] lane: bench\nRe-run the nightly bench.`;
    const stored = `${persistedNote(note, []).text}\n\n${carried}`;
    expect(stored.indexOf(NOOP)).toBeLessThan(stored.indexOf(CARRIED_FORWARD_LABEL));
    expect(prepareBriefingNote(stored).note).toBe(`${note}\n\n${carried}`);
    mockUtilityChat.mockResolvedValueOnce('CanLaw: eval landed at 0.81 → next run queued');
    expect(await generateOwnerBriefing({ chatId: 'sup-h5', userId: 'u1', noteContent: stored })).toBe(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(mockUtilityChat.mock.calls[0][0][1].content).not.toContain('(harness');
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    expect(prepareBriefingNote(stored).note).toBe(stored);
  });
});

describe('kill switch BRIEFING_UNVERIFIED_FILTER_DISABLED=1', () => {
  it('the previous input byte-for-byte: no marker, the claim (and any annotation) reaches the rewrite, no row', async () => {
    process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED = '1';
    await generateOwnerBriefing({ chatId: 'sup-7', userId: 'u1', noteContent: DET_NOTE, unverifiedClaims: [CLAIM] });
    expect(posted()).toBe(renderBriefingFromNote(DET_NOTE));
    const footnote = renderUnverifiedClaimsFootnote([FREE_CLAIM], { zeroTool: true });
    const withFootnote = `${FREE_NOTE}\n\n${footnote}`;
    expect(prepareBriefingNote(withFootnote, [FREE_CLAIM])).toEqual({ note: withFootnote, markedNote: withFootnote, droppedNote: withFootnote, supplied: 0, embedded: 0, located: 0 });
    redisStore.clear();
    await generateOwnerBriefing({ chatId: 'sup-8', userId: 'u1', noteContent: FREE_NOTE, unverifiedClaims: [FREE_CLAIM] });
    expect(mockUtilityChat.mock.calls[0][0][1].content).toContain('I dispatched the summary draft');
    await settle();
    expect(filterRows()).toHaveLength(0);
  });
});
