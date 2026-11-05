/**
 * Fleet Supervisor durable state doc (2026-08-22 rebuild — the 2026-08-21
 * amnesia incident) — supervisor-state.service unit tests with mocked Prisma.
 *
 * Pins: tolerant reads (missing/malformed state → empty doc, NEVER throws);
 * owner-directive capture (row create, 500-char text cap, newest-50 cap);
 * the merge rules (new-directive append; evidence-GATED closes — a close
 * without evidence is rejected into errors; unknown ids/invalid statuses
 * rejected; dispatch kind+id required with newest-30 cap; project upsert-by-
 * name capped at 20; notes replace capped at 4000); the never-throws contract
 * (DB failure → { applied: [], errors: [message] }); and the wake-block
 * renderer (empty sections omitted, open directives only with ids + ages,
 * ~6000-char hard cap dropping oldest dispatches first, then truncating
 * notes).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  // Ticket 8f5a45f7: stalled-todo liveness suppression reads run activity.
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Write-time citation validation (ticket cfeb1a57): applyStateUpdate loads the
// action verifier DYNAMICALLY for its miners + existence checks. Keep the REAL
// miners (the idiom regexes + honesty-register exclusion ARE the contract
// being wired) and mock the DB-touching row checks + near-miss lookup. The
// verifier's own heavy boundaries are mocked so requireActual loads cleanly.
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

const mockCitedMessageRowExists = jest.fn(async (_id: string) => true);
const mockCitedScheduleRowExists = jest.fn(async (_id: string) => true);
const mockSamePrefixRealIds = jest.fn(async (_kind: string, _id: string, _userId?: string) => [] as string[]);
jest.mock('./action-verifier', () => {
  const actual = jest.requireActual('./action-verifier');
  return {
    ...actual,
    citedMessageRowExists: (...a: any[]) => (mockCitedMessageRowExists as any)(...a),
    citedScheduleRowExists: (...a: any[]) => (mockCitedScheduleRowExists as any)(...a),
    samePrefixRealIds: (...a: any[]) => (mockSamePrefixRealIds as any)(...a),
  };
});

import {
  getSupervisorState,
  isSupervisorChat,
  supervisorChatFlag,
  formatStateForWake,
  appendDirective,
  appendVerifierRefutation,
  applyStateUpdate,
  buildFleetAttentionBlock,
  OWNER_DECISION_VERBATIM_WINDOW_MS,
  SupervisorStateDoc,
  VERIFIER_REFUTATION_PREFIX,
  RECENT_DISPATCHES_HEADER,
  archiveStaleDirectives, readSupervisorStateSection, DIRECTIVE_ARCHIVE_MIN_OPEN, DIRECTIVE_ARCHIVE_AFTER_MS,
} from './supervisor-state.service';

const CHAT = 'sup-chat-1';
const UID = 'u1';
const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };

/** In-memory supervisor_states table (chatId → stored state Json). */
let table: Map<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ isSupervisor: true });
  mockCitedMessageRowExists.mockResolvedValue(true);
  mockCitedScheduleRowExists.mockResolvedValue(true);
  mockSamePrefixRealIds.mockResolvedValue([]);
});

const stored = (): SupervisorStateDoc => table.get(CHAT) as SupervisorStateDoc;

describe('getSupervisorState', () => {
  it('a missing row yields an empty doc', async () => {
    expect(await getSupervisorState(CHAT)).toEqual(EMPTY);
  });

  it('malformed stored state is tolerated (→ empty doc)', async () => {
    table.set(CHAT, 'not an object');
    expect(await getSupervisorState(CHAT)).toEqual(EMPTY);
    table.set(CHAT, { directives: 'nope', dispatches: [{}], projects: null, notes: 42 });
    expect(await getSupervisorState(CHAT)).toEqual(EMPTY);
  });

  it('a DB failure yields an empty doc and never throws', async () => {
    mockPrisma.supervisorState.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await getSupervisorState(CHAT)).toEqual(EMPTY);
  });

  it('parses a stored doc, coercing an unknown directive status to open', async () => {
    table.set(CHAT, {
      directives: [{ id: 'd1', text: 't', at: '2026-08-22T00:00:00.000Z', status: 'weird' }],
      dispatches: [{ at: 'a', kind: 'send_chat_message', id: 'c9' }],
      projects: [{ name: 'P', status: 'ok', at: 'a' }],
      notes: 'n',
    });
    const doc = await getSupervisorState(CHAT);
    expect(doc.directives[0].status).toBe('open');
    expect(doc.dispatches).toEqual([{ at: 'a', kind: 'send_chat_message', id: 'c9' }]);
    expect(doc.projects).toEqual([{ name: 'P', status: 'ok', at: 'a' }]);
    expect(doc.notes).toBe('n');
  });
});

describe('isSupervisorChat', () => {
  it('true only for the flagged chat; false on a DB failure', async () => {
    expect(await isSupervisorChat(CHAT)).toBe(true);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: false });
    expect(await isSupervisorChat(CHAT)).toBe(false);
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await isSupervisorChat(CHAT)).toBe(false);
  });
  it('supervisorChatFlag (review fixer 2026-09-27): true / false from the row, NULL on a DB failure — the executors tell an outage from "not a supervisor"', async () => {
    expect(await supervisorChatFlag(CHAT)).toBe(true);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: false, isProjectSupervisor: true });
    expect(await supervisorChatFlag(CHAT)).toBe(true);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: false });
    expect(await supervisorChatFlag(CHAT)).toBe(false);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce(null);
    expect(await supervisorChatFlag(CHAT)).toBe(false);
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await supervisorChatFlag(CHAT)).toBeNull();
  });
});

describe('appendDirective', () => {
  it('creates the row and appends an open directive', async () => {
    await appendDirective(CHAT, UID, 'Keep an eye on PR #217');
    expect(stored().directives).toHaveLength(1);
    const d = stored().directives[0];
    expect(d.text).toBe('Keep an eye on PR #217');
    expect(d.status).toBe('open');
    expect(d.origin).toBe('owner'); // harness stamp — the project brief's owner-origin filter keys on it
    expect(d.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(d.at))).toBe(false);
    const create = mockPrisma.supervisorState.upsert.mock.calls[0][0].create;
    expect(create.chatId).toBe(CHAT);
    expect(create.userId).toBe(UID);
  });

  it('caps text at 500 chars; the cap evicts the oldest DONE row — never an OPEN one (remediation P2 v1#3/B6)', async () => {
    // 49 open + 1 done at the FRONT: at the cap, the done row evicts.
    table.set(CHAT, {
      ...EMPTY,
      directives: [
        { id: 'd-done', text: 'finished order', at: 'a', status: 'done', evidence: 'pr #1' },
        ...Array.from({ length: 49 }, (_, i) => ({ id: `d${i}`, text: `t${i}`, at: 'a', status: 'open' })),
      ],
    });
    await appendDirective(CHAT, UID, 'x'.repeat(600));
    expect(stored().directives).toHaveLength(50);
    expect(stored().directives.find((d) => d.id === 'd-done')).toBeUndefined(); // done row evicted
    expect(stored().directives[0].id).toBe('d0'); // every open row survives
    expect(stored().directives[49].text).toHaveLength(500);
  });

  it('an ALL-OPEN ledger over the cap keeps every open directive (effective cap raises — the 21:17Z class)', async () => {
    table.set(CHAT, {
      ...EMPTY,
      directives: Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, text: `t${i}`, at: 'a', status: 'open' })),
    });
    await appendDirective(CHAT, UID, 'the fifty-first open owner order');
    expect(stored().directives).toHaveLength(51); // nothing silently dropped
    expect(stored().directives[0].id).toBe('d0');
  });

  it('ignores empty text and never throws on a DB failure', async () => {
    await appendDirective(CHAT, UID, '   ');
    expect(table.has(CHAT)).toBe(false);
    mockPrisma.supervisorState.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(appendDirective(CHAT, UID, 'hi')).resolves.toBeUndefined();
  });

  it('N9 — a credential-shaped directive is stored REDACTED (it re-renders into every wake block)', async () => {
    const FAKE_SLACK = 'xoxb-' + '1234567890-FAKEFAKEFAKE'; // fake fixture token
    await appendDirective(CHAT, UID, `use ${FAKE_SLACK} for the relay`);
    const d = stored().directives[0];
    expect(d.text).toBe('use [REDACTED: looked like a credential] for the relay');
    expect(d.text).not.toContain(FAKE_SLACK);
  });
});

describe('write serialization (review M3 — upsertDoc read-modify-write race)', () => {
  it('concurrent refutations both land (no lost update)', async () => {
    await Promise.all([
      appendVerifierRefutation(CHAT, UID, 'claim A'),
      appendVerifierRefutation(CHAT, UID, 'claim B'),
    ]);
    const refs = stored().refutations;
    expect(refs).toHaveLength(2);
    expect(refs.join(' ')).toContain('claim A');
    expect(refs.join(' ')).toContain('claim B');
  });

  it('a directive append racing a refutation keeps BOTH writes', async () => {
    await Promise.all([
      appendVerifierRefutation(CHAT, UID, 'claim X'),
      appendDirective(CHAT, UID, 'owner said do the thing'),
    ]);
    expect(stored().refutations.join(' ')).toContain('claim X');
    expect(stored().directives.map((d) => d.text)).toContain('owner said do the thing');
  });
});

describe('applyStateUpdate', () => {
  const seed = () => table.set(CHAT, {
    directives: [{ id: 'd1', text: 'watch the digest', at: '2026-08-21T00:00:00.000Z', status: 'open' }],
    dispatches: [],
    projects: [],
    notes: 'old notes',
  });

  it('appends a new open directive from a text-only item', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ text: 'new ask' }] });
    expect(r.errors).toEqual([]);
    expect(r.applied.join(' ')).toMatch(/directive added/);
    expect(stored().directives).toHaveLength(2);
    expect(stored().directives[1].status).toBe('open');
    expect(stored().directives[1].id).toBeTruthy();
  });

  // Secret-scrubbing review fix (2026-09-27): the update_supervisor_state
  // write path — the one that persisted directive 384f859b from MODEL-typed
  // prose — redacts credential-shaped strings before the store. FAKE fixture.
  describe('model-typed credentials are redacted at persist (the 384f859b seam)', () => {
    const FAKE_ZAI = '0123456789abcdef0123456789abcdef' + '.AbCdEfGhIjKlMnOp';
    const REDACTED = '[REDACTED: looked like a credential]';

    it('a new directive carrying a Z.ai key is stored redacted, and applied[] says so', async () => {
      seed();
      const r = await applyStateUpdate(CHAT, UID, { directives: [{ text: `use ZAI_API_KEY=${FAKE_ZAI} for the CanLaw bench` }] });
      expect(r.errors).toEqual([]);
      expect(stored().directives[1].text).toBe(`use ZAI_API_KEY=${REDACTED} for the CanLaw bench`);
      expect(JSON.stringify(stored())).not.toContain(FAKE_ZAI);
      expect(r.applied.join(' ')).toMatch(/credential-shaped string\(s\) were REDACTED before storing \(directive\.text\)/);
      expect(r.applied.join(' ')).toMatch(/directive added/);
    });

    it('evidence on a close, dispatch notes, project statuses and notes are redacted too', async () => {
      seed();
      const r = await applyStateUpdate(CHAT, UID, {
        directives: [{ id: 'd1', status: 'done', evidence: `PR #215 (api_key=${'x'.repeat(24)})` }],
        dispatches: [{ kind: 'session', id: 'sess-1', note: `started with ${FAKE_ZAI}` }],
        projects: [{ name: 'canlaw', status: `bench running, token=AbCdEfGhIjKlMnOpQrStUv12` }],
        notes: `remember ${FAKE_ZAI}`,
      });
      expect(r.errors).toEqual([]);
      const s = stored();
      expect(s.directives[0].evidence).toBe(`PR #215 (api_key=${REDACTED})`);
      expect(s.dispatches[0].note).toBe(`started with ${REDACTED}`);
      expect(s.projects[0].status).toBe(`bench running, token=${REDACTED}`);
      expect(s.notes).toBe(`remember ${REDACTED}`);
      expect(JSON.stringify(s)).not.toContain(FAKE_ZAI);
      expect(r.applied.join(' ')).toContain('directive.evidence, dispatch.note, project.status, notes');
    });

    it('a clean update adds no redaction note', async () => {
      seed();
      const clean = await applyStateUpdate(CHAT, UID, { directives: [{ text: 'plain ask' }] });
      expect(clean.applied.join(' ')).not.toContain('REDACTED');
    });
  });

  it('closes a directive WITH evidence', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'PR #215' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
    expect(stored().directives[0].evidence).toBe('PR #215');
  });

  it('REJECTS a close without evidence into errors (the directive stays open)', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done' }] });
    expect(r.errors.join(' ')).toMatch(/evidence/);
    expect(stored().directives[0].status).toBe('open');
  });

  it('rejects unknown directive ids and invalid statuses', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, {
      directives: [{ id: 'nope', status: 'open' }, { id: 'd1', status: 'weird' }],
    });
    expect(r.errors).toHaveLength(2);
    expect(stored().directives[0].status).toBe('open');
  });

  it('appends dispatches (kind+id required), note capped at 300, newest 30 kept', async () => {
    table.set(CHAT, {
      ...EMPTY,
      dispatches: Array.from({ length: 30 }, (_, i) => ({ at: 'a', kind: 'k', id: `old${i}` })),
    });
    const r = await applyStateUpdate(CHAT, UID, {
      dispatches: [
        { kind: 'send_chat_message', id: 'c9', note: 'n'.repeat(400) },
        { kind: 'schedule_message' }, // missing id → rejected
      ],
    });
    expect(r.errors.join(' ')).toMatch(/kind and id/);
    expect(stored().dispatches).toHaveLength(30);
    expect(stored().dispatches[0].id).toBe('old1'); // oldest dropped
    expect(stored().dispatches[29].id).toBe('c9');
    expect(stored().dispatches[29].note).toHaveLength(300);
  });

  // fixer 2026-09-27 (tt-rd audit, finding upward-chatter-5): the owner-turn
  // empty retry replays the whole turn with update_supervisor_state on the
  // replay-safe allow list — an unconditional push double-wrote RECENT
  // DISPATCHES and the 30-row slice evicted a real row per duplicate.
  it('a dispatch with the same kind + id inside the 30-min window is NOT recorded twice (ack says already recorded); outside the window, or with the switch, it is', async () => {
    seed();
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    table.set(CHAT, {
      ...EMPTY,
      dispatches: [
        { at: recent, kind: 'send_chat_message', id: 'msg-dup-1' },
        { at: old, kind: 'todo_update', id: 'todo-9' },
        { at: '', kind: 'schedule_message', id: 'sched-legacy' }, // undated legacy row
      ],
    });
    const r = await applyStateUpdate(CHAT, UID, {
      dispatches: [
        { kind: 'send_chat_message', id: 'msg-dup-1', note: 'replayed' }, // same action, re-merged by the retry → skipped
        { kind: 'todo_update', id: 'todo-9', note: 'touched again 2h later' }, // a later legit re-touch → recorded
        { kind: 'schedule_message', id: 'sched-legacy' }, // undated row never blocks a fresh record
        { kind: 'send_chat_message', id: 'msg-new-2' },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.applied.join('\n')).toContain('dispatch already recorded: send_chat_message msg-dup-1 (no duplicate row');
    expect(r.applied.join('\n')).toContain('NOT evidence it ran this wake');
    const ids = stored().dispatches.map((d: any) => `${d.kind}:${d.id}`);
    expect(ids).toEqual(['send_chat_message:msg-dup-1', 'todo_update:todo-9', 'schedule_message:sched-legacy', 'todo_update:todo-9', 'schedule_message:sched-legacy', 'send_chat_message:msg-new-2']);
    expect(ids.filter((x: string) => x === 'send_chat_message:msg-dup-1')).toHaveLength(1);
  });

  it('upserts projects by name (status capped at 200, newest 20 kept)', async () => {
    seed();
    await applyStateUpdate(CHAT, UID, { projects: [{ name: 'Digby', status: 'green' }] });
    const r = await applyStateUpdate(CHAT, UID, { projects: [{ name: 'Digby', status: 's'.repeat(300) }] });
    expect(r.errors).toEqual([]);
    expect(stored().projects).toHaveLength(1); // upserted, not duplicated
    expect(stored().projects[0].status).toHaveLength(200);
    await applyStateUpdate(CHAT, UID, { projects: Array.from({ length: 25 }, (_, i) => ({ name: `P${i}`, status: 'ok' })) });
    expect(stored().projects).toHaveLength(20);
  });

  it('replaces notes (capped at 4000)', async () => {
    seed();
    await applyStateUpdate(CHAT, UID, { notes: 'n'.repeat(5000) });
    expect(stored().notes).toHaveLength(4000);
    await applyStateUpdate(CHAT, UID, { notes: 'fresh' });
    expect(stored().notes).toBe('fresh');
  });

  it('a DB failure returns { applied: [], errors: [message] } and never throws', async () => {
    mockPrisma.supervisorState.findUnique.mockRejectedValueOnce(new Error('db down'));
    const r = await applyStateUpdate(CHAT, UID, { notes: 'x' });
    expect(r.applied).toEqual([]);
    expect(r.errors).toEqual(['db down']);
  });

  // Ticket 69e07047 (2026-09-07): the supervisor reported five update_supervisor_state
  // merges failing with "ok:false, error 'goalId must be a non-empty string'" — an
  // error that exists nowhere in the platform (zero repo matches, zero git history,
  // no deploy in the claimed window) and a receipt shape this service never returns.
  // Pin the REAL error vocabulary across every failure mode: a regression that
  // changes what merge failures say (or emits schema-foreign field names) trips here.
  it('every failure mode speaks the documented vocabulary — never a schema-foreign field error (ticket 69e07047)', async () => {
    // 1. close without evidence
    seed();
    const r1 = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done' }] });
    // 2. unknown directive id + invalid status
    const r2 = await applyStateUpdate(CHAT, UID, {
      directives: [{ id: 'nope', status: 'open' }, { id: 'd1', status: 'weird' }],
    });
    // 3. dispatch missing kind/id
    const r3 = await applyStateUpdate(CHAT, UID, { dispatches: [{ kind: 'schedule_message' }] });
    // 4. fabricated msg citation in notes
    mockCitedMessageRowExists.mockResolvedValue(false);
    const r4 = await applyStateUpdate(CHAT, UID, {
      notes: 'Waiver lane: the waiver email is final (msg 972ac6fd) — owner can review + send.',
    });
    const allErrors = [...r1.errors, ...r2.errors, ...r3.errors, ...r4.errors];
    expect(allErrors.length).toBeGreaterThan(0);
    for (const err of allErrors) {
      expect(err).not.toMatch(/goalId/i);
      expect(err).not.toMatch(/must be a non-empty string/i);
      expect(err).toMatch(/evidence|no such directive|status must be|kind and id|NOT applied|do not exist/i);
    }
    // The result shape is always { applied, errors } — never { ok:false, error }.
    for (const r of [r1, r2, r3, r4]) {
      expect(Object.keys(r).sort()).toEqual(['applied', 'errors']);
    }
  });
});

describe('applyStateUpdate — directive id prefix resolution (ticket ec58521f)', () => {
  // The durable doc stores randomUUID() directive ids and the wake block
  // injects them in full — but supervisor lanes habitually carry 8-char
  // prefixes in their own notes (the same convention schedule_get /
  // hook_update / cancel_schedule accept) and submit those on close. The
  // exact-match lookup made directives unclosable in practice: 4/4
  // verbatim-carried ids rejected at 2026-09-08T05:02Z. Fix: a UNIQUE
  // >=8-char prefix resolves; ambiguity names candidates; invented ids still
  // fail.
  const FULL_A = '7425a1e7-1111-4000-8000-000000000001';
  const FULL_B = '7425a1e7-2222-4000-8000-000000000002';
  const FULL_C = 'd31c088f-3333-4000-8000-000000000003';
  const seedUuids = () => table.set(CHAT, {
    ...EMPTY,
    directives: [
      { id: FULL_A, text: 'alpha', at: 'a', status: 'open' },
      { id: FULL_B, text: 'beta', at: 'a', status: 'open' },
      { id: FULL_C, text: 'gamma', at: 'a', status: 'open' },
    ],
  });

  it('resolves a UNIQUE >=8-char prefix and closes the directive', async () => {
    seedUuids();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd31c088f', status: 'done', evidence: 'PR #215' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives.find((d) => d.id === FULL_C)?.status).toBe('done');
    expect(stored().directives.find((d) => d.id === FULL_C)?.evidence).toBe('PR #215');
    expect(stored().directives.find((d) => d.id === FULL_A)?.status).toBe('open');
  });

  it('REJECTS an ambiguous prefix, naming its candidates (nothing mutates)', async () => {
    seedUuids();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: '7425a1e7', status: 'done', evidence: 'PR #215' }] });
    expect(r.errors.join(' ')).toMatch(/ambiguous id prefix/);
    expect(r.errors.join(' ')).toMatch(/7425a1e7-1111/);
    expect(r.errors.join(' ')).toMatch(/7425a1e7-2222/);
    expect(stored().directives.every((d) => d.status === 'open')).toBe(true);
  });

  it('still REJECTS an unknown >=8-char id as no such directive id', async () => {
    seedUuids();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'beefcafe', status: 'open' }] });
    expect(r.errors.join(' ')).toMatch(/no such directive id/);
  });

  it('still REJECTS a short (<8-char) non-matching id — no prefix guessing below the floor', async () => {
    seedUuids();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd31c08', status: 'open' }] });
    expect(r.errors.join(' ')).toMatch(/no such directive id/);
  });

  it('exact full-id matches keep working unchanged', async () => {
    seedUuids();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: FULL_A, status: 'done', evidence: 'session abc' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives.find((d) => d.id === FULL_A)?.status).toBe('done');
  });

  it('a prefix-id close riding STORED evidence is still citation-validated (review F1 — no N2 bypass)', async () => {
    table.set(CHAT, {
      ...EMPTY,
      directives: [{ id: FULL_C, text: 'gamma', at: 'a', status: 'open', evidence: 'closed per the monitor schedule 1fd6a55f results' }],
    });
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd31c088f', status: 'done' }] });
    expect(r.errors.join('\n')).toContain('1fd6a55f');
    expect(stored().directives[0].status).toBe('open'); // bogus stored citation → close rejected even via prefix
  });
});

describe('applyStateUpdate — write-time evidence-citation validation (ticket cfeb1a57)', () => {
  const CITED_NOTES = 'Waiver lane: the waiver email is final (msg 972ac6fd) — owner can review + send.';

  it('REJECTS a notes replace citing a msg id that does not exist (other fields still apply)', async () => {
    mockCitedMessageRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      notes: CITED_NOTES,
      projects: [{ name: 'Waiver', status: 'email final' }],
    });
    expect(r.applied).toContain('project status: Waiver');
    expect(r.applied).not.toContain('notes replaced');
    const errs = r.errors.join('\n');
    expect(errs).toContain('notes NOT applied');
    expect(errs).toContain('972ac6fd');
    expect(stored().projects[0].name).toBe('Waiver');
    expect(stored().notes).toBe(''); // the fabricated citation never reaches the doc
  });

  it('applies notes whose cited msg id EXISTS', async () => {
    const r = await applyStateUpdate(CHAT, UID, { notes: CITED_NOTES });
    expect(r.errors).toEqual([]);
    expect(r.applied).toContain('notes replaced');
    expect(stored().notes).toBe(CITED_NOTES);
    expect(mockCitedMessageRowExists).toHaveBeenCalledWith('972ac6fd');
  });

  it('does not mine refutation-register prose (quoting a strike is honest)', async () => {
    const r = await applyStateUpdate(CHAT, UID, {
      notes: 'Verifier struck the 14:00Z note: msg 972ac6fd does not exist — never restate it.',
    });
    expect(r.errors).toEqual([]);
    expect(r.applied).toContain('notes replaced');
    expect(mockCitedMessageRowExists).not.toHaveBeenCalled(); // the honesty-register exclusion skipped the line
  });

  it('rejects a directive close whose evidence cites a schedule id that does not exist (the close does not land)', async () => {
    table.set(CHAT, { directives: [{ id: 'd1', text: 'watch the digest', at: '2026-08-21T00:00:00.000Z', status: 'open' }] });
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      directives: [{ id: 'd1', status: 'done', evidence: 'closed per the monitor schedule 1fd6a55f results' }],
    });
    const errs = r.errors.join('\n');
    expect(errs).toContain('directive d1');
    expect(errs).toContain('1fd6a55f');
    expect(stored().directives[0].status).toBe('open');
    expect(stored().directives[0].evidence).toBeUndefined();
  });

  it('sibling directive items are unaffected by one rejected item', async () => {
    table.set(CHAT, {
      directives: [
        { id: 'd1', text: 'a', at: 't', status: 'open' },
        { id: 'd2', text: 'b', at: 't', status: 'open' },
      ],
    });
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      directives: [
        { id: 'd1', status: 'done', evidence: 'closed per the monitor schedule 1fd6a55f results' }, // fabricated → rejected
        { id: 'd2', status: 'done', evidence: 'PR #581' }, // clean → closes
      ],
    });
    expect(r.errors.join('\n')).toContain('directive d1');
    expect(stored().directives[0].status).toBe('open');
    expect(stored().directives[1].status).toBe('done');
  });

  it('drops a dispatch NOTE citing a msg id that does not exist but still records the dispatch', async () => {
    mockCitedMessageRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      dispatches: [{ kind: 'send_chat_message', id: '7f0da5b9-5aff-456c-8c8a-07888c8494e2', note: 'told the waiver worker the email is final (msg 972ac6fd)' }],
    });
    expect(r.applied.join(' ')).toMatch(/dispatch ledger updated: send_chat_message 7f0da5b9/);
    expect(r.applied.join(' ')).toContain('(a HISTORY record of the action — NOT evidence it ran this wake)');
    const errs = r.errors.join('\n');
    expect(errs).toContain('note dropped');
    expect(errs).toContain('972ac6fd');
    expect(stored().dispatches).toHaveLength(1);
    expect(stored().dispatches[0].id).toBe('7f0da5b9-5aff-456c-8c8a-07888c8494e2'); // the real dispatch keeps its ledger entry
    expect(stored().dispatches[0].note).toBeUndefined();
  });

  it('fails open when the existence check itself errors (an unverifiable citation is never rejected)', async () => {
    mockCitedMessageRowExists.mockRejectedValue(new Error('db down'));
    const r = await applyStateUpdate(CHAT, UID, { notes: CITED_NOTES });
    expect(r.errors).toEqual([]);
    expect(r.applied).toContain('notes replaced');
  });

  it('decorates the rejection with same-prefix REAL ids (the id the model MEANT)', async () => {
    mockCitedMessageRowExists.mockResolvedValue(false);
    mockSamePrefixRealIds.mockResolvedValue(['972ac6fd-e755-4f7a-9b11-aa125b67cc01 (chat a8976e11, 2026-09-01T01:09:00.000Z)']);
    const r = await applyStateUpdate(CHAT, UID, { notes: CITED_NOTES });
    expect(r.errors.join('\n')).toContain('same-prefix real ids: 972ac6fd-e755');
  });

  it('mines TERSE idioms below the note-audit line floor (the write path has no safe-miss floor)', async () => {
    table.set(CHAT, { directives: [{ id: 'd1', text: 'watch the digest', at: 'a', status: 'open' }] });
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'sched 1fd6a55f' }] });
    expect(r.errors.join('\n')).toContain('1fd6a55f');
    expect(stored().directives[0].status).toBe('open'); // 14-char evidence line still mined → close rejected
  });

  it('validates a close riding STORED evidence (pre-fix pollution cannot close a directive)', async () => {
    table.set(CHAT, {
      directives: [{ id: 'd1', text: 'watch the digest', at: 'a', status: 'open', evidence: 'closed per the monitor schedule 1fd6a55f results' }],
    });
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done' }] });
    expect(r.errors.join('\n')).toContain('directive d1');
    expect(r.errors.join('\n')).toContain('1fd6a55f');
    expect(stored().directives[0].status).toBe('open');
  });

  it('rejects a NEW directive whose text cites a msg id that does not exist', async () => {
    mockCitedMessageRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      directives: [{ text: 'track the waiver email thread — see msg 972ac6fd for the final version' }],
    });
    expect(r.errors.join('\n')).toContain('new directive');
    expect(r.errors.join('\n')).toContain('972ac6fd');
    expect(stored().directives).toHaveLength(0); // the fabricated citation never enters the wake block
  });

  it('rejects a project status line citing a schedule id that does not exist', async () => {
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      projects: [{ name: 'Monitor', status: 'green per schedule 1fd6a55f firing #2 today' }],
    });
    expect(r.errors.join('\n')).toContain('project Monitor');
    expect(r.errors.join('\n')).toContain('1fd6a55f');
    expect(stored().projects).toHaveLength(0);
  });

  it('never mutates the caller-supplied update object, even when rejecting', async () => {
    mockCitedMessageRowExists.mockResolvedValue(false);
    const update = {
      notes: CITED_NOTES,
      dispatches: [{ kind: 'send_chat_message', id: '7f0da5b9', note: 'the waiver email is final per msg 972ac6fd — please send' }],
      projects: [{ name: 'Waiver', status: 'ok' }],
    };
    const snapshot = JSON.parse(JSON.stringify(update));
    await applyStateUpdate(CHAT, UID, update);
    expect(update).toEqual(snapshot);
  });

  it('validates the whitespace-COLLAPSED store form (a newline-split idiom cannot evade)', async () => {
    mockCitedMessageRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      projects: [{ name: 'Waiver', status: 'email final per msg\n972ac6fd today' }],
    });
    expect(r.errors.join('\n')).toContain('project Waiver');
    expect(r.errors.join('\n')).toContain('972ac6fd');
    expect(stored().projects).toHaveLength(0); // 'msg\n972ac6fd' evades per-line mining; the stored form 'msg 972ac6fd' convicts
  });

  it('newline-split idiom in new-directive text is caught via the collapsed store form', async () => {
    mockCitedScheduleRowExists.mockResolvedValue(false);
    const r = await applyStateUpdate(CHAT, UID, {
      directives: [{ text: 'watch the monitor schedule\n1fd6a55f for drift' }],
    });
    expect(r.errors.join('\n')).toContain('new directive');
    expect(r.errors.join('\n')).toContain('1fd6a55f');
    expect(stored().directives).toHaveLength(0);
  });
});

describe('formatStateForWake', () => {
  const NOW = new Date('2026-08-22T12:00:00.000Z');
  const DOC: SupervisorStateDoc = {
    directives: [
      { id: 'd-open', text: 'keep an eye on the digest', at: '2026-08-20T12:00:00.000Z', status: 'open' },
      { id: 'd-done', text: 'old ask', at: '2026-08-19T12:00:00.000Z', status: 'done', evidence: 'PR #1' },
    ],
    archived: [], dispatches: [{ at: '2026-08-22T10:00:00.000Z', kind: 'send_chat_message', id: 'c9', note: 'nudged' }],
    projects: [{ name: 'Digby', status: 'green', at: 'a' }],
    refutations: [],
    notes: 'owner prefers quiet mornings',
    inflightPreemptAt: '',
  };

  it('renders the header + all sections: OPEN directives only, with ids and ages', () => {
    const block = formatStateForWake(DOC, NOW);
    expect(block).toContain('[SUPERVISOR STATE — your durable memory across wakes. Update it before finishing with save_supervisor_state.]');
    expect(block).toContain('OPEN DIRECTIVES:');
    expect(block).toContain('[d-open]');
    expect(block).toContain('(2d ago)');
    expect(block).not.toContain('d-done'); // closed directives are not OPEN
    expect(block).toContain(RECENT_DISPATCHES_HEADER);
    expect(block).toContain('send_chat_message → c9 — nudged');
    expect(block).toContain('PROJECT STATUS:');
    expect(block).toContain('Digby: green');
    expect(block).toContain('NOTES:\nowner prefers quiet mornings');
  });

  it('omits empty sections (an empty doc renders the header only)', () => {
    const block = formatStateForWake({ ...EMPTY }, NOW);
    expect(block.trim()).toBe('[SUPERVISOR STATE — your durable memory across wakes. Update it before finishing with save_supervisor_state.]');
    expect(block).not.toContain('OPEN DIRECTIVES');
    expect(block).not.toContain('NOTES');
  });

  it('cap: oldest dispatches drop first (newest survive, notes untouched)', () => {
    const big: SupervisorStateDoc = {
      directives: [],
      archived: [], dispatches: Array.from({ length: 10 }, (_, i) => ({
        at: '2026-08-22T00:00:00.000Z', kind: 'start_coding_session', id: `sess-${i}`, note: 'n'.repeat(280),
      })),
      projects: [],
      refutations: [],
      notes: 'm'.repeat(4000),
      inflightPreemptAt: '',
    };
    const block = formatStateForWake(big, NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    expect(block).toContain(RECENT_DISPATCHES_HEADER);
    expect(block).not.toContain('sess-0'); // oldest dropped first
    expect(block).toContain('sess-9'); // newest kept
    expect(block).not.toContain('…[truncated]'); // notes fit once dispatches drop
  });

  it('cap: notes truncate once every dispatch has been dropped', () => {
    const big: SupervisorStateDoc = {
      directives: [{ id: 'd1', text: 'watch it', at: '2026-08-22T00:00:00.000Z', status: 'open' }],
      archived: [], dispatches: Array.from({ length: 30 }, (_, i) => ({
        at: '2026-08-22T00:00:00.000Z', kind: 'start_coding_session', id: `sess-${i}`, note: 'n'.repeat(280),
      })),
      projects: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, status: 's'.repeat(200), at: 'a' })),
      refutations: [],
      notes: 'm'.repeat(4000),
      inflightPreemptAt: '',
    };
    const block = formatStateForWake(big, NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    expect(block).not.toContain(RECENT_DISPATCHES_HEADER); // all dropped and still over →
    expect(block).toContain('…[truncated]'); // …notes truncated
    expect(block).toContain('[d1]'); // directives survive
    expect(block).toContain('P19'); // projects survive the dispatch/notes trims
  });

  // Autonomy loop #2 (2026-09-19): the Fleet Supervisor's 51 open directives
  // (42k chars) against the 6000-char block used to lose ~40 rows SILENTLY —
  // including standing owner grants — on every wake.
  it('cap: a directive ledger bigger than the block drops the oldest NON-standing rows first, keeps standing ones, and SAYS how many it hid', () => {
    const big: SupervisorStateDoc = {
      directives: [
        { id: 'std-old', text: 'STANDING: from now on ship without cards. ' + 'x'.repeat(300), at: '2026-08-01T00:00:00.000Z', status: 'open', standing: true },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `d-${i}`, text: `directive ${i} ` + 'y'.repeat(300), at: `2026-08-${String(2 + (i % 20)).padStart(2, '0')}T00:00:00.000Z`, status: 'open' as const })),
        { id: 'std-new', text: 'STANDING: never ask me about budgets. ' + 'z'.repeat(300), at: '2026-08-21T00:00:00.000Z', status: 'open', standing: true },
      ],
      archived: [], dispatches: [],
      projects: [],
      refutations: [],
      notes: '',
      inflightPreemptAt: '',
    };
    const block = formatStateForWake(big, NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    expect(block).toContain('[std-old]'); // standing rows survive even though oldest
    expect(block).toContain('[std-new]');
    expect(block).not.toContain('[d-0]'); // oldest non-standing dropped first
    expect(block).toContain('[d-29]'); // newest non-standing kept
    expect(block).toMatch(/…and \d+ older open directive\(s\) NOT shown \(d-0, d-1/);
    expect(block).toContain('Consolidate with save_supervisor_state');
  });

  it('no "NOT shown" line when every directive fits', () => {
    const block = formatStateForWake(DOC, NOW);
    expect(block).not.toContain('NOT shown');
  });
});

// ── buildFleetAttentionBlock (2026-08-30 fleet audit) ───────────────────────
// The live drift block injected under the durable doc on supervisor machine
// wakes: stalled in_progress todos, unstarted assigned todos, machine-written
// schedule prompts. TOTAL — any failure degrades to ''.

describe('buildFleetAttentionBlock', () => {
  beforeEach(() => {
    mockPrisma.projectTodo.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.chatSchedule.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.ownerQuestion.findMany.mockReset().mockResolvedValue([]);
  });

  it('returns empty when nothing is stale', async () => {
    await expect(buildFleetAttentionBlock(UID)).resolves.toBe('');
  });

  it('flags a stalled in_progress todo with its age + assignee suffix', async () => {
    mockPrisma.projectTodo.findMany
      .mockResolvedValueOnce([{ title: 'Hopper Machete-vs-Marlin bench', assigneeChatId: 'xxxx-xxxx-84adf975', updatedAt: new Date(Date.now() - 5 * 3600e3) }])
      .mockResolvedValueOnce([]); // the unstarted-pending query
    const block = await buildFleetAttentionBlock(UID);
    expect(block).toContain('FLEET ATTENTION');
    expect(block).toContain('STALLED todo "Hopper Machete-vs-Marlin bench"');
    expect(block).toContain('5h');
    expect(block).toContain('84adf975');
  });

  it('flags an assigned-but-pending todo older than 6h as UNSTARTED', async () => {
    mockPrisma.projectTodo.findMany
      .mockResolvedValueOnce([]) // stalled query
      .mockResolvedValueOnce([{ title: 'Head-to-head benchmark', assigneeChatId: 'xxxx-xxxx-84adf975', updatedAt: new Date(Date.now() - 22 * 3600e3) }]);
    const block = await buildFleetAttentionBlock(UID);
    expect(block).toContain('UNSTARTED todo "Head-to-head benchmark"');
    expect(block).toContain('22h');
  });

  // audit 2026-10-08 W1-7 REPLAY (supervisors F7): Schooltime's wake blocks carried "on chat …ec52d820";
  // the supervisor then called get_chat_status with "0037460b-…-ec52d820"-style splices 13 times in 24 h.
  it('W1-7: a lane chat id is rendered IN FULL (never "…<suffix>"); SUPERVISOR_STATE_FULL_IDS_DISABLED=1 restores the suffix', async () => {
    const LANE = '0037460b-b60b-456e-977f-a3127ec52d82';
    const schedRow = [{ id: '50532ee7-1111-4222-8333-444455556666', sessionId: LANE, createdAt: new Date(Date.now() - 2 * 86400e3) }];
    mockPrisma.chatSchedule.findMany.mockResolvedValue(schedRow);
    let block = await buildFleetAttentionBlock(UID, new Date());
    expect(block).toContain(`on chat ${LANE}`);
    expect(block).not.toMatch(/…[0-9a-f]{8}/);
    process.env.SUPERVISOR_STATE_FULL_IDS_DISABLED = '1';
    try {
      mockPrisma.chatSchedule.findMany.mockResolvedValue(schedRow);
      block = await buildFleetAttentionBlock(UID, new Date());
      expect(block).toContain('on chat …7ec52d82');
    } finally { delete process.env.SUPERVISOR_STATE_FULL_IDS_DISABLED; }
  });

  it('flags enabled machine-written schedule prompts for drift review — by the FULL id (ticket 03aef0da)', async () => {
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      { id: 'c461c912-8a2d-441e-a52a-ff2f9a9d9d69', sessionId: '810c924d-1d31-428c-bc6a-8120c132fcc4', createdAt: new Date(Date.now() - 7 * 86400e3) },
    ]);
    const now = new Date();
    const block = await buildFleetAttentionBlock(UID, now);
    // The 03aef0da shape: "schedule prompt c461c912… … schedule_get each" — an
    // 8-char prefix schedule_get could not resolve once the row aged out of its
    // listing window. The full id resolves at any status.
    // audit 2026-10-08 W1-7: the chat id is rendered IN FULL too (was "…c132fcc4" — the suffix the lanes spliced).
    expect(block).toContain('- schedule c461c912-8a2d-441e-a52a-ff2f9a9d9d69 on chat 810c924d-1d31-428c-bc6a-8120c132fcc4 (created 7d ago)');
    expect(block).not.toContain('c461c912…');
    expect(block).toContain('schedule_get each by the FULL id');
    expect(block).toContain('reads [stopped] was stopped since — skip it');
    // Still-live rows only: enabled AND not past their lifetime ceiling.
    expect(mockPrisma.chatSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: UID, enabled: true, promptSetBy: 'machine', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }));
  });

  it('FLEET_ATTENTION_FULL_SCHEDULE_IDS_DISABLED=1 restores the 8-char rendering + enabled-only pull', async () => {
    process.env.FLEET_ATTENTION_FULL_SCHEDULE_IDS_DISABLED = '1';
    try {
      mockPrisma.chatSchedule.findMany.mockResolvedValue([
        { id: 'f0160206-rest-of-id', sessionId: 'xxxx-84adf975', createdAt: new Date(Date.now() - 86400e3) },
      ]);
      const block = await buildFleetAttentionBlock(UID);
      expect(block).toContain('MACHINE-WRITTEN schedule prompt f0160206…');
      expect(block).toContain('schedule_get');
      expect(mockPrisma.chatSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: UID, enabled: true, promptSetBy: 'machine' },
      }));
    } finally {
      delete process.env.FLEET_ATTENTION_FULL_SCHEDULE_IDS_DISABLED;
    }
  });

  // Ticket 43212128 (2026-09-05 incident): open owner decisions must be
  // re-listed deterministically so the supervisor's notes can never assume
  // "the decisions you already know about". Ticket df4cff3c (2026-09-13 owner
  // complaint): the every-wake verbatim rule froze notes once cards stayed
  // open for days — NEW cards (<6h) still re-list verbatim every wake;
  // long-unchanged cards ride a one-line summary (full re-list ≤1×/6h).
  it('re-lists a NEW (<6h) OPEN owner decision VERBATIM with age + source chat', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Approve posting the upstream issue to tt-metal?', chatId: 'a8976e11-xxxx-yyyy-77b56d1c', createdAt: new Date(Date.now() - 2 * 3600e3) },
    ]);
    const block = await buildFleetAttentionBlock(UID);
    expect(block).toContain('FLEET ATTENTION');
    expect(block).toContain('OWNER DECISION open 2h');
    expect(block).toContain('"Approve posting the upstream issue to tt-metal?"');
    expect(block).toContain('(from chat a8976e11-xxxx-yyyy-77b56d1c)'); // audit 2026-10-08 W1-7: full id, never a suffix
    expect(block).toContain('never'.toUpperCase()); // the never-assume rule
    expect(block).not.toContain('open 6h+ unchanged'); // no summary line for fresh cards
  });

  it('compresses a long-unchanged (6h+) decision into ONE summary line — no verbatim text, no every-wake rule', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Approve posting the upstream issue to tt-metal?', chatId: 'a8976e11-xxxx-yyyy-77b56d1c', createdAt: new Date(Date.now() - 2 * 86400e3) },
    ]);
    const block = await buildFleetAttentionBlock(UID);
    expect(block).toContain('FLEET ATTENTION');
    expect(block).toContain('1 owner decision open 6h+ unchanged (oldest 2d) — see Management → Inbox');
    expect(block).toContain('never'.toUpperCase()); // the never-assume rule survives
    // the freeze fix: the verbatim card text and the every-wake instruction are GONE
    expect(block).not.toContain('Approve posting the upstream issue');
    expect(block).not.toContain('every wake until it resolves');
    expect(block).not.toContain('OWNER DECISION open 2d');
  });

  it('mixed ages: the fresh card stays verbatim, the stale one compresses — a new card surfaces verbatim immediately', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Old decision from yesterday?', chatId: 'chat-aaaa0001', createdAt: new Date(Date.now() - 26 * 3600e3) },
      { question: 'Fresh decision just flagged?', chatId: 'chat-bbbb0002', createdAt: new Date(Date.now() - 30 * 60e3) },
    ]);
    const block = await buildFleetAttentionBlock(UID);
    expect(block).toContain('OWNER DECISION open 30m — "Fresh decision just flagged?"');
    expect(block).toContain('1 owner decision open 6h+ unchanged (oldest 26h)');
    expect(block).not.toContain('Old decision from yesterday');
  });

  it('a decision exactly at the 6h window edge still counts as NEW (>= cutoff)', async () => {
    const now = new Date();
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Boundary decision?', chatId: 'chat-cccc0003', createdAt: new Date(now.getTime() - OWNER_DECISION_VERBATIM_WINDOW_MS) },
    ]);
    const block = await buildFleetAttentionBlock(UID, now);
    expect(block).toContain('OWNER DECISION open 6h — "Boundary decision?"');
    expect(block).not.toContain('open 6h+ unchanged');
  });

  it('owner-decision lines come FIRST (cap pressure drops later signal kinds)', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Decision one?', chatId: 'chat-aaaaaaa1', createdAt: new Date(Date.now() - 3600e3) },
    ]);
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      { id: 'f0160206-rest-of-id', sessionId: 'xxxx-84adf975', createdAt: new Date(Date.now() - 86400e3) },
    ]);
    const block = await buildFleetAttentionBlock(UID);
    expect(block.indexOf('OWNER DECISION')).toBeLessThan(block.indexOf('MACHINE-WRITTEN'));
  });

  it('a resolved (answered/dismissed) question leaves no line', async () => {
    // The service queries status:'open' only — the mock returning [] IS the
    // resolved case; assert the block stays empty.
    await expect(buildFleetAttentionBlock(UID)).resolves.toBe('');
    expect(mockPrisma.ownerQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: UID, status: 'open' } }),
    );
  });

  it('never throws — a DB hiccup degrades to an empty block', async () => {
    mockPrisma.projectTodo.findMany.mockRejectedValue(new Error('db down'));
    await expect(buildFleetAttentionBlock(UID)).resolves.toBe('');
  });
});

// ── Directive archive (autonomy loop #6, 2026-09-19): the Fleet Supervisor held
//    44 open directives (35 > 7 d) that the evidence-gated close could never
//    retire, so ~40 rows hid behind "NOT shown" on every wake for 16 h. ──
describe('directive archive', () => {
  // Anchored to the REAL clock (operator iteration 14, 2026-09-25): a fixed
  // 2026-09-19T16:00Z here was a time bomb — readSupervisorStateSection's
  // tidy compares directive ages against the real `new Date()`, so on
  // 2026-09-25 at 16:00Z the fixture's "1-day-old" rows crossed the 7-day
  // archive cutoff, the ledger trimmed to the 10-row floor, and every CI test
  // gate went red (deploy wave ccfa7c24 failed; nothing deployed).
  const NOW6 = new Date(Date.now() - 60_000);
  const day = 24 * 60 * 60 * 1000;
  const mk = (n: number, ageDays: number, extra: Partial<SupervisorStateDoc['directives'][number]> = {}) =>
    Array.from({ length: n }, (_, i) => ({ id: `${extra.standing ? 'std' : 'd'}-${ageDays}d-${i}`, text: `directive ${ageDays}d #${i}`, at: new Date(NOW6.getTime() - ageDays * day - i * 1000).toISOString(), status: 'open' as const, ...extra }));
  const base = (directives: SupervisorStateDoc['directives']): SupervisorStateDoc => ({ directives, archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' });

  it('moves OPEN non-standing rows older than 7 d, oldest first, only down to MIN_OPEN live rows; standing / done / fresh rows never move', () => {
    const doc = base([
      ...mk(2, 30, { standing: true }),
      ...mk(20, 12),
      ...mk(3, 8, { status: 'done', evidence: 'PR #1' } as any),
      ...mk(10, 2),
    ]);
    const { doc: out, moved } = archiveStaleDirectives(doc, NOW6);
    // 30 open non-standing rows (20 × 12 d + 10 × 2 d) → down to MIN_OPEN: moved rows all come from the 12 d cohort, oldest first.
    expect(moved).toHaveLength(30 - DIRECTIVE_ARCHIVE_MIN_OPEN);
    expect(moved.every((d) => d.id.startsWith('d-12d-'))).toBe(true);
    expect(moved[0].id).toBe('d-12d-19'); // oldest (largest i) first
    expect(out.archived).toHaveLength(30 - DIRECTIVE_ARCHIVE_MIN_OPEN);
    expect(out.archived.every((d) => d.archivedAt === NOW6.toISOString())).toBe(true);
    expect(out.directives.filter((d) => d.standing)).toHaveLength(2);
    expect(out.directives.filter((d) => d.status === 'done')).toHaveLength(3);
    expect(out.directives.filter((d) => d.id.startsWith('d-2d-'))).toHaveLength(10);
    expect(out.directives.filter((d) => d.status === 'open' && !d.standing)).toHaveLength(DIRECTIVE_ARCHIVE_MIN_OPEN);
    // A short ledger keeps its history in view even when old.
    expect(archiveStaleDirectives(base(mk(10, 30)), NOW6).moved).toEqual([]);
    expect(DIRECTIVE_ARCHIVE_AFTER_MS).toBe(7 * day);
  });

  it('the wake block names the archive (count + how to read / revive) and no longer hides those rows', () => {
    const { doc } = archiveStaleDirectives(base([...mk(30, 12), ...mk(5, 1)]), NOW6);
    const block = formatStateForWake(doc, NOW6);
    expect(block).toContain(`${35 - DIRECTIVE_ARCHIVE_MIN_OPEN} older directive(s) ARCHIVED`);
    expect(block).toContain("get_supervisor_state({section:'archived'");
    expect(block).toContain("status:'open'}]}) revives one");
    expect(block).not.toContain('NOT shown');
  });

  it('applyStateUpdate: an archived id is real — status:open REVIVES it with a fresh `at`; the write path persists the tidy and records the metric', async () => {
    const seeded = base([...mk(30, 12), ...mk(5, 1)]);
    mockPrisma.supervisorState.findUnique.mockResolvedValue({ state: seeded });
    mockPrisma.supervisorState.upsert.mockResolvedValue({});
    const victim = 'd-12d-29'; // the oldest → archived by the read-side tidy
    const MOVED = 35 - DIRECTIVE_ARCHIVE_MIN_OPEN; // 30 twelve-day rows + 5 fresh → archive down to the floor
    const read = await readSupervisorStateSection('chat-6', { section: 'archived', query: '12d #29' });
    expect(read.counts).toMatchObject({ archived: MOVED, open: DIRECTIVE_ARCHIVE_MIN_OPEN });
    expect((read.archived as any[]).map((d) => d.id)).toEqual([victim]);
    expect(String(read.archiveRule)).toMatch(/older than 7 days/);
    const r = await applyStateUpdate('chat-6', 'u1', { directives: [{ id: victim, status: 'open' }] });
    expect(r.errors).toEqual([]);
    expect(r.applied.join(' ')).toMatch(/revived from the archive/);
    const written = mockPrisma.supervisorState.upsert.mock.calls.at(-1)[0].update.state as SupervisorStateDoc;
    const revived = written.directives.find((d) => d.id === victim)!;
    expect(revived).toBeTruthy();
    expect(revived.archivedAt).toBeUndefined();
    expect(Date.parse(revived.at)).toBeGreaterThan(Date.now() - 60_000); // fresh — otherwise the tidy re-archives it at once
    expect(written.archived.find((d) => d.id === victim)).toBeUndefined();
    // The revive lifted the live open count above MIN_OPEN, so the post-mutate tidy moved the
    // next-oldest 12 d row out — the ledger stays at MIN_OPEN old rows; the revived row is fresh and stays.
    expect(written.archived).toHaveLength(MOVED);
    expect(written.archived.some((d) => d.id === `d-12d-${29 - MOVED}`)).toBe(true);
    expect(written.directives.filter((d) => d.status === 'open' && !d.standing)).toHaveLength(DIRECTIVE_ARCHIVE_MIN_OPEN);
    // An unknown id still fails, and the message points at the read tool.
    const bad = await applyStateUpdate('chat-6', 'u1', { directives: [{ id: 'ffffffff-0000-0000-0000-000000000000', status: 'open' }] });
    expect(bad.errors.join(' ')).toMatch(/get_supervisor_state/);
  });

  it('readSupervisorStateSection bounds its JSON and defaults to all sections newest-first', async () => {
    // Hermetic vs the read path's REAL clock: readSupervisorStateSection runs
    // its read-side tidy against Date.now() (getSupervisorState →
    // archiveStaleDirectives with the default now), so seeding `at` relative
    // to the fixed NOW6 rots this fixture once real time passes NOW6 + the
    // 7-day archive threshold — it did at 2026-09-25T16:00Z, when the "1 day"
    // rows crossed 7 d, 30 of 40 silently archived, and [0].id flipped to
    // 'd-1d-9'. Seed `at` relative to the RUN clock instead: always ~1 minute
    // old at execution time, never archived, forever. (The sibling tests pass
    // NOW6 into archiveStaleDirectives explicitly and stay hermetic.)
    const seeded = base([...mk(40, 1).map((d) => ({ ...d, at: new Date(Date.now() - 60_000).toISOString(), text: 'x'.repeat(480) }))]);
    mockPrisma.supervisorState.findUnique.mockResolvedValue({ state: seeded });
    const all = await readSupervisorStateSection('chat-6', {});
    expect(all.section).toBe('all');
    expect((all.directives as any[])[0].id).toBe('d-1d-39');
    expect(JSON.stringify(all).length).toBeLessThanOrEqual(12_000 + 200);
    expect(all.truncated).toBe(true);
    const few = await readSupervisorStateSection('chat-6', { section: 'directives', limit: 3 });
    expect((few.directives as any[])).toHaveLength(3);
    expect(few.archived).toBeUndefined();
  });
});


// ── KPI annotation of project lines (tt-rd audit 2026-09-27, finding 2d) ─────
describe('formatStateForWake — [register now: …] KPI annotation (kpi-honesty-loops finding 2d)', () => {
  const NOW = new Date('2026-09-27T15:22:15Z');
  const KPIS = [{ goalId: 'g', projectId: 'p', key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', setAt: '2026-09-27T13:22:15Z', receiptId: 'f5b42fe6-1111-4000-8000-000000000000' }];
  const DOC: SupervisorStateDoc = {
    directives: [], archived: [], dispatches: [], refutations: [], notes: '', inflightPreemptAt: '',
    projects: [
      { name: 'tt-rd', status: 'speed lane mid-firing; e2e premise 2.464 tok/s F-301 03:24Z', at: 'a' },
      { name: 'CanLaw', status: 'SFT-2 chain running', at: 'a' },
    ],
  };

  it('appends the live register value to a project line that types a KPI rate; other lines stay verbatim; no kpis ⇒ verbatim', () => {
    const block = formatStateForWake(DOC, NOW, { kpis: KPIS as any });
    expect(block).toContain('- tt-rd: speed lane mid-firing; e2e premise 2.464 tok/s F-301 03:24Z [register now: client_visible_e2e_tok_s=5.08 tok/s @13:22Z receipt f5b42fe6]');
    expect(block).toMatch(/- CanLaw: SFT-2 chain running(\n|$)/);
    expect(formatStateForWake(DOC, NOW)).not.toContain('[register now:');
  });
});
