/**
 * Shared secret-shape scanning (remediation P1 item N9, 2026-09-08).
 *
 * ONE pattern set for every credential-shaped-string check in the codebase:
 *  - commit-time diff scanning (coding/tools.ts scanDiffForSecrets — the
 *    original home of these patterns, session fa767dbf);
 *  - INBOUND text redaction (new): owner-question ANSWERS and supervisor
 *    directives are typed by a human and rendered into future prompts — an
 *    owner once pasted a password into an inbox answer and it sat in two DB
 *    rows, re-injected into every later wake prompt. Those persistence paths
 *    now store the redacted form.
 *
 * LEAF MODULE — no imports. It is pulled into jest graphs from tools.ts,
 * owner-questions.ts and supervisor-state.service.ts; an import of
 * config/env here would process.exit(1) half the test suite (the
 * machine-wake.ts discipline).
 *
 * NOTE (deliberate scope): existing DB rows are NOT retroactively scrubbed by
 * a deploy — the owner-run one-shot `scripts/framework-audit/scrub-stored-secrets.js`
 * (dry-run by default, `--apply` writes) rewrites supervisor_state directives /
 * owner_questions answers through redactSecrets on demand.
 * (The commit-time diff scan predates this module and keeps its own
 * [allow-secrets] escape.)
 *
 * 2026-09-27 (secret-scrubbing audit finding D4 — a pasted Z.ai key in a lane
 * message rode get_chat_messages into a supervisor directive and PERSISTED
 * because the pattern list had no Z.ai shape and chat-read tool output was
 * never redacted):
 *  - SECRET_PATTERNS gains the Z.ai `id.secret` shape (32 hex . 16 alnum) —
 *    structural, so it joins the shared set (commit-time scan + G4 + inbound);
 *  - INBOUND_ONLY_PATTERNS: a generic `api_key|token|secret|password = <value>`
 *    ASSIGNMENT shape, redaction-only (never the commit gate — `token=process.env.X`
 *    style lines are normal code; the value charset stops at quotes/brackets so a
 *    JSON envelope stays valid and env-var references are exempt);
 *  - redactChatReadSecrets: the tool-output entry point for get_chat_messages /
 *    get_run_receipts on MACHINE runs (no user turn — the supervisor harvest
 *    path). CHAT_READ_SECRET_REDACT_ALL=1
 *    widens it to user-present turns too. Fail-open: any throw returns the input.
 *
 * Review fixes (same day, same branch):
 *  - the assignment shape is NARROWED before it touches human persist paths:
 *    cursor / anti-forgery labels (`next_token`, `nextToken`, `page_token`,
 *    `csrf_token`, `cancellation token`, …) are exempt, the value must carry an
 *    entropy signal (mixed case + a digit, or ≥24 mostly-alphanumeric chars that
 *    are not `-`/`_`-joined prose words — `your-super-secret-jwt-key-…`,
 *    `dgt_paste_your_agent_token_here`, `localStorage.getItem` never hit), and
 *    the value stops at `&` (a URL query tail survives) and at `\` (a JSON
 *    escape sequence survives, so a serialized envelope stays valid);
 *  - redactStringsDeep: redact per STRING LEAF of an object (the envelope is
 *    serialized AFTER redaction — never a regex over JSON text);
 *  - findSecretSpans: the matched substrings (for the scrub script's
 *    `--show-masked` dry run), never printed unmasked by any caller.
 *
 * 2026-09-28 (backlog audit T6 — an owner answer carrying a Gmail APP
 * PASSWORD persisted verbatim: the shape has no prefix and no entropy signal,
 * so neither the structured set nor the assignment shape saw it):
 *  - CONTEXT_GATED_PATTERNS: the 16-lowercase-letter app-password shape (four
 *    spaced groups as Google displays it, or contiguous), redacted ONLY when a
 *    credential cue (`app password`, `gmail`, `smtp`, `secret`) sits within
 *    APP_PASSWORD_CUE_WINDOW chars of it. Redaction-only — never the commit
 *    gate. The one-shot for
 *    an already-stored row is `scripts/framework-audit/redact-owner-question-answer.js`.
 *
 * 2026-10-06 (audit 2026-10-06 T2-1 — three owner-typed human passwords /
 * one 10-word passphrase persisted verbatim and rode every later supervisor
 * wake: an 8–15-char password after `password:` missed the ≥16 + entropy bar
 * of the assignment shape, "passphrase" was not a label at all, and plain
 * English ("the password to X is Y") had no shape):
 *  - PASSWORD_LABEL_PATTERNS (redaction-only, never the commit gate):
 *    'Passphrase' — a passphrase-family label (passphrase / recovery|seed|
 *    security|backup phrase / mnemonic) followed by up to 30 words;
 *    'App password' — a password label + an exact 4x4 app-password value;
 *    'Password' — a password-family label (password / passwd / passcode /
 *    pwd / pw / pass / pin / secret, `db_password`-style compounds included)
 *    with a `:` / `=` separator, a prose "is" ("my pw is X") or a target
 *    clause ("password for the bridge is X" / "password to X: Y"), and ONE
 *    value token of ≥ 6 chars. The value is judged in code
 *    (passwordTokenToRedact): env refs, templates, placeholders, masks,
 *    [REDACTED, CONSTANT_NAMES, URLs / paths, code calls / member paths,
 *    versions and plain words / identifiers stay; a plain lowercase word is
 *    redacted only after an explicit `password:` label (and never one of
 *    NON_VALUE_WORDS — "required", "string", "unchanged" …); `pin` redacts
 *    digits only; `pass` (test summaries, boarding passes) needs mixed case +
 *    a digit or a digit + a symbol.
 *    Kill switch SECRET_SCAN_PASSWORD_LABELS_DISABLED=1 drops all three
 *    (byte-for-byte the previous redaction).
 *  - redactOutboundSecrets / outboundRedactionNotice: the OUTBOUND entry point
 *    (send_chat_message bodies, notify_user text — machine AND human turns),
 *    kill switch OUTBOUND_SECRET_REDACT_DISABLED=1.
 *
 * 2026-10-16 (audit 2026-10-16 todo 8d15611c, scanner side — the LiteLLM
 * 8-key paste): four more provider shapes join SECRET_PATTERNS, all measured
 * structure-only from the live specimen (masked head/tail, never the value):
 *  - 'Alibaba Model Studio key' — sk-sp- (token-plan) / sk-ws- (metered) with
 *    DOTS in the body (114/116 chars live). The generic sk- entry has no '.'
 *    in its charset, so these were invisible to every surface (redaction,
 *    commit gate, store_secret's lifter) — the gateway supervisor's probe saw
 *    ONLY the 4 already-stored batch-1 keys as candidates;
 *  - 'xAI API key' — xai- + pure-alnum body (84 chars live);
 *  - 'OpenAI token-plan id' — o1_ + dotted body (129 chars live).
 *  The two sk- entries sit BEFORE the generic 'OpenAI/Anthropic-style key' so
 *  the SPECIFIC match wins containment (redactImpl applies patterns in list
 *  order; a future key whose first dot-free segment ≥20 chars would otherwise
 *  also match the generic shape ⇒ two spans ⇒ a false 'ambiguous' refusal and
 *  a partial-token store). Observe-only channel: the store_secret loop metric
 *  carries pattern on stores and candidate pattern families on ambiguous
 *    refusals (secret-handoff-tools.ts) — values never, pattern names only.
 */

/** Secret-shaped string patterns (structured provider tokens — deliberately
 *  NOT a "looks like a password" heuristic, which would eat normal prose). */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'HuggingFace token', re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  // Alibaba Cloud Model Studio / DashScope keys (audit 2026-10-16 todo
  // 8d15611c, specimen: the owner's 8-key LiteLLM paste msg 1c7e9a72): the
  // token-plan and metered shapes are `sk-sp-…` / `sk-ws-…` with DOTS in the
  // body (measured live: 114/116 chars, 3 dots each) — the generic sk- entry
  // below has NO `.` in its charset, so these were invisible to the scanner
  // AND to store_secret's lifter (the gateway supervisor's 17:56Z probe: 4
  // already-stored keys offered as candidates #1-4, the four targets missing).
  // This entry sits BEFORE the generic one: a dotted sk-sp- key would
  // otherwise ALSO match the generic shape at its first dot-free segment
  // (two spans ⇒ a false 'ambiguous' refusal and a partial-token store).
  // The body floor (≥60) sits above prose (sk-sp-my-account-key…) and below
  // every measured real key (114/116). Same class as cfat_ (82dd8756) /
  // tskey- (4e8257c4).
  { name: 'Alibaba Model Studio key', re: /\bsk-(?:sp|ws)-[A-Za-z0-9_.-]{60,}\b/ },
  // xAI console keys (same audit): `xai-` + a pure-alphanumeric body
  // (measured live: 84 chars, 80-char body, no separators). The generic sk-
  // shape does not cover the xai- prefix at all.
  { name: 'xAI API key', re: /\bxai-[A-Za-z0-9]{40,}\b/ },
  // OpenAI token-plan / project ids (same audit): `o1_` prefix with dots and
  // a hyphen in the body (measured live: 129 chars, mixed case + digits).
  // The underscore prefix is otherwise unknown to the set.
  // 8a9ac61b provenance note: in the LiteLLM specimen (msg 1c7e9a72) the
  // o1_-shaped value rides an Alibaba bailian token-plan curl line — the
  // PREFIX is OpenAI's token-plan convention but the shape is deliberately
  // provider-agnostic (structural, like the Z.ai entry); do NOT rename the
  // pattern per provider and do not split it — a store of an Alibaba
  // token-plan id under this pattern name is correct, not a mismatch.
  // FIELD-VERIFIED SEMANTICS (gateway install 2026-10-17, census 12→28/50,
  // 24/24 probes 200): the o1_-shaped value is the bailian token-plan
  // BOOTSTRAP/PLAN ID, not a bearer — it 401s on every endpoint (a bogus-key
  // control 401s identically) and rides in token-plan config plumbing, never
  // an Authorization header; the sk-sp 'Alibaba Model Studio key' is the
  // token-plan bearer (200 on token-plan…maas.aliyuncs.com). Map lifts
  // accordingly when handing keys to a gateway.
  { name: 'OpenAI token-plan id', re: /\bo1_[A-Za-z0-9_.-]{60,}\b/ },
  { name: 'OpenAI/Anthropic-style key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Z.ai / ZhipuAI keys are `<32 hex>.<16 alnum>` (the ZAI_API_KEY id.secret format).
  { name: 'Z.ai API key', re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/ },
  // Cloudflare's scannable credential format (ticket 82dd8756): `cfk_` Global API
  // Key, `cfut_` User API Token, `cfat_` Account API Token — prefix + 40 chars +
  // checksum (developers.cloudflare.com/fundamentals/api/get-started/token-formats/).
  // The live mishap: an owner pasted a `cfat_` token, store_secret lifted text via
  // findSecretSpans, NOTHING matched (no provider prefix here, no `KEY=value` line
  // for the assignment shape) and the correct fromMessageId was refused
  // no_secret_found three times. Provider-prefixed like hf_/ghp_ above.
  { name: 'Cloudflare API token', re: /\bcf(?:k|ut|at)_[A-Za-z0-9]{30,}\b/ },
  // Tailscale auth key (audit 2026-10-15 todo 4e8257c4, specimen: the owner-pasted
  // tskey-auth-… key re-quoted VERBATIM into machine wake 9d0d12bd on 10-15): the
  // wake path ALREADY redacts on write (redactHookSummary at emit + delivery +
  // enqueueDirectWake), but no pattern knew the shape — the same provider-prefix
  // gap class as 82dd8756's Cloudflare token. Format:
  // tskey-auth-<keyUID>-<secret> (auth) and tskey-client-…/tskey-machine-… variants
  // (tailscale.com/kb/1085/auth-keys). Provider-prefixed like hf_/ghp_ above, so it
  // joins BOTH the redaction set and the commit-time scan set.
  { name: 'Tailscale auth key', re: /\btskey-(?:auth|client|machine)-[A-Za-z0-9]{20,}\b/ },
];

/**
 * Audit 2026-10-16, todo 8a9ac61b (the follow-up to 8d15611c — probe ≠ live
 * path): the LiteLLM gateway supervisor's store_secret {fromMessageId} was
 * REFUSED 'ambiguous' with only the 4 legacy batch-1 keys as candidates at
 * 22:19:56Z — 32 minutes AFTER the pattern wave (036a0cc6) completed — while
 * a run started after the LAST wave of the churn enumerated all 8 candidates
 * including the four new shapes. Verdict: a draining worker served the
 * pre-036a0cc6 pattern set mid-deploy-churn (the 37a875ee class), NOT a code
 * gap — the live enumeration path IS this list (extractSecretForHandoff →
 * findSecretSpans, no second registry). But the refusal carried nothing that
 * could have distinguished "scanner too old" from "shape unknown" at read
 * time, so the failure class cost a full fleet round to diagnose.
 *
 * The stamp below makes that class SELF-DIAGNOSING: a short stable digest of
 * the pattern registry (names + count). Every store_secret refusal result
 * and its loop-metric row now carries { patterns, stamp } — two refusals of
 * the same paste with different stamps = version skew (stale worker: retry
 * from a fresh run); the same stamp on a "missing shape" refusal = a REAL
 * pattern gap (file the shape). It rides the result and telemetry only —
 * never a prompt — and never contains key material (names + hash).
 *
 * djb2 over the names (hex, 8 chars): import-light by design — this is a
 * LEAF module (no node imports; see the header), so no node:crypto here.
 */
export function scannerStamp(): { patterns: number; stamp: string } {
  let h = 5381;
  for (const p of SECRET_PATTERNS) for (let i = 0; i < p.name.length; i++) h = (h * 33 + p.name.charCodeAt(i)) >>> 0;
  return { patterns: SECRET_PATTERNS.length, stamp: h.toString(16).padStart(8, '0') };
}

/**
 * Redaction-ONLY shapes (D4, 2026-09-27): a labelled credential ASSIGNMENT —
 * `api_key=…`, `X-API-Key: …`, `access_token: "…"`, `client_secret=…`,
 * `password: …` — with a value of ≥16 chars. Deliberately NOT in
 * SECRET_PATTERNS: the commit-time diff scan / G4 would strike ordinary code
 * (`token=process.env.TOKEN`, `secret: ${{ secrets.X }}`). The keyword must
 * be directly followed by the separator (`max_tokens=4096`, `token_count:`
 * never match), env-var / template / placeholder values and CONSTANT NAMES
 * (`SOME_FLAG_NAME_V2` — upper-case/digits/underscore only) are exempt, the
 * value stops at whitespace, quotes, commas, semicolons, brackets, `&` and
 * `\` (a JSON envelope and a URL query tail survive the rewrite), and the
 * replacement KEEPS the label — and the opening quote, when there is one — so
 * the reader still sees WHICH credential was dropped and a JSON string stays
 * a string. Group 1 = label + separator (+ opening quote); group 2 = the
 * value. The keyword is spelled case-insensitively by hand because the
 * constant-name exemption needs a case-SENSITIVE class. The regex is only the
 * candidate finder: `assignmentValueExempt` (cursor labels + the entropy
 * signal) decides whether a candidate is rewritten.
 *
 * NAMED-COMPOUND spans (ticket ca0b57cd, 2026-10-20): the keyword rule above
 * requires the keyword to be the label's LAST segment, so a compound
 * credential name whose last segment is not a keyword — the AWS idiom
 * `secret_access_key=…`, `access_key_id=…`, `private_key=…`, the PostgreSQL
 * `db_password`-adjacent family — was INVISIBLE to the span scan. The live
 * specimen: an owner answered a credential card with
 * `x_access_key=<20-char AKIA id>, x_secret_access_key=<40-char secret>` —
 * the AKIA prefix matched as an 'AWS access key' span (vaulted), the
 * 40-char secret under `secret_access_key=` matched NOTHING and sat verbatim
 * on the stored answer row. Every credential-carrying compound label whose
 * tail is `access_key | secret_key | access_key_id | secret_access_key |
 * private_key | shared_key | api_secret | secret_id | auth_token | auth_key
 * | admin_key | db_password | pass_key` is now ALSO a span (a named
 * assignment is owner INTENT, not a shape guess). Unchanged: the entropy
 * gate, placeholder/constant exemptions, the cursor-label exemption, and the
 * rewrite shape (label kept, value replaced). The span carries `label` (the
 * label text without the separator) so the owner-answer vault can store each
 * named value under its own envKey. Redaction-only — never SECRET_PATTERNS
 * (the commit gate / G4), same as the keyword rule.
 */
export const INBOUND_ONLY_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'Credential assignment',
    re: /\b([A-Za-z0-9_-]*(?:[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww](?:[Oo][Rr])?[Dd])["'`]?\s*[:=]\s*["'`]?)(?!process\.env\.|os\.environ[/.[]|os\.getenv|\$\{|\$[A-Z_]|<|\[REDACTED|\{\{|%|[A-Z0-9_]+(?:[\s"'`,;()[\]{}<>&\\]|$))((?:[^\s"'`,;()[\]{}<>&\\]|\\\/){16,})/g,
  },
];

/**
 * Ticket b71367e5 (ca0b57cd review advisory A8): the label a KEYWORD-leg
 * match names, when that label ENDS in a NAMED_COMPOUND_TAILS compound tail
 * (`db_password`, `auth_token`, `api_secret`, `secret_id`, `pass_key` —
 * tails whose bare keyword form (`token=`, `secret=`, `password=`) the
 * keyword leg matches but whose compound form the named-compound leg ALSO
 * covers). Pre-fix, the same credential was keyed BY SEPARATOR: the
 * `+`-separated form carried a label (named-compound leg) and stored as
 * e.g. $DB_PASSWORD, while the `=` / `:` / `export` forms (keyword leg)
 * stored under the opaque ordinal OWNER_ANSWER_<id>_2 — value never lost,
 * name unpredictable per separator. Now both legs carry the SAME label, so
 * the vault derives the same envKey whatever separator the owner used.
 * The label must NAME the compound (case-sensitive tail membership of the
 * normalized label's last `[_-]`-segment, mirroring how
 * NAMED_COMPOUND_RE builds its tail alternation) — a BARE keyword label
 * (`password=`, `api_key=`, `X-API-Key:`) is NOT a compound name and stays
 * unlabeled (the pre-fix span shape for those is unchanged). Pure.
 */
export function compoundCredentialLabel(labelWithSep: string): string | null {
  const label = String(labelWithSep ?? '').trim()
    .replace(/^export\s+/i, '')
    .replace(/["'`]/g, '')
    .replace(/[\s:=+]+$/, '');
  if (!label || /\s/.test(label)) return null; // `AWS credentials:` — prose before the keyword, not a name
  // `[_-]`-separated tails, like NAMED_COMPOUND_RE's tail alternation —
  // `db-password` names the same compound as `db_password`.
  const lower = label.toLowerCase().replace(/-/g, '_');
  for (const tail of NAMED_COMPOUND_TAILS) {
    if (lower === tail) return label;
    if (lower.endsWith(tail) && /_$/.test(lower.slice(0, lower.length - tail.length))) return label;
  }
  return null;
}

/**
 * NAMED-COMPOUND credential labels (ticket ca0b57cd): compound names whose
 * LAST segment is not one of the keywords above — the AWS idiom, the
 * database-connection family — but which name a credential just as
 * explicitly. A `NAME=value` line on an owner's credential card is owner
 * INTENT, not a shape guess: the label itself says "this is the secret".
 * Case-insensitive tail match, `[_-]`-separated; the label is captured with
 * its separator so redaction keeps the name visible. Redaction-only (same
 * posture as INBOUND_ONLY_PATTERNS).
 */
export const NAMED_COMPOUND_TAILS: ReadonlySet<string> = new Set([
  'access_key', 'secret_key', 'access_key_id', 'secret_access_key',
  'private_key', 'shared_key', 'api_secret', 'secret_id',
  'auth_token', 'auth_key', 'admin_key', 'db_password', 'pass_key',
]);

/**
 * Named-compound candidate finder (ticket ca0b57cd; re-anchored after the
 * 64705f7a8 adversarial review, finding B1). Shape:
 * `<label> [:=+] <value>` where the label ENDS in a NAMED_COMPOUND_TAILS
 * tail. The tail is required IN THE PATTERN — an alternation over the tails,
 * each letter spelled case-insensitively (`[Aa]…`) because the value-side
 * constant-name exemption needs a case-SENSITIVE `[A-Z0-9_]+` class and the
 * regex therefore cannot take the `i` flag. The first version matched ANY
 * `word[:=+]value` candidate and rejected non-tail labels in the replace
 * callback — which silently swallowed everything after the rejected
 * candidate: a credential preceded by any non-tail assignment (`AWS
 * credentials: AWS_SECRET_ACCESS_KEY=…`, a YAML mapping key `credentials:\n
 * AWS_SECRET_ACCESS_KEY: …`, a URL query `…?secret_access_key=…`) was
 * consumed by the earlier candidate's VALUE and never re-scanned
 * (`String.replace(/g)` does not retry inside a skipped match) — the secret
 * stored VERBATIM on the answer row with an EMPTY vault, the exact harm
 * ca0b57cd fixes. Anchoring the tail in the pattern fixes every such shape:
 * a non-tail `word:` no longer matches at all, so the scan continues to the
 * real credential label. `+` is a separator only when UNSPACED — the live
 * specimen's second pair arrived as `secret_access_key+<40-char>` and must
 * not slip through on punctuation, while a spaced `secret_key + suffix` is a
 * code expression, not an assignment (review A2). Group 1 = label
 * (+separator, quotes kept like the keyword rule), group 2 = value (≥16
 * chars, same stop set as the keyword rule). Value gates: assignmentValueExempt
 * (cursor labels + the entropy signal — placeholders, constant names and
 * getenv stay untouched) and NAMED_COMPOUND_VALUE_EXEMPT_RE (path / URL /
 * ARN / fingerprint references, review A1).
 */
const NAMED_COMPOUND_TAIL_SRC = [...NAMED_COMPOUND_TAILS]
  .map((t) => t.split('').map((c) => (/[A-Za-z]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c === '_' ? '[_-]' : c)).join(''))
  .sort((a, b) => b.length - a.length) // longest tail first (`secret_access_key` before `secret_key`)
  .join('|');
const NAMED_COMPOUND_RE = new RegExp(
  '\\b((?:[A-Za-z][A-Za-z0-9_-]{0,63}[_-])?(?:' + NAMED_COMPOUND_TAIL_SRC + ')'
  // Delta-review #4 (of 722064990): an optional backslash before each quote
  // — a literal-escaped JSON paste (`\"secret_access_key\": \"<40>\"`, the
  // 50bcd1e7 incident shape class) is a real owner answer form.
  // Ticket b71367e5 (escaped-JSON residual): ONE optional backslash still
  // missed the DOUBLE-escaped paste (`\\\"secret_access_key\\\":
  // \\\"<40>\\\"` — a JSON-of-JSON re-serialization, the next hop of the
  // same incident class) — `\\*` takes any run of them.
  + '(?:\\\\*["\'`]?\\s*[:=]\\s*\\\\*["\'`]?|\\+)'
  + ')(?!process\\.env\\.|os\\.environ[/.[]|os\\.getenv|\\$\\{|\\$[A-Z_]|<|\\[REDACTED|\\{\\{|%|[A-Z0-9_]+(?:[\\s"\'`,;()\\[\\]{}<>&\\\\]|$))'
  // Ticket b71367e5 (escaped-JSON residual): the value charset stops at `\`,
  // so an escaped-slash JSON value (`"abC…\/xyz"`) was redacted only up to
  // the backslash and the tail rode the row verbatim. `\/` (backslash +
  // slash, ONE unit) is now admitted into the value.
  + '((?:[^\\s"\'`,;()\\[\\]{}<>&\\\\]|\\\\/){16,})',
  'g',
);

/** Path / URL / ARN / fingerprint VALUES after a compound-tail label — a
 *  REFERENCE to where a key lives, never a pasted credential (review of
 *  64705f7a8, A1: `private_key=/etc/letsencrypt/live/…/privkey.pem`,
 *  `secret_id=arn:aws:secretsmanager:…`, `private_key=SHA256:AbCd…`).
 *  Delta-review finding #1 (of 722064990): the first cut took a BARE
 *  leading `/` — but `/` is in the base64 alphabet, so
 *  `AWS_SECRET_ACCESS_KEY=/9j4Kq…` (a real secret) was exempted and stored
 *  verbatim. Pass-3 finding #1 (of 1f44ef317): the shape rewrite then
 *  required the extension form for EVERY path, so relative/home references
 *  without an extension (`private_key=~/.ssh/MyKey2024`,
 *  `./certs/MyCert2024.pem`) redacted AND vaulted a filesystem path under
 *  the declared gate key — LIFTING A CREDENTIAL GATE on a path (the
 *  gate-honesty invariant, ad4fae90's B1/F2 class). Two-tier fix (both
 *  pass-3 reviews' prescription): a `~[user]/`, `./` or `../` prefix is an
 *  UNAMBIGUOUS path signal — no key format starts with those — so prefixed
 *  paths are exempt regardless of extension (pass-4 finding #1 widened
 *  `~/` to the tilde-USER form `~ec2-user/.ssh/…`, same vault+gate-lift
 *  harm); only a BARE leading `/`
 *  (which base64 CAN produce) must prove a path SHAPE: multi-segment with a
 *  short dotted extension in the final segment (`/etc/…/privkey.pem`,
 *  `/usr/local/bin/python3.12`). A single-run token (`/9j4…`) or a
 *  slash-bearing secret without an extension tail
 *  (`/wJalr…/K7MDENG/bPxRfiCYEXAMPLEKEY`) redacts. `md5:` joins `sha…:`
 *  (pass-3 finding #2 — a checksum fingerprint is a reference too). */
const NAMED_COMPOUND_VALUE_EXEMPT_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|arn:|sha[0-9]+:|md5:|~[^\s/]*\/[^\s]+|\.{1,2}\/[^\s]+|\/[^\s]+\/[^\s/]*\.[A-Za-z0-9]{1,8})/i;
/** Ticket b71367e5 (escaped-JSON residual): the exemption above must judge
 *  the value the OWNER PASTED, not its escaped serialization — an escaped
 *  path reference (`"private_key": "\/etc\/ssl\/private\/key2024.pem"`)
 *  is a path reference in every form. `\/` unescapes to `/` for the test
 *  only; the span keeps the raw pasted form. Pure. */
function namedCompoundValueExempt(rawValue: string): boolean {
  return NAMED_COMPOUND_VALUE_EXEMPT_RE.test(String(rawValue ?? '').replace(/\\\//g, '/'));
}

/** Span pushed by the named-compound leg (ca0b57cd): carries the LABEL so the
 *  owner-answer vault can derive a per-value envKey. */
function pushNamedCompoundSpan(spans: SecretSpan[] | null, name: string, value: string, labelWithSep: string): void {
  if (!spans) return;
  // b71367e5 (escaped-JSON): escape backslashes strip with the quotes — an
  // escaped paste (`\\\"secret_access_key\\\":`) yields the CLEAN label.
  const label = String(labelWithSep ?? '').replace(/\\+/g, '').replace(/["'`]/g, '').replace(/[\s:=+]+$/, '').trim();
  pushCaptureSpan(spans, name, value, label || undefined);
}

/** AWS access key ID shape — the same structural fact credentials.service's
 *  AWS_KEY_ID_RE refuses by: 20 chars, AKIA/ASIA/ABIA/ACCA + 16 upper alnum.
 *  Duplicated here on purpose (this module is a LEAF — see the header: an
 *  import of credentials.service would drag config/database into every jest
 *  graph that pulls the scanner). Both copies encode ONE provider fact, and
 *  a drift between them fails the 3b573ce3 tests on either side. */
const AWS_KEY_ID_SPAN_RE = /^(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}$/;

/**
 * Ticket 3b573ce3 (2026-10-30) — a FUSED AWS pair under ONE label.
 *
 * THE INCIDENT: an owner answered a credential card with both halves of a
 * ctrl.example.com S3 pair; the vault stored ONE 60-char value under
 * $CANLAW_CPT_S3_SECRET_ACCESS_KEY whose first 20 chars are the access-key ID
 * and whose last 40 are the real secret. Every consumer reading the env var
 * got an unusable secret, and the ID ALSO landed under an ordinal
 * OWNER_ANSWER_<id> key, so the same 20 chars rode two names.
 *
 * THE MECHANISM (measured on this scanner, not inferred): the capture legs
 * take a `LABEL=<value>` run's value with a bare non-whitespace charset, so
 * `…_SECRET_ACCESS_KEY=AKIA<16>DMha<36>` is captured as ONE 60-char span.
 * The 'AWS access key' provider pattern does not carve it out either: its
 * trailing `\b` fails against the alnum that abuts the key ID, so
 * `/AKIA[0-9A-Z]{16}\b/` never matches the head at all. The store-time AWS
 * pair guard did not catch it a second way — it is anchored
 * (`/^(?:AKIA|…)…{16}$/`), and a 60-char blob is not a key ID.
 *
 * THE RULE: a value that LEADS with a complete key ID and does not END as one
 * is two credentials fused, never one value — the key ID is self-identifying
 * (it needs no label to be recognized), so it splits off unlabeled and the
 * remainder keeps whatever label named it. This is a RESHAPE, not a refusal:
 * the ticket's own expected behaviour is "one credential-shaped value per env
 * key", and the vault's existing family-aware fit routing then puts the
 * labeled remainder on the secret slot it names and the key ID on its own key
 * (or refuses it there — valueSlotMismatch's long-standing key-ID-in-secret
 * refusal, which is the correct message for that half).
 *
 * Only a value LONGER than a key ID splits; a bare 20-char key ID is left
 * exactly as it was (the pre-fix span shape every ca0b57cd/c54074df pin
 * depends on). Pure. */
export function splitFusedAwsPair(value: string): { keyId: string; rest: string } | null {
  const v = String(value ?? '');
  if (v.length <= 20) return null;
  const keyId = v.slice(0, 20);
  if (!AWS_KEY_ID_SPAN_RE.test(keyId)) return null;
  return { keyId, rest: v.slice(20) };
}

/**
 * The ONE span-push choke point (ticket 3b573ce3): every capture leg that can
 * carry a labelled multi-value run goes through here so a fused AWS pair is
 * emitted as TWO spans (key ID unlabeled, remainder under the caller's label)
 * and can never reach the vault as one env var. The text rewrite is NOT
 * affected — redactImpl still replaces the whole matched run with one note,
 * so the stored answer text is redacted exactly as before; only the span
 * inventory (what the vault stores, and under which key) changes.
 */
function pushCaptureSpan(spans: SecretSpan[] | null, name: string, value: string, label?: string): void {
  if (!spans) return;
  const fused = splitFusedAwsPair(value);
  if (!fused) {
    spans.push({ name, value, ...(label ? { label } : {}) });
    return;
  }
  // The key ID leads: it is self-identifying, so it carries NO label (a label
  // on the run named the half the owner wrote last). The remainder is the
  // credential the caller's label actually names.
  spans.push({ name: 'AWS access key', value: fused.keyId });
  spans.push({ name, value: fused.rest, ...(label ? { label } : {}) });
}

/**
 * Ticket a65bc528 (2026-10-30) — the FUSED AWS pair under a label that names
 * NO credential.
 *
 * THE MEASURED DEFECT (probed on this scanner before the fix): the run
 * `ANY_LABEL=AKIA<16 upper alnum><40-char secret>` — and the live incident's
 * `CANLAW_CPT_S3_KEY=…` — produced **zero spans and zero redaction**, so the
 * owner-answer row (and every digest reading that row) persisted the 40-char
 * secret VERBATIM. Two independent reasons, both confirmed:
 *   1. the `AWS access key` provider pattern is `/AKIA[0-9A-Z]{16}\b/` — the
 *      trailing `\b` FAILS against the alnum that abuts the key ID, so the
 *      head of a fused run never matches;
 *   2. the capture legs are LABEL-driven: the named-compound leg needs the
 *      label to END in a NAMED_COMPOUND_TAILS tail (`…_S3_KEY` does not —
 *      `key` alone is not a tail) and the keyword leg needs a
 *      token/secret/password/api-key label. Neither fires on a neutral name.
 * The 3b573ce3 split (splitFusedAwsPair/pushCaptureSpan) only ever runs on a
 * value some leg already captured, so it cannot rescue a run nothing matched.
 *
 * THE RULE: an AKIA/ASIA/ABIA/ACCA-led run that CONTINUES with 20+ credential
 * chars is two fused credentials regardless of the label beside it — the key
 * ID is self-identifying, which is exactly why the label is not needed. This
 * leg therefore ignores labels entirely and fires on the VALUE shape alone.
 *
 * POSTURE — redaction-only, and deliberately NOT in SECRET_PATTERNS:
 *  - the commit-time diff scan / G4 keep their current behaviour. Widening the
 *    provider pattern there would newly strike committed fixtures across every
 *    lane, a blast radius this ticket does not ask for (the ticket itself
 *    offers "OR add a redaction-only catch-all" as the narrow shape);
 *  - the leg runs LAST, after every label-driven and context-gated leg, so a
 *    run those legs already captured and rewrote is never re-captured — the
 *    span inventory and redaction text of every pre-existing shape are
 *    byte-identical (the 3b573ce3 / ca0b57cd / b71367e5 / 365588cf pins);
 *  - on a match the whole run is replaced by ONE note and the spans are
 *    produced through pushCaptureSpan, i.e. the fused pair splits into the
 *    key ID + the secret half exactly as 3b573ce3 established — the vault
 *    stores two usable values instead of one 60-char concatenation, and the
 *    stored text never carries the secret.
 * Kill switch FUSED_AWS_PAIR_REDACT_DISABLED=1 restores the pre-fix scan
 * byte-for-byte (the measured 0-span / verbatim-secret behaviour).
 */
const FUSED_AWS_PAIR_RE = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}[A-Za-z0-9+/]{20,}/g;

/**
 * Ticket a65bc528 (finding F1) — TRUE when the text at `at` continues a FUSED
 * credential run, i.e. `[A-Za-z0-9+/]{20,}` starts exactly there. Used to stop
 * the `AWS access key` provider pattern from HALF-consuming a fused pair: its
 * trailing `\b` holds before `+` or `/` (both non-word), so without this guard
 * it redacted the 20-char key ID and left the 40-char secret standing. Handing
 * the head back keeps the run whole for the atomic legs (label-driven first,
 * then the label-free a65bc528 leg), which is what makes the split correct.
 * Pure.
 */
function fusedContinuationAt(text: string, at: number): boolean {
  return /^[A-Za-z0-9+/]{20,}/.test(String(text ?? '').slice(at));
}

/** The span/hit name for the FUSED-AWS-PAIR leg's remainder half (the key-ID
 *  half keeps 'AWS access key' — pushCaptureSpan's own naming). */
export const FUSED_AWS_PAIR_SPAN_NAME = 'AWS secret access key';

const fusedAwsPairRedactDisabled = (): boolean => process.env.FUSED_AWS_PAIR_REDACT_DISABLED === '1';

/** How far (chars, either side) a credential cue may sit from a context-gated match. */
export const APP_PASSWORD_CUE_WINDOW = 160;

/**
 * Context-GATED redaction shapes (backlog audit T6, 2026-09-28). A Google /
 * Gmail "app password" is 16 lowercase letters that the Google UI shows as
 * four spaced groups (`abcd efgh ijkl mnop`); pasted into an owner-question
 * answer it carries no prefix and no entropy signal, so nothing above matched
 * and the value sat in owner_questions.answer + the lane transcript. The BARE
 * 4x4 shape is ordinary prose ("here is what this does" — measured 10 hits
 * across 298 stored answers, 9 of them prose); gated on a nearby cue it hit
 * exactly the one real row. `re` finds candidates; a candidate is rewritten
 * only when `cue` matches within `window` chars before OR after it. The
 * contiguous 16-letter form takes the strict `app password` cue only (a
 * 16-letter English word near "secret" is not a credential). Redaction-only —
 * never SECRET_PATTERNS (the commit gate / G4).
 */
export const CONTEXT_GATED_PATTERNS: Array<{
  name: string;
  re: RegExp;
  cue: RegExp;
  window: number;
  /** Optional VALUE-SHAPE gate (ticket 365588cf): the matched candidate `m`
   *  must ALSO satisfy this regex to be redacted/span-pushed. Used by shapes
   *  whose `re` is a bare length/alphabet run that is not by itself evidence
   *  of a credential (a 40-char base64 run is also a sha1 hex, a git hash or
   *  an ordinary long word) — the same role `assignmentValueExempt`'s entropy
   *  signal plays for the assignment shapes. Absent = cue alone decides. */
  value?: RegExp;
}> = [
  { name: 'App password', re: /\b[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}\b/g, cue: /app[ -]?password|gmail|smtp|secret/i, window: APP_PASSWORD_CUE_WINDOW },
  { name: 'App password', re: /\b[a-z]{16}\b/g, cue: /app[ -]?password/i, window: APP_PASSWORD_CUE_WINDOW },
  // Ticket 365588cf (2026-10-30): the BARE AWS SECRET ACCESS KEY.
  //
  // THE MEASURED INCIDENT: an owner pasted a whole AWS access-key PAIR into an
  // owner-card's free-text reply box (the card was expectedAnswerType 'choice',
  // so there was no key field). The capture path
  // (owner-questions.ts vaultOwnerAnswerSecrets → findSecretSpans) could see
  // only the 20-char key ID — SECRET_PATTERNS has `\bAKIA[0-9A-Z]{16}\b` and
  // NOTHING for the 40-char secret half, which carries no prefix and no
  // structural signal at all. Probe:
  //   findSecretSpans('Access key\nAKIA…\nSecret access key\n<40-char>\nHide')
  //     → [ { name: 'AWS access key', len: 20 } ]
  // so the pair vaulted its key ID and the secret was DESTROYED (redacted away
  // in the answer row, never vaulted).
  //
  // A 40-char run over the AWS secret alphabet is NOT self-evidently a
  // credential (a sha1, a git blob hash, a 40-letter word), so this shape is
  // context-gated twice: `cue` must name the AWS/S3 access-key idiom nearby
  // (the owner's own "Secret access key" label satisfies it) AND `value` must
  // carry the AWS secret's entropy signature — mixed case AND a digit — while
  // rejecting a pure hex sha1 in either case. That keeps the pre-existing
  // class (a sha1 next to the word "s3") out of the span list, which the
  // vault would otherwise store as a credential and the gate would lift on.
  // Redaction-only — never SECRET_PATTERNS (the commit gate / G4), same
  // posture as the two app-password rows above.
  {
    name: 'AWS secret access key',
    re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g,
    // ANCHORED on purpose (review finding 1 of this ticket): a bare
    // /aws|s3/ cue matches INSIDE ordinary words — "dr-AWS", "l-AWS",
    // "fl-AWS", "cs-S3" — so any 40-char token in a sentence about a
    // diagram, a tax law or a CSS gradient was redacted AND vaulted as a
    // credential. The lookarounds require aws / s3 as its OWN token
    // (`s3://…` and `S3_SECRET_ACCESS_KEY` still match: `:` and `_` are not
    // alphanumerics) while the word-substring class cannot fire.
    cue: /(?<![A-Za-z0-9])(?:aws|s3)(?![A-Za-z0-9])|secret[ _-]?access[ _-]?key/i,
    window: APP_PASSWORD_CUE_WINDOW,
    // Not a sha1 (hex, either case) and not a low-entropy word: mixed case +
    // a digit. Real 40-char AWS secrets are base64 of 30 bytes — overwhelmingly
    // mixed case, and ~99.9 % carry at least one digit.
    value: /^(?![0-9a-fA-F]{40}$)(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9+/]{40}$/,
  },
];

/**
 * Hotfix 2026-10-06: a 4x4 lower-case run made of ordinary English words is PROSE,
 * never a Google app password (16 random letters). The first live scrub dry run
 * redacted "text html body data" near "Gmail API" and similar fleet prose. A
 * candidate is prose when ≥ 2 of its four groups are common words (a random group
 * is a common word with p ≈ 0.07 %). Kill switch SECRET_SCAN_APP_PASSWORD_PROSE_GUARD_DISABLED=1.
 */
const COMMON_FOUR = new Set(('that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what also back call came does done down each even ever find form gave give goes gone half hand high hold home hope into keep kind last left less life line list live look made main mean most move must name need next note once open part past plan read real rest room same seen send sent show side size sort step stop sure tell test text then type used user uses view wait walk week went word work year data file code html body mail load logs runs lane deep fail pass full true null json path host port name node page site link post push pull diff edit save fill sync loop time date zone hour days nine five four item rows cell what said word each make like into look more than been call find long down came made part over know take only year work back give most very after just name good some them well were your even many must here such does done head tail else none both cost free read able area away base best bill blue book both bulk case city club cold copy core cure dark deal dear deck deny desk disk door draw drop drug dual duty earn east easy edge epic exam exit face fact fair fall farm fast fear feel feet fell felt fine fire firm flag flat flow food foot four fuel fund game gate gear gift girl glad goal gold golf grew grid grow hair hall hard harm hate heat held help hero hide hill hint hire hits hold holy huge idea iron jobs join joke jump jury kept keys kick kill king land lead lean lift lock lord lose loss lost loud love luck mark meet menu mile mind mine miss mode mood moon nice once only pack paid pair pick pile pink plus poll pool poor pure race rain rank rate rely rich ride ring rise risk road rock role roll roof rule safe sale salt sand seat seed seek self sell ship shop shot sign sing slow snow soft soil sold sole song soon star stay suit tall task team tech term tiny tone took tool tour town tree trip unit upon vast vote wage wake ward warm wash wave ways weak wear west wide wife wild wind wine wire wise wish wood yard yeah zero').split(' '));
export function appPasswordLooksLikeProse(value: string): boolean {
  if (process.env.SECRET_SCAN_APP_PASSWORD_PROSE_GUARD_DISABLED === '1') return false;
  const groups = String(value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (groups.length !== 4) return false;
  return groups.filter((g) => COMMON_FOUR.has(g)).length >= 2;
}

// ── audit 2026-10-06 T2-1: password / passphrase labels + plain English ────────

/** Password-family keywords whose label alone is strong evidence of a credential. */
const STRONG_PASSWORD_KW = new Set(['password', 'passwd', 'passcode', 'pwd', 'pw', 'passphrase']);

/**
 * Label (group 1 = the whole label + connector, group 2 = the keyword):
 * a password-family keyword, optionally inside a `db_` / `wifi-` compound,
 * never the tail of a longer word (`bypass`, `compass`, `Spin`), followed by
 *  - an ASSIGNMENT `:` / `=` / `:=` / `==` (quotes around the label allowed,
 *    one line break allowed after the separator), or
 *  - a PROSE copula `is` / `was` (optionally `is:`), or
 *  - a TARGET clause `for|to|of|on <≤60 chars>` then `:` / `=` / `is`, or
 *  - a bare `to` ("set the password to X").
 * The compound prefix is bounded (≤4 segments) so a long snake_case run never
 * backtracks quadratically. The connector form is re-derived in code
 * (connectorKind).
 */
const PW_LABEL_SRC = String.raw`(?<![A-Za-z0-9/.])((?:[A-Za-z0-9]{1,24}[_-]){0,4}(KWS)(?![A-Za-z0-9])(?:["'\x60]?[ \t]*(?:={2,3}|:=|[:=])[ \t]*(?:\r?\n[ \t]*)?|[ \t]+(?:is|was)[ \t]*:?[ \t]*|[ \t]+(?:for|to|of|on)[ \t]+[^\n:=[\]]{1,60}?(?:[ \t]*[:=][ \t]*|[ \t]+(?:is|was)[ \t]*:?[ \t]*)|[ \t]+to[ \t]+)["'\x60]?)`;
// Hotfix 2026-10-06 (first live scrub dry run): the bare `pass` keyword matched the fleet's own
// verdict lines (`WCACHE-VERDICT PASS: …`, `FULL_PASS=1`, "this audit pass: `digest=…`") — 122+
// stored rows in one sample; it is dropped. A label preceded by `/` or `.` is a PATH (`/etc/passwd:`).
const PW_KWS = 'pass[ _-]?phrase|password|passwd|passcode|pwd|pw|pin|secret';
const PHRASE_KWS = String.raw`pass[ _-]?phrase|(?:recovery|seed|security|backup)[ _-]phrase|mnemonic`;

/**
 * The 'Password' / 'Passphrase' / 'App password' candidate finders. Each
 * candidate is decided in code (see redactPasswordShapes) — the regexes only
 * locate a label and the text after it. Order matters: the multi-word
 * passphrase runs first (a single-token pass would cut it to its first word),
 * then the labelled 4x4 app password, then the single token.
 */
export const PASSWORD_LABEL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Passphrase', re: new RegExp(`${PW_LABEL_SRC.replace('KWS', PHRASE_KWS)}([^\\s"'\\x60\\\\<>|]+(?:[ \\t]+[^\\s"'\\x60\\\\<>|]+){0,29})`, 'gi') },
  // Case-insensitive label; the 4x4 value's lower-case shape is re-checked in code.
  { name: 'App password', re: new RegExp(`${PW_LABEL_SRC.replace('KWS', 'password|passwd|pwd|pw')}([a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4})(?![A-Za-z0-9])`, 'gi') },
  { name: 'Password', re: new RegExp(`${PW_LABEL_SRC.replace('KWS', PW_KWS)}([^\\s"'\\x60\\\\<>]+)`, 'gi') },
];

/** Plain words that follow `password:` as a STATUS / TYPE, never as the value. */
const NON_VALUE_WORDS = new Set([
  'required', 'optional', 'none', 'null', 'undefined', 'true', 'false', 'string', 'number', 'boolean', 'unknown',
  'changed', 'unchanged', 'redacted', 'hidden', 'masked', 'unset', 'empty', 'blank', 'missing', 'provided', 'stored',
  'saved', 'rotated', 'expired', 'removed', 'deleted', 'invalid', 'incorrect', 'correct', 'wrong', 'needed', 'pending',
  'attached', 'enabled', 'disabled', 'default', 'secret', 'password', 'passphrase', 'passcode', 'please', 'ignored',
  'encrypted', 'hashed', 'plaintext', 'cleartext', 'private', 'public', 'protected', 'sensitive', 'omitted', 'elided',
  'included', 'excluded', 'supplied', 'entered', 'generated', 'random', 'updated', 'shared', 'verified', 'object',
  'varchar', 'integer', 'buffer', 'option', 'options', 'params', 'value', 'values', 'input', 'field', 'placeholder',
  'example', 'sample', 'dummy', 'nothing', 'anything', 'something', 'whatever', 'inline', 'below', 'above',
  'permission', 'denied', 'failed', 'reset', 'login', 'prompt', 'manager', 'policy', 'protected',
]);

/** Function words (a multi-word passphrase has at most one or two; prose has many). */
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'is', 'are', 'was', 'be', 'it', 'that',
  'this', 'we', 'i', 'you', 'not', 'no', 'my', 'our', 'your', 'its', 'as', 'by', 'from', 'but', 'so', 'if', 'then',
  'will', 'can', 'should', 'has', 'have', 'there', 'here',
]);

/** First words that make the text after a passphrase label prose, never the phrase. */
const PROSE_LEAD_WORDS = new Set([
  ...FUNCTION_WORDS, 'none', 'unset', 'tbd', 'todo', 'same', 'see', 'ask', 'check', 'required', 'optional', 'missing',
  'unknown', 'stored', 'saved', 'kept', 'set', 'empty', 'blank', 'must', 'needs', 'need', 'already', 'still', 'now',
  'also', 'being', 'been', 'please', 'use', 'using', 'rotated', 'changed', 'expired', 'below', 'above', 'attached',
  'sent', 'shared', 'given', 'provided', 'different', 'too', 'very', 'written', 'printed', 'n/a', 'what', 'which',
]);

/** Values that are a reference / template / placeholder / mask / bind param — never a credential. */
const PW_EXEMPT_PREFIX_RE = /^(?:process\.env\.|os\.environ[/.[]|os\.getenv|\$\{|\$[A-Za-z_]|<|\[|\(|\{|%|\*|•|:|#)/;

type PwConnector = 'assign' | 'prose';

function connectorKind(label: string): PwConnector {
  return /[:=][ \t]*(?:\r?\n[ \t]*)?["'\x60]?$/.test(label) ? 'assign' : 'prose';
}

/**
 * The prefix of a single label VALUE token to redact, or null to leave it.
 * `kw` = the matched keyword (lower-cased), `urlCtx` = the label sits in a URL
 * query (`?password=…&next=…` — the value stops at `&`).
 */
export function passwordTokenToRedact(kwRaw: string, connector: PwConnector, raw: string, urlCtx = false): string | null {
  const kw = String(kwRaw || '').toLowerCase().replace(/[ _-]/g, '');
  let v = String(raw ?? '');
  if (urlCtx) v = v.split('&')[0];
  v = v.replace(/[,;.:)\]}'"]+$/, '');
  if (v.length < 6) return null;
  if (PW_EXEMPT_PREFIX_RE.test(v)) return null;
  if (!/[A-Za-z0-9]/.test(v)) return null;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) || /^[A-Z]+$/.test(v)) return null; // CONSTANT_NAME / ALLCAPS word
  if (/:\/\//.test(v) || /^(?:~|\.{1,2})?\//.test(v)) return null; // URL / path
  if (/^\d+$/.test(v)) return kw === 'pin' || STRONG_PASSWORD_KW.has(kw) ? v : null;
  if (kw === 'pin') return null; // a PIN is digits; `pin: GPIO17` is wiring
  if (!/[A-Za-z]/.test(v)) return null; // dates, versions, IPs, fractions
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*[([{]/.test(v)) return null; // code call / index
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return null; // member path
  if (/^v\d+(?:[.-]\d+)+/i.test(v)) return null; // version
  const hasDigit = /\d/.test(v);
  const hasUpper = /[A-Z]/.test(v);
  const hasLower = /[a-z]/.test(v);
  const hasSymbol = /[^A-Za-z0-9_.-]/.test(v);
  if (!hasDigit && /^[A-Za-z_.-]+$/.test(v)) {
    // A plain word / identifier: a value only after an explicit password label.
    if (STRONG_PASSWORD_KW.has(kw) && connector === 'assign'
      && (/^[a-z]{6,}$/.test(v) || /^[A-Z][a-z]{5,}$/.test(v)) && !NON_VALUE_WORDS.has(v.toLowerCase())) return v;
    return null;
  }
  if (kw === 'pass') return (hasUpper && hasLower && hasDigit) || (hasDigit && hasSymbol) ? v : null;
  if (kw === 'secret' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(v)) return null; // snake_case identifier
  if (hasDigit) return v;
  return hasSymbol && v.length >= 8 ? v : null;
}

/**
 * The prefix of a multi-word passphrase candidate to redact, or null. Words
 * stop at a token ending in sentence punctuation and before a `label:` token.
 */
export function passphraseToRedact(connector: PwConnector, raw: string): string | null {
  const parts = String(raw ?? '').split(/([ \t]+)/); // keep separators so the prefix is exact
  const words: string[] = [];
  let prefix = '';
  for (let i = 0; i < parts.length; i += 2) {
    const w = parts[i];
    if (!w) break;
    if (words.length && /:$/.test(w)) break; // the next `label:` starts
    const end = /[.!?;,]$/.test(w);
    const clean = end ? w.replace(/[.!?;,]+$/, '') : w;
    if (clean) { words.push(clean); prefix += (words.length > 1 ? parts[i - 1] : '') + clean; }
    if (end) break;
  }
  if (!words.length) return null;
  if (PW_EXEMPT_PREFIX_RE.test(words[0])) return null;
  const single = (): string | null => passwordTokenToRedact('passphrase', connector, words[0]);
  if (words.length === 1) {
    // One hyphen/dot-joined run of ≥3 lower-case words is the passphrase format itself.
    if (connector === 'assign' && /^[a-z]+(?:[-.][a-z]+){2,}$/.test(words[0])) return words[0];
    return single();
  }
  const wordLike = words.every((w) => /^[A-Za-z]+$/.test(w) || /^\d+$/.test(w));
  if (!wordLike) return single();
  if (PROSE_LEAD_WORDS.has(words[0].toLowerCase())) return null;
  const fn = words.filter((w) => FUNCTION_WORDS.has(w.toLowerCase())).length;
  if (connector === 'assign') return fn <= 2 ? prefix : null;
  return words.length >= 4 && fn <= 1 ? prefix : null;
}

const passwordLabelsDisabled = (): boolean => process.env.SECRET_SCAN_PASSWORD_LABELS_DISABLED === '1';

/** Run the three PASSWORD_LABEL_PATTERNS over `out`; returns the rewrite + hit names. */
function redactPasswordShapes(input: string, spans: SecretSpan[] | null, noteFor: SecretNoteFor): { text: string; hits: string[] } {
  let out = input;
  const hits: string[] = [];
  for (const p of PASSWORD_LABEL_PATTERNS) {
    p.re.lastIndex = 0;
    let replaced = 0;
    out = out.replace(p.re, (m: string, label: string, kw: string, value: string, offset: number, whole: string) => {
      const connector = connectorKind(label);
      let redact: string | null;
      // Hotfix 2026-10-06: "a captured passphrase to <30 words>" swallowed prose — a passphrase is
      // redacted only after an assignment (`:` / `=`) or a copula (`is` / `was`), never a bare `to`.
      if (p.name === 'Passphrase') redact = (connector === 'prose' && !/[ \t](?:is|was)[ \t]*:?[ \t]*["'\x60]?$/i.test(label)) ? null : passphraseToRedact(connector, value);
      else if (p.name === 'App password') redact = connector === 'assign' && /^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$/.test(value) && !appPasswordLooksLikeProse(value) ? value : null;
      else redact = passwordTokenToRedact(kw, connector, value, /[?&]$/.test(whole.slice(Math.max(0, offset - 1), offset)));
      if (!redact) return m;
      replaced += 1;
      spans?.push({ name: p.name, value: redact });
      return `${label}${noteFor()}${value.slice(redact.length)}`;
    });
    if (replaced && !hits.includes(p.name)) hits.push(p.name);
  }
  return { text: out, hits };
}

/**
 * Labels whose "token" is a CURSOR or an anti-forgery nonce, never a
 * credential: `next_token` / `nextToken`, `page_token`, `pagination_token`,
 * `continuation_token`, `csrf_token` / `xsrf-token`, `anti_forgery_token`,
 * `cancellation token` (a run id in prose). Tested against the ≤24 chars of
 * text BEFORE the match plus the captured label, so a keyword separated from
 * "token" by a space ("the cancellation token: …") is caught too.
 */
const CURSOR_LABEL_RE = /(?:^|[^a-z])(?:next|page|pagination|continuation|cancel(?:lation)?|csrf|xsrf|anti[_-]?forgery)[ _-]?token["'`]?\s*[:=]\s*["'`]?$/i;

/**
 * Entropy signal for an assignment VALUE (review finding: the bare shape ate
 * `.env.example` placeholders, run ids in prose and `localStorage.getItem`):
 *  - mixed case AND a digit (`AbCd…12`, `AQICAHhwm0…`), or
 *  - ≥24 chars, ≥80 % alphanumeric, and NOT ≥2 lowercase prose words joined by
 *    `-` / `_` / `.` (`your-super-secret-jwt-key-change-this`,
 *    `dgt_paste_your_agent_token_here`, `source-of-truth-run-4b2c1d9e`).
 */
export function looksLikeCredentialValue(value: string): boolean {
  const v = String(value ?? '');
  if (/[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v)) return true;
  if (v.length < 24) return false;
  const alnum = (v.match(/[A-Za-z0-9]/g) ?? []).length;
  if (alnum / v.length < 0.8) return false;
  const proseWords = v.split(/[-_.]/).filter((s) => /^[a-z]{2,}$/.test(s)).length;
  return proseWords < 2;
}

/** True when the candidate match must be LEFT ALONE (cursor label or a value
 *  without an entropy signal). `before` = the text preceding the match. */
function assignmentValueExempt(before: string, label: string, value: string): boolean {
  if (CURSOR_LABEL_RE.test(`${before.slice(-24)}${label}`)) return true;
  return !looksLikeCredentialValue(value);
}

/** The stored replacement — visible to the owner AND to the model, so both
 *  know a credential was seen and dropped (never silently mangled). */
export const REDACTED_NOTE = '[REDACTED: looked like a credential]';

/**
 * Redaction regexes derived from SECRET_PATTERNS. The private-key entry is
 * widened to swallow the WHOLE block (header alone would leave the key body
 * standing); everything else redacts exactly the token match, globally.
 */
const REDACTION_RES: Array<{ name: string; re: RegExp }> = SECRET_PATTERNS.map((p) =>
  p.name === 'Private key block'
    ? { name: p.name, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g }
    : { name: p.name, re: new RegExp(p.re.source, 'g') },
);

/** Pattern names that hit in `text` (order of SECRET_PATTERNS; each name once). */
export function scanTextForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(String(text ?? ''))) hits.push(p.name);
  }
  return hits;
}

/** True when a context cue sits within `window` chars before or after the match at `offset`. */
function cueNearby(whole: string, offset: number, length: number, cue: RegExp, window: number): boolean {
  const before = whole.slice(Math.max(0, offset - window), offset);
  const after = whole.slice(offset + length, offset + length + window);
  return cue.test(before) || cue.test(after);
}

/**
 * Replace every secret-shaped match with REDACTED_NOTE. Pure apart from the
 * password-label kill-switch read. The structured patterns run first so a
 * `token=sk-…` line is reported under its provider name; the assignment shape
 * then catches what no provider pattern knows (the label is kept).
 */
export function redactSecrets(text: string): { text: string; hits: string[] } {
  const r = redactImpl(text, null);
  return { text: r.text, hits: r.hits };
}

/** A matched credential-shaped substring: the pattern name + the raw value.
 *  Callers MASK it before printing (see scrub-stored-secrets.js --show-masked). */
export type SecretSpan = { name: string; value: string; /** Named-assignment label (ca0b57cd named-compound leg): the label text without separator/quotes, when the span came from a `NAME=value` line. */ label?: string };
/**
 * Ticket 26786762: the replacement the redaction writes in place of a matched
 * span. The default is the destruction marker; the owner-secret-delivery path
 * supplies a numbered reveal handle instead, so the value is recoverable by
 * the owner rather than destroyed. Pure function contract: same call = same
 * replacement for ONE replace pass (it is invoked once per matched span, in
 * match order).
 */
export type SecretNoteFor = () => string;

/**
 * The substrings redactSecrets would replace, in order, WITHOUT rewriting the
 * text. For the scrub script's reviewable dry run only — never log these raw.
 */
export function findSecretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  redactImpl(text, spans);
  return spans;
}

function redactImpl(text: string, spans: SecretSpan[] | null, noteFor: SecretNoteFor = () => REDACTED_NOTE): { text: string; hits: string[] } {
  let out = String(text ?? '');
  const hits: string[] = [];
  for (const p of REDACTION_RES) {
    p.re.lastIndex = 0; // shared module-level regex — never trust prior state
    if (p.re.test(out)) {
      hits.push(p.name);
      p.re.lastIndex = 0;
      // Ticket a65bc528 finding F1 (review of PR #2191): the provider pattern
      // must NOT half-consume the head of a FUSED pair. `/AKIA[0-9A-Z]{16}\b/`
      // matches when the abutting char is `+` or `/` (both non-word, so `\b`
      // HOLDS), which redacted the 20-char key ID and left the 40-char secret
      // standing as `[REDACTED…]+<40>` — on the live persistence entry point,
      // verbatim. Leaving the head INTACT lets the atomic legs below consume
      // the whole run: the label-driven ones first (so the 3b573ce3 label pin
      // still rides the secret half), then the label-free a65bc528 leg.
      // Narrow by construction: only the AWS entry, and only when the run
      // really does continue as a fused credential.
      if (p.name === 'AWS access key') {
        out = out.replace(p.re, (m: string, offset: number, whole: string) =>
          fusedContinuationAt(whole, offset + m.length) ? m : (pushCaptureSpan(spans, p.name, m), noteFor()));
      } else {
        out = out.replace(p.re, (m: string) => { pushCaptureSpan(spans, p.name, m); return noteFor(); });
      }
    }
  }
  for (const p of INBOUND_ONLY_PATTERNS) {
    p.re.lastIndex = 0;
    let replaced = 0;
    const next = out.replace(p.re, (m: string, label: string, value: string, offset: number, whole: string) => {
      if (assignmentValueExempt(whole.slice(0, offset), label, value)) return m;
      replaced += 1;
      // Ticket b71367e5 (advisory A8): a keyword-leg label that NAMES a
      // NAMED_COMPOUND_TAILS compound (`db_password=`, `export DB_PASSWORD:`,
      // `auth_token=`) carries the label too — the same credential then
      // derives the SAME envKey whatever separator the owner used. A bare
      // keyword label (`password=`, `api_key=`, `X-API-Key:`) stays
      // unlabeled (the pre-fix span shape for those is unchanged).
      const compoundLabel = compoundCredentialLabel(label);
      // Ticket 3b573ce3: the keyword leg can carry the same fused AWS pair
      // (`secret_access_key=AKIA…<40>`) — same choke point, same split.
      pushCaptureSpan(spans, p.name, value, compoundLabel ?? undefined);
      return `${label}${noteFor()}`;
    });
    if (replaced) {
      hits.push(p.name);
      out = next;
    }
  }
  // Ticket ca0b57cd — the named-compound leg (`secret_access_key=…` and the
  // AWS/db idiom family): runs on the ALREADY-REWRITTEN text so a value the
  // keyword rule consumed can never be re-captured, and a value it declined
  // (placeholder / cursor / no entropy) is re-judged by the SAME exempt gate.
  // The tail itself lives IN the pattern (review B1) — a non-tail `word:` is
  // not a candidate at all, so nothing after it is swallowed.
  {
    NAMED_COMPOUND_RE.lastIndex = 0;
    let replaced = 0;
    const next = out.replace(NAMED_COMPOUND_RE, (m: string, label: string, value: string, offset: number, whole: string) => {
      if (namedCompoundValueExempt(value)) return m; // path / URL / ARN / fingerprint reference (A1; escaped forms judged unescaped)
      if (assignmentValueExempt(whole.slice(0, offset), label, value)) return m;
      replaced += 1;
      pushNamedCompoundSpan(spans, 'Named credential assignment', value, label);
      return `${label}${noteFor()}`;
    });
    if (replaced) {
      if (!hits.includes('Named credential assignment')) hits.push('Named credential assignment');
      out = next;
    }
  }
  // audit 2026-10-06 T2-1: password / passphrase labels + plain-English
  // disclosures (after the ≥16 assignment shape — a value it already
  // rewrote starts with `[REDACTED` and is left alone here).
  if (!passwordLabelsDisabled()) {
    const r = redactPasswordShapes(out, spans, noteFor);
    out = r.text;
    for (const h of r.hits) if (!hits.includes(h)) hits.push(h);
  }
  for (const p of CONTEXT_GATED_PATTERNS) {
    p.re.lastIndex = 0;
    let replaced = 0;
    const next = out.replace(p.re, (m: string, offset: number, whole: string) => {
      if (!cueNearby(whole, offset, m.length, p.cue, p.window)) return m;
      // Ticket 365588cf: the optional VALUE-SHAPE gate — a `re` that finds a
      // bare length/alphabet run (the 40-char AWS secret) is not proof on its
      // own; the candidate must also carry the shape (mixed case + a digit,
      // never a hex sha1). No `value` on a row = the cue alone decides, the
      // pre-ticket behaviour.
      if (p.value && !p.value.test(m)) return m;
      if (/ /.test(m) && appPasswordLooksLikeProse(m)) return m; // hotfix 2026-10-06: ordinary words, not a credential
      replaced += 1;
      spans?.push({ name: p.name, value: m });
      return noteFor();
    });
    if (replaced) {
      if (!hits.includes(p.name)) hits.push(p.name);
      out = next;
    }
  }
  // Ticket a65bc528 — the LABEL-FREE leg, deliberately LAST. Every leg above
  // is label-driven (or cue-driven) and has already rewritten whatever it
  // captured to a note, so a run matched here is one NOTHING else saw: no
  // pre-existing span shape or redaction text moves. The value shape alone is
  // the evidence (a self-identifying key ID fused to a ≥20-char continuation),
  // which is what makes a neutral label like `CANLAW_CPT_S3_KEY` irrelevant.
  if (!fusedAwsPairRedactDisabled()) {
    FUSED_AWS_PAIR_RE.lastIndex = 0;
    let replaced = 0;
    const next = out.replace(FUSED_AWS_PAIR_RE, (m: string) => {
      replaced += 1;
      // Same choke point as 3b573ce3: the run splits into the key ID (its own
      // span, no label) and the remainder (named as the secret half). The text
      // still carries ONE note for the whole run — a split there would leave
      // half the fused credential standing on the stored row.
      pushCaptureSpan(spans, FUSED_AWS_PAIR_SPAN_NAME, m);
      return noteFor();
    });
    if (replaced) {
      if (!hits.includes('AWS access key')) hits.push('AWS access key');
      out = next;
    }
  }
  return { text: out, hits };
}

/**
 * Redact every STRING LEAF of a value (plain objects / arrays walked, depth
 * ≤ 16; other values pass through untouched) with the chat-read policy. The
 * caller serializes the RESULT — a regex over already-serialized JSON text
 * could consume the backslash of an escaped quote and hand the model a
 * malformed document (review finding on get_run_receipts). Never throws: any
 * failure returns the input with hits: [] and applied: false.
 */
export function redactStringsDeep<T>(value: T, opts: { machineRun: boolean }): { value: T; hits: string[]; applied: boolean } {
  try {
    if (!opts?.machineRun && process.env.CHAT_READ_SECRET_REDACT_ALL !== '1') return { value, hits: [], applied: false };
    const hits = new Set<string>();
    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === 'string') {
        const r = redactSecrets(v);
        for (const h of r.hits) hits.add(h);
        return r.text;
      }
      if (depth >= 16 || v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v; // Date, Map, class instances…
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, depth + 1);
      return o;
    };
    const next = walk(value, 0) as T;
    return { value: hits.size ? next : value, hits: Array.from(hits), applied: true };
  } catch {
    return { value, hits: [], applied: false };
  }
}

/**
 * The inbound-persistence entry point (owner-question answers, supervisor
 * directives): returns the redacted text. Never throws.
 */
export function redactInboundSecrets(text: string): string {
  try {
    return redactSecrets(text).text;
  } catch {
    return String(text ?? '');
  }
}

/** redactInboundHead's defaults: the window a clip at `n` redacts is n + this, to the end of the token on that edge… */
export const REDACT_HEAD_MARGIN = 512;
/** …and never more than n + this (a whitespace-free run that long is cut there). */
export const REDACT_HEAD_MAX_WINDOW = 16384;

/**
 * Redact-before-clip for a caller that shows only the first `n` chars of `text` (FS owner-turn context review
 * 2026-10-23: the owner-turn history, the [SINCE YOUR LAST WAKE / NOTE] ledger diff). Redacts a window of n +
 * `margin` chars, extended to the end of the token sitting on that edge (≤ n + `maxWindow`), so a credential that
 * straddles the caller's clip is matched WHOLE instead of leaving its head on screen. Returns the redacted window
 * and whether the source continued past it (the caller marks the clip). Never throws.
 */
export function redactInboundHead(text: unknown, n: number, opts: { margin?: number; maxWindow?: number } = {}): { text: string; cut: boolean } {
  const s = String(text ?? '');
  const margin = opts.margin ?? REDACT_HEAD_MARGIN;
  const max = Math.max(margin, opts.maxWindow ?? REDACT_HEAD_MAX_WINDOW);
  let end = s.length;
  if (s.length > n + margin) {
    const ws = s.slice(n + margin, n + max).search(/\s/);
    end = ws < 0 ? Math.min(s.length, n + max) : n + margin + ws;
  }
  return { text: redactInboundSecrets(end < s.length ? s.slice(0, end) : s), cut: end < s.length };
}

/**
 * Ticket 26786762 (owner-secret delivery): the inbound redaction with BOTH a
 * spans sink AND a caller-supplied replacement note. The sink receives every
 * span the pass redacts, in match order, and the text carries `noteFor()`'s
 * output where each span sat — so the flag path can route the would-be-
 * destroyed value into an encrypted store and leave a numbered reveal handle
 * on the card instead of `[REDACTED: …]`. The spans and the rewrite come
 * from the SAME redactImpl pass, so extraction is exactly symmetric with
 * redactInboundSecrets by construction. Never throws: any failure degrades
 * to the plain redaction (spans empty, destruction marker in place).
 */
export function redactInboundSecretsWithNotes(
  text: string,
  spans: SecretSpan[],
  noteFor: SecretNoteFor,
): string {
  try {
    return redactImpl(String(text ?? ''), spans, noteFor).text;
  } catch {
    return redactInboundSecrets(text);
  }
}

/**
 * OUTBOUND entry point (audit 2026-10-06 T2-2): a message body an agent SENDS
 * — send_chat_message content (persisted in the target chat + its run's
 * prompt) and notify_user text (pushed to Telegram) — is redacted on EVERY
 * turn, machine and human: a relayed credential is how an owner-pasted key
 * spread into four more transcripts. The sanctioned hand-off is store_secret
 * (the value never rides a message). Kill switch
 * OUTBOUND_SECRET_REDACT_DISABLED=1 (verbatim, as before). Never throws.
 */
export function redactOutboundSecrets(text: string): { text: string; hits: string[]; count: number; applied: boolean } {
  const input = String(text ?? '');
  try {
    if (process.env.OUTBOUND_SECRET_REDACT_DISABLED === '1') return { text: input, hits: [], count: 0, applied: false };
    const spans: SecretSpan[] = [];
    const r = redactImpl(input, spans);
    return { text: r.text, hits: r.hits, count: spans.length, applied: true };
  } catch {
    return { text: input, hits: [], count: 0, applied: false };
  }
}

/** The tool-result line that ANNOUNCES an outbound redaction (never silent). */
export function outboundRedactionNotice(hits: string[], count: number): string {
  const n = Math.max(1, count | 0);
  return `CREDENTIALS REDACTED — ${n} credential-shaped value(s) (${hits.join(', ') || 'credential'}) were replaced with "${REDACTED_NOTE}" BEFORE this message was stored or sent; the recipient never saw them. A credential never rides a message: on the owner's own turn call store_secret {envKey} (the server lifts the value from the owner's message) and tell the lane to use $ENVKEY in its shell.`;
}

/**
 * Chat-read tool-output entry point (D4, 2026-09-27): get_chat_messages /
 * get_run_receipts hand their output through here. Redacts ONLY on a MACHINE
 * run (`machineRun` = no user turn anchors the call — the supervisor harvest
 * path that copied a pasted key into a directive) unless
 * CHAT_READ_SECRET_REDACT_ALL=1 widens it to every turn; a user-present turn
 * keeps reading its own chats verbatim (the owner pasted it, the owner may
 * read it back). Never
 * throws — any failure returns the input unchanged with hits: [].
 */
export function redactChatReadSecrets(
  text: string,
  opts: { machineRun: boolean },
): { text: string; hits: string[]; applied: boolean } {
  const input = String(text ?? '');
  try {
    const widen = process.env.CHAT_READ_SECRET_REDACT_ALL === '1';
    if (!opts?.machineRun && !widen) return { text: input, hits: [], applied: false };
    const r = redactSecrets(input);
    return { text: r.text, hits: r.hits, applied: true };
  } catch {
    return { text: input, hits: [], applied: false };
  }
}
