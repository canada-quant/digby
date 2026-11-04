/**
 * Coding-session CLI/API credentials — per-user secrets (Cloudflare, AWS,
 * Namecheap, Brev, custom …) injected into the session shell as env vars so
 * the agent's own commands (`wrangler`, `aws`, `brev`, curl'ing provider APIs)
 * authenticate as the user.
 *
 * MULTIPLE credentials per provider/env-key are supported via an optional
 * LABEL: the primary credential (label '') is injected under the canonical
 * envKey; a labeled one is injected as `${envKey}_${LABEL}` (e.g. a second
 * Cloudflare token labeled 'WORK' → CLOUDFLARE_API_TOKEN_WORK). Saving the
 * same envKey+label again updates it in place — nothing is ever silently
 * overwritten by a DIFFERENT credential.
 *
 * Security model:
 *  - Values are AES-256-GCM encrypted at rest. The key is DERIVED from
 *    JWT_SECRET (sha256("digby-coding-credentials:" + JWT_SECRET)) so no new
 *    deployment secret is needed; rotating JWT_SECRET invalidates stored
 *    values (users re-enter them — they are never displayed anyway).
 *  - The API NEVER returns a stored value — list responses carry a masked
 *    preview (last 4 chars) only.
 *  - Values are merged into the shell env per command and scrubbed from all
 *    shell output before it reaches the model/transcript (agent.ts `scrub`).
 *  - envKey is validated and deny-listed: shell-behavior vars (PATH,
 *    LD_PRELOAD, …) and the platform's own injected keys cannot be overridden.
 *    The deny check also applies to the DERIVED injected name, so a label
 *    can't smuggle a collision with a platform key (GITHUB + TOKEN).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_VALUE_LEN = 8192;
const MAX_CREDS_PER_USER = 50;

export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Vars that change shell/loader behavior, or that the platform itself injects. */
export const DENIED_ENV_KEYS = new Set([
  // shell / loader behavior
  'PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'IFS', 'PS1', 'PS2', 'PS3', 'PS4',
  'PROMPT_COMMAND', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'NODE_OPTIONS',
  'PYTHONSTARTUP', 'PERL5OPT', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  // platform-injected credentials (session-credentials.ts) — not overridable
  'GITHUB_TOKEN', 'GH_TOKEN', 'GOOGLE_ACCESS_TOKEN', 'SLACK_TOKEN', 'SLACK_USER_TOKEN',
  'ASANA_ACCESS_TOKEN', 'MCP_DIGBY_TOKEN', 'MCP_DIGBY_URL', 'DIGBY_USER_ID',
  // build 2026-10-08 ISO — the credential-proxy block (credential-proxy.ts buildProxyEnv)
  'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_TERMINAL_PROMPT',
  'DIGBY_CREDENTIAL_PROXY', 'DIGBY_CREDENTIAL_PROXY_TOKEN', 'DIGBY_CREDENTIAL_PROXY_APIS',
]);

/**
 * Normalize a user-supplied label to UPPER_SNAKE; '' = primary.
 * ' Work Acct! ' → 'WORK_ACCT'. Throws if nothing usable remains or the
 * result exceeds 24 chars — NEVER truncate: two long labels sharing a prefix
 * must not silently merge into one credential (that would re-introduce the
 * silent-overwrite bug labels exist to fix).
 */
export function normalizeLabel(raw: string): string {
  const l = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (String(raw || '').trim() && !l) throw new Error('Label must be letters, digits or underscores (max 24 chars).');
  if (l.length > 24) throw new Error('Label too long (max 24 chars).');
  return l;
}

/** The env var name a credential is actually injected under in session shells. */
export function injectedKeyFor(envKey: string, label: string): string {
  return label ? `${envKey}_${label}` : envKey;
}

/**
 * All-caps VALUE anomaly detector (feedback ticket 8a46847f). Values are stored
 * and injected VERBATIM — this service never changes a value's case (env-var
 * NAME uppercasing is conventional; VALUE uppercasing destroys the secret: a
 * JWT like "eyJ…" is dead as "EYJ…" because base64url is case-sensitive, and
 * CLI commands like "brev login --token …" are lowercase by convention). An
 * all-uppercase value of any length therefore almost always means the secret
 * was mangled BEFORE it reached the API (a shouty paste, a caps-lock retype,
 * an upstream/client-side transform) — exactly the corruption the ticket hit.
 * Legit all-caps values exist, so this is a NON-BLOCKING warning surfaced at
 * save time and on the credential list — never a rejection.
 *
 * False-positive control (adversarial review F1): compact PURE-ALNUM values
 * (≤24 chars) are exempt — the AWS Access Key ID ("AKIA…", 20 all-caps alnum
 * BY SPEC) is a required field of a first-class preset, and key-IDs generally
 * look like that. The corruption signature worth flagging carries structure:
 * spaces/dashes (shouted commands) or JWT/base64url punctuation (".", "-", "_").
 * A long all-caps pure-hex key can still warn — advisory only, accepted.
 * Scope note: the detector is ASCII-only (non-ASCII letters are ignored).
 */
export function valueCaseWarning(value: string): string | null {
  const letters = String(value || '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 12) return null;   // too short to judge
  if (/[a-z]/.test(letters)) return null; // has lowercase — case intact
  const trimmed = String(value).trim();
  if (/^[A-Z0-9]+$/.test(trimmed) && trimmed.length <= 24) return null; // key-ID shape (AWS AKIA…)
  return 'This value is ALL UPPERCASE — tokens and commands are usually case-sensitive (a JWT like "eyJ…" breaks as "EYJ…"). If you did not enter it in caps on purpose, re-check what you pasted.';
}

// ── Provider-slot shape validation (feedback ticket 20fa94da) ────────────────
// The live mishap: a Cloudflare pair was stored with the two values SWAPPED —
// the 32-hex ACCOUNT ID under CLOUDFLARE_API_TOKEN and the working cfat_
// TOKEN under CLOUDFLARE_ACCOUNT_ID. Values are write-only, so nothing
// downstream could flag the mapping; every lane rediscovered the swap through
// failed API calls (CF 400/6111). Like valueCaseWarning, this guards the SLOT
// a known shape lands in — but it REFUSES instead of warning: a stored swap is
// dead on arrival, and both doors surface the message to the owner at paste
// time (the Account UI toasts the 400's {error}; store_secret refuses with
// 'store_failed' and the same text).
// DELIBERATELY SURGICAL — never over-block: each rule fires ONLY on the
// known-wrong shape for its slot (a bare 32-hex value in a Cloudflare TOKEN
// slot; a cfk_/cfut_/cfat_ token in a Cloudflare ACCOUNT-ID slot). Unknown
// shapes pass untouched on BOTH slots — a shape the regexes do not know (e.g.
// a legacy 40-char Cloudflare token) must never be refused. The rules key on
// the envKey BASE, so labeled variants ride along: envKey
// CLOUDFLARE_API_TOKEN + label CQL (injected as CLOUDFLARE_API_TOKEN_CQL) is
// covered exactly like the primary, on both the Account UI door and
// store_secret (which stores new rows with provider 'custom' — provider-keyed
// rules would miss it).
// Kill switch: CODING_CRED_SLOT_VALIDATION_DISABLED=1 restores the old
// accept-anything behaviour.

/** Cloudflare scannable-token family — same shape set as the secret scanner's "Cloudflare API token" (secret-scan.ts, ticket 82dd8756): cfk_ Global API Key, cfut_ User API Token, cfat_ Account API Token. */
const CF_TOKEN_RE = /^cf(?:k|ut|at)_[A-Za-z0-9]{30,}$/;
/** Cloudflare account IDs are 32 hex characters (both cases accepted — the dashboard serves lowercase). */
const CF_ACCOUNT_ID_RE = /^[0-9a-fA-F]{32}$/;
const isCfTokenSlot = (envKey: string) => envKey === 'CLOUDFLARE_API_TOKEN' || envKey.startsWith('CLOUDFLARE_API_TOKEN_');
const isCfAccountSlot = (envKey: string) => envKey === 'CLOUDFLARE_ACCOUNT_ID' || envKey.startsWith('CLOUDFLARE_ACCOUNT_ID_');

// ── The AWS access-key PAIR (ticket c54074df / 7caf07ed, 2026-10-21) ─────────
// The incident: an owner pasted both halves of an AWS pair; the first span
// (the 20-char AKIA/ASIA key ID) was minted as the *_SECRET_ACCESS_KEY and
// the lane measured a 20-char "secret" byte-equal to the key-ID row. The pair
// shape is unambiguous in BOTH directions — a key ID is 20 chars with a known
// 4-char prefix, a secret access key is exactly 40 base64 characters — so a
// KNOWN-wrong-slot value is refused at store time on every surface that
// routes through upsertCredential (owner-card vault, store_secret, the
// Account → Coding form). Slot naming convention (AWS's own, mirrored by
// corridor env keys like CANLAW_CPT_S3_KEY / CANLAW_CPT_S3_SECRET_ACCESS_KEY):
// the SECRET slot CONTAINS "SECRET_ACCESS_KEY" or ends in SECRET/SECRET_KEY
// (a trailing numeric label — S3_SECRET_KEY_2 — is still the secret half);
// a KEY-ID slot ends in "ACCESS_KEY_ID" (label-suffixed variants included),
// the legacy AWS_ACCESS_KEY tail, or an S3-qualified S3_KEY/S3_ACCESS_KEY
// tail (the corridor convention CANLAW_CPT_S3_KEY).
const isAwsSecretSlot = (envKey: string) =>
  envKey.includes('SECRET_ACCESS_KEY') || /(?:^|_)(?:SECRET_KEY|SECRET)(?:_[A-Z0-9]+)*$/.test(envKey);
// The KEY-ID direction is deliberately NARROW (review finding B1/finding 1: a
// first cut matched every `*_KEY` slot, and `*_SECRET_KEY` — the most natural
// name for the secret half — was refused as a key-ID slot with a nonsense
// sibling). A 40-char base64 value is a REAL shape for non-AWS slots (Cohere
// keys are 40; HMAC/signing secrets), so refusing one there would wedge the
// credential on every surface AND fail-close its gate. The rule fires only on
// slots that NAME the AWS idiom (17d64418 (c) tightened the first cut, which
// fired on ANY slot holding an AWS/S3 word plus a KEY/ACCESS_KEY tail —
// S3_BUCKET_KEY and MY_AWS_KEY classified key-ID, so a genuine 40-char
// non-AWS secret was refused there with a nonsense sibling, the same
// over-block class as B1):
//   - an explicit `…_ACCESS_KEY_ID` tail, with any trailing label/ordinal
//     suffix (AWS_ACCESS_KEY_ID, AWS_ACCESS_KEY_ID_DIGBYOPERATOR);
//   - the legacy `…_AWS_ACCESS_KEY` tail (the pre-SDK-v2 env name);
//   - an S3-QUALIFIED `…_S3_KEY` / `…_S3_ACCESS_KEY` tail (the corridor
//     family: CANLAW_CPT_S3_KEY; the minio-style S3_ACCESS_KEY pair).
// A bare `…_AWS_KEY` (MY_AWS_KEY), a non-qualifying tail (S3_BUCKET_KEY) and
// every generic `*_KEY` (OPENAI_API_KEY, COHERE_API_KEY, SSH_KEY,
// ENCRYPTION_KEY, TURSO_DATABASE_KEY) are OUTSIDE — a 40-char value stores
// there unrefused.
const isAwsKeyIdSlot = (envKey: string) => {
  if (isAwsSecretSlot(envKey)) return false;
  if (/(?:^|_)ACCESS_KEY_ID(?:_[A-Z0-9]+)*$/.test(envKey)) return true;
  if (/(?:^|_)AWS_ACCESS_KEY(?:_[A-Z0-9]+)*$/.test(envKey)) return true;
  return /(?:^|_)S3_(?:KEY|ACCESS_KEY)(?:_[A-Z0-9]+)*$/.test(envKey);
};
/** AWS access key IDs: 20 chars, uppercase alnum, one of the documented prefixes (AKIA/ASIA/ABIA/ACCA). */
const AWS_KEY_ID_RE = /^(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}$/;
/** AWS secret access keys: exactly 40 base64 alphabet characters. */
const AWS_SECRET_RE = /^[A-Za-z0-9+/]{40}$/;

/** Slot family for the AWS-pair swap rules (tickets c54074df/7caf07ed):
 *  'secret' = the secret half's slot, 'key-id' = the access-key-ID half's
 *  slot, null = the envKey names no AWS-pair half. ONE classifier shared by
 *  valueSlotMismatch (store-time refusal) and the owner-answer vault's
 *  declared-slot routing, so a value, its label and its slot are always
 *  judged by the same family rules. */
export function awsSlotFamily(envKey: string): 'secret' | 'key-id' | null {
  if (isAwsSecretSlot(envKey)) return 'secret';
  if (isAwsKeyIdSlot(envKey)) return 'key-id';
  return null;
}

/** Ticket 9759bf5c: the SIBLING slot candidates of an AWS-pair half, by the
 *  same longest-first tail swaps valueSlotMismatch uses, label/ordinal
 *  suffixes preserved. A LIST, not one name, because the corridor convention
 *  does not swap tail-for-tail: CANLAW_CPT_S3_KEY is the key-ID half of
 *  CANLAW_CPT_S3_SECRET_ACCESS_KEY (S3_KEY ↔ SECRET_ACCESS_KEY), while the
 *  AWS-native spelling swaps ACCESS_KEY_ID ↔ SECRET_ACCESS_KEY. Empty when the
 *  slot names no pair half. The gate's pair-consistency check walks these in
 *  order; the store-time refusal keeps its own single best name. Pure. */
export function awsSiblingSlots(envKey: string): string[] {
  const family = awsSlotFamily(envKey);
  const swap = (from: string, to: string) => siblingSlot(envKey, from, to);
  // Order is load-bearing: the first sibling row that EXISTS decides, so the
  // corridor spelling of the LIVE pair (CANLAW_CPT_S3_KEY ↔
  // CANLAW_CPT_S3_SECRET_ACCESS_KEY) is tried before the AWS-native one.
  const out = (family === 'secret'
    ? [
      swap('SECRET_ACCESS_KEY', 'KEY'),           // corridor: …_S3_SECRET_ACCESS_KEY → …_S3_KEY
      swap('SECRET_ACCESS_KEY', 'ACCESS_KEY_ID'), // AWS-native
      swap('SECRET_KEY', 'KEY'),
      swap('SECRET_KEY', 'ACCESS_KEY_ID'),
      swap('SECRET', 'ACCESS_KEY_ID'),
      swap('SECRET_ACCESS_KEY', 'ACCESS_KEY'),
    ]
    : family === 'key-id'
      ? [
        swap('S3_KEY', 'S3_SECRET_ACCESS_KEY'),       // corridor, the live name
        swap('S3_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY'),
        swap('ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'),   // AWS-native
        swap('AWS_ACCESS_KEY', 'SECRET_ACCESS_KEY'),
        swap('KEY', 'SECRET_ACCESS_KEY'),
      ]
      : []);
  // Dedupe, drop self and anything that is not the OPPOSITE family (a swap
  // that lands back in the same family would compare a slot against its twin).
  const seen = new Set<string>();
  return out.filter((k): k is string => {
    if (!k || k === envKey || seen.has(k)) return false;
    if (awsSlotFamily(k) === family) return false;
    seen.add(k);
    return true;
  });
}

/** 17d64418 (c): derive the sibling slot of an AWS-pair half by swapping the
 *  `from` tail for `to`, PRESERVING any trailing label/ordinal suffix after
 *  the tail — AWS_ACCESS_KEY_ID_DIGBYOPERATOR → AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR,
 *  S3_SECRET_KEY_2 → S3_ACCESS_KEY_ID_2. The `from` candidates at each call
 *  site are ordered LONGEST-FIRST (SECRET_ACCESS_KEY before SECRET_KEY before
 *  SECRET): a shorter tail would otherwise match inside a longer one's
 *  suffix and mangle the derived name. Null when the slot has no such tail.
 *  Pure. */
function siblingSlot(envKey: string, from: string, to: string): string | null {
  const m = new RegExp(`^((?:.*_)?)(?:${from})((?:_[A-Z0-9]+)*)$`).exec(String(envKey ?? ''));
  return m ? `${m[1]}${to}${m[2]}` : null;
}

/**
 * The ticket-20fa94da guard: a KNOWN Cloudflare shape landing in the WRONG
 * slot returns a refusal message naming both correct slots; everything else
 * returns null (store it). Pure — no DB, no logging.
 */
export function valueSlotMismatch(envKey: string, value: string): string | null {
  if (process.env.CODING_CRED_SLOT_VALIDATION_DISABLED === '1') return null;
  const v = String(value || '').trim();
  if (isCfTokenSlot(envKey) && CF_ACCOUNT_ID_RE.test(v)) {
    const idSlot = envKey.replace(/^CLOUDFLARE_API_TOKEN/, 'CLOUDFLARE_ACCOUNT_ID');
    return `This value is a Cloudflare ACCOUNT ID (32 hex characters), but ${envKey} is the API-TOKEN slot — the two look swapped. Store the API token (new ones start with "cfat_" or "cfut_") under ${envKey} and the account ID under ${idSlot}.`;
  }
  if (isCfAccountSlot(envKey) && CF_TOKEN_RE.test(v)) {
    const tokenSlot = envKey.replace(/^CLOUDFLARE_ACCOUNT_ID/, 'CLOUDFLARE_API_TOKEN');
    return `This value is a Cloudflare API TOKEN ("cfat_"/"cfut_"/"cfk_" prefix), but ${envKey} is the ACCOUNT-ID slot — the two look swapped. Store the API token under ${tokenSlot} and the account ID (32 hex characters) under ${envKey}.`;
  }
  // The AWS pair (ticket c54074df / 7caf07ed): a key ID (20 chars, AKIA/ASIA/
  // ABIA/ACCA prefix) in a SECRET slot, or a 40-char secret in a KEY-ID slot,
  // is the documented swap class — refused with the sibling slot named, the
  // same shape as the Cloudflare rules above. The sibling slot is derived ONLY
  // from a slot that literally ends in the swapped tail (SECRET_ACCESS_KEY →
  // ACCESS_KEY_ID) — a slot that merely CONTAINS the tail keeps the generic
  // phrasing rather than a mangled name. 17d64418 (c): the swap is
  // SEGMENT-wise and SUFFIX-PRESERVING — a label/ordinal suffix after the
  // tail (AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR, S3_SECRET_KEY_2) rides along
  // to the derived sibling (AWS_ACCESS_KEY_ID_DIGBYOPERATOR) instead of the
  // old `KEY$`-anchored replace no-op'ing on it and advising the owner to
  // store the secret under the key-ID slot itself.
  if (isAwsSecretSlot(envKey) && AWS_KEY_ID_RE.test(v)) {
    const idSlot = siblingSlot(envKey, 'SECRET_ACCESS_KEY', 'ACCESS_KEY_ID')
      ?? siblingSlot(envKey, 'SECRET_KEY', 'ACCESS_KEY_ID')
      ?? siblingSlot(envKey, 'SECRET', 'ACCESS_KEY_ID');
    return `This value is an AWS ACCESS KEY ID (20 characters, "${v.slice(0, 4)}…" prefix), but ${envKey} is the SECRET-ACCESS-KEY slot — the two look swapped. Store the 20-character key ID under ${idSlot ?? 'the *_ACCESS_KEY_ID slot'} and the 40-character secret access key under ${envKey}.`;
  }
  // Ticket 3b573ce3 (2026-10-30): a FUSED pair — the key ID glued to the front
  // of the secret — was accepted here because both rules above are ANCHORED
  // (`/^(?:AKIA|…)…{16}$/`): a 60-char `AKIA…<40>` blob is neither a bare key
  // ID nor a bare 40-char secret, so it slipped through every store door and
  // landed on a *_SECRET_ACCESS_KEY slot as one unusable value (the incident:
  // a ctrl.example.com S3 pair stored as a 60-char $CANLAW_CPT_S3_SECRET_ACCESS_KEY
  // whose tail was the only real secret). The capture legs now SPLIT such a
  // run before it reaches here (secret-scan's pushCaptureSpan), so this is
  // the second door: the Account → Coding form and any direct API write. The
  // key ID is self-identifying, so a value LEADS with one and does not END as
  // one means two credentials were pasted as one — refuse, and name BOTH
  // halves' slots so the owner can redo it correctly. A genuine 40-char
  // secret (the only other way to be 20+X) cannot start with AKIA+16 upper
  // alnum by accident: that is the whole reason the prefix is a key ID.
  if (isAwsSecretSlot(envKey) && v.length > 20 && AWS_KEY_ID_RE.test(v.slice(0, 20))) {
    const idSlot = siblingSlot(envKey, 'SECRET_ACCESS_KEY', 'ACCESS_KEY_ID')
      ?? siblingSlot(envKey, 'SECRET_KEY', 'ACCESS_KEY_ID')
      ?? siblingSlot(envKey, 'SECRET', 'ACCESS_KEY_ID');
    return `This value is TWO credentials CONCATENATED — an AWS ACCESS KEY ID (20 characters, "${v.slice(0, 4)}…" prefix) fused to the front of the ${v.length - 20}-character value after it — so it cannot be stored as one secret. Store the 20-character key ID under ${idSlot ?? 'the *_ACCESS_KEY_ID slot'} and the secret access key alone (without the ID) under ${envKey}.`;
  }
  if (isAwsKeyIdSlot(envKey) && AWS_SECRET_RE.test(v)) {
    // The alternatives exactly mirror isAwsKeyIdSlot's classification rules
    // (ACCESS_KEY_ID / AWS_ACCESS_KEY / S3_ACCESS_KEY / S3_KEY tails, in that
    // order — a shorter tail listed first would shadow a longer one ending in
    // it, e.g. KEY matching inside …_ACCESS_KEY). 17d64418 (c) review N4: the
    // old fifth `KEY` alternative was unreachable (every key-id slot matches
    // one of the four) and is removed; the message carries an explicit
    // null-fallback so a future classification can never print "under null".
    const secretSlot = siblingSlot(envKey, 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY')
      ?? siblingSlot(envKey, 'AWS_ACCESS_KEY', 'SECRET_ACCESS_KEY')
      ?? siblingSlot(envKey, 'S3_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY')
      ?? siblingSlot(envKey, 'S3_KEY', 'S3_SECRET_ACCESS_KEY');
    return `This value looks like an AWS SECRET ACCESS KEY (exactly 40 base64 characters), but ${envKey} is the ACCESS-KEY-ID slot — the two look swapped. Store the 40-character secret access key under ${secretSlot ?? 'the *_SECRET_ACCESS_KEY slot'} and the 20-character key ID (AKIA/ASIA… prefix) under ${envKey}.`;
  }
  return null;
}

function key(): Buffer {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHash('sha256').update(`digby-coding-credentials:${secret}`).digest();
}

export function encryptValue(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptValue(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, key(), buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return decipher.update(buf.subarray(IV_LEN + TAG_LEN)).toString('utf8') + decipher.final('utf8');
}

export interface CredentialSummary {
  id: string;
  provider: string;
  envKey: string;
  label: string;       // '' = primary; 'WORK' → injected as envKey_WORK
  injectedKey: string; // the env var name this credential is injected under
  preview: string;     // '••••1234' — the API never returns the value itself
  readable: boolean;   // false = stored value no longer decrypts (JWT_SECRET drift) — re-enter it
  /** Non-blocking all-caps anomaly note (valueCaseWarning) — null when the value looks case-intact. */
  warning: string | null;
  updatedAt: Date;
}

const mask = (v: string) => `••••${v.length > 4 ? v.slice(-4) : ''}`;

const summaryFor = (r: { id: string; provider: string; envKey: string; label?: string | null; updatedAt: Date }, preview: string, readable = true, warning: string | null = null): CredentialSummary => {
  const label = r.label || '';
  return { id: r.id, provider: r.provider, envKey: r.envKey, label, injectedKey: injectedKeyFor(r.envKey, label), preview, readable, warning, updatedAt: r.updatedAt };
};

export async function listCredentials(userId: string): Promise<CredentialSummary[]> {
  const rows = await prisma.codingCredential.findMany({
    where: { userId }, orderBy: [{ provider: 'asc' }, { envKey: 'asc' }, { label: 'asc' }],
  });
  return rows.map(r => {
    let preview = '••••';
    let readable = true;
    let warning: string | null = null;
    try { const v = decryptValue(r.valueEnc); preview = mask(v); warning = valueCaseWarning(v); } catch { readable = false; /* key rotated — unreadable */ }
    return summaryFor(r, preview, readable, warning);
  });
}

/**
 * A well-formed PEM block (audit 2026-10-15, todo 75be792c): the ONLY
 * multi-line value the credential store accepts. Structural validation —
 * full BEGIN/END pair with a MATCHING label (RSA / EC / OPENSSH / ENCRYPTED
 * PRIVATE KEY, PRIVATE KEY, PUBLIC KEY, CERTIFICATE …), a base64 body, CRLF or
 * LF line endings, optional surrounding whitespace. A truncated paste (BEGIN
 * with no END), prose after the END marker, or arbitrary multi-line junk
 * fails — all refused rather than stored broken. Pure; never throws.
 */
export function isPemBlock(value: string): boolean {
  const src = String(value ?? '');
  const m = /^\s*-----BEGIN ([A-Z0-9 ]+)-----\r?\n/.exec(src);
  if (!m) return false;
  const label = m[1];
  const trimmed = src.trimEnd();
  const endMarker = `-----END ${label}-----`;
  if (!trimmed.endsWith(endMarker)) return false; // full pair, matching label, nothing after it
  const body = trimmed.slice(m[0].length, trimmed.length - endMarker.length).replace(/\r?\n$/, '');
  if (!body) return false;
  // Every body line is non-empty base64 (padding only at a line end) — a
  // blank line mid-body or any non-base64 character refuses the block.
  return body.split(/\r?\n/).every((l) => /^[A-Za-z0-9+/]+={0,2}$/.test(l));
}

export async function upsertCredential(
  userId: string, provider: string, envKey: string, value: string, label?: string,
): Promise<CredentialSummary> {
  const prov = String(provider || 'custom').toLowerCase().slice(0, 32);
  const k = String(envKey || '').trim();
  const lbl = normalizeLabel(String(label || ''));
  const v = String(value || '');
  if (!ENV_KEY_RE.test(k)) throw new Error('Env key must be UPPER_SNAKE_CASE (letters, digits, underscores; 2-64 chars).');
  if (DENIED_ENV_KEYS.has(k)) throw new Error(`"${k}" is reserved and cannot be set.`);
  const inject = injectedKeyFor(k, lbl);
  if (!ENV_KEY_RE.test(inject)) throw new Error(`"${inject}" is not a valid env var name (env key + label too long?).`);
  if (DENIED_ENV_KEYS.has(inject)) throw new Error(`"${inject}" is reserved and cannot be set.`);
  if (!v.trim()) throw new Error('Value is required.');
  if (v.length > MAX_VALUE_LEN) throw new Error(`Value too long (max ${MAX_VALUE_LEN} chars).`);
  // Multi-line values: ONLY a well-formed PEM block passes (audit 2026-10-15
  // todo 75be792c — an owner-pasted RSA/EC/OpenSSH private key was rejected
  // twice with an unactionable "Value must be a single line." because the
  // store_secret extraction had lifted the WHOLE block correctly and THIS
  // guard then refused it; the owner filed the key by hand in the UI, whose
  // <input type="password"> silently STRIPS newlines client-side, mangling
  // the key). Every injection path is newline-safe: values reach shells as
  // execFile env objects and `docker exec -e K=V` argv entries, never as a
  // sourced env file, and the output scrubber is an exact-match split/join —
  // so a verbatim PEM block is stored, verbatim, under its env var. A PEM
  // block is validated STRUCTURALLY (full BEGIN/END pair, matching label,
  // base64 body) — arbitrary multi-line prose/junk stays refused, and a
  // truncated paste (BEGIN with no END) is refused rather than stored broken.
  if (/[\n\r\0]/.test(v) && !isPemBlock(v)) {
    throw new Error('Value must be a single line (multi-line values are accepted only as a complete PEM private/public key block — full -----BEGIN…-----/-----END…----- with a base64 body).');
  }
  // A lone PEM header (the start of a truncated paste) must never store as a
  // broken credential — reviewer F1 on todo 75be792c: `-----BEGIN PRIVATE
  // KEY-----` with no body/END is single-line, so the newline guard above does
  // not see it; every consumer would then fail on a 27-char "key".
  if (/^-----BEGIN\b/.test(v.trim()) && !isPemBlock(v)) {
    throw new Error('That looks like the START of a PEM block (a -----BEGIN----- header) — a complete block (header to matching -----END----- line, base64 body) is required. Re-send the full block.');
  }
  // Ticket 20fa94da: a known provider shape landing in the WRONG slot (e.g. a
  // 32-hex Cloudflare account id under CLOUDFLARE_API_TOKEN) is refused at
  // store time — the swap class the ticket hit is otherwise undiscoverable
  // until lanes burn runs on 400/6111 API failures.
  const slotMismatch = valueSlotMismatch(k, v);
  if (slotMismatch) throw new Error(slotMismatch);
  const where = { userId_envKey_label: { userId, envKey: k, label: lbl } };
  const existing = await prisma.codingCredential.findUnique({ where });
  // Provider-flip guard: the unique key is (userId, envKey, label) WITHOUT
  // provider, so re-saving an infra-managed key (e.g. tailscale TS_AUTHKEY)
  // under a different provider would silently flip the row's provider and
  // START injecting the raw key into every session shell — un-doing the
  // INFRA_ONLY exclusion (adversarial review of #326, finding F9b).
  if (existing && existing.provider !== prov && INFRA_ONLY_PROVIDERS.has(existing.provider)) {
    throw new Error(`"${k}" is managed by the ${existing.provider} integration (Dev Container settings) — update or delete it there.`);
  }
  if (existing && existing.provider !== prov && INFRA_ONLY_PROVIDERS.has(prov)) {
    throw new Error(`"${k}" already exists as a ${existing.provider} credential — delete it first to store the ${prov} key.`);
  }
  if (!existing) {
    const count = await prisma.codingCredential.count({ where: { userId } });
    if (count >= MAX_CREDS_PER_USER) throw new Error(`Credential limit reached (${MAX_CREDS_PER_USER}).`);
  }
  const row = await prisma.codingCredential.upsert({
    where,
    create: { userId, provider: prov, envKey: k, label: lbl, valueEnc: encryptValue(v) },
    update: { provider: prov, valueEnc: encryptValue(v) },
  });
  logger.info(`coding credentials: ${existing ? 'updated' : 'added'} ${prov}/${inject} for user ${userId.slice(0, 8)}`);
  return summaryFor(row, mask(v), true, valueCaseWarning(v));
}

export async function deleteCredential(userId: string, id: string): Promise<boolean> {
  const r = await prisma.codingCredential.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

/**
 * Decrypted env map for shell injection. Labeled credentials inject under
 * `envKey_LABEL`, primaries under the canonical envKey — so every stored
 * credential is live simultaneously and none can shadow another (rows in
 * createdAt order; a duplicate derived name would deterministically resolve
 * to the NEWEST row). Best-effort: rows that fail to decrypt (key rotation)
 * are skipped — a broken credential must never block a session command.
 */
/**
 * Providers whose credentials are INFRASTRUCTURE inputs (consumed by Digby's
 * own container plumbing), never shell material — excluded from session-env
 * injection. 'tailscale' holds the dev-container auth key (dev-container
 * .service.ts joins the user's tailnet with it); leaking it into every
 * session shell would let any repo script mint tailnet access.
 */
const INFRA_ONLY_PROVIDERS = new Set(['tailscale']);

/** Decrypted value of ONE credential row (infra consumers only — never shells). Null when absent/unreadable. */
export async function getCredentialValueDecrypted(userId: string, provider: string, envKey: string): Promise<string | null> {
  if (!userId) return null;
  const row = await prisma.codingCredential.findFirst({
    where: { userId, provider, envKey },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => null);
  if (!row) return null;
  try { return decryptValue(row.valueEnc); } catch { return null; }
}

/**
 * STRICT loader for the chat-visibility seam: same filtering rules as
 * getCredentialEnv, but a failed DB read THROWS instead of degrading to an
 * empty env (reviewer F1, ticket c02b85bf: `.catch(() => [])` there made a DB
 * outage read as "None stored" in chat — asserting a key is absent when the
 * read merely failed). Shell injection keeps the best-effort contract below
 * (a broken credential must never block a session command); only the NAMES
 * read needs to distinguish failure from emptiness.
 */
async function loadShellCredentialEnvStrict(userId: string): Promise<Record<string, string>> {
  if (!userId) return {};
  const rows = await prisma.codingCredential.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const env: Record<string, string> = {};
  let unreadable = 0;
  for (const r of rows) {
    if (INFRA_ONLY_PROVIDERS.has(r.provider)) continue; // infra inputs never reach shells
    const ik = injectedKeyFor(r.envKey, r.label || '');
    if (!ENV_KEY_RE.test(ik) || DENIED_ENV_KEYS.has(ik)) continue; // defense in depth
    try { env[ik] = decryptValue(r.valueEnc); } catch { unreadable++; /* skip unreadable */ }
  }
  if (unreadable > 0) {
    logger.warn(`coding credentials: ${unreadable} of ${rows.length} stored credential(s) UNREADABLE for user ${userId.slice(0, 8)} — JWT_SECRET drift? They are skipped until re-entered (Account → Coding).`);
  }
  return env;
}

export async function getCredentialEnv(userId: string): Promise<Record<string, string>> {
  return loadShellCredentialEnvStrict(userId).catch(() => ({}));
}

/**
 * NAMES ONLY of the env vars a coding-session shell receives (ticket c02b85bf).
 * Built from the SAME strict loader as getCredentialEnv (single source of
 * truth — one filtering rule-set), so the list is exactly what a spawned
 * session's shell will have: infra-only providers, denied/invalid derived
 * names, and rows that no longer decrypt are all excluded by the same rules.
 * This is the chat-side visibility seam: the per-user integration-status block
 * and get_account_overview render these names so a chat agent knows which keys
 * EXIST (and can hand work to a coding session to use them) without a value
 * ever leaving this module. Returns NULL on a failed read — callers omit the
 * line/field rather than assert "None stored" (reviewer F1).
 */
export async function listShellCredentialNames(userId: string): Promise<string[] | null> {
  try {
    const env = await loadShellCredentialEnvStrict(userId);
    return Object.keys(env).sort();
  } catch {
    // Failed read ≠ nothing stored: null makes BOTH callers omit the line /
    // field instead of rendering "None stored" / count:0 (reviewer F1) —
    // never assert a key is absent when the read merely failed.
    return null;
  }
}
