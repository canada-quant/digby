/**
 * Ticket 372ff5a7 — ENOTEMPTY rmSync teardown race (CI run 37922630409, main
 * sha 664311203): `fs.rmSync(repo, {recursive, force})` in an afterEach threw
 * ENOTEMPTY on a NESTED `.git/objects` because a git child's detached work
 * (gc --auto / reflog writers surviving the awaited parent call) was still
 * populating the tree being removed.
 *
 * Why Node's own retry knobs don't cover it (reviewer-probed on Node 20):
 * `internal/fs/rimraf` DOES re-issue the nested `rmdirSync` on
 * ENOTEMPTY/EBUSY/EMFILE/ENFILE/EPERM (`maxRetries`), but it re-enumerates the
 * directory's children only ONCE, before that retry loop — a writer landing
 * after the enumeration keeps every retry rmdir failing forever. rmTreeSync
 * closes the gap by retrying the WHOLE rm (fresh enumeration each attempt).
 *
 * ENOTEMPTY / EBUSY / EPERM are the transient exit-lag set; any other code is
 * a real error and still throws loudly. Test-support helper (used by
 * review-diff-gate.test.ts and its 372ff5a7 replay) — not imported by prod.
 */
import * as fs from 'fs';

export const RM_TREE_TRANSIENT_CODES = ['ENOTEMPTY', 'EBUSY', 'EPERM'] as const;

/** Synchronous bounded sleep — no fake-timer interference, works on the main thread. */
const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface RmTreeOptions {
  /** Retry budget (default 6; non-finite values clamp to the default). */
  attempts?: number;
  /** Base backoff in ms, linear per attempt (default 50 — ~750ms worst case). */
  delayMs?: number;
  /** Injectable rm for tests (defaults to fs.rmSync). */
  rm?: (dir: string) => void;
}

/**
 * Remove `dir` recursively, retrying while a concurrent writer (a git child in
 * its exit window) transiently re-populates it.
 */
export const rmTreeSync = (dir: string, opts: RmTreeOptions = {}): void => {
  const attempts = Number.isFinite(opts.attempts) ? (opts.attempts as number) : 6;
  const delayMs = Number.isFinite(opts.delayMs) ? (opts.delayMs as number) : 50;
  const rm = opts.rm ?? ((d: string) => fs.rmSync(d, { recursive: true, force: true }));
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= attempts || !code || !(RM_TREE_TRANSIENT_CODES as readonly string[]).includes(code)) throw err;
    }
    sleepSync(delayMs * attempt);
  }
};
