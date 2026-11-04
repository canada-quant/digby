/**
 * Admin → Setup (self-host setup hardening, 2026-10-20) — source-level pins in
 * the repo's idiom for effectful sections (the section fetches in an effect;
 * a full SSR render only shows the spinner). What must hold: the section reads
 * GET /instance/setup, groups by the shared vocabulary, hides ready rows by
 * default, shows an admin the missing env NAMES + the how-to + the callback,
 * and reaches the Admin tab as its own "Setup" entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SECTION = readSrc('./SetupSection.tsx');
const ADMIN = readSrc('./AdminTab.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

describe('SetupSection', () => {
  it('is reachable from the Admin tab as "Setup"', () => {
    expect(ADMIN).toContain("import { SetupSection } from './SetupSection';");
    expect(ADMIN).toContain("{ id: 'setup', label: 'Setup', icon: Wrench }");
    expect(ADMIN).toContain("{section === 'setup' && <SetupSection />}");
  });
  it('reads the one setup endpoint and the shared helpers', () => {
    expect(API).toContain("apiClient.get('/crossmodel/instance/setup')");
    expect(SECTION).toContain('await instanceSetupApi.get()');
    expect(SECTION).toContain('groupFeatures(visible)');
    expect(SECTION).toContain('setupHeadline({');
  });
  it('hides ready rows by default and lets the admin show them', () => {
    expect(SECTION).toContain('const [showReady, setShowReady] = useState(false);');
    expect(SECTION).toContain("allFeatures.filter((f) => f.state !== 'ready')");
    expect(SECTION).toContain('data-testid="setup-all-ready"');
  });
  it('shows an admin the missing env names, the hint, the note and the OAuth callback — never a value', () => {
    for (const id of ['setup-row-', 'setup-state-', 'setup-missing-', 'setup-hint-']) expect(SECTION).toContain(`data-testid={\`${id}`);
    expect(SECTION).toContain('f.redirectUri');
    expect(SECTION).toContain('f.note');
    expect(SECTION).toContain('href={f.help}');
    // Admin-only detail: a plain user sees the state + summary only.
    expect(SECTION).toContain('const hasDetail = admin && (');
  });
  it('adds the build-time browser-tag row on a self-host from the NEXT_PUBLIC switches', () => {
    expect(SECTION).toContain('browserTagsFeature(setup.instance.selfHosted)');
    expect(SECTION).toContain('NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED');
    expect(SECTION).toContain('NEXT_PUBLIC_META_PIXEL_DISABLED');
  });
});
