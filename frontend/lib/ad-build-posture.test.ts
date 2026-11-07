/**
 * AD BUILD POSTURE (todo 9a3e82af, 2026-11-06) — the PUBLIC / Self-Hosted /
 * Enterprise image must ship NO ad tech.
 *
 * WHY THIS FILE EXISTS, AND HOW IT DIFFERS FROM ad-free.test.ts
 *   `ad-free.test.ts` walks the frontend SOURCE TREE and proves no ad library,
 *   slot or ads.txt can re-enter the code. It says nothing about the BUILD, and
 *   the build is where this leak lived: every kill switch existed and worked,
 *   but `frontend/Dockerfile` declared them with EMPTY defaults
 *   (`ARG NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED=`). A bare `docker build` — the
 *   thing a stranger building from source runs — therefore compiled DIGBY'S OWN
 *   GA4 (`G-NK7XPHC7FE`), Google Ads (`AW-16512038948`) and Meta pixel
 *   (`4660227547545860`) into their instance. The ids are ours; the traffic
 *   would have been ours too.
 *
 *   Self-host and the published images already passed `=1`, so they were safe in
 *   practice. The DEFAULT was the hole: any other build path inherited it.
 *
 * THE INVARIANT
 *   Disabling is the DEFAULT for every door into the public image, and enabling
 *   is an explicit act. Concretely:
 *     - frontend/Dockerfile ARG defaults        -> disabled
 *     - docker-compose.selfhost.yml defaults    -> disabled
 *     - published workflow build-args           -> disabled
 *     - docker-compose.app.yml (the HOSTED digby.ai deploy) is the ONE place
 *       allowed to enable, and it must keep doing so EXPLICITLY, so an
 *       accidental change there is visible rather than inherited.
 *
 *   `ad-free.test.ts` remains the source gate; this is the build/config gate.
 *   Neither is a RUNTIME network proof — see the note at the bottom.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');

const read = (p: string) => readFileSync(p, 'utf8');
const readRepo = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

/** The three build-time switches that gate Digby's own ad/measurement ids. */
const AD_SWITCHES = [
  'NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED',
  'NEXT_PUBLIC_GOOGLE_ANALYTICS_DISABLED',
  'NEXT_PUBLIC_META_PIXEL_DISABLED',
] as const;

/** The literal ad/measurement ids that must never be shipped to a public build. */
const OWNED_IDS = ['G-NK7XPHC7FE', 'AW-16512038948', '4660227547545860'] as const;

/** Read the declared DEFAULT of an `ARG NAME=value` line, or null when absent. */
function argDefault(dockerfile: string, name: string): string | null {
  const m = dockerfile.match(new RegExp(`^ARG\\s+${name}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

/** Read the compose default of `- NAME=${NAME:-default}`; null when the line is absent. */
function composeDefault(composeText: string, name: string): string | null {
  const m = composeText.match(new RegExp(`-\\s*${name}=\\$\\{${name}:-([^}]*)\\}`));
  return m ? m[1].trim() : null;
}

describe('frontend/Dockerfile — the public image defaults to AD-FREE', () => {
  const dockerfile = read(path.join(FRONTEND_ROOT, 'Dockerfile'));

  it('declares all three ad switches (guards against a rename silently skipping them)', () => {
    for (const name of AD_SWITCHES) {
      const dflt = argDefault(dockerfile, name);
      expect({ name, declared: dflt !== null }).toEqual({ name, declared: true });
    }
  });

  it("defaults every ad switch to '1' (DISABLED) — a bare docker build ships no ad tech", () => {
    // This is the exact hole this suite was written for: these were '' before.
    const wrong: string[] = [];
    for (const name of AD_SWITCHES) {
      const dflt = argDefault(dockerfile, name);
      if (dflt !== '1') wrong.push(`${name}=${JSON.stringify(dflt)}`);
    }
    expect({ adSwitchesNotDisabledByDefault: wrong }).toEqual({ adSwitchesNotDisabledByDefault: [] });
  });

  it('still forwards each switch to ENV (a default nobody reads is decoration)', () => {
    for (const name of AD_SWITCHES) {
      expect({ name, forwarded: dockerfile.includes(`ENV ${name}=$${name}`) }).toEqual({
        name,
        forwarded: true,
      });
    }
  });

  it('hard-codes none of the owned ad ids as a build-time value', () => {
    // The ids must exist only in lib/*.ts as constants the switches gate — never
    // baked into the image config where a switch cannot reach them.
    //
    // Scoped to ARG/ENV ASSIGNMENTS, not the whole file: naming an id in a
    // comment that explains the switch is documentation, not a shipped value,
    // and failing on it would train the next person to delete the explanation.
    const assignments = dockerfile
      .split('\n')
      .filter((l) => /^\s*(ARG|ENV)\s/.test(l))
      .join('\n');
    const leaked = OWNED_IDS.filter((id) => assignments.includes(id));
    expect({ idsInDockerfile: leaked }).toEqual({ idsInDockerfile: [] });
  });
});

describe('self-host + published images are explicitly ad-free', () => {
  it('docker-compose.selfhost.yml carries NO ad switch at all (removed, not merely defaulted off)', () => {
    // 2026-11-07 (todo b05753aa): the self-host stack used to FORWARD the three
    // switches with `${NAME:-1}`. Defaulting them off still shipped the plumbing
    // — and a stranger reading the file had to reason about Digby's own ad
    // accounts to know their instance was clean. The switches are now removed
    // from the self-host compose entirely, so the posture is structural: there
    // is nothing to flip and nothing to explain. Absence is the assertion.
    const text = readRepo('docker-compose.selfhost.yml');
    const present = AD_SWITCHES.filter((name) => text.includes(name));
    expect({ selfHostAdSwitchesStillPresent: present }).toEqual({ selfHostAdSwitchesStillPresent: [] });
    // ...and the same must hold for the generated published variant.
    const published = readRepo('docker-compose.selfhost.published.yml');
    const presentPublished = AD_SWITCHES.filter((name) => published.includes(name));
    expect({ publishedAdSwitchesStillPresent: presentPublished }).toEqual({ publishedAdSwitchesStillPresent: [] });
  });

  it('the published image workflow builds with every ad switch = 1', () => {
    // Two possible layouts, same rule as the compose-render suite: the private
    // source under .digby/, or the supplied copy in the public tree.
    const candidates = [
      path.join(REPO_ROOT, '.digby', 'publish', 'publish-images.yml'),
      path.join(REPO_ROOT, '.github', 'workflows', 'publish-images.yml'),
    ];
    const found = candidates.find((p) => {
      try {
        read(p);
        return true;
      } catch {
        return false;
      }
    });
    expect({ workflowFound: Boolean(found) }).toEqual({ workflowFound: true });

    const wf = read(found!);
    const missing = AD_SWITCHES.filter((name) => !new RegExp(`${name}=1`).test(wf));
    expect({ switchesNotDisabledInWorkflow: missing }).toEqual({ switchesNotDisabledInWorkflow: [] });
  });
});

/**
 * Read a repo file that the PUBLIC EXPORT deliberately WITHHOLDS, or null when
 * it is not there. `docker-compose.app.yml` is the hosted (private) stack and
 * `.digby/publish/scrub-rules.txt` drops it as prod topology — so it is absent
 * in the export BY POLICY, not by accident. Reading it unguarded threw ENOENT
 * during describe-collection and reddened the export's whole vitest leg
 * (measured 2026-11-07, scan leg H).
 *
 * Absent => the block SKIPS, it does not silently pass: the assertions still run
 * in the private tree, which is where the hosted stack lives and where this
 * block is meaningful.
 */
const readRepoIfPresent = (p: string): string | null => {
  try {
    return readRepo(p);
  } catch {
    return null;
  }
};

describe('the hosted digby.ai deploy stays the ONE explicit opt-in', () => {
  // `?? ''` rather than `null`: the skip guard needs a string-typed subject so
  // the assertions below typecheck (`composeDefault` takes a string). TypeScript
  // does not narrow a `const` across the callback boundary, so `app === null`
  // inside the guard would leave `app` as `string | null` at the call sites.
  // An EMPTY compose string is an unambiguous "absent" sentinel here — no real
  // docker-compose.app.yml is empty.
  const app = readRepoIfPresent('docker-compose.app.yml') ?? '';

  it.skipIf(app === '')('passes the switches through with an EMPTY default (empty !== "1", so the tag loads there)', () => {
    // This is the deliberate opposite of the public default. Pinning it means a
    // future "make it consistent" sweep cannot quietly turn digby.ai's
    // measurement off — or, worse, turn a public build's on.
    for (const name of AD_SWITCHES) {
      const dflt = composeDefault(app, name);
      expect({ name, hostedDefault: dflt }).toEqual({ name, hostedDefault: '' });
    }
  });
});

describe('public EXPORT carries no ad config (the exported tree, not just the source)', () => {
  /**
   * The review of the first cut found this leg MISSING: the suites above pin the
   * PRIVATE tree, and the public repo is a *generated* export of it, so a file
   * the export SUPPLIES (or fails to drop) can reintroduce ad config without any
   * private test noticing.
   *
   * The rules file lives under .digby/ and is itself exported-away, so this
   * block skips cleanly in the public tree (where it cannot exist). It runs
   * where it matters: in the private tree, before an export is cut.
   *
   * MEASURED 2026-11-06 by cutting a real export
   * (`scripts/publish/export-public-tree.sh --sha origin/main --out tmp/exp-ads`):
   * 3713 files, scrub PASSED, and in the exported tree
   *   frontend/Dockerfile:24,39 = `ARG ..._DISABLED=1`
   *   .github/workflows/publish-images.yml:197-199 = all three =1
   *   frontend/public/ads.txt          ABSENT
   *   ad ids in *.yml/Dockerfile/*.example config: none as an assignment
   * (the only id occurrences are explanatory COMMENTS in .env.example and the
   * Dockerfile, which document the switches rather than enable anything).
   */
  const RULES = path.join(REPO_ROOT, '.digby', 'publish', 'scrub-rules.txt');
  const rulesExist = (() => {
    try {
      readFileSync(RULES);
      return true;
    } catch {
      return false;
    }
  })();

  it('the export can never ship ads.txt, because the source tree no longer has one', () => {
    // The public tree still served frontend/public/ads.txt (HTTP 200) after the
    // private deletion — the export had simply not been re-cut. Deleting it from
    // the private tree is what makes every FUTURE export clean; this pins the
    // precondition so a re-add is caught before it reaches a public URL.
    expect(existsSync(path.join(FRONTEND_ROOT, 'public', 'ads.txt'))).toBe(false);
  });

  it.skipIf(!rulesExist)('no export supply rule targets an ad file or ad config', () => {
    const rules = readFileSync(RULES, 'utf8');
    // `supply <private> <public>` REPLACES a dropped path. A supply pointing at
    // an ad authorization file or an ad-enabled env example would defeat the
    // deletions above — and it would do so invisibly, in the exported tree only.
    const supplies = rules
      .split('\n')
      .filter((l) => /^supply\s/.test(l))
      .map((l) => l.trim());
    const offenders = supplies.filter((l) => /ads\.txt|google-ads|meta-pixel|doubleclick/i.test(l));
    expect({ adSupplyRules: offenders }).toEqual({ adSupplyRules: [] });
  });

  it.skipIf(!rulesExist)('the supplied publish workflow is the one that bakes the switches to 1', () => {
    const rules = readFileSync(RULES, 'utf8');
    // Assert the supply mapping exists at all — if the workflow were never
    // supplied, the exported repo would have no publish pipeline and the
    // "shipped images" claim would rest on a file the public tree cannot see.
    expect(rules).toMatch(/^supply\s+\.digby\/publish\/publish-images\.yml\s+\.github\/workflows\/publish-images\.yml$/m);
  });
});

/**
 * These are STATIC config assertions. They prove the switches are declared,
 * defaulted off and forwarded. They do NOT prove a rendered page issues zero ad
 * requests: that needs a browser network capture against a running build, and
 * this container has no jsdom / playwright / puppeteer harness to do it in.
 *
 * What closes the gap for the public tiers: the tags are gated at RENDER time by
 * `googleAdsTagDisabled()` / `metaPixelDisabled()` returning true, and
 * `ad-free.test.ts` proves no ad-serving library is in the tree at all. A
 * runtime capture against a deployed public instance remains the only complete
 * proof and is tracked on todo 9a3e82af rather than claimed here.
 */
describe('documented limit', () => {
  it('the ad-free source gate still exists (these two suites are complements)', () => {
    expect(read(path.join(FRONTEND_ROOT, 'lib', 'ad-free.test.ts'))).toContain('ad-free gate');
  });
});