import {
  classifyFileResult,
  dropLiveWrites,
  findingMetricRows,
  liveRunWriteStarts,
  mergeSignalFindings,
  runFrameworkSignalSweepOnce,
  signalTicketArgs,
  writtenByLiveRun,
  type FrameworkSignalSweepDeps,
  type SignalFinding,
  type TicketArgs,
} from './framework-signal-sweep';

// ── d6fdc1df(d): defaultDeps' loadOpenFingerprints must include tickets closed
// 'done' in the last 7 days (otherwise the hour after a lane closes its fix,
// the sweep re-files the same finding) and pass a deterministic orderBy. The
// prisma stub captures the exact findMany args the real defaultDeps issues.
const mockPrismaCalls: any[] = [];
let mockFingerprintRows: any[] = [];
// Ticket 92d644c6: the live-run write guard reads agent_runs. Default = no
// live runs, so every pre-existing expectation in this file is unchanged.
let mockLiveRuns: any[] = [];
// Assistant rows the real loadMessages issues; a test may swap them.
let mockMessageRows: any[] = [{ id: 'm1', chatId: 'chat-1', content: '[/CANVAS]', parts: null }];
const mockPrisma = {
  crossModelMessage: {
    findMany: jest.fn(async (args: any = {}) => {
      const where = args.where;
      if (where?.role === 'user') return [];
      mockPrismaCalls.push({ crossModelMessage: true, ...args });
      // The live-run guard filters ROWS in JS after the query (it needs each
      // row's createdAt), so the query itself is issued unfiltered.
      return mockMessageRows;
    }),
  },
  agentRun: {
    findMany: jest.fn(async (args: any = {}) => {
      mockPrismaCalls.push({ agentRun: true, ...args });
      const now = Date.now();
      return mockLiveRuns.filter((r) => r.status === 'running' && +new Date(r.leaseExpiresAt) > now);
    }),
  },
  ownerQuestion: {
    findMany: jest.fn(async (args: any = {}) => {
      mockPrismaCalls.push({ ownerQuestion: true, ...args });
      return [];
    }),
  },
  crossModelChat: { findMany: jest.fn(async () => [{ id: 'sup-1', userId: 'owner-1' }]) },
  userFeatureRequest: {
    findMany: jest.fn(async (args: any = {}) => {
      mockPrismaCalls.push(args);
      // A row that names its status is filtered by the query's OR (the r2
      // dedupe tests drive the REAL loadOpenFingerprints query); a status-less
      // row is returned as before.
      return mockFingerprintRows.filter((r) => r.status === undefined || mockMatchesOr(r, args?.where?.OR));
    }),
  },
};
/** Evaluate a loadOpenFingerprints OR clause (status / status-in / updatedAt floor) against one row. */
function mockMatchesOr(row: any, or: any[] | undefined): boolean {
  if (!Array.isArray(or)) return true;
  return or.some((c) => {
    const s = c?.status;
    const statusOk = typeof s === 'string' ? row.status === s : Array.isArray(s?.in) ? s.in.includes(row.status) : true;
    const gte = c?.updatedAt?.gte;
    return statusOk && (!gte || +new Date(row.updatedAt) >= +new Date(gte));
  });
}
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./infra-watch.service', () => ({
  __esModule: true,
  adminFleetSupervisors: jest.fn(async () => [{ id: 'sup-1', userId: 'owner-1' }]),
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-new', title: 'x' } })),
  normalizeFeedbackTitle: jest.fn((t: string) => String(t ?? '').toLowerCase()),
}));

// 2026-10-20: the default deps' daily budget (Redis INCR-first) + per-pass
// loop_metrics row — both mocked at the boundary.
const mockRedisStore = new Map<string, number>();
const mockRedis = {
  incr: jest.fn(async (k: string) => { const n = (mockRedisStore.get(k) ?? 0) + 1; mockRedisStore.set(k, n); return n; }),
  decr: jest.fn(async (k: string) => { const n = (mockRedisStore.get(k) ?? 0) - 1; mockRedisStore.set(k, n); return n; }),
  expire: jest.fn(async () => 1),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { FRAMEWORK_SIGNAL_SWEEP: 'framework_signal_sweep' },
}));

const norm = (title: string) => title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function deps(over: Partial<FrameworkSignalSweepDeps> = {}): FrameworkSignalSweepDeps {
  return {
    loadMessages: async () => [],
    loadQuestions: async () => [],
    loadUserMessages: async () => [],
    loadAssistants: async () => [],
    loadAdminAuthor: async () => 'admin-1',
    loadOpenFingerprints: async () => new Set(),
    fileTicket: async () => ({ deduped: false, ticket: { title: '' } }),
    normalizeTitle: norm,
    ...over,
  };
}

/** d6fdc1df: [HARNESS …] was one flood class — a bracketed harness word with
 *  no renderer contract. Keep a fixture of the exact shape that flooded. */
const harnessBlock = (chatId: string) => ({
  id: `m-${chatId}`,
  chatId,
  content: '[HARNESS EVIDENCE GUARD] UNVERIFIED — never list work you did not execute',
  parts: null,
});

describe('framework signal sweep', () => {
  const prev = process.env.FRAMEWORK_SIGNAL_SWEEP_DISABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.FRAMEWORK_SIGNAL_SWEEP_DISABLED;
    else process.env.FRAMEWORK_SIGNAL_SWEEP_DISABLED = prev;
  });

  it('returns sweep: disabled before touching deps', async () => {
    process.env.FRAMEWORK_SIGNAL_SWEEP_DISABLED = '1';
    const boom = () => { throw new Error('called'); };
    const status = await runFrameworkSignalSweepOnce(deps({
      loadMessages: boom, loadQuestions: boom, loadUserMessages: boom,
      loadAdminAuthor: boom, loadOpenFingerprints: boom, fileTicket: boom,
    }));
    expect(status).toBe('sweep: disabled');
  });

  it('stops before filing when there is no admin author', async () => {
    const fileTicket = jest.fn();
    const loadOpenFingerprints = jest.fn();
    const status = await runFrameworkSignalSweepOnce(deps({
      loadAdminAuthor: async () => null,
      loadMessages: async () => [],
      fileTicket,
      loadOpenFingerprints,
    }));
    expect(status).toBe('sweep: scanned 0/0/0, found 0, no admin author');
    expect(fileTicket).not.toHaveBeenCalled();
    expect(loadOpenFingerprints).not.toHaveBeenCalled();
  });

  it('names the finding count when there is no author', async () => {
    const status = await runFrameworkSignalSweepOnce(deps({
      loadAdminAuthor: async () => null,
      // d6fdc1df: a real renderer marker (stray [/CANVAS]) still flags.
      loadMessages: async () => [{ id: 'm1', chatId: 'abcd1234-rest', content: '[/CANVAS]', parts: null }],
    }));
    expect(status).toBe('sweep: scanned 1/0/0, found 1, no admin author');
  });

  // ── d6fdc1df part (a): the sweep files NO log-signature findings ──────────

  it('d6fdc1df(a): recurring logs yield NO findings — log-signal-sweep owns logs', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const status = await runFrameworkSignalSweepOnce(deps({
      // Even a loudly recurring error class must produce nothing here: the
      // framework sweep never reads logs, and the deps seam has no loadLogs.
      loadMessages: async () => [],
      fileTicket,
    }));
    expect(status).toBe('sweep: scanned 0/0/0, found 0, deduped 0, filed 0, capped 0');
    expect(fileTicket).not.toHaveBeenCalled();
    // The seam itself is gone: no loadLogs on the deps contract.
    expect((deps() as unknown as Record<string, unknown>).loadLogs).toBeUndefined();
  });

  // ── d6fdc1df part (b): harness/secret/redacted/prose caps never flag; the
  // flood class ([HARNESS …] in N chats) files nothing, and a per-marker
  // fingerprint means two chats with the same marker file ONE ticket. ────────

  it('d6fdc1df(b): HARNESS blocks in two chats file NOTHING', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const status = await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [harnessBlock('aaaa1111-rest'), harnessBlock('bbbb2222-rest')],
      fileTicket,
    }));
    expect(status).toBe('sweep: scanned 2/0/0, found 0, deduped 0, filed 0, capped 0');
    expect(fileTicket).not.toHaveBeenCalled();
  });

  it('d6fdc1df(b): two chats with the SAME real marker produce ONE fingerprint and ONE ticket', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const status = await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [
        { id: 'm1', chatId: 'aaaa1111-rest', content: '[/CANVAS]', parts: null },
        { id: 'm2', chatId: 'bbbb2222-rest', content: '[/CANVAS]', parts: null },
      ],
      fileTicket,
    }));
    expect(status).toBe('sweep: scanned 2/0/0, found 1, deduped 0, filed 1, capped 0');
    expect(fileTicket).toHaveBeenCalledTimes(1);
    const args = (fileTicket.mock.calls as unknown as TicketArgs[][])[0][0];
    expect(args.context.fingerprint).toBe('raw-marker:CANVAS');
    expect(args.context.sessionId).toBe('framework-sweep:raw-marker:CANVAS');
    // chatId/messageId stay as the example occurrence only.
    expect(typeof args.context.chatId).toBe('string');
    expect(typeof args.context.messageId).toBe('string');
  });

  it('d6fdc1df(b): an unclosed [SEND_EMAIL is still flagged high', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [{ id: 'm1', chatId: 'abcd1234-rest', content: '[SEND_EMAIL to="a@b.c"', parts: null }],
      fileTicket,
    }));
    const args = (fileTicket.mock.calls as unknown as TicketArgs[][])[0][0];
    expect(args.context.fingerprint).toBe('raw-marker:SEND_EMAIL');
    expect(args.priority).toBe(1);
    expect(args.context.severity).toBe('high');
  });

  it('dedupes an open fingerprint without filing', async () => {
    const fileTicket = jest.fn();
    const status = await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [{ id: 'm1', chatId: 'abcd1234-rest', content: '[/CANVAS]', parts: null }],
      loadOpenFingerprints: async () => new Set(['raw-marker:CANVAS']),
      fileTicket,
    }));
    expect(status).toBe('sweep: scanned 1/0/0, found 1, deduped 1, filed 0, capped 0');
    expect(fileTicket).not.toHaveBeenCalled();
  });

  it('files one ticket when two messages share a marker, and keeps high', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [
        { id: 'm1', chatId: 'c1', content: '[SEND_EMAIL subject="hi"]x[/SEND_EMAIL]', parts: null },
        { id: 'm2', chatId: 'c1', content: '[SEND_EMAIL to="a@b.c"]', parts: null },
      ],
      fileTicket,
    }));
    expect(fileTicket).toHaveBeenCalledTimes(1);
    const calls = fileTicket.mock.calls as unknown as TicketArgs[][];
    const args = calls[0][0];
    expect(args.priority).toBe(1);
    expect(args.context.severity).toBe('high');
    expect(args.title).toContain('(high)');
  });

  it('does not put the address in a high SEND_EMAIL ticket', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [{
        id: 'm1',
        chatId: 'abcd1234-rest',
        content: '[SEND_EMAIL to="secret@example.com"',
        parts: null,
      }],
      fileTicket,
    }));
    const calls = fileTicket.mock.calls as unknown as TicketArgs[][];
    const args = calls[0][0];
    expect(args.priority).toBe(1);
    expect(args.context.severity).toBe('high');
    expect(args.description).not.toContain('secret@example.com');
    expect(args.title).toBe('Raw marker SEND_EMAIL (high) survived in chat abcd1234');
  });

  // d6fdc1df: per-chat WIDGET markers are no longer findings (no renderer),
  // and per-type marker fingerprints can't reach the 10 cap (only 3 marker
  // types exist) — the cap tests now run on incomplete-card findings, which
  // fingerprint per owner question.
  // 65cfec1b: the fixture card carries no background cue the platform's
  // payload-gap admission can find (that is what makes it flaggable now —
  // the admission, not the context length alone).
  const card = (n: number) => ({ id: `oq-${n}`, question: 'paste the steps below', context: ' '.repeat(10) });

  it('caps at 10 filed tickets', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const questions = Array.from({ length: 11 }, (_, i) => card(i));
    const status = await runFrameworkSignalSweepOnce(deps({
      loadQuestions: async () => questions,
      fileTicket,
    }));
    expect(fileTicket).toHaveBeenCalledTimes(10);
    expect(status).toBe('sweep: scanned 0/11/0, found 11, deduped 0, filed 10, capped 1');
  });

  it('does not count a skipped file toward the cap', async () => {
    let n = 0;
    const fileTicket = jest.fn(async () => {
      n++;
      return n === 1 ? { error: 'invalid' } : { deduped: false, ticket: { title: 'x' } };
    });
    const questions = Array.from({ length: 12 }, (_, i) => card(i));
    const status = await runFrameworkSignalSweepOnce(deps({
      loadQuestions: async () => questions,
      fileTicket,
    }));
    expect(fileTicket).toHaveBeenCalledTimes(11);
    expect(status).toBe('sweep: scanned 0/12/0, found 12, deduped 0, filed 10, capped 1');
  });

  // Ticket 84b11946: a consoleAction card carries its paste payload and
  // click-by-click steps IN the composed question body — the empty context
  // column is by design, so the sweep must not file a ticket for one
  // (specimen oq_2dfb9e9a: the owner got the full payload and self-served
  // the grant 25 min later; the false-positive ticket was 84b11946).
  it('does not file an incomplete-card ticket for a consoleAction card (84b11946)', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const status = await runFrameworkSignalSweepOnce(deps({
      loadQuestions: async () => [{
        id: 'oq_2dfb9e9a-ba88-479d-91b2-b39f5894f0fa',
        question: 'save this ONE line in Tailscale admin\n\n**Paste exactly this (Tailscale admin console):**\n\n```json\n{"action":"accept","src":["tag:digby-dev"],"dst":["tag:pi"]}\n```\n\n**Click by click:**\n1. Open the Access Controls page.\n2. Click Save.',
        context: null,
        consoleAction: {
          consoleName: 'Tailscale admin console',
          consoleUrl: 'https://login.tailscale.com/admin/acls',
          whatAndWhySafe: 'read-only sandbox reach',
          steps: ['Open the Access Controls page.', 'Click Save.'],
        },
      }],
      fileTicket,
    }));
    expect(fileTicket).not.toHaveBeenCalled();
    expect(status).toBe('sweep: scanned 0/1/0, found 0, deduped 0, filed 0, capped 0');
  });

  // Ticket 65cfec1b: a NON-consoleAction card whose payload rides in the
  // question body (background + typed options, fallback paste instructions)
  // must not file either — the sweep-level pin that the `options` column is
  // threaded from loadQuestions through collectFindings into the detector's
  // payload-gap check (the detector test pins the shape directly; THIS test
  // pins the wiring — if collectFindings ever stops passing options through,
  // it fails).
  it('does not file an incomplete-card ticket for a self-contained inline ask with typed options (65cfec1b)', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const status = await runFrameworkSignalSweepOnce(deps({
      loadQuestions: async () => [{
        id: 'oq_6c37a254-6928-4c13-9b9c-ad8d9f87ca3b',
        question: '[raspi] Pi fleet access is ONE restart away — pass #4 proved your grant WORKS; the Pi is in digby-dev\'s netmap, online, but its tailscaled is wedged and silently dropping every TCP port.\n\nOptions:\n1. restarted — I run the staged read-only battery immediately.\n2. skip — leave it for later.\n\nIf it STILL fails after the restart, run these two on the Pi and paste the output.',
        context: null,
        options: [
          { id: 'restarted', label: 'I restarted it' },
          { id: 'skip', label: 'Skip for now' },
        ],
      }],
      fileTicket,
    }));
    expect(fileTicket).not.toHaveBeenCalled();
    expect(status).toBe('sweep: scanned 0/1/0, found 0, deduped 0, filed 0, capped 0');
  });

  it('classifies file results', () => {
    expect(classifyFileResult({ error: 'x' }, 'T', norm)).toBe('skipped');
    expect(classifyFileResult({ queued: true }, 'T', norm)).toBe('filed');
    expect(classifyFileResult({ deduped: true, ticket: { title: 'T' } }, 'T', norm)).toBe('deduped');
    expect(classifyFileResult({ deduped: true, ticket: { title: 'Other' } }, 'T', norm)).toBe('skipped');
    expect(classifyFileResult({ deduped: false, ticket: { title: 'T' } }, 'T', norm)).toBe('filed');
  });

  it('merges a later high hit onto the better reason', () => {
    const a: SignalFinding = {
      fingerprint: 'raw-marker:SEND_EMAIL',
      title: 'Raw marker SEND_EMAIL survived in chat c',
      description: 'A SEND_EMAIL marker survived renderer cleaning (no valid to).',
      priority: 2,
      context: { reason: 'no valid to', fingerprint: 'raw-marker:SEND_EMAIL' },
    };
    const b: SignalFinding = {
      ...a,
      title: 'Raw marker SEND_EMAIL (high) survived in chat c',
      description: 'A SEND_EMAIL marker survived renderer cleaning (unclosed).',
      priority: 1,
      context: { reason: 'unclosed', severity: 'high', fingerprint: 'raw-marker:SEND_EMAIL' },
    };
    const [merged] = mergeSignalFindings([a, b]);
    expect(merged.priority).toBe(1);
    expect(merged.title).toContain('(high)');
    expect(merged.description).toContain('(no valid to)');
    expect(merged.context.reason).toBe('no valid to');
  });

  // ── d6fdc1df(d): dedup includes recently-done fingerprints, deterministically ordered ──

  it('d6fdc1df(d): loadOpenFingerprints queries done-in-last-7d rows alongside open ones, with a deterministic orderBy', async () => {
    mockPrismaCalls.length = 0;
    // A [/CANVAS] finding exists and a DONE ticket (closed 2 days ago) already
    // carries its fingerprint — the sweep must dedup, not re-file. The sweep
    // runs with NO deps: the REAL defaultDeps issues every load (prisma is
    // the module mock at the top of this file; the sweep imports it
    // dynamically, so the factory runs lazily here).
    mockFingerprintRows = [{ context: { fingerprint: 'raw-marker:CANVAS' } }];
    const status = await runFrameworkSignalSweepOnce();
    expect(status).toBe('sweep: scanned 1/0/0, found 1, deduped 1, filed 0, capped 0');
    // The query the real loadOpenFingerprints issued (ownerQuestion rows —
    // captured since 84b11946 — are excluded: both selects carry `context`):
    const ufrCall = mockPrismaCalls.find((c) => c?.select && 'context' in c.select && !c.ownerQuestion);
    expect(ufrCall).toBeTruthy();
    expect(ufrCall.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
    const or = ufrCall.where.OR;
    // 4 = the d6fdc1df pair + the verifier-owned statuses (r2 test below).
    expect(or).toHaveLength(4);
    expect(or[0]).toEqual({ status: { in: ['open', 'in_progress', 'queued', 'reopened'] } });
    // done rows are included with a 7-day updatedAt floor (a live Date).
    expect(or[1].status).toBe('done');
    expect(+new Date(or[1].updatedAt.gte)).toBeGreaterThan(Date.now() - 8 * 24 * 3600_000);
    expect(+new Date(or[1].updatedAt.gte)).toBeLessThan(Date.now());
    // r2 review: BOTH verifier-owned arms carry the same 7-day floor.
    expect(or.slice(2).map((c: any) => c.status)).toEqual(['awaiting_verification', 'deployed_verified']);
    for (const c of or.slice(2)) expect(+new Date(c.updatedAt.gte)).toBeGreaterThan(Date.now() - 8 * 24 * 3600_000);
    expect(ufrCall.where.context).toEqual({ path: ['origin'], equals: 'framework-sweep' });
  });

  // ── r2 interactions (ACCEPTANCE-METRIC-BASELINE × d6fdc1df): a raw-marker
  // ticket carries the default metric, so its lane's close lands in
  // awaiting_verification (verifier-owned) and then deployed_verified — a
  // status pair the d6fdc1df set ignored, so the next pass re-filed (and the
  // drain re-laned) a fingerprint whose fix was already merged. ──
  it('r2: a fingerprint whose ticket is awaiting_verification (or deployed_verified ≤ 7 d) dedups — no re-file', async () => {
    const prevRows = mockFingerprintRows;
    const fb = jest.requireMock('../feedback/feedback.service') as { fileFeedbackTicket: jest.Mock };
    try {
      mockRedisStore.clear();
      fb.fileFeedbackTicket.mockClear();
      for (const status of ['awaiting_verification', 'deployed_verified']) {
        mockFingerprintRows = [{ status, updatedAt: new Date(Date.now() - 2 * 24 * 3600_000), context: { fingerprint: 'raw-marker:CANVAS' } }];
        expect(await runFrameworkSignalSweepOnce()).toBe('sweep: scanned 1/0/0, found 1, deduped 1, filed 0, capped 0');
      }
      expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
      // deployed_verified rides the SAME 7-day window as done.
      mockFingerprintRows = [{ status: 'deployed_verified', updatedAt: new Date(Date.now() - 9 * 24 * 3600_000), context: { fingerprint: 'raw-marker:CANVAS' } }];
      expect(await runFrameworkSignalSweepOnce()).toBe('sweep: scanned 1/0/0, found 1, deduped 0, filed 1, capped 0');
    } finally {
      mockFingerprintRows = prevRows;
      mockRedisStore.clear();
    }
  });

  // r2 review: the verifier measures (and so reopens) only once the fix is
  // LIVE. A close whose fix never goes live — a replay-test-only 'fixed' close
  // (no commitSha), a squash-merged or bisect-dropped head — answers
  // 'waiting' forever with no firstLiveAt, so an UNBOUNDED awaiting arm muted
  // a still-firing marker for good. Past the done arm's 7 days it re-files.
  it('r2 review: an awaiting_verification row whose fix never went live stops deduping after 7 d — the marker re-files', async () => {
    const prevRows = mockFingerprintRows;
    try {
      mockRedisStore.clear();
      const stuck = new Date(Date.now() - 9 * 24 * 3600_000);
      mockFingerprintRows = [{
        status: 'awaiting_verification',
        updatedAt: stuck,
        context: { fingerprint: 'raw-marker:CANVAS', verification: { queuedAt: stuck.toISOString(), lastVerdict: 'waiting', lastVerdictAt: stuck.toISOString() } },
      }];
      expect(await runFrameworkSignalSweepOnce()).toBe('sweep: scanned 1/0/0, found 1, deduped 0, filed 1, capped 0');
    } finally {
      mockFingerprintRows = prevRows;
      mockRedisStore.clear();
    }
  });

  it('r2: AUTOFILER_DEFAULT_METRIC_DISABLED=1 restores the d6fdc1df dedupe set', async () => {
    const prevRows = mockFingerprintRows;
    process.env.AUTOFILER_DEFAULT_METRIC_DISABLED = '1';
    try {
      mockPrismaCalls.length = 0;
      mockRedisStore.clear();
      mockFingerprintRows = [{ status: 'awaiting_verification', updatedAt: new Date(), context: { fingerprint: 'raw-marker:CANVAS' } }];
      expect(await runFrameworkSignalSweepOnce()).toBe('sweep: scanned 1/0/0, found 1, deduped 0, filed 1, capped 0');
      const ufrCall = mockPrismaCalls.find((c) => c?.select && 'context' in c.select && !c.ownerQuestion);
      expect(ufrCall.where.OR).toHaveLength(2);
    } finally {
      delete process.env.AUTOFILER_DEFAULT_METRIC_DISABLED;
      mockFingerprintRows = prevRows;
      mockRedisStore.clear();
    }
  });

  // ── Ticket 84b11946 (review finding 6): the defaultDeps loadQuestions select
  // must keep selecting consoleAction — the skip in findIncompleteCards is
  // silently inert without it (every consoleAction card would file a
  // false-positive ticket again). Same mockPrismaCalls pin pattern as the
  // d6fdc1df(d) test above. ──

  it('84b11946: loadQuestions selects consoleAction so the incomplete-card skip is live', async () => {
    mockPrismaCalls.length = 0;
    await runFrameworkSignalSweepOnce();
    const oqCall = mockPrismaCalls.find((c) => c?.ownerQuestion);
    expect(oqCall).toBeTruthy();
    expect(oqCall.select).toMatchObject({
      id: true,
      question: true,
      context: true,
      consoleAction: true,
      options: true,
    });
  });

  // ── 2026-10-20 (Grok-bot review): daily filing budget + per-pass metric ──

  describe('daily budget + loop_metrics (2026-10-20)', () => {
    const prevCap = process.env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY;
    const prevKs = process.env.FRAMEWORK_SIGNAL_DAY_CAP_DISABLED;
    afterEach(() => {
      if (prevCap === undefined) delete process.env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY;
      else process.env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY = prevCap;
      if (prevKs === undefined) delete process.env.FRAMEWORK_SIGNAL_DAY_CAP_DISABLED;
      else process.env.FRAMEWORK_SIGNAL_DAY_CAP_DISABLED = prevKs;
      mockRedisStore.clear();
      mockRecordLoopMetric.mockClear();
    });

    /** An in-memory day budget with the real reserve/refund semantics. */
    function budget() {
      let used = 0;
      return {
        reserveDaySlot: jest.fn(async (cap: number) => {
          used++;
          if (used > cap) { used--; return 'capped' as const; }
          return 'reserved' as const;
        }),
        refundDaySlot: jest.fn(async () => { used--; }),
        used: () => used,
      };
    }

    it('stops NEW filings once the day budget is spent and says so', async () => {
      process.env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY = '3';
      const b = budget();
      const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
      const recordPass = jest.fn();
      const status = await runFrameworkSignalSweepOnce(deps({
        loadQuestions: async () => Array.from({ length: 6 }, (_, i) => card(i)),
        fileTicket, reserveDaySlot: b.reserveDaySlot, refundDaySlot: b.refundDaySlot, recordPass,
      }));
      expect(fileTicket).toHaveBeenCalledTimes(3);
      expect(b.used()).toBe(3);
      expect(status).toBe('sweep: scanned 0/6/0, found 6, deduped 0, filed 3, capped 0, day-capped 3 (3/day)');
      expect(recordPass).toHaveBeenCalledTimes(1);
      expect(recordPass.mock.calls[0][0]).toMatchObject({ found: 6, filed: 3, dayCapped: 3, dayCap: 3, capped: 0, deduped: 0 });
    });

    it('a dedup bump or a skipped filing refunds its slot', async () => {
      const b = budget();
      let n = 0;
      const fileTicket = jest.fn(async (args: TicketArgs) => {
        n++;
        if (n === 1) return { deduped: true, ticket: { title: args.title } };
        if (n === 2) return { error: 'invalid' };
        throw new Error('db down');
      });
      const status = await runFrameworkSignalSweepOnce(deps({
        loadQuestions: async () => Array.from({ length: 3 }, (_, i) => card(i)),
        fileTicket, reserveDaySlot: b.reserveDaySlot, refundDaySlot: b.refundDaySlot,
      }));
      expect(b.refundDaySlot).toHaveBeenCalledTimes(3);
      expect(b.used()).toBe(0);
      expect(status).toBe('sweep: scanned 0/3/0, found 3, deduped 1, filed 0, capped 0');
    });

    it('a Redis failure fails OPEN (files, no refund)', async () => {
      const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
      const refundDaySlot = jest.fn(async () => {});
      const status = await runFrameworkSignalSweepOnce(deps({
        loadQuestions: async () => [card(1)],
        fileTicket, reserveDaySlot: async () => { throw new Error('redis down'); }, refundDaySlot,
      }));
      expect(status).toBe('sweep: scanned 0/1/0, found 1, deduped 0, filed 1, capped 0');
      expect(refundDaySlot).not.toHaveBeenCalled();
    });

    it('FRAMEWORK_SIGNAL_DAY_CAP_DISABLED=1 keeps only the per-pass cap', async () => {
      process.env.FRAMEWORK_SIGNAL_DAY_CAP_DISABLED = '1';
      process.env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY = '1';
      const b = budget();
      const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
      const recordPass = jest.fn();
      const status = await runFrameworkSignalSweepOnce(deps({
        loadQuestions: async () => Array.from({ length: 4 }, (_, i) => card(i)),
        fileTicket, reserveDaySlot: b.reserveDaySlot, refundDaySlot: b.refundDaySlot, recordPass,
      }));
      expect(b.reserveDaySlot).not.toHaveBeenCalled();
      expect(fileTicket).toHaveBeenCalledTimes(4);
      expect(status).toBe('sweep: scanned 0/4/0, found 4, deduped 0, filed 4, capped 0');
      expect(recordPass.mock.calls[0][0].dayCap).toBeNull();
    });

    it('records one pass row even with no admin author or no findings', async () => {
      const recordPass = jest.fn();
      await runFrameworkSignalSweepOnce(deps({ loadAdminAuthor: async () => null, recordPass }));
      await runFrameworkSignalSweepOnce(deps({ recordPass }));
      expect(recordPass).toHaveBeenCalledTimes(2);
      expect(recordPass.mock.calls[0][0]).toMatchObject({ noAuthor: true, found: 0, filed: 0 });
      expect(recordPass.mock.calls[1][0]).toMatchObject({ noAuthor: false, found: 0, filed: 0 });
    });

    it('default deps: INCR-first on the day-named key, 26 h TTL, and a counts-only loop_metrics row', async () => {
      process.env.FRAMEWORK_SIGNAL_TICKETS_PER_DAY = '1';
      mockFingerprintRows = [];
      mockPrisma.ownerQuestion.findMany.mockImplementationOnce(async () => [card(1), card(2)] as any);
      const { fileFeedbackTicket } = jest.requireMock('../feedback/feedback.service');
      fileFeedbackTicket.mockClear();
      const status = await runFrameworkSignalSweepOnce();
      // [/CANVAS] marker + two cards = 3 findings; budget 1 ⇒ one filed, two day-capped.
      expect(fileFeedbackTicket).toHaveBeenCalledTimes(1);
      expect(status).toMatch(/filed 1, capped 0, day-capped 2 \(1\/day\)$/);
      const day = new Date().toISOString().slice(0, 10);
      expect(mockRedisStore.get(`framework-signal-sweep:filed:${day}`)).toBe(1);
      expect(mockRedis.expire).toHaveBeenCalledWith(`framework-signal-sweep:filed:${day}`, 26 * 3600);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // ACCEPTANCE-METRIC-BASELINE (2026-10-20): the pass also records one
      // framework_signal_finding row per finding — exactly ONE pass row still.
      const passRows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'framework_signal_sweep');
      expect(passRows).toHaveLength(1);
      const findingRows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'framework_signal_finding');
      expect(findingRows.map((r) => r.meta.class).sort()).toEqual(['incomplete-card', 'incomplete-card', 'raw-marker']);
      const row = passRows[0];
      expect(row.kind).toBe('framework_signal_sweep');
      expect(row.value).toBe(1);
      expect(row.meta).toEqual(expect.objectContaining({ found: 3, filed: 1, dayCapped: 2, dayCap: 1 }));
      expect(JSON.stringify(row.meta)).not.toMatch(/paste the steps/);
    });
  });
});

// ── ACCEPTANCE-METRIC-BASELINE + TICKET-FAMILY-ROUTING (2026-10-20) ─────────
describe('event times, per-finding rows and the raw-marker default metric', () => {
  const ENV0 = { ...process.env };
  afterEach(() => { process.env = { ...ENV0 }; });

  it('stamps each finding with its EVENT time and records one row per finding before filing', async () => {
    const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
    const recordFindings = jest.fn(async (_f: SignalFinding[]) => {});
    await runFrameworkSignalSweepOnce(deps({
      loadMessages: async () => [{ id: 'm1', chatId: 'abcd1234-rest', content: '[/CANVAS]', parts: null, createdAt: '2026-10-20T10:00:00.000Z' }],
      fileTicket,
      recordFindings,
    }));
    expect(recordFindings).toHaveBeenCalledTimes(1);
    expect(recordFindings.mock.invocationCallOrder[0]).toBeLessThan((fileTicket.mock as any).invocationCallOrder[0]);
    const args = (fileTicket.mock.calls as unknown as TicketArgs[][])[0][0];
    expect(args.context.observedAt).toBe('2026-10-20T10:00:00.000Z');
    // raw-marker carries the default metric: its finding rows stay at 0 for 24 h.
    expect(args.context.acceptanceMetric).toMatchObject({ probe: 'loop_metric_count', params: { kind: 'framework_signal_finding', metaKey: 'fingerprint', metaValue: 'raw-marker:CANVAS' }, operator: '<=', target: 0, windowHours: 24 });
    expect(args.context.acceptanceMetricSource).toBe('autofiler-default');
  });

  it('findingMetricRows: event-time rows with class + fingerprint, capped', () => {
    const f = (fp: string, observedAt?: string): SignalFinding => ({ fingerprint: fp, title: 't', description: 'd', priority: 2, context: observedAt ? { observedAt } : {} });
    const rows = findingMetricRows([f('raw-marker:HARNESS', '2026-10-20T10:00:00.000Z'), f('incomplete-card:oq_1')]);
    expect(rows[0]).toEqual({ kind: 'framework_signal_finding', at: new Date('2026-10-20T10:00:00.000Z'), meta: { class: 'raw-marker', fingerprint: 'raw-marker:HARNESS' } });
    expect(rows[1]).toEqual({ kind: 'framework_signal_finding', meta: { class: 'incomplete-card', fingerprint: 'incomplete-card:oq_1' } });
    expect(findingMetricRows(Array.from({ length: 150 }, (_, i) => f(`missed-bug:c:${i}`)))).toHaveLength(100);
  });

  it('detector-wide classes get no default metric; AUTOFILER_DEFAULT_METRIC_DISABLED=1 attaches none', () => {
    const card: SignalFinding = { fingerprint: 'incomplete-card:oq_1', title: 'Incomplete owner card oq_1', description: 'd', priority: 2, context: { fingerprint: 'incomplete-card:oq_1' } };
    expect(signalTicketArgs(card, 'admin-1').context.acceptanceMetric).toBeUndefined();
    const marker: SignalFinding = { fingerprint: 'raw-marker:BATCH', title: 'Raw marker BATCH survived in chat 1', description: 'd', priority: 2, context: { fingerprint: 'raw-marker:BATCH' } };
    expect(signalTicketArgs(marker, 'admin-1').context.acceptanceMetric).toBeDefined();
    expect(signalTicketArgs(marker, 'admin-1', { ...process.env, AUTOFILER_DEFAULT_METRIC_DISABLED: '1' }).context.acceptanceMetric).toBeUndefined();
  });

  it('a merged finding is as recent as its NEWEST event', () => {
    const a: SignalFinding = { fingerprint: 'raw-marker:X', title: 'Raw marker X survived in chat 1', description: 'A X marker survived renderer cleaning (no renderer).', priority: 2, context: { reason: 'no renderer', observedAt: '2026-10-20T08:00:00.000Z' } };
    const b: SignalFinding = { ...a, context: { reason: 'no renderer', observedAt: '2026-10-20T11:00:00.000Z' } };
    expect(mergeSignalFindings([a, b])[0].context.observedAt).toBe('2026-10-20T11:00:00.000Z');
    expect(mergeSignalFindings([b, a])[0].context.observedAt).toBe('2026-10-20T11:00:00.000Z');
  });
});

// ── LIVE-RUN WRITE GUARD (ticket 92d644c6) ─────────────────────────────────
// A coding-run assistant row is INSERTed at run start and rewritten in place
// with the RAW unscrubbed model stream; the renderer scrub only happens at
// finalize. The sweep must never convict that mid-flight working copy.
describe('live-run write guard — never convict a row a live run is still writing', () => {
  const ENV0 = { ...process.env };
  const H = 3600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  afterEach(() => {
    process.env = { ...ENV0 };
    mockLiveRuns = [];
    mockMessageRows = [{ id: 'm1', chatId: 'chat-1', content: '[/CANVAS]', parts: null }];
    mockPrismaCalls.length = 0;
  });

  it('liveRunWriteStarts: only a RUNNING run with an UNEXPIRED lease is live', () => {
    const now = new Date('2026-11-03T05:00:00.000Z');
    const rows = [
      { sessionId: 'live-1', status: 'running', leaseExpiresAt: new Date('2026-11-03T05:05:00.000Z'), createdAt: new Date('2026-11-03T04:50:00.000Z') },
      { sessionId: 'expired', status: 'running', leaseExpiresAt: new Date('2026-11-03T04:55:00.000Z'), createdAt: new Date('2026-11-03T04:40:00.000Z') },
      { sessionId: 'finished', status: 'completed', leaseExpiresAt: new Date('2026-11-03T05:05:00.000Z'), createdAt: new Date('2026-11-03T04:30:00.000Z') },
      { sessionId: 'no-lease', status: 'running', leaseExpiresAt: null, createdAt: new Date('2026-11-03T04:30:00.000Z') },
      { sessionId: null, status: 'running', leaseExpiresAt: new Date('2026-11-03T05:05:00.000Z'), createdAt: new Date('2026-11-03T04:30:00.000Z') },
      { sessionId: 'string-lease', status: 'running', leaseExpiresAt: '2026-11-03T05:05:00.000Z', createdAt: '2026-11-03T04:45:00.000Z' },
    ];
    // An EXPIRED lease is a dead run: its leftover raw partial must still be
    // convictable, so expiry excludes it (a guard only ever DEFERS a conviction).
    const starts = liveRunWriteStarts(rows, now);
    expect([...starts.keys()].sort()).toEqual(['live-1', 'string-lease']);
    expect(starts.get('live-1')!.toISOString()).toBe('2026-11-03T04:50:00.000Z');
    expect(starts.get('string-lease')!.toISOString()).toBe('2026-11-03T04:45:00.000Z');
  });

  it('writtenByLiveRun: the row being written is skipped, the chat\'s OLDER finished rows are not', () => {
    const starts = new Map([['chat-1', new Date('2026-11-03T04:50:00.000Z')]]);
    const now = new Date('2026-11-03T04:56:00.000Z');
    // The row INSERTed at run start (and the small clock skew around it).
    expect(writtenByLiveRun({ chatId: 'chat-1', createdAt: '2026-11-03T04:50:00.100Z' }, starts)).toBe(true);
    expect(writtenByLiveRun({ chatId: 'chat-1', createdAt: '2026-11-03T04:49:00.000Z' }, starts)).toBe(true); // inside skew
    // A RESUMED run writes the row its interrupted attempt created: createdAt
    // predates the start, but a FRESH partial flush (within the 90 s recency
    // window) makes updatedAt the evidence — still live.
    expect(writtenByLiveRun({ chatId: 'chat-1', createdAt: '2026-11-03T03:00:00.000Z', updatedAt: '2026-11-03T04:55:30.000Z' }, starts, now)).toBe(true);
    // REVIEW FINDING 2 (over-suppression): a PREVIOUS run's finalized row also
    // post-dates the new run's start — but it stopped moving, so the recency
    // bound must let it through. Without this the row would hide for the whole
    // of the unrelated run, and permanently if that run outlives the 2 h scan.
    expect(writtenByLiveRun({ chatId: 'chat-1', createdAt: '2026-11-03T04:40:00.000Z', updatedAt: '2026-11-03T04:52:00.000Z' }, starts, now)).toBe(false);
    // A row from an EARLIER, finished run in the same chat is real delivered
    // text — it must stay scannable (a chat-level exclusion would hide it).
    expect(writtenByLiveRun({ chatId: 'chat-1', createdAt: '2026-11-03T03:00:00.000Z', updatedAt: '2026-11-03T03:05:00.000Z' }, starts, now)).toBe(false);
    // A different chat is untouched.
    expect(writtenByLiveRun({ chatId: 'chat-2', createdAt: '2026-11-03T04:50:00.000Z', updatedAt: '2026-11-03T04:50:00.000Z' }, starts, now)).toBe(false);
    // Rows without any timestamp cannot be attributed — never skip them.
    expect(writtenByLiveRun({ chatId: 'chat-1' }, starts, now)).toBe(false);
    // dropLiveWrites is the batch face of the same predicate.
    expect(dropLiveWrites(
      [
        { id: 'live', chatId: 'chat-1', createdAt: '2026-11-03T04:50:01.000Z' },
        { id: 'final', chatId: 'chat-1', createdAt: '2026-11-03T04:40:00.000Z', updatedAt: '2026-11-03T04:52:00.000Z' },
        { id: 'other', chatId: 'chat-2', createdAt: '2026-11-03T04:55:00.000Z' },
      ],
      starts, now,
    ).map((r) => r.id)).toEqual(['final', 'other']);
  });

  it('the scan SELECT carries updatedAt — the resumed-run witness is dead without it', async () => {
    // Regression pin for the guard's own wiring: writtenByLiveRun's second
    // witness reads row.updatedAt, so a `select` that omits it silently
    // disables the resumed-run arm in production while every unit test above
    // still passes (they supply the field by hand).
    mockLiveRuns = [];
    mockPrismaCalls.length = 0;
    await runFrameworkSignalSweepOnce();
    const msgCall = mockPrismaCalls.find((c) => c.crossModelMessage && c.where?.role === 'assistant');
    expect(msgCall).toBeTruthy();
    expect(Object.keys(msgCall.select).sort()).toEqual(['chatId', 'content', 'createdAt', 'id', 'parts', 'updatedAt']);
    // …and the liveness read must select what liveRunWriteStarts consumes.
    const runCall = mockPrismaCalls.find((c) => c.agentRun);
    expect(Object.keys(runCall.select).sort()).toEqual(['createdAt', 'leaseExpiresAt', 'sessionId', 'status']);
  });

  it('excludes only the in-flight row of a live chat and still scans that chat\'s older rows', async () => {
    const startedAt = Date.now() - 5 * 60_000;
    mockLiveRuns = [{ sessionId: 'chat-1', status: 'running', leaseExpiresAt: iso(Date.now() + H), createdAt: iso(startedAt) }];
    mockMessageRows = [
      { id: 'in-flight', chatId: 'chat-1', content: '[SEND_EMAIL to="a@b.c"', parts: null, createdAt: iso(startedAt + 1000), updatedAt: iso(Date.now() - 1000) },
      { id: 'finished', chatId: 'chat-1', content: '[/CANVAS]', parts: null, createdAt: iso(startedAt - H), updatedAt: iso(startedAt - H + 60_000) },
    ];
    // NO deps override: the guard lives in defaultDeps, so this drives the real
    // liveness read + the real loadMessages path (prisma is the module mock).
    const fb = jest.requireMock('../feedback/feedback.service') as { fileFeedbackTicket: jest.Mock };
    fb.fileFeedbackTicket.mockClear();
    mockRedisStore.clear();
    const status = await runFrameworkSignalSweepOnce();
    // The unclosed SEND_EMAIL (in-flight) is NOT convicted; the older stray
    // [/CANVAS] still is.
    expect(status).toContain('scanned 1/0/0, found 1');
    const args = fb.fileFeedbackTicket.mock.calls[0][0] as TicketArgs;
    expect(args.context.fingerprint).toBe('raw-marker:CANVAS');
    expect(args.context.chatId).toBe('chat-1');
  });

  it('a RESUMED run\'s row (created before the start, rewritten now) is excluded too', async () => {
    const startedAt = Date.now() - 5 * 60_000;
    mockLiveRuns = [{ sessionId: 'chat-1', status: 'running', leaseExpiresAt: iso(Date.now() + H), createdAt: iso(startedAt) }];
    // The interrupted attempt created the row an hour ago; the resumed run is
    // streaming raw markup into it right now (updatedAt is fresh).
    mockMessageRows = [
      { id: 'resumed', chatId: 'chat-1', content: '[SEND_EMAIL to="a@b.c"', parts: null, createdAt: iso(startedAt - H), updatedAt: iso(Date.now() - 2000) },
    ];
    const fb = jest.requireMock('../feedback/feedback.service') as { fileFeedbackTicket: jest.Mock };
    fb.fileFeedbackTicket.mockClear();
    mockRedisStore.clear();
    const status = await runFrameworkSignalSweepOnce();
    expect(status).toContain('scanned 0/0/0, found 0');
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY (92d644c6): an EXPIRED lease still convicts the leftover raw partial', async () => {
    // Prior true positive: a crashed run leaves a raw partial behind and its
    // lease lapses — that row IS what a reader can still see, so it must fire.
    const startedAt = Date.now() - 60 * 60_000;
    mockLiveRuns = [{ sessionId: 'chat-1', status: 'running', leaseExpiresAt: iso(Date.now() - H), createdAt: iso(startedAt) }];
    mockMessageRows = [{ id: 'm1', chatId: 'chat-1', content: '[SEND_EMAIL to="a@b.c"', parts: null, createdAt: iso(startedAt + 1000) }];
    const fb = jest.requireMock('../feedback/feedback.service') as { fileFeedbackTicket: jest.Mock };
    fb.fileFeedbackTicket.mockClear();
    mockRedisStore.clear();
    await runFrameworkSignalSweepOnce();
    expect(fb.fileFeedbackTicket).toHaveBeenCalledTimes(1);
    const args = fb.fileFeedbackTicket.mock.calls[0][0] as TicketArgs;
    expect(args.context.fingerprint).toBe('raw-marker:SEND_EMAIL');
    expect(args.priority).toBe(1);
  });

  it('DETECTOR-RECALL REPLAY (92d644c6): every prior true positive still fires with no live run', async () => {
    // The guard must not swallow a SINGLE prior conviction when nothing is in
    // flight — the same marker set the detector replay pins, driven end-to-end.
    const cases: Array<[string, string, number]> = [
      ['[SEND_EMAIL to="a@b.c"', 'raw-marker:SEND_EMAIL', 1],
      // A closed draft with NO valid `to` is still high — the reader sees the
      // raw markup AND the mail would go nowhere (pre-existing semantics).
      ['[SEND_EMAIL subject="hi"]body[/SEND_EMAIL]', 'raw-marker:SEND_EMAIL', 1],
      ['[/CANVAS]', 'raw-marker:CANVAS', 2],
      ['[/SEND_EMAIL]', 'raw-marker:SEND_EMAIL', 2],
    ];
    for (const [content, fingerprint, priority] of cases) {
      const fileTicket = jest.fn(async () => ({ deduped: false, ticket: { title: 'x' } }));
      await runFrameworkSignalSweepOnce(deps({
        loadMessages: async () => [{ id: 'm1', chatId: 'abcd1234-rest', content, parts: null }],
        fileTicket,
      }));
      expect({ content, calls: fileTicket.mock.calls.length }).toEqual({ content, calls: 1 });
      const args = (fileTicket.mock.calls as unknown as TicketArgs[][])[0][0];
      expect({ content, fp: args.context.fingerprint, prio: args.priority }).toEqual({ content, fp: fingerprint, prio: priority });
    }
  });

  it('fails OPEN: a liveness read that throws scans exactly as before', async () => {
    // An hourly detection signal must never be silenced by a telemetry read.
    mockMessageRows = [{ id: 'm1', chatId: 'chat-1', content: '[/CANVAS]', parts: null, createdAt: iso(Date.now()) }];
    const spy = jest.spyOn(mockPrisma.agentRun, 'findMany').mockRejectedValueOnce(new Error('agent_runs unavailable'));
    const status = await runFrameworkSignalSweepOnce();
    // The scan still happened and still convicted the [/CANVAS] row.
    expect(status).toContain('scanned 1/0/0, found 1');
    spy.mockRestore();
  });
});
