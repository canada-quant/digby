/**
 * getValidToken label-miss fallback (FO f121-hook, 2026-10-12).
 *
 * Live incident: the owner disconnected + reconnected the GitHub connector in
 * the 2026-10-11/12 breach-cleanup window; the rows came back under labels that
 * no project had pinned ("pastapaul_canadaquant", "Pastapaul"). The coding
 * path's label-pinned getValidToken (agent.ts → project.githubLabel) then
 * returned null and refused EVERY push/PR/merge fleet-wide while unlabeled
 * connector reads (list_github_repos, 100 repos, live updatedAt) kept working
 * in the same process — and ZERO "getValidToken failed" rows appeared in 24h
 * because the !row path logged nothing. The fallback below restores write
 * availability deterministically (first-connected, createdAt asc) with a warn;
 * GITHUB_LABEL_FALLBACK_DISABLED=1 restores the old hard failure.
 */

const findUnique = jest.fn();
const findFirst = jest.fn();
const warn = jest.fn();
const error = jest.fn();
const decryptWith = jest.fn(() => 'gho_decrypted_token');
const recordLoopMetric = jest.fn();
// e1cca01d fleet latch: a STATEFUL Redis mock — the key space actually holds
// what NX set (the review follow-up: the first flat mock could not catch the
// fallback row releasing the latch key the miss had just acquired; a mock
// without state pins nothing about holding).
const redisStore = new Map<string, string>();
const redisSet = jest.fn(async (key: string, val: string, opts?: unknown): Promise<string | null> => {
  const nx = !!(opts && typeof opts === 'object' && (opts as { NX?: boolean }).NX);
  if (nx && redisStore.has(key)) return null;
  redisStore.set(key, val);
  return 'OK';
});
const redisDel = jest.fn(async (key: string): Promise<number> => (redisStore.delete(key) ? 1 : 0));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { gitHubOAuthToken: { findUnique, findFirst } },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { warn, error, info: jest.fn() },
}));
jest.mock('../google/crypto', () => ({ decryptWith }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric,
  LOOP_METRIC_KINDS: { GITHUB_LABEL_FALLBACK: 'github_label_fallback' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (key: string, val: string, opts?: unknown) => redisSet(key, val, opts),
    del: (key: string) => redisDel(key),
  },
}));

import { getValidToken, __resetGithubLabelFallbackLatchForTests } from './token-manager';

/** The e1cca01d metric rides a fire-and-forget dynamic import — flush it. */
const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

const UID = 'user-1';
const ROW_OLD = { label: 'pastapaul_canadaquant', username: 'canada-quant', accessToken: 'enc_old' };
const ROW_NEW = { label: 'Pastapaul', username: 'canada-quant', accessToken: 'enc_new' };

describe('getValidToken', () => {
  const prevFlag = process.env.GITHUB_LABEL_FALLBACK_DISABLED;
  beforeEach(() => {
    jest.clearAllMocks();
    // e1cca01d: clearAllMocks does NOT undo mockResolvedValue overrides from a
    // previous test — restore the STATEFUL default and a fresh key space, or
    // an earlier override silently bypasses the latch semantics under test.
    redisStore.clear();
    redisSet.mockImplementation(async (key: string, val: string, opts?: unknown): Promise<string | null> => {
      const nx = !!(opts && typeof opts === 'object' && (opts as { NX?: boolean }).NX);
      if (nx && redisStore.has(key)) return null;
      redisStore.set(key, val);
      return 'OK';
    });
    redisDel.mockImplementation(async (key: string): Promise<number> => (redisStore.delete(key) ? 1 : 0));
    __resetGithubLabelFallbackLatchForTests(); // the held-set is module state — every test starts unlatched
    delete process.env.GITHUB_LABEL_FALLBACK_DISABLED;
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.GITHUB_LABEL_FALLBACK_DISABLED;
    else process.env.GITHUB_LABEL_FALLBACK_DISABLED = prevFlag;
  });

  it('label-pinned HIT returns the decrypted token and never queries the fallback', async () => {
    findUnique.mockResolvedValue(ROW_OLD);
    const tok = await getValidToken(UID, 'pastapaul_canadaquant');
    expect(tok).toBe('gho_decrypted_token');
    expect(findUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: UID, label: 'pastapaul_canadaquant' } } });
    expect(findFirst).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(decryptWith).toHaveBeenCalledWith('enc_old', 'GITHUB_TOKEN_ENCRYPTION_KEY');
  });

  it('no label → first-connected row, unchanged legacy behaviour', async () => {
    findFirst.mockResolvedValue(ROW_OLD);
    const tok = await getValidToken(UID);
    expect(tok).toBe('gho_decrypted_token');
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: UID }, orderBy: { createdAt: 'asc' } });
    expect(findUnique).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('label MISS + another account connected → deterministic first-connected fallback + warn naming both labels', async () => {
    findUnique.mockResolvedValue(null); // the pinned label matches no row
    findFirst.mockResolvedValue(ROW_OLD); // first-connected (createdAt asc)
    const tok = await getValidToken(UID, 'stale-pinned-label');
    expect(tok).toBe('gho_decrypted_token');
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: UID }, orderBy: { createdAt: 'asc' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"stale-pinned-label"');
    expect(warn.mock.calls[0][0]).toContain('"pastapaul_canadaquant"');
  });

  it('label MISS + NO accounts at all → null (refusal stands), no warn', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(null);
    const tok = await getValidToken(UID, 'stale-pinned-label');
    expect(tok).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('kill switch GITHUB_LABEL_FALLBACK_DISABLED=1 → label miss is a hard null, no fallback query', async () => {
    process.env.GITHUB_LABEL_FALLBACK_DISABLED = '1';
    findUnique.mockResolvedValue(null);
    const tok = await getValidToken(UID, 'stale-pinned-label');
    expect(tok).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('decrypt failure → null + error log (existing behaviour preserved on the fallback row too)', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_NEW);
    decryptWith.mockImplementationOnce(() => { throw new Error('bad key'); });
    const tok = await getValidToken(UID, 'stale-pinned-label');
    expect(tok).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('getValidToken failed');
  });

  // ── e1cca01d label-miss warn latch (f156 shape, fleet-wide Redis NX) ──
  // The 2026-10-18 prod burst: 6 projects pinned the dead "pasta_paul" label
  // and a busy lane hot-looped 73 byte-identical warn rows across 6 hours —
  // one standing degraded state, one message, no new information per row.
  // The FALLBACK must keep happening every call; only the logging is latched.
  // A 24 h TTL spaces rows ≥24 h apart, so any rolling 24 h window holds ≤2
  // rows in ≤2 distinct hours — below RULE1_MIN_HOURS=3 (review finding 1).

  it('e1cca01d: second miss within the window → fallback STILL happens, warn latched, ONE metric row', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    redisSet.mockResolvedValue('OK');                        // first miss acquires
    const tok1 = await getValidToken(UID, 'stale-pinned-label');
    expect(tok1).toBe('gho_decrypted_token');                // fallback fired
    expect(warn).toHaveBeenCalledTimes(1);                   // first miss warns
    await flushMicrotasks();                                 // the metric rides a dynamic import
    expect(recordLoopMetric).toHaveBeenCalledTimes(1);
    redisSet.mockResolvedValue(null as unknown as string);                        // key held → NX misses
    const tok2 = await getValidToken(UID, 'stale-pinned-label');
    expect(tok2).toBe('gho_decrypted_token');                // fallback STILL fires
    expect(findFirst).toHaveBeenCalledTimes(2);               // the fallback query ran again
    expect(warn).toHaveBeenCalledTimes(1);                   // but the warn is latched
    await flushMicrotasks();
    expect(recordLoopMetric).toHaveBeenCalledTimes(1);       // one metric per window
    const tok3 = await getValidToken(UID, 'stale-pinned-label');
    expect(tok3).toBe('gho_decrypted_token');
    expect(warn).toHaveBeenCalledTimes(1);                   // still latched
    const m = recordLoopMetric.mock.calls[0][0];
    expect(m.kind).toBe('github_label_fallback');
    expect(m.meta.pinnedLabel).toBe('stale-pinned-label');
    expect(m.meta.fallbackLabel).toBe('pastapaul_canadaquant');
  });

  it('e1cca01d: latch is FLEET-wide — a different process (fresh module latch set) does NOT re-warn while the key is held', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    redisSet.mockResolvedValue('OK');
    await getValidToken(UID, 'stale-pinned-label');
    expect(warn).toHaveBeenCalledTimes(1);
    // simulate another process: local held-set cleared, Redis still holds the key
    __resetGithubLabelFallbackLatchForTests();
    redisSet.mockResolvedValue(null as unknown as string);
    await getValidToken(UID, 'stale-pinned-label');
    expect(warn).toHaveBeenCalledTimes(1);                    // fleet-latched
    expect(findFirst).toHaveBeenCalledTimes(2);               // fallback still fires
  });

  it('e1cca01d: latch is per-(userId,label) — a different label or user still acquires and warns', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    redisSet.mockResolvedValue('OK');
    await getValidToken(UID, 'stale-pinned-label');       // acquires UID|stale-pinned-label
    await getValidToken(UID, 'other-dead-label');         // different label → acquires + warns
    await getValidToken('user-2', 'stale-pinned-label');  // different user → acquires + warns
    await flushMicrotasks();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(recordLoopMetric).toHaveBeenCalledTimes(3);
  });

  it('e1cca01d: Redis unavailable → FAIL-OPEN (the degraded state is never silenced by an infra hiccup)', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    redisSet.mockRejectedValue(new Error('redis down'));
    await getValidToken(UID, 'stale-pinned-label');
    await getValidToken(UID, 'stale-pinned-label');
    expect(warn).toHaveBeenCalledTimes(2);                // every miss warns — loud but honest
  });

  it('e1cca01d: label HIT releases a latch this process holds — a later re-break warns at once, not at TTL', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    redisSet.mockResolvedValue('OK');
    await getValidToken(UID, 'stale-pinned-label');       // miss → warn + latch acquired
    expect(warn).toHaveBeenCalledTimes(1);
    // the owner re-pins/reconnects: the label now HITS
    findUnique.mockResolvedValue(ROW_OLD);
    await getValidToken(UID, 'stale-pinned-label');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(redisDel).toHaveBeenCalledWith(`github:label-fallback-warn:${UID}|stale-pinned-label`);
    // and breaks again → acquires fresh, warns at once
    findUnique.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    await getValidToken(UID, 'stale-pinned-label');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('e1cca01d: regression — a fallback miss must NOT release the just-acquired latch (stateful Redis)', async () => {
    // The bug this pins: the first commit's release fired on ANY non-null row,
    // including the FALLBACK row — miss → acquire → warn → DEL the same key →
    // the latch never held. Only a genuine label hit may release.
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    await getValidToken(UID, 'stale-pinned-label');   // miss → acquire + warn
    expect(warn).toHaveBeenCalledTimes(1);
    expect(redisStore.has(`github:label-fallback-warn:${UID}|stale-pinned-label`)).toBe(true);
    await getValidToken(UID, 'stale-pinned-label');   // miss again → still latched
    expect(warn).toHaveBeenCalledTimes(1);
    expect(redisStore.has(`github:label-fallback-warn:${UID}|stale-pinned-label`)).toBe(true);
    // genuine HIT → released
    findUnique.mockResolvedValue(ROW_OLD);
    await getValidToken(UID, 'stale-pinned-label');
    expect(redisStore.has(`github:label-fallback-warn:${UID}|stale-pinned-label`)).toBe(false);
  });

  it('e1cca01d: label hit by ANOTHER process\'s latch does not DEL (only this process\'s acquisitions are released)', async () => {
    findUnique.mockResolvedValue(ROW_OLD);                // label hits immediately
    await getValidToken(UID, 'any-label');                // no latch was ever acquired here
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('e1cca01d: kill switch GITHUB_LABEL_FALLBACK_WARN_MS=0 → legacy every-miss warn, no latch key set', async () => {
    const saved = process.env.GITHUB_LABEL_FALLBACK_WARN_MS;
    process.env.GITHUB_LABEL_FALLBACK_WARN_MS = '0';
    try {
      findUnique.mockResolvedValue(null);
      findFirst.mockResolvedValue(ROW_OLD);
      redisSet.mockClear();
      await getValidToken(UID, 'stale-pinned-label');
      await getValidToken(UID, 'stale-pinned-label');
      await getValidToken(UID, 'stale-pinned-label');
      expect(warn).toHaveBeenCalledTimes(3);              // every miss warns
      expect(redisSet).not.toHaveBeenCalled();            // no latch armed
      await flushMicrotasks();
      expect(recordLoopMetric).toHaveBeenCalledTimes(3);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_LABEL_FALLBACK_WARN_MS;
      else process.env.GITHUB_LABEL_FALLBACK_WARN_MS = saved;
    }
  });

  it('e1cca01d: EMPTY env value (the compose `${VAR:-}` forward shape) → the DEFAULT window, not a disarmed latch (review finding 4)', async () => {
    const saved = process.env.GITHUB_LABEL_FALLBACK_WARN_MS;
    process.env.GITHUB_LABEL_FALLBACK_WARN_MS = '';
    try {
      findUnique.mockResolvedValue(null);
      findFirst.mockResolvedValue(ROW_OLD);
      redisSet.mockResolvedValueOnce('OK').mockResolvedValue(null);
      await getValidToken(UID, 'stale-pinned-label');
      await getValidToken(UID, 'stale-pinned-label');
      expect(warn).toHaveBeenCalledTimes(1);              // default latch active
      const [, ttlArg] = redisSet.mock.calls[0].slice(1);
      expect(ttlArg).toMatchObject({ NX: true, PX: 24 * 60 * 60 * 1000 });
    } finally {
      if (saved === undefined) delete process.env.GITHUB_LABEL_FALLBACK_WARN_MS;
      else process.env.GITHUB_LABEL_FALLBACK_WARN_MS = saved;
    }
  });

  it('e1cca01d: control characters in a label cannot forge log lines (review finding 9)', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(ROW_OLD);
    redisSet.mockResolvedValue('OK');
    await getValidToken(UID, 'evil\nbreak "quote"');
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).not.toContain('\n');
    expect(msg).toContain('evil break "quote"');          // sanitized, single line
  });
});
