/**
 * Meta Pixel (owner 2026-10-07) — the snippet, the Digby Kids rule, the sign-up event + its dedup id, the kill
 * switch, and where it mounts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { META_PIXEL_ID, disableMetaPixel, metaPixelBootstrap, newMetaEventId, reportMetaSignup } from './meta-pixel';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('meta-pixel', () => {
  afterEach(() => { delete process.env.NEXT_PUBLIC_META_PIXEL_DISABLED; });

  it('the bootstrap is Meta\'s base code for pixel 4660227547545860 (init + PageView)', () => {
    expect(META_PIXEL_ID).toBe('4660227547545860');
    const b = metaPixelBootstrap();
    expect(b).toContain("'https://connect.facebook.net/en_US/fbevents.js'");
    expect(b).toContain("fbq('init', '4660227547545860');");
    expect(b).toContain("fbq('track', 'PageView');");
    expect(b.match(/fbq\('init'/g)).toHaveLength(1);
  });

  it('a sign-up tracks CompleteRegistration with the shared eventID; no-op when the pixel is absent or disabled', () => {
    const calls: unknown[][] = [];
    reportMetaSignup('evt-123456', { fbq: (...a: unknown[]) => calls.push(a) });
    expect(calls).toEqual([['track', 'CompleteRegistration', {}, { eventID: 'evt-123456' }]]);
    expect(() => reportMetaSignup('evt-123456', {})).not.toThrow();
    expect(() => reportMetaSignup('evt-123456', undefined)).not.toThrow();
    process.env.NEXT_PUBLIC_META_PIXEL_DISABLED = '1';
    const none: unknown[][] = [];
    reportMetaSignup('evt-123456', { fbq: (...a: unknown[]) => none.push(a) });
    expect(none).toEqual([]);
  });

  it('event ids are fresh and match the backend\'s accepted shape', () => {
    const a = newMetaEventId();
    expect(a).not.toBe(newMetaEventId());
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('a child session revokes a loaded pixel', () => {
    const calls: unknown[][] = [];
    disableMetaPixel({ fbq: (...a: unknown[]) => calls.push(a) });
    expect(calls).toEqual([['consent', 'revoke']]);
    expect(() => disableMetaPixel({})).not.toThrow();
  });

  it('mounts once site-wide behind the Digby Kids gate; sign-up sends the id to the server AND the pixel', () => {
    expect(src('../app/layout.tsx')).toContain('<MetaPixel />');
    const tag = src('../app/MetaPixel.tsx');
    expect(tag).toContain('googleAdsAllowedForToken(storedToken())');
    expect(tag).toContain('if (metaPixelDisabled() || !allowed) return null;');
    const login = src('../app/login/page.tsx');
    const id = login.indexOf('const metaEventId = newMetaEventId();');
    const reg = login.indexOf('await authApi.register(');
    const px = login.indexOf('reportMetaSignup(metaEventId);');
    expect(id).toBeGreaterThan(-1);
    expect(reg).toBeGreaterThan(id);
    expect(login.slice(reg, px)).toContain('metaEventId,');
    expect(px).toBeGreaterThan(reg);
    const docker = src('../Dockerfile');
    expect(docker).toContain('ARG NEXT_PUBLIC_META_PIXEL_DISABLED=');
    expect(docker).toContain('ENV NEXT_PUBLIC_META_PIXEL_DISABLED=$NEXT_PUBLIC_META_PIXEL_DISABLED');
    expect(src('../app/(site)/privacy/page.tsx')).toContain('Meta Pixel');
  });
});

describe('Meta ClickID (fbc)', () => {
  it('builds fb.1.<ms>.<fbclid> from ?fbclid only', async () => {
    const { fbcFromSearch } = await import('./meta-pixel');
    expect(fbcFromSearch('?fbclid=IwAR0abc_DEF-123&utm_source=fb', 1791400000000)).toBe('fb.1.1791400000000.IwAR0abc_DEF-123');
    expect(fbcFromSearch('?utm_source=fb')).toBeNull();
    expect(fbcFromSearch('?fbclid=<script>')).toBeNull();
  });

  it('writes _fbc on the digby.example.com domain when missing or for a new click, and leaves a matching cookie alone', async () => {
    const { persistFbcFromUrl, currentFbc } = await import('./meta-pixel');
    const writes: string[] = [];
    const doc = { _c: '', get cookie() { return this._c; }, set cookie(v: string) { writes.push(v); this._c = v.split(';')[0]; } };
    const win = { location: { search: '?fbclid=IwAR0abc_DEF-123', hostname: 'digby.example.com', protocol: 'https:' }, document: doc };
    expect(persistFbcFromUrl(win as any, 1791400000000)).toBe('fb.1.1791400000000.IwAR0abc_DEF-123');
    expect(writes[0]).toBe('_fbc=fb.1.1791400000000.IwAR0abc_DEF-123; Max-Age=7776000; Path=/; SameSite=Lax; Domain=.digby.example.com; Secure');
    expect(currentFbc(doc as any)).toBe('fb.1.1791400000000.IwAR0abc_DEF-123');
    persistFbcFromUrl(win as any, 1791500000000);
    expect(writes).toHaveLength(1); // same click → untouched (keeps the original click time)
    expect(persistFbcFromUrl({ ...win, location: { ...win.location, search: '' } } as any)).toBeNull();
  });

  it('the pixel component keeps fbclid for adults; the sign-up sends it', () => {
    expect(src('../app/MetaPixel.tsx')).toContain('else persistFbcFromUrl();');
    expect(src('../app/login/page.tsx')).toContain('metaFbc: currentFbc(),');
  });
});
