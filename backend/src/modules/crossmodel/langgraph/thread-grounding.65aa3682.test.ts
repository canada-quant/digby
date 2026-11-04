/**
 * Thread-summary provenance guard — ticket 65aa3682 (2026-09-17).
 *
 * REPLAYS THE INCIDENT: during the 00:13Z deploy-recovery window the Fleet
 * Supervisor chat's (c0e22e36) rolling threadSummary was rewritten by the
 * extraction LLM from text alone (no receipts) and came back carrying a
 * "Progress Recap (00:13:34Z)" heading, a curl to
 * https://api.openai.com/v1/credits returning "$12.40", YAML edits and a
 * "top-up already initiated" — NONE present in any extraction input. The
 * poisoned summary was then injected as authoritative [Conversation Thread]
 * History into later runs (incl. the L2 cross-checker, which flagged it).
 *
 * Pins:
 *  - guardThreadSummaryGrounding strips timestamped-heading chrome and every
 *    sentence carrying a high-specificity token (URL/domain/$amount/path/
 *    command) absent from ALL extraction inputs — and keeps everything the
 *    model could have had a basis for (quoted, carried-forward, or token-free).
 *  - runUpdateContextPipeline sanitizes a fabricated extraction result BEFORE
 *    storePut (nothing fabricated reaches the store) and the extraction
 *    prompt carries the new grounding rules.
 *  - The injected [Conversation Thread] block is honestly framed as a
 *    model-maintained summary.
 */

// Decision gate (2026-09-24): stubbed OFF so this suite keeps pinning the
// pre-gate behaviour. The real module's import chain (loop-metrics.service →
// config/database → config/env) and its shadow-mode seat lookup
// (model-roles.service → middleware/error-handler → config/env) both
// process.exit(1) without env vars. Gate behaviour: *.decision-gate.test.ts.
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: () => 'off',
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
  confidenceOf: () => 0,
}));

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
const mockEnforceScopeCap: jest.Mock = jest.fn(async () => {});
jest.mock('../memory/unified-memory.service', () => ({
  memStore: (...a: any[]) => mockMemStore(...a),
  enforceScopeCap: (...a: any[]) => mockEnforceScopeCap(...a),
}));
jest.mock('../memory/user-facts.service', () => ({
  selectRelevantFacts: jest.fn(),
  syncUserFactRows: jest.fn(),
}));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({
  filterFactsByRelevance: jest.fn(),
  isTextRelevantToMessage: jest.fn(),
}));

const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));

import logger from '../../../utils/logger';
import { guardThreadSummaryGrounding, THREAD_SUMMARY_GROUNDING_RULES } from './thread-grounding';
import { runUpdateContextPipeline } from './memory.graph';

const mockWarn = logger.warn as jest.Mock;

/* ── Unit: the pure guard ─────────────────────────────────────────────────── */

describe('guardThreadSummaryGrounding (ticket 65aa3682 replay)', () => {
  const PRIOR = JSON.stringify({
    threadSummary: 'The fleet discussed the dflash2E release record and splash deconfliction.',
    confirmedFacts: {},
    openTopics: [],
    lastUserGoal: 'fleet oversight',
    messageCount: 40,
    lastUpdated: '2026-09-17T00:10:00.000Z',
  });
  const USER = '[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: 2026-09-17T00:13:34.936Z] hook wake: 2 lanes reported';
  const SYNTHESIS =
    'Fleet — 8:11 PM EDT (00:11Z): the OpenAI credits question is answered under the standing directives — ' +
    'provider spend is pre-approved; the only piece that is yours is the 2-minute top-up at platform.openai.com.';

  it('strips the exact fabricated recap from the incident (heading + curl + $12.40) and keeps grounded content', () => {
    const fabricated = [
      'Progress Recap (00:13:34Z)',
      'Ran shell checks: curl https://api.openai.com/v1/credits returned "$12.40".',
      'Edited deploy YAML files.',
      'Top-up already initiated.',
      'The fleet otherwise discussed the dflash2E release record.',
    ].join('\n');
    const r = guardThreadSummaryGrounding(fabricated, [PRIOR, USER, SYNTHESIS]);
    // Heading chrome dropped
    expect(r.strippedHeadings).toEqual(['Progress Recap (00:13:34Z)']);
    // The sentence carrying the fabricated URL + $amount dropped
    expect(r.strippedSentences).toHaveLength(1);
    expect(r.strippedSentences[0]).toContain('api.openai.com/v1/credits');
    // Persisted text: no fabrication, keeps vague prose (prompt-rules layer's
    // job, not the token guard's) and the carried-forward grounded sentence
    expect(r.text).not.toContain('api.openai.com');
    expect(r.text).not.toContain('12.40');
    expect(r.text).not.toContain('Progress Recap');
    expect(r.text).toContain('Edited deploy YAML files');
    expect(r.text).toContain('Top-up already initiated');
    expect(r.text).toContain('dflash2E release record');
  });

  it('keeps high-specificity tokens that ARE present in the assistant text (quoted, not invented)', () => {
    const summary = 'The assistant ran curl https://api.openai.com/v1/credits and saw "$12.40" remaining.';
    const synth = 'I checked with curl https://api.openai.com/v1/credits and the balance shows "$12.40" remaining.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, synth]);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('api.openai.com/v1/credits');
    expect(r.text).toContain('12.40');
  });

  it('keeps plain/derived numbers and vague prose (no token shapes → no false positives)', () => {
    const summary = '24 of its 50 turns in 3 h were one-paragraph report-ups; the queue drained as one turn.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, SYNTHESIS]);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('24 of its 50 turns');
  });

  it('returns empty text when EVERY sentence is fabricated (caller falls back to the prior summary)', () => {
    const summary = 'Checked https://billing.example.com/console. Balance stood at $4,099.10.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, SYNTHESIS]);
    expect(r.text).toBe('');
    expect(r.strippedSentences.length).toBeGreaterThan(0);
  });

  it('strips an invented command-shaped backtick span; keeps a single plain backticked word', () => {
    const summary = 'Ran `fuser -k 3101/tcp` on the bench box. Marked the lane `done`.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, SYNTHESIS]);
    expect(r.strippedSentences).toHaveLength(1);
    expect(r.strippedSentences[0]).toContain('fuser');
    expect(r.text).toContain('`done`');
  });

  it('keeps a command span the assistant text actually contains', () => {
    const summary = 'Ran `fuser -k 3101/tcp` on the bench box.';
    const synth = 'I ran `fuser -k 3101/tcp` on the bench box to free the port.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, synth]);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('fuser');
  });

  it('carry-forward: a token already in the PRIOR state may be kept (documented design limit)', () => {
    const priorWithUrl = JSON.stringify({ threadSummary: 'Checked https://status.example.com earlier.', messageCount: 40 });
    const summary = 'The status page https://status.example.com stayed green through the window.';
    const r = guardThreadSummaryGrounding(summary, [priorWithUrl, USER, SYNTHESIS]);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('status.example.com');
  });

  it('keeps a plain content sentence ending in a time paren (not recap-class chrome)', () => {
    const summary = 'The queue drained as one turn (00:33Z). The lane stayed quiet through the window.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, SYNTHESIS]);
    expect(r.strippedHeadings).toHaveLength(0);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('queue drained as one turn (00:33Z)');
  });

  it('strips a markdown-marked timestamped heading as chrome', () => {
    const summary = '## Fleet Status (00:33Z)\nThe lane stayed quiet through the window.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, SYNTHESIS]);
    expect(r.strippedHeadings).toEqual(['## Fleet Status (00:33Z)']);
    expect(r.text).toContain('stayed quiet');
  });

  // Reviewer C3 follow-up (65aa3682): trailing sentence punctuation captured
  // by the URL/path char classes must not make a GROUNDED token look invented.
  it('keeps a grounded URL at the end of the final sentence (trailing-period hazard)', () => {
    const summary = 'User shared https://example.com/docs.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, 'I read https://example.com/docs yesterday']);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('https://example.com/docs');
  });

  it('keeps a grounded absolute path at sentence end', () => {
    const summary = 'The balance came from /v1/credits.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, 'I ran curl https://api.openai.com/v1/credits just now']);
    expect(r.strippedSentences).toHaveLength(0);
    expect(r.text).toContain('/v1/credits');
  });

  it('still strips an UNGROUNDED URL carrying a trailing period', () => {
    const summary = 'Details at https://evil.example.net/x.';
    const r = guardThreadSummaryGrounding(summary, [PRIOR, USER, SYNTHESIS]);
    expect(r.strippedSentences).toHaveLength(1);
    expect(r.text).toBe('');
  });

  it('grounding rules carry the never-invent imperatives', () => {
    expect(THREAD_SUMMARY_GROUNDING_RULES).toContain('NEVER invent operational specifics');
    expect(THREAD_SUMMARY_GROUNDING_RULES).toContain('NO timestamped headings');
  });
});

/* ── Graph-level: fabricated extraction is sanitized before persist ───────── */

describe('runUpdateContextPipeline thread-summary sanitization (65aa3682)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreGet.mockImplementation(async (ns: string[]) => {
      if (ns[1] === 'thread') {
        return {
          threadSummary: 'The fleet discussed the dflash2E release record.',
          confirmedFacts: {},
          openTopics: [],
          lastUserGoal: 'fleet oversight',
          // 38 → this turn's messageCount 40 → turnNumber 20 (EVEN): the
          // every-2nd-turn thread-extraction debounce (memory.graph.ts:1511)
          // RUNS the extraction this turn.
          messageCount: 38,
          lastUpdated: '2026-09-17T00:10:00.000Z',
        };
      }
      return null;
    });
  });

  const FABRICATED_EXTRACTION = JSON.stringify({
    threadSummary: [
      'Progress Recap (00:13:34Z)',
      'Ran shell checks: curl https://api.openai.com/v1/credits returned "$12.40".',
      'The fleet otherwise discussed the dflash2E release record.',
    ].join('\n'),
    confirmedFacts: {},
    openTopics: [],
    lastUserGoal: 'fleet oversight',
    messageCount: 42,
    lastUpdated: '2026-09-17T00:23:00.000Z',
  });

  it('strips the fabricated tokens before storePut and the extraction prompt carries the grounding rules', async () => {
    mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const p = messages[0].content;
      if (p.includes('conversation thread summary')) return FABRICATED_EXTRACTION;
      if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 's', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' });
      if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
      if (p.includes('Normalize this finished AI-chat exchange')) return JSON.stringify({});
      return '{}';
    });

    await runUpdateContextPipeline({
      userId: 'u1',
      projectId: null,
      chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37',
      userMessage: '[MACHINE-TRIGGERED RUN] hook wake: lanes reported',
      synthesis: 'Fleet note: the OpenAI credits question is answered under the standing directives; the top-up is the owner\'s 2-minute errand.',
    });

    const threadPuts = mockStorePut.mock.calls.filter((c) => c[0][1] === 'thread');
    expect(threadPuts).toHaveLength(1);
    const saved = threadPuts[0][2];
    expect(saved.threadSummary).not.toContain('api.openai.com');
    expect(saved.threadSummary).not.toContain('12.40');
    expect(saved.threadSummary).not.toContain('Progress Recap');
    expect(saved.threadSummary).toContain('dflash2E release record');
    // The warn channel telemeters the strip for loop_metrics/log audit
    expect(mockWarn).toHaveBeenCalled();
    expect(String(mockWarn.mock.calls[0][0])).toContain('65aa3682');
    // The extraction prompt carried the new grounding rules
    const threadPrompt = mockUtilityChat.mock.calls
      .map((c) => c[0][0].content as string)
      .find((p) => p.includes('conversation thread summary'));
    expect(threadPrompt).toContain('NEVER invent operational specifics');
    expect(threadPrompt).toContain('NO timestamped headings');
  });

  it('an emptied summary falls back to the prior threadSummary (never persists a blank)', async () => {
    mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const p = messages[0].content;
      if (p.includes('conversation thread summary')) {
        return JSON.stringify({
          threadSummary: 'Checked https://billing.example.com/console. Balance stood at $4,099.10.',
          confirmedFacts: {},
          openTopics: [],
          lastUserGoal: 'g',
          messageCount: 42,
          lastUpdated: '',
        });
      }
      if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 's', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' });
      if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
      return '{}';
    });

    await runUpdateContextPipeline({
      userId: 'u1',
      projectId: null,
      chatId: 'chat-fallback',
      userMessage: '[MACHINE-TRIGGERED RUN] hook wake: one lane reported in',
      synthesis: 'A normal fleet note with nothing specific in it at all, just a status line.',
    });

    const threadPuts = mockStorePut.mock.calls.filter((c) => c[0][1] === 'thread');
    expect(threadPuts).toHaveLength(1);
    expect(threadPuts[0][2].threadSummary).toBe('The fleet discussed the dflash2E release record.');
  });
});
