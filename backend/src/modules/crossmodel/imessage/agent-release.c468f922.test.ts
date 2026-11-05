/**
 * Ticket c468f922 — "Desktop agent: privileged pre-login helper so a locked
 * macOS/Windows device can be driven remotely".
 *
 * THE INCIDENT THIS SUITE EXISTS FOR. The device-half of this ticket landed on
 * main in three PRs (#2066 typed `prelogin_input`, #2073 brokered remote
 * access, #2077 firewall-enforcement verification) and then reached ZERO
 * devices. The served artifact was never republished: the tree sat at
 * AGENT_VERSION 0.9.11 (the daf8706a calendar release), so
 *
 *   - `frontend/public/digby-imessage-agent.tar.gz` still carried the 0.9.11
 *     source tree (19 of 21 `src/*.ts` files — `remote-access.ts` and
 *     `unattended.ts` were simply NOT IN IT),
 *   - the release manifest named 0.9.11 with the matching sha256, so the
 *     manifest and the artifact agreed with EACH OTHER and every existing
 *     consistency test passed,
 *   - and `agentUpdateAdvert` is STRICTLY-newer-only, so a device already at
 *     0.9.11 (`versionNewer('0.9.11','0.9.11') === false`) could never be
 *     offered the release that contained the feature.
 *
 * Net effect measured on the live fleet: the `remote-access` command existed on
 * main and on zero devices, every device reported `remoteAccess: undefined`, and
 * the fleet verdict answered "not configured — the Digby agent on this device
 * never reported brokered remote access". A lane could not enable a channel that
 * was not on the box it was enabling.
 *
 * WHY THE EXISTING SUITES COULD NOT SEE IT. `agent-release.a9a74086.test.ts`
 * pins the tarball ↔ manifest agreement (version, sha256, native deps, engines).
 * That is a HYGIENE check: it asks "do these two committed artifacts agree",
 * and while the feature was invisible they both said 0.9.11 and both agreed.
 * Nothing compared the artifact against the SOURCE TREE it is supposed to be a
 * build of. A stale artifact that agrees with a stale manifest is the exact
 * shape that passes every check and ships nothing.
 *
 * THE INVARIANT PINNED HERE. `scripts/publish-agent-tarball.sh` stages the
 * release by copying `imessage-agent/src` verbatim (`cp -R "$AGENT/src" …`) and
 * tars it — no transpile, no filter, no subset. So the committed tarball's
 * `src/` tree MUST equal the on-disk `imessage-agent/src/` tree, file-for-file
 * and byte-for-byte, or a publish is outstanding. That single equality is what
 * makes "code merged" and "code shipped" the same fact, and it fails loudly on
 * the 0.9.11 shape (files on disk, absent from the artifact).
 *
 * This is a RELEASE-HYGIENE guard, not a substitute for the device-side proof
 * this ticket still needs (enable/revoke at a live login window) — see
 * docs/UNATTENDED_DEVICES.md §7.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { AGENT_RELEASE } from './agent-release';

// Mocks mirror agent-release.a9a74086.test.ts: agent-release imports agent-link
// → config/redis at module load, and parseEnv would process.exit(1) without
// DATABASE_URL etc. in the test env.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const store: any = {
    rows: [],
    iMessageAgent: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'agent-new', agentToken: 'tok' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { __esModule: true, default: store };
});
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { setEx: jest.fn(), get: jest.fn(), del: jest.fn() },
}));

/** repo root (…/backend/src/modules/crossmodel/imessage → up 5) */
import { isExportTree } from '../../../utils/export-mode';

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..');
const TARBALL = path.join(ROOT, 'frontend', 'public', 'digby-imessage-agent.tar.gz');
const SRC_DIR = path.join(ROOT, 'imessage-agent', 'src');

/** Every `imessage-agent/src/*.ts` entry inside the committed artifact.
 *  Lazy (not a module-level call) so a missing/unreadable tarball fails the
 *  "tarball exists" assertion with its message instead of throwing during
 *  module collection, where that message would be unreachable. */
function tarSrcEntries(): string[] {
  const out = execFileSync('tar', ['-tzf', TARBALL], { maxBuffer: 16 * 1024 * 1024 }).toString(
    'utf8',
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^imessage-agent\/src\/[^/]+\.ts$/.test(l))
    .map((l) => l.replace(/^imessage-agent\/src\//, ''))
    .sort();
}

/** The bytes of one file as served inside the artifact (lazy — see above). */
function tarSrcBytes(name: string): Buffer {
  return execFileSync('tar', ['-xzOf', TARBALL, `imessage-agent/src/${name}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** CRLF → LF. The repo carries no `.gitattributes`, so a developer with
 *  `core.autocrlf=true` (plausible: `windows-agent/` is first-class here)
 *  checks the 21 `.ts` files out as CRLF while the artifact holds LF — byte
 *  comparison would then fail ALL of them for a reason that is not a stale
 *  release. Normalising keeps the assertion about CONTENT, which is what the
 *  publish copies. */
function normalizeEol(buf: Buffer): string {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

// The src tree is FLAT today (21 top-level .ts, no subdirectories, no non-.ts
// assets) and both sides of the comparison below enumerate only top-level
// `.ts`. A future `src/foo/bar.ts` or a shipped `src/*.json` would therefore be
// invisible to BOTH sides and silently escape this guard — widen both the tar
// filter and the readdir if the tree ever grows a subdirectory.

const diskSrcFiles = fs
  .readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

// EXPORT TREE (todo 13069ce2, 2026-11-05): this suite compares the committed
// release artifact against the source tree, and the public export DROPS that
// artifact (`drop frontend/public/digby-imessage-agent.tar.gz` — a binary cannot
// be redacted, and the export exists to prove the SOURCE builds). `servedSrcFiles`
// is computed at MODULE level, so a missing tarball throws during collection —
// before the "tarball exists" assertion below could ever report it. Guarding the
// call is what keeps the failure meaningful: in an export there is no artifact
// to compare, in a checkout a missing one still throws here.
const IN_EXPORT = isExportTree(ROOT);
const servedSrcFiles = IN_EXPORT ? [] : tarSrcEntries();

const artifactSuite = IN_EXPORT ? describe.skip : describe;

artifactSuite('served agent artifact is a build of the CURRENT source tree (ticket c468f922)', () => {
  it('the committed tarball exists (a checkout without it cannot ship a release)', () => {
    expect(fs.existsSync(TARBALL)).toBe(true);
  });

  it('c468f922: every src/*.ts module on disk is PRESENT in the served artifact', () => {
    // The 0.9.11 failure, exactly: remote-access.ts + unattended.ts were on
    // disk and absent from the tarball, so the shipped agent had no
    // `remote-access` command for any device to run.
    const missing = diskSrcFiles.filter((f) => !servedSrcFiles.includes(f));
    expect(missing).toEqual([]);
  });

  it('c468f922: the served artifact carries NO src file that is not in the source tree', () => {
    // A leftover from an older build means the artifact was hand-edited or
    // published from a tree that has since moved — either way it is not a
    // build of what is on main.
    const extra = servedSrcFiles.filter((f) => !diskSrcFiles.includes(f));
    expect(extra).toEqual([]);
  });

  it('c468f922: the served src/*.ts files are BYTE-IDENTICAL to disk (no stale build)', () => {
    // The publish script copies src verbatim, so any drift means an
    // outstanding publish. Compared per file so a failure names the file.
    const differing: string[] = [];
    for (const name of diskSrcFiles) {
      if (!servedSrcFiles.includes(name)) continue; // covered by the presence test
      const onDisk = fs.readFileSync(path.join(SRC_DIR, name));
      if (normalizeEol(onDisk) !== normalizeEol(tarSrcBytes(name))) differing.push(name);
    }
    expect(differing).toEqual([]);
  });

  it('c468f922: the shipped agent carries the remote-access command (the ticket’s device half)', () => {
    // Both modules are asserted PRESENT above via the tree equality; this
    // pins the two that must never silently drop again, plus the dispatch
    // wiring that makes the command runnable on the box.
    expect(servedSrcFiles).toContain('remote-access.ts');
    expect(servedSrcFiles).toContain('unattended.ts');
    // The command is reachable from the agent's arg parser, not merely
    // present as an imported module.
    const servedIndex = tarSrcBytes('index.ts').toString('utf8');
    expect(servedIndex).toContain("case 'remote-access'");
  });

  it('c468f922: the artifact version equals the manifest version it is served under', () => {
    // Belt-and-braces on the one number that makes an advert fire at all:
    // strictly-newer-only means an artifact at the manifest's own version is
    // a release that can never reach a device already on it.
    const tarPkgVersion = (
      JSON.parse(
        execFileSync('tar', ['-xzOf', TARBALL, 'imessage-agent/package.json'], {
          maxBuffer: 16 * 1024 * 1024,
        }).toString('utf8'),
      ) as { version: string }
    ).version;
    expect(tarPkgVersion).toBe(AGENT_RELEASE.version);
    // And the SOURCE tree is at that same version — a publish that bumped the
    // artifact without the source (or vice versa) is how a release drifts.
    const diskPkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'imessage-agent', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(diskPkg.version).toBe(AGENT_RELEASE.version);
    const diskConfig = fs.readFileSync(path.join(SRC_DIR, 'config.ts'), 'utf8');
    expect(diskConfig).toContain(`export const AGENT_VERSION = '${AGENT_RELEASE.version}'`);
  });
});