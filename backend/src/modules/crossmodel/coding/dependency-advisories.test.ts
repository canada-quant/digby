// dependency-advisories now reaches workspace.service (the shared git runner
// with safe.directory ownership-drift resilience) → utils/logger → config/env,
// which validates env at import. Mock the logger (the repo idiom — see
// open-pull-request-head.c7bf1e66.test.ts) so the pure-fs suite stays hermetic.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkDependencyAdvisories,
  cleanVersion,
  compareVersions,
  dependencyAdvisoryCheckDisabled,
  fixedVersionFor,
  groupFindings,
  pnpmImporterVersions,
  renderAdvisoryNotice,
  renderAdvisoryPrBody,
  resetAdvisoryCache,
  resolveProductionDeps,
  versionFromPackageLock,
} from './dependency-advisories';

// The 2026-10-12 incident shape: a pnpm app pinned to a framework version with a
// public critical RCE advisory (React2Shell, fixed in 15.3.6).
const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@trpc/server':
        specifier: ^11.16.0
        version: 11.16.0(typescript@5.9.3)
      next:
        specifier: 15.3.1
        version: 15.3.1(@babel/core@7.29.0)(react-dom@19.2.4(react@19.2.4))(react@19.2.4)
      react:
        specifier: 19.2.4
        version: 19.2.4
    devDependencies:
      typescript:
        specifier: 5.9.3
        version: 5.9.3

packages:

  next@15.3.1:
    resolution: {integrity: sha512-x}
`;

const REACT2SHELL = {
  id: 'GHSA-9qr9-h5gf-34mp',
  aliases: ['CVE-2025-66478'],
  summary: 'Next.js is vulnerable to RCE in React flight protocol',
  database_specific: { severity: 'CRITICAL' },
  affected: [
    { package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '15.0.0' }, { fixed: '15.0.5' }] }] },
    { package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '15.3.0' }, { fixed: '15.3.6' }] }] },
    { package: { ecosystem: 'npm', name: 'next' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '16.0.0' }, { fixed: '16.0.7' }] }] },
  ],
};
const MODERATE = { id: 'GHSA-mod', summary: 'cache poisoning', database_specific: { severity: 'MODERATE' }, affected: [] };

function fakeOsv(byPkg: Record<string, any[]>, opts: { failBatch?: boolean } = {}) {
  const calls: string[] = [];
  const all = new Map<string, any>(Object.values(byPkg).flat().map(v => [v.id, v]));
  const impl = async (url: string, init?: any) => {
    calls.push(url);
    if (url.endsWith('/querybatch')) {
      if (opts.failBatch) return { ok: false, status: 503, json: async () => ({}) };
      const q = JSON.parse(init.body).queries as Array<{ package: { name: string } }>;
      return { ok: true, status: 200, json: async () => ({ results: q.map(x => ({ vulns: (byPkg[x.package.name] || []).map(v => ({ id: v.id })) })) }) };
    }
    const id = decodeURIComponent(url.split('/vulns/')[1]);
    const v = all.get(id);
    return v ? { ok: true, status: 200, json: async () => v } : { ok: false, status: 404, json: async () => ({}) };
  };
  return { impl, calls };
}

async function tmpRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dep-adv-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
  return root;
}

beforeEach(() => resetAdvisoryCache());

describe('version helpers', () => {
  it('strips pnpm peer suffixes and quotes', () => {
    expect(cleanVersion("15.3.1(@babel/core@7.29.0)(react@19.2.4)")).toBe('15.3.1');
    expect(cleanVersion("'19.2.4'")).toBe('19.2.4');
  });
  it('compares numerically with prereleases below their release', () => {
    expect(compareVersions('15.3.6', '15.3.1')).toBe(1);
    expect(compareVersions('15.10.0', '15.9.9')).toBe(1);
    expect(compareVersions('16.0.0-canary.1', '16.0.0')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('picks the lowest fixed version above the installed one, for this package only', () => {
    expect(fixedVersionFor(REACT2SHELL, 'next', '15.3.1')).toBe('15.3.6');
    expect(fixedVersionFor(REACT2SHELL, 'react', '15.3.1')).toBeNull();
  });
});

describe('lockfile readers', () => {
  it('reads the root importer of a pnpm v9 lockfile (dependencies only)', () => {
    const m = pnpmImporterVersions(PNPM_LOCK);
    expect(m.get('next')).toBe('15.3.1');
    expect(m.get('@trpc/server')).toBe('11.16.0');
    expect(m.get('react')).toBe('19.2.4');
    expect(m.has('typescript')).toBe(false); // devDependencies are not production
  });
  it('reads package-lock v3 and v1', () => {
    expect(versionFromPackageLock({ packages: { 'node_modules/next': { version: '16.3.3' } } }, 'next')).toBe('16.3.3');
    expect(versionFromPackageLock({ dependencies: { next: { version: '13.4.0' } } }, 'next')).toBe('13.4.0');
    expect(versionFromPackageLock({}, 'next')).toBeNull();
  });
});

describe('resolveProductionDeps', () => {
  it('resolves a pnpm app to the installed versions, skipping devDependencies', async () => {
    const root = await tmpRepo({
      'package.json': JSON.stringify({ dependencies: { next: '15.3.1', react: '19.2.4', '@trpc/server': '^11.16.0' }, devDependencies: { typescript: '5.9.3' } }),
      'pnpm-lock.yaml': PNPM_LOCK,
    });
    const { deps, manifests } = await resolveProductionDeps(root);
    expect(manifests).toEqual(['package.json']);
    expect(deps.map(d => `${d.name}@${d.version}`).sort()).toEqual(['@trpc/server@11.16.0', 'next@15.3.1', 'react@19.2.4']);
  });

  it('finds sub-project manifests (frontend/, backend/) with their own npm lockfiles, never node_modules', async () => {
    const root = await tmpRepo({
      'frontend/package.json': JSON.stringify({ dependencies: { next: '^16.0.10' } }),
      'frontend/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '16.1.1' } } }),
      'backend/package.json': JSON.stringify({ dependencies: { express: '^5.1.0' } }),
      'backend/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/express': { version: '5.1.0' } } }),
      'frontend/node_modules/x/package.json': JSON.stringify({ dependencies: { evil: '1.0.0' } }),
    });
    const { deps } = await resolveProductionDeps(root);
    expect(deps.map(d => `${d.manifest}:${d.name}@${d.version}`).sort()).toEqual([
      'backend/package.json:express@5.1.0',
      'frontend/package.json:next@16.1.1',
    ]);
  });

  it('falls back to an exact package.json pin when there is no lockfile, and skips ranges it cannot resolve', async () => {
    const root = await tmpRepo({ 'package.json': JSON.stringify({ dependencies: { next: '15.3.1', lodash: '^4.17.0', local: 'file:../x' } }) });
    const { deps } = await resolveProductionDeps(root);
    expect(deps.map(d => `${d.name}@${d.version}`)).toEqual(['next@15.3.1']);
  });
});

describe('checkDependencyAdvisories', () => {
  it('reports the critical framework advisory with its fixed version (the incident shape), ignoring moderates', async () => {
    const root = await tmpRepo({
      'package.json': JSON.stringify({ dependencies: { next: '15.3.1', react: '19.2.4' } }),
      'pnpm-lock.yaml': PNPM_LOCK,
    });
    const osv = fakeOsv({ next: [REACT2SHELL, MODERATE] });
    const report = await checkDependencyAdvisories(root, { fetchImpl: osv.impl });
    expect(report.error).toBeUndefined();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ pkg: 'next', version: '15.3.1', id: 'GHSA-9qr9-h5gf-34mp', severity: 'CRITICAL', fixed: '15.3.6', manifest: 'package.json' });

    const notice = renderAdvisoryNotice(report);
    expect(notice).toContain('[SECURITY ADVISORY]');
    expect(notice).toContain('CRITICAL next@15.3.1 (package.json): 1 critical — e.g. GHSA-9qr9-h5gf-34mp / CVE-2025-66478');
    expect(notice).toContain('upgrade to ≥ 15.3.6 to clear all of them');
    expect(notice).toContain('never downgrade');
    const body = renderAdvisoryPrBody(report);
    expect(body).toContain('Security advisories in production dependencies');
    expect(body).toContain('https://osv.dev/vulnerability/GHSA-9qr9-h5gf-34mp');
  });

  it('says nothing when there are no critical/high advisories', async () => {
    const root = await tmpRepo({ 'package.json': JSON.stringify({ dependencies: { next: '16.4.0' } }) });
    const report = await checkDependencyAdvisories(root, { fetchImpl: fakeOsv({ next: [MODERATE] }).impl });
    expect(report.findings).toEqual([]);
    expect(renderAdvisoryNotice(report)).toBe('');
    expect(renderAdvisoryPrBody(report)).toBe('');
  });

  it('fails open on an OSV outage (no findings, an error string, never throws)', async () => {
    const root = await tmpRepo({ 'package.json': JSON.stringify({ dependencies: { next: '15.3.1' } }) });
    const report = await checkDependencyAdvisories(root, { fetchImpl: fakeOsv({}, { failBatch: true }).impl });
    expect(report.findings).toEqual([]);
    expect(report.error).toMatch(/HTTP 503/);
  });

  it('fails open when fetch throws (network down / timeout)', async () => {
    const root = await tmpRepo({ 'package.json': JSON.stringify({ dependencies: { next: '15.3.1' } }) });
    const report = await checkDependencyAdvisories(root, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(report.findings).toEqual([]);
    expect(report.error).toMatch(/ECONNREFUSED/);
  });

  it('caches a complete answer per name@version (a second PR does not re-ask OSV)', async () => {
    const root = await tmpRepo({ 'package.json': JSON.stringify({ dependencies: { next: '15.3.1' } }) });
    const osv = fakeOsv({ next: [REACT2SHELL] });
    await checkDependencyAdvisories(root, { fetchImpl: osv.impl });
    const n = osv.calls.length;
    const again = await checkDependencyAdvisories(root, { fetchImpl: osv.impl });
    expect(osv.calls.length).toBe(n);
    expect(again.findings).toHaveLength(1);
  });

  it('a repo with no package.json reports nothing and asks nothing', async () => {
    const root = await tmpRepo({ 'README.md': '# python only' });
    const osv = fakeOsv({});
    const report = await checkDependencyAdvisories(root, { fetchImpl: osv.impl });
    expect(report).toMatchObject({ findings: [], packages: 0 });
    expect(osv.calls).toEqual([]);
  });
});

describe('groupFindings', () => {
  const f = (id: string, severity: 'CRITICAL' | 'HIGH', fixed: string | null, pkg = 'next') =>
    ({ pkg, version: '15.3.1', manifest: 'package.json', id, aliases: [], severity, summary: id, fixed });
  it('one group per package@version: worst first, the version that clears every fixed advisory', () => {
    const groups = groupFindings([f('H1', 'HIGH', '15.5.18'), f('C1', 'CRITICAL', '15.3.6'), f('C2', 'CRITICAL', '15.5.24'), f('A1', 'HIGH', '1.20.0', 'axios')]);
    expect(groups.map(g => g.pkg)).toEqual(['next', 'axios']);
    expect(groups[0]).toMatchObject({ severity: 'CRITICAL', critical: 2, high: 1, upgradeTo: '15.5.24', unfixed: 0 });
    expect(groups[0].worst.severity).toBe('CRITICAL');
  });
  it('counts advisories with no published fix', () => {
    const [g] = groupFindings([f('C1', 'CRITICAL', null)]);
    expect(g).toMatchObject({ upgradeTo: null, unfixed: 1 });
    expect(renderAdvisoryNotice({ findings: [f('C1', 'CRITICAL', null)], manifests: [], packages: 1 })).toContain('no fixed version published');
  });
});

describe('kill switch', () => {
  it('DEPENDENCY_ADVISORY_CHECK_DISABLED=1 disables the check', () => {
    expect(dependencyAdvisoryCheckDisabled({ DEPENDENCY_ADVISORY_CHECK_DISABLED: '1' } as any)).toBe(true);
    expect(dependencyAdvisoryCheckDisabled({} as any)).toBe(false);
  });
});
