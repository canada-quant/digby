/**
 * Log-signal sweep (ticket 8a66441e) — pure normalization/classification pinned
 * directly; the sweep's delivery/ticket legs run over mocked prisma/redis with
 * the REAL feedback.fileFeedbackTicket insert path (infra-watch suite posture:
 * the dedupe and per-fingerprint sessionId lessons are only visible when the
 * real service runs).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const redisStore = new Map<string, string>();
const redisTtl = new Map<string, number>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => { if (opts?.NX && redisStore.has(k)) return null; redisStore.set(k, v); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    // aad94ed4: the daily-cap counter's INCR-first reservation (decr refunds,
    // expire = the 26 h day-TTL — ttl recorded so the test pins it).
    incr: jest.fn(async (k: string) => { const n = (Number(redisStore.get(k)) || 0) + 1; redisStore.set(k, String(n)); return n; }),
    decr: jest.fn(async (k: string) => { const n = (Number(redisStore.get(k)) || 0) - 1; redisStore.set(k, String(n)); return n; }),
    expire: jest.fn(async (k: string, s: number) => { redisTtl.set(k, s); return 1; }),
  },
}));
// user_feature_requests + app_error_logs + crossmodel_chats + system_settings:
// the in-memory tables the sweep and the REAL feedback insert path drive.
const featureRequests: any[] = [];
let featureRequestSeq = 0;
const errorLogRows: any[] = [];
const ctxPathEquals = (row: any, cond: any): boolean => {
  const c = cond?.context;
  if (!c || !Array.isArray(c.path)) return true;
  return String(row.context?.[c.path[0]] ?? '') === String(c.equals);
};
const rowMatches = (row: any, where: any): boolean => {
  if (!where) return true;
  if (where.type && row.type !== where.type) return false;
  if (where.source && row.source !== where.source) return false;
  // 0ef6794e: the adjudication gate's closed-row read (title equality).
  if (typeof where.title === 'string' && row.title !== where.title) return false;
  if (typeof where.status === 'string' && row.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
  if (!ctxPathEquals(row, where)) return false;
  if (Array.isArray(where.OR) && !where.OR.some((o: any) => ctxPathEquals(row, o))) return false;
  return true;
};
/** app_error_logs findMany where-evaluator — faithful to the clauses
 *  fetchWindowRows sends (7b2990fa): level in, createdAt gte, and Prisma
 *  three-valued NOT-IN semantics (source: { notIn: [...] } EXCLUDES rows
 *  whose source is null/undefined — the sweep's exclusion must never widen
 *  to dropping NULL-source rows, which is most of the table) and the OR
 *  null-branch the service uses to keep them. */
const errorRowMatches = (row: any, where: any): boolean => {
  if (!where) return true;
  if (where.level?.in && !where.level.in.includes(row.level)) return false;
  if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
  if (Array.isArray(where.OR)) {
    // Prisma OR: at least one branch must hold. fetchWindowRows sends
    // [{ source: null }, { source: { notIn } }] — evaluated faithfully
    // (null-branch true only for a null/undefined source).
    const ok = where.OR.some((o: any) => {
      if (o && 'source' in o) {
        if (o.source === null) return row.source == null;
        if (o.source?.notIn) {
          if (row.source == null) return false; // Prisma: NOT IN excludes NULL
          return !o.source.notIn.includes(row.source);
        }
      }
      return true;
    });
    if (!ok) return false;
  }
  if (where.source?.notIn && !(Array.isArray(where.OR))) {
    if (row.source == null) return false; // Prisma: NOT IN excludes NULL (bare shape — the bug this must never regress to)
    if (where.source.notIn.includes(row.source)) return false;
  }
  return true;
};
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => [{ id: 'sup-1', userId: 'owner-1' }]) },
  loopMetric: { findMany: jest.fn(async () => []) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  systemSetting: { findUnique: jest.fn(async () => null) }, // supervisor switch: null = ON
  appErrorLog: {
    findMany: jest.fn(async ({ where }: any = {}) => errorLogRows.filter((r) => errorRowMatches(r, where))),
  },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where }: any = {}) => featureRequests.filter((r) => rowMatches(r, where))),
    // beb1788b: the cross-source pass's linkedExisting probe (finds a prior
    // agent row linked to the same user ticket). Newest-first semantics.
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const rows = featureRequests.filter((r) => rowMatches(r, where));
      return rows.length ? rows[rows.length - 1] : null;
    }),
    count: jest.fn(async ({ where }: any = {}) => featureRequests.filter((r) => rowMatches(r, where)).length),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `ufr-${++featureRequestSeq}`, status: 'open', createdAt: new Date(), ...data };
      featureRequests.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = featureRequests.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// feedback.service's boundary deps (same mocks as feedback.service.test.ts /
// the infra-watch suite): error-handler pulls config/env; the burn-down drain
// hook dynamically imports ticket-dispatch (config/redis).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); } },
}));
jest.mock('../feedback/ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'skipped' })),
  dispatchTicketToLane: jest.fn(async () => 'skipped'),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));
// aad94ed4: telemetry boundary mocked (attention-watchdog pattern) so the
// pass row's meta — capped:true / dayCap — is assertable without the real
// buffer/flush. infra-watch.service imports LOOP_METRIC_KINDS from the same
// module, so the mock re-exports a minimal registry with the kinds the sweep uses.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { LOG_SIGNAL_SWEEP: 'log_signal_sweep', INFRA_ALERT: 'infra_alert' },
}));

import {
  normalizeLogMessage,
  detectSuppressionPromise,
  parsePromisedWindowMs,
  summarizeLogFingerprints,
  classifyRecurringLogSignals,
  runLogSignalSweepOnce,
  logSignalTicketTitle,
  logSignalTicketSessionId,
  logSignalTicketDescription,
  LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED_ENV,
  LOG_SIGNAL_DESIGNED_ALARM_FILING_DISABLED_ENV,
  isoWeekKeyOf,
  fingerprintHash,
  LOG_SIGNAL_SWEEP_DISABLED_ENV,
  LOG_SIGNAL_SWEEP_TICKETS_DISABLED_ENV,
  LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV,
  LOG_SIGNAL_TICKETS_PER_DAY_ENV,
  LOG_SIGNAL_FILED_KEY,
  LOG_SIGNAL_FILED_TTL_SEC,
  LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT,
  redactSweepSignal,
  renderLogSignalAlert,
  isNonFaultLogRow,
  logSignalMetricContext,
  logSignalQuietTarget,
  type LogSignalRow,
} from './log-signal-sweep.service';
import { recordLoopMetric } from '../platform/loop-metrics.service';

const NOW = new Date('2026-10-16T18:00:00.000Z');
const H = 3_600_000;
const M = 60_000;

/** A row `minutesAgo` before NOW with the given message. */
const row = (minutesAgo: number, message: string, level = 'warn'): LogSignalRow => ({
  level,
  message,
  source: 'test',
  createdAt: new Date(NOW.getTime() - minutesAgo * M),
});

beforeEach(() => {
  redisStore.clear();
  redisTtl.clear();
  featureRequests.length = 0;
  featureRequestSeq = 0;
  errorLogRows.length = 0;
  mockPrisma.appErrorLog.findMany.mockClear();
  mockPrisma.userFeatureRequest.findMany.mockClear();
  mockPrisma.userFeatureRequest.create.mockClear();
  (recordLoopMetric as jest.Mock).mockClear();
  delete process.env[LOG_SIGNAL_SWEEP_DISABLED_ENV];
  delete process.env[LOG_SIGNAL_SWEEP_TICKETS_DISABLED_ENV];
  delete process.env[LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV];
  delete process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV];
  delete process.env[LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED_ENV];
});

// ── Normalization ─────────────────────────────────────────────────────────────

describe('normalizeLogMessage', () => {
  it('strips ids, uuids, hex, timestamps and numbers so one class lands on one fingerprint', () => {
    const a = normalizeLogMessage('session history sync: project chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddeeff — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials');
    const b = normalizeLogMessage('session history sync: project chat_99d1e2f0-aaaa-bbbb-cccc-0123456789ab — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 403 invalid token');
    expect(a).toBe(b);
    expect(a).toContain('push refused permanently');
    expect(a).toContain('quarantined for <n>h');
    expect(a).not.toContain('3f2a71c0');
  });

  it('normalizes bare counts, times and dates', () => {
    expect(normalizeLogMessage('12 runs still active after 25000ms — 2026-10-16T18:00:00Z'))
      .toBe('<n> runs still active after <n>ms — <date>');
    expect(normalizeLogMessage('03:14:15Z thing')).toContain('<time>');
  });

  it('lowercases, collapses whitespace, strips ANSI and caps length', () => {
    expect(normalizeLogMessage('  Multiple   Spaces  ')).toBe('multiple spaces');
    expect(normalizeLogMessage('\u001b[31mred\u001b[39m warn')).toBe('red warn');
    expect(normalizeLogMessage('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('an empty/undateable-safe shape never throws', () => {
    expect(normalizeLogMessage('')).toBe('');
    expect(typeof normalizeLogMessage(String(null))).toBe('string');
  });

  // ── Secret redaction (ticket 885614de) ────────────────────────────────────
  // Fake tokens assembled by CONCAT so the literals never appear whole in this
  // file (the secret-scan suite's own fixture convention).
  const FAKE_KEY = 'sk-' + 'proj-FAKEFAKEFAKEFAKEFAKE1234';
  const FAKE_ZAI = 'a'.repeat(32) + '.' + 'Zx9yAbCdEf012345'; // Z.ai id.secret shape
  const FAKE_XAI = 'xai-' + 'F'.repeat(40);
  const LABELLED = 'bearer api_key: ' + 'SUPERfakeVALUE1234567890ab';

  it('redacts provider tokens BEFORE the id/number passes could mangle them into partial secrets (885614de)', () => {
    // Pre-fix: sk-proj-…1234 → "sk-<n>" — a MANGLED partial secret riding the fingerprint.
    const fp = normalizeLogMessage(`provider call failed: ${FAKE_KEY} rejected (retry 3 of 5)`);
    expect(fp).not.toContain('sk-<n>');
    expect(fp).not.toContain(FAKE_KEY);
    // The fingerprint lowercases — the marker lands as [redacted: …].
    expect(fp).toMatch(/\[redacted: looked like a credential\]/);
    // The class prose survives — one class still lands on ONE fingerprint.
    expect(fp).toContain('provider call failed');
    expect(fp).toContain('rejected (retry <n> of <n>)');
  });

  it('every SECRET_PATTERNS provider shape redacts in the fingerprint (the write-time URL-only scrub gap)', () => {
    for (const tok of [FAKE_KEY, FAKE_ZAI, FAKE_XAI, LABELLED]) {
      const fp = normalizeLogMessage(`boom ${tok} boom`);
      expect(fp).not.toContain(tok);
      // The fingerprint lowercases — the marker lands as [redacted: …].
      expect(fp).toMatch(/\[redacted: looked like a credential\]/);
    }
  });

  it('the ticket DESCRIPTION redacts the raw exampleMessage excerpt (the 600-char raw slice)', () => {
    const raw = `gateway call failed after 3 retries: Authorization: Bearer ${FAKE_XAI} (upstream 401)`;
    const s = classifyRecurringLogSignals([{
      fingerprint: normalizeLogMessage(raw), count: 4, hours: 4, episodes: 2,
      firstAt: NOW.getTime() - 24 * H, lastAt: NOW.getTime(), minGapMs: 30 * M, levels: ['warn'],
      sources: ['llm.ts'], exampleMessage: raw,
    }])[0];
    const d = logSignalTicketDescription(s, NOW);
    expect(d).not.toContain(FAKE_XAI);
    expect(d).toContain('[REDACTED: looked like a credential]');
    // The evidence a fix lane needs survives.
    expect(d).toContain('gateway call failed');
    expect(d).toContain('Authorization: Bearer');
  });

  it('the WAKE prompt and its loop-metric top[] never carry a secret-shaped fingerprint', () => {
    const raw = `model call failed: key ${FAKE_ZAI} invalid (quarantined for 6h)`;
    const s = classifyRecurringLogSignals([{
      fingerprint: normalizeLogMessage(raw), count: 4, hours: 4, episodes: 2,
      firstAt: NOW.getTime() - 24 * H, lastAt: NOW.getTime(), minGapMs: 30 * M, levels: ['warn'],
      sources: ['llm.ts'], exampleMessage: raw,
    }])[0];
    const wake = renderLogSignalAlert([s], [], NOW);
    expect(wake).not.toContain(FAKE_ZAI);
    // Even a HAND-BUILT signal (a fingerprint that skipped normalizeLogMessage)
    // is redacted at the render seam — the choke is at egress, not just ingress.
    const handBuilt = { ...s, fingerprint: `secret ${FAKE_KEY} leaked` };
    expect(renderLogSignalAlert([handBuilt], [], NOW)).not.toContain(FAKE_KEY);
  });

  it('redactSweepSignal is idempotent (an already-redacted fingerprint never re-matches) and fails open', () => {
    const once = redactSweepSignal(`x ${FAKE_KEY} y`);
    expect(redactSweepSignal(once)).toBe(once);
    expect(redactSweepSignal('')).toBe('');
  });

  // ── Round 2 (885614de cross-family review finding 1): the base64url/JWT class
  // the PREFIX-based shared set cannot see — the ticket's one NAMED shape. ────
  const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dozjgNrYmC5VHcG6e5e5bM';
  const FAKE_B64 = 'dGhpcy1pcy1hLXNlY3JldC10b2tlbi0xMjM0NTY3ODkwYWJjZGVm';

  it('a JWT-shaped token is redacted in the fingerprint (the ticket\'s named base64url example)', () => {
    const fp = normalizeLogMessage(`auth failed: jwt ${FAKE_JWT} boom`);
    expect(fp).not.toContain(FAKE_JWT);
    expect(fp).not.toMatch(/eyjhbgci/); // no partial header survives either
    expect(fp).toMatch(/\[redacted: looked like a credential\]/);
    expect(fp).toContain('auth failed');
  });

  it('a Bearer-context base64url token is redacted in the fingerprint (the CUE tier, 24-39 chars, cue BEFORE)', () => {
    // 32-char mixed-case+digit token — deliberately UNDER 40 so this pin dies
    // if the cue tier is deleted (review F4: the earlier 52-char fixture only
    // exercised the bare ≥40 tier).
    const cued = 'dGhpcy1pcy1hLXNlY3JldC10b2tlbi0xMjM0';
    const fp = normalizeLogMessage(`Authorization: Bearer ${cued} rejected`);
    expect(cued.length).toBeLessThan(40);
    expect(fp).not.toContain(cued);
    expect(fp).toContain('authorization: bearer [redacted: looked like a credential] rejected');
  });

  it('a CUE-AFTER shape (24-39 chars, label after the value) is redacted too (review F3)', () => {
    const cued = 'Xy9AbCdEfGh1234567890aBcD';
    const fp = normalizeLogMessage(`${cued} is not a valid token`);
    expect(cued.length).toBeLessThan(40);
    expect(fp).not.toContain(cued.toLowerCase());
    expect(fp).toMatch(/\[redacted: looked like a credential\] is not a valid token/);
  });

  it('a STANDARD-base64 body (+ and / in the charset) is redacted whole — no head/tail fragments (review F1)', () => {
    const classic = 'AbCd+EfGh/IjKlMnOpQrStUvWxYz0123456789AbCdEfGh+IjKl';
    const r = redactSweepSignal(`Authorization: Bearer ${classic} rejected`);
    expect(r).not.toContain('AbCd+EfGh');
    expect(r).not.toContain('IjKlMnOp');
    expect(r).toContain('[REDACTED: looked like a credential]');
    expect(r).toContain('rejected');
  });

  it('a pure-HEX signing key (single case class, no digit-mixed entropy) is redacted (review F2)', () => {
    const hexKey = 'a'.repeat(8) + '3f9b7c2e5d81a04f6c3b29d7e58a1c0d'; // 40 hex chars, single class
    const r = redactSweepSignal(`upstream signing key ${hexKey} rejected`);
    expect(r).not.toContain(hexKey);
    expect(r).toContain('[REDACTED: looked like a credential]');
  });

  it('a LONG bare base64url token (no cue at all) is redacted — the labelled-assignment gap', () => {
    const longB64 = 'c3VwZXItc2VjcmV0LWxvbmd0b2tlbmpxbHVuaHdibHZhc2RmenFkYXFlMTIzNDU2Nzg5MGFiY2RlZg';
    const fp = normalizeLogMessage(`upstream 401: ${longB64}`);
    expect(fp).not.toContain(longB64);
    expect(fp).toMatch(/\[redacted: looked like a credential\]/);
    expect(fp).toContain('upstream <n>');
  });

  it('prose and identifiers a fix lane NEEDS still survive (false-positive guard)', () => {
    for (const msg of [
      'session history sync: project chat_a1 push refused permanently 401 Bad credentials',
      'deploy box-a healthy: 4/4 boxes, disks 32/13/54%',
      'run 3ef41b1c heartbeat lease renewed latency 4123ms',
      'log-signal-sweep normalizeLogMessage unchanged, rule 2 suppression promise',
    ]) {
      const fp = normalizeLogMessage(msg);
      expect(fp).not.toContain('[redacted');
      expect(fp.length).toBeGreaterThan(10);
    }
  });

  it('the raw DESCRIPTION excerpt also redacts the JWT/b64 class (the 600-char raw slice)', () => {
    const raw = `gateway auth failed: Bearer ${FAKE_B64} (upstream 401)`;
    const s = classifyRecurringLogSignals([{
      fingerprint: normalizeLogMessage(raw), count: 4, hours: 4, episodes: 2,
      firstAt: NOW.getTime() - 24 * H, lastAt: NOW.getTime(), minGapMs: 30 * M, levels: ['warn'],
      sources: ['llm.ts'], exampleMessage: raw,
    }])[0];
    const d = logSignalTicketDescription(s, NOW);
    expect(d).not.toContain(FAKE_B64);
    expect(d).toContain('[REDACTED: looked like a credential]');
    expect(d).toContain('gateway auth failed');
  });

  it('the round-2 structural layer rides the SAME kill switch (LOG_SIGNAL_SECRET_REDACT_DISABLED=1 restores verbatim)', () => {
    try {
      process.env[LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV] = '1';
      const fp = normalizeLogMessage(`auth failed: jwt ${FAKE_JWT} boom`);
      expect(fp).toContain('eyjhbgcioijiuzi<n>niisin'); // verbatim modulo id/number/lowercase passes — pre-round-2 behaviour
    } finally {
      delete process.env[LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV];
    }
  });

  it('LOG_SIGNAL_SECRET_REDACT_DISABLED=1 restores the verbatim fingerprint (fail-safe kill switch)', () => {
    try {
      process.env[LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV] = '1';
      const fp = normalizeLogMessage(`boom ${FAKE_KEY} boom`);
      // Verbatim modulo the id/number/lowercase passes — exactly the pre-fix behaviour.
      expect(fp).toContain(FAKE_KEY.replace(/\d+/g, '<n>').toLowerCase());
      expect(fp).not.toContain('redacted');
    } finally {
      delete process.env[LOG_SIGNAL_SECRET_REDACT_DISABLED_ENV];
    }
  });
});

// ── Suppression promises + windows ────────────────────────────────────────────

describe('detectSuppressionPromise + parsePromisedWindowMs', () => {
  it('detects the ticket\'s promise vocabulary', () => {
    for (const msg of [
      'push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after)',
      'backing off for 90 seconds',
      'back-off 30s',
      'suppressed duplicate alert',
      'once per hour',
      'cooldown 5m active',
    ]) {
      expect(detectSuppressionPromise(msg)).not.toBeNull();
    }
    expect(detectSuppressionPromise('a completely unrelated warn')).toBeNull();
  });

  it('parses the LARGEST stated duration as the promised window', () => {
    expect(parsePromisedWindowMs('quarantined for 6h')).toBe(6 * H);
    expect(parsePromisedWindowMs('backing off for 90 seconds')).toBe(90_000);
    expect(parsePromisedWindowMs('retry in 30s, full cooldown 10 minutes')).toBe(10 * M);
    expect(parsePromisedWindowMs('no duration here')).toBeNull();
  });

  // ── TICKET 6384c6a7 (2026-11-03): ADJACENCY + SCOPE-QUALIFIED PROMISES ─────
  // The defect: the parser took the LARGEST duration ANYWHERE in the message, so
  // the embed line below — whose only duration is the embed CLIENT's timeout
  // budget — was filed as a "once per 0 min" promise, and the sweep accused a
  // dedupe that is honoured by construction. Two narrow rules fix it:
  //   (1) a duration counts only inside the PROMISE TOKEN's own clause
  //       (±PROMISE_ADJACENCY_CHARS, cut at ; ( ) [ ] — – newline);
  //   (2) `per process|worker|instance|boot|container|pod` is a SCOPE promise,
  //       not a time promise, so it is not a rule-2 promise at all.
  describe('ticket 6384c6a7 — a duration must be ADJACENT to the promise, and a process scope is not a time window', () => {
    /** The production app_error_logs row, verbatim from ticket 6384c6a7. */
    const PROD_6384c6a7 = 'unified-memory: embed failed, 10/10 row(s) stored keyword-only — timeout (embed attempt timeout after 8000ms (batch 1/1, 2 attempt(s))); rows=10 maxChars=3500 source=orchestrator scope=session; per-row retry not attempted (logged once per cause per process; counted as unified_memory_embed_failed)';

    it('the production row no longer yields a 8000ms "promised window"', () => {
      expect(parsePromisedWindowMs(PROD_6384c6a7)).toBeNull();
    });

    it('the production row\'s promise is scope-qualified — not a rule-2 promise at all', () => {
      expect(detectSuppressionPromise(PROD_6384c6a7)).toBeNull();
      // …and rule 2 therefore cannot fire on it however tightly it repeats.
      const s = classifyRecurringLogSignals([{
        fingerprint: normalizeLogMessage(PROD_6384c6a7), count: 34, hours: 2, episodes: 2,
        firstAt: 0, lastAt: 1, minGapMs: 0, levels: ['warn'], sources: [], exampleMessage: PROD_6384c6a7,
      }]);
      expect(s.filter((x) => x.rule === 'rule2-suppression')).toHaveLength(0);
    });

    it('a SCOPE-qualified promise is nulled only when it states NO window', () => {
      for (const scope of ['process', 'worker', 'instance', 'boot', 'container', 'pod']) {
        // No stated duration ⇒ not a time promise ⇒ rule 2 must not apply.
        expect(detectSuppressionPromise(`suppressed once per ${scope} while it cools`)).toBeNull();
        expect(parsePromisedWindowMs(`suppressed once per ${scope} while it cools`)).toBeNull();
        // …but a STATED window makes it a time promise again (adversarial review
        // 2026-11-03, BLOCKER): a scope word must never rescue a promise that
        // named its own 6 h window from being policed.
        expect(parsePromisedWindowMs(`suppressed once per ${scope} for 6h`)).toBe(6 * H);
      }
    });

    it('REGRESSION (reviewer BLOCKER): an unrelated `per process` retry clause must not null a stated 6h window', () => {
      // The repo's own session-history quarantine shape with a scope word glued
      // onto the retry clause. Pre-fix this returned null, silently switching
      // rule 2 OFF for the sharpest signal class the sweep has.
      const msg = 'quarantined for 6h, one fresh attempt per process after';
      expect(detectSuppressionPromise(msg)).toBe('quarantined');
      expect(parsePromisedWindowMs(msg)).toBe(6 * H);
      const s = classifyRecurringLogSignals([{
        fingerprint: normalizeLogMessage(msg), count: 6, hours: 2, episodes: 2,
        firstAt: 0, lastAt: 1, minGapMs: 40 * M, levels: ['warn'], sources: [], exampleMessage: msg,
      }]);
      expect(s.map((x) => x.rule)).toEqual(['rule2-suppression']);

      // Same shape for a cooldown window and for a separate sentence.
      expect(parsePromisedWindowMs('cooldown 30 minutes before the next attempt per worker')).toBe(30 * M);
      expect(parsePromisedWindowMs('quarantined for 6h. Restarted once per boot.')).toBe(6 * H);
    });

    it('a parenthetical timeout budget is NOT harvested (openers terminate the clause)', () => {
      // The binding constraint: a parenthetical routinely carries an UNRELATED
      // budget, so `(`/`[`/dashes must end the promise's clause.
      expect(parsePromisedWindowMs('backing off for 2s (request timeout 600000ms)')).toBe(2_000);
      // Consequence, accepted deliberately: a window stated INSIDE the parens is
      // not parsed. That is the CONSERVATIVE direction — the promise still
      // convicts via the 3-repeat unparsed branch, one repeat later.
      expect(parsePromisedWindowMs('suppressed (for 30s)')).toBeNull();
      expect(detectSuppressionPromise('suppressed (for 30s)')).toBe('suppressed');
      // A window in the promise's OWN clause, before the parenthetical, survives.
      expect(parsePromisedWindowMs('quarantined for 6h (one fresh attempt)')).toBe(6 * H);
    });

    it('a slice landing inside a duration token cannot magnify the window (1000x guard)', () => {
      // `300ms` cut at the 80-char adjacency leaves `300m`, which would read as
      // 300 MINUTES and convict a gap nothing promised.
      expect(parsePromisedWindowMs('suppressed' + ' '.repeat(76) + '300ms')).toBeNull();
    });

    it('a SUBJECT scope is NOT nulled — per session/chat/subject/browser/key stay rule-2 promises (3-repeat branch)', () => {
      for (const scope of ['session', 'chat', 'subject', 'browser', 'key']) {
        expect(detectSuppressionPromise(`once per ${scope} alert`)).not.toBeNull();
        // No adjacent duration ⇒ the unparsed branch (3 repeats), unchanged.
        expect(parsePromisedWindowMs(`once per ${scope} alert`)).toBeNull();
        expect(logSignalQuietTarget({ exampleMessage: `once per ${scope} alert` })).toBe(2);
      }
    });

    it('a duration in the promise\'s own clause still parses ("cooldown 5m active")', () => {
      expect(detectSuppressionPromise('cooldown 5m active')).toBe('cooldown');
      expect(parsePromisedWindowMs('cooldown 5m active')).toBe(5 * M);
    });

    it('an ADJACENT promise duration wins over a long non-adjacent timeout budget', () => {
      // Regression for the pre-fix "largest anywhere" rule: 30000ms sits after a
      // `;`, in the next clause, and must never be read as the 6h quarantine.
      expect(parsePromisedWindowMs('quarantined for 6h; embed timeout after 30000ms exceeded')).toBe(6 * H);
      // …same for a parenthetical timeout budget next to a 2s backoff.
      expect(parsePromisedWindowMs('backing off for 2s (request timeout 600000ms)')).toBe(2_000);
    });

    it('the promise token\'s clause is bounded, so a far-away duration is ignored', () => {
      // 80 chars of filler puts 6h outside the adjacency window on both sides.
      const far = `quarantined${' x'.repeat(60)} then a 6h window was mentioned`;
      expect(parsePromisedWindowMs(far)).toBeNull();
    });
  });
});

// ── Summarize + classify ──────────────────────────────────────────────────────

describe('summarizeLogFingerprints', () => {
  it('groups by fingerprint and computes hours, episodes and minGap', () => {
    // 5 boot episodes (clusters separated by >5 min of silence), 3 rows each
    // 2 min apart — the ticket's motivating quarantine shape. UUIDs make every
    // row ONE fingerprint.
    const rows: LogSignalRow[] = [];
    for (let e = 0; e < 5; e++) {
      for (let i = 0; i < 3; i++) {
        // Episode e spans minutes-ago [e*60+20 .. e*60+16]; next episode starts
        // at e*60+10 — a >5-min silence gap between clusters.
        rows.push(row(e * 60 + 20 - i * 2, `session history sync: project chat_3f2a71c0-e${e}${i}b2c-4d3e-9f00-aabbccddeeff — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 bad credentials`));
      }
    }
    const fps = summarizeLogFingerprints(rows);
    expect(fps).toHaveLength(1);
    const fp = fps[0];
    expect(fp.count).toBe(15);
    expect(fp.episodes).toBe(5);
    expect(fp.minGapMs).toBe(2 * M);
  });

  it('accepts rows in any order and skips undateable ones', () => {
    const rows = [
      row(1, 'boom'),
      { level: 'warn', message: 'boom', source: 'x', createdAt: 'garbage' },
      row(61, 'boom'),
    ];
    const fps = summarizeLogFingerprints(rows as LogSignalRow[]);
    expect(fps[0].count).toBe(2);
  });
});

// ── Rule 2 is a PER-SUBJECT promise (the d7a1ad46 / 2e9ea13e false positive) ──
//
// The reported defect was "the message promises a 5-minute backoff yet 11
// occurrences landed as close as 1 min apart". The premise is false for this
// class: `suggested-questions: … for userId=<uuid> — backing off 5 min` makes
// its promise PER USER, the fingerprint elides the userId to `<uuid>`, so the
// group interleaves many users and `minGapMs` measured a gap BETWEEN users.
// Production rows for that fingerprint (24 h to 2026-11-07T00:36Z) contain
// exactly one sub-5-minute pair — 2026-11-06T15:55:15Z (userId 158ffa30) and
// 15:55:55Z (userId 22097a46), 40.6 s apart, DIFFERENT users — while every
// same-user pair is >= 306 s (5 min 06 s). Rule 2 must compare gaps WITHIN a
// subject, or it convicts an honored promise.
describe('rule 2 measures the promised window PER SUBJECT', () => {
  const SQ = (userId: string, n = 0) =>
    `suggested-questions: ${n} usable results for userId=${userId} (min 3) — backing off 5 min before retry`;

  it('two DIFFERENT users retrying 40 s apart is NOT a broken 5-min promise (the live false positive)', () => {
    // The exact production pair: 15:55:15Z user A, 15:55:55Z user B.
    const rows: LogSignalRow[] = [
      { level: 'warn', message: SQ('158ffa30-c056-4d97-94c8-e21c75dd50b7'), source: 's', createdAt: new Date('2026-11-06T15:55:15.277Z') },
      { level: 'warn', message: SQ('22097a46-2372-453c-b1d4-5b46bbc3f4f4'), source: 's', createdAt: new Date('2026-11-06T15:55:55.850Z') },
    ];
    const [fp] = summarizeLogFingerprints(rows);
    expect(fp.count).toBe(2);
    // The aggregate gap really is 40 s — but no SUBJECT repeated at all, so the
    // per-subject gap is null and rule 2's parsed branch cannot fire.
    expect(fp.minGapMs).toBeLessThan(60_000);
    expect(fp.minSubjectGapMs).toBeNull();
    const fired = classifyRecurringLogSignals([{ ...fp, hours: 1, episodes: 1 }]);
    expect(fired.filter((s) => s.rule === 'rule2-suppression')).toHaveLength(0);
  });

  it('the SAME user retrying inside its 5-min backoff DOES still fire rule 2', () => {
    const rows: LogSignalRow[] = [
      { level: 'warn', message: SQ('d1185fde-ab83-4fac-8bdd-f00362b03ec2'), source: 's', createdAt: new Date('2026-11-06T18:38:31.617Z') },
      { level: 'warn', message: SQ('d1185fde-ab83-4fac-8bdd-f00362b03ec2'), source: 's', createdAt: new Date('2026-11-06T18:39:31.617Z') }, // 60 s later
    ];
    const [fp] = summarizeLogFingerprints(rows);
    expect(fp.minSubjectGapMs).toBe(60_000);
    const fired = classifyRecurringLogSignals([{ ...fp, hours: 1, episodes: 1 }]);
    expect(fired.map((s) => s.rule)).toEqual(['rule2-suppression']);
    expect(fired[0].promisedWindowMs).toBe(5 * M);
  });

  it('a group of DIFFERENT users is quiet on rule 2 even when the aggregate gap is tiny', () => {
    // 6 distinct users, 10 s apart — 50 s of wall clock, one fingerprint.
    const us = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => `${c}1111111-2222-4333-8444-55556666777${c}`);
    const rows: LogSignalRow[] = us.map((u, i) => ({
      level: 'warn', message: SQ(u), source: 's',
      createdAt: new Date(Date.parse('2026-11-06T10:00:00.000Z') + i * 10_000),
    }));
    const [fp] = summarizeLogFingerprints(rows);
    expect(fp.count).toBe(6);
    expect(fp.minGapMs).toBe(10_000);
    const fired = classifyRecurringLogSignals([{ ...fp, hours: 1, episodes: 1 }]);
    expect(fired.filter((s) => s.rule === 'rule2-suppression')).toHaveLength(0);
  });

  it('the ticket description quotes the SUBJECT gap, never the cross-user one', () => {
    const rows: LogSignalRow[] = [
      { level: 'warn', message: SQ('158ffa30-c056-4d97-94c8-e21c75dd50b7'), source: 's', createdAt: new Date('2026-11-06T15:55:15.277Z') },
      { level: 'warn', message: SQ('158ffa30-c056-4d97-94c8-e21c75dd50b7'), source: 's', createdAt: new Date('2026-11-06T16:03:15.277Z') }, // same user, 8 min
      { level: 'warn', message: SQ('22097a46-2372-453c-b1d4-5b46bbc3f4f4'), source: 's', createdAt: new Date('2026-11-06T16:03:55.277Z') },
    ];
    const [fp] = summarizeLogFingerprints(rows);
    expect(fp.minSubjectGapMs).toBe(8 * M);
    // 40 s cross-user gap must not be rendered as the promise evidence…
    expect(fp.minGapMs).toBe(40_000);
    const s = classifyRecurringLogSignals([{ ...fp, hours: 3 }])[0];
    expect(s.rule).toBe('rule1-hours'); // hours 3, no subject violated 5 min
    expect(renderLogSignalAlert([s], [], NOW)).not.toMatch(/as close as 0 min apart/);
  });
});

// ── DETECTOR-RECALL REPLAY (log-signal sweep rule 2) ─────────────────────────
// The subject scoping above NARROWS rule 2. These replay the detector's prior
// TRUE POSITIVES and assert they still convict, so the narrowing cannot quietly
// switch the rule off for the classes it was built for.
describe('DETECTOR-RECALL REPLAY — rule 2 prior true positives still fire', () => {
  it('DETECTOR-RECALL REPLAY: one project quarantined 6h, repeating every 40 min, still fires', () => {
    const P = 'chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee01';
    const msg = `session history sync: project ${P} — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials`;
    const rows: LogSignalRow[] = [0, 40, 80, 120].map((m) => row(m, msg));
    const [fp] = summarizeLogFingerprints(rows);
    expect(fp.minSubjectGapMs).toBe(40 * M);
    const fired = classifyRecurringLogSignals([fp]);
    expect(fired.map((s) => s.rule)).toEqual(['rule2-suppression']);
    expect(fired[0].promise).toBe('quarantined');
    expect(fired[0].promisedWindowMs).toBe(6 * H);
    expect(logSignalTicketDescription(fired[0], NOW)).toContain('as close as 40 min apart');
  });

  it('DETECTOR-RECALL REPLAY: the unparsed-window 3-repeat branch is unchanged', () => {
    const three = classifyRecurringLogSignals([{
      fingerprint: 'x', count: 3, hours: 1, episodes: 1, firstAt: 0, lastAt: 0,
      minGapMs: M, levels: ['warn'], sources: [], exampleMessage: 'suppressed: will not repeat',
    }]);
    expect(three.map((x) => x.rule)).toEqual(['rule2-suppression']);
  });

  it('DETECTOR-RECALL REPLAY: a hand-built signal with no subject field still reads minGapMs (legacy contract)', () => {
    const legacy = classifyRecurringLogSignals([{
      fingerprint: 'x', count: 2, hours: 1, episodes: 1, firstAt: 0, lastAt: 0,
      minGapMs: 30_000, levels: ['warn'], sources: [], exampleMessage: 'quarantined for 6h',
    }]);
    expect(legacy.map((x) => x.rule)).toEqual(['rule2-suppression']);
  });

  // The e2e sweep fixture quarantines FIFTEEN DIFFERENT projects. Before the
  // subject scoping that shape convicted rule 2 (aggregate gap 10 min < the 6 h
  // promise); afterwards it must NOT — fifteen distinct projects each burning
  // their own 6 h quarantine broke no promise. Detection is NOT weakened: the
  // signal still surfaces, now via rule 1, which is the honest reading.
  it('DETECTOR-RECALL REPLAY: many DISTINCT subjects still SURFACE (rule 1), never silently dropped', () => {
    const P = (n: number) => `chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee${n.toString(16).padStart(2, '0')}`;
    const msg = (p: string) => `session history sync: project ${p} — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401`;
    const rows: LogSignalRow[] = [240, 230, 220, 180, 170, 160, 120, 110, 100, 60, 50, 40, 20, 10, 1]
      .map((m, i) => row(m, msg(P(i + 1))));
    const [fp] = summarizeLogFingerprints(rows);
    expect(fp.count).toBe(15);
    expect(fp.minSubjectGapMs).toBeNull();      // no project repeated
    const fired = classifyRecurringLogSignals([fp]);
    expect(fired).toHaveLength(1);              // STILL a signal
    // Via recurrence (either rule-1 leg), never a false promise claim.
    expect(fired[0].rule === 'rule1-hours' || fired[0].rule === 'rule1-boots').toBe(true);
  });

  // The KNOWN RESIDUAL named in the module doc — pinned so it stays VISIBLE and
  // deliberate instead of being rediscovered as a bug. All-distinct subjects,
  // whole burst inside ≤2 distinct hours with <5 min spacing: rule 2 is
  // correctly quiet (nobody broke their own promise) and rule 1 has neither 3
  // hours nor 3 silence-separated clusters. A future emit site that makes a
  // GLOBAL promise while naming a subject noun must revisit this, not inherit
  // silence.
  it('DETECTOR-RECALL REPLAY: the documented residual — all-distinct subjects inside ≤2 h is quiet (by design), ≥3 h still surfaces', () => {
    const P = (n: number) => `chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee${n.toString(16).padStart(2, '0')}`;
    const msg = (p: string) => `session history sync: project ${p} — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401`;
    // 8 distinct projects inside ONE hour → documented residual: no signal.
    const burst: LogSignalRow[] = [0, 4, 8, 12, 16, 20, 24, 28].map((m, i) => row(m, msg(P(i + 1))));
    const [burstFp] = summarizeLogFingerprints(burst);
    expect(burstFp.minSubjectGapMs).toBeNull();
    expect(burstFp.hours).toBeLessThan(3);       // below rule 1's hour floor
    expect(classifyRecurringLogSignals([burstFp])).toEqual([]);
    // The SAME shape spread over ≥3 hours is NOT silent — rule 1 catches it.
    const spread: LogSignalRow[] = [300, 240, 180, 120, 60, 1].map((m, i) => row(m, msg(P(i + 1))));
    const [spreadFp] = summarizeLogFingerprints(spread);
    const fired = classifyRecurringLogSignals([spreadFp]);
    expect(fired).toHaveLength(1);
    expect(fired[0].rule).toBe('rule1-hours');
  });
});

describe('classifyRecurringLogSignals', () => {
  const fp = (over: Partial<ReturnType<typeof summarizeLogFingerprints>[number]>) => ({
    fingerprint: 'x', count: 1, hours: 1, episodes: 1, firstAt: 0, lastAt: 0,
    minGapMs: null, levels: ['warn'], sources: [], exampleMessage: 'x', ...over,
  });

  it('RULE 1 hours: ≥3 distinct hours fires; 2 does not', () => {
    const fired = classifyRecurringLogSignals([fp({ hours: 3, count: 5 })]);
    const quiet = classifyRecurringLogSignals([fp({ hours: 2, count: 5 })]);
    expect(fired.map((s) => s.rule)).toEqual(['rule1-hours']);
    expect(quiet).toHaveLength(0);
  });

  it('RULE 1 boots: ≥3 boot episodes fires even inside 2 hours', () => {
    const fired = classifyRecurringLogSignals([fp({ hours: 1, episodes: 3, count: 9 })]);
    expect(fired.map((s) => s.rule)).toEqual(['rule1-boots']);
  });

  it('RULE 2: a quarantine promise repeating INSIDE its window fires (the motivating class)', () => {
    // quarantined for 6h, yet rows 40 min apart — 6 rows, minGap 40min < 6h.
    const s = classifyRecurringLogSignals([fp({
      count: 6, hours: 2, episodes: 2, minGapMs: 40 * M,
      exampleMessage: 'session history sync: project abc — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401',
      fingerprint: 'session history sync: project <uuid> — push refused permanently (terminal auth; quarantined for <n>h, one fresh attempt after): <n>',
    })]);
    expect(s.map((x) => x.rule)).toEqual(['rule2-suppression']);
    expect(s[0].promise).toBe('quarantined');
    expect(s[0].promisedWindowMs).toBe(6 * H);
  });

  it('RULE 2 respects its promise: a once-per-6h warn held to once per 7h does NOT fire rule 2 (and not enough hours for rule 1)', () => {
    const s = classifyRecurringLogSignals([fp({
      count: 3, hours: 2, minGapMs: 7 * H,
      exampleMessage: 'push refused permanently (quarantined for 6h)',
    })]);
    expect(s).toHaveLength(0);
  });

  it('RULE 2 unparsed window needs 3 repeats (2 never fires)', () => {
    const two = classifyRecurringLogSignals([fp({ count: 2, hours: 1, minGapMs: M, exampleMessage: 'suppressed: will not repeat' })]);
    expect(two).toHaveLength(0);
    const three = classifyRecurringLogSignals([fp({ count: 3, hours: 1, minGapMs: M, exampleMessage: 'suppressed: will not repeat' })]);
    expect(three.map((x) => x.rule)).toEqual(['rule2-suppression']);
    expect(three[0].promisedWindowMs).toBeNull();
  });

  it('rule 2 wins over rule 1 (sharpest signal first)', () => {
    const s = classifyRecurringLogSignals([fp({ count: 10, hours: 5, minGapMs: M, exampleMessage: 'quarantined for 6h' })]);
    expect(s).toHaveLength(1);
    expect(s[0].rule).toBe('rule2-suppression');
  });
});

// ── Ticket title/sessionId/week key ───────────────────────────────────────────

describe('ticket identity', () => {
  it('the title is STABLE per fingerprint and under the 140-char cap', () => {
    const t1 = logSignalTicketTitle('boom at <n>');
    expect(t1).toBe('log-signal: boom at <n>');
    expect(t1.length).toBeLessThanOrEqual(140);
    expect(logSignalTicketTitle('x'.repeat(300)).length).toBeLessThanOrEqual(140);
  });

  it('context.sessionId is PER FINGERPRINT (the fuzzy-dedup lesson from infra-watch card tickets)', () => {
    const a = logSignalTicketSessionId(fingerprintHash('alpha'));
    const b = logSignalTicketSessionId(fingerprintHash('beta'));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^log-signal-sweep:[0-9a-f]{16}$/);
  });

  it('the ISO week key matches the shape infra-watch uses', () => {
    expect(isoWeekKeyOf(new Date('2026-10-16T18:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
    // 2026-01-01 is a Thursday → week 1.
    expect(isoWeekKeyOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('the description carries the evidence a fix lane needs', () => {
    const s = classifyRecurringLogSignals([{
      fingerprint: 'push refused permanently (quarantined for <n>h)', count: 15, hours: 5, episodes: 5,
      firstAt: NOW.getTime() - 24 * H, lastAt: NOW.getTime(), minGapMs: 40 * M, levels: ['warn'],
      sources: ['coding/session-history-sync.service.ts'], exampleMessage: 'session history sync: project abc — push refused permanently (quarantined for 6h)',
    }])[0];
    const d = logSignalTicketDescription(s, NOW);
    expect(d).toContain('RULE 2');
    expect(d).toContain('quarantined');
    expect(d).toContain('get_fleet_telemetry');
    expect(d).toContain('log_signal_sweep');
    expect(d).toContain('8a66441e');
    expect(d.length).toBeLessThanOrEqual(8000);
  });
});

// ── The sweep end-to-end (mocked prisma/redis, REAL feedback insert path) ─────

describe('runLogSignalSweepOnce', () => {
  // Real messages carry UUID/hex ids — the normalizer strips those, so every
  // row of one class lands on ONE fingerprint. (Single-letter suffixes would
  // normalize to DISTINCT fingerprints — the first draft of this suite made
  // exactly that mistake. The variant must stay a VALID 8-4-4-4-12 uuid for
  // any n, hence the hex-padded tail segment.)
  const QUARANTINE_MSG = (p: string) => `session history sync: project ${p} — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials`;
  const P = (n: number) => `chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee${n.toString(16).padStart(2, '0')}`;

  it('files ONE ticket per fingerprint through the real feedback insert path and wakes the supervisor with the id', async () => {
    // The motivating shape: 40-min cadence across 5 boots.
    errorLogRows.push(
      row(240, QUARANTINE_MSG(P(1))), row(230, QUARANTINE_MSG(P(2))), row(220, QUARANTINE_MSG(P(3))),
      row(180, QUARANTINE_MSG(P(4))), row(170, QUARANTINE_MSG(P(5))), row(160, QUARANTINE_MSG(P(6))),
      row(120, QUARANTINE_MSG(P(7))), row(110, QUARANTINE_MSG(P(8))), row(100, QUARANTINE_MSG(P(9))),
      row(60, QUARANTINE_MSG(P(10))), row(50, QUARANTINE_MSG(P(11))), row(40, QUARANTINE_MSG(P(12))),
      row(20, QUARANTINE_MSG(P(13))), row(10, QUARANTINE_MSG(P(14))), row(1, QUARANTINE_MSG(P(15))),
    );
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({
      now: NOW,
      enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; },
    });

    expect(summary).toContain('signals 1');
    expect(summary).toContain('tickets filed 1');
    // ONE ticket row, source agent, stable title, per-fingerprint sessionId.
    expect(featureRequests).toHaveLength(1);
    const t = featureRequests[0];
    expect(t.type).toBe('bug_report');
    expect(t.source).toBe('agent');
    const expectedFp = normalizeLogMessage(QUARANTINE_MSG(P(1)));
    expect(t.title).toBe(logSignalTicketTitle(expectedFp));
    expect(t.context.sessionId).toBe(logSignalTicketSessionId(fingerprintHash(expectedFp)));
    expect(t.context.origin).toBe('log-signal-sweep');
    // The wake fired once and cites the ticket id.
    expect(wakes).toHaveLength(1);
    expect(wakes[0].prompt).toContain('[INFRA ALERT — recurring log signals]');
    expect(wakes[0].prompt).toContain(t.id);
    expect(wakes[0].targetChatId).toBe('sup-1');
    // The Redis week key caches the ticket id for the rest of the week.
    expect(redisStore.get(`log-signal-sweep:ticket:${isoWeekKeyOf(NOW)}:${fingerprintHash(expectedFp)}`)).toBe(t.id);
  });

  it('rows tagged logClass handled/external (utils/log-level.ts) never become a ticket or a wake', async () => {
    for (const m of [240, 230, 220, 180, 170, 160, 120, 110, 100, 60, 50, 40, 20, 10, 1]) {
      errorLogRows.push({ ...row(m, QUARANTINE_MSG(P(m))), context: { logClass: m % 2 ? 'external' : 'handled' } });
    }
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('signals 0');
    expect(featureRequests).toHaveLength(0);
    expect(wakes).toHaveLength(0);
    // The loader reads context so the tag is visible.
    expect(mockPrisma.appErrorLog.findMany.mock.calls[0][0].select.context).toBe(true);
  });

  it('isNonFaultLogRow: only the handled / external tags; untagged and fault rows stay sweepable', () => {
    expect(isNonFaultLogRow({ context: { logClass: 'handled' } })).toBe(true);
    expect(isNonFaultLogRow({ context: { logClass: 'external' } })).toBe(true);
    expect(isNonFaultLogRow({ context: { logClass: 'fault' } })).toBe(false);
    expect(isNonFaultLogRow({ context: { url: '/x' } })).toBe(false);
    expect(isNonFaultLogRow({ context: null })).toBe(false);
    expect(isNonFaultLogRow({})).toBe(false);
  });

  it('a secret-shaped token in a swept row NEVER reaches the filed ticket title/description or the wake (ticket 885614de)', async () => {
    // The write-time transport scrubs only the URL-userinfo shape — a provider
    // key an error line quoted sits RAW in app_error_logs. The sweep must not
    // copy it into the ticket title/description or the INFRA ALERT wake.
    const FAKE = 'sk-' + 'laneFAKEFAKEFAKEFAKEFAKE99';
    const SECRET_MSG = (n: number) => `gateway: upstream call failed (attempt ${n}): bearer ${FAKE} rejected — quarantined for 6h`;
    errorLogRows.push(
      row(240, SECRET_MSG(1)), row(180, SECRET_MSG(2)), row(120, SECRET_MSG(3)),
      row(60, SECRET_MSG(4)), row(40, SECRET_MSG(5)),
    );
    const wakes: any[] = [];
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });

    expect(featureRequests).toHaveLength(1);
    const t = featureRequests[0];
    expect(t.title).not.toContain(FAKE);
    expect(t.description).not.toContain(FAKE);
    expect(t.description).toContain('[REDACTED: looked like a credential]');
    expect(t.title).toContain('gateway: upstream call failed');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].prompt).not.toContain(FAKE);
    // The loop-metric meta top[] fingerprint is redacted too (the deliver() meta seam).
    const deliverMetric = (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]).find((m: any) => m?.meta?.top);
    expect(deliverMetric).toBeTruthy();
    expect(JSON.stringify(deliverMetric.meta.top)).not.toContain(FAKE);
    // The evidence a fix lane needs SURVIVES the redaction.
    expect(t.description).toContain('upstream call failed');
    expect(t.description).toContain('quarantined');
  });

  it('the SAME week never files twice: the second pass cites the cached ticket without a new row', async () => {    errorLogRows.push(row(240, QUARANTINE_MSG(P(1))), row(200, QUARANTINE_MSG(P(2))), row(160, QUARANTINE_MSG(P(3))), row(120, QUARANTINE_MSG(P(4))), row(80, QUARANTINE_MSG(P(5))), row(40, QUARANTINE_MSG(P(6))));
    const wakes: any[] = [];
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(featureRequests).toHaveLength(1);
    const firstId = featureRequests[0].id;
    // An hour later the signal is still true — the week key suppresses a second insert.
    const summary2 = await runLogSignalSweepOnce({ now: new Date(NOW.getTime() + H), enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(featureRequests).toHaveLength(1);
    expect(summary2).toContain('tickets filed 0');
    // The daily alert key also dedupes the second wake (same UTC day).
    expect(wakes).toHaveLength(1);
    expect(firstId).toBeTruthy();
  });

  it('a NEXT-DAY pass in the same week is NOT actionable: it cites the cached ticket but must NOT wake (N1)', async () => {
    errorLogRows.push(row(240, QUARANTINE_MSG(P(1))), row(200, QUARANTINE_MSG(P(2))), row(160, QUARANTINE_MSG(P(3))), row(120, QUARANTINE_MSG(P(4))), row(80, QUARANTINE_MSG(P(5))), row(40, QUARANTINE_MSG(P(6))));
    const wakes: any[] = [];
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(wakes).toHaveLength(1); // day 1: the filing IS actionable
    expect(featureRequests).toHaveLength(1);
    const firstId = featureRequests[0].id;
    expect(firstId).toBeTruthy();

    // NEXT UTC DAY, still the SAME ISO week: the class is still recurring, the
    // Redis week key still caches the ticket id, and the alert day key is FRESH
    // (day 2 would deliver if called) — only the actionability gate (nothing
    // filed or bumped THIS pass) keeps a standing class quiet. Before the N1
    // fix every hourly pass was actionable and the day key alone braked it to
    // one guaranteed wake/day per standing class, forever.
    const DAY2 = new Date('2026-10-17T18:00:00.000Z');
    expect(isoWeekKeyOf(DAY2)).toBe(isoWeekKeyOf(NOW)); // same ISO week
    // 7b2990fa mock fidelity (adversarial review finding B1): the class must
    // still be RECURRING at DAY2 — the mocked findMany now enforces the 24h
    // window the real one sends, and the day-1 rows (NOW-relative) fall
    // outside DAY2's window. Without DAY2-relative rows the second pass
    // fetches 0 rows and every not-actionable assertion below holds
    // VACUOUSLY — the N1 pin was silently vacated (review mutation-proved
    // it: regressing the gate to `signals.length > 0` passed 59/59).
    // Same fingerprint class (the uuid tails normalize away), same shape.
    const day2Row = (minutesAgo: number, message: string): LogSignalRow => ({ level: 'warn', message, source: 'test', createdAt: new Date(DAY2.getTime() - minutesAgo * M) });
    errorLogRows.push(day2Row(240, QUARANTINE_MSG(P(1))), day2Row(200, QUARANTINE_MSG(P(2))), day2Row(160, QUARANTINE_MSG(P(3))), day2Row(120, QUARANTINE_MSG(P(4))), day2Row(80, QUARANTINE_MSG(P(5))), day2Row(40, QUARANTINE_MSG(P(6))));
    const summary2 = await runLogSignalSweepOnce({ now: DAY2, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(featureRequests).toHaveLength(1); // no second row
    expect(summary2).toContain('rows 6'); // NON-vacuous: the class is inside DAY2's window
    expect(summary2).toContain('signals 1'); // and still recurrence-true (rule 1 fires)
    expect(summary2).toContain('tickets filed 0');
    expect(summary2).toContain('alert no'); // NOT actionable — despite the fresh day key
    expect(wakes).toHaveLength(1); // still only the day-1 wake
  });

  it('a LATER week bumps the standing ticket (feedback 90-day exact-title dedup) instead of filing a duplicate', async () => {
    errorLogRows.push(row(240, QUARANTINE_MSG(P(1))), row(200, QUARANTINE_MSG(P(2))), row(160, QUARANTINE_MSG(P(3))), row(120, QUARANTINE_MSG(P(4))), row(80, QUARANTINE_MSG(P(5))), row(40, QUARANTINE_MSG(P(6))));
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(featureRequests).toHaveLength(1);
    const first = featureRequests[0];

    // Ten days later (a new ISO week — its Redis key is empty) the class recurs.
    // (7b2990fa mock fidelity: rows are re-dated relative to LATER — the
    // mocked findMany now evaluates the 24h createdAt gte the real one sends,
    // and rows stamped against NOW would be ten days outside the window.)
    const LATER = new Date('2026-10-26T18:00:00.000Z');
    errorLogRows.length = 0;
    const laterRow = (minutesAgo: number, message: string): LogSignalRow => ({ level: 'warn', message, source: 'test', createdAt: new Date(LATER.getTime() - minutesAgo * M) });
    errorLogRows.push(laterRow(240, QUARANTINE_MSG(P(21))), laterRow(200, QUARANTINE_MSG(P(22))), laterRow(160, QUARANTINE_MSG(P(23))), laterRow(120, QUARANTINE_MSG(P(24))), laterRow(80, QUARANTINE_MSG(P(25))), laterRow(40, QUARANTINE_MSG(P(26))));
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: LATER, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(featureRequests).toHaveLength(1); // bumped, not duplicated
    expect(summary).toContain('bumped 1');
    expect(featureRequests[0].id).toBe(first.id);
    expect(featureRequests[0].context.occurrences).toBeGreaterThanOrEqual(2);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].prompt).toContain(first.id);
    expect(wakes[0].prompt).toContain('existing ticket');
  });

  it('quiet logs file nothing and wake nothing', async () => {
    errorLogRows.push(row(10, 'one-off transient network blip'));
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('signals 0');
    expect(featureRequests).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });

  // ── 7b2990fa: the sweep must never fingerprint its own failure warns ──────
  // The sweep's failure legs all log `logger.warn(\`${SOURCE}: …\`, { source: SOURCE })`
  // (defaultFileLogSignalTicket, the ticket loop's catch, the wake catch, the
  // outer catch), PrismaErrorTransport persists those rows to app_error_logs,
  // and a multi-hour Redis/DB outage makes the NEXT passes read them back as
  // input — the watchdog ticketing its own barking. The rows below carry the
  // exact message shape the service emits (keep in sync with the logger.warn
  // sites) at the exact cadence a dead-Redis hour would produce (one
  // filing-failed per signal per pass), recurrence-true under BOTH rule legs.

  it('7b2990fa: a storm of the sweep\'s OWN source-stamped warns files NOTHING and wakes nothing — the sweep never tickets its own barking', async () => {
    // 15 rows across 5 distinct hours (recurrence-true: rule1-hours AND
    // rule2-unparsed — "once per" is not promised here, but 3+ repeats of one
    // fingerprint inside 24h is the unparsed-promise leg's threshold shape…
    // and more importantly rule1-hours fires regardless). All stamped
    // source='log-signal-sweep' — exactly what the transport writes for the
    // sweep's own warns.
    for (let i = 0; i < 15; i++) {
      errorLogRows.push({
        level: 'warn',
        message: `log-signal-sweep: ticket filing failed for ab12cd34ef56ab${String(i).padStart(2, '0')} (non-fatal): Redis connection failed (getaddrinfo ENOTFOUND redis)`,
        source: 'log-signal-sweep',
        createdAt: new Date(NOW.getTime() - i * 20 * M), // 0..280 min, ≥5 distinct hours
      });
    }
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });

    expect(summary).toContain('rows 0'); // the fetch excluded every self row
    expect(summary).toContain('signals 0');
    expect(featureRequests).toHaveLength(0); // no ticket for the sweep's own warns
    expect(wakes).toHaveLength(0); // and no wake about them
  });

  it('7b2990fa: self rows are excluded at FETCH (the where clause carries source notIn) while a REAL signal in the same window still files', async () => {
    // The real signal rides alongside the sweep's own outage warns — the
    // Redis-outage shape the ticket describes: real signals AND self warns in
    // one window; only the real one must survive.
    errorLogRows.push(
      row(240, QUARANTINE_MSG(P(1))), row(230, QUARANTINE_MSG(P(2))), row(220, QUARANTINE_MSG(P(3))),
      row(180, QUARANTINE_MSG(P(4))), row(170, QUARANTINE_MSG(P(5))), row(160, QUARANTINE_MSG(P(6))),
      row(120, QUARANTINE_MSG(P(7))), row(110, QUARANTINE_MSG(P(8))), row(100, QUARANTINE_MSG(P(9))),
    );
    for (let i = 0; i < 9; i++) {
      errorLogRows.push({
        level: 'warn',
        message: `log-signal-sweep: ticket filing failed for ab12cd34ef56ab${String(i).padStart(2, '0')} (non-fatal): Redis connection failed`,
        source: 'log-signal-sweep',
        createdAt: new Date(NOW.getTime() - i * 25 * M),
      });
    }
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });

    // The exclusion is in the FETCH, not a post-filter: findMany received the
    // null-keeping OR shape (mocked findMany now evaluates it).
    const findWhere: any = mockPrisma.appErrorLog.findMany.mock.calls[0]?.[0]?.where;
    expect(Array.isArray(findWhere?.OR)).toBe(true);
    const notInBranch = findWhere?.OR?.find((b: any) => b?.source?.notIn);
    expect(notInBranch?.source?.notIn).toContain('log-signal-sweep');
    expect(findWhere?.OR?.some((b: any) => b?.source === null)).toBe(true); // NULL sources stay sweepable
    // Only the real signal survives the fetch and files.
    expect(summary).toContain('rows 9');
    expect(summary).toContain('signals 1');
    expect(featureRequests).toHaveLength(1);
    expect(featureRequests[0].title).toContain('session history sync');
    expect(wakes).toHaveLength(1);
  });

  it('7b2990fa: the exclusion NEVER widens — NULL-source rows (most of app_error_logs) stay sweepable, and other crons\' warns stay sweepable', async () => {
    // Prisma NOT-IN semantics exclude NULL — a naive `source: { notIn: […] }`
    // would silently drop every unattributed warn/error row from the sweep's
    // input. The implementation guards this (the clause is spread only for a
    // non-empty list, and the schema makes source nullable), and this test
    // pins the shape: the where clause keeps evaluating NULL-source rows true.
    const NO_SOURCE_MSG = (n: number) => `unattributed worker failure ${n}: push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials`;
    errorLogRows.push(
      { level: 'warn', message: NO_SOURCE_MSG(1), createdAt: new Date(NOW.getTime() - 240 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(2), createdAt: new Date(NOW.getTime() - 230 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(3), createdAt: new Date(NOW.getTime() - 220 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(4), createdAt: new Date(NOW.getTime() - 180 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(5), createdAt: new Date(NOW.getTime() - 170 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(6), createdAt: new Date(NOW.getTime() - 160 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(7), createdAt: new Date(NOW.getTime() - 120 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(8), createdAt: new Date(NOW.getTime() - 110 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(9), createdAt: new Date(NOW.getTime() - 100 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(10), createdAt: new Date(NOW.getTime() - 60 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(11), createdAt: new Date(NOW.getTime() - 50 * M) },
      { level: 'warn', message: NO_SOURCE_MSG(12), createdAt: new Date(NOW.getTime() - 40 * M) },
    );
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });

    expect(summary).toContain('rows 12'); // NULL-source rows were NOT dropped by the notIn clause
    expect(summary).toContain('signals 1');
    expect(featureRequests).toHaveLength(1);
    expect(featureRequests[0].title).toContain('unattributed worker failure');
  });

  it('LOG_SIGNAL_SWEEP_DISABLED=1 short-circuits everything', async () => {
    process.env[LOG_SIGNAL_SWEEP_DISABLED_ENV] = '1';
    errorLogRows.push(row(240, QUARANTINE_MSG('a')), row(200, QUARANTINE_MSG('b')), row(160, QUARANTINE_MSG('c')));
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('disabled');
    expect(featureRequests).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });

  it('LOG_SIGNAL_SWEEP_TICKETS_DISABLED=1 still wakes on a SPIKE (≥10 rows) but files nothing', async () => {
    process.env[LOG_SIGNAL_SWEEP_TICKETS_DISABLED_ENV] = '1';
    for (let i = 0; i < 12; i++) errorLogRows.push(row(240 - i * 10, `seat fallback leg failed attempt ${i} of 20 (transient 429, will retry): model chat_3f2a71c0-a${i}b2c-4d3e-9f00-aabbccddeeff`));
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('tickets filed 0');
    expect(featureRequests).toHaveLength(0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].prompt).toContain('recurring log signals');
  });

  it('a filing failure releases the Redis claim so the next sweep retries', async () => {
    for (let i = 0; i < 12; i++) errorLogRows.push(row(240 - i * 10, `warn class alpha failure ${i} of 20: session chat_3f2a71c0-a${i}b2c-4d3e-9f00-aabbccddeeff`));
    const failFile = async () => null;
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }), fileTicket: failFile });
    expect(featureRequests).toHaveLength(0);
    // No 'filing' marker survived — the week key was released.
    const left = [...redisStore.keys()].filter((k) => k.includes(':ticket:'));
    expect(left).toHaveLength(0);
  });

  it('two DIFFERENT fingerprints file two tickets with distinct titles and sessionIds (no fuzzy cross-merge)', async () => {
    // 30-min spacing → each class spans ≥3 distinct hours (Rule 1 hours).
    for (let i = 0; i < 8; i++) errorLogRows.push(row(240 - i * 30, `class alpha: widget chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee${i.toString(16).padStart(2, '0')} failed`));
    for (let i = 0; i < 8; i++) errorLogRows.push(row(240 - i * 30, `class beta: gadget chat_3f2a71c0-2b2c-4d3e-9f00-bbbbccddee${i.toString(16).padStart(2, '0')} failed`));
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(featureRequests).toHaveLength(2);
    const titles = featureRequests.map((t: any) => t.title).sort();
    expect(titles[0]).not.toBe(titles[1]);
    const sessions = featureRequests.map((t: any) => t.context.sessionId).sort();
    expect(sessions[0]).not.toBe(sessions[1]);
  });

  it('never throws: a prisma failure returns an error summary for cron_jobs.lastStatus', async () => {
    mockPrisma.appErrorLog.findMany.mockRejectedValueOnce(new Error('db down'));
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(summary).toContain('error:');
    expect(summary).toContain('db down');
  });

  // ── Daily NEW-filing cap (aad94ed4) ──────────────────────────────────────────
  //
  // The 25-pass simulation: PER_PASS=3 × an hourly cron was up to 72 new
  // rows/day; the day budget bounds it. Distinct fingerprints each pass —
  // each class spans 3+ distinct UTC hours so rule 1 fires, and the class tag
  // is LETTERS ONLY (a digit class-number would normalize away and collapse
  // every class onto ONE fingerprint — the suite's own documented trap).
  describe('daily NEW-filing cap (aad94ed4)', () => {
    /** Letter-only base-26 class tag (never normalized away). */
    const tag = (n: number): string => n.toString(26).split('').map((d) => String.fromCharCode(97 + parseInt(d, 26))).join('');
    const CLASS_MSG = (t: string, i: number) => `cap class ${t} failure ${i} of 20: session chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee${i.toString(16).padStart(2, '0')}`;
    /** Seed classes (one distinct fingerprint each), `rowsPerClass` rows 70 min apart before `at`. */
    const seedClasses = (at: Date, tags: string[], rowsPerClass = 6) => {
      errorLogRows.length = 0;
      for (const t of tags) for (let i = 0; i < rowsPerClass; i++) {
        const r = row(70 * i + 5, CLASS_MSG(t, i));
        r.createdAt = new Date(at.getTime() - (70 * i + 5) * M);
        errorLogRows.push(r);
      }
    };
    const passMetrics = () => (recordLoopMetric as jest.Mock).mock.calls
      .filter((c: any[]) => c[0]?.kind === 'log_signal_sweep' && typeof c[0]?.meta?.rows === 'number') // pass rows only — deliver()'s wake rows share the kind but carry meta.kind:'log_signal'
      .map((c: any[]) => c[0]);

    it('a 25-pass simulation files at most N per UTC day (3/pass, default 5/day) and records capped:true once the cap bites', async () => {
      const dayStart = new Date('2026-10-19T00:00:00.000Z'); // Monday — its own ISO week, clean keys
      let cappedPasses = 0;
      // 25 passes 30 min apart = 12 h — the whole simulation inside ONE UTC day.
      // (The real cron is hourly = at most 24 passes/day; 25-in-a-day is stricter.)
      for (let pass = 0; pass < 25; pass++) {
        const at = new Date(dayStart.getTime() + 5 * M + pass * 30 * M);
        seedClasses(at, [tag(pass * 3), tag(pass * 3 + 1), tag(pass * 3 + 2)]); // 3 FRESH classes every pass
        const summary = await runLogSignalSweepOnce({ now: at, enqueueDirectWake: async () => ({ ok: true }) });
        if (summary.includes('day cap hit')) cappedPasses++;
        // The INVARIANT: at every point of the day, ≤ N new rows exist (without
        // the cap this day would have filed 25 passes × 3 = 75).
        expect(featureRequests.length).toBeLessThanOrEqual(LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT);
        expect(featureRequests.length).toBe(pass === 0 ? 3 : LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT);
      }
      expect(featureRequests).toHaveLength(LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT); // the whole DAY filed exactly 5, not 75
      expect(cappedPasses).toBe(24); // the cap bites from pass 1 (2 more filed) onward
      // The pass telemetry: pass 0 uncapped, pass 1+ capped:true with dayCap.
      const passRows = passMetrics();
      expect(passRows).toHaveLength(25);
      expect(passRows[0].meta.capped).toBeUndefined();
      expect(passRows[1].meta.capped).toBe(true);
      expect(passRows[1].meta.dayCap).toBe(LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT);
      expect(passRows.slice(1).every((m: any) => m.meta?.capped === true)).toBe(true);
      // The counter ends AT the cap (over-cap INCRs refunded) with the 26 h TTL.
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-19'))).toBe(String(LOG_SIGNAL_TICKETS_PER_DAY_DEFAULT));
      expect(redisTtl.get(LOG_SIGNAL_FILED_KEY('2026-10-19'))).toBe(LOG_SIGNAL_FILED_TTL_SEC);
    });

    it('with LOG_SIGNAL_TICKETS_PER_DAY=2 the day files exactly 2 and every capped pass records meta capped:true + dayCap', async () => {
      process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] = '2';
      const dayStart = new Date('2026-10-19T00:00:00.000Z');
      let cappedPasses = 0;
      for (let pass = 0; pass < 25; pass++) {
        const at = new Date(dayStart.getTime() + 5 * M + pass * 30 * M); // 25 passes inside ONE UTC day
        seedClasses(at, [tag(100 + pass * 3), tag(101 + pass * 3), tag(102 + pass * 3)]);
        const summary = await runLogSignalSweepOnce({ now: at, enqueueDirectWake: async () => ({ ok: true }) });
        if (summary.includes('day cap hit')) cappedPasses++;
        expect(featureRequests.length).toBeLessThanOrEqual(2);
      }
      expect(featureRequests).toHaveLength(2); // the DAY budget, not 3/pass × 25
      expect(cappedPasses).toBe(25); // the very first pass already over-files (3 classes > 2/day)
      const passRows = passMetrics();
      expect(passRows.length).toBe(25);
      const cappedRows = passRows.filter((m: any) => m.meta?.capped === true);
      expect(cappedRows).toHaveLength(25);
      expect(cappedRows.every((m: any) => m.meta?.dayCap === 2)).toBe(true);
      // The counter never inflated past the cap.
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-19'))).toBe('2');
    });

    it('the day budget is per UTC DAY: a new day (new Redis key) files again without waiting', async () => {
      process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] = '2';
      const day1 = new Date('2026-10-19T00:30:00.000Z');
      seedClasses(day1, [tag(200), tag(201), tag(202)]);
      await runLogSignalSweepOnce({ now: day1, enqueueDirectWake: async () => ({ ok: true }) });
      expect(featureRequests).toHaveLength(2); // day 1 spent
      // DAY 2: fresh counter key — 2 more NEW filings, no cross-day leakage.
      const day2 = new Date('2026-10-20T00:30:00.000Z'); // same ISO week, next UTC day
      seedClasses(day2, [tag(210), tag(211), tag(212)]);
      const summary2 = await runLogSignalSweepOnce({ now: day2, enqueueDirectWake: async () => ({ ok: true }) });
      expect(summary2).toContain('tickets filed 2');
      expect(featureRequests).toHaveLength(4);
      // Each day's counter stayed at its own cap.
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-19'))).toBe('2');
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-20'))).toBe('2');
    });

    it('a dedup BUMP is budget-exempt: in a pass whose budget is spent AND capped, a standing ticket still bumps (occurrences grow, no new row)', async () => {
      // Day 1 (its own ISO week): file one ticket for class tag(0)='a'.
      const week1 = new Date('2026-10-19T12:00:00.000Z');
      seedClasses(week1, [tag(0)]);
      await runLogSignalSweepOnce({ now: week1, enqueueDirectWake: async () => ({ ok: true }) });
      expect(featureRequests).toHaveLength(1);
      const standing = featureRequests[0];
      expect(standing.id).toBeTruthy();

      // Day 2 = next Monday (a NEW ISO week ⇒ empty week key, the insert path
      // runs) AND a new UTC day. The same class-'a' fingerprint recurs (a BUMP)
      // while two FRESH classes spend the budget and a third gets capped —
      // all four signals must be in ONE pass, so the per-pass slice is widened
      // (the default 3 would leave the standing class outside the pass).
      const day2 = new Date('2026-10-26T12:00:00.000Z');
      process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] = '2';
      seedClasses(day2, [tag(300), tag(301), tag(302)], 12); // 12 rows each — louder, sorted first
      for (let i = 0; i < 6; i++) { // the standing class, 6 rows — quietest, processed LAST
        const r = row(70 * i + 5, CLASS_MSG(tag(0), i));
        r.createdAt = new Date(day2.getTime() - (70 * i + 5) * M);
        errorLogRows.push(r);
      }
      const summary = await runLogSignalSweepOnce({ now: day2, ticketsPerPass: 4, enqueueDirectWake: async () => ({ ok: true }) });

      // 2 fresh rows consumed the budget, the 3rd fresh class was capped, and
      // the standing row BUMPED (occurrences 2) AFTER the cap had already
      // fired in this pass — no third new row.
      expect(featureRequests).toHaveLength(3);
      expect(featureRequests.find((r: any) => r.id === standing.id)?.context.occurrences).toBeGreaterThanOrEqual(2);
      expect(summary).toContain('bumped 1');
      expect(summary).toContain('day cap hit');
      // The refund kept the counter at the cap despite the over-cap INCR.
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-26'))).toBe('2');
    });

    it('LOG_SIGNAL_TICKETS_PER_DAY=0 (bumps-only mode) files nothing new but still bumps standing tickets', async () => {
      process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] = '0';
      seedClasses(NOW, [tag(400), tag(401)]);
      const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
      expect(summary).toContain('tickets filed 0');
      expect(featureRequests).toHaveLength(0);
      expect(summary).toContain('day cap hit'); // 0/day ⇒ every new filing is capped
      // Bumps still flow in this mode — pinned by the exempt test above.
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY(NOW.toISOString().slice(0, 10)))).toBe('0'); // INCR refunded
    });

    it('a capped fingerprint leaves its week key UNCLAIMED (deferred, not lost) — the next pass/day retries it', async () => {
      process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] = '1';
      const t0 = new Date('2026-10-19T00:30:00.000Z');
      seedClasses(t0, [tag(500), tag(501), tag(502)]); // 3 classes, day cap 1 → two defer
      await runLogSignalSweepOnce({ now: t0, enqueueDirectWake: async () => ({ ok: true }) });
      expect(featureRequests).toHaveLength(1);
      // Only the FILED class holds a week key — no 'filing' marker or cached id
      // survived for the deferred ones, so the next pass retries them fresh.
      // (Which class files depends on the (reversed) row order the mocked
      // findMany returns, so assert set-membership over the three candidates.)
      const claims = [...redisStore.keys()].filter((k) => k.includes(':ticket:'));
      expect(claims).toHaveLength(1);
      const filedHashes = [tag(500), tag(501), tag(502)].map((t) => fingerprintHash(normalizeLogMessage(CLASS_MSG(t, 0))));
      expect(filedHashes.some((h) => claims[0].includes(h))).toBe(true);
      // The counter did NOT inflate past the cap (the capped INCRs were refunded).
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-19'))).toBe('1');
    });

    it('a THROWN insert refunds the reserved day slot and releases the week claim (throw-path leak, adversarial review: counter read "1" at 74bdb8b4)', async () => {
      // Reviewer finding 2, empirically confirmed by its probe: an insert that
      // THROWS after the INCR reservation burned a day slot and stranded the
      // week claim until its TTL — five such throws would wedge the day shut.
      seedClasses(NOW, [tag(600)]);
      const summary = await runLogSignalSweepOnce({
        now: NOW,
        enqueueDirectWake: async () => ({ ok: true }),
        fileTicket: async () => { throw new Error('db gone mid-insert'); },
      });
      expect(summary).toContain('tickets filed 0'); // non-fatal: the pass itself survived
      expect(summary).not.toContain('error:');
      expect(featureRequests).toHaveLength(0);      // nothing stored…
      // …so NO day budget was spent — the reserved slot must be refunded to 0
      // (the pre-fix leak left '1', under-filing the rest of the day).
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY(NOW.toISOString().slice(0, 10)))).toBe('0');
      // The week claim was released too (no stranded 'filing' marker) — the
      // next sweep retries the fingerprint instead of waiting out the TTL.
      expect([...redisStore.keys()].filter((k) => k.includes(':ticket:'))).toHaveLength(0);
    });

    it('a QUEUED insert result (feedback global backstop reached) is a NEW filing — the slot stands (review finding 1: adjudicated-clean shape, now pinned)', async () => {
      // Past feedback's GLOBAL_CAP_PER_DAY (300 agent rows/24h) the insert path
      // STORES the ticket as status:'queued' instead of dropping it — a stored
      // row is a stored row, so the day budget keeps the slot (it is NOT a
      // dedup bump, which would be refunded). Pad rows sit inside feedback's
      // real-clock 24h window (the caps read Date.now(), not deps.now).
      seedClasses(NOW, [tag(700)]);
      for (let i = 0; i < 300; i++) {
        // Pads are dated against the REAL clock (Date.now() - 60s), not NOW:
        // feedback's global cap counts rows via Date.now() (see the comment
        // above), so NOW-relative pads age out of the 24h window 36h after
        // NOW (2026-10-16T17:59Z + 24h) and the test red-lines for the rest
        // of real-time — a time bomb that fired 2026-10-17T17:59Z (main CI
        // green 17:44Z, then red). Real-clock-relative pads never age out.
        featureRequests.push({ id: `pad-${i}`, type: 'bug_report', source: 'agent', status: 'open', title: `pad ${i}`, description: 'x', createdAt: new Date(Date.now() - 60_000) });
      }
      const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
      expect(summary).toContain('tickets filed 1');
      const stored = featureRequests.find((r: any) => r.status === 'queued');
      expect(stored).toBeTruthy(); // queued, never dropped
      expect(stored.title).toContain('log-signal:'); // OUR fingerprint, not a pad row
      // The queued row consumed the day budget — counter '1', NOT refunded.
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY(NOW.toISOString().slice(0, 10)))).toBe('1');
    });

    // ── d6fdc1df: the walk skips already-ticketed signals ─────────────────────
    it('d6fdc1df(c): skips the already-ticketed loudest signals, files the next NEW ones, and the daily cap still bounds the walk', async () => {
      // The flood-day shape: the three LOUDEST classes were already ticketed
      // this ISO week (their week keys cite standing ticket ids), so the
      // pre-fix signals.slice(0, perPass) spent the whole pass on them and
      // filed NOTHING all day while fresh classes sat below the slice. The
      // walk must skip a cited signal WITHOUT consuming the per-pass budget
      // and keep descending until perPass NEW tickets have filed.
      const at = new Date('2026-10-19T12:00:00.000Z'); // Monday — its own ISO week, clean keys
      const cited = [tag(800), tag(801), tag(802)]; // already ticketed this week
      const fresh = [tag(803), tag(804), tag(805)]; // never filed before
      seedClasses(at, cited, 18); // 18 rows each — strictly the loudest three
      for (const t of fresh) for (let i = 0; i < 12; i++) { // 12 rows each — quieter
        const r = row(70 * i + 5, CLASS_MSG(t, i));
        r.createdAt = new Date(at.getTime() - (70 * i + 5) * M);
        errorLogRows.push(r);
      }
      const week = isoWeekKeyOf(at);
      for (const t of cited) {
        redisStore.set(`log-signal-sweep:ticket:${week}:${fingerprintHash(normalizeLogMessage(CLASS_MSG(t, 0)))}`, `standing-${t}-ticket`);
      }
      // Day budget 2: the walk files 803 and 804, then 805 defers (capped) —
      // proving BOTH the skip-past-cited walk AND the still-enforced daily cap.
      process.env[LOG_SIGNAL_TICKETS_PER_DAY_ENV] = '2';
      const summary = await runLogSignalSweepOnce({ now: at, enqueueDirectWake: async () => ({ ok: true }) });

      expect(summary).toContain('tickets filed 2');
      expect(summary).toContain('day cap hit');
      const filedTitles = featureRequests.map((r: any) => r.title);
      expect(filedTitles).toHaveLength(2);
      for (const t of cited) {
        // A cited signal files NOTHING — its standing ticket is only referenced.
        expect(filedTitles).not.toContain(logSignalTicketTitle(normalizeLogMessage(CLASS_MSG(t, 0))));
      }
      // Both NEW filings come from the fresh set (which two file is a tie-order
      // artifact — the mock's fetchWindowRows reverses rows, so equal-count
      // classes enter the sort in reverse insertion order; the DOCTRINE is
      // that cited signals never consume the budget).
      const freshTitles = fresh.map((t) => logSignalTicketTitle(normalizeLogMessage(CLASS_MSG(t, 0))));
      for (const title of filedTitles) expect(freshTitles).toContain(title);
      // The third FRESH class deferred at the day cap — every fresh class the
      // walk did NOT file keeps its week key unclaimed so the next pass/day
      // retries it.
      const filedFingerprints = new Set(featureRequests.map((r: any) => r.context.fingerprintHash));
      for (const t of fresh) {
        const key = `log-signal-sweep:ticket:${week}:${fingerprintHash(normalizeLogMessage(CLASS_MSG(t, 0)))}`;
        if (!filedFingerprints.has(fingerprintHash(normalizeLogMessage(CLASS_MSG(t, 0))))) {
          expect(redisStore.has(key)).toBe(false);
        }
      }
      // The day counter sits AT the cap (the over-cap INCR was refunded).
      expect(redisStore.get(LOG_SIGNAL_FILED_KEY('2026-10-19'))).toBe('2');
    });

    it('d6fdc1df(c): the per-pass budget counts NEW filings only — 3 cited + 3 fresh with the default 5/day files all 3 fresh in ONE pass', async () => {
      const at = new Date('2026-10-19T12:00:00.000Z');
      const cited = [tag(810), tag(811), tag(812)];
      const fresh = [tag(813), tag(814), tag(815)];
      seedClasses(at, cited, 18);
      for (const t of fresh) for (let i = 0; i < 12; i++) {
        const r = row(70 * i + 5, CLASS_MSG(t, i));
        r.createdAt = new Date(at.getTime() - (70 * i + 5) * M);
        errorLogRows.push(r);
      }
      const week = isoWeekKeyOf(at);
      for (const t of cited) {
        redisStore.set(`log-signal-sweep:ticket:${week}:${fingerprintHash(normalizeLogMessage(CLASS_MSG(t, 0)))}`, `standing-${t}-ticket`);
      }
      // Defaults: 3 NEW per pass, 5 per day. Pre-fix, the cited three consumed
      // the slice and this pass filed NOTHING; post-fix it files all three
      // fresh classes (3 ≤ both caps) — the walk only stops at perPass NEW.
      const summary = await runLogSignalSweepOnce({ now: at, enqueueDirectWake: async () => ({ ok: true }) });
      expect(summary).toContain('tickets filed 3');
      expect(featureRequests).toHaveLength(3);
      for (const t of fresh) {
        expect(featureRequests.map((r: any) => r.title)).toContain(logSignalTicketTitle(normalizeLogMessage(CLASS_MSG(t, 0))));
      }
    });
  });

  // ── Ticket beb1788b (2026-10-18): the sweep's ticket is never parked as a
  // linked duplicate ──────────────────────────────────────────────────────────
  // The defect: the sweep files with the FIRST ADMIN's userId, which activated
  // feedback's cross-source pass against that admin's own 24h user-filed
  // tickets; the sweep description embeds a 600-char raw log excerpt that
  // enlarges the containment haystack, so a containment hit parked the
  // fingerprint as a done + duplicateOf row (never dispatched) whose title was
  // the sweep's OWN — the title-agreement guard below could not see it. This
  // replays the full end-to-end shape through the REAL feedback insert path:
  // an admin user ticket whose title the sweep's raw excerpt contains, plus a
  // matching agent boilerplate row for the twin leg.
  describe('beb1788b — the sweep ticket never parks as a linked duplicate', () => {
    const QUAR = (p: string) => `session history sync: project ${p} — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after): 401 Bad credentials`;

    // The admin's OWN user-filed ticket from the same 24h — its title is a
    // ≥4-token substring of the sweep's raw log excerpt (the containment the
    // cross-source matcher keys on).
    const ADMIN_USER_TICKET = {
      id: 'ufr-user-90ab',
      type: 'bug_report',
      source: 'user',
      userId: 'owner-1', // must match the supervisor userId the sweep files with (sup-1 → owner-1)
      status: 'open',
      title: 'push refused permanently terminal auth quarantined for 6h',
      description: 'My coding session keeps failing to sync history.',
      createdAt: new Date(Date.now() - 30 * 60_000),
      context: {},
    };

    it('the raw excerpt would match cross-source (premise pinned), yet the sweep ticket files OPEN and dispatchable', async () => {
      featureRequests.push({ ...ADMIN_USER_TICKET });
      errorLogRows.push(row(240, QUAR(P(1))), row(200, QUAR(P(2))), row(160, QUAR(P(3))), row(120, QUAR(P(4))), row(80, QUAR(P(5))), row(40, QUAR(P(6))));

      const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });

      expect(summary).toContain('tickets filed 1');
      // ONE new row: the sweep's OWN ticket, OPEN (not done), no duplicateOf.
      const sweepRow = featureRequests.find((r: any) => r.title.startsWith('log-signal:'));
      expect(sweepRow).toBeTruthy();
      expect(sweepRow.status).toBe('open');
      expect(sweepRow.context.duplicateOf).toBeUndefined();
      expect(sweepRow.context.surface).toBe('system');
      // The admin's user row was never mutated (read-only, and never even
      // consulted as a link candidate).
      const userRow = featureRequests.find((r: any) => r.id === ADMIN_USER_TICKET.id);
      expect(userRow.status).toBe('open');
      // The week key caches the sweep's own row id — a dispatchable id.
      const expectedFp = normalizeLogMessage(QUAR(P(1)));
      expect(redisStore.get(`log-signal-sweep:ticket:${isoWeekKeyOf(NOW)}:${fingerprintHash(expectedFp)}`)).toBe(sweepRow.id);
    });

    it('the belt: a dedup result landing on a LINKED duplicate (duplicateOf) is never cached under the week key', async () => {
      // Belt replay — the guard shape the ticket asked for. With the
      // service-side system-filing guard DISABLED (kill switch), feedback
      // parks the sweep ticket as a linked duplicate carrying the sweep's
      // OWN title — exactly the beb1788b shape that title agreement could
      // not catch. The belt in defaultFileLogSignalTicket must refuse to
      // cache the parked id: the week key must not appear, and the loop's
      // null-return contract (release claim + refund slot, pinned above)
      // keeps the fingerprint retryable next pass.
      errorLogRows.push(row(240, QUAR(P(1))), row(200, QUAR(P(2))), row(160, QUAR(P(3))), row(120, QUAR(P(4))), row(80, QUAR(P(5))), row(40, QUAR(P(6))));
      const expectedFp = normalizeLogMessage(QUAR(P(1)));
      const stableTitle = logSignalTicketTitle(expectedFp);

      const prev = process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED;
      process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED = '1'; // service guard OFF — the belt must catch it
      try {
        featureRequests.push({ ...ADMIN_USER_TICKET });

        const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });

        // The park happened inside feedback (guard disabled) — the linked row
        // exists with the sweep's title…
        const linkedRow = featureRequests.find((r: any) => r.context?.duplicateOf === ADMIN_USER_TICKET.id);
        expect(linkedRow).toBeTruthy();
        expect(linkedRow.title).toBe(stableTitle);
        // …but the BELT refused to cache it: no week key holds the parked id.
        const weekKey = `log-signal-sweep:ticket:${isoWeekKeyOf(NOW)}:${fingerprintHash(expectedFp)}`;
        expect(redisStore.get(weekKey)).not.toBe(linkedRow.id);
        // The slot reservation the parked insert consumed was refunded (a
        // null-return filing refunds — the loop's contract, pinned above).
        expect(summary).toContain('tickets filed 0');
        expect(redisStore.get(LOG_SIGNAL_FILED_KEY(NOW.toISOString().slice(0, 10)))).toBe('0');
      } finally {
        if (prev === undefined) delete process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED;
        else process.env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED = prev;
      }
    });
  });
});

// ── PER-FINGERPRINT ADJUDICATION SUPPRESSION (ticket 0ef6794e) ───────────────
//
// The sweep's filing walk gained a skip branch (log-signal-adjudication.ts):
// a fingerprint whose class has been adjudicated designed >=2 cycles, with a
// VERIFIED id-named replay pin, inside its re-open bar and below the
// 3x-baseline surge line, no longer files a weekly ticket. The REAL feedback
// insert path runs below (suite posture), so these pin the walk END-TO-END
// against the insert path's own outcomes: an unsuppressed weekly re-file of
// an adjudicated row lands as the ABSORBED bump (be06c812); a bar-breach
// recurrence escalates through the insert path's REOPEN; a genuinely-new
// fingerprint files fresh. The gate's own decision table is pinned in
// log-signal-adjudication.test.ts.
describe('per-fingerprint adjudication suppression (0ef6794e)', () => {
  // The signal rows and the seeded standing row must agree on the fingerprint
  // EXACTLY — both derived at runtime from the same message shape, so the
  // seeded row's title is byte-identical to the sweep's computed title
  // (normalization + the 140-char truncation included).
  const SIGNAL_MSG = 'action-verifier: dropped 2 LLM-extracted note claim(s) with NO verbatim support in the audited note (ticket 587e9d64 grounding lane — extraction paraphrase-hallucination)';
  const ROW_MSG = (i: number) => `${SIGNAL_MSG}: run ${i} chat_3f2a71c0-1b2c-4d3e-9f00-aabbccddee0${i}`;
  const TITLE = logSignalTicketTitle(normalizeLogMessage(ROW_MSG(0)));
  const PREFIX = 'fc1fd22f';
  const PIN = 'backend/src/modules/crossmodel/platform/action-verifier.log-signal-fc1fd22f.test.ts';

  /** The standing row's context — fc1fd22f's live shape (count 19, baseline 19, one absorbed sighting). */
  const adjudicatedCtx = (over: Record<string, unknown> = {}) => ({
    fingerprintHash: '4b2b02a2d87ab48e',
    count: 19,
    occurrences: 2,
    acceptanceMetricBaseline: { baseline: 19, measurable: true, vacuous: false },
    sightings: [{ duplicateSuppressedBy: 'adjudicated-class', at: '2026-11-02T01:10:49.696Z' }],
    ...over,
  });

  /** Seed a standing CLOSED adjudicated row exactly the way the platform records one. */
  const seedAdjudicatedRow = (over: Record<string, unknown> = {}, ctxOver: Record<string, unknown> = {}) => {
    const seeded = {
      id: 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438',
      type: 'bug_report',
      source: 'agent',
      title: TITLE,
      status: 'done',
      priority: 2,
      userId: 'owner-1',
      description: 'prior fingerprint ticket',
      adminNote:
        'Adjudicated (family lane f02ac12e, 2026-10-26): false positive — no deterministic framework defect; guard correct.\n' +
        `Re-open bar: reopen if the fingerprint's 24h count exceeds 13,149 rows or a GROUNDED true claim is ever dropped.\n` +
        `[machine-close evidence: replay test ${PIN} (verified: exists + cites ${PREFIX})]`,
      context: adjudicatedCtx(ctxOver),
      createdAt: new Date('2026-10-24T00:00:00Z'),
      updatedAt: new Date('2026-10-26T02:19:16.578Z'),
      ...over,
    };
    featureRequests.push(seeded);
    return seeded;
  };

  /** Rows for ONE recurring fingerprint class (the varying tail normalizes away), spread across >=3 distinct hours. */
  const pushSignalRows = (n: number, minutesAgoStart = 240, spacingMin = 30) => {
    for (let i = 0; i < n; i++) errorLogRows.push(row(minutesAgoStart - i * spacingMin, ROW_MSG(i)));
  };

  it('DETECTOR-RECALL REPLAY: a genuinely-NEW fingerprint (no standing adjudicated row) still files', async () => {
    pushSignalRows(8); // >=3 distinct hours -> rule 1
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('tickets filed 1');
    expect(featureRequests.filter((r: any) => r.status === 'open')).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  it('DETECTOR-RECALL REPLAY: an epidemic recurrence over the recorded re-open bar still escalates (insert-path REOPEN)', async () => {
    seedAdjudicatedRow({}, { reopenBar: 4 }); // structural bar: 8 > 4 breaches
    pushSignalRows(8);
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('adjudicated suppressed 0');
    // The insert path reopened the standing row — the escalation the verdict's own bar demanded.
    const standing = featureRequests.find((r: any) => r.id === 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438');
    expect(standing.status).toBe('open');
    expect(standing.context.reopenCount).toBe(1);
    expect(standing.context.reopenBar).toBe(4); // B4: the bar survives the reopen write
    expect(wakes).toHaveLength(1);
  });

  it('DETECTOR-RECALL REPLAY: a 3x-baseline SURGE still surfaces (files onto the standing row, wakes, count trail recorded)', async () => {
    seedAdjudicatedRow();
    pushSignalRows(60, 1439, 20); // 60 rows in 24h, >=3 distinct hours
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('adjudicated suppressed 0');
    expect(summary).toContain('bumped 1');
    const standing = featureRequests.find((r: any) => r.id === 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438');
    const lastSighting = standing.context.sightings[standing.context.sightings.length - 1];
    expect(lastSighting.count).toBe(60); // the surge is IN the trail
    expect(lastSighting.duplicateSuppressedBy).toBe('adjudicated-class');
    expect(wakes).toHaveLength(1); // the wake carries the standing ticket id
    expect(wakes[0].prompt).toContain('fc1fd22f');
  });

  it('suppresses the weekly re-file of a twice-adjudicated designed class inside its bar (no insert, no wake, metrics keep recording)', async () => {
    seedAdjudicatedRow();
    pushSignalRows(8);
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });
    expect(summary).toContain('adjudicated suppressed 1');
    expect(summary).toContain('tickets filed 0');
    expect(summary).toContain('bumped 0');
    // The standing row is UNTOUCHED (no absorption sighting, no occurrences bump).
    expect(featureRequests).toHaveLength(1);
    expect(featureRequests[0].context.occurrences).toBe(2);
    // No wake: a suppressed filing is not actionable.
    expect(wakes).toHaveLength(0);
    // The pass telemetry row carries the suppression count (view 'metrics' observability).
    const pass = (recordLoopMetric as jest.Mock).mock.calls.filter((c: any) => c[0]?.kind === 'log_signal_sweep' && typeof c[0]?.meta?.rows === 'number');
    expect(pass.length).toBeGreaterThan(0);
    expect(pass[pass.length - 1][0].meta.adjudicatedSuppressed).toBe(1);
    // The week-key claim was RELEASED (the next pass re-asks the gate) — no ':ticket:' residue.
    expect([...redisStore.keys()].filter((k) => k.includes(':ticket:'))).toHaveLength(0);
  });

  it('one adjudication cycle (close only, no post-close witness) still files onto the standing row — one adjudication must not arm suppression', async () => {
    // Same row but WITHOUT the absorbed sighting: cycles = 1 < 2.
    seedAdjudicatedRow({}, { sightings: [] });
    pushSignalRows(8);
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(summary).toContain('adjudicated suppressed 0');
    // Unsuppressed: the weekly re-file lands as the be06c812 absorbed bump (occurrences trail).
    expect(summary).toContain('bumped 1');
    const standing = featureRequests.find((r: any) => r.id === 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438');
    expect(standing.status).toBe('done');
    expect(standing.context.occurrences).toBe(3);
  });

  it('a lazy close (verdict + cycles but NO verified pin) still surfaces — and the insert path escalates it (reopen)', async () => {
    seedAdjudicatedRow({ adminNote: 'Adjudicated: false positive — by design, nothing to fix. No replay pin recorded.' });
    pushSignalRows(8);
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(summary).toContain('adjudicated suppressed 0');
    const standing = featureRequests.find((r: any) => r.id === 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438');
    expect(standing.status).toBe('open'); // reopened — a lazy close never silences the class
    expect(standing.context.reopenCount).toBe(1);
  });

  it('LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED=1 restores the weekly filing behavior', async () => {
    process.env[LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED_ENV] = '1';
    seedAdjudicatedRow();
    pushSignalRows(8);
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(summary).toContain('adjudicated suppressed 0');
    expect(summary).toContain('bumped 1');
  });
});

// ── ACCEPTANCE-METRIC-BASELINE (2026-10-20): the log-signal default metric ──
describe('logSignalMetricContext (default acceptance metric)', () => {
  it('attaches "<= (re-fire threshold − 1) over 24 h" on the fingerprint\'s stable literal fragment, narrowed to a single level / source', () => {
    const raw = 'session-history-sync: project 3f2c1a4e-1111-4222-8333-944455556666 — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after)';
    const fp = normalizeLogMessage(raw);
    const ctx = logSignalMetricContext({ fingerprint: fp, levels: ['warn'], sources: ['session-history-sync'], exampleMessage: raw });
    expect(ctx.acceptanceMetricSource).toBe('autofiler-default');
    // A parsed suppression window re-fires rule 2 at 2 repeats ⇒ at most 1 row may remain (review 2026-10-20).
    expect(ctx.acceptanceMetric).toMatchObject({ probe: 'app_error_log_count', operator: '<=', target: 1, windowHours: 24, params: { level: 'warn', source: 'session-history-sync' } });
    const pattern = (ctx.acceptanceMetric as any).params.messagePattern as string;
    expect(pattern.length).toBeGreaterThanOrEqual(16);
    // The fragment is a literal (case-folded) substring of the raw message class.
    expect('session-history-sync: project X — push refused permanently (terminal auth; quarantined for 6h, one fresh attempt after)'.toLowerCase()).toContain(pattern);
  });

  it('review 2026-10-20: the quiet target sits just below the sweep\'s OWN re-fire threshold (never a flat 0)', () => {
    // No suppression promise: ≤ 2 rows can never span 3 hours / 3 boot episodes.
    expect(logSignalQuietTarget({ exampleMessage: 'invalid signature on every request here' })).toBe(2);
    expect((logSignalMetricContext({ fingerprint: 'invalid signature on every request here', exampleMessage: 'invalid signature on every request here' }).acceptanceMetric as any).target).toBe(2);
    // A promise with a parsed window: rule 2 fires at 2 repeats ⇒ 1.
    expect(logSignalQuietTarget({ exampleMessage: 'push refused (quarantined for 6h)' })).toBe(1);
    // A promise without a parseable window: rule 2 fires at 3 ⇒ 2; the fingerprint is the fallback text.
    expect(logSignalQuietTarget({ fingerprint: 'backing off — will retry later' })).toBe(2);
    expect(logSignalQuietTarget({})).toBe(2);
  });

  it('no stable fragment, or AUTOFILER_DEFAULT_METRIC_DISABLED=1 ⇒ no metric (the ticket files flagged, as before)', () => {
    expect(logSignalMetricContext({ fingerprint: '<n> <uuid> <hex>' })).toEqual({});
    expect(logSignalMetricContext({ fingerprint: 'invalid signature on every request here' }, { ...process.env, AUTOFILER_DEFAULT_METRIC_DISABLED: '1' })).toEqual({});
  });

  // ── TICKET 1425001e (2026-11-01): A DESIGNED ALARM GETS NO VOLUME BAR ──────
  // Ticket 8b62e61e: a fix that NAMED the gateway severance class and kept the
  // warn as the alarm was filed with `<= 2` over that warn's own volume — a
  // probe counting an emit site (coding-model.ts:2145) its diff never touched.
  // Measured 28 ⇒ CERTAIN fail ⇒ the next tick reopens a correct fix.
  it('attaches NO metric for the GATEWAY-OR-OURS designed alarm, and FLAGS it (never a silent drop)', () => {
    const fp = 'tool-call stream [api-optimize-xiaomi-mimo-v<n>-pro]: gateway-or-ours gateway recv=<n> acc=<n> drop=<n> frag=<n> buf=<n>';
    const ctx = logSignalMetricContext({ fingerprint: fp, levels: ['warn'], sources: ['run-model-turn'], exampleMessage: fp });
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricSource).toBeUndefined();
    // FLAGGED: puts the row on the done-bar board line so the absence is
    // visible and the lane attaches a behavioural criterion instead.
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricDesignedAlarm).toBe('gateway-or-ours');
  });

  it('an ordinary signal still gets the normal default metric (detection not weakened)', () => {
    const ctx = logSignalMetricContext({ fingerprint: 'session-history-sync: push refused permanently', levels: ['warn'], sources: ['session-history-sync'] });
    expect(ctx.acceptanceMetricSource).toBe('autofiler-default');
    expect(ctx.acceptanceMetric).toMatchObject({ probe: 'app_error_log_count', operator: '<=' });
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
  });
});

// ── TICKET 30dfad06 (2026-11-06): THE DEFAULT BAR MUST NOT SPAN A SIBLING ───
// The default bar is `app_error_log_count <= N` over a case-insensitive LITERAL
// SUBSTRING. `stableLiteralFragment` picks the LONGEST literal run, which for a
// message whose distinguishing text sits AFTER a long common head is the HEAD —
// and that head is a substring of every sibling subclass sharing the template.
// Then the bar counts rows the fix is not allowed to silence, and the verifier
// reopens a CORRECT fix forever.
//
// REPLAY (the live true positive this must keep catching): ticket 30dfad06's
// fix (#2574, 8128524556) WORKED — the verifier's window
// [02:45:52Z, 03:15:58Z] held exactly four matching warn rows and it measured
// THREE: one `500 … Parse Error: Header overflow` correctly EXCLUDED as
// logClass 'external' (adjudicated vendor class) plus three `timeout` rows that
// #2574 deliberately keeps filing, because tagging our own ECONNABORTED budget
// would swallow the invisible-outage class. 3 > 2 ⇒ reopened on a correct fix.
describe('30dfad06 — a fragment shared with a SIBLING class buys no volume bar', () => {
  // DETECTOR-RECALL REPLAY — the prior true positive replayed below is the live
  // 30dfad06 window (pointers f7aed76d/e9416b6b/cd43d371/97b15b4c, measured 3
  // over a bar of 2). Everything this change "stops filing" it must stop for the
  // RIGHT reason: NO bar rather than a bar that measures a sibling. The recall
  // guards below (a non-colliding sibling, and the signal matching itself) prove
  // the discrimination does not weaken ordinary detection.
  // The two subclasses of ONE brightdata-direct template, split by
  // classifyDirectMiss into deliberately DIFFERENT dispositions.
  const ROW_500 = 'BrightData direct: scrape_as_markdown failed: 500 Request failed with status code 500 — body: {"status_code":500,"error":"Proxy request failed","error_code":"unknown_proxy_error","details":"Parse Error: Header overflow"}';
  const ROW_TIMEOUT = 'BrightData direct: scrape_as_markdown failed:  timeout of 45000ms exceeded';

  it('the derived fragment really is the SHARED HEAD (the precondition this guards)', () => {
    const fp = normalizeLogMessage(ROW_500);
    const ctx = logSignalMetricContext({ fingerprint: fp, levels: ['warn'], sources: ['brightdata-direct'], exampleMessage: ROW_500 });
    // Alone, the head is what the fragment builder chooses…
    const pattern = (ctx.acceptanceMetric as any)?.params?.messagePattern as string;
    expect(pattern).toBe('brightdata direct: scrape_as_markdown failed');
    // …and it is a literal substring of BOTH subclasses, which is the defect.
    expect(ROW_500.toLowerCase()).toContain(pattern);
    expect(ROW_TIMEOUT.toLowerCase()).toContain(pattern);
  });

  it('REPLAY: with the `timeout` sibling live in the same pass, the bar is re-derived to a DISCRIMINATING run', () => {
    const fp = normalizeLogMessage(ROW_500);
    const sibling = normalizeLogMessage(ROW_TIMEOUT);
    // Sanity: the sibling genuinely collides on the shared head.
    expect(sibling.toLowerCase()).toContain('brightdata direct: scrape_as_markdown failed');
    const ctx = logSignalMetricContext(
      { fingerprint: fp, levels: ['warn'], sources: ['brightdata-direct'], exampleMessage: ROW_500 },
      process.env,
      [{ fingerprint: sibling, exampleMessage: ROW_TIMEOUT, sources: ['brightdata-direct'], levels: ['warn'] }],
    );
    // A bar is STILL attached — coverage is preserved, not dropped.
    expect(ctx.acceptanceMetricSource).toBe('autofiler-default');
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    const pattern = (ctx.acceptanceMetric as any).params.messagePattern as string;
    // …and it is the run that separates the 500 from `timeout`.
    expect(pattern).toBe('request failed with status code');
    // THE POINT: the bar's own predicate no longer matches the sibling's rows,
    // so the three `timeout` rows can no longer make a correct fix "fail".
    expect(ROW_500.toLowerCase()).toContain(pattern);
    expect(ROW_TIMEOUT.toLowerCase()).not.toContain(pattern);
  });

  it('when NO run discriminates, the bar is dropped and FLAGGED (never a bar on a sibling\'s rows)', () => {
    // A fingerprint entirely SUBSUMED by a live sibling's: every candidate run
    // the probe could use also matches the sibling's rows, so no sound bar
    // exists. (Two messages that normalize to the SAME fingerprint are not a
    // sibling at all — they are one class — which the self-exclusion handles.)
    const A = 'cache warm failed for tenant alpha';
    const B = 'cache warm failed for tenant alpha retry exhausted';
    expect(normalizeLogMessage(A)).not.toBe(normalizeLogMessage(B));
    const ctx = logSignalMetricContext(
      { fingerprint: normalizeLogMessage(A), levels: ['warn'], sources: ['cache-warm'], exampleMessage: A },
      process.env,
      [{ fingerprint: normalizeLogMessage(B), exampleMessage: B, sources: ['cache-warm'], levels: ['warn'] }],
    );
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricSource).toBeUndefined();
    // Never a SILENT drop: the flag puts the row on the done-bar board.
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricAmbiguousFragment).toContain('cache warm failed for tenant alpha');
  });

  it('a NON-colliding sibling still gets the normal default metric (detection not weakened)', () => {
    const fp = normalizeLogMessage(ROW_500);
    const ctx = logSignalMetricContext(
      { fingerprint: fp, levels: ['warn'], sources: ['brightdata-direct'], exampleMessage: ROW_500 },
      process.env,
      // A sibling from the SAME source that does not share the head: the
      // discrimination must not treat "same source" as "same class".
      [{ fingerprint: 'brightdata direct: zone credentials rejected — 401 invalid token for zone', exampleMessage: 'BrightData direct: zone credentials rejected — 401 invalid token for zone' }],
    );
    expect(ctx.acceptanceMetricSource).toBe('autofiler-default');
    expect(ctx.acceptanceMetric).toMatchObject({ probe: 'app_error_log_count', operator: '<=' });
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
  });

  it('the signal matching itself is not a clash (only SIBLINGS are)', () => {
    const fp = normalizeLogMessage(ROW_500);
    const withSelf = logSignalMetricContext(
      { fingerprint: fp, levels: ['warn'], sources: ['brightdata-direct'], exampleMessage: ROW_500 },
      process.env,
      [{ fingerprint: fp, exampleMessage: ROW_500 }],
    );
    expect(withSelf.acceptanceMetricSource).toBe('autofiler-default');
    expect(withSelf.acceptanceMetricMissing).toBeUndefined();
  });

  it('ambiguousFragmentSibling — pure: ignores blank/unknown input, never throws', () => {
    const { ambiguousFragmentSibling } = require('../feedback/acceptance-metric-defaults');
    expect(ambiguousFragmentSibling('brightdata direct: scrape_as_markdown failed', [])).toBeNull();
    expect(ambiguousFragmentSibling(null, [{ fingerprint: 'anything at all here' }])).toBeNull();
    expect(ambiguousFragmentSibling('   ', [{ fingerprint: 'anything at all here' }])).toBeNull();
    expect(ambiguousFragmentSibling('shared head of one template', [{}])).toBeNull();
    expect(ambiguousFragmentSibling('shared head of one template', [{ fingerprint: 'a SHARED HEAD of one template, variant two' }]))
      .toBe('a SHARED HEAD of one template, variant two');
  });
});

// ── TICKET 35cd91a7 (2026-11-06): A DECLARED INSTRUMENT NEVER FILES ──────────
// The sweep already computed `designedAlarmOfFingerprint` — but only inside the
// TICKET'S OWN PAYLOAD (`logSignalMetricContext`), i.e. after the filing
// decision. So the platform declared a class a designed alarm and paid for a
// ticket about it in the same expression: 35cd91a7's context carries
// `acceptanceMetricDesignedAlarm:'gateway-or-ours'` on a row filed that hour.
// A declared instrument's warn fires by design, so its ticket can never be
// closed as a fix — it re-files every ISO week, forever.
describe('35cd91a7 — a platform-declared DESIGNED ALARM is not filed as a ticket', () => {
  // The live fingerprint shape (normalized: digits → <n>).
  const INSTRUMENT_MSG = (i: number) =>
    `tool-call stream [api-optimize-alibaba-deepseek-v4.1-flash]: GATEWAY-OR-OURS gateway recv=0 acc=0 drop=0 frag=0 buf=0 fr=null sc=0 verdict=no_complete_payload — receivedBytes=0 accumulatedBytes=0 droppedBytes=0 fragments=0 undrainedBufferBytes=0 finishReason=null slots=1 named=1 unnamed=0 broken=0:get_fleet_telemetry:len0:Unexpected end of JSON input discardedComplete=[] claims=none r${i}`;

  it('files NOTHING for the GATEWAY-OR-OURS instrument, and counts what it withheld', async () => {
    // 12 rows across many hours = the RULE-1 recurrence the live ticket came from.
    for (let i = 0; i < 12; i++) errorLogRows.push(row(240 - i * 10, INSTRUMENT_MSG(i)));
    const wakes: any[] = [];
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async (o: any) => { wakes.push(o); return { ok: true }; } });

    // The recurrence WAS detected (the alarm still fires and is still counted) …
    expect(summary).toContain('signals 1');
    // … but no ticket was bought for an instrument.
    expect(summary).toContain('tickets filed 0');
    expect(summary).toContain('designed-alarm suppressed 1');
    expect(featureRequests).toHaveLength(0);
  });

  it('a genuine fault fingerprint still files (the stop is not a blanket off-switch)', async () => {
    for (let i = 0; i < 12; i++) errorLogRows.push(row(240 - i * 10, `session-history-sync: push refused permanently ${i} of 20`));
    await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });
    expect(featureRequests).toHaveLength(1);
    expect(featureRequests[0].title).toContain('session-history-sync');
  });

  it('an `ours` culprit KEEPS FILING — a defect of ours is never an instrument', async () => {
    // RECALL: the emit template carries the GATEWAY-OR-OURS token for EVERY
    // verdict, so without the culprit guard the stop would silently retire the
    // sweep's only detector for our own stream-handling bugs (unread arg bytes,
    // skipped raw lines, parse-fail frames).
    const oursMsg = (i: number) =>
      `tool-call stream [api-optimize-alibaba-deepseek-v4.1-flash]: GATEWAY-OR-OURS ours recv=812 acc=400 drop=0 frag=0 buf=0 fr=tool_calls sc=1 ur=412 verdict=no_complete_payload — receivedBytes=812 accumulatedBytes=400 droppedBytes=0 fragments=0 undrainedBufferBytes=0 finishReason=tool_calls slots=1 named=1 unnamed=0 broken=0 discardedComplete=[] claims=none o${i}`;
    for (let i = 0; i < 12; i++) errorLogRows.push(row(240 - i * 10, oursMsg(i)));
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });

    expect(summary).toContain('designed-alarm suppressed 0');
    expect(featureRequests).toHaveLength(1);
    expect(featureRequests[0].title).toContain('gateway-or-ours');
  });

  it('LOG_SIGNAL_DESIGNED_ALARM_FILING_DISABLED=1 restores filing for declared instruments', async () => {
    // A separate kill switch from the adjudication one: an operator can restore
    // filing for declared instruments without re-arming every adjudicated class.
    process.env[LOG_SIGNAL_DESIGNED_ALARM_FILING_DISABLED_ENV] = '1';
    for (let i = 0; i < 12; i++) errorLogRows.push(row(240 - i * 10, INSTRUMENT_MSG(i)));
    const summary = await runLogSignalSweepOnce({ now: NOW, enqueueDirectWake: async () => ({ ok: true }) });

    expect(summary).toContain('designed-alarm suppressed 0');
    expect(featureRequests).toHaveLength(1);
  });
});
