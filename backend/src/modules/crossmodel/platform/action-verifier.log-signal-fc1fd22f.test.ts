/**
 * Characterization pin — log-signal ticket fc1fd22f (2026-10-25, family lane
 * f02ac12e): the "action-verifier: dropped <n> LLM-extracted note claim(s)
 * with NO verbatim support in the audited note (ticket 587e9d64 grounding
 * lane — extraction paraphrase-hallucination): …" warn fingerprint the
 * hourly log-signal-sweep filed (19 rows across 12 distinct hours, Oct 24) is
 * the action-verifier's VERBATIM-GROUNDING gate doing its DESIGNED job on the
 * correct side of the precision/recall trade — NOT a defect.
 *
 * WHAT THE ROWS ARE: every warn row is ONE machine-triggered run whose
 * utility-LLM claim extractor paraphrase-hallucinated one or more
 * first-person artifact/dispatch claims the audited note never made
 * (ticket 587e9d64's incident class: the extractor is instructed to return
 * "short verbatim quote" details but, being an LLM, it invents phrasings).
 * groundExtractedClaims (the deterministic fix that landed for 587e9d64)
 * DROPS those ungrounded claims BEFORE they can reach the tier chain — the
 * drop is the anti-fabrication guard working, and the warn row is its
 * designed visibility (the sweep reads warn+error only). The recurrence is
 * owned LLM-behavior variance on the utility seat, not a suppression state
 * or a retry storm: the drop is computed per-run from the same window the
 * extractor saw, so a paraphrase-hallucinating extractor keeps being caught
 * while a truthful one passes silently.
 *
 * ADJUDICATION (family lane f02ac12e, 2026-10-26): not a framework defect —
 * guard correct. The probe (48h window): 23 rows total, 5 rows on Oct 25 vs
 * 19 on Oct 24 (decaying), no error-level rows anywhere in the window, and
 * every row's ticketed body cites a DIFFERENT underlying lane's note (587e9d64
 * grounding lane). The dispatch payload for the dropped claims is bounded
 * (each row lists the dropped [kind] detail, ≤120 chars each), so the class
 * cannot flood.
 *
 * THE PIN: this file replays the exact prod shape — an honest supervisor
 * note + a hallucinating extractor — and asserts (a) the ungrounded claims
 * are dropped (phantoms stay EMPTY — the guard prevents a false conviction,
 * the 587e9d64 incident), (b) the warn fires with the exact fingerprinted
 * prefix and source stamp, (c) a verbatim TRUE claim still passes grounding
 * and still convicts when unexecuted (the guard's precision must NOT be
 * relaxed by this pin), and (d) the warn is WARN level (the observability
 * contract: the sweep must keep seeing it). A future pass cannot "fix" the
 * warn into silence, or latch it off, without breaking this suite.
 *
 * Mock discipline mirrors action-verifier.587e9d64.test.ts (this file's
 * sibling): config/database and every transitively-heavy boundary is mocked
 * at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: async () => [] },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { computePhantomClaims, groundExtractedClaims, ExtractedClaim } from './action-verifier';
import logger from '../../../utils/logger';

const CHAT = 'chat-fc1fd22f-grounding-lane';

/** A supervisor note with NO artifact or dispatch claims — but honest prose that a paraphrase-hallucinating extractor might "improve" into them. No ticket ids (a cited id the DB rows don't back would itself convict — the miner's ticket-citation lane). */
const HONEST_NOTE = `# Adjudication note — lead ticket of the log-signal family

**Adjudicated:** designed observability, not a framework defect. The lead seat rejected the turn once; the built-in fallback answered. The run survived.

## Evidence

- The 24h window held 32 warn rows across 8 distinct hours and ZERO error-level rows.
- The earlier lane (1f46af47) filed a pull request characterizing this class; its merge (852913104) already holds the pin.
- The ticket context records a reopen because the prior close carried a commit sha where the metric bar needed the verbatim-support replay instead.

## What remains

Nothing further for this lane; the class is designed.`;

/**
 * The extractor's paraphrase-hallucinated output, in the prod shape of the
 * fc1fd22f rows: claims that "improve" the note's honest prose into
 * first-person dispatch/PR artifacts the note never made.
 */
const HALLUCINATED_CLAIMS_JSON = JSON.stringify({
  claims: [
    {
      kind: 'ticket',
      detail: 'filed ticket 09a03aef closed done',
    },
    {
      kind: 'dispatch',
      detail: 'staged a dispatch for lane 6ed158ca to ship the round-6 fix and spawn a fresh round-6 reviewer',
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
});

describe('log-signal fc1fd22f — action-verifier grounding-drop warn (designed anti-fabrication visibility)', () => {
  it('REPLAYS the prod row verbatim: the hallucinated claims are dropped at grounding, phantoms stay EMPTY, and the warn IS the fingerprint', async () => {
    mockUtilityChat.mockResolvedValueOnce(HALLUCINATED_CLAIMS_JSON as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: HONEST_NOTE, parts: [], receipts: [],
      runStartedAt: new Date(), machineTriggered: true,
    });

    // (a) The ungrounded claims never became claims — the guard prevented a
    // false conviction (the 587e9d64 incident class) before the tier chain.
    expect(comp.claims).toEqual([]);
    expect(comp.phantoms).toEqual([]);

    // (b) The warn fired with the exact fingerprinted prefix — verbatim, so
    // the sweep's normalized fingerprint stays stable — and the exact
    // payload shape the prod rows carry (the dropped [kind] detail).
    const warn = (logger.warn as unknown as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0] ?? ''))
      .find((m: string) => m.includes('NO verbatim support in the audited note'));
    expect(warn).toBeDefined();
    expect(warn).toContain('action-verifier: dropped 2 LLM-extracted note claim(s) with NO verbatim support in the audited note (ticket 587e9d64 grounding lane — extraction paraphrase-hallucination):');
    expect(warn).toContain('[ticket] filed ticket 09a03aef closed done');
    expect(warn).toContain('[dispatch] staged a dispatch for lane 6ed158ca');
  });

  it('the warn is WARN level (the observability contract: the sweep reads warn+error only — info lines are invisible)', () => {
    // Static shape pin, the e194233a precedent: the emitting call starts
    // with logger.warn, so the class stays sweep-visible by design. Anchor
    // on the NOTE-site literal (the args surface at action-verifier.ts's
    // other call shares the 'NO verbatim support' fragment — the note-only
    // suffix disambiguates).
    const fs = require('fs') as typeof import('fs');
    const src = fs.readFileSync(require('path').join(__dirname, 'action-verifier.ts'), 'utf8');
    const at = src.indexOf('NO verbatim support in the audited note');
    expect(at).toBeGreaterThan(-1);
    const callStart = src.lastIndexOf('logger.', at);
    expect(src.slice(callStart, callStart + 'logger.warn('.length)).toBe('logger.warn(');
  });

  it('precision is NOT relaxed by this pin: a verbatim TRUE claim still grounds — and still convicts when unexecuted', async () => {
    // The 587e9d64 contract's other half: grounding drops paraphrase, never
    // truth. A verbatim claim in the note passes grounding and reaches the
    // tier chain, which (with no receipts and no DB rows) convicts it.
    const note = 'Run closed. I dispatched the nightly audit worker (session deadbeef-1234-5678-9abc-def012345678) — it is running now.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the nightly audit worker', id: 'deadbeef-1234-5678-9abc-def012345678' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.claims).toHaveLength(1);
    expect(comp.phantoms).toHaveLength(1);
    // No drop warn fired for the grounded claim — the fingerprint class
    // covers only the DROPPED claims (uppercase 'NO', the emitted form).
    const dropWarns = (logger.warn as unknown as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0] ?? ''))
      .filter((m: string) => m.includes('NO verbatim support'));
    expect(dropWarns).toHaveLength(0);
  });
});

describe('groundExtractedClaims — the fc1fd22f contract unit (drop = designed miss, never a strike)', () => {
  const claim = (kind: string, detail: string, id?: string): ExtractedClaim =>
    ({ kind: kind as ExtractedClaim['kind'], detail, ...(id ? { id } : {}) });

  it('drops the prod row shapes verbatim (ticket-closure + dispatch detail forms)', () => {
    const src = HONEST_NOTE;
    const { grounded, dropped } = groundExtractedClaims([
      claim('ticket', 'filed ticket 09a03aef closed done'),
      claim('dispatch', 'staged a dispatch for lane 6ed158ca to ship the round-6 fix and spawn a fresh round-6 reviewer'),
    ], src);
    expect(grounded).toEqual([]);
    expect(dropped).toHaveLength(2);
    expect(dropped.map((d: any) => d.kind)).toEqual(['ticket', 'dispatch']);
  });

  it('a claim whose detail IS a verbatim substring of the note grounds — and never produces the warn', () => {
    const src = 'I dispatched the cleanup worker (session cafebabe-1234) and it is working now.';
    const { grounded, dropped } = groundExtractedClaims([claim('dispatch', 'dispatched the cleanup worker')], src);
    expect(grounded).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});
