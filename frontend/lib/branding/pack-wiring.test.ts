/**
 * WIRING pins — the pack feature is actually CONNECTED (todo 61dc8aaf).
 *
 * `pack.test.ts` proves the merge logic is correct. That is not the same as
 * proving the app uses it. The two ways this feature can silently stop working
 * while every unit test stays green:
 *
 *   1. `BrandingProvider` stops fetching the active pack (an overlay nobody
 *      applies), or stops passing the merged value into the context — the admin
 *      panel then activates packs that change nothing on screen;
 *   2. the Admin → "Branding packs" section disappears from the sections list or
 *      from the render switch — the backend is fine and the operator has no door.
 *
 * These read the sources and assert the wiring, which is deliberately brittle: a
 * refactor that moves the fetch should have to update this file and think about
 * it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

const PROVIDER = 'app/branding/BrandingProvider.tsx';
const ADMIN_TAB = 'app/crossmodel/account/AdminTab.tsx';
const SECTION = 'app/crossmodel/account/BrandingPacksSection.tsx';

describe('BrandingProvider applies the runtime pack', () => {
  const src = read(PROVIDER);

  it('fetches the public active-pack endpoint', () => {
    expect(src).toContain('/api/crossmodel/branding/pack');
  });

  it('merges through applyPack and publishes the merged value to the context', () => {
    expect(src).toMatch(/import \{[^}]*applyPack/);
    expect(src).toMatch(/applyPack\(value, pack\)/);
    // The context must receive the MERGED value, not the server snapshot.
    expect(src).toMatch(/<BrandingContext\.Provider value=\{branding\}>/);
  });

  it('degrades to the server snapshot instead of throwing (parse + catch)', () => {
    expect(src).toContain('parseActivePack');
    expect(src).toMatch(/\.catch\(/);
  });

  it('is opt-outable so a test can pin the shipped identity', () => {
    expect(src).toContain('runtimePack');
  });
});

describe('Admin → Branding packs exists and is reachable', () => {
  const admin = read(ADMIN_TAB);

  it('is declared in the AdminSection union', () => {
    expect(admin).toMatch(/type AdminSection =[^;]*'branding'/);
  });

  it('appears in the sections list with its own label', () => {
    expect(admin).toContain("id: 'branding'");
    expect(admin).toContain("label: 'Branding packs'");
  });

  it('is rendered by the section switch', () => {
    expect(admin).toMatch(/\{section === 'branding' && <BrandingPacksSection \/>\}/);
    expect(admin).toContain("import { BrandingPacksSection }");
  });

  it('the section covers the whole operator flow', () => {
    const src = read(SECTION);
    // upload → validate → preview → activate → rollback
    expect(src).toContain('brandingPacksApi.create');
    expect(src).toContain('brandingPacksApi.activate');
    expect(src).toContain('brandingPacksApi.rollback');
    // Preview renders BOTH schemes and both motion modes.
    expect(src).toMatch(/preview-light|preview-\$\{scheme\}/);
    expect(src).toContain('reduced motion');
    // Rejections are surfaced per slot, not as one opaque failure.
    expect(src).toContain('rejection-');
  });

  it('uses design tokens, never raw violet/emerald utilities', () => {
    const src = read(SECTION);
    // The repo rule (app/p3-token-guards.test.ts): app/** may not use raw
    // violet-*/emerald-* utilities; brand/success must come from the tokens.
    expect(src).not.toMatch(/\b(?:violet|emerald)-\d+/);
    expect(src).toMatch(/bg-brand|text-brand/);
  });
});