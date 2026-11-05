/**
 * scripts/framework-audit/backfill-chat-mode-auto.js — the owner's 2026-09-26
 * "default all chats to auto even supervisors" one-shot, on a MOCKED Prisma
 * client: dry-run by default (counts per previous mode, no writes), --apply
 * writes the store row FIRST and the guarded chat update, --revert restores
 * from the store rows and drops them, kids are never selected, a chat whose
 * mode moved between read and write is skipped (never overwritten), and the
 * previous value is never lost.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storedModeToPreset, AUTO_MODE_PRESET } from '../modules/crossmodel/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'backfill-chat-mode-auto.js'));

/** A runtime that understands a stored 'auto' (what eb74abd8+ serves). */
const okCheck = () => ({ ok: true, reason: 'auto_maps_to_l2', modulePath: 'test' });
/** The pre-eb74abd8 runtime shape: no storedModeToPreset export at all. */
const oldRuntime = () => ({ ok: false, reason: 'storedModeToPreset_missing', modulePath: 'test' });

type Chat = { id: string; mode: string; isSupervisor?: boolean; isProjectSupervisor?: boolean; childOwner?: boolean; createdAt: number };

/** An in-memory Prisma double covering exactly the calls the script makes. */
function makePrisma(chats: Chat[]) {
  const store = new Map<string, { namespacePath: string; key: string; value: any }>();
  const nsKey = (ns: string, key: string) => `${ns}|${key}`;
  const prisma: any = {
    chats, store,
    crossModelChat: {
      findMany: jest.fn(async ({ where, take }: any) => {
        let rows = chats.filter((c) => c.mode !== where.mode.not && !(where.user?.isChild === false && c.childOwner));
        rows = rows.sort((a, b) => a.createdAt - b.createdAt);
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((c) => ({ id: c.id, mode: c.mode, isSupervisor: !!c.isSupervisor, isProjectSupervisor: !!c.isProjectSupervisor }));
      }),
      updateMany: jest.fn(({ where, data }: any) => ({
        // PrismaPromise-like: executes when awaited inside $transaction.
        then: (res: any, rej: any) => Promise.resolve().then(() => {
          const row = chats.find((c) => c.id === where.id && (where.mode === undefined || c.mode === where.mode));
          if (row) row.mode = data.mode;
          return { count: row ? 1 : 0 };
        }).then(res, rej),
      })),
    },
    contextStoreEntry: {
      upsert: jest.fn(({ where, create, update }: any) => ({
        then: (res: any, rej: any) => Promise.resolve().then(() => {
          const k = nsKey(where.namespacePath_key.namespacePath, where.namespacePath_key.key);
          const existing = store.get(k);
          const row = existing ? { ...existing, value: update.value } : { namespacePath: create.namespacePath, key: create.key, value: create.value };
          store.set(k, row);
          return row;
        }).then(res, rej),
      })),
      findMany: jest.fn(async ({ where, take }: any) => {
        let rows = [...store.values()].filter((r) => r.key === where.key && r.namespacePath.endsWith(where.namespacePath.endsWith));
        rows = rows.sort((a, b) => a.namespacePath.localeCompare(b.namespacePath));
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((r) => ({ namespacePath: r.namespacePath, value: r.value }));
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const k = nsKey(where.namespacePath, where.key);
        const had = store.delete(k);
        return { count: had ? 1 : 0 };
      }),
    },
    $transaction: jest.fn(async (ops: any[]) => {
      const out: any[] = [];
      for (const op of ops) out.push(await op);
      return out;
    }),
  };
  return prisma;
}

const fleet = (): Chat[] => [
  { id: 'c-sup', mode: 'thinking', isSupervisor: true, createdAt: 1 },
  { id: 'c-psup', mode: 'thinking', isProjectSupervisor: true, createdAt: 2 },
  { id: 'c-l1', mode: 'single_thinking', createdAt: 3 },
  { id: 'c-fast', mode: 'fast', createdAt: 4 },
  { id: 'c-l3', mode: 'deep_research', createdAt: 5 },
  { id: 'c-already', mode: 'auto', createdAt: 6 },
  { id: 'c-kid', mode: 'single_thinking', childOwner: true, createdAt: 7 },
];

/**
 * FLAKE-1 replay — the "dist-emitting suite FIRST in the same worker" leg.
 *
 * The banked repro (2026-10-13, on a branch that never reached main) was that a
 * suite compiling into `backend/dist` EARLIER in the same jest worker flipped the
 * guard's default-loader answer: the cwd-relative candidate then resolved, so
 * `runtimeSupportsAuto()` returned ok:true where the suite had asserted
 * `types_module_missing`. Jest gives no intra-worker ordering guarantee, so the
 * only honest replay is to emit that dist HERE, FIRST, and then assert the guard
 * still answers the same thing.
 *
 * This describe sits above every other block in the file on purpose: its
 * beforeAll runs before anything else in this worker. afterAll removes what it
 * created — and leaves a dist that was already there (e.g. `npm run build` on a
 * dev box) untouched.
 */
describe('dist-emitting prelude (FLAKE-1 replay: an earlier suite in this worker compiles into backend/dist)', () => {
  const distTypes = path.resolve(process.cwd(), 'dist', 'modules', 'crossmodel', 'types.js');
  let createdDir: string | null = null;
  let prior: Buffer | null = null;

  beforeAll(() => {
    const distRoot = path.resolve(process.cwd(), 'dist');
    if (!fs.existsSync(distRoot)) createdDir = distRoot;
    // A dev box may already carry a real `npm run build` artifact here. Never
    // destroy it: remember the exact bytes and put them back in afterAll.
    if (fs.existsSync(distTypes)) prior = fs.readFileSync(distTypes);
    fs.mkdirSync(path.dirname(distTypes), { recursive: true });
    // The artifact `tsc` emits for src/modules/crossmodel/types.ts.
    fs.writeFileSync(distTypes, [
      "exports.AUTO_MODE_PRESET = 'thinking';",
      'exports.storedModeToPreset = function (m) { return m === "auto" ? exports.AUTO_MODE_PRESET : m; };',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (createdDir) fs.rmSync(createdDir, { recursive: true, force: true });
    else if (prior) fs.writeFileSync(distTypes, prior);
    else fs.rmSync(distTypes, { force: true });
  });

  it('with that dist present, the guard answer is UNCHANGED — no order dependence (FLAKE-1)', () => {
    // Non-vacuous: the emitted dist really is loadable through the production
    // candidate list, so the replay is not passing because nothing was emitted.
    const emitted = script.runtimeSupportsAuto();
    expect(emitted).toMatchObject({ ok: true, reason: 'auto_maps_to_l2' });
    expect(emitted.modulePath).toBe(path.resolve(process.cwd(), 'dist', 'modules', 'crossmodel', 'types'));
    // …and a world WITHOUT a dist still refuses, stated explicitly rather than
    // inherited from whatever this worker happened to leave on disk.
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-dist-absent-'));
    try {
      expect(script.runtimeSupportsAuto({ load: script.makeRuntimeLoader([path.join(emptyRoot, 'dist', 'modules', 'crossmodel', 'types')]) }))
        .toMatchObject({ ok: false, reason: 'types_module_missing' });
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('parseArgs', () => {
  it('dry-run by default; --apply / --revert / --limit / --batch / --run parse; garbage is refused', () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, revert: false, limit: null, batch: 200, run: null });
    expect(script.parseArgs(['--apply', '--limit', '5', '--batch=50', '--run', 'r1'])).toMatchObject({ apply: true, limit: 5, batch: 50, run: 'r1' });
    expect(script.parseArgs(['--revert', '--apply'])).toMatchObject({ apply: true, revert: true });
    expect(script.parseArgs([])).toMatchObject({ skipRuntimeCheck: false });
    expect(script.parseArgs(['--apply', '--skip-runtime-check'])).toMatchObject({ apply: true, skipRuntimeCheck: true });
    expect(() => script.parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => script.parseArgs(['--limit', '-1'])).toThrow(/--limit/);
    expect(() => script.parseArgs(['--batch', '0'])).toThrow(/--batch/);
  });
});

describe('forward backfill', () => {
  it('DRY RUN: selects every non-kid chat not already on auto (supervisors included), counts per previous mode, writes NOTHING', async () => {
    const prisma = makePrisma(fleet());
    const report = await script.run({ prisma, argv: [] });
    expect(report).toMatchObject({ action: 'forward', dryRun: true, apply: false, candidates: 5, wouldUpdate: 5 });
    expect(report.byPreviousMode).toEqual({ thinking: 2, single_thinking: 1, fast: 1, deep_research: 1 });
    expect(report.supervisors).toEqual({ fleet: 1, project: 1 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    expect(prisma.chats.map((c: Chat) => c.mode)).toEqual(['thinking', 'thinking', 'single_thinking', 'fast', 'deep_research', 'auto', 'single_thinking']);
    // The kid's chat and the already-auto chat were never candidates.
    expect(prisma.crossModelChat.findMany.mock.calls[0][0].where).toMatchObject({ mode: { not: 'auto' }, user: { isChild: false } });
  });

  it("--apply: every candidate becomes 'auto', the previous mode lands in the store row FIRST (namespace <chatId>:mode-backfill / key previous), kids untouched", async () => {
    const prisma = makePrisma(fleet());
    const report = await script.run({ prisma, argv: ['--apply', '--run', 'r-test'], runtimeCheck: okCheck });
    expect(report).toMatchObject({ action: 'forward', apply: true, dryRun: false, candidates: 5, updated: 5, skippedChanged: 0 });
    expect(report.byPreviousMode).toEqual({ thinking: 2, single_thinking: 1, fast: 1, deep_research: 1 });
    const modes = Object.fromEntries(prisma.chats.map((c: Chat) => [c.id, c.mode]));
    expect(modes).toEqual({ 'c-sup': 'auto', 'c-psup': 'auto', 'c-l1': 'auto', 'c-fast': 'auto', 'c-l3': 'auto', 'c-already': 'auto', 'c-kid': 'single_thinking' });
    expect(prisma.store.get('c-sup:mode-backfill|previous').value).toMatchObject({ previousMode: 'thinking', run: 'r-test', isSupervisor: true, isProjectSupervisor: false, at: expect.any(String) });
    expect(prisma.store.get('c-fast:mode-backfill|previous').value.previousMode).toBe('fast');
    expect(prisma.store.has('c-kid:mode-backfill|previous')).toBe(false);
    expect(prisma.store.has('c-already:mode-backfill|previous')).toBe(false);
    // Store upsert precedes the guarded chat update inside each transaction.
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops).toHaveLength(10);
    expect(prisma.contextStoreEntry.upsert.mock.calls[0][0].where.namespacePath_key).toEqual({ namespacePath: 'c-sup:mode-backfill', key: 'previous' });
    expect(prisma.crossModelChat.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'c-sup', mode: 'thinking' }, data: { mode: 'auto' } });
  });

  it('--apply is GUARDED: a chat whose mode moved between the read and the write is skipped (counted skippedChanged), never overwritten', async () => {
    const chats = fleet();
    const prisma = makePrisma(chats);
    // Simulate a concurrent change: after the selection, c-l1 moves to deep_research.
    const original = prisma.crossModelChat.findMany.getMockImplementation()!;
    prisma.crossModelChat.findMany.mockImplementationOnce(async (q: any) => {
      const rows = await original(q);
      chats.find((c) => c.id === 'c-l1')!.mode = 'deep_research';
      return rows;
    });
    const report = await script.run({ prisma, argv: ['--apply'], runtimeCheck: okCheck });
    expect(report).toMatchObject({ updated: 4, skippedChanged: 1 });
    expect(chats.find((c) => c.id === 'c-l1')!.mode).toBe('deep_research');
  });

  it('--limit caps the rows per invocation and --batch splits transactions', async () => {
    const prisma = makePrisma(fleet());
    const report = await script.run({ prisma, argv: ['--apply', '--limit', '3', '--batch', '2'], runtimeCheck: okCheck });
    expect(report).toMatchObject({ candidates: 3, updated: 3 });
    expect(prisma.crossModelChat.findMany.mock.calls[0][0].take).toBe(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // 2 + 1 rows
    expect(prisma.chats.filter((c: Chat) => c.mode === 'auto')).toHaveLength(4); // 3 backfilled + the one already on auto
  });
});

describe('--revert', () => {
  it('DRY RUN lists the backfilled rows per previous mode and writes nothing; --apply restores each chat still on auto and drops its store row; a chat someone moved off auto keeps its store row (never lost)', async () => {
    const prisma = makePrisma(fleet());
    await script.run({ prisma, argv: ['--apply'], runtimeCheck: okCheck });
    const dry = await script.run({ prisma, argv: ['--revert'] });
    expect(dry).toMatchObject({ action: 'revert', dryRun: true, backfilledRows: 5, wouldRestore: 5 });
    expect(dry.byPreviousMode).toEqual({ thinking: 2, single_thinking: 1, fast: 1, deep_research: 1 });
    expect(prisma.chats.every((c: Chat) => c.id === 'c-kid' || c.mode === 'auto')).toBe(true);
    expect(prisma.store.size).toBe(5);
    // The owner pins one chat to a preset after the backfill — the revert must not clobber it.
    prisma.chats.find((c: Chat) => c.id === 'c-l3')!.mode = 'thinking';
    const applied = await script.run({ prisma, argv: ['--revert', '--apply'] });
    expect(applied).toMatchObject({ action: 'revert', apply: true, restored: 4, skippedChanged: 1, dropped: 4 });
    expect(applied.restoredByMode).toEqual({ thinking: 2, single_thinking: 1, fast: 1 });
    const modes = Object.fromEntries(prisma.chats.map((c: Chat) => [c.id, c.mode]));
    expect(modes).toEqual({ 'c-sup': 'thinking', 'c-psup': 'thinking', 'c-l1': 'single_thinking', 'c-fast': 'fast', 'c-l3': 'thinking', 'c-already': 'auto', 'c-kid': 'single_thinking' });
    expect([...prisma.store.keys()]).toEqual(['c-l3:mode-backfill|previous']); // kept — its previous value (deep_research) is not lost
    expect(prisma.store.get('c-l3:mode-backfill|previous').value.previousMode).toBe('deep_research');
  });

  it('nsFor / chatIdOf round-trip; a foreign store row is ignored', () => {
    expect(script.nsFor('abc')).toBe('abc:mode-backfill');
    expect(script.chatIdOf('abc:mode-backfill')).toBe('abc');
    expect(script.chatIdOf('abc:thread')).toBeNull();
  });
});

describe('runtime guard (2026-09-26 rollout audit, supervisors-auto-1)', () => {
  it("runtimeSupportsAuto: the REAL types.ts contract passes — a stored 'auto' is the L2 preset for a machine wake", () => {
    expect(AUTO_MODE_PRESET).toBe('thinking');
    expect(script.AUTO_PRESET).toBe(AUTO_MODE_PRESET);
    expect(script.runtimeSupportsAuto({ load: () => ({ mod: { storedModeToPreset }, modulePath: 'src' }) })).toEqual({ ok: true, reason: 'auto_maps_to_l2', modulePath: 'src' });
  });

  it('runtimeSupportsAuto: a missing module, a module without the export, a throwing export and an L1 mapping each REFUSE (never throw)', () => {
    expect(script.runtimeSupportsAuto({ load: () => { throw new Error('Cannot find module'); } })).toMatchObject({ ok: false, reason: 'types_module_missing', detail: expect.stringContaining('Cannot find module') });
    expect(script.runtimeSupportsAuto({ load: () => ({ mod: {}, modulePath: 'x' }) })).toMatchObject({ ok: false, reason: 'storedModeToPreset_missing', modulePath: 'x' });
    expect(script.runtimeSupportsAuto({ load: () => ({ mod: { storedModeToPreset: () => { throw new Error('boom'); } } }) })).toMatchObject({ ok: false, reason: 'storedModeToPreset_threw' });
    // The pre-eb74abd8 wake rule: anything outside {thinking, deep_research, deep_research_all} ran at L1.
    const legacy = (m: string) => (m === 'thinking' || m === 'deep_research' ? m : 'single_thinking');
    expect(script.runtimeSupportsAuto({ load: () => ({ mod: { storedModeToPreset: legacy } }) })).toMatchObject({ ok: false, reason: 'auto_not_l2', detail: expect.stringContaining('single_thinking') });
    // A bare module (no {mod} wrapper) is accepted too.
    expect(script.runtimeSupportsAuto({ load: () => ({ storedModeToPreset }) })).toMatchObject({ ok: true });
    // The PRODUCTION candidate list is pinned: the container's served dist first,
    // then the cwd-relative one. This is what the live guard probes on a box, so
    // it must not drift just because tests needed a seam.
    expect(script.RUNTIME_MODULE_CANDIDATES[0]).toBe('/app/dist/modules/crossmodel/types');
    expect(script.RUNTIME_MODULE_CANDIDATES[1]).toBe(path.resolve(process.cwd(), 'dist', 'modules', 'crossmodel', 'types'));
    // makeRuntimeLoader() with no argument IS the production loader (same list).
    expect(script.makeRuntimeLoader() instanceof Function).toBe(true);
  });

  it('makeRuntimeLoader is HERMETIC: the same guard answer whether or not another suite emitted backend/dist (FLAKE-1)', () => {
    // FLAKE-1 repro: the guard's default candidates are cwd-relative, so a suite
    // that compiles into backend/dist BEFORE this one in the same jest worker
    // changed the answer — the loader found a dist and reported ok:true where the
    // suite asserted types_module_missing. Each leg below states its world
    // explicitly via a per-test temp root, so suite order can never decide it.
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-dist-empty-'));
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-dist-present-'));
    // A dist-EMITTING shape: what tsc writes for src/modules/crossmodel/types.ts,
    // the exact artifact the decision-gate script suites leave behind.
    const emittedDir = path.join(distRoot, 'dist', 'modules', 'crossmodel');
    fs.mkdirSync(emittedDir, { recursive: true });
    fs.writeFileSync(path.join(emittedDir, 'types.js'), [
      "exports.AUTO_MODE_PRESET = 'thinking';",
      'exports.storedModeToPreset = function (m) { return m === "auto" ? exports.AUTO_MODE_PRESET : m; };',
      '',
    ].join('\n'));
    try {
      const before = script.runtimeSupportsAuto({ load: script.makeRuntimeLoader([path.join(emptyRoot, 'dist', 'modules', 'crossmodel', 'types')]) });
      const after = script.runtimeSupportsAuto({ load: script.makeRuntimeLoader([path.join(distRoot, 'dist', 'modules', 'crossmodel', 'types')]) });
      // Same guard, two worlds, no order dependence: the empty root still refuses…
      expect(before).toMatchObject({ ok: false, reason: 'types_module_missing' });
      // …and the emitted dist is still recognised as a valid runtime (the real
      // eb74abd8+ contract), so the seam did not blind the check.
      expect(after).toMatchObject({ ok: true, reason: 'auto_maps_to_l2' });
      expect(after.modulePath).toBe(path.join(distRoot, 'dist', 'modules', 'crossmodel', 'types'));
      // Re-asking the empty root AFTER the dist root loaded is still a refusal —
      // require() caching cannot make the answer sticky across candidates.
      expect(script.runtimeSupportsAuto({ load: script.makeRuntimeLoader([path.join(emptyRoot, 'dist', 'modules', 'crossmodel', 'types')]) }))
        .toMatchObject({ ok: false, reason: 'types_module_missing' });
      // The production list stays the live one (a seam for tests, not a rewrite):
      // an explicit empty candidate list proves the loader loops and rethrows
      // rather than falling back to anything.
      expect(() => script.makeRuntimeLoader([])()).toThrow(/no runtime types module found/);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });

  it('forward --apply on a runtime that predates auto writes NOTHING and reports refused (exit 3 path); the dry run still reports the check', async () => {
    const prisma = makePrisma(fleet());
    const dry = await script.run({ prisma, argv: [], runtimeCheck: oldRuntime });
    expect(dry).toMatchObject({ dryRun: true, candidates: 5, wouldUpdate: 5, runtime: { ok: false, reason: 'storedModeToPreset_missing', skipped: false } });
    expect(dry.refused).toBeUndefined();
    const report = await script.run({ prisma, argv: ['--apply'], runtimeCheck: oldRuntime });
    expect(report).toMatchObject({ action: 'forward', apply: true, refused: 'runtime_predates_auto', candidates: 5, updated: 0, skippedChanged: 0, runtime: { ok: false, skipped: false } });
    expect(report.hint).toMatch(/deploy eb74abd8\+ first/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    expect(prisma.store.size).toBe(0);
    expect(prisma.chats.map((c: Chat) => c.mode)).toEqual(['thinking', 'thinking', 'single_thinking', 'fast', 'deep_research', 'auto', 'single_thinking']);
  });

  it('--skip-runtime-check and BACKFILL_RUNTIME_CHECK_DISABLED=1 bypass the guard (reported as skipped) and the write proceeds', async () => {
    const a = makePrisma(fleet());
    const viaFlag = await script.run({ prisma: a, argv: ['--apply', '--skip-runtime-check'], runtimeCheck: oldRuntime });
    expect(viaFlag).toMatchObject({ updated: 5, runtime: { ok: false, skipped: true } });
    expect(viaFlag.refused).toBeUndefined();
    const b = makePrisma(fleet());
    const viaEnv = await script.run({ prisma: b, argv: ['--apply'], runtimeCheck: oldRuntime, env: { BACKFILL_RUNTIME_CHECK_DISABLED: '1' } });
    expect(viaEnv).toMatchObject({ updated: 5, runtime: { ok: false, skipped: true } });
    expect(script.runtimeCheckDisabledByEnv({ BACKFILL_RUNTIME_CHECK_DISABLED: 'true' })).toBe(true);
    expect(script.runtimeCheckDisabledByEnv({ BACKFILL_RUNTIME_CHECK_DISABLED: '0' })).toBe(false);
    expect(script.runtimeCheckDisabledByEnv({})).toBe(false);
  });

  it('a passing runtime writes as before; --revert --apply is NEVER gated (a stored level is understood by every runtime)', async () => {
    const prisma = makePrisma(fleet());
    const fwd = await script.run({ prisma, argv: ['--apply'], runtimeCheck: okCheck });
    expect(fwd).toMatchObject({ updated: 5, runtime: { ok: true, skipped: false } });
    const rev = await script.run({ prisma, argv: ['--revert', '--apply'], runtimeCheck: oldRuntime });
    expect(rev).toMatchObject({ action: 'revert', restored: 5, dropped: 5 });
    expect(rev.runtime).toBeUndefined();
    expect(rev.refused).toBeUndefined();
    expect(prisma.chats.find((c: Chat) => c.id === 'c-sup')!.mode).toBe('thinking');
  });
});
