// Worker cap (feedback ticket ca4798a6, 2026-09-02): jest's default is
// (logical cores - 1) workers — 7 on this 8-core container. On the shared
// coding box (up to 24 concurrent sessions per host) that oversubscribes the
// host CPU so badly that a 23ms test was starved past the 5s default timeout
// (feedback-images guard test: 0.327s isolated vs 14.2s contended full-suite,
// zero assertion failures, green on replication). Fewer, fed workers beat
// many, thrashing ones: 4 keeps the ~190-suite run in the 1-2 min band while
// leaving host headroom for co-tenant sessions. Escape hatch:
// JEST_MAX_WORKERS=<positive int> (e.g. 8 on a quiet dedicated box); the
// --maxWorkers CLI flag still overrides everything. Guard test:
// src/jest-config.test.ts.
const envMaxWorkers = process.env.JEST_MAX_WORKERS;
let maxWorkers = 4;
if (envMaxWorkers !== undefined && envMaxWorkers !== '') {
  if (!/^[1-9]\d*$/.test(envMaxWorkers)) {
    throw new Error(`JEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(envMaxWorkers)}`);
  }
  maxWorkers = Number(envMaxWorkers);
}

// Worker memory recycling (feedback ticket 7fbc34cd, 2026-10-09): the shared
// dev container's HOST box (33 GB, several co-tenant lanes' containers) can
// transiently starve while this cgroup still reads healthy — the kernel
// OOM-killer then SIGKILLs the largest-RSS process, which is a full-suite
// jest worker tree (~1114 test files here). maxWorkers caps CONCURRENCY but
// not a long-lived worker's RSS creep across suites. workerIdleMemoryLimit
// (jest ≥29) makes jest-worker recycle any child whose memory stays above the
// limit AFTER finishing a suite (idle check), bounding the tree's footprint:
// 1 GB per worker ≈ 25% of the per-leg 4096 MB heap cap the verify chain
// exports (NODE_OPTIONS --max-old-space-size=4096) — a worker can never OOM
// itself below the cap, and recycling happens between suites, never mid-test.
// Escape hatch: JEST_WORKER_IDLE_MB=<positive int> (0 disables recycling);
// the CLI flag still overrides everything. Guard: src/jest-config.test.ts.
//
// Scheduling note (adversarial review of 7fbc34cd, finding F2): setting
// workerIdleMemoryLimit also disables jest's small-run IN-BAND scheduling
// (@jest/core testSchedulerHelper — in-band requires !workerIdleMemoryLimit),
// so a scoped single-suite run always spawns a worker (~a few hundred MB V8
// baseline, no correctness impact; explicit --runInBand / --detectOpenHandles
// still force in-band). JEST_WORKER_IDLE_MB=0 restores the old scheduling.
const envIdleMb = process.env.JEST_WORKER_IDLE_MB;
let workerIdleMemoryLimit = 1024 * 1024 * 1024; // 1 GB in bytes
if (envIdleMb !== undefined && envIdleMb !== '') {
  if (!/^\d+$/.test(envIdleMb)) {
    throw new Error(`JEST_WORKER_IDLE_MB must be a non-negative integer (MB), got ${JSON.stringify(envIdleMb)}`);
  }
  const mb = Number(envIdleMb);
  workerIdleMemoryLimit = mb > 0 ? mb * 1024 * 1024 : undefined; // 0 = off
}

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  maxWorkers,
  ...(workerIdleMemoryLimit !== undefined ? { workerIdleMemoryLimit } : {}),
  // Redirects TMPDIR to a durable repo-local .jest-tmp/ for all workers — see
  // jest.global-setup.js (the container's /tmp is wiped aggressively; suites
  // staging real-git fixtures there raced the wipe — workspace-restore flake).
  globalSetup: '<rootDir>/jest.global-setup.js',
  // Jest's OWN cache must live on the durable root too: cacheDirectory is
  // resolved during config normalization in the main process — BEFORE
  // globalSetup runs — so the TMPDIR redirect can never cover it, and the
  // default os.tmpdir()/jest_rt cache gets wiped mid-run (haste-map persist
  // then crashes the whole run before any test executes — reviewer repro,
  // PR #357 review finding 1). A shared cache dir across concurrent runs is
  // standard (content-addressed, version-keyed like the default jest_rt).
  cacheDirectory: '<rootDir>/.jest-tmp/jest-cache',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/scripts/**/*.test.ts'],
  // transpile-only (isolatedModules) + diagnostics off: the repo tsconfig uses the
  // deprecated moduleResolution=node10 which trips full type-checking; we only need
  // the test to RUN, not type-check (that's covered separately by `tsc --noEmit`).
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }],
  },
};
