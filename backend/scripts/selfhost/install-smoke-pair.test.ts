/**
 * Phase 1 self-host (todo 13f6da9f) — the install/upgrade smoke's tag pair must
 * track the release it claims to test.
 *
 * WHY THIS TEST EXISTS
 *   `install-smoke.yml` proves the documented stranger journey: install from
 *   published images, register the first admin, then UPGRADE. A `release:
 *   published` event carries NO inputs, so the workflow `env:` fallbacks — not
 *   the `workflow_dispatch` defaults — are what actually run on a release.
 *
 *   That gap shipped TWICE:
 *     - v1.0.2 (run 42363887067) ran 1.0.0 -> 1.0.1 while the pair was meant to
 *       be 1.0.1 -> 1.0.2, so the green run proved nothing about v1.0.2.
 *     - v1.0.3 (run 42366894697) ran 1.0.1 -> 1.0.2, so the green run proved
 *       nothing about v1.0.3 either — the exact defect class, one release later,
 *       because the fix moved the pair without pinning the INVARIANT.
 *
 *   The invariant that actually needs pinning is not any single literal: it is
 *   that every pair site AGREES and that `to_tag` is the release the guide
 *   documents as current. A test that only pins "the four sites match each
 *   other" would still have passed while all four lagged one release behind, so
 *   this suite ties the pair to `docs/SELF_HOST.md`'s "current release" claim.
 *
 *   This runs under BACKEND jest (roots include backend/scripts) and is
 *   dual-layout: it reads the private source under `.digby/publish/` when
 *   present, else the supplied copy under `.github/workflows/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Supplied into the public tree from `.digby/`; find it in whichever layout we are in. */
const WORKFLOW = (() => {
  const candidates = [
    path.join(REPO_ROOT, '.digby', 'publish', 'install-smoke.yml'),
    path.join(REPO_ROOT, '.github', 'workflows', 'install-smoke.yml'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
})();

const SELF_HOST_GUIDE = path.join(REPO_ROOT, 'docs', 'SELF_HOST.md');

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Every site in the workflow that names the release pair. Missing any one of
 * them leaves the pair half-moved: the job NAME can disagree with what runs,
 * and the `env:` fallbacks are what a release event actually uses.
 */
interface PairSite {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

function pairSites(text: string): PairSite[] {
  const sites: PairSite[] = [];

  // 1-2. workflow_dispatch `default:` values (what a manual dispatch uses).
  // Bounded to the two inputs so an unrelated `default:` further down cannot
  // be mistaken for a pair site.
  const inputBlock = text.slice(
    text.indexOf('workflow_dispatch:'),
    text.indexOf('schedule:'),
  );
  const fromDefault = /from_tag:[\s\S]*?default:\s*"([^"]+)"/.exec(inputBlock);
  const toDefault = /to_tag:[\s\S]*?default:\s*"([^"]+)"/.exec(inputBlock);
  if (fromDefault && toDefault) {
    sites.push({
      label: 'workflow_dispatch defaults',
      from: fromDefault[1],
      to: toDefault[1],
    });
  }

  // 3-4. `env:` fallbacks — WHAT A `release: published` RUN ACTUALLY USES.
  const fromEnv = /FROM_TAG:\s*\$\{\{\s*inputs\.from_tag\s*\|\|\s*'([^']+)'\s*\}\}/.exec(text);
  const toEnv = /TO_TAG:\s*\$\{\{\s*inputs\.to_tag\s*\|\|\s*'([^']+)'\s*\}\}/.exec(text);
  if (fromEnv && toEnv) {
    sites.push({ label: 'env fallbacks', from: fromEnv[1], to: toEnv[1] });
  }

  // 5. The job NAME a stranger reads in the Actions UI.
  const jobName = /name:\s*anonymous install \$\{\{\s*inputs\.from_tag\s*\|\|\s*'([^']+)'\s*\}\}\s*→\s*upgrade to \$\{\{\s*inputs\.to_tag\s*\|\|\s*'([^']+)'\s*\}\}/.exec(
    text,
  );
  if (jobName) {
    sites.push({ label: 'job name', from: jobName[1], to: jobName[2] });
  }

  // 6. The upgrade step's display name.
  const upgradeStep = /name:\s*E — upgrade to \$\{\{\s*inputs\.to_tag\s*\|\|\s*'([^']+)'\s*\}\}/.exec(text);
  if (upgradeStep) {
    sites.push({ label: 'upgrade step name', from: sites[0]?.from ?? '', to: upgradeStep[1] });
  }

  return sites;
}

/** "**`v1.0.3`** is the current release" -> "1.0.3" */
function documentedCurrentRelease(guideText: string): string | undefined {
  const m = /\*\*`v(\d+\.\d+\.\d+)`\*\*\s+is the current release/.exec(guideText);
  return m?.[1];
}

/**
 * The dispatch defaults the GUIDE tells a stranger to expect:
 *
 *   `from_tag` (the upgrade baseline — an older release, default `1.0.1`) and
 *   `to_tag` (the release under test, default `1.0.2`).
 *
 * Why this is pinned separately: the release-event path uses the workflow
 * `env:` fallbacks, so the `workflow_dispatch` `default:` values are the ones a
 * HUMAN reads and hand-types when they start a run from the Actions UI. They
 * drifted independently of the fallbacks — after the pair moved to 1.0.2→1.0.3
 * the guide still advertised 1.0.1/1.0.2, i.e. a stranger following the page
 * would dispatch the PREVIOUS pair and prove nothing about the current release.
 * That is the same defect class as the two stale-release smoke runs.
 */
function documentedDispatchDefaults(
  guideText: string,
): { from: string; to: string } | undefined {
  const from = /`from_tag`[^\n]*?default\s+`(\d+\.\d+\.\d+)`/.exec(guideText);
  const to = /`to_tag`[^\n]*?default\s+`(\d+\.\d+\.\d+)`/.exec(guideText);
  if (!from || !to) return undefined;
  return { from: from[1], to: to[1] };
}

/** The `workflow_dispatch` `default:` pair — what a manual dispatch starts from. */
function workflowInputDefaults(
  workflowText: string,
): { from: string; to: string } | undefined {
  const inputBlock = workflowText.slice(
    workflowText.indexOf('workflow_dispatch:'),
    workflowText.indexOf('schedule:'),
  );
  const from = /from_tag:[\s\S]*?default:\s*"([^"]+)"/.exec(inputBlock);
  const to = /to_tag:[\s\S]*?default:\s*"([^"]+)"/.exec(inputBlock);
  if (!from || !to) return undefined;
  return { from: from[1], to: to[1] };
}

describe('install-smoke release pair tracks the documented release', () => {
  const workflow = read(WORKFLOW);
  const guide = read(SELF_HOST_GUIDE);

  it('finds every pair site (a reworded workflow must not silently skip this suite)', () => {
    const sites = pairSites(workflow);
    // from/to defaults, from/to env fallbacks, job name, upgrade step name.
    expect(sites.map((s) => s.label)).toEqual([
      'workflow_dispatch defaults',
      'env fallbacks',
      'job name',
      'upgrade step name',
    ]);
  });

  it('every pair site agrees — a half-moved pair makes the job name lie about what ran', () => {
    const sites = pairSites(workflow);
    for (const site of sites) {
      expect({ site: site.label, from: site.from, to: site.to }).toEqual({
        site: site.label,
        from: sites[0].from,
        to: sites[0].to,
      });
    }
  });

  it('the documented current release is what the guide claims', () => {
    // Guards the OTHER half of the invariant: if the guide moves and the pair
    // does not (or vice versa), one of these two assertions fails.
    expect(documentedCurrentRelease(guide)).toBeDefined();
  });

  it('to_tag IS the release the guide documents as current', () => {
    const sites = pairSites(workflow);
    const documented = documentedCurrentRelease(guide);

    // This is the assertion that would have caught BOTH v1.0.2 and v1.0.3:
    // the pair agreed with itself while lagging the release it claimed to test.
    expect(sites[0].to).toBe(documented);
  });

  it('from_tag is an older release than to_tag (an upgrade must actually upgrade)', () => {
    const [first] = pairSites(workflow);
    const v = (s: string) => s.split('.').map(Number);
    const [fMaj, fMin, fPat] = v(first.from);
    const [tMaj, tMin, tPat] = v(first.to);
    const from = fMaj * 1e6 + fMin * 1e3 + fPat;
    const to = tMaj * 1e6 + tMin * 1e3 + tPat;

    // Equal endpoints make the "revision changed" assertion reject the run as
    // not-an-upgrade; a NEWER baseline would test a downgrade, not an upgrade.
    expect(from).toBeLessThan(to);
  });

  it('parses the dispatch defaults out of both the guide and the workflow', () => {
    // A prose rewrite that drops either parenthetical would make the pin below
    // vacuous; fail loudly instead of silently weakening it.
    expect(documentedDispatchDefaults(guide)).toBeDefined();
    expect(workflowInputDefaults(workflow)).toBeDefined();
  });

  it('the guide advertises the SAME dispatch defaults the workflow actually has', () => {
    // The reader-facing half of the pair. The `env:` fallbacks (what a release
    // event runs) were pinned first; these `default:` values are what a human
    // copies when they start a run by hand. They forked once already: the pair
    // moved to 1.0.2→1.0.3 while this paragraph still said 1.0.1→1.0.2, so the
    // documented manual dispatch would have re-proven the PREVIOUS release.
    expect(documentedDispatchDefaults(guide)).toEqual(workflowInputDefaults(workflow));
  });

  it('the guide still names the current release in the form this suite parses', () => {
    // A prose rewrite that drops "is the current release" would let
    // documentedCurrentRelease() return undefined and quietly weaken the pin
    // above; fail loudly instead.
    expect(guide).toMatch(/\*\*`v\d+\.\d+\.\d+`\*\*\s+is the current release/);
  });
});