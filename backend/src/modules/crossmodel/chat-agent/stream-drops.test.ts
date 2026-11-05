/**
 * chat-agent/stream-drops.ts — the stream-drop wave's switches and throttled
 * loop metrics (2026-10-20). Pins: the per-key + per-process throttle (a
 * flapping client writes one row per window, a storm is capped, the key map is
 * bounded); the sse_viewer_drop / sse_reattach row shapes (counts only, box
 * label); SSE_DROP_TELEMETRY_DISABLED=1 writes nothing; the beacon gate.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecord(...a),
}));

import {
  allowStreamMetric, __resetStreamMetricThrottle, __streamMetricKeyCount, recordSseViewerDrop, recordSseReattach, allowStreamBeacon,
  streamBoxMeta, streamSessionKey, guestStreamAttachDisabled, sseEarlyHeartbeatDisabled, sseDropTelemetryDisabled,
  STREAM_METRIC_KEY_INTERVAL_MS, STREAM_METRIC_MAX_PER_MIN, STREAM_METRIC_MAX_KEYS, STREAM_BEACON_MAX_PER_CLIENT_PER_MIN,
} from './stream-drops';

const SWITCHES = ['GUEST_STREAM_ATTACH_DISABLED', 'SSE_EARLY_HEARTBEAT_DISABLED', 'SSE_DROP_TELEMETRY_DISABLED'];

beforeEach(() => {
  jest.clearAllMocks();
  __resetStreamMetricThrottle();
  for (const s of SWITCHES) delete process.env[s];
});
afterAll(() => { for (const s of SWITCHES) delete process.env[s]; });

describe('switches', () => {
  it('each reads exactly "1" at call time', () => {
    expect([guestStreamAttachDisabled(), sseEarlyHeartbeatDisabled(), sseDropTelemetryDisabled()]).toEqual([false, false, false]);
    process.env.GUEST_STREAM_ATTACH_DISABLED = '1';
    process.env.SSE_EARLY_HEARTBEAT_DISABLED = '1';
    process.env.SSE_DROP_TELEMETRY_DISABLED = 'true'; // only '1' arms a switch
    expect([guestStreamAttachDisabled(), sseEarlyHeartbeatDisabled(), sseDropTelemetryDisabled()]).toEqual([true, true, false]);
  });
});

describe('allowStreamMetric — the throttle', () => {
  it('one row per key per window; another key is independent', () => {
    const t0 = 1_000_000;
    expect(allowStreamMetric('drop:stream:c1', t0)).toBe(true);
    expect(allowStreamMetric('drop:stream:c1', t0 + STREAM_METRIC_KEY_INTERVAL_MS - 1)).toBe(false);
    expect(allowStreamMetric('drop:stream:c2', t0 + 1)).toBe(true);
    expect(allowStreamMetric('drop:stream:c1', t0 + STREAM_METRIC_KEY_INTERVAL_MS)).toBe(true);
  });

  it('a storm across many keys is capped per process per minute, and the cap resets the next minute', () => {
    const t0 = 5_000_000;
    let admitted = 0;
    for (let i = 0; i < STREAM_METRIC_MAX_PER_MIN * 3; i++) if (allowStreamMetric(`k${i}`, t0 + i)) admitted++;
    expect(admitted).toBe(STREAM_METRIC_MAX_PER_MIN);
    expect(allowStreamMetric('fresh', t0 + 60_000)).toBe(true);
  });

  it('the key map stays bounded (keys older than the window are pruned at the cap) — memory never grows with clients', () => {
    let t = 9_000_000;
    // Spread keys over many minutes so the per-minute cap never blocks the fill.
    for (let i = 0; i < STREAM_METRIC_MAX_KEYS + 10; i++) { allowStreamMetric(`key-${i}`, t); t += 1_001; }
    expect(__streamMetricKeyCount()).toBeLessThan(STREAM_METRIC_MAX_KEYS);
    expect(__streamMetricKeyCount()).toBeLessThanOrEqual(Math.ceil(STREAM_METRIC_KEY_INTERVAL_MS / 1_001) + 10);
  });
});

describe('recordSseViewerDrop / recordSseReattach', () => {
  it('sse_viewer_drop: counts + surface + box label, never text; value = the connection lifetime', () => {
    expect(recordSseViewerDrop({ surface: 'guest', path: 'remote', sessionKey: 'anon-s1', elapsedMs: 1234.7, eventsWritten: 9, runElapsedMs: 50_000, guest: true })).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const row = mockRecord.mock.calls[0][0];
    expect(row).toMatchObject({
      kind: 'sse_viewer_drop', sessionId: 'anon-s1', value: 1235, unit: 'ms',
      meta: { surface: 'guest', path: 'remote', elapsedMs: 1235, eventsWritten: 9, runElapsedMs: 50_000, guest: true, host: expect.any(String) },
    });
  });

  it('a flapping viewer on one chat writes ONE drop row per window', () => {
    for (let i = 0; i < 10; i++) recordSseViewerDrop({ surface: 'attach', sessionKey: 'c1', elapsedMs: 10, eventsWritten: 1, guest: false });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('sse_reattach carries the source', () => {
    recordSseReattach({ surface: 'attach', source: 'truncated', sessionKey: 'c1', events: 2000, guest: false });
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ kind: 'sse_reattach', sessionId: 'c1', meta: { surface: 'attach', source: 'truncated', events: 2000, guest: false } });
  });

  it('SSE_DROP_TELEMETRY_DISABLED=1: nothing is written, the beacon gate refuses', () => {
    process.env.SSE_DROP_TELEMETRY_DISABLED = '1';
    expect(recordSseViewerDrop({ surface: 'stream', elapsedMs: 1, eventsWritten: 0, guest: true })).toBe(false);
    expect(recordSseReattach({ surface: 'guest', source: 'local', guest: true })).toBe(false);
    expect(allowStreamBeacon('stream_drop', 'anon-s1')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('allowStreamBeacon throttles per event + key', () => {
    expect(allowStreamBeacon('stream_drop', 'anon-s1')).toBe(true);
    expect(allowStreamBeacon('stream_drop', 'anon-s1')).toBe(false);
    expect(allowStreamBeacon('stream_resume', 'anon-s1')).toBe(true);
  });
});

// Review 2026-10-20: POST /ux/beacon is public and its chat uuid is never
// checked, so the beacons are untrusted input — they must not be able to spend
// the budget of the rows the SERVER observed, and one client must not spend
// the beacon budget for everyone.
describe('the beacon budget is its own, and capped per client', () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

  it('a full minute of beacons with fresh chat uuids never silences the server drop / reattach rows', () => {
    const now = 7_000_000;
    let admitted = 0;
    for (let i = 0; i < STREAM_METRIC_MAX_PER_MIN * 2; i++) if (allowStreamBeacon('stream_drop', uuid(i), `client-${i}`, now)) admitted++;
    expect(admitted).toBe(STREAM_METRIC_MAX_PER_MIN); // the beacon budget caps beacons
    expect(allowStreamMetric('drop:attach:real-chat', now, 'server')).toBe(true);
    expect(recordSseViewerDrop({ surface: 'stream', sessionKey: 'real-chat-2', elapsedMs: 5, eventsWritten: 1, guest: false })).toBe(true);
    expect(recordSseReattach({ surface: 'attach', source: 'local', sessionKey: 'real-chat-3', guest: false })).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(2);
  });

  it('the server rows cannot spend the beacon budget either', () => {
    const now = 8_000_000;
    for (let i = 0; i < STREAM_METRIC_MAX_PER_MIN; i++) allowStreamMetric(`drop:stream:c${i}`, now, 'server');
    expect(allowStreamMetric('drop:stream:one-more', now, 'server')).toBe(false);
    expect(allowStreamBeacon('stream_drop', 'anon-s1', 'client-a', now)).toBe(true);
  });

  it('one client rotating chat uuids admits only its per-client cap; another client is unaffected', () => {
    const now = 9_000_000;
    let admitted = 0;
    for (let i = 0; i < 30; i++) if (allowStreamBeacon('stream_drop', uuid(i), 'client-a', now + i)) admitted++;
    expect(admitted).toBe(STREAM_BEACON_MAX_PER_CLIENT_PER_MIN);
    expect(allowStreamBeacon('stream_drop', uuid(100), 'client-b', now + 50)).toBe(true);
    // The client's cap resets the next minute.
    expect(allowStreamBeacon('stream_drop', uuid(200), 'client-a', now + 60_000)).toBe(true);
  });

  it('a refusal spends nothing: a throttled key does not count toward the client cap, a capped client does not count toward the budget', () => {
    const now = 10_000_000;
    for (let i = 0; i < 20; i++) allowStreamBeacon('stream_drop', 'same-chat', 'client-a', now + i); // 1 admitted, 19 key-throttled
    let admitted = 0;
    for (let i = 0; i < 10; i++) if (allowStreamBeacon('stream_drop', uuid(i), 'client-a', now + 100 + i)) admitted++;
    expect(admitted).toBe(STREAM_BEACON_MAX_PER_CLIENT_PER_MIN - 1);
    // client-a's refused tries spent no budget: the rest of the minute's budget is still there for others.
    let others = 0;
    for (let i = 0; i < STREAM_METRIC_MAX_PER_MIN; i++) if (allowStreamBeacon('stream_drop', uuid(1000 + i), `other-${i}`, now + 200)) others++;
    expect(others).toBe(STREAM_METRIC_MAX_PER_MIN - STREAM_BEACON_MAX_PER_CLIENT_PER_MIN);
  });

  it('no client known ⇒ only the key throttle and the beacon budget apply', () => {
    let admitted = 0;
    for (let i = 0; i < 10; i++) if (allowStreamBeacon('stream_drop', uuid(i), null, 11_000_000)) admitted++;
    expect(admitted).toBe(10);
  });
});

describe('helpers', () => {
  it('streamBoxMeta: BOX_NAME wins, else the 12-char hostname; BG_COLOR only when set', () => {
    expect(streamBoxMeta({ BOX_NAME: 'example-ca-app-b' } as any, 'abcdef0123456789')).toEqual({ host: 'example-ca-app-b' });
    expect(streamBoxMeta({} as any, 'abcdef0123456789')).toEqual({ host: 'abcdef012345' });
    expect(streamBoxMeta({ BG_COLOR: 'green' } as any, 'h')).toEqual({ host: 'h', colour: 'green' });
  });
  it('streamSessionKey: the chat id, else anon-<sid>, else none', () => {
    expect(streamSessionKey('c1', 's1')).toBe('c1');
    expect(streamSessionKey(null, 's1')).toBe('anon-s1');
    expect(streamSessionKey(undefined, undefined)).toBeUndefined();
  });
});
