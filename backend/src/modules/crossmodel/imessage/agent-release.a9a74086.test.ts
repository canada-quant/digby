/**
 * Ticket a9a74086 — "tried to run the command Digby gave me" (owner-filed,
 * Mac mini, 2026-10-13): the one-line installer died building better-sqlite3
 * under Homebrew Node v26.0.0 ("No prebuilt binaries found (target=26.0.0 …)"
 * → node-gyp CXX wall → npm error code 1).
 *
 * Root cause: the served tarball pinned better-sqlite3 11.10.0, whose darwin
 * prebuilds stop at Node ABI 131 (Node 23). This suite pins the publish-time
 * invariants that keep a 0.8.2+ tarball installable on current Node — the
 * checks that run on Linux CI too, because they read the committed artifacts
 * (package.json/package-lock.json inside the tarball + the manifest) rather
 * than compiling anything.
 *
 * Why backend: the tarball + manifest + this suite all ship from this repo,
 * and backend jest is the GATING CI job (the imessage-agent job is
 * continue-on-error). A tarball that cannot install under its own engines
 * floor must fail HERE, at publish time, not on a customer Mac.
 *
 * Idiom: source/artifact pins via fs.readFileSync (chat-files.test.ts,
 * hooks.retired-target.9df506cc.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

import { AGENT_RELEASE } from './agent-release';
import { isExportTree } from '../../../utils/export-mode';

// Mocks mirror agent-release.0e4c9601.test.ts (agent-release imports
// agent-link → config/redis at module load; parseEnv would process.exit(1)
// without DATABASE_URL etc. in the test env).
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
const ROOT = path.join(__dirname, '..', '..', '..', '..', '..');
const TARBALL = path.join(ROOT, 'frontend', 'public', 'digby-imessage-agent.tar.gz');

/** Read one file out of the tar.gz without touching disk (tar → gunzip → text). */
function readTarEntry(entryPath: string): string {
  // `tar -xzOf <tarball> <entry>` prints the decompressed entry to stdout.
  const buf = execFileSync('tar', ['-xzOf', TARBALL, entryPath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return buf.toString('utf8');
}

// WHY THIS IS SKIPPED IN AN EXPORT (todo 13069ce2, 2026-11-05): every pin here
// reads the COMMITTED release artifact `frontend/public/digby-imessage-agent.tar.gz`,
// which the public export drops by design — a binary cannot be redacted, only
// scanned, and the export exists to prove the SOURCE builds. The existence check
// below runs at COLLECTION time (it throws before a single `it` is declared), so
// an unconditional throw would abort the whole suite for a tree fact rather than
// a release regression. The skip is conditioned on a genuine export, so a
// checkout missing the tarball still fails loudly — which is the failure this
// suite was written for.
const IN_EXPORT_TARBALL = isExportTree(ROOT);
const tarballSuite = IN_EXPORT_TARBALL ? describe.skip : describe;

tarballSuite('served agent tarball ↔ manifest ↔ engines (ticket a9a74086)', () => {
  // `describe.skip` marks the tests skipped but STILL RUNS this callback to
  // collect them — measured, 2026-11-05: skipping the describe alone left the
  // collection-time throw below firing, so the suite still failed. The guard
  // has to return from the BODY before that throw, not just change the describe.
  if (IN_EXPORT_TARBALL) {
    it.skip('committed release tarball pins — not applicable to a scrubbed export', () => {});
    return;
  }
  const exists = fs.existsSync(TARBALL);
  // The tarball is a committed artifact — it always exists in a checkout.
  if (!exists) throw new Error(`missing committed tarball: ${TARBALL}`);

  const tarPkg = JSON.parse(readTarEntry('imessage-agent/package.json')) as {
    version: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
  };

  it('the manifest names exactly the version inside the tarball (no silent downgrade)', () => {
    expect(tarPkg.version).toBe(AGENT_RELEASE.version);
  });

  it('the manifest sha256 matches the committed tarball byte-for-byte (a stale sha = a release no Mac can verify)', () => {
    const bytes = fs.readFileSync(TARBALL);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(sha).toBe(AGENT_RELEASE.sha256);
  });

  it('a9a74086: the tarball pins better-sqlite3 12.11.1 exact (Node 20–26 prebuilds; 11.10.0 dies on Node 24+)', () => {
    // EXACT pin: a native-dep version change refuses the self-update swap
    // (0e4c9601 carry rule), so a caret that drifted to 12.12.x would strand
    // the fleet. 11.10.0 has darwin prebuilds only for ABI 108/115/127/131
    // (Node 18–23) and its C++ fails to compile on Node 26's V8.
    expect(tarPkg.dependencies?.['better-sqlite3']).toBe('12.11.1');
  });

  it('a9a74086: the tarball lockfile agrees with its package.json (a half-regenerated lock ships a wrong build)', () => {
    const lock = JSON.parse(readTarEntry('imessage-agent/package-lock.json')) as {
      packages?: Record<string, {
        version?: string;
        engines?: { node?: string };
        dependencies?: Record<string, string>;
      }>;
    };
    expect(lock.packages?.['node_modules/better-sqlite3']?.version).toBe('12.11.1');
    expect(lock.packages?.['']?.engines?.node).toBe('>=20');
    // the lock must carry the SAME exact pin (not a stale ^11 or a drifted ^12)
    expect(lock.packages?.['']?.dependencies?.['better-sqlite3']).toBe('12.11.1');
  });

  it('a9a74086: the tarball engines floor is Node 20 (matches 12.11.1 support; 18 is EOL with no prebuild)', () => {
    expect(tarPkg.engines?.node).toBe('>=20');
  });

  it('a9a74086: the tarball install.sh preflights the Node major (the ticket’s node-gyp wall, made impossible)', () => {
    const installSh = readTarEntry('imessage-agent/install.sh');
    expect(installSh).toContain('NODE_MAJOR=');
    expect(installSh).toContain('[[ "$NODE_MAJOR" -lt 20 ]]');
    expect(installSh).toContain('Node.js 20 or newer is required');
  });
});
