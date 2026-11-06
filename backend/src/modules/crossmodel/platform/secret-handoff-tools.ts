/**
 * Owner-secret hand-off — `store_secret` (audit 2026-10-06 T2-3).
 *
 * The gap (litellm audit F4, schooltime F1, others F4): an owner pastes a
 * key / password into a chat and asks the fleet to use it. There was no
 * sanctioned path from that paste to a lane: machine reads are redacted (D4),
 * so supervisors asked the owner to install it himself ("i sent it in the
 * chat why cant you do this for me"), lanes asked again ("STOP ASKING ME"),
 * and the eventual workaround — a supervisor relaying the plaintext with
 * send_chat_message — copied it into four more transcripts.
 *
 *   store_secret {envKey, label?, fromMessageId?, which?}   MUTATING
 *
 * HUMAN TURN: this turn's message or an earlier owner-typed row.
 * MACHINE RUN (ticket 37a875ee): ONLY via fromMessageId citing an
 * owner-authored row — the owner's paste IS the authorization, the value is
 * lifted server-side from that row and never transits agent context, so the
 * redaction posture is unchanged; a machine run without fromMessageId is
 * refused (a run on injected text must never choose what lands in the
 * owner's shell env).
 *
 * The SERVER lifts the value from the owner's OWN words — this turn's message
 * (ToolContext.userTurnText, threaded only on human turns) or, with
 * `fromMessageId`, an earlier user row the owner typed in a chat they own
 * (never an assistant row, an agent send or a schedule / hook / webhook wake).
 * The model never passes, retypes or echoes the value (a `value` argument is
 * ignored). The value goes into the existing encrypted per-user coding
 * credentials store (coding/credentials.service upsertCredential — AES-256-GCM
 * at rest, injected into every coding session shell of the account as
 * `$ENVKEY`, scrubbed from shell output), and the result names only the env
 * var.
 *
 * Telemetry: loop_metrics `store_secret` {outcome: stored | refused, reason?,
 * injectedKey?, source?, pattern?, replaced?, scannerPatterns?,
 * scannerStamp?} — the scanner fields (8a9ac61b) identify WHICH pattern
 * registry enumerated: version-skew self-diagnosis (different stamps on the
 * same paste = stale worker, retry from a fresh run; same stamp on a
 * missing shape = a real pattern gap). Refusal RESULTS additionally carry
 * `scanner` {patterns, stamp} and the ambiguous refusal `candidates`
 * (pattern names + char counts, never values). An Activity row
 * `coding_credential.store` per store (env name + source, never the value).
 * Kill switch STORE_SECRET_TOOL_DISABLED=1 (the tool refuses; nothing stored).
 *
 * Import-light (platform-tools.ts imports this statically): only the
 * secret-scan and work-tools leaves; prisma / credentials.service /
 * loop-metrics load dynamically inside the handler.
 */
import { findSecretSpans, redactSecrets, scannerStamp } from './secret-scan';
import { isHumanTurn } from './work-tools';

export const SECRET_HANDOFF_TOOL_NAMES = ['store_secret'] as const;
export type SecretHandoffToolName = (typeof SECRET_HANDOFF_TOOL_NAMES)[number];
export const isSecretHandoffTool = (name: string): name is SecretHandoffToolName =>
  (SECRET_HANDOFF_TOOL_NAMES as readonly string[]).includes(name);

export const SECRET_HANDOFF_TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'store_secret',
      description: "Store a credential the OWNER pasted (API key, token, password, passphrase) in their encrypted coding credentials so EVERY coding lane of this account gets it as $ENVKEY in its shell. The server lifts the value from the owner's OWN message — this turn's, or an earlier one they typed (fromMessageId, any chat they own); you never pass, retype or echo the value. Returns only the env var name(s) — then tell lanes to use \"$ENVKEY\" and never relay the value or ask for it again. Machine-triggered runs (schedule / hook / ticket wakes) MUST pass fromMessageId naming the owner's own paste: that paste IS the authorization. Re-storing the same envKey (+label) replaces it. SEVERAL values in one message: a credential-file paste whose values each name their own slot (access_token + refresh_token, an AWS pair) is vaulted in ONE call, each under a derived env var named in the result; otherwise the refusal lists the candidates — re-call with which, or all: true to vault every value.",
      parameters: {
        type: 'object',
        properties: {
          envKey: { type: 'string', description: 'UPPER_SNAKE env var name the lanes will read, e.g. HUE_PASSWORD or XIAOMI_MIMO_API_KEY (2-64 chars; shell / platform names are reserved). For a multi-value paste it is the PREFIX: envKey BREV_ACCESS_TOKEN stores access_token as BREV_ACCESS_TOKEN and refresh_token as BREV_REFRESH_TOKEN.' },
          label: { type: 'string', description: 'Optional: an ADDITIONAL credential under the same envKey, injected as ENVKEY_LABEL (e.g. WORK). Normalized to UPPER_SNAKE, ≤24 chars after normalization — a longer label is refused invalid_label, never truncated; keep it a short tag, not a sentence.' },
          fromMessageId: { type: 'string', description: "Optional: id of an EARLIER owner-typed message carrying the value (from get_chat_messages / search_chats), or an OWNER-QUESTION ANSWER id (oq_…, from list_owner_questions — full id or ≥8-char prefix) when the value was pasted on an inbox card." },
          which: { type: 'number', description: 'Optional 1-based pick when the message carries several credential-shaped values (the refusal lists them).' },
          all: { type: 'boolean', description: 'Optional: vault EVERY credential-shaped value in the cited message in this one call instead of asking which one (at most 8). Use after the ambiguous refusal when the owner pasted a whole credential file; each value lands under its own env var, named in the result.' },
        },
        required: ['envKey'],
      },
    },
  },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; machineTriggered?: boolean; userTurnText?: string; anonymous?: boolean };

const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }

/** Providers whose credentials are infrastructure inputs, never shell env
 *  (mirrors coding/credentials.service INFRA_ONLY_PROVIDERS). */
const INFRA_ONLY_PROVIDERS = new Set(['tailscale']);
/** metadata.origin values that mark MACHINE-authored "user" rows (chat-agent MACHINE_ROW_ORIGINS). */
const MACHINE_ROW_ORIGINS = new Set(['schedule', 'hook', 'agent', 'machine', 'webhook']);
/** Machine chrome that rides inside a user row's content (queue-time firing headers, harness notices). */
const MACHINE_CONTENT_PREFIX_RE = /^\s*\[(MACHINE-TRIGGERED RUN|HARNESS|SCHEDULED|HOOK)/i;
/** A value that is a reference / placeholder / an already-redacted note — never the secret itself. */
const PLACEHOLDER_VALUE_RE = /^(?:process\.env\.|\$|<|\[REDACTED|\{\{|\*|•)/;

export function storeSecretDisabled(): boolean {
  return process.env.STORE_SECRET_TOOL_DISABLED === '1';
}

export interface SecretCandidate { n: number; pattern: string; chars: number; context: string }
export type SecretExtraction =
  | { ok: true; value: string; pattern: string }
  | { ok: false; reason: 'none' }
  | { ok: false; reason: 'ambiguous'; candidates: SecretCandidate[] };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The few words before a span that name it (a label), with anything secret-looking masked. */
function labelContext(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 60), Math.max(0, index));
  const tokens = before.split(/\s+/).filter(Boolean).slice(-4);
  const masked = tokens.map((t) => (t.length >= 8 && (/\d/.test(t) || (/[a-z]/.test(t) && /[A-Z]/.test(t))) && !/^[A-Z0-9_]+[:=]?$/.test(t) ? '***' : t));
  return redactSecrets(masked.join(' ')).text.slice(-48);
}

/**
 * Lift the secret out of `text` (pure). Order:
 *  1. NAMED: `ENVKEY=value` / `ENVKEY: value` for the requested envKey — the
 *     owner literally named it, so no shape heuristic is needed;
 *  2. the shared scanner's spans (secret-scan findSecretSpans — provider
 *     tokens, credential assignments, password / passphrase labels, plain
 *     English, app passwords), deduped and ordered by position; one ⇒ it,
 *     several ⇒ `which` (1-based) or an `ambiguous` answer listing them
 *     (pattern + length + the label words before it — never the value).
 */
/**
 * One candidate value in a cited owner message, as the store leg sees it
 * (ticket f95e1e30). `label` is the span's own named-compound label when the
 * shared scanner supplied one (secret-scan `SecretSpan.label`) — the local
 * credential-file reader below fills it in for the OAuth pair shapes the
 * scanner leaves unlabelled.
 */
export interface HandoffSpan { n: number; value: string; pattern: string; index: number; label?: string }

/** The ordered, de-duplicated credential-shaped spans of `text`, position-sorted.
 *  The ONE enumeration both the single-value extractor and the multi-value plan
 *  read (ticket f95e1e30) — never a second registry.
 *
 *  `indices` keeps EVERY occurrence of a value, not just the first: an owner who
 *  echoes a token in prose before pasting the file would otherwise have the
 *  prose's label win the slot (review finding #5 of f95e1e30 — `my secret_key:
 *  <T>` followed by `{"access_token": "<T>"}` planned the access token as
 *  BREV_SECRET_KEY). The plan refuses a value whose occurrences disagree. */
export interface HandoffSpan { n: number; value: string; pattern: string; index: number; indices: number[]; label?: string }

export function handoffSpans(text: string): HandoffSpan[] {
  const src = String(text ?? '');
  const seen = new Set<string>();
  let spans: Array<{ name: string; value: string; index: number; label?: string }> = findSecretSpans(src)
    .filter((s) => { if (seen.has(s.value)) return false; seen.add(s.value); return true; })
    .map((s) => ({ ...s, index: src.indexOf(s.value) }))
    .sort((a, b) => a.index - b.index);
  // audit 2026-10-08 W4-5: no known shape — a message that SAYS it carries a token ("Token created", "API token",
  // "api key") accepts its high-entropy runs (≥ 32 chars, mixed case + digits, never hex / a uuid / a path / a URL)
  // as candidates: a dashboard paste of a provider token the scanner has no pattern for (a legacy 40-char
  // Cloudflare token) was otherwise unstorable. STORE_SECRET_CUED_TOKEN_DISABLED=1 restores "none".
  if (!spans.length && !cuedTokenDisabled()) spans = cuedTokenSpans(src);
  return spans.map((s, i) => {
    const indices: number[] = [];
    for (let at = src.indexOf(s.value); at !== -1; at = src.indexOf(s.value, at + 1)) {
      indices.push(at);
      if (indices.length >= 20) break; // a pathological repeat is already an ambiguity
    }
    return { n: i + 1, value: s.value, pattern: s.name, index: s.index, indices: indices.length ? indices : [s.index], ...(s.label ? { label: s.label } : {}) };
  });
}

/**
 * The credential-file FIELD NAME immediately before `index` (`"access_token":
 * "` → access_token, `refresh_token=` → refresh_token), UPPER_SNAKE, or null.
 *
 * Pure and LOCAL on purpose (ticket f95e1e30): the shared scanner's
 * `compoundCredentialLabel` only labels its NAMED_COMPOUND_TAILS set, so the
 * standard OAuth pair every CLI writes — `{"access_token": "...",
 * "refresh_token": "..."}` — arrives here UNLABELLED. Teaching secret-scan a
 * new tail would move a detector other surfaces read; this reader is a
 * store-leg-only interpretation of the same bytes.
 */
export function assignmentLabelBefore(text: string, index: number): string | null {
  const end = Math.max(0, Math.min(index, String(text ?? '').length));
  const window = String(text ?? '').slice(Math.max(0, end - 96), end);
  const m = /(?<![A-Za-z0-9_])["'`]?([A-Za-z][A-Za-z0-9_]{1,39})["'`]?[ \t]*[:=][ \t]*["'`]?$/.exec(window);
  if (!m) return null;
  const norm = m[1].toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return norm || null;
}

/**
 * Credential-file field names that each name a DISTINCT secret slot (ticket
 * f95e1e30). Matched as the whole label or as a `_`-suffixed tail, so
 * `BREV_ACCESS_TOKEN` and `accessToken` both resolve to `access_token`.
 *
 * DELIBERATELY NARROW: a bare `password` / `api key <value>` in prose names no
 * slot, so those pastes keep today's ambiguous-with-`which` refusal (pinned by
 * the existing tests). Only a paste whose EVERY value names its own slot is
 * vaulted in one call without asking.
 */
const MULTI_VAULT_FIELDS: ReadonlyArray<{ field: string; match: string }> = [
  { field: 'ACCESS_TOKEN', match: 'access_token' },
  { field: 'REFRESH_TOKEN', match: 'refresh_token' },
  { field: 'ID_TOKEN', match: 'id_token' },
  { field: 'SESSION_TOKEN', match: 'session_token' },
  { field: 'AUTH_TOKEN', match: 'auth_token' },
  { field: 'BEARER_TOKEN', match: 'bearer_token' },
  { field: 'CLIENT_SECRET', match: 'client_secret' },
  { field: 'SECRET_ACCESS_KEY', match: 'secret_access_key' },
  { field: 'ACCESS_KEY_ID', match: 'access_key_id' },
  { field: 'SECRET_KEY', match: 'secret_key' },
  { field: 'API_KEY', match: 'api_key' },
  { field: 'APIKEY', match: 'apikey' },
  { field: 'PRIVATE_KEY', match: 'private_key' },
];

/** How many values ONE multi-value call may vault (ticket f95e1e30). Small on
 *  purpose: the per-user credential cap is 50, and a paste this large is
 *  already a transcript worth reading rather than a key pair. */
export const MULTI_VAULT_MAX_SPANS = 8;

/** The env key a slot label maps to, given the caller's base envKey.
 *
 *  THE RULE (review findings #3 + #4 of f95e1e30): the caller's `envKey` owns the
 *  NAMESPACE; a slot label may only name the SLOT. Pre-fix a label that already
 *  ended in `_<field>` became the key outright, so a paste of
 *  `PROD_API_KEY: <A>` alongside a JSON pair wrote `PROD_API_KEY` — a live
 *  credential, under a name the caller never mentioned, silently REPLACED
 *  (`envKey: OTHER`). Never derive a key the caller did not name.
 *
 *  `envKey: BREV_ACCESS_TOKEN` + access_token ⇒ `BREV_ACCESS_TOKEN`;
 *  `envKey: BREV` + refresh_token ⇒ `BREV_REFRESH_TOKEN`. */
function multiVaultEnvKey(baseEnvKey: string, _label: string, field: string): string | null {
  const base = String(baseEnvKey ?? '').toUpperCase();
  // Strip a trailing slot so a pair paste under `BREV_ACCESS_TOKEN` does not
  // mint BREV_ACCESS_TOKEN_ACCESS_TOKEN.
  const stripped = base.replace(/_(?:ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SESSION_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|API_KEY|APIKEY|PRIVATE_KEY|TOKEN|SECRET|KEY|PASSWORD)$/, '');
  const prefix = stripped || base;
  if (!prefix) return null;
  const key = `${prefix}_${field}`;
  return key.length <= 64 ? key : null;
}

/**
 * A derived key that would SHADOW a platform-injected / reserved variable
 * (review finding #4/#6 of f95e1e30). `DENIED_ENV_KEYS` lists bare names
 * (`GITHUB_TOKEN`, `GH_TOKEN`, …), so `envKey: GITHUB` + an `access_token`
 * field minted `GITHUB_ACCESS_TOKEN` — a third-party OAuth token landing in
 * every lane's shell under a platform-looking name, and the exact-key check at
 * the store leg never fired.
 *
 * Matches on the STEM: the key itself, or `<stem>_<anything>` where `<stem>` is
 * a reserved name with its own credential-ish tail removed (`GITHUB_TOKEN` →
 * `GITHUB`). Pure. */
export function reservedKeyFamily(key: string, denied: ReadonlySet<string>): string | null {
  const k = String(key ?? '');
  if (denied.has(k)) return k;
  for (const d of Array.from(denied)) {
    const stem = d.replace(/_(?:ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SESSION_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|API_KEY|APIKEY|PRIVATE_KEY|TOKEN|SECRET|KEY|ID)$/, '');
    if (stem && stem !== d && k.startsWith(`${stem}_`)) return d;
  }
  return null;
}

export interface PlannedSecret { n: number; value: string; pattern: string; label: string; field: string; envKey: string }

/**
 * The ONE-CALL multi-value plan for `text` (ticket f95e1e30), or null.
 *
 * Fires when every credential-shaped value names its own DISTINCT slot:
 *  - two or more spans (a single value keeps the existing single path);
 *  - each span carries a recognised credential-file field name — the scanner's
 *    own compound label, or the local `assignmentLabelBefore` reader;
 *  - every derived envKey is distinct and env-key shaped.
 *
 * `all: true` (an explicit caller opt-in) relaxes the LABEL requirement: every
 * span is vaulted, an unlabelled one as `<PREFIX>_<n>`. That is the "vault
 * everything in this message" door — never the default, because ordinal names
 * carry no meaning the owner can use later.
 */
export function planMultiValueStore(
  text: string,
  baseEnvKey: string,
  opts: { all?: boolean; spans?: HandoffSpan[] } = {},
): { plan: PlannedSecret[] } | { reason: 'none' | 'single' | 'ambiguous' } {
  const src = String(text ?? '');
  const spans = opts.spans ?? handoffSpans(src);
  if (!spans.length) return { reason: 'none' };
  if (spans.length === 1 && !opts.all) return { reason: 'single' };
  if (spans.length > MULTI_VAULT_MAX_SPANS) return { reason: 'ambiguous' };
  const labelOf = (s: HandoffSpan): string | null => {
    const own = String(s.label ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (own) return own;
    // Reader labels from EVERY occurrence. A value the owner echoed in prose
    // before pasting the file (`my secret_key: <T>` … `{"access_token": "<T>"}`)
    // has two candidate slots; picking the first would silently store the
    // access token under BREV_SECRET_KEY (review finding #5 of f95e1e30).
    // Disagreement is a real ambiguity — return null so the caller refuses.
    const at = (s.indices ?? [s.index]).map((ix) => assignmentLabelBefore(src, ix));
    const distinct = Array.from(new Set(at.filter((l): l is string => !!l)));
    return distinct.length === 1 ? distinct[0] : null;
  };
  const fieldOf = (label: string | null): { field: string; match: string } | null => {
    if (!label) return null;
    // Separator-insensitive on BOTH sides: the real `credentials.json` most
    // CLIs write is camelCase (`accessToken`), which normalizes to
    // ACCESSTOKEN and would otherwise miss ACCESS_TOKEN (review advisory of
    // f95e1e30 — the reported shape's own spelling).
    const flat = label.toLowerCase().replace(/_/g, '');
    for (const f of MULTI_VAULT_FIELDS) {
      const fm = f.match.replace(/_/g, '');
      if (flat === fm || flat.endsWith(fm)) return f;
    }
    return null;
  };
  const basePrefix = String(baseEnvKey ?? '').toUpperCase()
    .replace(/_(?:ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SESSION_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|API_KEY|APIKEY|PRIVATE_KEY|TOKEN|SECRET|KEY|PASSWORD)$/, '')
    || String(baseEnvKey ?? '').toUpperCase() || 'OWNER';
  const plan: PlannedSecret[] = [];
  for (const s of spans) {
    const label = labelOf(s);
    const f = fieldOf(label);
    if (!f) {
      // Explicit `all` may still take an unnamed value — under an ordinal key.
      if (!opts.all) return { reason: 'ambiguous' };
      const key = `${basePrefix}_${s.n}`;
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(key)) return { reason: 'ambiguous' };
      plan.push({ n: s.n, value: s.value, pattern: s.pattern, label: label ?? '', field: '', envKey: key });
      continue;
    }
    const key = multiVaultEnvKey(baseEnvKey, label as string, f.field);
    if (!key) return { reason: 'ambiguous' };
    plan.push({ n: s.n, value: s.value, pattern: s.pattern, label: label as string, field: f.match, envKey: key });
  }
  if (plan.length < 1) return { reason: 'none' };
  if (plan.length === 1 && !opts.all) return { reason: 'single' };
  // A collision means two values claim ONE slot — never guess which one the
  // owner meant; fall back to the which-pick refusal that names both.
  const keys = new Set(plan.map((p) => p.envKey));
  if (keys.size !== plan.length) return { reason: 'ambiguous' };
  return { plan };
}

export function extractSecretForHandoff(text: string, envKey: string, which?: number | null): SecretExtraction {
  const src = String(text ?? '');
  if (envKey) {
    // Audit 2026-10-15 (todo 75be792c): a named `ENVKEY=-----BEGIN …-----`
    // assignment whose value is a MULTI-LINE PEM block. The one-token capture
    // below would otherwise grab just the literal `-----BEGIN` header word and
    // SILENTLY STORE a broken value (it passes every placeholder check) — the
    // block must be lifted whole, header to matching END.
    const pemNamed = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(envKey)}(?![A-Za-z0-9_])["'\\x60]?[ \\t]*[:=][ \\t]*["'\\x60]?(-----BEGIN [A-Z0-9 ]+-----[\\s\\S]*?-----END [A-Z0-9 ]+-----)`, 'i').exec(src);
    if (pemNamed) return { ok: true, value: pemNamed[1], pattern: 'Named PEM block' };
    const named = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(envKey)}(?![A-Za-z0-9_])["'\\x60]?[ \\t]*[:=][ \\t]*["'\\x60]?([^\\s"'\\x60]+)`, 'i').exec(src);
    if (named) {
      const v = named[1].replace(/[,;)\]}]+$/, '').replace(/\.$/, '');
      // A PEM header token is not a value — fall through to the scanner, which
      // lifts the whole block (never store the orphaned `-----BEGIN` word).
      if (v.length >= 4 && !PLACEHOLDER_VALUE_RE.test(v) && !/^-----BEGIN\b/.test(v)) return { ok: true, value: v, pattern: 'Named assignment' };
    }
  }
  const spans = handoffSpans(src);
  if (!spans.length) return { ok: false, reason: 'none' };
  if (spans.length === 1) return { ok: true, value: spans[0].value, pattern: spans[0].pattern };
  const pick = typeof which === 'number' && Number.isInteger(which) ? which : null;
  if (pick !== null && pick >= 1 && pick <= spans.length) return { ok: true, value: spans[pick - 1].value, pattern: spans[pick - 1].pattern };
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: spans.map((s) => ({ n: s.n, pattern: s.pattern, chars: s.value.length, context: labelContext(src, s.index) })),
  };
}

export function cuedTokenDisabled(): boolean {
  return process.env.STORE_SECRET_CUED_TOKEN_DISABLED === '1';
}
const TOKEN_CUE_RE = /\b(?:api[ _-]?(?:token|key)|access[ _-]?token|auth(?:entication)?[ _-]?token|bearer[ _-]?token|secret[ _-]?key|personal access token|token\s+(?:created|generated|value|summary)|your (?:new )?token)\b/i;
const HIGH_ENTROPY_RUN_RE = /(?<![A-Za-z0-9_\-./:@=])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-./:@])/g;
/** A run that looks like a generated credential: mixed case + a digit, not hex (a sha / hash) and not a uuid. Pure. */
function looksGenerated(run: string): boolean {
  if (/^[0-9a-f-]+$/i.test(run)) return false;
  return /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
}
/** The cued high-entropy runs of a message (pattern 'Cued token'), position-ordered. Pure. */
export function cuedTokenSpans(text: string): Array<{ name: string; value: string; index: number }> {
  const src = String(text ?? '');
  if (!TOKEN_CUE_RE.test(src)) return [];
  const out: Array<{ name: string; value: string; index: number }> = [];
  for (const m of src.matchAll(HIGH_ENTROPY_RUN_RE)) {
    const v = m[0];
    if (!looksGenerated(v) || out.some((o) => o.value === v)) continue;
    out.push({ name: 'Cued token', value: v, index: m.index ?? src.indexOf(v) });
  }
  return out;
}

function machineAuthoredRow(row: { role?: string | null; content?: string | null; metadata?: unknown }): boolean {
  if (row.role !== 'user') return true;
  const o = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>).origin : null;
  if (typeof o === 'string' && MACHINE_ROW_ORIGINS.has(o)) return true;
  return MACHINE_CONTENT_PREFIX_RE.test(String(row.content ?? ''));
}

/** How many recent credential-store audit rows the honest-miss vault lookup
 *  reads (ticket 365588cf 2b). The vault writes ONE activity row per answered
 *  card, so 25 covers a normal owner session; the filter is exact on
 *  (via, questionId), so a miss is a true "nothing captured from THIS card". */
const VAULT_LOOKBACK_ROWS = 25;

/** How many recent owner-typed rows of THIS chat a no_user_turn refusal may
 *  name (ticket 5fcbdd61). Small on purpose: a paste the owner is asking to
 *  bank is inevitably near the end of the transcript, and a long id list is a
 *  worse prompt than a short one. */
const OWNER_ROW_CANDIDATES = 5;

/**
 * The most recent OWNER-typed message ids of this chat — ids and timestamps
 * ONLY, never content (ticket 5fcbdd61).
 *
 * THE DEAD END THIS FIXES: a machine wake that reaches for a credential the
 * owner pasted in chat was refused `no_user_turn` and told to "re-call with
 * fromMessageId (get_chat_messages gives ids)" — so it had to spend a whole
 * extra tool round trip hunting for the id, and when the turn budget ran out
 * the paste simply sat unread while the owner was asked to re-paste a
 * long-lived credential. Production telemetry for that specimen shows exactly
 * this refusal (reason 'no_user_turn').
 *
 * Deliberately WEAKER than the store leg's validation: this list is a hint. A
 * row named from it still goes through the full owner-typing + ownership
 * checks when the caller cites it (machineAuthoredRow + chat.userId below), so
 * a wrong or hostile id here can never widen what store_secret will lift. The
 * filter is the SAME predicate the read path uses, so a row this helper names
 * is one the store leg would accept — no content is inspected beyond what is
 * needed to exclude machine rows.
 *
 * Never throws: any DB error yields [] and the refusal keeps its old shape.
 */
async function recentOwnerRowCandidates(ctx: Ctx): Promise<Array<{ id: string; at: string }>> {
  if (!ctx.sessionId) return [];
  const prisma = await db();
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId: ctx.sessionId, role: 'user' },
    orderBy: { createdAt: 'desc' },
    take: OWNER_ROW_CANDIDATES * 4,
    // content is selected ONLY to apply machineAuthoredRow's prefix test; it is
    // never returned, logged or put in the refusal.
    select: { id: true, role: true, content: true, metadata: true, createdAt: true },
  });
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r: any) => !machineAuthoredRow(r))
    .slice(0, OWNER_ROW_CANDIDATES)
    .reverse() // oldest first: the paste usually precedes the wake asking about it
    .map((r: any) => ({
      id: String(r.id ?? ''),
      at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ''),
    }))
    .filter((r) => r.id);
}

/** The envKeys the owner-answer vault already stored from THIS question's
 *  reply, read from its audit rows (ticket 365588cf 2b).
 *
 *  The vault records `{ via: 'owner_answer_vault', questionId, envKeys }` on
 *  every answered card (owner-questions.ts ~4097) — the ONLY durable record
 *  that ties a stored credential back to the card it came from, and the only
 *  source that survives the answer row being redacted at rest. Empty on any
 *  failure (best-effort: a refusal is never blocked by a lookup). Never
 *  returns a value — env NAMES only. */
async function vaultedEnvKeysForQuestion(userId: string, questionId: string): Promise<string[]> {
  try {
    const prisma = await db();
    const rows = await prisma.activity.findMany({
      where: { userId, action: 'coding_credential.store' },
      orderBy: { createdAt: 'desc' },
      take: VAULT_LOOKBACK_ROWS,
    });
    const keys: string[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const meta = row && typeof row.metadata === 'object' && row.metadata !== null ? (row.metadata as Record<string, unknown>) : null;
      if (!meta) continue;
      if (String(meta.via ?? '') !== 'owner_answer_vault') continue;
      if (String(meta.questionId ?? '') !== String(questionId ?? '')) continue;
      const named = Array.isArray(meta.envKeys) ? meta.envKeys : [];
      for (const k of named) {
        const name = String(k ?? '').trim();
        if (name && !keys.includes(name)) keys.push(name);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/** The declared slot of a credential-gated card (`credential:<ENVKEY>`), or
 *  null for a choice / yes_no / free card (ticket 365588cf 2b — the fallback
 *  pointer names the card's own key field only when the card HAS one). The
 *  envKey half is a NAME, never a value; it is echoed in a refusal only.
 *  Pure. */
function declaredEnvKeyOf(expected: unknown): string | null {
  const m = /^\s*credential:([A-Za-z][A-Za-z0-9_]{0,63})\s*$/.exec(String(expected ?? ''));
  return m ? m[1].toUpperCase() : null;
}

function recordStoreSecret(ctx: Ctx, meta: Record<string, unknown>): void {
  void import('./loop-metrics.service')
    .then((m: any) => { if (typeof m?.recordLoopMetric === 'function') m.recordLoopMetric({ kind: 'store_secret', sessionId: ctx.sessionId, meta: { chatId: ctx.sessionId, ...meta } }); })
    .catch(() => { /* telemetry never blocks */ });
}

export async function executeSecretHandoffTool(ctx: Ctx, name: SecretHandoffToolName, args: any): Promise<string> {
  const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}, metric: Record<string, unknown> = {}): string => {
    recordStoreSecret(ctx, { outcome: 'refused', reason, ...metric });
    return out({ ok: false, tool: name, reason, ...extra, message });
  };
  if (storeSecretDisabled()) {
    return refuse('disabled', 'store_secret is switched off on this instance (STORE_SECRET_TOOL_DISABLED=1). The owner can add the credential under Account → Coding → Credentials; never relay the value in a message.');
  }
  if (ctx.anonymous || !ctx.userId || String(ctx.userId).startsWith('anon')) {
    return refuse('anonymous', 'store_secret needs a signed-in user — this chat is anonymous.');
  }
  // Ticket 37a875ee: a machine run may store ONLY from an owner-authored row
  // (fromMessageId) — never from text the run itself holds (ctx.userTurnText is
  // machine-injected on a wake). On a HUMAN turn both paths stay open (the
  // owner is present; fromMessageId rows are owner-validated below either way).
  const fromIdArg = String(args?.fromMessageId ?? '').trim();
  if (!isHumanTurn(ctx) && !fromIdArg) {
    // Ticket 5fcbdd61 — THE DEAD END THIS REMOVES. This is the refusal an owner's
    // paste actually hits (production telemetry: reason 'no_user_turn' at
    // 05:30:32Z, chat 41bd202a — the run had no anchor and named no row). It used
    // to tell the caller to "re-call with fromMessageId (get_chat_messages gives
    // ids)" — a scavenger hunt the turn budget ran out of, so the paste sat
    // unread in the very chat the run was in and the owner was asked to re-paste.
    // Now the refusal NAMES the citable owner-typed rows of THIS chat. Ids and
    // timestamps only — never a byte of content and never a value — so nothing
    // secret transits the refusal, and the guard is NOT widened: the caller must
    // still pass fromMessageId explicitly and that row is still owner-validated
    // below. The run could already read these ids via get_chat_messages; this
    // only saves the round trip that was being lost.
    const candidates = await recentOwnerRowCandidates(ctx).catch(() => [] as Array<{ id: string; at: string }>);
    const named = candidates.length
      ? ` Owner-typed message(s) in THIS chat you can cite right now (oldest first; ids only): ${candidates.map((c) => `${c.id} (${c.at})`).join(', ')}. Re-call store_secret with fromMessageId set to one of those ids and the same envKey.`
      : '';
    return refuse('no_user_turn', `store_secret runs only on the owner's own turn — the value is lifted from THEIR message, never from text a machine-triggered run holds. A machine-triggered run may store from an EARLIER owner-typed message: re-call with fromMessageId naming the owner's paste.${named}${candidates.length ? '' : ' (No owner-typed row was found in this chat — read it with get_chat_messages / search_chats, or the owner can add the value under Account → Coding → Credentials.)'} Otherwise tell the owner (one line, in your reply) that it is stored the moment they next message this chat — or that they can add it under Account → Coding → Credentials. Do not ask for the value again and never relay it.`, candidates.length ? { candidateFromMessageIds: candidates.map((c) => c.id) } : {});
  }
  let envKey = String(args?.envKey ?? '').trim();
  if (/^[a-z][a-z0-9_]*$/i.test(envKey)) envKey = envKey.toUpperCase();
  const creds: any = await import('../coding/credentials.service');
  if (!creds.ENV_KEY_RE.test(envKey)) return refuse('invalid_env_key', 'envKey must be an UPPER_SNAKE env var name (letters, digits, underscores; 2-64 chars), e.g. HUE_PASSWORD.');
  if (creds.DENIED_ENV_KEYS.has(envKey)) return refuse('reserved_env_key', `"${envKey}" is reserved (a shell / platform variable) — pick another name, e.g. ${envKey}_USER.`);
  let label = '';
  try { label = creds.normalizeLabel(String(args?.label ?? '')); } catch (err: any) { return refuse('invalid_label', String(err?.message ?? err)); }

  // The owner's OWN words: this turn's message, or an earlier user row they typed.
  let text = '';
  let source: 'turn' | 'message' = 'turn';
  let sourceMessageId: string | null = null;
  const fromId = fromIdArg;
  const prisma = await db();
  // Ticket 365588cf (2a): this leg came from an OWNER-QUESTION ANSWER row.
  // The no_secret_found refusal below uses it to point at the vault instead of
  // dead-ending in a re-paste loop, and needs the question id to look the
  // vault's activity rows up. Only the oq_ leg sets it — the chat-message leg
  // keeps the plain refusal (an assistant row must stay not_owner_typed, and a
  // user row has no card to point back at).
  let oqLeg = false;
  let oqRowRef: { id: string; answer: string | null; answeredBy: string | null; userId: string; resolvedAt: Date | null; createdAt: Date; expectedAnswerType?: string | null } | null = null;
  if (fromId && /^oq_[0-9A-Za-z]{8,}/.test(fromId)) {
    // Ticket ca0b57cd: fromMessageId may name an OWNER-QUESTION ANSWER row —
    // the owner's credential paste on an inbox card. A supervisor repairing a
    // half-vaulted answer (the ca0b57cd specimen: only the first value of an
    // access-key + secret pair was vaulted) had no lawful path: the answer
    // text lives on the owner-question row, not in any chat message. Guards,
    // strictest-first: the row belongs to this user and was answered by the
    // OWNER (an answer_owner_question supervisor ruling or a preset default is
    // a machine/derived decision, never the owner's paste — same posture as
    // the vault leg's answeredBy === 'owner' check). On success the answer
    // text feeds the SAME extraction + store flow as a chat message below
    // (ambiguous candidates, no-secret refusal, infra-managed guard, audit) —
    // no separate store path.
    let oqRow: { id: string; answer: string | null; answeredBy: string | null; userId: string; resolvedAt: Date | null; createdAt: Date; expectedAnswerType?: string | null } | null = null;
    try {
      oqRow = await prisma.ownerQuestion.findUnique({
        where: { id: fromId },
        // b71367e5 (A6): resolvedAt/createdAt feed the freshness guard — a
        // select that omits them would read undefined and refuse EVERY row.
        // 365588cf (2b): expectedAnswerType tells the honest-miss refusal
        // whether the CARD declares a credential slot worth a re-paste.
        select: { id: true, answer: true, answeredBy: true, userId: true, resolvedAt: true, createdAt: true, expectedAnswerType: true },
      });
      // Fleet idiom (review A3 of 64705f7a8): every other owner-question
      // surface takes an ≥8-char id PREFIX (ops-tools dismiss_owner_question,
      // list_owner_questions, the Telegram short ref) — the exact-id
      // findUnique alone refused `oq_f04ac515`. Same shape: prefix resolve
      // only when the exact id missed, ambiguous when it matches two rows.
      if (!oqRow && fromId.length >= 8) {
        const cands: Array<{ id: string; answer: string | null; answeredBy: string | null; userId: string; resolvedAt: Date | null; createdAt: Date; expectedAnswerType?: string | null }> = await prisma.ownerQuestion.findMany({
          where: { userId: ctx.userId, id: { startsWith: fromId } },
          // b71367e5 (A6): same freshness fields as the exact-id read above.
          select: { id: true, answer: true, answeredBy: true, userId: true, resolvedAt: true, createdAt: true, expectedAnswerType: true },
          take: 2,
        }).catch(() => []);
        if (cands.length > 1) {
          return refuse('ambiguous', 'That prefix matches more than one owner question — pass the full oq_ id (list_owner_questions shows it).', { fromMessageId: fromId });
        }
        oqRow = cands[0] ?? null;
      }
    } catch { oqRow = null; }
    if (oqRow) {
      if (oqRow.userId !== ctx.userId) {
        return refuse('message_not_found', 'No owner-question answer with that id belongs to this account — copy the oq_ id from list_owner_questions.', { fromMessageId: fromId });
      }
      if (String(oqRow.answeredBy ?? '') !== 'owner') {
        return refuse('not_owner_typed', 'That owner question was answered by a supervisor or a preset default — only the owner\'s own pasted answer can carry a secret to store.', { fromMessageId: fromId });
      }
      // Ticket b71367e5 (ca0b57cd review advisory A6): a FRESHNESS guard on
      // the repair leg. Pre-fix, ANY owner-answered row — however old —
      // lifted into the vault under any caller-named envKey. A credential
      // that sat in a question row for weeks may long since be ROTATED or
      // REVOKED, and the card it answered may be superseded; minting a
      // stale value as a live credential (overwriting a newer one under the
      // same name) is exactly the silent-corruption class the vault exists
      // to prevent. Freshness measures the ANSWER (resolvedAt — when the
      // owner's paste landed), falling back to createdAt for legacy rows;
      // a null/invalid timestamp is fail-closed (refused as stale). Window:
      // STORE_SECRET_OQ_MAX_AGE_DAYS (default 7; an EMPTY or unparsable
      // value falls back to the default — never 0, the compose
      // Number('')===0 gotcha that silently disables numeric knobs).
      // Kill switch STORE_SECRET_OQ_FRESHNESS_DISABLED=1 restores the
      // unguarded leg.
      if (process.env.STORE_SECRET_OQ_FRESHNESS_DISABLED !== '1') {
        const rawMaxDays = process.env.STORE_SECRET_OQ_MAX_AGE_DAYS;
        const parsedDays = rawMaxDays === undefined || rawMaxDays === '' ? NaN : Number(rawMaxDays);
        const maxAgeDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
        const answeredAtMs = Date.parse(String((oqRow as any).resolvedAt ?? '')) || Date.parse(String((oqRow as any).createdAt ?? ''));
        const ageDays = Number.isFinite(answeredAtMs) ? (Date.now() - answeredAtMs) / 86_400_000 : Infinity;
        if (!Number.isFinite(answeredAtMs) || ageDays > maxAgeDays) {
          return refuse('stale_row',
            `That owner-question answer is ${Number.isFinite(answeredAtMs) ? `~${Math.floor(ageDays)}d old` : 'undated'} — past the ${maxAgeDays}-day window for lifting a value from a card row (the credential may be rotated or the card superseded; a machine lift of a stale value can silently overwrite a newer credential under the same name). Ask the owner to re-supply the value (store_secret on their next message, or Account → Coding → Credentials).`,
            { fromMessageId: fromId, ...(Number.isFinite(answeredAtMs) ? { ageDays: Math.floor(ageDays) } : {}), maxAgeDays });
        }
      }
      text = String(oqRow.answer ?? '');
      source = 'message';
      sourceMessageId = oqRow.id;
      // Ticket 365588cf (2a): the guards all passed — this leg IS an
      // owner-answered card, so a no_secret_found may look the vault up.
      oqLeg = true;
      oqRowRef = oqRow;
    } else {
      return refuse('message_not_found', 'No owner question with that id exists — copy the oq_ id from list_owner_questions (or a chat message id from get_chat_messages).', { fromMessageId: fromId });
    }
    // fall through to the shared extraction + store flow with text set.
  } else if (fromId) {
    const row = await prisma.crossModelMessage.findUnique({
      where: { id: fromId },
      select: { id: true, role: true, content: true, metadata: true, chat: { select: { userId: true } } },
    }).catch(() => null);
    if (!row || row.chat?.userId !== ctx.userId) {
      return refuse('message_not_found', 'No message in a chat you own has that id — copy it from get_chat_messages / search_chats.', { fromMessageId: fromId });
    }
    if (machineAuthoredRow(row)) {
      return refuse('not_owner_typed', 'That message was not typed by the owner (an assistant row, an agent send, or a schedule / hook / webhook wake) — only the owner\'s own words can carry a secret to store.', { fromMessageId: fromId });
    }
    text = String(row.content ?? '');
    source = 'message';
    sourceMessageId = row.id;
  } else {
    text = String(ctx.userTurnText ?? '');
  }

  const which = typeof args?.which === 'number' ? args.which : (typeof args?.which === 'string' && /^\d+$/.test(args.which) ? Number(args.which) : null);
  // ── Ticket f95e1e30: ONE call vaults EVERY value ─────────────────────────
  // The measured flow (chat 41bd202a, 05:29Z): the owner pasted Brev's
  // credentials.json — `{"access_token": …, "refresh_token": …}` — and asked
  // "if I send you a key in the chat you need ability to store it permanently
  // for me autonomously". The pre-fix tool stored ONE value per call, so a
  // refresh-token half either needed a second turn or (worse) was silently
  // left behind when a NAMED assignment matched first — the same
  // silent-partial-vault class as ca0b57cd.
  //
  // Two doors, both inside the existing owner-row guards above:
  //  - AUTOMATIC: every credential-shaped value names its own DISTINCT slot
  //    (`access_token` / `refresh_token` / `client_secret` / the AWS pair …),
  //    so the derived keys are meaningful and no question is worth a turn;
  //  - EXPLICIT `all: true`: vault every value, unnamed ones as `<PREFIX>_<n>`.
  // Anything else (bare `password`, prose "api key …", duplicate slots) keeps
  // today's ambiguous-with-`which` refusal byte-for-byte.
  const allArg = args?.all === true || args?.all === 'true';
  if (which === null) {
    const planned = planMultiValueStore(text, envKey, { all: allArg });
    // ONE value is never a multi-value store: the single-value path below owns
    // it (a NAMED `ENVKEY=…` assignment, `which`, the honest-miss wording). A
    // 1-length plan here would only re-derive a key the caller already named.
    if ('plan' in planned && planned.plan.length > 1) {
      const plan = planned.plan;
      const stored: Array<{ envKey: string; injectedKey: string; replaced: boolean; label: string }> = [];
        const unstored: Array<{ n: number; pattern: string; reason: string }> = [];
        for (const item of plan) {
          // A DERIVED name gets the same guards the caller's envKey passed
          // above, PLUS a family check (ticket f95e1e30, review #4/#6): the
          // exact-name DENIED set lists bare GITHUB_TOKEN but not
          // GITHUB_ACCESS_TOKEN, so an exact check alone let `envKey: GITHUB`
          // + an access_token field mint a platform-looking name for a
          // third-party OAuth token.
          const reservedFamily = reservedKeyFamily(item.envKey, creds.DENIED_ENV_KEYS);
          if (!creds.ENV_KEY_RE.test(item.envKey) || reservedFamily) {
            unstored.push({ n: item.n, pattern: item.pattern, reason: `derived key ${item.envKey} is not storable (${reservedFamily ? `reserved family ${reservedFamily}` : 'invalid name'}) — pass an explicit envKey with which: ${item.n}` });
            continue;
          }
          try {
            const prior = await prisma.codingCredential.findUnique({
              where: { userId_envKey_label: { userId: ctx.userId, envKey: item.envKey, label } },
              select: { provider: true },
            }).catch(() => null);
            if (prior && INFRA_ONLY_PROVIDERS.has(prior.provider)) {
              unstored.push({ n: item.n, pattern: item.pattern, reason: `infra_managed:${prior.provider}` });
              continue;
            }
            const itemSummary: any = await creds.upsertCredential(ctx.userId, prior?.provider ?? 'custom', item.envKey, item.value, label);
            const itemInjected = String(itemSummary?.injectedKey ?? (label ? `${item.envKey}_${label}` : item.envKey));
            stored.push({ envKey: item.envKey, injectedKey: itemInjected, replaced: !!prior, label: item.label });
            try {
              await prisma.activity.create({ data: { userId: ctx.userId, action: 'coding_credential.store', resource: 'platform', metadata: { via: 'store_secret', chatId: ctx.sessionId, envKey: itemInjected, source, pattern: item.pattern, replaced: !!prior, multi: plan.length, slot: item.field || null, ...(sourceMessageId ? { sourceMessageId } : {}) } } });
            } catch { /* the audit row never fails the tool */ }
          } catch (err: any) {
            // Per-item isolation (ticket f95e1e30): one refused value (a slot
            // mismatch, a multi-line non-PEM, the per-user cap) must never
            // abort its siblings — the sibling half of a token pair surviving
            // while the other is NAMED unstored is the whole point.
            unstored.push({ n: item.n, pattern: item.pattern, reason: String(err?.message ?? err).slice(0, 300) });
          }
        }
        if (stored.length) {
          try {
            const { invalidateIntegrationStatusCache } = await import('../langgraph/integration-status-cache');
            await invalidateIntegrationStatusCache(ctx.userId);
          } catch { /* cache hygiene never fails the store */ }
        }
        if (!stored.length) {
          return refuse('store_failed', `None of the ${plan.length} credential-shaped values in that message could be stored: ${unstored.map((u) => `#${u.n} ${u.pattern} — ${u.reason}`).join('; ')}. Nothing was stored. Fix the named cause (or ask the owner to re-send that one value alone) — the others on their own would store.`, { unstored }, { unstoredPatterns: unstored.map((u) => u.pattern) });
        }
        recordStoreSecret(ctx, { outcome: 'stored', injectedKey: stored.map((s) => s.injectedKey).join(','), source, pattern: 'multi', replaced: stored.some((s) => s.replaced), multi: stored.length, unstored: unstored.length });
        const list = stored.map((s) => `$${s.injectedKey}`).join(', ');
        const unstoredNote = unstored.length
          ? ` NOT stored: ${unstored.map((u) => `#${u.n} ${u.pattern} (${u.reason})`).join('; ')} — re-call store_secret with which: ${unstored[0].n} and an explicit envKey for that one value, or ask the owner for it on its own.`
          : '';
        return out({
          ok: true,
          tool: name,
          envKey: stored[0].envKey,
          injectedKey: stored[0].injectedKey,
          envKeys: stored.map((s) => s.envKey),
          injectedKeys: stored.map((s) => s.injectedKey),
          stored: stored.map((s) => ({ envKey: s.envKey, injectedKey: s.injectedKey, replaced: s.replaced, slot: s.label || null })),
          ...(unstored.length ? { unstored } : {}),
          label: label || null,
          replaced: stored.some((s) => s.replaced),
          ids: { envKey: stored[0].injectedKey, envKeys: stored.map((s) => s.injectedKey) },
          source,
          ...(sourceMessageId ? { sourceMessageId } : {}),
          pattern: 'multi',
          message: `Stored ${stored.length} credential${stored.length === 1 ? '' : 's'} from that one message — ${list}. Every coding session shell of this account has them from its next command (encrypted at rest, scrubbed from shell output). Tell lanes to use ${stored.length === 1 ? 'that variable' : 'those variables'} by name — never paste a value into a message, and do not ask the owner for them again.${stored.some((s) => s.replaced) ? ' One or more REPLACED the previous value stored under that name.' : ''}${unstoredNote}`,
        });
    }
  }
  const found = extractSecretForHandoff(text, envKey, which);
  if (!found.ok && found.reason === 'ambiguous') {
    // Audit 2026-10-16 (todo 8d15611c) observe-only channel: WHICH pattern
    // families the scanner offered on an ambiguous paste — pattern names and
    // char counts only, never a value or label context. This is the row that
    // shows the new provider shapes lifting in production (the LiteLLM
    // specimen re-probe: 8 candidates incl. 'Alibaba Model Studio key').
    // Audit 2026-10-16 (todo 8a9ac61b): the stamp identifies WHICH pattern
    // registry enumerated — two refusals of the same paste with different
    // stamps = version skew (a draining worker on an older build: retry from
    // a fresh run), the same stamp on a missing shape = a REAL pattern gap.
    const stamp = scannerStamp();
    return refuse('ambiguous', `That message carries ${found.candidates.length} credential-shaped values — re-call store_secret with which: <n> (and the same envKey). Candidates (the value is never shown): ${found.candidates.map((c) => `#${c.n} ${c.pattern} (${c.chars} chars) after "${c.context}"`).join('; ')}.`, { candidates: found.candidates, scanner: stamp }, { candidatePatterns: found.candidates.map((c) => ({ n: c.n, pattern: c.pattern, chars: c.chars })), scannerPatterns: stamp.patterns, scannerStamp: stamp.stamp });
  }
  if (!found.ok) {
    // 8a9ac61b: the stamp rides this refusal too — a no_secret_found on a
    // paste that LOOKS like a credential is the exact case where the reader
    // must be able to tell "old scanner" (version skew: retry from a fresh
    // run) from "unknown shape" (a real pattern gap: file the shape) apart.
    const stamp = scannerStamp();
    // ── Ticket 365588cf (2b): the oq_ leg's HONEST MISS.
    // THE MEASURED DEFECT: an owner pasted an AWS access-key PAIR into a
    // 'choice' card's free-text reply box. The scanner knew only the key ID,
    // so the secret was destroyed; a supervisor then called store_secret
    // {fromMessageId: <oq id>} to repair it, the resolving answer held no
    // liftable value any more (it had been redacted / notice-stamped), and the
    // tool answered a bare `no_secret_found` — a DEAD END that says nothing
    // about the vault. The supervisor's only next move was asking the owner to
    // re-paste a credential the vault may ALREADY hold, which is exactly the
    // re-paste loop the vault exists to end. So: when this leg came from an
    // owner-answered card, look for the vault's own audit rows for THAT card
    // (activity coding_credential.store, via 'owner_answer_vault', questionId
    // = the FULL id — owner-questions.ts:4097) and, if any exist, point at the
    // envKeys they name instead of dead-ending.
    const vaultedKeys = oqLeg && oqRowRef ? await vaultedEnvKeysForQuestion(ctx.userId, oqRowRef.id) : [];
    if (oqLeg && vaultedKeys.length) {
      const list = vaultedKeys.map((k) => `$${k}`).join(', ');
      return refuse('no_secret_found',
        `The resolving answer holds no liftable value (it was already captured and redacted at rest), but the vault ALREADY holds a credential captured from this card's reply — stored as ${vaultedKeys.join(', ')} and live in every coding-session shell of this account as ${list}. Use the env var directly (never re-paste); if a specific slot is empty, re-supply only that half via store_secret on a fresh paste, or Account → Coding → Credentials.`,
        { ...(sourceMessageId ? { fromMessageId: sourceMessageId } : {}), scanner: stamp, vaultedEnvKeys: vaultedKeys },
        { scannerPatterns: stamp.patterns, scannerStamp: stamp.stamp, vaultedEnvKeys: vaultedKeys });
    }
    // The card's own declaration, for the no-vault fallback: a credential card
    // names the slot worth re-supplying, so the pointer is specific.
    const declaredKey = oqLeg && oqRowRef ? declaredEnvKeyOf(oqRowRef.expectedAnswerType) : null;
    const cardFallback = `Ask the owner to re-supply it${declaredKey ? ` in the card's key field (${declaredKey})` : ' on the card'} or one line \`${envKey || 'ENVKEY'}=<value>\` in chat (then re-call store_secret), or to add it under Account → Coding → Credentials.`;
    return refuse('no_secret_found', oqLeg
      // The oq_ leg never says "that message is stored unredacted" — the row
      // IS a redacted answer row by the time it is read, and a re-paste prompt
      // with no vault context is the dead end this ticket removes.
      ? `That owner-question answer carries no credential-shaped value${envKey ? ` (and no ${envKey}=… line)` : ''}, and the vault holds no credential captured from this card, so there is nothing to lift and nothing already stored. ${cardFallback}`
      : source === 'turn'
        ? `This turn's message carries no credential-shaped value${envKey ? ` (and no ${envKey}=… line)` : ''}. If the owner pasted it in an EARLIER message, re-call with fromMessageId (get_chat_messages / search_chats give ids) — do not ask them to paste it again.`
        // audit 2026-10-08 W4-5: say "redacted" only when a redaction marker is actually in the stored row — the
        // old line blamed a redaction that never happened (the row held the unredacted token in a shape the scanner
        // did not know). STORE_SECRET_HONEST_MISS_DISABLED=1 restores the old wording.
        : (process.env.STORE_SECRET_HONEST_MISS_DISABLED === '1' || /\[REDACTED/.test(text)
          ? `That message carries no credential-shaped value${envKey ? ` (and no ${envKey}=… line)` : ''} — its stored copy may already be redacted. The owner can add it under Account → Coding → Credentials.`
          : `That message is stored unredacted, but no value in it matches a credential shape this tool knows${envKey ? ` and it has no ${envKey}=… line` : ''}. Do not guess or retype it: ask the owner to send it once more as one line \`${envKey || 'ENVKEY'}=<value>\` (then call store_secret on that turn), or to add it under Account → Coding → Credentials.`),
    { ...(sourceMessageId ? { fromMessageId: sourceMessageId } : {}), scanner: stamp }, { scannerPatterns: stamp.patterns, scannerStamp: stamp.stamp });
  }

  const existing = await prisma.codingCredential.findUnique({
    where: { userId_envKey_label: { userId: ctx.userId, envKey, label } },
    select: { provider: true },
  }).catch(() => null);
  if (existing && INFRA_ONLY_PROVIDERS.has(existing.provider)) {
    return refuse('infra_managed', `"${envKey}" is managed by the ${existing.provider} integration (Dev Container settings) — it never reaches session shells. Store the value under a different envKey.`);
  }
  let summary: any;
  try {
    summary = await creds.upsertCredential(ctx.userId, existing?.provider ?? 'custom', envKey, found.value, label);
  } catch (err: any) {
    // Audit 2026-10-15 (todo 75be792c): a multi-line value that is NOT a
    // well-formed PEM block (truncated paste, prose after the END marker) is
    // refused with the PEM shape named — the old "Value must be a single
    // line." told the agent nothing actionable and the owner re-pasted twice.
    return refuse('store_failed', `Could not store it: ${String(err?.message ?? err)}${/\n|\r/.test(found.value) && !/too long/i.test(String(err?.message ?? '')) ? ' A multi-line value is storable only as one complete PEM block (-----BEGIN…----- to -----END…-----, nothing before or after). If the paste was truncated, ask the owner to re-send the full block in chat — the Account → Coding → Credentials form cannot hold multi-line values (its input strips newlines).' : ''}`);
  }
  // Ticket c02b85bf: the chat-side [YOUR INTEGRATION STATUS] block lists stored
  // credential NAMES — drop its Redis copy so the just-stored key is visible to
  // the very next chat turn instead of after the 5-min TTL.
  try {
    const { invalidateIntegrationStatusCache } = await import('../langgraph/integration-status-cache');
    await invalidateIntegrationStatusCache(ctx.userId);
  } catch { /* cache hygiene never fails the store */ }
  const injectedKey = String(summary?.injectedKey ?? (label ? `${envKey}_${label}` : envKey));
  try {
    await prisma.activity.create({ data: { userId: ctx.userId, action: 'coding_credential.store', resource: 'platform', metadata: { via: 'store_secret', chatId: ctx.sessionId, envKey: injectedKey, source, pattern: found.pattern, replaced: !!existing, ...(sourceMessageId ? { sourceMessageId } : {}) } } });
  } catch { /* the audit row never fails the tool */ }
  recordStoreSecret(ctx, { outcome: 'stored', injectedKey, source, pattern: found.pattern, replaced: !!existing });
  const warning = typeof summary?.warning === 'string' && summary.warning ? ` ⚠ ${summary.warning}` : '';
  return out({
    ok: true,
    tool: name,
    envKey,
    injectedKey,
    label: label || null,
    replaced: !!existing,
    // Receipt ids (audit 2026-10-16 todo 77c88942, LiteLLM specimen 8fae35a4):
    // a successful store is a CLAIMABLE action ("banked/stored JWT_PRIVATE_KEY")
    // the unbacked-claim guard verifies like any send/dispatch — the env var
    // NAME is the id. NEVER the value: no key material reaches a receipt row
    // (inputHash/outputHash are sha256 digests of the args/result, and the
    // result carries only this name).
    ids: { envKey: injectedKey },
    source,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    pattern: found.pattern,
    message: `Stored as $${injectedKey}: every coding session shell of this account has it from its next command (encrypted at rest, scrubbed from shell output). Tell lanes to use "$${injectedKey}" — e.g. sshpass -p "$${injectedKey}" … or curl -H "Authorization: Bearer $${injectedKey}" — never paste the value into a message, and do not ask the owner for it again.${existing ? ' It REPLACED the previous value stored under that name.' : ''}${warning}`,
  });
}
