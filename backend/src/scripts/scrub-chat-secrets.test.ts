/**
 * scripts/framework-audit/scrub-chat-secrets.js — the audit 2026-10-06 T2-4
 * one-shot that rewrites ALREADY-STORED credential copies (transcripts,
 * coding transcripts, owner questions, supervisor docs, hook payloads, the
 * busy-chat queue and the named chats' run events) through the shared
 * redaction, on an in-memory Prisma double: a scope is required, the dry run
 * writes nothing and never prints a secret, --apply writes through guarded
 * updates, a row that moved is skipped, other chats are untouched, a second
 * pass is a no-op. FAKE values only.
 */
import path from 'path';
import { redactSecrets, findSecretSpans, REDACTED_NOTE } from '../modules/crossmodel/platform/secret-scan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'scrub-chat-secrets.js'));

const FAKE_PW = 'Hue2024!x';
const FAKE_KEY = 'sk-' + 'FAKEfakeFAKEfake1234567890ab';
const PS = 'chat-ps-00000001';
const LANE = 'chat-lane-0000002';
const OTHER = 'chat-other-000003';
const T0 = new Date('2026-10-05T18:00:00Z');
const T1 = new Date('2026-10-06T01:00:00Z');

function pick(row: any, select: any) {
  const out: any = {};
  for (const k of Object.keys(select || row)) if (!select || select[k]) out[k] = row[k] === undefined ? undefined : JSON.parse(JSON.stringify(row[k], (_k, v) => (typeof v === 'bigint' ? `__big:${v}` : v)), (_k, v) => (typeof v === 'string' && v.startsWith('__big:') ? BigInt(v.slice(6)) : v));
  for (const k of Object.keys(out)) if (row[k] instanceof Date) out[k] = new Date(row[k]);
  return out;
}
function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'AND') return v.every((w: any) => matches(row, w));
    if (k === 'OR') return v.some((w: any) => matches(row, w));
    const val = row[k];
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    if (v && typeof v === 'object') {
      if ('in' in v) return v.in.includes(val);
      if ('gte' in v) return val >= v.gte;
      if ('gt' in v) return val > v.gt;
      if ('path' in v) return v.path.reduce((o: any, p: string) => (o == null ? o : o[p]), val) === v.equals;
      return false;
    }
    if (v === null) return val == null;
    return val === v;
  });
}
function table(rows: any[], opts: { moveOnWrite?: boolean } = {}) {
  return {
    rows,
    findMany: jest.fn(async ({ where, select, take }: any) => rows
      .filter((r) => matches(r, where))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, take ?? Infinity)
      .map((r) => pick(r, select))),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) return { count: 0 };
      if (opts.moveOnWrite) { if ('updatedAt' in row) row.updatedAt = new Date(+(row.updatedAt ?? T1) + 1000); if (typeof row.content === 'string') row.content += ' (edited)'; for (const f of ['answer', 'context']) if (typeof row[f] === 'string') row[f] += ' (edited)'; if (row.type) row.type = 'moved'; }
      if (!matches(row, where)) return { count: 0 };
      Object.assign(row, JSON.parse(JSON.stringify(data)));
      return { count: 1 };
    }),
  };
}

function fixtures(opts: { moveOnWrite?: boolean } = {}) {
  const prisma: any = {
    crossModelMessage: table([
      { id: 'm1', chatId: PS, role: 'user', content: `username: bob password: ${FAKE_PW} for the Hue - store somewhere`, parts: null, metadata: null, createdAt: T0, updatedAt: null },
      { id: 'm2', chatId: PS, role: 'assistant', content: 'Stored.', parts: [{ type: 'text', text: `noted: the password is ${FAKE_PW}` }, { type: 'tool_call', args: { content: `XIAOMI_KEY=${FAKE_KEY}` } }], metadata: { guardOriginal: `key ${FAKE_KEY}` }, createdAt: T1, updatedAt: T1 },
      { id: 'm3', chatId: PS, role: 'assistant', content: 'All clean here.', parts: [{ type: 'text', text: 'nothing secret' }], metadata: null, createdAt: T1, updatedAt: T1 },
      { id: 'm9', chatId: OTHER, role: 'user', content: `password: ${FAKE_PW}`, parts: null, metadata: null, createdAt: T1, updatedAt: null },
      // MERGE-1 step 10: `coding_messages` was DROPPED, so the scrubber scans ONE
      // transcript table. This row (formerly the legacy table's `c1`) now lives here —
      // the post-DROP reality this test models. A scrubber still reaching for
      // prisma.codingMessage would throw on a missing model, not read empty.
      { id: 'm10', chatId: LANE, role: 'user', content: `[relay] passphrase: alpha bravo charlie delta echo foxtrot`, parts: null, metadata: null, createdAt: T1, updatedAt: T1 },
    ], opts),
    ownerQuestion: table([
      { id: 'oq_aaaa0001', chatId: PS, forChatId: null, answer: `the pw is ${FAKE_PW}`, context: null, createdAt: T1 },
      { id: 'oq_aaaa0002', chatId: OTHER, forChatId: LANE, answer: 'yes', context: `token: ${FAKE_KEY}`, createdAt: T1 },
      { id: 'oq_aaaa0003', chatId: OTHER, forChatId: null, answer: `password: ${FAKE_PW}`, context: null, createdAt: T1 },
    ], opts),
    supervisorState: table([
      { id: 's1', chatId: PS, state: { directives: [{ id: 'f5158878', text: `username: bob password: ${FAKE_PW}`, status: 'open' }], archived: [{ id: '0f93082e', text: 'passphrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet' }], notes: 'all quiet', dispatches: [] }, updatedAt: T1 },
    ], opts),
    eventHook: table([{ id: 'h-fleet', targetChatId: PS }, { id: 'h-x', targetChatId: OTHER }]),
    hookEvent: table([
      { id: 'e1', hookId: 'h-fleet', payload: { sourceChatId: 'chat-agx-000009', summary: `final: the password is ${FAKE_PW}` }, createdAt: T1, updatedAt: T1 },
      { id: 'e2', hookId: 'h-x', payload: { sourceChatId: LANE, summary: `relayed ${FAKE_KEY}` }, createdAt: T1, updatedAt: T1 },
      { id: 'e3', hookId: 'h-x', payload: { sourceChatId: OTHER, summary: `password: ${FAKE_PW}` }, createdAt: T1, updatedAt: T1 },
    ], opts),
    pendingChatMessage: table([
      { id: 'p1', chatId: LANE, content: `install with XIAOMI_KEY=${FAKE_KEY}`, createdAt: T1 },
    ], opts),
    agentRun: table([{ id: 'run-lane', sessionId: LANE }, { id: 'run-other', sessionId: OTHER }]),
    agentEvent: table([
      { id: BigInt(10), runId: 'run-lane', seq: 3022, type: 'tool_call', payload: { name: 'send_chat_message', args: { content: `key ${FAKE_KEY}` } }, createdAt: T1 },
      { id: BigInt(11), runId: 'run-lane', seq: 3023, type: 'text', payload: { text: 'ok' }, createdAt: T1 },
      { id: BigInt(12), runId: 'run-other', seq: 1, type: 'tool_call', payload: { args: { content: `key ${FAKE_KEY}` } }, createdAt: T1 },
    ], opts),
  };
  return prisma;
}

const noSecret = (out: unknown) => {
  const s = JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  expect(s).not.toContain(FAKE_PW);
  expect(s).not.toContain(FAKE_KEY);
  expect(s).not.toContain('alpha bravo');
};

describe('scrub-chat-secrets.js — parseArgs', () => {
  it('a scope is REQUIRED; --chat repeats / takes comma lists; --since parses; unknown args / tables refuse', () => {
    expect(() => script.parseArgs([])).toThrow(/--chat <id>.*--since/);
    expect(script.parseArgs(['--chat', PS, '--chat', `${LANE},${PS}`])).toMatchObject({ apply: false, chats: [PS, LANE] });
    expect(script.parseArgs(['--since=2026-10-04T00:00:00Z']).since).toEqual(new Date('2026-10-04T00:00:00Z'));
    expect(script.parseArgs(['--chat', PS, '--apply', '--show-masked'])).toMatchObject({ apply: true, showMasked: true });
    expect(() => script.parseArgs(['--since', 'yesterday'])).toThrow(/ISO/);
    expect(() => script.parseArgs(['--chat', 'abc'])).toThrow(/full chat id/);
    expect(() => script.parseArgs(['--chat', PS, '--tables', 'nope'])).toThrow(/unknown table/);
    expect(() => script.parseArgs(['--chat', PS, '--bogus'])).toThrow(/unknown argument/);
    expect(script.parseArgs(['--help'])).toMatchObject({ help: true });
  });
});

describe('scrub-chat-secrets.js — run', () => {
  it('dry run over the named chats: counts + row ids per table, NO writes, never the secret', async () => {
    const prisma = fixtures();
    const out = await script.run({ prisma, argv: ['--chat', PS, '--chat', LANE], redact: redactSecrets });
    expect(out.apply).toBe(false);
    expect(out.crossmodelMessages).toMatchObject({ scanned: 4, rowsWithHits: 3, updated: 0 });
    // m10 is the LANE-scoped relay row that used to sit in the dropped legacy table:
    // one scan now covers both histories, which is the point of MERGE-1.
    // Hits are listed in ascending id order (the script pages by id), so `m10`
    // sorts between `m1` and `m2` — not a content ordering.
    expect(out.crossmodelMessages.hits.map((h: any) => [h.id, h.fields])).toEqual([['m1', ['content']], ['m10', ['content']], ['m2', ['parts', 'metadata']]]);
    expect(out.codingMessages).toBeUndefined(); // MERGE-1 step 10: the table is gone, so the key must be too
    expect(out.ownerQuestions).toMatchObject({ scanned: 2, rowsWithHits: 2 }); // chatId PS + forChatId LANE; OTHER's own row untouched
    expect(out.supervisorStates.hits).toEqual([{ id: 's1', chatId: PS, fields: ['state.directives', 'state.archived'], patterns: expect.arrayContaining(['Password', 'Passphrase']) }]);
    expect(out.hookEvents.hits.map((h: any) => h.id)).toEqual(['e1', 'e2']); // a hook TARGETING PS + a payload FROM LANE
    expect(out.pendingChatMessages).toMatchObject({ scanned: 1, rowsWithHits: 1 });
    expect(out.agentEvents).toMatchObject({ runs: 1, scanned: 2, rowsWithHits: 1 });
    expect(out.agentEvents.hits[0]).toMatchObject({ id: '10', runId: 'run-lane', seq: 3022, type: 'tool_call' });
    for (const k of ['crossModelMessage', 'ownerQuestion', 'supervisorState', 'hookEvent', 'pendingChatMessage', 'agentEvent']) {
      expect(prisma[k].updateMany).not.toHaveBeenCalled();
    }
    noSecret(out);
  });

  it('--apply rewrites only the matched substrings through guarded updates; other chats untouched; a second pass finds nothing', async () => {
    const prisma = fixtures();
    const out = await script.run({ prisma, argv: ['--chat', PS, '--chat', LANE, '--apply'], redact: redactSecrets });
    expect(out.crossmodelMessages).toMatchObject({ rowsWithHits: 3, updated: 3, skippedChanged: 0 });
    const m = prisma.crossModelMessage.rows;
    expect(m[0].content).toBe(`username: bob password: ${REDACTED_NOTE} for the Hue - store somewhere`);
    expect(m[1].parts[0].text).toBe(`noted: the password is ${REDACTED_NOTE}`);
    expect(m[1].parts[1]).toEqual({ type: 'tool_call', args: { content: `XIAOMI_KEY=${REDACTED_NOTE}` } });
    expect(m[1].metadata.guardOriginal).toBe(`key ${REDACTED_NOTE}`);
    expect(m[2].parts).toEqual([{ type: 'text', text: 'nothing secret' }]);
    expect(m[3].content).toContain(FAKE_PW); // another chat — out of scope
    expect(prisma.crossModelMessage.updateMany.mock.calls[0][0].where).toEqual({ id: 'm1', updatedAt: null });
    expect(prisma.supervisorState.rows[0].state.directives[0]).toEqual({ id: 'f5158878', text: `username: bob password: ${REDACTED_NOTE}`, status: 'open' });
    expect(prisma.supervisorState.rows[0].state.archived[0].text).toBe(`passphrase: ${REDACTED_NOTE}`);
    expect(prisma.supervisorState.rows[0].state.notes).toBe('all quiet');
    expect(prisma.ownerQuestion.rows[0].answer).toBe(`the pw is ${REDACTED_NOTE}`);
    expect(prisma.ownerQuestion.updateMany.mock.calls[0][0].where).toEqual({ id: 'oq_aaaa0001', answer: `the pw is ${FAKE_PW}` });
    expect(prisma.ownerQuestion.rows[2].answer).toContain(FAKE_PW); // out of scope
    expect(prisma.hookEvent.rows[0].payload.summary).toBe(`final: the password is ${REDACTED_NOTE}`);
    expect(prisma.hookEvent.rows[2].payload.summary).toContain(FAKE_PW); // out of scope
    expect(prisma.pendingChatMessage.rows[0].content).toBe(`install with XIAOMI_KEY=${REDACTED_NOTE}`);
    expect(prisma.agentEvent.rows[0].payload.args.content).toBe(`key ${REDACTED_NOTE}`);
    expect(prisma.agentEvent.rows[2].payload.args.content).toContain(FAKE_KEY); // another chat's run
    noSecret(out);
    const again = await script.run({ prisma, argv: ['--chat', PS, '--chat', LANE], redact: redactSecrets });
    for (const t of script.TABLES) expect(again[t].rowsWithHits).toBe(0);
  });

  it('--apply skips (never overwrites) rows the app rewrote between read and write', async () => {
    const prisma = fixtures({ moveOnWrite: true });
    const out = await script.run({ prisma, argv: ['--chat', PS, '--chat', LANE, '--apply'], redact: redactSecrets });
    for (const t of script.TABLES) {
      expect(out[t].updated).toBe(0);
      expect(out[t].skippedChanged).toBe(out[t].rowsWithHits);
    }
    expect(prisma.crossModelMessage.rows[0].content).toContain(FAKE_PW);
  });

  it('--since alone scans by time (agent events need --chat and say so); pagination walks every page', async () => {
    const prisma = fixtures();
    const out = await script.run({ prisma, argv: ['--since', '2026-10-06T00:00:00Z', '--batch', '1'], redact: redactSecrets });
    expect(out.crossmodelMessages).toMatchObject({ scanned: 4, rowsWithHits: 3 }); // m1 (T0) is older
    expect(out.crossmodelMessages.hits.map((h: any) => h.id)).toEqual(['m10', 'm2', 'm9']);
    expect(out.agentEvents.skipped).toMatch(/needs --chat/);
    expect(out.agentEvents.scanned).toBe(0);
    expect(prisma.crossModelMessage.findMany.mock.calls.length).toBeGreaterThan(3);
  });

  it('--tables narrows; --show-masked lists masked spans (first 3 + *** + last 2; under 16 chars fully masked), never the value', async () => {
    const prisma = fixtures();
    const out = await script.run({ prisma, argv: ['--chat', PS, '--tables', 'crossmodelMessages,supervisorStates', '--show-masked'], redact: redactSecrets, spans: findSecretSpans });
    expect(Object.keys(out).filter((k) => script.TABLES.includes(k))).toEqual(['crossmodelMessages', 'supervisorStates']);
    expect(out.showMasked).toBe(true);
    expect(script.maskSpan(FAKE_PW)).toBe('***'); // a 9-char password: first 3 + last 2 would be most of it
    expect(script.maskSpan(FAKE_KEY)).toBe('sk-***ab');
    expect(out.crossmodelMessages.hits[0].masked).toEqual(['content: Password ***']);
    expect(out.crossmodelMessages.hits[1].masked).toEqual(expect.arrayContaining(['parts: Password ***', 'parts: OpenAI/Anthropic-style key sk-***ab', 'metadata.guardOriginal: OpenAI/Anthropic-style key sk-***ab']));
    expect(out.supervisorStates.hits[0].masked).toEqual(['state.directives: Password ***', 'state.archived: Passphrase alp***et']);
    noSecret(out);
  });

  // Review 2026-10-23: closed directives older than the newest 20 live in the context store's cold archive
  // ([chatId,'supervisor-archive']) and are mirrored for search — the supervisor_states scan never reached them.
  it('the supervisor COLD archive: dry run lists the hit; --apply rewrites the row (guarded) and deletes its search-mirror rows', async () => {
    const cold = [
      { namespacePath: `${PS}:supervisor-archive`, key: 'c0ld-1', value: { id: 'c0ld-1', text: `username: bob password: ${FAKE_PW}`, status: 'done' }, updatedAt: T1 },
      { namespacePath: `${PS}:supervisor-archive`, key: 'c0ld-2', value: { id: 'c0ld-2', text: 'nothing secret', status: 'done' }, updatedAt: T1 },
      { namespacePath: `${OTHER}:supervisor-archive`, key: 'c0ld-9', value: { id: 'c0ld-9', text: `password: ${FAKE_PW}`, status: 'done' }, updatedAt: T1 },
    ];
    const withStore = () => {
      const prisma = fixtures();
      prisma.contextStoreEntry = {
        findMany: jest.fn(async ({ where }: any) => cold
          .filter((r) => (where.namespacePath.in ? where.namespacePath.in.includes(r.namespacePath) : r.namespacePath.endsWith(where.namespacePath.endsWith)))
          .map((r) => JSON.parse(JSON.stringify(r)))),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const r = cold.find((x) => x.namespacePath === where.namespacePath && x.key === where.key);
          if (!r || new Date(r.updatedAt).getTime() !== new Date(where.updatedAt).getTime()) return { count: 0 };
          r.value = data.value;
          return { count: 1 };
        }),
      };
      prisma.$executeRawUnsafe = jest.fn(async () => 2);
      return prisma;
    };
    const dry = await script.run({ prisma: withStore(), argv: ['--chat', PS], redact: redactSecrets });
    expect(dry.supervisorColdArchive).toMatchObject({ scanned: 2, rowsWithHits: 1, updated: 0 });
    expect(dry.supervisorColdArchive.hits).toEqual([{ chatId: PS, key: 'c0ld-1', fields: ['value.text'], patterns: ['Password'] }]);
    noSecret(dry);
    const prisma = withStore();
    const out = await script.run({ prisma, argv: ['--chat', PS, '--apply'], redact: redactSecrets });
    expect(out.supervisorColdArchive).toMatchObject({ updated: 1, skippedChanged: 0, mirrorRowsDeleted: 4 });
    expect(cold[0].value.text).toBe(`username: bob password: ${REDACTED_NOTE}`);
    expect(cold[2].value.text).toContain(FAKE_PW); // another chat, out of scope
    expect((prisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c) => [c[1], c[2]])).toEqual([[PS, 'archive c0ld-1 '], [PS, 'archive c0ld-1 ']]);
  });
});
