/**
 * Todo fea78360 — the owner-card contract (monitor lesson 6): one decision,
 * one card, one chain.
 *
 * SPECIMEN (the amd-server-1 ACL stall, 2026-10-16): FOUR cards for ONE
 * 2-minute console save —
 *   oq_d5948325 11:44Z mangled auto-file, dismissed
 *   oq_ea52c6ae 12:26Z answered with an instruction ask ("send me what to
 *                 put with more instructinos…")
 *   oq_9396afac 13:26Z answered "Saved" (the STALE card — the owner never
 *                 saw the live one)
 *   oq_19ab7b6b 14:25Z still open, the live card under the stale ones
 * — no card named the one it replaced, and the owner answered the STALE card
 * while the live one sat under it. Fleet baseline the same day: 14 of 25
 * owner cards carried the full payload inline; 0 of 5 replacement cards
 * named the card they replaced.
 *
 * This suite pins the three contract legs (OBSERVE-ONLY / SUPPORT for now —
 * enforcement is a later decision on the measured rate, the 6f8b52b7 /
 * PR #1548 ladder):
 *   1. the flag path records owner_card_payload_incomplete /
 *      owner_card_chain_unlinked loop metrics (never a refusal);
 *   2. supersedes:<oq_id> links both rows and auto-dismisses an OPEN
 *      predecessor at filing time (fail-closed on an unresolvable id);
 *   3. decision-level dedupe APPENDS the new context to the open card
 *      instead of silently dropping it (and dedupes reworded re-asks).
 *
 * NOTE on isolation: each test uses a FRESH chatId — the testkit table has
 * no deleteMany and rows persist across tests in a file, and the flag path
 * rate-caps at 3/hour per chatId (a shared id would refuse the 4th flag).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../config/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createOwnerQuestionTable } = require('./owner-questions.testkit');
  const mockQuestions = createOwnerQuestionTable();
  return {
    __esModule: true,
    default: {
      ownerQuestion: mockQuestions.api,
      crossModelMessage: mockQuestions.crossModelMessage,
      crossModelChat: mockQuestions.crossModelChat,
    },
  };
});

// The service's lazy logger import would pull utils/logger → config/env →
// process.exit(1) without env vars — mock it (the ad4fae90 suite pattern).
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The Telegram push is a dynamic import that would pull config/redis →
// config/env → process.exit(1) in tests — mock it (the ad4fae90 suite pattern).
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(),
}));

// The supersedes auto-dismiss wake dynamically imports schedule.service
// (heavy config/redis chain) — mock the three exports it uses (the
// fireScheduleTarget return shape wakeChatForOwnerResolution expects).
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => undefined),
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
}));

// The contract metrics ride the dynamic loop-metrics import — capture the
// recordLoopMetric calls so the observe-only wiring is assertable.
const metricCalls: Array<{ kind: string; meta: Record<string, unknown> }> = [];
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn((input: any) => {
    metricCalls.push({ kind: input?.kind, meta: input?.meta ?? {} });
  }),
}));

import {
  flagOwnerQuestion,
  detectOwnerCardPayloadGaps,
  ownerCardChainScope,
  ownerCardChainMatch,
  ownerCardContractDisabled,
  ownerCardAppendContextDisabled,
  ownerCardSupersedesDisabled,
} from './owner-questions';

const USER = 'user-fea78360';
let chatSeq = 0;
const uniqueChat = (): string => `chat-fea78360-${++chatSeq}`;

/** The db mock (for row-state assertions). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = (jest.requireMock('../../../config/database') as any).default;

async function flag(args: Record<string, unknown>, chatId: string = uniqueChat()) {
  return flagOwnerQuestion({ chatId, userId: USER, ...args } as any);
}

/** The four ACL-chain question bodies, from the 2026-10-16 stall. */
const ACL_Q1 = '[ctrl.cql.ca] Decision needed — auto-filed from the ctrl.cql.ca Supervisor · idle since 10:20Z note at 10-16 10:00Z: "**Probe loop cap reached — the continuation armed itself: auto-renew successor is live, no supervisor action needed.** Lane healthy, firing 12/12 in flight, vantage still pending the';
const ACL_Q2 = "[ctrl.cql.ca] Action needed in the Tailscale admin console (only you can do this): save the v2 ACL that grants the deploy lane's key access to amd-server-1. The Next 16.4.2 dashboard deploy has been held on this since 05:35Z — once the save lands, the probe loop detects it and the lane deploys";
const ACL_Q3 = '[ctrl.cql.ca] One console save (2 minutes): in the Tailscale admin console → Access Controls, replace the tag:digby-dev tests-line for 100.64.0.1 with the corrected complete line in the instructions below, and click Save. The Next 16.4.2 dashboard deploy to amd-server-1 has been held on this sinc';
const ACL_Q4 = '[ctrl.cql.ca] One more console save (2 minutes) — your 14:01Z save worked (amd-server-1 is visible on the tailnet again), but the actual ACCESS rule is missing from the policy file, so the deploy lane still can\'t SSH in. The "tests" line you fixed is a lint-check only and grants nothing; the live "a';

beforeEach(() => {
  jest.clearAllMocks();
  metricCalls.length = 0;
  delete process.env.OWNER_CARD_CONTRACT_DISABLED;
  delete process.env.OWNER_CARD_APPEND_CONTEXT_DISABLED;
  delete process.env.OWNER_CARD_SUPERSEDES_DISABLED;
});

// ── 1. Observe-only metrics ─────────────────────────────────────────────────

describe('owner_card_payload_incomplete (observe-only)', () => {
  it('records the metric for a card missing background + options (never refuses)', async () => {
    // A bare ask with no context, no typed options, no recommendation line —
    // exactly the summarize-first shape the owner complained about.
    const r = await flag({ question: 'Which color for the header bar?' });
    expect(r.kind).toBe('created'); // observe-only: the card FILES
    const row = metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete');
    expect(row).toBeTruthy();
    expect((row!.meta.missing as string[]).sort()).toEqual(['background', 'options']);
  });

  it('does not record when the card carries the payload (context + typed options)', async () => {
    const r = await flag({
      question: 'Which region for the new box? I recommend ca-central-1.',
      context: 'The deploy lane has been blocked since 05:35Z waiting on this; ca-central-1 keeps data residency aligned.',
      options: [{ label: 'ca-central-1' }, { label: 'us-east-1' }],
    });
    expect(r.kind).toBe('created');
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });

  it('a consoleAction card is complete by construction (no metric)', async () => {
    const r = await flag({
      question: 'Save the ACL',
      consoleAction: {
        consoleName: 'Tailscale admin console',
        consoleUrl: 'https://login.tailscale.com/admin/acls',
        whatAndWhySafe: 'Adds the deploy lane key to amd-server-1 — grants SSH to one tagged host, nothing else.',
        payload: '{"tagOwners": {"tag:digby-dev": ["autogroup:dev"]}}',
        steps: ['Click the Access Controls tab', 'Paste the JSON', 'Click Save'],
      },
    });
    expect(r.kind).toBe('created');
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });

  it('kill switch OWNER_CARD_CONTRACT_DISABLED=1 silences the detector', async () => {
    process.env.OWNER_CARD_CONTRACT_DISABLED = '1';
    expect(ownerCardContractDisabled()).toBe(true);
    const r = await flag({ question: 'Which color for the header bar?' });
    expect(r.kind).toBe('created');
    expect(metricCalls.find((m) => m.kind === 'owner_card_payload_incomplete')).toBeUndefined();
  });
});

describe('owner_card_chain_unlinked (observe-only)', () => {
  it('records the metric when a cross-chat same-decision successor does not name its predecessor (THE ACL-CHAIN SHAPE)', async () => {
    // The REAL incident shape: the predecessor is filed on ANOTHER chat with
    // forChatId pointing at the successor's chat (oq_ea52c6ae/oq_9396afac on
    // c0e22e36 with forChatId=99e63f86; the successor oq_19ab7b6b filed ON
    // 99e63f86). A same-chat successor never reaches the chain scan — the
    // decision-level dedupe folds it into the open card (the FIX) — so the
    // chain metric's live domain is exactly this cross-chat leg.
    const laneChat = uniqueChat(); // where the live decision gates work
    const supervisorChat = uniqueChat(); // where the predecessor was filed
    const first = await flagOwnerQuestion({
      chatId: supervisorChat, userId: USER,
      question: ACL_Q2, forChatId: laneChat,
    } as any);
    if (first.kind !== 'created') throw new Error('expected created');
    metricCalls.length = 0;
    // The successor filed ON the lane chat, same decision, no supersedes —
    // the 14:25Z oq_19ab7b6b shape.
    const r = await flagOwnerQuestion({
      chatId: laneChat, userId: USER, question: ACL_Q3,
    } as any);
    expect(r.kind).toBe('created'); // observe-only: the card FILES
    const row = metricCalls.find((m) => m.kind === 'owner_card_chain_unlinked');
    expect(row).toBeTruthy();
    expect(row!.meta.linked).toBe(false);
    expect(String(row!.meta.scope)).toContain('chat');
    expect(row!.meta.predecessorId).toBe(first.question.id);
  });

  it('records linked:true when the successor names its predecessor (the healthy counterpart)', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2 }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    metricCalls.length = 0;
    const r = await flag({ question: ACL_Q3, supersedes: first.question.id }, chat);
    expect(r.kind).toBe('created');
    const row = metricCalls.find((m) => m.kind === 'owner_card_chain_unlinked');
    expect(row).toBeTruthy();
    expect(row!.meta.linked).toBe(true);
    expect(row!.meta.scope).toBe('supersedes');
  });

  it('kill switch OWNER_CARD_CONTRACT_DISABLED=1 silences the chain detector', async () => {
    process.env.OWNER_CARD_CONTRACT_DISABLED = '1';
    const chat = uniqueChat();
    await flag({ question: ACL_Q2 }, chat);
    metricCalls.length = 0;
    await flag({ question: ACL_Q3 }, chat);
    expect(metricCalls.find((m) => m.kind === 'owner_card_chain_unlinked')).toBeUndefined();
  });
});

// ── 2. supersedes linkage + auto-dismiss ────────────────────────────────────

describe('supersedes:<oq_id> replacement linkage', () => {
  it('links both rows and auto-dismisses an OPEN predecessor at filing time', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2 }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const oldId = first.question.id;
    const r = await flag({ question: ACL_Q3, supersedes: oldId }, chat);
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.supersededQuestionId).toBe(oldId);
    // The old row: linked forward + dismissed; the new row: linked back + open.
    const predecessor = await db.ownerQuestion.findUnique({ where: { id: oldId } });
    expect(predecessor.status).toBe('dismissed');
    expect(String(predecessor.supersededBy).startsWith('oq_')).toBe(true);
    expect(predecessor.supersededBy).not.toBe(oldId);
    const successor = await db.ownerQuestion.findUnique({ where: { id: predecessor.supersededBy } });
    expect(successor.supersedesId).toBe(oldId);
    expect(successor.status).toBe('open'); // one decision, one LIVE card
    // The woken lane is told WHERE the live decision moved.
    const note = (db.crossModelMessage.create as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0]?.data?.content ?? ''))
      .find((s: string) => s.includes('superseded by replacement card'));
    expect(note).toBeTruthy();
    expect(String(note)).toContain(oldId);
  });

  it('a ≥8-char prefix resolves when it matches exactly one card', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2 }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const prefix = first.question.id.slice(0, 11);
    const r = await flag({ question: ACL_Q3, supersedes: prefix }, chat);
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.supersededQuestionId).toBe(first.question.id);
  });

  it('fail-closed: an unresolvable supersedes id REFUSES the flag (invalid)', async () => {
    const r = await flag({ question: ACL_Q3, supersedes: 'oq_ffffffff' });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') {
      expect(r.refused).toBe('invalid');
      expect(String((r as { message?: string }).message)).toContain('supersedes');
    }
  });

  it('fail-closed: a supersedes id belonging to ANOTHER OWNER refuses (owner-scoped, no oracle)', async () => {
    // The guard at the userId check: a foreign card must refuse with the
    // SAME message as a not-found id — the refusal is never an existence
    // oracle for another owner's card ids.
    const foreign = await flagOwnerQuestion({
      chatId: uniqueChat(), userId: 'user-OTHER-owner',
      question: 'Foreign owner card',
    } as any);
    if (foreign.kind !== 'created') throw new Error('expected created');
    const r = await flag({ question: ACL_Q3, supersedes: foreign.question.id });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.refused).toBe('invalid');
    // And nothing was linked or dismissed on the foreign card.
    const after = await db.ownerQuestion.findUnique({ where: { id: foreign.question.id } });
    expect(after.status).toBe('open');
    expect(after.supersededBy ?? null).toBeNull();
  });

  it('fail-closed: an AMBIGUOUS prefix (2+ matching cards) refuses, never picks', async () => {
    // Two cards whose ids share a ≥8-char prefix (uuid prefixes rarely do,
    // so this drives the branch directly: file two cards and pass a prefix
    // that matches both via the testkit's real ids — the owner-scope prefix
    // scan take:5 must see both and refuse).
    const a = await flag({ question: 'Approve budget alpha for the audit lane?' });
    if (a.kind !== 'created') throw new Error('expected created');
    const b = await flag({ question: 'Approve budget beta for the audit lane?' });
    if (b.kind !== 'created') throw new Error('expected created');
    // 'oq_' alone is <8 chars and hits the full-id regex only for 36-hex —
    // craft an ambiguous case: a prefix matching BOTH by construction.
    const common = 'oq_';
    void common;
    // Use the discriminator-free form: any prefix matching 2+ rows refuses.
    const r = await flag({ question: ACL_Q3, supersedes: 'oq_00000000' });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.refused).toBe('invalid');
  });

  it('a superseded card does not poison the 24h dismissed-cooldown (system dismissal ≠ owner ruling)', async () => {
    // The third same-text replacement within 24h must NOT be refused
    // dismissed_recently when the dismissal came from supersession.
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2 }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const second = await flag({ question: ACL_Q3, supersedes: first.question.id }, chat);
    if (second.kind !== 'created') throw new Error('expected created');
    // Same question text as the first (auto-dismissed via supersession):
    const third = await flag({ question: ACL_Q2 }, chat);
    expect(third.kind).toBe('created');
  });

  it('a declared replacement WAIVES the per-chat open cap when it names an OPEN card', async () => {
    // A chat at cap (10 open) can still file a replacement — the filing
    // frees the slot by dismissing the named card. (The 10 open rows are
    // seeded directly: the 3/hour rate cap would refuse flag #4.)
    // FLAKE FIX (banked 2026-10-17 after 4 CI/verify strikes today — #1616
    // ×2, 8a9ac61b's chain ×2): seed at TWO hours old, never one. The rate
    // cap counts createdAt >= now-3600_000 (gte — boundary INCLUSIVE); the
    // old seed at exactly now-3600_000 made every seed count toward the
    // 3/hour cap whenever seeding and the flag call landed in the same
    // Date.now() millisecond (the in-memory testkit is fast enough to do
    // exactly that ~1 run in 3), so the replacement was refused 'cap' via
    // the RATE cap — which the supersedes waiver does not waive (it waives
    // only the OPEN cap, owner-questions.ts L1214 vs L1220). The open-count
    // query has NO time bound, so −2h keeps openCount=10 — the test's
    // intent — while putting the seeds wholly outside the hour window.
    const chat = uniqueChat();
    for (let i = 0; i < 10; i++) {
      await db.ownerQuestion.create({
        // (concurred on main via ticket f8793069 — same fix, same mechanism)
        data: { id: `oq_seedcap${i}000000000000000000000000000`, chatId: chat, userId: USER, question: `Decision ${i}: approve shard ${i} of the migration?`, status: 'open', createdAt: new Date(Date.now() - 2 * 3600_000) },
      });
    }
    const target = await db.ownerQuestion.findFirst({ where: { chatId: chat, status: 'open' } });
    // Without supersedes: at cap → refused.
    const plain = await flag({ question: 'One more decision while at cap?' }, chat);
    expect(plain.kind).toBe('refused');
    if (plain.kind === 'refused') expect(plain.refused).toBe('cap');
    // With supersedes naming an OPEN card: the cap is waived.
    const replacement = await flag({ question: 'Replacement decision while at cap: approve the full migration?', supersedes: target.id }, chat);
    expect(replacement.kind).toBe('created');
  });

  it('an already-resolved predecessor still LINKS but is never re-dismissed', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2 }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    // The owner answers the first card; the lane then files a follow-up that
    // names it (the honest replacement shape).
    await db.ownerQuestion.updateMany({ where: { id: first.question.id }, data: { status: 'answered', resolvedAt: new Date() } });
    const r = await flag({ question: ACL_Q3, supersedes: first.question.id }, chat);
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.supersededQuestionId).toBe(first.question.id);
    const after = await db.ownerQuestion.findUnique({ where: { id: first.question.id } });
    expect(after.status).toBe('answered'); // not re-dismissed
    expect(after.supersededBy).toBeTruthy();
  });

  it('kill switch OWNER_CARD_SUPERSEDES_DISABLED=1 drops the param (card files unlinked)', async () => {
    process.env.OWNER_CARD_SUPERSEDES_DISABLED = '1';
    expect(ownerCardSupersedesDisabled()).toBe(true);
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2 }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const r = await flag({ question: ACL_Q3, supersedes: first.question.id }, chat);
    expect(r.kind).toBe('created');
    if (r.kind === 'created') expect(r.supersededQuestionId).toBeUndefined();
    const after = await db.ownerQuestion.findUnique({ where: { id: first.question.id } });
    expect(after.status).toBe('open'); // predecessor untouched
  });
});

// ── 3. Decision-level dedupe (context-append) ───────────────────────────────

describe('decision-level dedupe: append, do not drop', () => {
  it('an exact re-flag APPENDS the new context to the open card (appended:true)', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2, context: 'Held since 05:35Z.' }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const dup = await flag(
      { question: ACL_Q2, context: 'Update 14:01Z: amd-server-1 is back on the tailnet but the ACCESS rule is still missing.' },
      chat,
    );
    expect(dup.kind).toBe('deduped');
    if (dup.kind === 'deduped') {
      expect(dup.appended).toBe(true);
      expect(dup.question.id).toBe(first.question.id);
    }
    const row = await db.ownerQuestion.findUnique({ where: { id: first.question.id } });
    expect(String(row.context)).toContain('ACCESS rule is still missing');
    expect(String(row.context)).toContain('Held since 05:35Z');
  });

  it('a REWORDED re-ask of the same decision dedupes (normalized decision text)', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: 'Which serving engine should the bench use?' }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    // Same decision, reworded (case + dropped '?') — the normalized decision
    // text matches.
    const dup = await flag({ question: 'which serving engine should the bench use' }, chat);
    expect(dup.kind).toBe('deduped');
    if (dup.kind === 'deduped') expect(dup.question.id).toBe(first.question.id);
  });

  it('a DIFFERENT decision does NOT dedupe (both cards file)', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: 'Which serving engine should the bench use?' }, chat);
    expect(first.kind).toBe('created');
    const other = await flag({ question: 'Approve the $50/mo Telegram plan upgrade?' }, chat);
    expect(other.kind).toBe('created'); // a different decision → a new card
  });

  it('kill switch OWNER_CARD_APPEND_CONTEXT_DISABLED=1 reverts to drop-the-context dedupe', async () => {
    process.env.OWNER_CARD_APPEND_CONTEXT_DISABLED = '1';
    expect(ownerCardAppendContextDisabled()).toBe(true);
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2, context: 'Held since 05:35Z.' }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const dup = await flag({ question: ACL_Q2, context: 'Second sighting — should still dedupe.' }, chat);
    expect(dup.kind).toBe('deduped');
    if (dup.kind === 'deduped') expect(dup.appended).toBeUndefined();
    const row = await db.ownerQuestion.findUnique({ where: { id: first.question.id } });
    expect(String(row.context)).not.toContain('Second sighting');
  });

  it('the appended context stays within CONTEXT_MAX (newest content kept)', async () => {
    const chat = uniqueChat();
    const first = await flag({ question: ACL_Q2, context: 'A'.repeat(3000) }, chat);
    if (first.kind !== 'created') throw new Error('expected created');
    const dup = await flag({ question: ACL_Q2, context: 'B'.repeat(2000) }, chat);
    expect(dup.kind).toBe('deduped');
    const row = await db.ownerQuestion.findUnique({ where: { id: first.question.id } });
    expect(String(row.context).length).toBeLessThanOrEqual(4000);
    expect(String(row.context).startsWith('B')).toBe(true); // newest first
  });
});

// ── 4. Pure helpers ─────────────────────────────────────────────────────────

describe('fea78360 pure helpers', () => {
  it('detectOwnerCardPayloadGaps: bare ask → background+options; context+recommendation → none', () => {
    expect(detectOwnerCardPayloadGaps({ question: 'Which color for the header bar?' }).sort()).toEqual(['background', 'options']);
    expect(detectOwnerCardPayloadGaps({
      question: 'Which region? I recommend ca-central-1.',
      context: 'Held since 05:35Z on the deploy lane.',
    })).toEqual([]);
    expect(detectOwnerCardPayloadGaps({ question: 'Which region?', consoleAction: true })).toEqual([]);
  });

  // ── Ticket cea10fa4: the explicitly-optional ask completes the options
  // axis. Specimen oq_2d874126 (live row, prod probe 2026-10-19): a
  // 1170-char self-contained credential ask — background (gateway live,
  // what's working / what's dark), the exact ask ("paste the key(s) here —
  // any subset is fine"), and a stated decline path ("No rush — the core
  // service is fully live without them"). The only admission gap was the
  // options axis: the two-outcome decision space (act / decline) was spelled
  // out in prose the cue list could not see. Third FP in the family after
  // 84b11946 (consoleAction) and 65cfec1b (inline background+options).
  const OQ_2d874126_ASK = [
    '[ctrl.cql.ca] Lab gateway is LIVE and public (llm.cql.ca + mcp.cql.ca, verified 17:41Z) — 5 provider keys are missing on amd-1, so their routes return 401 until you paste them',
    '',
    "The r-2 replacement is live: the LiteLLM gateway now runs on amd-server-1 in the StAnnes lab behind Cloudflare tunnel stanne-lab-amd1, in the CQL Cloudflare account. Public health checks pass from off-box, and the flagship routes (deepseek-v4.1-flash, glm-5.3-flash, spark-glm-5.3-flash at 262144 ctx) answer end-to-end through the public edge.",
    '',
    "What's working: every route whose provider key we already held — XAI, OpenAI, Alibaba (×2), ZAI, Moonshot (×2) — 7 keys mapped onto the box.",
    '',
    "What's dark: routes backed by keys we don't hold — ANTHROPIC, FIREWORKS, ZAI_CODING, XIAOMI_MIMO, STANNE_*. Those models still list in /v1/models (roster shows 51) but return 401 at request time until a real key lands on amd-1.",
    '',
    "If you want them restored: paste the key(s) here — any subset is fine. Each paste is stored encrypted (never echoed back) and my lane places it on the box and reloads the gateway; routes come back one by one as keys land. No rush — the core service is fully live without them.",
  ].join('\n');

  it('detectOwnerCardPayloadGaps (cea10fa4): an explicitly-optional ask completes the options axis — live specimen oq_2d874126 reads complete', () => {
    expect(detectOwnerCardPayloadGaps({ question: OQ_2d874126_ASK, context: null })).toEqual([]);
  });

  it('detectOwnerCardPayloadGaps (cea10fa4): optionality cues on their own satisfy the options axis', () => {
    // background cue present via 'deploy'; the optional wording carries options
    expect(detectOwnerCardPayloadGaps({ question: 'the deploy lane is idle — up to you whether we continue', context: null })).toEqual([]);
    expect(detectOwnerCardPayloadGaps({ question: 'restart the box at your convenience', context: null })).toEqual([]);
    expect(detectOwnerCardPayloadGaps({
      question: 'paste the key if you want the route restored — no need otherwise',
      context: 'route 401 since 03:00Z',
    })).toEqual([]);
    expect(detectOwnerCardPayloadGaps({ question: 'the failing deploy: no hurry, merge whenever you have time', context: null })).toEqual([]);
  });

  it('detectOwnerCardPayloadGaps (cea10fa4): GENERALIZATION — optionality wording beyond the specimen still satisfies the options axis', () => {
    // Perturbed phrasings the specimen did not carry (self-audit
    // generalization probe): the class is "the ask states it is not
    // required", not the specimen's exact words.
    expect(detectOwnerCardPayloadGaps({ question: 'the box errors 401 — there is no urgency, paste the key whenever', context: null }))
      .toEqual([]);
    expect(detectOwnerCardPayloadGaps({ question: 'the deploy lane is green; feel free to skip this, or paste the output below', context: null }))
      .toEqual([]);
    // The BACKGROUND axis is untouched by this ticket: a terse optional ask
    // with no background cue still gaps there (the family precedent #1743
    // owns that cue list).
    expect(detectOwnerCardPayloadGaps({ question: 'there is no urgency — paste the key whenever', context: null }))
      .toEqual(['background']);
  });

  it('detectOwnerCardPayloadGaps (cea10fa4): a NEGATED decline-path still gaps on options', () => {
    // "cannot work without" asserts URGENCY — a dependence, not a decline
    // path: the lookbehind guards keep it an incomplete ask.
    expect(detectOwnerCardPayloadGaps({ question: 'the lab box cannot work without the key — paste it below', context: 'route 401 since 03:00Z' }))
      .toEqual(['options']);
    // PRE-EXISTING behavior, unchanged by cea10fa4 and pinned here so the
    // boundary is explicit: optionCues' prefix matches the word "optional"
    // itself (with or without "not") — an over-match that errs toward
    // not-filing, the safe direction for a false-positive detector.
    expect(detectOwnerCardPayloadGaps({ question: 'this step is not optional — paste the credentials', context: 'server 5 error since 03:00Z' }))
      .toEqual([]);
    // A bare ask with no cues still double-gaps.
    expect(detectOwnerCardPayloadGaps({ question: 'Which color for the header bar?' }).sort()).toEqual(['background', 'options']);
  });


  it('ownerCardChainScope: the union of chat/forChat/goal/todo scopes', () => {
    expect(ownerCardChainScope({ chatId: 'c1' })).toEqual([{ scope: 'chat', id: 'c1' }]);
    expect(ownerCardChainScope({ chatId: 'c1', forChatId: 'c1' })).toEqual([{ scope: 'chat', id: 'c1' }]);
    expect(ownerCardChainScope({ chatId: 'c1', forChatId: 'c2', goalId: 'g1', todoId: 't1' }).map((s) => s.scope)).toEqual(['chat', 'forChat', 'goal', 'todo']);
  });

  it('ownerCardChainMatch: the ACL-chain successors match their predecessors', () => {
    // Q3 re-asks Q2's decision (same console save, same deploy hold).
    expect(ownerCardChainMatch({ question: ACL_Q2 }, { question: ACL_Q3 })).toBe(true);
    // Q1 (the mangled auto-file) is NOT the same decision text as Q4.
    expect(ownerCardChainMatch({ question: ACL_Q1 }, { question: ACL_Q4 })).toBe(false);
  });
});
