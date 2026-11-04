/**
 * PIN (ticket 253636d6, 2026-10-24) — LEG 2 of 2: the DISPATCH side, backup
 * kind. One backup-alert key never takes TWO dedicated ticket lanes.
 *
 * THE DEFECT THIS PINS: one stale-backup event on box-a (newest dump
 * 2026-10-23T09:01:11.565Z) filed TWO agent tickets 9.3 s apart (437896fb
 * from chat c0e22e36 at 15:19:48.683Z, cf047f4a from chat 6061a468 at
 * 15:19:57.951Z); 437896fb dispatched a dedicated ticket lane (08a486f0,
 * 15:32:14Z) while cf047f4a sat OPEN "waiting for a free ticket lane" — the
 * drain would have opened a SECOND ops lane for the same event as soon as a
 * slot freed, because the backup class had no stable key for the fffacaee
 * dispatch guard to compare.
 *
 * THE FIX (extractor side): kind 'backup' — severity@host@<newest-dump ms
 * ISO> for stale/failed (severity@host for missing/lapse). The dispatch
 * guard itself needed NO change: infraAlertKeyOfRow re-derives each row's
 * key through the same extractor (stamped context.infraAlertKey first, else
 * the row's own alert shape), so once the extractor speaks 'backup' the
 * guards see the collision automatically.
 *
 * This file runs the drain on the 9dacab1a SELECT/WHERE-faithful mock
 * harness with BOTH live rows verbatim and asserts the SECOND row is HELD
 * with the collision note while the holder keeps its lane. The FILING leg is
 * pinned in infra-alert-key.backup.253636d6.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { makeFaithfulFindMany, mockMatchesWhere, mockApplySelect, type MockRow } from './ticket-dispatch.mock.9dacab1a';

// The incident's verbatim rows (get_feedback 2026-10-24: titles and
// description heads quoted verbatim, tails elided for the fixture).
const TS = '2026-10-23T09:01:11.565Z'; // the newest dump — the EPISODE identity
const KEY = `backup:stale:box-a@${TS}`;

// A = 437896fb (chat c0e22e36, filed 15:19:48.683Z) — the row the drain dispatched.
const TITLE_A = `Nightly backup stale on box-a — digby-backup.timer missed last night's dump`;
const DESC_A = `[INFRA ALERT — backup stale, fired 2026-10-24T15:19Z] The newest nightly database dump on box-a is 30.1h old (2026-10-23T09:01:11.565Z; seen 15:18Z) — the digby-backup.timer (08:30Z daily) did not produce a dump last night. Without it a bad migration or a deleted table is unrecoverable past the last S3 copy.\n\nPlaybook (per the alert): run an ec2-ops one-shot on the prod box that:\n1. Reads \`systemctl status digby-backup.timer digby-backup.service\` and \`journalctl -u digby-backup.service --since -…`;

// B = cf047f4a (chat 6061a468, filed 15:19:57.951Z) — the duplicate that must be HELD.
const TITLE_B = `Nightly backup stale on box-a — digby-backup.timer skipped last night's dump (30.1 h old)`;
const DESC_B = `INFRA ALERT — the newest nightly database dump on box-a is 30.1 h old (2026-10-23T09:01:11.565Z; verified 15:19Z via get_fleet_telemetry view 'boxes' — box-a web row: backup.ageH 30.1, count 3, disk 34% / 688 GB free). The digby-backup.timer (08:30Z daily) did not produce a dump last night. Without it a bad migration or a deleted table is unrecoverable past the last S3 copy.\n\nPlaybook: run an ec2-ops one-shot on the prod box that reads \`systemctl status digby-backup.timer digby-backup.service\` and \`journalctl -u digby-backup.service --since -2d\` (the two known causes: the disk guard aborting under 2 GB free — unlikely here, 688 GB free — and the service being killed by a deploy build, journal shows "Failed with result 'signal'"), fixes the cause, re-runs \`sudo systemctl start digby-backup.service\`, and confirms the new dump under /opt/crossmodel-backups AND its S3 copy (\`aws s3 ls s3://digby-backups-prod/postgres/ | tail -2\`).\n\nVerify afterwards: get_fleet_telemetry view 'boxes' shows box-a backup.ageH under 24. Never delete dumps to make room — grow the volume instead (owner spend, one question to the owner).`;

type Row = MockRow & {
  id: string; type: string; title: string; description: string; priority: number; source: string;
  status: string; adminNote: string | null; context: any; createdAt: Date; updatedAt: Date; userId?: string | null;
  user?: { role?: string | null } | null;
};
let tickets: Row[] = [];
let runs: Array<{ sessionId: string; status: string; createdAt: Date; updatedAt: Date }> = [];
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();

const faithfulFindMany = makeFaithfulFindMany(() => tickets);

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const c = chats.get(where.id);
      if (!c) return null;
      return mockApplySelect({ ...c }, select);
    }),
    findMany: jest.fn(async ({ where, take }: any) => {
      const ids: string[] = Array.isArray(where?.id?.in) ? where.id.in : [];
      return [...chats.entries()].filter(([id]) => ids.includes(id)).slice(0, take ?? Infinity).map(([id, c]) => ({ id, ...c }));
    }),
  },
  crossModelProject: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: {
    findMany: jest.fn((args: any) => faithfulFindMany(args)),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of tickets) {
        if (!mockMatchesWhere(r as Record<string, any>, where)) continue;
        Object.assign(r, data, { updatedAt: new Date() });
        count++;
      }
      return { count };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = tickets.find((t) => t.id === where.id);
      if (r) Object.assign(r, data, { updatedAt: new Date() });
      return r ?? {};
    }),
    findUnique: jest.fn(async ({ where, select }: any) => {
      const r = tickets.find((t) => t.id === where.id);
      return r ? mockApplySelect({ ...r }, select) : null;
    }),
  },
  agentRun: {
    findMany: jest.fn(async ({ where }: any) => runs.filter((r) => where.sessionId.in.includes(r.sessionId))),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const kv = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (key: string, value: string, opts?: any) => {
      if (opts?.NX && kv.has(key)) return null;
      kv.set(key, value);
      return 'OK';
    }),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_opts: any) => ({ id: `lane-2536-${String(++spawnSeq).padStart(4, '0')}-0000-0000000000aa` }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: jest.fn(async ({ chatId }: any) => ({ id: chatId, archived: true })),
}));

// The slot-release notice dynamically imports hooks.service, whose graph
// (error-handler → config/env) calls process.exit without env vars — mock the
// boundary (bf656696 harness pattern).
const mockEmitHookEventSafe = jest.fn(async () => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...(a as [])),
}));

import { drainOpenTicketsToLane } from './ticket-dispatch.service';

const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const LANE_A = '08a486f0-1132-424d-8183-dca967d63a76'; // the lane 437896fb dispatched to (get_feedback, 15:32:14Z)

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'enhancement', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 4, source: 'agent', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  delete process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED;
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // force the day cap path
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('253636d6 — DISPATCH leg: a same-episode backup ticket never takes a second lane', () => {
  it('THE LIVE SHAPE: 437896fb in_progress with a live lane, cf047f4a open (the F34 queue) — the duplicate is HELD, no second lane, holder records the collision with the episode key', async () => {
    tickets = [
      ticket('437896fb-ff60-4af2-b694-c926868e6762', {
        status: 'in_progress', title: TITLE_A, description: DESC_A,
        adminNote: 'Queued — ticket lane 08a486f0 starts it (dispatched 2026-10-24T15:32:14Z, dispatch 1 of 3).',
        context: { sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', surface: 'chat', filedAt: '2026-10-24T15:19:48.637Z', dispatchMode: 'ticket_lane', dispatchedTo: LANE_A, dispatchedAt: '2026-10-24T15:32:14.739Z', laneDispatches: 1, laneDispatchEpoch: 0 },
        createdAt: new Date('2026-10-24T15:19:48.683Z'), updatedAt: new Date('2026-10-24T15:32:14.739Z'),
      }),
      ticket('cf047f4a-26e9-4b40-b81f-e85df0c58b33', {
        title: TITLE_B, description: DESC_B,
        context: { sessionId: '6061a468-bb49-428c-8879-e77e7a9939c7', surface: 'chat', filedAt: '2026-10-24T15:19:57.933Z' },
        createdAt: new Date('2026-10-24T15:19:57.951Z'), updatedAt: new Date('2026-10-24T15:19:58.039Z'),
      }),
    ];
    runs = [{ sessionId: LANE_A, status: 'running', createdAt: new Date(Date.now() - 30 * 60_000), updatedAt: new Date(Date.now() - 60_000) }];
    chats.set(LANE_A, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });

    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'deduped', batched: 0 }); // refused — nothing spawned
    expect(mockStartCodingSession).not.toHaveBeenCalled();

    const dup = byId('cf047f4a-26e9-4b40-b81f-e85df0c58b33');
    expect(dup.status).toBe('open'); // held, not dispatched
    expect(dup.context.dispatchedTo).toBeUndefined();
    expect(String(dup.adminNote)).toMatch(/^Held — duplicate infra alert: ticket /);
    expect(String(dup.adminNote)).toContain('437896fb'); // the holder's 8-char id prefix

    const holder = byId('437896fb-ff60-4af2-b694-c926868e6762');
    expect(holder.status).toBe('in_progress'); // the holder keeps its lane
    expect(holder.context.dispatchedTo).toBe(LANE_A);
    expect(holder.context.collisions).toHaveLength(1);
    expect(holder.context.collisions[0]).toMatchObject({ ticketId: 'cf047f4a-26e9-4b40-b81f-e85df0c58b33', key: KEY });
  });

  it('THE WOULD-HAVE-HAPPENED SHAPE: both open, no lane yet — ONE lane spawns, the second row held (same-drain claimed-key guard)', async () => {
    tickets = [
      ticket('backup-815f-0000-0000000000b1', { title: TITLE_A, description: DESC_A, createdAt: new Date(Date.now() - 20 * 60_000) }),
      ticket('backup-66c8-0000-0000000000b2', { title: TITLE_B, description: DESC_B, createdAt: new Date(Date.now() - 19 * 60_000) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 }); // ONE spawn, not two
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);

    // The FIRST row (scan order: same priority, older createdAt first) spawned.
    const spawnedId = 'backup-815f-0000-0000000000b1';
    expect(byId(spawnedId).status).toBe('in_progress');
    expect(byId(spawnedId).context.dispatchedTo).toBeTruthy();

    const dup = byId('backup-66c8-0000-0000000000b2');
    expect(dup.status).toBe('open');
    expect(dup.context.dispatchedTo).toBeUndefined();
    expect(String(dup.adminNote)).toMatch(/^Held — duplicate infra alert: ticket /);
    expect(String(dup.adminNote)).toContain('lane spawning this drain'); // same-drain claim, no lane id yet

    const collisions = byId(spawnedId).context.collisions;
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ ticketId: 'backup-66c8-0000-0000000000b2', key: KEY });
  });

  it('a DIFFERENT episode (a NEW dump gone stale — different ms timestamp) is NOT held: it dispatches normally', async () => {
    const liveLane = 'lane-00000-0000-0000-0000-0000000000c9';
    tickets = [
      ticket('holder-0000-0000-0000000000ba', {
        status: 'in_progress', title: TITLE_A, description: DESC_A,
        context: { dispatchMode: 'ticket_lane', dispatchedTo: liveLane, dispatchedAt: new Date(Date.now() - 20 * 3600_000).toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 },
        createdAt: new Date(Date.now() - 21 * 3600_000), updatedAt: new Date(Date.now() - 20 * 3600_000),
      }),
      ticket('nextep-0000-0000-0000000000bb', {
        title: `Nightly backup stale on box-a — digby-backup.timer skipped last night's dump`,
        description: DESC_B.replaceAll('2026-10-23T09:01:11.565Z', '2026-10-26T09:01:09.123Z'), // a NEW episode
        createdAt: new Date(Date.now() - 30 * 60_000),
      }),
    ];
    runs = [{ sessionId: liveLane, status: 'running', createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 60_000) }];
    chats.set(liveLane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });

    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 }); // a genuinely NEW episode dispatches
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('nextep-0000-0000-0000000000bb').status).toBe('in_progress');
    expect(String(byId('nextep-0000-0000-0000000000bb').adminNote)).toMatch(/^Queued — ticket lane /);
  });

  it('the kill switch FEEDBACK_INFRA_ALERT_DEDUP_DISABLED=1 reverts the guard (pre-fix behavior: both rows spawn)', async () => {
    process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED = '1';
    tickets = [
      ticket('ks-a-00000-0000-0000000000ca', { title: TITLE_A, description: DESC_A, createdAt: new Date(Date.now() - 20 * 60_000) }),
      ticket('ks-b-00000-0000-0000000000cb', { title: TITLE_B, description: DESC_B, createdAt: new Date(Date.now() - 19 * 60_000) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 2 }); // pre-fix: two lanes for one episode
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
  });
});
