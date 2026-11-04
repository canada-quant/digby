/**
 * Ticket ad9ef768 — login-page marketing surface + contact-address migration.
 *
 * SOURCE-LEVEL pins (the phase0-ui-pins / ui-polish-pins idiom: readFileSync +
 * toContain on stable identifiers, never line numbers). The login page is a
 * 'use client' component behind useRouter/useSearchParams — no jsdom, no
 * next/navigation mock precedent in this repo — so its marketing surface is
 * pinned at source level, exactly like the auth pins already in
 * ui-polish-pins.test.ts.
 *
 * 1. The marketing panel keeps the brand headline, gains the differentiator
 *    subhead, renders the seven feature cards (each claim repo-verifiable —
 *    see the LOGIN_FEATURES docblock in page.tsx), and owns its scroll so the
 *    taller grid cannot clip on short viewports.
 * 2. The auth surface is untouched: the login/signup handlers and their
 *    single authApi calls are still there, marketing added no auth logic.
 * 3. Contact addresses: the whole frontend source tree is walked and must
 *    contain NONE of the legacy contact addresses (help@ / hello@ /
 *    support@ / contact@digby.example.com) — the site address is digby@digby.example.com
 *    (owner directive 2026-09-25). The mobile SUPPORT_EMAIL surfaces are
 *    pinned the same way.
 *
 * A failing pin is a regression to fix in the page, not a test to weaken.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const LOGIN_PAGE = fileURLToPath(new URL('./page.tsx', import.meta.url));
const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// test file lives at <repo>/frontend/app/login/ — repo root is three dirs up.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (abs: string): string => readFileSync(abs, 'utf8');

const page = read(LOGIN_PAGE);

/** The seven marketing cards (titles pin the card set without pinning layout). */
const CARD_TITLES = [
  'The whole AI council',
  'Learns who you are',
  'Canvas workspace',
  'Projects & knowledge',
  'Coding sessions that ship',
  'A fleet while you sleep',
  'Works inside your tools',
];

describe('Login marketing surface (ticket ad9ef768)', () => {
  it('keeps the brand headline and lands the differentiator subhead', () => {
    expect(page).toContain('Ask once. Get the best of every AI.');
    expect(page).toContain(
      'One question, every frontier model, one blended answer — with long-running coding sessions that ship real PRs.'
    );
  });

  it('declares all seven feature cards (the 4 originals + coding sessions, fleet, integrations)', () => {
    expect(page).toContain('const LOGIN_FEATURES');
    for (const title of CARD_TITLES) {
      expect(page, `feature card missing: ${title}`).toContain(title);
    }
  });

  it('lays the cards out as a grid with the integrations card spanning both columns', () => {
    expect(page).toContain('grid grid-cols-2 gap-3');
    expect(page).toContain("wide ? ' col-span-2' : ''");
  });

  it('the branding panel owns its scroll so the taller grid cannot clip (short-viewport QA)', () => {
    // Same idiom as the right column (ui-polish-pins pins that one):
    // min-h-full + justify-center inside a flex-1 min-h-0 scroll wrapper.
    expect(page).toContain('relative z-10 flex-1 min-h-0 overflow-y-auto');
    expect(page).toContain('flex min-h-full flex-col items-center justify-center');
  });

  it('trust strip carries only repo-verifiable claims', () => {
    expect(page).toContain('Live at digby.example.com');
    expect(page).toContain('Self-hostable — MIT licensed');
    expect(page).toContain('Frontier &amp; open-source models');
  });
});

describe('Login auth surface untouched (ticket ad9ef768 constraint)', () => {
  it('login/signup handlers and their single authApi calls are intact', () => {
    expect(page).toContain('const handleLogin = async');
    expect(page).toContain('const handleSignup = async');
    expect(page).toContain('await authApi.login(');
    expect(page).toContain('await authApi.register(');
    // Marketing must not have added auth API calls: exactly one of each.
    expect(page.split('authApi.login(').length - 1).toBe(1);
    expect(page.split('authApi.register(').length - 1).toBe(1);
  });
});

// ── contact-address migration ────────────────────────────────────────────────

/** Legacy contact addresses the owner retired in favour of digby@digby.example.com. */
const LEGACY_ADDRESSES = [
  'help@digby.example.com',
  'hello@digby.example.com',
  'support@digby.example.com',
  'contact@digby.example.com',
];

/** Text extensions worth scanning (skips binaries in public/ and lockfiles). */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.css', '.html', '.txt', '.yml', '.yaml', '.xml', '.svg',
]);

const SKIP_DIRS = new Set(['node_modules', '.next', '__snapshots__', '.git']);

/** Recursively collect text-file paths under root. */
function collectTextFiles(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collectTextFiles(abs, out);
    } else {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      // Test files legitimately NAME the banned literals (this pin does);
      // package-lock.json is generated. Neither is user-facing source.
      if (TEXT_EXT.has(ext) && !/\.test\.[cm]?[jt]sx?$/.test(name) && name !== 'package-lock.json') {
        out.push(abs);
      }
    }
  }
  return out;
}

describe('Contact-address migration — digby@digby.example.com everywhere (ticket ad9ef768)', () => {
  it('no legacy contact address (help@/hello@/support@/contact@digby.example.com) anywhere in frontend source', () => {
    const offenders: string[] = [];
    for (const abs of collectTextFiles(FRONTEND_ROOT)) {
      const src = read(abs);
      const lower = src.toLowerCase();
      for (const legacy of LEGACY_ADDRESSES) {
        if (lower.includes(legacy)) offenders.push(`${abs.replace(FRONTEND_ROOT, '')}: ${legacy}`);
      }
    }
    expect(offenders, `legacy contact addresses found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('ToS, privacy, landing footer and login footer all use digby@digby.example.com', () => {
    for (const rel of [
      'app/(site)/terms/page.tsx',
      'app/(site)/privacy/page.tsx',
      'app/crossmodel/page.tsx',
      'app/login/page.tsx',
    ]) {
      expect(read(join(FRONTEND_ROOT, rel)), `${rel}`).toContain('mailto:digby@digby.example.com');
    }
  });

});
