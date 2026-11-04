/**
 * Prisma mock helpers for the 9dacab1a dispatch suites — a SELECT-FAITHFUL,
 * WHERE-FAITHFUL in-memory userFeatureRequest table (round-1 review root
 * cause: the old mock ignored `select` AND several where shapes, so vacuous
 * passes hid real behavior — see the 7b2990fa learning: after a
 * mock-fidelity upgrade, every pre-existing pin must be mutation-tested and
 * each pinned test must assert its fetch shape returned >0 rows).
 *
 * Faithfulness contract (mirrors what the drain + blocker index + closed
 * fetch actually issue):
 *  - `where.id.in` — membership
 *  - `where.id.startsWith` — prefix backstop (buildBlockerIndex F2 read side)
 *  - `where.status` / `where.status.in`
 *  - `where.updatedAt.gte`
 *  - `where.OR` — recursive branch evaluation
 *  - `select` — PROJECTION (unselected fields dropped, nested
 *    `user: { select: { role } }` projected too)
 *  - `orderBy` — the drain's static shapes ([{priority desc},{createdAt asc}],
 *    {createdAt asc}, {updatedAt desc}, [{updatedAt desc},{id desc}] — a
 *    non-date string field compares lexically)
 *  - `take` / `skip`
 *  - JSON-path filters (`context: { path: [...], equals }` — TICKET-LANE
 *    ARCHIVE GAPS 2026-10-21: the paged closed-lane scan filters
 *    dispatchMode in SQL; the path resolves inside the JSON column and the
 *    remaining operators apply to the resolved value)
 */

export type MockRow = {
  id: string;
  type?: string;
  title?: string;
  description?: string;
  priority?: number;
  source?: string;
  status?: string;
  adminNote?: string | null;
  context?: any;
  createdAt?: Date;
  updatedAt?: Date;
  userId?: string | null;
  user?: { role?: string | null } | null;
  [k: string]: unknown;
};

/** Evaluate one Prisma `where` clause against a row — recursive on OR/AND. */
export function mockMatchesWhere(r: Record<string, any>, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  for (const [key, v] of Object.entries(where)) {
    if (key === 'OR') {
      if (!Array.isArray(v) || !v.some((branch: any) => mockMatchesWhere(r, branch))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!Array.isArray(v) || !v.every((branch: any) => mockMatchesWhere(r, branch))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (mockMatchesWhere(r, v)) return false;
      continue;
    }
    if (v === null || typeof v !== 'object') {
      if (r[key] !== v) return false;
      continue;
    }
    // Prisma JSON-path filter ({ path: [...], equals, ... }): resolve the path
    // inside the JSON column, then evaluate the other operators on the value.
    if (Array.isArray((v as Record<string, unknown>).path)) {
      let cur: any = r[key];
      for (const seg of (v as { path: unknown[] }).path) cur = cur != null && typeof cur === 'object' ? cur[seg as string] : undefined;
      const { path: _path, ...ops } = v as Record<string, unknown>;
      if (!mockMatchesWhere({ json: cur }, { json: ops })) return false;
      continue;
    }
    // Field filter object ({ in, startsWith, endsWith, gte, lte, equals, notIn, not }).
    const val = r[key];
    for (const [op, operand] of Object.entries(v as Record<string, any>)) {
      switch (op) {
        case 'in':
          if (!Array.isArray(operand) || !operand.includes(val)) return false;
          break;
        case 'notIn':
          if (Array.isArray(operand) && operand.includes(val)) return false;
          break;
        case 'startsWith':
          if (typeof val !== 'string' || !val.startsWith(String(operand))) return false;
          break;
        case 'endsWith':
          if (typeof val !== 'string' || !val.endsWith(String(operand))) return false;
          break;
        case 'contains':
          if (typeof val !== 'string' || !val.includes(String(operand))) return false;
          break;
        case 'equals':
          // JSON null vs undefined: a stored null matches equals:null.
          if (operand === null ? val != null : val !== operand) return false;
          break;
        case 'gte':
          if (!(val != null && (val as any) >= (operand as any))) return false;
          break;
        case 'gt':
          if (!(val != null && (val as any) > (operand as any))) return false;
          break;
        case 'lte':
          if (!(val != null && (val as any) <= (operand as any))) return false;
          break;
        case 'lt':
          if (!(val != null && (val as any) < (operand as any))) return false;
          break;
        case 'not':
          if (operand === null ? val == null : val === operand) return false;
          break;
        default:
          // Unknown operator: be conservative and require equality.
          if (val !== (v as Record<string, unknown>)[op]) return false;
      }
    }
  }
  return true;
}

/** Apply a Prisma `select` projection (shallow + one nested level). */
export function mockApplySelect(row: Record<string, any>, select: any): Record<string, any> {
  if (!select || typeof select !== 'object') return { ...row };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object') {
      // Nested select (user: { select: { role: true } }).
      out[k] = row[k] && typeof row[k] === 'object' ? mockApplySelect(row[k], (v as any).select) : row[k];
    }
  }
  return out;
}

/** Sort by the orderBy shapes the drains issue (array form + single-object form). */
export function mockApplyOrderBy<T extends Record<string, any>>(rows: T[], orderBy: any): T[] {
  const out = [...rows];
  const terms: Array<[string, string]> = Array.isArray(orderBy)
    ? orderBy.map((o: any) => Object.entries(o)[0] as [string, string])
    : orderBy && typeof orderBy === 'object'
      ? [Object.entries(orderBy)[0] as [string, string]]
      : [];
  out.sort((a, b) => {
    for (const [field, dir] of terms) {
      const av = a[field]; const bv = b[field];
      // A date-shaped string compares as a time; any other string lexically (an id tiebreak).
      const an = av instanceof Date ? av.getTime() : typeof av === 'string' && !Number.isNaN(Date.parse(av)) ? Date.parse(av) : av;
      const bn = bv instanceof Date ? bv.getTime() : typeof bv === 'string' && !Number.isNaN(Date.parse(bv)) ? Date.parse(bv) : bv;
      if (an === bn) continue;
      const cmp = (an ?? -Infinity) < (bn ?? -Infinity) ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return out;
}

export interface MockFindManyArgs {
  where?: any;
  orderBy?: any;
  take?: number;
  skip?: number;
  select?: any;
}

/**
 * A select-faithful `userFeatureRequest.findMany` over an array of rows.
 * `rowsRef` is a getter so tests that reassign their fixture array keep
 * being seen (the fixture pattern reassigns `tickets = [...]` per test).
 */
export function makeFaithfulFindMany(rowsRef: () => MockRow[]) {
  return async (args: MockFindManyArgs = {}): Promise<MockRow[]> => {
    const matched = rowsRef().filter((r) => mockMatchesWhere(r as Record<string, any>, args.where));
    const sorted = mockApplyOrderBy(matched as Record<string, any>[], args.orderBy) as MockRow[];
    const paged = sorted.slice(args.skip ?? 0, args.take != null ? (args.skip ?? 0) + args.take : undefined);
    // NOTE: build the projected row WITHOUT an object-literal spread — TS drops
    // the index signature through spread (github.com/microsoft/TypeScript
    // #10727), which would type every projected row as `{ context: any }` and
    // break `.id` / `.status` access in the suites.
    return paged.map((r) => {
      const projected = mockApplySelect(r as Record<string, any>, args.select);
      projected.context = r.context === undefined ? undefined : JSON.parse(JSON.stringify(r.context ?? null));
      return projected as MockRow;
    });
  };
}

/**
 * Third review (2026-10-22): the drain now reads the lane-family-facts HOUSE
 * RULES (readLaneKeepReasons) before it archives a CLOSED ticket's own lane and
 * the superseded lane at re-dispatch, and a failed read keeps the lane (fail
 * closed). A suite that does not model those reads fills them with EMPTY answers
 * here — no owner question, no todo, no human row, no share link, no pin, no
 * integration, no descendant, no restore marker, no restore audit row — so its
 * lanes are archived exactly as before. Only MISSING model methods are added;
 * a suite's own mocks are never replaced. Plain async functions (this file is
 * compiled with the app — no jest globals).
 */
export function withEmptyHouseRuleReads<T extends Record<string, any>>(prisma: T): T {
  const p = prisma as Record<string, any>;
  const fill = (model: string, method: string, impl: (args: any) => Promise<unknown[]>) => {
    p[model] = p[model] ?? {};
    if (typeof p[model][method] !== 'function') p[model][method] = impl;
  };
  const empty = async () => [];
  for (const model of ['projectTodo', 'ownerQuestion', 'pendingConfirmation', 'crossModelMessage', 'chatShareLink', 'chatWebhook', 'eventHook', 'activity']) {
    fill(model, 'findMany', empty);
  }
  // Only the house-rule SHAPES answer empty — any other read of these models
  // still fails like the missing method it replaces (a suite that never modelled
  // chat existence must keep reading "unknown", never "no chat").
  fill('crossModelChat', 'findMany', async (args: any) => {
    const sel = args?.select ?? {};
    // The restore-audit owners read selects { id, userId, createdAt } (fifth review 2026-10-22: createdAt bounds the scan).
    const auditOwners = sel.id && sel.userId && Object.keys(sel).every((k) => ['id', 'userId', 'createdAt'].includes(k));
    if (args?.where?.parentChatId?.in || sel.titlePinned || auditOwners) return [];
    throw new TypeError('crossModelChat.findMany is not modelled by this suite');
  });
  fill('contextStoreEntry', 'findMany', async (args: any) => {
    if (String(args?.where?.namespacePath ?? '').includes('lane-lifecycle')) return [];
    throw new TypeError('contextStoreEntry.findMany is not modelled by this suite');
  });
  return prisma;
}
