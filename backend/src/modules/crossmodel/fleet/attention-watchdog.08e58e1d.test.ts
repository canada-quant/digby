/**
 * Ticket 08e58e1d (mishap, 2026-09-17) — REPLAY TEST.
 *
 * Incident: in the Fleet Supervisor chat, two consecutive machine-triggered
 * wakes (~14:27Z and ~14:36Z) died on provider 429 and each persisted the
 * harness's terminal fallback envelope ("Sorry — I couldn't get an answer out
 * this time: the AI provider is rate-limiting requests right now…") as their
 * assistant row — UNDER THE WAKE'S MACHINE ORIGIN (hook/schedule). The
 * attention watchdog's stuck-note backstop then fired: "[WATCHDOG] Your last
 * 3 notes are near-identical — act or stand down." The identical texts were
 * harness-generated error fallbacks, not supervisor-authored wake notes — the
 * detector was scoring the platform's own error text as lane output and
 * demanding the supervisor act / STAND DOWN on text it never wrote.
 *
 * Root cause: scanSupervisorNotes (attention-watchdog.service.ts) selected
 * note rows by metadata.origin ALONE; a provider-killed run's fallback row
 * inherits the wake origin at persist (chat-agent.service.ts finalize), and
 * byte-identical envelopes are Jaccard-1.0 near-identical by construction.
 *
 * Fix (this file pins all three legs):
 *   1. chat-agent finalize stamps metadata.providerError on every
 *      modelErrored row (the deterministic marker);
 *   2. the watchdog note filter excludes rows carrying that marker OR
 *      matching a known harness error envelope (isHarnessErrorNote,
 *      coding/harness-error-notes.ts — the envelope-shape lane covers rows
 *      persisted before the marker existed);
 *   3. the generator↔detector contract: every modelErrorTerminalNote shape
 *      must satisfy isHarnessErrorNote, so a future rewording fails loudly
 *      instead of silently re-admitting error text into the similarity input.
 *
 * Pre-fix, tests 1–3 FAIL (the nudge posts / the envelopes classify); the
 * control (test 4) passes both before and after, proving the backstop itself
 * was never neutered.
 */

// ── Boundary mocks (same pattern as attention-watchdog.service.test.ts) ──────
jest.mock('../platform/supervisor.service', () => ({
  __esModule: true,
  healSupervisorWildcardHook: jest.fn(async () => undefined),
  healSupervisorStockPrompt: jest.fn(async () => false),
  disableOrphanWildcardHooks: jest.fn(async () => 0),
  classifySupervisorNote: jest.fn((c: unknown) => {
    const t = String(c ?? '');
    if (/no-op/i.test(t)) return 'supervisor_noop';
    if (/ACTIONS TAKEN/i.test(t)) return 'supervisor_action';
    return 'supervisor_note';
  }),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
}));
jest.mock('./containment-ladder.service', () => ({
  __esModule: true,
  sweepContainmentLadder: jest.fn(async () => 0),
}));
jest.mock('../platform/goals.service', () => ({
  __esModule: true,
  noteUnbackedOwnerWaitClaim: jest.fn(async () => ({ woken: [] })),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// compaction.ts (imported for the REAL generator in the contract test) pulls
// utility-llm + coding-retrieval — mock both so no env/prisma chain loads.
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => 'RECAP: n/a'),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: jest.fn(async () => 1),
}));

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn() },
  pendingConfirmation: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  crossModelProject: { findMany: jest.fn() },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  crossModelMessage: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

let hashStores: Record<string, Record<string, string>>;
let plainStore: Record<string, string>;
const mockRedis: any = {
  mGet: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  hGetAll: jest.fn(),
  hSet: jest.fn(),
  hDel: jest.fn(),
  expire: jest.fn(),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

jest.mock('../coding/datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'America/Vancouver'),
}));

import { runAttentionWatchdogOnce, STUCK_NUDGE_TEXT } from './attention-watchdog.service';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import { isHarnessErrorNote, EMPTY_RUN_FALLBACK_NOTE } from '../coding/harness-error-notes';
import { modelErrorTerminalNote } from '../coding/compaction';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const SUP = 'sup-chat';
/** Incident afternoon — 2026-09-17 11:00 EDT / 08:00 PDT (NOT quiet hours). */
const T0 = new Date('2026-09-17T15:00:00Z');
const CURSOR_KEY = `attn-watchdog:notecursor:${OWNER}`;

/** The incident envelope, produced by the REAL generator — never a hand-typed
 *  copy that could drift from the code under test. */
const FALLBACK_429 = modelErrorTerminalNote({
  errorStatus: 429,
  transcriptChars: 12_000,
  contextBudget: 4_000_000,
  attempts: 3,
  recoveryLabel: 'backoff-and-retry',
  audience: 'user',
});

/** A machine-wake assistant row (arrays are newest-first, matching the DB). */
const note = (id: string, content: string, minutesAgo: number, origin = 'schedule', extraMeta: any = {}) => ({
  id,
  content,
  createdAt: new Date(T0.getTime() - minutesAgo * 60_000),
  metadata: { origin, ...extraMeta },
});

const nudgePosts = () =>
  mockPrisma.crossModelMessage.create.mock.calls.filter((c: any[]) => c[0].data.metadata?.kind === 'stuck-note-nudge');
const supervisorMetrics = () =>
  (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]).filter((m: any) => String(m?.kind ?? '').startsWith('supervisor'));

beforeEach(() => {
  jest.clearAllMocks();
  hashStores = {};
  plainStore = {};
  mockRedis.hGetAll.mockImplementation(async (key: string) => ({ ...(hashStores[key] ?? {}) }));
  mockRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    (hashStores[key] ??= {})[field] = value;
    return 1;
  });
  mockRedis.hDel.mockImplementation(async (key: string, fields: string[]) => {
    for (const f of fields) delete hashStores[key]?.[f];
    return fields.length;
  });
  mockRedis.expire.mockResolvedValue(true);
  mockRedis.get.mockImplementation(async (k: string) => plainStore[String(k)] ?? null);
  mockRedis.set.mockImplementation(async (k: string, v: string) => { plainStore[String(k)] = String(v); return 'OK'; });
  mockRedis.del.mockImplementation(async (k: string) => { delete plainStore[String(k)]; return 1; });
  mockRedis.mGet.mockResolvedValue([]);
  mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
    return []; // no project-supervisor lanes, no cadence chats in this replay
  });
  mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
  mockPrisma.pendingConfirmation.findUnique.mockResolvedValue(null);
  mockPrisma.pendingConfirmation.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
});

describe('ticket 08e58e1d — harness 429-fallback envelopes are never scored as supervisor notes', () => {
  it('1. REPLAY: a window of identical 429 fallback envelopes produces NO stuck-note nudge and NO classification telemetry', async () => {
    // The detector input that fired the false alarm: three machine-origin
    // assistant rows whose content is the byte-identical harness 429 envelope
    // (two consecutive dead wakes + the earlier one still in the window).
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('m-env-3', FALLBACK_429, 5, 'hook'),
      note('m-env-2', FALLBACK_429, 15, 'schedule'),
      note('m-env-1', FALLBACK_429, 25, 'schedule'),
    ]);
    await runAttentionWatchdogOnce({ now: T0 });

    expect(nudgePosts()).toHaveLength(0); // pre-fix: exactly ONE nudge posted here
    expect(supervisorMetrics()).toHaveLength(0); // envelopes never enter the classifier either
    // Nothing at all is posted into the supervisor thread by this sweep.
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('2. the exact incident shape — 2 envelopes + 1 real note: no nudge; the real note is still classified, the envelopes never are', async () => {
    const REAL = 'Fleet sweep: Benchmarks lane healthy, perf goal on track. Next sweep in 2h.';
    const realRow = note('m-real-1', REAL, 25, 'schedule');
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('m-env-2', FALLBACK_429, 5, 'hook'),
      note('m-env-1', FALLBACK_429, 15, 'schedule'),
      realRow,
    ]);
    // A live cursor (as of mid-incident) so the classification duty runs.
    plainStore[CURSOR_KEY] = String(T0.getTime() - 60 * 60_000);

    await runAttentionWatchdogOnce({ now: T0 });

    expect(nudgePosts()).toHaveLength(0);
    const metrics = supervisorMetrics();
    expect(metrics).toHaveLength(1); // the real note only
    expect(metrics[0].kind).toBe('supervisor_note');
    expect(metrics[0].meta.messageId).toBe(String(realRow.id).slice(0, 8));
    // …and the scan cursor advances to the real note, never to an envelope.
    expect(plainStore[CURSOR_KEY]).toBe(String(realRow.createdAt.getTime()));
  });

  it('3. the deterministic marker lane: providerError-marked rows are excluded even when the content matches NO known envelope', async () => {
    // A FUTURE error envelope shape the prefix list does not recognize — the
    // metadata.providerError marker (stamped at persist since this fix) must
    // exclude it without any prose matching.
    const FUTURE_ENVELOPE = '⚠︎ RUN TERMINATED EARLY: the model endpoint entered an outage window; nothing was delivered.';
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('m-mark-3', FUTURE_ENVELOPE, 5, 'hook', { providerError: { status: 429, kind: 'transient' } }),
      note('m-mark-2', FUTURE_ENVELOPE, 15, 'schedule', { providerError: { status: 429, kind: 'transient' } }),
      note('m-mark-1', FUTURE_ENVELOPE, 25, 'schedule', { providerError: { status: 429, kind: 'transient' } }),
    ]);
    plainStore[CURSOR_KEY] = String(T0.getTime() - 60 * 60_000);

    await runAttentionWatchdogOnce({ now: T0 });

    expect(nudgePosts()).toHaveLength(0);
    expect(supervisorMetrics()).toHaveLength(0);
  });

  it('4. CONTROL: the backstop still fires on 3 near-identical REAL lane notes (no over-exclusion)', async () => {
    const repeatNote = (n: number) =>
      `**Fleet sweep — ${n}:04 PM PDT: all lanes green**\n\n| Lane | Status | Detail |\n|---|---|---|\n| Benchmarks c9ccf88${n} | ✅ healthy | firing 23:1${n}Z |\n\nNo owner items this sweep. Next sweep in 2h.`;
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('m3-33333333', repeatNote(3), 10),
      note('m2-22222222', repeatNote(2), 130, 'hook'),
      note('m1-11111111', repeatNote(1), 250),
    ]);

    await runAttentionWatchdogOnce({ now: T0 });

    expect(nudgePosts()).toHaveLength(1);
    expect(nudgePosts()[0][0].data).toMatchObject({
      chatId: SUP,
      role: 'assistant',
      content: STUCK_NUDGE_TEXT,
      metadata: { origin: 'attention-watchdog', kind: 'stuck-note-nudge' },
    });
  });
});

describe('ticket 08e58e1d — isHarnessErrorNote envelope detector', () => {
  it('matches every harness error/fallback envelope shape', () => {
    expect(isHarnessErrorNote(FALLBACK_429)).toBe(true); // user 429
    expect(isHarnessErrorNote(modelErrorTerminalNote({ errorStatus: 503, transcriptChars: 12_000, contextBudget: 4_000_000, attempts: 2, audience: 'user' }))).toBe(true);
    expect(isHarnessErrorNote(modelErrorTerminalNote({ errorMessage: 'socket hang up', transcriptChars: 12_000, contextBudget: 4_000_000, attempts: 2, audience: 'user' }))).toBe(true);
    expect(isHarnessErrorNote(modelErrorTerminalNote({ errorStatus: 400, transcriptChars: 4_500_000, contextBudget: 4_000_000, attempts: 2, audience: 'user' }))).toBe(true); // over-budget user shape
    expect(isHarnessErrorNote(modelErrorTerminalNote({ errorStatus: 429, transcriptChars: 12_000, contextBudget: 4_000_000, attempts: 3, audience: 'operator' }))).toBe(true); // coding-lane shape
    expect(isHarnessErrorNote(EMPTY_RUN_FALLBACK_NOTE)).toBe(true);
    // Leading whitespace and carried-forward blocks appended after the
    // envelope (chat-agent finalize) must not defeat the shape match.
    expect(isHarnessErrorNote(`\n${FALLBACK_429}\n\n---\n_Carried forward…_`)).toBe(true);
  });

  it('never matches lane-authored text', () => {
    expect(isHarnessErrorNote('Fleet sweep: all lanes green. Next sweep in 2h.')).toBe(false);
    expect(isHarnessErrorNote('WAKE: no-op (nothing changed)')).toBe(false);
    expect(isHarnessErrorNote('STANDING DOWN: Benchmarks until state changes')).toBe(false);
    expect(isHarnessErrorNote('')).toBe(false);
    expect(isHarnessErrorNote(undefined)).toBe(false);
    expect(isHarnessErrorNote(null)).toBe(false);
    expect(isHarnessErrorNote(42)).toBe(false);
  });

  it('EMPTY_RUN_FALLBACK_NOTE is byte-identical to the legacy inline string (no user-facing text change)', () => {
    expect(EMPTY_RUN_FALLBACK_NOTE).toBe('I wasn\'t able to generate a response for this message. Please try again.');
  });
});

describe('ticket 08e58e1d — generator↔detector contract', () => {
  it('EVERY modelErrorTerminalNote shape satisfies isHarnessErrorNote (a rewording fails here loudly)', () => {
    const base = { transcriptChars: 12_000, contextBudget: 4_000_000, attempts: 2 };
    const shapes = [
      // user audience (chat lanes — the Fleet Supervisor's own shape)
      { ...base, errorStatus: 429, audience: 'user' as const },
      { ...base, errorStatus: 400, audience: 'user' as const },
      { ...base, errorStatus: 503, audience: 'user' as const },
      { ...base, errorMessage: 'connection reset by peer', audience: 'user' as const },
      { ...base, transcriptChars: 4_500_000, errorStatus: 400, audience: 'user' as const }, // over budget
      // operator audience (coding lanes)
      { ...base, errorStatus: 429, audience: 'operator' as const },
      { ...base, errorStatus: 400, audience: 'operator' as const },
      { ...base, errorMessage: 'socket hang up', audience: 'operator' as const },
      { ...base, transcriptChars: 4_500_000, errorStatus: 400, audience: 'operator' as const },
    ];
    for (const opts of shapes) {
      const noteText = modelErrorTerminalNote(opts);
      expect(isHarnessErrorNote(noteText)).toBe(true);
    }
  });
});
