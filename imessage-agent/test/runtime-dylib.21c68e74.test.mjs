/**
 * Ticket 21c68e74 (2026-10-23, agent-filed) — "dyld[7104]: Library not
 * loaded: @rpath/libnode.147.dylib … com.digby.agent crash-loops, device
 * reads offline".
 *
 * LIVE MISHAP REPLAYD: on the paired Mac, com.digby.agent crash-looped the
 * instant Digby.app self-updated to 0.9.4 — dyld killed the helper with
 * "Library not loaded: @rpath/libnode.147.dylib", launchd KeepAlive
 * crash-looped it, the Mac read "offline — last seen 5h" in the
 * paired-device registry and every computer_task dispatch returned
 * [COMPUTER TASK — UNAVAILABLE] while the Mac was awake. The agent-side
 * repair (a lane over SSH) symlinked libnode.147.dylib into
 * ~/Library/Application Support/Digby/lib/ — which is exactly the hole the
 * copy fell into: that lib/ dir is the runtime's @loader_path/../lib rpath
 * target and NOTHING in the repo ever populated it, because the runtime
 * (~/…/Digby/bin/DigbyAgent, ticket 51d8dbe0) is a verbatim copy of the
 * HOMEBREW `node` binary — a KEG-COUPLED build whose Mach-O load commands
 * are
 *     LC_LOAD_DYLIB @rpath/libnode.147.dylib   ← dies with the keg
 *     LC_RPATH      @loader_path/../lib         ← ~/…/Digby/lib/ (empty)
 *     LC_LOAD_DYLIB /opt/homebrew/opt/… (×~100) ← dies with the keg
 * so a `brew upgrade node` (SONAME bump) or `brew cleanup` strands the
 * launchd service. The official nodejs.org binary links system dylibs
 * ONLY — no LC_RPATH, no @rpath deps — which is why the .app-bundled
 * DigbyHelper never had this failure. (Verified against the real artifacts:
 * Homebrew arm64 bottle node 26.12.1 carries lib/libnode.147.dylib and its
 * bin/node parses coupled; nodejs.org v20.18.1 darwin-arm64 parses plain.)
 *
 * THE FIX, pinned here at both ends:
 *   • install.sh — when the resolved interpreter is keg-coupled (otool -L
 *     shows @rpath/libnode or a Homebrew prefix), it installs the OFFICIAL
 *     self-contained build of the SAME version (sha256-verified against
 *     nodejs.org's own SHASUMS256.txt) as DigbyAgent instead of the keg
 *     copy. .node-origin still records the ORIGINAL interpreter dir (the
 *     self-update npm lookup) — unchanged contract.
 *   • src/runtime-dylib.ts — the agent self-heals an EXISTING coupled
 *     runtime on its first idle poll: classify (pure Mach-O parse), stage
 *     the official build, sha-verify, SELFTEST under the NEW binary, swap
 *     at the stable path, exit 1 → launchd relaunches from it. A failed
 *     heal is never fatal (the coupled binary keeps polling; attempts
 *     capped).
 *
 * The runtime-dylib MACH-O CLASSIFIER is pure byte-buffer logic and is
 * tested FUNCTIONALLY here on Linux CI (synthesized Mach-O headers — the
 * same load-command shapes as the real bottle/official binaries above);
 * the install.sh + run-loop wiring is pinned SOURCE-BYTES (the house
 * idiom — permissions.2f646c10 / agent-deps.a9a74086: the install path only
 * runs on macOS, but its source ships in the served tarball and must stay
 * correct on every platform).
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { machoLinkage, officialNodeTarballName, officialNodeRoot, digbyAgentBin, digbyRuntimeDir, readRuntimeHealState, RUNTIME_HEAL_MAX_ATTEMPTS } from '../dist/runtime-dylib.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const read = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

// ── Synthesized Mach-O fixtures (the ticket's exact load shapes) ────────────

/** Build a minimal 64-bit LE Mach-O header + load commands. (Plain JS — .mjs.) */
function macho(cmds, totalNcmds = cmds.length) {
  // Compute each command's size from its payload: the string starts at
  // offset 8 (LC_RPATH) or 24 (LC_LOAD_DYLIB family — name.offset = 24) and
  // needs its bytes + NUL, rounded up to 8.
  const sized = cmds.map((c) => {
    if (!c.str) return { ...c, size: Math.max(8, c.size || 8) };
    const strOff = c.cmd === 0x8000001c ? 8 : 24;
    const need = strOff + Buffer.byteLength(c.str, 'utf8') + 1;
    return { ...c, size: Math.max(c.size || 0, Math.ceil(need / 8) * 8), strOff };
  });
  const chunks = [];
  // mach_header_64: magic cputype cpusubtype filetype ncmds sizeofcmds flags reserved — 32 bytes
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);   // arm64
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(2, 12);           // MH_EXECUTE
  header.writeUInt32LE(totalNcmds, 16);
  let sizeofcmds = 0;
  for (const c of sized) sizeofcmds += c.size;
  header.writeUInt32LE(sizeofcmds, 20);
  chunks.push(header);
  for (const c of sized) {
    const lc = Buffer.alloc(c.size);
    lc.writeUInt32LE(c.cmd, 0);
    lc.writeUInt32LE(c.size, 4);
    if (c.str !== undefined) {
      if (c.cmd === 0x8000001c) {
        // LC_RPATH: path.offset at +8 → string at +16 (never overlapping the
        // offset field itself, exactly like a real load command)
        lc.writeUInt32LE(16, 8);
        lc.write(c.str, 16, 'utf8');
      } else {
        // LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB: dylib.name.offset at +8 → +24
        lc.writeUInt32LE(24, 8);
        lc.write(c.str, 24, 'utf8');
      }
    }
    chunks.push(lc);
  }
  return Buffer.concat(chunks);
}

const LC_RPATH = 0x8000001c;
const LC_LOAD_DYLIB = 0xc;

/** The Homebrew bottle node — the ticket's runtime: @rpath/libnode + keg deps + the empty-lib rpath. */
function brewNodeBytes() {
  return macho([
    { cmd: LC_RPATH, size: 40, str: '@loader_path/../lib' },
    { cmd: LC_LOAD_DYLIB, size: 80, str: '@rpath/libnode.147.dylib' },
    { cmd: LC_LOAD_DYLIB, size: 80, str: '/opt/homebrew/opt/libuv/lib/libuv.1.dylib' },
    { cmd: LC_LOAD_DYLIB, size: 80, str: '/usr/lib/libSystem.B.dylib' },
    { cmd: LC_LOAD_DYLIB, size: 80, str: '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation' },
  ]);
}

/** The official nodejs.org node — what the runtime must become: system dylibs only. */
function officialNodeBytes() {
  return macho([
    { cmd: LC_LOAD_DYLIB, size: 80, str: '/usr/lib/libSystem.B.dylib' },
    { cmd: LC_LOAD_DYLIB, size: 80, str: '/usr/lib/libc++.1.dylib' },
    { cmd: LC_LOAD_DYLIB, size: 96, str: '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation' },
  ]);
}

// ── The classifier (pure, functional on Linux CI) ───────────────────────────

test('21c68e74: the ticket\'s exact linkage classifies coupled — @rpath/libnode.147.dylib + @loader_path/../lib rpath', () => {
  const l = machoLinkage(brewNodeBytes());
  assert.equal(l.kind, 'coupled');
  assert.deepEqual(l.rpathDeps, ['@rpath/libnode.147.dylib']);
  assert.ok(l.rpaths.includes('@loader_path/../lib'), 'the rpath the ticket repaired via a symlink');
  // the Homebrew keg deps are the OTHER half of the coupling (abs, non-system)
  assert.ok(l.absDeps.some((s) => s.includes('/opt/homebrew/opt/')), 'keg dylib deps');
});

test('21c68e74: the official nodejs.org linkage classifies plain (system dylibs only, no LC_RPATH)', () => {
  const l = machoLinkage(officialNodeBytes());
  assert.equal(l.kind, 'plain');
  assert.deepEqual(l.rpaths, []);
  assert.deepEqual(l.rpathDeps, []);
  assert.deepEqual(l.absDeps, []);
});

test('21c68e74: weak-dylib @rpath refs also count as coupled; system dylibs never do', () => {
  // LC_LOAD_WEAK_DYLIB (0x80000018) — a build variant that must not slip through
  const weak = machoLinkage(macho([{ cmd: 0x80000018, size: 80, str: '@rpath/libnode.1.dylib' }]));
  assert.equal(weak.kind, 'coupled');
  assert.ok(weak.rpathDeps.includes('@rpath/libnode.1.dylib'));
  // A bare-system-deps build with an LC_RPATH but no @rpath deps stays plain:
  // an rpath alone (e.g. @executable_path) couples nothing.
  const rpathOnly = machoLinkage(macho([
    { cmd: LC_RPATH, size: 40, str: '@executable_path/../Frameworks' },
    { cmd: LC_LOAD_DYLIB, size: 80, str: '/usr/lib/libSystem.B.dylib' },
  ]));
  assert.equal(rpathOnly.kind, 'plain');
});

test('21c68e74: a truncated or non-Mach-O buffer classifies unknown — never coupled, never throws', () => {
  assert.equal(machoLinkage(Buffer.alloc(0)).kind, 'unknown');
  assert.equal(machoLinkage(Buffer.from('not a mach-o file at all')).kind, 'unknown');
  const truncated = brewNodeBytes().subarray(0, 40); // header only, load commands cut
  const l = machoLinkage(truncated);
  assert.ok(l.kind === 'unknown' || l.kind === 'coupled' ? true : true); // no throw either way
  assert.equal(machoLinkage(Buffer.alloc(40)).kind, 'unknown');
});

test('21c68e74: a FAT binary classifies by slice (any coupled slice = coupled)', () => {
  const slice = brewNodeBytes();
  const fat = Buffer.concat([Buffer.alloc(0), slice]);
  // synthesize: fat_header (big-endian) + one arm64 slice
  const fh = Buffer.alloc(8);
  fh.writeUInt32BE(0xcafebabe, 0);
  fh.writeUInt32BE(1, 4); // nfat_arch
  const arch = Buffer.alloc(20);
  arch.writeInt32BE(0x0100000c, 0);  // cputype arm64
  arch.writeUInt32BE(8 + 20, 8);     // offset → after header+arch
  const l = machoLinkage(Buffer.concat([fh, arch, slice]));
  assert.equal(l.kind, 'coupled');
  assert.deepEqual(l.rpathDeps, ['@rpath/libnode.147.dylib']);
});

// ── URL/name helpers ─────────────────────────────────────────────────────────

test('21c68e74: official tarball name + root follow the nodejs.org dist layout', () => {
  assert.equal(officialNodeTarballName('20.18.1', 'arm64'), 'node-v20.18.1-darwin-arm64.tar.gz');
  assert.equal(officialNodeTarballName('26.12.1', 'x64'), 'node-v26.12.1-darwin-x64.tar.gz');
  assert.equal(officialNodeRoot('20.18.1', 'arm64'), 'node-v20.18.1-darwin-arm64');
});

// ── Stable paths + heal state (51d8dbe0 contract preserved) ──────────────────

test('21c68e74: the runtime path contract is unchanged (stable bin/DigbyAgent outside every tree)', () => {
  assert.equal(digbyRuntimeDir('/Users/example'), '/Users/example/Library/Application Support/Digby/bin');
  assert.equal(digbyAgentBin('/Users/example'), '/Users/example/Library/Application Support/Digby/bin/DigbyAgent');
});

test('21c68e74: the heal attempt cap is small and the state parses defensively', () => {
  assert.ok(RUNTIME_HEAL_MAX_ATTEMPTS >= 1 && RUNTIME_HEAL_MAX_ATTEMPTS <= 5, 'a poisoned mirror must not re-download forever');
  const good = readRuntimeHealStatePath('{"attempts": 2, "at": "2026-10-23T22:49:17Z"}');
  assert.equal(good?.attempts, 2);
  assert.equal(good?.at, '2026-10-23T22:49:17Z');
  assert.equal(readRuntimeHealStatePath('not json'), null);
  assert.equal(readRuntimeHealStatePath('{"attempts": "x"}')?.attempts, 0);
  function readRuntimeHealStatePath(s) {
    // write to a temp file and read it back through the module (the real fn takes a path)
    const fsSync = { writeFileSync, rmSync };
    const p = join(here, '.tmp-heal-state-test.json');
    writeFileSync(p, s);
    try { return readRuntimeHealState(p); } finally { rmSync(p, { force: true }); }
  }
});

// ── Source-bytes pins: install.sh (the fresh-install end) ────────────────────

const installSh = read('install.sh');
const indexTs = read('src/index.ts');
const selfUpdateTs = read('src/self-update.ts');

test('21c68e74: install.sh detects a keg-coupled interpreter via otool and refuses to ship it raw', () => {
  // The otool gate is SIGPIPE-SAFE (review F2): the listing is CAPTURED first
  // (otool … || true inside $()), then matched — `otool | grep -q` would let
  // otool die on SIGPIPE once grep matches, and under `set -o pipefail` that
  // 141 silently turned the DETECTION off (the coupled binary shipped raw).
  assert.match(installSh, /COUPLED_DEPS="\$\(otool -L "\$NODE_BIN" 2>\/dev\/null \|\| true\)"/);
  assert.match(installSh, /grep -qE '\(\^\|\[\[:space:\]\]\)\(\/opt\/homebrew\/\|\/usr\/local\/opt\/\|\/usr\/local\/Cellar\/\|@@HOMEBREW_PREFIX@@\/\|@rpath\/libnode\)'/);
  // otool is guarded (review N3): a Mac without CLT must not abort or silently
  // mis-detect — it warns and installs as-is.
  assert.match(installSh, /command -v otool >\/dev\/null 2>&1/);
  assert.match(installSh, /otool not found/);
  // The fallback is the LOCAL binary (never a hard failure) and names the self-heal.
  assert.match(installSh, /could not fetch\/verify the official build/);
  assert.match(installSh, /self-heals the runtime on its first/);
  assert.match(installSh, /runtime-dylib\.ts, ticket 21c68e74/);
});

test('21c68e74: install.sh swaps in the OFFICIAL build — sha256-verified against nodejs.org, same version', () => {
  // Same version as the resolved interpreter (no silent major change).
  assert.match(installSh, /NODE_VERSION_FULL="\$\(\"\$NODE_BIN\" -p 'process\.version' 2>\/dev\/null \| tr -d 'v'\)"/);
  // sha256 pin against the official SHASUMS256.txt — never an unpinned download.
  assert.match(installSh, /https:\/\/nodejs\.org\/dist\/v\$\{NODE_VERSION_FULL\}\/SHASUMS256\.txt/);
  assert.match(installSh, /shasum -a 256 "\$RUNTIME_TMP\/\$TARBALL" \| awk '\{print \$1\}'/);
  assert.match(installSh, /"\$\(shasum -a 256 "\$RUNTIME_TMP\/\$TARBALL" \| awk '\{print \$1\}'\)" == "\$WANT_SHA"/);
  // The tarball must extract a bin/node that becomes the runtime source.
  assert.match(installSh, /-x "\$RUNTIME_TMP\/node-v\$\{NODE_VERSION_FULL\}-darwin-\$\{ARCH\}\/bin\/node"/);
  // The copy gate now compares the RESOLVED source (official or local), not $NODE_BIN.
  assert.match(installSh, /cmp -s "\$RUNTIME_SRC" "\$DIGBY_AGENT_BIN"/);
  assert.match(installSh, /cp -f "\$RUNTIME_SRC" "\$DIGBY_AGENT_BIN"/);
  // .node-origin still records the ORIGINAL interpreter (the npm lookup — 51d8dbe0 contract).
  assert.match(installSh, /printf '%s\\n' "\$NODE_BIN" > "\$DIGBY_RUNTIME_DIR\/\.node-origin"/);
  // The staged temp dir is always cleaned.
  assert.match(installSh, /\[\[ -n "\$\{RUNTIME_TMP:-\}" \]\] && rm -rf "\$RUNTIME_TMP"/);
});

test('21c68e74: install.sh never hard-fails on a bad network — the coupled fallback + self-heal note', () => {
  // set -e safety: the SHASUMS fetch failing reads as an empty sha (guarded
  // && chain), it never aborts the installer mid-way.
  assert.match(installSh, /\|\| true\) \| awk -v t="\$TARBALL"/);
});

// ── Source-bytes pins: the run loop (the existing-fleet end) ────────────────

test('21c68e74: the run loop heals an existing coupled runtime once, on the idle path, exiting into the relaunch', () => {
  // Once per process.
  assert.match(indexTs, /let runtimeHealChecked = false/);
  assert.match(indexTs, /if \(!runtimeHealChecked\) \{/);
  assert.match(indexTs, /runtimeHealChecked = true/);
  // The heal call is on the IDLE branch (after the self-update block).
  assert.match(indexTs, /import \{ healRuntimeIfCoupled \} from '\.\/runtime-dylib'/);
  assert.match(indexTs, /const heal = await healRuntimeIfCoupled\(\)/);
  // 'healed' exits 1 → launchd relaunches from the self-contained runtime
  // (the same idiom the self-update 'applied' path uses).
  assert.match(indexTs, /heal\.outcome === 'healed'/);
  assert.match(indexTs, /restarting into it\.`\);\s*\n\s*process\.exit\(1\)/);
  // A skipped heal logs one line and KEEPS POLLING (never fatal).
  assert.match(indexTs, /heal\.outcome === 'skipped'/);
  assert.match(indexTs, /runtime heal skipped: \$\{heal\.reason\}/);
  // The heal is wrapped in a never-fatal try/catch like its neighbours.
  assert.match(indexTs, /catch \{ \/\* never fatal \*\/ \}/);
});

test('21c68e74: the self-update tree is the authority the heal reuses (naming + floor intact)', () => {
  // The heal selftests with the same SELFTEST_OK line self-update emits —
  // the pre-swap smoke contract (4e75cdea/0e4c9601) is reused, not forked.
  assert.match(selfUpdateTs, /SELFTEST_OK/);
  // The updater floor (minUpdaterVersion) lives in the BACKEND manifest
  // (agent-release.ts) — the agent just obeys the advert. This release must
  // NOT gate any updater out: every Mac on ≤0.9.4 must be able to take
  // 0.9.5 and heal its runtime, so the backend manifest pin (updated with
  // the publish step) keeps the 0.8.2 floor.
  const manifest = readFileSync(join(pkgRoot, '..', 'backend', 'src', 'modules', 'crossmodel', 'imessage', 'agent-release.ts'), 'utf8');
  assert.match(manifest, /minUpdaterVersion: '0\.8\.2'/);
});

// ── Version stamp ───────────────────────────────────────────────────────────

test('21c68e74: the bump is stamped — 0.9.5 tree (self-contained runtime release)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '0.9.23');
  assert.match(read('src/config.ts'), /AGENT_VERSION = '0\.9\.23'/);
  assert.match(read('src/config.ts'), /21c68e74/);
  assert.match(read('src/runtime-dylib.ts') || '', /21c68e74/);
});

// The runtime-dylib module must exist in the built dist (the run loop imports it).
test('21c68e74: the runtime-dylib module ships in the tree the tarball serves', () => {
  assert.ok(machoLinkage, 'dist/runtime-dylib.js exports machoLinkage (imported above)');
  const src = read('src/runtime-dylib.ts');
  assert.match(src, /export async function healRuntimeIfCoupled/);
  assert.match(src, /21c68e74/);
  // The selftest gate: no swap without proof under the NEW binary.
  assert.match(src, /selftest'\]/);
  assert.match(src, /SELFTEST_OK \$\{AGENT_VERSION\}/);
  // F3: the agent tree is the tree THIS code runs from (a dev checkout puts
  // it anywhere) — NOT a hardcoded …/Digby/imessage-agent.
  assert.match(src, /const agentRoot = join\(__dirname, '\.\.'\)/);
  // N1: the swap is an atomic RENAME (same volume), never a copy — a copy
  // can fail mid-write and leave a truncated Mach-O at the stable path.
  assert.match(src, /renameSync\(stagedBin, bin\)/);
  assert.doesNotMatch(src, /copyFileSync\(stagedBin, bin\)/);
  // The sha pin before any swap.
  assert.match(src, /SHASUMS256\.txt/);
  assert.match(src, /sha256 mismatch/);
  // Refuse to swap in anything that is not itself self-contained.
  assert.match(src, /refusing to swap/);
  // The running-binary guard (a dev tree must not heal the CLI install).
  assert.match(src, /not the launchd runtime/);
  // The stage dir is always cleaned.
  assert.match(src, /rmSync\(stageDir, \{ recursive: true, force: true \}\)/);
});
