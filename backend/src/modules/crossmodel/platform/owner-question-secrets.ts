/**
 * OWNER-QUESTION SECRET DELIVERY (ticket 26786762, 2026-10-17).
 *
 * THE MISHAP: flag_owner_question redacted question/context AT WRITE TIME
 * (owner-questions.ts redactInboundSecrets at the create-path entry), so a
 * lane delivering a credential to the owner — the owner's own directive
 * ("send me the api key") — filed a card whose stored text read
 * "[REDACTED: looked like a credential]" exactly where the key was. The one
 * thing the card existed to deliver never reached the owner, while the flag
 * result said ok (the filing lane cannot see the owner-side render). There
 * was NO agent→owner credential-value channel: store_secret lifts values
 * only from owner-authored messages, and the coding-credentials vault is
 * write-only.
 *
 * THE FIX — the symmetric counterpart of the owner→fleet answer vault
 * (ticket 50bcd1e7, vaultOwnerAnswerSecrets), in reverse:
 *  - IMPLICIT RESCUE: at flag time the spans the inbound scan WOULD destroy
 *    are captured (redactInboundSecretsWithNotes) and stored here, ENCRYPTED
 *    (AES-256-GCM via credentials.service encryptValue, key derived from
 *    JWT_SECRET — the same vault the coding credentials use); the card text
 *    carries a numbered reveal handle ("[SECRET 1]") instead of the
 *    destruction marker.
 *  - EXPLICIT DELIVERY (deliverSecrets): a first-class param for shapes the
 *    scanner does not know (the documented refusal class — a provider
 *    prefix SECRET_PATTERNS never learned). The value is delivered ONLY to
 *    this store; every agent-authored surface around the flag call
 *    (question/context, the console spec's slots, option labels/ids, the
 *    persisted tool-call args preview and the streak-args snapshots) is
 *    masked, scrubbed to a reveal handle, or degraded whole — see the seam
 *    map in the tests. Known residual (out of scope, ticketed separately):
 *    agent_runs.checkpoint persists raw tool_calls until terminal on
 *    origin/main (the store_secret class).
 *  - REVEAL: an owner-authed REST endpoint decrypts on demand; the card
 *    renders a Reveal/Copy affordance per secret. Reveal is scoped to the
 *    row's owner (the userId the flag was filed for) — a project member
 *    reading the question through list_owner_questions sees the placeholder
 *    text and never the value.
 *
 * SECURITY MODEL:
 *  - Values encrypted at rest with the platform's existing credentials key
 *    (sha256("digby-coding-credentials:" + JWT_SECRET)); rotating JWT_SECRET
 *    invalidates stored values (they were one-delivery — the card still
 *    carries its text; the reveal then reports unreadable).
 *  - The store NEVER returns a value to an agent surface: reveal is REST +
 *    owner-scoped only; list projections carry a masked preview (last 4).
 *  - Implicit-rescue values are SINGLE-LINE only (multi-line/PEM values stay
 *    destroyed exactly as before — the agent is told to use deliverSecrets).
 *  - Kill switch OWNER_SECRET_DELIVERY_DISABLED=1 returns the create path to
 *    the pre-fix destruction behavior and refuses explicit deliveries with
 *    a reason (never a silent drop — a delivery the agent believes succeeded
 *    is the exact mishap class this module exists to end). One independent
 *    refusal stands on BOTH sides of the switch: consoleAction.payload
 *    carrying credential material is refused (ticket 1b1c41bc's
 *    fail-closed posture — a payload credential is a compose-spec defect,
 *    not a delivery), and consoleAction.consoleUrl echoing a delivered
 *    value is refused (a scrubbed URL is a broken link).
 *
 * Like owner-questions.ts, this module keeps prisma/credentials imports LAZY
 * (call-time dynamic import) so a static import of it never drags
 * config/database's env-validating chain into a Jest graph.
 */

import { randomUUID } from 'crypto';
import { findSecretSpans, redactInboundSecrets, type SecretSpan } from './secret-scan';

/** Kill switch for the whole delivery path (create + reveal degrade). */
export function oqSecretDeliveryDisabled(): boolean {
  return process.env.OWNER_SECRET_DELIVERY_DISABLED === '1';
}

/** Max implicit spans rescued from one flag's text (mirrors the answer
 *  path's OQ_VAULT_MAX_SPANS — a bounded rescue, never a storage firehose;
 *  spans beyond the cap keep the pre-fix destruction marker). */
export const OQ_IMPLICIT_SECRET_CAP = 3;
/** Max explicit deliverSecrets entries on one flag. Over cap REFUSES the
 *  flag (never silently drops a value the agent believes was delivered). */
export const OQ_EXPLICIT_SECRET_CAP = 3;
/** Combined hard cap per question (implicit kept + explicit). */
export const OQ_SECRET_TOTAL_CAP = 6;
/** Max length of a delivered value (mirrors credentials MAX_VALUE_LEN). */
export const OQ_SECRET_VALUE_MAX = 8192;
/** Max length of an explicit secret's display label. */
export const OQ_SECRET_LABEL_MAX = 120;

/** What a delivered value is replaced with in every PREVIEW surface (tool
 *  call args, transcript parts, SSE events) — the value itself never rides
 *  a preview seam (review BLOCKING 1, ticket 26786762 rework). */
export const DELIVERED_VALUE_MASK = '[delivered — encrypted, not echoed]';

/** Whole-field degrade marker for a NON-CANONICAL delivery-bearing args
 *  object (review BLOCKING G1, round 6): nested / case-variant / snake-case /
 *  array-root shapes the canonical branch cannot project safely. A neutral
 *  string — never the args text (which carries the raw value). */
export const DELIVERY_BEARING_ARGS_NOTE = '[redacted — tool args carried deliverSecrets material]';

/** The KEYWORDS a delivery-bearing tool call can carry, normalized for
 *  detection (review BLOCKING F′, round 5 + G1 riding item, round 6): the
 *  field name in any case (`DeliverSecrets`), any separator family
 *  (`deliver_secrets`, `deliver-secrets`, `deliver secrets`), any \uXXXX /
 *  \u{XXXX} / \UXXXXXXXX escape encoding of it — after unicode-decode +
 *  lower-case they are all `deliver…secrets` with optional separators.
 *  FAIL-SAFE direction: prose that merely mentions the field name also
 *  trips detection (the review's standing trade: a lost diagnostic snapshot
 *  is better than a leaked value). */
const DELIVERY_KEYWORD_RE = /deliver[\s\\/_-]*secrets?/i;

/** Review BLOCKING F′ + G1: normalize a raw string for delivery-shape
 *  detection — decode \uXXXX / \u{…} / \UXXXXXXXX escapes (case-insensitive
 *  hex; exotica per the round-6 riding item), then match the separator-family
 *  keyword (case-insensitive). Pure; never throws. */
export function isDeliveryBearingText(normalizedSource: string): boolean {
  return DELIVERY_KEYWORD_RE.test(decodeUnicodeEscapes(String(normalizedSource ?? '')));
}

/** Sibling fields (besides deliverSecrets) of a parsed tool-args object.
 *  Review BLOCKING G2 (round 6) + H2/H3/H4 (round 7): the same value echoed
 *  in a sibling — top-level string OR nested object/array leaf
 *  (meta.note, notes[0], any depth) — rides the seam raw while the canonical
 *  field is masked. Exact echo (split/join, ≥8-char floor) catches
 *  scanner-UNKNOWN delivered values; the span scan catches anything the
 *  inbound scanner itself knows. The walk is NODE-COUNT bounded (not depth
 *  bounded — a depth cap leaked a value nested 6 deep in round 7's G5
 *  probe), so a pathological shape cannot stall the preview path. */
interface StringLeaf { s: string; key: string | null }

/** A1 (round 8 riding): the walk budget FAILS CLOSED — when the node budget
 *  dies mid-walk, `exhausted` is set and the callers degrade whole (a
 *  value past the 64th leaf rode the seam raw when the walk silently
 *  stopped; "cannot prove safe" must mean MASK, not pass). */
interface WalkBudget { nodes: number; exhausted?: boolean }

function collectStringLeaves(node: unknown, key: string | null, out: StringLeaf[], budget: WalkBudget): void {
  if (out.length >= 64) { budget.exhausted = true; return; }
  if (budget.nodes <= 0) { budget.exhausted = true; return; }
  budget.nodes -= 1;
  if (node === null || node === undefined) return;
  if (typeof node === 'string') { if (node.trim()) out.push({ s: node, key }); return; }
  // H4 (round 7): parseDeliverSecrets STRINGIFIES non-string value slots
  // (a number 86421357 IS delivered as "86421357") — collect primitives too.
  if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') {
    out.push({ s: String(node), key });
    return;
  }
  if (typeof node === 'object') {
    if (Array.isArray(node)) {
      for (const el of node) collectStringLeaves(el, null, out, budget);
    } else {
      for (const [k, v] of Object.entries(node)) collectStringLeaves(v, k, out, budget);
    }
  }
}

/** Every string leaf under the deliverSecrets field of ANY shape (canonical
 *  entries, bare strings, nested value keys, unnamed keys, stringified
 *  primitives) — the ECHO candidate set for the sibling scan (review H2/G5/
 *  G6: an unnamed-key or depth-6 value is still the material a sibling must
 *  not echo). Bounded by node count. */
/** A1 (round 8): the candidate-collection result — `exhausted` means the
 *  walk hit its budget and the candidate set is TRUNCATED (the caller must
 *  degrade whole: a truncated set cannot prove the siblings safe). */
interface CandidateWalk { values: string[]; exhausted: boolean }

function deliveryEchoCandidates(field: unknown): CandidateWalk {
  const leaves: StringLeaf[] = [];
  const budget: WalkBudget = { nodes: 256 };
  collectStringLeaves(field, null, leaves, budget);
  return { values: leaves.map((l) => l.s), exhausted: !!budget.exhausted };
}

/** The VALUE-ish subset for the LABEL-slot gate: every leaf EXCEPT label-slot
 *  strings — the label must not "self-echo" against itself or a sibling
 *  label (round 8: all-leaf candidates broke the round-3 B′ pins this way),
 *  but a label echoing a value/note/bare-element leaf still degrades. */
function deliveryValueIsh(field: unknown): string[] {
  const leaves: StringLeaf[] = [];
  collectStringLeaves(field, null, leaves, { nodes: 256 });
  return leaves.filter((l) => l.key !== 'label').map((l) => l.s);
}

/** Walk a sibling value RECURSIVELY (objects and arrays included) and hit
 *  when any string leaf echoes a candidate or scans as a credential. A1
 *  (round 8): budget exhaustion FAILS CLOSED — returns true (degrade). */
function siblingScanHits(args: Record<string, unknown>, candidates: string[]): boolean {
  const leaves: StringLeaf[] = [];
  const budget: WalkBudget = { nodes: 256 };
  for (const [k, v] of Object.entries(args)) {
    if (k === 'deliverSecrets') continue;
    collectStringLeaves(v, k, leaves, budget);
  }
  if (budget.exhausted) return true;
  for (const leaf of leaves) {
    for (const dv of candidates) {
      if (dv && dv.length >= 8 && leaf.s.split(dv).length > 1) return true;
    }
    if (findSecretSpans(leaf.s).length > 0) return true;
  }
  return false;
}

/**
 * Review BLOCKING 1 (ticket 26786762 rework): mask `deliverSecrets[].value`
 * in a tool-call args PREVIEW before it is stamped into transcript parts /
 * emitted over SSE / persisted to coding_messages. The executor keeps the
 * REAL parsed args — only the preview copy is masked. Pure; returns the
 * input object untouched when it carries no deliverSecrets (every other
 * tool call pays nothing). Exported for the transcript-scrub regression
 * test.
 *
 * Review BLOCKING B (adjudicated re-review): the part is stamped BEFORE
 * execution, so a call the executor will later REFUSE still persists its
 * args — the mask must hold for NON-CANONICAL shapes too (a double-encoded
 * array, a bare string, a non-string value). When deliverSecrets is present
 * but not the canonical array-of-{string value} shape, the WHOLE field is
 * masked: anything that might carry a value is redacted on a preview seam.
 */
export function maskDeliverSecretsForPreview<T>(args: T): T {
  if (args === null || args === undefined) return args;
  // Review BLOCKING G1 (round 6), primitive shape: a malformed call whose
  // arguments parse to a bare primitive (JSON.parse('"…"') → string) — the
  // part would carry it verbatim. Keyword or span detection decides; a hit
  // degrades to the note.
  if (typeof args !== 'object') {
    const text = typeof args === 'string' ? args : String(args);
    return ((isDeliveryBearingText(text) || findSecretSpans(text).length > 0)
      ? DELIVERY_BEARING_ARGS_NOTE
      : args) as unknown as T;
  }
  // Review BLOCKING G1 (round 6), array-root shape: the args object itself
  // is an array (a model that wrapped the call) — there is no top-level
  // object to project; the normalized detection over the serialized form
  // decides, and a hit degrades the WHOLE args to the note.
  if (Array.isArray(args)) {
    return (isDeliveryBearingText(JSON.stringify(args))
      ? DELIVERY_BEARING_ARGS_NOTE
      : args) as unknown as T;
  }
  const a = args as Record<string, unknown>;
  if (!('deliverSecrets' in a)) {
    // Review BLOCKING G1 (round 6) + H1 (round 7): NO canonical top-level
    // field — but a nested (`payload.deliverSecrets`), case-variant
    // (`DeliverSecrets`), snake-case (`deliver_secrets`) encoding still
    // carries the value, AND the IMPLICIT-RESCUE class (a scanner-known
    // credential in question/context with NO deliverSecrets at all — the
    // ORIGINAL specimen class of this ticket) rides the persisted part raw
    // while the service vaults it and the card shows the handle. Two legs:
    // the normalized keyword scan AND the span scan (findSecretSpans) over
    // the serialized object; either hit degrades the WHOLE args.
    const serialized = JSON.stringify(args);
    if (isDeliveryBearingText(serialized) || findSecretSpans(serialized).length > 0) {
      return DELIVERY_BEARING_ARGS_NOTE as unknown as T;
    }
    return args;
  }
  const ds = a.deliverSecrets;
  // Review BLOCKING G2 (round 6): collect the VALUE candidates from the
  // deliverSecrets field of ANY shape (canonical entries, bare strings,
  // nested value keys) and scan the SIBLING fields for an exact echo or a
  // scanner-known credential — the same value echoed in `note`, `context`
  // or `question` would ride the seam raw while the canonical field is
  // masked (the executor vaults the canonical one either way:
  // executorDelivers=true in the reviewer's probe). A hit degrades the
  // WHOLE args, on the canonical AND the non-canonical branch alike.
  // H2/H4 (round 7): the echo candidate set is EVERY string leaf + String()
  // of primitives under the deliverSecrets field of ANY shape (canonical
  // entries, bare strings, nested/unnamed value keys, stringified numbers) —
  // node-count bounded. A1 (round 8): budget exhaustion fails CLOSED — a
  // truncated candidate set cannot prove the siblings safe, degrade whole.
  const candidateWalk = deliveryEchoCandidates(ds);
  if (candidateWalk.exhausted) {
    return DELIVERY_BEARING_ARGS_NOTE as unknown as T;
  }
  const valueCandidates = candidateWalk.values;
  // Non-label leaves for the label-slot gate (the label never self-echoes).
  const valueIsh = deliveryValueIsh(ds);
  // H3 (round 7): a delivery-bearing SIBLING KEY (DeliverSecrets /
  // deliver_secrets beside the canonical field) carries values the scan
  // never collected — degrade the whole args.
  if (Object.keys(a).some((k) => k !== 'deliverSecrets' && isDeliveryBearingText(k))) {
    return DELIVERY_BEARING_ARGS_NOTE as unknown as T;
  }
  if (siblingScanHits(a, valueCandidates)) {
    return DELIVERY_BEARING_ARGS_NOTE as unknown as T;
  }
  if (Array.isArray(ds) && ds.length > 0 && ds.every((e: unknown) =>
    !!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as Record<string, unknown>).value === 'string')) {
    // Review BLOCKING B′ (round 3) + G2 label-echo (round 6): PROJECT to a
    // known-safe shape — never spread the entry. `label` and any extra key
    // (a model that puts the key in `note`, or in `label` itself) would
    // otherwise ride the preview seam verbatim while `value` alone is
    // masked. The label survives only when it is credential-free under the
    // inbound scan AND does not echo any delivered value (a scanner-UNKNOWN
    // value pasted into the label slot — the scan alone cannot see it);
    // anything else degrades to the neutral 'Credential'.
    const effectiveLabel = (e: Record<string, unknown>): string => {
      const raw = typeof e.label === 'string' ? e.label : '';
      // Non-label leaves only — the label never self-echoes (round 8).
      if (raw && valueIsh.some((v) => v && raw.split(v).length > 1)) return 'Credential';
      return safeDeliveredLabel(raw);
    };
    const masked = (ds as Array<Record<string, unknown>>).map((e) => ({
      label: effectiveLabel(e),
      value: DELIVERED_VALUE_MASK,
    }));
    return { ...a, deliverSecrets: masked } as unknown as T;
  }
  // Non-canonical (an empty array passes through harmlessly below; anything
  // else — double-encoded JSON, a bare value, non-string value slots — is
  // masked wholesale).
  if (Array.isArray(ds) && ds.length === 0) return { ...a, deliverSecrets: [] } as unknown as T;
  return { ...a, deliverSecrets: DELIVERED_VALUE_MASK } as unknown as T;
}

/** The label a delivered secret shows on SAFE surfaces (preview seams, the
 *  flag-result manifest): the raw label survives ONLY when it is
 *  credential-free under the inbound scan (the same gate every
 *  consoleAction field runs — review B″/B′, round 4); anything else
 *  degrades to the neutral 'Credential'. Exported for the manifest seam. */
export function safeDeliveredLabel(raw: unknown): string {
  const rawLabel = typeof raw === 'string' ? raw.trim().slice(0, OQ_SECRET_LABEL_MAX) : '';
  return rawLabel && redactInboundSecrets(rawLabel) === rawLabel ? rawLabel : 'Credential';
}

/** Review BLOCKING G3 (round 6): the label a delivered secret PERSISTS with
 *  (owner_question_secrets.label, rendered on the card and returned by
 *  reveal). The schema encrypts only valueEnc — a credential-shaped label
 *  rode into storage in PLAINTEXT (probed: stored raw + rendered on the
 *  card while the manifest showed 'Credential'). Two gates: (1) the inbound
 *  scan (scanner-known shapes), (2) an EXACT-ECHO check against every
 *  delivered value on the card — a scanner-UNKNOWN value (cfat_… class)
 *  pasted into the label slot is invisible to the scan alone. Anything that
 *  fails either gate degrades to 'Credential'; the value still decrypts.
 *  Exported for the store + deliverable-construction seams. */
export function safeDeliverableLabel(raw: unknown, deliveredValues: string[]): string {
  const base = safeDeliveredLabel(raw);
  if (base === 'Credential') return base;
  for (const v of deliveredValues) {
    if (v && base.split(v).length > 1) return 'Credential';
  }
  return base;
}

/** Decode \uXXXX, \u{XXXX} and \UXXXXXXXX escapes (case-insensitive hex) —
 *  a `deliver\u0053ecrets` key is the field name to the executor's JSON.parse
 *  but INVISIBLE to a plain includes() scan (review BLOCKING F′, round 5;
 *  exotica per the round-6 riding item — fail-safe direction argues for
 *  decoding them). Applied TWICE (a double-escaped `\\u0053` still decodes
 *  on the second pass). Pure. */
function decodeUnicodeEscapes(s: string): string {
  const once = s
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h: string) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_m, h: string) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    });
  return once === s ? s : decodeUnicodeEscapes(once);
}

/**
 * The same mask for a RAW tool-arguments STRING (the streak-args capture
 * seams in coding/agent.ts hold `String(tc.arguments)` — JSON text, not a
 * parsed object; review BLOCKING A). Review BLOCKING D (round 4): an input
 * that CONTAINS deliverSecrets but does not parse (a stream-truncated call)
 * is redacted WHOLE. Review BLOCKING F′ (round 5): the detection is
 * PARSE-FIRST, then a NORMALIZED raw scan (lower-cased, \uXXXX-decoded)
 * that fires even when the parse succeeded — a nested
 * `payload.deliverSecrets`, a case-variant `DeliverSecrets`, or an escaped
 * `deliver\u0053ecrets` key is delivery-shaped content the parse-shape guard
 * alone cannot see (the escaped shape even DELIVERS: JSON.parse decodes the
 * key, so the value is vaulted while the raw string rode the seam).
 *
 * TRADE (fail-safe, deliberate): an ordinary call whose PROSE merely
 * mentions "deliverSecrets" with no top-level field also loses its streak
 * args to the whole-string redaction — better a lost diagnostic snapshot
 * than a leaked value.
 *
 * Never throws.
 */
export function maskDeliverSecretsInArgsString(raw: string): string {
  const s = String(raw ?? '');
  // Parse first: a parseable object whose TOP-LEVEL shape carries the field
  // gets the SURGICAL mask (values masked, labels projected, the rest of
  // the call readable).
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const a = parsed as Record<string, unknown>;
      if ('deliverSecrets' in a) {
        const masked = maskDeliverSecretsForPreview(parsed);
        // Round 6 (G1/G2): the object mask now DEGRADES non-canonical and
        // sibling-echo shapes to a NOTE STRING — return it verbatim, never
        // JSON.stringify a string (which would quote it).
        if (typeof masked === 'string') return masked;
        return JSON.stringify(masked);
      }
      // Parse succeeded but no top-level field — FALL THROUGH to the
      // normalized scan (a nested / case-variant mention must still fire).
    }
  } catch {
    /* fall through to the normalized scan */
  }
  // Normalized scan (round 5 F′ + round 6 riding item) + SPAN LEG (round 7
  // H1): any encoding of the field name anywhere in the string — case
  // variants, the separator family (deliver_secrets / deliver-secrets /
  // deliver secrets), \uXXXX / \u{…} / \UXXXXXXXX escapes — OR any
  // scanner-known credential span (the implicit-rescue class: a credential
  // in question/context with no deliverSecrets at all — the original
  // specimen class of this ticket, riding the streak seams raw while the
  // service vaults it) — the WHOLE string is redacted (no surgical replace
  // on a shape we cannot prove safe). No hit → byte-identical.
  if (isDeliveryBearingText(s) || findSecretSpans(s).length > 0) {
    return DELIVERY_BEARING_ARGS_NOTE;
  }
  return s;
}

/** The reveal handle written into card text where a rescued span sat.
 *  Numbered, 1-based, in span order. Stable format — the pending surface
 *  and the UI pattern-match it to render the affordance. */
export function oqSecretPlaceholder(ordinal: number): string {
  return `[SECRET ${ordinal}]`;
}

/** A stored-value shape the implicit rescue accepts: non-empty, single-line
 *  (no PEM/multi-line — those stay destroyed; deliverSecrets handles them
 *  with explicit intent), within the vault's value budget, and not itself
 *  an already-redacted marker. Pure. */
export function storableSpanValue(value: string): boolean {
  const v = String(value ?? '');
  if (!v.trim()) return false;
  if (v.length > OQ_SECRET_VALUE_MAX) return false;
  if (/[\n\r\0]/.test(v)) return false;
  if (/^\[REDACTED/i.test(v.trim())) return false;
  return true;
}

/**
 * Build the implicit-rescue note callback for ONE redaction pass, drawing
 * ordinals from a SHARED counter (question / context / options / console
 * spec passes of one flag all number into the same sequence — the reveal
 * handles on the card must be globally unique). `spans` is the pass's span
 * sink (redactInboundSecretsWithNotes pushes each matched span then calls
 * noteFor, so the LAST element is the just-matched span). Kept spans
 * (storable, under the shared cap) get a numbered handle; everything else
 * keeps the destruction marker, exactly as pre-fix. `kept` is what the
 * caller persists. Pure given the counter; exported for tests.
 */
export interface SpanRescueCounter {
  /** Next ordinal to assign (starts at 1 + explicitCount; shared across every pass of one flag). */
  next: number;
  /** The counter value when the FIRST pass began. The implicit budget is
   *  PER-CARD: at most OQ_IMPLICIT_SECRET_CAP spans kept across EVERY pass
   *  of one flag (counter.next − start), never per-pass (review BLOCKING C —
   *  a per-rescuer count doubled the documented cap). */
  start: number;
}

export function buildSpanRescuer(
  spans: SecretSpan[],
  counter: SpanRescueCounter,
): {
  noteFor: () => string;
  kept: Array<{ ordinal: number; value: string; name: string }>;
} {
  const kept: Array<{ ordinal: number; value: string; name: string }> = [];
  const noteFor = (): string => {
    const span = spans[spans.length - 1];
    if (!span) return '[REDACTED: looked like a credential]';
    // Ticket 26786762 rework (review BLOCKING C): the implicit budget is
    // PER-CARD — the counter is shared across every pass (question, context)
    // and only increments for KEPT spans, so (counter.next − counter.start)
    // is the number of implicit spans already vaulted on THIS card; beyond
    // the cap the span keeps the pre-fix destruction marker. (A per-rescuer
    // count would double the budget: one rescuer per pass.)
    if (counter.next - counter.start >= OQ_IMPLICIT_SECRET_CAP) return '[REDACTED: looked like a credential]';
    if (!storableSpanValue(span.value)) return '[REDACTED: looked like a credential]';
    const ordinal = counter.next;
    counter.next += 1;
    kept.push({ ordinal, value: span.value, name: span.name });
    return oqSecretPlaceholder(ordinal);
  };
  return { noteFor, kept };
}

/** One validated explicit delivery entry. */
export interface ExplicitSecretEntry {
  label: string;
  value: string;
}

/**
 * Validate the deliverSecrets param shape (sync — value well-formedness that
 * needs the credentials module's PEM check is finished in
 * validateExplicitSecretValue). Refuses (never trims to fit): a non-array, a
 * missing/blank value, an over-cap array, an over-budget value or label, or
 * an already-redacted marker as the value. A label is optional and defaults
 * to 'Credential'. Pure; exported for tests.
 */
export function parseDeliverSecrets(raw: unknown): { ok: true; entries: ExplicitSecretEntry[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, entries: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'deliverSecrets must be an array of {label?, value}' };
  if (raw.length > OQ_EXPLICIT_SECRET_CAP) {
    return { ok: false, error: `deliverSecrets carries ${raw.length} entries — the cap is ${OQ_EXPLICIT_SECRET_CAP} per card; split the delivery or use the vault` };
  }
  const entries: ExplicitSecretEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: 'deliverSecrets entries must be objects {label?, value}' };
    const value = String((e as any).value ?? '');
    if (!value.trim()) return { ok: false, error: 'deliverSecrets entry with an empty value — deliver real values only' };
    if (value.length > OQ_SECRET_VALUE_MAX) return { ok: false, error: `deliverSecrets value over ${OQ_SECRET_VALUE_MAX} chars` };
    if (/^\[REDACTED/i.test(value.trim())) return { ok: false, error: 'deliverSecrets value is already a redaction marker — deliver the real value' };
    let label = String((e as any).label ?? '').trim().slice(0, OQ_SECRET_LABEL_MAX);
    if (!label) label = 'Credential';
    entries.push({ label, value });
  }
  return { ok: true, entries };
}

/**
 * Finish explicit-value validation with the credentials module's own
 * well-formedness (multi-line values are accepted ONLY as a complete,
 * well-formed PEM block — the same rule upsertCredential enforces; a
 * \n-escaped paste is unescaped first). Returns the normalized value, or
 * null to REFUSE that entry's delivery (the caller must refuse the whole
 * flag — a partially-delivered card is the silent-drop mishap again).
 * Async (lazy import); never throws.
 */
export async function validateExplicitSecretValue(value: string): Promise<string | null> {
  let v = String(value ?? '');
  try {
    if (/\\[nrt]/.test(v)) v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    if (/^["']/.test(v) && /["']$/.test(v) && v.length >= 2) v = v.slice(1, -1);
    v = v.trim();
    if (!v) return null;
    if (/[\n\r\0]/.test(v) || /^-----BEGIN\b/.test(v)) {
      const creds: any = await import('../coding/credentials.service');
      if (typeof creds?.isPemBlock !== 'function' || !creds.isPemBlock(v)) return null;
    }
    return v;
  } catch {
    return null;
  }
}

/** What gets persisted for one delivered secret. */
export interface DeliverableSecret {
  ordinal: number;
  label: string;
  value: string;
  /** Which scanner pattern rescued an implicit span, or 'explicit'. */
  origin: string;
}

/**
 * Persist the delivery set for a JUST-CREATED question row. Values are
 * encrypted (encryptValue — AES-256-GCM, credentials key); rows are
 * id-stamped oqs_<uuid> and unique on (questionId, ordinal). Best-effort on
 * the audit/metric legs, FAIL-LOUD on the store itself (the caller refuses
 * the flag when the store write fails — never a card whose reveal 404s).
 * Returns the stored count. Async; lazy prisma/credentials imports.
 */
export async function storeQuestionSecrets(
  prisma: any,
  userId: string,
  questionId: string,
  secrets: DeliverableSecret[],
): Promise<number> {
  if (!secrets.length) return 0;
  const creds: any = await import('../coding/credentials.service');
  if (typeof creds?.encryptValue !== 'function') throw new Error('credentials vault unavailable');
  // Review BLOCKING G3 (round 6): the label persists in PLAINTEXT (the
  // schema encrypts only valueEnc) and renders on the card — sanitize at the
  // STORE choke point, where every deliverable on the card is in hand: the
  // inbound scan gate plus an exact-echo check against every delivered VALUE
  // (a scanner-unknown value pasted into a label slot is invisible to the
  // scan alone). A label that fails either gate degrades to 'Credential';
  // the value still decrypts.
  const allValues = secrets.map((s) => s.value);
  const data = secrets.map((s) => ({
    id: `oqs_${randomUUID()}`,
    questionId,
    userId,
    ordinal: s.ordinal,
    label: safeDeliverableLabel(s.label, allValues).slice(0, OQ_SECRET_LABEL_MAX),
    valueEnc: creds.encryptValue(s.value),
    spanName: s.origin,
  }));
  await prisma.ownerQuestionSecret.createMany({ data });
  try {
    await prisma.activity.create({
      data: {
        userId,
        action: 'owner_question_secret.deliver',
        resource: 'platform',
        metadata: { questionId, secrets: data.length, origin: 'flag_owner_question' },
      },
    }).catch(() => { /* audit row is best-effort */ });
  } catch { /* activity table absent in some test graphs — never fail */ }
  return data.length;
}

/** A masked preview: last 4 chars only (the value NEVER leaves this module
 *  except through revealQuestionSecret, which is owner-scoped REST). */
function maskValue(v: string): string {
  return `••••${v.length > 4 ? v.slice(-4) : ''}`;
}

/** List projection for the owner's pending payload: ordinals + labels +
 *  masked previews. Owner-scoped by construction (the pending list IS the
 *  owner's); null on any read failure (tolerant seam — the card still
 *  renders, the affordance just hides). */
export async function listQuestionSecretPreviews(
  prisma: any,
  userId: string,
  questionId: string,
): Promise<Array<{ ordinal: number; label: string; preview: string }>> {
  try {
    const rows = await prisma.ownerQuestionSecret.findMany({
      where: { questionId, userId },
      orderBy: { ordinal: 'asc' },
    });
    const creds: any = await import('../coding/credentials.service');
    if (typeof creds?.decryptValue !== 'function') return [];
    return (rows ?? []).map((r: any) => {
      let preview = '••••';
      try { preview = maskValue(creds.decryptValue(r.valueEnc)); } catch { /* rotated key — keep the blank mask */ }
      return { ordinal: Number(r.ordinal), label: String(r.label ?? 'Credential'), preview };
    });
  } catch {
    return [];
  }
}

/** Reveal outcome. 'unreadable' = the stored value no longer decrypts
 *  (JWT_SECRET rotated) — the card text still stands. */
export type RevealResult =
  | { ok: true; ordinal: number; label: string; value: string }
  | { ok: false; reason: 'not_found' | 'unreadable' };

/**
 * Decrypt ONE delivered secret for the OWNER. Scoped to (questionId,
 * userId): a row filed for another owner never resolves. Increments the
 * reveal counters and records the audit row + metric (best-effort). Async;
 * never throws.
 *
 * RETENTION: delivered secrets persist with their question row (answered /
 * dismissed cards keep them — the owner may re-reveal a value they did not
 * copy; the coding-credentials vault keeps values the same way). Encrypted
 * at rest; no agent surface reads a value back, ever.
 */
export async function revealQuestionSecret(
  prisma: any,
  userId: string,
  questionId: string,
  ordinal: number,
): Promise<RevealResult> {
  try {
    const row = await prisma.ownerQuestionSecret.findFirst({
      where: { questionId, userId, ordinal },
    });
    if (!row) return { ok: false, reason: 'not_found' };
    const creds: any = await import('../coding/credentials.service');
    if (typeof creds?.decryptValue !== 'function') return { ok: false, reason: 'unreadable' };
    let value: string;
    try {
      value = creds.decryptValue(row.valueEnc);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    try {
      await prisma.ownerQuestionSecret.update({
        where: { id: row.id },
        data: { revealedAt: new Date(Date.now()), revealCount: Number(row.revealCount ?? 0) + 1 },
      }).catch(() => { /* counter is telemetry — the reveal itself stands */ });
      await prisma.activity.create({
        data: {
          userId,
          action: 'owner_question_secret.reveal',
          resource: 'platform',
          metadata: { questionId, ordinal: Number(ordinal) },
        },
      }).catch(() => { /* best-effort */ });
    } catch { /* telemetry never blocks a reveal */ }
    return { ok: true, ordinal: Number(ordinal), label: String(row.label ?? 'Credential'), value };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}
