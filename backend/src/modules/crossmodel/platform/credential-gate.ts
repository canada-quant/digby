/**
 * CREDENTIAL GATES (todo 77c88942 item 2, audit 2026-10-16 — monitor lesson 3).
 *
 * The specimen: oq_211513ed + oq_483730f8 were both answered "yes public" 3
 * seconds apart (04:33:13Z / 04:33:16Z) — neither answer held a credential —
 * and the credential-gated Schooltime todo 746aa1c5 flipped in_progress 18
 * seconds later (04:33:31Z). The Fleet Supervisor's homework over 100
 * answered owner questions found 12 of 14 credential-ask cards answered with
 * text holding NO credential (mismatched/noise, instruction-requests,
 * deferrals, or the credential arriving via a separate paste).
 *
 * The fix checks STATE, not text: flag_owner_question declares the expected
 * answer type (credential:<ENVKEY> | choice | yes_no | free); a credential
 * gate resolves ONLY when a store_secret RunToolReceipt for that envKey
 * exists for the owner. Answer text NEVER resolves it — a mismatched answer
 * is recorded on the row (a counter-question the lane must answer back on)
 * and the gate stays shut.
 *
 * The receipt channel (item 1, commit 0fde16f21): a SUCCESSFUL store_secret
 * mints a RunToolReceipt with ok:true and ids {envKey: <the env var NAME>} —
 * the name only, never the value — so the lift condition is a single
 * findFirst on the ids JSON path (the same Prisma shape as
 * supervisor-state.service's prNumber lookup), with the CodingCredential
 * store as the state fallback for keys stored before the channel existed.
 */

// R1-3 (ticket 91b0f191): the inbound credential scan gates the envKey half
// of 'credential:<ENVKEY>'. secret-scan is a leaf module (no imports of its
// own) — a static import cannot drag env-validating chains into Jest graphs.
import { findSecretSpans } from './secret-scan';

/** The declared answer types. 'free' (and null) keep the legacy behavior:
 *  any non-empty answer resolves. */
export type ExpectedAnswerType = 'free' | 'choice' | 'yes_no' | 'credential';

export interface ParsedAnswerType {
  type: ExpectedAnswerType | null;
  /** For type 'credential': the env var NAME (e.g. 'SCHOOLTIME_API_KEY') — never the value. */
  envKey?: string;
}

/** Max length we accept for an envKey (mirrors store_secret's envKey validation). */
export const ENVKEY_MAX = 64;

/** An ENVKEY-shaped token: 2-64 chars of [A-Z0-9_], with at least one
 *  underscore-delimited segment after the first (SCHOOLTIME_API_KEY, not
 *  plain prose in caps). Pure; exported for tests. */
export const ENVKEY_RE = /\b[A-Z][A-Z0-9_]{1,63}(?:_[A-Z0-9]+)+\b/g;

/** Every ENVKEY-shaped token in a text (deduped, order of appearance). Pure. */
export function envKeysInText(text: string): string[] {
  const t = String(text ?? '');
  if (!t) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of t.matchAll(ENVKEY_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

/** R1-3 (round-1 review of 5c024656, probe D5; ticket 91b0f191): TRUE when the
 *  envKey half of 'credential:<ENVKEY>' is itself credential material under
 *  the inbound secret scan. The parse-level shape check ([A-Za-z0-9_]{2,64})
 *  happily accepts a scanner-known key ('ghp_…', 'sk-…' contain no forbidden
 *  char), so before this check the key rode the stored owner-question row's
 *  expectedAnswerType slot verbatim ('credential:ghp_…') onto every
 *  projection surface (list_owner_questions, the pending-confirmations card).
 *  The scan runs on the RAW token BEFORE any toUpperCase — the scanner's
 *  patterns are case-sensitive, so an uppercased key would sail past them.
 *  Pure; exported for tests. */
export function envKeyLooksLikeCredential(envKey: string): boolean {
  const raw = String(envKey ?? '').trim();
  if (!raw) return false;
  return findSecretSpans(raw).length > 0;
}

/**
 * Parse the flagger-supplied expectedAnswerType declaration. Accepted shapes:
 *   'free' | 'choice' | 'yes_no' → that type
 *   'credential:ENVKEY' | 'credential:<ENVKEY>' → credential + envKey (validated)
 *   'credential' (bare) → credential, envKey inferred from the question text
 *     when it names exactly ONE ENVKEY-shaped token; else left unset (the gate
 *     can never lift until re-filed with a name — safer than guessing)
 *   null / '' / anything else → null (legacy free-text behavior)
 * Pure; exported for tests.
 */
/** The RAW (pre-uppercase) envKey half of an explicit 'credential:<ENVKEY>'
 *  slot — null for bare/inferred/unmatched forms. R1-3 (ticket 91b0f191):
 *  the create-site echo scrub must see the RAW case — echoScrub matches are
 *  case-sensitive, and the parsed envKey is uppercased, so a mixed-case echo
 *  of a delivered value would otherwise ride the stored slot case-mangled.
 *  Pure; exported for tests. */
export function rawEnvKeyHalf(raw: unknown): string | null {
  const m = /^credential[:<]\s*<?\s*([A-Za-z0-9_]{2,64})\s*>?$/.exec(String(raw ?? '').trim());
  return m ? m[1] : null;
}

export function parseExpectedAnswerType(raw: unknown, question: string): ParsedAnswerType {
  const t = String(raw ?? '').trim();
  if (!t) return { type: null };
  if (t === 'free' || t === 'choice' || t === 'yes_no') return { type: t };
  if (t === 'credential' || t === 'credential:' || t === 'credential:<>') {
    // Bare 'credential' (or an empty key slot): infer the envKey from the
    // question text when it names exactly ONE ENVKEY-shaped token; else the
    // gate has no key and can never lift by text OR state until re-filed —
    // fail-closed, never a silent free-text degradation.
    // R1-3 (probe D5): the inferred key runs the same credential scan —
    // uniform with the explicit branch (no current scanner pattern overlaps
    // ENVKEY_RE's uppercase-underscore shape, but the seam must not depend
    // on that staying true).
    const keys = envKeysInText(question).filter((k) => !envKeyLooksLikeCredential(k));
    if (keys.length === 1) return { type: 'credential', envKey: keys[0].slice(0, ENVKEY_MAX) };
    return { type: 'credential' };
  }
  // R1-3 (probe D5): the envKey half must pass the inbound credential scan
  // BEFORE it is accepted — the parse-level shape check alone let a
  // scanner-known key ride the stored row's expectedAnswerType slot verbatim.
  // Fail-closed: a hit drops ONLY the credential envKey (the gate stays a
  // credential gate with no key — the documented unresolvable-until-refiled
  // shape), never the whole declaration.
  const rawKey = rawEnvKeyHalf(t);
  if (rawKey && !envKeyLooksLikeCredential(rawKey)) return { type: 'credential', envKey: rawKey.toUpperCase() };
  if (rawKey) return { type: 'credential' };
  return { type: null };
}

/**
 * Does the answer text LOOK like it carries the credential itself (a paste
 * the owner made into the answer box)? Used ONLY to warn the owner the value
 * was redacted before storing — it NEVER lifts the gate: even a real paste
 * must land in the vault (store_secret, the card's key field or the Account
 * UI), because persisting a credential inside an owner_questions row is
 * exactly the leak class the answer path already redacts against (N9).
 * Pure; exported for tests.
 */
export function answerLooksLikeCredential(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/-----BEGIN [A-Z0-9 ]+-----/.test(t)) return true; // PEM block
  // A long single opaque token (JWT / api-key shape) with no prose around it.
  if (t.length >= 40 && /^[A-Za-z0-9_\-.=+/]+$/.test(t) && !/\s/.test(t)) return true;
  return false;
}

/** Ticket 9759bf5c: a stored credential that EXISTS but must not resolve a
 *  gate. Both classes are "the row is there, and it proves nothing about the
 *  ask" — the false green the sweeper used to stamp. */
export type CredentialDecline =
  /** The stored row / receipt was written BEFORE the question was filed: an
   *  OLD value can never satisfy a NEW-key ask (9059's whole point — the asks
   *  exist precisely because the old value is known-dead). */
  | 'predates-question'
  /** The stored value is one half of an AWS access-key PAIR whose other half
   *  contradicts it — the halves are byte-identical (the 2026-10-21/30 corrupt
   *  capture), or the sibling row is a known wrong-slot capture. A pair that
   *  fails its own contract is a dead credential, whatever this row looks
   *  like on its own. */
  | 'aws-pair-mismatch';

export interface CredentialLift {
  lifted: boolean;
  via: 'receipt' | 'store' | null;
  /** Present ONLY when a row/receipt was FOUND and refused — the sweeper logs
   *  it and leaves the card open. Absent on every lift and on the plain
   *  "nothing stored" / slot-mismatch refusals (their shape is unchanged). */
  declinedBy?: CredentialDecline;
}

/** TRUE when a stored timestamp provably predates the ask. A MISSING or
 *  unparseable timestamp cannot prove anything, so it never declines — the
 *  same "never wedge on a read we cannot interpret" posture as the unreadable
 *  value below. Prisma's @updatedAt / @default(now()) guarantee both fields on
 *  real rows, so this is test-stub leniency, not a production hole. Pure. */
function predatesAsk(storedAt: unknown, notBefore: Date | null): boolean {
  if (!notBefore) return false;
  const t = storedAt instanceof Date ? storedAt.getTime() : Date.parse(String(storedAt ?? ''));
  if (!Number.isFinite(t)) return false;
  return t < notBefore.getTime();
}

/**
 * Ticket 9759bf5c: does the OTHER half of this AWS access-key pair contradict
 * `slotValue`? A credential row is only half the evidence for an AWS pair —
 * the 2026-10-21 capture left the 20-char key ID in the SECRET slot while the
 * KEY slot held the same 20 chars, so the KEY row passed its own slot
 * validation and the sweeper lifted a gate on a demonstrably dead pair.
 *
 * Two classes fire, both MEASURED rather than heuristic:
 *   (a) the halves are byte-identical — no real pair ever is (the live shape:
 *       AK_len=20, SK_len=20, IDENTICAL);
 *   (b) the sibling fails ITS OWN slot validation (a known wrong-slot capture,
 *       e.g. an AKIA id sitting in the *_SECRET_ACCESS_KEY slot).
 * Anything unreadable/unjudgeable returns false — an exotic pair shape must
 * never wedge a gate shut (the fail-open posture this module already keeps for
 * undecryptable values). Never throws. Exported for tests.
 */
export async function awsPairInconsistent(
  prisma: any,
  userId: string,
  slotEnvKey: string,
  slotValue: string,
): Promise<boolean> {
  try {
    const {
      awsSlotFamily, awsSiblingSlots, decryptValue, valueSlotMismatch,
    } = await import('../coding/credentials.service');
    if (!awsSlotFamily(slotEnvKey)) return false;      // not an AWS-pair slot
    const siblingKeys = awsSiblingSlots(slotEnvKey);
    if (!siblingKeys.length) return false;
    const a = String(slotValue).trim();
    // Walk the candidate spellings (the corridor S3_KEY ↔ SECRET_ACCESS_KEY
    // pair first, then the AWS-native ACCESS_KEY_ID spelling): the FIRST
    // sibling row that exists is the pair partner, and only a contradiction
    // there is a verdict — a missing sibling proves nothing either way.
    for (const siblingKey of siblingKeys) {
      const sibling = await prisma.codingCredential.findFirst({
        where: { userId, envKey: siblingKey },
        select: { envKey: true, valueEnc: true },
      });
      if (!sibling || typeof sibling.valueEnc !== 'string' || !sibling.valueEnc) continue;
      // A sibling lookup that resolves back to the slot row itself proves
      // nothing (comparing a value with itself) — skip it, never convict.
      if (String(sibling.envKey ?? '') === String(slotEnvKey)) continue;
      let siblingValue: string | null = null;
      try { siblingValue = decryptValue(sibling.valueEnc); } catch { continue; }
      if (typeof siblingValue !== 'string' || !siblingValue) continue;
      const b = siblingValue.trim();
      if (a && b && a === b) return true;                              // (a) identical halves
      if (valueSlotMismatch(String(sibling.envKey ?? ''), siblingValue)) return true; // (b) corrupt sibling
      return false; // the pair partner exists and is consistent
    }
    return false;
  } catch { return false; }
}

/**
 * The credential-gate lift condition: a store_secret receipt for this envKey
 * exists for this owner's chats. Checks the RECEIPT first (item 1's channel —
 * the durable "it was stored" proof), falling back to the CodingCredential
 * row itself (the STATE — a key stored before the receipt channel existed,
 * or via the Account UI, still lifts the gate; we check state, not text).
 * Labeled stores mint ids.envKey = `${envKey}_${LABEL}` (the injected name),
 * so both legs match on the envKey BASE by prefix. Fail-closed on a read
 * error: a probe hiccup keeps the gate SHUT (the sweeper re-checks every
 * 5 min; the lane re-asks on its next wake). Exported for tests.
 *
 * Ticket 9759bf5c (2026-10-30): BOTH legs used to accept any row that existed,
 * so a card asking for a FRESH key auto-resolved on the stale dead one — twice
 * on the same credential pair (oq_aacc4a12 on 2026-10-21, oq_d054352c on
 * 2026-10-30, the latter 91 s after it was filed and before any probe could
 * disagree). `opts.notBefore` — the question's createdAt — makes the state leg
 * prove it is NEWER than the ask (`updatedAt`, not `createdAt`: repairing a
 * corrupt row rewrites the value in place and must count), and the AWS-pair
 * check makes it prove the pair is internally consistent. A refusal returns
 * `declinedBy` so the caller can leave the card OPEN and say why instead of
 * answering it "default".
 */
export async function credentialLifted(
  prisma: any,
  userId: string,
  envKey: string,
  opts: { notBefore?: Date | null } = {},
): Promise<CredentialLift> {
  const key = String(envKey ?? '').trim().toUpperCase();
  if (!key || !userId) return { lifted: false, via: null };
  const notBefore = opts?.notBefore instanceof Date ? opts.notBefore : null;
  let declinedBy: CredentialDecline | undefined;
  try {
    // (1) store_secret receipt: ok:true, owner-scoped through the chat
    // relation, ids.envKey startsWith the base key. The JSON-path filter is
    // the same Prisma shape as supervisor-state.service's prNumber lookup.
    const receipt = await prisma.runToolReceipt.findFirst({
      where: {
        ok: true,
        tool: 'store_secret',
        ids: { path: ['envKey'], string_starts_with: key },
        chat: { userId },
      },
      select: { id: true, createdAt: true },
    });
    // A receipt that predates the ask is the OLD value: record the decline and
    // keep going — a NEWER store row may still be the honest evidence.
    if (receipt) {
      if (!predatesAsk(receipt.createdAt, notBefore)) return { lifted: true, via: 'receipt' };
      declinedBy = 'predates-question';
    }
  } catch { /* fall through to the store check */ }
  try {
    // (2) The CodingCredential store itself (schema: userId + envKey; labeled
    // variants share the envKey base). State, not channel.
    // Ticket c54074df / 7caf07ed (2026-10-21): the STATE check used to lift
    // on ROW EXISTENCE alone. The incident: the 18:25Z owner-answer vault
    // minted the 20-char AWS KEY ID into the *_SECRET_ACCESS_KEY slot; that
    // corrupt row then satisfied every later lift — the owner-gate-sweeper
    // auto-resolved two later cards on it, stamping "credential … stored"
    // as the owner's answer while the vault held no usable secret. The row
    // must now prove it holds what its slot declares: the value is decrypted
    // and slot-validated (the shared valueSlotMismatch rules — an
    // AKIA/ASIA key ID in a SECRET_ACCESS_KEY slot is a KNOWN swap and can
    // never lift). ONE query carries both fields (review finding C: two
    // unordered findFirsts could validate one row's value against another
    // row's envKey); the catch wraps ONLY the decrypt/validate leg — a
    // query failure fail-closes per the documented read posture below, while
    // an UNREADABLE value (a legacy row, a JWT_SECRET rotation) keeps the
    // state-posture lift so a key rotation can never wedge every gate shut.
    const stored = await prisma.codingCredential.findFirst({
      where: { userId, envKey: { startsWith: key } },
      select: { envKey: true, valueEnc: true, updatedAt: true },
    });
    if (stored) {
      // Ticket 9759bf5c (defect 1): a row written before the question was
      // filed is the OLD value, and the ask exists BECAUSE that old value is
      // dead — it can never be the answer. `updatedAt` is the right column:
      // repairing a corrupt row overwrites the value in place (the
      // 7caf07ed ADDENDUM A recovery path), so a genuine repair reads as NEW.
      if (predatesAsk(stored.updatedAt, notBefore)) {
        return { lifted: false, via: null, declinedBy: 'predates-question' };
      }
      if (typeof stored.valueEnc === 'string' && stored.valueEnc) {
        let value: string | null = null;
        let readable = true;
        try {
          const { decryptValue, valueSlotMismatch } = await import('../coding/credentials.service');
          value = decryptValue(stored.valueEnc);
          if (valueSlotMismatch(stored.envKey, value)) {
            // Observability (review finding H): a slot-mismatched row is
            // indistinguishable from "no row" without this — the live corrupt
            // row sat invisible for 15+ hours. Named, counted, never loud.
            try {
              const { default: logger } = await import('../../../utils/logger');
              logger.warn(`credential-gate: store row ${stored.envKey} holds a value that slot-mismatches its envKey — gate stays SHUT until the credential is re-stored (corrupt capture class, tickets c54074df/7caf07ed)`);
            } catch { /* logging must never block the lift decision */ }
            return { lifted: false, via: null };
          }
        } catch { readable = false; /* undecryptable — fail-OPEN on legibility */ }
        if (!readable && value === null) return { lifted: true, via: 'store' };
        // Ticket 9759bf5c (defect 2): this row passed its OWN slot check, but
        // on an AWS pair the sibling is half the evidence — a pair whose halves
        // are byte-identical (the live AK_len=20 / SK_len=20 IDENTICAL shape)
        // is a dead credential that satisfied every lift on BOTH slots.
        if (typeof value === 'string' && await awsPairInconsistent(prisma, userId, stored.envKey, value)) {
          try {
            const { default: logger } = await import('../../../utils/logger');
            logger.warn(`credential-gate: store row ${stored.envKey} is one half of an AWS pair the sibling contradicts (identical halves or a wrong-slot sibling) — gate stays SHUT until BOTH halves are re-stored (ticket 9759bf5c)`);
          } catch { /* logging must never block the lift decision */ }
          return { lifted: false, via: null, declinedBy: 'aws-pair-mismatch' };
        }
      }
      return { lifted: true, via: 'store' };
    }
  } catch { /* fail-closed below */ }
  return declinedBy ? { lifted: false, via: null, declinedBy } : { lifted: false, via: null };
}
