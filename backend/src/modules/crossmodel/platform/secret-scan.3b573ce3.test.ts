/**
 * Ticket 3b573ce3 (2026-10-30) — the owner-answer vault stored TWO credentials
 * CONCATENATED as ONE env var.
 *
 * THE LIVE INCIDENT: the owner answered a `ctrl.cql.ca` credential card with
 * both halves of an S3 pair. The vault receipt said both were stored, and in
 * the lane's shell $CANLAW_CPT_S3_SECRET_ACCESS_KEY measured 60 chars with an
 * `AKIA` prefix — chars [0:20] byte-equal to $OWNER_ANSWER_OQ0E8265 (the
 * 20-char access key ID from the SAME answer), chars [20:60] the real secret.
 * Any consumer reading the env var got a secret prefixed with the key ID.
 *
 * THE MECHANISM (measured with this scanner, not inferred): a FUSED run —
 * `…_SECRET_ACCESS_KEY=AKIA<16><40-char secret>` with the key ID glued to the
 * secret, the shape a two-line paste produces when a UI strips the newline —
 * is captured as ONE 60-char span. The 'AWS access key' provider pattern does
 * not carve it out either: its trailing `\b` fails against the alnum that
 * abuts the key ID, so `/AKIA[0-9A-Z]{16}\b/` never matches the head. The
 * store-time AWS pair guard missed it a second way — it is ANCHORED
 * (`/^(?:AKIA|…){16}$/`), and a 60-char blob is not a key ID.
 *
 * THE CONTRACT these tests pin:
 *  1. a fused pair is SPLIT at capture — the key ID (self-identifying, needs
 *     no label) and the secret as two spans, never one concatenated value;
 *  2. the owner's own `NAME=value` label rides the value (the incident's
 *     second half: the ID landed on an ordinal OWNER_ANSWER_<id> key while
 *     the owner had written CANLAW_CPT_S3_KEY) — carried ONLY when the name
 *     is already a valid env-var name, so prose labels never mint $TOKEN;
 *  3. the store door refuses a fused blob on a secret slot, naming both
 *     halves' slots (the Account → Coding form / any direct API write);
 *  4. every PRE-EXISTING span shape is byte-identical (a bare 20-char key ID,
 *     a plain 40-char secret, ordinary inbound redaction).
 */
import {
  findSecretSpans,
  redactSecrets,
  redactInboundSecrets,
  splitFusedAwsPair,
  REDACTED_NOTE,
} from './secret-scan';

// FAKE fixtures — structurally valid, never real key material.
const AKID = 'AKIA' + 'FAKEFAKEFAKEFAKE'; // 20 chars: AKIA + 16 upper alnum
// ASSEMBLED AT RUNTIME, deliberately — see credentials.service.3b573ce3.test.ts.
// Same 40-char base64 value, no credential-shaped literal in the tree.
const SECRET = ['AbCdEfGh', 'IjKlMnOp', 'QrStUvWx', 'Yz012345', '6789+/ab'].join(''); // 40 chars (AWS secret-key length)
const FUSED = `${AKID}${SECRET}`; // 60 — the live shape

describe('ticket 3b573ce3 — fixture sanity (the shapes are what the ticket measured)', () => {
  it('the fused fixture is exactly the live 60-char shape: AKIA prefix, key ID in [0:20]', () => {
    expect(FUSED).toHaveLength(60);
    expect(FUSED.startsWith('AKIA')).toBe(true);
    expect(FUSED.slice(0, 20)).toBe(AKID);
    expect(FUSED.slice(20)).toBe(SECRET);
  });
});

describe('ticket 3b573ce3 (a) — a FUSED AWS pair is split at capture, never stored as one value', () => {
  it('THE PIN: `…_SECRET_ACCESS_KEY=<AKID><SECRET>` yields TWO spans, and NO span is the fused 60-char blob', () => {
    const spans = findSecretSpans(`CANLAW_CPT_S3_SECRET_ACCESS_KEY=${FUSED}`);
    // The ticket's acceptance criterion, asserted literally: one
    // credential-shaped value per value — never the concatenation.
    for (const s of spans) {
      expect(s.value).not.toBe(FUSED);
      expect(s.value.length).toBeLessThan(60);
    }
    expect(spans).toHaveLength(2);
    const idSpan = spans.find((s) => s.value === AKID);
    const secretSpan = spans.find((s) => s.value === SECRET);
    expect(idSpan).toBeDefined();
    expect(secretSpan).toBeDefined();
    // The key ID is self-identifying — it carries no label (a label on the run
    // named the half the owner wrote last). The secret keeps that label.
    expect(idSpan!.label).toBeUndefined();
    expect(idSpan!.name).toBe('AWS access key');
    expect(secretSpan!.label).toBe('CANLAW_CPT_S3_SECRET_ACCESS_KEY');
  });

  it('the KEYWORD leg is the same choke point: `secret_access_key=<fused>` also splits', () => {
    const spans = findSecretSpans(`secret_access_key=${FUSED}`);
    expect(spans.map((s) => s.value).sort()).toEqual([AKID, SECRET].sort());
    expect(spans.some((s) => s.value === FUSED)).toBe(false);
  });

  it('a fused pair inside a multi-line two-value answer splits per value (the ticket is a MULTI-LINE paste)', () => {
    const answer = `CANLAW_CPT_S3_KEY=${AKID}\nCANLAW_CPT_S3_SECRET_ACCESS_KEY=${FUSED}`;
    const spans = findSecretSpans(answer);
    expect(spans.some((s) => s.value === FUSED)).toBe(false);
    // Two clean values — the key ID (from line 1 and from the fused head are
    // the same string, so the vault's own seen-values dedupe collapses them)
    // plus the secret: no 60-char value anywhere in the inventory.
    const values = spans.map((s) => s.value);
    expect(values).toContain(SECRET);
    expect(values.every((v) => v.length <= 40)).toBe(true);
  });

  it('splitFusedAwsPair is surgical: it fires ONLY on a key ID that leads a LONGER value', () => {
    expect(splitFusedAwsPair(FUSED)).toEqual({ keyId: AKID, rest: SECRET });
    expect(splitFusedAwsPair(AKID)).toBeNull();            // a bare key ID is one value
    expect(splitFusedAwsPair(SECRET)).toBeNull();          // a plain secret is one value
    expect(splitFusedAwsPair('AKIA' + 'short')).toBeNull(); // too short to hold a whole key ID+value
    expect(splitFusedAwsPair(`X${FUSED}`)).toBeNull();      // not LEADED by a key ID
    expect(splitFusedAwsPair('')).toBeNull();
  });
});

describe('ticket 3b573ce3 (b) — the provider-pattern legs NEVER mint an env name from ambient prose', () => {
  // The first cut of this fix carried the owner's `NAME=value` label onto a
  // provider-pattern span (so the incident's `CANLAW_CPT_S3_KEY=` name would
  // reach its own env var). The independent adversarial review REFUTED it:
  // any `[A-Z][A-Z0-9_]+[:=]` in ordinary prose minted a credential — `OK:`,
  // `NOTE:`, `IMPORTANT:`, `TOKEN:`, `API_KEY:`, `PROD:` — and a 96-char
  // window did not bound the label's distance from the value ("the KEY is
  // IMPORTANT: AKIA…"). That is a generic env var ($IMPORTANT, $TOKEN) an
  // attacker-authored or echoed string could drop a credential into, and it
  // contradicts the ad4fae90 B1/F2 posture the code itself cites. REVERTED:
  // the provider-pattern legs capture the VALUE only, as they always did;
  // an owner-named value stores under the vault's existing label-derived /
  // ordinal keys, and the ticket's actual harm (a CORRUPT value) is closed
  // by the split in (a) plus the store-door refusal in (c).
  it('THE PIN: a prose CAPS word before the value never becomes an env key', () => {
    for (const prose of ['OK', 'NOTE', 'IMPORTANT', 'TOKEN', 'API_KEY', 'PROD', 'WARNING']) {
      const spans = findSecretSpans(`${prose}: ${AKID}`);
      expect(spans).toHaveLength(1);
      expect(spans[0].value).toBe(AKID);
      expect(spans[0].label).toBeUndefined();
    }
  });

  it('the label is not lifted from FAR away either (the 96-char window defect)', () => {
    const spans = findSecretSpans(`${'X'.repeat(200)} TOKEN: ${AKID}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].label).toBeUndefined();
  });

  it('a genuine env-var name before the value is still NOT adopted by this leg', () => {
    // Correct behaviour, recorded so a future "fix" does not re-introduce the
    // over-capture: naming is the NAMED-assignment leg's job (ca0b57cd, which
    // requires a credential-shaped label tail), never a bare CAPS token.
    const spans = findSecretSpans(`CANLAW_CPT_S3_KEY=${AKID}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].label).toBeUndefined();
  });

  it('lowercase prose labels stay unlabeled too (ad4fae90 B1/F2)', () => {
    for (const label of ['token', 'secret', 'password', 'api_key']) {
      expect(findSecretSpans(`${label}=${AKID}`)[0].label).toBeUndefined();
    }
  });
});

describe('ticket 3b573ce3 (c) — every pre-existing span shape is unchanged', () => {
  it('a bare 20-char key ID alone: one span, one value (the c54074df/7caf07ed pins)', () => {
    const spans = findSecretSpans(`key = ${AKID}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe(AKID);
    expect(spans[0].name).toBe('AWS access key');
  });

  it('a plain 40-char secret alone: one span, one value', () => {
    const spans = findSecretSpans(`CANLAW_CPT_S3_SECRET_ACCESS_KEY=${SECRET}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe(SECRET);
    expect(spans[0].label).toBe('CANLAW_CPT_S3_SECRET_ACCESS_KEY');
  });

  it('a NON-AWS provider value fused in a run is left alone (the split keys on the key-ID prefix only)', () => {
    // A 40-char secret is not a key ID, and a GitHub token does not lead with
    // AKIA — neither is a fused pair.
    const gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const spans = findSecretSpans(`TOKEN_ONE=${gh}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe(gh);
  });

  it('the TEXT rewrite is untouched: the fused run is still replaced by ONE redaction note', () => {
    // Only the span INVENTORY changed. The stored answer text must stay the
    // redacted form the N9 posture has always produced (a split there would
    // leave half the fused run visible on the row).
    const text = `CANLAW_CPT_S3_SECRET_ACCESS_KEY=${FUSED}`;
    const r = redactSecrets(text);
    expect(r.text).toBe(`CANLAW_CPT_S3_SECRET_ACCESS_KEY=${REDACTED_NOTE}`);
    expect(redactInboundSecrets(text)).not.toContain(SECRET);
    expect(redactInboundSecrets(text)).not.toContain(AKID);
  });
});