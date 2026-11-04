/**
 * Replay test — ticket 372ff5a7: review-diff-gate.test.ts afterEach threw
 * ENOTEMPTY on a NESTED `.git/objects` during `fs.rmSync(repo, {recursive,
 * force})` teardown (CI run 37922630409, main sha 664311203, PR #1373's
 * merge — 18,657 passed / 1 failed, every other check green).
 *
 * The racer: a git child's detached work (gc --auto / reflog writers) in its
 * exit window, still populating the tree the afterEach was removing. `force`
 * swallows ENOENT only; Node's own `maxRetries` re-issues the nested rmdir but
 * re-enumerates children only ONCE, so a writer landing after enumeration is
 * never cleared (reviewer-probed on Node 20) — rmTreeSync (rm-tree-sync.ts)
 * closes the gap by retrying the WHOLE rm (fresh enumeration per attempt) on
 * the transient exit-lag codes (ENOTEMPTY/EBUSY/EPERM) while still throwing
 * real errors immediately.
 *
 * The rm is dependency-injected (the fs module namespace is non-configurable
 * under ts-jest, so spyOn(fs,'rmSync') cannot intercept it) to simulate the
 * straggler writer exactly. Asserts BOTH halves:
 *   1. the exact CI shape — nested ENOTEMPTY on attempt 1 → attempt 2 clears;
 *   2. real errors still throw immediately (no silent-swallow regression).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rmTreeSync, RM_TREE_TRANSIENT_CODES } from './rm-tree-sync';

describe('rmTreeSync — 372ff5a7 ENOTEMPTY teardown race replay', () => {
  it('absorbs a nested .git/objects ENOTEMPTY from a straggler git writer and completes the rm (CI run 37922630409 shape)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-tree-372ff5a7-'));
    try {
      // The fixture under repair: a real git-shaped tree with the nested dir CI choked on.
      const nested = path.join(root, '.git', 'objects', 'pack');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'pack-abc.pack'), 'pack');

      let calls = 0;
      const enotemptyOnFirst = (dir: string) => {
        calls += 1;
        if (calls === 1) {
          // straggler git child in its exit window writes into the nested dir
          // AFTER the rm pass — the rm then sees a non-empty directory at the
          // rmdir step, exactly the CI failure line.
          fs.writeFileSync(path.join(nested, 'pack-late.pack'), 'late git write');
          throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${nested}'`), { code: 'ENOTEMPTY' });
        }
        fs.rmSync(dir, { recursive: true, force: true });
      };

      expect(() => rmTreeSync(root, { rm: enotemptyOnFirst })).not.toThrow();
      expect(calls).toBe(2);
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a writer racing the whole budget is bounded, not a hang — final attempt is a normal rm', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-tree-372ff5a7-'));
    try {
      let calls = 0;
      const enotemptyFirst3 = (dir: string) => {
        calls += 1;
        if (calls <= 3) throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
        fs.rmSync(dir, { recursive: true, force: true });
      };
      expect(() => rmTreeSync(root, { attempts: 4, delayMs: 1, rm: enotemptyFirst3 })).not.toThrow();
      expect(calls).toBe(4);
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-transient errors still throw on the first attempt (no silent swallow)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-tree-372ff5a7-'));
    try {
      const eacces = () => {
        throw Object.assign(new Error("EACCES: permission denied, unlink '/etc/passwd'"), { code: 'EACCES' });
      };
      expect(() => rmTreeSync(root, { rm: eacces })).toThrow('EACCES');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('EBUSY and EPERM are retried too (the full transient exit-lag set), with no cross-code misses', () => {
    for (const code of RM_TREE_TRANSIENT_CODES) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-tree-372ff5a7-'));
      try {
        let calls = 0;
        const busyOnce = (dir: string) => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error(`${code}: transient`), { code });
          fs.rmSync(dir, { recursive: true, force: true });
        };
        expect(() => rmTreeSync(root, { delayMs: 1, rm: busyOnce })).not.toThrow();
        expect(calls).toBe(2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
