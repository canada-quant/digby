/** looksLikeCaptcha — deterministic CAPTCHA / human-verification detector added
 *  for ticket 58cad87c (local-driver run hit a CAPTCHA on swapcard, retried, and
 *  degenerated into a thousands-token mixed-language monologue instead of
 *  stopping cleanly). */

// glm-loop transitively imports logger → env.ts (process.exit on missing env in
// a bare test env) and driver/router modules; mock the leaves so importing the
// pure looksLikeCaptcha helper never triggers env validation.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  stripThink: (s: string) => s,
}));
jest.mock('./router', () => ({ __esModule: true, selectBrowserDriver: jest.fn() }));

import { looksLikeCaptcha } from './glm-loop';

describe('looksLikeCaptcha (58cad87c)', () => {
  it('detects a Cloudflare-style challenge interstitial (text format)', () => {
    const page =
      'Verify you are human by completing the action below.\n' +
      'Checking if the site connection is secure.\n' +
      'swapcard.com needs to review the security of your connection before proceeding.';
    expect(looksLikeCaptcha(page)).toBe(true);
  });

  it('detects reCAPTCHA widget markup (html format)', () => {
    const html = '<div class="g-recaptcha" data-sitekey="6LcXXXX"></div><script src="https://www.google.com/recaptcha/api.js"></script>';
    expect(looksLikeCaptcha(html)).toBe(true);
  });

  it('does NOT flag an invisible reCAPTCHA v3 loader on an ordinary page (review F1)', () => {
    // v3 loads api.js site-wide (WordPress/CF7, many login pages) with no
    // blocking challenge — the page itself is fully readable.
    const html =
      '<script src="https://www.google.com/recaptcha/api.js?render=6LcXXXX"></script>' +
      '<h1>Welcome</h1><p>Our normal, fully readable landing page content.</p>';
    expect(looksLikeCaptcha(html)).toBe(false);
  });

  it('detects hCaptcha / Turnstile / Arkose markers', () => {
    expect(looksLikeCaptcha('<div class="h-captcha" data-sitekey="x"></div>')).toBe(true);
    expect(looksLikeCaptcha('<div class="cf-turnstile" data-sitekey="x"></div>')).toBe(true);
    expect(looksLikeCaptcha('https://client-api.arkoselabs.com/fc/gc/')).toBe(true);
  });

  it('detects imperative solve phrasing', () => {
    expect(looksLikeCaptcha('Please complete the captcha to continue.')).toBe(true);
    expect(looksLikeCaptcha('Are you a robot? Tick the box to proceed.')).toBe(true);
    expect(looksLikeCaptcha("I'm not a robot")).toBe(true);
  });

  it('does NOT flag an ordinary page', () => {
    const page =
      'People directory — Alice Martin · Acme Corp; Bob Zhou · Globex. ' +
      'Sign in to message attendees, book meetings, and view the agenda.';
    expect(looksLikeCaptcha(page)).toBe(false);
  });

  it('does NOT flag the bare word "captcha" in editorial content', () => {
    const article =
      'Modern CAPTCHAs are a kind of challenge-response test used in computing ' +
      'to determine whether the user is human. This article explains how a ' +
      'captcha works and why sites deploy them.';
    expect(looksLikeCaptcha(article)).toBe(false);
  });

  it('handles empty / null-ish input', () => {
    expect(looksLikeCaptcha('')).toBe(false);
    expect(looksLikeCaptcha(undefined as any)).toBe(false);
  });
});
