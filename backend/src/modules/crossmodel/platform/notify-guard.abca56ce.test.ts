/**
 * Ticket abca56ce replay pins — KPI re-announcements + dismissal attribution.
 *
 * KPI half: the Schooltime rate was announced "MET" three times in one day
 * (103.9 @02:00, 162.9 @05:18 Telegram, 113.4 @08:56) while the of-record
 * state never changed. The guard anchors on the REGISTER, not the typed
 * number: a push is refused only when it announces the KPI AND the of-record
 * {value, met} state is a repeat (state unchanged, value within threshold).
 * Pure half in kpi-of-record.abca56ce.test.ts (kpiAnnouncedBy / repeat).
 *
 * Attribution half: a 15:27Z owner-inbox dismissal was narrated at 15:28Z as
 * "dismissed as our bug" with no actor; dismissOwnerQuestion hardcoded "the
 * OWNER dismissed" for every caller. Every dismissal now stamps dismissedBy
 * and narrates from it — owner / supervisor / agent / system.
 */

const mockRedisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => mockRedisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mockRedisStore.set(k, v); return 'OK'; }),
  },
}));
const mockOwnerQuestions: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: {
      findMany: jest.fn(async ({ where }: any) => mockOwnerQuestions.filter((q) => q.userId === where.userId && q.status === where.status && new Date(q.resolvedAt) >= where.resolvedAt.gte)),
    },
    // The kpi-register read path (loadKpisForOwner → loadProjectKpis) is
    // mocked at the service boundary below; these are the prisma models it
    // touches. Empty by default (fail-open → no KPI leg applies).
    crossModelProject: { findMany: jest.fn(async () => []) },
    projectGoal: { findMany: jest.fn(async () => []) },
  },
}));

// The register read is mocked at the service seam: notify-guard dynamic-
// imports './kpi-register.service', so jest.mock at that boundary intercepts.
const mockKpis: any[] = [];
jest.mock('./kpi-register.service', () => ({
  __esModule: true,
  loadKpisForOwner: jest.fn(async () => mockKpis),
}));

import {
  findKpiReannouncement, rememberKpiAnnouncements, renderKpiReannounceRefusal,
  notifyKpiReannounceThreshold, dismissedByPhrase, renderNotifyDismissedRefusal,
  findDismissedQuestionRaised,
} from './notify-guard';

const ENV = ['NOTIFY_USER_KPI_REANNOUNCE_DISABLED', 'NOTIFY_USER_KPI_REANNOUNCE_THRESHOLD', 'NOTIFY_USER_KPI_REANNOUNCE_WINDOW_MIN', 'NOTIFY_USER_DEDUPE_DISABLED', 'NOTIFY_USER_DISMISSED_GUARD_DISABLED'];
beforeEach(() => { mockRedisStore.clear(); mockOwnerQuestions.length = 0; mockKpis.length = 0; for (const k of ENV) delete process.env[k]; });

const SCHOOLTIME_KPI = {
  key: 'kpi:schooltime_verified_clips_per_hour', value: 103.9, unit: ' clips/hr',
  bar: 100, history: [{ value: 90 }], goalId: 'goal-schooltime-1', projectId: 'proj-schooltime',
};

describe('KPI re-announcement guard (ticket abca56ce)', () => {
  it('re-announcing the SAME of-record state with a DIFFERENT typed number is refused; first push passes', async () => {
    const t0 = Date.now();
    mockKpis.push(SCHOOLTIME_KPI);
    // First push — nothing remembered yet — goes through.
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips MET at 103.9 clips/hr', t0)).toBeNull();
    await rememberKpiAnnouncements('u1', 'Schooltime verified clips MET at 103.9 clips/hr', t0);
    // Second push, typed number 162.9 — the register still holds 103.9: the
    // near-duplicate guard is blind (different tokens) but THIS guard refuses.
    const hit = await findKpiReannouncement('u1', 'Schooltime verified clips MET at 162.9 clips/hr', t0 + 3 * 3600_000);
    expect(hit).toMatchObject({ key: SCHOOLTIME_KPI.key, value: 103.9, met: true, priorValue: 103.9 });
    expect(renderKpiReannounceRefusal(hit!)).toMatch(/Nothing was sent: this push re-announces KPI kpi:schooltime_verified_clips_per_hour/);
    expect(renderKpiReannounceRefusal(hit!)).toMatch(/of record 103.9 clips\/hr, bar MET/);
    expect(renderKpiReannounceRefusal(hit!)).toMatch(/Push this KPI again only when its of-record state CHANGES/);
    // Third push, another number — still refused (one push per state change,
    // within the 6 h window; after that the state ages out and re-announces).
    expect(await findKpiReannouncement('u1', 'the schooltime rate is now 113.4 clips/hr — MET', t0 + 3 * 3600_000)).toMatchObject({ key: SCHOOLTIME_KPI.key });
  });

  it('a state FLIP or a >threshold move re-pushes (news); a ≤threshold move does not', async () => {
    const t0 = Date.now();
    mockKpis.push(SCHOOLTIME_KPI);
    await rememberKpiAnnouncements('u1', 'Schooltime MET at 103.9 clips/hr', t0);
    // Value moved 103.9 → 110 (5.9% — inside the 10% threshold): refused.
    mockKpis.length = 0;
    mockKpis.push({ ...SCHOOLTIME_KPI, value: 110 });
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips at 110 clips/hr', t0 + 3600_000)).toMatchObject({ value: 110 });
    // Value moved 103.9 → 120 (>10%): NOT a repeat — allowed through.
    mockKpis.length = 0;
    mockKpis.push({ ...SCHOOLTIME_KPI, value: 120 });
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips at 120 clips/hr', t0 + 3600_000)).toBeNull();
    // Bar flips MET → not-met (value below the bar): allowed through.
    mockKpis.length = 0;
    mockKpis.push({ ...SCHOOLTIME_KPI, value: 104 });
    mockKpis.push({ ...SCHOOLTIME_KPI, value: 99, bar: 100, history: [{ value: 90 }] });
    mockKpis.length = 0;
    mockKpis.push({ ...SCHOOLTIME_KPI, value: 99 });
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips slipped to 99 clips/hr — not met', t0 + 3600_000)).toBeNull();
    // The threshold is configurable and the kill switch disables the leg.
    mockKpis.length = 0;
    mockKpis.push({ ...SCHOOLTIME_KPI, value: 110 });
    process.env.NOTIFY_USER_KPI_REANNOUNCE_THRESHOLD = '0.5';
    expect(notifyKpiReannounceThreshold()).toBe(0.5);
    // A 5.9% move is inside a 50% threshold → still a repeat (refused)…
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips at 110 clips/hr', t0 + 3600_000)).toMatchObject({ threshold: 0.5 });
    delete process.env.NOTIFY_USER_KPI_REANNOUNCE_THRESHOLD;
    process.env.NOTIFY_USER_KPI_REANNOUNCE_DISABLED = '1';
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips at 110 clips/hr', t0 + 3600_000)).toBeNull();
  });

  it('a push that does not ANNOUNCE the KPI is never refused (no rate in the unit, no key word, no key cite)', async () => {
    const t0 = Date.now();
    mockKpis.push(SCHOOLTIME_KPI);
    await rememberKpiAnnouncements('u1', 'Schooltime MET at 103.9 clips/hr', t0);
    // Another lane's unrelated rate in a DIFFERENT unit.
    expect(await findKpiReannouncement('u1', 'QB2 hit 42.7 tok/s — new best.', t0 + 60_000)).toBeNull();
    // A rate in the same unit from a DIFFERENT KPI (no schooltime key word) —
    // the unit alone is not an announcement.
    expect(await findKpiReannouncement('u1', 'Spark serving at 101.2 clips/hr on the bench.', t0 + 60_000)).toBeNull();
    // No rate and no key word at all.
    expect(await findKpiReannouncement('u1', 'All lanes green; nightly digest attached.', t0 + 60_000)).toBeNull();
  });

  it('remembered states age out with the window; an empty register never refuses', async () => {
    const t0 = Date.now();
    mockKpis.push(SCHOOLTIME_KPI);
    await rememberKpiAnnouncements('u1', 'Schooltime MET at 103.9 clips/hr', t0);
    // Default window 6 h: a push at t0+7h is fresh news again.
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips at 103.9 clips/hr', t0 + 7 * 3600_000)).toBeNull();
    // No KPIs registered at all — the guard is inert.
    mockKpis.length = 0;
    expect(await findKpiReannouncement('u1', 'Schooltime verified clips at 103.9 clips/hr', t0 + 60_000)).toBeNull();
  });
});

describe('dismissal attribution (ticket abca56ce)', () => {
  it('the dismissed-refusal names the ACTOR from the row — supervisor/system/agent dismissals are never "the OWNER"', () => {
    expect(dismissedByPhrase('owner')).toBe('the OWNER DISMISSED');
    expect(dismissedByPhrase(null)).toBe('the OWNER DISMISSED'); // legacy rows
    expect(dismissedByPhrase('supervisor')).toMatch(/Fleet Supervisor \(on the owner's behalf\)/);
    expect(dismissedByPhrase('system')).toMatch(/superseded it — no owner ruling/);
    expect(dismissedByPhrase('agent')).toMatch(/filing chat/);
    const sup = renderNotifyDismissedRefusal({ id: 'oq_a0004080-aaaa-bbbb-cccc-000000000001', question: 'Cut over the schooltime apex?', resolvedAt: '2026-10-16T15:27:00.000Z', via: 'cited', dismissedBy: 'supervisor' });
    expect(sup).toMatch(/Fleet Supervisor \(on the owner's behalf\) DISMISSED/);
    expect(sup).not.toMatch(/the OWNER DISMISSED/);
    const sys = renderNotifyDismissedRefusal({ id: 'oq_a0004080-aaaa-bbbb-cccc-000000000001', question: 'Cut over the schooltime apex?', resolvedAt: null, via: 'topic', dismissedBy: 'system' });
    expect(sys).toMatch(/superseded it — no owner ruling/);
  });

  it('a dismissed row the OWNER dismissed still reads as the owner (legacy NULL included)', async () => {
    mockOwnerQuestions.push({ id: 'oq_a0004080-aaaa-bbbb-cccc-000000000001', userId: 'u1', status: 'dismissed', question: 'Cut over the schooltime apex?', resolvedAt: new Date(Date.now() - 30 * 60_000), dismissedBy: 'owner' });
    const hit = await findDismissedQuestionRaised('u1', 'Still waiting on question oq_a0004080 in your inbox.');
    expect(hit).toMatchObject({ via: 'cited', dismissedBy: 'owner' });
    expect(renderNotifyDismissedRefusal(hit!)).toMatch(/the OWNER DISMISSED/);
    // Legacy row without the column — NULL renders as the owner.
    mockOwnerQuestions.length = 0;
    mockOwnerQuestions.push({ id: 'oq_a0004080-aaaa-bbbb-cccc-000000000001', userId: 'u1', status: 'dismissed', question: 'Cut over the schooltime apex?', resolvedAt: new Date(Date.now() - 30 * 60_000) });
    const legacy = await findDismissedQuestionRaised('u1', 'Still waiting on question oq_a0004080 in your inbox.');
    expect(legacy).toMatchObject({ dismissedBy: null });
    expect(renderNotifyDismissedRefusal(legacy!)).toMatch(/the OWNER DISMISSED/);
  });
});
