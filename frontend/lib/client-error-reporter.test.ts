import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scrubClientErrorText,
  scrubUnquotedText,
  isDiagnosticMessage,
  bounded,
  boundedStack,
  sanitizeUrl,
  clientErrorBody,
  clientErrorSignature,
  describeThrown,
  reportClientError,
  installClientErrorReporter,
  makeErrorListener,
  makeRejectionListener,
  clientErrorReportDisabled,
  clientBuildSha,
  __resetClientErrorReporter,
  __clientErrorSignatureCount,
  CLIENT_ERROR_ENDPOINT,
  SIGNATURE_WINDOW_MS,
  MAX_REPORTS_PER_MINUTE,
  MAX_REPORTS_PER_PAGE,
  MAX_SIGNATURES,
  MAX_MESSAGE,
  MAX_STACK,
  TEXT_MASK,
  SECRET_MASK,
  QUOTED_TEXT_MIN,
  type ClientErrorTransport,
} from './client-error-reporter';

/** A transport that records the exact JSON that would have left the tab. */
function recorder(): ClientErrorTransport & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    // sendBeacon takes a Blob (the real one does, to set a JSON content-type);
    // a Blob's text is only readable asynchronously, so the recorder routes
    // through the fetch seam where the body is the JSON string itself.
    sendBeacon: () => false,
    fetch: (_url: string, init: RequestInit) => { sent.push(String(init.body)); return Promise.resolve({}); },
  };
}

const T0 = 1_700_000_000_000;

/**
 * A DISTINCT message per index. Deliberately alphabetic: clientErrorSignature
 * strips digits (bound to the same class, that is the point — "row 1 failed"
 * and "row 2 failed" ARE one bug), so a numeric label would collapse every
 * case into one signature and the budget assertions below would be measuring
 * the dedupe instead of the budget.
 */
const distinctLabel = (i: number): string => {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0);
  return s;
};

beforeEach(() => __resetClientErrorReporter());

describe('client-error-reporter — user text never leaves the tab', () => {
  it('masks a long quoted run (the user-typed sentence inside a thrown message)', () => {
    const typed = 'remind me about my daughter appointment with Dr Chen on Tuesday';
    const out = scrubClientErrorText(`Error: failed rendering "${typed}"`);
    expect(out).not.toContain('Dr Chen');
    expect(out).not.toContain(typed);
    expect(out).toContain(TEXT_MASK);
    expect(out).toContain('failed rendering');
  });

  it('leaves short quoted fragments (React keys, frame names) alone', () => {
    const short = 'a'.repeat(QUOTED_TEXT_MIN - 10);
    expect(scrubClientErrorText(`Error: bad prop "${short}"`)).toContain(short);
    expect(scrubClientErrorText(`Error: bad prop "${'b'.repeat(QUOTED_TEXT_MIN + 1)}"`)).toContain(TEXT_MASK);
  });

  it('the POSTED body carries no user text at all', () => {
    const typed = 'my private medical notes that I pasted into the composer';
    const body = clientErrorBody({
      message: `TypeError: cannot render "${typed}"`,
      source: 'onerror',
      url: 'https://digby.ai/chat',
    });
    expect(body).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain('private medical notes');
    expect(JSON.stringify(body)).toContain(TEXT_MASK);
  });

  /** BLOCKER 1 (adversarial review, 2026-11-06) — the unquoted shape a real throw produces. */
  it('BLOCKER1 — an UNQUOTED user sentence never leaves the tab', () => {
    const typed = 'my daughter has a dentist appointment on Thursday at 3pm';
    const body = clientErrorBody({ message: `Error: ${typed}`, source: 'onerror' });
    expect(body).not.toBeNull();
    expect(body!.message).not.toContain('dentist');
    expect(body!.message).not.toContain(typed);
    expect(body!.message).toContain(TEXT_MASK);
  });

  it('BLOCKER1 — a rejected plain string is masked too (the non-Error path)', () => {
    const typed = 'remember my passport renewal appointment at the office downtown';
    expect(scrubUnquotedText(typed)).not.toContain('passport renewal');
    const body = clientErrorBody({ message: typed, source: 'unhandledrejection' });
    expect(JSON.stringify(body)).not.toContain('passport renewal');
  });

  it('BLOCKER1 guard — framework diagnostics keep their text (it IS the diagnosis)', () => {
    for (const message of [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      'Error: Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate.',
      'TypeError: x is not a function',
    ]) {
      expect(isDiagnosticMessage(message)).toBe(true);
      const body = clientErrorBody({ message, source: 'onerror' });
      expect(JSON.stringify(body)).not.toContain(TEXT_MASK);
    }
    expect(isDiagnosticMessage('Error: my daughter has a dentist appointment')).toBe(false);
  });

  it('BLOCKER1 guard — a SHORT multi-word fragment is not mistaken for a sentence', () => {
    expect(scrubUnquotedText('Error: socket read timeout')).toBe('Error: socket read timeout');
  });

  /** MAJOR 2 (adversarial review, 2026-11-06) — the tab must not collapse the stack. */
  it('MAJOR2 — the stack keeps its newlines so the frame list survives', () => {
    const body = clientErrorBody({
      message: 'TypeError: boom',
      stack: 'TypeError: boom\n    at ChatRow (https://digby.ai/a.js:1:2)\n    at renderWithHooks (https://digby.ai/b.js:3:4)',
      source: 'onerror',
    });
    expect(body!.stack).toContain('\n');
    expect(body!.stack!.split('\n').filter((l) => /^\s*at\s/.test(l))).toHaveLength(2);
    // …and the signature therefore carries a real frame.
    expect(clientErrorSignature(body!.message, body!.stack)).toContain('at ChatRow');
  });

  it('MAJOR2 — boundedStack collapses horizontal whitespace but not newlines', () => {
    const out = boundedStack('Error: x\n\n\n    at   Foo    (a.js:1:2)\n\n', 4000);
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).not.toMatch(/[ \t]{2,}/);
    expect(out).toContain('at Foo (a.js:1:2)');
  });

  it('caps every field (a hostile/looping page cannot post a megabyte)', () => {
    const body = clientErrorBody({
      message: 'x'.repeat(MAX_MESSAGE * 5),
      stack: 'at y\n'.repeat(MAX_STACK),
      source: 'onerror',
      route: '/' + 'z'.repeat(5000),
      userAgent: 'u'.repeat(5000),
    });
    expect(body).not.toBeNull();
    expect(body!.message.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect((body!.stack ?? '').length).toBeLessThanOrEqual(MAX_STACK);
    expect((body!.route ?? '').length).toBeLessThanOrEqual(200);
    expect((body!.userAgent ?? '').length).toBeLessThanOrEqual(300);
  });
});

describe('client-error-reporter — credential shapes', () => {
  // Assembled, never literal: this repo mirrors to a public tree whose gitleaks
  // scans every ref, so a token-shaped literal in a test file is the exact leak
  // class this scrubber exists to stop — and allowlisting the file would blind
  // the scanner to a real key pasted here later. The scrubber still receives the
  // identical final string.
  const cred = (...parts: string[]): string => parts.join('');
  const gitUserinfo = cred('ghs_', 'abc123def456');
  const gitToken = cred('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789');
  const providerKey = cred('sk-proj-', 'abcdefghijklmnop0123');
  const slackToken = cred('xoxb-', '1234567890-abcdefghijkl');
  const awsKeyId = cred('AKIA', 'IOSFODNN7EXAMPL2');
  const googleKey = cred('AIza', 'SyA1234567890abcdefghijklmnopqrstuv');
  const cfToken = cred('cf_', 'abcdefghijklmnopqrstuvwxyz0123');
  const jwtTriple = cred('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');

  const cases: Array<[string, string]> = [
    ['URL userinfo', `https://x-access-token:${gitUserinfo}@github.com/o/r.git`],
    ['bare git userinfo', 'unable to access oauth2:secrettoken@github.com'],
    ['github token', gitToken],
    ['bearer', 'Bearer eyJhbGciOiJIUzI1NiJ9.payloadpart.sigpart'],
    ['provider prefix', providerKey],
    ['slack', slackToken],
    ['aws', awsKeyId],
    ['google', googleKey],
    ['cloudflare', cfToken],
    ['jwt', jwtTriple],
    ['labelled', 'token=supersecretvalue123'],
  ];
  for (const [name, text] of cases) {
    it(`masks ${name}`, () => {
      const out = scrubClientErrorText(text);
      expect(out).toContain(SECRET_MASK);
      // The masked output must not still contain the credential body.
      expect(out.replace(/\*/g, '')).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
      expect(out).not.toContain('supersecretvalue123');
    });
  }

  it('is idempotent', () => {
    const once = scrubClientErrorText(`Bearer abcdefghijklmn and ${gitToken}`);
    expect(scrubClientErrorText(once)).toBe(once);
  });

  it('the URL sent carries no query string or fragment (where a ?token= lives)', () => {
    expect(sanitizeUrl('https://digby.ai/chat/abc?token=secret123&q=private#frag')).toBe('https://digby.ai/chat/abc');
    const queryToken = cred('sk-proj-', 'abcdefghijklmnop0123456789');
    const body = clientErrorBody({
      message: 'Error: boom',
      source: 'onerror',
      url: `https://digby.ai/chat?token=${queryToken}`,
    });
    expect(JSON.stringify(body)).not.toContain('secret123');
    expect(JSON.stringify(body)).not.toContain(queryToken);
  });

  it('tolerates a relative / junk URL', () => {
    expect(sanitizeUrl('/chat?x=1')).toBe('/chat');
    expect(sanitizeUrl('')).toBeUndefined();
    expect(sanitizeUrl(undefined)).toBeUndefined();
  });

  it('never throws on hostile input', () => {
    expect(() => scrubClientErrorText(undefined)).not.toThrow();
    expect(scrubClientErrorText(undefined)).toBe('');
    expect(() => bounded(null, 10)).not.toThrow();
    expect(() => clientErrorBody({ message: '', source: 'onerror' })).not.toThrow();
    expect(clientErrorBody({ message: '', source: 'onerror' })).toBeNull();
    expect(() => describeThrown(undefined)).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeThrown(circular)).not.toThrow();
  });
});

describe('client-error-reporter — one request per signature (render loop)', () => {
  it('THE ACCEPTANCE: 100 identical throws produce ONE request', () => {
    const t = recorder();
    for (let i = 0; i < 100; i++) {
      reportClientError({ message: 'Error: Maximum update depth exceeded', stack: 'Error\n    at ChatRow (https://digby.ai/app.js:1:100)', source: 'onerror' }, t, T0 + i);
    }
    expect(t.sent).toHaveLength(1);
    expect(__clientErrorSignatureCount()).toBe(1);
  });

  it('reports the same class again only after its window lapses', () => {
    const t = recorder();
    const err = { message: 'Error: boom', stack: 'Error\n    at x (https://digby.ai/a.js:1:1)', source: 'onerror' as const };
    expect(reportClientError(err, t, T0)).toBe('sent');
    expect(reportClientError(err, t, T0 + 1000)).toBe('duplicate');
    expect(reportClientError(err, t, T0 + SIGNATURE_WINDOW_MS + 1)).toBe('sent');
    expect(t.sent).toHaveLength(2);
  });

  it('groups an id/number-varying instance into one signature; separates real classes', () => {
    const a = clientErrorSignature("TypeError: Cannot read properties of undefined (reading 'id')", 'Error\n    at ChatRow (https://digby.ai/app.js:1:22345)');
    const b = clientErrorSignature("TypeError: Cannot read properties of undefined (reading 'id')", 'Error\n    at ChatRow (https://digby.ai/app.js:1:98765)');
    const c = clientErrorSignature('ReferenceError: y is not defined', 'Error\n    at ChatRow (https://digby.ai/app.js:1:22345)');
    expect(a).toBe(b);
    expect(a).not.toBe(c);

    const t = recorder();
    reportClientError({ message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: 'Error\n    at ChatRow (https://digby.ai/app.js:1:22345)', source: 'onerror' }, t, T0);
    reportClientError({ message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: 'Error\n    at ChatRow (https://digby.ai/app.js:1:98765)', source: 'onerror' }, t, T0 + 10);
    expect(t.sent).toHaveLength(1);
  });

  it('a page that throws 100 DISTINCT errors is bounded by the per-minute budget', () => {
    const t = recorder();
    for (let i = 0; i < 100; i++) {
      reportClientError({ message: `Error: distinct failure ${distinctLabel(i)}`, source: 'onerror' }, t, T0 + i);
    }
    expect(t.sent.length).toBeLessThanOrEqual(MAX_REPORTS_PER_MINUTE);
    expect(t.sent.length).toBe(MAX_REPORTS_PER_MINUTE);
  });

  it('the per-page cap is the backstop for a long-lived tab', () => {
    const t = recorder();
    // One report per minute-window reset, spaced past each window.
    for (let i = 0; i < MAX_REPORTS_PER_PAGE + 20; i++) {
      reportClientError({ message: `Error: long lived ${distinctLabel(i)}`, source: 'onerror' }, t, T0 + i * 61_000);
    }
    expect(t.sent).toHaveLength(MAX_REPORTS_PER_PAGE);
    expect(reportClientError({ message: 'Error: one more', source: 'onerror' }, t, T0 + 10_000_000)).toBe('rate-limited');
  });

  it('keeps its signature map bounded', () => {
    const t = recorder();
    for (let i = 0; i < MAX_SIGNATURES + 100; i++) {
      reportClientError({ message: `Error: rotating ${distinctLabel(i)}`, source: 'onerror' }, t, T0 + i * 61_000);
    }
    expect(__clientErrorSignatureCount()).toBeLessThanOrEqual(MAX_SIGNATURES);
  });
});

describe('client-error-reporter — never breaks the page it reports on', () => {
  it('a throwing transport does not throw and does not retry the same signature', () => {
    const t: ClientErrorTransport = { sendBeacon: () => { throw new Error('beacon exploded'); }, fetch: () => { throw new Error('fetch exploded'); } };
    expect(() => reportClientError({ message: 'Error: boom', source: 'onerror' }, t, T0)).not.toThrow();
    // The attempt was recorded BEFORE sending — a crash loop cannot re-enter.
    expect(reportClientError({ message: 'Error: boom', source: 'onerror' }, t, T0 + 10)).toBe('duplicate');
  });

  it('a rejected fetch promise is swallowed (no unhandled rejection of its own)', async () => {
    const t: ClientErrorTransport = { fetch: () => Promise.reject(new Error('network down')) };
    expect(() => reportClientError({ message: 'Error: boom', source: 'onerror' }, t, T0)).not.toThrow();
    // Give the microtask queue a turn: nothing may reject out of the reporter.
    await Promise.resolve();
  });

  it('falls back to fetch when sendBeacon refuses (returns false)', () => {
    const calls: string[] = [];
    const t: ClientErrorTransport = {
      sendBeacon: () => false,
      fetch: (url: string) => { calls.push(url); return Promise.resolve({}); },
    };
    expect(reportClientError({ message: 'Error: boom', source: 'onerror' }, t, T0)).toBe('sent');
    expect(calls).toEqual([CLIENT_ERROR_ENDPOINT]);
  });

  it('an empty message is dropped, never posted', () => {
    const t = recorder();
    expect(reportClientError({ message: '', source: 'onerror' }, t, T0)).toBe('empty');
    expect(t.sent).toHaveLength(0);
  });
});

describe('client-error-reporter — listeners', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('the error listener reports an ErrorEvent shape', () => {
    const t = recorder();
    makeErrorListener(t)({
      error: new Error('render failed'),
      filename: 'https://digby.ai/app.js',
      lineno: 42,
      colno: 7,
    });
    expect(t.sent).toHaveLength(1);
    const body = JSON.parse(t.sent[0]);
    expect(body.source).toBe('onerror');
    expect(body.message).toContain('render failed');
    expect(body.line).toBe(42);
    expect(body.column).toBe(7);
  });

  it('the error listener survives an event with no error object (a cross-origin / resource error)', () => {
    const t = recorder();
    expect(() => makeErrorListener(t)({ message: 'Script error.' })).not.toThrow();
    expect(t.sent).toHaveLength(1);
    expect(JSON.parse(t.sent[0]).message).toContain('Script error');
  });

  it('the rejection listener reports the reason, string or Error', () => {
    const t = recorder();
    makeRejectionListener(t)({ reason: new Error('promise blew up') });
    makeRejectionListener(t)({ reason: 'a plain string reason' });
    expect(t.sent).toHaveLength(2);
    expect(JSON.parse(t.sent[0]).source).toBe('unhandledrejection');
    expect(JSON.parse(t.sent[1]).message).toContain('a plain string reason');
  });

  it('the rejection listener never rethrows on a hostile reason', () => {
    const t = recorder();
    expect(() => makeRejectionListener(t)({ reason: undefined })).not.toThrow();
    expect(() => makeRejectionListener(t)({})).not.toThrow();
  });

  it('install() adds both listeners and returns a teardown that removes exactly them', () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const fakeWin = {
      addEventListener: (type: string, fn: unknown) => added.push([type, fn]),
      removeEventListener: (type: string, fn: unknown) => removed.push([type, fn]),
      location: { href: 'https://digby.ai/chat', pathname: '/chat' },
      navigator: { userAgent: 'UA' },
    };
    const teardown = installClientErrorReporter(fakeWin, recorder());
    expect(added.map(([t]) => t)).toEqual(['error', 'unhandledrejection']);
    teardown();
    expect(removed.map(([t]) => t)).toEqual(['error', 'unhandledrejection']);
    // The SAME function references are removed (a fresh closure would leak a listener).
    expect(removed[0][1]).toBe(added[0][1]);
    expect(removed[1][1]).toBe(added[1][1]);
  });

  it('install() is a no-op (never throws) without a window', () => {
    const teardown = installClientErrorReporter(undefined, recorder());
    expect(() => teardown()).not.toThrow();
    expect(() => installClientErrorReporter({} as never, recorder())()).not.toThrow();
  });
});

describe('client-error-reporter — switches and build stamp', () => {
  it('NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED=1 sends nothing', () => {
    const t = recorder();
    expect(clientErrorReportDisabled({ NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED: '1' })).toBe(true);
    expect(reportClientError({ message: 'Error: boom', source: 'onerror' }, t, T0, { NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED: '1' })).toBe('disabled');
    expect(t.sent).toHaveLength(0);
    expect(clientErrorReportDisabled({})).toBe(false);
  });

  it('the build sha is sent only when it is sha-shaped', () => {
    expect(clientBuildSha({ NEXT_PUBLIC_DEPLOY_SHA: 'd9ae52784f' })).toBe('d9ae52784f');
    expect(clientBuildSha({ NEXT_PUBLIC_DEPLOY_SHA: 'has spaces' })).toBeUndefined();
    expect(clientBuildSha({})).toBeUndefined();
    const t = recorder();
    reportClientError({ message: 'Error: boom', source: 'onerror', buildSha: 'd9ae52784f' }, t, T0);
    expect(JSON.parse(t.sent[0]).buildSha).toBe('d9ae52784f');
  });
});