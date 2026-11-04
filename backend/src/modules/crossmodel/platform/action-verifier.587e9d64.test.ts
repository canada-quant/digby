/**
 * REPLAY PIN — mishap ticket 587e9d64 (2026-09-14, chat 378224d5): an HONEST
 * user-facing final note (msg 510479e4) was convicted of a phantom DISPATCH
 * claim the note never made. The note said "The deliverable (created this
 * run) … also saved to your Files page … built from the session's parse of
 * the ALL IN attendee directory"; the utility-LLM claim extractor — instructed
 * to return "short verbatim quote" details but never CHECKED for verbatim
 * support — paraphrase-hallucinated a first-person dispatch claim:
 *   [dispatch] "created a coding session to generate the deliverable
 *   [allin-2026-priority-targets.md] and save it to Files page
 *   (id 9ed656af-230a-452d-86f7-a1aa738f350e)"
 * ("coding session" appears NOWHERE in the note; the cited id is the generated
 * FILE's id.) The tier chain convicted it (no own-run receipts; the dispatch
 * artifact check reads crossmodel_chats only), verifyRunActionClaimsAsync
 * appended a correction that was itself FALSE (msg 7d6446c8 — it contradicted
 * a true note in the user's thread), and filePhantomTicket auto-filed the
 * mishap.
 *
 * This file pins the fix: groundExtractedClaims — deterministic verbatim-
 * grounding of LLM-extracted claims against the SAME window the extractor
 * saw, wired at both computePhantomClaims extraction call sites (note +
 * args), failing toward MISS (a false strike replaces an honest note —
 * strictly worse than a miss, which the deterministic miner + post-delivery
 * lane backstop). The replay asserts the incident note now produces ZERO
 * phantoms; companion tests pin that a verbatim TRUE claim still convicts,
 * and that an emptied LLM lane still triggers the e413c084 miner fallback.
 *
 * Mock discipline mirrors action-verifier.test.ts: config/database and every
 * transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  // The replay note cites the chat's REAL todo (`Todo 0a7f2a5e`) — existence
  // exonerates it exactly as in production (the goal/todo citation lane,
  // ticket 3ed139cd).
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => ({ id: '0a7f2a5e-real-todo-row' })), findMany: jest.fn(async () => []) },
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

const CHAT = '378224d5-4271-4efa-bdfc-628dc5e1eecd';

/**
 * The incident note VERBATIM (chat 378224d5, msg 510479e4, 2026-09-14
 * 05:05:28.911Z — pulled from the live transcript during the ticket-587e9d64
 * investigation). It claims exactly ONE artifact (a generated file, created
 * via create_document — not a tracked consequential tool) and NO dispatch.
 */
const INCIDENT_NOTE = `# Todo 0a7f2a5e — status report

**Target list: DONE — delivered as a file. 66 confirmed-name priority targets. Meetings booked: 0 — booking did not start this run.** Honest partial status below; nothing claimed that didn't happen.

## 1. The deliverable (created this run)

**[allin-2026-priority-targets.md — download](/api/crossmodel/generated-files/9ed656af-230a-452d-86f7-a1aa738f350e/download)** — also saved to your Files page (9.4 KB, id \`9ed656af-230a-452d-86f7-a1aa738f350e\`). Contents, built from the session's parse of the ALL IN attendee directory:

- **Tier 1 — Government/defence: 27 targets (owner's first priority, listed first).** Leads: Yvan Fournier (SMA cybersécurité, Ministère de la Cybersécurité et du Numérique QC), Victor Khoo (Director, Canadian C5ISRT, General Dynamics Mission Systems–Canada), Shawn McCorkell (Public Safety Canada), three Rheinmetall Canada directors, ISED/FedDev/IRAP rows, plus public-sector channel rows (Microsoft, SAP, AWS, Levio).
- **Tier 2 — Quant finance: 17 targets** — National Bank (Marechaux, Caron, Lapointe), TD (Sabrina Ng), RBC Borealis (Anya McGee), CI Financial, Intact, Desjardins, TMX, Scale AI/Cycle Momentum investors.
- **Tier 3 — AI infrastructure: 22 targets** — NVIDIA ×6 (John Josephakis Global VP HPC/AI, John DuPont AI Factories, Calista Redmond, Will Koffel/Inception, Dat Le, Marcus Pratt), Lenovo sovereign HPC (Christine Reeves), AWS sovereign cloud, BUZZ HPC, HIVE, Denvr, Cologix, Databricks, Dell (Rejean Carrier).
- **Meeting-request template** (~60 words, Swapcard-ready) with per-tier angle fill-ins, a booking tracker table, and secondary rows (Cohere, Bell AI Fabric, TELUS, Fasken) after the 66.

**Constraints honored:** gov/defence leads the list; every draft uses **IDEaS CH-13 bid-submitted/awaiting-results framing only** — no results, JV, or funding claims anywhere in the document.

## 2. Meetings booked: 0 — plainly

No Swapcard meeting request was sent this run. I searched session memory for the app's booking session/URL; the only Swapcard material retrieved was **unrelated 2023 Affiliate Summit West emails to a different mailbox** — no usable ALL IN 2026 login or booking session in hand. This is the gap that matters most with the event 2–3 days out.

## 3. Cross-check reconciliation

- The cross-checker reported it **could not read the directory** and held only 3 contact rows (Mae Ceralvo/NVIDIA, Chris Penrose/NVIDIA, Hilary Gu/Dell). I could **not confirm those three in the directory text**, so the document lists them under **"Unverified — DO NOT USE without confirmation"**, and points to the verified NVIDIA/Dell rows instead. They were flagged, not used.
- Its one useful find — the **IBM Canada "Not-for-profit AI initiative"** door on the app's book-a-meeting rail — is in the document as a **lead attributed to the cross-check run, marked verify-in-app**, since I didn't observe it myself.

## 4. What remains (next session, in order)

1. Open the ALL IN Swapcard app and confirm the IBM program door + the three unverified rows.
2. Send meeting requests **Tier 1 first** (Fournier, Khoo, McCorkell, Rheinmetall trio), using the template verbatim.
3. Log each send in the doc's booking tracker.`;

/** The extractor's hallucinated output, verbatim from the ticket's phantom-claim line. */
const HALLUCINATED_CLAIMS_JSON = JSON.stringify({
  claims: [
    {
      kind: 'dispatch',
      detail: 'created a coding session to generate the deliverable [allin-2026-priority-targets.md] and save it to Files page (id 9ed656af-230a-452d-86f7-a1aa738f350e)',
      id: '9ed656af-230a-452d-86f7-a1aa738f350e',
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.projectTodo.findFirst.mockResolvedValue({ id: '0a7f2a5e-real-todo-row' });
});

describe('ticket 587e9d64 REPLAY — the chat-378224d5 false-conviction incident', () => {
  it('the incident note produces ZERO phantoms: the hallucinated dispatch claim is dropped at grounding', async () => {
    mockUtilityChat.mockResolvedValueOnce(HALLUCINATED_CLAIMS_JSON as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      runStartedAt: new Date(), machineTriggered: true,
    });
    // The LLM lane's one claim is dropped (no verbatim support); the
    // deterministic miner fallback finds no first-person receipt idiom in
    // this honest note; the `Todo 0a7f2a5e` citation is exonerated by the
    // existing todo row — exactly the production shape.
    expect(comp.claims).toEqual([]);
    expect(comp.phantoms).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('587e9d64 grounding lane'), expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('created a coding session'), expect.anything());
  });

  it('a VERBATIM true dispatch claim in the note still grounds — and still convicts when unexecuted', async () => {
    const note = 'Run closed. I dispatched the nightly audit worker (session deadbeef-1234-5678-9abc-def012345678) — it is running now.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the nightly audit worker', id: 'deadbeef-1234-5678-9abc-def012345678' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.claims).toEqual([{ kind: 'dispatch', detail: 'dispatched the nightly audit worker', id: 'deadbeef-1234-5678-9abc-def012345678' }]);
    expect(comp.phantoms).toEqual(comp.claims); // grounding passed it; the tier chain convicted it (no receipts, no DB row)
  });

  it('an emptied LLM lane still triggers the deterministic miner fallback (ticket e413c084 chain intact)', async () => {
    const note = '**Supervisor wake:** spot-check complete, 4 confirmed 1 FALSE.\n**Action:** I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing it to close `4550ee11` with the actual PR/commit evidence.';
    // LLM returns ONE ungrounded claim — grounding drops it — then the miner
    // must still catch the real first-person receipt idiom in the note.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'created a coding session for the spot-check' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(comp.claims).toEqual([{ kind: 'message', detail: expect.stringContaining('I sent a steer'), id: '6fbb2f9d' }]);
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'message', id: '6fbb2f9d' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('587e9d64 grounding lane'), expect.anything());
  });
});

describe('groundExtractedClaims — the deterministic verbatim-grounding unit surface (ticket 587e9d64)', () => {
  const claim = (detail: string, id?: string): ExtractedClaim => ({ kind: 'dispatch', detail, ...(id ? { id } : {}) });

  it('keeps a claim whose detail is a verbatim substring of the source', () => {
    const src = 'Status: I dispatched the cleanup worker (session cafebabe-1234) and it is working now.';
    const { grounded, dropped } = groundExtractedClaims([claim('dispatched the cleanup worker')], src);
    expect(grounded).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it('DROPS the incident paraphrase-hallucination shape (kind/verb invented from honest prose)', () => {
    const { grounded, dropped } = groundExtractedClaims(
      [claim('created a coding session to generate the deliverable [allin-2026-priority-targets.md] and save it to Files page (id 9ed656af-230a-452d-86f7-a1aa738f350e)', '9ed656af-230a-452d-86f7-a1aa738f350e')],
      INCIDENT_NOTE,
    );
    expect(grounded).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('fails toward MISS on a cross-sentence true claim (≤4 tokens require ALL in one window)', () => {
    const src = 'I dispatched the cleanup worker. Its session id is 3bd727f6.';
    const { grounded, dropped } = groundExtractedClaims([claim('dispatched the cleanup worker session')], src);
    // "session" sits in the OTHER sentence — dropped. Documented doctrine: a
    // false strike is strictly worse than a miss; the miner + post-delivery
    // lane backstop, and a dropped TRUE claim is harmless when executed.
    expect(grounded).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('keeps claims with no checkable content (empty / id-only detail) — grounding never invents a drop reason', () => {
    const { grounded } = groundExtractedClaims([claim(''), claim('9ed656af-230a-452d')], 'unrelated source text');
    expect(grounded).toHaveLength(2);
  });

  it('the 80% threshold: 5-of-6 tokens in one window grounds, 4-of-6 does not', () => {
    const src = 'I dispatched the nightly audit worker before closing the run.';
    // 6 content tokens, 5 present (dispatched/nightly/audit/worker/run) → ≥80% → grounded.
    expect(groundExtractedClaims([claim('dispatched the nightly audit worker cleanup run')], src).grounded).toHaveLength(1);
    // 6 content tokens, only 4 present → below the bar → dropped.
    expect(groundExtractedClaims([claim('dispatched the nightly audit worker cleanup telegram')], src).dropped).toHaveLength(1);
  });

  it('is case/markdown-insensitive (normalized comparison)', () => {
    const src = '**Action:** I FILED ticket `abc12345` with the full replay.';
    expect(groundExtractedClaims([{ kind: 'ticket', detail: 'filed ticket abc12345 with the full replay' }], src).grounded).toHaveLength(1);
  });
});
