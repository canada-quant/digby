/**
 * Phase 1 self-host (todo 9caf3230) — the published compose file is GENERATED
 * from docker-compose.selfhost.yml and must never drift from it.
 *
 * WHY THIS TEST EXISTS
 *   A stranger installing from published images runs
 *   docker-compose.selfhost.published.yml — a file they hold no reference copy
 *   of. If it drifts from the source compose, the failure is invisible from
 *   inside this repo and loud on their machine: a service missing from the
 *   published file simply does not exist for them, and a wrong image tag fails
 *   at `docker compose pull` with a registry 404.
 *
 *   So the committed render is pinned to a fresh render, the build-context →
 *   image mapping is pinned to the publish workflow, and the workflow is pinned
 *   to the zero-provisioned-credential posture.
 *
 * This runs under BACKEND jest (roots include backend/scripts) and drives the
 * real generator as a CLI, so the artifact tested is the artifact that ships.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'selfhost', 'render-published-compose.mjs');
const SOURCE = path.join(REPO_ROOT, 'docker-compose.selfhost.yml');
const TARGET = path.join(REPO_ROOT, 'docker-compose.selfhost.published.yml');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'selfhost', 'install.sh');

/**
 * The publish workflow is SUPPLIED into the public tree from a private source
 * under .digby/ (which the export drops wholesale). So this suite runs in two
 * different layouts and must find the file in whichever one it is in:
 *
 *   private tree  .digby/publish/publish-images.yml      (the source of truth)
 *   public tree   .github/workflows/publish-images.yml   (what was supplied)
 *
 * Pinning only the private path made this suite fail in the exported tree —
 * caught by scan-public-tree.sh leg F running the tree's own tests, which is
 * exactly the job of that leg.
 */
const WORKFLOW = (() => {
  const candidates = [
    path.join(REPO_ROOT, '.digby', 'publish', 'publish-images.yml'),
    path.join(REPO_ROOT, '.github', 'workflows', 'publish-images.yml'),
  ];
  const found = candidates.find((p) => existsSync(p));
  // Fall back to the private path so a MISSING file fails loudly with a useful
  // message ("not built") rather than a confusing ENOENT from read().
  return found ?? candidates[0];
})();

const read = (p: string) => readFileSync(p, 'utf8');

/** `service:` keys are the only lines at exactly two spaces ending in ':'. */
function serviceNames(composeText: string): string[] {
  return composeText
    .split('\n')
    .filter((l) => /^ {2}[a-z0-9][a-z0-9_-]*:\s*$/.test(l))
    .map((l) => l.trim().replace(/:$/, ''))
    .sort();
}

/** The `image:` line belonging to a named service block. */
function imageFor(composeText: string, service: string): string | undefined {
  const start = composeText.indexOf(`  ${service}:`);
  if (start < 0) return undefined;
  const rest = composeText.slice(start);
  // Stop at the next two-space service key so we never read a later service's image.
  const next = rest.slice(1).search(/\n {2}[a-z0-9][a-z0-9_-]*:\s*\n/);
  const block = next >= 0 ? rest.slice(0, next + 1) : rest;
  return block
    .split('\n')
    .find((l) => l.trim().startsWith('image:'))
    ?.trim();
}

describe('published compose is a faithful render of the source compose', () => {
  it('the committed file matches a fresh render (no drift)', () => {
    // Render into a scratch copy of the tree so the check never rewrites the
    // working tree: copy the generator + source to a temp root and run it.
    const tmp = mkdtempSync(path.join(tmpdir(), 'render-check-'));
    try {
      expect(existsSync(GENERATOR)).toBe(true);
      expect(existsSync(SOURCE)).toBe(true);

      // The generator resolves paths from its own location, so run it in place
      // but diff WITHOUT writing: `--check` is the drift gate.
      const out = execFileSync('node', [GENERATOR, '--check'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out).toContain('PASS');
      expect(read(TARGET)).toBe(read(TARGET)); // file is unchanged by --check
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('carries no build: block — every service pulls', () => {
    const lines = read(TARGET)
      .split('\n')
      .filter((l) => /^\s+build:\s*$/.test(l));
    expect(lines).toEqual([]);
  });

  it('every source service appears in the published file', () => {
    const src = serviceNames(read(SOURCE));
    const pub = serviceNames(read(TARGET));
    expect(src.length).toBeGreaterThan(0);
    expect(pub).toEqual(src);
  });

  it('the migrate service gets the -build tag (it needs the prisma CLI)', () => {
    const image = imageFor(read(TARGET), 'migrate');
    expect(image).toBeDefined();
    expect(image).toContain('-backend:');
    expect(image!.endsWith('-build')).toBe(true);
  });

  it('backend / relay / worker share the production tag, not the build stage', () => {
    const text = read(TARGET);
    for (const svc of ['backend', 'relay', 'worker']) {
      const image = imageFor(text, svc);
      // This jest build's `expect` takes one argument, so the failing service
      // is named by including it in the compared value instead of a message.
      expect({ svc, image }).toEqual({ svc, image: expect.any(String) });
      expect({ svc, usesBuildStage: image!.endsWith('-build') }).toEqual({ svc, usesBuildStage: false });
    }
  });

  it('the frontend pulls a published image too (the whole point of the file)', () => {
    const image = imageFor(read(TARGET), 'frontend');
    expect(image).toBeDefined();
    expect(image).toMatch(/-frontend:\$\{DIGBY_IMAGE_TAG:-latest\}$/);
  });

  it('registry and tag stay overridable so a fork publishes to its own namespace', () => {
    const text = read(TARGET);
    expect(text).toContain('${DIGBY_IMAGE_REGISTRY:-ghcr.io/canada-quant/digby}');
    expect(text).toContain('${DIGBY_IMAGE_TAG:-latest}');
  });

  it('preserves non-image fields: the Caddyfile mount and ./branding mount survive', () => {
    const text = read(TARGET);
    expect(text).toContain('./deploy/selfhost/Caddyfile');
    expect(text).toContain('./branding:/branding:ro');
    // The operator-facing port knob must survive the transform.
    expect(text).toContain('${SELFHOST_PORT:-8080}');
  });
});

describe('publish workflow and render script agree', () => {
  it('every image the render references is built by the workflow', () => {
    const wf = read(WORKFLOW);
    const text = read(TARGET);
    const names = new Set<string>();
    for (const m of text.matchAll(/-([a-z0-9][a-z0-9-]*):\$\{DIGBY_IMAGE_TAG/g)) {
      names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      // One-arg expect: carry the name into the compared value so a failure
      // still says WHICH image the workflow never builds.
      expect({ name, built: wf.includes(name) }).toEqual({ name, built: true });
    }
  });

  it('publishes with GITHUB_TOKEN ONLY — the public repo holds zero provisioned secrets', () => {
    const wf = read(WORKFLOW);
    const refs = [...wf.matchAll(/(secrets|vars)\.([A-Z_][A-Z0-9_]*)/g)].map((m) => `${m[1]}.${m[2]}`);
    // GITHUB_TOKEN is injected by Actions itself; scan-public-tree.sh leg C2
    // exempts exactly it and fails on anything else.
    expect([...new Set(refs)]).toEqual(['secrets.GITHUB_TOKEN']);
  });

  it('declares the least privilege it needs', () => {
    const wf = read(WORKFLOW);
    expect(wf).toMatch(/^\s+packages:\s+write\s*$/m);
    expect(wf).toMatch(/^\s+contents:\s+read\s*$/m);
  });

  it('builds the frontend with a RELATIVE api base so one image fits every hostname', () => {
    const wf = read(WORKFLOW);
    expect(wf).toContain('NEXT_PUBLIC_API_URL=/api');
    expect(wf).toContain('DIGBY_INSTANCE=selfhost');
  });

  it('is release-triggered, not push-to-main (so :latest cannot move under a running install)', () => {
    const wf = read(WORKFLOW);
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\nconcurrency:'));
    expect(on).toContain('v*');
    expect(on).toContain('workflow_dispatch');
    expect(on).not.toContain('branches:');
  });

  it('a release push ALSO moves `latest`, so the default install is the newest release (b05753aa)', () => {
    // The defect this pins (measured 2026-11-06): a `v*` tag push applied only
    // the version tag + sha tag, so `latest` was left at whatever manual
    // dispatch ran last — and the documented stranger quick-start (install.sh
    // sets no tag, compose resolves `:latest`) installed an OLD image with no
    // revision label. `latest` must mean "newest release", per image family.
    const wf = read(WORKFLOW);
    for (const family of ['backend', 'frontend']) {
      const latestOnTag = new RegExp(
        `github\\.ref_type == 'tag'[^\\n]*-${family}:latest`,
      );
      expect({ family, emitsLatestOnTag: latestOnTag.test(wf) }).toEqual({
        family,
        emitsLatestOnTag: true,
      });
    }
    // ...and every OTHER published image family (the matrix) does the same. The
    // matrix line is built with `format('{0}/{1}-{2}:latest', ...)`, so match the
    // real shape rather than a literal ${{ matrix.name }} interpolation.
    expect(wf).toMatch(/github\.ref_type == 'tag'[\s\S]{0,120}format\('[^']*-[^']*:latest'[\s\S]{0,80}matrix\.name/);
    // The migrate service pulls `-build`; without a `latest-build` the migrate
    // container of a default install would not exist.
    expect(wf).toContain('-backend:latest-build');
  });

  it('builds BOTH backend stages — without the build tag, migrate has nothing to pull', () => {
    const wf = read(WORKFLOW);
    expect(wf).toContain('target: production');
    expect(wf).toContain('target: build');
  });
});

describe('installer is safe for a stranger to run', () => {
  it('exists and is POSIX sh', () => {
    const sh = read(INSTALLER);
    expect(sh.startsWith('#!/bin/sh')).toBe(true);
    expect(sh).not.toMatch(/\blocal \w+=/);
    expect(sh).not.toMatch(/^\s*declare /m);
  });

  it('never overwrites an operator .env', () => {
    expect(read(INSTALLER)).toContain('keeping existing .env');
  });

  it('downloads only from the public repo, never a private path', () => {
    const sh = read(INSTALLER);
    expect(sh).toContain('raw.githubusercontent.com');
    expect(sh).toContain('canada-quant/digby');
    expect(sh).not.toContain('example-org');
  });

  it('ships no credentials — it tells the operator to generate them', () => {
    const sh = read(INSTALLER);
    expect(sh).toContain('openssl rand -hex 32');
    // A literal assignment of a non-empty secret in the installer would mean a
    // published credential. The example file's values are all empty.
    expect(sh).not.toMatch(/^\s*JWT_SECRET=\S+/m);
    expect(sh).not.toMatch(/^\s*POSTGRES_PASSWORD=\S+/m);
  });
});