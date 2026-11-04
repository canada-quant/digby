/**
 * moonshot.integration generateTitle — local-fallback hardening (2026-08-08,
 * feedback 0222d8f9 "chat title not working again").
 *
 * Prod telemetry showed recurring 'generateTitle: deepseek-v4-flash returned
 * empty content, using local fallback' warns; the raw-question fallback then
 * became the sidebar title verbatim — including an embedded email address.
 * These tests pin the fallback's email stripping (and the pre-existing UUID
 * stripping) by forcing the LLM chain to return empty content.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// utilityChat returns '' → generateTitle takes the local-fallback path.
jest.mock('../../../utils/utility-llm', () => ({
  utilityChat: jest.fn().mockResolvedValue(''),
  UTILITY_MODEL_NAME: 'deepseek-flash',
  sanitizeStatusLine: (s: string) => s,
}));

// Heavy module-graph boundaries (not exercised by generateTitle's fallback
// path) — mocked so the import graph never reaches config/env at import time.
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(),
  SEARCH_UNAVAILABLE_NOTE: '',
}));
jest.mock('../tool-executor', () => ({
  ToolCache: jest.fn(),
  TOOL_DEFINITIONS: [],
  processToolCalls: jest.fn(),
}));

// generateGhostTitle's endpoint leg resolves the spec's provider through the
// coding-model seam and posts via helper-completion — both mocked here so the
// unit tests stay off the network and can pin the privacy property (the
// utilityChat CLOUD chain is never called for a ghost title). (mock-prefixed:
// jest.mock factories may only reference out-of-scope vars with that prefix.)
const mockGhostProvider: any = { url: 'https://ghost.example/v1/chat/completions', model: 'abliterated-llama-70b', apiKey: 'k', label: 'homelab (custom endpoint)', extra: {}, omitParams: [] };
const mockGhostPost: jest.Mock = jest.fn(async (..._args: any[]) => ({ data: { choices: [{ message: { content: 'A Ghost Endpoint Title' }, finish_reason: 'stop' }] } }));
jest.mock('../coding/coding-model', () => ({
  resolveProviderForRun: jest.fn(async () => mockGhostProvider),
}));
jest.mock('../coding/helper-completion', () => ({
  postNonStreamingCompletion: (p: any, payload: any) => mockGhostPost(p, payload),
  extractNonStreamingAnswer: (choice: any) => {
    const raw = String(choice?.message?.content ?? '');
    return { text: raw.trim(), hadReasoning: false, finishReason: choice?.finish_reason ?? null };
  },
}));

import moonshotIntegration from './moonshot.integration';

describe('generateTitle local fallback (LLM chain empty)', () => {
  it('strips email addresses from the raw-question fallback title', async () => {
    const title = await moonshotIntegration.generateTitle(
      'get all recent emails from reedsmith from paul@example.com please',
      ''
    );
    expect(title).not.toContain('@');
    expect(title).not.toContain('example.com');
    expect(title.toLowerCase()).toContain('get all recent emails');
  });

  it('still strips UUIDs from the fallback title (pre-existing behavior)', async () => {
    const title = await moonshotIntegration.generateTitle(
      'summarize doc 627a12d9-aaaa-bbbb-cccc-1234567890ab for me',
      ''
    );
    expect(title).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(title.toLowerCase()).toContain('summarize doc');
  });

  it('returns New Conversation for an email-only question instead of leaking it', async () => {
    // Reviewer catch: with the whole question stripped, the last-resort path
    // must not fall back to the RAW question (that would re-leak the email).
    const title = await moonshotIntegration.generateTitle('paul@example.com', '');
    expect(title).not.toContain('@');
    expect(title).toBe('New Conversation');
  });

  it('handles long @-laden dot-free input without hanging (ReDoS guard)', async () => {
    // Reviewer-measured: the unbounded /\S+@\S+\.\S+/g did not finish in >5min
    // on this shape. The bounded input + bounded-class regex must complete
    // well inside jest's default 5s timeout.
    const title = await moonshotIntegration.generateTitle('a@'.repeat(5000), '');
    expect(typeof title).toBe('string');
  });
});

// ── generateGhostTitle (ticket de60115d, 2026-10-23 — "ghost mode chat title
// not working"): the ghost chat gets the same title lifecycle WITHOUT the
// cloud utility chain. Endpoint leg when a designation is live, hardened
// local cleaner otherwise. Pinned here at the unit seam. ────────────────────
describe('generateGhostTitle (ticket de60115d) — never a cloud title', () => {
  const utilityChatMock = require('../../../utils/utility-llm').utilityChat as jest.Mock;

  beforeEach(() => {
    utilityChatMock.mockClear();
    mockGhostPost.mockClear();
    mockGhostPost.mockImplementation(async () => ({ data: { choices: [{ message: { content: 'A Ghost Endpoint Title' }, finish_reason: 'stop' }] } }));
  });

  it('no designation (spec null) → the LOCAL cleaner only, no endpoint post, no cloud call', async () => {
    const title = await moonshotIntegration.generateGhostTitle('How do I ferment kimchi safely at home', '', null);
    expect(title).toBe('How do I ferment kimchi safely at home'.substring(0, 60));
    expect(mockGhostPost).not.toHaveBeenCalled();
    expect(utilityChatMock).not.toHaveBeenCalled();
  });

  it('a live designation → ONE post to the designated endpoint, the title is its answer', async () => {
    const title = await moonshotIntegration.generateGhostTitle('How do I ferment kimchi safely at home', '', 'homelab:abliterated-llama-70b');
    expect(title).toBe('A Ghost Endpoint Title');
    expect(mockGhostPost).toHaveBeenCalledTimes(1);
    // The privacy property: the endpoint leg posts to the DESIGNATED
    // endpoint's url and model, and the cloud utility chain is never called.
    const [provider, payload] = mockGhostPost.mock.calls[0];
    expect(provider.url).toBe('https://ghost.example/v1/chat/completions');
    expect(provider.model).toBe('abliterated-llama-70b');
    expect(String(payload.messages[1].content)).toContain('How do I ferment kimchi safely at home');
    expect(utilityChatMock).not.toHaveBeenCalled();
  });

  it('the endpoint failing (throw / empty / reasoning-shaped) falls back LOCAL, never cloud', async () => {
    // throw
    mockGhostPost.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED'); });
    let t = await moonshotIntegration.generateGhostTitle('Question about sourdough starters here', '', 'homelab:abliterated-llama-70b');
    expect(t).toBe('Question about sourdough starters here'.substring(0, 60));
    // empty content
    mockGhostPost.mockImplementationOnce(async () => ({ data: { choices: [{ message: { content: '' } }] } }));
    t = await moonshotIntegration.generateGhostTitle('Question about sourdough starters here', '', 'homelab:abliterated-llama-70b');
    expect(t).toBe('Question about sourdough starters here'.substring(0, 60));
    // reasoning-shaped output (the _looksLikeReasoning guard)
    mockGhostPost.mockImplementationOnce(async () => ({ data: { choices: [{ message: { content: 'We need to generate a title based on the question and answer provided above' } }] } }));
    t = await moonshotIntegration.generateGhostTitle('Question about sourdough starters here', '', 'homelab:abliterated-llama-70b');
    expect(t).toBe('Question about sourdough starters here'.substring(0, 60));
    expect(utilityChatMock).not.toHaveBeenCalled();
  });

  it('a spec that resolves to a BUILT-IN provider is refused → local fallback (never a cloud model)', async () => {
    const { resolveProviderForRun } = require('../coding/coding-model');
    const resolve = resolveProviderForRun as jest.Mock;
    resolve.mockImplementationOnce(async () => ({ ...mockGhostProvider, label: 'Kimi (built-in)' }));
    const title = await moonshotIntegration.generateGhostTitle('Another question about bread baking', '', 'homelab:abliterated-llama-70b');
    expect(title).toBe('Another question about bread baking'.substring(0, 60));
    expect(mockGhostPost).not.toHaveBeenCalled();
    expect(utilityChatMock).not.toHaveBeenCalled();
  });

  it('the local cleaner strips PII exactly like generateTitle (email/UUID)', async () => {
    const title = await moonshotIntegration.generateGhostTitle('get emails from paul@example.com about doc 627a12d9-aaaa-bbbb-cccc-1234567890ab', '', null);
    expect(title).not.toContain('@');
    expect(title).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
