/**
 * Replay pin — ticket ba41858d (P2): extend the moot / premise-invalidation
 * auto-resolve (3ce5f6d0, PR #664 — cancel_schedule only) to the three
 * incident-class tools of the 2026-08-11 16:33Z stale-card incident:
 * schedule_message, send_chat_message, start_coding_session. A staged
 * confirmation card whose directive was SUPERSEDED out-of-band while it sat
 * in the owner inbox used to keep firing verbatim when the owner finally
 * clicked — the moot checker now resolves it 'moot' WITH a receipt (result
 * json + lane transcript note) on the listing-time sweep and the consume
 * path (the REST confirm path rides the same resolveConfirmationIfMoot).
 *
 * Per-tool deterministic end states (pending-confirmations.ts
 * mootReasonForStagedAction):
 *   - schedule_message: an ENABLED, still-live schedule with the SAME
 *     whitespace/case-normalized prompt, kind and interval already exists on
 *     the target chat (the lane re-armed the directive out-of-band).
 *   - send_chat_message: the identical message is verifiably ALREADY
 *     DELIVERED — exact content (the deterministic [AGENT-SENT MESSAGE — …]
 *     header stripped), metadata.origin 'agent' from THIS staging lane,
 *     createdAt strictly after the card was staged.
 *   - start_coding_session: an identical child session exists — strict
 *     lineage (parentChatId = the staging lane), canonical project, exact
 *     title derivation, same first prompt (delivered row or Redis stash),
 *     created after staging, not archived.
 *
 * Each tool pins BOTH halves: (a) the superseded premise resolves 'moot'
 * with receipt + lane note, and (b) a NOT-yet-moot staging NEVER
 * auto-resolves — a live premise keeps the card and a later user-turn
 * confirm still executes the staged args (fail-open doctrine: a missed moot
 * keeps the card; a wrongly-mooted card would silently drop an owner
 * decision).
 *
 * Mock discipline mirrors owner-inbox-noise.3ce5f6d0.test.ts: the REAL
 * registry runs against the in-memory testkit pendingConfirmation table; the
 * checker-facing tables are small filter-APPLYING in-memory tables so the
 * fail-open pins exercise the real where-clauses (metadata paths, createdAt
 * bounds, lineage) instead of canned returns.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// config/redis — the start_coding_session checker's pre-delivery first-prompt
// stash (first-prompt-recovery PENDING_KEY). Real module pulls config/env
// (process.exit at import).
const mockRedisGet = jest.fn(async (..._a: any[]) => null as string | null);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockRedisGet(...a), set: jest.fn(), del: jest.fn() },
}));

// platform.service — only the coding-session TARGET canonicalizer is used by
// the checker (the staged projectId may re-file into a workspace ancestor).
const mockResolveCodingSessionTarget = jest.fn();
jest.mock('./platform.service', () => ({
  __esModule: true,
  resolveCodingSessionTarget: (...a: any[]) => mockResolveCodingSessionTarget(...a),
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { agentSendHeader } from './agent-send-header';

/* ── Filter-applying in-memory tables for the checker reads ──────────────────
 * Supports exactly the where operators the moot checkers emit: scalar
 * equality, { startsWith }, { gt } (date), { in }, Json { path, equals },
 * top-level AND/OR — so a fail-open pin proves the CHECKER'S OWN where clause
 * excludes the row (an owner retype, a foreign lane, an archived child), not
 * just that a canned mock returned []. */
const isCondObj = (v: any) => v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
function matchField(val: any, cond: any): boolean {
  if (isCondObj(cond)) {
    if ('path' in cond) {
      let cur = val;
      for (const p of cond.path) cur = cur?.[p];
      return matchField(cur, cond.equals);
    }
    if ('startsWith' in cond) return typeof val === 'string' && val.startsWith(cond.startsWith);
    let known = false;
    if ('gt' in cond) { known = true; if (!(new Date(val).getTime() > new Date(cond.gt).getTime())) return false; }
    if ('in' in cond) { known = true; if (!cond.in.includes(val)) return false; }
    return known;
  }
  return val === cond;
}
function matchWhere(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (k === 'AND') return (v as any[]).every((c) => matchWhere(row, c));
    if (k === 'OR') return (v as any[]).some((c) => matchWhere(row, c));
    return matchField(row[k], v);
  });
}
function makeTable() {
  const rows: any[] = [];
  const query = ({ where, orderBy, take }: any = {}) => {
    let out = rows.filter((r) => matchWhere(r, where));
    if (orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    if (orderBy?.createdAt === 'asc') out = [...out].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    if (take) out = out.slice(0, take);
    return out;
  };
  return {
    rows,
    reset: () => { rows.length = 0; },
    findMany: jest.fn(async (args: any = {}) => query(args)),
    findFirst: jest.fn(async (args: any = {}) => query({ ...args, take: 1 })[0] ?? null),
  };
}

const mockConfirmations = createPendingConfirmationTable();
const schedules = makeTable();   // chatSchedule
const messages = makeTable();    // crossModelMessage
const chats = makeTable();       // crossModelChat (child-session lineage)
const mockMessageCreate = jest.fn(async (..._a: any[]) => ({}));
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    chatSchedule: {
      findMany: (...a: any[]) => schedules.findMany(...a),
      findFirst: (...a: any[]) => schedules.findFirst(...a),
    },
    crossModelMessage: {
      findMany: (...a: any[]) => messages.findMany(...a),
      findFirst: (...a: any[]) => messages.findFirst(...a),
      create: (...a: any[]) => mockMessageCreate(...a),
    },
    crossModelChat: {
      findMany: (...a: any[]) => chats.findMany(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
    },
  },
}));

import {
  consumePendingConfirmation,
  getPendingConfirmation,
  listPendingConfirmationsForUser,
  registerPendingConfirmation,
} from './pending-confirmations';

const LANE = 'lane-1';
const USER = 'u1';

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  schedules.reset();
  messages.reset();
  chats.reset();
  mockRedisGet.mockResolvedValue(null);
  mockResolveCodingSessionTarget.mockResolvedValue({ ok: true, projectId: 'proj-1', source: 'direct' });
});

/** The staged row's createdAt (the checkers' stagedAt anchor). */
async function stagedAt(confirmationId: string): Promise<Date> {
  const row = await getPendingConfirmation(confirmationId);
  return row!.createdAt;
}

/** Shared assertions for a moot resolution: status + receipt + lane note. */
async function expectMootedWithReceipt(confirmationId: string, reasonPart: string) {
  const row = await getPendingConfirmation(confirmationId);
  expect(row!.status).toBe('moot');
  expect(row!.result).toMatchObject({ moot: true, reason: expect.stringContaining(reasonPart) });
  expect(row!.resolvedAt).not.toBeNull();
  expect(mockMessageCreate).toHaveBeenCalledWith({
    data: expect.objectContaining({
      chatId: LANE, role: 'assistant',
      content: expect.stringContaining('MOOT'),
      metadata: { origin: 'owner-inbox' },
    }),
  });
}

/** Shared assertions for the fail-open half: the card stays pending, no lane
 *  note posts, and a LATER user-turn confirm still executes the staged args. */
async function expectKeptAndConfirmable(confirmationId: string, tool: string, stagedArgs: any) {
  expect((await getPendingConfirmation(confirmationId))!.status).toBe('pending');
  expect(mockMessageCreate).not.toHaveBeenCalled();
  const check = await consumePendingConfirmation({
    confirmationId, sessionId: LANE, tool,
    userTurnAt: new Date((await stagedAt(confirmationId)).getTime() + 1000),
  });
  expect(check).toEqual({ ok: true, args: stagedArgs });
  expect((await getPendingConfirmation(confirmationId))!.status).toBe('consumed');
}

/* ── A) schedule_message (ba41858d) ────────────────────────────────────────── */

describe('A) schedule_message moot — superseded arm (ba41858d)', () => {
  const ARGS = { chatId: 'chat-target', prompt: 'nightly digest sweep', kind: 'recurring', intervalMinutes: 60 };
  const stage = () => registerPendingConfirmation({
    sessionId: LANE, userId: USER, tool: 'schedule_message',
    args: ARGS, summary: 'Schedule a prompt to run every 60 minutes on chat chat-target: "nightly digest sweep"',
  });
  const armedRow = (over: any = {}) => ({
    id: 'sched-dup', userId: USER, sessionId: 'chat-target', prompt: 'nightly digest sweep',
    kind: 'recurring', intervalSec: 3600, enabled: true, runsCount: 0, maxRuns: null,
    ...over,
  });

  it('resolves MOOT at listing time when the lane re-armed the identical schedule out-of-band — receipt + lane note (the 16:33Z class)', async () => {
    const { confirmationId } = await stage();
    // The superseding arm landed while the card sat — different casing/extra
    // whitespace in the stored prompt must still match (the create-time
    // duplicate-backstop's own normalization).
    schedules.rows.push(armedRow({ prompt: '  Nightly   Digest\nSweep ' }));

    const listed = await listPendingConfirmationsForUser(USER);

    expect(listed).toEqual([]);
    await expectMootedWithReceipt(confirmationId, 'already has an enabled identical recurring schedule sched-dup');
  });

  it('the lane sees a MOOT result on the consume path (a re-call with confirmationId never executes)', async () => {
    const { confirmationId } = await stage();
    schedules.rows.push(armedRow());

    const check = await consumePendingConfirmation({
      confirmationId, sessionId: LANE, tool: 'schedule_message',
      userTurnAt: new Date((await stagedAt(confirmationId)).getTime() + 1000),
    });

    expect(check).toEqual({ ok: false, reason: 'moot', detail: expect.stringContaining('duplicate') });
    expect((await getPendingConfirmation(confirmationId))!.status).toBe('moot');
  });

  it('NEVER moots a live premise: no matching schedule → the card stays and a later user-turn confirm executes the staged args', async () => {
    const { confirmationId } = await stage();
    schedules.rows.push(armedRow({ id: 'sched-other', prompt: 'a different job entirely' }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'schedule_message', ARGS);
  });

  it('NEVER moots on a DIFFERENT cadence (same prompt, 120m vs the staged 60m — a different schedule, not a duplicate)', async () => {
    const { confirmationId } = await stage();
    schedules.rows.push(armedRow({ intervalSec: 7200 }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'schedule_message', ARGS);
  });

  it('NEVER moots on an EXHAUSTED identical one-shot (runsCount = maxRuns — a chain’s next-link re-arm is not a duplicate)', async () => {
    const onceArgs = { chatId: 'chat-target', prompt: 'verdict wait backstop', kind: 'once', intervalMinutes: 30 };
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: LANE, userId: USER, tool: 'schedule_message', args: onceArgs, summary: 's',
    });
    schedules.rows.push(armedRow({
      prompt: 'verdict wait backstop', kind: 'once', intervalSec: 1800, maxRuns: 1, runsCount: 1, // already FIRED
    }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'schedule_message', onceArgs);
  });

  it('NEVER moots on a DISABLED identical row (not an armed duplicate — confirming arms it fresh)', async () => {
    const { confirmationId } = await stage();
    schedules.rows.push(armedRow({ enabled: false }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'schedule_message', ARGS);
  });

  it('prefix tolerance: an 8-char staged chatId moots when it names exactly ONE chat with the duplicate', async () => {
    const UUID_A = 'a1b2c3d4-0000-4000-8000-0000000000aa';
    const prefixed = { ...ARGS, chatId: 'a1b2c3d4' }; // fleet-idiom ≥8-char prefix
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: LANE, userId: USER, tool: 'schedule_message', args: prefixed, summary: 's',
    });
    schedules.rows.push(armedRow({ sessionId: UUID_A })); // the only chat under the prefix

    const check = await consumePendingConfirmation({
      confirmationId, sessionId: LANE, tool: 'schedule_message',
      userTurnAt: new Date((await stagedAt(confirmationId)).getTime() + 1000),
    });
    expect(check).toEqual({ ok: false, reason: 'moot', detail: expect.stringContaining('sched-dup') });
  });

  it('prefix tolerance: NEVER moots when an 8-char staged chatId names TWO chats with candidate rows (ambiguity is not moot)', async () => {
    const UUID_A = 'a1b2c3d4-0000-4000-8000-0000000000aa';
    const UUID_B = 'a1b2c3d4-9999-4000-8000-0000000000bb';
    const prefixed = { ...ARGS, chatId: 'a1b2c3d4' };
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: LANE, userId: USER, tool: 'schedule_message', args: prefixed, summary: 's',
    });
    schedules.rows.push(armedRow({ sessionId: UUID_A }));
    schedules.rows.push(armedRow({ id: 'sched-other-chat', sessionId: UUID_B }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'schedule_message', prefixed);
  });
});

/* ── B) send_chat_message (ba41858d) ───────────────────────────────────────── */

describe('B) send_chat_message moot — identical message already delivered (ba41858d)', () => {
  const TARGET = 'chat-target';
  const ARGS = { chatId: TARGET, content: 'The verdict is in — please review PR #867.' };
  const HEADER = agentSendHeader('Kernel lane', LANE, 'crossmodel'); // the REAL header builder
  const stage = (args: any = ARGS) => registerPendingConfirmation({
    sessionId: LANE, userId: USER, tool: 'send_chat_message',
    args, summary: `Send this message to chat ${TARGET} as you: "${ARGS.content}"`,
  });
  const deliveredRow = (createdAt: Date, over: any = {}) => ({
    id: 'msg-dup', chatId: TARGET, role: 'user',
    content: HEADER + ARGS.content, // delivery prepends the provenance header
    metadata: { origin: 'agent', sourceChatId: LANE },
    createdAt,
    ...over,
  });

  it('resolves MOOT at listing time when the lane re-sent the identical message out-of-band (headered row) — receipt + lane note', async () => {
    const { confirmationId } = await stage();
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() + 60_000)));

    const listed = await listPendingConfirmationsForUser(USER);

    expect(listed).toEqual([]);
    await expectMootedWithReceipt(confirmationId, 'the identical message is already delivered');
  });

  it('resolves MOOT on the consume path for a headerless exact-content delivery (the deterministic strip is idempotent)', async () => {
    const { confirmationId } = await stage();
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() + 60_000), {
      id: 'msg-plain', content: ARGS.content,
    }));

    const check = await consumePendingConfirmation({
      confirmationId, sessionId: LANE, tool: 'send_chat_message',
      userTurnAt: new Date((await stagedAt(confirmationId)).getTime() + 1000),
    });

    expect(check).toEqual({ ok: false, reason: 'moot', detail: expect.stringContaining('already delivered') });
  });

  it('NEVER moots a live premise: nothing delivered after staging → the card stays and a later confirm executes', async () => {
    const { confirmationId } = await stage();

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', ARGS);
  });

  it('NEVER moots on the OWNER’s own identical retype (metadata.origin absent — a human repeat is a deliberate repeat)', async () => {
    const { confirmationId } = await stage();
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() + 60_000), {
      content: ARGS.content, metadata: { authorId: USER }, // human-origin row: no agent stamp
    }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', ARGS);
  });

  it('NEVER moots on an identical delivery from a DIFFERENT lane (provenance must name the staging lane)', async () => {
    const { confirmationId } = await stage();
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() + 60_000), {
      metadata: { origin: 'agent', sourceChatId: 'lane-OTHER' },
    }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', ARGS);
  });

  it('NEVER moots on an identical delivery created BEFORE the card was staged (no superseding re-send happened)', async () => {
    const { confirmationId } = await stage();
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() - 60_000)));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', ARGS);
  });

  it('NEVER moots on a NEAR-duplicate (identical prefix, extra sentence — exact content or nothing)', async () => {
    const { confirmationId } = await stage();
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() + 60_000), {
      content: HEADER + `${ARGS.content} Also: the deploy finished.`,
    }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', ARGS);
  });

  it('NEVER moots an attachment-carrying staged send (uploadIds transform the delivered body — unverifiable, fail open)', async () => {
    const withUploads = { ...ARGS, uploadIds: ['upl_1'] };
    const { confirmationId } = await stage(withUploads);
    messages.rows.push(deliveredRow(new Date((await stagedAt(confirmationId)).getTime() + 60_000)));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    expect(messages.findMany).not.toHaveBeenCalled(); // short-circuits before the read
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', withUploads);
  });
});

/* ── C) start_coding_session (ba41858d) ────────────────────────────────────── */

describe('C) start_coding_session moot — identical child session already exists (ba41858d)', () => {
  const ARGS = { projectId: 'proj-1', title: 'Fix the sweep doctrine', prompt: 'Implement ticket ba41858d end to end.' };
  const PARENT_BLOCK =
    '[PARENT SESSION CONTEXT — what the session that spawned you recently did, decided, and learned; newest first]\n' +
    '- 2026-09-19: moot checkers → shipped';
  const stage = (args: any = ARGS) => registerPendingConfirmation({
    sessionId: LANE, userId: USER, tool: 'start_coding_session',
    args, summary: `Start a new coding session in project ${ARGS.projectId} titled "${ARGS.title}".`,
  });
  const childRow = (createdAt: Date, over: any = {}) => ({
    id: 'child-1', userId: USER, parentChatId: LANE, projectId: 'proj-1',
    title: ARGS.title, archivedAt: null, createdAt,
    ...over,
  });

  it('resolves MOOT at listing time when the lane re-spawned the identical session out-of-band (delivered first prompt, full spawn chrome) — receipt + lane note', async () => {
    const { confirmationId } = await stage();
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after));
    // The REAL delivery shape: [AGENT-SENT MESSAGE — …] header + the optional
    // [PARENT SESSION CONTEXT — …] digest + the staged prompt as the suffix.
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user',
      content: agentSendHeader('Kernel lane', LANE, 'crossmodel') + `${PARENT_BLOCK}\n\n${ARGS.prompt}`,
      metadata: { origin: 'agent', sourceChatId: LANE },
      createdAt: after,
    });

    const listed = await listPendingConfirmationsForUser(USER);

    expect(listed).toEqual([]);
    await expectMootedWithReceipt(confirmationId, 'an identical coding session already exists — chat child-1');
  });

  it('resolves MOOT on the consume path while the first prompt is still only in the Redis stash (pre-delivery window)', async () => {
    const { confirmationId } = await stage();
    const after = new Date((await stagedAt(confirmationId)).getTime() + 30_000);
    chats.rows.push(childRow(after));
    // No message row yet (workspace still provisioning); the durable stash holds it.
    mockRedisGet.mockResolvedValue(JSON.stringify({ prompt: ARGS.prompt, origin: { kind: 'agent', sourceChatId: LANE } }));

    const check = await consumePendingConfirmation({
      confirmationId, sessionId: LANE, tool: 'start_coding_session',
      userTurnAt: new Date((await stagedAt(confirmationId)).getTime() + 1000),
    });

    expect(check).toEqual({ ok: false, reason: 'moot', detail: expect.stringContaining('same first prompt') });
    expect(mockRedisGet).toHaveBeenCalledWith('coding:first-prompt:pending:child-1');
  });

  it('resolves MOOT across the ancestor re-file (staged a plain sub-folder; the child landed in the canonical workspace project)', async () => {
    const subFolderArgs = { ...ARGS, projectId: 'proj-subfolder' };
    const { confirmationId } = await stage(subFolderArgs);
    mockResolveCodingSessionTarget.mockResolvedValue({ ok: true, projectId: 'proj-1', source: 'ancestor' });
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after)); // filed in the canonical proj-1
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user', content: ARGS.prompt,
      metadata: { origin: 'agent', sourceChatId: LANE }, createdAt: after,
    });

    const listed = await listPendingConfirmationsForUser(USER);

    expect(listed).toEqual([]);
    await expectMootedWithReceipt(confirmationId, 'an identical coding session already exists');
  });

  it('NEVER moots a live premise: no child exists → the card stays and a later confirm executes the staged args', async () => {
    const { confirmationId } = await stage();

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', ARGS);
  });

  it('NEVER moots on a DIFFERENT first prompt (same project + title + lineage is not an identical session)', async () => {
    const { confirmationId } = await stage();
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after));
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user', content: 'A completely different brief.',
      metadata: { origin: 'agent', sourceChatId: LANE }, createdAt: after,
    });

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', ARGS);
  });

  it('NEVER moots when the child\'s DIFFERENT first prompt merely ENDS with \'\\n\\n\' + the staged prompt (reviewer D-F1: a staged \'continue\' false-mooted against \'Review the migration first.\\n\\ncontinue\' — the endsWith chrome match could not locate the digest boundary)', async () => {
    const shortArgs = { ...ARGS, prompt: 'continue' };
    const { confirmationId } = await stage(shortArgs);
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after));
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user',
      content: agentSendHeader('Kernel lane', LANE, 'crossmodel') + `${PARENT_BLOCK}\n\nReview the migration first.\n\ncontinue`,
      metadata: { origin: 'agent', sourceChatId: LANE },
      createdAt: after,
    });

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', shortArgs);
  });

  it('NEVER moots the same suffix trap through the pre-delivery stash path (D-F1 variant — the stash holds the SAME enriched prompt)', async () => {
    const shortArgs = { ...ARGS, prompt: 'continue' };
    const { confirmationId } = await stage(shortArgs);
    const after = new Date((await stagedAt(confirmationId)).getTime() + 30_000);
    chats.rows.push(childRow(after));
    // No delivered message yet; the stash carries block + '\n\n' + a DIFFERENT
    // prompt that merely ends with '\n\ncontinue'.
    mockRedisGet.mockResolvedValue(JSON.stringify({
      prompt: `${PARENT_BLOCK}\n\nReview the migration first.\n\ncontinue`,
      origin: { kind: 'agent', sourceChatId: LANE },
    }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', shortArgs);
  });

  it('still resolves MOOT when the staged prompt is itself MULTI-LINE and matches EXACTLY after the chrome (the D-F1 fix must not over-tighten past exact equality)', async () => {
    const multiArgs = { ...ARGS, prompt: 'Review the migration first.\n\ncontinue' };
    const { confirmationId } = await stage(multiArgs);
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after));
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user',
      content: `${PARENT_BLOCK}\n\nReview the migration first.\n\ncontinue`,
      metadata: { origin: 'agent', sourceChatId: LANE },
      createdAt: after,
    });

    expect(await listPendingConfirmationsForUser(USER)).toEqual([]);
    await expectMootedWithReceipt(confirmationId, 'an identical coding session already exists');
  });

  it('NEVER moots on an ARCHIVED identical child (archive is not the armed end state — the owner may want a fresh one)', async () => {
    const { confirmationId } = await stage();
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after, { archivedAt: new Date(after.getTime() + 1000) }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', ARGS);
  });

  it('NEVER moots on an identical session parented to a DIFFERENT lane (strict lineage — an owner/UI spawn is not this card’s premise)', async () => {
    const { confirmationId } = await stage();
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after, { parentChatId: null })); // owner-spawned from the UI

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', ARGS);
  });

  it('NEVER moots on a child created BEFORE the card was staged (the spawn the card stages is a NEW one)', async () => {
    const { confirmationId } = await stage();
    const before = new Date((await stagedAt(confirmationId)).getTime() - 60_000);
    chats.rows.push(childRow(before));
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user', content: ARGS.prompt,
      metadata: { origin: 'agent', sourceChatId: LANE }, createdAt: before,
    });

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', ARGS);
  });

  it('NEVER moots a PROMPTLESS staged spawn (no first prompt to identity-match — title+project alone is too loose)', async () => {
    const promptless = { projectId: 'proj-1', title: ARGS.title };
    const { confirmationId } = await stage(promptless);
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after, { title: ARGS.title }));

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', promptless);
  });

  it('NEVER moots when the staged project no longer resolves (the canonical target is unverifiable — fail open)', async () => {
    const { confirmationId } = await stage();
    mockResolveCodingSessionTarget.mockResolvedValue({ ok: false, reason: 'not_found' });
    const after = new Date((await stagedAt(confirmationId)).getTime() + 60_000);
    chats.rows.push(childRow(after));
    messages.rows.push({
      id: 'msg-first', chatId: 'child-1', role: 'user', content: ARGS.prompt,
      metadata: { origin: 'agent', sourceChatId: LANE }, createdAt: after,
    });

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'start_coding_session', ARGS);
  });
});

/* ── D) doctrine pins (ba41858d) ───────────────────────────────────────────── */

describe('D) fail-open doctrine (ba41858d)', () => {
  it('a tool WITHOUT a checker (update_schedule) is never auto-resolved even with a staged row', async () => {
    const args = { id: 'sched-1', prompt: 'x' };
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: LANE, userId: USER, tool: 'update_schedule', args, summary: 's',
    });

    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'update_schedule', args);
  });

  it('a checker READ FAILURE fails OPEN (the card stays live — a missed moot never drops an owner decision)', async () => {
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: LANE, userId: USER, tool: 'send_chat_message',
      args: { chatId: 'chat-target', content: 'ping' }, summary: 's',
    });
    messages.findMany.mockRejectedValueOnce(new Error('connection terminated'));

    // The sweep hiccup keeps the card; the next listing retries and (with the
    // table healthy again) still finds nothing moot → confirmable.
    expect((await listPendingConfirmationsForUser(USER)).map((r: any) => r.id)).toEqual([confirmationId]);
    await expectKeptAndConfirmable(confirmationId, 'send_chat_message', { chatId: 'chat-target', content: 'ping' });
  });
});
