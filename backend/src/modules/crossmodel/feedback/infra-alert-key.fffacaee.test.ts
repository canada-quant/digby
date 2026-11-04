/**
 * PIN (ticket fffacaee, 2026-10-20) — LEG 1 of 2: infra-alert FILINGS dedup
 * on the alert's STABLE KEY.
 *
 * THE DEFECT THIS PINS: one failed deploy run (39441731823, sha 51946acc,
 * failed 2026-10-20 14:47:52Z) produced TWO agent-filed tickets ~50 s apart —
 * b612be26 from chat 6061a468 ("Deploy run 39441731823 failed (sha 51946acc,
 * CI also red) — fix and re-run") and 9e0c9f5a from chat c0e22e36 ("Deploy
 * run 39441731823 failed on main head 51946acc — fix and re-run") — because
 * every dedup pass in fileFeedbackTicket keys on TITLE TEXT (normalized
 * equality, the mishap 60-char prefix, Jaccard, containment) and infra-watch
 * fans ONE deploy-failure alert out to up to 10 admin supervisor chats, each
 * of which composes its own wording.
 *
 * THE FIX (filing side): a deploy-failure / CI-red alert filing extracts its
 * STABLE KEY — 'deploy-failure:<runId>:<owner>/<repo>' (a "Deploy run <id>"-
 * led title corroborated by the raw github.com/<owner>/<repo>/actions/runs/
 * <id> URL in the body) or 'ci-red:<sha>[:<owner>/<repo>]' (a CI-red-shaped
 * title with the failing sha) — and bumps the OPEN agent ticket carrying the
 * same key instead of creating a new row. Pre-fix rows are matched by
 * re-deriving their key from their own alert shape. THE INCIDENT PAIR
 * REPLAYED VERBATIM (both real titles + description heads, source 'agent')
 * must fold into ONE row with occurrences=2.
 *
 * STRICT-ALERT GATING is pinned too: a META-ticket ABOUT the duplicate-alert
 * defect (this very ticket's title) quotes the same run id + sha in its
 * title/description but is NOT alert-shaped — it must never fold. This
 * guards the false-positive direction the whole design depends on.
 *
 * The DISPATCH leg is pinned in infra-alert-dispatch.fffacaee.test.ts (the
 * 9dacab1a harness); this file pins the pure extractor + the filing pass on
 * the feedback.service.test.ts mock pattern.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope

import {
  extractInfraAlertKey,
  infraAlertKeyString,
  infraAlertKeysEqual,
  infraAlertKeyOfContext,
  INFRA_ALERT_KEY_FIELD,
} from './infra-alert-key';

const FEEDBACK_SRC = fs.readFileSync(path.join(__dirname, 'feedback.service.ts'), 'utf8');
const DISPATCH_SRC = fs.readFileSync(path.join(__dirname, 'ticket-dispatch.service.ts'), 'utf8');

// The INCIDENT's verbatim rows (read with get_feedback 2026-10-20; titles and
// description heads quoted verbatim, tails elided for the fixture).
const RUN = '39441731823';
const SHA = '51946acc';
const REPO = 'canada-quant/digby';
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN}`;
const TITLE_A = `Deploy run ${RUN} failed (sha ${SHA}, CI also red) — fix and re-run`;
const TITLE_B = `Deploy run ${RUN} failed on main head ${SHA} — fix and re-run`;
const DESC_A = `INFRA ALERT (deploy failed, seen 2026-10-20T14:53Z): GitHub deploy run ${RUN} for sha ${SHA} ("Merge remote-tracking branch 'origin/main'…") concluded FAILURE (started 2026-10-20T14:42:47Z): ${RUN_URL} — and the same-sha CI (ci.yml) verdict is ALSO failure, so the code on main is genuinely red.`;
const DESC_B = `[INFRA ALERT — deploy failed, fleet supervisor dispatch 2026-10-20T14:54Z]\n\nFailed run: ${RUN_URL}\n- Deploy run ${RUN} for sha ${SHA} ("Merge remote-tracking branch 'origin/main' into claude/relaxed-pasteur-0k7de0", committed 2026-10-20T14:38:31Z) concluded FAILURE (started 14:42:47Z, ended 14:47:52Z).`;

describe('fffacaee — the pure stable-key extractor (infra-alert-key.ts)', () => {
  it('extracts deploy-failure:<runId>:<owner>/<repo> from BOTH incident titles despite the differing wording', () => {
    const a = extractInfraAlertKey(TITLE_A, DESC_A);
    const b = extractInfraAlertKey(TITLE_B, DESC_B);
    expect(a).toEqual({ kind: 'deploy-failure', id: RUN, repo: REPO });
    expect(b).toEqual({ kind: 'deploy-failure', id: RUN, repo: REPO });
    expect(infraAlertKeyString(a!)).toBe(`deploy-failure:${RUN}:${REPO}`);
    expect(infraAlertKeyString(a!)).toBe(infraAlertKeyString(b!)); // ONE key for both wordings
  });

  it('extracts ci-red:<sha> from the CI-watch wake shape ([CI FAILED — owner/repo@sha12])', () => {
    const title = `[CI FAILED — canada-quant/digby@1a2b3c4d5e6f] The commit this lane pushed is RED on GitHub`;
    const body = `[CI FAILED — canada-quant/digby@1a2b3c4d5e6f] The commit this lane pushed (branch main · PR #123 · receipt ab12cd34) is RED on GitHub: shard 3/4.`;
    const k = extractInfraAlertKey(title, body);
    expect(k).toEqual({ kind: 'ci-red', id: '1a2b3c4d5e6f', repo: REPO });
    expect(infraAlertKeyString(k!)).toBe(`ci-red:1a2b3c4d5e6f:${REPO}`);
  });

  it('STRICT GATING — the META ticket about this very defect (fffacaee) quotes the run id + sha but is NOT alert-shaped: no key, no fold', () => {
    const metaTitle = 'Infra-alert dispatcher double-files/double-dispatches one failed deploy run (two tickets ~50s apart, two lanes)';
    const metaDesc = `Evidence in the ticket body: deploy run ${RUN} (sha ${SHA}) produced TWO infra-alert tickets ~50s apart. Both name the same run id in their titles: ${RUN_URL}. Suggested fix: dedup on the stable key.`;
    expect(extractInfraAlertKey(metaTitle, metaDesc)).toBeNull();
    const alertKey = extractInfraAlertKey(TITLE_A, DESC_A)!;
    expect(infraAlertKeysEqual({ title: metaTitle, description: metaDesc, context: {} }, alertKey)).toBe(false);
  });

  it('STRICT GATING — a "Deploy run <id>"-led title WITHOUT the raw run URL in the body is not an alert filing', () => {
    expect(extractInfraAlertKey(TITLE_A, 'The deploy failed yesterday; nobody re-ran it.')).toBeNull();
  });

  it('STRICT GATING — a DIFFERENT failed run id never folds (the key is the identity, not the class)', () => {
    const other = extractInfraAlertKey(`Deploy run 39499999999 failed (sha ${SHA}) — fix and re-run`, `Failed run: https://github.com/${REPO}/actions/runs/39499999999`);
    const a = extractInfraAlertKey(TITLE_A, DESC_A)!;
    expect(infraAlertKeyString(other!)).not.toBe(infraAlertKeyString(a));
  });

  it('STRICT GATING — a title-led run id whose body URL names a DIFFERENT run is not an alert filing about the title\'s run', () => {
    expect(extractInfraAlertKey(TITLE_A, `Other failure: https://github.com/${REPO}/actions/runs/39499999999`)).toBeNull();
  });

  it('keys compare through the context stamp (post-fix rows) AND through re-derivation (pre-fix rows)', () => {
    const a = extractInfraAlertKey(TITLE_A, DESC_A)!;
    const keyStr = infraAlertKeyString(a);
    expect(infraAlertKeyOfContext({ [INFRA_ALERT_KEY_FIELD]: keyStr })).toBe(keyStr);
    expect(infraAlertKeysEqual({ context: { [INFRA_ALERT_KEY_FIELD]: keyStr }, title: 'unrelated', description: 'unrelated' }, a)).toBe(true);
    // unstamped but alert-shaped (the pre-fix B row)
    expect(infraAlertKeysEqual({ context: {}, title: TITLE_B, description: DESC_B }, a)).toBe(true);
  });

  it('TEXTUAL — the leaf imports no I/O modules (prisma/redis/logger): the pure-leaf discipline', () => {
    const src = fs.readFileSync(path.join(__dirname, 'infra-alert-key.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+'(?:\.\.\/)*(?:config\/database|config\/redis|utils\/logger)'/);
  });

  it('TEXTUAL — the filing pass is wired into fileFeedbackTicket and the dispatch guard reads the same leaf', () => {
    expect(FEEDBACK_SRC).toMatch(/'infra-alert-key'/);            // bumpDedupedTicket match kind
    expect(FEEDBACK_SRC).toMatch(/infraAlertDedupDisabled\(\)/);  // filing-side kill switch
    expect(DISPATCH_SRC).toMatch(/INFRA_ALERT_COLLISION_NOTE_PREFIX/);
    expect(DISPATCH_SRC).toMatch(/claimedAlertKeys\.set\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The FILING leg (feedback.service mocked-prisma harness)
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// The filing path dynamically imports ticket-dispatch.service (config/redis →
// config/env exits without env) — mock the boundary (feedback.service.test.ts
// pattern).
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'sent', batched: 1 })),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));

import { fileFeedbackTicket } from './feedback.service';

/** WHERE-faithful matcher for the dedup scans' query shapes: equality,
 *  in/gte/lt on Date fields, title contains (the prefilter token), the
 *  context-path JSON filters (sessionId / chatId / duplicateOf), AND/OR. */
function matchesWhere(r: any, where: any): boolean {
  if (!where || typeof where !== 'object') return true;
  for (const [key, v] of Object.entries(where)) {
    if (key === 'AND') { if (!Array.isArray(v) || !v.every((b: any) => matchesWhere(r, b))) return false; continue; }
    if (key === 'OR') { if (!Array.isArray(v) || !v.some((b: any) => matchesWhere(r, b))) return false; continue; }
    if (key === 'context' && v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).path)) {
      const cv = v as Record<string, unknown>;
      const cur = (cv.path as any[]).reduce<any>((acc, p) => (acc && typeof acc === 'object') ? acc[p] : undefined, r.context);
      if (cv.equals !== undefined && cur !== cv.equals) return false;
      continue;
    }
    if (v === null || typeof v !== 'object') { if (r[key] !== v) return false; continue; }
    if (v instanceof Date) { if (new Date(r[key]).getTime() !== v.getTime()) return false; continue; }
    const val = r[key];
    for (const [op, operand] of Object.entries(v as Record<string, any>)) {
      const asDate = (x: any) => (x instanceof Date ? x.getTime() : new Date(x).getTime());
      if (op === 'in') { if (!Array.isArray(operand) || !operand.includes(val)) return false; }
      else if (op === 'gte') { if (!(val != null && asDate(val) >= asDate(operand))) return false; }
      else if (op === 'lte') { if (!(val != null && asDate(val) <= asDate(operand))) return false; }
      else if (op === 'lt') { if (!(val != null && asDate(val) < asDate(operand))) return false; }
      else if (op === 'gt') { if (!(val != null && asDate(val) > asDate(operand))) return false; }
      else if (op === 'equals') { if (operand === null ? val != null : val !== operand) return false; }
      else if (op === 'startsWith') { if (!String(val ?? '').startsWith(String(operand))) return false; }
      else if (op === 'contains') { if (!String(val ?? '').toLowerCase().includes(String(operand).toLowerCase())) return false; }
      else if (op === 'mode' || op === 'case' || op === 'not') { /* Prisma mode flags — already honored case-insensitively above */ }      else { if (val !== (v as Record<string, unknown>)[op]) return false; }
    }
  }
  return true;
}

/** The in-memory open-ticket table the dedup scans read. */
let openRows: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED;
  openRows = [];
  mockPrisma.userFeatureRequest.findMany.mockImplementation(async (args: any) => {
    let rows = openRows.filter((r) => matchesWhere(r, args?.where));
    const ord = Array.isArray(args?.orderBy) ? args.orderBy[0] : args?.orderBy;
    const field = ord ? Object.keys(ord)[0] : 'createdAt';
    const dir = ord ? Object.values(ord)[0] : 'desc';
    rows = [...rows].sort((a: any, b: any) => {
      const av = new Date(a[field]).getTime(); const bv = new Date(b[field]).getTime();
      if (av !== bv) return dir === 'desc' ? bv - av : av - bv;
      return dir === 'desc' ? String(b.id).localeCompare(String(a.id)) : String(a.id).localeCompare(String(b.id));
    });
    return rows.slice(0, args?.take ?? rows.length);
  });
  mockPrisma.userFeatureRequest.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
  mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'created-0000-0000-0000000000ff', ...data }));
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
});

describe('fffacaee — FILING leg: a second alert naming an OPEN ticket\'s run id bumps it (no new row)', () => {
  it('the incident pair replayed VERBATIM: B (different wording, same run) bumps A — occurrences=2, NO create, key stamped', async () => {
    // A = the first supervisor's filing (b612be26's real title + description head)
    openRows = [{
      id: 'b612be26-3dba-4760-b389-866ddb6eb511',
      type: 'enhancement', source: 'agent', status: 'open', priority: 4,
      title: TITLE_A, description: DESC_A,
      context: { sessionId: '6061a468-bb49-428c-8879-e77e7a9939c7', surface: 'chat', filedAt: '2026-10-20T14:54:10.403Z' },
      createdAt: new Date('2026-10-20T14:54:10.436Z'), updatedAt: new Date('2026-10-20T14:54:10.436Z'),
    }];
    // B = the second supervisor's filing ~50s later (9e0c9f5a's real title + description head)
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'enhancement', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: 'c0e22e36-1c74-4295-8049-8b48335c6c37', surface: 'chat', filedAt: '2026-10-20T14:55:00.114Z' },
    });
    expect(r).toMatchObject({ deduped: true });
    expect((r as any).ticket.id).toBe('b612be26-3dba-4760-b389-866ddb6eb511');
    // the bump write: occurrences 1 → 2, the sighting trail names B's session
    const bumpCall = mockPrisma.userFeatureRequest.update.mock.calls.map((c: any[]) => c[0])
      .find((a: any) => a.data?.context && typeof a.data.context.occurrences === 'number');
    expect(bumpCall).toBeTruthy();
    expect(bumpCall.where.id).toBe('b612be26-3dba-4760-b389-866ddb6eb511');
    expect(bumpCall.data.context.occurrences).toBe(2);
    expect(bumpCall.data.context.sightings).toHaveLength(1);
    expect(bumpCall.data.context.sightings[0].sessionId).toBe('c0e22e36-1c74-4295-8049-8b48335c6c37');
    // the stable key is stamped on the bumped row (the dispatch leg reads it)
    expect(bumpCall.data.context[INFRA_ALERT_KEY_FIELD]).toBe(`deploy-failure:${RUN}:${REPO}`);
    // NO new row was created
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('the alert-key pass folds even across TYPES (bug_report vs enhancement) — the key, not the type, is the identity', async () => {
    openRows = [{
      id: 'alert-0000-0000-0000000000aa', type: 'enhancement', source: 'agent', status: 'open', priority: 4,
      title: TITLE_A, description: DESC_A, context: {},
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'bug_report', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: 'sess-2', surface: 'chat', filedAt: new Date().toISOString() },
    });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('a META ticket about the duplicate-alert defect (fffacaee\'s own shape) is NOT folded into the alert ticket', async () => {
    openRows = [{
      id: 'alert-0000-0000-0000000000ab', type: 'enhancement', source: 'agent', status: 'open', priority: 4,
      title: TITLE_A, description: DESC_A, context: { [INFRA_ALERT_KEY_FIELD]: `deploy-failure:${RUN}:${REPO}` },
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'bug_report',
      title: 'Infra-alert dispatcher double-files/double-dispatches one failed deploy run (two tickets ~50s apart, two lanes)',
      description: `Evidence: deploy run ${RUN} (sha ${SHA}) produced two tickets. See ${RUN_URL}. Fix: dedup on the stable key.`,
      priority: 2,
      context: { sessionId: 'sess-meta', surface: 'coding', filedAt: new Date().toISOString() },
    });
    // a fresh row (the meta ticket is a DIFFERENT ticket about the defect)
    expect(r).not.toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalled();
  });

  it('the kill switch FEEDBACK_INFRA_ALERT_DEDUP_DISABLED=1 reverts to title-only dedup (B files a new row)', async () => {
    process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED = '1';
    openRows = [{
      id: 'alert-0000-0000-0000000000ac', type: 'enhancement', source: 'agent', status: 'open', priority: 4,
      title: TITLE_A, description: DESC_A, context: {},
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'enhancement', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: 'sess-2', surface: 'chat', filedAt: new Date().toISOString() },
    });
    expect(r).not.toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalled();
  });

  it('a USER-filed open alert ticket is never mutated by an agent filing (agent immutability holds)', async () => {
    openRows = [{
      id: 'user-0000-0000-0000000000ad', type: 'enhancement', source: 'user', status: 'open', priority: 2,
      title: TITLE_A, description: DESC_A, context: {},
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'enhancement', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: 'sess-2', surface: 'chat', filedAt: new Date().toISOString() },
    });
    expect(r).not.toMatchObject({ deduped: true }); // the scan is source:'agent' — the user row is invisible
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalled();
  });

  it('a CLOSED alert ticket does not take the open-state bump (the closed-reopen machinery owns closed rows)', async () => {
    openRows = [{
      id: 'closed00-0000-0000-000000000ae', type: 'enhancement', source: 'agent', status: 'done', priority: 4,
      title: TITLE_A, description: DESC_A, context: { [INFRA_ALERT_KEY_FIELD]: `deploy-failure:${RUN}:${REPO}` },
      createdAt: new Date(Date.now() - 90_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'enhancement', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: 'sess-2', surface: 'chat', filedAt: new Date().toISOString() },
    });
    // not the OPEN-state bump — a fresh row (closed rows flow through the
    // reopen/adjudicated passes, which this test does not pin)
    expect(r).not.toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalled();
  });
});
