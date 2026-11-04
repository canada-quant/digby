/**
 * Drive watch (2026-09-29, owner-confirmed cf_822011a4) — unit tests.
 *
 * Covers the four dispatch-brief gates, plus the pure dedupe helpers:
 *   (a) sync ping vs real change — ping → no wake; change → wake w/ doc names
 *   (b) pageToken increment + persist across changes.list pages
 *   (c) (fileId, modifiedTime) dedupe — same change re-delivered → no 2nd wake;
 *       different modifiedTime → fires
 *   (d) renewal expiry math — expiring <24h → renewed; dead (never-bound) →
 *       stop + re-create
 *
 * Mocks: prisma (../../../config/database), token-manager (getValidToken), the
 * enqueueDirectWake hook seam (../platform/hooks.service), logger, and axios —
 * the same jest.mock style as the platform test files.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockFindFirst = jest.fn();
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockDelete = jest.fn();

const mockChatFindUnique = jest.fn();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    driveWatch: {
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockFindUnique(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      update: (...a: any[]) => mockUpdate(...a),
      create: (...a: any[]) => mockCreate(...a),
      delete: (...a: any[]) => mockDelete(...a),
    },
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
    },
  },
}));

const mockGetValidToken = jest.fn();
jest.mock('./token-manager', () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

const mockEnqueueDirectWake = jest.fn();
jest.mock('../platform/hooks.service', () => ({
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockAxiosGet(...a),
    post: (...a: any[]) => mockAxiosPost(...a),
  },
}));

import {
  createDriveWatch,
  handleDrivePush,
  pullAndMaybeFire,
  renewDriveWatches,
  shouldRenew,
  changeKey,
  parseFiredChanges,
  dedupeAgainstFired,
  nextFiredWindow,
  filterChangesForFolder,
  buildWakePrompt,
  RENEWAL_WINDOW_MS,
  type DriveChange,
} from './drive-watch.service';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WATCH = {
  id: 'watch-1',
  userId: 'user-1',
  label: 'Personal',
  folderId: 'folder-abc',
  channelId: 'chan-1',
  resourceId: 'res-1',
  token: 'page-0',
  expiration: new Date(Date.now() + 6 * 24 * 3600 * 1000), // healthy, not expiring
  targetChatId: 'chat-1',
  promptTemplate: '',
  lastFiredChanges: [] as string[],
  lastFiredAt: null as Date | null,
  lastSyncedAt: null as Date | null,
  createdAt: new Date(),
};

function headers(over: Record<string, string> = {}): Record<string, string> {
  return {
    'x-goog-channel-id': WATCH.channelId,
    'x-goog-resource-id': WATCH.resourceId,
    'x-goog-resource-state': 'exists',
    ...over,
  };
}

/** A single-page changes.list response carrying one in-folder change. */
function changesPage(
  changes: Array<{ fileId: string; name: string; modifiedTime: string; parents?: string[] }>,
  opts: { nextPageToken?: string; newStartPageToken?: string } = {},
) {
  return {
    data: {
      nextPageToken: opts.nextPageToken,
      newStartPageToken: opts.newStartPageToken ?? 'page-next',
      changes: changes.map((c) => ({
        fileId: c.fileId,
        file: {
          id: c.fileId,
          name: c.name,
          modifiedTime: c.modifiedTime,
          trashed: false,
          parents: c.parents ?? [WATCH.folderId],
        },
      })),
    },
  };
}

function mockTokenOk() {
  mockGetValidToken.mockResolvedValue('ya29.access-token');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTokenOk();
  mockEnqueueDirectWake.mockResolvedValue({ ok: true });
  mockUpdate.mockResolvedValue({});
});

// ── (a) sync ping vs real change ─────────────────────────────────────────────

describe('handleDrivePush — sync ping vs real change', () => {
  it('sync ping → 200, NO wake, no pull', async () => {
    mockFindFirst.mockResolvedValue(WATCH);
    const res = await handleDrivePush(headers({ 'x-goog-resource-state': 'sync' }));
    expect(res.status).toBe(200);
    expect(res.fired).toBe(false);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('not_exists ping → 200, NO wake (renewal re-creates the channel)', async () => {
    mockFindFirst.mockResolvedValue(WATCH);
    const res = await handleDrivePush(headers({ 'x-goog-resource-state': 'not_exists' }));
    expect(res.status).toBe(200);
    expect(res.fired).toBe(false);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('real change → 200, wake fired with the changed doc names', async () => {
    mockFindFirst.mockResolvedValue(WATCH);
    mockFindUnique.mockResolvedValue(WATCH);
    mockAxiosGet.mockResolvedValue(
      changesPage([{ fileId: 'f1', name: 'Algebra notes', modifiedTime: '2026-09-29T18:00:00Z' }]),
    );
    const res = await handleDrivePush(headers());
    expect(res.status).toBe(200);
    expect(res.fired).toBe(true);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueDirectWake.mock.calls[0][0];
    expect(arg.targetChatId).toBe('chat-1');
    expect(arg.prompt).toContain('Algebra notes');
  });

  it('channelId+resourceId mismatch → 403, no wake (the dispatch-brief security gate)', async () => {
    mockFindFirst.mockResolvedValue(WATCH);
    const res = await handleDrivePush(headers({ 'x-goog-resource-id': 'someone-else' }));
    expect(res.status).toBe(403);
    expect(res.fired).toBe(false);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('unknown channel → 404 (stops Google retries)', async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await handleDrivePush(headers());
    expect(res.status).toBe(404);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('malformed push (missing headers) → 400', async () => {
    const res = await handleDrivePush({ 'x-goog-channel-id': 'chan-1' });
    expect(res.status).toBe(400);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('change re-pulled but dedupe yields nothing new → 200, NO wake', async () => {
    const fired: DriveChange = { fileId: 'f1', name: 'Algebra notes', modifiedTime: '2026-09-29T18:00:00Z' };
    const row = { ...WATCH, lastFiredChanges: [changeKey(fired)] };
    mockFindFirst.mockResolvedValue(row);
    mockFindUnique.mockResolvedValue(row);
    mockAxiosGet.mockResolvedValue(
      changesPage([{ fileId: 'f1', name: 'Algebra notes', modifiedTime: '2026-09-29T18:00:00Z' }]),
    );
    const res = await handleDrivePush(headers());
    expect(res.status).toBe(200);
    expect(res.fired).toBe(false);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });
});

// ── (b) pageToken increment + persist across pages ───────────────────────────

describe('pullAndMaybeFire — pageToken increment + persist', () => {
  it('pages through and persists the newStartPageToken after firing', async () => {
    mockFindUnique.mockResolvedValue(WATCH);
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          nextPageToken: 'page-1',
          changes: [
            { fileId: 'f1', file: { id: 'f1', name: 'Doc A', modifiedTime: '2026-09-29T18:01:00Z', trashed: false, parents: [WATCH.folderId] } },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          newStartPageToken: 'page-2',
          changes: [
            { fileId: 'f2', file: { id: 'f2', name: 'Doc B', modifiedTime: '2026-09-29T18:02:00Z', trashed: false, parents: [WATCH.folderId] } },
          ],
        },
      });

    const fired = await pullAndMaybeFire(WATCH.id);
    expect(fired).toBe(true);
    // started from the stored token, then followed nextPageToken
    expect(mockAxiosGet.mock.calls[0][1].params.pageToken).toBe('page-0');
    expect(mockAxiosGet.mock.calls[1][1].params.pageToken).toBe('page-1');
    // persist the new start token + both doc names made it into the wake
    const upd = mockUpdate.mock.calls[0][0];
    expect(upd.data.token).toBe('page-2');
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('Doc A');
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('Doc B');
  });

  it('advances the pointer WITHOUT firing when nothing new (at-most-once path)', async () => {
    mockFindUnique.mockResolvedValue(WATCH);
    mockAxiosGet.mockResolvedValue(changesPage([], { newStartPageToken: 'page-9' }));
    const fired = await pullAndMaybeFire(WATCH.id);
    expect(fired).toBe(false);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0][0].data.token).toBe('page-9');
  });

  it('seeds the start page token when the row has none', async () => {
    mockFindUnique.mockResolvedValue({ ...WATCH, token: null });
    mockAxiosGet
      .mockResolvedValueOnce({ data: { startPageToken: 'seed-1' } }) // getStartPageToken
      .mockResolvedValueOnce(changesPage([], { newStartPageToken: 'seed-2' }));
    const fired = await pullAndMaybeFire(WATCH.id);
    expect(fired).toBe(false);
    expect(mockAxiosGet.mock.calls[0][0]).toContain('startPageToken');
    expect(mockAxiosGet.mock.calls[1][1].params.pageToken).toBe('seed-1');
  });
});

// ── (c) (fileId, modifiedTime) dedupe ────────────────────────────────────────

describe('dedupe — (fileId, modifiedTime)', () => {
  it('same change re-delivered → no second fire', async () => {
    const ch: DriveChange = { fileId: 'f1', name: 'Doc', modifiedTime: '2026-09-29T18:00:00Z' };
    const row = { ...WATCH, lastFiredChanges: [changeKey(ch)], lastFiredAt: new Date(Date.now() - 60_000) };
    mockFindUnique.mockResolvedValue(row);
    mockAxiosGet.mockResolvedValue(changesPage([{ fileId: 'f1', name: 'Doc', modifiedTime: '2026-09-29T18:00:00Z' }]));
    const fired = await pullAndMaybeFire(WATCH.id);
    expect(fired).toBe(false);
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('same file, different modifiedTime → fires', async () => {
    const old: DriveChange = { fileId: 'f1', name: 'Doc', modifiedTime: '2026-09-29T18:00:00Z' };
    const row = { ...WATCH, lastFiredChanges: [changeKey(old)] };
    mockFindUnique.mockResolvedValue(row);
    mockAxiosGet.mockResolvedValue(changesPage([{ fileId: 'f1', name: 'Doc', modifiedTime: '2026-09-29T18:30:00Z' }]));
    const fired = await pullAndMaybeFire(WATCH.id);
    expect(fired).toBe(true);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('the fired window is persisted with the new key prepended', async () => {
    const old: DriveChange = { fileId: 'f0', name: 'Old', modifiedTime: '2026-09-29T17:00:00Z' };
    const row = { ...WATCH, lastFiredChanges: [changeKey(old)] };
    mockFindUnique.mockResolvedValue(row);
    mockAxiosGet.mockResolvedValue(changesPage([{ fileId: 'f1', name: 'New', modifiedTime: '2026-09-29T18:30:00Z' }]));
    await pullAndMaybeFire(WATCH.id);
    const persisted: string[] = mockUpdate.mock.calls[0][0].data.lastFiredChanges;
    expect(persisted[0]).toBe('f1:2026-09-29T18:30:00Z');
    expect(persisted).toContain(changeKey(old));
  });

  it('pure helpers: parseFiredChanges / dedupeAgainstFired / nextFiredWindow', () => {
    const a: DriveChange = { fileId: 'a', name: 'A', modifiedTime: 't1' };
    const b: DriveChange = { fileId: 'a', name: 'A', modifiedTime: 't2' };
    expect(parseFiredChanges(['a:t1', 'garbage', 5, null])).toEqual(['a:t1']);
    expect(dedupeAgainstFired([a, b], ['a:t1'])).toEqual([b]);
    const win = nextFiredWindow([b], ['a:t1']);
    expect(win[0]).toBe('a:t2');
    expect(win).toContain('a:t1');
  });

  it('pure helpers: filterChangesForFolder keeps only direct children', () => {
    const ch: DriveChange[] = [
      { fileId: 'in', name: 'In', modifiedTime: 't' },
      { fileId: 'out', name: 'Out', modifiedTime: 't' },
    ];
    const parents = new Map<string, string[]>([
      ['in', ['folder-abc']],
      ['out', ['someone-elses-folder']],
    ]);
    const kept = filterChangesForFolder(ch, parents, 'folder-abc');
    expect(kept.map((c) => c.fileId)).toEqual(['in']);
  });

  it('pure helpers: buildWakePrompt names the docs + honours a template', () => {
    const changes: DriveChange[] = [{ fileId: 'f1', name: 'Essay', modifiedTime: 't1' }];
    const def = buildWakePrompt({ label: 'Personal', folderId: 'folder-abc', promptTemplate: '' }, changes);
    expect(def).toContain('Essay');
    const tpl = buildWakePrompt(
      { label: 'Personal', folderId: 'folder-abc', promptTemplate: 'Changed: {{docNames}} in {{folderId}}' },
      changes,
    );
    expect(tpl).toBe('Changed: Essay in folder-abc');
  });
});

// ── (d) renewal expiry math ──────────────────────────────────────────────────

describe('renewal expiry math', () => {
  const now = new Date('2026-09-29T18:00:00Z');

  it('shouldRenew: expiring <24h → true; healthy → false; never-bound → true', () => {
    expect(shouldRenew(new Date(now.getTime() + 12 * 3600 * 1000), now)).toBe(true); // 12h out
    expect(shouldRenew(new Date(now.getTime() + RENEWAL_WINDOW_MS - 1), now)).toBe(true);
    expect(shouldRenew(new Date(now.getTime() + 6 * 24 * 3600 * 1000), now)).toBe(false); // 6d out
    expect(shouldRenew(null, now)).toBe(true); // channel never opened
    expect(shouldRenew(new Date(now.getTime() - 60_000), now)).toBe(true); // already expired
  });

  it('renewDriveWatches: expiring row → renewed (stop old + open new + update row)', async () => {
    const expiring = { ...WATCH, expiration: new Date(now.getTime() + 3600 * 1000) }; // 1h out
    mockFindMany.mockResolvedValue([expiring]);
    mockFindUnique.mockResolvedValue(expiring);
    // stopChannel (POST channels/stop) + openChannel (POST changes/watch)
    mockAxiosPost.mockResolvedValue({ data: { resourceId: 'res-2', expiration: String(now.getTime() + 6 * 24 * 3600 * 1000) } });
    mockAxiosGet.mockResolvedValue(changesPage([], { newStartPageToken: 'p1' })); // reconciliation pull

    const report = await renewDriveWatches(now);
    expect(report.checked).toBe(1);
    expect(report.renewed).toBe(1);
    expect(report.renewFailed).toBe(0);
    // the old channel was stopped and a new one opened
    expect(mockAxiosPost.mock.calls.some((c) => String(c[0]).includes('channels/stop'))).toBe(true);
    expect(mockAxiosPost.mock.calls.some((c) => String(c[0]).includes('changes/watch'))).toBe(true);
    // row updated with the new resourceId
    expect(mockUpdate.mock.calls.some((c) => c[0].data.resourceId === 'res-2')).toBe(true);
  });

  it('renewDriveWatches: dead row (never-bound channel) → stop+re-create → renewed', async () => {
    const dead = { ...WATCH, resourceId: '', expiration: null }; // NO_CHANNEL sentinel
    mockFindMany.mockResolvedValue([dead]);
    mockFindUnique.mockResolvedValue(dead);
    mockAxiosPost.mockResolvedValue({ data: { resourceId: 'res-3', expiration: String(now.getTime() + 6 * 24 * 3600 * 1000) } });
    mockAxiosGet.mockResolvedValue(changesPage([], { newStartPageToken: 'p1' }));

    const report = await renewDriveWatches(now);
    expect(report.renewed).toBe(1);
    // no channels/stop needed for a never-bound channel, but a new watch opened
    expect(mockAxiosPost.mock.calls.some((c) => String(c[0]).includes('changes/watch'))).toBe(true);
  });

  it('renewDriveWatches: healthy row → not renewed, but reconciliation pull still runs', async () => {
    mockFindMany.mockResolvedValue([WATCH]); // healthy expiration
    mockFindUnique.mockResolvedValue(WATCH);
    mockAxiosGet.mockResolvedValue(changesPage([], { newStartPageToken: 'p1' }));
    const report = await renewDriveWatches(now);
    expect(report.checked).toBe(1);
    expect(report.renewed).toBe(0);
    expect(report.renewFailed).toBe(0);
    expect(mockAxiosPost).not.toHaveBeenCalled(); // no stop/watch
    expect(mockAxiosGet).toHaveBeenCalled(); // the fallback pull ran
  });
});

// ── (e) same-owner gate at subscribe (PR #1157 adversarial review) ───────────

describe('createDriveWatch — same-owner targetChatId gate', () => {
  const INPUT = { userId: 'user-1', folderId: 'folder-abc', targetChatId: 'chat-1' };

  it('rejects a targetChatId owned by a DIFFERENT user (cross-tenant wake injection)', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'user-B' });
    await expect(createDriveWatch(INPUT)).rejects.toThrow(
      'subscribe_drive_watch requires targetChatId to be one of YOUR chats (same owner) — got a chat id owned by another user or unknown.',
    );
    expect(mockCreate).not.toHaveBeenCalled(); // no row persisted
  });

  it('rejects an UNKNOWN targetChatId the same way', async () => {
    mockChatFindUnique.mockResolvedValue(null);
    await expect(createDriveWatch(INPUT)).rejects.toThrow(
      'subscribe_drive_watch requires targetChatId to be one of YOUR chats (same owner)',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('same-owner subscribe still succeeds and persists the row', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'user-1' });
    mockFindUnique.mockResolvedValue(null); // no existing (userId, folderId, targetChatId) row → CREATE path
    mockAxiosGet.mockResolvedValue({ data: { startPageToken: 'page-0' } });
    mockAxiosPost.mockResolvedValue({ data: { resourceId: 'res-1', expiration: '1759000000000' } });
    mockCreate.mockResolvedValue(WATCH);
    const view = await createDriveWatch(INPUT);
    expect(view.id).toBe('watch-1');
    expect(view.targetChatId).toBe('chat-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ── (f) idempotent re-subscribe — no raw P2002 to the tool caller (FO 53) ────

describe('createDriveWatch — idempotent re-subscribe', () => {
  const INPUT = { userId: 'user-1', folderId: 'folder-abc', targetChatId: 'chat-1' };

  /** axios.post serves channels/stop AND changes/watch — route by URL. */
  function postByUrl() {
    mockAxiosPost.mockImplementation(async (url: string) => {
      if (url.includes('/channels/stop')) return { data: {} };
      return { data: { resourceId: 'res-2', expiration: '1759000000000' } };
    });
  }

  it('updates the existing triple in place (stop old channel, open new, refresh token+template) instead of surfacing P2002', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'user-1' });
    mockFindUnique.mockResolvedValue({ ...WATCH, resourceId: 'res-1' }); // existing BOUND row
    mockAxiosGet.mockResolvedValue({ data: { startPageToken: 'page-9' } });
    postByUrl();
    mockUpdate.mockResolvedValue({ ...WATCH, promptTemplate: 'Hey {{docs}}' });
    const view = await createDriveWatch({ ...INPUT, promptTemplate: 'Hey {{docs}}' });
    expect(mockCreate).not.toHaveBeenCalled(); // the P2002 path is gone
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = mockUpdate.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'watch-1' });
    expect(updateArgs.data.token).toBe('page-9');
    expect(updateArgs.data.promptTemplate).toBe('Hey {{docs}}');
    expect(updateArgs.data.resourceId).toBe('res-2');
    // the OLD channel was stopped before the new one replaced it
    expect(mockAxiosPost.mock.calls.some((c: any[]) => c[0].includes('/channels/stop'))).toBe(true);
    expect(view.id).toBe('watch-1');
  });

  it('re-subscribe over a channel-less row (changes.watch had failed) skips channels/stop', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'user-1' });
    mockFindUnique.mockResolvedValue({ ...WATCH, resourceId: '' }); // NO_CHANNEL sentinel
    mockAxiosGet.mockResolvedValue({ data: { startPageToken: 'page-9' } });
    postByUrl();
    mockUpdate.mockResolvedValue({ ...WATCH });
    await createDriveWatch(INPUT);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAxiosPost.mock.calls.some((c: any[]) => c[0].includes('/channels/stop'))).toBe(false);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
