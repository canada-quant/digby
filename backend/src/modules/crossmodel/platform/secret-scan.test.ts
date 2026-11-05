/**
 * Shared secret-scan leaf (remediation P1 item N9) — pure-function tests with
 * FAKE fixture credentials (never real ones). The pattern set is the one
 * scanDiffForSecrets (coding/tools.ts) has always used; the redaction half is
 * new: inbound owner-question answers + supervisor directives persist the
 * redacted form.
 */
import {
  SECRET_PATTERNS,
  INBOUND_ONLY_PATTERNS,
  REDACTED_NOTE,
  scanTextForSecrets,
  redactSecrets,
  redactInboundSecrets,
  redactChatReadSecrets,
  redactStringsDeep,
  findSecretSpans,
  looksLikeCredentialValue,
  CONTEXT_GATED_PATTERNS,
  APP_PASSWORD_CUE_WINDOW,
  PASSWORD_LABEL_PATTERNS,
  passwordTokenToRedact,
  passphraseToRedact,
  redactOutboundSecrets,
  outboundRedactionNotice,
} from './secret-scan';

// Fixtures — FAKE, structurally valid shapes only.
const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const FAKE_SK = 'sk-' + 'proj-FAKEFAKEFAKEFAKEFAKE1234';
const FAKE_SLACK = 'xoxb-' + '1234567890-FAKEFAKEFAKE';
const FAKE_AWS = 'AKIA' + 'FAKEFAKEFAKEFAKE';
const FAKE_HF = 'hf_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake12';
const FAKE_GOOGLE = 'AIza' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake123';
/** Ticket 365588cf: a FAKE 40-char AWS-secret-shaped run (mixed case + digits,
 *  base64 alphabet, leading '/'), assembled from parts so no
 *  credential-shaped literal sits contiguous in source. */
const FAKE_AWS_SECRET = '/' + ['fLnGw229n89c5Ufq', 'Zvrx9xwDLyaVz328', 'LAqYLz9'].join('');
/** A sha1-shaped 40-char PURE HEX run — the value-shape gate must reject it. */
const FAKE_SHA1 = ['3dc48ac3797981ef', 'eff56d36b5a145a6', 'b75183cb'].join('');
const FAKE_KEY_BLOCK =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKEFAKE\nFAKELINE2\n-----END RSA PRIVATE KEY-----';

describe('N9 — scanTextForSecrets', () => {
  it.each([
    ['GitHub token', FAKE_GH],
    ['OpenAI/Anthropic-style key', FAKE_SK],
    ['Slack token', FAKE_SLACK],
    ['AWS access key', FAKE_AWS],
    ['HuggingFace token', FAKE_HF],
    ['Google API key', FAKE_GOOGLE],
    ['Private key block', FAKE_KEY_BLOCK],
  ])('detects a %s', (name, fixture) => {
    expect(scanTextForSecrets(`the credential is ${fixture} ok?`)).toContain(name);
  });

  it('benign owner prose never hits (no password heuristics — structured tokens only)', () => {
    expect(scanTextForSecrets('Resume the ca-central-1 lane; my password policy stays as-is. sk-etch is a word.')).toEqual([]);
    expect(scanTextForSecrets('use hunter2 as the placeholder')).toEqual([]);
  });
});

describe('N9 — redactSecrets', () => {
  it('replaces the token with the visible note and reports the hit', () => {
    const { text, hits } = redactSecrets(`deploy with ${FAKE_GH} tonight`);
    expect(text).toBe(`deploy with ${REDACTED_NOTE} tonight`);
    expect(hits).toEqual(['GitHub token']);
  });

  it('redacts EVERY occurrence and every pattern in one pass', () => {
    const { text, hits } = redactSecrets(`a=${FAKE_SK} b=${FAKE_SK} c=${FAKE_SLACK}`);
    expect(text).not.toContain(FAKE_SK);
    expect(text).not.toContain(FAKE_SLACK);
    expect((text.match(/\[REDACTED: looked like a credential\]/g) ?? []).length).toBe(3);
    expect(hits).toEqual(expect.arrayContaining(['OpenAI/Anthropic-style key', 'Slack token']));
  });

  it('swallows a WHOLE private-key block, not just its header line', () => {
    const { text } = redactSecrets(`key follows:\n${FAKE_KEY_BLOCK}\ndone`);
    expect(text).toBe(`key follows:\n${REDACTED_NOTE}\ndone`);
    expect(text).not.toContain('MIIFAKE');
    expect(text).not.toContain('END RSA PRIVATE KEY');
  });

  it('swallows an UNTERMINATED private-key block to end of text', () => {
    const { text } = redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKE\ntruncated paste');
    expect(text).toBe(REDACTED_NOTE);
  });

  it('leaves clean text byte-identical', () => {
    const clean = 'Answer: yes, ship it — the region stays ca-central-1.';
    expect(redactSecrets(clean)).toEqual({ text: clean, hits: [] });
  });
});

describe('N9 — redactInboundSecrets (persistence entry point)', () => {
  it('redacts by default', () => {
    expect(redactInboundSecrets(`token ${FAKE_AWS}`)).toBe(`token ${REDACTED_NOTE}`);
  });

  it('tolerates garbage input (nullish collapses to empty, never throws)', () => {
    expect(redactInboundSecrets(undefined as any)).toBe('');
    expect(redactInboundSecrets(null as any)).toBe('');
    expect(redactInboundSecrets('')).toBe('');
  });
});

describe('N9 — the pattern set stays shared with the commit-time diff scan', () => {
  it('exports the 7 canonical patterns scanDiffForSecrets has always used + the Z.ai shape (D4, 2026-09-27) + the Cloudflare scannable shapes (82dd8756) + the Tailscale auth key (4e8257c4) + the four LiteLLM-specimen provider shapes (8d15611c)', () => {
    expect(SECRET_PATTERNS.map((p) => p.name)).toEqual([
      'HuggingFace token',
      'GitHub token',
      'Alibaba Model Studio key',
      'xAI API key',
      'OpenAI token-plan id',
      'OpenAI/Anthropic-style key',
      'Slack token',
      'AWS access key',
      'Google API key',
      'Private key block',
      'Z.ai API key',
      'Cloudflare API token',
      'Tailscale auth key',
    ]);
  });

  it('the 8d15611c sk- entries sit BEFORE the generic sk- shape (containment: the specific pattern must consume a dotted sk-sp-/sk-ws- token first)', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names.indexOf('Alibaba Model Studio key')).toBeLessThan(names.indexOf('OpenAI/Anthropic-style key'));
  });

  it('the generic assignment shape is REDACTION-ONLY — never in the shared commit-gate set', () => {
    expect(INBOUND_ONLY_PATTERNS.map((p) => p.name)).toEqual(['Credential assignment']);
    expect(SECRET_PATTERNS.map((p) => p.name)).not.toContain('Credential assignment');
    // scanTextForSecrets (the commit-time / G4 scan) does not know the shape:
    expect(scanTextForSecrets('token=process.env.MCP_DIGBY_TOKEN_VALUE')).toEqual([]);
    expect(scanTextForSecrets(`api_key=${'x'.repeat(24)}`)).toEqual([]);
  });
});

// ── D4 (2026-09-27): Z.ai keys, the assignment shape, chat-read redaction ────

const FAKE_ZAI = '0123456789abcdef0123456789abcdef' + '.AbCdEfGhIjKlMnOp';

describe('D4 — Z.ai id.secret keys', () => {
  it('detects and redacts the <32 hex>.<16 alnum> shape (the finding: a pasted Z.ai key persisted in a directive)', () => {
    expect(scanTextForSecrets(`ZAI_API_KEY=${FAKE_ZAI}`)).toEqual(['Z.ai API key']);
    const { text, hits } = redactSecrets(`use ${FAKE_ZAI} for the bench`);
    expect(text).toBe(`use ${REDACTED_NOTE} for the bench`);
    expect(hits).toEqual(['Z.ai API key']);
  });

  it('a git sha, an md5 or a dotted version never hits', () => {
    expect(scanTextForSecrets('sha 0123456789abcdef0123456789abcdef01234567.tar.gz')).toEqual([]);
    expect(scanTextForSecrets('md5 d41d8cd98f00b204e9800998ecf8427e')).toEqual([]);
    expect(scanTextForSecrets('v0123456789abcdef0123456789abcdef.1')).toEqual([]);
  });
});

describe('D4 — credential ASSIGNMENT shape (redaction only)', () => {

  it.each([
    ['api_key=…', `api_key=${'x'.repeat(24)}`, `api_key=${REDACTED_NOTE}`],
    ['X-API-Key header', 'X-API-Key: 0123456789abcdef0123456789abcdef', `X-API-Key: ${REDACTED_NOTE}`],
    ['access_token in JSON (opening quote kept, string stays a string)', '"access_token": "AbCdEfGhIjKlMnOpQrStUv12", "n": 1', `"access_token": "${REDACTED_NOTE}", "n": 1`],
    ['client_secret=', 'client_secret=verysecretvaluehere12345 and more', `client_secret=${REDACTED_NOTE} and more`],
    ['PASSWORD: (case-insensitive keyword)', 'PASSWORD: hunter2hunter2hunter2hunter2', `PASSWORD: ${REDACTED_NOTE}`],
  ])('redacts %s — the label survives, the value goes', (_label, input, expected) => {
    const { text, hits } = redactSecrets(input);
    expect(text).toBe(expected);
    expect(hits).toEqual(['Credential assignment']);
  });

  it.each([
    ['an env-var reference', 'token=process.env.MCP_DIGBY_TOKEN_VALUE'],
    ['a GitHub Actions template', 'secret: ${{ secrets.MY_SECRET_VALUE }}'],
    ['a shell variable', 'token=$MCP_DIGBY_TOKEN_VALUE_LONG'],
    ['a <placeholder>', 'JWT_SECRET=<min 32 chars please>'],
    ['a CONSTANT / flag name as the value', 'the token: SUPERVISOR_WAKE_TRIAGE_V2_ENABLED flag'],
    ['a keyword that is only a prefix (max_tokens=)', 'max_tokens=4096000000000000000'],
    ['a keyword glued to a suffix (token_count:)', 'token_count: 12345678901234567890'],
    ['a kill-switch name', 'INBOUND_SECRET_SCAN_DISABLED=1'],
    ['a short value', 'TELEGRAM_BOT_TOKEN=...'],
    ['the already-redacted note', `api_key=${REDACTED_NOTE}`],
    ['plain prose', 'my password policy stays as-is; the secret sauce is patience'],
  ])('never hits %s', (_label, input) => {
    expect(redactSecrets(input)).toEqual({ text: input, hits: [] });
  });

  it('a structured token behind a label is reported under its provider name, not the generic shape', () => {
    const { text, hits } = redactSecrets(`token: ${FAKE_SK} done`);
    expect(text).toBe(`token: ${REDACTED_NOTE} done`);
    expect(hits).toEqual(['OpenAI/Anthropic-style key']);
  });

  it('a JSON envelope stays parseable after redaction', () => {
    const src = JSON.stringify({ a: { access_token: 'AbCdEfGhIjKlMnOpQrStUv12', note: `see ${FAKE_ZAI}` }, n: 1 });
    const { text } = redactSecrets(src);
    expect(JSON.parse(text)).toEqual({ a: { access_token: REDACTED_NOTE, note: `see ${REDACTED_NOTE}` }, n: 1 });
  });

  it('the inbound persist path (directives / owner answers) now catches the assignment shape', () => {
    expect(redactInboundSecrets(`use api_key=${'x'.repeat(24)} on the bench`)).toBe(`use api_key=${REDACTED_NOTE} on the bench`);
  });
});

describe('D4 — redactChatReadSecrets (get_chat_messages / get_run_receipts output)', () => {
  afterEach(() => {
    delete process.env.CHAT_READ_SECRET_REDACT_ALL;
  });

  it('redacts on a MACHINE run and reports hits + applied', () => {
    expect(redactChatReadSecrets(`key ${FAKE_ZAI}`, { machineRun: true })).toEqual({ text: `key ${REDACTED_NOTE}`, hits: ['Z.ai API key'], applied: true });
  });

  it('a user-present turn reads verbatim (the owner may read back what they pasted)', () => {
    expect(redactChatReadSecrets(`key ${FAKE_ZAI}`, { machineRun: false })).toEqual({ text: `key ${FAKE_ZAI}`, hits: [], applied: false });
  });

  it('CHAT_READ_SECRET_REDACT_ALL=1 widens to user-present turns', () => {
    process.env.CHAT_READ_SECRET_REDACT_ALL = '1';
    expect(redactChatReadSecrets(`key ${FAKE_ZAI}`, { machineRun: false }).text).toBe(`key ${REDACTED_NOTE}`);
  });

  it('clean text is byte-identical with applied:true and no hits; garbage input never throws', () => {
    expect(redactChatReadSecrets('nothing here', { machineRun: true })).toEqual({ text: 'nothing here', hits: [], applied: true });
    expect(redactChatReadSecrets(undefined as any, { machineRun: true })).toEqual({ text: '', hits: [], applied: true });
    expect(redactChatReadSecrets('x', undefined as any)).toEqual({ text: 'x', hits: [], applied: false });
  });
});

// ── Review fixes (2026-09-27, same branch): the assignment shape is narrowed ──

describe('review — the assignment shape leaves cursors, prose, placeholders, code and URL tails alone', () => {
  it.each([
    ['an AWS pagination cursor (nextToken camelCase)', 'nextToken: AQICAHhwm0abcdefghijklmnop'],
    ['a next_token cursor', 'next_token=eyJvZmZzZXQiOjEwMH0abcdef'],
    ['a page_token cursor', 'page_token=CAESFgoLMTIzNDU2Nzg5MDESBQoDYWJj'],
    ['a continuation_token', 'continuation_token: AbCdEfGhIjKlMnOpQrStUv12'],
    ['a csrf_token nonce', 'csrf_token=9f2a8b7c6d5e4f3a2b1c0d9e'],
    ['an xsrf-token header', 'xsrf-token: 9f2a8b7c6d5e4f3a2b1c0d9eAB'],
    ['a cancellation token (a run id in prose)', 'the cancellation token: source-of-truth-run-4b2c1d9e is stale'],
    ['a .env.example placeholder', 'JWT_SECRET=your-super-secret-jwt-key-change-this-in-production'],
    ['a scrubbed marker', 'token=***SCRUBBED-2026-08-31***'],
    ['an agent-token placeholder', 'DIGBY_AGENT_TOKEN=dgt_paste_your_agent_token_here'],
    ['a code line (localStorage.getItem)', 'const token = localStorage.getItem('],
    ['a short mixed-case value with no digit', '"access_token": "AbCdEfGhIjKlMnOpQrStUv"'],
    ['a JSON-escaped quote right after a short value', 'token=abcdefghijklmnopq\\"tail\\" x'],
  ])('never hits %s', (_label, input) => {
    expect(redactSecrets(input)).toEqual({ text: input, hits: [] });
  });

  it('a URL share token is redacted but the query tail after & survives', () => {
    const { text, hits } = redactSecrets('https://x.digby.ai/share?token=abcdefghijklmnopqrstuvwx&view=1');
    expect(text).toBe(`https://x.digby.ai/share?token=${REDACTED_NOTE}&view=1`);
    expect(hits).toEqual(['Credential assignment']);
  });

  it('a value abutting a JSON escape sequence stops at the backslash — serialized text stays valid JSON', () => {
    const src = JSON.stringify({ note: 'token=AbCdEfGhIjKlMnOpQrStUv12"tail"\nnext line', n: 1 });
    const { text } = redactSecrets(src);
    expect(JSON.parse(text)).toEqual({ note: `token=${REDACTED_NOTE}"tail"\nnext line`, n: 1 });
  });

  it('looksLikeCredentialValue: the entropy signal', () => {
    expect(looksLikeCredentialValue('AbCdEfGhIjKlMnOpQrStUv12')).toBe(true); // mixed case + digit
    expect(looksLikeCredentialValue('0123456789abcdef0123456789abcdef')).toBe(true); // ≥24, alnum, one segment
    expect(looksLikeCredentialValue('x'.repeat(24))).toBe(true);
    expect(looksLikeCredentialValue('AbCdEfGhIjKlMnOpQrStUv')).toBe(false); // no digit, <24
    expect(looksLikeCredentialValue('your-super-secret-jwt-key-change-this-in-production')).toBe(false); // prose words
    expect(looksLikeCredentialValue('***SCRUBBED-2026-08-31***')).toBe(false); // <80 % alnum
    expect(looksLikeCredentialValue('')).toBe(false);
  });

  it('refresh_token / id_token / api_key values with entropy STILL redact (only cursor labels are exempt)', () => {
    expect(redactSecrets('refresh_token=AbCdEfGhIjKlMnOpQrStUv12').text).toBe(`refresh_token=${REDACTED_NOTE}`);
    expect(redactSecrets('id_token: AbCdEfGhIjKlMnOpQrStUv12').text).toBe(`id_token: ${REDACTED_NOTE}`);
  });
});

describe('review — findSecretSpans (the scrub script\'s masked dry run)', () => {
  it('lists every matched substring with its pattern name, in redaction order, without rewriting', () => {
    const text = `a ${FAKE_ZAI} then api_key=${'x'.repeat(24)} and ${FAKE_GH}`;
    expect(findSecretSpans(text)).toEqual([
      { name: 'GitHub token', value: FAKE_GH },
      { name: 'Z.ai API key', value: FAKE_ZAI },
      { name: 'Credential assignment', value: 'x'.repeat(24) },
    ]);
    expect(findSecretSpans('nothing here')).toEqual([]);
    expect(findSecretSpans('next_token=eyJvZmZzZXQiOjEwMH0abcdef')).toEqual([]); // exemptions apply
  });
});

describe('review — redactStringsDeep (per-leaf envelope redaction)', () => {
  afterEach(() => {
    delete process.env.CHAT_READ_SECRET_REDACT_ALL;
  });

  it('redacts every string leaf of nested objects / arrays, keeps non-strings and the shape, reports hits', () => {
    const when = new Date('2026-09-27T00:00:00Z');
    const env = { ok: true, runs: [{ id: 'r1', receipts: [{ ids: { note: `token=AbCdEfGhIjKlMnOpQrStUv12"tail"\nnext`, prNumber: 7 }, error: `saw ${FAKE_ZAI}` }], at: when }], n: null };
    const r = redactStringsDeep(env, { machineRun: true });
    expect(r.applied).toBe(true);
    expect(r.hits).toEqual(expect.arrayContaining(['Credential assignment', 'Z.ai API key']));
    expect(r.value).toEqual({ ok: true, runs: [{ id: 'r1', receipts: [{ ids: { note: `token=${REDACTED_NOTE}"tail"\nnext`, prNumber: 7 }, error: `saw ${REDACTED_NOTE}` }], at: when }], n: null });
    // The caller serializes the RESULT — always valid JSON.
    expect(() => JSON.parse(JSON.stringify(r.value))).not.toThrow();
    expect(env.runs[0].receipts[0].error).toContain(FAKE_ZAI); // input not mutated
  });

  it('a clean object comes back as the SAME reference with applied:true; user-present turns return the input', () => {
    const env = { a: ['clean', 1], b: { c: 'also clean' } };
    expect(redactStringsDeep(env, { machineRun: true })).toEqual({ value: env, hits: [], applied: true });
    expect(redactStringsDeep(env, { machineRun: true }).value).toBe(env);
    const dirty = { k: FAKE_ZAI };
    expect(redactStringsDeep(dirty, { machineRun: false })).toEqual({ value: dirty, hits: [], applied: false });
    process.env.CHAT_READ_SECRET_REDACT_ALL = '1';
    expect(redactStringsDeep(dirty, { machineRun: false }).value).toEqual({ k: REDACTED_NOTE });
  });

  it('never throws on cyclic or exotic input (depth cap, class instances pass through)', () => {
    const cyc: any = { k: FAKE_ZAI };
    cyc.self = cyc;
    const r = redactStringsDeep(cyc, { machineRun: true });
    expect(r.value.k).toBe(REDACTED_NOTE);
    expect(redactStringsDeep(undefined, { machineRun: true })).toEqual({ value: undefined, hits: [], applied: true });
    expect(redactStringsDeep(FAKE_ZAI as any, { machineRun: true }).value).toBe(REDACTED_NOTE);
  });
});

// --- Backlog audit T6 (2026-09-28): the context-gated Gmail app-password shape ---
describe('T6 — context-gated app-password shape (redaction-only)', () => {
  const FAKE_APP_PW = 'abcd efgh ijkl mnop'; // FAKE: the 4x4 lowercase shape Google displays
  const FAKE_APP_PW_CONTIGUOUS = 'abcdefghijklmnop';

  it('redacts the spaced 4x4 shape when an app-password / gmail / smtp / secret cue is nearby', () => {
    for (const cue of ['app password', 'App-Password', 'gmail', 'SMTP', 'github secret']) {
      const text = `the ${cue} is ${FAKE_APP_PW} — added it to github secrets too`;
      const r = redactSecrets(text);
      expect(r.hits).toContain('App password');
      expect(r.text).not.toContain(FAKE_APP_PW);
      expect(r.text).toContain(REDACTED_NOTE);
    }
  });

  it('the cue may sit AFTER the value, within the window', () => {
    const r = redactSecrets(`${FAKE_APP_PW} is the gmail app password for digby@example.com`);
    expect(r.text).not.toContain(FAKE_APP_PW);
  });

  it('the BARE 4x4 shape in prose is left alone (no cue nearby)', () => {
    for (const prose of [
      'here is what this does when it runs',
      'they said that when your lane runs late it must wait',
      `${FAKE_APP_PW} appears with no cue at all`,
    ]) {
      const r = redactSecrets(prose);
      expect(r.text).toBe(prose);
      expect(r.hits).not.toContain('App password');
    }
  });

  it('a cue OUTSIDE the window does not gate the match', () => {
    const far = 'x'.repeat(APP_PASSWORD_CUE_WINDOW + 20);
    const text = `gmail ${far} ${FAKE_APP_PW}`;
    expect(redactSecrets(text).text).toBe(text);
  });

  it('the contiguous 16-letter form needs the strict app-password cue', () => {
    expect(redactSecrets(`app password: ${FAKE_APP_PW_CONTIGUOUS}`).text).not.toContain(FAKE_APP_PW_CONTIGUOUS);
    // "responsibilities" near "secret" is an English word, not a credential.
    const prose = 'the secret to good responsibilities is delegation';
    expect(redactSecrets(prose).text).toBe(prose);
  });

  it('never joins the commit-gate set (scanTextForSecrets / SECRET_PATTERNS stay blind to it)', () => {
    expect(scanTextForSecrets(`app password ${FAKE_APP_PW}`)).toEqual([]);
    expect(SECRET_PATTERNS.some((p) => p.name === 'App password')).toBe(false);
    // Ticket 365588cf: the gated set is no longer app-password ONLY (the bare
    // AWS secret access key row joined it) — pin the members that must be
    // present instead of the old "all rows are App password" identity.
    expect(CONTEXT_GATED_PATTERNS.filter((p) => p.name === 'App password').length).toBe(2);
    expect(CONTEXT_GATED_PATTERNS.some((p) => p.name === 'AWS secret access key')).toBe(true);
    // ...and the same commit-gate blindness holds for the new shape: an AWS
    // cue + a credential-shaped 40-char run is invisible to scanTextForSecrets
    // (the G4 diff scan must never strike ordinary code).
    expect(scanTextForSecrets(`aws secret access key ${FAKE_AWS_SECRET}`)).toEqual([]);
    expect(SECRET_PATTERNS.some((p) => p.name === 'AWS secret access key')).toBe(false);
  });

  it('findSecretSpans reports the span (for the masked dry run) and redactInboundSecrets persists the note', () => {
    const text = `the gmail app password is ${FAKE_APP_PW}`;
    expect(findSecretSpans(text)).toEqual([{ name: 'App password', value: FAKE_APP_PW }]);
    expect(redactInboundSecrets(text)).toBe(`the gmail app password is ${REDACTED_NOTE}`);
  });
});

// --- Ticket 365588cf (2026-10-30): the BARE AWS secret access key ---
// The measured incident: an owner pasted a whole AWS access-key PAIR into an
// owner-card's free-text reply box (the card was expectedAnswerType 'choice',
// so there was no key field). findSecretSpans saw ONLY the 20-char key ID —
// the scanner had no pattern for the 40-char secret half — so the pair vaulted
// its key ID and the secret was destroyed (redacted out of the answer row,
// never vaulted). FAKE fixtures only.
describe('365588cf — context-gated bare AWS secret access key (redaction-only)', () => {
  it('finds the bare 40-char secret next to the AWS "Secret access key" idiom', () => {
    const text = `Access key\n${FAKE_AWS}\nSecret access key\n${FAKE_AWS_SECRET}\nHide`;
    const spans = findSecretSpans(text);
    expect(spans.map((s) => s.name)).toEqual(['AWS access key', 'AWS secret access key']);
    expect(spans[1].value).toBe(FAKE_AWS_SECRET);
    expect(spans[1].value).toHaveLength(40);
  });

  it('redacts it (cue from the owner\'s own label) and keeps the label readable', () => {
    const text = `Secret access key: ${FAKE_AWS_SECRET}`;
    const r = redactSecrets(text);
    expect(r.hits).toContain('AWS secret access key');
    expect(r.text).toBe(`Secret access key: ${REDACTED_NOTE}`);
  });

  it('THE VALUE-SHAPE GATE: a 40-char pure-hex sha1 beside an AWS/S3 cue is NOT a secret', () => {
    for (const text of [`aws s3 deploy commit ${FAKE_SHA1}`, `secret access key ${FAKE_SHA1}`]) {
      expect(findSecretSpans(text).some((s) => s.name === 'AWS secret access key')).toBe(false);
      expect(redactSecrets(text).hits).not.toContain('AWS secret access key');
    }
  });

  it('a low-entropy 40-letter word run beside the cue is not a secret either', () => {
    const words = 'thequickbrownfoxjumpsoverthelazydogandmore'; // 40 lower-case letters
    expect(findSecretSpans(`s3 ${words}`).some((s) => s.name === 'AWS secret access key')).toBe(false);
  });

  it('no AWS/S3 cue nearby ⇒ left alone (a bare 40-char run is not self-evidently a credential)', () => {
    const text = `here is the blob ${FAKE_AWS_SECRET} for the parse`;
    expect(findSecretSpans(text).some((s) => s.name === 'AWS secret access key')).toBe(false);
    expect(redactSecrets(text).text).toBe(text);
  });

  // REVIEW FINDING 1 (blocking, caught by the independent adversarial review
  // of this ticket, reproduced before the fix): a bare /aws|s3/ cue matches
  // INSIDE ordinary words — "dr-AWS", "l-AWS", "fl-AWS", "cs-S3" — so any
  // 40-char token in a sentence about a diagram, a tax law or a CSS gradient
  // was redacted AND routed to the vault as a credential (a non-secret minted
  // as a live $ENVKEY in every coding shell). The cue is now token-anchored;
  // this pins the word-substring class shut.
  it('THE CUE IS TOKEN-ANCHORED: "draws"/"laws"/"flaws"/"css3" are not an AWS cue', () => {
    for (const text of [
      `the diagram draws on the trace ${FAKE_AWS_SECRET} printed by the run`,
      `the tax laws changed; reference ${FAKE_AWS_SECRET} applies`,
      `two flaws showed up; the request id was ${FAKE_AWS_SECRET}`,
      `css3 gradients and trace ${FAKE_AWS_SECRET}`,
      `the lawn was mowed; id ${FAKE_AWS_SECRET}`,
    ]) {
      expect(findSecretSpans(text).some((s) => s.name === 'AWS secret access key')).toBe(false);
      expect(redactSecrets(text).text).toBe(text); // left exactly as written
    }
  });

  it('...while a STANDALONE aws / s3 token still gates (the anchoring is not over-tight)', () => {
    for (const text of [
      `aws ${FAKE_AWS_SECRET}`,
      `use aws, then ${FAKE_AWS_SECRET}`,
      `s3 upload ${FAKE_AWS_SECRET}`,
      `s3://bucket/key ${FAKE_AWS_SECRET}`,
      `AWS_SECRET_ACCESS_KEY ${FAKE_AWS_SECRET}`,
      `Secret access key ${FAKE_AWS_SECRET}`,
    ]) {
      expect(findSecretSpans(text).some((s) => s.name === 'AWS secret access key')).toBe(true);
    }
  });
});

// --- audit 2026-10-06 T2-1: password / passphrase labels + plain English ---
// (FAKE values only — the shapes an owner types, never a real credential.)
describe('audit 2026-10-06 T2-1 — password-family labels redact values ≥ 6 chars', () => {
  afterEach(() => {
    delete process.env.SECRET_SCAN_PASSWORD_LABELS_DISABLED;
  });

  it.each([
    ['the owner paste (username + password, 9 chars)', 'username: bob@example.com password: Hue2024!x for the Hue - store somewhere', `username: bob@example.com password: ${REDACTED_NOTE} for the Hue - store somewhere`],
    ['a short password with a digit', 'password: hunter22', `password: ${REDACTED_NOTE}`],
    ['a plain lower-case word after an explicit password label', 'Password: sunshine', `Password: ${REDACTED_NOTE}`],
    ['a quoted code literal', "const password = 'Abc123xy';", `const password = '${REDACTED_NOTE}';`],
    ['a JSON field (the envelope stays valid)', '{"password":"Abc12345","user":"bob"}', `{"password":"${REDACTED_NOTE}","user":"bob"}`],
    ['a value on the next line', 'Password:\nAbc123x9', `Password:\n${REDACTED_NOTE}`],
    ['compound labels (db_password=, wifi-pw:)', 'db_password=Abc123x9 and wifi-pw: hunter22', `db_password=${REDACTED_NOTE} and wifi-pw: ${REDACTED_NOTE}`],
    ['passwd / passcode / pwd', 'passwd: Xy12ab34 passcode: 9a8b7c6d pwd=Qq11ww22', `passwd: ${REDACTED_NOTE} passcode: ${REDACTED_NOTE} pwd=${REDACTED_NOTE}`],
    ['a 6-digit pin', 'pin: 482913', `pin: ${REDACTED_NOTE}`],
    ['a secret label with a short mixed value', 'secret: s3cr3t99', `secret: ${REDACTED_NOTE}`],
    ['a trailing parenthetical survives', 'password: Abc123!x (rotated monthly)', `password: ${REDACTED_NOTE} (rotated monthly)`],
    ['a URL query value stops at &', 'https://x.example/login?password=Abc123x9&next=/home', `https://x.example/login?password=${REDACTED_NOTE}&next=/home`],
    ['the second label after a non-value first', 'pin: none, password: Abc123!x', `pin: none, password: ${REDACTED_NOTE}`],
  ])('redacts %s', (_label, input, expected) => {
    const r = redactSecrets(input);
    expect(r.text).toBe(expected);
    expect(r.hits).toContain('Password');
  });

  it.each([
    ['my/the password is X', 'my password is hunter22.', `my password is ${REDACTED_NOTE}.`],
    ['pw is X (the value keeps its symbols)', 'pw is Tr0ub4dor&3', `pw is ${REDACTED_NOTE}`],
    ['password for X is Y', 'the password for the Hue bridge is Abc123!x ok', `the password for the Hue bridge is ${REDACTED_NOTE} ok`],
    ['password to X: Y', 'password to the wifi: Abc123!x', `password to the wifi: ${REDACTED_NOTE}`],
    ['set the password to X', 'set the password to hunter22 please', `set the password to ${REDACTED_NOTE} please`],
    ['the pin is a 6+ digit number', 'the pin is 482913', `the pin is ${REDACTED_NOTE}`],
  ])('redacts the plain-English disclosure: %s', (_label, input, expected) => {
    expect(redactSecrets(input)).toEqual({ text: expected, hits: ['Password'] });
  });

  it.each([
    ['a 10-word passphrase after a label', 'passphrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet', `passphrase: ${REDACTED_NOTE}`],
    ['a plain-English passphrase (stops at the sentence end)', 'the E2EE passphrase is alpha bravo charlie delta echo foxtrot. Then go', `the E2EE passphrase is ${REDACTED_NOTE}. Then go`],
    ['a hyphen-joined passphrase', 'passphrase: correct-horse-battery-staple', `passphrase: ${REDACTED_NOTE}`],
    ['a recovery phrase', 'recovery phrase: abandon ability able about above absent', `recovery phrase: ${REDACTED_NOTE}`],
    ['digit groups (backup passphrase)', 'backup passphrase = 12345 67890 13579 24680 11223 44556', `backup passphrase = ${REDACTED_NOTE}`],
    ['a single symbol-bearing token, prose after it kept', 'passphrase: Tr0ub4dor&3 is the one', `passphrase: ${REDACTED_NOTE} is the one`],
    ['a following label: is not swallowed', 'passphrase: alpha bravo charlie user: bob', `passphrase: ${REDACTED_NOTE} user: bob`],
  ])('redacts %s', (_label, input, expected) => {
    const r = redactSecrets(input);
    expect(r.text).toBe(expected);
    expect(r.hits).toContain('Passphrase');
  });

  it('a password label followed by an exact 4x4 app password redacts the whole value (no gmail cue needed)', () => {
    expect(redactSecrets('Password: abcd efgh ijkl mnop')).toEqual({ text: `Password: ${REDACTED_NOTE}`, hits: ['App password'] });
  });

  it.each([
    ['status words after a label', 'password: required; Password: unchanged; password: none'],
    ['a TS type', 'password: string;'],
    ['a zod call', 'password: z.string().min(8)'],
    ['an env reference', 'password: process.env.DB_PASSWORD'],
    ['a member path', 'password: config.db.password'],
    ['a camelCase identifier', 'password: hashedPassword'],
    ['a shell var', 'password: $HUE_PASS'],
    ['a template', 'password: ${DB_PASS} and secret: {{ vault_secret }}'],
    ['a placeholder', 'password: <your password>'],
    ['a mask', 'password: ******** and pw: ••••••••'],
    ['a CONSTANT_NAME', 'password: HUE_PASSWORD'],
    ['a version', 'password: v1.2.3'],
    ['an Ansible tag', 'password: !vault'],
    ['a SQL bind param', 'WHERE password = :password'],
    ['a hash column (password_hash:)', 'password_hash: Abc123x9'],
    ['a glued suffix (passwordHash:)', 'passwordHash: Abc123x9'],
    ['the tail of a longer word (bypass / compass)', 'bypass: Abc123!x compass: Abc123!x'],
    ['prose after "is"', 'the password is wrong; the password is stored in 1Password'],
    ['prose after a passphrase label', 'The passphrase is stored in 1Password. The passphrase is too long to type on a phone. passphrase: not set yet'],
    ['a short PIN (< 6)', 'the pin is 1234'],
    ['a non-numeric pin (GPIO wiring)', 'pin: GPIO17'],
    ['a test summary (pass:)', 'pass: test_login_2fa; pass: 45/50'],
    ['a bare pass label (dropped 2026-10-06 — verdict lines)', 'pass: Hunter22'],
    ['a snake_case secret id / a numeric secret', 'secret: test_secret_1 secret: 12345678'],
    ['an idiom', 'the secret to good code is simplicity'],
    ['a label that is not a password label', 'I changed my password policy: Abc123!x'],
    ['the already-redacted note', `password: ${REDACTED_NOTE}`],
    ['max_tokens / token_count', 'max_tokens=4096 and token_count: 12'],
    ['mnemonic prose', 'mnemonic: an aid to memory'],
  ])('never hits %s', (_label, input) => {
    expect(redactSecrets(input)).toEqual({ text: input, hits: [] });
  });

  it('is idempotent (a second pass over redacted text changes nothing)', () => {
    const once = redactSecrets('set the password to hunter22 please; passphrase: alpha bravo charlie delta; my pw is Abc123!x').text;
    expect(redactSecrets(once)).toEqual({ text: once, hits: [] });
  });

  it('never joins the commit gate (scanTextForSecrets / SECRET_PATTERNS stay blind to it)', () => {
    expect(scanTextForSecrets('password: hunter22')).toEqual([]);
    expect(SECRET_PATTERNS.some((p) => /Password|Passphrase/.test(p.name))).toBe(false);
    expect(PASSWORD_LABEL_PATTERNS.map((p) => p.name)).toEqual(['Passphrase', 'App password', 'Password']);
  });

  it('findSecretSpans reports the value (never the label) for the masked dry run', () => {
    expect(findSecretSpans('password: hunter22 and passphrase: alpha bravo charlie')).toEqual([
      { name: 'Passphrase', value: 'alpha bravo charlie' },
      { name: 'Password', value: 'hunter22' },
    ]);
  });

  it('the inbound persist path (directives / owner answers) now catches it', () => {
    expect(redactInboundSecrets('username: bob password: Hue2024!x')).toBe(`username: bob password: ${REDACTED_NOTE}`);
  });

  it('SECRET_SCAN_PASSWORD_LABELS_DISABLED=1 restores the previous redaction byte-for-byte', () => {
    process.env.SECRET_SCAN_PASSWORD_LABELS_DISABLED = '1';
    for (const t of ['password: hunter22', 'my pw is Tr0ub4dor&3', 'passphrase: alpha bravo charlie delta', 'pin: 482913', 'Password: abcd efgh ijkl mnop']) {
      expect(redactSecrets(t)).toEqual({ text: t, hits: [] });
    }
    // The ≥16 assignment shape and the structured patterns are untouched by the switch.
    expect(redactSecrets('PASSWORD: hunter2hunter2hunter2hunter2').text).toBe(`PASSWORD: ${REDACTED_NOTE}`);
  });

  it('passwordTokenToRedact / passphraseToRedact: the value rules in isolation', () => {
    expect(passwordTokenToRedact('password', 'assign', 'hunter22,')).toBe('hunter22');
    expect(passwordTokenToRedact('password', 'prose', 'sunshine')).toBeNull(); // plain word after "is" is prose
    expect(passwordTokenToRedact('pin', 'assign', '482913')).toBe('482913');
    expect(passwordTokenToRedact('secret', 'assign', '482913')).toBeNull();
    expect(passwordTokenToRedact('password', 'assign', 'Abc123x9&next=1', true)).toBe('Abc123x9');
    expect(passphraseToRedact('prose', 'alpha bravo charlie')).toBeNull(); // < 4 words after "is"
    expect(passphraseToRedact('assign', 'alpha bravo charlie')).toBe('alpha bravo charlie');
    expect(passphraseToRedact('assign', 'the vault entry for it')).toBeNull();
  });
});

describe('audit 2026-10-06 T2-2 — redactOutboundSecrets (send_chat_message / notify_user bodies)', () => {
  afterEach(() => { delete process.env.OUTBOUND_SECRET_REDACT_DISABLED; });

  it('redacts on every call (no machine/human split) and counts the values', () => {
    const r = redactOutboundSecrets(`use ${FAKE_GH} and the password is Hue2024!x`);
    expect(r).toEqual({ text: `use ${REDACTED_NOTE} and the password is ${REDACTED_NOTE}`, hits: ['GitHub token', 'Password'], count: 2, applied: true });
  });

  it('clean text: applied, no hits, byte-identical; garbage never throws', () => {
    expect(redactOutboundSecrets('ship it')).toEqual({ text: 'ship it', hits: [], count: 0, applied: true });
    expect(redactOutboundSecrets(undefined as any)).toEqual({ text: '', hits: [], count: 0, applied: true });
  });

  it('OUTBOUND_SECRET_REDACT_DISABLED=1 sends verbatim', () => {
    process.env.OUTBOUND_SECRET_REDACT_DISABLED = '1';
    expect(redactOutboundSecrets(`use ${FAKE_GH}`)).toEqual({ text: `use ${FAKE_GH}`, hits: [], count: 0, applied: false });
  });

  it('the notice names the count, the patterns and the sanctioned hand-off (store_secret → $ENVKEY), never the value', () => {
    const n = outboundRedactionNotice(['Password'], 2);
    expect(n).toMatch(/^CREDENTIALS REDACTED — 2 credential-shaped value\(s\) \(Password\)/);
    expect(n).toContain('store_secret');
    expect(n).toContain('$ENVKEY');
  });
});


// --- Hotfix 2026-10-06: false positives found by the first live scrub dry run (fleet transcripts) ---
describe('hotfix 2026-10-06 — fleet prose is never a credential', () => {
  afterEach(() => { delete process.env.SECRET_SCAN_APP_PASSWORD_PROSE_GUARD_DISABLED; });
  it.each([
    ['a PASS verdict line', 'WCACHE-VERDICT PASS: layers=48/48 bytes=2179996632/2179996632, RESTORE rc=0'],
    ['a FULL_PASS flag', 'snapcap15 parse (FINALS=2/FULL_PASS=1/MAX=0, torch-tensor-parallelism=1.00'],
    ['"this audit pass:" + a digest', 'ls-remote this audit pass: `digest=5c831aadbe066c311add3038c6d85dba9f6`'],
    ['"same pass:" + a key=value', 'Router auth + listing — same pass: `router_keyed=200`, `models_listing=200`'],
    ['"this pass:" + a CONSTANT=0', 'byte-audit re-run on disk bytes this pass: `WRITTEN_BYTES=0`'],
    ['a path label (/etc/passwd:)', 'cmd: line 1: /etc/passwd: Permission denied\nPASSWD-WRITE-FAILED'],
    ['a passphrase after a bare "to"', 'decrypting audio from encrypted classroom clips using a captured passphrase to generate decryption keys for each class'],
    ['an app-password-shaped run of ordinary words near Gmail', 'via raw Gmail API: msg is a bare text html body data and no parts array'],
    ['another 4x4 word run near smtp', 'the smtp relay: real mail sent from the deployed backend'],
  ])('leaves alone: %s', (_label, input) => {
    const r = redactSecrets(input);
    expect(r.text).toBe(input);
  });
  it.each([
    ['a random 4x4 app password near a secrets cue', 'ok i added xqzv bkwp rtmj hfyd to github secrets try now'],
    ['a labelled random 4x4', 'Password: xqzv bkwp rtmj hfyd'],
    ['a password label', 'password: Hue2024!x'],
    ['a passphrase after a colon', 'passphrase: alpha bravo charlie delta echo foxtrot'],
    ['a passphrase after "is"', 'the E2EE passphrase is alpha bravo charlie delta echo foxtrot.'],
  ])('still redacts: %s', (_label, input) => {
    expect(redactSecrets(input).text).toContain(REDACTED_NOTE);
  });
  it('kill switch: SECRET_SCAN_APP_PASSWORD_PROSE_GUARD_DISABLED=1 restores the word-run match', () => {
    process.env.SECRET_SCAN_APP_PASSWORD_PROSE_GUARD_DISABLED = '1';
    expect(redactSecrets('via raw Gmail API: msg is a bare text html body data and no parts array').text).toContain(REDACTED_NOTE);
  });
});

describe('hotfix 2026-10-06 — env-var REFERENCES are never credentials (LiteLLM os.environ/NAME)', () => {
  it.each([
    ['a LiteLLM config line', 'litellm_params:\n  api_base: https://api.xiaomimimo.com/v1\n  api_key: os.environ/XIAOMI_API_KEY\n  model: openai/x'],
    ['an os.environ index', 'api_key = os.environ["MOONSHOT_API_KEY"]'],
    ['os.getenv', 'secret_key=os.getenv("JWT_SECRET_KEY_FOR_PROD_X1")'],
    ['a password label referencing os.environ', 'password: os.environ/DB_PASSWORD_PROD_2'],
  ])('leaves alone: %s', (_label, input) => {
    expect(redactSecrets(input).text).toBe(input);
  });
  it('a real key after api_key: is still redacted', () => {
    expect(redactSecrets('api_key: sk-proj-Abc123Def456Ghi789Jkl012').text).toContain(REDACTED_NOTE);
  });
});
