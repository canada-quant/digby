/**
 * Client-error sanitizer (ticket d4e643a5) — the ingest-side choke for an
 * UNTRUSTED browser payload.
 *
 * The acceptance this pins (from the ticket):
 *   - "No user message content or token appears in the captured payload
 *     (assert in a test)."
 *   - one row per signature (the signature is derived HERE, from sanitized
 *     text, so a client cannot dodge dedupe by claiming one).
 *
 * Every case asserts on the shape that reaches app_error_logs, not on an
 * intermediate helper, so a regression in the composition still fails.
 */
import {
  sanitizeClientError,
  scrubClientErrorText,
  scrubUnquotedText,
  isDiagnosticMessage,
  sanitizeClientErrorUrl,
  sanitizeClientErrorBuildSha,
  boundedClientErrorText,
  clientErrorSignature,
  firstStackFrame,
  CLIENT_ERROR_MAX_MESSAGE,
  CLIENT_ERROR_MAX_STACK,
  CLIENT_ERROR_MAX_URL,
  CLIENT_ERROR_TEXT_MASK,
  CLIENT_ERROR_SECRET_MASK,
  QUOTED_TEXT_MIN,
} from './client-error-sanitize';

describe('client-error sanitize — user text never survives', () => {
  it('masks a long quoted run inside a thrown message (the user-typed sentence)', () => {
    const typed = 'please summarise my private medical appointment on Tuesday for me';
    const out = sanitizeClientError({ message: `Error: rendering failed for "${typed}"` });
    expect(out.message).not.toContain('medical appointment');
    expect(out.message).not.toContain(typed);
    expect(out.message).toContain(CLIENT_ERROR_TEXT_MASK);
    // The error CLASS is still identifiable — that is the whole point of keeping the row.
    expect(out.message).toContain('rendering failed');
  });

  /**
   * BLOCKER 1 (adversarial review, 2026-11-06). The quoted-run mask above only
   * caught text inside QUOTES, but the shape a real throw produces has none:
   * `throw new Error(typedText)` / `Promise.reject(userInput)` yields
   * `Error: my daughter has a dentist appointment on Thursday at 3pm`, which
   * was persisted verbatim and then quoted into the auto-filed ticket by the
   * sweep. This case FAILS on the pre-fix code (verified: `leaked? true`).
   */
  it('BLOCKER1 — masks an UNQUOTED user sentence (throw new Error(typedText))', () => {
    const typed = 'my daughter has a dentist appointment on Thursday at 3pm';
    const out = sanitizeClientError({ message: `Error: ${typed}`, source: 'onerror' });
    expect(out.message).not.toContain('dentist');
    expect(out.message).not.toContain('Thursday');
    expect(out.message).not.toContain(typed);
    expect(out.message).toContain(CLIENT_ERROR_TEXT_MASK);
  });

  it('BLOCKER1 — a rejected plain string and a rejected object body are masked too', () => {
    const typed = 'remember my passport renewal appointment at the office downtown';
    expect(scrubUnquotedText(`Unhandled rejection: ${typed}`)).not.toContain('passport renewal');
    // A non-Error rejection object is stringified by the reporter into the same shape.
    const out = sanitizeClientError({ message: `Error: ${JSON.stringify({ text: typed })}`, source: 'unhandledrejection' });
    expect(out.message).not.toContain('passport renewal');
  });

  /**
   * The mask must NOT eat the diagnostic messages that are the whole reason the
   * row is worth keeping — those texts ARE the classification, and their
   * fingerprint must stay distinct per component.
   */
  it('BLOCKER1 guard — framework diagnostics keep their text (the message IS the diagnosis)', () => {
    const cases = [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      'Error: Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.',
      'Objects are not valid as a React child (found: object with keys {a, b})',
      'Error: Rendered more hooks than during the previous render.',
      'Warning: Invalid hook call. Hooks can only be called inside of the body of a function component.',
      'TypeError: x is not a function',
    ];
    for (const message of cases) {
      const out = sanitizeClientError({ message, source: 'onerror' });
      expect(out.message).not.toContain(CLIENT_ERROR_TEXT_MASK);
      expect(out.message.length).toBeGreaterThan(10);
    }
  });

  it('BLOCKER1 guard — a SHORT multi-word fragment is not mistaken for a sentence', () => {
    // 4 words / under the char floor: keep it.
    expect(scrubUnquotedText('Error: socket read timeout')).toBe('Error: socket read timeout');
  });

  it('BLOCKER1 — a sentence carrying an id/url is still masked on its prose half', () => {
    const out = sanitizeClientError({ message: 'Error: the invoice for customer 4821 was rejected by the billing provider', source: 'onerror' });
    expect(out.message).not.toContain('rejected by the billing provider');
    expect(out.message).toContain(CLIENT_ERROR_TEXT_MASK);
  });

  it('leaves SHORT quoted fragments alone (a stack frame / React key is diagnostic, not user text)', () => {
    // Below the QUOTED_TEXT_MIN floor: nothing is masked.
    const short = 'a'.repeat(QUOTED_TEXT_MIN - 10);
    expect(scrubClientErrorText(`Error: bad prop "${short}"`)).toContain(short);
    const atFloor = 'b'.repeat(QUOTED_TEXT_MIN + 1);
    expect(scrubClientErrorText(`Error: bad prop "${atFloor}"`)).not.toContain(atFloor);
  });

  /**
   * MAJOR 2 (adversarial review, 2026-11-06): the single-line helper collapsed
   * every newline, so `firstStackFrame` could never find an `at …` line and the
   * signature's frame half was ALWAYS empty — two unrelated faults sharing a
   * message collided into one dedupe key. This case FAILS on the pre-fix code
   * (verified: signature was `typeerror: boom @ `).
   */
  it('MAJOR2 — the stack keeps its newlines and the signature keeps its frame', () => {
    const out = sanitizeClientError({
      message: 'TypeError: boom',
      stack: 'TypeError: boom\n    at ChatRow (https://digby.ai/a.js:1:2)\n    at renderWithHooks (https://digby.ai/b.js:3:4)',
      source: 'onerror',
    });
    expect(out.stack).toContain('\n');
    expect(out.stack!.split('\n').filter((l) => /^\s*at\s/.test(l))).toHaveLength(2);
    expect(out.signature).toContain('at ChatRow');
    // And the frame still distinguishes two faults that share a message.
    const other = sanitizeClientError({
      message: 'TypeError: boom',
      stack: 'TypeError: boom\n    at SettingsPanel (https://digby.ai/c.js:9:9)',
      source: 'onerror',
    });
    expect(out.signature).not.toBe(other.signature);
  });

  it('MAJOR2 — horizontal whitespace is still collapsed and blank-line runs are bounded', () => {
    const out = sanitizeClientError({ message: 'x', stack: 'Error: x\n\n\n\n    at   Foo    (a.js:1:2)\n\n', source: 'onerror' });
    expect(out.stack).not.toMatch(/\n{3,}/);
    expect(out.stack).not.toMatch(/[ \t]{2,}/);
    expect(out.stack).toContain('at Foo (a.js:1:2)');
  });

  it('caps the message and the stack (a render loop must not persist a megabyte)', () => {
    const out = sanitizeClientError({
      message: 'x'.repeat(CLIENT_ERROR_MAX_MESSAGE * 4),
      stack: `Error: boom\n${'    at fn (https://digby.ai/app.js:1:2)\n'.repeat(900)}`,
    });
    expect(out.message.length).toBeLessThanOrEqual(CLIENT_ERROR_MAX_MESSAGE);
    expect((out.stack ?? '').length).toBeLessThanOrEqual(CLIENT_ERROR_MAX_STACK);
  });

  it('collapses whitespace/newlines out of the message so the fingerprint is one line', () => {
    const out = sanitizeClientError({ message: 'TypeError:\n\n  cannot read   id' });
    expect(out.message).toBe('TypeError: cannot read id');
  });
});

describe('client-error sanitize — every credential shape a browser stack can carry is masked', () => {
  /**
   * Credential fixtures are ASSEMBLED here, never written as literals.
   *
   * This repo mirrors to a public tree whose gitleaks scans every ref, so a
   * credential-shaped literal committed in a test file is exactly the leak
   * class this scrubber exists to stop — a scanner cannot tell a placeholder
   * from a live key, and teaching it to ignore these files would blind it to a
   * real key pasted into the same file later. Assembling the value at runtime
   * keeps the scrubber under test (it receives the identical final string)
   * while leaving no token-shaped text in the tree.
   */
  const cred = (...parts: string[]): string => parts.join('');
  const gitToken = cred('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789');
  const gitUserinfo = cred('ghs_', 'secrettokenvalue123');
  const providerKey = cred('sk-proj-', 'abcdefghijklmnop0123');
  const slackToken = cred('xoxb-', '1234567890-abcdefghijkl');
  const awsKeyId = cred('AKIA', 'IOSFODNN7EXAMPL2');
  const googleKey = cred('AIza', 'SyA1234567890abcdefghijklmnopqrstuv');
  const cfToken = cred('cf_', 'abcdefghijklmnopqrstuvwxyz0123');
  const jwtTriple = cred('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');

  const cases: Array<[string, string, string]> = [
    ['URL userinfo', `https://x-access-token:${gitUserinfo}@github.com/o/r.git failed`, gitUserinfo],
    ['bare git token userinfo', 'fatal: unable to access oauth2:verysecrettoken@github.com', 'verysecrettoken'],
    ['github token family', `push failed for ${gitToken}`, gitToken],
    ['bearer header', 'fetch failed: {"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"}', 'eyJhbGciOiJIUzI1NiJ9.payload.sig'],
    ['provider prefix', `provider rejected ${providerKey}`, providerKey],
    ['slack token', `slack post failed ${slackToken}`, slackToken],
    ['aws key id', `s3 denied for ${awsKeyId}`, awsKeyId],
    ['google api key', `maps call failed ${googleKey}`, googleKey],
    ['cloudflare token', `CF request failed ${cfToken}`, cfToken],
    ['jwt triple', `bad token ${jwtTriple}`, 'eyJhbGciOiJIUzI1NiJ9'],
    ['labelled assignment', 'config error token=supersecretvalue123', 'supersecretvalue123'],
    ['labelled password', 'login failed password: hunter2hunter2', 'hunter2hunter2'],
  ];

  for (const [name, text, secret] of cases) {
    it(`masks ${name}`, () => {
      const scrubbed = scrubClientErrorText(text);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain(CLIENT_ERROR_SECRET_MASK);
    });
  }

  it('is idempotent — scrubbing an already-scrubbed string changes nothing', () => {
    const once = scrubClientErrorText(`failed with ${gitToken} and Bearer abcdefghijklmn`);
    expect(scrubClientErrorText(once)).toBe(once);
  });

  it('masks a token that appears inside a stack, not only in the message', () => {
    const stackToken = cred('ghs_', 'aaaaaaaaaaaaaaa');
    const out = sanitizeClientError({
      message: 'Request failed',
      stack: `Error: Request failed\n    at send (https://digby.ai/app.js:1:2)\n    at https://x-access-token:${stackToken}@github.com/o/r.git`,
    });
    expect(out.stack).toBeDefined();
    expect(out.stack).not.toContain(stackToken);
    expect(out.message).not.toContain(stackToken);
  });

  it('never throws on hostile input shapes', () => {
    expect(() => scrubClientErrorText(undefined)).not.toThrow();
    expect(() => scrubClientErrorText({ toString: () => { throw new Error('nope'); } })).not.toThrow();
    expect(scrubClientErrorText(undefined)).toBe('');
    expect(() => boundedClientErrorText(null, 10)).not.toThrow();
  });
});

describe('client-error sanitize — URL is reduced to origin + pathname', () => {
  it('drops the query string and fragment (a ?token= or a search term lives there)', () => {
    expect(sanitizeClientErrorUrl('https://digby.ai/crossmodel/chat?token=secret123&q=private#frag')).toBe('https://digby.ai/crossmodel/chat');
  });

  it('handles a relative path and junk without throwing', () => {
    expect(sanitizeClientErrorUrl('/crossmodel?x=1')).toBe('/crossmodel');
    expect(sanitizeClientErrorUrl('')).toBeUndefined();
    expect(sanitizeClientErrorUrl(undefined)).toBeUndefined();
    expect(sanitizeClientErrorUrl('not a url at all')).toBe('not a url at all');
  });

  it('caps a pathological URL', () => {
    const long = `https://digby.ai/${'a'.repeat(2000)}`;
    expect((sanitizeClientErrorUrl(long) ?? '').length).toBeLessThanOrEqual(CLIENT_ERROR_MAX_URL);
  });

  it('rejects a build sha that is not a sha-shaped token (it is echoed into context)', () => {
    expect(sanitizeClientErrorBuildSha('abc123def')).toBe('abc123def');
    expect(sanitizeClientErrorBuildSha('has spaces in it')).toBeUndefined();
    // Over the cap ⇒ REJECTED rather than silently truncated: a truncated sha
    // names a different build, which would mislead every row it stamps.
    expect(sanitizeClientErrorBuildSha('x'.repeat(200))).toBeUndefined();
    expect(sanitizeClientErrorBuildSha('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitizeClientErrorBuildSha('')).toBeUndefined();
  });
});

describe('client-error sanitize — the signature is the dedupe key', () => {
  it('groups the same error however its ids/numbers change (the class, not the instance)', () => {
    const a = sanitizeClientError({ message: 'TypeError: Cannot read properties of undefined (reading \'id\')', stack: 'Error\n    at ChatRow (https://digby.ai/_next/static/chunks/app.js:1:22345)' });
    const b = sanitizeClientError({ message: 'TypeError: Cannot read properties of undefined (reading \'id\')', stack: 'Error\n    at ChatRow (https://digby.ai/_next/static/chunks/app.js:1:98765)' });
    expect(a.signature).toBe(b.signature);
  });

  it('separates different error classes', () => {
    const a = sanitizeClientError({ message: 'TypeError: x is not a function', stack: 'Error\n    at A (https://digby.ai/a.js:1:2)' });
    const b = sanitizeClientError({ message: 'ReferenceError: y is not defined', stack: 'Error\n    at A (https://digby.ai/a.js:1:2)' });
    expect(a.signature).not.toBe(b.signature);
  });

  it('ignores a client-supplied signature entirely (the field is not part of the input)', () => {
    const out = sanitizeClientError({ message: 'boom', stack: 'Error\n    at A (https://digby.ai/a.js:1:2)', signature: 'attacker-chosen' } as never);
    expect(out.signature).not.toContain('attacker-chosen');
    expect(out.signature).toContain('boom');
  });

  it('caps the signature length', () => {
    const long = 'z '.repeat(500);
    expect(clientErrorSignature(long, 'Error\n    at x').length).toBeLessThanOrEqual(200);
  });

  it('firstStackFrame picks the first `at` line and tolerates junk', () => {
    expect(firstStackFrame('Error: x\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)')).toBe('at foo (a.js:1:1)');
    expect(firstStackFrame('no frames here')).toBe('');
    expect(firstStackFrame(undefined)).toBe('');
  });
});

describe('client-error sanitize — source + counters', () => {
  it('only accepts the closed source set (an unknown handler falls back to onerror)', () => {
    expect(sanitizeClientError({ message: 'x', source: 'error-boundary' }).source).toBe('error-boundary');
    expect(sanitizeClientError({ message: 'x', source: 'onerror' }).source).toBe('onerror');
    expect(sanitizeClientError({ message: 'x', source: 'something-else' }).source).toBe('onerror');
    expect(sanitizeClientError({ message: 'x' }).source).toBe('onerror');
  });

  it('defaults occurrences to 1 and clamps a silly value', () => {
    expect(sanitizeClientError({ message: 'x' }).occurrences).toBe(1);
    expect(sanitizeClientError({ message: 'x', occurrences: 0 }).occurrences).toBe(1);
    expect(sanitizeClientError({ message: 'x', occurrences: 1e9 }).occurrences).toBe(10_000);
  });

  it('keeps line/column when numeric and drops nonsense', () => {
    expect(sanitizeClientError({ message: 'x', line: 12, column: 4 })).toMatchObject({ line: 12, column: 4 });
    expect(sanitizeClientError({ message: 'x', line: -5 }).line).toBeUndefined();
    expect(sanitizeClientError({ message: 'x', line: 'nope' as never }).line).toBeUndefined();
  });
});