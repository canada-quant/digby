/**
 * audit 2026-10-08 W4-2 — the memory pipeline never stores an UNGROUNDED answer as a confirmed fact.
 *
 * REPLAYS of the two prod cases (2026-10-08, shapes only — the owner's own chats, no other account's content):
 *  (1) the switch model: the owner asked for "the exact model … i know its a mellanox i just forgot which type"; a
 *      ZERO-TOOL answer named an exact model ("It's an NVIDIA Mellanox SN2010 …") and the distill filed "Resolution:
 *      The hardware is confirmed as an NVIDIA Mellanox SN2010" into the user scope one second later;
 *  (2) Cloudflare: a chat that had only read its OWN memory (one search_memory call) answered "Confirmed — no
 *      Cloudflare API token anywhere"; the project extractor filed "Cloudflare API access confirmed missing" as a
 *      project decision (a coding lane found the token six minutes later).
 * Pins: the extractors see the answer labelled UNVERIFIED; the distill record is labelled unverified and carries no
 * "confirmed"; a NEW decision / thread fact / personal fact carrying a confirmation claim or a detail only the
 * unverified answer stated is dropped (a `memory_provenance` row says so); a tool-backed answer and the kill switch
 * MEMORY_ANSWER_GROUNDING_DISABLED=1 keep the previous behaviour.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockUpsert: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) } },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: {},
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));

const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));

const mockMemStore: jest.Mock = jest.fn();
jest.mock('../memory/unified-memory.service', () => ({
  memStore: (...a: any[]) => mockMemStore(...a),
  enforceScopeCap: jest.fn(async () => {}),
}));
jest.mock('../memory/user-facts.service', () => ({ selectRelevantFacts: jest.fn(), syncUserFactRows: jest.fn() }));
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: jest.fn(),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({ filterFactsByRelevance: jest.fn(), isTextRelevantToMessage: jest.fn() }));
const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { runUpdateContextPipeline, DECISION_SOURCE } from './memory.graph';
import { answerGroundingFromParts } from '../memory/answer-grounding';

const flush = () => new Promise((r) => setImmediate(r));
const ZERO_TOOLS = answerGroundingFromParts([{ type: 'text', text: 'answer' }]);
const MEMORY_ONLY = answerGroundingFromParts([
  { type: 'tool_call', name: 'search_memory', args: '{"query":"cloudflare"}' },
  { type: 'tool_result', name: 'search_memory', result: '2 results: … no credential named CLOUDFLARE …' },
]);
const WEB_BACKED = answerGroundingFromParts([
  { type: 'tool_call', name: 'search_engine', args: '{}' },
  { type: 'tool_result', name: 'search_engine', result: 'NVIDIA SN2010 — 18x25GbE …' },
]);

function storeReturns(opts: { project?: unknown; thread?: unknown; user?: unknown }) {
  mockStoreGet.mockImplementation(async (ns: string[]) => {
    if (ns[1] === 'context') return opts.project ?? null;
    if (ns[1] === 'thread') return opts.thread ?? null;
    if (ns[1] === 'memory') return opts.user ?? null;
    return null;
  });
}
const prompts = (needle: string) => mockUtilityChat.mock.calls.map((c) => String(c[0][0].content)).filter((p) => p.includes(needle));
const conversationStores = () => mockMemStore.mock.calls.filter((c) => c[1] === 'conversation');
const decisionStores = () => mockMemStore.mock.calls.filter((c) => c[1] === DECISION_SOURCE);
const projectPuts = () => mockStorePut.mock.calls.filter((c) => c[0][1] === 'context');
const threadPuts = () => mockStorePut.mock.calls.filter((c) => c[0][1] === 'thread');
const provenanceRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'memory_provenance');

beforeEach(() => {
  jest.clearAllMocks();
  mockMemStore.mockResolvedValue(1);
  mockStorePut.mockResolvedValue(undefined);
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockResolvedValue(undefined);
  delete process.env.MEMORY_ANSWER_GROUNDING_DISABLED;
});
afterAll(() => { delete process.env.MEMORY_ANSWER_GROUNDING_DISABLED; });

// ── (1) the switch model ─────────────────────────────────────────────────────
const SWITCH_ASK = 'tell me the exact model … i know its a mellanox i just forgot which type';
const SWITCH_ANSWER = "It's an NVIDIA Mellanox SN2010 — the half-width 1U switch with 18× 25GbE SFP28 ports and 4× 100GbE QSFP28 uplinks, running Onyx (or Cumulus Linux), fanless-quiet enough for a rack under a desk. Spec sheet: 1.7 Tbps switching, 1.26 Bpps, 300 ns port-to-port latency, dual hot-swap PSUs. Can also run Cumulus Linux or Linux Switch.";

function routeSwitch() {
  mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
    const p = messages[0].content;
    if (p.includes('Normalize this finished AI-chat exchange')) {
      return JSON.stringify({ question: 'What exact model is my Mellanox switch?', summary: 'The switch is an NVIDIA Mellanox SN2010, a half-width 18x25GbE + 4x100GbE switch; it was verified against the spec sheet.', resolution: 'The hardware is confirmed as an NVIDIA Mellanox SN2010', refs: ['NVIDIA Mellanox SN2010'] });
    }
    if (p.includes('conversation thread summary')) {
      return JSON.stringify({ threadSummary: 'The user asked which Mellanox switch they own.', confirmedFacts: { 'switch model': 'NVIDIA Mellanox SN2010', 'switch vendor': 'Mellanox (user stated)' }, openTopics: [], lastUserGoal: 'identify the switch', messageCount: 6, lastUpdated: '' });
    }
    if (p.includes('memory manager')) return JSON.stringify({ add: { network_switch: 'NVIDIA Mellanox SN2010', homelab_switch_vendor: 'Mellanox' }, remove: [], reject: [] });
    if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 'homelab owner', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: 'terse' });
    return '{}';
  });
}

describe('replay (1) — a zero-tool answer naming an exact model is never stored as confirmed', () => {
  const input = { userId: 'u1', projectId: null, chatId: 'c-switch', userMessage: SWITCH_ASK, synthesis: SWITCH_ANSWER, answerGrounding: ZERO_TOOLS };

  it('the distill record is labelled unverified and carries no "confirmed" / "verified"', async () => {
    storeReturns({ thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeSwitch();
    await runUpdateContextPipeline(input);
    await flush();
    expect(prompts('Normalize this finished AI-chat exchange')[0]).toContain('UNVERIFIED');
    expect(conversationStores()).toHaveLength(1);
    const item = conversationStores()[0][2][0];
    expect(item.content).toMatch(/^Unverified — Digby's answer used no tool or source this turn/);
    expect(item.content).toContain('Resolution (unverified — Digby said): The hardware is stated as an NVIDIA Mellanox SN2010');
    expect(item.content).not.toMatch(/confirmed|verified against/i);
    expect(provenanceRows()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'c-switch', meta: expect.objectContaining({ extractor: 'distill', action: 'labelled_unverified', neutralized: true }) })]));
  });

  it('the thread state and the personal facts keep what the USER said and drop the answer-only model number', async () => {
    storeReturns({ thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeSwitch();
    await runUpdateContextPipeline(input);
    await flush();
    expect(prompts('conversation thread summary')[0]).toContain('UNVERIFIED');
    expect(prompts('memory manager')[0]).toContain('UNVERIFIED');
    const thread = threadPuts().at(-1)![2];
    expect(thread.confirmedFacts).toEqual({ 'switch vendor': 'Mellanox (user stated)' });
    const saved = mockUpsert.mock.calls.at(-1)?.[0];
    const facts = saved?.update?.facts ?? saved?.create?.facts ?? {};
    expect(JSON.stringify(facts)).not.toContain('SN2010');
    expect(facts).toMatchObject({ homelab_switch_vendor: 'Mellanox' }); // the user's own word is kept
    expect(provenanceRows().map((r) => r.meta.extractor).sort()).toEqual(['distill', 'thread', 'user']);
  });

  it('a tool-backed answer (a web search this turn) is stored as before — no label, "confirmed" kept', async () => {
    storeReturns({ thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeSwitch();
    await runUpdateContextPipeline({ ...input, answerGrounding: WEB_BACKED });
    await flush();
    expect(prompts('Normalize this finished AI-chat exchange')[0]).not.toContain('UNVERIFIED');
    expect(conversationStores()[0][2][0].content).toContain('Resolution: The hardware is confirmed as an NVIDIA Mellanox SN2010');
    expect(threadPuts().at(-1)![2].confirmedFacts).toHaveProperty('switch model');
    expect(provenanceRows()).toHaveLength(0);
  });

  it('MEMORY_ANSWER_GROUNDING_DISABLED=1 restores the previous extraction for an ungrounded answer', async () => {
    process.env.MEMORY_ANSWER_GROUNDING_DISABLED = '1';
    storeReturns({ thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeSwitch();
    await runUpdateContextPipeline(input);
    await flush();
    expect(conversationStores()[0][2][0].content).toContain('Resolution: The hardware is confirmed as');
    expect(provenanceRows()).toHaveLength(0);
  });
});

// ── (2) Cloudflare ───────────────────────────────────────────────────────────
const CF_ASK = 'deploy the digby site to cloudflare pages — use the cloudflare token from my coding tab';
const CF_ANSWER = 'Confirmed — checked the project record: no Cloudflare API token anywhere. The credential store is write-only from my side, so paste the token here (or add it under Account → Coding) and I will deploy the site to Cloudflare Pages right after. '.repeat(2);
const projectState = (decisions: string[]) => ({ summary: 'digby site', recentDecisions: decisions, entities: { people: [], amounts: [], places: [], topics: ['cloudflare'] }, openItems: [], lastUpdated: '2026-10-08T00:00:00.000Z' });

function routeCloudflare(decisions: string[]) {
  mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
    const p = messages[0].content;
    if (p.includes('maintaining a project knowledge base')) return JSON.stringify(projectState(decisions));
    if (p.includes('conversation thread summary')) return JSON.stringify({ threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: 'g', messageCount: 6, lastUpdated: '' });
    if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
    if (p.includes('maintain a user profile')) return JSON.stringify({ summary: '', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' });
    if (p.includes('Normalize this finished AI-chat exchange')) return JSON.stringify({ question: 'Cloudflare deploy', summary: 'asked for the token', resolution: 'pending', refs: [] });
    return '{}';
  });
}

describe('replay (2) — a memory-only "confirmed missing" never becomes a project decision', () => {
  const input = { userId: 'u1', projectId: 'p-site', chatId: 'c-cf', userMessage: CF_ASK, synthesis: CF_ANSWER, answerGrounding: MEMORY_ONLY };
  const KEEP = 'Deploy the digby site on Cloudflare Pages';
  const FALSE = 'Cloudflare API access confirmed missing';

  it('a search_memory read is not grounding (re-storing what memory said is circular)', () => {
    expect(MEMORY_ONLY).toEqual({ toolBacked: false, evidenceCalls: 0, tools: [] });
    expect(WEB_BACKED.toolBacked).toBe(true);
  });

  it('the false "confirmed missing" decision is dropped before the save and never filed; the user\'s own decision stays', async () => {
    storeReturns({ project: projectState(['Site lives in the digby repo']), thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeCloudflare(['Site lives in the digby repo', KEEP, FALSE]);
    await runUpdateContextPipeline(input);
    await flush();
    expect(prompts('maintaining a project knowledge base')[0]).toContain('PROVENANCE RULE');
    const saved = projectPuts().at(-1)![2];
    expect(saved.recentDecisions).toEqual(['Site lives in the digby repo', KEEP]);
    const filed = decisionStores().flatMap((c) => c[2].map((i: any) => i.title));
    expect(filed).toContain(KEEP);
    expect(filed.join(' ')).not.toMatch(/confirmed missing/i);
    expect(provenanceRows()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'c-cf', meta: expect.objectContaining({ extractor: 'project', action: 'dropped_decisions', dropped: 1, toolBacked: false }) })]));
  });

  it('"the user confirmed …" is the USER\'s statement — not dropped', async () => {
    storeReturns({ project: projectState([]), thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeCloudflare(['The user confirmed the deploy target is Cloudflare Pages']);
    await runUpdateContextPipeline(input);
    await flush();
    expect(projectPuts().at(-1)![2].recentDecisions).toEqual(['The user confirmed the deploy target is Cloudflare Pages']);
  });

  it('with a real tool result the decision stands (the extractor\'s call, as before)', async () => {
    storeReturns({ project: projectState([]), thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeCloudflare([FALSE]);
    await runUpdateContextPipeline({ ...input, answerGrounding: WEB_BACKED });
    await flush();
    expect(projectPuts().at(-1)![2].recentDecisions).toEqual([FALSE]);
  });

  it('no grounding passed (machine finals / rebuilds) ⇒ the previous behaviour', async () => {
    storeReturns({ project: projectState([]), thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    routeCloudflare([FALSE]);
    await runUpdateContextPipeline({ userId: 'u1', projectId: 'p-site', chatId: 'c-cf', userMessage: CF_ASK, synthesis: CF_ANSWER });
    await flush();
    expect(projectPuts().at(-1)![2].recentDecisions).toEqual([FALSE]);
    expect(prompts('maintaining a project knowledge base')[0]).not.toContain('PROVENANCE RULE');
  });
});

// ── review 2026-10-23 (privacy): a pasted credential never enters a conversation distill ─────────────────
// The distill summarises the RAW owner message, and its refs ("systems, files, URLs, or entities mentioned")
// copied a pasted key into the user-scope record — which a supervisor's search_memory then recalled verbatim.
describe('the conversation distill never carries a pasted credential', () => {
  const HF = 'hf_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9';
  it('the prompt sees the key redacted, and a key the model reconstructs anyway is redacted in the stored record', async () => {
    storeReturns({ thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 4, lastUpdated: '' } });
    mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const p = messages[0].content;
      if (p.includes('Normalize this finished AI-chat exchange')) {
        return JSON.stringify({ question: `Which token (${HF}) for the HF upload?`, summary: 'The owner handed over the Hugging Face token for the spark lane upload; the lane will use it for the mirror push.', resolution: `Use ${HF}`, refs: ['Hugging Face', 'spark lane', HF] });
      }
      return '{}';
    });
    await runUpdateContextPipeline({
      userId: 'u1', projectId: null, chatId: 'c-hf',
      userMessage: `use ${HF} for the HF upload on the spark lane, then push the mirror`,
      synthesis: `Got it — I will hand ${HF} to the spark lane for the upload. ${'The lane pushes the mirror right after the upload finishes and reports back here. '.repeat(5)}`,
      answerGrounding: WEB_BACKED,
    });
    await flush();
    const prompt = prompts('Normalize this finished AI-chat exchange')[0];
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain('hf_A1b2');
    const item = conversationStores()[0][2][0];
    expect(JSON.stringify(item)).not.toContain('hf_A1b2');
    expect(item.content).toContain('[REDACTED: looked like a credential]');
  });
});
