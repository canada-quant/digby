/**
 * Test kit for the "Needs owner" inbox store (owner-questions.ts): an
 * in-memory ownerQuestion table supporting exactly the query shapes the
 * service uses (create / findUnique by id / findFirst with {chatId,question,
 * status(,resolvedAt:{gte})} / findMany with {userId,status} + createdAt desc
 * + take / conditional updateMany / count with {chatId,status} or
 * {chatId,createdAt:{gte}}), PLUS the crossModelMessage.create +
 * crossModelChat.update mocks the transcript-note poster writes through.
 *
 * Wire-up (same const-then-jest.mock pattern as pending-confirmations.testkit):
 *
 *   const mockQuestions = createOwnerQuestionTable();
 *   jest.mock('../../../config/database', () => ({
 *     __esModule: true,
 *     default: {
 *       ownerQuestion: mockQuestions.api,
 *       crossModelMessage: mockQuestions.crossModelMessage,
 *       crossModelChat: mockQuestions.crossModelChat,
 *     },
 *   }));
 *
 * The service lazy-imports config/database at CALL time, so the factory's
 * reference is always initialized by the first call. Reset rows between tests
 * with mockQuestions.reset() (jest.clearAllMocks keeps impls but not table
 * state).
 */
export function createOwnerQuestionTable() {
  const rows: any[] = [];
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      // Review 2026-09-13 issue 11: the triage-hide filter is an explicit
      // `OR: [...]` of null / not / lte branches — support the logical
      // combinators (Prisma shapes: OR = array, some branch; NOT = object or
      // array, none may match).
      if (k === 'OR' && Array.isArray(v)) return v.some((branch) => match(row, branch));
      if (k === 'NOT') return (Array.isArray(v) ? v : [v]).every((branch) => !match(row, branch));
      // Prisma `field: null` matches SQL NULL — a row built without the column
      // (undefined) is the same thing to a real DB, so treat both as null.
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        const cond: any = v;
        // Every present operator must hold (Prisma ANDs range bounds together).
        let known = false;
        if ('gt' in cond) { known = true; if (!(new Date(row[k]).getTime() > new Date(cond.gt).getTime())) return false; }
        if ('gte' in cond) { known = true; if (!(new Date(row[k]).getTime() >= new Date(cond.gte).getTime())) return false; }
        if ('lte' in cond) { known = true; if (!(new Date(row[k]).getTime() <= new Date(cond.lte).getTime())) return false; }
        if ('in' in cond) { known = true; if (!cond.in.includes(row[k])) return false; }
        // Inequality (Prisma `not`): SQL semantics — a NULL/absent column never
        // satisfies `not` (the triage filter carries explicit null branches).
        if ('not' in cond) { known = true; if (row[k] === null || row[k] === undefined || row[k] === cond.not) return false; }
        // Substring filter (Prisma string `contains`) — the stopped-schedule
        // marker lookup queries `context: { contains: '[stopped-schedule:…]' }`.
        if ('contains' in cond) { known = true; if (typeof row[k] !== 'string' || !row[k].includes(cond.contains)) return false; }
        // Prefix filter (Prisma string `startsWith`) — listOwnerQuestionsForUser
        // resolves ≥8-char id prefixes with `id: { startsWith: s }` (ticket
        // 8bae9959). A full id is a prefix of itself, so exact ids ride the
        // same operator.
        if ('startsWith' in cond) { known = true; if (typeof row[k] !== 'string' || !row[k].startsWith(cond.startsWith)) return false; }
        return known;
      }
      return row[k] === v;
    });
  const api = {
    create: jest.fn(async ({ data }: any) => {
      // new Date(Date.now()) (not bare new Date()) so jest.spyOn(Date,'now')
      // fake-time tests stay consistent with the service's Date.now()-based math.
      const row = {
        status: 'open', context: null, answer: null,
        createdAt: new Date(Date.now()), resolvedAt: null,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    delete: jest.fn(async ({ where }: any) => {
      const i = rows.findIndex((r) => match(r, where));
      if (i >= 0) return rows.splice(i, 1)[0];
      return null;
    }),
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
    findFirst: jest.fn(async ({ where, orderBy }: any = {}) => {
      let out = rows.filter((r) => match(r, where));
      if (orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      return out[0] ?? null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: any = {}) => {
      let out = rows.filter((r) => match(r, where));
      if (orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      if (take) out = out.slice(0, take);
      return out;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const m = rows.filter((r) => match(r, where));
      m.forEach((r) => Object.assign(r, data));
      return { count: m.length };
    }),
    count: jest.fn(async ({ where }: any = {}) => rows.filter((r) => match(r, where)).length),
  };
  // The transcript-note poster (postOwnerInboxNote) writes through these.
  // findMany + messageRows back the ticket-91ec252a triage-race probe
  // (answerOwnerQuestion reads role:'user' rows newer than the question's
  // createdAt in the filing chat; no seeded rows → the probe sees none).
  const messageRows: any[] = [];
  const crossModelMessage = {
    create: jest.fn(async (_args: any) => ({})),
    findMany: jest.fn(async ({ where, orderBy, take }: any = {}) => {
      let out = messageRows.filter((r) => match(r, where));
      if (orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      if (take) out = out.slice(0, take);
      return out;
    }),
  };
  const crossModelChat = { update: jest.fn(async (_args: any) => ({})) };
  // Ticket 26786762: the delivered-secrets store (owner_question_secrets) —
  // createMany / findMany / findFirst / update support every query shape
  // owner-question-secrets.ts issues; the activity audit table is
  // best-effort-only (a jest.fn that never throws).
  const secretRows: any[] = [];
  const ownerQuestionSecret = {
    createMany: jest.fn(async ({ data }: any) => {
      for (const d of data) secretRows.push({ revealCount: 0, revealedAt: null, createdAt: new Date(Date.now()), ...d });
      return { count: data.length };
    }),
    findMany: jest.fn(async ({ where, orderBy }: any = {}) => {
      let out = secretRows.filter((r) => match(r, where));
      if (orderBy?.ordinal === 'asc') out = [...out].sort((a, b) => a.ordinal - b.ordinal);
      return out;
    }),
    findFirst: jest.fn(async ({ where }: any = {}) => secretRows.find((r) => match(r, where)) ?? null),
    update: jest.fn(async ({ where, data }: any) => {
      const row = secretRows.find((r) => match(r, where));
      if (row) Object.assign(row, data);
      return row ?? null;
    }),
    deleteMany: jest.fn(async ({ where }: any = {}) => {
      const m = secretRows.filter((r) => match(r, where));
      for (const r of m) secretRows.splice(secretRows.indexOf(r), 1);
      return { count: m.length };
    }),
  };
  const activity = { create: jest.fn(async (_args: any) => ({})) };
  return {
    rows,
    api,
    messageRows,
    crossModelMessage,
    crossModelChat,
    secretRows,
    ownerQuestionSecret,
    activity,
    reset: () => {
      rows.length = 0;
      messageRows.length = 0;
      secretRows.length = 0;
      crossModelMessage.create.mockClear();
      crossModelMessage.findMany.mockClear();
      crossModelChat.update.mockClear();
      ownerQuestionSecret.createMany.mockClear();
      ownerQuestionSecret.findMany.mockClear();
      ownerQuestionSecret.findFirst.mockClear();
      ownerQuestionSecret.update.mockClear();
      ownerQuestionSecret.deleteMany.mockClear();
      activity.create.mockClear();
    },
  };
}
