/**
 * secret-scan replay pins (consolidated) — batch-train T3i (2026-10-17).
 *
 * Consolidation of the pure (mock-free) single-ticket replay suites that
 * pin this seam — one file per ticket became one file per seam. Every
 * original suite is preserved verbatim inside its own describe() (the
 * wrapper scopes each replay's module-level consts, so replays cannot
 * collide), and every ticket id stays greppable in its describe title:
 *   crossmodel/platform/secret-scan.4e8257c4.test.ts
 *   crossmodel/platform/secret-scan.8d15611c.test.ts
 *
 * Deliberately NOT consolidated here: the agent-derail-break family (78
 * files) — each replay carries its own jest.mock bodies (file-scoped; a
 * merge would collide mock registries), so those stay one-file-per-ticket.
 *
 * jest --findRelatedTests note: the seam-name prefix is kept so a change to
 * secret-scan.ts still selects this suite by name.
 */

import { redactSecrets, scanTextForSecrets, REDACTED_NOTE, findSecretSpans, SECRET_PATTERNS } from './secret-scan';
import { extractSecretForHandoff } from './secret-handoff-tools';

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/platform/secret-scan.4e8257c4.test.ts — replay ticket 4e8257c4 (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 4e8257c4 — consolidated from secret-scan.4e8257c4.test.ts', () => {
  // Synthetic throwaway shapes in the real Tailscale key format — never real key
  // material (tskey-auth-<keyUID>-<secret>; real secret halves are longer, the
  // regex needs ≥20 body chars which the fake padding provides).
  const FAKE_TSKEY = 'tskey-auth-' + 'kFAKE0123456789abcdefghijklmnop';
  const FAKE_TSKEY_BARE = 'tskey-auth-kFAKE0123456789abcdefghijklmnopqrstuvwxyz0123456789';
  const FAKE_TSKEY_VARIANT = 'tskey-client-' + 'FAKE0123456789abcdefghijklmnopqr';

  describe('audit 4e8257c4 — a Tailscale auth key never rides a machine wake prompt', () => {
    it('the shape is in the shared pattern set (redaction + commit-gate scan alike)', () => {
      expect(scanTextForSecrets(`join with ${FAKE_TSKEY}`)).toEqual(['Tailscale auth key']);
      expect(scanTextForSecrets(`join with ${FAKE_TSKEY_VARIANT}`)).toEqual(['Tailscale auth key']);
    });

    it('redactSecrets replaces the key with the visible note — bare paste, quoted, labelled, multiple occurrences', () => {
      const cases = [
        `join the tailnet: ${FAKE_TSKEY_BARE}`,
        `join the tailnet: "${FAKE_TSKEY}"`,
        `TS_AUTHKEY=${FAKE_TSKEY}`,
        `${FAKE_TSKEY} and again ${FAKE_TSKEY}`,
      ];
      for (const c of cases) {
        const { text } = redactSecrets(c);
        expect(text).not.toContain(FAKE_TSKEY);
        expect(text).not.toContain(FAKE_TSKEY_BARE);
        expect(text).toContain(REDACTED_NOTE);
      }
    });

    it('ACCEPTANCE (the 9d0d12bd specimen class): a hook summary quoting the key is redacted by the shared engine — the wake-path write seam pins this in hooks.audit-2026-10-06.t3.test.ts (redactHookSummary wraps this exact engine, kill-switch contract included there)', () => {
      // the specimen shape: the summary re-quotes the owner's pasted key; the
      // engine is what redactHookSummary runs at emit + delivery + direct wakes
      const summary = `lane done — the owner pasted this Tailscale key: ${FAKE_TSKEY} (join the tailnet)`;
      const { text, hits } = redactSecrets(summary);
      expect(text).not.toContain(FAKE_TSKEY);
      expect(text).toContain(REDACTED_NOTE);
      expect(hits).toEqual(['Tailscale auth key']);
    });

    it('benign tskey-adjacent prose never hits (no false-positive class)', () => {
      expect(scanTextForSecrets('the tskey format is documented at tailscale.com/kb/1085')).toEqual([]);
      expect(scanTextForSecrets('use TS_AUTHKEY from the environment, never paste it')).toEqual([]);
      // a SHORT body (<20 chars) is not the credential shape
      expect(scanTextForSecrets('tskey-auth-k123')).toEqual([]);
    });

    it('store_secret\'s lifter now SEES the shape (the 82dd8756 refusal class closed for Tailscale)', () => {
      // findSecretSpans is what store_secret lifts text through — before the
      // pattern, an owner's tskey paste returned no spans and the store was
      // refused no_secret_found
      const spans = findSecretSpans(`here is the key ${FAKE_TSKEY} for the tailnet`);
      expect(spans.map((s) => s.name)).toEqual(['Tailscale auth key']);
      expect(spans[0].value).toBe(FAKE_TSKEY);
    });
  });
});

// ═══════���═══════════════════════════════════════════════════════════════════
// modules/crossmodel/platform/secret-scan.8d15611c.test.ts — replay ticket 8d15611c (verbatim below, inside its own scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('replay 8d15611c — consolidated from secret-scan.8d15611c.test.ts', () => {
  // Synthetic values mirroring the MEASURED structure (probe receipts above),
  // grown to the exact live length by a deterministic filler — the source file
  // never holds one contiguous key literal, and the length assertion below pins
  // the magnitude (a future pattern edit that silently stops matching real-size
  // keys fails this suite).
  const grow = (head: string, target: number): string => {
    const alphabet = 'Ab1Cd2Ef3gH4iJ5kL6mN7oP8qR9sT0uV';
    let out = head;
    let i = 0;
    while (out.length < target) out += alphabet[i++ % alphabet.length];
    return out.slice(0, target);
  };
  // dotted body (3 dots live), mixed case + digits, 114 chars measured
  const ALI_TOKEN_PLAN = grow('sk-sp-Qw7Ab2.gH5iJ6kL.oP9qR', 114);
  // dotted body + underscores (116 measured)
  const ALI_METERED = grow('sk-ws-Za4Bc5.h7Ij8kL9.oPq1rS_tU3vW', 116);
  // xAI: pure-alnum body, 84 chars measured
  const XAI_KEY = grow('xai-Ab3cDe5fGh7iJk9lMn1pQr3sTu5vWx7yZ', 84);
  // OpenAI token-plan id: o1_ + dotted body with a hyphen, 129 chars measured
  const O1_PLAN = grow('o1_4Ns8aB-cD2eF4gH.iJ6kL8mN0pQ2rS.tU4vW6xY8zA0bC', 129);

  /** The specimen paste's SHAPE (8 bare tokens on their own lines, no KEY=value
   *  lines) — the gateway supervisor's probe saw only 4 candidates in it. */
  const OWNER_PASTE_REPLICA = [
    'here are the rest of the llm keys for the gateway',
    '',
    'alibaba token plan',
    ALI_TOKEN_PLAN,
    'alibaba metered',
    ALI_METERED,
    'xai',
    XAI_KEY,
    'openai token plan',
    O1_PLAN,
    '',
    'please bank these as well',
  ].join('\n');

  describe('8d15611c — the four provider shapes are visible to every scanner surface', () => {
    it('scanTextForSecrets names each of the four shapes (the 17:56Z probe saw none of them)', () => {
      expect(scanTextForSecrets(`Bearer ${ALI_TOKEN_PLAN}`)).toEqual(['Alibaba Model Studio key']);
      expect(scanTextForSecrets(`Bearer ${ALI_METERED}`)).toEqual(['Alibaba Model Studio key']);
      expect(scanTextForSecrets(`Bearer ${XAI_KEY}`)).toEqual(['xAI API key']);
      expect(scanTextForSecrets(`Bearer ${O1_PLAN}`)).toEqual(['OpenAI token-plan id']);
    });

    it('redactSecrets replaces each shape with the visible note — bare, quoted, labelled', () => {
      for (const [key] of [[ALI_TOKEN_PLAN], [ALI_METERED], [XAI_KEY], [O1_PLAN]] as const) {
        for (const c of [`use ${key}`, `"${key}"`, `DASHSCOPE_API_KEY=${key}`, `${key} and again ${key}`]) {
          const { text, hits } = redactSecrets(c);
          expect(text).not.toContain(key);
          expect(text).toContain('[REDACTED: looked like a credential]');
          expect(hits.length).toBeGreaterThan(0);
        }
      }
    });

    it('the shared pattern set entry order: the specific sk- shapes precede the generic one (containment)', () => {
      const names = SECRET_PATTERNS.map((p) => p.name);
      expect(names.indexOf('Alibaba Model Studio key')).toBeLessThan(names.indexOf('OpenAI/Anthropic-style key'));
    });

    it('a dotted sk-sp- key whose first dot-free segment is ≥20 chars is matched by the SPECIFIC pattern only — never two spans (the false-ambiguous trap)', () => {
      // The long-segment variant the live keys did not happen to have: without
      // the ordering, the generic sk- shape would ALSO match its first segment.
      const longSeg = 'sk-sp-' + 'AbcdEfghIjklMnopQrst1' + '.' + 'uvwXyz0123456789AbcdEfghIjklMnopQrstuv';
      const spans = findSecretSpans(`key: ${longSeg}`);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ name: 'Alibaba Model Studio key', value: longSeg });
    });

    it('benign prose never hits (no false-positive class)', () => {
      expect(scanTextForSecrets('the sk-sp- prefix denotes an alibaba token-plan key')).toEqual([]);
      expect(scanTextForSecrets('sk-sp-short sk-ws-also-short xai-tiny o1_what')).toEqual([]);
      expect(scanTextForSecrets('a o1_ prose fragment never matches the shape')).toEqual([]);
      expect(scanTextForSecrets('xai-rocket-4 is a model name, not a key (body too short)')).toEqual([]);
    });
  });

  describe('8d15611c — store_secret lifts the four shapes out of the owner paste', () => {
    it('each shape alone ⇒ ok (was invisible: the 17:56Z probe offered only the 4 batch-1 keys)', () => {
      expect(extractSecretForHandoff(`here is the key ${ALI_TOKEN_PLAN}`, 'ALIBABA_TOKEN_PLAN_KEY', null))
        .toEqual({ ok: true, value: ALI_TOKEN_PLAN, pattern: 'Alibaba Model Studio key' });
      expect(extractSecretForHandoff(`here is the key ${ALI_METERED}`, 'ALIBABA_METERED_KEY', null))
        .toEqual({ ok: true, value: ALI_METERED, pattern: 'Alibaba Model Studio key' });
      expect(extractSecretForHandoff(`here is the key ${XAI_KEY}`, 'XAI_API_KEY', null))
        .toEqual({ ok: true, value: XAI_KEY, pattern: 'xAI API key' });
      expect(extractSecretForHandoff(`here is the key ${O1_PLAN}`, 'OPENAI_TOKEN_PLAN_ID', null))
        .toEqual({ ok: true, value: O1_PLAN, pattern: 'OpenAI token-plan id' });
    });

    it('the full 8-key paste SHAPE ⇒ every shape is a candidate (which picks any of them)', () => {
      const found = extractSecretForHandoff(OWNER_PASTE_REPLICA, 'LLM_KEYS', null);
      // ambiguous is CORRECT here (4+ candidates) — but now all four families
      // are OFFERED, which is the todo's acceptance (before: only already-
      // stored batch-1 shapes appeared).
      expect(found).toMatchObject({ ok: false, reason: 'ambiguous' });
      if (found.ok || found.reason !== 'ambiguous') throw new Error('unreachable');
      const patterns = found.candidates.map((c) => c.pattern);
      expect(patterns).toContain('Alibaba Model Studio key');
      expect(patterns).toContain('xAI API key');
      expect(patterns).toContain('OpenAI token-plan id');
      // Containment proof: exactly one candidate per token (4), each measured
      // length appears once, and the GENERIC sk- shape claims none of them —
      // the specific pattern consumed both Alibaba tokens first (before this
      // change the dotted keys produced no span at all; without the list-order
      // fix they could have produced TWO: specific + generic ⇒ false ambiguous).
      expect(found.candidates).toHaveLength(4);
      expect(patterns).not.toContain('OpenAI/Anthropic-style key');
      expect(found.candidates.map((c) => c.chars).sort((a, b) => a - b)).toEqual([84, 114, 116, 129]);
      const pick = extractSecretForHandoff(OWNER_PASTE_REPLICA, 'LLM_KEYS', 1);
      expect(pick).toEqual({ ok: true, value: ALI_TOKEN_PLAN, pattern: 'Alibaba Model Studio key' });
    });

    it('candidate char counts match the real-key magnitudes (114/116/84/129 measured live)', () => {
      expect(ALI_TOKEN_PLAN.length).toBe(114);
      expect(ALI_METERED.length).toBe(116);
      expect(XAI_KEY.length).toBe(84);
      expect(O1_PLAN.length).toBe(129);
    });
  });
});
