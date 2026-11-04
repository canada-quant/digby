/**
 * Ticket 251e9329 (mishap, 2026-09-13) — REPLAY: the 3× observe_resource
 * failure streak in session e083ff2e (run d079835a).
 *
 * What happened: the CanLaw coordinator lane's standing schedule prompt
 * (Directive E) mandates `observe_resource b18d1c00 …` every tick. Between
 * ticks 01:53Z and 02:26Z that id was DELETED out-of-band (releaseWatchedResource
 * has no in-app caller — nothing in the app can delete a row), while the
 * survivor b53b93f4 (the same AWS capacity block, per the supervisor's steer)
 * stayed registered. The lane's calls were correctly formed — right tool,
 * grounded uuid, per its standing instructions — but every refusal said only
 * "register_watched_resource first (or list via get_account_overview)", and
 * get_account_overview had NO watched-resources section, so the advertised
 * recovery path did not exist. With no way to discover the registry, the lane
 * re-issued the same blind call until the derail breaker tripped (3× streak)
 * and auto-filed this ticket.
 *
 * The fix under test (two halves, both replayed here):
 *   1. resources.service.ts — the refusal is SELF-DESCRIBING: it names the
 *      resources that ARE registered (id prefix + label), so the lane
 *      self-heals in ONE round instead of three blind calls.
 *   2. account-tools.ts — get_account_overview → watchedResources EXISTS
 *      (the recovery path the error always advertised), pinned in
 *      account-tools.test.ts.
 *
 * This file replays the mishap at the service boundary: a vanished id with a
 * live survivor must produce a refusal the lane can act on, and following it
 * must succeed on the very next call.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The registry as it stood when the streak fired: b18d1c00 (the lane's
// mandated id) GONE, b53b93f4 (same AWS capacity block) alive.
const VANISHED_ID = 'b18d1c00-0f6c-4423-8d35-c3e05f4f2e12';
const SURVIVOR = { id: 'b53b93f4-fac9-4cd6-9085-90a8da021cc3', label: 'AWS Capacity Block cr-056fd55496e1beb3f (8×B300, CanLaw SFT/GSPO remainder)', createdAt: new Date('2026-09-11T18:00:00Z') };

// Query-aware findMany — resolveWatchedResource probes with an id/label filter
// (must MISS for the vanished id), while the refusal's registry listing reads
// where: { userId } only. Per-test state lives in `listing`/`listingRejects`
// so implementations never leak between tests (the jest mock trap).
let listing: Array<{ id: string; label: string; createdAt: Date }> = [];
let listingRejects = false;
const mockFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockFindMany = jest.fn(async (arg?: any): Promise<any[]> => {
  const where = arg?.where ?? {};
  if (where.id || where.label) return []; // resolution lookups: no match
  if (listingRejects) throw new Error('table gone'); // the registry listing itself fails
  return listing;
});
const mockUpdate = jest.fn(async (arg?: any) => ({
  id: arg?.where?.id, label: SURVIVOR.label, maxUnobservedMinutes: 300,
  lastObservedAt: new Date(), notes: null, createdAt: SURVIVOR.createdAt,
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    watchedResource: {
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      update: (...a: any[]) => mockUpdate(...a),
      count: jest.fn(async () => 1),
      create: jest.fn(async (arg?: any) => ({ id: 'wr-new', createdAt: new Date(), ...arg?.data })),
      delete: jest.fn(async () => ({})),
    },
    trainingArtifact: { count: jest.fn(async () => 0) },
  },
}));

jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK') } }));

import { observeResource } from './resources.service';

describe('ticket 251e9329 — observe_resource on a vanished id self-heals in ONE round', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listing = [SURVIVOR];
    listingRejects = false;
    mockFindFirst.mockReset();
    mockFindFirst.mockImplementation(async () => null);
  });

  it('replays the streak: the mandated id is gone, a survivor is registered', async () => {
    // The lane's first call — exactly the tool call that tripped the breaker
    // (right tool, grounded uuid, per its standing schedule prompt).
    const err = await observeResource('u1', VANISHED_ID).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = String(err?.message ?? '');
    // Still the same error class (nothing about the failure shape changes)…
    expect(msg).toContain('No watched resource');
    expect(msg).toContain('register_watched_resource first');
    // …but now SELF-DESCRIBING: names the survivor's id prefix and label, so
    // the lane never needs a second blind call (the old message named nothing).
    expect(msg).toContain('b53b93f4');
    expect(msg).toContain('AWS Capacity Block');
    expect(msg).toContain('get_account_overview');
  });

  it('the recovery the refusal prescribes actually works: observing the survivor it names succeeds', async () => {
    mockFindFirst.mockImplementation(async (arg?: any) => (arg?.where?.id === SURVIVOR.id ? { ...SURVIVOR, maxUnobservedMinutes: 300 } : null));
    const r = await observeResource('u1', SURVIVOR.id);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SURVIVOR.id },
      data: expect.objectContaining({ lastObservedAt: expect.any(Date) }),
    }));
    expect(r.id).toBe(SURVIVOR.id);
    expect(r.lastObservedAt).toBeTruthy();
  });

  it('empty registry says so explicitly (the lane learns it must register, not hunt)', async () => {
    listing = [];
    await expect(observeResource('u1', VANISHED_ID)).rejects.toThrow(/registry is EMPTY/);
  });

  it('a failing registry read degrades to the plain guidance — never a different error class', async () => {
    listingRejects = true;
    await expect(observeResource('u1', VANISHED_ID)).rejects.toThrow(/No watched resource "b18d1c00/);
  });

  it('the registry listing is owner-scoped (another user\'s resources are never leaked into a refusal)', async () => {
    await observeResource('u1', VANISHED_ID).catch(() => {});
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u1' }),
    }));
  });
});
