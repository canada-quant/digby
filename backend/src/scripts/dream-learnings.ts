/**
 * dream:learnings — runnable dedupe/merge ("dream") pass over the durable
 * learnings file (audit #11 close-out).
 *
 * Loads `.digby/notes/learnings.md`, runs coding-memory.service's pure
 * dreamLearnings() (mechanical dedupe of verbatim entries + a bounded
 * utility-LLM merge of near-duplicate clusters — degrades to mechanical-only
 * without provider keys), writes the result back when it changed, and prints
 * a summary diff count.
 *
 * Path resolution: $LEARNINGS_PATH (explicit FILE override) wins; otherwise
 * the first CLI arg is the REPO ROOT (default: this checkout's root) and the
 * file is <root>/.digby/notes/learnings.md.
 *
 * Exit codes:
 *   0 — clean pass (file rewritten, or nothing to fold)
 *   1 — file unreadable / write failure
 *   2 — the ANTI-WIPE GUARD tripped (the pass would drop >30% of entries):
 *       the script REFUSES, the file is left byte-identical.
 *
 * Usage:
 *   npm run dream:learnings                # this checkout's .digby/notes/learnings.md
 *   npm run dream:learnings -- /opt/crossmodel
 *   LEARNINGS_PATH=/tmp/learnings.md npm run dream:learnings
 */

import fs from 'fs';
import path from 'path';

/** The anti-wipe refusal exit code (pinned by the script's tests). */
export const GUARD_EXIT_CODE = 2;

/**
 * dreamLearnings itself is pure content-in → content-out (utility LLM only,
 * no DB), but its module graph reaches config/env, which process.exit(1)s in
 * an env-less shell. Seed inert placeholders for the required keys BEFORE the
 * (deferred) import so the script runs anywhere the repo is checked out —
 * nothing here ever opens a DB/Redis connection.
 */
function seedInertEnvDefaults(): void {
  process.env.DATABASE_URL ??= 'postgresql://inert:inert@127.0.0.1:5432/inert';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'inert-dream-learnings-placeholder-secret-0000000000';
  process.env.JWT_REFRESH_SECRET ??= 'inert-dream-learnings-placeholder-secret-0000000000';
}

/** $LEARNINGS_PATH (file) > <repoRootArg>/.digby/notes/learnings.md > this checkout's copy. */
export function resolveLearningsPath(repoRootArg?: string): string {
  const envPath = String(process.env.LEARNINGS_PATH ?? '').trim();
  if (envPath) return path.resolve(envPath);
  // src/scripts (tsx) and dist/scripts (compiled) both sit three levels below the repo root.
  const root = repoRootArg ? path.resolve(repoRootArg) : path.resolve(__dirname, '..', '..', '..');
  return path.join(root, '.digby', 'notes', 'learnings.md');
}

/** The runnable pass. Returns the process exit code; never throws. */
export async function runDreamLearnings(
  repoRootArg?: string,
  log: (line: string) => void = console.log,
): Promise<number> {
  const file = resolveLearningsPath(repoRootArg);
  let markdown: string;
  try {
    markdown = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    log(`dream:learnings — cannot read ${file}: ${err?.message ?? err}`);
    return 1;
  }

  seedInertEnvDefaults();
  const { dreamLearnings } = await import('../modules/crossmodel/coding/coding-memory.service');
  const result = await dreamLearnings(markdown);

  if (result.guardTripped) {
    log(`dream:learnings — REFUSED (anti-wipe guard): ${result.warning ?? 'the pass would gut the file'}`);
    log(`dream:learnings — ${file} left untouched.`);
    return GUARD_EXIT_CODE;
  }

  if (!result.changed) {
    log(`dream:learnings — nothing to fold (${result.entriesBefore} entries, 0 dropped); ${file} untouched.`);
    return 0;
  }

  try {
    fs.writeFileSync(file, result.content);
  } catch (err: any) {
    log(`dream:learnings — rewrite of ${file} failed: ${err?.message ?? err}`);
    return 1;
  }
  const dropped = result.entriesBefore - result.entriesAfter;
  log(
    `dream:learnings — ${file}: ${result.entriesBefore} → ${result.entriesAfter} entries `
    + `(-${dropped}: ${result.removedVerbatim} verbatim duplicate(s) removed, ${result.mergedNearDupes} near-duplicate(s) merged).`,
  );
  return 0;
}

/* istanbul ignore next — the CLI gate; the logic above is what the tests pin */
if (require.main === module) {
  runDreamLearnings(process.argv[2])
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`dream:learnings — unexpected failure: ${err?.message ?? err}`);
      process.exit(1);
    });
}
