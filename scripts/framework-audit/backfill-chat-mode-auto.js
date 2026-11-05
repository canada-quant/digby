#!/usr/bin/env node
/**
 * backfill-chat-mode-auto.js — ONE-SHOT WRITE (owner 2026-09-26: "for chat session
 * default all chats to auto even supervisors and fleet supervisors").
 *
 * Sets `crossmodel_chats.mode = 'auto'` on every EXISTING chat whose owner is not a
 * child (Digby Kids chats are never touched) — fleet / project supervisor chats
 * INCLUDED — and PRESERVES the previous value in the context store (the same
 * "store" table the memory domain uses; memory/context-store.ts conventions):
 *     namespacePath `<chatId>:mode-backfill`, key `previous`
 *     value { previousMode, at, run, isSupervisor, isProjectSupervisor }
 * so nothing is lost and `--revert` restores it byte-for-byte. The runtime treats
 * a stored 'auto' as "route per send" (human turns → the Auto router; machine
 * wakes → the compute policy with the L2 preset as the fail-open fallback —
 * types.ts storedModeToPreset) and a LEGACY stored level as that preset, so an
 * un-backfilled chat behaves identically — this script is a CLEANUP, not a
 * prerequisite.
 *
 * DRY RUN BY DEFAULT (prints counts per previous mode; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-chat-mode-auto.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-chat-mode-auto.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-chat-mode-auto.js --revert           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-chat-mode-auto.js --revert --apply   # restore + drop the store rows
 * Options: --limit N (cap the rows touched this invocation; re-run to continue),
 *          --batch N (rows per transaction, default 200), --run <id> (stamp; default a timestamp),
 *          --skip-runtime-check (bypass the runtime guard below; env BACKFILL_RUNTIME_CHECK_DISABLED=1 is the same).
 *
 * RUNTIME GUARD (2026-09-26 rollout audit, finding supervisors-auto-1): the forward
 * `--apply` is only safe on a backend that UNDERSTANDS a stored 'auto'. Before eb74abd8
 * the wake path (coding/schedule.service.ts) mapped any stored mode outside
 * {thinking, deep_research, deep_research_all} to single_thinking, so backfilling AHEAD
 * of that deploy would have silently downgraded every supervisor wake from L2 to L1.
 * Because prodq.sh runs this file INSIDE the live container, `runtimeSupportsAuto()` loads
 * the SAME `/app/dist/modules/crossmodel/types` the box serves and requires
 * `storedModeToPreset('auto') === 'thinking'`; a forward `--apply` on a runtime that fails
 * the check writes NOTHING and exits 3 (`refused: 'runtime_predates_auto'`). The dry run
 * and the revert report the check but are never gated (a stored LEVEL is understood by
 * every runtime). Fail-closed on purpose — this is an owner-run write, not a machine lane.
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is the ONE
 * deliberate exception — an owner-directed write one-shot — and every write sits behind
 * `--apply`; without it the script is a read-only probe like the others. Each chat's
 * update is guarded (`WHERE mode = <the mode we recorded>`), so a chat whose mode moved
 * between the read and the write is left alone and counted under `skippedChanged`.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from
 * /app): `require('/app/dist/config/database')` is the backend's own Prisma client.
 * Testable offline: `module.exports.run({ prisma, argv })` takes a mocked client
 * (backend/src/scripts/backfill-chat-mode-auto.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage. Exit 3 = forward --apply refused by the runtime guard (nothing written).
 */
'use strict';

const NS_SUFFIX = ':mode-backfill';
const STORE_KEY = 'previous';
const TARGET_MODE = 'auto';
const DEFAULT_BATCH = 200;

function parseArgs(argv) {
  const out = { apply: false, revert: false, limit: null, batch: DEFAULT_BATCH, run: null, help: false, skipRuntimeCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--revert') out.revert = true;
    else if (a === '--skip-runtime-check') out.skipRuntimeCheck = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a.startsWith('--batch=')) out.batch = Number(a.slice('--batch='.length));
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit < 0)) throw new Error('--limit must be a non-negative number');
  if (!Number.isFinite(out.batch) || out.batch < 1) throw new Error('--batch must be a positive number');
  return out;
}

/** What a stored 'auto' must map to for a MACHINE wake (types.ts AUTO_MODE_PRESET) — L2. */
const AUTO_PRESET = 'thinking';
/** The compiled types module the live container serves (prodq.sh runs from /app); the cwd form is for a local `node dist` run. */
const RUNTIME_MODULE_CANDIDATES = ['/app/dist/modules/crossmodel/types', require('path').resolve(process.cwd(), 'dist', 'modules', 'crossmodel', 'types')];

/**
 * A loader that probes `candidates` in order and returns the first types module
 * it can require, rethrowing the last failure if none loads.
 *
 * Injectable on purpose (FLAKE-1, backlog 2026-11-03): the guard's answer must
 * not depend on whether SOME EARLIER SUITE in the same jest worker happened to
 * emit `backend/dist` (the decision-gate script suites compile into it), because
 * the default candidate list is cwd-relative. Tests point a loader at a per-test
 * temp root so both "no dist" and "dist present" are stated directly. This is a
 * seam for TESTS only — the production default below still probes exactly the
 * two candidates it always has, so the live guard is unchanged.
 */
function makeRuntimeLoader(candidates) {
  const list = Array.isArray(candidates) ? candidates : RUNTIME_MODULE_CANDIDATES;
  return function runtimeLoad() {
    let lastErr = null;
    for (const candidate of list) {
      try { return { mod: require(candidate), modulePath: candidate }; } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('no runtime types module found');
  };
}

/** The production loader: the container's served dist, then the cwd-relative one. */
const defaultRuntimeLoad = makeRuntimeLoader(RUNTIME_MODULE_CANDIDATES);

/**
 * Does the runtime this process runs beside understand a stored 'auto'?
 * `load` is injectable (tests); it returns `{ mod, modulePath }` or throws.
 * Never throws — a failure to prove support is a refusal, not a crash.
 */
function runtimeSupportsAuto({ load } = {}) {
  let loaded;
  try { loaded = (load || defaultRuntimeLoad)(); } catch (err) {
    return { ok: false, reason: 'types_module_missing', detail: String(err && err.message ? err.message : err) };
  }
  const mod = loaded && loaded.mod !== undefined ? loaded.mod : loaded;
  const modulePath = loaded && typeof loaded.modulePath === 'string' ? loaded.modulePath : null;
  if (!mod || typeof mod.storedModeToPreset !== 'function') return { ok: false, reason: 'storedModeToPreset_missing', modulePath };
  let preset;
  try { preset = mod.storedModeToPreset(TARGET_MODE); } catch (err) {
    return { ok: false, reason: 'storedModeToPreset_threw', modulePath, detail: String(err && err.message ? err.message : err) };
  }
  if (preset !== AUTO_PRESET) return { ok: false, reason: 'auto_not_l2', modulePath, detail: `storedModeToPreset('${TARGET_MODE}') = ${String(preset)} (expected ${AUTO_PRESET})` };
  return { ok: true, reason: 'auto_maps_to_l2', modulePath };
}

const runtimeCheckDisabledByEnv = (env) => /^(1|true|on|yes)$/i.test(String((env || process.env).BACKFILL_RUNTIME_CHECK_DISABLED || '').trim());

const nsFor = (chatId) => `${chatId}${NS_SUFFIX}`;
const chatIdOf = (namespacePath) => (typeof namespacePath === 'string' && namespacePath.endsWith(NS_SUFFIX) ? namespacePath.slice(0, -NS_SUFFIX.length) : null);

function countBy(rows, keyOf) {
  const counts = {};
  for (const r of rows) {
    const k = keyOf(r);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Every non-kid chat not already on 'auto' (supervisors included). */
async function selectCandidates(prisma, limit) {
  return prisma.crossModelChat.findMany({
    where: { mode: { not: TARGET_MODE }, user: { isChild: false } },
    select: { id: true, mode: true, isSupervisor: true, isProjectSupervisor: true },
    orderBy: { createdAt: 'asc' },
    ...(limit !== null && limit !== undefined ? { take: limit } : {}),
  });
}

/** Every store row the backfill wrote (the revert set). */
async function selectBackfilled(prisma, limit) {
  return prisma.contextStoreEntry.findMany({
    where: { key: STORE_KEY, namespacePath: { endsWith: NS_SUFFIX } },
    select: { namespacePath: true, value: true },
    orderBy: { namespacePath: 'asc' },
    ...(limit !== null && limit !== undefined ? { take: limit } : {}),
  });
}

async function applyForward(prisma, rows, opts) {
  const at = new Date().toISOString();
  let updated = 0;
  let skippedChanged = 0;
  for (const batch of chunk(rows, opts.batch)) {
    // The store row FIRST (so a crash between the two never loses the previous
    // value), then the guarded chat update — both in one transaction per batch.
    const ops = batch.flatMap((r) => [
      prisma.contextStoreEntry.upsert({
        where: { namespacePath_key: { namespacePath: nsFor(r.id), key: STORE_KEY } },
        create: { namespacePath: nsFor(r.id), key: STORE_KEY, value: { previousMode: r.mode, at, run: opts.run, isSupervisor: !!r.isSupervisor, isProjectSupervisor: !!r.isProjectSupervisor } },
        update: { value: { previousMode: r.mode, at, run: opts.run, isSupervisor: !!r.isSupervisor, isProjectSupervisor: !!r.isProjectSupervisor }, updatedAt: new Date() },
      }),
      prisma.crossModelChat.updateMany({ where: { id: r.id, mode: r.mode }, data: { mode: TARGET_MODE } }),
    ]);
    const results = await prisma.$transaction(ops);
    for (let i = 1; i < results.length; i += 2) {
      const n = results[i] && typeof results[i].count === 'number' ? results[i].count : 0;
      if (n === 1) updated += 1;
      else skippedChanged += 1;
    }
  }
  return { updated, skippedChanged };
}

async function applyRevert(prisma, rows, opts) {
  let restored = 0;
  let skippedChanged = 0;
  let dropped = 0;
  const restoredByMode = {};
  for (const batch of chunk(rows, opts.batch)) {
    for (const r of batch) {
      const chatId = chatIdOf(r.namespacePath);
      const previousMode = r.value && typeof r.value.previousMode === 'string' ? r.value.previousMode : null;
      if (!chatId || !previousMode) { skippedChanged += 1; continue; }
      // Restore ONLY a chat still on 'auto' (someone may have set a preset since);
      // the store row is dropped only when the restore landed — never lose it.
      const [upd] = await prisma.$transaction([
        prisma.crossModelChat.updateMany({ where: { id: chatId, mode: TARGET_MODE }, data: { mode: previousMode } }),
      ]);
      if (upd && upd.count === 1) {
        await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: r.namespacePath, key: STORE_KEY } });
        restored += 1;
        dropped += 1;
        restoredByMode[previousMode] = (restoredByMode[previousMode] || 0) + 1;
      } else {
        skippedChanged += 1;
      }
    }
  }
  return { restored, skippedChanged, dropped, restoredByMode };
}

/**
 * The whole one-shot. `prisma` is injectable (tests); `argv` defaults to the
 * process's. Returns the report object it also prints when `print` is true.
 */
async function run({ prisma, argv, print = false, runtimeCheck, env } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    const usage = 'usage: backfill-chat-mode-auto.js [--apply] [--revert] [--limit N] [--batch N] [--run <id>] [--skip-runtime-check]';
    if (print) console.log(usage);
    return { usage };
  }
  const client = prisma || require('/app/dist/config/database').default;
  const runId = opts.run || `mode-auto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'backfill-chat-mode-auto', run: runId, at: new Date().toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    // The runtime guard runs (and is reported) on every forward invocation; it
    // gates ONLY the write. Bypass: --skip-runtime-check or BACKFILL_RUNTIME_CHECK_DISABLED=1.
    const skip = opts.skipRuntimeCheck || runtimeCheckDisabledByEnv(env);
    report.runtime = { ...(runtimeCheck || runtimeSupportsAuto)(), skipped: skip };
    const rows = await selectCandidates(client, opts.limit);
    report.candidates = rows.length;
    report.byPreviousMode = countBy(rows, (r) => String(r.mode));
    report.supervisors = { fleet: rows.filter((r) => r.isSupervisor).length, project: rows.filter((r) => r.isProjectSupervisor).length };
    if (opts.apply && !skip && !report.runtime.ok) {
      report.refused = 'runtime_predates_auto';
      report.updated = 0;
      report.skippedChanged = 0;
      report.hint = `the backend this ran beside does not map a stored '${TARGET_MODE}' to ${AUTO_PRESET} (${report.runtime.reason}); a wake on it would run L1 — deploy eb74abd8+ first, or pass --skip-runtime-check`;
    } else if (opts.apply) Object.assign(report, await applyForward(client, rows, { batch: opts.batch, run: runId }));
    else report.wouldUpdate = rows.length;
  } else {
    const rows = await selectBackfilled(client, opts.limit);
    report.backfilledRows = rows.length;
    report.byPreviousMode = countBy(rows, (r) => String(r.value && r.value.previousMode));
    if (opts.apply) Object.assign(report, await applyRevert(client, rows, { batch: opts.batch }));
    else report.wouldRestore = rows.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, selectCandidates, selectBackfilled, applyForward, applyRevert, runtimeSupportsAuto, runtimeCheckDisabledByEnv, nsFor, chatIdOf, NS_SUFFIX, STORE_KEY, TARGET_MODE, AUTO_PRESET, DEFAULT_BATCH, RUNTIME_MODULE_CANDIDATES, makeRuntimeLoader };

if (require.main === module) {
  run({ print: true })
    .then((report) => process.exit(report && report.refused ? 3 : 0))
    .catch((err) => {
      const usage = /unknown argument|--limit must|--batch must/.test(String(err && err.message));
      console.error(`backfill-chat-mode-auto: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}
