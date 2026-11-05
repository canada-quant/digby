/**
 * PIN (ticket 253636d6, 2026-10-24) — the BACKUP alert class joins the
 * fffacaee stable-key dedup.
 *
 * THE DEFECT THIS PINS: one stale-backup event on box-a (newest dump
 * 2026-10-23T09:01:11.565Z, ageH 30.1) produced TWO agent tickets 9.3 s
 * apart — 437896fb from chat c0e22e36 ("Nightly backup stale on box-a —
 * digby-backup.timer missed last night's dump") and cf047f4a from chat
 * 6061a468 ("Nightly backup stale on box-a — digby-backup.timer skipped
 * last night's dump (30.1 h old)") — because the fffacaee stable-key dedup
 * covers ONLY kind 'deploy-failure' | 'ci-red': the backup alert class
 * extracts NO key, so every dedup pass falls back to TITLE TEXT, and the two
 * titles differ by one word + a suffix. infra-watch fans ONE backup alert to
 * every admin supervisor chat by design (infra-watch.service.ts deliver() —
 * the fffacaee header documents independently-worded filings as the DESIGNED
 * shape of this class), so the pair was guaranteed, not unlucky. 437896fb
 * dispatched a ticket lane (08a486f0) while cf047f4a sat open waiting for a
 * free lane — a SECOND ops lane for the same event.
 *
 * THE FIX: InfraAlertKey gains kind 'backup'. Identity: severity@host for
 * missing/lapse (no dump to name); severity@host@<newest-dump ms-precision
 * ISO> for stale/failed (the millisecond timestamp names the EPISODE; the
 * sweep's "seen 15:18Z" / "fired 2026-10-24T15:19Z" observation times are
 * hh:mmZ / second-precision and correctly excluded — they differ BETWEEN the
 * pair while the episode timestamp is identical). STRICT-ALERT GATING per
 * fffacaee discipline: the TITLE must carry the ADJACENT pair
 * "backup <severity>" (the rendered head "[INFRA ALERT — backup stale]" is
 * quoted adjacently by every downstream title; a meta-ticket about THIS
 * defect says "backup alerts — one stale event" — not adjacent — and never
 * folds) AND the BODY must corroborate with the machine-rendered
 * "INFRA ALERT" marker. THE INCIDENT PAIR REPLAYED VERBATIM (both real
 * titles + description heads, source 'agent') must fold into ONE row with
 * occurrences=2 and the key stamped.
 *
 * The DISPATCH leg needs no change — infraAlertKeyOfRow re-derives through
 * the same extractor — and is pinned here through infraAlertKeysEqual (the
 * exact re-derivation seam the dispatch guards call).
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

// The INCIDENT's verbatim rows (read with get_feedback 2026-10-24; titles and
// description heads quoted verbatim, tails elided for the fixture).
const TS = '2026-10-23T09:01:11.565Z'; // the newest dump — the EPISODE identity
const KEY = `backup:stale:box-a@${TS}`;

// A = 437896fb (chat c0e22e36, filed 2026-10-24T15:19:48.683Z, in_progress, dispatched)
const TITLE_A = `Nightly backup stale on box-a — digby-backup.timer missed last night's dump`;
const DESC_A = `[INFRA ALERT — backup stale, fired 2026-10-24T15:19Z] The newest nightly database dump on box-a is 30.1h old (2026-10-23T09:01:11.565Z; seen 15:18Z) — the digby-backup.timer (08:30Z daily) did not produce a dump last night. Without it a bad migration or a deleted table is unrecoverable past the last S3 copy.\n\nPlaybook (per the alert): run an ec2-ops one-shot on the prod box that:\n1. Reads \`systemctl status digby-backup.timer digby-backup.service\` and \`journalctl -u digby-backup.service --since -…`;

// B = cf047f4a (chat 6061a468, filed 2026-10-24T15:19:57.951Z, open, waiting for a lane)
const TITLE_B = `Nightly backup stale on box-a — digby-backup.timer skipped last night's dump (30.1 h old)`;
const DESC_B = `INFRA ALERT — the newest nightly database dump on box-a is 30.1 h old (2026-10-23T09:01:11.565Z; verified 15:19Z via get_fleet_telemetry view 'boxes' — box-a web row: backup.ageH 30.1, count 3, disk 34% / 688 GB free). The digby-backup.timer (08:30Z daily) did not produce a dump last night. Without it a bad migration or a deleted table is unrecoverable past the last S3 copy.\n\nPlaybook: run an ec2-ops one-shot on the prod box that reads \`systemctl status digby-backup.timer digby-backup.service\` and \`journalctl -u digby-backup.service --since -2d\` (the two known causes: the disk guard aborting under 2 GB free — unlikely here, 688 GB free — and the service being killed by a deploy build, journal shows "Failed with result 'signal'"), fixes the cause, re-runs \`sudo systemctl start digby-backup.service\`, and confirms the new dump under /opt/crossmodel-backups AND its S3 copy (\`aws s3 ls s3://digby-backups-prod/postgres/ | tail -2\`).\n\nVerify afterwards: get_fleet_telemetry view 'boxes' shows box-a backup.ageH under 24. Never delete dumps to make room — grow the volume instead (owner spend, one question to the owner).`;

describe('253636d6 — the pure stable-key extractor (backup kind)', () => {
  it('extracts backup:stale:box-a@<newest-dump ms ISO> from BOTH incident rows despite the differing wording', () => {
    const a = extractInfraAlertKey(TITLE_A, DESC_A);
    const b = extractInfraAlertKey(TITLE_B, DESC_B);
    expect(a).toEqual({ kind: 'backup', id: 'stale', repo: `box-a@${TS}` });
    expect(b).toEqual(a);
    expect(infraAlertKeyString(a!)).toBe(KEY);
    expect(infraAlertKeyString(b!)).toBe(KEY); // ONE key for both wordings
  });

  it('the observation times ("seen 15:18Z" vs "verified 15:19Z") are NOT part of the key — only the episode timestamp is', () => {
    // Same episode re-observed an hour later: the alert head re-renders with a
    // new "seen" clock but the SAME newest dump — the key must not move.
    const later = extractInfraAlertKey(
      TITLE_B,
      DESC_B.replace('seen 15:18Z', 'seen 16:18Z').replace('verified 15:19Z', 'verified 16:19Z'),
    );
    expect(infraAlertKeyString(later!)).toBe(KEY);
  });

  it('a DIFFERENT episode (new dump produced, then stale again) never folds — the ms timestamp is the identity', () => {
    const nextEpisode = extractInfraAlertKey(
      TITLE_B,
      DESC_B.replaceAll('2026-10-23T09:01:11.565Z', '2026-10-25T09:01:09.123Z'),
    );
    expect(infraAlertKeyString(nextEpisode!)).toBe('backup:stale:box-a@2026-10-25T09:01:09.123Z');
    expect(infraAlertKeyString(nextEpisode!)).not.toBe(KEY);
  });

  it('keys compare through the context stamp (post-fix rows) AND through re-derivation (pre-fix rows — the dispatch guard seam)', () => {
    const b = extractInfraAlertKey(TITLE_B, DESC_B)!;
    const keyStr = infraAlertKeyString(b);
    expect(infraAlertKeyOfContext({ [INFRA_ALERT_KEY_FIELD]: keyStr })).toBe(keyStr);
    expect(infraAlertKeysEqual({ context: { [INFRA_ALERT_KEY_FIELD]: keyStr }, title: 'unrelated', description: 'unrelated' }, b)).toBe(true);
    // unstamped but alert-shaped (the pre-fix A row — 437896fb carries no stamp)
    expect(infraAlertKeysEqual({ context: {}, title: TITLE_A, description: DESC_A }, b)).toBe(true);
  });

  it('the failed severity keys on the newest-dump timestamp too (renderBackupAlert FAILED shape)', () => {
    const title = `Backup FAILED on box-a — nightly dump errored`;
    const body = `[INFRA ALERT — backup FAILED] the latest nightly backup attempt on box-a FAILED at 2026-10-23T09:01:11.565Z (seen 15:19Z) — backup-status.json on the /backups mount says status:"failed", so the 08:30Z digby-backup run produced no dump.`;
    const k = extractInfraAlertKey(title, body);
    expect(k).toEqual({ kind: 'backup', id: 'failed', repo: `box-a@${TS}` });
    expect(infraAlertKeyString(k!)).toBe(`backup:failed:box-a@${TS}`);
  });

  it('missing / producer-not-reporting have no dump to name — the key is severity@host only', () => {
    const missing = extractInfraAlertKey(
      `Backup missing on box-a — no nightly dumps present`,
      `[INFRA ALERT — backup missing] no nightly database dump is present on the backup producer box-a (seen 15:19Z). Playbook: dispatch_platform_task "Backup missing on box-a".`,
    );
    expect(missing).toEqual({ kind: 'backup', id: 'missing', repo: 'box-a' });
    const lapse = extractInfraAlertKey(
      `Backup producer not reporting on box-a — /backups mount unreadable`,
      `[INFRA ALERT — backup producer not reporting] the backup producer box-a has not reported a backup reading in over 24 h while its box_health heartbeats continue normally (seen 15:19Z).`,
    );
    expect(lapse).toEqual({ kind: 'backup', id: 'lapse', repo: 'box-a' });
  });

  it('STRICT GATING — the META ticket about this very defect (253636d6) quotes the timestamp and "INFRA ALERT" but its title is NOT backup-shaped: no key, no fold', () => {
    const metaTitle = 'Infra-alert key dedup misses backup alerts — one stale event, two tickets 9 s apart, second lane queued';
    const metaDesc = `One stale event (newest dump ${TS}) produced two tickets 9 s apart; the alert head "[INFRA ALERT — backup stale]" is quoted by both. Fix: extend the stable-key dedup with kind 'backup'.`;
    expect(extractInfraAlertKey(metaTitle, metaDesc)).toBeNull();
    const alertKey = extractInfraAlertKey(TITLE_A, DESC_A)!;
    expect(infraAlertKeysEqual({ title: metaTitle, description: metaDesc, context: {} }, alertKey)).toBe(false);
  });

  it('STRICT GATING — a backup-shaped title WITHOUT the machine-rendered "INFRA ALERT" marker in the body is not an alert filing', () => {
    expect(extractInfraAlertKey(TITLE_A, 'The backup looks stale; someone should look at it eventually.')).toBeNull();
  });

  it('STRICT GATING — a stale/failed body whose timestamp was paraphrased away degrades to severity@host (under-fold, the pre-fix behavior — never a wrong fold)', () => {
    const k = extractInfraAlertKey(TITLE_A, `[INFRA ALERT — backup stale] the newest nightly dump on box-a is about a day old.`);
    expect(k).toEqual({ kind: 'backup', id: 'stale', repo: 'box-a' });
  });

  it('the deploy-failure and CI-red kinds are unchanged (regression)', () => {
    expect(extractInfraAlertKey(`Deploy run 39441731823 failed (sha 51946acc) — fix and re-run`, `Failed run: https://github.com/example-org/crossmodel/actions/runs/39441731823`))
      .toEqual({ kind: 'deploy-failure', id: '39441731823', repo: 'example-org/crossmodel' });
    expect(extractInfraAlertKey(`[CI FAILED — example-org/crossmodel@1a2b3c4d5e6f] red on GitHub`, `[CI FAILED — example-org/crossmodel@1a2b3c4d5e6f] shard 3/4 red.`))
      .toEqual({ kind: 'ci-red', id: '1a2b3c4d5e6f', repo: 'example-org/crossmodel' });
  });

  it('TEXTUAL — the leaf imports no I/O modules (prisma/redis/logger): the pure-leaf discipline', () => {
    const src = fs.readFileSync(path.join(__dirname, 'infra-alert-key.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+'(?:\.\.\/)*(?:config\/database|config\/redis|utils\/logger)'/);
  });

  it('TEXTUAL — the filing pass scans backup candidates on the class token (the title gate\'s first word), and the dispatch guard still reads the same leaf', () => {
    expect(FEEDBACK_SRC).toMatch(/alertKey\.kind\s*===\s*'backup'\s*\?\s*'backup'\s*:\s*alertKey\.id/);
    expect(DISPATCH_SRC).toMatch(/INFRA_ALERT_COLLISION_NOTE_PREFIX/);
    expect(DISPATCH_SRC).toMatch(/claimedAlertKeys\.set\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The FILING leg (feedback.service mocked-prisma harness — the fffacaee pattern)
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

/** WHERE-faithful matcher for the dedup scans' query shapes (the fffacaee harness). */
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
      else if (op === 'mode' || op === 'case' || op === 'not') { /* Prisma mode flags — already honored case-insensitively above */ }
      else { if (val !== (v as Record<string, unknown>)[op]) return false; }
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

describe('253636d6 — FILING leg: a second backup alert for the same episode bumps the open ticket (no new row)', () => {
  it('the incident pair replayed VERBATIM: B (different wording, same episode) bumps A — occurrences=2, NO create, key stamped', async () => {
    // A = 437896fb's real row (filed 15:19:48Z, in_progress, no key stamp — pre-fix)
    openRows = [{
      id: '437896fb-ff60-4af2-b694-c926868e6762',
      type: 'enhancement', source: 'agent', status: 'in_progress', priority: 4,
      title: TITLE_A, description: DESC_A,
      context: { sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', surface: 'chat', filedAt: '2026-10-24T15:19:48.637Z' },
      createdAt: new Date('2026-10-24T15:19:48.683Z'), updatedAt: new Date('2026-10-24T15:19:48.683Z'),
    }];
    // B = cf047f4a's real filing 9.3 s later
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'enhancement', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: '6061a468-bb49-428c-8879-e77e7a9939c7', surface: 'chat', filedAt: '2026-10-24T15:19:57.933Z' },
    });
    expect(r).toMatchObject({ deduped: true });
    expect((r as any).ticket.id).toBe('437896fb-ff60-4af2-b694-c926868e6762');
    // the bump write: occurrences 1 → 2, the sighting trail names B's session
    const bumpCall = mockPrisma.userFeatureRequest.update.mock.calls.map((c: any[]) => c[0])
      .find((a: any) => a.data?.context && typeof a.data.context.occurrences === 'number');
    expect(bumpCall).toBeTruthy();
    expect(bumpCall.where.id).toBe('437896fb-ff60-4af2-b694-c926868e6762');
    expect(bumpCall.data.context.occurrences).toBe(2);
    expect(bumpCall.data.context.sightings).toHaveLength(1);
    expect(bumpCall.data.context.sightings[0].sessionId).toBe('6061a468-bb49-428c-8879-e77e7a9939c7');
    // the stable key is stamped on the bumped row (the dispatch leg reads it)
    expect(bumpCall.data.context[INFRA_ALERT_KEY_FIELD]).toBe(KEY);
    // NO new row was created
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
  });

  it('the alert-key pass folds even across TYPES (bug_report vs enhancement) — the key, not the type, is the identity', async () => {
    openRows = [{
      id: 'alert-0000-0000-0000000000ba', type: 'enhancement', source: 'agent', status: 'open', priority: 4,
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

  it('a META ticket about the duplicate-alert defect (253636d6\'s own shape) is NOT folded into the alert ticket', async () => {
    openRows = [{
      id: 'alert-0000-0000-0000000000bb', type: 'enhancement', source: 'agent', status: 'open', priority: 4,
      title: TITLE_A, description: DESC_A, context: { [INFRA_ALERT_KEY_FIELD]: KEY },
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'bug_report',
      title: 'Infra-alert key dedup misses backup alerts — one stale event, two tickets 9 s apart, second lane queued',
      description: `Evidence: one stale event (newest dump ${TS}) filed 437896fb + cf047f4a 9 s apart; both quote "[INFRA ALERT — backup stale]". Fix: extend the stable-key dedup with kind 'backup'.`,
      priority: 4,
      context: { sessionId: 'sess-meta', surface: 'coding', filedAt: new Date().toISOString() },
    });
    // a fresh row (the meta ticket is a DIFFERENT ticket about the defect)
    expect(r).not.toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalled();
  });

  it('the kill switch FEEDBACK_INFRA_ALERT_DEDUP_DISABLED=1 reverts to title-only dedup (B files a new row)', async () => {
    process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED = '1';
    openRows = [{
      id: 'alert-0000-0000-0000000000bc', type: 'enhancement', source: 'agent', status: 'open', priority: 4,
      title: TITLE_A, description: DESC_A, context: {},
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
    }];
    const r = await fileFeedbackTicket({
      userId: 'u2', type: 'enhancement', title: TITLE_B, description: DESC_B, priority: 4,
      context: { sessionId: 'sess-3', surface: 'chat', filedAt: new Date().toISOString() },
    });
    expect(r).not.toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).toHaveBeenCalled();
  });
});
