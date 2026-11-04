/**
 * Test kit for memory/fact-versions.ts: an in-memory user_memory_fact_versions
 * table supporting exactly the query shapes the module uses (findMany with
 * {userId, key | key:{in}, validTo:null} + orderBy validFrom desc + take /
 * select; deleteMany {userId, key:{in}}; updateMany {id:{in}}; createMany).
 *
 * Wire-up — build it INSIDE the config/database factory (fact-versions imports
 * prisma at module load) and reach it through the mocked default export:
 *
 *   jest.mock('../../../config/database', () => {
 *     const { createFactVersionTable } = jest.requireActual('../memory/fact-versions.testkit');
 *     const versions = createFactVersionTable();
 *     return { __esModule: true, default: { ...versions.prismaModels(), __versions: versions } };
 *   });
 *   const versions = (prisma as any).__versions as FactVersionTable;
 *
 * Reset rows between tests with versions.reset().
 */
export interface FakeFactVersionRow {
  id: string;
  userId: string;
  key: string;
  value: string;
  source: string;
  sourceChatId: string | null;
  validFrom: Date;
  validTo: Date | null;
  endedReason: string | null;
  replacedBy: string | null;
  createdAt: Date;
}

export type FactVersionTable = ReturnType<typeof createFactVersionTable>;

export function createFactVersionTable() {
  const rows: FakeFactVersionRow[] = [];
  /** user_memory_facts rows (key → createdAt) the lazy backfill / meta fallback read. */
  const indexRows: Array<{ userId: string; key: string; createdAt: Date }> = [];
  let seq = 0;

  const keyMatches = (rowKey: string, cond: any): boolean => {
    if (cond === undefined) return true;
    if (typeof cond === 'string') return rowKey === cond;
    if (cond && Array.isArray(cond.in)) return cond.in.includes(rowKey);
    return false;
  };
  const match = (r: FakeFactVersionRow, where: any): boolean => {
    if (!where) return true;
    if (where.userId !== undefined && r.userId !== where.userId) return false;
    if (!keyMatches(r.key, where.key)) return false;
    if ('validTo' in where && where.validTo === null && r.validTo !== null) return false;
    if (where.id && Array.isArray(where.id.in) && !where.id.in.includes(r.id)) return false;
    return true;
  };
  const pick = (r: any, select: any) => {
    if (!select) return { ...r };
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
    return out;
  };

  const api = {
    findMany: jest.fn(async (args: any = {}) => {
      let out = rows.filter((r) => match(r, args.where));
      if (args.orderBy) out = [...out].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof args.take === 'number') out = out.slice(0, args.take);
      return out.map((r) => pick(r, args.select));
    }),
    deleteMany: jest.fn(async (args: any = {}) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], args.where)) { rows.splice(i, 1); count++; }
      return { count };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) if (match(r, where)) { Object.assign(r, data); count++; }
      return { count };
    }),
    createMany: jest.fn(async ({ data }: any) => {
      const list = Array.isArray(data) ? data : [data];
      for (const d of list) {
        const now = new Date(Date.now());
        rows.push({
          id: `v${++seq}`, sourceChatId: null, validTo: null, endedReason: null, replacedBy: null,
          createdAt: now, validFrom: now, ...d,
        });
      }
      return { count: list.length };
    }),
  };

  const indexApi = {
    findMany: jest.fn(async (args: any = {}) => indexRows
      .filter((r) => (args.where?.userId === undefined || r.userId === args.where.userId) && keyMatches(r.key, args.where?.key))
      .map((r) => ({ key: r.key, createdAt: r.createdAt }))),
  };

  return {
    rows,
    indexRows,
    api,
    indexApi,
    /** The prisma surface fact-versions touches: the versions model, the index read and an array $transaction. */
    prismaModels: () => ({
      userMemoryFactVersion: api,
      userMemoryFact: indexApi,
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    }),
    /** Open (current) versions, optionally for one key. */
    open: (userId: string, key?: string) => rows.filter((r) => r.userId === userId && r.validTo === null && (key === undefined || r.key === key)),
    /** Every version of one key, oldest first. */
    history: (userId: string, key: string) => rows.filter((r) => r.userId === userId && r.key === key).sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime() || a.id.localeCompare(b.id, 'en', { numeric: true })),
    /** Seed one version row directly. */
    seed: (row: Partial<FakeFactVersionRow> & { userId: string; key: string; value: string }) => {
      const now = new Date(Date.now());
      rows.push({ id: `v${++seq}`, source: 'turn', sourceChatId: null, validFrom: now, validTo: null, endedReason: null, replacedBy: null, createdAt: now, ...row });
    },
    reset: () => { rows.splice(0); indexRows.splice(0); seq = 0; },
  };
}
