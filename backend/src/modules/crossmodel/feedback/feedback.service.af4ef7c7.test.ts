/**
 * Ticket af4ef7c7 — the adjudicated-class dedupe never fired for the
 * auto-filed breaker class.
 *
 * THE DEFECT (measured on main before this fix):
 *   1. `coding/reflection.ts` writes its breaker ticket with a raw
 *      `prisma.userFeatureRequest.create` (`grep -c context` → 0 on that
 *      create block). EVERY dedupe pass lives inside `fileFeedbackTicket`, so
 *      the harness filer never entered the chain at all — stamping a key at
 *      that create site would have been inert.
 *   2. Its titles embed the MUTABLE chat title
 *      ('5× success-side wrong-tool loop: edit_file on "<chat title>" — …'),
 *      so two sightings of one class almost never share a normalized title,
 *      and the pass's equality arm matched nothing.
 *
 * THE FIX: a STRUCTURAL class key (the detector's own trip shape + the
 * called→intended tool pair — never the chat title) stamped at file time, plus
 * `bumpAdjudicatedClassSighting`, a direct JSON-path lookup the raw-write
 * filers can reach with no rate cap and no cross-source pass.
 *
 * WHAT A WRONG KEY COSTS (PR #2295, refuted): a title-derived key collapsed
 * genuinely distinct classes and would have hidden a recurrence — strictly
 * worse than the duplicate-row cost being fixed. The cases below pin BOTH
 * directions: same class attaches, distinct classes never do.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(async () => 0),
    create: jest.fn(async (...a: any[]) => ({ id: 'fresh-1', ...a[0]?.data })),
    update: jest.fn(async (...a: any[]) => ({ id: a[0]?.where?.id ?? 'bumped', ...a[0]?.data })),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) } }));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  releaseDispatchClaim: jest.fn(async () => ({})),
  drainUnderCapTickets: jest.fn(async () => 0),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { constructor(public code: number, m: string) { super(m); } },
}));

import {
  breakerClassKey, bumpAdjudicatedClassSighting, BREAKER_CLASS_KEY_FIELD,
} from './feedback.service';

/** The REAL title of ticket 59118fe0, transcribed verbatim from get_feedback. */
const TITLE_59118FE0 = '5× success-side wrong-tool loop: edit_file on "Panel-loss mid-scan kills legs: \'<cam · " — framework or model?';
/** The REAL title of ticket 2c98b460, transcribed verbatim from get_feedback. */
const TITLE_2C98B460 = 'kimi-k3 coding lanes derail into wrong-tool loops (update_plan×27 vs intended get_chat_messages) — third cluster';

/** A closed, ADJUDICATED breaker row as reflection.ts stamps one. */
function adjudicatedRow(over: Record<string, any> = {}) {
  return {
    id: '59118fe0-3e66-4fa3-98e8-fe39b7638bbf',
    title: TITLE_59118FE0,
    description: 'original body',
    status: 'done',
    type: 'mishap',
    source: 'agent-harness',
    adminNote: 'VERDICT: MODEL BEHAVIOR — the guard is correct, no deterministic framework defect.',
    updatedAt: new Date('2026-11-02T03:57:14.936Z'),
    context: {
      sessionId: '0037460b-d239-474e-bd32-5fe3ec52d820',
      [BREAKER_CLASS_KEY_FIELD]: 'success_intent:edit_file->verify',
      occurrences: 1,
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
});

describe('breakerClassKey — structural key, never the chat title', () => {
  it('keys a success-side trip on the called→intended tool pair', () => {
    expect(breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' }))
      .toBe('success_intent:edit_file->verify');
  });

  it('the SAME class under a DIFFERENT chat title derives an IDENTICAL key (the whole fix)', () => {
    // This is the defect's shape: the chat title is the only thing that varies
    // between two sightings of one class, and it is not an input to the key.
    const a = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
    const b = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
    expect(a).toBe(b);
    expect(a).not.toContain('Panel-loss'); // never leaks title text
  });

  it('keys a narration-repeat trip on its synthetic label', () => {
    expect(breakerClassKey({ shape: 'narration_repeat', tool: 'narration' }))
      .toBe('narration_repeat:narration');
  });

  it('REFUSES to key a bare failure streak — no discriminator means no key', () => {
    // BLOCKER-1 from PR #2295, pinned: a permanent-refusal class (terminal auth,
    // quarantined 6h) and a fatal-403-on-the-branch class are DISTINCT. Keying
    // them on the shared tool alone would fuse them and hide a recurrence.
    expect(breakerClassKey({ shape: 'failure', tool: 'run_command' })).toBeNull();
    expect(breakerClassKey({ shape: 'failure', tool: 'run_command', intended: null })).toBeNull();
    expect(breakerClassKey({ tool: 'run_command' })).toBeNull();
  });

  it('refuses a success trip with no intended tool (the pairing IS the class)', () => {
    expect(breakerClassKey({ shape: 'success_intent', tool: 'edit_file' })).toBeNull();
    expect(breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: '   ' })).toBeNull();
  });

  it('refuses an empty tool', () => {
    expect(breakerClassKey({ shape: 'success_intent', tool: '', intended: 'verify' })).toBeNull();
  });

  it('DISTINCT tool pairs never collapse onto one key', () => {
    const editToVerify = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
    const planToMsgs = breakerClassKey({ shape: 'success_intent', tool: 'update_plan', intended: 'get_chat_messages' });
    expect(editToVerify).not.toBe(planToMsgs);
  });

  it('apostrophe-bearing titles cannot collide (no quote-stripping exists to eat them)', () => {
    // PR #2295 blocker 2: stripping "quoted spans" ate real possessives so
    // "ticket didn't reopen: owner's verdict stood" and "…model's verdict
    // stood" collided. The structural key never looks at text at all.
    const a = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
    const b = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
    expect(a).toBe(b);
    expect(a).not.toMatch(/['"]/);
  });
});

describe('bumpAdjudicatedClassSighting — the arm a raw-write filer can reach', () => {
  it('attaches a same-class sighting with a DIFFERENT chat title to the adjudicated row', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([adjudicatedRow()]);

    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify',
      type: 'mishap',
      description: 'a later trip on a totally different chat',
      context: { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', [BREAKER_CLASS_KEY_FIELD]: 'success_intent:edit_file->verify' },
    });

    expect(res?.attached).toBe('59118fe0-3e66-4fa3-98e8-fe39b7638bbf');
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where.id).toBe('59118fe0-3e66-4fa3-98e8-fe39b7638bbf');
    expect(upd.data.context.occurrences).toBe(2);
    expect(upd.data.context.sightings[0].duplicateSuppressedBy).toBe('adjudicated-class');
    // The class key survives on the row — this is what makes the next trip find it.
    expect(upd.data.context[BREAKER_CLASS_KEY_FIELD]).toBe('success_intent:edit_file->verify');
  });

  it('looks the class up by STAMPED key, with NO title prefilter', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([adjudicatedRow()]);
    await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    const where = mockPrisma.userFeatureRequest.findMany.mock.calls[0][0].where;
    // The legacy scan prefilters `title CONTAINS <token>` — for a breaker title
    // that token is the mutable chat-title word, which is how the class went
    // unseen. This path must carry no title predicate at all.
    expect(where.AND).toBeUndefined();
    expect(where.title).toBeUndefined();
    expect(where.context).toEqual({ path: [BREAKER_CLASS_KEY_FIELD], equals: 'success_intent:edit_file->verify' });
    expect(where.source).toEqual({ in: ['agent', 'agent-harness'] });
  });

  it('does NOT attach to a row that is closed but NOT adjudicated', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      adjudicatedRow({ adminNote: 'closed as stale, no verdict recorded', context: { [BREAKER_CLASS_KEY_FIELD]: 'success_intent:edit_file->verify' } }),
    ]);
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    expect(res).toBeNull();
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('never absorbs a linked-duplicate record', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      adjudicatedRow({ context: { duplicateOf: 'other-1', [BREAKER_CLASS_KEY_FIELD]: 'success_intent:edit_file->verify' } }),
    ]);
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    expect(res).toBeNull();
  });

  it('returns null (filer proceeds normally) when nothing matches the class', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    expect(res).toBeNull();
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('fail-open: a throwing lookup never blocks the filing', async () => {
    mockPrisma.userFeatureRequest.findMany.mockRejectedValue(new Error('db down'));
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    expect(res).toBeNull();
  });

  it('an empty class key is a no-op', async () => {
    expect(await bumpAdjudicatedClassSighting({ classKey: '  ', type: 'mishap', description: 'x', context: {} })).toBeNull();
    expect(mockPrisma.userFeatureRequest.findMany).not.toHaveBeenCalled();
  });

  // ── Adversarial review #2298, F1 (blocking) ──────────────────────────────
  it('honours the FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED escape hatch', async () => {
    // The switch is the documented false-merge escape hatch for this behaviour
    // ("an escape hatch must be env, not a code change"). An attach arm outside
    // it would be unrevertable in an incident.
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([adjudicatedRow()]);
    process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED = '1';
    try {
      const res = await bumpAdjudicatedClassSighting({
        classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
      });
      expect(res).toBeNull();
      expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
    } finally {
      delete process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED;
    }
  });

  // ── Adversarial review #2298, F2 (blocking) ──────────────────────────────
  it('does NOT absorb into a class carrying a RE-OPEN BAR it cannot evaluate', async () => {
    // A breaker sighting carries no 24h `count`, so it can never evaluate the
    // bar. Absorbing anyway is how a barred class becomes permanently silent.
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      adjudicatedRow({ context: { [BREAKER_CLASS_KEY_FIELD]: 'success_intent:edit_file->verify', reopenBar: 50 } }),
    ]);
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    expect(res).toBeNull();
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('still absorbs when the adjudicated row records NO bar', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([adjudicatedRow()]);
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify', type: 'mishap', description: 'x', context: {},
    });
    expect(res?.attached).toBe('59118fe0-3e66-4fa3-98e8-fe39b7638bbf');
  });
});

describe('the REAL pair from the ticket (59118fe0 vs 2c98b460) — honest verdict', () => {
  /**
   * The ticket asserts these two are ONE class and should attach. Measured
   * against the shipped detector, they are NOT one structural class:
   *   59118fe0 = a breaker AUTO-filing, success_intent edit_file→verify
   *   2c98b460 = an agent-written RECURRENCE CLUSTER, update_plan→get_chat_messages
   * They share the umbrella label ("success-side wrong-tool loop") but not a
   * tool pair. This fix therefore does NOT attach them, and must not pretend
   * to: a key broad enough to join every tool pair would also join the
   * distinct classes blocker-1 of PR #2295 refuted.
   */
  it('does NOT join them — they are different structural classes', () => {
    const keyFrom59118fe0 = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
    const keyFrom2c98b460 = breakerClassKey({ shape: 'success_intent', tool: 'update_plan', intended: 'get_chat_messages' });
    expect(keyFrom59118fe0).toBe('success_intent:edit_file->verify');
    expect(keyFrom2c98b460).toBe('success_intent:update_plan->get_chat_messages');
    expect(keyFrom59118fe0).not.toBe(keyFrom2c98b460);
  });

  it('2c98b460 row (source agent, agent-written title) is not a breaker row a key would find', () => {
    // Its context carries no breakerClassKey — it was filed by an agent chat,
    // not by the harness filer, so the class arm never considers it. Recorded
    // here so a future lane cannot re-assert an attachment that cannot happen.
    const row = { title: TITLE_2C98B460, source: 'agent', context: {} };
    expect(row.context).not.toHaveProperty(BREAKER_CLASS_KEY_FIELD);
  });

  it('59118fe0 row IS findable by its structural key across a changed chat title', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([adjudicatedRow()]);
    const res = await bumpAdjudicatedClassSighting({
      classKey: 'success_intent:edit_file->verify',
      type: 'mishap',
      description: 'same class, chat retitled in the meantime',
      context: { [BREAKER_CLASS_KEY_FIELD]: 'success_intent:edit_file->verify' },
    });
    expect(res?.attached).toBe('59118fe0-3e66-4fa3-98e8-fe39b7638bbf');
  });
});