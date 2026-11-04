import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { cleanPathFor, proxy } from './proxy';

/** Clean-URL proxy pins (owner 2026-10-14: no public /crossmodel URLs). */

const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(new URL(path, 'https://digby.example.com'), { headers, method });

describe('cleanPathFor', () => {
  it('maps legacy paths to their clean twins', () => {
    expect(cleanPathFor('/crossmodel')).toBe('/');
    expect(cleanPathFor('/crossmodel/')).toBe('/');
    expect(cleanPathFor('/crossmodel/privacy')).toBe('/privacy');
    expect(cleanPathFor('/crossmodel/terms')).toBe('/terms');
    expect(cleanPathFor('/crossmodel/account')).toBe('/account');
    expect(cleanPathFor('/crossmodel/projects/abc')).toBe('/projects/abc');
    expect(cleanPathFor('/crossmodel/shared/chat/tok')).toBe('/shared/chat/tok');
  });
  it('leaves unknown sub-paths alone', () => {
    expect(cleanPathFor('/crossmodel/nope')).toBeNull();
    expect(cleanPathFor('/crossmodelx')).toBeNull();
  });
});

describe('proxy', () => {
  it('308s a document load of a legacy URL, keeping the query', () => {
    const res = proxy(req('/crossmodel?chatId=abc'));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://digby.example.com/?chatId=abc');
    const r2 = proxy(req('/crossmodel/account?tab=integrations&google=connected'));
    expect(r2.headers.get('location')).toBe('https://digby.example.com/account?tab=integrations&google=connected');
  });

  it('client navigations to a legacy URL get the same 308 (the app router follows it)', () => {
    expect(proxy(req('/crossmodel', { rsc: '1' })).status).toBe(308);
    expect(proxy(req('/crossmodel/privacy', { rsc: '1' })).status).toBe(308);
  });

  it('does not redirect non-GET requests', () => {
    expect(proxy(req('/crossmodel', {}, 'POST')).status).not.toBe(308);
  });

  it('rewrites the root and app screens to their internal routes', () => {
    expect(proxy(req('/')).headers.get('x-middleware-rewrite')).toBe('https://digby.example.com/crossmodel');
    expect(proxy(req('/account?tab=x')).headers.get('x-middleware-rewrite')).toBe('https://digby.example.com/crossmodel/account?tab=x');
    expect(proxy(req('/shared/chat/t')).headers.get('x-middleware-rewrite')).toBe('https://digby.example.com/crossmodel/shared/chat/t');
  });

  it('passes public site pages straight through (no prefix collisions)', () => {
    for (const p of ['/about', '/private-ai', '/profile-x', '/projectsfoo', '/privacy', '/learn/what-is-sovereign-ai', '/help', '/login']) {
      expect(proxy(req(p)).headers.get('x-middleware-rewrite'), p).toBeNull();
      expect(proxy(req(p)).status, p).not.toBe(308);
    }
  });
});
