/**
 * REPLAY PIN — mishap ticket 71a270d2 (2026-09-24T15:21:04.320Z, verifier:
 * action-verifier): "Phantom observation clock: machine note cites future
 * timestamp(s) (chat 1ea4621f)".
 *
 * THE INCIDENT BEING REPLAYED: the Sunday Market daily Slack-digest machine
 * wake (chat 1ea4621f-502e-4b83-a269-c85a733d0212, schedule firing, run
 * clock 2026-09-24T15:21:04.320Z) summarized YESTERDAY'S (Sep 23) Slack
 * activity and cited the Paul↔Matt DM's Recovery Unplugged message
 * datelessly: "- **Recovery Unplugged meeting was positive** (1:40 PM PDT /
 * 20:40Z): …". That message is REAL — slack_search returned permalink
 * https://sundaymarket.slack.com/archives/D06DYPSE3LJ/p1790195999249539,
 * whose µs epoch decodes to 2026-09-23T20:39:59.249Z (yesterday 1:40 PM
 * PDT), re-verified live 2026-09-24 (17:0xZ, this fix's lane). The
 * deterministic future-observation-clock lane (ticket 375c8618 class)
 * resolved the DATELESS token to TODAY 20:40Z — +319 min ahead of the run
 * clock, an "impossible observation" — and REPLACED the whole owner-
 * requested digest pre-delivery (ticket cdd3fbfe full-replacement class),
 * auto-filing this mishap ticket.
 *
 * ADJUDICATION (2026-09-24 engineering lane be2abe9e): FALSE-POSITIVE class
 * — the inverse of the 1c2eb455 contained-signal pin. The lane did NOT
 * fabricate: every struck stamp was a real, tool-observed PAST event. The
 * gap was PROVENANCE READABILITY: slack_search — the only surface that
 * reaches DM/MPIM content (channel history cannot list DMs) — renders NO
 * clock text; each hit carries its instant ONLY as the permalink's /p<16-
 * digit µs epoch>, a form stampHasToolProvenance could not read. Channel-
 * sourced digest lines ("1:09 PM PDT (20:09Z)") survived via the verbatim
 * clock-context leg (history output prints "20:09:00 UTC") — only the
 * search-surfaced DM line was blind, which is why exactly ONE digest line
 * struck while its siblings did not.
 *
 * THE FIX (this ticket): a Slack permalink-epoch leg in haystackHasInstant —
 * HAYSTACK_PERMALINK_EPOCH_RE decodes /p<16 digits> and compares UTC
 * time-of-day within EPOCH_TIME_OF_DAY_TOLERANCE_MS (120s — the incident's
 * own citations minute-round: 20:39:59.249Z cited as "20:40Z", 1s;
 * 21:15:29.075Z as "21:15Z", 29s), date-INDEPENDENTLY (the clock-only stamp
 * asserts no day — the same P4 semantics as the existing clock leg). Shipped
 * verbatim in BOTH lanes (action-verifier.ts + run-evidence-guard.ts — the
 * standing keep-in-sync discipline). The /p prefix keeps it unambiguous: a
 * Slack permalink IS a timestamp by construction; a bare 16-digit run could
 * be an id and never vouches (pinned below).
 *
 * What makes THIS pin load-bearing (the shapes sibling pins do not cover):
 *  1. The DATELESS-PAST-EVENT citation: a clock-of-day later than now whose
 *     true day is YESTERDAY — the nearest-candidate rule's core false-
 *     positive surface (chat-lane rule "Residual ambiguity": the accepted
 *     miss this fix closes for tool-backed events).
 *  2. EPOCH-ENCODED provenance: the haystack carries NO clock text at all —
 *     the verbatim clock-context leg AND the ISO/Z instant legs are all
 *     blind; only the new permalink leg can vouch.
 *  3. MINUTE-ROUNDING: the cited 20:40 is 0.751s off the decoded 20:39:59.249
 *     — an exact-match design would still strike the incident.
 *  4. The strike path still works WITHOUT the haystack (the phantom corpus
 *     keeps convicting — over-exemption is the fail-safe direction, and the
 *     a8976e11/#307 pins' no-haystack classes are untouched).
 *
 * Boundary-mocked like the sibling pins (action-verifier.1c2eb455.test.ts):
 * prisma, logger, the utility LLM, the feedback service, supervisor-state and
 * the receipts service are stubs; the REAL guard executes.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import {
  guardMachineWakeFinalAnswer,
  findFutureObservedTimestamps,
  ACTION_GUARD_BANNER,
} from './action-verifier';

/** The incident seat + owner (ticket context sessionId / userId). */
const CHAT = '1ea4621f-502e-4b83-a269-c85a733d0212';
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
/** The run's real clock (ticket context filedAt) — the comparison point. */
const INCIDENT_NOW = new Date('2026-09-24T15:21:04.320Z');

/**
 * The CONVICTED line — verbatim from the ticket's struck-timestamp listing
 * (the digest's Paul↔Matt DM section). The stamps are DATELESS citations of
 * a REAL yesterday Slack message.
 */
const DM_LINE = '- **Recovery Unplugged meeting was positive** (1:40 PM PDT / 20:40Z): they run Google PPC largely in-house, **94% beds filled**, and are **looking to buy more centers soon** — follow-up call in ~2 weeks';
/**
 * The SIBLING line that never struck (pre- or post-fix): "next week" is
 * future-intent wording, so its clocks are exempt by line — pinning that
 * the fix does not disturb the FUTURE_INTENT_RE vocabulary.
 */
const REHAB_BD_LINE = '- **Rehab BD pipeline** (2:15 PM PDT / 21:15Z): Matt has LinkedIn traction with **Discovery Behavioral Health, Las Cruces rehab center, Caron Treatment Centers, and Gateway Rehabs**; Las Cruces meeting booked for next week; proposes focusing on more LinkedIn outreach next week';
/** The note's warning lead — "Tomorrow's" is future-intent; its clocks exempt. */
const WARNING_LINE = "⚠️ **Schedule re-arm NOT executed this run** — I exhausted my tool rounds pulling channel data and could not call `schedule_message` before this final turn closed. **Tomorrow's 8 AM digest will not fire unless re-armed** — say \"re-arm the daily digest\" in this chat and I'll set it for 15:00Z. (Today's digest is also ~19 min late, landing 8:19 AM PDT / 15:18Z vs the 8:00 target.)";

/** The incident note — reconstructed from the ticket's excerpt, convicted line verbatim. */
const INCIDENT_NOTE = [
  WARNING_LINE,
  '',
  '# 📋 Sunday Market Slack Digest — Wednesday, Sep 23, 2026',
  '',
  '## 💬 Paul ↔ Matt DM — the day\'s main thread',
  DM_LINE,
  REHAB_BD_LINE,
  '',
  '## #sm-drp-rehab',
  '- 1:09 PM PDT (20:09Z): **VOB tracking tab** added to the sheet',
].join('\n');

/**
 * The run's slack_search tool_result — VERBATIM as the Slack MCP renders it
 * (re-pulled live 2026-09-24 while fixing): NO clock text, the message
 * instant carried ONLY as the permalink's /p<µs epoch> — 1790195999249539
 * = 2026-09-23T20:39:59.249Z = the DM_LINE's real event.
 */
const SLACK_SEARCH_RESULT = [
  '[Slack Search Results]',
  '# Search Results for "Recovery Unplugged"',
  '',
  'Total matches: 13',
  '',
  '## #U06DVRVRS5B — @matt',
  '  Meeting with recovery unplugged was positive. They do their own Google PPC largely in house with 94% beds filled rate but are looking to buy more centers soon. They want to have a follow up call in a couple of weeks',
  '  https://sundaymarket.slack.com/archives/D06DYPSE3LJ/p1790195999249539',
  '',
  '## #U06DVRVRS5B — @matt',
  '  I also have some traction with Discovery Behavioral Health, Las Cruces rehab center, Caron Treatment Centers and Gateway Rehabs through LinkedIn. Meeting with las Cruces next week but the rest haven\'t got that far.',
  '  https://sundaymarket.slack.com/archives/D06DYPSE3LJ/p1790198129075049',
].join('\n');

/**
 * The run's slack_get_channel_history tool_result shape — renders zoned
 * clock text ("20:09:00 UTC"), which the EXISTING verbatim clock-context leg
 * already vouches (why the #sm-drp-rehab line never struck, pre-fix).
 */
const CHANNEL_HISTORY_RESULT = [
  '[Slack Channel History: #sm-drp-rehab]',
  '# History: #sm-drp-rehab (C0763E3A54P)',
  '',
  '## <@U062WA9SA9K> — 2026-09-23 20:09:00 UTC',
  '  VOB tracking tab added to the sheet',
].join('\n');

/** The incident run's parts: the tool_results the provenance haystacks read. */
const INCIDENT_PARTS = [
  { type: 'tool_result', name: 'slack_search', result: SLACK_SEARCH_RESULT },
  { type: 'tool_result', name: 'slack_get_channel_history', result: CHANNEL_HISTORY_RESULT },
];

const guard = (extra: Record<string, unknown>) =>
  guardMachineWakeFinalAnswer({
    chatId: CHAT,
    userId: OWNER,
    finalText: INCIDENT_NOTE,
    parts: INCIDENT_PARTS as any,
    receipts: [],
    runStartedAt: new Date('2026-09-24T15:01:07.000Z'),
    machineTriggered: true,
    now: INCIDENT_NOW,
    ...extra,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket 71a270d2 — REPLAY: the false-phantom Slack-digest clocks', () => {
  // build 2026-10-08 Q-3: pins the LEGACY replace lane (FUTURE_CLOCK_REPLACE_ENABLED=1 restore path);
  // the default clock policy is pinned in action-verifier.future-clock-policy.q3.test.ts.
  beforeAll(() => { process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1'; });
  afterAll(() => { delete process.env.FUTURE_CLOCK_REPLACE_ENABLED; });
  it('PRE-FIX SHAPE STILL CONVICTS with no haystack: the incident note strikes +319min and files the mishap ticket (the 375c8618 corpus is untouched)', async () => {
    const res = await guard({ parts: [] as any });
    expect(res.struck).toBe(true);
    expect(res.audited).toBe(true);
    expect(res.finalText).toContain(ACTION_GUARD_BANNER);
    expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
    expect(res.finalText).toContain('"1:40 PM PDT"');
    expect(res.finalText).toContain('"20:40Z"');
    expect(res.finalText).toContain(INCIDENT_NOW.toISOString());
    // Deterministic: the clock lane runs before the keyword gate and never
    // spends an LLM call on the strike path.
    expect(mockUtilityChat).not.toHaveBeenCalled();
    // The auto-filed mishap ticket — the incident's own filing shape
    // (title matches this replay's ticket verbatim).
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe(`Phantom observation clock: machine note cites future timestamp(s) (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.description).toContain('"20:40Z"');
  });

  it('POST-FIX: the SAME note with the run\'s slack tool_results is CLEAN — the permalink epoch vouches the real yesterday event, the digest delivers', async () => {
    const res = await guard({});
    expect(res.struck ?? false).toBe(false);
    expect(res.finalText).toBe(INCIDENT_NOTE);
    expect(res.finalText).not.toContain('--- BEGIN STRUCK NOTE');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the fix is stamp-specific, not haystack-presence: a fabricated clock with NO matching permalink still convicts WITH the same haystacks present', async () => {
    // A phantom "verified through 23:05Z" — no tool output, permalink or
    // otherwise, carries that time-of-day (both permalinks decode 20:39/21:15).
    const phantomNote = `Probed all five channels — verified through 23:05Z, all quiet.\n${DM_LINE}`;
    const res = await guard({ finalText: phantomNote });
    expect(res.struck).toBe(true);
    expect(res.finalText).toContain('"23:05Z"');
  });
});

describe('ticket 71a270d2 — deterministic unit pins on the incident shapes', () => {
  it('the convicted line yields EXACTLY the two incident stamps (+319 min each — the ticket\'s arithmetic) with NO haystack', () => {
    const hits = findFutureObservedTimestamps(DM_LINE, INCIDENT_NOW);
    expect(hits.map((h) => h.token).sort()).toEqual(['1:40 PM PDT', '20:40Z']);
    expect(hits.every((h) => h.minutesAhead === 319)).toBe(true);
  });

  it('the permalink haystack exonerates BOTH forms of the same instant ("1:40 PM PDT" PDT-offset and "20:40Z" UTC)', () => {
    expect(findFutureObservedTimestamps(DM_LINE, INCIDENT_NOW, { evidenceHaystacks: [SLACK_SEARCH_RESULT] })).toEqual([]);
  });

  it('the rounding case: the µs epoch 20:39:59.249Z vouches the minute-rounded "20:41Z" (60.751s) but NOT "20:42Z" (120.751s — the ±120s boundary)', () => {
    const line = (s: string) => `- **Meeting was positive** (${s}): they run Google PPC largely in-house`;
    // 20:41:00 - 20:39:59.249 = 60.751s ≤ 120s → vouches (clean).
    expect(findFutureObservedTimestamps(line('20:41Z'), INCIDENT_NOW, { evidenceHaystacks: [SLACK_SEARCH_RESULT] })).toEqual([]);
    // 20:42:00 - 20:39:59.249 = 120.751s > 120s → no vouch (convicts).
    expect(findFutureObservedTimestamps(line('20:42Z'), INCIDENT_NOW, { evidenceHaystacks: [SLACK_SEARCH_RESULT] }).map((h) => h.token)).toEqual(['20:42Z']);
  });

  it('the /p prefix is load-bearing: a BARE 16-digit id with no permalink context never vouches (a run id is not a timestamp)', () => {
    const bareIdHaystack = 'row id 1790195999249539 status active';
    expect(findFutureObservedTimestamps(DM_LINE, INCIDENT_NOW, { evidenceHaystacks: [bareIdHaystack] }).map((h) => h.token).sort()).toEqual(['1:40 PM PDT', '20:40Z']);
  });

  it('a thread_ts query param (dotted seconds form) does not vouch — only the /p<16-digit> permalink shape does', () => {
    const threadTsHaystack = 'thread permalink query: ?thread_ts=1784141363.905799 (dotted seconds, not a /p epoch)';
    expect(findFutureObservedTimestamps(DM_LINE, INCIDENT_NOW, { evidenceHaystacks: [threadTsHaystack] }).map((h) => h.token).sort()).toEqual(['1:40 PM PDT', '20:40Z']);
  });

  it("CONTROL: the sibling lines were already clean pre-fix — future-intent wording ('next week', \"Tomorrow's\") and channel-history clock text still exempt", () => {
    // Rehab BD line: "next week" future-intent — clean with NO haystack at all.
    expect(findFutureObservedTimestamps(REHAB_BD_LINE, INCIDENT_NOW)).toEqual([]);
    // Warning line: "Tomorrow's" future-intent — clean with NO haystack.
    expect(findFutureObservedTimestamps(WARNING_LINE, INCIDENT_NOW)).toEqual([]);
    // Channel-history line: the EXISTING verbatim clock-context leg vouches
    // "20:09" against the history result's "20:09:00 UTC" — pre-fix behavior
    // preserved (why only the search-surfaced DM line was ever exposed).
    expect(findFutureObservedTimestamps('- 1:09 PM PDT (20:09Z): **VOB tracking tab** added', INCIDENT_NOW, { evidenceHaystacks: [CHANNEL_HISTORY_RESULT] })).toEqual([]);
  });

  it('cross-day date-independence is the incident itself: the epoch (Sep 23) vouches a stamp the nearest-candidate rule dated Sep 24', () => {
    // The decoded epoch instant is 2026-09-23T20:39:59.249Z — a FULL DAY
    // before the run clock — yet it vouches, because the clock-only stamp
    // asserts no day (P4 semantics). The main replay pin covers this at the
    // guard level; this pins it at the parser level for the boundary.
    const hits = findFutureObservedTimestamps(DM_LINE, INCIDENT_NOW, { evidenceHaystacks: [SLACK_SEARCH_RESULT] });
    expect(hits).toEqual([]);
  });
});
