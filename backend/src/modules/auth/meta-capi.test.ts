// jest globals (backend test runner)
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  META_PIXEL_ID, buildCompleteRegistrationEvent, eventSourceUrlFrom, metaCapiEnabled, resolveMetaEventId,
  sendMetaCompleteRegistration, sha256Normalized,
} from './meta-capi';

const input = {
  email: ' Person@Example.com ', userId: 'u1', eventId: 'abcd1234-ef', eventSourceUrl: 'https://digby.ai/login?signup=true',
  clientUserAgent: 'UA/1', clientIpAddress: '1.2.3.4', fbp: 'fb.1.1.2', nowMs: 1_791_400_000_000,
};

describe('meta-capi (Conversions API CompleteRegistration)', () => {
  it('inert without a token, and under META_CAPI_DISABLED=1', () => {
    expect(metaCapiEnabled({} as any)).toBe(false);
    expect(metaCapiEnabled({ META_CAPI_ACCESS_TOKEN: 't' } as any)).toBe(true);
    expect(metaCapiEnabled({ META_CAPI_ACCESS_TOKEN: 't', META_CAPI_DISABLED: '1' } as any)).toBe(false);
  });

  it('builds the Events Manager fields: time, name, source url, action source, hashed email, raw UA', () => {
    const e = buildCompleteRegistrationEvent(input) as any;
    expect(e.event_name).toBe('CompleteRegistration');
    expect(e.event_time).toBe(1_791_400_000);
    expect(e.event_id).toBe('abcd1234-ef');
    expect(e.action_source).toBe('website');
    expect(e.event_source_url).toBe('https://digby.ai/login?signup=true');
    expect(e.user_data.em).toEqual([sha256Normalized('person@example.com')]);
    expect(e.user_data.em[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(e.user_data.client_user_agent).toBe('UA/1');
    expect(e.user_data.client_ip_address).toBe('1.2.3.4');
    expect(e.user_data.fbp).toBe('fb.1.1.2');
    expect(e.user_data.fbc).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('Example.com');
  });

  it('keeps a well-formed browser event id (dedup) and mints one otherwise', () => {
    expect(resolveMetaEventId('3f6c1a2b-1111-4222-8333-444455556666')).toBe('3f6c1a2b-1111-4222-8333-444455556666');
    expect(resolveMetaEventId('<script>')).toMatch(/^reg_/);
    expect(resolveMetaEventId(undefined)).toMatch(/^reg_/);
  });

  it('event_source_url is a digby page or the sign-up page', () => {
    expect(eventSourceUrlFrom('https://digby.ai/login?signup=true')).toBe('https://digby.ai/login?signup=true');
    expect(eventSourceUrlFrom('https://evil.example/digby.ai')).toBe('https://digby.ai/login?signup=true');
    expect(eventSourceUrlFrom(undefined)).toBe('https://digby.ai/login?signup=true');
  });

  it('posts to the pixel events edge with the token in the BODY, never the URL; never throws', async () => {
    const calls: any[] = [];
    const ok = await sendMetaCompleteRegistration(input, {
      env: { META_CAPI_ACCESS_TOKEN: 'tok123' } as any,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{}' }; },
    });
    expect(ok).toBe(true);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v24.0/${META_PIXEL_ID}/events`);
    expect(calls[0].url).not.toContain('tok123');
    const body = JSON.parse(calls[0].init.body);
    expect(body.access_token).toBe('tok123');
    expect(body.data).toHaveLength(1);
    const bad = await sendMetaCompleteRegistration(input, {
      env: { META_CAPI_ACCESS_TOKEN: 'tok123' } as any,
      fetchImpl: async () => { throw new Error('network down'); },
    });
    expect(bad).toBe(false);
    const fetchSpy = jest.fn();
    expect(await sendMetaCompleteRegistration(input, { env: {} as any, fetchImpl: fetchSpy as any })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the register controller sends it fire-and-forget with the browser\'s metaEventId', () => {
    const ctl = readFileSync(join(__dirname, 'auth.controller.ts'), 'utf8');
    expect(ctl).toContain('void sendMetaCompleteRegistration({');
    expect(ctl).toContain('resolveMetaEventId(req.body?.metaEventId)');
    expect(ctl.indexOf('void sendMetaCompleteRegistration')).toBeGreaterThan(ctl.indexOf('res.status(201).json'));
  });
});

describe('chooseFbc (Meta ClickID)', () => {
  const { chooseFbc } = require('./meta-capi');
  const now = 1_791_400_000_000;
  it('prefers a valid _fbc cookie, then the browser copy', () => {
    expect(chooseFbc({ cookie: 'fb.1.1791300000000.IwAR0abcDEF_123-xyz', body: 'fb.1.1791300000001.other1234', nowMs: now })).toBe('fb.1.1791300000000.IwAR0abcDEF_123-xyz');
    expect(chooseFbc({ cookie: 'garbage', body: 'fb.1.1791300000001.other1234', nowMs: now })).toBe('fb.1.1791300000001.other1234');
  });
  it('builds fb.1.<touch ms>.<fbclid> from our own capture when Meta\'s script never wrote the cookie — last touch first', () => {
    expect(chooseFbc({ touches: [{ fbclid: 'IwAR0lastTouch99', ts: 1791390000000 }, { fbclid: 'IwAR0firstTouch1', ts: 1791000000000 }], nowMs: now })).toBe('fb.1.1791390000000.IwAR0lastTouch99');
    expect(chooseFbc({ touches: [null, { fbclid: 'IwAR0firstTouch1' }], nowMs: now })).toBe(`fb.1.${now}.IwAR0firstTouch1`);
    expect(chooseFbc({ touches: [{ utm_source: 'x' } as any], nowMs: now })).toBeUndefined();
    expect(chooseFbc({ touches: [{ fbclid: 'bad id with spaces' }], nowMs: now })).toBeUndefined();
  });
  it('the register controller passes the cookie, the body copy and both touch cookies', () => {
    const ctl = readFileSync(join(__dirname, 'auth.controller.ts'), 'utf8');
    expect(ctl).toContain("fbc: chooseFbc({ cookie: req.cookies?._fbc, body: req.body?.metaFbc, touches: [cookieTouch(req, LAST_TOUCH_COOKIE), cookieTouch(req, FIRST_TOUCH_COOKIE)] }),");
  });
});
