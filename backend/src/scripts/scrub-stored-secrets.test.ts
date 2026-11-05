/**
 * scripts/framework-audit/scrub-stored-secrets.js — the D4 (2026-09-27)
 * one-shot that rewrites ALREADY-STORED supervisor directives / owner-question
 * answers through the shared credential redaction, on a MOCKED Prisma client:
 * dry-run by default (hit list, no writes; never the secret itself), --apply
 * writes guarded by the updatedAt / original-value we read, a row that moved
 * between read and write is skipped, filters narrow the scan, and every other
 * field of the doc survives byte-for-byte.
 */
import path from 'path';
import { redactSecrets, findSecretSpans, REDACTED_NOTE } from '../modules/crossmodel/platform/secret-scan';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'scrub-stored-secrets.js'));

// FAKE fixtures — structurally valid shapes only.
const FAKE_ZAI = '0123456789abcdef0123456789abcdef' + '.AbCdEfGhIjKlMnOp';
const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

type StateRow = { chatId: string; state: any; updatedAt: Date };
type QRow = { id: string; answer: string | null; context: string | null };

function makePrisma(states: StateRow[], questions: QRow[], opts: { moveOnWrite?: boolean } = {}) {
  const prisma: any = {
    states, questions,
    supervisorState: {
      findMany: jest.fn(async ({ where }: any) => states
        .filter((s) => !where?.chatId || s.chatId === where.chatId)
        .map((s) => ({ chatId: s.chatId, state: JSON.parse(JSON.stringify(s.state)), updatedAt: s.updatedAt }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = states.find((s) => s.chatId === where.chatId);
        if (!row) return { count: 0 };
        if (opts.moveOnWrite) row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
        if (where.updatedAt && row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        row.state = data.state;
        return { count: 1 };
      }),
    },
    ownerQuestion: {
      findMany: jest.fn(async ({ where }: any) => questions
        .filter((q) => !where?.id?.startsWith || q.id.startsWith(where.id.startsWith))
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
  };
  return prisma;
}

const cleanDirective = { id: 'd-clean-0001', text: 'Resume the ca-central-1 lane after the deploy.', at: '2026-09-20T00:00:00.000Z', status: 'open', scope: 'canlaw' };
const dirtyDirective = { id: '384f859b-aaaa-bbbb-cccc-dddddddddddd', text: `use ZAI_API_KEY=${FAKE_ZAI} for the bench`, at: '2026-09-21T00:00:00.000Z', status: 'open', standing: true, scope: 'canlaw' };
const archivedDirty = { id: 'a-archived-01', text: 'older note', evidence: `pushed with ${FAKE_GH}`, at: '2026-09-10T00:00:00.000Z', status: 'done' };

function fixtures() {
  const states: StateRow[] = [
    { chatId: 'sup-canlaw', updatedAt: new Date('2026-09-26T00:00:00Z'), state: { directives: [cleanDirective, dirtyDirective], archived: [archivedDirty], dispatches: [{ id: 'x', lane: 'l1' }], notes: 'untouched' } },
    { chatId: 'sup-fleet', updatedAt: new Date('2026-09-26T00:00:00Z'), state: { directives: [cleanDirective], archived: [], dispatches: [] } },
  ];
  const questions: QRow[] = [
    { id: 'oq_clean0001', answer: 'yes, ship it', context: null },
    { id: 'oq_dirty0002', answer: `api_key=${'x'.repeat(24)} is the one`, context: `token: ${FAKE_GH}` },
    { id: 'oq_open00003', answer: null, context: 'no answer yet' },
  ];
  return { states, questions };
}

describe('scrub-stored-secrets.js — parseArgs', () => {
  it('dry-run by default; --apply flips; filters narrow the scan', () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, supervisor: true, questions: true });
    expect(script.parseArgs(['--apply'])).toMatchObject({ apply: true });
    expect(script.parseArgs(['--chat', 'sup-1'])).toMatchObject({ chat: 'sup-1' });
    expect(script.parseArgs(['--directive=384f859b'])).toMatchObject({ directive: '384f859b', questions: false, supervisor: true });
    expect(script.parseArgs(['--question', 'oq_dirty0002'])).toMatchObject({ question: 'oq_dirty0002', supervisor: false });
    expect(() => script.parseArgs(['--directive', 'abc'])).toThrow(/at least 8/);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

describe('scrub-stored-secrets.js — scrubSupervisorDoc (pure)', () => {
  it('rewrites only the matched substrings, keeps every other field, and reports names not text', () => {
    const doc = fixtures().states[0].state;
    const { doc: next, changed, hits } = script.scrubSupervisorDoc(doc, redactSecrets);
    expect(changed).toBe(true);
    expect(next.directives[0]).toEqual(cleanDirective);
    expect(next.directives[1]).toEqual({ ...dirtyDirective, text: `use ZAI_API_KEY=${REDACTED_NOTE} for the bench` });
    expect(next.archived[0]).toEqual({ ...archivedDirty, evidence: `pushed with ${REDACTED_NOTE}` });
    expect(next.dispatches).toEqual(doc.dispatches);
    expect(next.notes).toBe('untouched');
    expect(hits).toEqual([
      { section: 'directives', id: dirtyDirective.id, fields: ['text'], patterns: ['Z.ai API key'] },
      { section: 'archived', id: 'a-archived-01', fields: ['evidence'], patterns: ['GitHub token'] },
    ]);
    expect(JSON.stringify(hits)).not.toContain(FAKE_ZAI);
    // The input doc is not mutated.
    expect(doc.directives[1].text).toContain(FAKE_ZAI);
  });

  it('--directive narrows to one id (prefix) and leaves the rest alone', () => {
    const doc = fixtures().states[0].state;
    const { doc: next, hits } = script.scrubSupervisorDoc(doc, redactSecrets, { directive: '384f859b' });
    expect(hits).toHaveLength(1);
    expect(next.archived[0].evidence).toContain(FAKE_GH); // not selected
  });

  it('a clean doc reports changed:false and an identical doc', () => {
    const doc = fixtures().states[1].state;
    expect(script.scrubSupervisorDoc(doc, redactSecrets)).toEqual({ doc, changed: false, hits: [] });
  });
});

describe('scrub-stored-secrets.js — run', () => {
  it('dry run: counts + hit list, NO writes, no secret in the output', async () => {
    const { states, questions } = fixtures();
    const prisma = makePrisma(states, questions);
    const out = await script.run({ prisma, argv: [], redact: redactSecrets });
    expect(out.apply).toBe(false);
    expect(out.supervisorStates).toMatchObject({ scanned: 2, rowsWithHits: 1, updated: 0, skippedChanged: 0 });
    expect(out.supervisorStates.hits[0].chatId).toBe('sup-canlaw');
    expect(out.ownerQuestions).toMatchObject({ scanned: 3, rowsWithHits: 1, updated: 0 });
    expect(out.ownerQuestions.hits).toEqual([{ id: 'oq_dirty0002', fields: ['answer', 'context'], patterns: expect.arrayContaining(['Credential assignment', 'GitHub token']) }]);
    expect(prisma.supervisorState.updateMany).not.toHaveBeenCalled();
    expect(prisma.ownerQuestion.updateMany).not.toHaveBeenCalled();
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_ZAI);
    expect(text).not.toContain(FAKE_GH);
    expect(text).not.toContain('x'.repeat(24));
  });

  it('--apply rewrites the rows through guarded updates and leaves clean rows untouched', async () => {
    const { states, questions } = fixtures();
    const prisma = makePrisma(states, questions);
    const out = await script.run({ prisma, argv: ['--apply'], redact: redactSecrets });
    expect(out.supervisorStates).toMatchObject({ rowsWithHits: 1, updated: 1, skippedChanged: 0 });
    expect(out.ownerQuestions).toMatchObject({ rowsWithHits: 1, updated: 1, skippedChanged: 0 });
    expect(prisma.supervisorState.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.supervisorState.updateMany.mock.calls[0][0].where).toEqual({ chatId: 'sup-canlaw', updatedAt: new Date('2026-09-26T00:00:00Z') });
    expect(states[0].state.directives[1].text).toBe(`use ZAI_API_KEY=${REDACTED_NOTE} for the bench`);
    expect(states[0].state.directives[1].standing).toBe(true);
    expect(states[0].state.archived[0].evidence).toBe(`pushed with ${REDACTED_NOTE}`);
    expect(states[1].state.directives[0]).toEqual(cleanDirective);
    expect(questions[1].answer).toBe(`api_key=${REDACTED_NOTE} is the one`);
    expect(questions[1].context).toBe(`token: ${REDACTED_NOTE}`);
    expect(questions[0].answer).toBe('yes, ship it');
    // The question update is guarded by the ORIGINAL values.
    expect(prisma.ownerQuestion.updateMany.mock.calls[0][0].where).toEqual({ id: 'oq_dirty0002', answer: `api_key=${'x'.repeat(24)} is the one`, context: `token: ${FAKE_GH}` });
  });

  it('--apply skips (never overwrites) a row that moved between read and write', async () => {
    const { states, questions } = fixtures();
    const prisma = makePrisma(states, questions, { moveOnWrite: true });
    const out = await script.run({ prisma, argv: ['--apply'], redact: redactSecrets });
    expect(out.supervisorStates).toMatchObject({ rowsWithHits: 1, updated: 0, skippedChanged: 1 });
    expect(out.ownerQuestions).toMatchObject({ rowsWithHits: 1, updated: 0, skippedChanged: 1 });
    expect(states[0].state.directives[1].text).toContain(FAKE_ZAI); // untouched
  });

  it('--chat / --directive / --question / --no-* narrow the scan', async () => {
    const { states, questions } = fixtures();
    const prisma = makePrisma(states, questions);
    const byChat = await script.run({ prisma, argv: ['--chat', 'sup-fleet'], redact: redactSecrets });
    expect(byChat.supervisorStates).toMatchObject({ scanned: 1, rowsWithHits: 0 });
    const byDirective = await script.run({ prisma, argv: ['--directive', '384f859b'], redact: redactSecrets });
    expect(byDirective.supervisorStates.hits[0].directives).toEqual([{ section: 'directives', id: dirtyDirective.id, fields: ['text'], patterns: ['Z.ai API key'] }]);
    expect(byDirective.ownerQuestions.scanned).toBe(0);
    const byQuestion = await script.run({ prisma, argv: ['--question', 'oq_dirty'], redact: redactSecrets });
    expect(byQuestion.supervisorStates.scanned).toBe(0);
    expect(byQuestion.ownerQuestions).toMatchObject({ scanned: 1, rowsWithHits: 1 });
    const noQ = await script.run({ prisma, argv: ['--no-questions'], redact: redactSecrets });
    expect(noQ.ownerQuestions.scanned).toBe(0);
  });

  // Review fix: a reviewable dry run — masked matches (first 3 + *** + last 2),
  // never the secret; without the flag (or without a span finder) the output
  // stays names-only. No "previous value" store row by design: the previous
  // value IS the credential.
  it('--show-masked lists masked matches per hit; the secret itself never appears; the flag is a no-op without a span finder', async () => {
    expect(script.maskSpan(FAKE_ZAI)).toBe('012***Op');
    expect(script.maskSpan('short')).toBe('***');
    expect(script.maskSpan('exactly8')).toBe('***');
    expect(script.maskSpan('Hue2024!x15char')).toBe('***'); // audit 2026-10-06 T2-4: < 16 chars masks fully (a short password)
    const { states, questions } = fixtures();
    const prisma = makePrisma(states, questions);
    const out = await script.run({ prisma, argv: ['--show-masked'], redact: redactSecrets, spans: findSecretSpans });
    expect(out.showMasked).toBe(true);
    expect(out.apply).toBe(false);
    expect(out.supervisorStates.hits[0].directives).toEqual([
      { section: 'directives', id: dirtyDirective.id, fields: ['text'], patterns: ['Z.ai API key'], masked: ['text: Z.ai API key 012***Op'] },
      { section: 'archived', id: 'a-archived-01', fields: ['evidence'], patterns: ['GitHub token'], masked: [`evidence: GitHub token ${FAKE_GH.slice(0, 3)}***${FAKE_GH.slice(-2)}`] },
    ]);
    expect(out.ownerQuestions.hits[0].masked).toEqual([`answer: Credential assignment xxx***xx`, `context: GitHub token ${FAKE_GH.slice(0, 3)}***${FAKE_GH.slice(-2)}`]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_ZAI);
    expect(text).not.toContain(FAKE_GH);
    expect(text).not.toContain('x'.repeat(24));
    expect(prisma.supervisorState.updateMany).not.toHaveBeenCalled();
    // Names-only without the flag / without a finder.
    const plain = await script.run({ prisma, argv: [], redact: redactSecrets, spans: findSecretSpans });
    expect(plain.showMasked).toBe(false);
    expect(plain.supervisorStates.hits[0].directives[0]).not.toHaveProperty('masked');
    const noFinder = await script.run({ prisma, argv: ['--show-masked'], redact: redactSecrets });
    expect(noFinder.showMasked).toBe(false);
    expect(noFinder.ownerQuestions.hits[0]).not.toHaveProperty('masked');
  });
});

// Review 2026-10-23: closed directives older than the newest 20 moved OUT of supervisor_states into the context store
// ([chatId,'supervisor-archive'], up to 180 rows per supervisor chat) and their 'archive …' mirror rows in digby_memory.
// The scrub reported a clean ledger while a secret still sat in a cold row and its mirror (get_supervisor_state
// {section:'archived'} and search_memory still returned it).
describe('scrub-stored-secrets.js — the COLD archive', () => {
  type ColdRow = { namespacePath: string; key: string; value: any; updatedAt: Date | null };
  const coldDirty = { id: 'c0ld0001-aaaa-bbbb-cccc-dddddddddddd', text: 'rotate the bench key', evidence: `pushed with ${FAKE_GH}`, at: '2026-09-01T00:00:00.000Z', status: 'done', archivedAt: '2026-09-02T00:00:00.000Z' };
  const coldClean = { id: 'c0ld0002-aaaa-bbbb-cccc-dddddddddddd', text: 'done long ago', at: '2026-08-01T00:00:00.000Z', status: 'done' };
  function withCold(prisma: any, rows: ColdRow[], opts: { moveOnWrite?: boolean } = {}) {
    prisma.cold = rows;
    prisma.contextStoreEntry = {
      findMany: jest.fn(async ({ where }: any) => rows
        .filter((r) => (typeof where.namespacePath === 'string' ? r.namespacePath === where.namespacePath : r.namespacePath.endsWith(where.namespacePath.endsWith)))
        .map((r) => ({ ...r, value: JSON.parse(JSON.stringify(r.value)) }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = rows.find((x) => x.namespacePath === where.namespacePath && x.key === where.key);
        if (!r) return { count: 0 };
        if (opts.moveOnWrite) r.updatedAt = new Date(9e12);
        if ((r.updatedAt?.getTime() ?? null) !== (where.updatedAt?.getTime() ?? null)) return { count: 0 };
        r.value = data.value;
        r.updatedAt = data.updatedAt ?? r.updatedAt;
        return { count: 1 };
      }),
    };
    prisma.$executeRawUnsafe = jest.fn(async () => 1);
    return prisma;
  }
  const coldRows = (): ColdRow[] => [
    { namespacePath: 'sup-canlaw:supervisor-archive', key: coldDirty.id, value: coldDirty, updatedAt: new Date('2026-10-20T00:00:00Z') },
    { namespacePath: 'sup-canlaw:supervisor-archive', key: coldClean.id, value: coldClean, updatedAt: new Date('2026-10-20T00:00:00Z') },
    { namespacePath: 'sup-fleet:supervisor-archive', key: 'other', value: { ...coldClean, id: 'other' }, updatedAt: null },
  ];

  it('dry run lists the cold hit (names only), writes nothing', async () => {
    const { states, questions } = fixtures();
    const prisma = withCold(makePrisma(states, questions), coldRows());
    const out = await script.run({ prisma, argv: [], redact: redactSecrets });
    expect(out.coldArchive).toMatchObject({ scanned: 3, rowsWithHits: 1, updated: 0 });
    expect(out.coldArchive.hits).toEqual([{ chatId: 'sup-canlaw', id: coldDirty.id, fields: ['evidence'], patterns: ['GitHub token'] }]);
    expect(JSON.stringify(out)).not.toContain(FAKE_GH);
    expect(prisma.contextStoreEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('--apply rewrites the cold row (guarded) and deletes its search-mirror rows (hot and archived copies) so recall stops returning the secret', async () => {
    const { states, questions } = fixtures();
    const rows = coldRows();
    const prisma = withCold(makePrisma(states, questions), rows);
    const out = await script.run({ prisma, argv: ['--apply', '--chat', 'sup-canlaw'], redact: redactSecrets });
    expect(out.coldArchive).toMatchObject({ scanned: 2, rowsWithHits: 1, updated: 1, skippedChanged: 0 });
    expect(rows[0].value.evidence).toContain(REDACTED_NOTE);
    expect(rows[0].value.evidence).not.toContain(FAKE_GH);
    expect(rows[0].value.text).toBe(coldDirty.text);
    expect(rows[1].value).toEqual(coldClean);
    const sql = (prisma.$executeRawUnsafe as jest.Mock).mock.calls;
    expect(sql.length).toBe(2);
    for (const [q, chat, prefix] of sql) {
      expect(q).toMatch(/^DELETE FROM digby_memory(_archive)? WHERE scope_type = 'chat' AND scope_id = \$1 AND source = 'supervisor_state' AND starts_with\(ref, \$2\)$/);
      expect(chat).toBe('sup-canlaw');
      expect(prefix).toBe(`archive ${coldDirty.id.slice(0, 24)} `);
    }
  });

  it('a cold row the app rewrote between read and write is skipped; --directive narrows; --no-supervisor skips it', async () => {
    const { states, questions } = fixtures();
    const moving = withCold(makePrisma(states, questions), coldRows(), { moveOnWrite: true });
    const moved = await script.run({ prisma: moving, argv: ['--apply'], redact: redactSecrets });
    expect(moved.coldArchive).toMatchObject({ updated: 0, skippedChanged: 1 });
    expect(moving.$executeRawUnsafe).not.toHaveBeenCalled();
    const narrow = await script.run({ prisma: withCold(makePrisma(states, questions), coldRows()), argv: ['--directive', 'c0ld0002'], redact: redactSecrets });
    expect(narrow.coldArchive.rowsWithHits).toBe(0);
    const none = await script.run({ prisma: withCold(makePrisma(states, questions), coldRows()), argv: ['--no-supervisor'], redact: redactSecrets });
    expect(none.coldArchive.scanned).toBe(0);
  });
});
