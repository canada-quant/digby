const mockPrisma: any = {
  $queryRaw: jest.fn(),
  messageFeedback: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
  loopMetric: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
// The quality judge's Utility-seat call (defaultQualityJudge, exported 2026-10-04 for the model bench). Default ''
// = a failed judge call, which is what an un-keyed test process got from the real utilityChat before.
const mockUtilityChat = jest.fn(async (..._a: any[]) => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
// The spec-pinned comparative judge's call path (comparativeJudgeOnModel, P1.5): both dynamically imported —
// resolveProviderForRun (coding-model) resolves the spec, runHelperCompletion posts the non-streaming call.
const mockResolveProviderForRun = jest.fn(async (..._a: any[]) => null);
const mockRunHelperCompletion = jest.fn(async (..._a: any[]) => ({ text: '', hadReasoning: false, finishReason: 'stop' }));
jest.mock('../coding/coding-model', () => ({ __esModule: true, resolveProviderForRun: (...a: any[]) => mockResolveProviderForRun(...a) }));
jest.mock('../coding/helper-completion', () => ({ __esModule: true, runHelperCompletion: (...a: any[]) => mockRunHelperCompletion(...a) }));
const PROVIDER: any = { url: 'https://llm.example.com/chat/completions', apiKey: 'k', model: 'mimo-v26-flash-rl', label: 'cql-litellm (custom endpoint)', extra: {}, maxTools: 32 };
jest.mock('../chat-agent/handback-detector', () => ({ __esModule: true, findHandback: (i: any) => (/say the word/i.test(String(i?.finalText)) ? { phrase: 'say the word' } : null) }));

import {
  parseQuality, defaultQualityJudge, QUALITY_RUBRIC, ANSWER_LEAK_RE, ANSWER_REFUSAL_RE,
  COMPARATIVE_RUBRIC, defaultComparativeJudge, parseRanking, comparativeJudgeOnModel,
  COMPARATIVE_RUBRIC_V2, COMPARATIVE_CUT_MARKER, comparativeUserMessage, comparativeRubricText,
  AuditSummary, auditBriefingLine, detectRegressions, isAuditableAnswer, parseJudgeLane, runLiveChatAuditOnce,
  sampleFromEnv, summarizeAudit, turnSignals, replayLaneResult, ReplayResult, REPLAY_SEGMENT, LIVE_CHAT_AUDIT_KIND, SIDE_KINDS, CARD_NOTE_KINDS,
  collapseQuality, qualityRepeatsFromEnv, countWebGroundingCalls, WEB_GROUNDING_TOOL_NAMES,
  RouterHealth, RouterAskRow, routerHealthFromRows, ROUTER_GATE_BARS,
} from './live-chat-audit';
import { NON_HUMAN_SEGMENTS } from './decision-gate-fit';

const row = (over: any = {}) => ({
  id: over.id ?? 'a1', chatId: over.chatId ?? 'c1', createdAt: new Date('2026-10-04T00:00:00Z'), content: over.content ?? 'An answer.',
  parts: over.parts ?? [], metadata: over.metadata ?? {
    depth: { plan: { preset: 'single_thinking', lane: over.ranQuick ? 'quick' : undefined }, turnPlan: { lane: over.lane ?? 'quick', act: !!over.act, ...(over.decisionId ? { decisionId: over.decisionId } : {}), ...(over.backend ? { backend: over.backend } : {}), ...(over.ruleLane ? { ruleLane: over.ruleLane } : {}) }, ...(over.escalated ? { escalations: [{ rung: 'verify' }] } : {}) },
    ux: { ttftMs: over.ttft ?? 8000, completionMs: over.done ?? 9000 },
    ...(over.error ? { models: { digby: { error: 'returned no output' } } } : {}),
  },
  feedback: over.feedback ?? [],
});

const baseSummary = (over: Partial<AuditSummary> = {}): AuditSummary => ({
  windowHours: 24, turns: 40, laneMix: {}, acted: 0, ranQuick: 0, quickTapped: 0, ttft: {}, completionP50: null,
  errors: 0, empty: 0, handbacks: 0, leaks: 0, refusals: 0, escalations: 0, thumbsDown: 0, checks: {}, duplicateAnswers: 0, verifierCorrections: 0,
  effortArms: {}, replay: { n: 0, agree: 0, judged: 0, judgeAgree: 0, quickActedJudgedDeeper: 0, researchUnderRouted: 0 }, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LIVE_CHAT_AUDIT_DISABLED;
  delete process.env.LIVE_CHAT_AUDIT_TICKETS_DISABLED;
  delete process.env.LIVE_CHAT_AUDIT_REPLAY_SAMPLE;
  delete process.env.LIVE_CHAT_AUDIT_JUDGE_SAMPLE;
  delete process.env.LIVE_CHAT_AUDIT_QUALITY_REPEATS;
  mockPrisma.$queryRaw.mockResolvedValue([]); // unwired queries (e.g. the verifier-ticket read) answer empty
  process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE = '0'; // tests that want the judge inject it and opt in
});

describe('signals (pure)', () => {
  it('reads lane / act / ran-quick / latency / error / escalation / thumbs from one answer row', () => {
    const s = turnSignals(row({ lane: 'quick', act: true, ranQuick: true, ttft: 7800, escalated: true, error: true, feedback: ['thumbs_down'] }));
    expect(s).toMatchObject({ lane: 'quick', acted: true, ranQuick: true, ttftMs: 7800, error: true, escalated: true, thumbsDown: true, empty: false });
  });

  it('only HUMAN answers are audited — machine / verifier / side rows are not', () => {
    expect(isAuditableAnswer({ depth: {} })).toBe(true);
    expect(isAuditableAnswer({ origin: 'user' })).toBe(true);
    expect(isAuditableAnswer({ origin: 'machine', verifier: 'action-verifier' })).toBe(false);
    expect(isAuditableAnswer({ origin: 'schedule' })).toBe(false);
    expect(isAuditableAnswer({ kind: 'deeper_findings' })).toBe(false);
    expect(isAuditableAnswer({ kind: 'control_note', origin: 'agent' })).toBe(false);
  });

  // Ticket 0f208004 (2026-10-09): both "duplicate answer" chats sighted by the nightly
  // audit were a coding session's ONE real answer plus the hourly session_status card
  // (origin AND kind 'session_status', session-status.service.ts) landing inside the
  // turn's answer window. A card is machine-written status, never a turn's answer —
  // excluded here and in the duplicate-answer SQL.
  it('0f208004 — status cards (session_status / project_status / owner_briefing) are never auditable answers', () => {
    expect(isAuditableAnswer({ kind: 'session_status', origin: 'session_status' })).toBe(false);
    expect(isAuditableAnswer({ kind: 'session_status', origin: 'user' })).toBe(false); // dual-write / legacy origin
    expect(isAuditableAnswer({ kind: 'project_status', origin: 'user' })).toBe(false);
    expect(isAuditableAnswer({ kind: 'owner_briefing' })).toBe(false);
    expect(isAuditableAnswer({ origin: 'session_status' })).toBe(false); // origin alone is already ≠ 'user', pinned anyway
    expect(isAuditableAnswer({ kind: 'deeper_findings', origin: 'session_status' })).toBe(false);
    // a real answer keeps counting
    expect(isAuditableAnswer({ origin: 'user', kind: undefined, depth: {} })).toBe(true);
    expect(isAuditableAnswer({ depth: {} })).toBe(true);
  });

  it('summarizes lanes, quick taps, latency and replay agreement', () => {
    const sig = [
      turnSignals(row({ lane: 'quick', act: true, ranQuick: true, ttft: 8000, escalated: true })),
      turnSignals(row({ lane: 'quick', act: true, ranQuick: true, ttft: 20000 })),
      turnSignals(row({ lane: 'standard', ttft: 30000 })),
    ];
    const s = summarizeAudit(sig, { duplicateAnswers: 1, verifierCorrections: 0, replays: [
      { recorded: 'quick', replayed: 'quick', judge: 'research', acted: true, preset: 'single_thinking' },
      { recorded: 'standard', replayed: 'checked', judge: 'research', acted: false, preset: 'thinking' },
    ] });
    expect(s).toMatchObject({ turns: 3, acted: 2, ranQuick: 2, quickTapped: 1, duplicateAnswers: 1 });
    expect(s.ttft['quick-ran']).toMatchObject({ n: 2 });
    expect(s.replay).toEqual({ n: 2, agree: 1, nFallback: 0, backendDrift: 0, judged: 2, judgeAgree: 0, quickActedJudgedDeeper: 1, researchUnderRouted: 2, researchUnderRoutedWhy: { uncalibrated: 0, routerNotAsked: 2 } });
  });

  it('reads the lead-effort A/B arm and compares the arms (2026-10-04)', () => {
    const mk = (arm: string, ttft: number, escalated = false) => turnSignals({ ...row({ ttft, escalated }), metadata: { ...(row({ ttft, escalated }).metadata as any), ux: { ttftMs: ttft, completionMs: ttft + 1000, effortArm: arm } } });
    const s = summarizeAudit([mk('high', 40_000), mk('high', 60_000, true), mk('max', 150_000), mk('none', 9_000)], { duplicateAnswers: 0, verifierCorrections: 0, replays: [] });
    expect(s.effortArms.high).toMatchObject({ n: 2, escalated: 1 });
    expect(s.effortArms.max).toMatchObject({ n: 1, ttftP50: 150_000 });
    expect(auditBriefingLine(s)).toMatch(/effort A\/B first token high \d+ s \(n 2\) vs max 150 s \(n 1\)/);
  });

  it('scores the shadow lane rule against the judge (2026-10-04)', () => {
    const s = summarizeAudit([], { duplicateAnswers: 0, verifierCorrections: 0, replays: [
      { recorded: 'standard', replayed: 'standard', judge: 'research', acted: false, preset: 'thinking', ruleLane: 'research' },
      { recorded: 'quick', replayed: 'quick', judge: 'quick', acted: true, preset: 'single_thinking', ruleLane: 'quick' },
      { recorded: 'standard', replayed: 'standard', judge: 'standard', acted: false, preset: 'thinking', ruleLane: 'checked' },
    ] });
    expect(s.replay).toMatchObject({ ruleJudged: 3, ruleJudgeAgree: 2, argmaxJudgeAgreeOnRuled: 2, ruleChanged: 2 });
    expect(auditBriefingLine({ ...s, turns: 3 })).toMatch(/lane rule vs judge 2\/3 \(argmax 2\/3; rule moved 2\)/);
  });

  it('parses the judge lane from the LAST "LANE:" line', () => {
    expect(parseJudgeLane('thinking… LANE: quick\nactually LANE: checked')).toBe('checked');
    expect(parseJudgeLane('no verdict')).toBeNull();
  });

  it('sample envs: blank = default, garbage = default, clamped', () => {
    expect(sampleFromEnv(undefined, 30)).toBe(30);
    expect(sampleFromEnv('', 30)).toBe(30);
    expect(sampleFromEnv('abc', 30)).toBe(30);
    expect(sampleFromEnv('0', 30)).toBe(0);
    expect(sampleFromEnv('999', 30)).toBe(200);
  });

  it('replayed asks ride a NON-HUMAN segment the readiness ruler never pools', () => {
    expect(NON_HUMAN_SEGMENTS.has(REPLAY_SEGMENT)).toBe(true);
  });
});

describe('regressions (pure)', () => {
  it('any double answer is a bug ticket with a stable title', () => {
    const r = detectRegressions(baseSummary({ duplicateAnswers: 1 }), []);
    expect(r).toEqual([expect.objectContaining({ signal: 'duplicate_answers', type: 'bug_report', title: '[live-chat audit] a question was answered twice' })]);
  });

  it('a first-token regression needs ≥ 10 turns AND ≥ 3 baseline nights AND > 1.5× the baseline p50', () => {
    const base = [1, 2, 3].map(() => baseSummary({ ttft: { standard: { n: 20, p50: 20_000, p90: 60_000 } } }));
    expect(detectRegressions(baseSummary({ ttft: { standard: { n: 12, p50: 35_000, p90: 90_000 } } }), base).map((x) => x.signal)).toEqual(['ttft_standard']);
    expect(detectRegressions(baseSummary({ ttft: { standard: { n: 12, p50: 28_000, p90: 90_000 } } }), base)).toEqual([]); // 1.4×
    expect(detectRegressions(baseSummary({ ttft: { standard: { n: 8, p50: 60_000, p90: 90_000 } } }), base)).toEqual([]); // too few turns
    expect(detectRegressions(baseSummary({ ttft: { standard: { n: 12, p50: 60_000, p90: 90_000 } } }), base.slice(0, 2))).toEqual([]); // no baseline yet
  });

  it('lead errors need ≥ 3 AND a rate above max(5 %, 2× baseline)', () => {
    expect(detectRegressions(baseSummary({ errors: 3, turns: 40 }), []).map((x) => x.signal)).toEqual(['lead_errors']);
    expect(detectRegressions(baseSummary({ errors: 2, turns: 40 }), [])).toEqual([]);
    expect(detectRegressions(baseSummary({ errors: 3, turns: 100 }), [])).toEqual([]); // 3 % < 5 %
  });

  it('Quick-lane taps, replay drift, Quick judged deeper, research under-routed', () => {
    const s = baseSummary({ ranQuick: 10, quickTapped: 3, replay: { n: 20, agree: 15, judged: 20, judgeAgree: 14, quickActedJudgedDeeper: 2, researchUnderRouted: 3 } });
    expect(detectRegressions(s, []).map((x) => x.signal).sort()).toEqual(['quick_judged_deeper', 'quick_tapped', 'research_under_routed', 'turn_plan_drift']);
  });

  // ── Ticket f2e34408 (2026-11-02): the under-routed count must name its CAUSE, and the router's own
  // waste (asked, then unable to use its answer) needs a gate of its own ──
  it('f2e34408: the under-routed ticket names the calibration split, so an input defect is not read as a routing-rule defect', () => {
    const s = baseSummary({
      replay: { n: 20, agree: 19, judged: 20, judgeAgree: 9, quickActedJudgedDeeper: 0, researchUnderRouted: 3, researchUnderRoutedWhy: { uncalibrated: 3, routerNotAsked: 0 }, ruleJudged: 20, ruleJudgeAgree: 9, argmaxJudgeAgreeOnRuled: 9, ruleChanged: 0 },
    });
    const r = detectRegressions(s, []).find((x) => x.signal === 'research_under_routed')!;
    expect(r).toBeTruthy();
    expect(r.detail).toMatch(/3 ran on an UNCALIBRATED turn plan/);
    expect(r.detail).toMatch(/0 ran below Level 3 with a usable classification/);
    expect(r.detail).toMatch(/ruleAdjustedLane is shadow and routes nothing/);
  });

  it('f2e34408: the router-unusable gate fires on the measured state (24 of 31 eligible) and stays quiet on a healthy night', () => {
    const measured: RouterHealth = { n: 104, byRoute: { denied: 73, no_answer: 24, kept: 5, research: 2 }, eligible: 31, noAnswer: 24, noAnswerRate: 24 / 31, noAnswerWhy: { 'unusable turn plan': 24 }, routed: 2 };
    expect(detectRegressions(baseSummary({ router: measured }), []).map((x) => x.signal)).toContain('research_router_unusable');
    // A healthy night: a couple of timeouts only.
    const healthy: RouterHealth = { n: 60, byRoute: { denied: 40, no_answer: 2, kept: 18 }, eligible: 20, noAnswer: 2, noAnswerRate: 0.1, noAnswerWhy: { 'turn plan timed out': 2 }, routed: 18 };
    expect(detectRegressions(baseSummary({ router: healthy }), []).map((x) => x.signal)).not.toContain('research_router_unusable');
    // Below the eligible floor the ratio is not evidence.
    const thin: RouterHealth = { n: 8, byRoute: { no_answer: 3, kept: 5 }, eligible: 8, noAnswer: 3, noAnswerRate: 3 / 8, noAnswerWhy: { 'unusable turn plan': 3 }, routed: 5 };
    expect(detectRegressions(baseSummary({ router: thin }), []).map((x) => x.signal)).not.toContain('research_router_unusable');
  });

  it('f2e34408: routerHealthFromRows counts only the asks the router was OBLIGED to answer (allowance false is correct work, not waste)', () => {
    const rows: RouterAskRow[] = [
      { route: 'denied', allowance: false, why: 'deep research not allowed (guest_no_research) — not asked' },
      { route: 'denied', allowance: false, why: 'deep research not allowed (guest_no_research) — not asked' },
      { route: 'no_answer', allowance: true, why: 'unusable turn plan — the router\'s level stands' },
      { route: 'no_answer', allowance: true, why: 'turn plan timed out — the router\'s level stands' },
      { route: 'research', allowance: true, why: 'lane research (p 0.86 ≥ 0.5)' },
      { route: 'kept', allowance: true, why: 'lane standard (p(research) 0.12)' },
    ];
    const h = routerHealthFromRows(rows);
    expect(h.n).toBe(6);
    expect(h.eligible).toBe(4);           // the two guest denials are excluded
    expect(h.noAnswer).toBe(2);
    expect(h.noAnswerRate).toBe(0.5);
    expect(h.routed).toBe(1);
    expect(h.noAnswerWhy).toEqual({ 'unusable turn plan': 1, 'turn plan timed out': 1 });
  });

  it('f2e34408: an empty window yields a zero rate rather than a divide-by-zero', () => {
    expect(routerHealthFromRows([])).toEqual({ n: 0, byRoute: {}, eligible: 0, noAnswer: 0, noAnswerRate: 0, noAnswerWhy: {}, routed: 0 });
    expect(routerHealthFromRows([{ route: 'denied', allowance: false }])).toMatchObject({ eligible: 0, noAnswerRate: 0 });
  });

  // ── Ticket 4c3f2a5c (2026-10-24): the replay agreement must be a comparison of CLASSIFICATIONS ──
  it('4c3f2a5c: fallback-lane turns (no decisionId) are EXCLUDED from the ratio and counted as nFallback — a preset fallback is not a classification', () => {
    // 20 replayed turns, 2 with hadDecision:false (live ask failed ⇒ recorded lane = preset fallback).
    // The OLD code counted them in n (disagreeing, by construction) and dragged 15/20 = 75 % to a
    // false drift; the fixed ratio is over the 18 classified turns: 15/18 = 83 % — still drift here,
    // but honest. With 16 agreeing of 18: 89 % — ABOVE the bar, no ticket.
    const mk = (over: Partial<ReplayResult>): ReplayResult => ({ recorded: 'standard', replayed: 'standard', judge: null, acted: false, preset: 'thinking', ...over });
    const rows = Array.from({ length: 18 }, (_, i) => mk({ recorded: i < 15 ? 'standard' : 'quick', replayed: 'standard', hadDecision: true }))
      .concat([mk({ recorded: 'quick', replayed: 'research', hadDecision: false }), mk({ recorded: 'standard', replayed: 'research', hadDecision: false })]);
    const s = summarizeAudit([], { duplicateAnswers: 0, verifierCorrections: 0, replays: rows });
    expect(s.replay).toMatchObject({ n: 18, agree: 15, nFallback: 2, backendDrift: 0 });
    expect(detectRegressions(s, []).map((x) => x.signal)).toContain('turn_plan_drift'); // 15/18 = 83 % < 85 %
    const ok = summarizeAudit([], { duplicateAnswers: 0, verifierCorrections: 0, replays: rows.map((x, i) => (i < 16 ? { ...x, recorded: 'standard' as const } : x)) });
    expect(ok.replay).toMatchObject({ n: 18, agree: 16, nFallback: 2 }); // 89 % — the two fallback rows no longer trip it
    expect(detectRegressions(ok, []).map((x) => x.signal)).not.toContain('turn_plan_drift');
  });

  it('4c3f2a5c: a disagreement where the live backend differs from the replay backend is ATTRIBUTED (backendDrift), and the drift detail names it — the 2026-10-24 jev→llm-cql swap class', () => {
    const mk = (over: Partial<ReplayResult>): ReplayResult => ({ recorded: 'checked', replayed: 'checked', judge: null, acted: false, preset: 'thinking', hadDecision: true, ...over });
    const rows = Array.from({ length: 12 }, () => mk({}))
      .concat(Array.from({ length: 4 }, () => mk({ recorded: 'checked', replayed: 'standard', liveBackend: 'jev', replayBackend: 'llm-cql:agx-laya' })));
    const s = summarizeAudit([turnSignals(row({ lane: 'checked' }))], { duplicateAnswers: 0, verifierCorrections: 0, replays: rows });
    expect(s.replay).toMatchObject({ n: 16, agree: 12, backendDrift: 4, nFallback: 0 }); // 75 % — drift fires
    const [reg] = detectRegressions(s, []);
    expect(reg).toMatchObject({ signal: 'turn_plan_drift' });
    expect(reg!.detail).toMatch(/4 of the disagreements are BACKEND DRIFT \(the live ask's backend differs from today's — a swap or calibration change/);
    expect(auditBriefingLine(s)).toMatch(/backend drift 4/);
    // matching backends on every disagreement ⇒ no backendDrift note, same ratio
    const same = summarizeAudit([turnSignals(row({ lane: 'checked' }))], { duplicateAnswers: 0, verifierCorrections: 0, replays: rows.map((x) => ({ ...x, replayBackend: x.liveBackend })) });
    expect(same.replay).toMatchObject({ n: 16, agree: 12, backendDrift: 0 });
    expect(auditBriefingLine(same)).not.toMatch(/backend drift/);
  });

  it('4c3f2a5c: replayLaneResult — a bare lane keeps its meaning; a { lane, backend } record carries the replay backend for attribution', () => {
    expect(replayLaneResult('quick')).toEqual({ lane: 'quick', backend: null });
    expect(replayLaneResult(null)).toEqual({ lane: null, backend: null });
    expect(replayLaneResult('bogus' as unknown as any)).toEqual({ lane: null, backend: null });
    expect(replayLaneResult({ lane: 'research', backend: 'llm-cql:agx-laya' })).toEqual({ lane: 'research', backend: 'llm-cql:agx-laya' });
    expect(replayLaneResult({ lane: 'bogus' as unknown as any, backend: '' })).toEqual({ lane: null, backend: null });
  });

  it('4c3f2a5c: the replay ask carries the LIVE-faithful state — priorLane from the previous answer (stash-guarded, like the live reader), the TRUE turnIndex, attachments by the real attachmentMeta shape, the live backend normalized to its spec', async () => {
    // The audit's own answer population: two classified turns (decisionId set), like wireQueries' shape.
    const rows = [
      row({ id: 'a1', chatId: 'c1', lane: 'quick', act: true, ranQuick: true, decisionId: 'd-live-1' }),
      row({ id: 'a2', chatId: 'c2', lane: 'checked', decisionId: 'd-live-2', backend: 'TypeSafe Jev' }),
    ];
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ chatId: 'c9' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    // 3 prior user turns before the question; the question row carries 2 attachments in the REAL
    // attachmentMeta shape chat-agent stamps (items { filename, type: 'image'|'pdf'|'document' }) —
    // B1 fix: images count by the type-prefix filter (judgeContextFor's own), never a phantom
    // metadata.images key. The PREVIOUS answer recorded lane 'checked' WITH a stash (the live
    // reader's turnPlanFromMetadata returns null without one — a fallback answer yields null).
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { content: 'the question', createdAt: new Date('2026-10-04T00:03:00Z'), metadata: { attachments: [{ filename: 'a.png', type: 'image' }, { filename: 'b.pdf', type: 'pdf' }] } },
      { content: 'earlier 2' }, { content: 'earlier 1' },
    ]);
    mockPrisma.crossModelMessage.findFirst.mockImplementation((args: any) => {
      if (args.where.role === 'assistant') return Promise.resolve({ metadata: { depth: { turnPlan: { lane: 'checked', stash: {} } } } });
      return Promise.resolve({ createdAt: new Date('2026-10-04T00:03:00Z'), metadata: { attachments: [{ filename: 'a.png', type: 'image' }, { filename: 'b.pdf', type: 'pdf' }] } });
    });
    mockPrisma.crossModelMessage.count.mockResolvedValue(21); // the TRUE turn count (the ticket's 21-vs-2 case)
    const replayLane = jest.fn(async (_m: string, _p: string[], _s?: unknown) => ({ lane: 'checked' as const, backend: 'jev' }));
    await runLiveChatAuditOnce({ now: new Date('2026-10-04T09:00:00Z'), replayLane, judgeLane: async () => null, fileTicket: async () => 't-1' });
    expect(replayLane).toHaveBeenCalledWith('the question', ['earlier 1', 'earlier 2'], { priorLane: 'checked', turnIndex: 21, images: 1, documents: 1, liveBackend: 'jev' });
    // clearAllMocks clears calls but NOT implementations — restore the shared defaults before any
    // assert can fail, so later tests (the full-pass pin) see the pristine mock set.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
  });

  it('4c3f2a5c B1: a question row WITHOUT attachments replays attachment-blind (0/0) — and a phantom metadata.images key is never read', async () => {
    const rows = [row({ id: 'a1', chatId: 'c1', lane: 'quick', act: true, ranQuick: true, decisionId: 'd-live-1' })];
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      // NO attachments array, but a stray metadata.images — the reader must ignore it (B1).
      { content: 'the question', createdAt: new Date('2026-10-04T00:03:00Z'), metadata: { images: [{ id: 'phantom' }] } },
    ]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
    const replayLane = jest.fn(async () => 'quick' as const);
    await runLiveChatAuditOnce({ now: new Date('2026-10-04T09:00:00Z'), replayLane, judgeLane: async () => null, fileTicket: async () => 't-1' });
    expect(replayLane).toHaveBeenCalledWith('the question', [], { turnIndex: 0, images: 0, documents: 0, liveBackend: null });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  });

  it('4c3f2a5c B1: a prior answer whose plan carries NO stash (a preset fallback) yields priorLane null — the live reader\'s own guard, not a fallback lane', async () => {
    const rows = [row({ id: 'a1', chatId: 'c1', lane: 'quick', act: true, ranQuick: true, decisionId: 'd-live-1' })];
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { content: 'the question', createdAt: new Date('2026-10-04T00:03:00Z') },
    ]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ metadata: { depth: { turnPlan: { lane: 'quick' /* NO stash */ } } } });
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
    const replayLane = jest.fn(async () => 'quick' as const);
    await runLiveChatAuditOnce({ now: new Date('2026-10-04T09:00:00Z'), replayLane, judgeLane: async () => null, fileTicket: async () => 't-1' });
    expect(replayLane).toHaveBeenCalledWith('the question', [], { turnIndex: 0, images: 0, documents: 0, liveBackend: null });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  });

  it('4c3f2a5c B2: a live LABEL backend normalizes to its spec before the comparison — "TypeSafe Jev" vs replay spec "jev" is NOT backend drift', () => {
    // The answer row's turnPlan.backend is the LABEL ('TypeSafe Jev'); the replay returns the
    // SPEC ('jev'). Same physical backend ⇒ backendDrift must stay 0 (the pre-fix code compared
    // them raw and counted every such disagreement as drift).
    const mk = (over: Partial<ReplayResult>): ReplayResult => ({ recorded: 'checked', replayed: 'checked', judge: null, acted: false, preset: 'thinking', hadDecision: true, liveBackend: null, replayBackend: null, ...over });
    const rows = Array.from({ length: 12 }, () => mk({}))
      .concat(Array.from({ length: 4 }, () => mk({ recorded: 'checked', replayed: 'standard', liveBackend: 'TypeSafe Jev', replayBackend: 'jev' })));
    // The 2-to-arg form pins the SUMMARY comparison; the normalization happens in the audit loop
    // (backendSpecOfRow on the row's label), pinned by replayLaneResult + the state test. Here we
    // pin what the loop writes after normalization: liveBackend: 'jev' (the spec).
    const s = summarizeAudit([turnSignals(row({ lane: 'checked' }))], { duplicateAnswers: 0, verifierCorrections: 0, replays: rows.map((x) => ({ ...x, liveBackend: 'jev' })) });
    expect(s.replay).toMatchObject({ n: 16, agree: 12, backendDrift: 0 }); // 'jev' === 'jev'
    expect(auditBriefingLine(s)).not.toMatch(/backend drift/);
  });

  it('the briefing line names the numbers and the regression tickets', () => {
    const line = auditBriefingLine(baseSummary({ ranQuick: 9, ttft: { 'quick-ran': { n: 9, p50: 68_000, p90: 120_000 }, standard: { n: 21, p50: 21_800, p90: 100_000 } }, replay: { n: 20, agree: 19, judged: 0, judgeAgree: 0, quickActedJudgedDeeper: 0, researchUnderRouted: 0 } }), ['duplicate_answers']);
    expect(line).toMatch(/^Live-chat audit \(last 24 h\): 40 human turns · Quick lane 9 \(first token p50 68 s\) · other lanes p50 22 s · replay agreement 95 %/);
    // audit 2026-10-08 W4-3: a detected regression is never called a "ticket" unless one was filed.
    expect(line).toMatch(/⚠ 1 regression\(s\) detected: duplicate_answers$/);
    expect(auditBriefingLine(baseSummary({ turns: 0 }))).toBeNull();
  });
});

describe('runLiveChatAuditOnce', () => {
  const answers = [
    row({ id: 'a1', chatId: 'c1', lane: 'quick', act: true, ranQuick: true, decisionId: 'd-live-1' }),
    row({ id: 'a2', chatId: 'c2', lane: 'standard', content: 'Say the word and I will do the rest.', decisionId: 'd-live-2' }),
    { ...row({ id: 'v1', chatId: 'c3' }), metadata: { origin: 'machine', verifier: 'action-verifier', depth: {} } },
  ];
  const wireQueries = (dupChats: string[], verifierChats: string[]) => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(answers)
      .mockResolvedValueOnce(dupChats.map((chatId) => ({ chatId })))
      .mockResolvedValueOnce(verifierChats.map((chatId) => ({ chatId })))
      .mockResolvedValueOnce([]); // verifier mishap tickets (observe-only era)
  };

  it('LIVE_CHAT_AUDIT_DISABLED=1 does nothing', async () => {
    process.env.LIVE_CHAT_AUDIT_DISABLED = '1';
    expect(await runLiveChatAuditOnce()).toMatch(/disabled/);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('a full pass: signals, transcript checks, replay + judge, one ticket per regression, one summary row — never message text', async () => {
    wireQueries(['c9'], []);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ content: 'what is the weather in Tokyo?' }]);
    const replayLane = jest.fn(async () => 'quick' as const);
    const judgeLane = jest.fn(async () => 'quick' as const);
    const fileTicket = jest.fn(async () => 't-1');
    const line = await runLiveChatAuditOnce({ now: new Date('2026-10-04T09:00:00Z'), replayLane, judgeLane, fileTicket });
    expect(line).toMatch(/^2 turns, 1 regression\(s\) filed: duplicate_answers, replay 1\/2, judged 2/); // both answers carried a turn plan; the standard one replayed as quick
    expect(fileTicket).toHaveBeenCalledTimes(1);
    expect((fileTicket.mock.calls[0] as any)[0]).toMatchObject({ signal: 'duplicate_answers' });
    expect((fileTicket.mock.calls[0] as any)[2]).toEqual(['c9']);
    // Ticket 4c3f2a5c: the replay ask carries the LIVE-faithful state (third arg) — priorLane when
    // the previous answer recorded one, the TRUE turnIndex (not the ≤2 prior window), attachments.
    // Here: no prior answer (findFirst → null) ⇒ no priorLane, turnIndex = count → 0, no attachments.
    expect(replayLane).toHaveBeenCalledWith('what is the weather in Tokyo?', [], { turnIndex: 0, images: 0, documents: 0, liveBackend: null });
    const metric = mockRecordLoopMetric.mock.calls[0][0];
    expect(metric).toMatchObject({ kind: LIVE_CHAT_AUDIT_KIND, value: 2, meta: { regressions: ['duplicate_answers'], ticketsFiled: ['duplicate_answers'] } });
    expect(metric.meta.summary).toMatchObject({ turns: 2, handbacks: 1, duplicateAnswers: 1 });
    expect(JSON.stringify(metric)).not.toMatch(/Tokyo|Say the word/); // aggregates only
  });

  it('LIVE_CHAT_AUDIT_TICKETS_DISABLED=1 reports but files nothing; sample envs at 0 skip the replay + judge legs', async () => {
    process.env.LIVE_CHAT_AUDIT_TICKETS_DISABLED = '1';
    process.env.LIVE_CHAT_AUDIT_REPLAY_SAMPLE = '0';
    wireQueries(['c9'], []);
    const fileTicket = jest.fn(async () => 't-1');
    const replayLane = jest.fn(async () => 'quick' as const);
    await runLiveChatAuditOnce({ fileTicket, replayLane });
    expect(fileTicket).not.toHaveBeenCalled();
    expect(replayLane).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ regressions: ['duplicate_answers'], ticketsFiled: [], ticketsDisabled: true });
  });

  it('verifier convictions count the observe-only MISHAP TICKETS too (deduped by chat with correction rows)', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(answers)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ chatId: 'c1' }])
      .mockResolvedValueOnce([{ chatId: 'c1' }, { chatId: 'c4' }, { chatId: 'c5' }]);
    const fileTicket = jest.fn(async () => 't-2');
    await runLiveChatAuditOnce({ fileTicket, replayLane: async () => null, judgeLane: async () => null });
    expect(mockRecordLoopMetric.mock.calls[0][0].meta.summary.verifierCorrections).toBe(3);
    expect((fileTicket.mock.calls[0] as any)[0]).toMatchObject({ signal: 'verifier_corrections', title: '[live-chat audit] action-verifier phantom convictions on plain chats' });
  });

  it('never throws: a failed query returns a status line', async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    expect(await runLiveChatAuditOnce()).toMatch(/^failed: db down/);
  });

  // Ticket 18bce3f9 (2026-10-07): 4 of 5 hand-back sample chats were model-bench
  // traffic (claudebot@digby.example.com, titles 'model-bench …') — synthetic answers drove
  // the '6 hand-backs' count and re-filed the ticket nightly. The answer query must
  // exclude the bench account's chats (by account email AND by title prefix — the
  // belt for rows written before the synthetic stamp existed).
  it('18bce3f9 — the answer query excludes bench-account chats (by email) and model-bench titles (prefix)', async () => {
    wireQueries([], []);
    const replayLane = jest.fn(async () => 'quick' as const);
    await runLiveChatAuditOnce({ now: new Date('2026-10-07T09:00:00Z'), replayLane, judgeLane: async () => null });
    const first = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0];
    const sql = String(first[0]);
    expect(sql).toMatch(/LEFT JOIN "users" bu ON bu\."id" = c\."userId" AND bu\."email" = /);
    expect(sql).toMatch(/bu\."id" IS NULL/);
    expect(sql).toMatch(/coalesce\(c\."title", ''\) NOT LIKE /);
    const params = first.slice(1).map((x: any) => (x instanceof Date ? x.toISOString() : String(x)));
    // the bound params include the bench account email and the title prefix
    expect(params.some((x: string) => /claudebot@digby\.example\.com/.test(x))).toBe(true);
    expect(params.some((x: string) => /^model-bench%?$/.test(x))).toBe(true);
    // 18bce3f9 review finding 3: the transcript checks (duplicate answers, verifier
    // corrections) exclude bench traffic too — the population must agree across signals.
    const calls = (mockPrisma.$queryRaw as jest.Mock).mock.calls;
    const dupCall = calls.find((c: any[]) => String(c[0]).includes('count(*)') && String(c[0]).includes('u."chatId"'));
    const verifierCall = calls.find((c: any[]) => String(c[0]).includes("'action-verifier'"));
    for (const c of [dupCall, verifierCall]) {
      expect(c).toBeTruthy();
      const sql = String(c[0]);
      expect(sql).toMatch(/bu\."id" IS NULL/);
      expect(sql).toMatch(/NOT LIKE /);
      expect(c.slice(1).some((x: any) => /claudebot@digby\.example\.com/.test(String(x)))).toBe(true);
    }
  });

  // Ticket 0f208004 (2026-10-09): the duplicate-answer transcript check counted a coding
  // session's hourly session_status card (origin AND kind 'session_status') as a second
  // "ordinary" answer — both sighted chats were ONE real answer + one card. The sub-select
  // is now ALLOW-LISTED: an assistant row is an answer only when origin = 'user' OR it
  // carries a depth stamp (the answers-query contract) — every machine notice (status
  // cards, schedule ACKs / owner digests origin 'schedule', hook wakes, background-worker
  // reports, deploy-interrupt notes, metadata-less notices) is out in one predicate, and
  // a coding-session answer row stamped only {origin:'user', triggerKind:'user'} still
  // counts (71 such rows in the 14 d probe — a depth-ONLY allow-list would drop them).
  // Card kinds stay in the kind list as the second belt (side-row kinds live there).
  it('0f208004 — the duplicate-answer SQL is allow-listed: origin user OR a depth stamp; cards excluded from the kind list', async () => {
    wireQueries([], []);
    await runLiveChatAuditOnce({ replayLane: async () => null, judgeLane: async () => null });
    const calls = (mockPrisma.$queryRaw as jest.Mock).mock.calls;
    const dupCall = calls.find((c: any[]) => String(c[0]).includes('count(*)') && String(c[0]).includes('u."chatId"'));
    expect(dupCall).toBeTruthy();
    const sql = String(dupCall![0]);
    expect(sql).toMatch(/\(a\."metadata"->>'origin' = 'user' OR a\."metadata"->'depth' IS NOT NULL\)/);
    expect(sql).toMatch(/coalesce\(a\."metadata"->>'kind', ''\) NOT IN \('deeper_findings','continuation_result','deliverable_handoff','control_note','check_addendum','council_addendum','session_status','project_status','owner_briefing'\)/);
    expect(sql).not.toMatch(/coalesce\(a\."metadata"->>'origin', 'user'\) NOT IN/); // the deny-list is gone
  });

  // DETECTOR-RECALL REPLAY (ticket 0f208004): the precision fix above must NOT relax the
  // detector — a user turn genuinely answered by TWO ordinary assistant rows still files
  // the duplicate_answers regression. This replays the detector's PRIOR true positive
  // (the 2026-10-04 orphan-sweeper race sighting shape: two plain origin-'user' answer
  // rows in one turn window) through the full pass, SQL shape included.
  it('DETECTOR-RECALL REPLAY (0f208004) — a genuine double answer still files duplicate_answers', async () => {
    wireQueries(['c9'], []);
    const fileTicket = jest.fn(async () => 't-1');
    await runLiveChatAuditOnce({ now: new Date('2026-10-09T09:00:00Z'), replayLane: async () => null, judgeLane: async () => null, fileTicket });
    expect(fileTicket).toHaveBeenCalledTimes(1);
    expect((fileTicket.mock.calls[0] as any)[0]).toMatchObject({ signal: 'duplicate_answers', type: 'bug_report' });
    expect((fileTicket.mock.calls[0] as any)[2]).toEqual(['c9']);
    // the SQL that produced the sighting still carries the ordinary-answer population
    const calls = (mockPrisma.$queryRaw as jest.Mock).mock.calls;
    const dupCall = calls.find((c: any[]) => String(c[0]).includes('count(*)') && String(c[0]).includes('u."chatId"'));
    const sql = String(dupCall![0]);
    expect(sql).toMatch(/a\."role" = 'assistant' AND a\."createdAt" > u\."createdAt"/); // counts answers to THIS user row
    expect(sql).toMatch(/a\."metadata"->>'verifier' IS NULL/); // verifier notes never counted
    // recall: a plain human answer row — origin 'user' with NO depth stamp (a coding
    // session's answer rows, 71 in the 14 d prod probe) — still enters the count.
    expect(sql).toMatch(/\(a\."metadata"->>'origin' = 'user' OR a\."metadata"->'depth' IS NOT NULL\)/);
  });

  // 0f208004 review finding (adversarial review 2026-10-09): the OLD deny-list admitted
  // every assistant row with no kind and a non-enumerated origin — the prod leak class
  // (14 d probe): 778 schedule ACK / owner-digest rows (origin 'schedule', some kind
  // 'owner_digest'), 64 hook-wake answers (origin 'hook'), 16 owner-inbox notes, 8
  // metadata-less notice rows, background_worker_report / child_run_failed /
  // deploy-interrupt rows. The allow-list predicate must exclude ALL of them.
  it('0f208004 — machine notices (schedule ACKs, hook wakes, worker reports, metadata-less rows) are never counted as answers', () => {
    // the allow-listed SQL predicate, as a JS twin: origin 'user' OR a depth stamp.
    const isCountedAnswer = (metadata: any) => {
      const md = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : {};
      return (md.origin === 'user' || md.depth !== undefined) && !SIDE_KINDS.has(String(md.kind ?? '')) && !CARD_NOTE_KINDS.has(String(md.kind ?? '')) && !md.verifier;
    };
    expect(isCountedAnswer({ origin: 'user', triggerKind: 'user' })).toBe(true); // coding answer, no depth (recall)
    expect(isCountedAnswer({ depth: {} })).toBe(true); // plain human answer (no origin stamp)
    expect(isCountedAnswer({ origin: 'schedule' })).toBe(false); // 778 rows
    expect(isCountedAnswer({ origin: 'schedule', kind: 'owner_digest' })).toBe(false); // owner digests
    expect(isCountedAnswer({ origin: 'hook' })).toBe(false); // 64 rows
    expect(isCountedAnswer({ origin: 'owner-inbox' })).toBe(false);
    expect(isCountedAnswer({ kind: 'background_worker_report', origin: 'background_worker' })).toBe(false);
    expect(isCountedAnswer({ kind: 'child_run_failed', origin: 'child_failure' })).toBe(false);
    expect(isCountedAnswer({ origin: 'deploy-interrupt' })).toBe(false);
    expect(isCountedAnswer(null)).toBe(false); // metadata-less notice rows (8)
    expect(isCountedAnswer(undefined)).toBe(false);
  });
});

describe('answer quality + leaks + refusals (2026-10-04)', () => {
  it('flags leaked internal text and false "I can\'t browse" refusals on real answers', () => {
    expect(ANSWER_LEAK_RE.test('Here you go <think>reasoning</think>')).toBe(true);
    expect(ANSWER_LEAK_RE.test('{"name": "search_engine", "arguments": {}}')).toBe(true);
    expect(ANSWER_LEAK_RE.test('The weather is sunny.')).toBe(false);
    expect(ANSWER_REFUSAL_RE.test("Sorry, I can't browse the internet to check live prices.")).toBe(true);
    expect(ANSWER_REFUSAL_RE.test('The store opens at 9 am.')).toBe(false);
    const s = turnSignals({ ...row(), content: 'Sure <think>x</think> done' });
    expect(s).toMatchObject({ leak: true, refusal: false });
  });

  it('self-host 2026-10-20: an honest "no web search here" line is never a refusal on an instance without web search', () => {
    const content = "I can't search the web on this instance, so this is from memory.";
    expect(turnSignals({ ...row(), content }, undefined, { webSearchConfigured: false }).refusal).toBe(false);
    expect(turnSignals({ ...row(), content }).refusal).toBe(true);
    // the non-web refusals still count there
    expect(turnSignals({ ...row(), content: 'As an AI language model I cannot have opinions.' }, undefined, { webSearchConfigured: false }).refusal).toBe(true);
    expect(turnSignals({ ...row(), content: "I can't help with that request." }, undefined, { webSearchConfigured: false }).refusal).toBe(true);
  });

  it('parses SCORE / ISSUE from the judge (last lines win; unknown issue falls back by score)', () => {
    expect(parseQuality('thinking...\nSCORE: 2\nISSUE: incomplete')).toEqual({ score: 2, issue: 'incomplete' });
    expect(parseQuality('SCORE: 5\nISSUE: perfect')).toEqual({ score: 5, issue: 'none' });
    expect(parseQuality('SCORE: 3\nISSUE: ???')).toEqual({ score: 3, issue: 'unclear' });
    expect(parseQuality('no verdict')).toEqual({ score: null, issue: 'unclear' });
  });

  it('defaultQualityJudge (exported for the model bench): QUALITY_RUBRIC on the Utility seat, parsed; empty → 1 with no call; failure → null', async () => {
    mockUtilityChat.mockResolvedValueOnce('The answer covers both parts.\nSCORE: 4\nISSUE: none');
    expect(await defaultQualityJudge('is it gonna rain in Toronto tomorrow', 'Yes — 80 % chance (Environment Canada, today).')).toEqual({ score: 4, issue: 'none' });
    const [msgs, opts] = mockUtilityChat.mock.calls[0] as any[];
    expect(msgs[0]).toEqual({ role: 'system', content: QUALITY_RUBRIC });
    expect(msgs[msgs.length - 1].content).toMatch(/^USER MESSAGE:\nis it gonna rain[\s\S]*ASSISTANT ANSWER:\nYes/);
    expect(opts).toMatchObject({ thinking: true, temperature: 0.1 });
    mockUtilityChat.mockClear();
    expect(await defaultQualityJudge('q', '   ')).toEqual({ score: 1, issue: 'off_topic' });
    expect(mockUtilityChat).not.toHaveBeenCalled();
    mockUtilityChat.mockRejectedValueOnce(new Error('seat down'));
    expect(await defaultQualityJudge('q', 'an answer')).toBeNull();
  });

  it('defaultComparativeJudge (P1.3, exported for the model bench): COMPARATIVE_RUBRIC on the Utility seat, labels never named; RANKING parsed best-first with the LAST line winning; empty → null with no call; unparseable/failed → null', async () => {
    mockUtilityChat.mockResolvedValueOnce('Comparing the three candidates.\nRANKING: C, A, B');
    const answers = [
      { label: 'A', answer: 'Paris is the capital of France.' },
      { label: 'B', answer: 'I think it might be Lyon?' },
      { label: 'C', answer: 'The capital of France is Paris.' },
    ];
    expect(await defaultComparativeJudge('what is the capital of France', answers)).toEqual(['C', 'A', 'B']);
    const [msgs, opts] = mockUtilityChat.mock.calls[0] as any[];
    expect(msgs[0]).toEqual({ role: 'system', content: COMPARATIVE_RUBRIC });
    expect(msgs[msgs.length - 1].content).toMatch(/^USER QUESTION:\nwhat is the capital of France\n\nCANDIDATE ANSWERS:\n--- A ---\nParis is the capital of France\./);
    expect(opts).toMatchObject({ thinking: true, temperature: 0.1 });
    // parseRanking: last RANKING line wins; space-separated labels parse; no line → null
    expect(parseRanking('RANKING: B, A\nmore text\nRANKING: A,B')).toEqual(['A', 'B']);
    expect(parseRanking('RANKING: C  A')).toEqual(['C', 'A']);
    expect(parseRanking('no ranking line')).toBeNull();
    // empty candidate list → null without a seat call
    mockUtilityChat.mockClear();
    expect(await defaultComparativeJudge('q', [])).toBeNull();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    // reply without a RANKING line → null; seat failure → null
    mockUtilityChat.mockResolvedValueOnce('judge reply without a RANKING line');
    expect(await defaultComparativeJudge('q', [{ label: 'A', answer: 'an answer' }])).toBeNull();
    mockUtilityChat.mockRejectedValueOnce(new Error('seat down'));
    expect(await defaultComparativeJudge('q', [{ label: 'A', answer: 'an answer' }])).toBeNull();
  });

  it('comparativeJudgeOnModel (P1.5, exported for the model bench): the SAME rubric on a PINNED spec via resolveProviderForRun + runHelperCompletion; a fallen-back colon-spec / empty answer / timeout → null (never a wrong ranking)', async () => {
    const answers = [
      { label: 'A', answer: 'Paris is the capital of France.' },
      { label: 'B', answer: 'The capital of France is Paris.' },
    ];
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'cql-litellm (custom endpoint)', model: 'mimo-v26-flash-rl' });
    mockRunHelperCompletion.mockResolvedValueOnce({ text: 'Comparing the candidates.\nRANKING: B, A', hadReasoning: false, finishReason: 'stop' });
    expect(await comparativeJudgeOnModel('what is the capital of France', answers, 'cql-litellm:mimo-v26-flash-rl')).toEqual(['B', 'A']);
    expect(mockResolveProviderForRun).toHaveBeenCalledWith('cql-litellm:mimo-v26-flash-rl');
    const [p, msgs, opts] = mockRunHelperCompletion.mock.calls[0] as any[];
    expect(p.model).toBe('mimo-v26-flash-rl');
    expect(msgs[0]).toEqual({ role: 'system', content: COMPARATIVE_RUBRIC }); // the same rubric as the seat judge
    expect(msgs[msgs.length - 1].content).toMatch(/^USER QUESTION:\nwhat is the capital of France\n\nCANDIDATE ANSWERS:\n--- A ---\nParis is the capital of France\./);
    expect(opts).toMatchObject({ maxTokens: 4000, temperature: 0.1, timeoutMs: 120_000 });
    // a colon-spec that fell back to the built-in switch (no '(custom endpoint)' label) is NOT the judge asked for → null
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'built-in', model: 'glm-5.3' });
    expect(await comparativeJudgeOnModel('q', answers, 'dead-endpoint:some-model')).toBeNull();
    expect(mockRunHelperCompletion).toHaveBeenCalledTimes(1);
    // built-in ids resolve normally (no colon → no fallback check) and parse normally
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'built-in', model: 'glm-5.3' });
    mockRunHelperCompletion.mockResolvedValueOnce({ text: 'RANKING: A, B', hadReasoning: false, finishReason: 'stop' });
    expect(await comparativeJudgeOnModel('q', answers, 'glm-5.3')).toEqual(['A', 'B']);
    // an empty answer text throws HelperEmptyAnswerError → null; a timeout → null; empty candidate list → null with no call
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'cql-litellm (custom endpoint)', model: 'mimo-v26-flash-rl' });
    mockRunHelperCompletion.mockRejectedValueOnce(new Error('timeout of 120000ms exceeded'));
    expect(await comparativeJudgeOnModel('q', answers, 'cql-litellm:mimo-v26-flash-rl')).toBeNull();
    // an empty answer text (HelperEmptyAnswerError) → null — the caller falls back to absolute scoring, never a wrong ranking
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'cql-litellm (custom endpoint)', model: 'mimo-v26-flash-rl' });
    mockRunHelperCompletion.mockRejectedValueOnce(new Error('mimo-v26-flash-rl (cql-litellm (custom endpoint)) returned no answer text'));
    expect(await comparativeJudgeOnModel('q', answers, 'cql-litellm:mimo-v26-flash-rl')).toBeNull();
    mockResolveProviderForRun.mockClear();
    mockRunHelperCompletion.mockClear();
    expect(await comparativeJudgeOnModel('q', [], 'cql-litellm:mimo-v26-flash-rl')).toBeNull();
    expect(await comparativeJudgeOnModel('q', answers, '')).toBeNull();
    expect(mockResolveProviderForRun).not.toHaveBeenCalled();
  });

  // Judge v2 (2026-10-20, "fix the model benchmarks"): the length-blind rubric, the cut marker, the wider parser.
  it('COMPARATIVE_RUBRIC_V2 is length-blind, order-blind and asks for EVERY label; v1 stays the default rubric', () => {
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/Length and formatting are NOT quality/);
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/Never prefer an answer for being longer, more detailed, more formatted/);
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/prefer the SHORTER one/);
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/Padding, repetition and filler are defects/);
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/order of the answers and their labels are RANDOM/);
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/Rank EVERY label exactly once/);
    // the cut note is NOT a length cue and credits nothing unseen (2026-10-20 review): no char count, no "assume it is fine"
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/"shortened here for this review" marker/);
    expect(COMPARATIVE_RUBRIC_V2).toMatch(/give the unseen rest neither credit nor penalty/);
    expect(COMPARATIVE_RUBRIC_V2).not.toMatch(/do not count the cut against it|\d+ chars/);
    expect(COMPARATIVE_RUBRIC_V2).not.toMatch(/right length/); // the v1 phrase that asked the judge to weigh length
    expect(COMPARATIVE_RUBRIC_V2.split('\n').pop()).toMatch(/^RANKING: /); // the parser's line stays the last instruction
    expect(comparativeRubricText()).toBe(COMPARATIVE_RUBRIC);
    expect(comparativeRubricText('v1')).toBe(COMPARATIVE_RUBRIC);
    expect(comparativeRubricText('v2')).toBe(COMPARATIVE_RUBRIC_V2);
  });

  it('comparativeUserMessage: v1 is byte-identical to the pre-v2 message (no marker); v2 marks a CUT answer only', () => {
    const long = 'x'.repeat(6500);
    const answers = [{ label: 'A', answer: long }, { label: 'B', answer: 'short' }];
    const legacy = `USER QUESTION:\n${'q'.repeat(10)}\n\nCANDIDATE ANSWERS:\n${answers.map((a) => `--- ${a.label} ---\n${a.answer.slice(0, 6000)}`).join('\n\n')}`;
    expect(comparativeUserMessage('q'.repeat(10), answers)).toBe(legacy);
    expect(comparativeUserMessage('q'.repeat(10), answers, 'v1')).toBe(legacy);
    const v2 = comparativeUserMessage('q'.repeat(10), answers, 'v2');
    expect(COMPARATIVE_CUT_MARKER).toBe('[… shortened here for this review]');
    expect(COMPARATIVE_CUT_MARKER).not.toMatch(/\d/); // the marker never states the answer's length
    expect(v2).toBe(`USER QUESTION:\n${'q'.repeat(10)}\n\nCANDIDATE ANSWERS:\n--- A ---\n${'x'.repeat(6000)}\n${COMPARATIVE_CUT_MARKER}\n\n--- B ---\nshort`);
    // exactly 6000 chars is not cut → no marker; the question cut is unchanged (3000)
    expect(comparativeUserMessage('q', [{ label: 'A', answer: 'y'.repeat(6000) }], 'v2')).not.toContain('shortened');
    expect(comparativeUserMessage('Q'.repeat(3500), [{ label: 'A', answer: 'a' }], 'v2')).toContain(`USER QUESTION:\n${'Q'.repeat(3000)}\n\n`);
  });

  it('parseRanking (judge v2): > separates labels like commas, markdown emphasis / code ticks are stripped; ; and / still END the line; the old pins hold', () => {
    expect(parseRanking('RANKING: B > A > C')).toEqual(['B', 'A', 'C']); // was ['B'] — the ingest filled A, C by position
    expect(parseRanking('RANKING: C>A>B')).toEqual(['C', 'A', 'B']);
    expect(parseRanking('RANKING: C, A > B')).toEqual(['C', 'A', 'B']);
    // 2026-10-20 review: ';' and '/' are NOT separators — trailing prose after them stays out of the labels (as before
    // v2), so a clean ranking is never turned into a v2 "incomplete" ballot (a retry or a failed ballot)
    expect(parseRanking('RANKING: C, A, B; A is weakest on sources')).toEqual(['C', 'A', 'B']);
    expect(parseRanking('RANKING: B, A, C / C cut short')).toEqual(['B', 'A', 'C']);
    expect(parseRanking('RANKING: C; A; B')).toEqual(['C']); // a ';'-separated ranking reads as partial (v2 refuses it → the ballot is retried)
    expect(parseRanking('RANKING: **C, A, B**')).toEqual(['C', 'A', 'B']); // was null
    expect(parseRanking('**RANKING:** C, A, B')).toEqual(['C', 'A', 'B']);
    expect(parseRanking('__RANKING: B, A__')).toEqual(['B', 'A']);
    expect(parseRanking('RANKING: `C, A, B`')).toEqual(['C', 'A', 'B']);
    expect(parseRanking('reasoning…\n**RANKING: B > C > A**\n')).toEqual(['B', 'C', 'A']);
    // the existing pins
    expect(parseRanking('RANKING: B, A\nmore text\nRANKING: A,B')).toEqual(['A', 'B']);
    expect(parseRanking('RANKING: C  A')).toEqual(['C', 'A']);
    expect(parseRanking('no ranking line')).toBeNull();
    expect(parseRanking('RANKING: C, A, B')).toEqual(['C', 'A', 'B']);
    // an equality is not a separator: the line stops there (the ingest's v2 completeness check then refuses it)
    expect(parseRanking('RANKING: C > A = B')).toEqual(['C', 'A']);
  });

  it('both comparative judges take opts.rubric: v2 = COMPARATIVE_RUBRIC_V2 + the cut marker; omitted = v1 exactly; v2 refuses a bare id that does not resolve to itself', async () => {
    const answers = [{ label: 'A', answer: 'z'.repeat(6100) }, { label: 'B', answer: 'The capital of France is Paris.' }];
    mockUtilityChat.mockResolvedValueOnce('RANKING: B > A');
    expect(await defaultComparativeJudge('capital of France?', answers, { rubric: 'v2' })).toEqual(['B', 'A']);
    const [msgs, opts] = mockUtilityChat.mock.calls[0] as any[];
    expect(msgs[0]).toEqual({ role: 'system', content: COMPARATIVE_RUBRIC_V2 });
    expect(msgs[1].content).toContain(COMPARATIVE_CUT_MARKER);
    expect(opts).toMatchObject({ thinking: true, temperature: 0.1, maxTokens: 4000, timeout: 120_000 }); // the call shape is unchanged
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('RANKING: B, A');
    await defaultComparativeJudge('capital of France?', answers);
    const [v1msgs] = mockUtilityChat.mock.calls[0] as any[];
    expect(v1msgs[0]).toEqual({ role: 'system', content: COMPARATIVE_RUBRIC });
    expect(v1msgs[1].content).not.toContain('cut at');
    // the pinned-spec judge
    mockResolveProviderForRun.mockClear();
    mockRunHelperCompletion.mockClear();
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'DashScope intl (Qwen)', model: 'qwen3.6-27b' });
    mockRunHelperCompletion.mockResolvedValueOnce({ text: '**RANKING:** B, A', hadReasoning: false, finishReason: 'stop' });
    expect(await comparativeJudgeOnModel('capital of France?', answers, 'qwen3.6-27b', { rubric: 'v2' })).toEqual(['B', 'A']);
    const [, hmsgs, hopts] = mockRunHelperCompletion.mock.calls[0] as any[];
    expect(hmsgs[0]).toEqual({ role: 'system', content: COMPARATIVE_RUBRIC_V2 });
    expect(hmsgs[1].content).toContain(COMPARATIVE_CUT_MARKER);
    expect(hopts).toEqual({ maxTokens: 4000, temperature: 0.1, timeoutMs: 120_000 });
    // v2: a bare id that resolves to ANOTHER built-in (a typo → normalizeCodingModel's default) is refused, no call
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'ZAI direct', model: 'glm-5.3' });
    expect(await comparativeJudgeOnModel('q', answers, 'qwen3.6-27bb', { rubric: 'v2' })).toBeNull();
    expect(mockRunHelperCompletion).toHaveBeenCalledTimes(1);
    // v1 (omitted): the same fallen-back bare id still judges, exactly as before — and on the v1 rubric
    mockResolveProviderForRun.mockResolvedValueOnce({ ...PROVIDER, label: 'ZAI direct', model: 'glm-5.3' });
    mockRunHelperCompletion.mockResolvedValueOnce({ text: 'RANKING: A, B', hadReasoning: false, finishReason: 'stop' });
    expect(await comparativeJudgeOnModel('q', answers, 'qwen3.6-27bb')).toEqual(['A', 'B']);
    expect((mockRunHelperCompletion.mock.calls[1] as any[])[1][0]).toEqual({ role: 'system', content: COMPARATIVE_RUBRIC });
  });

  it('summarizes the judge and files regressions: any leak, ≥ 3 refusals, low quality', () => {
    const q = [5, 4, 2, 1, 2, 4, 5, 4, 3, 2].map((score) => ({ score, issue: score <= 2 ? 'incomplete' as const : 'none' as const }));
    const s = summarizeAudit([], { duplicateAnswers: 0, verifierCorrections: 0, replays: [], quality: q });
    expect(s.quality).toEqual({ n: 10, mean: 3.2, low: 4, issues: { incomplete: 4 } });
    const signals = detectRegressions(baseSummary({ leaks: 1, refusals: 3, quality: s.quality }), []).map((r) => r.signal).sort();
    expect(signals).toEqual(['answer_leaks', 'answer_quality', 'answer_refusals']);
    expect(detectRegressions(baseSummary({ quality: { n: 9, mean: 2, low: 9, issues: {} } }), [])).toEqual([]); // n < 10
    expect(auditBriefingLine({ ...s, turns: 10 })).toMatch(/answer quality 3\.2\/5 \(n 10, 4 low\)/);
  });

  it('a full pass runs the quality judge over the replay sample (no answer text in the row)', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a1', chatId: 'c1', lane: 'standard', content: 'Paris is the capital of France.' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ content: 'capital of france?' }]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // no side rows after the answer
    process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE = '20';
    const qualityJudge = jest.fn(async () => ({ score: 5, issue: 'none' as const }));
    await runLiveChatAuditOnce({ replayLane: async () => 'standard', judgeLane: async () => 'standard', qualityJudge, fileTicket: jest.fn(async () => null) });
    expect(qualityJudge).toHaveBeenCalledWith('capital of france?', 'Paris is the capital of France.', [], {});
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.summary.quality).toEqual({ n: 1, mean: 5, low: 0, issues: {} });
    expect(JSON.stringify(meta)).not.toMatch(/Paris|capital of france/);
  });

  // ── Ticket 3ff96116 (2026-10-09): the quality judge scored attachment turns blind, never saw a
  // turn's side-row continuation, and its run-to-run spread (measured 3 on the 1..5 scale — the same
  // answer re-scored 2,5,2,4) made single samples count answers "low" on noise. These pin the three
  // measurement fixes: judge context (attachments + side rows) and median-of-K scoring. ──
  it('3ff96116 — the judge gets a context note for image attachments (it cannot see pixels) and for the same turn\'s side rows; no ctx = the pre-fix call shape', async () => {
    // image attachment on the turn's user row
    mockUtilityChat.mockResolvedValueOnce('SCORE: 4\nISSUE: none');
    await defaultQualityJudge('what is in this photo', 'The receipt shows $12.40.', [], { images: 1 });
    const content = (mockUtilityChat.mock.calls[0] as any[])[0][mockUtilityChat.mock.calls[0][0].length - 1].content as string;
    expect(content).toMatch(/^NOTE: the user message arrived with 1 image attachment\(s\) whose contents you cannot see/);
    expect(content).toMatch(/USER MESSAGE:\nwhat is in this photo\n\nASSISTANT ANSWER:\nThe receipt shows \$12\.40\.$/);
    // document attachment
    mockUtilityChat.mockClear();
    await defaultQualityJudge('summarize the attached doc', 'The doc lists 3 steps.', [], { documents: 2 });
    expect(String((mockUtilityChat.mock.calls[0] as any[])[0].slice(-1)[0].content)).toMatch(/^NOTE: the user message arrived with 2 document attachment\(s\)/);
    // side-row continuation: the note + the appended block
    mockUtilityChat.mockClear();
    await defaultQualityJudge('fix my deploy', 'Looked at it — details below.', [], { sideRowText: 'The root cause was the env var. Fix: set FOO=bar.' });
    const c2 = String((mockUtilityChat.mock.calls[0] as any[])[0].slice(-1)[0].content);
    expect(c2).toMatch(/NOTE: after this answer the SAME turn delivered a continuation note/);
    expect(c2).toMatch(/\[continuation of the same turn, delivered to the user as a side note\]\nThe root cause was the env var\. Fix: set FOO=bar\.$/);
    // no ctx: the pre-3ff96116 shape is unchanged (bench compatibility)
    mockUtilityChat.mockClear();
    await defaultQualityJudge('q', 'an answer', []);
    expect(String((mockUtilityChat.mock.calls[0] as any[])[0].slice(-1)[0].content)).not.toMatch(/^NOTE:/);
  });

  it('3ff96116 — collapseQuality: median of K, ties conservative, nulls skipped, all-null → null', () => {
    expect(collapseQuality([{ score: 2, issue: 'incorrect' }, { score: 5, issue: 'none' }, { score: 2, issue: 'incorrect' }])).toEqual({ score: 2, issue: 'incorrect' });
    expect(collapseQuality([{ score: 5, issue: 'none' }, { score: 2, issue: 'incorrect' }, { score: 4, issue: 'incomplete' }])).toEqual({ score: 4, issue: 'incomplete' });
    // even K: the LOWER of the two centres wins (conservative)
    expect(collapseQuality([{ score: 5, issue: 'none' }, { score: 1, issue: 'incorrect' }])).toEqual({ score: 1, issue: 'incorrect' });
    // the measured prod noise shape: 2,5,2,4 → 2 (not the 5 or the 4)
    expect(collapseQuality([{ score: 2, issue: 'incorrect' }, { score: 5, issue: 'none' }, { score: 2, issue: 'incorrect' }, { score: 4, issue: 'incomplete' }])).toEqual({ score: 2, issue: 'incorrect' });
    // null / unparseable calls are skipped; all-null → null
    expect(collapseQuality([null, { score: 4, issue: 'incomplete' }])).toEqual({ score: 4, issue: 'incomplete' });
    expect(collapseQuality([null, null])).toBeNull();
    expect(collapseQuality([])).toBeNull();
  });

  it('3ff96116 — qualityRepeatsFromEnv: default 3 (median-of-K); 1 restores the single shot; clamped 1..9; garbage → default', () => {
    expect(qualityRepeatsFromEnv(undefined)).toBe(3);
    expect(qualityRepeatsFromEnv('')).toBe(3);
    expect(qualityRepeatsFromEnv('1')).toBe(1);
    expect(qualityRepeatsFromEnv('5')).toBe(5);
    expect(qualityRepeatsFromEnv('0')).toBe(1); // clamped up — one call minimum
    expect(qualityRepeatsFromEnv('99')).toBe(9); // clamped down
    expect(qualityRepeatsFromEnv('garbage')).toBe(3);
  });

  // ── Ticket 3ff96116 RECURRENCE (2026-10-14, sighting 2): the reopened ticket fired on a window whose
  // dominant issue was 'ungrounded' (10/39 judge attempts) — landing on answers that made 1–7 VERIFIED live
  // web tool calls (chat_search_usage). The text-only judge cannot see the tool calls, so the rubric's
  // "does it show it looked them up" leg punished grounded answers: the stably-low answer of the window
  // (7427400d 19:55, scored [2,2,2] ungrounded) had made 3 search_engine calls; re-judged WITH the
  // grounding note the same answer scores median 4, and the window collapses to low=0 / mean ≈4.08 —
  // no ticket. Same blindness class #1390 fixed for attachments. ──
  it('3ff96116 recurrence — the judge gets a grounding note for the turn\'s verified web tool calls; no calls = no note (the pre-fix shape)', async () => {
    // a turn with 3 verified web-grounding calls → the note, verbatim
    mockUtilityChat.mockResolvedValueOnce('SCORE: 4\nISSUE: none');
    await defaultQualityJudge('where can I buy the choppers hat advent calendar', 'Stock checked at three stores: …', [], { webToolCalls: 3 });
    const content = String((mockUtilityChat.mock.calls[0] as any[])[0].slice(-1)[0].content);
    expect(content).toMatch(/^NOTE: the assistant made 3 live web search\/browse tool call\(s\) during this turn before answering/);
    expect(content).toMatch(/It did look the facts up — judge how well the answer uses that evidence rather than whether lookups happened\.\n/);
    expect(content).toMatch(/USER MESSAGE:\nwhere can I buy the choppers hat advent calendar/);
    // 0 calls → nothing (the answer was served from the model's own knowledge, and the judge may say so)
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('SCORE: 4\nISSUE: none');
    await defaultQualityJudge('q', 'an answer', [], { webToolCalls: 0 });
    expect(String((mockUtilityChat.mock.calls[0] as any[])[0].slice(-1)[0].content)).not.toMatch(/NOTE: the assistant made/);
    // the note composes with the attachment + side-row notes (all three lines, in order)
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('SCORE: 4\nISSUE: none');
    await defaultQualityJudge('q', 'an answer', [], { images: 1, webToolCalls: 2, sideRowText: 'later: the price dropped.' });
    const composed = String((mockUtilityChat.mock.calls[0] as any[])[0].slice(-1)[0].content);
    expect(composed).toMatch(/^NOTE: the user message arrived with 1 image attachment\(s\)/);
    expect(composed).toMatch(/\nNOTE: the assistant made 2 live web search\/browse tool call\(s\)/);
    expect(composed).toMatch(/\nNOTE: after this answer the SAME turn delivered a continuation note/);
  });

  it('3ff96116 recurrence — countWebGroundingCalls: only web tools, only tool_call parts; the twin of chat-agent\'s countWebToolCalls never drifts', () => {
    const parts = [
      { type: 'tool_call', name: 'search_engine', args: {} },
      { type: 'tool_call', name: 'create_document', args: {} },       // platform tool — not grounding
      { type: 'tool_call', name: 'scrape_as_markdown', args: {} },
      { type: 'text', name: 'search_engine' },                        // right name, wrong type
      { type: 'tool_call', name: 'web_pipe', args: {} },
      { type: 'tool_call', name: 'browser_task', args: {} },
      { type: 'tool_call', name: 'not_a_tool', args: {} },
    ];
    expect(countWebGroundingCalls(parts)).toBe(4);
    expect(countWebGroundingCalls([])).toBe(0);
    expect(countWebGroundingCalls(null)).toBe(0);
    expect(countWebGroundingCalls(undefined)).toBe(0);
    expect(countWebGroundingCalls('nope')).toBe(0);
    // the twin-set pin: the audit's grounding set must equal the SERVICE's set, or the note and the
    // chat_search_usage metric disagree about what counts as a looked-up turn. Read the service SOURCE
    // (the W4-3 idiom — importing it pulls config/env, which exits a key-less jest worker).
    const svcSrc = (jest.requireActual('fs') as typeof import('fs')).readFileSync(require.resolve('../chat-agent/chat-agent.service.ts'), 'utf8');
    const svcSet = (svcSrc.match(/WEB_GROUNDING_TOOLS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '').match(/'([a-z_]+)'/g)!.map((x) => x.replace(/'/g, ''));
    expect(svcSet.length).toBeGreaterThan(0);
    expect([...WEB_GROUNDING_TOOL_NAMES].sort()).toEqual([...svcSet].sort());
  });

  it('3ff96116 recurrence — a full pass feeds the judge the turn\'s web-grounding count from its own parts', async () => {
    // the answer row carries 3 web-grounding tool calls in its parts (the same source chat_search_usage counts)
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a1', chatId: 'c1', lane: 'standard', content: 'Stock checked at three stores.', parts: [
        { type: 'tool_call', name: 'search_engine', args: {} },
        { type: 'tool_call', name: 'search_engine', args: {} },
        { type: 'tool_call', name: 'browser_task', args: {} },
      ] })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ content: 'where can I buy the choppers hat advent calendar?' }]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // no side rows after the answer
    process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE = '20';
    const qualityJudge = jest.fn(async () => ({ score: 4, issue: 'none' as const }));
    await runLiveChatAuditOnce({ replayLane: async () => 'standard', judgeLane: async () => 'standard', qualityJudge, fileTicket: jest.fn(async () => null) });
    expect(qualityJudge).toHaveBeenCalledWith('where can I buy the choppers hat advent calendar?', 'Stock checked at three stores.', [], { webToolCalls: 3 });
    // no message text in the stored row (the standing privacy invariant)
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(JSON.stringify(meta)).not.toMatch(/choppers|Stock checked/);
  });

  // DETECTOR-RECALL REPLAY (ticket 3ff96116 recurrence, 2026-10-14): the grounding-note fix must NOT
  // relax the answer_quality detector — a sample of genuinely bad answers (low ≥ 3) still files the
  // regression, grounding context or not. This replays the detector's PRIOR true positives: BOTH real
  // sightings of this ticket (2026-10-09 n=16 low=4 mean 4, and 2026-10-14 n=13 low=4 mean 3.69).
  it('DETECTOR-RECALL REPLAY (3ff96116) — a genuinely bad sample still files answer_quality, with grounding context present', async () => {
    // sighting 2's shape: 13 planned turns, judged LOW even though several carry web-grounding calls
    const answers = Array.from({ length: 13 }, (_, i) => row({
      id: `a${i}`, chatId: `c${i}`, lane: 'standard',
      content: i < 4 ? 'A wrong or unsupported answer.' : 'A good answer.',
      parts: i % 2 === 0 ? [{ type: 'tool_call', name: 'search_engine', args: {} }] : [], // grounding on 7 of them
    }));
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(answers)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ content: 'a question' }]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE = '20';
    const qualityJudge = jest.fn(async (_m: string, answer: string, _e: string[], _ctx?: { webToolCalls?: number }) =>
      answer.startsWith('A wrong') ? { score: 2, issue: 'incorrect' as const } : { score: 5, issue: 'none' as const });
    const fileTicket = jest.fn(async () => 't-1');
    await runLiveChatAuditOnce({ now: new Date('2026-10-14T04:36:04Z'), replayLane: async () => 'standard', judgeLane: async () => 'standard', qualityJudge, fileTicket });
    // the gate: n ≥ 10 AND low ≥ 3 → the ticket files (n=13, low=4 — the sighting-2 shape)
    expect(fileTicket).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'answer_quality', type: 'bug_report', priority: 2, title: '[live-chat audit] answer quality below the bar' }),
      expect.anything(),
      ['c0', 'c1', 'c2', 'c3'], // the LOW chats are the filing's chat ids — judged on their merits, grounding or not
    );
    // and the grounding context was present on the judged calls (the fix feeds, never silences):
    // 7 of the 13 turns carry a web call, and median-of-K repeats each judged turn 3× → 21 fed ctxs
    const ctxs = qualityJudge.mock.calls.map((c: any[]) => c[3]);
    expect(ctxs.filter((c) => c && c.webToolCalls === 1).length).toBe(21);
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.summary.quality).toEqual({ n: 13, mean: 4.08, low: 4, issues: { incorrect: 4 } });
    expect(JSON.stringify(meta)).not.toMatch(/wrong or unsupported|a question/);
  });

  it('3ff96116 — a full pass feeds the judge the turn\'s attachments and side rows and collapses K calls to the median', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a1', chatId: 'c1', lane: 'standard', content: 'The receipt shows $12.40.' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    // the prior-turn read: the user row carries 1 image attachment; then the side-row read (judgeContextFor)
    mockPrisma.crossModelMessage.findMany
      .mockResolvedValueOnce([{ content: 'what does this receipt show?', metadata: { attachments: [{ filename: 'r.png', type: 'image/png' }] } }])
      .mockResolvedValueOnce([{ content: 'Root cause: FOO unset. Fix: set FOO=bar.', metadata: { kind: 'deliverable_handoff' } }]);
    // the "next user row after the answer" probe → null (cap at now)
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE = '20';
    const scores = [2, 5, 2]; // the measured noise shape — the median is 2
    const qualityJudge = jest.fn(async () => {
      const score = scores.shift() as number;
      return { score, issue: score <= 2 ? ('incorrect' as const) : ('none' as const) };
    });
    await runLiveChatAuditOnce({ replayLane: async () => 'standard', judgeLane: async () => 'standard', qualityJudge, fileTicket: jest.fn(async () => null) });
    expect(qualityJudge).toHaveBeenCalledTimes(3); // median-of-3, the default
    expect(qualityJudge).toHaveBeenLastCalledWith('what does this receipt show?', 'The receipt shows $12.40.', [], { images: 1, sideRowText: 'Root cause: FOO unset. Fix: set FOO=bar.' });
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.summary.quality).toEqual({ n: 1, mean: 2, low: 1, issues: { incorrect: 1 } });
    expect(JSON.stringify(meta)).not.toMatch(/receipt|FOO|capital of france/);
  });

  it('3ff96116 — LIVE_CHAT_AUDIT_QUALITY_REPEATS=1 restores the single-shot judge (the kill switch)', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a1', chatId: 'c1', lane: 'standard', content: 'Paris is the capital of France.' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ content: 'capital of france?' }]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE = '20';
    process.env.LIVE_CHAT_AUDIT_QUALITY_REPEATS = '1';
    const qualityJudge = jest.fn(async () => ({ score: 5, issue: 'none' as const }));
    await runLiveChatAuditOnce({ replayLane: async () => 'standard', judgeLane: async () => 'standard', qualityJudge, fileTicket: jest.fn(async () => null) });
    expect(qualityJudge).toHaveBeenCalledTimes(1);
    expect(qualityJudge).toHaveBeenCalledWith('capital of france?', 'Paris is the capital of France.', [], {});
  });
});

describe('owner briefing line', () => {
  beforeEach(() => { mockPrisma.user = { findUnique: jest.fn() }; });
  const { liveChatAuditBriefingLine } = jest.requireActual('./live-chat-audit') as typeof import('./live-chat-audit');

  it('admins get the newest row\'s line; a regular user gets nothing (the audit spans every user)', async () => {
    mockPrisma.loopMetric.findFirst.mockResolvedValue({ meta: { briefing: 'Live-chat audit (last 24 h): 40 human turns · no regressions' } });
    mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN' });
    expect(await liveChatAuditBriefingLine('u-admin')).toMatch(/^Live-chat audit/);
    mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'USER' });
    expect(await liveChatAuditBriefingLine('u-1')).toBeNull();
    expect(await liveChatAuditBriefingLine(null)).toBeNull();
  });

  it('no row in 36 h / a read failure → null', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.loopMetric.findFirst.mockResolvedValueOnce(null);
    expect(await liveChatAuditBriefingLine('u-admin')).toBeNull();
    mockPrisma.loopMetric.findFirst.mockRejectedValueOnce(new Error('db'));
    expect(await liveChatAuditBriefingLine('u-admin')).toBeNull();
  });
});

// ── audit 2026-10-08 W4-3 / W4-7 ────────────────────────────────────────────────────────────────
import { humanTtftFromRows, ttftBars, regressionBriefingTail, type TtftRow } from './live-chat-audit';

describe('W4-3 — bug-class regressions file with a type the feedback service accepts', () => {
  it('every regression type is one of FEEDBACK_TYPES (the 10-07 / 10-08 nights were rejected: Invalid type "bug")', () => {
    // Read FEEDBACK_TYPES from the leaf SOURCE (importing it pulls config/env, which exits a key-less jest worker).
    // Moved from feedback.service.ts to ticket-status.ts (the import-free leaf — 6665fff6 A8).
    const src = (jest.requireActual('fs') as typeof import('fs')).readFileSync(require.resolve('../feedback/ticket-status.ts'), 'utf8');
    const FEEDBACK_TYPES = (src.match(/export const FEEDBACK_TYPES = \[([\s\S]*?)\]/)?.[1] ?? '').match(/'([a-z_]+)'/g)!.map((x) => x.replace(/'/g, ''));
    expect(FEEDBACK_TYPES).toContain('bug_report');
    expect(FEEDBACK_TYPES).not.toContain('bug');
    const loud = baseSummary({
      duplicateAnswers: 2, verifierCorrections: 4, errors: 9, turns: 40, empty: 4, leaks: 2, refusals: 4, handbacks: 4, ranQuick: 12, quickTapped: 5,
      quality: { n: 12, mean: 2.5, low: 5, issues: { incorrect: 5 } },
      replay: { n: 20, agree: 10, judged: 20, judgeAgree: 10, quickActedJudgedDeeper: 3, researchUnderRouted: 4 },
      humanTtft: { n: 13, p50: 88_000, p90: 400_000, noChunk: 0, guests: 4, supervisor: 3, slowest: [] },
    });
    const regs = detectRegressions(loud, []);
    expect(regs.length).toBeGreaterThanOrEqual(10);
    for (const r of regs) expect(FEEDBACK_TYPES).toContain(r.type);
    // the 10-08 night's two signals file as bug_report
    expect(regs.find((r) => r.signal === 'duplicate_answers')?.type).toBe('bug_report');
    expect(regs.find((r) => r.signal === 'answer_quality')?.type).toBe('bug_report');
  });

  it('the briefing counts only FILED tickets — a failed filing is named, never called a ticket', () => {
    delete process.env.LIVE_CHAT_AUDIT_BRIEFING_FILED_ONLY_DISABLED;
    // the 10-08 04:19Z shape: two detected, none filed (both rejected)
    expect(regressionBriefingTail(['duplicate_answers', 'answer_quality'], { filed: [] }))
      .toBe(' · ⚠ 2 regression(s) detected: duplicate_answers, answer_quality — no ticket filed; filing FAILED: duplicate_answers, answer_quality');
    expect(regressionBriefingTail(['duplicate_answers', 'answer_quality'], { filed: ['duplicate_answers'] }))
      .toBe(' · ⚠ 2 regression(s) detected: duplicate_answers, answer_quality — 1 ticket(s) filed: duplicate_answers; filing FAILED: answer_quality');
    expect(regressionBriefingTail(['handbacks'], { filed: [], disabled: true })).toMatch(/tickets off/);
    expect(regressionBriefingTail([], { filed: [] })).toBe(' · no regressions');
  });

  it('LIVE_CHAT_AUDIT_BRIEFING_FILED_ONLY_DISABLED=1 restores the old wording', () => {
    process.env.LIVE_CHAT_AUDIT_BRIEFING_FILED_ONLY_DISABLED = '1';
    try {
      expect(regressionBriefingTail(['duplicate_answers'], { filed: [] })).toBe(' · ⚠ 1 regression ticket(s): duplicate_answers');
    } finally {
      delete process.env.LIVE_CHAT_AUDIT_BRIEFING_FILED_ONLY_DISABLED;
    }
  });

  it('a full pass whose filing fails says so in the stored briefing (replay of 10-08: 0 of 2 filed)', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a1', chatId: 'c1', lane: 'standard' })])
      .mockResolvedValueOnce([{ chatId: 'c9' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const fileTicket = jest.fn(async () => null); // the service rejected it
    await runLiveChatAuditOnce({ now: new Date('2026-10-08T04:19:00Z'), replayLane: async () => null, judgeLane: async () => null, fileTicket });
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.ticketsFiled).toEqual([]);
    expect(meta.briefing).toMatch(/regression\(s\) detected: duplicate_answers — no ticket filed; filing FAILED: duplicate_answers/);
    expect(meta.briefing).not.toMatch(/regression ticket/);
  });
});

describe('W4-7 — the absolute first-word gate over EVERY human turn', () => {
  afterEach(() => { for (const k of ['LIVE_CHAT_AUDIT_TTFT_GATE_DISABLED', 'LIVE_CHAT_AUDIT_TTFT_P50_MS', 'LIVE_CHAT_AUDIT_TTFT_P90_MS', 'LIVE_CHAT_AUDIT_TTFT_MIN_N']) delete process.env[k]; });
  // The 10-08 night shape (13 real turns, split by lane below the per-lane n ≥ 10 minimum, so the relative check
  // could not fire; a third of the turns over 2 min). Ids are synthetic; values are the audit's measured TTFTs.
  const NIGHT: TtftRow[] = [
    248_000, 246_000, 570_000, 88_000, 71_000, 59_000, 32_000, 112_000, 285_000, 16_000, 51_000, 140_000, 389_000,
  ].map((v, i) => ({ sessionId: i < 3 ? `c-owner-${i}` : i < 6 ? `anon-g${i}` : `c-${i}`, value: v, guest: i >= 3 && i < 6, supervisor: i >= 10 && i < 12 }));

  it('humanTtftFromRows: n / p50 / p90, guests + supervisor turns counted, no-answer rows apart, the slowest signed-in chats', () => {
    const h = humanTtftFromRows([...NIGHT, { sessionId: 'c-x', value: null, noChunk: true }]);
    expect(h).toMatchObject({ n: 13, p50: 112_000, p90: 389_000, noChunk: 1, guests: 3, supervisor: 2 });
    expect(h.slowest).toEqual(['c-owner-2', 'c-12', 'c-8', 'c-owner-0', 'c-owner-1']); // > the 240 s p90 bar, signed-in only, slowest first, ≤ 5
  });

  it('the night breaks the bar ⇒ ONE ttft_absolute bug_report ticket with the numbers (no per-lane minimum)', () => {
    const regs = detectRegressions(baseSummary({ turns: 13, ttft: { standard: { n: 6, p50: 88_000, p90: 248_000 } }, humanTtft: humanTtftFromRows(NIGHT) }), []);
    const r = regs.find((x) => x.signal === 'ttft_absolute');
    expect(r).toMatchObject({ type: 'bug_report', priority: 2, title: '[live-chat audit] first-word latency over the bar' });
    expect(r!.detail).toMatch(/ALL 13 human turns/);
    expect(r!.detail).toMatch(/p50 112 s \(bar 60 s\), p90 389 s \(bar 240 s\)/);
    expect(r!.detail).toMatch(/guests 3, supervisor-chat turns 2/);
  });

  it('the measured 2026-10-08 24 h state (66 turns, p50 86 s / p90 278 s) breaks the p50 bar', () => {
    const h = { n: 66, p50: 85_595, p90: 277_624, noChunk: 0, guests: 30, supervisor: 19, slowest: [] };
    expect(detectRegressions(baseSummary({ humanTtft: h }), []).map((x) => x.signal)).toContain('ttft_absolute');
  });

  it('below the bars, too few turns, or the kill switch ⇒ no ticket; the bars are env-overridable', () => {
    const quick: TtftRow[] = Array.from({ length: 8 }, (_, i) => ({ sessionId: `c${i}`, value: 30_000 + i * 1000 }));
    expect(detectRegressions(baseSummary({ humanTtft: humanTtftFromRows(quick) }), []).map((x) => x.signal)).not.toContain('ttft_absolute');
    expect(detectRegressions(baseSummary({ humanTtft: humanTtftFromRows(NIGHT.slice(0, 4)) }), []).map((x) => x.signal)).not.toContain('ttft_absolute');
    process.env.LIVE_CHAT_AUDIT_TTFT_P50_MS = '600000';
    process.env.LIVE_CHAT_AUDIT_TTFT_P90_MS = '900000';
    expect(ttftBars()).toMatchObject({ p50Ms: 600_000, p90Ms: 900_000, minN: 5 });
    expect(detectRegressions(baseSummary({ humanTtft: humanTtftFromRows(NIGHT) }), []).map((x) => x.signal)).not.toContain('ttft_absolute');
    delete process.env.LIVE_CHAT_AUDIT_TTFT_P50_MS;
    delete process.env.LIVE_CHAT_AUDIT_TTFT_P90_MS;
    process.env.LIVE_CHAT_AUDIT_TTFT_GATE_DISABLED = '1';
    expect(detectRegressions(baseSummary({ humanTtft: humanTtftFromRows(NIGHT) }), []).map((x) => x.signal)).not.toContain('ttft_absolute');
  });

  it('a full pass reads the ux_ttft rows (guests + supervisor chats), files the latency ticket and briefs the numbers', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([row({ id: 'a1', chatId: 'c1', lane: 'standard' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(NIGHT.map((r) => ({ sessionId: r.sessionId, value: r.value, guest: r.guest ? 'true' : null, no_chunk: null, supervisor: !!r.supervisor })));
    const fileTicket = jest.fn(async () => 't-9');
    await runLiveChatAuditOnce({ now: new Date('2026-10-08T04:19:00Z'), replayLane: async () => null, judgeLane: async () => null, fileTicket });
    const ttftSql = String((mockPrisma.$queryRaw as jest.Mock).mock.calls[4][0]);
    expect(ttftSql).toMatch(/"kind" = 'ux_ttft'/);
    expect(ttftSql).toMatch(/'synthetic'/);
    expect(ttftSql).not.toMatch(/isSupervisor" = false/); // supervisor chats are IN this population
    expect(fileTicket).toHaveBeenCalledWith(expect.objectContaining({ signal: 'ttft_absolute' }), expect.anything(), ['c-owner-2', 'c-12', 'c-8', 'c-owner-0', 'c-owner-1']);
    const meta = mockRecordLoopMetric.mock.calls[0][0].meta;
    expect(meta.summary.humanTtft).toMatchObject({ n: 13, guests: 3, supervisor: 2 });
    expect(meta.briefing).toMatch(/first word \(all 13 human turns\) p50 112 s \/ p90 389 s/);
    expect(meta.briefing).toMatch(/1 ticket\(s\) filed: ttft_absolute/);
  });
});
