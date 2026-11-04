/**
 * profile-extraction-guard.test.ts — the 2026-10-20 profile parse_error bursts.
 *
 * PROD (admin error logs, `memory-audit: extraction parse_error (profile) for <userId> after ~7000 ms:
 * { "summary": "…`): 31 rows 2026-10-06 22:00–23:59Z, 34 rows 2026-10-12 00:00Z, 23 rows in ~2 min
 * 2026-10-20 11:24Z for ONE user (the shared prod test account), each ~6.7–7.2 s — the time the
 * utility model takes to spend the whole 1800-token output budget.
 *
 * Root cause, two halves, both reproduced here through the REAL pipeline (runUpdateContextPipeline)
 * with the REAL parser + salvage (memory-audit is not mocked) and a model simulator that does what the
 * logged rows show — re-emits the profile it was SHOWN, merges the turn in, and is cut at the budget:
 *  (1) TRUNCATION TREADMILL — the profile leg re-emits the WHOLE profile object every call and
 *      nothing bounds its fields ("summary (1 line)" was a hint, never enforced). The profile
 *      accretes until the echo outgrows the budget (900 → 1800 bumps bought days each). Once the cut
 *      lands inside the FIRST field the f171 salvage has nothing complete to keep, so nothing is saved
 *      — and a profile that is never saved never shrinks: every later call for that user fails the
 *      same way. Fix: the profile is bounded (memory/profile-guard.ts PROFILE_FIELD_CAPS) — the model
 *      is shown a clamped profile, told the per-field limits, and the saved profile is clamped, so the
 *      echo always fits and an already-oversized stored profile heals on its next extraction.
 *  (2) TRIGGER STORM — the profile is per USER but its debounce is per CHAT (`messageCount <= 6`
 *      always runs), so every fresh chat's first turns re-ran the same doomed re-emission (23 chats ⇒
 *      23 calls). Fix: a per-user in-process throttle — one profile extraction in flight per user, a
 *      cooldown after it, a longer backoff after a failure; explicit rejections bypass it; the turn's
 *      flat facts still run.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockUpsert: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) },
    crossModelChat: { findMany: jest.fn(async () => []) },
    crossModelMessage: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), get: jest.fn(async () => null) },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(async () => ({ conversationHistory: [] })), getUserMemoryBlock: jest.fn(async () => '') },
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));

const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));

jest.mock('../memory/unified-memory.service', () => ({ memStore: jest.fn(), enforceScopeCap: jest.fn(async () => {}) }));
jest.mock('../memory/user-facts.service', () => ({ selectRelevantFacts: jest.fn(), syncUserFactRows: jest.fn() }));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({ filterFactsByRelevance: jest.fn(), isTextRelevantToMessage: jest.fn() }));
const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));
// The leaf telemetry sink only — memory-audit (recordExtractionOutcome, parseModelJson,
// salvageTruncatedJson) runs for real, so the rows below are what prod would record.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_EXTRACTION: 'memory_extraction', USER_MEMORY_MUTATION: 'user_memory_mutation' },
}));

import { runUpdateContextPipeline, PROFILE_EXTRACTION_BUDGET_TOKENS } from './memory.graph';
import { resetProfileExtractionThrottle } from '../memory/profile-guard';

// ── the model simulator ─────────────────────────────────────────────────────────
/** ~4 chars per output token (English prose through DeepSeek's tokenizer). */
const CHARS_PER_TOKEN = 4;
const PROFILE_PROMPT_HEAD = 'You are analyzing a conversation to maintain a user profile';
const SHOWN_PROFILE_RE = /Current user profile:\n([\s\S]*?)\n\nCurrent existing facts:/;
/** Ops mode (2026-10-20 per-item ops): the profile is rendered as `field (at most N characters): value` lines. */
const OPS_PROFILE_RE = /Current user profile \(each topic has an \[id\]\):\n([\s\S]*?)\n\nCurrent existing facts:/;
const isOpsPrompt = (prompt: string) => OPS_PROFILE_RE.test(prompt);

let profilePrompts: string[] = [];
let profileAnswer: 'echo' | 'garbage' = 'echo';

/** The shown profile, parsed back out of the prompt ('(none yet)' ⇒ null). */
function shownProfile(prompt: string): any {
  const ops = prompt.match(OPS_PROFILE_RE);
  if (ops) {
    const field = (name: string) => {
      const line = ops[1].split('\n').find((l) => l.startsWith(`${name} (at most`));
      const v = line ? line.slice(line.indexOf('): ') + 3) : '';
      return v === '(empty)' ? '' : v;
    };
    const topics = [...ops[1].matchAll(/^ {2}\[T\d+\] (.*)$/gm)].map((x) => x[1]);
    return { summary: field('summary'), preferences: field('preferences'), currentFocus: field('currentFocus'), recentTopics: topics, communicationStyle: field('communicationStyle') };
  }
  const m = prompt.match(SHOWN_PROFILE_RE);
  if (!m || m[1].trim() === '(none yet)') return null;
  return JSON.parse(m[1]);
}

/** Re-emit the shown profile with this turn merged in — the accretion the prod tails show — cut at the budget. */
function simulateProfileAnswer(prompt: string, opts: any): string {
  if (profileAnswer === 'garbage') return 'I could not produce a profile update for this exchange.';
  const p = shownProfile(prompt) ?? { summary: '', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' };
  // Ops prompt: the model answers only the change — it still accretes into the summary it rewrites.
  const out = isOpsPrompt(prompt) ? JSON.stringify({
    set: { summary: `${p.summary} Asked about tide pools near Halifax.`.trim(), ...(p.preferences ? {} : { preferences: 'Prefers short answers.' }), ...(p.communicationStyle ? {} : { communicationStyle: 'direct' }) },
    ...((p.recentTopics ?? []).includes('tide pools') ? {} : { add: { recentTopics: ['tide pools'] } }),
  }) : JSON.stringify({
    summary: `${p.summary} Asked about tide pools near Halifax.`.trim(),
    preferences: p.preferences || 'Prefers short answers.',
    currentFocus: p.currentFocus,
    recentTopics: [...(p.recentTopics ?? []), 'tide pools'].slice(-5),
    communicationStyle: p.communicationStyle || 'direct',
  }, null, 2);
  const cap = (opts?.maxTokens ?? 512) * CHARS_PER_TOKEN;
  opts?.onMeta?.({ leg: 'deepseek', model: 'deepseek-flash', finishReason: out.length > cap ? 'length' : 'stop' });
  return out.slice(0, cap);
}

function routeUtility(messages: Array<{ content: string }>, opts: any): Promise<string> {
  const prompt = messages[0].content;
  if (prompt.startsWith(PROFILE_PROMPT_HEAD)) {
    profilePrompts.push(prompt);
    return Promise.resolve(simulateProfileAnswer(prompt, opts));
  }
  if (prompt.startsWith('You are a memory manager')) return Promise.resolve('{"add": {}, "remove": [], "reject": []}');
  if (prompt.startsWith('You are maintaining a conversation thread summary')) {
    return Promise.resolve('{"threadSummary": "t", "confirmedFacts": {}, "openTopics": [], "lastUserGoal": "g"}');
  }
  return Promise.resolve('{}');
}

// ── store fixture: one profile per user ─────────────────────────────────────────
let profiles: Record<string, any> = {};
const flatFactCalls = () => mockUtilityChat.mock.calls.filter((c: any[]) => String(c[0][0].content).startsWith('You are a memory manager')).length;
const profileRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'memory_extraction' && r.meta.source === 'profile');

/** A runaway stored profile: the summary alone is longer than the whole output budget can echo. */
function runawayProfile() {
  const sentence = 'User asked about aquarium research programs, Calgary weather and travel itineraries. ';
  return {
    summary: sentence.repeat(Math.ceil((PROFILE_EXTRACTION_BUDGET_TOKENS * CHARS_PER_TOKEN * 1.25) / sentence.length)).trim(),
    preferences: 'Prefers bulleted lists and day-by-day itineraries. '.repeat(30).trim(),
    currentFocus: '',
    recentTopics: ['aquariums', 'Calgary', 'itineraries'],
    communicationStyle: 'detailed, prefers bulleted lists and short social media captions',
  };
}

const turn = (userId: string, chatId: string, userMessage = 'Can you suggest a few good tide pools to visit near Halifax this weekend?') =>
  runUpdateContextPipeline({ userId, projectId: null, chatId, userMessage, synthesis: 'Here are three tide pools worth a visit.' } as any);

let clock = Date.parse('2026-10-20T11:24:00Z');
beforeEach(() => {
  jest.clearAllMocks();
  resetProfileExtractionThrottle();
  profilePrompts = [];
  profileAnswer = 'echo';
  profiles = {};
  delete process.env.PROFILE_FIELD_CAPS_DISABLED;
  delete process.env.PROFILE_EXTRACT_THROTTLE_DISABLED;
  delete process.env.MEMORY_STATE_OPS_DISABLED;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  mockFindUnique.mockResolvedValue({ facts: {} });
  mockUpsert.mockResolvedValue({ facts: {} });
  mockStoreGet.mockImplementation(async (ns: string[], key: string) => (key === 'contextState' ? profiles[ns[0]] ?? null : null));
  mockStorePut.mockImplementation(async (ns: string[], key: string, value: any) => { if (key === 'contextState') profiles[ns[0]] = value; });
  mockUtilityChat.mockImplementation(routeUtility);
});
afterEach(() => { jest.restoreAllMocks(); clock += 60 * 60_000; });

describe('profile extraction — truncation treadmill (root cause 1)', () => {
  it('a stored profile whose summary outgrew the output budget no longer parse_errors — the call succeeds and the saved profile is bounded', async () => {
    profiles['u-runaway'] = runawayProfile();
    await turn('u-runaway', 'c-1');
    const rows = profileRows();
    expect(rows).toHaveLength(1);
    // Before the fix: outcome 'parse_error' (cut inside the summary — nothing for the salvage to keep).
    expect(rows[0].meta.outcome).toBe('changed');
    expect(rows[0].meta.finishReason).toBe('stop');
    const saved = profiles['u-runaway'];
    expect(saved.summary.length).toBeLessThanOrEqual(300);
    expect(saved.preferences.length).toBeLessThanOrEqual(500);
    expect(saved.recentTopics).toContain('tide pools');
    // the model was SHOWN the bounded profile, and told the limits
    const shown = shownProfile(profilePrompts[0]);
    expect(shown.summary.length).toBeLessThanOrEqual(300);
    expect(profilePrompts[0]).toMatch(/at most 300 characters/);
  });

  it('220 turns of accretion never outgrow the budget (the profile stays bounded, every call parses)', async () => {
    for (let i = 0; i < 220; i++) {
      await turn('u-accrete', `c-${i}`);
      clock += 5 * 60_000; // turns minutes apart — outside any per-user cooldown
    }
    const outcomes = profileRows().map((r: any) => r.meta.outcome);
    expect(outcomes).toHaveLength(220);
    // Before the fix: the summary grew ~37 chars a turn (1,109 chars by turn 30); the f171 salvage kept
    // saving it while only a LATER field was cut, and from ~turn 195 — the summary alone past the
    // 1800-token echo — every call was a parse_error and the profile never moved again.
    // Every call parses: 'changed', or 'noop' once the simulated re-add clamps back to identical text (ops mode).
    expect(outcomes.filter((o: string) => o !== 'changed' && o !== 'noop')).toEqual([]);
    expect(profiles['u-accrete'].summary.length).toBeLessThanOrEqual(300);
  });
});

describe('profile extraction — trigger storm (root cause 2)', () => {
  it('23 fresh chats for ONE user at once run ONE profile extraction — and every turn still extracts its flat facts', async () => {
    profiles['u-storm'] = runawayProfile();
    await Promise.all(Array.from({ length: 23 }, (_, i) => turn('u-storm', `storm-${i}`)));
    // Before the fix: 23 profile calls, 23 parse_error rows.
    expect(profilePrompts).toHaveLength(1);
    expect(profileRows()).toHaveLength(1);
    expect(flatFactCalls()).toBe(23);
  });

  it('a failing profile extraction backs off: skipped 2 min later, retried after the backoff', async () => {
    profileAnswer = 'garbage';
    await turn('u-fail', 'f-1');
    expect(profileRows().map((r: any) => r.meta.outcome)).toEqual(['parse_error']);
    clock += 2 * 60_000;
    await turn('u-fail', 'f-2');
    expect(profilePrompts).toHaveLength(1); // still backing off — no wasted call
    expect(flatFactCalls()).toBe(2); // the turn's facts still ran
    clock += 15 * 60_000;
    await turn('u-fail', 'f-3');
    expect(profilePrompts).toHaveLength(2);
  });

  it('the next profile row reports how many turns the throttle skipped since the last run', async () => {
    await turn('u-count', 'k-1');
    await turn('u-count', 'k-2');
    await turn('u-count', 'k-3');
    clock += 2 * 60_000;
    await turn('u-count', 'k-4');
    const rows = profileRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].meta.throttledSkips).toBeUndefined();
    expect(rows[1].meta.throttledSkips).toBe(2);
  });

  it('an explicit rejection bypasses the throttle (wrong facts are purged at once)', async () => {
    await turn('u-reject', 'r-1');
    await turn('u-reject', 'r-2', 'Please stop talking about my knee injury, I am fine now and it is not relevant anymore.');
    expect(profilePrompts).toHaveLength(2);
  });
});

describe('per-item ops (2026-10-20 memory wave)', () => {
  it('the prompt asks for the CHANGES only — no whole-object echo is requested', async () => {
    profiles['u-ops'] = runawayProfile();
    await turn('u-ops', 'p-1');
    expect(profilePrompts[0]).toContain('Return ONLY the CHANGES as one JSON object');
    expect(profilePrompts[0]).toContain('[T1] aquariums');
    expect(profilePrompts[0]).not.toContain('Return ONLY valid JSON matching this structure');
    expect(profileRows()[0].meta.detail).toMatch(/^ops set=1 add=1 upd=0 rm=0/);
  });

  it('{} is a noop: nothing moves, the row says noop (not changed)', async () => {
    profiles['u-noop'] = { summary: 's', preferences: 'p', currentFocus: '', recentTopics: ['x'], communicationStyle: 'c' };
    mockUtilityChat.mockImplementation((m: any[], o: any) => (String(m[0].content).startsWith(PROFILE_PROMPT_HEAD) ? (profilePrompts.push(m[0].content), Promise.resolve('{}')) : routeUtility(m as any, o)));
    await turn('u-noop', 'n-1');
    expect(profileRows()[0].meta.outcome).toBe('noop');
    expect(profiles['u-noop']).toEqual({ summary: 's', preferences: 'p', currentFocus: '', recentTopics: ['x'], communicationStyle: 'c' });
  });

  it('a purge is a set + a remove by id', async () => {
    profiles['u-purge'] = { summary: 'Runner recovering from an ACL injury.', preferences: 'Rehab plans', currentFocus: '', recentTopics: ['ACL rehab', 'marathons'], communicationStyle: 'c' };
    mockUtilityChat.mockImplementation((m: any[], o: any) => (String(m[0].content).startsWith(PROFILE_PROMPT_HEAD)
      ? (profilePrompts.push(m[0].content), Promise.resolve('{"set": {"summary": "Runner.", "preferences": ""}, "remove": ["T1"]}'))
      : routeUtility(m as any, o)));
    await turn('u-purge', 'g-1', 'Please stop talking about my ACL injury, I am fine now and it is not relevant anymore.');
    expect(profiles['u-purge']).toEqual({ summary: 'Runner.', preferences: '', currentFocus: '', recentTopics: ['marathons'], communicationStyle: 'c' });
  });

  it('MEMORY_STATE_OPS_DISABLED=1: the whole-object answer path (with the profile bounds) is back', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    profiles['u-ops-off'] = runawayProfile();
    await turn('u-ops-off', 'q-1');
    expect(profilePrompts[0]).toContain('Return ONLY valid JSON matching this structure');
    expect(profilePrompts[0]).toMatch(/at most 300 characters/);
    expect(profileRows()[0].meta.outcome).toBe('changed'); // the bounds alone fix the runaway profile
  });
});

describe('kill switches restore the previous behaviour', () => {
  it('PROFILE_FIELD_CAPS_DISABLED=1 + MEMORY_STATE_OPS_DISABLED=1: the unbounded profile is shown and the old prompt is sent', async () => {
    process.env.PROFILE_FIELD_CAPS_DISABLED = '1';
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    profiles['u-caps-off'] = runawayProfile();
    await turn('u-caps-off', 'o-1');
    expect(shownProfile(profilePrompts[0]).summary.length).toBeGreaterThan(300);
    expect(profilePrompts[0]).not.toMatch(/at most 300 characters/);
    expect(profilePrompts[0]).toContain('Fields: summary (1 line), preferences, currentFocus, recentTopics (array max 5), communicationStyle');
    expect(profileRows()[0].meta.outcome).toBe('parse_error'); // the original failure, reproduced
  });

  it('PROFILE_EXTRACT_THROTTLE_DISABLED=1: one profile call per eligible turn again', async () => {
    process.env.PROFILE_EXTRACT_THROTTLE_DISABLED = '1';
    await Promise.all(Array.from({ length: 5 }, (_, i) => turn('u-throttle-off', `t-${i}`)));
    expect(profilePrompts).toHaveLength(5);
  });
});
