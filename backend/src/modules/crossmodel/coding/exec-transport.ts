/**
 * Exec TRANSPORT-death classification — a PURE leaf module, deliberately free of
 * imports.
 *
 * WHY IT IS A SEPARATE FILE (2026-11-03, family tool-failure-streak):
 * this predicate first lived in `container.service.ts`, and `tools.ts` imported
 * it from there. That looked harmless, but it put the whole
 * `container.service → prisma → config/database → config/env` graph on the
 * module-load path of `tools.ts`, so any suite importing `tools` (or `agent.ts`)
 * booted `parseEnv()`, which `process.exit(1)`s when DATABASE_URL / REDIS_URL /
 * JWT_SECRET are absent. CI documents the opposite contract (`.github/workflows/
 * ci.yml`: "No env block on purpose … the full suite passes env-less"), and 29
 * suites broke on exactly that — 27790 tests passed, zero assertion failures,
 * and every red was a suite failing to LOAD.
 *
 * The classification is string inspection and nothing else, so it belongs in a
 * leaf: import it from here, never from a module that reaches config/database.
 * Guarded by infra-not-model.tool-failure-streak.test.ts ("leaf-module" case),
 * which fails if this file ever grows an import.
 */

/**
 * True when an exec's stderr describes an INFRASTRUCTURE/TRANSPORT death rather
 * than the command's own result: the shell never ran at all (the session
 * container is gone / the daemon refused / exec is unavailable while a
 * container is re-provisioned) or the runtime killed it (SIGKILL/OOM, timeout,
 * maxBuffer). Callers use this to name the failure as INFRA instead of
 * reporting it as a bad command/pattern/scope.
 *
 * FAMILY tool-failure-streak (2026-11-03, 9 auto-filed mishaps): eight members
 * read `Tool grep failed: the search did not complete ([exit: 1]) — this is NOT
 * a "no matches" verdict. Narrow the scope/path, …` for calls whose pattern AND
 * path were perfectly VALID (all six recorded call shapes replay GREEN in the
 * worktree — they were only ever mislabeled). Each lane obeyed the advice,
 * changed its pattern/scope, racked the 3× streak and had `grep` withheld for a
 * model round — the derail breaker convicted the MODEL for a dead BOX, and the
 * mishap it auto-filed blamed the model. An infra death must be named as infra.
 *
 * Deliberately does NOT treat a bare `[exit: 1]` as transport: that is the
 * ambiguous one (a real `git grep` fatal also exits 1). A missing pipeline
 * sentinel PLUS one of these signatures is what proves the shell died — see
 * the grep branch in tools.ts, which requires both.
 */
export function isExecTransportFailure(stderr: string | undefined | null): boolean {
  const s = (stderr || '').slice(0, 2000);
  if (!s) return false;
  if (/No such container|is not running|Error response from daemon|Cannot connect to the Docker daemon|Isolated execution is temporarily unavailable/i.test(s)) return true;
  if (/runc-process|OCI runtime exec failed|stdout maxBuffer length exceeded/i.test(s)) return true;
  if (/— timed out\]/.test(s)) return true;
  // A spawn that never produced a shell (no docker CLI on the box, ENOENT on the
  // exec helper) is the same class of death: the command never ran. Anchored
  // `[exec failed]` by the tool wrapper that catches it (ticket 0c6a47de).
  if (/\[exec failed\][^\n]*(?:spawn|ENOENT|EACCES|command not found)/i.test(s)) return true;
  // The runtime killed the wrapper (SIGKILL/OOM) — never the command's verdict.
  return /\[exit: (?:137|143|error)\b/.test(s);
}