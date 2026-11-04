/**
 * The client half of the LABEL WINDOW (patience plan 1a, 2026-09-26) — what survives roster 2026-10-06 B-3.
 *
 * The composer picker, the page's mode-origin memory (mode-source.ts) and the chat-open level restore are
 * DELETED (Digby picks depth and models per message); the web client can no longer emit 'picked' or
 * 'restored'. What stays pinned here:
 *   1. buildPlainStreamUrl — the GET query, the >1500-char register body and the register-failure fallback
 *      all carry `modeSource` (a guest's forced Ensemble still says 'default'), and omit it when undefined.
 *   2. buildPlainDepthConfig — signed-in sends Auto with NO modeSource (no label-window ask can be armed from
 *      the web), guests the forced Ensemble as 'default', kids nothing.
 *   3. SOURCE pins: the page tracks no mode origin; the view forwards modeSource on both plain send paths as
 *      the EXACT token `modeSource: plainCfg.modeSource,` (a `?? 'picked'` regression would arm the server's
 *      label window on all Auto traffic).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

vi.mock('@/lib/api-client', () => ({ ensureFreshAuthCookie: vi.fn(async () => {}) }));

import { buildPlainStreamUrl, buildPlainDepthConfig } from './plain-session';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts).
 *  `to` is resolved AFTER `from`, so an earlier stray occurrence can't shrink
 *  the region to nothing. */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `region anchor ${JSON.stringify(to)} missing after ${JSON.stringify(from)}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

// ── 1. buildPlainStreamUrl ───────────────────────────────────────────────────

describe('buildPlainStreamUrl — modeSource rides every send shape', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ streamToken: '11111111-1111-4111-8111-111111111111' }) }));
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => { (globalThis as any).fetch = originalFetch; });

  const query = (url: string) => new URL(url).searchParams;

  it('short message: the GET query carries each of the three values and omits it when undefined', async () => {
    for (const modeSource of ['picked', 'default', 'restored'] as const) {
      const url = await buildPlainStreamUrl({ chatId: 'c1', message: 'hi', mode: 'thinking', modeSource, webSearch: true });
      expect(query(url).get('modeSource')).toBe(modeSource);
      expect(query(url).get('mode')).toBe('thinking');
    }
    const none = await buildPlainStreamUrl({ chatId: 'c1', message: 'hi', mode: 'auto', webSearch: true });
    expect(query(none).has('modeSource')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('long message: the register body carries modeSource (and omits it when undefined); the SSE URL stays token-only', async () => {
    const long = 'x'.repeat(1600);
    const url = await buildPlainStreamUrl({ chatId: 'c1', message: long, mode: 'single_thinking', modeSource: 'picked', webSearch: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [regUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(regUrl).toMatch(/\/crossmodel\/stream\/register$/);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ message: long, mode: 'single_thinking', modeSource: 'picked', chatId: 'c1' });
    expect(query(url).get('streamToken')).toBe('11111111-1111-4111-8111-111111111111');
    expect(query(url).has('modeSource')).toBe(false);

    await buildPlainStreamUrl({ chatId: 'c1', message: long, mode: 'auto', webSearch: true });
    const body2 = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect('modeSource' in body2).toBe(false);
  });

  it('long message with a failed register: the truncated fallback GET still carries modeSource', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any);
    const url = await buildPlainStreamUrl({ chatId: 'c1', message: 'y'.repeat(1600), mode: 'thinking', modeSource: 'restored', webSearch: true });
    expect(query(url).get('modeSource')).toBe('restored');
    expect(query(url).get('message')?.length).toBe(1500);
  });
});

// ── 2. buildPlainDepthConfig — no label-window origin is reachable from the web (roster 2026-10-06 B-3) ──

describe('buildPlainDepthConfig — signed-in Auto sends no modeSource; a guest forced Ensemble says default; kids nothing', () => {
  const base = { guest: false, isKid: false, deepResearchQuota: null } as const;

  it('signed-in: every stored pref sends Auto with NO modeSource (the server label window cannot be armed from the web)', () => {
    for (const pref of ['auto', 'single_thinking', 'thinking', 'deep_research'] as const) {
      const cfg = buildPlainDepthConfig({ ...base, pref });
      expect(cfg.mode).toBe('auto');
      expect(cfg.modeSource).toBeUndefined();
    }
  });

  it('a guest sends the FORCED Ensemble as default (not a choice); kids send their stored mode and nothing else', () => {
    expect(buildPlainDepthConfig({ ...base, guest: true, pref: 'auto' })).toMatchObject({ mode: 'thinking', modeSource: 'default' });
    expect(buildPlainDepthConfig({ ...base, guest: true, pref: 'single_thinking' })).toMatchObject({ mode: 'thinking', modeSource: 'default' });
    const kid = buildPlainDepthConfig({ ...base, isKid: true, pref: 'thinking' });
    expect(kid).toMatchObject({ mode: 'thinking', digDeeperEnabled: false });
    expect(kid.modeSource).toBeUndefined();
  });
});

// ── 3. Source pins ───────────────────────────────────────────────────────────

const PAGE = read('./page.tsx');
const VIEW = read('./components/CodeSessionView.tsx');

describe('page.tsx — no mode origin is tracked any more (roster 2026-10-06 B-3; source pins)', () => {
  it('the picker setters, the origin memory and the chat-open level restore are gone', () => {
    for (const gone of ['setPatienceLevel', 'selectAutoMode', 'setModeOrigin', 'modeOriginRef', 'nextOriginAfterRestore', "from './mode-source'", 'LEGACY_PICKER']) {
      expect(PAGE, `${gone} must be gone from page.tsx`).not.toContain(gone);
    }
  });

  it('the plain config is wired to buildPlainDepthConfig with the guest flag + isKid only (the output is tested above)', () => {
    const cfg = region(PAGE, 'plain={(codeChatPlain || chatlessActive) ? {', 'onDepthRunSettled:');
    expect(cfg).toContain('...buildPlainDepthConfig({');
    expect(cfg).toContain('isKid,');
    expect(cfg).not.toContain('modeOrigin');
    expect(cfg).not.toContain('legacyPicker');
    expect(PAGE).not.toContain('modeSourceFor(');
  });
});

describe('CodeSessionView.tsx — forwards modeSource on both plain send paths (source pins)', () => {
  it('PlainSessionProps carries modeSource and both buildPlainStreamUrl calls forward it', () => {
    const props = region(VIEW, 'export interface PlainSessionProps {', 'webSearch: boolean;');
    expect(props).toContain('modeSource?: PlainModeSource;');
    const calls = VIEW.split('buildPlainStreamUrl({').slice(1);
    expect(calls.length).toBe(2); // the busy-queue passthrough + the live send
    // EXACT tokens (trailing comma): `modeSource: plainCfg.modeSource ?? 'picked'`
    // would stamp every Auto / kid send 'picked' and fire the server label
    // window on all Auto traffic — the looser substring pin let it pass.
    for (const c of calls) expect(c.slice(0, 400)).toContain('mode: plainCfg.mode, modeSource: plainCfg.modeSource, webSearch: plainCfg.webSearch,');
  });
});

describe('audit 2026-09-26 (guest-persistence-1): the guest session rides the token URL too', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { (globalThis as any).fetch = originalFetch; });
  const query = (url: string) => new URL(url).searchParams;
  it('a >1500-char GUEST send: the register body AND the SSE token URL carry sessionId; a signed-in send keeps the URL token-only', async () => {
    const SID = '22222222-2222-4222-8222-222222222222';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ streamToken: '11111111-1111-4111-8111-111111111111' }) }));
    (globalThis as any).fetch = fetchMock;
    const url = await buildPlainStreamUrl({ chatId: null, message: 'x'.repeat(1600), mode: 'thinking', modeSource: 'default', webSearch: true, sessionId: SID });
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body.sessionId).toBe(SID);
    expect(query(url).get('sessionId')).toBe(SID);
    expect(query(url).get('streamToken')).toBe('11111111-1111-4111-8111-111111111111');
    const authed = await buildPlainStreamUrl({ chatId: 'c1', message: 'x'.repeat(1600), mode: 'auto', webSearch: true });
    expect(query(authed).get('sessionId')).toBeNull();
  });
});