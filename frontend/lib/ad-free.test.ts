/**
 * AD-FREE GATE (todo 9a3e82af) — the reintroduction guard.
 *
 * Digby ships ad-free: no in-product ad serving, no ad-tech libraries. This
 * suite fails the build if an ad library, ad slot or ad authorization file comes
 * back into the frontend tree.
 *
 * WHY A GATE AND NOT JUST THE DELETION: the Google Ad Manager "thinking" slot
 * survived several waves because nothing asserted its absence — every existing
 * test asserted it was correctly KID-GATED, which is a different property. A
 * deletion with no gate is a deletion that regresses silently.
 *
 * SCOPE, STATED HONESTLY: this is a SOURCE + static-asset gate. It proves the
 * tree contains no ad library, slot call or ads.txt authorization. It does NOT
 * prove rendered runtime network behaviour (that the page makes zero ad
 * requests at load); that requires a browser network capture against a running
 * build and is tracked separately on the todo. A green run here is necessary,
 * not sufficient, for the todo's "rendered network behaviour" bar.
 *
 * The Google Ads CONVERSION tag stays for now (lib/google-ads.ts): it is
 * measurement of sign-ups, not ad serving, and it does not render a creative.
 * GA4 rides the same gtag bootstrap, so removing it needs its own decision.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The directories the gate walks. `components/` is a REAL populated tree that
 * the first cut of this gate MISSED — re-adding a googletag slot under
 * frontend/components/ left it green (independent review, 2026-11-06). Pinned
 * by the "walks every source tree" test below so a refactor cannot drop one.
 */
export const WALKED_DIRS = ['app', 'components', 'lib'] as const;

/** Every .ts/.tsx under WALKED_DIRS (tests, node_modules, .next excluded). */
function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name === 'node_modules' || name.name === '.next' || name.name.startsWith('.')) continue;
      const p = join(dir, name.name);
      if (name.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name.name) || /\.test\.(ts|tsx)$/.test(name.name)) continue;
      // Normalize to a LEADING-slash repo-relative path. FRONTEND_ROOT comes from
      // fileURLToPath, which keeps a trailing slash, so a naive slice strips the
      // first character of the segment (this bit twice: once in the landing-page
      // assertion, once in the scope assertion).
      const rel = '/' + p.slice(FRONTEND_ROOT.length).replace(/^\/+/, '').replace(/\\/g, '/');
      out.push({ rel, text: readFileSync(p, 'utf8') });
    }
  };
  for (const dir of WALKED_DIRS) {
    const abs = join(FRONTEND_ROOT, dir);
    if (existsSync(abs)) walk(abs);
  }
  return out;
}

describe('ad-free gate — no ad-tech may re-enter the frontend', () => {
  const files = sources();

  it('walks every source tree (components/ included)', () => {
    // Guards the scope bug this gate shipped with: `frontend/components/` is a
    // real tree, and a slot added there must be caught.
    expect([...WALKED_DIRS]).toEqual(['app', 'components', 'lib']);
    expect(files.some((f) => f.rel.startsWith('/components/'))).toBe(true);
  });

  // The ad-serving libraries: a tag loader or slot API. The conversion tag
  // (googletagmanager.com/gtag) is deliberately NOT in this list.
  const AD_LIBRARY_MARKERS = [
    'securepubads.g.doubleclick.net', // Google Ad Manager (GPT) tag
    'googletag.defineSlot',
    'googletag.pubads',
    'enableServices',
    'adsbygoogle',                    // AdSense
    'google_ad_client',               // legacy AdSense
  ];

  it('no file loads an ad library or requests an ad slot', () => {
    const hits = files.flatMap((f) =>
      AD_LIBRARY_MARKERS.filter((m) => f.text.includes(m)).map((m) => `${f.rel}: ${m}`),
    );
    expect(hits).toEqual([]);
  });

  it('the Google Ad Manager account id is gone from the source tree', () => {
    // pub-5522451507419838 was the Ad Manager inventory; it must not be named in
    // code. (ads.txt itself is asserted absent below.)
    const hits = files.filter((f) => f.text.includes('pub-5522451507419838')).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it('ads.txt is GONE from public/ — no authorized ad inventory', () => {
    // ads.txt is an authorization for ad sellers to serve against our domain.
    // Its absence is the strongest static signal that we sell no ad inventory.
    expect(existsSync(join(FRONTEND_ROOT, 'public', 'ads.txt'))).toBe(false);
  });

  it('the retired ThinkingAd slot component does not exist', () => {
    expect(existsSync(join(FRONTEND_ROOT, 'app', 'crossmodel', 'components', 'ThinkingAd.tsx'))).toBe(false);
  });

  it('the landing page mounts no ad slot', () => {
    // Read the file directly rather than matching a computed relative path —
    // the path-shape match was itself the bug in the first cut of this gate.
    const landingPath = join(FRONTEND_ROOT, 'app', 'crossmodel', 'page.tsx');
    expect(existsSync(landingPath)).toBe(true);
    const landing = readFileSync(landingPath, 'utf8');
    expect(landing).not.toContain('<ThinkingAd');
    expect(landing).not.toContain('adLibAllowed');
  });
});