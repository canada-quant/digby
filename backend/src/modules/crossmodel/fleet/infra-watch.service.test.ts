/**
 * Infra watch (owner 2026-09-18) — pure classification/rendering + the sweep's
 * delivery/dedupe over mocked prisma/redis. Mirrors the follow-through suite's
 * posture: the deterministic halves are pinned; the wake seam is injected.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    // NX honoured (the card-ticket dedup claims with NX); plain sets overwrite.
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => { if (opts?.NX && redisStore.has(k)) return null; redisStore.set(k, v); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  },
}));
// user_feature_requests: a tiny in-memory table so the card-class ticket tests
// can drive the REAL feedback.fileFeedbackTicket insert path (its exact-title
// + same-session fuzzy dedup passes and rate-cap counts included) instead of
// the injected seam — the review finding was invisible with the seam mocked.
const featureRequests: any[] = [];
let featureRequestSeq = 0;
const ctxPathEquals = (row: any, cond: any): boolean => {
  const c = cond?.context;
  if (!c || !Array.isArray(c.path)) return true;
  return String(row.context?.[c.path[0]] ?? '') === String(c.equals);
};
const rowMatches = (row: any, where: any): boolean => {
  if (!where) return true;
  if (where.type && row.type !== where.type) return false;
  if (where.source && row.source !== where.source) return false;
  if (typeof where.status === 'string' && row.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
  if (!ctxPathEquals(row, where)) return false;
  if (Array.isArray(where.OR) && !where.OR.some((o: any) => ctxPathEquals(row, o))) return false;
  return true;
};
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []) },
  loopMetric: { findMany: jest.fn(async () => []) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON.
  systemSetting: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where }: any = {}) => featureRequests.filter((r) => rowMatches(r, where))),
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
// feedback.service's boundary deps (same mocks as feedback.service.test.ts):
// error-handler pulls config/env (process.exit without env vars); the
// burn-down drain hook dynamically imports ticket-dispatch (config/redis).
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
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  boxLabel,
  classifyBoxHealth,
  selectDeployFailures,
  attachCiVerdicts,
  summarizeCardCost,
  ownerStagedCardRows,
  renderBoxAlert,
  renderDeployFailureAlert,
  renderCardCostAlert,
  sweepInfraWatch,
  collectBoxHealth,
  deploySha,
  latestBoxHealthRows,
  producerBackupLastSeenAt,
  readBackupState,
  classifyBackupAge,
  renderBackupAlert,
  BACKUP_STALE_H,
  DISK_WARN_PCT,
  DISK_CRIT_PCT,
  isoWeekKey,
  fileCardClassTickets,
  cardClassTicketTitle,
  cardTicketSessionId,
  // audit budgets-cost-6 (2026-09-26)
  DECISION_BACKEND_DOWN_KIND,
  alertDecisionBackendDown,
  renderDecisionBackendDownAlert,
  selectDecisionBackendDownAlerts,
} from './infra-watch.service';
import { fileFeedbackTicket } from '../feedback/feedback.service';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const NOW = new Date('2026-09-18T20:00:00.000Z');

// ── Hermetic net (FO firing 41, 2026-09-28 red-main flake) ────────────────────
// CI 36414115643 failed ONLY on main (bf1147f97): a sweep test injected
// fetchDeployRuns but NOT fetchCiRuns, so the default CI seam ran a REAL fetch
// to api.github.com with the fake token 'ghp_x' — fast on a dev box, but a
// GitHub-hosted runner's IP class is secondary-rate-limited and the call can
// exceed jest's 5 s timeout (the service's own abort budget is 10 s). This
// suite must never touch the network: any real reach is RECORDED before the
// throw, and afterAll fails the file on the record — even where the service
// swallows the error (fetchCi's `.catch(() => [])` would otherwise turn the
// violation into a silent [] and a green test).
const netReaches: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (url: any) => {
    netReaches.push(String(url));
    throw new Error(`HERMETIC NET: infra-watch tests must inject every fetch seam — real network reach: ${String(url)}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (netReaches.length) {
    throw new Error(`HERMETIC NET: ${netReaches.length} real network reach(es) in this suite: ${netReaches.slice(0, 5).join(' | ')}`);
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  featureRequests.length = 0;
  featureRequestSeq = 0;
  delete process.env.INFRA_WATCH_DISABLED;
  delete process.env.INFRA_WATCH_CARD_TICKET_MIN_PER_TOOL;
  // DEPLOY-WATCH-BLIND: never read a real token from the shell (the hermetic net would trip).
  delete process.env.INFRA_WATCH_BLIND_ALARM_DISABLED;
  delete process.env.INFRA_WATCH_GITHUB_TOKEN;
  mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'fleet-sup-1', userId: 'owner-1' }]);
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
});

describe('box health', () => {
  it('labels the box by BOX_NAME, else the container hostname prefix', () => {
    expect(boxLabel({ BOX_NAME: 'box-a' } as any, 'deadbeefcafe1234')).toBe('box-a');
    expect(boxLabel({} as any, 'deadbeefcafe1234')).toBe('deadbeefcafe');
  });

  it('reports the short DEPLOY_SHA only when it looks like a commit sha (compose default is empty; "dev" is not a sha)', () => {
    expect(deploySha({ DEPLOY_SHA: '98e7d462f3a1b2c3d4e5f60718293a4b5c6d7e8f' } as any)).toBe('98e7d462');
    expect(deploySha({ DEPLOY_SHA: '' } as any)).toBeUndefined();
    expect(deploySha({ DEPLOY_SHA: 'dev' } as any)).toBeUndefined();
    expect(deploySha({} as any)).toBeUndefined();
  });

  describe('backup age (the 2026-09-17 night nobody noticed)', () => {
    it('readBackupState: unmounted dir says nothing; empty dir counts 0; dumps yield the newest age', async () => {
      expect(await readBackupState('/nonexistent/backups/dir', NOW)).toBeUndefined();
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'digby-bk-'));
      try {
        expect(await readBackupState(dir, NOW)).toEqual({ count: 0, ageH: null });
        await fsp.writeFile(path.join(dir, 'admin_db-20260916-083423.dump'), 'x');
        await fsp.writeFile(path.join(dir, 'admin_db-20260918-083325.dump'), 'y');
        await fsp.writeFile(path.join(dir, 'env-overrides-20260918-083325.env'), 'z'); // not a dump
        const old = new Date(NOW.getTime() - 48 * 3_600_000);
        const fresh = new Date(NOW.getTime() - 11.2 * 3_600_000);
        await fsp.utimes(path.join(dir, 'admin_db-20260916-083423.dump'), old, old);
        await fsp.utimes(path.join(dir, 'admin_db-20260918-083325.dump'), fresh, fresh);
        const st = await readBackupState(dir, NOW);
        expect(st).toMatchObject({ count: 2, ageH: 11.2 });
        expect(st!.newestAt).toBe(fresh.toISOString());
        const h = await collectBoxHealth('web', { backupDir: dir, now: NOW });
        expect(h.backup).toMatchObject({ count: 2, ageH: 11.2 });
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('collectBoxHealth omits backup when the mount is absent', async () => {
      const h = await collectBoxHealth('worker', { backupDir: '/nonexistent/backups/dir' });
      expect(h.backup).toBeUndefined();
    });

    it('backup-status marker (FO firing 21, 2026-09-25 — the silent failed nightly): marker surfaces, a FAILED run alerts immediately (age rule alone would stay silent), a newer dump supersedes, kill switch restores age-only, malformed marker never throws', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'digby-bk-status-'));
      try {
        // no marker (pre-2026-09-25 script) → the age rule alone, exactly as before
        await fsp.writeFile(path.join(dir, 'admin_db-20260918-133000.dump'), 'x');
        const dumpAt = new Date(NOW.getTime() - 6.5 * 3_600_000);
        await fsp.utimes(path.join(dir, 'admin_db-20260918-133000.dump'), dumpAt, dumpAt);
        expect(await readBackupState(dir, NOW)).toMatchObject({ count: 1, ageH: 6.5 });
        // the 2026-09-25 08:31Z shape: yesterday's dump still young, today's run FAILED
        await fsp.writeFile(path.join(dir, 'backup-status.json'), '{"status":"failed","at":"2026-09-18T14:00:00Z","error":"no dump source succeeded"}');
        const st = await readBackupState(dir, NOW);
        expect(st).toMatchObject({ count: 1, ageH: 6.5, status: 'failed', statusAt: '2026-09-18T14:00:00Z', statusError: 'no dump source succeeded' });
        const rowA = { host: 'box-a', process: 'web', diskPct: 10, diskFreeGb: 900, memFreePct: 50, load1: 0.1, at: NOW, backup: st };
        // immediate alert — ageH 6.5 is far under BACKUP_STALE_H, so the old rule said nothing for 30 h
        expect(classifyBackupAge([rowA as any], NOW)).toEqual({ kind: 'backup', severity: 'failed', host: 'box-a', ageH: 6.5, newestAt: dumpAt.toISOString(), statusError: 'no dump source succeeded' });
        expect(renderBackupAlert({ kind: 'backup', severity: 'failed', host: 'box-a', statusError: 'no dump source succeeded' }, NOW)).toContain('[INFRA ALERT — backup FAILED]');
        // a dump NEWER than the failed marker supersedes it (the manual re-run landed)
        const newer = new Date(NOW.getTime() - 1 * 3_600_000);
        await fsp.writeFile(path.join(dir, 'admin_db-20260918-190000.dump'), 'y');
        await fsp.utimes(path.join(dir, 'admin_db-20260918-190000.dump'), newer, newer);
        const st2 = await readBackupState(dir, NOW);
        expect(st2).toMatchObject({ status: 'failed' });
        expect(classifyBackupAge([{ ...rowA, backup: st2 } as any], NOW)).toBeNull();
        // an 'ok' marker never alerts
        await fsp.writeFile(path.join(dir, 'backup-status.json'), '{"status":"ok","at":"2026-09-18T19:05:00Z"}');
        expect(classifyBackupAge([{ ...rowA, backup: await readBackupState(dir, NOW) } as any], NOW)).toBeNull();
        // a malformed marker is ignored (never throw), a non-producer never decides
        await fsp.writeFile(path.join(dir, 'backup-status.json'), 'not-json{');
        const st5 = await readBackupState(dir, NOW);
        expect(st5!.status).toBeUndefined();
        const rowB = { host: 'box-b', process: 'web', diskPct: 10, diskFreeGb: 900, memFreePct: 50, load1: 0.1, at: NOW, backup: { count: 1, ageH: 2, status: 'failed', statusAt: '2026-09-18T14:00:00Z' } };
        expect(classifyBackupAge([rowB as any], NOW)).toBeNull();
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    const row = (host: string, backup?: any): any => ({ host, process: 'web', diskPct: 10, diskFreeGb: 900, memFreePct: 50, load1: 0.1, at: NOW, ...(backup !== undefined ? { backup } : {}) });

    it('classifyBackupAge: silent when no row sees the mount; the freshest dump anywhere decides', () => {
      expect(classifyBackupAge([row('box-a'), row('box-c')], NOW)).toBeNull();
      // box A fresh, box B/C mount an empty dir
      expect(classifyBackupAge([row('box-a', { count: 2, ageH: 11.2 }), row('box-b', { count: 0, ageH: null })], NOW)).toBeNull();
      // freshest is stale
      expect(classifyBackupAge([row('box-a', { count: 1, ageH: 35.4, newestAt: '2026-09-17T08:36:00.000Z' }), row('box-b', { count: 0, ageH: null })], NOW))
        .toEqual({ kind: 'backup', severity: 'stale', host: 'box-a', ageH: 35.4, newestAt: '2026-09-17T08:36:00.000Z' });
      // exactly at the threshold is not stale
      expect(classifyBackupAge([row('box-a', { count: 1, ageH: BACKUP_STALE_H })], NOW)).toBeNull();
      // mounted everywhere, dumps nowhere
      expect(classifyBackupAge([row('box-b', { count: 0, ageH: null }), row('box-a', { count: 0, ageH: null })], NOW)).toEqual({ kind: 'backup', severity: 'missing', host: 'box-a' });
    });

    it('classifyBackupAge: only the producer decides — box-b leftovers never name an alert; a producer reporting lapse downgrades to silence (the 2026-09-19 23:06Z re-fire)', () => {
      // box-a's box_health lapsed mid-deploy and box-b's 45 h leftover (timer
      // disabled-by-design, ticket cc1ca2bf) named a stale alert.
      const leftover = { count: 3, ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' };
      // producer row absent from the window; only the non-producer leftover reports ⇒ silent
      expect(classifyBackupAge([row('box-b', leftover), row('box-c')], NOW)).toBeNull();
      // producer row present but its mount reading absent (pre-/mid-deploy container) ⇒ silent
      expect(classifyBackupAge([row('box-b', leftover), row('box-a')], NOW)).toBeNull();
      // a non-producer's stale leftover alongside a FRESH producer dump ⇒ silent (the producer decides)
      expect(classifyBackupAge([row('box-b', leftover), row('box-a', { count: 2, ageH: 3.1 })], NOW)).toBeNull();
      // a non-producer's FRESHER dump never masks a genuinely stale producer ⇒ still alerts, naming the producer
      expect(classifyBackupAge([row('box-b', { count: 9, ageH: 1.5 }), row('box-a', { count: 1, ageH: 41.2, newestAt: '2026-09-17T06:20:00.000Z' })], NOW))
        .toEqual({ kind: 'backup', severity: 'stale', host: 'box-a', ageH: 41.2, newestAt: '2026-09-17T06:20:00.000Z' });
      // a genuinely stale freshest dump from the producer still alerts — the pin's core case
      expect(classifyBackupAge([row('box-a', { count: 1, ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' }), row('box-b', leftover)], NOW))
        .toEqual({ kind: 'backup', severity: 'stale', host: 'box-a', ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' });
      // the owner role is config-driven: an override can move it off box-a
      expect(classifyBackupAge([row('box-b', leftover)], NOW, BACKUP_STALE_H, ['box-b']))
        .toEqual({ kind: 'backup', severity: 'stale', host: 'box-b', ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' });
    });

    it('classifyBackupAge: producer-lapse degrade — no producer backup reading in the window + fresh producer heartbeats ⇒ WARN lapse naming the producer (todo 7e57d253)', () => {
      // the pre-4f6cb3610 class: box-a recreated without the /backups mount —
      // heartbeats fine, backup readings gone for the whole 24 h window
      expect(classifyBackupAge([row('box-a'), row('box-c')], NOW, BACKUP_STALE_H, ['box-a'], null))
        .toEqual({ kind: 'backup', severity: 'lapse', host: 'box-a' });
      // non-producer leftovers still reporting never change the lapse reading
      expect(classifyBackupAge([row('box-a'), row('box-b', { count: 3, ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' })], NOW, BACKUP_STALE_H, ['box-a'], null))
        .toEqual({ kind: 'backup', severity: 'lapse', host: 'box-a' });
      // a TRANSIENT lapse (producer reported backup earlier in the window — the 2026-09-19 23:06Z class) stays silent
      expect(classifyBackupAge([row('box-a'), row('box-c')], NOW, BACKUP_STALE_H, ['box-a'], new Date(NOW.getTime() - 2 * 3_600_000))).toBeNull();
      // a legacy caller (param undefined) keeps the silence
      expect(classifyBackupAge([row('box-a'), row('box-c')], NOW)).toBeNull();
      // producer heartbeats STALE (> BOX_HEALTH_STALE_MS) ⇒ no lapse alert — classifyBoxHealth's silent-box owns a dead box
      expect(classifyBackupAge([{ ...row('box-a'), at: new Date(NOW.getTime() - 2 * 3_600_000) }, row('box-c')], NOW, BACKUP_STALE_H, ['box-a'], null)).toBeNull();
      // a producer READING in the window still decides normally — lapse never fires
      expect(classifyBackupAge([row('box-a', { count: 1, ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' })], NOW, BACKUP_STALE_H, ['box-a'], null))
        .toEqual({ kind: 'backup', severity: 'stale', host: 'box-a', ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' });
    });

    it('producerBackupLastSeenAt: the newest producer row WITH a backup reading wins; non-producers never count; none ⇒ null', async () => {
      mockPrisma.loopMetric.findMany.mockResolvedValue([
        { createdAt: new Date(NOW.getTime() - 60_000), meta: { host: 'box-a', process: 'web' } }, // transient: no backup field
        { createdAt: new Date(NOW.getTime() - 2 * 3_600_000), meta: { host: 'box-a', backup: { count: 2, ageH: 11.2 } } },
        { createdAt: new Date(NOW.getTime() - 30_000), meta: { host: 'box-b', backup: { count: 3, ageH: 45.0 } } }, // non-producer: never counts
      ]);
      expect(await producerBackupLastSeenAt(NOW)).toEqual(new Date(NOW.getTime() - 2 * 3_600_000));
      mockPrisma.loopMetric.findMany.mockResolvedValue([{ createdAt: new Date(NOW.getTime() - 60_000), meta: { host: 'box-a' } }]);
      expect(await producerBackupLastSeenAt(NOW)).toBeNull();
    });

    it('renderBackupAlert: the lapse branch names the producer + the /backups mount playbook, and is distinct from the silent-box alert', () => {
      const lapse = renderBackupAlert({ kind: 'backup', severity: 'lapse', host: 'box-a' }, NOW);
      expect(lapse).toContain('backup producer box-a has not reported a backup reading');
      expect(lapse).toContain('"Backup producer box-a not reporting backups"');
      expect(lapse).toContain('/backups');
      expect(lapse).toContain("get_fleet_telemetry view 'boxes' shows box-a backup.ageH under 24");
      expect(lapse).not.toContain('silent box]');
      // a host-less lapse falls back to the configured producer
      expect(renderBackupAlert({ kind: 'backup', severity: 'lapse' }, NOW)).toContain('backup producer box-a');
    });

    it('renderBackupAlert names the producer box in the playbook + verify line (never a non-producer leftover host)', () => {
      const stale = renderBackupAlert({ kind: 'backup', severity: 'stale', host: 'box-a', ageH: 45.0, newestAt: '2026-09-18T01:56:43.957Z' }, NOW);
      expect(stale).toContain('"Nightly backup stale on box-a"');
      expect(stale).toContain("get_fleet_telemetry view 'boxes' shows box-a backup.ageH under 24");
      expect(stale).not.toContain('shows box-b backup.ageH under 24');
      // a host-less alert falls back to the configured producer, not a leftover host
      const missing = renderBackupAlert({ kind: 'backup', severity: 'missing' }, NOW);
      expect(missing).toContain('on the backup producer box-a');
      expect(missing).toContain("get_fleet_telemetry view 'boxes' shows box-a backup.ageH under 24");
    });

    it('renders stale and missing alerts with the timer facts, the known causes, the one-shot path and the verify step', () => {
      const stale = renderBackupAlert({ kind: 'backup', severity: 'stale', host: 'box-a', ageH: 35.4, newestAt: '2026-09-17T08:36:00.000Z' }, NOW);
      expect(stale).toContain('[INFRA ALERT — backup stale] the newest nightly database dump on box-a is 35.4 h old');
      expect(stale).toContain('digby-backup.timer');
      expect(stale).toContain("Failed with result 'signal'");
      // 437896fb (2026-10-24): the timeout kill is a first-class known cause, and
      // the S3 evidence is the journal line — the instance role has no ListBucket.
      expect(stale).toContain("Failed with result 'timeout'");
      expect(stale).toContain('TimeoutStartSec=7200');
      expect(stale).toContain('offsite copy uploaded');
      expect(stale).not.toContain('aws s3 ls s3://');   // must DIRECT the journal line, not an S3 listing the role can't run
      expect(stale).toContain('==ONE-SHOT-INSERT-POINT-PROD==');
      expect(stale).toContain("get_fleet_telemetry view 'boxes' shows box-a backup.ageH under 24");
      expect(stale).toContain('Never delete dumps');
      const missing = renderBackupAlert({ kind: 'backup', severity: 'missing', host: 'box-a' }, NOW);
      expect(missing).toContain('[INFRA ALERT — backup missing] no nightly database dump is present');
    });

    it('the sweep raises ONE backup alert from the same rows the disk classification reads, deduped', async () => {
      mockPrisma.loopMetric.findMany.mockImplementation(async (q: any) => {
        if (q?.where?.kind === 'box_health') {
          return [{ createdAt: new Date(NOW.getTime() - 5 * 60000), meta: { host: 'box-a', process: 'web', diskPct: 10, diskFreeGb: 900, memFreePct: 50, load1: 0.1, backup: { count: 1, ageH: 40.1, newestAt: '2026-09-17T03:54:00.000Z' } } }];
        }
        return [];
      });
      const wake = jest.fn(async (_o: any) => ({ ok: true }));
      const first = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
      expect(first.alerts).toBe(1);
      const prompt = String((wake.mock.calls[0] as any[])[0].prompt);
      expect(prompt).toContain('[INFRA ALERT — backup stale]');
      expect(prompt).toContain('40.1 h old');
      const second = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
      expect(second.alerts).toBe(0); // 6 h dedupe
    });
  });

  it('latestBoxHealthRows keeps the newest row per host and carries process/sha/memory/load through', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:46:00Z'), meta: { host: 'box-a', process: 'web', sha: '98e7d462', diskPct: 10, diskFreeGb: 932.3, memFreePct: 47, load1: 0.1, upMin: 3 } },
      { createdAt: new Date('2026-09-18T19:39:00Z'), meta: { host: 'box-a', process: 'worker', sha: '764f9ee1', diskPct: 10, diskFreeGb: 932.3, memFreePct: 47, load1: 0.1 } },
      { createdAt: new Date('2026-09-18T19:31:00Z'), meta: { host: '1c434c8b0465', process: 'web', diskPct: 5, diskFreeGb: 983.8, memFreePct: 63, load1: 0.06 } },
    ]);
    const rows = await latestBoxHealthRows(NOW);
    expect(rows.map((r) => r.host).sort()).toEqual(['1c434c8b0465', 'box-a']);
    // per host+process for the telemetry views: box A's web AND worker both appear
    const perProc = await latestBoxHealthRows(NOW, { perProcess: true });
    expect(perProc.map((r) => `${r.host}/${r.process}`).sort()).toEqual(['1c434c8b0465/web', 'box-a/web', 'box-a/worker']);
    expect(perProc.find((r) => r.process === 'worker')!.sha).toBe('764f9ee1');
    const a = rows.find((r) => r.host === 'box-a')!;
    expect(a).toMatchObject({ process: 'web', sha: '98e7d462', memFreePct: 47, load1: 0.1, upMin: 3 });
    const old = rows.find((r) => r.host === '1c434c8b0465')!;
    expect(old.sha).toBeUndefined();
    expect(old.upMin).toBeUndefined();
  });

  it('collects a real measurement of this process (numbers, sane ranges)', async () => {
    const h = await collectBoxHealth('worker');
    expect(h.process).toBe('worker');
    expect(h.upMin).toBeGreaterThanOrEqual(0);
    expect(h.diskPct).toBeGreaterThanOrEqual(0); expect(h.diskPct).toBeLessThanOrEqual(100);
    expect(h.memFreePct).toBeGreaterThanOrEqual(0); expect(h.memFreePct).toBeLessThanOrEqual(100);
    expect(typeof h.diskFreeGb).toBe('number');
  });

  it('classifies: ≥ crit → critical, ≥ warn → warning, healthy → nothing, stale row → silent', () => {
    const fresh = new Date(NOW.getTime() - 5 * 60_000);
    const alerts = classifyBoxHealth([
      { host: 'box-a', diskPct: 99, diskFreeGb: 1.4, at: fresh },
      { host: 'box-b', diskPct: DISK_WARN_PCT, diskFreeGb: 14, at: fresh },
      { host: 'box-c', diskPct: 18, diskFreeGb: 796, at: fresh },
      { host: 'box-d', diskPct: 10, diskFreeGb: 500, at: new Date(NOW.getTime() - 2 * 3600_000) },
      // pre-BOX_NAME container ids: replaced on every deploy — a stale one is a
      // retirement, never a silent box (19:26Z false wakes); a fresh one still
      // gets its disk alert
      { host: 'ee5c8a1935cf', diskPct: 10, diskFreeGb: 932, at: new Date(NOW.getTime() - 2 * 3600_000) },
      { host: '7796c4e42d7e', diskPct: 96, diskFreeGb: 3, at: fresh },
    ], NOW);
    expect(alerts).toEqual([
      { kind: 'disk', host: 'box-a', severity: 'critical', diskPct: 99, diskFreeGb: 1.4 },
      { kind: 'disk', host: 'box-b', severity: 'warning', diskPct: DISK_WARN_PCT, diskFreeGb: 14 },
      { kind: 'silent', host: 'box-d', severity: 'silent', lastSeenAt: new Date(NOW.getTime() - 2 * 3600_000) },
      { kind: 'disk', host: '7796c4e42d7e', severity: 'critical', diskPct: 96, diskFreeGb: 3 },
    ]);
    expect(DISK_CRIT_PCT).toBeGreaterThan(DISK_WARN_PCT);
  });

  it('renders the disk alert with the box, the numbers, the ordered playbook and the verify step', () => {
    const text = renderBoxAlert({ kind: 'disk', host: 'box-a', severity: 'critical', diskPct: 99, diskFreeGb: 1.4 }, NOW);
    expect(text.startsWith('[INFRA ALERT — disk critical] box-a root disk at 99% (1.4 GB free) at 20:00Z.')).toBe(true);
    expect(text).toContain('dispatch_platform_task "Reclaim disk on box-a"');
    expect(text).toContain('NEVER prune volumes or containers');
    expect(text).toContain('owner spend');
    expect(text).toContain('verify');
  });
});

describe('deploy failures', () => {
  const runs = [
    { id: 35361845981, conclusion: 'failure', head_sha: 'b40b4869abc', html_url: 'https://gh/x/1', created_at: '2026-09-18T19:40:00Z', updated_at: '2026-09-18T19:50:00Z', display_title: 'fix(chat-agent): follow-ups' },
    { id: 35360777615, conclusion: 'success', head_sha: '0cb74e30abc', html_url: 'https://gh/x/2', created_at: '2026-09-18T19:30:00Z', updated_at: '2026-09-18T19:45:00Z', display_title: 'ok' },
    { id: 35254976394, conclusion: 'failure', head_sha: 'ade80ec3abc', html_url: 'https://gh/x/3', created_at: '2026-09-17T17:48:00Z', updated_at: '2026-09-17T18:16:00Z', display_title: 'old' },
  ];
  it('keeps only failures inside the lookback window, newest first, with an 8-char sha', () => {
    expect(selectDeployFailures(runs, NOW)).toEqual([
      { runId: 35361845981, sha: 'b40b4869', url: 'https://gh/x/1', startedAt: '2026-09-18T19:40:00Z', title: 'fix(chat-agent): follow-ups' },
    ]);
    expect(selectDeployFailures([], NOW)).toEqual([]);
  });
  it('renders the deploy alert with the run, sha, url, the "main is not what production runs" fact and the verify step', () => {
    const text = renderDeployFailureAlert(selectDeployFailures(runs, NOW)[0], NOW);
    expect(text).toContain('[INFRA ALERT — deploy failed] GitHub deploy run 35361845981 for b40b4869');
    expect(text).toContain('https://gh/x/1');
    expect(text).toContain('main is NOT what production runs');
    expect(text).toContain('.deploy-sha');
  });
  it('attachCiVerdicts: matches on the sha prefix, highest (newest) CI run id per sha wins, and carries the verdict', () => {
    const failures = selectDeployFailures(runs, NOW); // one failure: sha b40b4869
    const ciRuns = [
      // older CI run on the same sha — FAILED (a superseded verdict)
      { id: 11, status: 'completed', conclusion: 'failure', head_sha: 'b40b4869abc' },
      // newest CI run on the same sha — PASSED (wins)
      { id: 12, status: 'completed', conclusion: 'success', head_sha: 'b40b4869abc' },
      // a different sha — must not match
      { id: 13, status: 'completed', conclusion: 'success', head_sha: 'fffffffffff' },
    ];
    const enriched = attachCiVerdicts(failures, ciRuns);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].ciVerdict).toBe('success');
  });
  it('attachCiVerdicts: no matching CI run → null verdict; in-progress CI → in_progress', () => {
    const failures = selectDeployFailures(runs, NOW);
    expect(attachCiVerdicts(failures, [])[0].ciVerdict).toBeNull();
    const inFlight = attachCiVerdicts(failures, [{ id: 20, status: 'in_progress', conclusion: null, head_sha: 'b40b4869abc' }]);
    expect(inFlight[0].ciVerdict).toBe('in_progress');
    expect(attachCiVerdicts(failures, [{ id: 21, status: 'completed', conclusion: 'failure', head_sha: 'b40b4869abc' }])[0].ciVerdict).toBe('failure');
  });
  it('renderDeployFailureAlert: a green same-sha CI verdict renders the FLAKE re-run branch and demotes the fix-lane dispatch', () => {
    const f = { ...selectDeployFailures(runs, NOW)[0], ciVerdict: 'success' as const };
    const text = renderDeployFailureAlert(f, NOW);
    expect(text).toContain('SAME-SHA CI VERDICT: success');
    expect(text).toContain('rolled FLAKE');
    expect(text).toContain('gh run rerun --failed');
    expect(text).toContain('ONLY if the same-sha CI verdict is not \'success\'');
  });
  it('renderDeployFailureAlert: a red same-sha CI verdict says the code is genuinely red', () => {
    const f = { ...selectDeployFailures(runs, NOW)[0], ciVerdict: 'failure' as const };
    const text = renderDeployFailureAlert(f, NOW);
    expect(text).toContain('SAME-SHA CI VERDICT: failure');
    expect(text).toContain('genuinely red');
  });
  it('renderDeployFailureAlert: an in-progress same-sha CI verdict tells the lane to wait; a null verdict renders the legacy playbook unchanged', () => {
    const base = renderDeployFailureAlert(selectDeployFailures(runs, NOW)[0], NOW);
    expect(base).not.toContain('SAME-SHA CI VERDICT');
    const waiting = renderDeployFailureAlert({ ...selectDeployFailures(runs, NOW)[0], ciVerdict: 'in_progress' as const }, NOW);
    expect(waiting).toContain('SAME-SHA CI VERDICT: in progress');
    expect(waiting).toContain('wait for CI to conclude');
  });
});

describe('owner-click cost', () => {
  it('groups staged cards by tool and stays silent under the threshold', () => {
    expect(summarizeCardCost([{ tool: 'send_chat_message' }, { tool: 'send_chat_message' }])).toBeNull();
    expect(summarizeCardCost([{ tool: 'send_chat_message' }, { tool: 'send_chat_message' }, { tool: 'set_chat_autonomy' }]))
      .toEqual({ total: 3, byTool: [{ tool: 'send_chat_message', n: 2 }, { tool: 'set_chat_autonomy', n: 1 }] });
    const text = renderCardCostAlert({ total: 3, byTool: [{ tool: 'send_chat_message', n: 2 }, { tool: 'set_chat_autonomy', n: 1 }] }, NOW);
    expect(text).toContain('[INFRA ALERT — owner-click cost] 3 confirmation cards');
    expect(text).toContain('send_chat_message ×2, set_chat_autonomy ×1');
    expect(text).toContain('FRAMEWORK DEFECT');
    expect(text).not.toContain('Tickets (');
  });

  describe('auto-ticket per (tool, ISO week) — WI-Q 2026-09-25', () => {
    const DIGEST = { total: 5, byTool: [{ tool: 'send_chat_message', n: 4 }, { tool: 'set_chat_autonomy', n: 1 }] };
    const makeFiler = () => {
      let n = 0;
      return jest.fn(async (_o: any) => ({ id: `ticket-${++n}` }));
    };

    it('isoWeekKey is Monday-anchored UTC (2026-09-18 Fri and 2026-09-20 Sun share W38; the 21st opens W39; year rollover)', () => {
      expect(isoWeekKey(new Date('2026-09-18T20:00:00Z'))).toBe('2026-W38');
      expect(isoWeekKey(new Date('2026-09-20T23:59:59Z'))).toBe('2026-W38');
      expect(isoWeekKey(new Date('2026-09-21T00:00:00Z'))).toBe('2026-W39');
      expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    });

    it('files EXACTLY one ticket per ≥3/day tool per week through the injected insert seam, none for tools under the threshold', async () => {
      const filer = makeFiler();
      const out = await fileCardClassTickets('owner-1', DIGEST, NOW, filer);
      expect(filer).toHaveBeenCalledTimes(1);
      expect(filer.mock.calls[0][0]).toMatchObject({
        userId: 'owner-1',
        title: cardClassTicketTitle('send_chat_message', 4),
        context: expect.objectContaining({ sessionId: 'infra-watch:send_chat_message', origin: 'infra-watch', tool: 'send_chat_message', cardsPerDay: 4, week: '2026-W38' }),
      });
      expect(filer.mock.calls[0][0].title).toBe('Card class: send_chat_message staged 4×/day — candidate for a card-free path');
      expect(filer.mock.calls[0][0].description).toContain("get_fleet_telemetry view 'cards'");
      expect(out).toEqual([{ tool: 'send_chat_message', n: 4, ticketId: 'ticket-1', week: '2026-W38', filed: true }]);
      expect(redisStore.get('infra-watch:card-ticket:send_chat_message:2026-W38')).toBe('ticket-1');
      // the next day's sweep the same week: NO new filing — the existing id is cited
      const later = await fileCardClassTickets('owner-1', DIGEST, new Date('2026-09-19T20:00:00Z'), filer);
      expect(filer).toHaveBeenCalledTimes(1);
      expect(later).toEqual([{ tool: 'send_chat_message', n: 4, ticketId: 'ticket-1', week: '2026-W38', filed: false }]);
      // a new ISO week files again
      const nextWeek = await fileCardClassTickets('owner-1', DIGEST, new Date('2026-09-22T20:00:00Z'), filer);
      expect(filer).toHaveBeenCalledTimes(2);
      expect(nextWeek[0]).toMatchObject({ ticketId: 'ticket-2', week: '2026-W39', filed: true });
    });

    it('a failed insert releases the week key so the next sweep retries', async () => {
      const failing = jest.fn(async () => null);
      expect(await fileCardClassTickets('owner-1', DIGEST, NOW, failing)).toEqual([]);
      expect(redisStore.has('infra-watch:card-ticket:send_chat_message:2026-W38')).toBe(false);
      const throwing = jest.fn(async () => { throw new Error('db down'); });
      expect(await fileCardClassTickets('owner-1', DIGEST, NOW, throwing)).toEqual([]); // never throws
      // threshold is tunable
      process.env.INFRA_WATCH_CARD_TICKET_MIN_PER_TOOL = '5';
      const strict = makeFiler();
      expect(await fileCardClassTickets('owner-1', DIGEST, NOW, strict)).toEqual([]);
      expect(strict).not.toHaveBeenCalled();
    });

    it('the wake cites the ticket id (filed vs found-earlier-this-week vs deduped-existing) and tells the supervisor never to re-file', () => {
      const text = renderCardCostAlert(DIGEST, NOW, [{ tool: 'send_chat_message', n: 4, ticketId: 'abc12345-ticket', week: '2026-W38', filed: true }]);
      expect(text).toContain('send_chat_message → ticket abc12345-ticket');
      expect(text).toContain('never re-file it');
      const again = renderCardCostAlert(DIGEST, NOW, [{ tool: 'send_chat_message', n: 4, ticketId: 'abc12345-ticket', week: '2026-W38', filed: false }]);
      expect(again).toContain('ticket abc12345-ticket (filed earlier this week)');
      const deduped = renderCardCostAlert(DIGEST, NOW, [{ tool: 'send_chat_message', n: 4, ticketId: 'abc12345-ticket', week: '2026-W38', filed: false, deduped: true }]);
      expect(deduped).toContain('ticket abc12345-ticket (existing open ticket — sighting recorded, not re-filed)');
      expect(deduped).not.toContain('filed earlier this week');
    });

    describe('through the REAL feedback.fileFeedbackTicket insert path (review fix 2026-09-25 — the seam hid a fuzzy-dedup merge)', () => {
      // Two tools at the same N in one digest: their titles differ by ONE token
      // ("Card class: <tool> staged 3×/day — candidate for a card-free path"),
      // Jaccard 0.67 ≥ feedback's 0.6 fuzzy threshold — under a SHARED
      // context.sessionId the second filing bumped the first tool's ticket.
      const TWO_TOOLS = { total: 6, byTool: [{ tool: 'send_chat_message', n: 3 }, { tool: 'notify_user', n: 3 }] };

      it('negative control: the mock honours feedback\'s same-session fuzzy pass — a SHARED session id merges the two titles into one ticket', async () => {
        const ctx = (tool: string) => ({ sessionId: 'infra-watch', tool });
        const a: any = await fileFeedbackTicket({ userId: 'owner-1', type: 'enhancement', title: cardClassTicketTitle('send_chat_message', 3), description: 'a', context: ctx('send_chat_message') });
        const b: any = await fileFeedbackTicket({ userId: 'owner-1', type: 'enhancement', title: cardClassTicketTitle('notify_user', 3), description: 'b', context: ctx('notify_user') });
        expect(a.deduped).toBe(false);
        expect(b.deduped).toBe(true);
        expect(b.ticket.id).toBe(a.ticket.id); // the bug the seam-mocked suite could not see
        expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalledTimes(1);
      });

      it('files TWO distinct rows for two tools at N=3 in one digest (per-tool session ids), and the wake cites two distinct ids', async () => {
        const out = await fileCardClassTickets('owner-1', TWO_TOOLS, NOW); // default seam = the real insert path
        expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalledTimes(2);
        expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled(); // no bump = no fuzzy merge
        const created = mockPrisma.userFeatureRequest.create.mock.calls.map((c: any) => c[0].data);
        expect(created.map((d: any) => d.title)).toEqual([cardClassTicketTitle('send_chat_message', 3), cardClassTicketTitle('notify_user', 3)]);
        expect(created.map((d: any) => d.context.sessionId)).toEqual([cardTicketSessionId('send_chat_message'), cardTicketSessionId('notify_user')]);
        expect(created[0]).toMatchObject({ type: 'enhancement', source: 'agent', priority: 2, userId: 'owner-1', context: expect.objectContaining({ area: 'framework', origin: 'infra-watch', tool: 'send_chat_message', cardsPerDay: 3, week: '2026-W38' }) });
        expect(out).toEqual([
          { tool: 'send_chat_message', n: 3, ticketId: 'ufr-1', week: '2026-W38', filed: true },
          { tool: 'notify_user', n: 3, ticketId: 'ufr-2', week: '2026-W38', filed: true },
        ]);
        expect(redisStore.get('infra-watch:card-ticket:send_chat_message:2026-W38')).toBe('ufr-1');
        expect(redisStore.get('infra-watch:card-ticket:notify_user:2026-W38')).toBe('ufr-2');
        const prompt = renderCardCostAlert(TWO_TOOLS, NOW, out);
        expect(prompt).toContain('send_chat_message → ticket ufr-1');
        expect(prompt).toContain('notify_user → ticket ufr-2');
      });

      it('a later ISO week with the same tool at the same N hits feedback\'s 90-day exact-title dedup: the OLD ticket is cited as deduped (filed:false), never announced as filed', async () => {
        const first = await fileCardClassTickets('owner-1', TWO_TOOLS, NOW);
        expect(first.map((t) => t.filed)).toEqual([true, true]);
        const nextWeek = new Date('2026-09-22T20:00:00Z');
        const again = await fileCardClassTickets('owner-1', TWO_TOOLS, nextWeek);
        expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalledTimes(2); // nothing new
        expect(mockPrisma.userFeatureRequest.update).toHaveBeenCalledTimes(2); // one sighting bump per tool
        expect(again).toEqual([
          { tool: 'send_chat_message', n: 3, ticketId: 'ufr-1', week: '2026-W39', filed: false, deduped: true },
          { tool: 'notify_user', n: 3, ticketId: 'ufr-2', week: '2026-W39', filed: false, deduped: true },
        ]);
        expect(redisStore.get('infra-watch:card-ticket:notify_user:2026-W39')).toBe('ufr-2');
        expect(featureRequests[1].context.occurrences).toBe(2);
      });

      it('a dedup hit on a DIFFERENT title is a non-filing: nothing is cached under the tool\'s week key and the next sweep retries', async () => {
        // Plant an open agent ticket that the per-tool session shares and whose
        // title is fuzzy-close (drop one token) — the only way a merge could
        // still land on a foreign row.
        featureRequests.push({ id: 'ufr-foreign', type: 'enhancement', source: 'agent', status: 'open', createdAt: new Date(), priority: 1, description: 'x', title: 'Card class: notify_user staged 4×/day — candidate for a card-free path', context: { sessionId: cardTicketSessionId('notify_user') } });
        const out = await fileCardClassTickets('owner-1', { total: 3, byTool: [{ tool: 'notify_user', n: 3 }] }, NOW);
        expect(out).toEqual([]);
        expect(redisStore.has('infra-watch:card-ticket:notify_user:2026-W38')).toBe(false);
        expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
      });
    });
  });
});

describe('sweepInfraWatch — delivery + dedupe over the admin fleet supervisor', () => {
  it('wakes the fleet supervisor once per alert class within the dedupe window and records infra_alert', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      // producer carries a healthy backup reading so the lapse path stays silent — this test is about disk-critical dedupe
      if (where?.kind === 'box_health') return [{ createdAt: new Date(NOW.getTime() - 60_000), meta: { host: 'box-a', diskPct: 96, diskFreeGb: 5, backup: { count: 2, ageH: 11.2 } } }];
      return [];
    });
    const first = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(first.alerts).toBe(1);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ targetChatId: 'fleet-sup-1', prompt: expect.stringContaining('[INFRA ALERT — disk critical] box-a') }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_alert', sessionId: 'fleet-sup-1' }));
    const second = await sweepInfraWatch({ now: new Date(NOW.getTime() + 60_000), enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(second.alerts).toBe(0); // deduped
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a failed deploy run alerts once, using the admin owner\'s GitHub token; a healthy fleet and no token alert nothing', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    const runs = [{ id: 42, conclusion: 'failure', head_sha: 'b40b4869abc', html_url: 'u', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), display_title: 't' }];
    // 2026-09-28 red-main flake (FO firing 41): this test injected
    // fetchDeployRuns but NOT fetchCiRuns, so the sweep's default CI seam ran a
    // REAL fetch to api.github.com with the fake token 'ghp_x' — 150 ms on a
    // dev box, but > jest's 5 s timeout on a CI runner whose IP class
    // api.github.com secondary-rate-limits (CI 36414115643 failed on bf1147f97
    // while the same suite passed its PR run 36413647397 five minutes earlier).
    // Every fetch seam is injected now, and the hermetic net below makes any
    // future forgotten seam a loud suite failure instead of a hidden timeout.
    const ciRuns = [{ id: 50, status: 'completed', conclusion: 'success', head_sha: 'b40b4869abc' }];
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => 'ghp_x', fetchDeployRuns: async () => runs, fetchCiRuns: async () => ciRuns });
    expect(r.alerts).toBe(1);
    expect(wake.mock.calls[0][0].prompt).toContain('deploy run 42');
    // the same-sha CI enrichment is wired through the sweep's own seam — pinned
    // here because the pure attachCiVerdicts tests cannot see the seam default
    expect(wake.mock.calls[0][0].prompt).toContain('SAME-SHA CI VERDICT: success');
    expect(wake.mock.calls[0][0].prompt).toContain('rolled FLAKE');
    const again = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => 'ghp_x', fetchDeployRuns: async () => runs, fetchCiRuns: async () => ciRuns });
    expect(again.alerts).toBe(0);
    const none = await sweepInfraWatch({ now: new Date(NOW.getTime() + 7 * 3600_000), enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(none.alerts).toBe(0);
  });

  it('FO firing 102: the sweep stamps deploy_wave_success for every in-window successful run, Redis-deduped by runId (the red-alert recovery signal)', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    const runs = [
      { id: 42, conclusion: 'failure', head_sha: 'b40b4869abc', html_url: 'u', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), display_title: 't' },
      { id: 41, conclusion: 'success', head_sha: '3b4375b751', html_url: 'u2', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), display_title: 'ok wave' },
      { id: 40, conclusion: 'success', head_sha: 'e5fb2483e2', html_url: 'u3', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), display_title: 'ok wave 2' },
    ];
    const ciRuns: any[] = [];
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => 'ghp_x', fetchDeployRuns: async () => runs, fetchCiRuns: async () => ciRuns });
    expect(r.alerts).toBe(1); // only the failed run alerts
    // both successful runs are stamped once — meta.at = the run's conclusion time
    const stamped = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'deploy_wave_success');
    expect(stamped.map((c) => c[0].meta.runId)).toEqual([41, 40]); // newest first
    expect(stamped[0][0].meta).toMatchObject({ runId: 41, sha: '3b4375b7', at: NOW.toISOString() });
    // the Redis seen-keys dedupe: a second sweep over the same runs stamps nothing new
    mockRecordLoopMetric.mockClear();
    await sweepInfraWatch({ now: new Date(NOW.getTime() + 60_000), enqueueDirectWake: wake, getGithubToken: async () => 'ghp_x', fetchDeployRuns: async () => runs, fetchCiRuns: async () => ciRuns });
    expect(mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'deploy_wave_success')).toHaveLength(0);
  });

  it('owner-click cost: the sweep files the card-class ticket through the seam and the wake + infra_alert meta cite its id (WI-Q)', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    const filer = jest.fn(async (_o: any) => ({ id: 'ticket-777' }));
    mockPrisma.pendingConfirmation.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.userId === 'owner-1') return [1, 2, 3].map(() => ({ tool: 'send_chat_message' })).concat([{ tool: 'set_chat_autonomy' }]);
      return [];
    });
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null, fileCardTicket: filer });
    expect(r.alerts).toBe(1);
    expect(filer).toHaveBeenCalledTimes(1);
    expect(filer.mock.calls[0][0]).toMatchObject({ userId: 'owner-1', title: 'Card class: send_chat_message staged 3×/day — candidate for a card-free path' });
    const prompt = String(wake.mock.calls[0][0].prompt);
    expect(prompt).toContain('[INFRA ALERT — owner-click cost] 4 confirmation cards');
    expect(prompt).toContain('send_chat_message → ticket ticket-777');
    expect(wake.mock.calls[0][0].meta).toMatchObject({ kind: 'cards', tickets: [{ tool: 'send_chat_message', ticketId: 'ticket-777', filed: true }] });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_alert', meta: expect.objectContaining({ tickets: [{ tool: 'send_chat_message', ticketId: 'ticket-777', filed: true }] }) }));
    // the daily digest key dedupes the next sweep entirely (no second filing, no second wake)
    await sweepInfraWatch({ now: new Date(NOW.getTime() + 3600_000), enqueueDirectWake: wake, getGithubToken: async () => null, fileCardTicket: filer });
    expect(filer).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('abd733af (6d19f11f finding 2a, sweep-level): an actionable card day whose wake enqueue FAILS stamps NO 26h digest key — the next sweep re-attempts, and only a DELIVERED digest stamps it', async () => {
    // SWEEP-LEVEL pin (review round 1b finding 1): the caller-side ordering —
    // CARD_DIGEST_KEY set only after deliver() returns delivered>0 — was
    // previously unpinned (deliver()'s own half is pinned in
    // abd733af.sibling-wake-seams.test.ts); reverting this block to the
    // pre-fix shape (dkey stamped before deliver()) passed every suite.
    // Three token-less sweeps in a row would ALSO raise the DEPLOY-WATCH-BLIND
    // alarm (pinned in its own describe below) — this test counts card wakes only.
    process.env.INFRA_WATCH_BLIND_ALARM_DISABLED = '1';
    const wake = jest.fn(async (_o: any) => ({ ok: false, error: 'target chat not found' }));
    const filer = jest.fn(async (_o: any) => ({ id: 'ticket-901' }));
    mockPrisma.pendingConfirmation.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.userId === 'owner-1') return [1, 2, 3].map(() => ({ tool: 'send_chat_message' }));
      return [];
    });
    const dkey = `infra-watch:cards:owner-1:${NOW.toISOString().slice(0, 10)}`;
    const r1 = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null, fileCardTicket: filer });
    expect(r1.alerts).toBe(0); // the card digest did NOT deliver
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].meta).toMatchObject({ kind: 'cards' });
    // THE SEAM: pre-fix stamped dkey BEFORE deliver(), so the failed wake was never retried that day
    expect(redisStore.has(dkey)).toBe(false);
    // the enqueue failure is evidenced, not silenced
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_alert', sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'cards', outcome: 'enqueue_failed' }) }));
    // second sweep, wake recovered: the SAME actionable day retries (NX week claim held — no duplicate ticket) and only then stamps the day key
    const healthy = jest.fn(async (_o: any) => ({ ok: true, hookEventId: 'he-1' }));
    const r2 = await sweepInfraWatch({ now: NOW, enqueueDirectWake: healthy, getGithubToken: async () => null, fileCardTicket: filer });
    expect(r2.alerts).toBe(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(healthy.mock.calls[0][0].meta).toMatchObject({ kind: 'cards' });
    expect(filer).toHaveBeenCalledTimes(1);
    expect(redisStore.has(dkey)).toBe(true);
    // third sweep: the delivered digest dedupes the rest of the day
    const r3 = await sweepInfraWatch({ now: new Date(NOW.getTime() + 3600_000), enqueueDirectWake: healthy, getGithubToken: async () => null, fileCardTicket: filer });
    expect(r3.alerts).toBe(0);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('abd733af: a NOT-actionable card day still stamps the 26h digest key (skip-key semantics — no per-sweep row-fetch churn) and wakes nobody', async () => {
    const wake = jest.fn(async (_o: any) => ({ ok: true }));
    let cardFetches = 0;
    mockPrisma.pendingConfirmation.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.userId === 'owner-1') { cardFetches++; return [{ tool: 'send_chat_message' }, { tool: 'notify_user' }]; } // 2 cards < threshold 3
      return [];
    });
    const dkey = `infra-watch:cards:owner-1:${NOW.toISOString().slice(0, 10)}`;
    const r1 = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(r1.alerts).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(redisStore.has(dkey)).toBe(true); // stamped on the not-actionable DECISION
    expect(cardFetches).toBeGreaterThan(0); // non-vacuous: the card pass actually ran
    const after = cardFetches;
    await sweepInfraWatch({ now: new Date(NOW.getTime() + 60_000), enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(cardFetches).toBe(after); // the skip key holds: no second row fetch
  });

  it('owner-click cost is scoped to the OWNER\'S cards — another account\'s staged cards never count (10395cc6)', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    // The exact 2026-09-26 false-alarm shape: the owner staged 3 cards, OTHER
    // accounts staged pause_schedule ×3 / stop_run ×1 / send_chat_message ×1 —
    // the old GLOBAL loop_metrics read counted 8 and filed a pause_schedule
    // card-class ticket against the owner.
    mockPrisma.pendingConfirmation.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.userId !== 'owner-1') return [];
      return [
        { tool: 'start_coding_session' }, { tool: 'start_coding_session' }, { tool: 'set_chat_autonomy' },
      ];
    });
    // Foreign rows in loop_metrics must be invisible to the digest: they only
    // exist in the metric stream, never in the owner's pending_confirmations.
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.kind === 'confirmation_staged') {
        return [
          { meta: { tool: 'pause_schedule', machine: false } }, { meta: { tool: 'pause_schedule', machine: false } }, { meta: { tool: 'pause_schedule', machine: false } },
          { meta: { tool: 'stop_run', machine: false } }, { meta: { tool: 'send_chat_message', machine: false } },
          { meta: { tool: 'start_coding_session' } }, { meta: { tool: 'start_coding_session' } }, { meta: { tool: 'set_chat_autonomy' } },
        ];
      }
      return [];
    });
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null, fileCardTicket: jest.fn(async () => null) });
    // 3 owner cards = below CARD_COST_DAILY_THRESHOLD (3) is "at" threshold...
    // threshold is ">= 3" so 3 counts — but the digest names ONLY the owner's
    // tools (start_coding_session ×2 + set_chat_autonomy ×1 = 3), never
    // pause_schedule. No tool reaches the per-tool ticket minimum of 3.
    expect(r.alerts).toBe(1);
    const prompt = String(wake.mock.calls[0][0].prompt);
    expect(prompt).toContain('[INFRA ALERT — owner-click cost] 3 confirmation cards');
    expect(prompt).not.toContain('pause_schedule');
    expect(prompt).not.toContain('stop_run');
    // per-tool ticket minimum (default 3): neither owner tool hit 3 → no ticket
    expect(prompt).not.toContain('→ ticket');
  });

  it('ownerStagedCardRows: fallback reads the owner\'s chat ids when no pending cards survive (deleted-chat cards stay counted)', async () => {
    // pendingConfirmation empty (chat deleted) → the loop_metrics fallback keys
    // on the owner's OWN chat ids; a foreign session's rows never match.
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.userId === 'owner-1') return [{ id: 'chat-owner-1' }, { id: 'chat-owner-2' }];
      return [];
    });
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.kind === 'confirmation_staged') {
        const allowed: string[] = where?.sessionId?.in ?? [];
        expect(allowed).toEqual(['chat-owner-1', 'chat-owner-2']); // scoped, never unscoped
        return [
          { meta: { tool: 'pause_schedule' } }, { meta: { tool: 'pause_schedule' } }, { meta: { tool: 'pause_schedule' } },
        ];
      }
      return [];
    });
    const rows = await ownerStagedCardRows('owner-1', NOW);
    expect(rows).toEqual([{ tool: 'pause_schedule' }, { tool: 'pause_schedule' }, { tool: 'pause_schedule' }]);
    // NO owner chats at all → empty, and never an unscoped IN () query
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    expect(await ownerStagedCardRows('owner-1', NOW)).toEqual([]);
  });

  it('kill switch and no admin fleet supervisor → no reads, no wakes', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    process.env.INFRA_WATCH_DISABLED = '1';
    expect(await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake })).toEqual({ alerts: 0 });
    delete process.env.INFRA_WATCH_DISABLED;
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    expect(await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake })).toEqual({ alerts: 0 });
    expect(wake).not.toHaveBeenCalled();
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// deliver() is the ONE seam every infra / product alert wake goes through: while
// the Fleet Supervisor is switched off it delivers nothing, sets NO dedupe key
// (a still-true alert fires the moment the switch is back on) and records one
// supervisor_switch skip per target naming the alert kind.
import { deliver } from './infra-watch.service';
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from '../platform/supervisor-switch';

describe('supervisor OFF switch × deliver()', () => {
  const targets = [{ id: 'fleet-sup-1', userId: 'owner-1' }, { id: 'fleet-sup-2', userId: 'owner-2' }];
  const switchRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'supervisor_switch');
  beforeEach(() => {
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  });
  afterAll(() => { mockPrisma.systemSetting.findUnique.mockResolvedValue(null); invalidateSupervisorSwitchCache(); });

  it('fleet OFF: no wake, no dedupe key, one skip row per target (source alert:<kind>); ON again: the SAME alert delivers and dedupes', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: NOW } : null));
    invalidateSupervisorSwitchCache();
    const wake = jest.fn(async () => ({ ok: true }));
    expect(await deliver(targets, 'infra-watch:alert:disk:box-a:crit', 3600, '[INFRA ALERT — disk]', { kind: 'disk' }, wake as any)).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(redisStore.has('infra-watch:alert:disk:box-a:crit')).toBe(false);
    expect(switchRows()).toEqual([
      expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'alert:infra_alert', chatId: 'fleet-sup-1' }) }),
      expect.objectContaining({ sessionId: 'fleet-sup-2', meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'alert:infra_alert', chatId: 'fleet-sup-2' }) }),
    ]);
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.kind === 'infra_alert')).toBe(false);

    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
    expect(await deliver(targets, 'infra-watch:alert:disk:box-a:crit', 3600, '[INFRA ALERT — disk]', { kind: 'disk' }, wake as any)).toBe(2);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(redisStore.has('infra-watch:alert:disk:box-a:crit')).toBe(true);
  });

  it('a product-watch delivery names its own metric kind in the skip source; a switch read error fails open', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: 'off', updatedAt: NOW } : null));
    invalidateSupervisorSwitchCache();
    const wake = jest.fn(async () => ({ ok: true }));
    expect(await deliver(targets.slice(0, 1), 'product-watch:x', 3600, '[PRODUCT ALERT]', { kind: 'chips' }, wake as any, 'product_alert')).toBe(0);
    expect(switchRows()[0].meta.source).toBe('alert:product_alert');

    mockPrisma.systemSetting.findUnique.mockRejectedValue(new Error('db down'));
    invalidateSupervisorSwitchCache();
    expect(await deliver(targets.slice(0, 1), 'product-watch:y', 3600, '[PRODUCT ALERT]', { kind: 'chips' }, wake as any, 'product_alert')).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

// ── Enqueue failure contract (ticket 6d19f11f) ────────────────────────────────
// enqueueDirectWake reports failure as { ok: false } instead of throwing
// (hooks.service enqueueDirectWake: target chat gone, outbox write failed, …),
// and deliver() NEVER read that return: a failed wake still set the dedupe key
// (INFRA_ALERT_DEDUPE_SEC = 6 h) and wrote a delivered-looking metrics row —
// the alert was silenced for the whole window without ever landing. These pin
// the contract on every failure shape at the seam, on both metric kinds.
describe('deliver() enqueue failure contract (6d19f11f)', () => {
  const targets = [{ id: 'fleet-sup-1', userId: 'owner-1' }, { id: 'fleet-sup-2', userId: 'owner-2' }];
  const rows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    redisStore.clear();
    mockRecordLoopMetric.mockClear();
  });

  it('a { ok: false } return is NOT delivered: no dedupe key, no delivered metrics row, an enqueue_failed row naming the error, and the SAME alert fires again on the next pass', async () => {
    const wake = jest.fn(async (_o?: any): Promise<any> => ({ ok: false, error: 'target chat not found' }));
    expect(await deliver(targets, 'infra-watch:alert:disk:box-a:crit', 6 * 3600, '[INFRA ALERT — disk]', { kind: 'disk', host: 'box-a' }, wake as any)).toBe(0);
    expect(wake).toHaveBeenCalledTimes(2);
    // NOT delivered ⇒ the dedupe key stays unset, so the next sweep retries…
    expect(redisStore.has('infra-watch:alert:disk:box-a:crit')).toBe(false);
    // …and the failure is recorded as such — one row per target, distinguishable
    // from a delivered row by meta.outcome, and never counted as one.
    expect(rows().filter((m) => m?.kind === 'infra_alert')).toEqual([
      expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'disk', host: 'box-a', outcome: 'enqueue_failed', error: 'target chat not found' }) }),
      expect.objectContaining({ sessionId: 'fleet-sup-2', meta: expect.objectContaining({ kind: 'disk', host: 'box-a', outcome: 'enqueue_failed', error: 'target chat not found' }) }),
    ]);
    expect(rows().some((m) => m?.kind === 'infra_alert' && !m.meta?.outcome)).toBe(false);
    // Retry: the same alert, still true, delivers the moment the enqueue works —
    // the pre-fix code had already set the key and would return 0 for 6 h.
    wake.mockImplementation(async () => ({ ok: true }));
    expect(await deliver(targets, 'infra-watch:alert:disk:box-a:crit', 6 * 3600, '[INFRA ALERT — disk]', { kind: 'disk', host: 'box-a' }, wake as any)).toBe(2);
    expect(redisStore.has('infra-watch:alert:disk:box-a:crit')).toBe(true);
    expect(rows().some((m) => m?.kind === 'infra_alert' && m.sessionId === 'fleet-sup-1' && !m.meta?.outcome)).toBe(true);
  });

  it('a THROWN enqueue failure is the same not-delivered class: no key, failure row, next pass retries', async () => {
    const wake = jest.fn(async (_o?: any): Promise<any> => { throw new Error('redis outbox down'); });
    expect(await deliver(targets.slice(0, 1), 'infra-watch:alert:backup:box-b:warn', 6 * 3600, '[INFRA ALERT — backup]', { kind: 'backup' }, wake as any)).toBe(0);
    expect(redisStore.has('infra-watch:alert:backup:box-b:warn')).toBe(false);
    expect(rows().filter((m) => m?.kind === 'infra_alert')).toEqual([
      expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'backup', outcome: 'enqueue_failed', error: 'redis outbox down' }) }),
    ]);
    wake.mockImplementation(async () => ({ ok: true }));
    expect(await deliver(targets.slice(0, 1), 'infra-watch:alert:backup:box-b:warn', 6 * 3600, '[INFRA ALERT — backup]', { kind: 'backup' }, wake as any)).toBe(1);
  });

  it('a thrown failure NEVER takes the delivered count with it: all targets fail, some throw and some return not-ok', async () => {
    const wake = jest.fn(async (o: any) => (o.targetChatId === 'fleet-sup-1' ? { ok: false, error: 'queue full' } : Promise.reject(new Error('boom'))));
    expect(await deliver(targets, 'infra-watch:alert:disk:box-c:crit', 6 * 3600, '[INFRA ALERT — disk]', { kind: 'disk' }, wake as any)).toBe(0);
    expect(redisStore.has('infra-watch:alert:disk:box-c:crit')).toBe(false);
    expect(rows().filter((m) => m?.kind === 'infra_alert')).toHaveLength(2);
    expect(rows().every((m) => m?.kind !== 'infra_alert' || m.meta?.outcome === 'enqueue_failed')).toBe(true);
  });

  it('a partial failure (one target ok, one not) sets the dedupe key — the alert landed where it could; the failed half is NOT retried while the key holds', async () => {
    const wake = jest.fn(async (o: any) => (o.targetChatId === 'fleet-sup-1' ? { ok: true, hookEventId: 'he-1' } : { ok: false, error: 'target chat not found' }));
    expect(await deliver(targets, 'infra-watch:alert:silent:box-d:crit', 6 * 3600, '[INFRA ALERT — silent]', { kind: 'silent' }, wake as any)).toBe(1);
    // At least one real delivery ⇒ the dedupe key holds (the alert landed where
    // it could; deliver() early-returns on the key, so the failed target waits
    // out the window — a partial delivery beats silencing everyone).
    expect(redisStore.has('infra-watch:alert:silent:box-d:crit')).toBe(true);
    const metricRows = rows().filter((m) => m?.kind === 'infra_alert');
    expect(metricRows).toEqual([
      expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'silent' }) }), // delivered: no outcome
      expect.objectContaining({ sessionId: 'fleet-sup-2', meta: expect.objectContaining({ kind: 'silent', outcome: 'enqueue_failed' }) }),
    ]);
  });

  it('a legacy wake seam with NO return value still counts as delivered (undefined ≠ { ok: false }) — no false-negative on the old contract', async () => {
    const wake = jest.fn(async () => undefined);
    expect(await deliver(targets.slice(0, 1), 'product-watch:chips', 3600, '[PRODUCT ALERT]', { kind: 'chips' }, wake as any, 'product_alert')).toBe(1);
    expect(redisStore.has('product-watch:chips')).toBe(true);
    expect(rows().some((m) => m?.kind === 'product_alert' && m.meta?.outcome === 'enqueue_failed')).toBe(false);
  });

  it('the failure contract carries the caller metric kind too (product_alert / log_signal callers share deliver())', async () => {
    const wake = jest.fn(async () => ({ ok: false, error: 'target chat not found' }));
    expect(await deliver(targets.slice(0, 1), 'product-watch:chips2', 3600, '[PRODUCT ALERT]', { kind: 'chips' }, wake as any, 'product_alert')).toBe(0);
    expect(redisStore.has('product-watch:chips2')).toBe(false);
    expect(rows().filter((m) => m?.kind === 'product_alert')).toEqual([
      expect.objectContaining({ sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'chips', outcome: 'enqueue_failed' }) }),
    ]);
  });
});

/** audit budgets-cost-6 (2026-09-26): a decision backend that answered 401/403 (revoked / exhausted key) — the gate's
 *  direct alert, the sweep's re-read of the same rows under the SAME dedupe key, the renderers, and the kill switch. */
describe('decision backend down (audit budgets-cost-6)', () => {
  const latched = { event: 'latched' as const, purpose: 'sweep_triage', at: '2026-09-26T06:34:55.000Z', spec: 'jev', backend: 'TypeSafe Jev', status: 403, cooldownMs: 90_000 };

  it('renders the latched alert with the backend, the status, the act purposes at stake, the key hint, the boxes-tile playbook and the recovered verify step; the all-failed alert names the streak and the leg errors', () => {
    const text = renderDecisionBackendDownAlert(latched, NOW);
    expect(text).toContain('[INFRA ALERT — decision backend down] TypeSafe Jev (spec jev) answered HTTP 403');
    expect(text).toContain('TYPESAFE_API_KEY');
    expect(text).toContain('LATCHED it for 90 s');
    expect(text).toContain("get_fleet_telemetry view 'boxes'");
    expect(text).toContain("decisionGate");
    expect(text).toContain("kind 'decision_gate_backend_down'");
    expect(text).toContain("'recovered' event");
    expect(text).toContain('sweep_triage, wake_triage, auto_route, drain_triage, imessage_send');
    const all = renderDecisionBackendDownAlert({ event: 'all_legs_failed', purpose: 'auto_route', at: NOW.toISOString(), legErrors: ['TypeSafe Jev: timeout', 'DeepSeek logprob readout: HTTP 502'], streak: 3 }, NOW);
    expect(all).toContain('[INFRA ALERT — decision gate: every backend failing] 3+ decision-gate asks');
    expect(all).toContain('TypeSafe Jev: timeout | DeepSeek logprob readout: HTTP 502');
    expect(all).toContain('fail-open');
  });

  it('alertDecisionBackendDown wakes the admin fleet supervisor once per (spec, status) and records infra_alert; a second call inside the dedupe window is a no-op; INFRA_WATCH_DISABLED delivers nothing', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    expect(await alertDecisionBackendDown(latched, { now: NOW, enqueueDirectWake: wake })).toBe(1);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ targetChatId: 'fleet-sup-1', prompt: expect.stringContaining('[INFRA ALERT — decision backend down] TypeSafe Jev') }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_alert', sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'decision_backend', event: 'latched', spec: 'jev', status: 403, purpose: 'sweep_triage' }) }));
    expect(await alertDecisionBackendDown({ ...latched, purpose: 'wake_triage', at: '2026-09-26T06:36:00.000Z' }, { now: NOW, enqueueDirectWake: wake })).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
    // A different status is a different episode class.
    expect(await alertDecisionBackendDown({ ...latched, status: 401 }, { now: NOW, enqueueDirectWake: wake })).toBe(1);
    process.env.INFRA_WATCH_DISABLED = '1';
    expect(await alertDecisionBackendDown({ ...latched, spec: 'deepseek-flash', backend: 'DeepSeek logprob readout' }, { now: NOW, enqueueDirectWake: wake })).toBe(0);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('selectDecisionBackendDownAlerts: the newest latched/relatched row per (spec, status) unless a later recovered row closed it; the streak alert at ≥ 3 all_legs_failed rows; unknown rows ignored', () => {
    const t = (s: number) => new Date(NOW.getTime() - s * 1000);
    const rows = [
      { createdAt: t(600), meta: { event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'sweep_triage', cooldownMs: 90_000 } },
      { createdAt: t(500), meta: { event: 'relatched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'wake_triage', cooldownMs: 90_000, relatches: 1 } },
      // A recovered readout episode: never alerted.
      { createdAt: t(400), meta: { event: 'latched', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', status: 401, purpose: 'auto_route' } },
      { createdAt: t(300), meta: { event: 'recovered', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', status: 401, purpose: 'auto_route', downMs: 100_000 } },
      { createdAt: t(200), meta: { event: 'all_legs_failed', purpose: 'drain_triage', legErrors: ['TypeSafe Jev: timeout'], streak: 1 } },
      { createdAt: t(100), meta: { event: 'all_legs_failed', purpose: 'drain_triage', legErrors: ['TypeSafe Jev: timeout'], streak: 2 } },
      { createdAt: t(50), meta: { host: 'box-a', diskPct: 10 } }, // not ours
    ];
    const two = selectDecisionBackendDownAlerts(rows);
    expect(two).toEqual([expect.objectContaining({ event: 'latched', spec: 'jev', status: 403, purpose: 'wake_triage', at: t(500).toISOString() })]);
    const three = selectDecisionBackendDownAlerts([...rows, { createdAt: t(10), meta: { event: 'all_legs_failed', purpose: 'auto_route', legErrors: ['TypeSafe Jev: timeout', 'DeepSeek logprob readout: timeout'], streak: 3 } }]);
    expect(three.map((a) => a.event)).toEqual(['latched', 'all_legs_failed']);
    expect(three[1]).toMatchObject({ purpose: 'auto_route', streak: 3, legErrors: ['TypeSafe Jev: timeout', 'DeepSeek logprob readout: timeout'] });
  });

  it('ticket 4d476b9a: all_legs_failed rows decide() attributed to an event-loop STALL never make the sweep alert; an egress streak does and names its cause; the kill switch counts stall rows again', () => {
    const t = (s: number) => new Date(NOW.getTime() - s * 1000);
    // Round 2: a stall row carries the confirming evidence decide() measured (legTimings, every timeout stallConfirmed).
    const confirmed = [{ backend: 'TypeSafe Jev', attempt: 1, failure: 'timeout', budgetMs: 595, lateMs: 300, wireLateMs: 300, stall: true, stallConfirmed: true }];
    const row = (s: number, cause?: string, legTimings?: any[]) => ({ createdAt: t(s), meta: { event: 'all_legs_failed', purpose: 'turn_plan', legErrors: ['TypeSafe Jev: timeout timeout of 595ms exceeded [loop stall: 300 ms late]'], streak: 0, ...(cause ? { cause } : {}), ...(legTimings ? { legTimings } : cause === 'stall' ? { legTimings: confirmed } : {}) } });
    const stallBurst = [row(300, 'stall'), row(200, 'stall'), row(100, 'stall'), row(50, 'stall')];
    expect(selectDecisionBackendDownAlerts(stallBurst)).toEqual([]);
    // Round 2: the sweep re-checks the evidence on the row — a cause-'stall' row whose timeouts were only cheaply late
    // (a 60 ms-late timer on a free loop: a hung backend), or that carries no legTimings at all, COUNTS.
    const cheap = [{ backend: 'TypeSafe Jev', attempt: 1, failure: 'timeout', budgetMs: 2000, lateMs: 60, wireLateMs: 60, stall: true, stallConfirmed: false }];
    expect(selectDecisionBackendDownAlerts([row(30, 'stall', cheap), row(20, 'stall', []), row(10, 'stall', cheap)])).toEqual([expect.objectContaining({ event: 'all_legs_failed', streak: 3, cause: 'stall' })]);
    // Two egress rows next to the stall burst: still under the 3-row bar.
    expect(selectDecisionBackendDownAlerts([...stallBurst, row(40, 'egress'), row(30, 'egress')])).toEqual([]);
    const egress = selectDecisionBackendDownAlerts([...stallBurst, row(40, 'egress'), row(30, 'mixed'), row(20, 'egress')]);
    expect(egress).toEqual([expect.objectContaining({ event: 'all_legs_failed', streak: 3, cause: 'egress', at: t(20).toISOString() })]);
    expect(renderDecisionBackendDownAlert(egress[0], NOW)).toContain('Measured cause of the latest: egress or provider latency (every leg timed out; no timeout was a confirmed event-loop stall).');
    // A pre-change row (no cause) still counts and renders without a cause clause.
    const legacy = selectDecisionBackendDownAlerts([row(30), row(20), row(10)]);
    expect(legacy[0].cause).toBeUndefined();
    expect(renderDecisionBackendDownAlert(legacy[0], NOW)).not.toContain('Measured cause');
    // An unknown cause string is not carried into the alert.
    expect(selectDecisionBackendDownAlerts([row(30, 'egress'), row(20, 'egress'), row(10, 'solar-flare')])[0].cause).toBeUndefined();
    const prev = process.env.DECISION_GATE_STALL_RECOVERY_DISABLED;
    process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = '1';
    try {
      expect(selectDecisionBackendDownAlerts(stallBurst)).toEqual([expect.objectContaining({ event: 'all_legs_failed', streak: 4 })]);
    } finally {
      if (prev === undefined) delete process.env.DECISION_GATE_STALL_RECOVERY_DISABLED; else process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = prev;
    }
  });

  it('the sweep re-reads the decision_gate_backend_down rows and delivers under the SAME dedupe key as the direct alert (a landed direct alert makes the sweep a no-op; a lost one is caught within a tick)', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.kind === DECISION_BACKEND_DOWN_KIND) return [{ createdAt: new Date(NOW.getTime() - 120_000), meta: { event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'sweep_triage', cooldownMs: 90_000 } }];
      return [];
    });
    const first = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(first.alerts).toBe(1);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('[INFRA ALERT — decision backend down] TypeSafe Jev (spec jev) answered HTTP 403') }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_alert', meta: expect.objectContaining({ kind: 'decision_backend', viaSweep: true }) }));
    // The direct path was already delivered → the sweep's key is taken → nothing more.
    expect(await alertDecisionBackendDown({ event: 'latched', purpose: 'sweep_triage', at: NOW.toISOString(), spec: 'jev', backend: 'TypeSafe Jev', status: 403 }, { now: NOW, enqueueDirectWake: wake })).toBe(0);
    const second = await sweepInfraWatch({ now: new Date(NOW.getTime() + 60_000), enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(second.alerts).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

// ── DEPLOY-WATCH-BLIND (2026-10-20) ───────────────────────────────────────────
// Prod: 0 deploy_wave_success rows over 10-17..10-20 against 110 green + 10 red
// deploy.yml runs. The sweep read ONE token — targets[0] of an UNORDERED
// take:10 — whose owner had no usable GitHub account (getValidToken warned 73×
// on 10-18), skipped silently on null, and the run fetchers returned [] on any
// non-200: "cannot read" looked exactly like "no runs", with no signal.
import {
  probeDeployWatchToken,
  recordDeployWatchBlind,
  clearDeployWatchBlind,
  readDeployWatchBlindState,
  renderDeployWatchBlindAlert,
  deployWatchBlindReason,
  fetchDeployRunsWithStatus,
  fetchCiRunsWithStatus,
  fetchDeployRuns,
  adminFleetSupervisors,
  DEPLOY_WATCH_BLIND_ALARM_AFTER,
  type WorkflowRunsFetch,
} from './infra-watch.service';

describe('DEPLOY-WATCH-BLIND — token iteration (probeDeployWatchToken)', () => {
  const ok = (runs: any[] = []): WorkflowRunsFetch => ({ runs, status: 200 });
  const refused = (status: number): WorkflowRunsFetch => ({ runs: [], status });

  it('the first owner token answers 401, the second answers 200 ⇒ the sweep reads with the second (its runs ARE the probe — one read, not two)', async () => {
    const runs = [{ id: 7, conclusion: 'success' }];
    const fetchRuns = jest.fn(async (t: string) => (t === 'tok-owner-1' ? refused(401) : ok(runs)));
    const getToken = jest.fn(async (u: string) => `tok-${u}`);
    const p = await probeDeployWatchToken({ envToken: null, userIds: ['owner-1', 'owner-2'], getToken, fetchRuns });
    expect(p).toMatchObject({ token: 'tok-owner-2', runs, source: 'user:owner-2', reason: null, tried: 2, failures: ['user:owner-1:http_401'] });
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });

  it('the env token (INFRA_WATCH_GITHUB_TOKEN) is preferred: when it reads, no owner token is ever requested', async () => {
    const getToken = jest.fn(async (u: string) => `tok-${u}`);
    const fetchRuns = jest.fn(async () => ok());
    const p = await probeDeployWatchToken({ envToken: ' ghp_env ', userIds: ['owner-1'], getToken, fetchRuns });
    expect(p).toMatchObject({ token: 'ghp_env', source: 'env', tried: 1 });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('a refused env token falls back to the owners\' tokens; its failure is the reported reason when nothing reads', async () => {
    const fetchRuns = jest.fn(async (t: string) => (t === 'ghp_env' ? refused(403) : t === 'tok-owner-1' ? refused(401) : ok()));
    const hit = await probeDeployWatchToken({ envToken: 'ghp_env', userIds: ['owner-1', 'owner-2'], getToken: async (u) => `tok-${u}`, fetchRuns });
    expect(hit).toMatchObject({ token: 'tok-owner-2', failures: ['env:http_403', 'user:owner-1:http_401'] });
    const blind = await probeDeployWatchToken({ envToken: 'ghp_env', userIds: ['owner-1'], getToken: async (u) => `tok-${u}`, fetchRuns: async (t) => (t === 'ghp_env' ? refused(403) : refused(401)) });
    expect(blind).toMatchObject({ token: null, reason: 'http_403', tried: 2, failures: ['env:http_403', 'user:owner-1:http_401'] });
  });

  it('no token anywhere ⇒ no_token (nothing fetched); a thrown fetch / getToken reads as network / no token, never a throw', async () => {
    const fetchRuns = jest.fn(async () => ok());
    expect(await probeDeployWatchToken({ userIds: ['owner-1', 'owner-1', ''], getToken: async () => null, fetchRuns })).toMatchObject({ token: null, reason: 'no_token', tried: 0, failures: [] });
    expect(fetchRuns).not.toHaveBeenCalled();
    const boom = await probeDeployWatchToken({ userIds: ['owner-1', 'owner-2'], getToken: async (u) => { if (u === 'owner-1') throw new Error('db down'); return 'tok-2'; }, fetchRuns: async () => { throw new Error('ECONNRESET'); } });
    expect(boom).toMatchObject({ token: null, reason: 'network', tried: 1, failures: ['user:owner-2:network'] });
    // the same token held by two owners is probed once
    const dup = jest.fn(async () => refused(401));
    await probeDeployWatchToken({ userIds: ['owner-1', 'owner-2'], getToken: async () => 'shared', fetchRuns: dup });
    expect(dup).toHaveBeenCalledTimes(1);
  });

  it('a non-prod instance with no INFRA_WATCH_REPO (repo \'\') is "nothing to watch" — skipped, never blind, no token read', async () => {
    const getToken = jest.fn(async () => 'tok');
    const p = await probeDeployWatchToken({ repo: '', userIds: ['owner-1'], getToken, fetchRuns: async () => ok() });
    expect(p).toMatchObject({ token: null, reason: null, skipped: 'no_repo', tried: 0 });
    expect(getToken).not.toHaveBeenCalled();
    // the fetcher's own no_repo answer is honoured too
    expect(await probeDeployWatchToken({ userIds: ['owner-1'], getToken, fetchRuns: async () => ({ runs: [], status: null, skipped: 'no_repo' }) })).toMatchObject({ skipped: 'no_repo', reason: null });
  });

  it('deployWatchBlindReason names the status (null = no response)', () => {
    expect(deployWatchBlindReason(null)).toBe('network');
    expect(deployWatchBlindReason(401)).toBe('http_401');
  });
});

describe('DEPLOY-WATCH-BLIND — the status-carrying fetchers', () => {
  const swap = async (impl: any, fn: () => Promise<void>) => {
    const hermetic = globalThis.fetch;
    globalThis.fetch = impl;
    try { await fn(); } finally { globalThis.fetch = hermetic; }
  };
  it('a non-200 keeps its status (the [] wrappers still return []); a thrown fetch is status null', async () => {
    await swap(jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })), async () => {
      expect(await fetchDeployRunsWithStatus('tok')).toEqual({ runs: [], status: 404 });
      expect(await fetchCiRunsWithStatus('tok')).toEqual({ runs: [], status: 404 });
      expect(await fetchDeployRuns('tok')).toEqual([]);
    });
    await swap(jest.fn(async () => { throw new Error('aborted'); }), async () => {
      expect(await fetchDeployRunsWithStatus('tok')).toEqual({ runs: [], status: null });
    });
    await swap(jest.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 1, url }] }) })), async () => {
      const r = await fetchDeployRunsWithStatus('tok', { status: 'completed' });
      expect(r.status).toBe(200);
      expect(r.runs[0].url).toContain('/actions/workflows/deploy.yml/runs?per_page=8&status=completed');
    });
  });
});

describe('DEPLOY-WATCH-BLIND — the sweep', () => {
  const blindRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'infra_watch_blind');
  const blindWakes = (wake: jest.Mock) => wake.mock.calls.filter((c: any[]) => c[0]?.meta?.kind === 'deploy_watch_blind');
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

  it('adminFleetSupervisors reads in a STABLE order (oldest supervisor first) — the sweep no longer depends on the planner', async () => {
    await adminFleetSupervisors();
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'asc' }, take: 10 }));
  });

  it('the first owner\'s token is refused, the second owner\'s reads ⇒ the deploy failure alerts and no blind row lands', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'fleet-sup-1', userId: 'owner-1' }, { id: 'fleet-sup-2', userId: 'owner-2' }]);
    const wake = jest.fn(async (_o: any) => ({}));
    const runs = [{ id: 42, conclusion: 'failure', head_sha: 'b40b4869abc', html_url: 'u', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), display_title: 't' }];
    const fetchRunsWithStatus = jest.fn(async (t: string) => (t === 'tok-owner-1' ? { runs: [], status: 401 } : { runs, status: 200 }));
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, envGithubToken: null, getGithubToken: async (u) => `tok-${u}`, fetchDeployRunsWithStatus: fetchRunsWithStatus, fetchCiRuns: async () => [] });
    expect(r.alerts).toBe(2); // one deploy-failure wake per fleet supervisor
    expect(wake.mock.calls[0][0].prompt).toContain('deploy run 42');
    expect(blindRows()).toHaveLength(0);
  });

  it('every credential refused ⇒ one infra_watch_blind row per sweep, ONE alarm at the 3rd consecutive sweep, deduped for 24 h; a seeing sweep ends the episode', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    const deps = { enqueueDirectWake: wake, envGithubToken: 'ghp_env', getGithubToken: async () => 'tok-owner-1', fetchDeployRunsWithStatus: async (t: string) => ({ runs: [], status: t === 'ghp_env' ? 401 : 403 }), fetchCiRuns: async () => [] };
    for (let i = 0; i < DEPLOY_WATCH_BLIND_ALARM_AFTER - 1; i++) {
      expect((await sweepInfraWatch({ ...deps, now: at(i * 15) })).alerts).toBe(0);
    }
    expect(blindWakes(wake)).toHaveLength(0);
    expect(blindRows().map((m) => m.meta.consecutive)).toEqual([1, 2]);
    expect(blindRows()[0].meta).toMatchObject({ reason: 'http_401', tried: 2, failures: ['env:http_401', 'user:owner-1:http_403'], since: NOW.toISOString() });
    const third = await sweepInfraWatch({ ...deps, now: at(30) });
    expect(third.alerts).toBe(1);
    expect(blindWakes(wake)).toHaveLength(1);
    const prompt = String(blindWakes(wake)[0][0].prompt);
    expect(prompt).toContain(`deploy watch blind: http_401 since ${NOW.toISOString()}`);
    expect(prompt).toContain('INFRA_WATCH_GITHUB_TOKEN');
    expect(prompt).not.toContain('ghp_env'); // never the token itself
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_alert', sessionId: 'fleet-sup-1', meta: expect.objectContaining({ kind: 'deploy_watch_blind', reason: 'http_401', consecutive: 3 }) }));
    // still blind: counted, but the 24 h key holds the alarm
    expect((await sweepInfraWatch({ ...deps, now: at(45) })).alerts).toBe(0);
    expect(blindWakes(wake)).toHaveLength(1);
    expect(await readDeployWatchBlindState()).toMatchObject({ consecutive: 4, since: NOW.toISOString(), reason: 'http_401' });
    // a credential reads again: one 'recovered' row, the episode state is gone
    mockRecordLoopMetric.mockClear();
    await sweepInfraWatch({ ...deps, now: at(60), fetchDeployRunsWithStatus: async () => ({ runs: [], status: 200 }) });
    expect(blindRows()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ outcome: 'recovered', consecutive: 4, source: 'env' }) })]);
    expect(await readDeployWatchBlindState()).toBeNull();
  });

  it('no token anywhere is blind too (reason no_token) — the old silent skip', async () => {
    const wake = jest.fn(async (_o: any) => ({}));
    for (let i = 0; i < DEPLOY_WATCH_BLIND_ALARM_AFTER; i++) await sweepInfraWatch({ now: at(i * 15), enqueueDirectWake: wake, envGithubToken: null, getGithubToken: async () => null });
    expect(blindRows().map((m) => m.meta.reason)).toEqual(['no_token', 'no_token', 'no_token']);
    expect(blindWakes(wake)).toHaveLength(1);
    expect(String(blindWakes(wake)[0][0].prompt)).toContain('deploy watch blind: no_token since');
  });

  it('kill switch INFRA_WATCH_BLIND_ALARM_DISABLED=1: no rows, no count, no alarm — the token iteration still finds a reader', async () => {
    process.env.INFRA_WATCH_BLIND_ALARM_DISABLED = '1';
    const wake = jest.fn(async (_o: any) => ({}));
    for (let i = 0; i < DEPLOY_WATCH_BLIND_ALARM_AFTER + 1; i++) await sweepInfraWatch({ now: at(i * 15), enqueueDirectWake: wake, envGithubToken: null, getGithubToken: async () => null });
    expect(blindRows()).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
    expect(await readDeployWatchBlindState()).toBeNull();
    const runs = [{ id: 43, conclusion: 'failure', head_sha: 'c40b4869abc', html_url: 'u', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), display_title: 't' }];
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'fleet-sup-1', userId: 'owner-1' }, { id: 'fleet-sup-2', userId: 'owner-2' }]);
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, envGithubToken: null, getGithubToken: async (u) => (u === 'owner-1' ? null : 'tok-2'), fetchDeployRunsWithStatus: async () => ({ runs, status: 200 }), fetchCiRuns: async () => [] });
    expect(r.alerts).toBe(2);
  });

  it('recordDeployWatchBlind / clearDeployWatchBlind never throw on a Redis failure; the alert text names reason, since and the playbook', async () => {
    const redis = jest.requireMock('../../../config/redis').default;
    redis.get.mockImplementationOnce(async () => { throw new Error('redis down'); });
    await expect(recordDeployWatchBlind({ reason: 'http_401', tried: 1, failures: [] }, [{ id: 'fleet-sup-1', userId: 'owner-1' }], NOW, jest.fn(async () => ({})))).resolves.toBe(0);
    redis.get.mockImplementationOnce(async () => { throw new Error('redis down'); });
    await expect(clearDeployWatchBlind('env')).resolves.toBeUndefined();
    const text = renderDeployWatchBlindAlert({ consecutive: 3, since: '2026-10-18T02:00:00.000Z', reason: 'no_token' }, NOW, ['user:owner-1:http_401']);
    expect(text).toMatch(/^\[INFRA ALERT — deploy watch blind\] deploy watch blind: no_token since 2026-10-18T02:00:00\.000Z/);
    expect(text).toContain('credentials probed this sweep: user:owner-1:http_401');
    expect(text).toContain('deploy_wave_success');
  });
});

describe('noteDeployWatchSource (2026-10-20): which credential the deploy watch read GitHub with', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { noteDeployWatchSource, resetDeployWatchSourceForTests } = require('./infra-watch.service');
  const rows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'infra_watch_source');
  beforeEach(() => { resetDeployWatchSourceForTests(); mockRecordLoopMetric.mockClear(); });

  it('records the dedicated token once, then nothing while the source stays the same', () => {
    expect(noteDeployWatchSource('env')).toBe(true);
    expect(noteDeployWatchSource('env')).toBe(false);
    expect(rows()).toEqual([{ kind: 'infra_watch_source', meta: { source: 'env', previous: null } }]);
  });

  it('records a change of source, naming an admin account only by its id8', () => {
    noteDeployWatchSource('env');
    expect(noteDeployWatchSource('user:abcd1234')).toBe(true);
    expect(rows()[1]).toEqual({ kind: 'infra_watch_source', meta: { source: 'user', user: 'abcd1234', previous: 'env' } });
  });

  it('a sweep with no credential records nothing', () => {
    expect(noteDeployWatchSource(null)).toBe(false);
    expect(rows()).toEqual([]);
  });
});
