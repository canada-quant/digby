/**
 * guest-session-run — the anonymous run's cross-process liveness marker
 * (owner report 2026-09-26: a guest reload mid-answer lost the turn). Pins:
 *   - the in-process key shape the run registers under;
 *   - the Redis marker: written with the 60 s TTL, refreshed by the same
 *     call, dropped at clear;
 *   - `isGuestSessionRunActive` = local registry OR marker, fail-open false
 *     on a Redis error.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, { value: string; ex?: number }>();
let redisDown = false;
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { EX?: number }) => {
      if (redisDown) throw new Error('redis down');
      redisStore.set(k, { value: v, ex: opts?.EX });
      return 'OK';
    }),
    del: jest.fn(async (k: string) => {
      if (redisDown) throw new Error('redis down');
      return redisStore.delete(k) ? 1 : 0;
    }),
    exists: jest.fn(async (k: string) => {
      if (redisDown) throw new Error('redis down');
      return redisStore.has(k) ? 1 : 0;
    }),
  },
}));

import {
  chatSessionRunKey, guestSessionRunMarkerKey, GUEST_RUN_TTL_SEC,
  markGuestSessionRunLive, clearGuestSessionRunLive, isGuestSessionRunActive,
} from './guest-session-run';
import { startLiveRun, endLiveRun } from '../coding/live-runs';

const SID = '0f1e2d3c-4b5a-4697-8877-665544332211';

beforeEach(() => {
  redisStore.clear();
  redisDown = false;
});

describe('keys', () => {
  it('the in-process run key matches the shape chat-agent.service registers under', () => {
    expect(chatSessionRunKey(SID)).toBe(`chat:session:${SID}`);
    expect(guestSessionRunMarkerKey(SID)).toBe(`cm_session_run:${SID}`);
  });
});

describe('marker lifecycle', () => {
  it('mark writes the marker with the liveness TTL; clear drops it', async () => {
    await markGuestSessionRunLive(SID);
    const row = redisStore.get(guestSessionRunMarkerKey(SID));
    expect(row).toBeDefined();
    expect(row!.ex).toBe(GUEST_RUN_TTL_SEC);
    expect(await isGuestSessionRunActive(SID)).toBe(true);
    await clearGuestSessionRunLive(SID);
    expect(redisStore.has(guestSessionRunMarkerKey(SID))).toBe(false);
    expect(await isGuestSessionRunActive(SID)).toBe(false);
  });

  it('a Redis outage never throws: mark is best-effort, active reads false', async () => {
    redisDown = true;
    await expect(markGuestSessionRunLive(SID)).resolves.toBeUndefined();
    await expect(clearGuestSessionRunLive(SID)).resolves.toBeUndefined();
    expect(await isGuestSessionRunActive(SID)).toBe(false);
  });
});

describe('isGuestSessionRunActive — local registry OR marker', () => {
  it('a run live in THIS process answers true without touching Redis', async () => {
    redisDown = true; // would throw if consulted
    startLiveRun(chatSessionRunKey(SID));
    try {
      expect(await isGuestSessionRunActive(SID)).toBe(true);
    } finally {
      endLiveRun(chatSessionRunKey(SID));
    }
  });

  it('a run live on ANOTHER instance (marker only) answers true', async () => {
    redisStore.set(guestSessionRunMarkerKey(SID), { value: String(Date.now()), ex: GUEST_RUN_TTL_SEC });
    expect(await isGuestSessionRunActive(SID)).toBe(true);
  });

  it('no run anywhere answers false', async () => {
    expect(await isGuestSessionRunActive(SID)).toBe(false);
  });
});
