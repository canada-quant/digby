/**
 * REPLAY PIN — ticket 363f5793-442c-454a-88f3-3a08d5353d24 (mishap,
 * 2026-09-22T20:13:00Z): "Phantom action claim: chat asserted action(s) never
 * executed (chat dddbf9ba)".
 *
 * The mishap was a FALSE POSITIVE — the second user-visible corrosive kind:
 * the platform told the user a REAL, receipted action had never happened.
 * Chat dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38's user asked "did you properly
 * file that ticket with the framework"; the run DID file it (file_feedback →
 * ticket 23c68866-3997-40d9-8c22-b93b3bc01fe1, receipt
 * 1b731bd2-cd7c-4a58-a028-726ab7f03850 — both printed verbatim in the mishap
 * ticket's own "Executed consequential actions" list). The answer
 * (msg 43b2d0d7, 2026-09-22T20:12:59Z) narrated that ONE filing twice:
 *   1. "Ticket's in now: **`23c68866`** — bug report, priority 1."
 *      — id-bearing [ticket] claim;
 *   2. "- **The ticket:** filed against Digby's platform (`bug_report`,
 *      area: integrations) with the failure signature…"
 *      — id-less [ticket] claim about the SAME filing.
 * The verifier then posted the correction (msg d9d7f773, 20:13:00Z):
 *   "[ticket] \"filed against Digby's platform (`bug_report`,
 *   area: integrations)\" — no matching successful tool call exists in that
 *   turn's log" — a FALSE statement; the receipt named the ticket.
 *
 * Root cause (deterministic): findPhantomClaims' kind-SPECIFIC own-run id
 * match CONSUMED the matched execution (`specific.consumed = true`). The
 * id-bearing claim (1) matched the single file_feedback execution's envelope
 * and burned its slot; the id-less twin (2) then found no unconsumed
 * ticket-kind slot and convicted on count. One truthful action, two truthful
 * narrations, double-counted. The file's own doctrine already forbids this:
 * the miner block warns against "false-convict[ing] the id-less twin on the
 * consumed slot", and the kind-AGNOSTIC tier directly below the buggy line
 * exonerates WITHOUT consuming with the comment "the id match is
 * claim-specific … the same-kind id-less slot accounting (step 4) stays
 * available for the action's own-kind narration" — implemented for the rare
 * mis-typed claim, violated for the common correctly-typed one. The
 * per-surface pool split (review B1, ticket e65061e1) covered note↔args
 * twins; same-surface twins had no protection.
 *
 * The fix: the kind-specific id match is NON-CONSUMING (one-line behavior
 * change), aligning it with the kind-agnostic tier's stated doctrine.
 * Accepted residual (fail toward MISS, the 587e9d64 doctrine — a false
 * strike replaces an HONEST note, strictly worse): an id-less claim
 * narrating a SECOND, unexecuted action of the same kind now exonerates on
 * the freed slot. Pure id-less over-claims still convict on slot count
 * (pinned below), and a fabricated id still convicts through the tier chain
 * (pinned below).
 *
 * Mock discipline mirrors action-verifier.d25172ca.test.ts: config/database
 * and every transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));

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

import { computePhantomClaims } from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

// The mishap's real chat id — the filed ticket title reads true against it.
const CHAT = 'dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38';

// The run's REAL executed receipts, verbatim from the mishap ticket's own
// "Executed consequential actions this run" list (ticket 363f5793 body).
const FF_RECEIPT: ToolReceipt = {
  id: '1b731bd2-cd7c-4a58-a028-726ab7f03850', chatId: CHAT, runId: null,
  tool: 'file_feedback', ok: true,
  ids: { receiptId: '1b731bd2-cd7c-4a58-a028-726ab7f03850', ticketId: '23c68866-3997-40d9-8c22-b93b3bc01fe1' },
  inputHash: null, outputHash: null, createdAt: new Date(),
};
const LIST_RECEIPT: ToolReceipt = {
  id: '75c3d3a8-3891-4366-a7a2-e57e597ec3c6', chatId: CHAT, runId: null,
  tool: 'list_feedback', ok: true,
  ids: { receiptId: '75c3d3a8-3891-4366-a7a2-e57e597ec3c6' },
  inputHash: null, outputHash: null, createdAt: new Date(),
};

// The struck note, verbatim from msg 43b2d0d7 (2026-09-22T20:12:59Z).
const MISHAP_NOTE = `Ticket's in now: **\`23c68866\`** — bug report, priority 1.

What happened and what I did:

- **The issue:** both X tool calls (\`x_search\` for AI queries and \`x_get_trends\`) came back empty this morning even though your integrations panel shows X as connected (@codoublez). That's why the digest was built from trend mirrors (trends24, getdaytrends), web search, Hugging Face, and scraped X feeds instead of direct pulls.
- **The ticket:** filed against Digby's platform (\`bug_report\`, area: integrations) with the failure signature — empty results contradicting the connected status — plus a note that your daily digest now depends on this working every morning. The triage queue picks it up from there.
- **Your digest is unaffected either way:** the morning schedule (still pending your confirmation if you haven't tapped it) uses the layered fallback, so you'll get trends regardless.

For what it's worth, this looked like an auth/token issue on Digby's side of the integration rather than anything about your account — if the ticket confirms that, a reconnect in Account → Integrations might also be worth a try.`;

// The TWO claims the LLM extractor emitted for the note — proven by the
// incident record: the correction (msg d9d7f773) prints the id-less claim
// verbatim, and ONLY an id-bearing claim consuming the single file_feedback
// slot first explains that conviction at all.
const CLAIM_ID_BEARING = { kind: 'ticket', detail: "Ticket's in now: **`23c68866`** — bug report, priority 1.", id: '23c68866' };
const CLAIM_ID_LESS = { kind: 'ticket', detail: "filed against Digby's platform (`bug_report`, area: integrations)" };

const BASE_INPUT = () => ({
  chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [] as any[],
  receipts: [FF_RECEIPT, LIST_RECEIPT], runStartedAt: new Date(), machineTriggered: false,
});

describe('ticket 363f5793 replay — same-surface id-bearing + id-less twin narrations of ONE proven action', () => {
  beforeEach(() => {
    mockUtilityChat.mockReset();
    mockGetRecentChatReceipts.mockClear();
  });

  it('THE MISHAP REPLAY: the id-less twin of a receipt-matched filing convicts NOTHING (was: 1 phantom, the false correction d9d7f773)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [CLAIM_ID_BEARING, CLAIM_ID_LESS] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT());
    expect(comp.claims).toHaveLength(2); // raw audit trail — both narrations kept
    expect(comp.phantoms).toEqual([]);   // ONE real filing exonerates BOTH narrations
  });

  it('GUARD (slot accounting preserved): a THIRD, unexecuted id-less filing claim still convicts on count', async () => {
    const CLAIM_SECOND_ID_LESS = { kind: 'ticket', detail: 'filed a second ticket about the digest schedule depending on the X read path' };
    const note = `${MISHAP_NOTE}\n- **Follow-up:** filed a second ticket about the digest schedule depending on the X read path.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [CLAIM_ID_BEARING, CLAIM_ID_LESS, CLAIM_SECOND_ID_LESS] }) as never);
    const comp = await computePhantomClaims({ ...BASE_INPUT(), finalText: note });
    expect(comp.phantoms).toHaveLength(1); // one execution vouches the twin; the over-claim convicts
    expect(comp.phantoms[0].detail).toBe(CLAIM_SECOND_ID_LESS.detail);
  });

  it('GUARD (no laundering): a FABRICATED ticket id still convicts through the tier chain — the fix only frees the slot, never the id check', async () => {
    const CLAIM_FAKE_ID = { kind: 'ticket', detail: "Ticket's in now: **`deadbeef`** — bug report, priority 1.", id: 'deadbeef' };
    const note = MISHAP_NOTE.replace('23c68866', 'deadbeef');
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [CLAIM_FAKE_ID, CLAIM_ID_LESS] }) as never);
    const comp = await computePhantomClaims({ ...BASE_INPUT(), finalText: note });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].id).toBe('deadbeef');
  });
});
