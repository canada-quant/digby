/**
 * Self-contained runtime guard (ticket 21c68e74, 2026-10-23) — "dyld[7104]:
 * Library not loaded: @rpath/libnode.147.dylib … com.digby.agent crash-loops".
 *
 * LIVE MISHAP REPLAYD (the ticket's incident): the CLI installer (install.sh,
 * ticket 51d8dbe0) copies the HOMEBREW `node` binary verbatim to
 * ~/Library/Application Support/Digby/bin/DigbyAgent — the launchd service's
 * runtime, at a stable path OUTSIDE the agent tree. Homebrew's node is a
 * KEG-COUPLED build: its Mach-O load commands are
 *     LC_LOAD_DYLIB @rpath/libnode.147.dylib
 *     LC_RPATH      @loader_path
 *     LC_RPATH      @loader_path/../lib        (← DigbyAgent → …/Digby/lib/)
 *     LC_LOAD_DYLIB @@HOMEBREW_PREFIX@@/opt/…  (~100 keg dylibs)
 * so the copy only runs while the exact keg it was poured from still exists.
 * `brew upgrade node` (bumps the libnode SONAME) or `brew cleanup` (removes
 * the old keg) leaves the launchd job with an unresolvable @rpath — dyld
 * kills the helper before Node boots, launchd KeepAlive crash-loops it, the
 * Mac goes "offline — last seen 5h" in the paired-device registry and every
 * computer_task dispatch returns [COMPUTER TASK — UNAVAILABLE] with nothing
 * user-visible anywhere (the ticket's platform effect). The nodejs.org
 * official builds the .app/.pkg ship are SELF-CONTAINED (only system dylibs,
 * no LC_RPATH, no @rpath deps) — the CLI path simply never did the same.
 *
 * FIX (both ends, same ticket):
 *   A. install.sh (0.9.5): when the resolved interpreter is keg-coupled,
 *      download the OFFICIAL self-contained build of the SAME version from
 *      nodejs.org (sha256-verified against dist/SHASUMS256.txt), install it
 *      as DigbyAgent, and keep the origin (Homebrew/nvm) path recorded in
 *      .node-origin for the self-update npm lookup. A `plain` build is copied
 *      as before. The stable path, name, TCC story and .node-origin contract
 *      (51d8dbe0) are unchanged.
 *   B. THIS module: the agent self-heals an EXISTING keg-coupled runtime.
 *      0.9.5 runs fine under the old coupled binary (it still boots — its keg
 *      exists), and on its FIRST poll it stages the official replacement,
 *      selftests it under the NEW binary, then swaps it in place (the running
 *      process is untouched — its image was mapped at load) and exits 1 so
 *      launchd relaunches from the self-contained runtime. Every Mac on
 *      ≤0.9.4 takes 0.9.5 via the ordinary self-update advert, then heals its
 *      runtime on first poll. If the heal fails (no network, sha mismatch,
 *      selftest failure) the agent keeps polling under the old binary and
 *      logs one line — never fatal.
 *
 * Everything above the network boundary is pure and tested on Linux CI; the
 * macOS wiring is pinned by source-bytes tests (test/runtime-dylib.21c68e74
 * .test.mjs), the house idiom.
 */

import { join, resolve } from 'path';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, renameSync,
  openSync, readSync, closeSync, statSync, chmodSync, appendFileSync,
} from 'fs';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { AGENT_VERSION } from './config';

/** The launchd runtime's stable home (51d8dbe0 — outside every agent tree). */
export function digbyRuntimeDir(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Digby', 'bin');
}

/** The digby-named service binary (TCC's Full Disk Access / Screen Recording entry). */
export function digbyAgentBin(home: string = homedir()): string {
  return join(digbyRuntimeDir(home), 'DigbyAgent');
}

/** Load-command kinds we classify (see machoLinkage). */
export type RuntimeLinkage = { rpaths: string[]; rpathDeps: string[]; absDeps: string[]; kind: 'plain' | 'coupled' | 'unknown' };

/**
 * Decode a binary's Mach-O load commands (64-bit LE / FAT) and classify its
 * dynamic linkage. Pure over the bytes handed in (the caller reads a head
 * slice — load commands sit in the first kilobytes of every real binary).
 *
 *   rpaths:    every LC_RPATH string ('@loader_path/../lib' in the ticket).
 *   rpathDeps: @rpath/… LC_LOAD(_WEAK)_DYLIB entries (libnode.147.dylib —
 *              the keg-coupled build's tell).
 *   absDeps:   absolute NON-system dylib paths (the @@HOMEBREW_PREFIX@@/opt/
 *              … relocations a Homebrew bottle carries).
 *
 * System dylibs (/usr/lib/*, /System/*) ship in every build (official and
 * Homebrew alike) and carry no coupling — ignored. Never throws: a
 * truncated / non-Mach-O / 32-bit read is `unknown`, which every caller
 * treats as "do nothing".
 */
export function machoLinkage(bytes: Buffer): RuntimeLinkage {
  const out: RuntimeLinkage = { rpaths: [], rpathDeps: [], absDeps: [], kind: 'unknown' };
  try {
    const magicLE = bytes.readUInt32LE(0);
    if (magicLE === 0xfeedfacf) return scan(bytes, 0, out);      // 64-bit LE Mach-O
    if (magicLE === 0xfeedface) return out;                       // 32-bit — unknown
    if (bytes.readUInt32BE(0) === 0xcafebabe) {                   // FAT: any slice counts
      const nfat = bytes.readUInt32BE(4);
      for (let i = 0; i < nfat; i++) {
        const sliceOff = bytes.readUInt32BE(8 + i * 20 + 8);      // fat_arch.offset
        if (sliceOff + 40 <= bytes.length) return scan(bytes, sliceOff, out);
      }
    }
  } catch { out.kind = 'unknown'; }
  return out;
}

function scan(bytes: Buffer, off: number, out: RuntimeLinkage): RuntimeLinkage {
  try {
    const ncmds = bytes.readUInt32LE(off + 16);
    let p = off + 32;
    for (let i = 0; i < ncmds; i++) {
      if (p + 8 > bytes.length) return out;                       // truncated — unknown
      const cmd = bytes.readUInt32LE(p);
      const cmdsize = bytes.readUInt32LE(p + 4);
      if (cmdsize < 8 || p + cmdsize > bytes.length) return out;
      if (cmd === 0x8000001c) {                                   // LC_RPATH
        // path.offset (p+8) points at the string INSIDE the command.
        const soff = bytes.readUInt32LE(p + 8);
        const s = soff > 0 && soff < cmdsize ? cstr(bytes, p + soff) : null;
        if (s !== null) out.rpaths.push(s);
      } else if (cmd === 0xc || cmd === 0x80000018) {             // LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB
        // dylib.name.offset (p+8) points at the string INSIDE the command.
        const soff = bytes.readUInt32LE(p + 8);
        const s = soff > 0 && soff < cmdsize ? cstr(bytes, p + soff) : null;
        if (s === null) { p += cmdsize; continue; }
        if (s.startsWith('@rpath/')) out.rpathDeps.push(s);
        else if (!s.startsWith('/usr/lib/') && !s.startsWith('/System/')) out.absDeps.push(s);
      }
      p += cmdsize;
    }
    out.kind = out.rpathDeps.length > 0 || out.absDeps.length > 0 ? 'coupled' : 'plain';
  } catch { out.kind = 'unknown'; }
  return out;
}

function cstr(bytes: Buffer, from: number): string | null {
  const e = bytes.indexOf(0, from);
  if (e < 0 || e - from > 4096) return null;
  return bytes.slice(from, e).toString('utf8');
}

/** Read the first `n` bytes of a file (the ~96MB runtime never fully loads). */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(n, statSync(path).size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** 64KB covers every real node binary's load commands with a wide margin. */
const HEAD_BYTES = 64 * 1024;

/**
 * True when `binPath` is a keg-coupled build (Homebrew's node): its dynamic
 * linkage leans on @rpath (libnode…) or absolute non-system dylibs. This is
 * the binary that breaks on a brew upgrade/cleanup. Best-effort, never
 * throws; a missing/unreadable binary is NOT coupled (nothing to heal).
 */
export function isKegCoupledRuntime(binPath: string): boolean {
  try {
    return machoLinkage(readHead(binPath, HEAD_BYTES)).kind === 'coupled';
  } catch {
    return false;
  }
}

/** The official nodejs.org tarball name for a version + process.arch-shaped arch. */
export function officialNodeTarballName(version: string, arch: string): string {
  return `node-v${version}-darwin-${arch}.tar.gz`;
}

/** Root directory inside the extracted official tarball (node-vX.Y.Z-darwin-ARCH). */
export function officialNodeRoot(version: string, arch: string): string {
  return `node-v${version}-darwin-${arch}`;
}

/**
 * Fetch SHASUMS256.txt for `version` and return the 64-hex sha256 recorded
 * for `tarballName`, or null. Never throws — every failure is a heal skip.
 */
export async function officialNodeSha256(version: string, tarballName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const text = await res.text();
    for (const line of text.split('\n')) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
      if (m && m[2] === tarballName) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** The heal retry state (~/.…/Digby/bin/.runtime-heal.json), best-effort. */
export function readRuntimeHealState(path: string): { attempts: number; at: string } | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as { attempts?: unknown; at?: unknown };
    const attempts = Number(s.attempts);
    return {
      attempts: Number.isFinite(attempts) ? attempts : 0,
      at: typeof s.at === 'string' ? s.at : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export type RuntimeHealOutcome =
  | { outcome: 'healed'; to: string }
  | { outcome: 'unnecessary' }
  | { outcome: 'skipped'; reason: string };

/** Attempts before the heal gives up (spread across relaunches via the state file). */
export const RUNTIME_HEAL_MAX_ATTEMPTS = 3;

/**
 * e2915963 (2026-10-24): the runtime swap writes this stamp so the NEXT
 * process (launchd relaunches us after exit(1)) can attribute a TCC
 * permission regression to the swap it just performed. Without it the
 * regression surfaces at task time as a bare "Missing macOS permission(s):
 * Accessibility" with no cause. The stamp is read by
 * noteRuntimeSwapForRegression (index.ts) once, then self-cleans.
 */
export const RUNTIME_SWAP_STAMP = 'runtime-swap.json';

/**
 * Byte-equality of two binaries (the install.sh `cmp -s` idiom, 933e6ca4 —
 * TCC grants attach to the exact file; a byte-identical replacement gains
 * nothing and orphans everything). Pure, exported for the tests.
 * Unreadable/missing files are NOT equal (a missing staged binary never
 * silently "equals" — the caller's own extract gate already refused it).
 */
export function binariesEqual(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    const fa = openSync(a, 'r');
    try {
      const fb = openSync(b, 'r');
      try {
        const CHUNK = 1024 * 1024;
        const bufA = Buffer.alloc(CHUNK);
        const bufB = Buffer.alloc(CHUNK);
        let pos = 0;
        while (pos < sa.size) {
          const nA = readSync(fa, bufA, 0, CHUNK, pos);
          const nB = readSync(fb, bufB, 0, CHUNK, pos);
          if (nA !== nB) return false;
          if (nA <= 0) break;
          if (bufA.compare(bufB, 0, nA, 0, nA) !== 0) return false;
          pos += nA;
        }
        return true;
      } finally { closeSync(fb); }
    } finally { closeSync(fa); }
  } catch {
    return false;
  }
}

/**
 * e2915963: stamp a JUST-PERFORMED runtime swap (called between the swap and
 * the exit) so the successor process can attribute a TCC permission
 * regression to the swap that caused it. Best-effort — the surfacing path
 * degrades to unattributed regression detection when the stamp is absent,
 * which is exactly the pre-fix behavior. (Review F4: only the heal writes a
 * stamp — the self-update tree-swap never touches the TCC-attached binary,
 * so it neither needs nor gets one.)
 */
export function writeRuntimeSwapStamp(bin: string): void {
  try {
    const st = statSync(bin);
    const stamp = join(digbyRuntimeDir(), RUNTIME_SWAP_STAMP);
    writeFileSync(stamp, JSON.stringify({
      swappedAt: new Date().toISOString(),
      to: bin,
      dev: st.dev,
      ino: st.ino,
    }, null, 2));
  } catch { /* best-effort */ }
}

/**
 * e2915963: read (and CONSUME) the runtime-swap stamp. Returns null when no
 * swap is pending attribution — the steady state. Exported for the tests.
 */
export function readRuntimeSwapStamp(home: string = homedir()): {
  swappedAt: string; to: string; dev: number; ino: number;
} | null {
  try {
    const stamp = join(digbyRuntimeDir(home), RUNTIME_SWAP_STAMP);
    const raw = JSON.parse(readFileSync(stamp, 'utf8')) as Record<string, unknown>;
    const out = {
      swappedAt: typeof raw.swappedAt === 'string' ? raw.swappedAt : '',
      to: typeof raw.to === 'string' ? raw.to : '',
      dev: Number(raw.dev),
      ino: Number(raw.ino),
    };
    if (!out.swappedAt || !out.to) return null;
    return out;
  } catch {
    return null;
  }
}

/** e2915963: delete the swap stamp (called after attribution). Best-effort. */
export function clearRuntimeSwapStamp(home: string = homedir()): void {
  try { rmSync(join(digbyRuntimeDir(home), RUNTIME_SWAP_STAMP), { force: true }); } catch { /* best-effort */ }
}

/**
 * Full heal pass, for the run loop (once per process, right after the first
 * successful poll). Cheap in the steady state — one 64KB head read + parse.
 *
 *   unnecessary: this binary is already self-contained (or absent/unreadable
 *                — nothing to classify, nothing to heal).
 *   healed:      the coupled runtime was replaced by the official build of
 *                the SAME node version, SELFTESTED under the NEW binary
 *                before the swap. The CALLER exits 1 so launchd relaunches
 *                from the self-contained runtime (the bundleReplaced /
 *                permission_relaunch idiom).
 *   skipped:     never fatal — the agent keeps polling under the old binary;
 *                retries are capped by the state file.
 */
export async function healRuntimeIfCoupled(): Promise<RuntimeHealOutcome> {
  let bin: string;
  try {
    bin = digbyAgentBin();
  } catch { return { outcome: 'unnecessary' }; }
  if (!existsSync(bin)) return { outcome: 'unnecessary' };

  // Only the process actually RUNNING as the launchd runtime may heal it: a
  // dev tree, the .app-bundled helper (its own self-contained runtime) or a
  // bare `node dist/index.js run` must never touch the CLI install's binary
  // (its digbyAgentBin() can exist on the same Mac).
  try {
    if (resolve(process.execPath) !== resolve(bin)) return { outcome: 'skipped', reason: 'not the launchd runtime' };
  } catch { return { outcome: 'skipped', reason: 'unreadable exec path' }; }

  if (!isKegCoupledRuntime(bin)) return { outcome: 'unnecessary' };

  const version = process.version.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) return { outcome: 'skipped', reason: `unreadable node version ${process.version}` };
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const tarballName = officialNodeTarballName(version, arch);

  const statePath = join(digbyRuntimeDir(), '.runtime-heal.json');
  const state = readRuntimeHealState(statePath);
  if (state && state.attempts >= RUNTIME_HEAL_MAX_ATTEMPTS) {
    return { outcome: 'skipped', reason: 'runtime-heal attempt cap reached' };
  }
  try {
    mkdirSync(digbyRuntimeDir(), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ attempts: (state?.attempts || 0) + 1, at: new Date().toISOString() }, null, 2));
  } catch { /* state best-effort — a lost cap only means an extra attempt */ }

  const stageDir = join(digbyRuntimeDir(), 'runtime-stage');
  try {
    // 1. The official build of the SAME version, sha256-verified against
    //    nodejs.org's own SHASUMS256.txt (the pin that makes a poisoned
    //    mirror a NO-OP instead of a bad swap).
    const want = await officialNodeSha256(version, tarballName);
    if (!want) return { outcome: 'skipped', reason: `SHASUMS256.txt has no entry for ${tarballName}` };
    const res = await fetch(`https://nodejs.org/dist/v${version}/${tarballName}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) return { outcome: 'skipped', reason: `download HTTP ${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== want) return { outcome: 'skipped', reason: 'sha256 mismatch' };

    // 2. Extract (flat — the tarball root is name-versioned) and locate the
    //    binary; it must itself classify PLAIN, or the swap is refused.
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    const tgz = join(stageDir, 'node.tgz');
    writeFileSync(tgz, bytes);
    const root = officialNodeRoot(version, arch);
    const ex = await new Promise<{ code: number; stderr: string }>((r) => {
      execFile('tar', ['-xzf', tgz, '-C', stageDir], { timeout: 120_000 }, (err, _so, se) => {
        r({ code: err ? 1 : 0, stderr: String(se || '') });
      });
    });
    if (ex.code !== 0) return { outcome: 'skipped', reason: `extract failed: ${ex.stderr.slice(0, 120)}` };
    const stagedBin = join(stageDir, root, 'bin', 'node');
    if (!existsSync(stagedBin)) return { outcome: 'skipped', reason: 'extracted tarball has no bin/node' };
    if (isKegCoupledRuntime(stagedBin)) {
      return { outcome: 'skipped', reason: 'staged official binary is not self-contained — refusing to swap' };
    }

    // 3. SELFTEST the CURRENT tree under the NEW binary — the same pre-swap
    //    smoke the self-update path runs (4e75cdea/0e4c9601): no swap
    //    without proof the replacement can run this tree's modules.
    // (review F3: the agent tree is NOT always …/Digby/imessage-agent — a
    // dev checkout (git clone + ./install.sh) puts it anywhere while the
    // runtime stays at the stable path; the tree THIS code runs from is the
    // authority, exactly like self-update's agentRoot.)
    const agentRoot = join(__dirname, '..');
    const entry = join(agentRoot, 'dist', 'index.js');
    if (!existsSync(entry)) return { outcome: 'skipped', reason: 'no dist tree to selftest' };
    const smoke = await new Promise<{ code: number; stdout: string; stderr: string }>((r) => {
      execFile(stagedBin, [entry, 'selftest'], { timeout: 120_000, env: process.env }, (err, so, se) => {
        r({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout: String(so || ''), stderr: String(se || '') });
      });
    });
    if (smoke.code !== 0 || !smoke.stdout.includes(`SELFTEST_OK ${AGENT_VERSION}`)) {
      return { outcome: 'skipped', reason: `selftest under staged binary failed: ${(smoke.stderr || smoke.stdout).slice(0, 120)}` };
    }

    // 4. Swap at the STABLE path (the running process keeps its mapped
    //    image). RENAME, never copy (review N1): a copyFileSync into
    //    ~/Library can fail mid-write (ENOSPC) and leave a TRUNCATED Mach-O
    //    at the stable path — a permanent crash-loop worse than the ticket.
    //    The stage dir and the runtime dir are the same volume
    //    (…/Digby/bin/runtime-stage), so rename is atomic: the stable path
    //    is either the old binary or the new one, never a partial file.
    //    A rename swap still replaces the inode, so macOS TCC re-grants only
    //    on a real runtime change — which this is; the onboarding stamp
    //    (permissions.ts) re-fires on the inode change and the integrations
    //    card re-shows the Full Disk Access step if a grant is needed.
    //    e2915963 (2026-10-24): a byte-IDENTICAL staged binary is NOT a real
    //    runtime change — swapping it anyway would recreate the inode and
    //    silently orphan the Accessibility / Screen Recording / Full Disk
    //    Access grants the Mac already holds for this exact file (the
    //    install.sh cmp -s idiom, 933e6ca4 — carried into the agent-side
    //    swap here). NOTE (review F1): this gate is DEFENSE-IN-DEPTH for the
    //    narrow re-heal class — the heal only reaches this line when the
    //    CURRENT runtime is still keg-coupled (line 344 returns 'unnecessary'
    //    for an already-healed Mac), and the incident itself was a FIRST
    //    heal (keg-coupled Homebrew copy → official node: genuinely
    //    different bytes), which correctly proceeds with the swap and stamps
    //    it; the incident-class protection is the swap stamp + the
    //    regression surfacing (index.ts) + the backend poll-seam detector.
    if (binariesEqual(stagedBin, bin)) {
      return {
        outcome: 'skipped',
        reason: 'staged official build is byte-identical to the current runtime — keeping the existing file (and its TCC grants) (e2915963)',
      };
    }
    try { rmSync(`${bin}.old`, { force: true }); } catch { /* best-effort */ }
    try {
      renameSync(bin, `${bin}.old`);
    } catch { /* no file to move (raced) — the rename below still proceeds */ }
    try {
      renameSync(stagedBin, bin);
    } catch (e) {
      // Never leave the launchd job without a binary: put the old one back.
      try { if (!existsSync(bin) && existsSync(`${bin}.old`)) renameSync(`${bin}.old`, bin); } catch { /* best-effort */ }
      return { outcome: 'skipped', reason: `swap failed: ${String(e).slice(0, 120)}` };
    }
    try { chmodSync(bin, 0o755); } catch { /* best-effort */ }

    // e2915963: stamp the just-performed swap so the relaunched process can
    // attribute any TCC regression to it (see writeRuntimeSwapStamp). The
    // swap REALLY changed the runtime (binariesEqual refused the byte-equal
    // case above), so the Accessibility / Screen Recording / Full Disk Access
    // grants may need re-making — the next process surfaces that loudly
    // instead of waiting for a task-time failure.
    writeRuntimeSwapStamp(bin);

    // 5. One line in the service's own stdout log (StandardOutPath in the
    //    plist), best-effort.
    try {
      const logDir = join(digbyRuntimeDir(), '..', 'logs');
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, 'digby-agent.log'),
        `[${new Date().toISOString()}] ♻️  self-contained runtime heal: replaced the keg-coupled DigbyAgent with official node v${version} (ticket 21c68e74); launchd will relaunch from it.\n`);
    } catch { /* log best-effort */ }

    return { outcome: 'healed', to: bin };
  } finally {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
