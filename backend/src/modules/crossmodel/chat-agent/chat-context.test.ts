/**
 * chat-context tests — the context-building helpers extracted (2026-07-23) from the
 * deleted legacy query-pipeline. Covers the pure / lightly-stateful exports:
 *   - truncateHistoryAssistantMessages (2400/3500-char caps + truncation marker)
 *   - enrichFollowUpReference (wrapper over ./followup-enrichment + observability log)
 *   - enrichTruncationContinuation (cut-off-complaint detection + continuation block)
 *   - buildModelContextBlock (per-mode/per-modelSet prompt block)
 *   - buildDateTimeBlock (UTC block + optional user-local block, fixed clock)
 *   - buildIntegrationStatusBlock (Redis cache hit/miss + per-integration lines)
 *   - SHARED_AI_RULES / DIGBY_PLATFORM_IDENTITY constants
 *
 * buildChatQueryContext / persistAndEmitCanvases are intentionally NOT covered here
 * (heavy prisma/redis/SSE orchestration — out of scope for a unit suite).
 *
 * Mocking: logger/prisma/redis are mocked at their leaf modules (same pattern as
 * ../folders.test.ts); the heavy leaf deps (context.service, rag.service,
 * langgraph/memory.graph) are mocked with minimal shapes so this suite imports
 * cleanly without config/env. integration-status-cache is REAL (it only needs the
 * mocked redis) so the cache key/TTL contract is asserted against the real values.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockRedis = { get: jest.fn(), setEx: jest.fn(), del: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  googleOAuthToken: { findFirst: jest.fn(), count: jest.fn() },
  gitHubOAuthToken: { findFirst: jest.fn() },
  xOAuthToken: { findFirst: jest.fn() },
  xeroOAuthToken: { findFirst: jest.fn() },
  plaidAccessToken: { findFirst: jest.fn() },
  slackOAuthToken: { findFirst: jest.fn() },
  asanaOAuthToken: { findFirst: jest.fn() },
  telegramLink: { findFirst: jest.fn() },
  // Ticket c02b85bf: the credential NAMES line is sourced from the real
  // credentials.service (getCredentialEnv) against this mocked table.
  codingCredential: { findFirst: jest.fn(), findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Heavy leaf deps — mocked so the import never reaches config/env. The functions
// under test don't call them, but chat-context.ts imports them at module load.
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(), loadSessionContext: jest.fn() },
}));
jest.mock('../rag.service', () => ({
  retrieveChunks: jest.fn(),
  retrieveCrossProjectChunks: jest.fn(),
  buildContextBlock: jest.fn(),
  buildCrossProjectBlock: jest.fn(),
}));
jest.mock('../langgraph/memory.graph', () => ({
  getEnrichedContext: jest.fn(),
  getProjectSettings: jest.fn(),
}));
// Ticket c02b85bf: chat-context reads credential NAMES through this leaf —
// mock it so the block tests control the list without depending on
// encryption env. (The real function's contract is pinned in
// coding/credentials.service.test.ts.)
jest.mock('../coding/credentials.service', () => ({
  listShellCredentialNames: jest.fn(),
}));

import {
  truncateHistoryAssistantMessages,
  enrichFollowUpReference,
  enrichTruncationContinuation,
  buildModelContextBlock,
  buildDateTimeBlock,
  dualTimestampRule,
  buildIntegrationStatusBlock,
  SHARED_AI_RULES,
  DIGBY_PLATFORM_IDENTITY,
} from './chat-context';
import {
  INTEGRATION_STATUS_CACHE_KEY,
  INTEGRATION_STATUS_CACHE_TTL,
} from '../langgraph/integration-status-cache';
import { listShellCredentialNames } from '../coding/credentials.service';
import logger from '../../../utils/logger';

type Msg = { role: 'user' | 'assistant'; content: string };

const mockLoggerInfo = logger.info as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;

beforeEach(() => jest.clearAllMocks());

// ═══════════════════════════════════════════════════════════════════════════════
// truncateHistoryAssistantMessages — caps: 2400 (assistant), 3500 (LAST assistant)
// ═══════════════════════════════════════════════════════════════════════════════

describe('truncateHistoryAssistantMessages', () => {
  it('returns an empty history unchanged', () => {
    expect(truncateHistoryAssistantMessages([])).toEqual([]);
  });

  it('leaves short assistant and user messages intact', () => {
    const history: Msg[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'thanks' },
    ];
    expect(truncateHistoryAssistantMessages(history)).toEqual(history);
  });

  it('never truncates user messages, no matter how long', () => {
    const history: Msg[] = [{ role: 'user', content: 'u'.repeat(10000) }];
    const out = truncateHistoryAssistantMessages(history);
    expect(out[0].content).toHaveLength(10000);
  });

  it('keeps a non-last assistant message at exactly 2400 chars intact, truncates at 2401', () => {
    const mk = (len: number): Msg[] => [
      { role: 'assistant', content: 'a'.repeat(len) },
      { role: 'assistant', content: 'short last' }, // a later assistant message → first is non-last
    ];
    expect(truncateHistoryAssistantMessages(mk(2400))[0].content).toBe('a'.repeat(2400));

    const out = truncateHistoryAssistantMessages(mk(2401));
    expect(out[0].content).toBe(
      'a'.repeat(2400) + '\n\n[… previous response truncated for brevity — 2401 chars total]',
    );
  });

  it('keeps the LAST assistant message at exactly 3500 chars intact, truncates at 3501', () => {
    const mk = (len: number): Msg[] => [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'b'.repeat(len) },
    ];
    expect(truncateHistoryAssistantMessages(mk(3500))[1].content).toBe('b'.repeat(3500));

    const out = truncateHistoryAssistantMessages(mk(3501));
    expect(out[1].content).toBe(
      'b'.repeat(3500) + '\n\n[… previous response truncated for brevity — 3501 chars total]',
    );
  });

  it('applies the 2400 cap to earlier assistants and the 3500 cap to the last one', () => {
    const history: Msg[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'x'.repeat(3000) }, // non-last → 2400 cap
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'y'.repeat(3400) }, // last → 3500 cap → intact
    ];
    const out = truncateHistoryAssistantMessages(history);
    expect(out[1].content).toContain('[… previous response truncated for brevity — 3000 chars total]');
    expect(out[1].content.startsWith('x'.repeat(2400))).toBe(true);
    expect(out[3].content).toBe('y'.repeat(3400)); // under the last-message budget
    // roles and order are preserved
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('trims trailing whitespace at the cut point before appending the marker', () => {
    const content = 'a'.repeat(2398) + '   ' + 'b'.repeat(100); // 2501 chars, spaces at the 2400 cut
    const out = truncateHistoryAssistantMessages([
      { role: 'assistant', content },
      { role: 'assistant', content: 'last' },
    ]);
    expect(out[0].content).toBe(
      'a'.repeat(2398) + '\n\n[… previous response truncated for brevity — 2501 chars total]',
    );
  });

  it('uses the last-message budget even when the final message is a user message', () => {
    // The "last assistant" is found by scanning backwards — a trailing user message
    // does not change which assistant message gets the 3500 budget.
    const history: Msg[] = [
      { role: 'assistant', content: 'c'.repeat(3400) },
      { role: 'user', content: 'next question' },
    ];
    const out = truncateHistoryAssistantMessages(history);
    expect(out[0].content).toBe('c'.repeat(3400)); // only assistant message = last assistant → 3500 cap
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enrichFollowUpReference — thin wrapper over ./followup-enrichment + info log
// ═══════════════════════════════════════════════════════════════════════════════

describe('enrichFollowUpReference (chat-context wrapper)', () => {
  const ASSISTANT_LONG =
    'Teranet is a colocation and data-center provider we recommended for hosting. ' +
    'It offers Victoria and Toronto facilities with competitive pricing and low latency. ' +
    'Their Victoria site is well suited for BC-based workloads and disaster recovery.';
  const history: Msg[] = [
    { role: 'user', content: 'Where should we host?' },
    { role: 'assistant', content: ASSISTANT_LONG },
  ];

  it('passes the message through unchanged when there is no history (and logs nothing)', () => {
    expect(enrichFollowUpReference("what's Teranet?", [])).toBe("what's Teranet?");
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('enriches an explicit "what\'s X?" reference and logs the explicit enrichment line', () => {
    const out = enrichFollowUpReference("what's Teranet?", history);
    expect(out.startsWith("what's Teranet?")).toBe(true);
    expect(out).toContain('CONVERSATION CONTEXT');
    expect(out).toContain('Teranet');
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo.mock.calls[0][0]).toContain('enriched follow-up reference');
    expect(mockLoggerInfo.mock.calls[0][0]).toContain('Teranet');
  });

  it('enriches an implicit continuation and logs the implicit enrichment line', () => {
    const out = enrichFollowUpReference('how much for the Victoria site', history);
    expect(out.startsWith('how much for the Victoria site')).toBe(true);
    expect(out).toContain('topic from my previous response');
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo.mock.calls[0][0]).toContain('enriched implicit follow-up');
  });

  it('leaves a self-contained message untouched and logs nothing', () => {
    const msg = 'The quarterly revenue figures look strong overall';
    expect(enrichFollowUpReference(msg, history)).toBe(msg);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enrichTruncationContinuation — "you got cut off" → continue-don't-restart block
// ═══════════════════════════════════════════════════════════════════════════════

describe('enrichTruncationContinuation', () => {
  const PREV = 'The quick brown fox jumps over the lazy dog. '.repeat(10); // 450 chars
  const history: Msg[] = [
    { role: 'user', content: 'list the top 20 chess openings with explanations' },
    { role: 'assistant', content: PREV },
  ];

  it('returns the message unchanged when it exceeds 200 chars (complaints are brief)', () => {
    const msg = 'keep going ' + 'x'.repeat(250);
    expect(enrichTruncationContinuation(msg, history)).toBe(msg);
  });

  it('returns the message unchanged with empty history', () => {
    expect(enrichTruncationContinuation('your response stopped short', [])).toBe('your response stopped short');
  });

  it('returns the message unchanged when it matches no truncation pattern', () => {
    const msg = 'what is the capital of France?';
    expect(enrichTruncationContinuation(msg, history)).toBe(msg);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('returns the message unchanged when the last assistant message is under 100 chars', () => {
    const shortHistory: Msg[] = [{ role: 'assistant', content: 'Short answer.' }];
    expect(enrichTruncationContinuation('you got cut off', shortHistory)).toBe('you got cut off');
  });

  it('returns the message unchanged when there is no assistant message in history', () => {
    const userOnly: Msg[] = [{ role: 'user', content: 'earlier question' }];
    expect(enrichTruncationContinuation('you got cut off', userOnly)).toBe('you got cut off');
  });

  it.each([
    'your response stopped short',
    'you got cut off',
    'continue from where you stopped',
    'keep going',
    "the answer wasn't finished",
    'finish the response',
  ])('enriches the truncation complaint %j with the full previous response', (msg) => {
    const out = enrichTruncationContinuation(msg, history);
    expect(out.startsWith(msg)).toBe(true);
    expect(out).toContain('═══ TRUNCATION CONTINUATION CONTEXT ═══');
    expect(out).toContain('YOUR PREVIOUS (TRUNCATED) RESPONSE:');
    expect(out).toContain(PREV); // full previous response (< 3000 chars) is included
    expect(out).toContain('═══ END TRUNCATION CONTEXT ═══');
    expect(out).toContain('CRITICAL INSTRUCTION');
    expect(out).toContain('Do NOT restart from the beginning');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('detected truncation continuation request'),
    );
  });

  it('caps an over-long previous response at 3000 chars with a truncation note', () => {
    const bigHistory: Msg[] = [{ role: 'assistant', content: 'x'.repeat(4000) }];
    const out = enrichTruncationContinuation('you got cut off', bigHistory);
    expect(out).toContain('x'.repeat(3000));
    expect(out).not.toContain('x'.repeat(3001)); // 3001st char onwards is cut
    expect(out).toContain('[... truncated for context ...]');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// buildDateTimeBlock — fixed clock: Thu 2026-07-23 15:04:05 UTC
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildDateTimeBlock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 6, 23, 15, 4, 5)));
  });
  afterEach(() => jest.useRealTimers());

  it('renders the UTC date/time fields, quarter and day-of-year', () => {
    const block = buildDateTimeBlock();
    expect(block).toContain('[CURRENT DATE & TIME');
    expect(block).toContain('Date      : Thursday, July 23, 2026');
    expect(block).toContain('Time      : 15:04:05 UTC');
    expect(block).toContain('ISO 8601  : 2026-07-23T15:04:05.000Z');
    expect(block).toContain(`Unix ts   : ${Math.floor(Date.UTC(2026, 6, 23, 15, 4, 5) / 1000)}`);
    expect(block).toContain('Quarter   : Q3 of 2026   (Day 204 of the year)');
    expect(block).toContain('no web search required');
    expect(block).toContain('[/CURRENT DATE & TIME]');
  });

  it('omits the user-local block when no timezone is given', () => {
    expect(buildDateTimeBlock()).not.toContain('User local:');
    expect(buildDateTimeBlock(undefined)).not.toContain('IMPORTANT');
  });

  it('adds a user-local block for a valid timezone (Vancouver = UTC-7 in July)', () => {
    const block = buildDateTimeBlock('America/Vancouver');
    expect(block).toContain('User local: Thursday, July 23, 2026 at 08:04:05 AM PDT (America/Vancouver)');
    expect(block).toContain('use the USER LOCAL date above — NOT the UTC date');
    // UTC fields are still present alongside the local block
    expect(block).toContain('Date      : Thursday, July 23, 2026');
  });

  it('is byte-identical when extraNote is omitted vs explicitly undefined', () => {
    expect(buildDateTimeBlock('America/Vancouver')).toBe(buildDateTimeBlock('America/Vancouver', undefined));
    expect(buildDateTimeBlock()).toBe(buildDateTimeBlock(undefined, undefined));
  });

  it('swallows an invalid timezone without throwing and skips the local block', () => {
    let block = '';
    expect(() => { block = buildDateTimeBlock('Not/AZone'); }).not.toThrow();
    expect(block).not.toContain('User local:');
    expect(block).toContain('Date      : Thursday, July 23, 2026');
  });

  it('renders an extra note inside the block (before the closing tag) when given', () => {
    const block = buildDateTimeBlock('America/Vancouver', 'Timestamp rule: test note');
    expect(block).toContain('Timestamp rule: test note');
    expect(block.indexOf('Timestamp rule: test note')).toBeLessThan(block.indexOf('[/CURRENT DATE & TIME]'));
    // omitted / blank → byte-identical to the no-note rendering
    expect(buildDateTimeBlock('America/Vancouver')).not.toContain('Timestamp rule:');
    expect(buildDateTimeBlock('America/Vancouver', '   ')).not.toContain('Timestamp rule:');
  });

  it('tracks quarter/day-of-year across the calendar (Dec 31 → Q4, day 365)', () => {
    jest.setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)));
    const block = buildDateTimeBlock();
    expect(block).toContain('Date      : Thursday, December 31, 2026');
    expect(block).toContain('Quarter   : Q4 of 2026   (Day 365 of the year)');
  });

  it('dualTimestampRule (owner convention 63698528): both clocks, local first, Zulu in parens', () => {
    const rule = dualTimestampRule('America/Vancouver');
    expect(rule).toContain('render BOTH clocks');
    expect(rule).toContain("the user's local time (America/Vancouver) first");
    expect(rule).toContain('the UTC instant in parentheses');
    expect(rule).toContain('"10:30 PM PDT (05:30Z)"');
    expect(rule).toContain('Never a bare Zulu-only or local-only timestamp');
    // and it rides inside the block as the extraNote (before the closing tag)
    const block = buildDateTimeBlock('America/Vancouver', rule);
    expect(block).toContain('Timestamp rule:');
    expect(block.indexOf('Timestamp rule:')).toBeLessThan(block.indexOf('[/CURRENT DATE & TIME]'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildIntegrationStatusBlock — Redis-cached per-user connection status
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildIntegrationStatusBlock', () => {
  const ALL_CONNECTED = () => {
    mockPrisma.googleOAuthToken.findFirst.mockResolvedValue({ id: 'g1', email: 'a@b.co', label: 'Work' });
    mockPrisma.googleOAuthToken.count.mockResolvedValue(3);
    mockPrisma.gitHubOAuthToken.findFirst.mockResolvedValue({ id: 'gh1', username: 'octocat', scopes: ['repo'] });
    mockPrisma.xOAuthToken.findFirst.mockResolvedValue({ id: 'x1', screenName: 'xhandle' });
    mockPrisma.xeroOAuthToken.findFirst.mockResolvedValue({ id: 'xe1', orgName: 'Acme Ltd' });
    mockPrisma.plaidAccessToken.findFirst.mockResolvedValue({ id: 'p1', institutionName: 'RBC' });
    mockPrisma.slackOAuthToken.findFirst.mockResolvedValue({ id: 's1', teamName: 'acme' });
    mockPrisma.asanaOAuthToken.findFirst.mockResolvedValue({ id: 'a1', asanaName: 'Ada' });
    mockPrisma.telegramLink.findFirst.mockResolvedValue({ id: 't1', username: 'adatg' });
  };

  beforeEach(() => {
    // Defaults: cache miss, nothing connected. (clearAllMocks keeps prior
    // implementations, so every test starts from an explicit clean slate.)
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setEx.mockResolvedValue('OK');
    for (const model of Object.values(mockPrisma) as any[]) {
      model.findFirst.mockResolvedValue(null);
      if (model.count) model.count.mockResolvedValue(0);
    }
    // Default: no stored coding credentials (the "None stored" line renders);
    // individual tests override with a populated list.
    (listShellCredentialNames as jest.Mock).mockResolvedValue([]);
  });

  it('returns the not-signed-in block for a null user without touching redis or prisma', async () => {
    const block = await buildIntegrationStatusBlock(null);
    expect(block).toBe(
      '[YOUR INTEGRATION STATUS]\n' +
      'This user is not signed in. They can create a free account to access integrations.\n' +
      '[/YOUR INTEGRATION STATUS]',
    );
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockPrisma.googleOAuthToken.findFirst).not.toHaveBeenCalled();
  });

  it('returns the cached block on a redis hit and skips all DB queries', async () => {
    mockRedis.get.mockResolvedValue('CACHED_STATUS_BLOCK');
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toBe('CACHED_STATUS_BLOCK');
    expect(mockRedis.get).toHaveBeenCalledWith(INTEGRATION_STATUS_CACHE_KEY('u1'));
    expect(mockPrisma.googleOAuthToken.findFirst).not.toHaveBeenCalled();
    expect(mockRedis.setEx).not.toHaveBeenCalled();
  });

  it('falls through to the DB when redis.get throws', async () => {
    mockRedis.get.mockRejectedValue(new Error('redis down'));
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain("[YOUR INTEGRATION STATUS — THIS USER'S CONNECTIONS]");
    expect(mockPrisma.googleOAuthToken.findFirst).toHaveBeenCalled();
  });

  it('renders all eight integrations as not-connected on a cache miss with no tokens', async () => {
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain("[YOUR INTEGRATION STATUS — THIS USER'S CONNECTIONS]");
    for (const name of ['Google Workspace', 'GitHub', 'X (Twitter)', 'Xero Accounting', 'Plaid Banking', 'Slack', 'Asana', 'Telegram']) {
      expect(block).toContain(`• ${name}: ❌ Not connected`);
    }
    expect(block.trim().endsWith('[/YOUR INTEGRATION STATUS]')).toBe(true);
    // …and the rendered block is cached with the real key + TTL
    expect(mockRedis.setEx).toHaveBeenCalledWith(INTEGRATION_STATUS_CACHE_KEY('u1'), INTEGRATION_STATUS_CACHE_TTL, block);
  });

  // ── coding-credential NAMES line (ticket c02b85bf) ─────────────────────────
  // The wrong answer this ticket reported — "I don't have a Cloudflare key" —
  // was the CORRECT inference from a block that never mentioned the store.
  it('lists stored coding credentials as NAMES ONLY with the hand-off rule (ticket c02b85bf)', async () => {
    (listShellCredentialNames as jest.Mock).mockResolvedValue(['AWS_SECRET_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN']);
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain('• API keys / credentials (Account → Coding): ✅ 2 stored — AWS_SECRET_ACCESS_KEY, CLOUDFLARE_API_TOKEN');
    expect(block).toContain('ALREADY SET as env vars in every coding-session shell');
    expect(block).toContain('NEVER ask the user to paste a key that is listed here');
  });

  it('says "None stored" (and how to add one) when the user has no coding credentials', async () => {
    (listShellCredentialNames as jest.Mock).mockResolvedValue([]);
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain('• API keys / credentials (Account → Coding): ❌ None stored');
    expect(block).toContain('Account → Coding');
  });

  it('OMITS the credentials line entirely when the read fails — never renders "None stored" for a broken read (the wrong answer would return)', async () => {
    (listShellCredentialNames as jest.Mock).mockRejectedValue(new Error('db gone'));
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).not.toContain('API keys / credentials');
    // the rest of the block is intact — one failed read degrades alone
    expect(block).toContain('• Google Workspace: ❌ Not connected');
    expect(block).toContain('[/YOUR INTEGRATION STATUS]');
  });

  it('never renders a credential VALUE even if one somehow leaked into the names list (defense in depth)', async () => {
    (listShellCredentialNames as jest.Mock).mockResolvedValue(['CLOUDFLARE_API_TOKEN']);
    const block = await buildIntegrationStatusBlock('u1');
    // the names seam is names-only by construction; pin that the rendered line
    // carries the NAME and the shell rule, not any preview/mask/value.
    expect(block).toContain('CLOUDFLARE_API_TOKEN');
    expect(block).not.toMatch(/••••/);
  });

  it('renders connected lines with account details for every connected integration', async () => {
    ALL_CONNECTED();
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain('• Google Workspace: ✅ CONNECTED (3 accounts) — Gmail, Calendar, Drive active');
    expect(block).toContain('• GitHub: ✅ CONNECTED — @octocat — repos, issues, pull requests');
    expect(block).toContain('• X (Twitter): ✅ CONNECTED — @xhandle');
    expect(block).toContain('• Xero Accounting: ✅ CONNECTED — Acme Ltd');
    expect(block).toContain('• Plaid Banking: ✅ CONNECTED — RBC');
    expect(block).toContain('• Slack: ✅ CONNECTED — acme');
    expect(block).toContain('• Asana: ✅ CONNECTED — Ada');
    expect(block).toContain('• Telegram: ✅ CONNECTED — @adatg');
  });

  it('omits the "(N accounts)" suffix when the user has a single Google account', async () => {
    mockPrisma.googleOAuthToken.findFirst.mockResolvedValue({ id: 'g1', email: 'a@b.co', label: null });
    mockPrisma.googleOAuthToken.count.mockResolvedValue(1);
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain('• Google Workspace: ✅ CONNECTED — Gmail, Calendar, Drive active');
    expect(block).not.toContain('accounts)');
  });

  it('flags a GitHub token WITHOUT the repo scope as a warning, not a success', async () => {
    mockPrisma.gitHubOAuthToken.findFirst.mockResolvedValue({ id: 'gh1', username: 'octocat', scopes: ['read:user'] });
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain('• GitHub: ⚠️ CONNECTED — @octocat but WITHOUT repository access');
    expect(block).toContain('grant the "repo" scope');
  });

  it('treats an individual failed query as not-connected while keeping the others', async () => {
    ALL_CONNECTED();
    mockPrisma.googleOAuthToken.findFirst.mockRejectedValue(new Error('db blip'));
    mockPrisma.googleOAuthToken.count.mockRejectedValue(new Error('db blip'));
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain('• Google Workspace: ❌ Not connected');
    expect(block).toContain('• Xero Accounting: ✅ CONNECTED — Acme Ltd');
  });

  it('still returns the block when caching it fails (setEx is non-critical)', async () => {
    mockRedis.setEx.mockRejectedValue(new Error('redis down'));
    const block = await buildIntegrationStatusBlock('u1');
    expect(block).toContain("[YOUR INTEGRATION STATUS — THIS USER'S CONNECTIONS]");
  });

  it('returns an empty string and logs a warning on a catastrophic failure', async () => {
    const saved = mockPrisma.googleOAuthToken;
    mockPrisma.googleOAuthToken = undefined; // → TypeError inside the try, hits the outer catch
    try {
      const block = await buildIntegrationStatusBlock('u1');
      expect(block).toBe('');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('buildIntegrationStatusBlock failed'),
      );
    } finally {
      mockPrisma.googleOAuthToken = saved;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED_AI_RULES / DIGBY_PLATFORM_IDENTITY — the always-injected prompt blocks
// ═══════════════════════════════════════════════════════════════════════════════

describe('SHARED_AI_RULES / DIGBY_PLATFORM_IDENTITY constants', () => {
  it('SHARED_AI_RULES is a non-empty wrapped block carrying its key standing rules', () => {
    expect(typeof SHARED_AI_RULES).toBe('string');
    expect(SHARED_AI_RULES.length).toBeGreaterThan(1000);
    expect(SHARED_AI_RULES).toContain('[CRITICAL AI RESPONSE GUIDELINES — APPLY ALWAYS]');
    expect(SHARED_AI_RULES).toContain('[/CRITICAL AI RESPONSE GUIDELINES]');
    expect(SHARED_AI_RULES).toContain('NEVER claim that any AI model version');
    expect(SHARED_AI_RULES).toContain('USER EXPLICIT REJECTION');
    expect(SHARED_AI_RULES).toContain('NUMERICAL ACCURACY');
    expect(SHARED_AI_RULES).toContain('TOPIC CORRECTION DETECTION');
    expect(SHARED_AI_RULES).toContain('CONVERSATION PROGRESSION — NO REPETITION');
  });

  it('SHARED_AI_RULES carries the NEWS FRESHNESS date-verification rule (feedback 28fc8496)', () => {
    // Regression guard for the 2026-08-27 "very old news" wrong answer: a
    // resurfaced 2023/2025 wildfire story was presented as happening today.
    expect(SHARED_AI_RULES).toContain('NEWS FRESHNESS');
    expect(SHARED_AI_RULES).toContain('DATE-VERIFY CURRENT EVENTS');
    expect(SHARED_AI_RULES).toContain('resurface');
    expect(SHARED_AI_RULES).toContain('"dated today"');
    expect(SHARED_AI_RULES).toContain('do not anchor on the premise');
  });

  it('SHARED_AI_RULES carries the LOCATION-AWARE place-query rule (ticket ff16191f / user ticket 711aa37f)', () => {
    // Regression guard for the 2026-08-10 "Skechers in Mayfair Mall" miss: the
    // user is in Victoria BC but the assistant answered for Mayfair Mall in
    // Milwaukee WI — the model did not APPLY the known locale from memory facts.
    expect(SHARED_AI_RULES).toContain('LOCATION-AWARE PLACE QUERIES');
    expect(SHARED_AI_RULES).toContain("resolve it against the USER'S known location FIRST");
    expect(SHARED_AI_RULES).toContain('ask which city/area they mean BEFORE answering');
    // The rule must live inside the guidelines block, beside TRAINING DATA HONESTY.
    const honestyIdx = SHARED_AI_RULES.indexOf('TRAINING DATA HONESTY');
    const locationIdx = SHARED_AI_RULES.indexOf('LOCATION-AWARE PLACE QUERIES');
    const closeIdx = SHARED_AI_RULES.indexOf('[/CRITICAL AI RESPONSE GUIDELINES]');
    expect(honestyIdx).toBeGreaterThan(-1);
    expect(locationIdx).toBeGreaterThan(honestyIdx);
    expect(locationIdx).toBeLessThan(closeIdx);
  });

  it('DIGBY_PLATFORM_IDENTITY is a non-empty wrapped block naming Digby and its integrations', () => {
    expect(typeof DIGBY_PLATFORM_IDENTITY).toBe('string');
    expect(DIGBY_PLATFORM_IDENTITY.length).toBeGreaterThan(500);
    expect(DIGBY_PLATFORM_IDENTITY).toContain('[DIGBY PLATFORM IDENTITY — YOU ARE DIGBY]');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('You are Digby, an AI assistant at digby.example.com');
    for (const name of ['Google Workspace', 'Xero Accounting', 'Plaid Banking', 'Slack', 'Asana', 'Telegram']) {
      expect(DIGBY_PLATFORM_IDENTITY).toContain(name);
    }
    expect(DIGBY_PLATFORM_IDENTITY).toContain('[/DIGBY PLATFORM IDENTITY]');
  });

  it('DIGBY_PLATFORM_IDENTITY describes the CURRENT product (2026-09-26 compute-policy rewrite): Auto default, Dig deeper, no depth setting, every integration, the platform surfaces', () => {
    // The retired tiers (the fast single-model L1 died 2026-06-21) must never
    // be advertised again — the model repeated "4 thinking levels" to users.
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('4 thinking levels');
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('Single (fastest)');
    // 2026-09-26 (audit docs-drift-5): the per-chat patience picker left the
    // composer — the block must not advertise it, and must name the real
    // control (Dig deeper). Ticket c99b404a (2026-10-27): the Account →
    // Advanced TAB was removed outright, so the block no longer names it.
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('picks one per chat');
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('PATIENCE LEVELS');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('Auto (the default for every chat)');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('Dig deeper');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('Sign in for a deeper look');
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('Account → Advanced');
    // roster 2026-10-06 B-3: the Advanced radios are gone; c99b404a: the tab
    // itself is gone — the block names no depth SETTING any more.
    expect(DIGBY_PLATFORM_IDENTITY).toContain('There is no depth setting: Digby picks depth and models per message');
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('Default depth (Auto / 1 Quick / 2 Ensemble / 3 Research)');
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('default depth in Account → Advanced');
    for (const shape of ['Quick', 'Ensemble', 'Deep Research']) {
      expect(DIGBY_PLATFORM_IDENTITY).toContain(shape);
    }
    expect(DIGBY_PLATFORM_IDENTITY).toContain('full-peer model cross-checking');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('research council');
    // The Dig deeper bullet must sit INSIDE the capabilities list the :388
    // "answer from the above" rule scopes, not only in the header paragraph.
    const capsIdx = DIGBY_PLATFORM_IDENTITY.indexOf('OTHER CAPABILITIES:');
    const ruleIdx = DIGBY_PLATFORM_IDENTITY.indexOf('IMPORTANT: When asked about your capabilities');
    const digIdx = DIGBY_PLATFORM_IDENTITY.indexOf('• Dig deeper —');
    expect(digIdx).toBeGreaterThan(capsIdx);
    expect(digIdx).toBeLessThan(ruleIdx);
    // Integrations that were missing from the list until this refresh.
    for (const name of ['GitHub', 'X (Twitter)', 'iMessage', 'Telegram']) {
      expect(DIGBY_PLATFORM_IDENTITY).toContain(name);
    }
    expect(DIGBY_PLATFORM_IDENTITY).toContain('PUBLIC reads work for everyone');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('notify_user');
    // Platform surfaces the model can OPERATE for the user.
    for (const s of ['Digby Code', 'Schedules & recurring runs', 'Fleet Supervisor', 'Persistent memory', 'knowledge bases (RAG)', 'Canvas/Artifacts', 'Public share links', 'browser_task', 'headless local browser', 'Voice input', 'PWA']) {
      expect(DIGBY_PLATFORM_IDENTITY).toContain(s);
    }
    // Topic feeds were retired 2026-10-20 (ticket 43c24152): the identity block
    // must never advertise them again — digests are scheduled prompts now.
    expect(DIGBY_PLATFORM_IDENTITY).not.toContain('Topic feeds');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('topic digests');
    expect(DIGBY_PLATFORM_IDENTITY).toContain('You OPERATE these for the user through your platform tools — see the playbook in your instructions.');
    // Prompt-cost ceiling: the refresh was capped at the old block's length + 40% (3,151 → 4,411);
    // raised to 4,900 on 2026-09-09 for the Computer-use bullet (computer_task — the user's real
    // Mac screen/apps; the model must know the capability exists to ever use it).
    // Raised to 5,200 on 2026-09-26 for the DEPTH CONTROLS section (Dig deeper +
    // Account → Advanced replacing the retired per-chat picker; +276 chars).
    expect(DIGBY_PLATFORM_IDENTITY.length).toBeLessThanOrEqual(5_200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildModelContextBlock — rewritten 2026-09-03 (owner wave): must describe the
// LIVE lineup (kimi-k3 orchestrator everywhere; deepseek-flash full-peer L2
// cross-checker; glm-5.3 + deepseek-flash L3 council) and never the retired
// pre-cutover architecture. These pins are the drift guard for that.
// ═════════════════════════════════════════════════════════════════════════════
describe('buildModelContextBlock (2026-09-03 lineup)', () => {
  it('L1 names Kimi K3 as the sole model', () => {
    const b = buildModelContextBlock('single_thinking', 'open_source');
    expect(b).toContain('Kimi K3');
    expect(b).toContain('sole responding model');
  });
  it('L2 names the two-agent ensemble: Kimi K3 orchestrator + DeepSeek V4.1 Flash peer', () => {
    const b = buildModelContextBlock('thinking', 'open_source');
    expect(b).toContain('Kimi K3');
    expect(b).toContain('DeepSeek V4.1 Flash');
    // The retired seat model must not be named — the checker introduced itself
    // as "DeepSeek V4 Pro" to users after the 2026-09-10 cutover because of this block.
    expect(b).not.toContain('V4 Pro');
    expect(b).not.toContain('GLM-5.2');
  });
  it('L3 names the council: GLM-5.3 + DeepSeek V4.1 Flash under a Kimi K3 lead', () => {
    const b = buildModelContextBlock('deep_research', 'open_source');
    expect(b).toContain('GLM-5.3');
    expect(b).toContain('DeepSeek V4.1 Flash');
    expect(b).not.toContain('V4 Pro');
    expect(b).toContain('Kimi K3');
  });
  it('legacy modes alias forward; modelSet no longer branches', () => {
    expect(buildModelContextBlock('single', 'frontier')).toBe(buildModelContextBlock('single_thinking', 'open_source'));
    expect(buildModelContextBlock('fast', 'frontier')).toBe(buildModelContextBlock('single_thinking', 'open_source'));
    expect(buildModelContextBlock('deep_research_all', 'frontier')).toBe(buildModelContextBlock('deep_research', 'open_source'));
    expect(buildModelContextBlock('thinking', 'frontier')).toBe(buildModelContextBlock('thinking', 'open_source'));
  });
  it('never mentions any retired model id', () => {
    for (const mode of ['single_thinking', 'thinking', 'deep_research']) {
      const b = buildModelContextBlock(mode, 'open_source');
      for (const dead of ['GLM-5.2', 'GPT-5.5', 'GPT-5.4', 'Grok-4.3', 'Gemini 3.1', 'K2.6']) {
        expect(b).not.toContain(dead);
      }
    }
  });
});
