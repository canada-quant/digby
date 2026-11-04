/**
 * Project Brief (owner 2026-09-22: "the project status updates but more in
 * depth human readable"). Pins: the model's prose is scrubbed of identifiers
 * and cannot invent an ask; every owner message gets a "You asked" row; a
 * junk/empty model answer falls back to a deterministic brief; acks and bare
 * status questions are not asks; the call opts into reasoning; the kill
 * switch removes the brief entirely.
 *
 * "You asked" grounding (owner 2026-09-24 — the canlegal-bench card said
 * "→ no record yet" for 12+ hours about messages the supervisor had answered
 * within 6 minutes and closed in its ledger): the ledger is read NEWEST first
 * before any cap; owner rows are never crowded out by machine wake prompts;
 * the supervisor's on-turn reply is loaded and yields 'answered'; the
 * deterministic verdict overrules a model 'unknown' that contradicts the
 * evidence; 'unknown' says "not tracked on the board yet"; the brief carries
 * an asks fingerprint that moves when a reply or a ledger close lands.
 *
 * Adversarial review 2026-09-24 (applied here): C6 a reply needs the chat
 * engine's finalize stamp — an unstamped harness notice is never the reply;
 * C7 the word-overlap directive tier is advisory and the ask filter is the
 * ledger's own classifier; C8 a read failure yields NO brief, never one built
 * from empty evidence; C9/C21 the candidate scan carries no content, content
 * and replies are each ONE query; C10/C11 empty and "no record" model notes;
 * C18 the sessions sentence agrees with the uncapped count.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
const mockRecordExtractionOutcome: jest.Mock = jest.fn();
jest.mock('../memory/memory-audit', () => ({
  recordExtractionOutcome: (...a: any[]) => mockRecordExtractionOutcome(...a),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: {} }));
jest.mock('../platform/owner-questions', () => ({ OWNER_WAIT_CLAIM_RE: /x^/, INLINE_OQ_ID_RE: /x^/, isCounterQuestionRow: () => false }));
jest.mock('../coding/harness-error-notes', () => ({ isHarnessErrorNote: (t: unknown) => /^Sorry — I couldn't get an answer/.test(String(t ?? '')) }));
const mockGetSupervisorState: jest.Mock = jest.fn();
// The ledger read is mocked; the ack/status classifier (review C7: the SAME one appendDirective uses) stays REAL.
jest.mock('../platform/supervisor-state.service', () => ({
  ...jest.requireActual('../platform/supervisor-state.service'),
  getSupervisorState: (...a: any[]) => mockGetSupervisorState(...a),
}));
const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  ownerQuestion: { findMany: jest.fn() },
  crossModelMessage: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  buildProjectBrief, fallbackBrief, isStatusCheckOrAck, renderBriefMarkdown,
  computeAsksFingerprint, newestFirst, findDirectiveForAsk, findDirectiveMatch, deterministicAskStatus, replyGist, sessionsSentence,
  BRIEF_ASKS_FETCH, BRIEF_REPLY_FETCH, BRIEF_OWNER_CONTENT_FETCH, ASK_UNTRACKED_NOTE, PROJECT_BRIEF_BUDGET_TOKENS,
} from './project-brief.service';
import { isAckOrStatusQuestion } from '../platform/supervisor-state.service';
import type { ProjectStatus } from './project-status.service';

const NOW = new Date('2026-09-22T17:00:00Z');
const STATUS: ProjectStatus = {
  projectName: 'canlegal-bench', headline: 'canlegal-bench: 1 of 8 goals active, 7 done; 4 lanes working',
  workingOn: ['Step 9 program — Citator re-scrape — F97: census 388/294/94'],
  doneSince: ['3 work sessions finished'], blocked: ['1 question is waiting for your answer'], next: ['Re-sync splash suite-mean copy'],
  goals: { active: 1, done: 7, blocked: 0 }, todos: { inProgress: 2, pending: 1, blocked: 1, doneSince: 0 }, lanesRunning: 4, ownerItems: 1,
};
const ASK1 = { id: 'm-ask1-0000000000', content: 'ok well 1% is not acceptable what are you doing to get the citator re-scrape moving', createdAt: new Date('2026-09-22T04:52:00Z'), metadata: { authorId: 'u1' } };
// A bare status question — the ledger's classifier skips it, so the brief does too.
const ASK2 = { id: 'm-ask2-0000000000', content: 'any update?', createdAt: new Date('2026-09-22T13:32:00Z'), metadata: null };
const ASK3 = { id: 'm-ask3-0000000000', content: "can't the computer use agent solve a complex captcha", createdAt: new Date('2026-09-22T12:33:00Z'), metadata: null };
const MACHINE = { id: 'm-mach-0000000000', content: '[MACHINE-TRIGGERED RUN — sweep]', createdAt: new Date('2026-09-22T14:00:00Z'), metadata: { origin: 'schedule' } };
/** What chat-agent's finalize stamps on an on-turn reply (review C6). */
const REPLY_META = { engine: 'agent', models: { digby: { model: 'kimi-k3' } }, mode: 'thinking' };

/** user rows and assistant rows the mocked chat hands back (any order — the mock sorts like the real queries). */
let userRows: any[];
let assistantRows: any[];

beforeEach(() => {
  jest.clearAllMocks();
  userRows = [ASK2, MACHINE, ASK3, ASK1];
  assistantRows = [];
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ name: 'canlegal-bench' });
  mockPrisma.projectGoal.findMany.mockResolvedValue([
    { title: 'phase-7-audit-remediation: quarantine → gold re-inclusion', status: 'active', progressNote: 'F97 census 388/294/94 PIDs=0 (msg 752e9bc8)', blockedReason: null, updatedAt: NOW },
    { title: 'Ship the public leaderboard', status: 'done', progressNote: null, blockedReason: null, updatedAt: NOW },
  ]);
  mockPrisma.projectTodo.findMany.mockResolvedValue([{ title: 'Citator re-scrape', status: 'in_progress', progressNote: 'harvest paused at a CAPTCHA', blockedReason: null, updatedAt: NOW }]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ question: 'Which unblock route do you want for the CAPTCHA?' }]);
  // The real queries (review C9/C21): (1) the candidate scan — user rows newest
  // first inside the window, id/createdAt/metadata ONLY; (2) the content load —
  // ONE findMany by id; (3) the reply scan — ONE findMany of assistant rows
  // after the oldest ask, inside the asks' own windows, oldest first.
  mockPrisma.crossModelMessage.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.role === 'user') {
      return [...userRows]
        .filter((r) => r.createdAt >= w.createdAt.gte)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, args.take)
        .map(({ id, createdAt, metadata }) => ({ id, createdAt, metadata }));
    }
    if (w.id?.in) {
      const ids = new Set<string>(w.id.in);
      return userRows.filter((r) => ids.has(r.id)).map(({ id, content }) => ({ id, content }));
    }
    if (w.role === 'assistant') {
      const ranges: Array<{ gt: Date; lte: Date }> = (w.OR ?? []).map((o: any) => o.createdAt);
      return [...assistantRows]
        .filter((r) => r.createdAt > w.createdAt.gt && ranges.some((rg) => r.createdAt > rg.gt && r.createdAt <= rg.lte))
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, args.take);
    }
    return [];
  });
  mockGetSupervisorState.mockResolvedValue({
    directives: [{ id: 'd1', text: '1% is not acceptable — accelerate the citator re-scrape', at: '2026-09-22T04:53:00Z', status: 'done', evidence: 'acceleration ruling executed; 371-case Mac harvest launched (msg 9ae9a485)' }],
    archived: [], dispatches: [], projects: [], notes: '', refutations: [],
  });
});

const promptOf = () => String(mockUtilityChat.mock.calls[0][0][0].content);
const messageQueries = () => mockPrisma.crossModelMessage.findMany.mock.calls.map((c: any[]) => c[0]);

describe('isStatusCheckOrAck (review C7: the ledger capture classifier, verbatim)', () => {
  it('drops acks and bare status questions, keeps real asks — with exactly the verdicts appendDirective\'s classifier gives', () => {
    expect(isStatusCheckOrAck('any update?')).toBe(true);
    expect(isStatusCheckOrAck('ok')).toBe(true);
    expect(isStatusCheckOrAck('how did it go?')).toBe(true);
    expect(isStatusCheckOrAck('thanks!')).toBe(true);
    expect(isStatusCheckOrAck("can't the computer use agent solve a complex captcha")).toBe(false);
    expect(isStatusCheckOrAck('1% is not acceptable what are you doing to get it moving')).toBe(false);
    // The ledger captures "where are you at?" as a directive (not in its ack
    // vocabulary) — so the brief lists it too: the two classifiers never disagree.
    expect(isStatusCheckOrAck('where are you at?')).toBe(false);
    for (const t of ['where are you at?', 'what are you doing now?', 'any update?', 'thanks!', 'status', 'ship it tonight', '', '👍', 'ok, but also re-run the failing suite before merging']) {
      expect(isStatusCheckOrAck(t)).toBe(isAckOrStatusQuestion(t));
    }
  });
});

describe('buildProjectBrief', () => {
  it('model path: prose is identifier-scrubbed, every owner message gets a row, an invented ask is dropped, the call opts into reasoning', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      mission: 'canlegal-bench publishes a Canadian legal benchmark; 7 of 8 goals are done (see msg 752e9bc8).',
      now: 'The citator re-scrape is paused at a CAPTCHA on lane 66c9fb5c; the headnote curation is nearly complete.',
      changed: ['Three work sessions finished', 'Headnote curation reached the last batches'],
      blocked: ['The CAPTCHA needs a human — one question is waiting for you'],
      next: 'Finish the re-scrape once the CAPTCHA is solved, then re-include the three case-law tasks.',
      asks: [
        { at: '2026-09-22T04:52:00.000Z', text: 'ok well 1% is not acceptable…', status: 'done', note: 'acceleration ruling executed; the Mac harvest was launched' },
        { at: '2026-09-22T12:33:00.000Z', text: "can't the computer use agent solve a complex captcha", status: 'in_progress', note: 'the agent tried once; DataDome caught it' },
        { at: '2026-09-21T00:00:00.000Z', text: 'invented request the owner never made', status: 'done', note: 'nope' },
      ],
    }));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief).not.toBeNull();
    expect(brief!.source).toBe('model');
    expect(brief!.mission).not.toContain('752e9bc8');
    expect(brief!.now).not.toContain('66c9fb5c');
    expect(brief!.mission).toContain('7 of 8 goals are done');
    expect(brief!.asks.map((a) => a.status)).toEqual(['in_progress', 'done']); // newest first; the invented row is gone
    expect(brief!.asks[1].text).toContain('1% is not acceptable');
    expect(brief!.asks.some((a) => a.text.includes('invented'))).toBe(false);
    expect(brief!.asks.some((a) => a.text === 'any update?')).toBe(false); // status check, not an ask
    expect(typeof brief!.asksFingerprint).toBe('string');
    expect(mockUtilityChat.mock.calls[0][1]).toEqual(expect.objectContaining({ thinking: true, maxTokens: PROJECT_BRIEF_BUDGET_TOKENS }));
    // Firing 45 (2026-09-29): the budget must stay GENEROUS — thinking calls
    // count reasoning against max_tokens, and the admin's 'utility' Edge
    // override leg passes max_tokens through literally (the 16384 thinking
    // floor guards only the built-in DeepSeek leg), so 2200 still cut the
    // JSON mid-mission (18.8% parse_error, 7 fallback cards in 4h). Pin the
    // FLOOR, not the literal — a future raise stays green, a cut below the
    // generous room fails here.
    expect(PROJECT_BRIEF_BUDGET_TOKENS).toBeGreaterThanOrEqual(8000);
    // Firing 13: the ROW carries the budget too (the audit's min_budget/max_budget
    // read NULL on project_brief rows — a fixed budget is still a budget to prove).
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'project_brief', outcome: 'changed', budgetTokens: PROJECT_BRIEF_BUDGET_TOKENS }));
  });

  it('stamps the provider leg + finish reason on every outcome row (firing 45: parse_error rows carried budgetTokens but no leg, so truncations were unattributable from the audit)', async () => {
    // A truncated answer on the Edge override leg: onMeta fires with the leg
    // + finish_reason=length. f160: the length-clip retries ONCE with thinking
    // OFF; when the retry ALSO fails to parse, the parse_error row attributes
    // the RETRY's leg/finishReason (it produced the failing raw) and the clip
    // itself is recorded on the brief_length_retry metric row.
    mockUtilityChat.mockImplementationOnce(async (_msgs: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'override', model: 'cql-litellm:qwen3.8-flash', finishReason: 'length' });
      return '{ "mission": "The project aims to bring up and serve the model on the cluster while simultaneously landing a bounty, with serving prove';
    }).mockImplementationOnce(async (_msgs: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: 'stop' });
      return 'Sorry, still no JSON.';
    });
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('fallback');
    expect(mockUtilityChat).toHaveBeenCalledTimes(2);
    expect(mockUtilityChat.mock.calls[1][1]).toEqual(expect.objectContaining({ thinking: false }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'brief_length_retry', meta: expect.objectContaining({ clippedLeg: 'override', retryLeg: 'deepseek', retryOutcome: 'parse_error' }) }));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'project_brief', outcome: 'parse_error', leg: 'deepseek', finishReason: 'stop',
    }));
    // And the changed path stamps them too (a clean call reports its leg).
    mockUtilityChat.mockImplementationOnce(async (_msgs: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: 'stop' });
      return JSON.stringify({ mission: 'canlegal-bench is working toward the leaderboard', now: 'right now scraping', changed: [], blocked: [], next: 'the re-scrape', asks: [] });
    });
    const brief2 = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief2!.source).toBe('model');
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'project_brief', outcome: 'changed', leg: 'deepseek', finishReason: 'stop',
    }));
  });

  it('f160: a length-clipped thinking call retries ONCE with thinking OFF and recovers the model brief (2026-10-18 audit: 9 clip rows in 7d, every one leg=deepseek finishReason=length — even at the 16384 thinking floor)', async () => {
    mockUtilityChat.mockImplementationOnce(async (_msgs: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: 'length' });
      return '{ "mission": "Crossmodel builds and hardens the Digby agent framework; of 21 goals, 3 are act';
    }).mockImplementationOnce(async (_msgs: any[], opts: any) => {
      opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: 'stop' });
      return JSON.stringify({ mission: 'Crossmodel builds and hardens the Digby agent framework', now: 'right now landing batch trains', changed: [], blocked: [], next: 'the next wave', asks: [] });
    });
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('model');
    expect(mockUtilityChat).toHaveBeenCalledTimes(2);
    expect(mockUtilityChat.mock.calls[0][1]).toEqual(expect.objectContaining({ thinking: true }));
    expect(mockUtilityChat.mock.calls[1][1]).toEqual(expect.objectContaining({ thinking: false, maxTokens: PROJECT_BRIEF_BUDGET_TOKENS }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'brief_length_retry', meta: expect.objectContaining({ clippedLeg: 'deepseek', retryLeg: 'deepseek', retryOutcome: 'changed' }) }));
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({
      source: 'project_brief', outcome: 'changed', leg: 'deepseek', finishReason: 'stop',
    }));
    // A junk answer that was NOT length-clipped must never re-pay the call.
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('Sorry, I cannot help with that.');
    const brief2 = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief2!.source).toBe('fallback');
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
  });

  it('a junk model answer records parse_error and falls back to a deterministic brief that still carries the asks with ledger-derived status', async () => {
    mockUtilityChat.mockResolvedValueOnce('Sorry, I cannot help with that.');
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('fallback');
    expect(brief!.mission).toContain('canlegal-bench is working toward');
    // audit 2026-10-06 T8-3: the counts of record (STATUS.goals: 1 active, 7 done), never the 2-row goal list.
    expect(brief!.mission).toContain('7 of 8 goals are done');
    expect(brief!.now).toContain('Right now:');
    const ask1 = brief!.asks.find((a) => a.text.includes('1% is not acceptable'))!;
    expect(ask1.status).toBe('done'); // matched the ledger directive (stamped a minute AFTER the message, by wording)
    expect(ask1.note).not.toContain('9ae9a485');
    const ask3 = brief!.asks.find((a) => a.text.includes('captcha'))!;
    expect(ask3.status).toBe('unknown');
    expect(ask3.note).toBe(ASK_UNTRACKED_NOTE); // never "no record yet"
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'project_brief', outcome: 'parse_error', budgetTokens: PROJECT_BRIEF_BUDGET_TOKENS }));
  });

  it('a failing model call records llm_error and still returns the fallback', async () => {
    mockUtilityChat.mockRejectedValueOnce(new Error('HTTP 503'));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('fallback');
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'project_brief', outcome: 'llm_error' }));
  });

  // Review C8 (2026-09-24): a ledger or message read that fails must not
  // produce a confident brief built from empty evidence ("→ not tracked" for
  // every ask, a mission with no directives) — there is no brief, and the
  // card keeps its previous one.
  it('review C8: an unreadable ledger or message table yields NO brief — no fallback, no model call', async () => {
    mockGetSupervisorState.mockRejectedValueOnce(new Error('supervisor_states down'));
    expect(await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' })).toBeNull();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockRecordExtractionOutcome).not.toHaveBeenCalled();

    mockPrisma.crossModelMessage.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' })).toBeNull();
    expect(mockUtilityChat).not.toHaveBeenCalled();

    // The reply lookup is a read too — its failure is a failure, not "unanswered".
    mockPrisma.crossModelMessage.findMany.mockImplementationOnce(async () => userRows.map(({ id, createdAt, metadata }) => ({ id, createdAt, metadata })));
    mockPrisma.crossModelMessage.findMany.mockImplementationOnce(async () => userRows.map(({ id, content }) => ({ id, content })));
    mockPrisma.crossModelMessage.findMany.mockRejectedValueOnce(new Error('reply scan down'));
    expect(await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' })).toBeNull();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('review C21: a preloaded ask context (from the fingerprint read) is used as-is — the ledger and the owner rows are not read again', async () => {
    const fp = await computeAsksFingerprint('sup1', NOW);
    expect(fp).not.toBeNull();
    mockGetSupervisorState.mockClear();
    mockPrisma.crossModelMessage.findMany.mockClear();
    mockUtilityChat.mockResolvedValueOnce('junk');
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1', askContext: fp!.context });
    expect(brief!.asksFingerprint).toBe(fp!.fingerprint);
    expect(brief!.asks.map((a) => a.text)).toEqual([ASK3.content, ASK1.content]);
    expect(mockGetSupervisorState).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  // Ticket a8d6e514: a lane's note may now be a 2,000-char continuation ledger — the brief prompt carries the
  // bounded display form (≤200, word boundary + "…"), never the ledger; a short note is unchanged.
  it('a8d6e514: a 2,000-char goal/todo progress note reaches the brief prompt clamped to ≤200 chars', async () => {
    const ledger = `F97 census 388/294/94 PIDs=0. ${'NEXT: carry ticket 9cc62eef, re-check its closure, sweep siblings; '.repeat(40)}TAIL-MARKER`.slice(0, 2000);
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ title: 'Standing shortfall hunt', status: 'active', progressNote: ledger, blockedReason: null, updatedAt: NOW }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([{ title: 'Citator re-scrape', status: 'in_progress', progressNote: 'harvest paused at a CAPTCHA', blockedReason: null, updatedAt: NOW }]);
    mockUtilityChat.mockResolvedValueOnce('junk');
    await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    const prompt = promptOf();
    const goalLine = prompt.split('\n').find((l) => l.includes('Standing shortfall hunt'))!;
    const note = goalLine.slice(goalLine.indexOf('progress note: ') + 'progress note: '.length);
    expect(note.length).toBeLessThanOrEqual(200);
    expect(note.endsWith('…')).toBe(true);
    expect(ledger.startsWith(note.slice(0, -1))).toBe(true);
    expect(prompt).not.toContain('TAIL-MARKER');
    expect(prompt).toContain('— progress note: harvest paused at a CAPTCHA'); // short note byte-identical
  });
});

// ── "You asked" grounding (owner 2026-09-24) ─────────────────────────────────

describe('"You asked" grounding (owner 2026-09-24: "no record yet" for 12+ hours about answered, ledger-closed asks)', () => {
  it('the directive ledger is read NEWEST first before any cap: with 50 oldest-first rows the newest (the owner\'s latest ask, done) reaches the prompt and the fallback; the oldest is cut', async () => {
    // Stored oldest-first, as supervisor_states keeps them. Row 49 is the capture of ASK1 (stamped 2 s after the message, same text).
    const directives = Array.from({ length: 50 }, (_, i) => ({
      id: `d${i}`, text: `old directive number ${i} about something else entirely`, at: new Date(Date.UTC(2026, 8, 1 + Math.floor(i / 4), i % 24)).toISOString(), status: 'open' as const,
    }));
    directives[49] = { id: 'd49', text: ASK1.content, at: '2026-09-22T04:52:02Z', status: 'done' as const, ...({ evidence: 'PR #172 closed; release-readiness answer landed (msg 47085e20)' } as any) };
    mockGetSupervisorState.mockResolvedValue({ directives, archived: [], dispatches: [], projects: [], notes: '', refutations: [] });
    mockUtilityChat.mockResolvedValueOnce('junk');
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    const prompt = promptOf();
    const ledgerBlock = prompt.slice(prompt.indexOf('OWNER DIRECTIVE LEDGER'), prompt.indexOf("OWNER'S RECENT MESSAGES"));
    expect(ledgerBlock).toContain('[done] ok well 1% is not acceptable');
    expect(ledgerBlock).not.toContain('old directive number 0 '); // the oldest 20 are cut, not the newest
    expect(ledgerBlock.indexOf('2026-09-22T04:52:02Z')).toBeLessThan(ledgerBlock.indexOf('old directive number 48'));
    // The ask block carries its own ledger row beside the message.
    expect(prompt).toMatch(/"ok well 1% is not acceptable[^\n]*\n\s+LEDGER: done — evidence: PR #172 closed/);
    const ask1 = brief!.asks.find((a) => a.text.includes('1% is not acceptable'))!;
    expect(ask1.status).toBe('done');
    expect(ask1.note).toContain('release-readiness answer landed');
    expect(ask1.note).not.toContain('47085e20');
  });

  it('review C9: owner rows are never crowded out by machine wake prompts — 450 newer hook/schedule user rows (> a week of 62/day) and an owner ask from day 6.9 still surfaces; the scan is BRIEF_ASKS_FETCH rows WITHOUT content, then ONE content read by id', async () => {
    const wakes = Array.from({ length: 450 }, (_, i) => ({
      id: `m-wake-${i}`, content: `[MACHINE-TRIGGERED RUN — hook ${i}]`, createdAt: new Date(NOW.getTime() - (i + 1) * 60_000), metadata: { origin: i % 2 ? 'hook' : 'schedule' },
    }));
    const OLD_ASK = { id: 'm-old-00000000000', content: 'please rebuild the citator index before the weekend', createdAt: new Date(NOW.getTime() - 6.9 * 24 * 60 * 60_000), metadata: null };
    const EXPIRED = { id: 'm-exp-00000000000', content: 'this one is older than the window', createdAt: new Date(NOW.getTime() - 7.1 * 24 * 60 * 60_000), metadata: null };
    userRows = [...wakes, ASK2, ASK3, ASK1, OLD_ASK, EXPIRED];
    mockUtilityChat.mockResolvedValueOnce('junk');
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    const userQuery = messageQueries().find((q: any) => q?.where?.role === 'user');
    expect(userQuery.take).toBe(BRIEF_ASKS_FETCH);
    expect(BRIEF_ASKS_FETCH).toBe(800); // 62/day × 7 = 434 < 800
    expect(userQuery.select).toEqual({ id: true, createdAt: true, metadata: true }); // no content on the wide scan
    expect(userQuery.where.createdAt.gte).toEqual(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000));
    const contentQueries = messageQueries().filter((q: any) => q?.where?.id?.in);
    expect(contentQueries).toHaveLength(1);
    expect(contentQueries[0].select).toEqual({ id: true, content: true });
    expect([...contentQueries[0].where.id.in].sort()).toEqual([ASK1.id, ASK2.id, ASK3.id, OLD_ASK.id].sort());
    expect(contentQueries[0].where.id.in.length).toBeLessThanOrEqual(BRIEF_OWNER_CONTENT_FETCH);
    expect(brief!.asks.map((a) => a.text)).toEqual([ASK3.content, ASK1.content, OLD_ASK.content]);
    expect(promptOf()).not.toContain('MACHINE-TRIGGERED');
  });

  it("the supervisor's on-turn reply yields 'answered' — machine notes, briefings, provider envelopes AND unstamped harness notices in between are skipped (review C6); ONE reply query serves every ask (review C21)", async () => {
    assistantRows = [
      { id: 'a-hook-000000000', content: 'WAKE: no-op — nothing moved', createdAt: new Date('2026-09-22T12:34:00Z'), metadata: { origin: 'hook', engine: 'agent' } },
      { id: 'a-brief-00000000', content: 'Owner briefing: all quiet.', createdAt: new Date('2026-09-22T12:35:00Z'), metadata: { kind: 'owner_briefing', engine: 'agent' } },
      { id: 'a-429-0000000000', content: "Sorry — I couldn't get an answer out this time: the AI provider rate-limited the request (HTTP 429).", createdAt: new Date('2026-09-22T12:36:00Z'), metadata: { ...REPLY_META, providerError: { status: 429 } } },
      // Review C6: harness notices are plain assistant rows with NO metadata —
      // schedule parked/stopped/capped, hook-delivery failures. Never the reply.
      { id: 'a-park-000000000', content: '⏸️ **Schedule 8f1c auto-parked** — the project is dormant. It will NOT fire while the project stays dormant.', createdAt: new Date('2026-09-22T12:37:00Z'), metadata: null },
      { id: 'a-stop-000000000', content: 'Schedule stopped: the terminal cap of 200 firings was reached.', createdAt: new Date('2026-09-22T12:38:00Z'), metadata: {} },
      { id: '47085e20-reply-0', content: '**Short answer: no.** DataDome CAPTCHAs are image-classification puzzles rotated per session; the computer-use agent tried once and was caught. The Mac residential route is the way through.', createdAt: new Date('2026-09-22T12:39:00Z'), metadata: REPLY_META },
    ];
    mockUtilityChat.mockResolvedValueOnce('junk');
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    const ask3 = brief!.asks.find((a) => a.text.includes('captcha'))!;
    expect(ask3.status).toBe('answered');
    expect(ask3.note).toMatch(/^Short answer: no\. DataDome CAPTCHAs/);
    expect(ask3.note!.split(' ').length).toBeLessThanOrEqual(21); // ≤ 20 words (+ ellipsis token)
    expect(ask3.note).not.toMatch(/auto-parked|Schedule stopped/);
    expect(promptOf()).toMatch(/"can't the computer use agent[^\n]*\n\s+LEDGER: \(no directive recorded[^\n]*\n\s+SUPERVISOR'S REPLY \(msg 47085e20\): "\*\*Short answer: no\.\*\*/);
    // ONE reply query: assistant rows after the OLDEST ask, inside each ask's 6-hour window, oldest first, bounded.
    const replyQueries = messageQueries().filter((q: any) => q?.where?.role === 'assistant');
    expect(replyQueries).toHaveLength(1);
    const rq = replyQueries[0];
    expect(rq.where.chatId).toBe('sup1');
    expect(rq.orderBy).toEqual({ createdAt: 'asc' });
    expect(rq.take).toBe(BRIEF_REPLY_FETCH);
    expect(BRIEF_REPLY_FETCH).toBe(300);
    expect(rq.where.createdAt.gt).toEqual(ASK1.createdAt);
    expect(rq.where.OR).toHaveLength(2);
    for (const range of rq.where.OR) expect(range.createdAt.lte.getTime() - range.createdAt.gt.getTime()).toBe(6 * 60 * 60 * 1000);
    expect(rq.where.OR.map((o: any) => o.createdAt.gt.toISOString()).sort()).toEqual([ASK1.createdAt.toISOString(), ASK3.createdAt.toISOString()]);
  });

  it('review C6: with ONLY an unstamped harness notice after the ask, the ask reads as unanswered; a `models` object counts as the stamp too', async () => {
    assistantRows = [{ id: 'a-cap-0000000000', content: 'Schedule stopped — cap reached; nothing more will fire.', createdAt: new Date('2026-09-22T12:40:00Z'), metadata: null }];
    let fp = await computeAsksFingerprint('sup1', NOW);
    expect(fp!.context.asks.find((a) => a.text.includes('captcha'))!.reply).toBeNull();
    assistantRows = [{ id: 'a-models-0000000', content: 'Yes — the residential route is queued.', createdAt: new Date('2026-09-22T12:41:00Z'), metadata: { models: { digby: {} } } }];
    fp = await computeAsksFingerprint('sup1', NOW);
    expect(fp!.context.asks.find((a) => a.text.includes('captcha'))!.reply).toMatchObject({ id: 'a-models-0000000' });
  });

  it("a model 'unknown' / \"no record yet\" is overruled by the evidence: ledger done → done, a reply → answered; a real unknown says 'not tracked on the board yet'", async () => {
    assistantRows = [{ id: 'reply-3-00000000', content: 'Yes — but only with the residential proxy; I have queued that route.', createdAt: new Date('2026-09-22T12:40:00Z'), metadata: REPLY_META }];
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      mission: 'canlegal-bench publishes a Canadian legal benchmark.', now: 'The citator re-scrape is paused at a CAPTCHA.', changed: [], blocked: [], next: 'Finish the re-scrape.',
      asks: [
        { at: '2026-09-22T12:33:00.000Z', text: "can't the computer use agent solve a complex captcha", status: 'unknown', note: 'No ledger entry or goal/todo update in the inputs says what became of this.' },
        { at: '2026-09-22T04:52:00.000Z', text: 'ok well 1% is not acceptable…', status: 'unknown', note: 'no record yet' },
      ],
    }));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('model');
    expect(brief!.asks.map((a) => a.status)).toEqual(['answered', 'done']);
    expect(brief!.asks[0].note).toMatch(/^Yes — but only with the residential proxy/);
    expect(brief!.asks[1].note).toContain('acceleration ruling executed');
    for (const a of brief!.asks) expect(a.note).not.toMatch(/no record/i);
    // Prompt rules name the statuses and forbid the old wording.
    expect(promptOf()).toContain('"done|in_progress|answered|open|unknown"');
    expect(promptOf()).toContain(`"${ASK_UNTRACKED_NOTE}" (never "no record yet")`);
    expect(promptOf()).toContain('Work sessions running: 4 · scheduled (idle until their next wake): 0');
  });

  // Review C10 + C11 (2026-09-24): an EMPTY model note takes the evidence-backed
  // one when the verdicts agree (or whenever the evidence has a verdict); a
  // "no record" note is rewritten at EVERY status — the deterministic note when
  // the verdicts agree, dropped when they do not.
  it('review C10/C11: empty and "no record" model notes at every status', async () => {
    const ASK4 = { id: 'm-ask4-0000000000', content: 'rebuild the index tonight', createdAt: new Date('2026-09-22T16:00:00Z'), metadata: null };
    const ASK5 = { id: 'm-ask5-0000000000', content: 'ship the leaderboard tonight', createdAt: new Date('2026-09-22T16:30:00Z'), metadata: null };
    const ASK6 = { id: 'm-ask6-0000000000', content: 'is the serving cluster up yet?', createdAt: new Date('2026-09-22T15:00:00Z'), metadata: null };
    userRows = [ASK6, ASK5, ASK4, ASK3, ASK1];
    assistantRows = [
      { id: 'reply-3-00000000', content: 'Yes — but only with the residential proxy; I have queued that route.', createdAt: new Date('2026-09-22T12:40:00Z'), metadata: REPLY_META },
      { id: 'reply-6-00000000', content: 'Yes — 16 of 16 GPUs are serving.', createdAt: new Date('2026-09-22T15:05:00Z'), metadata: REPLY_META },
    ];
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      mission: 'canlegal-bench publishes a Canadian legal benchmark.', now: 'The citator re-scrape is paused at a CAPTCHA.', changed: [], blocked: [], next: 'Finish the re-scrape.',
      asks: [
        { at: ASK6.createdAt.toISOString(), text: ASK6.content, status: 'in_progress', note: '' },                       // C10: empty, verdicts differ, evidence has one → the reply gist
        { at: ASK5.createdAt.toISOString(), text: ASK5.content, status: 'in_progress', note: '' },                       // C10: empty, no evidence at all → no note
        { at: ASK4.createdAt.toISOString(), text: ASK4.content, status: 'open', note: 'No record yet' },                  // C11: "no record", verdicts differ → dropped
        { at: ASK3.createdAt.toISOString(), text: ASK3.content, status: 'answered', note: '   ' },                        // C10: scrubs to empty, verdicts agree → the reply gist
        { at: ASK1.createdAt.toISOString(), text: ASK1.content, status: 'done', note: 'no record of this in the ledger' }, // C11: "no record", verdicts agree → the evidence
      ],
    }));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('model');
    const by = (t: string) => brief!.asks.find((a) => a.text === t)!;
    expect(by(ASK6.content)).toEqual({ at: ASK6.createdAt.toISOString(), text: ASK6.content, status: 'in_progress', note: 'Yes — 16 of 16 GPUs are serving.' });
    expect(by(ASK5.content)).toEqual({ at: ASK5.createdAt.toISOString(), text: ASK5.content, status: 'in_progress' });
    expect(by(ASK4.content)).toEqual({ at: ASK4.createdAt.toISOString(), text: ASK4.content, status: 'open' });
    expect(by(ASK3.content)).toMatchObject({ status: 'answered', note: 'Yes — but only with the residential proxy; I have queued that route.' });
    expect(by(ASK1.content)).toMatchObject({ status: 'done', note: 'acceleration ruling executed; 371-case Mac harvest launched' });
    for (const a of brief!.asks) expect(a.note ?? '').not.toMatch(/no record/i);
  });

  it('asks fingerprint: stable for the same asks/ledger/replies, moves when a reply lands or the ledger closes, rides on the brief with its context; null when unprovable (review C8)', async () => {
    const r1 = await computeAsksFingerprint('sup1', NOW);
    expect(r1!.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(r1!.context.asks.map((a) => a.text)).toEqual([ASK3.content, ASK1.content]);
    expect(r1!.context.directives).toHaveLength(1);
    expect((await computeAsksFingerprint('sup1', NOW))!.fingerprint).toBe(r1!.fingerprint);
    mockUtilityChat.mockResolvedValueOnce('junk');
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.asksFingerprint).toBe(r1!.fingerprint);
    assistantRows = [{ id: 'reply-3-00000000', content: 'Answered in chat.', createdAt: new Date('2026-09-22T12:40:00Z'), metadata: REPLY_META }];
    const r2 = await computeAsksFingerprint('sup1', NOW);
    expect(r2!.fingerprint).not.toBe(r1!.fingerprint);
    mockGetSupervisorState.mockResolvedValue({ directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [] });
    expect((await computeAsksFingerprint('sup1', NOW))!.fingerprint).not.toBe(r2!.fingerprint);
    expect(await computeAsksFingerprint(null, NOW)).toBeNull();
    mockPrisma.crossModelMessage.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await computeAsksFingerprint('sup1', NOW)).toBeNull(); // unprovable ⇒ the card treats the asks as changed
    mockGetSupervisorState.mockRejectedValueOnce(new Error('supervisor_states down'));
    expect(await computeAsksFingerprint('sup1', NOW)).toBeNull(); // review C8: a ledger read failure is not "no directives"
  });

  it('pure helpers: newestFirst, findDirectiveMatch tiers (exact text, ≤5 s proximity, word overlap — tiers 2-3 never reach back before the message), deterministicAskStatus, replyGist', () => {
    const rows = [{ at: '2026-09-01T00:00:00Z', n: 1 }, { at: '', n: 0 }, { at: '2026-09-03T00:00:00Z', n: 3 }, { at: '2026-09-02T00:00:00Z', n: 2 }];
    expect(newestFirst(rows).map((r) => r.n)).toEqual([3, 2, 1, 0]);
    const ask = { at: new Date('2026-09-22T04:52:00Z'), text: 'please ship the release-readiness answer today' };
    const exact = { at: '2026-09-20T00:00:00Z', text: 'Please ship the release-readiness   answer today', status: 'done' };
    const near = { at: '2026-09-22T04:52:04Z', text: 'ship it', status: 'open' };
    const far = { at: '2026-09-22T04:52:06Z', text: 'unrelated', status: 'open' };
    const overlap = { at: '2026-09-22T05:10:00Z', text: 'the release-readiness answer must ship', status: 'open' };
    // Review C7: the same wording recorded BEFORE the message cannot be its capture.
    const stale = { at: '2026-09-10T00:00:00Z', text: 'the release-readiness answer must ship', status: 'done' };
    const justBefore = { at: '2026-09-22T04:51:57Z', text: 'ship the release-readiness answer', status: 'open' }; // 3 s early — capture jitter, still eligible
    expect(findDirectiveForAsk(ask, [near, exact])).toBe(exact);
    expect(findDirectiveMatch(ask, [near, exact])).toEqual({ directive: exact, tier: 'exact' });
    expect(findDirectiveForAsk(ask, [far, near])).toBe(near);
    expect(findDirectiveMatch(ask, [far, near])!.tier).toBe('near');
    expect(findDirectiveForAsk(ask, [far, overlap])).toBe(overlap);
    expect(findDirectiveMatch(ask, [far, overlap])!.tier).toBe('overlap');
    expect(findDirectiveForAsk(ask, [far, stale])).toBeNull();
    expect(findDirectiveMatch(ask, [justBefore])).toEqual({ directive: justBefore, tier: 'near' });
    expect(findDirectiveForAsk(ask, [far])).toBeNull();
    const reply = { id: 'r', at: new Date(), text: 'On it — the answer goes out at noon.' };
    expect(deterministicAskStatus({ directive: { ...exact, evidence: 'PR #172 closed (msg 47085e20)' }, directiveTier: 'exact' })).toEqual({ status: 'done', note: 'PR #172 closed' });
    expect(deterministicAskStatus({ directive: near, directiveTier: 'near', reply })).toEqual({ status: 'answered', note: 'On it — the answer goes out at noon.' });
    expect(deterministicAskStatus({ directive: near, directiveTier: 'near' })).toEqual({ status: 'open', note: "recorded in the supervisor's ledger, still open" });
    expect(deterministicAskStatus({})).toEqual({ status: 'unknown', note: ASK_UNTRACKED_NOTE });
    // Review C7: an overlap-tier 'done' is advisory — with a reply in hand the ask is 'answered', not 'done'; without one it still closes.
    const overlapDone = { ...overlap, status: 'done', evidence: 'shipped in PR #180' };
    expect(deterministicAskStatus({ directive: overlapDone, directiveTier: 'overlap', reply })).toEqual({ status: 'answered', note: 'On it — the answer goes out at noon.' });
    expect(deterministicAskStatus({ directive: overlapDone, directiveTier: 'overlap' })).toEqual({ status: 'done', note: 'shipped in PR #180' });
    expect(deterministicAskStatus({ directive: { ...exact, evidence: 'shipped in PR #180' }, directiveTier: 'exact', reply })).toEqual({ status: 'done', note: 'shipped in PR #180' });
    // Audit 96fb2f25 (raspi e571edf5): the harness stamp 'answered' renders
    // 'answered' — the reply gist when present, the evidence stamp otherwise —
    // never 'done'. A ledger 'done' (typed evidence) still renders 'done'.
    const answeredStamp = { ...exact, status: 'answered' as const, evidence: 'msg 879175d0' };
    expect(deterministicAskStatus({ directive: answeredStamp, directiveTier: 'exact', reply })).toEqual({ status: 'answered', note: 'On it — the answer goes out at noon.' });
    expect(deterministicAskStatus({ directive: answeredStamp, directiveTier: 'exact' })).toEqual({ status: 'answered', note: 'a supervisor reply landed — no verified outcome yet' });
    expect(replyGist('## Heads-up\n| a | b |\n|---|---|\nthe **quick** brown fox jumps over the lazy dog again and again and again and again and again and again and again')).toBe('Heads-up a b the quick brown fox jumps over the lazy dog again and again and again and again and…');
  });
});

describe('fallbackBrief + renderBriefMarkdown', () => {
  it('renders the plain-words paragraph and the You asked ledger without identifiers', () => {
    const brief = fallbackBrief({
      projectName: 'inference', status: { ...STATUS, workingOn: ['Serve GLM-5.3 on 16×H100 — Consumer verdict FINAL: parse FAIL'] },
      goals: [{ title: 'Serve GLM-5.3 on 16×H100 for CanLaw v3 dataset generation', status: 'active', note: null, blocked: null, updatedAt: NOW }],
      asks: [{ at: new Date('2026-09-22T13:31:00Z'), text: 'you still havent served glm5.3? what the hell have you done all night' }],
      directives: [], now: NOW,
    });
    const md = renderBriefMarkdown(brief, () => 'Sep 22, 6:31 AM');
    expect(md).toContain('**In plain words**');
    expect(md).toContain('inference is working toward: Serve GLM-5.3 on 16×H100 for CanLaw v3 dataset generation.');
    expect(md).toContain('**You asked**');
    expect(md).toContain('Sep 22, 6:31 AM — "you still havent served glm5.3?');
    expect(md).toContain(`→ unknown: ${ASK_UNTRACKED_NOTE}`);
    expect(md).not.toContain('no record');
  });

  it("an answered ask renders as '→ answered: <gist>'", () => {
    const brief = fallbackBrief({
      projectName: 'inference', status: STATUS, goals: [], directives: [], now: NOW,
      asks: [{ at: new Date('2026-09-22T13:31:00Z'), text: 'is the serving cluster up yet?', reply: { id: 'r1', at: new Date('2026-09-22T13:35:00Z'), text: 'Yes — 16 of 16 GPUs are serving since 13:20Z (run 9f8e7d6c5b4a3210).' } }],
    });
    // "13:20Z" and "(run 9f8e…)" are scrubbed by the card's identifier stripper; the sentence's own period survives.
    expect(brief.asks[0]).toEqual({ at: '2026-09-22T13:31:00.000Z', text: 'is the serving cluster up yet?', status: 'answered', note: 'Yes — 16 of 16 GPUs are serving since.' });
    expect(brief.asks[0].note).not.toMatch(/9f8e7d6c|13:20Z/);
    expect(renderBriefMarkdown(brief)).toContain('→ answered: Yes — 16 of 16 GPUs are serving since.');
  });

  it("the 'now' sentence reads from the measured counters: running lanes by title; scheduled-only says nothing is running; a Running: entry is not echoed twice", () => {
    const timing = { lanes: [{ chatId: 'l1', title: 'Citator re-scrape', state: 'running' as const, runningForMin: 42 }, { chatId: 'l2', title: 'Nightly eval', state: 'scheduled' as const }], goals: [], closures: [], nextStatusAt: NOW.toISOString() };
    expect(sessionsSentence({ ...STATUS, lanesRunning: 1, lanesScheduled: 1, timing })).toBe('1 work session running: Citator re-scrape.');
    expect(sessionsSentence({ ...STATUS, lanesRunning: 0, lanesScheduled: 3 })).toBe('Nothing is running right now; 3 sessions are scheduled to wake later.');
    expect(sessionsSentence({ ...STATUS, lanesRunning: 0, lanesScheduled: 0 })).toBe('Nothing is running right now.');
    const running = fallbackBrief({ projectName: 'x', status: { ...STATUS, workingOn: ['Running: Citator re-scrape (42m)'], lanesRunning: 1, lanesScheduled: 1, timing }, goals: [], asks: [], directives: [], now: NOW });
    expect(running.now).toBe('1 work session running: Citator re-scrape.');
    const idle = fallbackBrief({ projectName: 'x', status: { ...STATUS, workingOn: [], lanesRunning: 0, lanesScheduled: 3 }, goals: [], asks: [], directives: [], now: NOW });
    expect(idle.now).toBe('Nothing is running right now; 3 sessions are scheduled to wake later.');
  });

  it('review C18: past the timing block\'s lane cap the sentence says "…and N more running" so the count and the list agree', () => {
    const lanes = Array.from({ length: 6 }, (_, i) => ({ chatId: `l${i}`, title: `Lane ${i + 1}`, state: 'running' as const, runningForMin: 10 + i }));
    const timing = { lanes, goals: [], closures: [], nextStatusAt: NOW.toISOString() };
    expect(sessionsSentence({ ...STATUS, lanesRunning: 8, lanesScheduled: 0, timing }))
      .toBe('8 work sessions running: Lane 1, Lane 2, Lane 3, Lane 4, Lane 5, Lane 6, …and 2 more running.');
    expect(sessionsSentence({ ...STATUS, lanesRunning: 6, lanesScheduled: 0, timing }))
      .toBe('6 work sessions running: Lane 1, Lane 2, Lane 3, Lane 4, Lane 5, Lane 6.');
    expect(sessionsSentence({ ...STATUS, lanesRunning: 3, lanesScheduled: 0 })).toBe('3 work sessions running.'); // no titles at all — no dangling list
  });
});


// ── KPI of record in the brief (tt-rd audit 2026-09-27, finding 4) ───────────
describe('project brief — KPI of record (kpi-honesty-loops finding 4)', () => {
  const KPI_PREMISE = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', kind: 'kpi', bar: 10, receiptId: 'f5b42fe6-1111-4000-8000-000000000000', setAt: '2026-09-22T15:00:00.000Z', prev: { value: 2.464, setAt: '2026-09-22T03:34:40.000Z' } };
  const withKpi = () => mockPrisma.projectGoal.findMany.mockResolvedValue([
    { title: 'Serve Qwen3.8 fast enough to use', status: 'active', progressNote: 'e2e 6.56 tok/s client-visible (of record)', blockedReason: null, updatedAt: NOW, premises: [KPI_PREMISE] },
  ]);

  it('the prompt names the MISSION KPI and a model "now" that types a different rate is replaced by the deterministic sentence', async () => {
    withKpi();
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      mission: 'tt-rd serves Qwen3.8 on the QuietBox.',
      now: 'The speed work is serving 6.56 tok/s client-visible now and closing in on the bar.',
      changed: [], blocked: [], next: 'Reach 7 tok/s soon.', asks: [],
    }));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(brief!.source).toBe('model');
    expect(mockUtilityChat.mock.calls[0][0][0].content).toContain('MISSION KPI (of record');
    expect(mockUtilityChat.mock.calls[0][0][0].content).toContain('KPI of record (client visible e2e tok s): 5.08 tok/s (measured receipt f5b42fe6, 2h ago), bar ≥10.');
    expect(brief!.now).not.toContain('6.56');
    expect(brief!.now).toContain('KPI of record (client visible e2e tok s): 5.08 tok/s');
    // fixer follow-up (finding 4): "next" is a target sentence, not a claim of the current value — it is kept verbatim
    // (it used to be erased for the first pending todo title).
    expect(brief!.next).toBe('Reach 7 tok/s soon.');
  });

  it('fixer follow-up (finding 4): a "now" that quotes the bar or the previous reading alongside the register value is CORRECT and kept verbatim', async () => {
    withKpi();
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      mission: 'm', now: 'Serving 5.08 tok/s against a bar of 10 tok/s; the previous reading was 2.464 tok/s.', changed: [], blocked: [], next: 'Reach the bar of 10 tok/s.', asks: [],
    }));
    const b = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(b!.source).toBe('model');
    expect(b!.now).toBe('Serving 5.08 tok/s against a bar of 10 tok/s; the previous reading was 2.464 tok/s.');
    expect(b!.next).toBe('Reach the bar of 10 tok/s.');
  });

  it('a "now" that omits the number gets the register sentence appended; one that quotes it is kept; the fallback brief carries it too', async () => {
    withKpi();
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ mission: 'm', now: 'The speed lane is mid-firing.', changed: [], blocked: [], next: 'n', asks: [] }));
    const b1 = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(b1!.now).toBe('The speed lane is mid-firing. KPI of record (client visible e2e tok s): 5.08 tok/s (measured receipt f5b42fe6, 2h ago), bar ≥10.');
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ mission: 'm', now: 'Serving 5.08 tok/s of record; bar is 10.', changed: [], blocked: [], next: 'n', asks: [] }));
    const b2 = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(b2!.now).toBe('Serving 5.08 tok/s of record; bar is 10.');
    mockUtilityChat.mockResolvedValueOnce('junk');
    const b3 = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(b3!.source).toBe('fallback');
    expect(b3!.now).toContain('KPI of record (client visible e2e tok s): 5.08 tok/s');
  });
});

// ── Goal counts of record (audit 2026-10-06 T8-3, spark #7) ──────────────────
// The spark card: headline "all 25 goals done" (25 done, 5 archived) beside a
// brief "All 17 active goals for the spark-cluster project are complete".
import { goalCountMismatches, reconcileGoalCountText, canonicalGoalSentence, goalCountsOf } from './project-brief.service';
describe('brief goal counts are the card\'s counts (audit 2026-10-06 T8-3)', () => {
  const SPARK = { active: 0, done: 25, blocked: 0, total: 25 };
  const MIXED = { active: 4, done: 3, blocked: 1, total: 8 };
  afterEach(() => { delete process.env.BRIEF_GOAL_COUNTS_DISABLED; });

  it('flags the spark sentence and replaces it with the canonical count sentence; the rest of the field survives', () => {
    const text = 'Spark-cluster runs the 16-GPU serving cluster. All 17 active goals for the spark-cluster project are complete.';
    expect(goalCountMismatches(text, SPARK)).toEqual(['All 17 active goals']);
    expect(reconcileGoalCountText(text, SPARK)).toEqual({ text: 'Spark-cluster runs the 16-GPU serving cluster. All 25 goals are done.', fixed: ['All 17 active goals'] });
  });

  it('a correct count is never touched; bare unqualified "N goals" is not judged', () => {
    for (const ok of ['all 25 goals done', '25 of 25 goals are done', '25 goals done', 'across 3 goals the lanes keep moving', 'no blocked goals']) {
      expect(goalCountMismatches(ok, SPARK)).toEqual([]);
    }
    for (const ok of ['3 of 8 goals are done', '4 active goals', '1 blocked goal', '5 goals remaining', 'goal 2 of 3 is next']) {
      expect(goalCountMismatches(ok, MIXED)).toEqual([]);
    }
  });

  it('wrong totals, wrong qualified counts and wrong "all" claims are flagged', () => {
    expect(goalCountMismatches('7 of 8 goals done', SPARK)).toEqual(['7 of 8 goals done']);
    expect(goalCountMismatches('3 of 9 goals are done', MIXED)).toEqual(['3 of 9 goals are done']);
    expect(goalCountMismatches('2 active goals', MIXED)).toEqual(['2 active goals']);
    expect(goalCountMismatches('all 8 goals are done', MIXED)).toEqual(['all 8 goals are done']);
  });

  it('canonical sentence shapes', () => {
    expect(canonicalGoalSentence(SPARK)).toBe('All 25 goals are done.');
    expect(canonicalGoalSentence(MIXED)).toBe('3 of 8 goals are done (4 active, 1 blocked).');
    expect(canonicalGoalSentence({ active: 0, done: 0, blocked: 0, total: 0 })).toBe('No goals are set yet.');
  });

  it('buildProjectBrief: the prompt carries the exact counts and a model sentence with a wrong count is replaced', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ mission: 'canlegal-bench publishes a legal benchmark. All 2 goals are complete.', now: 'Scraping.', changed: [], blocked: [], next: 'the re-scrape', asks: [] }));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(promptOf()).toContain('GOAL COUNTS (exact, of record');
    expect(promptOf()).toContain('8 goals — 1 active, 7 done, 0 blocked.');
    expect(brief!.mission).toBe('canlegal-bench publishes a legal benchmark. 7 of 8 goals are done (1 active).');
  });

  it('BRIEF_GOAL_COUNTS_DISABLED=1: no counts block, the model sentence stands, the fallback counts the goal list (previous behaviour)', async () => {
    process.env.BRIEF_GOAL_COUNTS_DISABLED = '1';
    expect(goalCountsOf(STATUS)).toBeNull();
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ mission: 'canlegal-bench publishes a legal benchmark. All 2 goals are complete.', now: 'Scraping.', changed: [], blocked: [], next: 'the re-scrape', asks: [] }));
    const brief = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(promptOf()).not.toContain('GOAL COUNTS');
    expect(promptOf()).toContain("(e.g. '7 of 8 goals done')");
    expect(brief!.mission).toBe('canlegal-bench publishes a legal benchmark. All 2 goals are complete.');
    mockUtilityChat.mockResolvedValueOnce('junk');
    const fb = await buildProjectBrief('p1', STATUS, { now: NOW, supervisorChatId: 'sup1' });
    expect(fb!.mission).toContain('1 of 2 goals are done');
  });
});
