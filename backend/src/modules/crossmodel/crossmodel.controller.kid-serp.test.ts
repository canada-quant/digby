/**
 * Digby Kids SERP bounding (feedback ticket 5e84448a) — run-level pin for
 * streamQuery's kid branch: the BrightData SERP must pass through the REAL
 * boundSerpForContext choke point (chat-agent/serp-bound.ts, ticket ba968a07)
 * BEFORE it reaches streamKidResponse's model context. Pre-fix the raw
 * 30-80KB blob — search-engine junk hosts, duplicate URL mentions, unbounded
 * length — was injected VERBATIM into the child-facing system prompt.
 *
 * The mock streamKidResponse boundary captures EXACTLY what the kid model
 * would have seen, so the assertions are on the wire, not on internals:
 * bounded (≤ SERP_BOUND_MAX_CHARS, ≤ SERP_BOUND_MAX_RESULTS URLs), deduped,
 * junk-host-free, truncation noted. Reverting the controller one-liner makes
 * every one of them fail (the raw blob fails all four).
 *
 * serp-bound itself is NOT mocked — the point is the real choke point.
 * Everything else on the controller's import graph is a mocked boundary
 * (config/env exits the process at import — per .digby/notes/learnings.md).
 * No chatId: the history load/save and chat-capability branches are
 * chatId-gated and stay out of scope (one concern per test).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUser = jest.fn();
const mockChatFindUnique = jest.fn();
const mockMsgFindMany = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUser(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    crossModelMessage: { findMany: (...a: any[]) => mockMsgFindMany(...a) },
  },
}));

jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
// streamQuery ALWAYS assembles the attachment slot (empty uploadIds → null) —
// combineAttachments must exist even though no upload is staged.
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));

const mockStreamKidResponse = jest.fn();
const mockGenerateKidStatus = jest.fn();
jest.mock('./integrations/qwen-kid.integration', () => ({
  streamKidResponse: (...a: any[]) => mockStreamKidResponse(...a),
  generateKidStatus: (...a: any[]) => mockGenerateKidStatus(...a),
}));
const mockSearch = jest.fn();
jest.mock('./mcp-search', () => ({ searchWithBrightData: (...a: any[]) => mockSearch(...a) }));

jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));

import controller from './crossmodel.controller';
import { SERP_BOUND_MAX_CHARS, SERP_BOUND_MAX_RESULTS } from './chat-agent/serp-bound';

/**
 * Raw BrightData-shaped SERP: 12 distinct citation-worthy results (over the
 * 8-result cap) + search-engine/vendor junk hosts + the first result
 * mentioned THREE times (anchor, bare repeat, cached echo) — the exact
 * flooding shape ticket 5e84448a reported.
 */
const FIRST_URL = 'https://www.space.com/why-is-the-sky-blue';
const REAL: Array<[string, string, string]> = [
  [FIRST_URL, 'Why Is the Sky Blue? | Space', 'Sunlight scatters off molecules in the atmosphere; blue wavelengths scatter the most in every direction, so the whole daytime sky appears blue to our eyes wherever we look up.'],
  ['https://www.noaa.gov/jetstream/sky-color', 'NOAA JetStream explainer', 'Rayleigh scattering describes how gas molecules deflect shorter wavelengths of visible light far more strongly than the longer red wavelengths as sunlight crosses the open atmosphere overhead.'],
  ['https://www.scientificamerican.com/article/why-is-the-sky-blue', 'Scientific American', 'As sunlight moves through the air it bumps into oxygen and nitrogen molecules; those tiny particles scatter violet and blue light in every direction across the whole sky dome all day.'],
  ['https://www.britannica.com/science/sky-blue-color', 'Britannica: sky colour', 'The sky appears blue because of the way the atmosphere interacts with sunlight, scattering shorter blue wavelengths far more than the longer red and orange ones during the daylight hours.'],
  ['https://www.livescience.com/why-sky-blue', 'Live Science', 'Visible light is a spectrum of wavelengths and air molecules are much smaller than those wavelengths, so they preferentially scatter the blue end of the spectrum across the sky overhead.'],
  ['https://www.weather.gov/explain-sky', 'weather.gov explainer', 'On a clear day the whole dome glows blue because scattered sunlight arrives from every direction at once; at sunset the longer path through the air leaves mostly red and orange hues behind.'],
  ['https://phys.org/news/sky-blue-rayleigh', 'Phys.org on Rayleigh', 'Lord Rayleigh quantified the inverse fourth-power law: the intensity of scattered light scales with the inverse fourth power of its wavelength as it travels through a clear gaseous medium.'],
  ['https://www.nasa.gov/sky-color-kids', 'NASA Space Place', 'Light travels in waves and different colors have different wavelengths; blue and violet waves are shorter and get bounced around far more by the air molecules all around us every day.'],
  ['https://www.natgeokids.com/sky-blue', 'Nat Geo Kids', 'The atmosphere acts like a giant field of tiny particles, spreading blue light everywhere so no matter where you look overhead that color reaches your eyes first during the daytime.'],
  ['https://www.exploratorium.edu/sky-blue', 'Exploratorium exhibit', 'A beam through a tank of milky water shows the same effect: from the side it glows blue while straight through it looks orange, a tabletop model of exactly what our sky does.'],
  ['https://www.optics4kids.org/sky', 'Optics4Kids', 'Polarization joins scattering in the upper atmosphere, which is why the patch of sky ninety degrees away from the sun looks the deepest blue through a pair of polarized sunglasses.'],
  ['https://www.metoffice.gov.uk/sky-blue', 'Met Office learning', 'Violet light actually scatters even more strongly than blue, but the sun emits less of it and our eyes are less sensitive to it, so we end up perceiving the sky as blue instead.'],
];
const RAW_SERP = [
  'Google Search results — why is the sky blue',
  `Related: https://www.google.com/search?q=why+is+the+sky+red+at+sunset`,
  `Shop: https://www.bing.com/search?q=blue+sky+poster`,
  `Forums: https://duckduckgo.com/?q=sky+color`,
  `Vendor docs: https://docs.brightdata.com/scraping-browser/introduction`,
  ...REAL.map(([url, label, snippet]) => `[${label}](${url}) ${snippet}`),
  `Bare repeat: ${FIRST_URL}`,
  `Cached echo ${FIRST_URL} — same page again`,
].join('\n');

const mkReq = (): any => ({
  query: { message: 'Why is the sky blue?', mode: 'single_thinking', webSearch: 'true' },
  user: { id: 'kid-1' },
  on: jest.fn(),
});
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    frames: [] as string[],
    writableEnded: false,
    headersSent: false,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    cookie: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const sseEvents = (res: any) =>
  res.frames.filter((f: string) => f.startsWith('data: ')).map((f: string) => JSON.parse(f.slice(6)));

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUser.mockResolvedValue({ isChild: true, childAge: 9, childGuardrails: null });
  mockChatFindUnique.mockResolvedValue(null);
  mockMsgFindMany.mockResolvedValue([]);
  mockSearch.mockResolvedValue(RAW_SERP);
  // generateKidStatus is .then-chained in the handler — it MUST return a promise.
  mockGenerateKidStatus.mockResolvedValue(null);
  mockStreamKidResponse.mockImplementation(async (_m: any, _o: any, onDelta: any) => {
    onDelta?.('Blue light bounces around the most! ');
    return { text: 'Blue light bounces around the most! ' };
  });
});

describe('streamQuery kid path — SERP grounding is bounded (ticket 5e84448a)', () => {
  // Self-host 2026-10-20: the kid path runs its search only when a search backend
  // is configured — pin the bounded-SERP behaviour with one present.
  const prevToken = process.env.BRIGHTDATA_API_TOKEN;
  beforeEach(() => { process.env.BRIGHTDATA_API_TOKEN = 'test-token'; });
  afterEach(() => { if (prevToken !== undefined) process.env.BRIGHTDATA_API_TOKEN = prevToken; else delete process.env.BRIGHTDATA_API_TOKEN; });

  it('passes the SERP through the real boundSerpForContext before streamKidResponse', async () => {
    const res = mkRes();
    const next = jest.fn();
    await controller.streamQuery(mkReq(), res, next);

    // ── The model-context wire: exactly one kid call, and what it carried ──
    expect(mockStreamKidResponse).toHaveBeenCalledTimes(1);
    const opts = mockStreamKidResponse.mock.calls[0][1];
    const webContext: string = opts.webContext;

    // Bounded: hard char cap, and never MORE URLs than the result cap.
    expect(webContext.length).toBeLessThanOrEqual(SERP_BOUND_MAX_CHARS);
    expect(webContext.length).toBeLessThan(RAW_SERP.length); // bounding actually shrank it
    expect((webContext.match(/https?:\/\//g) || []).length).toBeLessThanOrEqual(SERP_BOUND_MAX_RESULTS);

    // Junk-host-free: search-engine pages + the vendor doc host never reach the child.
    expect(webContext).not.toMatch(/google\.com|bing\.com|duckduckgo\.com|brightdata\.com/);

    // Real grounding survived, deduped to a single mention, caps noted.
    expect(webContext).toContain(FIRST_URL);
    expect(webContext.match(new RegExp(FIRST_URL.replace(/[/.]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(webContext).toContain('[... truncated');

    // ── The SSE wire: kids mode announced, answer streamed, clean close ──
    const events = sseEvents(res);
    expect(events[0]).toEqual({ type: 'init', data: { mode: 'kids', webSearch: true } });
    const complete = events.find((e: any) => e.type === 'complete');
    expect(complete?.data?.models?.qwen_kid?.webSearchUsed).toBe(true);
    expect(complete?.data?.summary).toContain('Blue light bounces');
    expect(res.writableEnded).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('a failed search degrades to empty grounding, never a dead stream', async () => {
    mockSearch.mockRejectedValueOnce(new Error('brightdata down'));
    const res = mkRes();
    const next = jest.fn();
    await controller.streamQuery(mkReq(), res, next);

    expect(mockStreamKidResponse).toHaveBeenCalledTimes(1);
    expect(mockStreamKidResponse.mock.calls[0][1].webContext).toBe('');
    const complete = sseEvents(res).find((e: any) => e.type === 'complete');
    expect(complete?.data?.models?.qwen_kid?.webSearchUsed).toBe(false);
    expect(res.writableEnded).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});
