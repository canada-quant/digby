/**
 * Ticket a65bc528 (2026-10-30) — a FUSED AWS pair under a label that names NO
 * credential captured zero spans and was never redacted.
 *
 * THE MEASURED DEFECT (this file's first block re-measures it): for
 *
 *     ANY_LABEL=AKIA<16 upper alnum><40-char secret>      (60-char fused run)
 *
 * `findSecretSpans` returned **0 spans**, and `redactSecrets` /
 * `redactInboundSecrets` returned text that still CONTAINED the 40-char
 * secret verbatim — so the owner-answer row (N9 redaction posture) and every
 * digest carrying that row persisted a live AWS secret in plaintext.
 *
 * TWO independent reasons, both reproduced before the fix:
 *   1. the `AWS access key` provider pattern is `/AKIA[0-9A-Z]{16}\b/` — the
 *      trailing `\b` fails against the alnum abutting the key ID, so the head
 *      of a fused run never matched;
 *   2. both capture legs are LABEL-driven — the named-compound leg requires the
 *      label to END in a NAMED_COMPOUND_TAILS tail (`…_S3_KEY` does not; `key`
 *      alone is not a tail), and the keyword leg needs a token/secret/password/
 *      api-key label. A neutral name fired neither.
 * The 3b573ce3 split only ever runs on a value some leg already captured, so
 * it cannot rescue a run nothing matched — this was PRE-EXISTING, not a
 * regression from 3b573ce3 (the ticket states the same from the pre-fix
 * scanner).
 *
 * THE FIX under test: a LABEL-FREE leg at the END of `redactImpl` that matches
 * the VALUE shape alone — a self-identifying AKIA/ASIA/ABIA/ACCA key ID fused
 * to a ≥20-char credential continuation — redacts the whole run to ONE note
 * and hands it to `pushCaptureSpan`, which splits it into the key ID + the
 * secret half exactly as 3b573ce3 established. Redaction-only: the leg is NOT
 * in SECRET_PATTERNS, so the commit-time diff gate (G4) keeps its current
 * behaviour.
 */
import {
  findSecretSpans,
  redactSecrets,
  redactInboundSecrets,
  FUSED_AWS_PAIR_SPAN_NAME,
  SECRET_PATTERNS,
} from './secret-scan';

// FAKE fixtures — structurally valid, never real key material (same shapes as
// the 3b573ce3 suite so the two files measure the same live incident).
const AKID = 'AKIA' + 'FAKEFAKEFAKEFAKE'; // 20 chars: AKIA + 16 upper alnum
// ASSEMBLED AT RUNTIME, deliberately — see credentials.service.3b573ce3.test.ts.
// Same 40-char base64 value, no credential-shaped literal in the tree.
const SECRET = ['AbCdEfGh', 'IjKlMnOp', 'QrStUvWx', 'Yz012345', '6789+/ab'].join(''); // 40 chars, base64 alphabet
const FUSED = `${AKID}${SECRET}`; // 60 — the live shape
const NOTE = '[REDACTED: looked like a credential]';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('ticket a65bc528 — the reported defect is REALLY reproduced (pre-fix measurement, via the kill switch)', () => {
  it('with FUSED_AWS_PAIR_REDACT_DISABLED=1 the pre-fix behaviour returns byte-for-byte: 0 spans, secret survives', () => {
    process.env.FUSED_AWS_PAIR_REDACT_DISABLED = '1';
    for (const label of ['CANLAW_CPT_S3_KEY', 'ANY_LABEL']) {
      const text = `${label}=${FUSED}`;
      expect(findSecretSpans(text)).toEqual([]);
      expect(redactInboundSecrets(text)).toBe(text);
      expect(redactInboundSecrets(text).includes(SECRET)).toBe(true);
    }
  });
});

describe('ticket a65bc528 — acceptance (a): a neutral label captures spans AND the secret never survives', () => {
  it('THE PIN: `ANY_LABEL=AKIA<16><40>` yields TWO spans and the stored text carries no secret', () => {
    const text = `ANY_LABEL=${FUSED}`;
    const spans = findSecretSpans(text);
    // Two credentials, not one 60-char blob: the key ID and the secret half.
    expect(spans.map((s) => s.value)).toEqual([AKID, SECRET]);
    expect(spans.map((s) => s.name)).toEqual(['AWS access key', FUSED_AWS_PAIR_SPAN_NAME]);
    // No span is ever the fused run itself.
    expect(spans.some((s) => s.value === FUSED)).toBe(false);

    const red = redactSecrets(text).text;
    expect(red).toBe(`ANY_LABEL=${NOTE}`);
    expect(red.includes(SECRET)).toBe(false);
    expect(red.includes(AKID)).toBe(false);
    expect(redactInboundSecrets(text).includes(SECRET)).toBe(false);
  });

  it("the ticket's LIVE shape — `CANLAW_CPT_S3_KEY=…` — is redacted too (the label is not a tail, so no label leg fires)", () => {
    const text = `CANLAW_CPT_S3_KEY=${FUSED}`;
    expect(findSecretSpans(text).map((s) => s.value)).toEqual([AKID, SECRET]);
    expect(redactInboundSecrets(text)).toBe(`CANLAW_CPT_S3_KEY=${NOTE}`);
  });

  it('label-free in every carrier shape the report named (prose, JSON, quoted assignment)', () => {
    const carriers = [
      `here it is ${FUSED}`,
      `"label": "${FUSED}"`,
      `{'x': '${FUSED}'}`,
      `s3 creds -> ${FUSED}`,
      `SOMETHING=${FUSED}`,
    ];
    for (const text of carriers) {
      expect(findSecretSpans(text).length).toBeGreaterThanOrEqual(2);
      const red = redactSecrets(text).text;
      expect(red.includes(SECRET)).toBe(false);
      expect(red).toBe(text.replace(FUSED, NOTE));
    }
  });

  it('every self-identifying AWS key-ID prefix is covered, not just AKIA', () => {
    for (const prefix of ['AKIA', 'ASIA', 'ABIA', 'ACCA']) {
      const id = `${prefix}FAKEFAKEFAKEFAKE`;
      const text = `ANY_LABEL=${id}${SECRET}`;
      expect(findSecretSpans(text).map((s) => s.value)).toEqual([id, SECRET]);
      expect(redactInboundSecrets(text).includes(SECRET)).toBe(false);
    }
  });

  it('defence in depth: a secret-adjacent carrier that already redacted once stays redacted (idempotent)', () => {
    const once = redactInboundSecrets(`ANY_LABEL=${FUSED}`);
    expect(redactInboundSecrets(once)).toBe(once);
  });

  // FINDING F1 (independent adversarial review of PR #2191) — the second,
  // subtler leak in the same class, found only by attacking the fix: the `AWS
  // access key` provider pattern is `/AKIA[0-9A-Z]{16}\b/` and `\b` HOLDS
  // before `+` and `/` (both non-word chars). A real AWS secret may begin with
  // either, and then the provider pattern HALF-consumed the fused run —
  // redacting the 20-char key ID and leaving the 40-char secret standing as
  // `[REDACTED…]+<rest>` BEFORE this leg could see the head. On the live
  // persistence entry point that stored the secret verbatim, on neutral AND on
  // the crowded `…_SECRET_ACCESS_KEY=` label. The fix hands the head back so
  // the run stays whole for the atomic legs. These pins are the reason it can
  // never regress silently.
  it('FINDING F1: a secret half beginning `+` or `/` is redacted too — the provider pattern must not half-consume the fused head', () => {
    const body = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbC'; // 40 chars, base64 alphabet
    for (const lead of ['+', '/']) {
      const secret = lead + body.slice(1); // 40 chars, starts with + or /
      for (const label of ['ANY_LABEL', 'CANLAW_CPT_S3_KEY', 'CANLAW_CPT_S3_SECRET_ACCESS_KEY']) {
        const text = `${label}=${AKID}${secret}`;
        const out = redactInboundSecrets(text);
        // THE ASSERTION THAT MATTERS: the secret must not survive, in any form.
        expect(out.includes(secret)).toBe(false);
        expect(out.includes(body.slice(1))).toBe(false);
        // …and the whole run collapses to one note, not a note plus a tail.
        expect(out).toBe(`${label}=${NOTE}`);
        // Two spans, never a note-then-orphan-tail.
        const spans = findSecretSpans(text);
        expect(spans.length).toBe(2);
        expect(spans.map((s) => s.value)).toEqual([AKID, secret]);
      }
    }
  });

  it('FINDING F1: the guard is narrow — a BARE key id followed by `+`/`/` and a SHORT tail still redacts only the id', () => {
    // <20 chars after the id: below the continuation bar, so this is NOT a
    // fused pair and the provider pattern keeps its original behaviour.
    for (const tail of ['+short', '/short']) {
      const text = `note ${AKID}${tail}`;
      const spans = findSecretSpans(text);
      expect(spans.map((s) => s.name)).toEqual(['AWS access key']);
      expect(redactInboundSecrets(text)).toBe(`note ${NOTE}${tail}`);
    }
  });
});

describe('ticket a65bc528 — the leg does NOT over-match (it must not swallow benign AKIA-led text)', () => {
  it('a BARE 20-char key id (no fused secret) keeps its existing single-span behaviour', () => {
    const text = `my key id is ${AKID}`;
    expect(findSecretSpans(text).map((s) => s.name)).toEqual(['AWS access key']);
    expect(redactInboundSecrets(text)).toBe(`my key id is ${NOTE}`);
  });

  it('a short alnum continuation (< 20 chars) is NOT a fused pair — the leg does not widen to it', () => {
    // Measured behaviour, and it is the ticket's reason #1 left deliberately
    // alone: `…FAKEabc123` abuts lowercase alnum, so the provider pattern's
    // trailing \b still fails and the LEG requires ≥20 continuation chars, so
    // nothing matches. A 6-char tail is not a credential pair, and widening the
    // leg to any alnum continuation would newly strike benign AKIA-led ids in
    // every committed fixture — exactly the blast radius this ticket avoids.
    const text = `ANY_LABEL=${AKID}abc123`;
    const spans = findSecretSpans(text);
    expect(spans.some((s) => s.name === FUSED_AWS_PAIR_SPAN_NAME)).toBe(false);
    expect(spans.map((s) => s.value)).toEqual([]);
  });

  it('a hyphenated run is NOT the fused shape (the AWS secret alphabet has no hyphen) — no over-capture', () => {
    const text = `ANY_LABEL=${AKID}-${SECRET}`;
    const spans = findSecretSpans(text);
    expect(spans.some((s) => s.name === FUSED_AWS_PAIR_SPAN_NAME)).toBe(false);
    expect(spans.map((s) => s.value)).toEqual([AKID]);
  });

  it('clean prose mentioning a region stays byte-identical (no new false positive)', () => {
    const clean = 'Deploy to ca-central-1 and verify the s3 bucket ACL.';
    expect(redactSecrets(clean)).toEqual({ text: clean, hits: [] });
  });

  // STATED TRADEOFF (measured, not assumed): the leg matches on VALUE shape, so
  // a long base64 blob that merely STARTS with AKIA is redacted even though it
  // may be an image/opaque token rather than a credential pair. That is the
  // direction a secret scanner must fail in — a mangled note on benign text is
  // recoverable (the owner re-pastes; the note says what happened), whereas the
  // leak this ticket reports stores a live AWS secret in plaintext forever. The
  // leg is bounded so ordinary prose cannot trip it: the continuation must be
  // ≥20 credential-alphabet chars with NO punctuation or whitespace.
  it('a benign-looking AKIA-led base64 blob IS redacted — the documented safe-direction over-capture', () => {
    const blob = 'AKIAAAAAAAAAAAAAAAAAAFyZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY';
    const text = `base64: ${blob}`;
    expect(findSecretSpans(text).map((s) => s.name)).toEqual(['AWS access key', FUSED_AWS_PAIR_SPAN_NAME]);
    expect(redactInboundSecrets(text).includes(blob.slice(20))).toBe(false);
    expect(redactInboundSecrets(text)).toBe(`base64: ${NOTE}`);
  });

  it('but ordinary prose after a key id never trips the LEG (a space/punctuation breaks the continuation)', () => {
    for (const text of [
      `the doc says ${AKID} with a long tail of words after it`,
      `prefix ${'AKIA'}XXXXXXXXXXXXXXXXsome_ordinary_text_here_1234567890abcdef`,
      `${'AKIADOCUMENTATIONEXAMPLE'}000 and then prose continues here`,
    ]) {
      // The LEG must not fire. (A bare key id IS still captured by the
      // pre-existing provider pattern when a word boundary follows it — that
      // behaviour predates this ticket and is asserted by the recall block;
      // what matters here is that no FUSED split is invented.)
      expect(findSecretSpans(text).some((s) => s.name === FUSED_AWS_PAIR_SPAN_NAME)).toBe(false);
      // And no long credential-alphabet run survives redaction in any of them.
      expect(redactInboundSecrets(text)).toBe(text.replace(/\bAKIA[0-9A-Z]{16}\b/, NOTE));
    }
  });
});

describe('ticket a65bc528 — the commit gate is untouched (the leg is redaction-only)', () => {
  it('FUSED_AWS_PAIR_SPAN_NAME is not a SECRET_PATTERNS provider name and the pattern set is unchanged in size', () => {
    expect(SECRET_PATTERNS.map((p) => p.name)).not.toContain(FUSED_AWS_PAIR_SPAN_NAME);
    expect(SECRET_PATTERNS).toHaveLength(13);
  });
});

/**
 * DETECTOR-RECALL REPLAY — the marker the self-merge gate looks for on a
 * detector change. This leg is ADDITIVE (it runs last and only sees runs no
 * prior leg captured), so no existing detector's true positives may stop
 * firing. Each block below replays a PRIOR true-positive shape and asserts it
 * STILL fires — on the redacted text AND on the span inventory — i.e. the
 * recall the fix must not trade away.
 */
describe('DETECTOR-RECALL REPLAY — prior true positives still fire after the a65bc528 leg', () => {
  // DETECTOR-RECALL REPLAY #1: the provider patterns (the commit gate's own set).
  it('DETECTOR-RECALL REPLAY: every provider-pattern true positive still redacts', () => {
    const cases: Array<[string, string, string]> = [
      ['AWS access key', 'token', AKID],
      ['GitHub token', 'token', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'],
      ['OpenAI/Anthropic-style key', 'token', 'sk-' + 'proj-FAKEFAKEFAKEFAKEFAKE1234'],
      ['Slack token', 'token', 'xoxb-' + '1234567890-FAKEFAKEFAKE'],
      ['Google API key', 'token', 'AIza' + 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123'],
    ];
    for (const [name, prefix, value] of cases) {
      const text = `${prefix} ${value}`;
      expect(findSecretSpans(text).map((s) => s.name)).toContain(name);
      expect(redactInboundSecrets(text)).toBe(`${prefix} ${NOTE}`);
    }
  });

  // DETECTOR-RECALL REPLAY #2: the 3b573ce3 fused-pair split, under a REAL tail label.
  it('DETECTOR-RECALL REPLAY: `…_SECRET_ACCESS_KEY=<fused>` still splits into exactly two spans', () => {
    const text = `CANLAW_CPT_S3_SECRET_ACCESS_KEY=${FUSED}`;
    const spans = findSecretSpans(text);
    expect(spans.map((s) => s.value)).toEqual([AKID, SECRET]);
    expect(spans.some((s) => s.value === FUSED)).toBe(false);
    expect(redactInboundSecrets(text)).toBe(`CANLAW_CPT_S3_SECRET_ACCESS_KEY=${NOTE}`);
  });

  // DETECTOR-RECALL REPLAY #3: the keyword/assignment leg, a NON-AWS credential under a recognised label.
  it('DETECTOR-RECALL REPLAY: a labelled non-AWS credential still redacts (the keyword leg is untouched)', () => {
    const text = 'api_key: sk-' + 'proj-FAKEFAKEFAKEFAKEFAKE1234';
    expect(findSecretSpans(text).length).toBeGreaterThanOrEqual(1);
    expect(redactInboundSecrets(text)).toBe(`api_key: ${NOTE}`);
  });

  // DETECTOR-RECALL REPLAY #4: the pre-existing exemption — a PATH reference is never a credential.
  it('DETECTOR-RECALL REPLAY: the private-key PATH reference exemption still holds (no new strike)', () => {
    const text = '"private_key": "\\/etc\\/ssl\\/private\\/key2024.pem"';
    expect(findSecretSpans(text)).toEqual([]);
    expect(redactInboundSecrets(text)).toBe(text);
  });

  // DETECTOR-RECALL REPLAY #5: clean text stays byte-identical — the standing non-true-positive floor.
  it('DETECTOR-RECALL REPLAY: clean prose is still returned byte-identical with zero hits', () => {
    const clean = 'Answer: yes, ship it — the region stays ca-central-1.';
    expect(redactSecrets(clean)).toEqual({ text: clean, hits: [] });
  });
});