/**
 * scripts/framework-audit/redact-owner-question-answer.js — the T6 (2026-09-28)
 * question-scoped one-shot on a MOCKED Prisma client: dry-run by default (hit
 * list, no writes, never the secret), --apply guarded by the value we read,
 * --chat-messages also rewrites the chat's transcript rows (content + parts
 * string leaves), and an ambiguous / unknown prefix refuses.
 */
import path from 'path';
import { redactSecrets, findSecretSpans, REDACTED_NOTE } from '../modules/crossmodel/platform/secret-scan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'redact-owner-question-answer.js'));

// FAKE fixtures — structurally valid shapes only.
const FAKE_APP_PW = 'abcd efgh ijkl mnop';
const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

type QRow = { id: string; chatId: string; answer: string | null; context: string | null };
type MRow = { id: string; chatId: string; role: string; content: string; parts: any; createdAt: Date };

function makePrisma(questions: QRow[], messages: MRow[], opts: { moveOnWrite?: boolean } = {}) {
  const prisma: any = {
    ownerQuestion: {
      findMany: jest.fn(async ({ where }: any) => questions
        .filter((q) => q.id.startsWith(where.id.startsWith))
        .map((q) => ({ ...q }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = questions.find((q) => q.id === where.id);
        if (!row) return { count: 0 };
        if (opts.moveOnWrite) row.answer = 'moved';
        for (const k of Object.keys(where)) if (k !== 'id' && (row as any)[k] !== where[k]) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    crossModelMessage: {
      findMany: jest.fn(async ({ where }: any) => messages
        .filter((m) => m.chatId === where.chatId)
        .map((m) => ({ id: m.id, role: m.role, content: m.content, parts: JSON.parse(JSON.stringify(m.parts)) }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = messages.find((m) => m.id === where.id);
        if (!row) return { count: 0 };
        if (where.content !== undefined && row.content !== where.content) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return prisma;
}

function fixtures() {
  const questions: QRow[] = [
    { id: 'oq_8cce9d18-aaaa', chatId: 'chat-b92e', answer: `the gmail app password is ${FAKE_APP_PW}; added it to github secrets`, context: 'lane asked for SMTP creds' },
    { id: 'oq_clean0001', chatId: 'chat-other', answer: 'yes, ship it', context: null },
    { id: 'oq_8cce9d18-bbbb', chatId: 'chat-dup', answer: 'ambiguous twin', context: null },
  ];
  const messages: MRow[] = [
    { id: 'm1', chatId: 'chat-b92e', role: 'user', content: `[Owner inbox] A: "the gmail app password is ${FAKE_APP_PW}"`, parts: null, createdAt: new Date('2026-09-28T02:28:00Z') },
    { id: 'm2', chatId: 'chat-b92e', role: 'assistant', content: 'Configured the SMTP relay.', parts: [{ type: 'text', text: `set smtp app password ${FAKE_APP_PW} in env` }, { type: 'tool_call', name: 'x', args: { token: FAKE_GH } }], createdAt: new Date('2026-09-28T02:29:00Z') },
    { id: 'm3', chatId: 'chat-b92e', role: 'assistant', content: 'Nothing sensitive here.', parts: [{ type: 'text', text: 'plain' }], createdAt: new Date('2026-09-28T02:30:00Z') },
    { id: 'm9', chatId: 'chat-other', role: 'user', content: `unrelated chat ${FAKE_APP_PW} gmail`, parts: null, createdAt: new Date('2026-09-28T02:31:00Z') },
  ];
  return { questions, messages };
}

describe('redact-owner-question-answer.js — parseArgs', () => {
  it('requires --question (≥ 8 chars); dry-run by default; flags flip', () => {
    expect(() => script.parseArgs([])).toThrow(/--question <id> is required/);
    expect(() => script.parseArgs(['--question', 'abc'])).toThrow(/at least 8/);
    expect(script.parseArgs(['--question', 'oq_8cce9d18'])).toMatchObject({ apply: false, chatMessages: false, showMasked: false, question: 'oq_8cce9d18' });
    expect(script.parseArgs(['--question=oq_8cce9d18', '--apply', '--chat-messages', '--show-masked'])).toMatchObject({ apply: true, chatMessages: true, showMasked: true });
    expect(() => script.parseArgs(['--question', 'oq_8cce9d18', '--bogus'])).toThrow(/unknown argument/);
    expect(script.parseArgs(['--help'])).toMatchObject({ help: true });
  });
});

describe('redact-owner-question-answer.js — run', () => {
  it('refuses an ambiguous prefix and an unknown id', async () => {
    const { questions, messages } = fixtures();
    const prisma = makePrisma(questions, messages);
    await expect(script.run({ prisma, argv: ['--question', 'oq_8cce9d18'], redact: redactSecrets })).rejects.toThrow(/resolves to 2 rows/);
    await expect(script.run({ prisma, argv: ['--question', 'oq_nope0000'], redact: redactSecrets })).rejects.toThrow(/resolves to 0 rows/);
    expect(prisma.ownerQuestion.updateMany).not.toHaveBeenCalled();
  });

  it('dry run: names the pattern + fields, writes nothing, never prints the secret', async () => {
    const { questions, messages } = fixtures();
    const prisma = makePrisma(questions, messages);
    const out = await script.run({ prisma, argv: ['--question', 'oq_8cce9d18-aaaa', '--show-masked'], redact: redactSecrets, spans: findSecretSpans });
    expect(out).toMatchObject({ apply: false, question: 'oq_8cce9d18-aaaa', showMasked: true });
    expect(out.ownerQuestion).toMatchObject({ found: 1, fields: ['answer'], patterns: ['App password'], updated: 0, skippedChanged: 0 });
    expect(out.ownerQuestion.masked).toEqual(['answer: App password abc***op']);
    expect(out.chatMessages).toMatchObject({ scanned: 0, rowsWithHits: 0 });
    expect(prisma.ownerQuestion.updateMany).not.toHaveBeenCalled();
    expect(prisma.crossModelMessage.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(FAKE_APP_PW);
    expect(questions[0].answer).toContain(FAKE_APP_PW); // untouched
  });

  it('--apply rewrites the answer through a value-guarded update; a clean context is left alone', async () => {
    const { questions, messages } = fixtures();
    const prisma = makePrisma(questions, messages);
    const out = await script.run({ prisma, argv: ['--question', 'oq_8cce9d18-aaaa', '--apply'], redact: redactSecrets });
    expect(out.ownerQuestion).toMatchObject({ updated: 1, skippedChanged: 0 });
    expect(questions[0].answer).toBe(`the gmail app password is ${REDACTED_NOTE}; added it to github secrets`);
    expect(questions[0].context).toBe('lane asked for SMTP creds');
    const call = prisma.ownerQuestion.updateMany.mock.calls[0][0];
    expect(call.where.id).toBe('oq_8cce9d18-aaaa');
    expect(call.where.answer).toContain(FAKE_APP_PW); // the guard is the value we read
    expect(call.data).toEqual({ answer: `the gmail app password is ${REDACTED_NOTE}; added it to github secrets` });
  });

  it('a row that moved between read and write is skippedChanged, not overwritten', async () => {
    const { questions, messages } = fixtures();
    const prisma = makePrisma(questions, messages, { moveOnWrite: true });
    const out = await script.run({ prisma, argv: ['--question', 'oq_8cce9d18-aaaa', '--apply'], redact: redactSecrets });
    expect(out.ownerQuestion).toMatchObject({ updated: 0, skippedChanged: 1 });
  });

  it('--chat-messages scans ONLY that chat, rewrites content + parts string leaves, guards on content', async () => {
    const { questions, messages } = fixtures();
    const prisma = makePrisma(questions, messages);
    const dry = await script.run({ prisma, argv: ['--question', 'oq_8cce9d18-aaaa', '--chat-messages', '--show-masked'], redact: redactSecrets, spans: findSecretSpans });
    expect(dry.chatMessages).toMatchObject({ scanned: 3, rowsWithHits: 2, updated: 0 });
    expect(dry.chatMessages.hits).toEqual([
      { id: 'm1', role: 'user', fields: ['content'], patterns: ['App password'], masked: ['content: App password abc***op'] },
      { id: 'm2', role: 'assistant', fields: ['parts'], patterns: expect.arrayContaining(['App password', 'GitHub token']), masked: expect.arrayContaining(['parts: App password abc***op', 'parts: GitHub token ghp***r8']) },
    ]);
    expect(JSON.stringify(dry)).not.toContain(FAKE_APP_PW);
    expect(JSON.stringify(dry)).not.toContain(FAKE_GH);
    expect(prisma.crossModelMessage.updateMany).not.toHaveBeenCalled();

    const out = await script.run({ prisma, argv: ['--question', 'oq_8cce9d18-aaaa', '--chat-messages', '--apply'], redact: redactSecrets });
    expect(out.chatMessages).toMatchObject({ rowsWithHits: 2, updated: 2, skippedChanged: 0 });
    expect(messages[0].content).toBe(`[Owner inbox] A: "the gmail app password is ${REDACTED_NOTE}"`);
    expect(messages[1].content).toBe('Configured the SMTP relay.'); // untouched field
    expect(messages[1].parts[0].text).toBe(`set smtp app password ${REDACTED_NOTE} in env`);
    expect(messages[1].parts[1].args.token).toBe(REDACTED_NOTE);
    expect(messages[1].parts[1].type).toBe('tool_call'); // structure survives
    expect(messages[2].parts[0].text).toBe('plain');
    expect(messages[3].content).toContain(FAKE_APP_PW); // the other chat is never touched
    const guards = prisma.crossModelMessage.updateMany.mock.calls.map((c: any[]) => c[0].where);
    expect(guards[0]).toEqual({ id: 'm1', content: expect.stringContaining(FAKE_APP_PW) });
    expect(guards[1]).toEqual({ id: 'm2', content: 'Configured the SMTP relay.' });
    // Idempotent: a second apply finds nothing left.
    const again = await script.run({ prisma, argv: ['--question', 'oq_8cce9d18-aaaa', '--chat-messages', '--apply'], redact: redactSecrets });
    expect(again.ownerQuestion.fields).toEqual([]);
    expect(again.chatMessages).toMatchObject({ rowsWithHits: 0, updated: 0 });
  });

  it('maskSpan / redactJsonDeep helpers', () => {
    expect(script.maskSpan('short')).toBe('***');
    expect(script.maskSpan('Hue2024!x15char')).toBe('***'); // audit 2026-10-06 T2-4: < 16 chars masks fully
    expect(script.maskSpan(FAKE_APP_PW)).toBe('abc***op');
    const r = script.redactJsonDeep({ a: [`token: ${FAKE_GH}`, 1, null], b: { c: 'clean' } }, redactSecrets);
    expect(r.changed).toBe(true);
    expect(r.hits).toEqual(['GitHub token']);
    expect(r.value).toEqual({ a: [`token: ${REDACTED_NOTE}`, 1, null], b: { c: 'clean' } });
    const clean = { x: 'y' };
    expect(script.redactJsonDeep(clean, redactSecrets)).toEqual({ value: clean, changed: false, hits: [] });
  });
});
