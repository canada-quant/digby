/**
 * Regression guard for feedback ticket ca4798a6 (2026-09-02): the backend
 * jest config must NOT fall back to jest's default worker count
 * (logical cores - 1). On the shared coding box (up to 24 concurrent
 * sessions per host) that oversubscribes the host CPU and starves random
 * timing-sensitive tests past the 5s default timeout — a 23ms test flaked
 * with a 14.2s suite time under load, zero assertion failures, green
 * standalone and on replication. jest.config.js must cap maxWorkers and
 * honor the JEST_MAX_WORKERS escape hatch. If this test fails because you
 * removed or loosened the cap, re-read the ticket first.
 *
 * Extended for feedback ticket 7fbc34cd (2026-10-09): the config must ALSO
 * set workerIdleMemoryLimit so a full-suite worker tree cannot creep past a
 * bounded RSS on the shared host (the kernel OOM-killer picks the largest
 * RSS process when the HOST starves while this container's cgroup reads
 * healthy — two full-suite jest legs died to exactly that). Honor the
 * JEST_WORKER_IDLE_MB escape hatch (0 disables recycling).
 */
describe('jest.config.js maxWorkers cap (ticket ca4798a6)', () => {
  const ORIGINAL = process.env.JEST_MAX_WORKERS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.JEST_MAX_WORKERS;
    else process.env.JEST_MAX_WORKERS = ORIGINAL;
    jest.resetModules();
  });

  const loadConfig = (): { maxWorkers?: number | string } => {
    jest.resetModules();
    return require('../jest.config.js');
  };

  it('caps maxWorkers when JEST_MAX_WORKERS is unset', () => {
    delete process.env.JEST_MAX_WORKERS;
    const config = loadConfig();
    // A numeric cap must exist — an absent cap means jest defaults to
    // (cores - 1) workers, the oversubscription this guard pins against.
    expect(typeof config.maxWorkers).toBe('number');
    expect(config.maxWorkers).toBeGreaterThanOrEqual(1);
    // The cap must stay conservative (leave host headroom for co-tenant
    // sessions); raise this bound only with a deliberate, reviewed decision.
    expect(config.maxWorkers).toBeLessThanOrEqual(4);
  });

  it('honors the JEST_MAX_WORKERS escape hatch', () => {
    process.env.JEST_MAX_WORKERS = '8';
    expect(loadConfig().maxWorkers).toBe(8);
  });

  it('rejects a non-positive-integer JEST_MAX_WORKERS with a clear error', () => {
    process.env.JEST_MAX_WORKERS = 'lots';
    expect(() => loadConfig()).toThrow(/JEST_MAX_WORKERS/);
  });
});

describe('jest.config.js workerIdleMemoryLimit (ticket 7fbc34cd)', () => {
  const ORIGINAL_MAX = process.env.JEST_MAX_WORKERS;
  const ORIGINAL_IDLE = process.env.JEST_WORKER_IDLE_MB;

  afterEach(() => {
    if (ORIGINAL_MAX === undefined) delete process.env.JEST_MAX_WORKERS;
    else process.env.JEST_MAX_WORKERS = ORIGINAL_MAX;
    if (ORIGINAL_IDLE === undefined) delete process.env.JEST_WORKER_IDLE_MB;
    else process.env.JEST_WORKER_IDLE_MB = ORIGINAL_IDLE;
    jest.resetModules();
  });

  const loadConfig = (): { maxWorkers?: number | string; workerIdleMemoryLimit?: number } => {
    jest.resetModules();
    return require('../jest.config.js');
  };

  it('bounds worker RSS by default (recycling on — absent means jest spawns unbounded workers)', () => {
    delete process.env.JEST_MAX_WORKERS;
    delete process.env.JEST_WORKER_IDLE_MB;
    const config = loadConfig();
    expect(typeof config.workerIdleMemoryLimit).toBe('number');
    expect(config.workerIdleMemoryLimit).toBeGreaterThan(0);
    // Conservative: ≤ 2 GB — well inside the verify chain's per-leg 4096 MB
    // heap cap, never above it.
    expect(config.workerIdleMemoryLimit).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
  });

  it('honors the JEST_WORKER_IDLE_MB escape hatch (MB → bytes)', () => {
    process.env.JEST_WORKER_IDLE_MB = '1536';
    expect(loadConfig().workerIdleMemoryLimit).toBe(1536 * 1024 * 1024);
  });

  it('JEST_WORKER_IDLE_MB=0 disables recycling (key absent, jest default behavior)', () => {
    process.env.JEST_WORKER_IDLE_MB = '0';
    expect(loadConfig().workerIdleMemoryLimit).toBeUndefined();
  });

  it('rejects a non-numeric JEST_WORKER_IDLE_MB with a clear error', () => {
    process.env.JEST_WORKER_IDLE_MB = 'lots';
    expect(() => loadConfig()).toThrow(/JEST_WORKER_IDLE_MB/);
  });
});
