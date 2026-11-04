/**
 * Test kit for the DB-persisted confirmation registry (pending-confirmations.ts):
 * an in-memory pendingConfirmation table supporting exactly the query shapes the
 * registry uses (create / findUnique by id / findMany with {userId,status(:{in}),
 * expiresAt:{gt,lte}} / conditional updateMany / count).
 *
 * Wire-up (same const-then-jest.mock pattern the platform suites use for
 * platform.service):
 *
 *   const mockConfirmations = createPendingConfirmationTable();
 *   jest.mock('../../../config/database', () => ({
 *     __esModule: true,
 *     default: { pendingConfirmation: mockConfirmations.api },
 *   }));
 *
 * The registry lazy-imports config/database at CALL time, so the factory's
 * reference is always initialized by the first gate call. Reset rows between
 * tests with mockConfirmations.reset() (jest.clearAllMocks keeps impls but not
 * table state).
 */
export function createPendingConfirmationTable() {
  const rows: any[] = [];
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        const cond: any = v;
        // Every present operator must hold (Prisma ANDs range bounds together).
        let known = false;
        if ('gt' in cond) { known = true; if (!(new Date(row[k]).getTime() > new Date(cond.gt).getTime())) return false; }
        if ('lte' in cond) { known = true; if (!(new Date(row[k]).getTime() <= new Date(cond.lte).getTime())) return false; }
        if ('in' in cond) { known = true; if (!cond.in.includes(row[k])) return false; }
        return known;
      }
      return row[k] === v;
    });
  const api = {
    create: jest.fn(async ({ data }: any) => {
      // new Date(Date.now()) (not bare new Date()) so jest.spyOn(Date,'now')
      // fake-time tests stay consistent with the registry's Date.now()-based math.
      const row = { status: 'pending', result: null, createdAt: new Date(Date.now()), resolvedAt: null, ...data };
      rows.push(row);
      return row;
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
  return { rows, api, reset: () => { rows.length = 0; } };
}
