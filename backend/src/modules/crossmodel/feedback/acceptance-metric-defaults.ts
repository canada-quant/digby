/**
 * Acceptance-metric DEFAULTS + the regex-intent check (ACCEPTANCE-METRIC-BASELINE,
 * 2026-10-20) — the PRISMA-FREE half of ticket-metric.ts.
 *
 * Why a separate leaf: the auto-filers (framework-signal-sweep.ts builds its
 * ticket args synchronously and keeps its DB access behind dynamic imports)
 * must attach a default metric without dragging config/database into their
 * static import graph. Everything here is pure; ticket-metric.ts re-exports it,
 * and its validator re-checks every default at read time (the defaults below
 * are valid by construction — ticket-metric.test.ts pins that they validate).
 *
 * Imports only the loop-metric-kinds leaf (+ a type).
 */

import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';
import type { AcceptanceMetric } from './ticket-metric';

/** Kill switch for the whole baseline gate (regex-intent refusal included). Read at CALL time. */
export function acceptanceBaselineGateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACCEPTANCE_BASELINE_GATE_DISABLED === '1';
}

/** Kill switch for the auto-filers' default metrics (and the per-finding telemetry rows they count). */
export function autofilerDefaultMetricDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTOFILER_DEFAULT_METRIC_DISABLED === '1';
}

/** Regex INTENT a literal-substring probe can never honor (see regexIntentOf) — the
 *  character-class case is judged separately (regexClassIntentOf). */
const REGEX_INTENT_RE = /\||\\|\.[*+?]|^\^|\$$|\(\?|\{\d+(?:,\d*)?\}/;
/** A bracketed group: candidate character class OR a literal log tag ("[ticket-dispatch]"). */
const BRACKET_GROUP_RE = /\[([^\]\s]{1,40})\]/g;
/** A real character-class RANGE: both ends the same kind (digit / lower / upper), start ≤ end. */
const CLASS_RANGE_RE = /([0-9])-([0-9])|([a-z])-([a-z])|([A-Z])-([A-Z])/g;

/**
 * A bracketed group that reads as a regex CHARACTER CLASS, or null. Review
 * 2026-10-20: "[ticket-dispatch] drain failed" and "[post-deploy verifier
 * (6665fff6)]" are log tags, not classes — the old "[ … x-y … ]" test refused
 * them. A group is a class only when it carries no whitespace and is made of
 * valid ranges with at most two other characters ('[a-z]', '[0-9a-f]',
 * '[A-Za-z0-9_]', '[^a-z]'); a hyphenated word ('[log-in]', '[e-mail]',
 * '[x-ray]', '[ticket-dispatch]') is not — its "range" is reversed or comes
 * with three or more loose letters. A rangeless class ('[abc]+') reads as a
 * literal here; the baseline gate then finds it counts nothing (vacuous). Pure.
 */
function regexClassIntentOf(p: string): string | null {
  BRACKET_GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_GROUP_RE.exec(p)) !== null) {
    const body = m[1].replace(/^\^/, '');
    let ranges = 0;
    const rest = body.replace(CLASS_RANGE_RE, (all: string, d1?: string, d2?: string, l1?: string, l2?: string, u1?: string, u2?: string) => {
      const [a, b] = [d1 ?? l1 ?? u1 ?? '', d2 ?? l2 ?? u2 ?? ''];
      if (a <= b) { ranges++; return ''; }
      return all;
    });
    if (ranges >= 1 && rest.length <= 2) { BRACKET_GROUP_RE.lastIndex = 0; return m[0]; }
  }
  BRACKET_GROUP_RE.lastIndex = 0;
  return null;
}

/**
 * The first REGEX-INTENT token in a pattern, or null. The app_error_log_count
 * probe matches a case-insensitive LITERAL substring (Prisma contains), so
 * these can only ever match themselves: alternation '|', a backslash escape,
 * '.*' / '.+' / '.?', a leading '^' / trailing '$', '(?' groups, '{n,m}'
 * quantifiers and character classes ('[a-z]', '[0-9a-f]+' — regexClassIntentOf).
 * Plain parentheses, brackets and dots stay legal — log messages carry them
 * literally ("[HARNESS …]", "[ticket-dispatch] drain failed", "(terminal
 * auth; …)", "config.json"). Pure.
 */
export function regexIntentOf(pattern: unknown): string | null {
  const p = typeof pattern === 'string' ? pattern : '';
  if (!p) return null;
  const m = REGEX_INTENT_RE.exec(p);
  return m ? m[0] : regexClassIntentOf(p);
}

/** Provenance stamp (context.acceptanceMetricSource) on a ticket whose metric an AUTO-FILER attached. */
export const AUTOFILER_DEFAULT_METRIC_SOURCE = 'autofiler-default';

/**
 * Provenance stamp (context.acceptanceMetricSource) on a ticket whose metric a
 * LANE attached itself via `file_feedback` (TICKET 31199f81, 2026-11-06).
 *
 * This exists because the redirect's escape hatch must be an EXPLICIT marker:
 * once a missing marker means "decide from the metric's content", a
 * hand-authored bar is indistinguishable from a pre-marker auto-filer stamp
 * unless the filer says which it is. `feedback.service.ts` already reads this
 * same literal as its telemetry fallback; platform-tools now STORES it, so a
 * lane's judgement stays enforceable instead of being redirected away.
 */
export const HAND_AUTHORED_METRIC_SOURCE = 'filer';

/** Default window: one day of post-fix silence is the auto-filers' own "the class stops recurring" check. */
export const DEFAULT_METRIC_WINDOW_HOURS = 24;
/** A literal fragment shorter than this would match unrelated log lines. */
export const LOG_FRAGMENT_MIN = 16;
const LOG_FRAGMENT_MAX = 120;
/** ticket-metric.ts's PARAM_MAX / LEVELS (kept in step; its validator re-checks). */
const PARAM_MAX = 200;
const LEVELS = ['error', 'warn'];

/**
 * The longest STABLE literal fragment of a log-signal fingerprint: the text
 * between normalization placeholders (<uuid> <hex> <date> <time> <n>) and
 * redaction notes, edge punctuation trimmed; ≥ LOG_FRAGMENT_MIN chars and free
 * of regex intent, else null.
 *
 * RAW-ANCHOR (log-signal family 2026-10-21, tickets ac626e4f + 658ecf0e): the
 * probe matches a case-insensitive LITERAL substring of the RAW app_error_logs
 * rows, but the fingerprint has ALL whitespace collapsed — so a raw message
 * carrying a double space ("search_engine failed:  direct …") or a newline
 * ("docker info --format {{.ServerVersion}}\n)") yields a fingerprint fragment
 * that matches ZERO raw rows: a VACUOUS metric that passes whether the class is
 * fixed or roaring (measured baseline 0 against 211 actual rows on ac626e4f,
 * 0 against 22 on 658ecf0e). When the caller holds the signal's newest RAW
 * example, the fragment is verified against it; on a miss it is re-derived
 * from the RAW text (whose whitespace is the faithful one), keeping only runs
 * the fingerprint also carries — the class identity, never per-occurrence
 * variable text. Null when nothing qualifies: the honest no-metric path the
 * sweep already handles (acceptanceMetricMissing), never a pattern that
 * cannot count its own rows. Pure.
 */
/**
 * PREFER A DISCRIMINATING RUN (ticket 30dfad06, 2026-11-06). The default bar is
 * a case-insensitive LITERAL SUBSTRING count, so a fragment that also matches a
 * SIBLING class still filing measures that sibling's rows too. When `avoid`
 * rejects the longest run, fall back to the longest run it accepts — keeping a
 * SOUND bar instead of dropping coverage. `chosen` is returned unchanged when
 * nothing discriminates, so the caller can SEE the collision and decide (never a
 * silent weakening). Pure.
 */
function preferDiscriminating(
  chosen: string,
  pool: ReadonlyArray<string>,
  avoid: ((candidate: string) => boolean) | undefined,
): string {
  if (!avoid || !chosen || !avoid(chosen)) return chosen;
  const alt = [...new Set(pool.map((x) => String(x)))]
    .map((x) => x.slice(0, LOG_FRAGMENT_MAX).trim())
    .filter((x) => x.length >= LOG_FRAGMENT_MIN)
    .filter((x) => !avoid(x))
    .sort((a, b) => b.length - a.length)[0];
  return alt ?? chosen;
}

/**
 * THE EMITTER'S OWN NAME (ticket d634e874, 2026-11-07).
 *
 * `warnSeatFailure` (seat-call.ts:280) renders ONE template for EVERY seat role
 * that shares it:
 *
 *     `${role} seat: ${p.model} (${p.label}) failed — ${describeSeatError(err)}`
 *
 * so `pdf_ocr seat: …`, `vision_describe seat: …` and `computer_vision seat: …`
 * differ ONLY in the role token in front. That token is the emit CLASS, and it
 * must survive derivation.
 *
 * MEASURED — it did not. `normalizeLogMessage` turns each model/error number
 * into a `<n>` placeholder, so the fingerprint's pieces are
 * `pdf_ocr seat: api-optimize-zai-glm-` (35 chars) and
 * `-flash (llm-cql (custom endpoint)) failed — timeout of` (53). The longest run
 * wins, the SHORT role-bearing run loses, and the derived pattern is
 * `flash (llm-cql (custom endpoint)) failed — timeout of` — which is a literal
 * substring of the vision_describe AND computer_vision rows too. Probe output
 * before this guard, all three roles deriving the identical string:
 *
 *     pdf_ocr   → "flash (llm-cql (custom endpoint)) failed — timeout of"
 *     vision…   → "flash (llm-cql (custom endpoint)) failed — timeout of"
 *     computer… → "flash (llm-cql (custom endpoint)) failed — timeout of"
 *
 * CONSEQUENCE (live, ticket d634e874): the bar counted three emit classes. The
 * 22-row pdf_ocr amplification was fixed and deployed, the pdf_ocr count fell to
 * 1, and the post-deploy verifier still REOPENED the ticket at 15:05:49Z on
 * `measured 3` — two vision_describe and one computer_vision row from other
 * files. No fix to the pdf_ocr emitter could ever have cleared it.
 *
 * THE RULE: when a message NAMES ITS OWN EMITTER, the derived pattern must keep
 * that name. `<role> seat: ` is that template's shape, and the role token is
 * what separates one seat's rows from another's. The sibling-discrimination pass
 * cannot cover this: it only fires when a colliding sibling is VISIBLE in the
 * same pass, and a seat role that starts failing next week is by definition not
 * in it (the same bounded-guarantee limitation `ambiguousFragmentSibling`
 * documents). Keeping the emitter's name is structural — it does not depend on
 * who else happens to be emitting today.
 *
 * `required` distinguishes "this message names an emitter" from "it does not":
 * a message that names one but yields no qualifying run gets NO bar (null,
 * flagged by the caller) rather than a cross-emitter bar. Never a silent
 * weakening — the caller's `acceptanceMetricMissing` flag keeps the absence on
 * the done-bar board.
 */
const EMITTER_ROLE_PREFIX_RE = /^([a-z][a-z0-9_.-]{1,40}) seat: /;

export function emitterScopedRun(fingerprint: unknown, pool: ReadonlyArray<string>): { required: boolean; run: string | null } {
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  const m = EMITTER_ROLE_PREFIX_RE.exec(fp);
  if (!m) return { required: false, run: null };
  const armed = `${m[1]} seat:`;
  const run = [...new Set(pool.map((x) => String(x).slice(0, LOG_FRAGMENT_MAX).trim()))]
    .filter((x) => x.length >= LOG_FRAGMENT_MIN && !regexIntentOf(x) && x.startsWith(armed))
    .sort((a, b) => b.length - a.length)[0];
  return { required: true, run: run ?? null };
}

export function stableLiteralFragment(fingerprint: unknown, exampleMessage?: unknown, avoid?: (candidate: string) => boolean): string | null {
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  const trimEdges = (x: string) => x.replace(/^[\s:;,.\-—–'"`]+|[\s:;,\-—–'"`]+$/g, '');
  const pieces = fp
    .split(/<[a-z_-]+>|\[REDACTED[^\]]*\]|…/i)
    .map(trimEdges)
    .filter((x) => x.length >= LOG_FRAGMENT_MIN && !regexIntentOf(x));
  // EMITTER SCOPE (d634e874) — resolved BEFORE the length/whitespace choices
  // below, because those are exactly what drops the role token. `required`
  // means the message names its own emitter (`<role> seat: …`), so a run
  // WITHOUT that name measures some other emitter's rows.
  const emitter = emitterScopedRun(fp, pieces);
  /** When the message names its own emitter, ONLY a run keeping that name may
   *  become the bar. No fallback: a fallback is precisely how the cross-emitter
   *  tail got in. If the emitter-scoped run still collides with a same-role
   *  sibling, the CALLER detects it (its `residual` check) and files with
   *  `acceptanceMetricMissing` rather than a bar that measures someone else. */
  const withEmitter = (fallback: string | null): string | null => {
    if (!emitter.required) return fallback;
    return emitter.run; // null ⇒ no bar (never a cross-emitter one)
  };
  if (!pieces.length) return null;
  const best = [...pieces].sort((a, b) => b.length - a.length)[0].slice(0, LOG_FRAGMENT_MAX).trim();
  const raw = typeof exampleMessage === 'string' ? exampleMessage : '';
  // No raw example (direct callers / older shapes): the fingerprint fragment,
  // as before — the filing-time baseline gate still measures every stored
  // metric against the real rows and drops a vacuous one.
  if (!raw) return withEmitter(best);
  if (raw.toLowerCase().includes(best.toLowerCase())) {
    // DISCRIMINATION ALSO HERE (30dfad06): the early-return path is the COMMON
    // one (the fingerprint fragment is a substring of the raw example), and it
    // is exactly the path a shared HEAD takes — returning `best` unconditionally
    // here would leave the sibling-spanning bar in place. Offer the other
    // fingerprint pieces as alternatives so a discriminating run can be chosen.
    const earlyOut = preferDiscriminating(best, pieces, avoid).slice(0, LOG_FRAGMENT_MAX).trim();
    const resolved = withEmitter(earlyOut.length >= LOG_FRAGMENT_MIN ? earlyOut : null);
    return resolved && resolved.length >= LOG_FRAGMENT_MIN ? resolved : null;
  }
  // The fingerprint fragment is NOT a substring of the raw example — the two
  // differ in whitespace (the fingerprint collapsed it). Re-derive from the
  // RAW text, anchored to the fingerprint: split on the same variable-token
  // shapes normalizeLogMessage replaces, keep only runs the fingerprint
  // carries — either the run is a chunk of the fingerprint, or the whole
  // (possibly cap-truncated at FINGERPRINT_MAX_LEN) fingerprint text sits
  // inside the run, the 658ecf0e shape: the raw run is the uncapped original
  // of a fingerprint normalization cut mid-word. The RAW fragment's own
  // spacing is what the probe's literal contains-match needs.
  const fpKey = rawWsKey(fp);
  const anchored = (x: string): boolean => { const k = rawWsKey(x); return fpKey.includes(k) || k.includes(fpKey); };
  // The exampleMessage arrives REDACTED (logSignalMetricContext redacts both
  // ends), but the rows the probe counts are UNREDACTED — a secret sits
  // verbatim in app_error_logs while the example carries the
  // [REDACTED: …] marker. A run containing the marker can never match its
  // own rows (review 2026-10-21, F1) — split redaction notes and ellipses
  // out FIRST (the fingerprint splitter's own alternation), then the
  // variable tokens; strip ANSI the way the normalizer does so a raw run
  // cannot carry colour codes either.
  const candidates = raw
    .replace(/\u001b\[\d+m/g, '')
    .split(/\[REDACTED[^\]]*\]|…/i)
    .flatMap((piece) => piece.split(RAW_VARIABLE_TOKEN_RE))
    .map(trimEdges)
    .filter((x) => x.length >= LOG_FRAGMENT_MIN && !regexIntentOf(x))
    .filter(anchored);
  if (!candidates.length) return null;
  const rawBest = [...candidates].sort((a, b) => b.length - a.length)[0];
  // Whitespace-stable preference (review 2026-10-21, F2): the raw run carries
  // the EXAMPLE row's spacing — a double space or newline inside it only
  // matches rows with that exact spacing, so one fingerprint with two
  // whitespace variants would be half-counted (and a quiet half can stamp
  // deployed_verified while the other roars). The longest sub-run BETWEEN
  // those breaks — single-spaced text only — matches every variant. Falls
  // back to the full run when no sub-run qualifies.
  const stable = rawBest
    .split(/\s{2,}|\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.length >= LOG_FRAGMENT_MIN && !regexIntentOf(x))
    .filter(anchored)
    .sort((a, b) => b.length - a.length)[0];
  // DISCRIMINATION (30dfad06): when the best run also matches a sibling class,
  // prefer the longest run that does not — a SOUND bar, not a dropped one.
  // The pool is every anchored candidate run (pre-whitespace-split rungs
  // included, so "request failed with status code" is available even though the
  // longest run happens to be the shared head).
  const pool = [...candidates, ...(stable ? [stable] : [])];
  const chosen = stable ?? rawBest;
  // EMITTER SCOPE (d634e874) applies on this path too: the RAW runs carry the
  // role token uncut, so the emitter-scoped choice is available here even when
  // the placeholder-split pieces above lost it.
  const rawEmitter = emitterScopedRun(fp, candidates);
  const out = preferDiscriminating(chosen, pool, avoid).slice(0, LOG_FRAGMENT_MAX).trim();
  const resolved = rawEmitter.required ? rawEmitter.run : (out.length >= LOG_FRAGMENT_MIN ? out : null);
  if (!resolved || resolved.length < LOG_FRAGMENT_MIN) return null;
  if (rawEmitter.required && avoid && avoid(resolved)) {
    return out.length >= LOG_FRAGMENT_MIN ? out : null;
  }
  return resolved;
}

/**
 * FRAGMENT DISCRIMINATION (ticket 30dfad06, lane 3d5956e1, 2026-11-06) — does
 * this fragment measure ONE class, or a head two classes share?
 *
 * The default bar is `app_error_log_count <= N` matching a case-insensitive
 * LITERAL SUBSTRING of the row. So the bar is only attainable when the fragment
 * matches the ticket's OWN rows and nothing else that keeps filing. `stableLiteralFragment`
 * picks the LONGEST literal run, which for a message whose distinguishing text
 * sits AFTER a long common head is the HEAD — and that head is a substring of
 * every sibling subclass that shares the template.
 *
 * MEASURED, and the reason this exists (ticket 30dfad06 reopened at
 * 2026-11-06T03:15:58Z on a fix that WORKS): `brightdata-direct.ts` emits one
 * message template whose subclasses `classifyDirectMiss` splits into
 * deliberately DIFFERENT dispositions — `http_5xx`/`net_*` going out via
 * logExternal (adjudicated vendor class, correctly retired from the sweep) while
 * `timeout` (our own ECONNABORTED budget) stays an untagged warn that MUST keep
 * filing, because tagging it would swallow the 2026-08-06 invisible-outage
 * class. The derived fragment was the shared head
 * "brightdata direct: scrape_as_markdown failed" (44 chars), a substring of
 * BOTH. The verifier's window held exactly four matching rows and it measured
 * THREE: one `500 Header overflow` (excluded, external — the fix working) plus
 * three `timeout` rows (kept by design). `3 > 2` ⇒ REOPENED. The bar counted a
 * class the fix is not allowed to silence, so no correct fix could ever clear it.
 *
 * THE CALLER'S EVIDENCE IS THE PASS'S OTHER SIGNALS — the only set known to be
 * still emitting (the sweep already dropped every non-fault row, so a sibling in
 * that set contributes rows to this count). A collision means the fragment does
 * not identify one class, and the honest answer is NO volume bar plus a visible
 * flag, never a bar that measures someone else's rows. This is the same
 * do-not-invent-an-unattainable-criterion posture as the designed-alarm path
 * (1425001e), and the caller flags `acceptanceMetricMissing` so the absence stays
 * on the done-bar board instead of passing silently.
 *
 * BOUNDED, stated honestly: the guarantee is against siblings VISIBLE in the
 * same pass. A class that first appears after filing is not predicted here — no
 * filing-time derivation can see it, and the flag makes that visible rather than
 * silent. Pure; never throws.
 */
export function ambiguousFragmentSibling(
  fragment: string | null,
  siblings: ReadonlyArray<{ fingerprint?: unknown; exampleMessage?: unknown }>,
): string | null {
  const f = typeof fragment === 'string' ? fragment.trim().toLowerCase() : '';
  if (!f) return null;
  for (const s of siblings) {
    const fp = String(s?.fingerprint ?? '');
    if (!fp) continue;
    if (fp.toLowerCase().includes(f)) return fp;
    // The RAW example carries the un-collapsed text the probe actually matches.
    const ex = String(s?.exampleMessage ?? '');
    if (ex && ex.toLowerCase().includes(f)) return fp;
  }
  return null;
}

/** Whitespace-collapsed, case-folded comparison key — the shape the
 *  fingerprint and a raw run of the same class share. Pure. */
function rawWsKey(x: string): string {
  return x.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The variable-token shapes normalizeLogMessage replaces, matched against the
 *  RAW text: uuids, ≥16-hex ids, dates/times, bare numbers — ONE alternation,
 *  same order as the normalizer (uuids before hex before timestamps before
 *  numbers) so an earlier alternative cannot mangle what a later one looks
 *  for. String.split honors the flags-free pattern. */
const RAW_VARIABLE_TOKEN_RE
  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b\d{4}-\d{2}-\d{2}(?:[T ][\d:]+(?:\.\d+)?)?Z?|\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?|\d+(?:\.\d+)?/gi;

/**
 * TICKET 1425001e (2026-11-01) — DESIGNED-ALARM classes: emissions whose warn
 * firing is the INTENDED behaviour of a working system, so their VOLUME can
 * never be an acceptance bar.
 *
 * WHY THIS EXISTS (measured, not stylistic). Ticket 8b62e61e — a fix that NAMED
 * a severed tool-call cut and deliberately KEPT the warn as the alarm — was
 * filed with the sweep's default `app_error_log_count <= 2` over its own
 * fingerprint. That probe counts warn EMISSION at an emit site
 * (`coding-model.ts:2145`) the fix's diff never touched. The lane measured 28
 * rows against a bar of 2 and said so in its close-out note; because
 * `certainEarlyVerdict` rules a `<=` breach with measured > target as CERTAIN,
 * the next verifier tick would have REOPENED a correct fix and the drain would
 * have dispatched a fresh lane onto a non-defect.
 *
 * THE FIX IS NOT "COUNT THE LOSS INSTEAD" — that was the original proposal and
 * the live data refutes it. A `<=` bar on the new
 * `tool_call_unrecovered_severance` kind would reopen the SAME fix one level
 * down: the gateway really does send short payloads, so unrecovered severance
 * PERSISTS after a naming fix by design (live rows at 22:54:40Z, seven minutes
 * after the 22:47Z deploy that carried the naming fix, still read
 * `sv:"complete-sibling"`). Nor does `>= 1` work — it fails closed whenever the
 * gateway happens to stop severing. FOR A NAMING/CONTAINMENT FIX THERE IS NO
 * SOUND COUNT BAR, so the honest autofiler behaviour is to attach NONE and let
 * the row surface as needing a behavioural criterion. A CONTAINMENT fix that
 * genuinely reduces the loss can attach
 * `loop_metric_count {kind: tool_call_unrecovered_severance} <= n` itself — the
 * kind exists for exactly that, and its rows carry `ok:false` so the ok/fail
 * aggregate can rate them.
 *
 * Signatures are matched against the METRIC'S OWN messagePattern (never a lane's
 * prose), so this is a structural property of the probe being attached, not a
 * party's opinion about it. Pure.
 */
/**
 * MEASURED (adversarial review of the first cut, 2026-11-01) — the emit sites
 * share ONE head, `tool-call stream [<model>]`, across THREE different classes
 * in coding-model.ts:
 *   :2145  GATEWAY-OR-OURS drop arithmetic                     ← the instrument
 *   :2033  dropped duplicate fragment(s)                      ← a real defect
 *   :2062  folded orphaned continuation ⇒ call dispatched truncated ← a REAL
 *                                                               DATA-LOSS defect
 * The head alone therefore attributes NOTHING. The first cut matched it on the
 * FINGERPRINT, which suppressed the metric for the orphan-fold family too and
 * made a genuine truncation regression unmeasurable and unreopenable. Two rules
 * follow, deliberately ASYMMETRIC because the two surfaces carry different text:
 *   - a FINGERPRINT is the whole normalized message, so it carries the
 *     distinguishing words ⇒ require the instrument's own TOKEN;
 *   - a metric's messagePattern is a derived FRAGMENT that may be nothing but
 *     the shared head (that IS the 8b62e61e metric: `tool-call stream
 *     [api-optimize-xiaomi-mimo-v`) ⇒ accept the head, but ONLY when the
 *     fragment is nothing BUT the head (no trailing prose). A later family's
 *     fragment keeps its tail and so still misses.
 */
const INSTRUMENT_TOKEN_RE = /gateway-or-ours/i;
/** The emit-site head with a model name and NO trailing prose — the ambiguous fragment. */
const SHARED_HEAD_RE = /^tool-call stream \[[^\]]*$/i;
/**
 * The verdict line's CULPRIT reads `ours` (ticket 35cd91a7, 2026-11-06).
 *
 * RECALL GUARD. `finalizeVerdictSummary` renders `${culprit} recv=…` and
 * `gatewayOrOurs` returns 'ours' for the classes that ARE a defect of ours:
 * unread argument bytes, skipped raw lines, parse-fail tool calls, and the
 * parse-fail+multiline pair. The emit TEMPLATE carries the `GATEWAY-OR-OURS`
 * token for EVERY verdict, so the signature above matches an `ours` row too.
 * Without this guard, declaring the class a designed instrument would retire
 * the sweep's only detector for our own stream-handling bugs — the exact
 * self-inflicted blind spot the `designedAlarmOfMetric` comment records from
 * its first cut's review.
 *
 * `ours recv=` is unambiguous: the culprit word is immediately followed by the
 * arithmetic, and "gateway" cannot contain it.
 *
 * WHY THE RAW ROW, NOT THE FINGERPRINT (adversarial review of 35cd91a7,
 * 2026-11-06). The emit template puts the model name BEFORE the summary
 * (`tool-call stream [${provider.model}]: GATEWAY-OR-OURS ${summary}`) and the
 * fingerprint is hard-cut at FINGERPRINT_MAX_LEN = 120. A model id longer than
 * ~73 normalized chars therefore cuts `ours recv=` away while the
 * `gateway-or-ours` TOKEN survives — the guard misses, the token matches, and
 * EVERY `ours` verdict on that seat becomes a permanently-silenced class. That
 * is a miss, NOT the safe direction: the token keeps matching independently of
 * the culprit. Measured before the fix: model length 74/78/82 → silenced.
 * Callers therefore pass the RAW example message (uncut) and the guard reads
 * that; the truncated fingerprint is only the fallback when no raw row exists.
 */
const OURS_CULPRIT_RE = /\bours recv=/i;

/**
 * The web-search PDF fetch/extract warn's arm that is OUR OWN bug, not a
 * third-party condition (ticket 68200428, adversarial review 2026-11-06).
 *
 * `extractPdfTextFromUrl` runs `decodeURIComponent(<last path segment>)` inside
 * the same try as the fetch. A bare `%` in that segment throws
 * `URIError: URI malformed`, aborting extraction for a PDF already downloaded —
 * and real targets carry that shape (asbca.mil serves `…/56355%MAC`). The
 * emitter then reports it through the same `PDF fetch/extract failed` template,
 * so a template-wide designed-observability signature would have retired the
 * bar on a defect a fix CAN drive to zero. This guard keeps that arm
 * measurable.
 *
 * RECALL GUARD, same posture as OURS_CULPRIT_RE above: it is the only thing
 * stopping a designed signature from swallowing our own bug. The bug itself is
 * fixed at the emit site (`safeDecodeUrlSegment`, mcp-search.ts), so this arm
 * can no longer be minted going forward; the guard exists so that if it is ever
 * reintroduced (or a legacy row is re-measured) it keeps a bar.
 *
 * `uri malformed` is the exact `.message` Node's URIError carries, so this can
 * never match a third-party status/redirect/size arm.
 */
const OURS_PDF_FETCH_ARM_RE = /uri malformed/i;

const DESIGNED_ALARM_SIGNATURES: ReadonlyArray<{ id: string; test: (pattern: string, surface: 'fingerprint' | 'metric', raw: string) => boolean; why: string }> = [
  {
    // The finalize/GATEWAY-OR-OURS line is an INSTRUMENT, not a fault report: it
    // states its own drop arithmetic (recv/acc/drop/frag/buf) about a condition
    // the emitting file does not own. It fires whenever an upstream gateway ends
    // a turn short — correct behaviour of a correct measurement.
    id: 'gateway-or-ours',
    test: (p, surface, raw) => {
      // RECALL FIRST (35cd91a7): an `ours` culprit is a defect of OURS — never a
      // designed instrument, whatever surface is asking. Tested against the RAW
      // row where one was supplied, so the 120-char read cut cannot hide it.
      if (OURS_CULPRIT_RE.test(raw)) return false;
      return surface === 'metric'
        ? INSTRUMENT_TOKEN_RE.test(p) || SHARED_HEAD_RE.test(p.trim())
        : INSTRUMENT_TOKEN_RE.test(p);
    },
    why: 'the GATEWAY-OR-OURS finalize line is an instrument that reports its own drop arithmetic; it fires whenever the upstream gateway ends a turn short, fix or no fix',
  },
];

/**
 * TICKET dc4f7ff5 (2026-11-06) — DESIGNED OBSERVABILITY: a warn whose FIRING IS
 * the fix working, so its VOLUME can never be an acceptance bar.
 *
 * THE DEFECT THIS REPLAYS (measured, both specimens live at filing time):
 * the log-signal auto-filer attaches `app_error_log_count <= N` over the
 * ticket's own fingerprint fragment. For a class that emits the warning as the
 * EVIDENCE OF DESIGNED BEHAVIOUR, every residual row is correct behaviour, so
 * the bar is unattainable and `certainEarlyVerdict` rules each residual row a
 * CERTAIN fail — the post-deploy verifier reopens a fix that WORKS, forever.
 *
 * Two live specimens, both confirmed against origin/main before this change:
 *   - 3769b1b3 `utilityChat: utility role override unreachable (…) — the
 *     built-in chain serves utility calls directly.` The override leg fails
 *     over to the built-in chain BY DESIGN and the lane MEASURED the residual
 *     shape: every row reads `streak 1` because the override SUCCEEDS BETWEEN
 *     failures. Its 242-row baseline is external provider intermittency plus
 *     caller budgets vs multi-tens-of-k prefill, not a defect the bar can
 *     track.
 *   - e35f9985 `action-verifier: dropped <n> LLM-extracted note claim(s)
 *     narrating THIRD-PARTY lane status …` The action-verifier's drop guard
 *     DISCARDING a misattributed claim is the guard working; the warn is its
 *     only prose account. It reopens at 3 measured against a bar of 2 — and
 *     all three rows are this ticket's OWN class (see below).
 *
 * WHY "NO BAR" AND NOT "BASELINE × k" — the ticket offered both; the data
 * decides. A rate bar is only sound when the post-fix rate is bounded by the
 * FIX. Neither class is: the utility latch tracks third-party latency, and the
 * drop guard tracks how many lanes happen to narrate other lanes' status. A
 * `<= baseline × k` would still breach on a bad hour and reopen a correct fix
 * (the 1425001e measurement, one level down). The honest autofiler behaviour
 * is NO volume bar, FLAGGED so the row stays on the done-bar board and a lane
 * attaches its own behavioural criterion — the same posture as the designed
 * alarm path above, never a silent drop.
 *
 * NOT A FILING-STOP. `designedAlarmOfFingerprint` ALSO gates the sweep's
 * ticket filing (log-signal-sweep.service.ts). These classes must KEEP FILING:
 * 3769b1b3's remedy is an OWNER action (repair/re-point the custom utility
 * endpoint) and its recurrences are the only evidence of a sustained override
 * failure — `utils/utility-llm.test.ts` pins exactly that contract, and
 * e35f9985's warn is the only prose account of which claims a lane tried to
 * attribute to other lanes (log-signal-family.3769b1b3.pin.test.ts). So this
 * signature set is consulted ONLY for the METRIC decision; the filing-stop
 * keeps its narrow instrument-only predicate. Pinned by test.
 *
 * SURFACE ASYMMETRY (same rule as the alarm signatures above, and for the same
 * measured reason): a FINGERPRINT is the whole normalized message, so it
 * carries the class's own self-description — require it. A metric's
 * messagePattern is a derived FRAGMENT that may be nothing but the leading
 * clause (that IS 3769b1b3's derived pattern, `utilitychat: utility role
 * override unreachable (timeout of`), so the fragment must be accepted on the
 * distinguishing TOKEN alone. Being stricter on the metric surface would leave
 * the unfixed reopen loop in place for the very tickets this exists for.
 */
const DESIGNED_OBSERVABILITY_SIGNATURES: ReadonlyArray<{
  id: string;
  test: (pattern: string, surface: 'fingerprint' | 'metric', raw: string) => boolean;
  why: string;
}> = [
  {
    // utilityChat's override latch. The sole emitter
    // (utils/utility-llm.ts:101) ALWAYS appends "— the built-in chain serves
    // utility calls directly.", so the token IS the class in production; a
    // source-level pin in the replay test fails if a future emitter drops that
    // declaration, forcing this signature to be revisited rather than silently
    // over-matching.
    //
    // WHY NOT ALSO REQUIRE THE DECLARATION HERE (the adversarial-review finding
    // on this commit): the two surfaces cannot agree on it, and pretending they
    // did was worse than the honest shape. The FINGERPRINT is hard-cut at
    // FINGERPRINT_MAX_LEN=120, which lands BEFORE the declaration — that is why
    // the stored derived fragment is `utilitychat: utility role override
    // unreachable (timeout of`, with no declaration to test. Requiring it on
    // the fingerprint surface while accepting the bare token on the metric
    // surface produced a stamped bar for a hypothetical no-fallback variant
    // that the VERIFIER would then park as designed-observability: the stamp
    // said "measurable", the verifier said "unsound", and neither was right.
    // Unifying on the token makes the two agree. A no-fallback variant is
    // deliberately OUT of this class and gets NO bar (flagged, still filed) —
    // and since a real override outage's remedy is an owner action, a flagged
    // row is the better posture for it than a bar that cannot clear.
    id: 'utility-override-failover',
    test: (p) => /utility role override unreachable/i.test(p),
    why: 'the utility override latch fires BY DESIGN when the override leg fails over to the built-in chain, which serves the call directly — every residual row is the designed failover working, and the residual rate tracks third-party latency, not the fix',
  },
  {
    // action-verifier's THIRD-PARTY-ATTRIBUTION drop guard DISCARDING a claim a
    // lane tried to attribute to another lane. This is the ONLY arm of the two
    // `dropped <n> LLM-extracted … claim(s)` emit sites that qualifies, and the
    // exclusion is deliberate — see below.
    //
    // WHY THE `with NO verbatim support` SIBLING IS EXCLUDED (587e9d64 arm): its
    // volume IS coupled to a real defect. It measures extractor
    // paraphrase-hallucination, so a regression in the extractor makes it fire
    // more and a fix makes it fire less — exactly the property a `<=` bar needs.
    // Silencing it would hide whether the extractor improved. The ticket names
    // it as a live sibling class the fix is forbidden to silence, and its own
    // lane must keep its bar. (Measured: after PR #2583 the autofiler's
    // discriminator already separates the two arms, so the "shared fragment"
    // premise was refuted — but the exclusion is right on its own merits.)
    id: 'action-verifier-drop-guard',
    test: (p) => {
      if (!/llm-extracted\b.*\bclaim\(s\)/i.test(p)) return false;
      // The stored derived fragment can START mid-message (the fragment builder
      // drops the `action-verifier: dropped <n>` prefix, which carries the only
      // <n> placeholder), so the class test anchors on the disposition clause.
      if (/no verbatim support/i.test(p)) return false; // 587e9d64 arm — fix-coupled, keeps its bar
      return /narrating third-party lane status/i.test(p);
    },
    why: 'the action-verifier third-party-attribution drop guard discarding a claim a lane attributed to another lane is the guard WORKING — the dropped claim is real but not this run\'s, so no fix in this run can or should reduce the count',
  },
  {
    // ── TICKET 68200428 (2026-11-06, family lane a10726b9) ──────────────────
    // `Digby Web Search: PDF fetch/extract failed for "<url>": <reason>` —
    // mcp-search.ts `extractPdfTextFromUrl`'s catch, the per-target PDF fetch
    // observability for web research. ONE warn per failed TARGET, then null and
    // the caller falls through to the remaining search results; the fetch is
    // never retried inside the function.
    //
    // WHY THE CLASS AND NOT ONE ARM — WITH ONE EXCEPTION, WHICH IS OURS.
    // The two signatures above key on a distinguishing token because their emit
    // sites carry SILENCED and MUST-STILL-FILE arms side by side. This one's
    // arms are almost all a per-target property of a third-party server or of a
    // deliberate bound of ours — measured in the ticket's own window the class
    // filed as `Request failed with status code 403` (asbca.mil, dupont.com,
    // accessdata.fda.gov), `402` (globalsecurity.org), `503` (rockwool.com) and
    // `maxContentLength size of 20971520 exceeded`, i.e. the cap designed into
    // PDF_FETCH_MAX_BYTES. None is a defect a fix could drive to zero: an
    // external host refusing us stays refused (re-probed 2026-11-06 with a full
    // browser User-Agent — the same AkamaiGHost `Access Denied` 403 body, so it
    // is not bot-blocking we could mitigate), and the size cap is memory
    // safety, not a bug.
    //
    // THE EXCEPTION (adversarial review of this very ticket, 2026-11-06): the
    // same try also caught `decodeURIComponent(<last path segment>)`, and a bare
    // `%` in that segment (real target: asbca.mil `…/56355%MAC`) threw
    // `URIError: URI malformed`, aborting extraction for a PDF we had ALREADY
    // downloaded. That is OUR bug, not a third-party condition — so it is
    // excluded from this signature (OURS_PDF_FETCH_ARM_RE) and keeps a volume
    // bar, and the bug itself is FIXED at the emit site
    // (`safeDecodeUrlSegment`). Both halves are pinned: the repair in this
    // signature's replay suite, the retained bar in its recall guards.
    //
    // WHY A PATTERN MATCH RATHER THAN A FRAGMENT SHAPE (the F1 trap, avoided).
    // The autofiler's derived fragment for a row of this class is the message
    // head ending at the first variable token — measured on the live rows:
    // `digby web search: pdf fetch/extract failed for "https://www.asbca.mil/portals/`
    // (78 chars). Because normalizeLogMessage collapses the digit runs, the
    // fragment stops at the FIRST numeric path segment, so it is a per-HOST
    // prefix that does NOT carry the reason. Two consequences, both deliberate:
    //   - a shape-based test on the fragment could not tell a 403 arm from a
    //     same-host arm, so it would have to accept every host. Keying on the
    //     emit-site TEMPLATE is the same breadth but states the real reason —
    //     the class is designed end to end;
    //   - the bar the autofiler stamped is therefore per-host, and a fix could
    //     never clear it. That is the loop this closes.
    // The truncation is also why the ours-arm exclusion reads the pattern it is
    // GIVEN: a per-host prefix cannot contain `uri malformed`, so it falls
    // through to the designed verdict exactly as before — and after the repair
    // above our code can no longer mint that reason anyway.
    //
    // NOT A FILING-STOP, and NOT a logClass tag: the sweep keeps fingerprinting
    // and filing this class (the per-target warn is the only account of which
    // research targets are unreachable, and it is what surfaced this ticket).
    // Only the METRIC decision consults this set. Source-level pinned below in
    // log-signal-pdf-fetch.68200428.test.ts: exactly ONE emit site REPO-WIDE, one
    // warn per target, never retried — if a future refactor adds a retry or a
    // second emitter the pin fails and this signature must be revisited rather
    // than silently widening.
    //
    // THE EXTRACTOR IS A DIFFERENT MESSAGE AND KEEPS ITS BAR — `pdf-parse
    // getText() failed for <filename>` (pdf-extract.ts) measures the extractor
    // working, so a regression there must stay measurable. This pattern cannot
    // match it (pinned).
    id: 'websearch-pdf-fetch-target',
    test: (p) => /pdf fetch\/extract failed/i.test(p) && !OURS_PDF_FETCH_ARM_RE.test(p),
    why: 'the web-search PDF fetch/extract warn is per-target observability for an external document host refusing us or exceeding a deliberate size bound — one warn per target, never retried, so its volume tracks which third-party URLs a research session cites, never whether a fix works',
  },
  {
    // ── TICKET b73eae1b (2026-11-07, family lane 39ecd1b9) ──────────────────
    // `suggested-questions: draft yielded <n> candidates, <n> pass the
    // mechanical check (drops {}, source check skipped) for userId=<uuid> —
    // skipping critic`
    //
    // THE EMITTER (suggested-questions.service.ts:947) sits in an EXPLICIT
    // DESIGNED branch: `if (checked.kept.length < MIN_QUESTIONS)` — the comment
    // above it says a second reasoning call "cannot rescue a draft already below
    // the survivor threshold", so the run SKIPS the critic and takes the
    // defaults+backoff path. One warn per generation attempt, then it returns
    // []. The draft prompt itself legalises a small draft: DRAFT_SYSTEM says
    // "Produce fewer than MIN_CANDIDATES only when the context holds fewer than
    // 3 usable items", and the service header prefers "fewer chips" to padded
    // ones. So a thin user context structurally yields this row.
    //
    // WHY ITS BAR CANNOT CLEAR (the measured trap the ticket fell into). The
    // autofiler stamped `<= 2 / 24 h` on the derived fragment. Measured on this
    // ticket's own 11 rows, EVERY one reads `(drops {})` — i.e.
    // `mechanicalCheck` dropped NOTHING, so `kept === candidates < 3` and the
    // DRAFT itself came back empty or tiny. The recurrence driver is therefore
    // the draft provider's yield (utilityChat returning '' when every leg fails,
    // utils/utility-llm.ts, or model prose carrying no JSON array), which no fix
    // in this repo bounds — it tracks provider-seat health and user-context
    // thinness, exactly like the adjudicated utility-override-failover class. A
    // retry or a `question`-key alias could REDUCE it; neither can hold ≤2
    // across a provider blip, so a correct fix would reopen on the next one.
    //
    // SURFACE ASYMMETRY, MEASURED — the same trap utility-override-failover
    // documents above, and the reason a naive `draft yielded` predicate would
    // have been DEAD CODE here. `stableLiteralFragment` drops the message's
    // prefix (it is not literal — it carries the varying counts), so the
    // autofiler's derived messagePattern begins MID-MESSAGE:
    //     'pass the mechanical check (drops {}, source check skipped) for us'
    // verified by running logSignalDefaultMetric on this ticket's own
    // fingerprint. The fingerprint surface carries `draft yielded … candidates`;
    // the metric surface cannot, because those words are before the kept run.
    // So the predicate accepts EITHER self-description. Both are this class's
    // own prose, and neither appears in the :590 sibling.
    //
    // NOT A FILING-STOP, and NOT the :590 sibling's bar. This warn must keep
    // filing: it is the only per-attempt account of WHY a user got defaults.
    // The sibling `suggested-questions: <n> usable results for userId=… —
    // backing off …` is a DIFFERENT emit site (service.ts:590) and a different
    // ticket (d7a1ad46); the two CO-FIRE for one user event (this path returns
    // [], which fails the `>= MIN_QUESTIONS` test that logs :590), so the
    // predicates must not overlap. The sibling's fingerprint and its derived
    // fragment (`usable results for userid=`) match neither arm. Pinned below.
    id: 'suggested-questions-draft-yield',
    test: (p) => /draft yielded\b.*\bcandidates/i.test(p) || /pass the mechanical check\b/i.test(p),
    why: 'the suggested-questions draft-yield warn records a designed branch: a draft already below the survivor threshold skips the critic and takes defaults + a bounded backoff, one warn per attempt, so its volume tracks the draft provider\'s yield and the thinness of a user\'s context — never whether a fix works',
  },
  {
    // ── TICKET 9ffb9f8c (2026-11-07, family lane 39ecd1b9) ──────────────────
    // `action-verifier: pre-delivery strike — <n> phantom claim(s) in supervisor
    // <id>'s note; the note was delivered as writ`
    //
    // VERDICT: DESIGNED OBSERVABILITY — the guard WORKING, already pinned twice.
    // The emitter (platform/action-verifier.ts, the PRE-DELIVERY guard) is
    // explicitly observe-only for the ACTION class under defaults: nothing is
    // removed, the note is delivered as written, and the warn plus a
    // `guard_strike` row are the only account. Every residual row is the
    // detector RECORDING a real conviction of a fabricated claim in a
    // supervisor's note — the fabrication class the owner rules target. Prior
    // adjudications: 82029969 (citation class, "the guard doing its DESIGNED
    // job … not a defect in the guard") and 91fb1905 (the same emit site under
    // BRIEFING-UNVERIFIED-FILTER). log-signal-family.30dfad06.pin.test.ts:55-61
    // re-asserts member 18d83feb for this exact site as "DESIGNED, already
    // pinned twice".
    //
    // WHY THE BAR CANNOT CLEAR. Its volume tracks how often MODEL NARRATION
    // fabricates an id-less action claim — a property of the lanes' prose, not
    // of this repo's code. There is nothing a fix could tighten without
    // stopping the detector from convicting, which would blind the fleet to the
    // very class the owner rules target. Also measured: its derived fragment is
    // FRAGILE — stableLiteralFragment returns `'s note; the note was delivered
    // as writ'`, which starts MID-WORD (the digit-folded supervisor id broke the
    // preceding literal run). A bar counting that fragment measures a
    // meaningless slice of prose.
    //
    // NOT the `action-verifier-drop-guard` sibling (:526 above). That is a
    // DIFFERENT emit site (`dropped <n> LLM-extracted note claim(s) narrating
    // THIRD-PARTY lane status`, ticket e35f9985/bbd8521e). Neither arm below
    // matches it: the drop-guard message contains no `phantom` and no
    // `delivered as writ`. Pinned, because if this signature ever swallowed the
    // sibling, the sibling's own adjudicated bar would silently vanish.
    id: 'action-verifier-predelivery-strike',
    test: (p) => /phantom claim\(s\) in supervisor/i.test(p) || /note was delivered as writ/i.test(p),
    why: 'the action-verifier PRE-DELIVERY strike is the fabrication guard convicting phantom claims in a supervisor note before delivery — observe-only by design, so every residual row is the detector recording a REAL conviction, and its rate tracks model narration rather than whether a fix works',
  },
  {
    // ── TICKET 9289d163 (2026-11-07, family lane 39ecd1b9) ──────────────────
    // `CloudBrowserDriver: BrightData Scraping Browser CDP unavailable
    // (ip_forbidden?) → read-only scrape mode`
    //
    // VERDICT: DESIGNED OBSERVABILITY of a standing EXTERNAL condition, with an
    // owner-side remedy the source already states. cloud-driver.ts:14-21
    // documents the posture verbatim: "If that connection is refused (today it
    // returns 407 ip_forbidden because the prod server's IP isn't on the
    // BrightData zone's allowlist — fix: allowlist the IP or disable the zone's
    // IP-whitelist), the driver drops to a read-only scrape mode … The instant
    // the zone is allowlisted, navigate connects and the real browser is used —
    // NO CODE CHANGE." The warn is the mode transition's only account, and the
    // fallback is the designed degrade (the agent keeps working, read-only), not
    // a crash.
    //
    // ONCE PER DRIVER INSTANCE, never a storm: `mode` starts 'unknown' and is
    // only ever assigned 'cdp' or 'scrape', so the emit sits under
    // `mode === 'unknown'` and fires at most once per instance. A fresh driver
    // is built per browser session, so 10 rows / 6 hours ≈ 10 sessions where CDP
    // was armed and the FIRST attempt failed. Its volume tracks the zone's
    // allowlist state and gateway health — an owner action, never a code fix.
    //
    // This is the one whose bar the fleet most needs NOT to count: the whole
    // block is armed only when CLOUD_BROWSER_CDP is set, so the rows are
    // evidence that the hosted browser's interactive path is degraded, not a
    // defect to be measured away.
    id: 'cloud-browser-cdp-unavailable',
    test: (p) => /scraping browser cdp unavailable/i.test(p),
    why: 'the cloud browser CDP-unavailable warn records a designed degrade to read-only scrape mode when the BrightData zone will not accept this server\'s egress IP — once per driver instance, remedied by an owner-side zone allowlist and not by any code change, so its rate tracks external zone state, never whether a fix works',
  },
  {
    // ── TICKET d7a1ad46 (LEAD of the log-signal family, 2026-11-07 lane
    //    39ecd1b9; originally filed 2026-11-01, prior lane d0e5e838) ─────────
    // `suggested-questions: <n> usable results for userId=<uuid> (min <n>) —
    //  backing off <n> min before retry`
    //
    // WHY A SIGNATURE RATHER THAN A SERVICE FIX. The warn is emitted ONCE per
    // generation attempt (suggested-questions.service.ts:590) and the attempt
    // then arms a backoff marker the controller READS before kicking another
    // regeneration — 5 min for a transient miss, 30 min when a real draft was
    // thinned by the critic. So the class cannot become a request-rate storm,
    // and its rate tracks how many users hit a yield miss, which no fix here
    // bounds. The 30dfad06 pin already adjudicated it DESIGNED on exactly that
    // reasoning ("the recurrence driver is a real per-user yield miss, not a
    // retry loop; silencing it would blind the fleet to users who never get a
    // personalized set").
    //
    // THE REOPEN (sighting 2) WAS BASED ON A MISREADING, MEASURED 2026-11-07.
    // It claimed the 5-min promise was broken — "11 occurrences as close as
    // 1 min apart". The per-user rows refute it: d1185fde 18:38:31.617Z →
    // 18:43:37.969Z = 5m06s, 867c4f48 11:05:52.705Z → 11:11:00.115Z = 5m07s,
    // and EVERY same-user pair in the 24 h window is >= the 5-minute backoff.
    // The sub-5-minute adjacencies are across DIFFERENT users (22097a46 at
    // 15:55:55.850Z vs 158ffa30 at 15:55:15.277Z — two people 40 s apart),
    // which the PER-USER backoff never promised to space. The sweep was
    // comparing a global rate against a per-subject promise. (That exact
    // measuring defect is being fixed on its own ticket, 2e9ea13e, as "rule 2
    // measures the promised window per SUBJECT" — this signature handles the
    // METRIC side; the two are complementary, not duplicates.)
    //
    // WHICH ROWS ARE LEFT. Every one of the 12 live rows reads
    // `0 usable results`, and that path CO-FIRES the sibling :947 draft-yield
    // warn for the same user event (it returns [], failing `>= MIN_QUESTIONS`).
    // So the dominant driver is the DRAFT provider's yield — the class
    // `suggested-questions-draft-yield` above — not anything this repo's code
    // decides. The critic-thinning and exception arms exist but did not appear
    // in the window.
    //
    // NOT the :947 sibling. Its message carries `draft yielded … pass the
    // mechanical check` and never `usable results`; this predicate requires
    // `usable results`, so the two stay disjoint in both directions. Pinned.
    id: 'suggested-questions-low-yield',
    test: (p) => /usable results for user(?:id)?=/i.test(p),
    why: 'the suggested-questions low-yield warn is emitted once per generation attempt before arming the per-user backoff the controller reads, so it cannot storm; its rate tracks how many users hit a transient draft-yield miss, and the class is already adjudicated designed (30dfad06) — the 2026-11-07 reopen misread a PER-USER promise against a global rate',
  },
];

/** The unsoundness FAMILY a matched signature belongs to — the verifier's note reads from this. */
export type UnsoundMetricClass = 'designed-alarm' | 'designed-observability';

/** Does this FINGERPRINT emit by design (so no volume default may be attached)? Pure. */
export function designedObservabilityOfFingerprint(fingerprint: unknown, exampleMessage?: unknown): { id: string; why: string } | null {
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  if (!fp) return null;
  const raw = typeof exampleMessage === 'string' && exampleMessage ? exampleMessage : fp;
  return DESIGNED_OBSERVABILITY_SIGNATURES.find((s) => s.test(fp, 'fingerprint', raw)) ?? null;
}

/**
 * Is this metric's PROVENANCE an explicit hand-authored claim?
 *
 * TICKET 31199f81 (2026-11-06) — THE ESCAPE HATCH IS KEYED ON AN EXPLICIT
 * MARKER, NEVER ON THE ABSENCE OF ONE. This used to be an allowlist
 * (`source === 'autofiler-default'`, everything else refused), which made
 * "no marker" mean "hand-authored" — and that inverted exactly the rows it was
 * meant to protect:
 *   - 3769b1b3 carried a stored `app_error_log_count <= 0` bar over
 *     `utility role override unreachable`, a class that emits BY DESIGN (its
 *     own message says the built-in chain serves the call). Its context had NO
 *     `acceptanceMetricSource` — so the guard failed CLOSED, the bar was
 *     measured, one residual row (the fix's own 15 s leg cap working) counted,
 *     and the post-deploy verifier REOPENED a correct, deployed fix at
 *     13:32:39Z on measured 1, dispatching a fresh lane onto a non-defect.
 *   - It also made the check depend on WHO stamped the bar rather than on what
 *     the bar can measure — so every pre-marker stamp inherited the same loop.
 *
 * A marker that is PRESENT and is not the auto-filer's is a lane saying "this
 * is my metric, enforce it": that judgement stays the lane's and the bar is
 * never redirected. A MISSING marker says nothing about authorship, so the
 * CONTENT decides. Pure.
 */
function explicitlyHandAuthored(source: unknown): boolean {
  return typeof source === 'string' && source.trim() !== '' && source !== AUTOFILER_DEFAULT_METRIC_SOURCE;
}

/**
 * Does this probe measure the VOLUME of a class that emits by design — a
 * designed ALARM (1425001e) or designed OBSERVABILITY (dc4f7ff5)?
 *
 * The decision is made from the METRIC'S OWN CONTENT (`params.messagePattern`
 * through the same classifiers the sweep uses to stamp it), evaluated at the
 * moment of the ruling — never from stamp-time metadata, which is what
 * TICKET 31199f81 fixed. The one provenance input left is the explicit
 * hand-authored marker above (`explicitlyHandAuthored`): a lane can still
 * insist its own metric be measured, and this guard must never become the
 * escape hatch it was built to close. A markerless bar is NOT treated as
 * hand-authored. Pure.
 */
export function designedAlarmOfMetric(metric: AcceptanceMetric, source: unknown): { id: string; why: string; class: UnsoundMetricClass } | null {
  if (explicitlyHandAuthored(source)) return null;
  if (metric.probe !== 'app_error_log_count') return null;
  const pattern = String(metric.params.messagePattern ?? '');
  if (!pattern) return null;
  // A metric's messagePattern IS the pattern (a short derived fragment); fall back
  // to it as the raw so the culprit test still runs on whatever text we hold.
  const alarm = DESIGNED_ALARM_SIGNATURES.find((s) => s.test(pattern, 'metric', pattern));
  if (alarm) return { ...alarm, class: 'designed-alarm' };
  const obs = DESIGNED_OBSERVABILITY_SIGNATURES.find((s) => s.test(pattern, 'metric', pattern));
  return obs ? { ...obs, class: 'designed-observability' } : null;
}

/**
 * Is this fingerprint a designed alarm (so no volume default may be attached)? Pure.
 *
 * `exampleMessage` is the NEWEST RAW row for the same fingerprint. Pass it
 * whenever it is in hand: the fingerprint is cut at FINGERPRINT_MAX_LEN, and the
 * `ours` recall guard must see the culprit the cut may have removed (see
 * OURS_CULPRIT_RE). Without it the guard falls back to the fingerprint itself —
 * correct for every model id short enough to keep the culprit inside the cut,
 * which is the whole shipped population today.
 */
export function designedAlarmOfFingerprint(fingerprint: unknown, exampleMessage?: unknown): { id: string; why: string } | null {
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  if (!fp) return null;
  const raw = typeof exampleMessage === 'string' && exampleMessage ? exampleMessage : fp;
  return DESIGNED_ALARM_SIGNATURES.find((s) => s.test(fp, 'fingerprint', raw)) ?? null;
}

/**
 * The log-signal sweep's default metric: the fingerprint's stable fragment
 * stays at or below `quietTarget` app_error_logs rows for 24 h after the fix.
 * The target is the sweep's own re-fire threshold minus one (the caller
 * passes it — log-signal-sweep logSignalQuietTarget; review 2026-10-20: a
 * flat 0 reopened fixes that cut a warn from ~40/h to 2/day, below the
 * sweep's alert line), default 0. Narrowed to the signal's level / source
 * when it has exactly one. null when no stable fragment exists. Pure.
 */
export function logSignalDefaultMetric(signal: { fingerprint: string; levels?: readonly string[]; sources?: readonly string[]; quietTarget?: number; exampleMessage?: string | null; avoidFragment?: (candidate: string) => boolean }): AcceptanceMetric | null {
  const fragment = stableLiteralFragment(signal.fingerprint, signal.exampleMessage ?? undefined, signal.avoidFragment);
  if (!fragment) return null;
  const levels = [...new Set((signal.levels ?? []).filter((l) => LEVELS.includes(l)))];
  const sources = [...new Set((signal.sources ?? []).filter((x) => typeof x === 'string' && x.trim() && x.trim().length <= PARAM_MAX).map((x) => x.trim()))];
  const params: Record<string, string> = { messagePattern: fragment };
  if (levels.length === 1) params.level = levels[0];
  if (sources.length === 1) params.source = sources[0];
  // LOGCLASS-SYMMETRY (2026-11-01, tickets 359c3a35 + b4bfd09a): the sweep
  // never even fingerprints a row that isNonFaultLogRow accepts (logClass
  // 'external' / 'handled'), so "the sweep stopped filing this class" and
  // "the class fell below this bar" MUST mean the same thing. They did not:
  // the probe counted every warn row, tag or no tag, so an emit site that was
  // correctly retagged logExternal (09bbd32c, PR #2234) kept tripping its own
  // acceptance bar and the verifier reopened the ticket every window. The
  // default now subtracts the same non-fault class the sweep drops. Untagged
  // and logClass:'fault' rows still count — detection is not weakened.
  params.excludeLogClass = 'external';
  const target = typeof signal.quietTarget === 'number' && Number.isInteger(signal.quietTarget) && signal.quietTarget >= 0 ? signal.quietTarget : 0;
  return { probe: 'app_error_log_count', params, operator: '<=', target, windowHours: DEFAULT_METRIC_WINDOW_HOURS };
}

/**
 * HEAL an auto-filer default metric that was stored BEFORE the logClass
 * symmetry existed (2026-11-01, tickets 359c3a35 + b4bfd09a).
 *
 * Those two tickets carry context.acceptanceMetric written by the old
 * logSignalDefaultMetric: `app_error_log_count <= 2` with level/source/
 * messagePattern and no logClass awareness. The fix landed in code, but the
 * STORED metric is what the post-deploy verifier re-measures — so without a
 * heal the corrected probe never runs on the very tickets that motivated it,
 * and both reopen forever on rows their own root cause adjudicated external.
 *
 * Scope is deliberately narrow: only a metric stamped
 * acceptanceMetricSource:'autofiler-default' is healed (a hand-authored metric
 * is its lane's judgement, never rewritten), only the app_error_log_count
 * probe, and only when it does not already carry a filter. Pass the SIGNAL's
 * measured classes via `signalLevels`/`signalSources` is NOT required — the
 * heal adds the exclusion alone. Pure; the caller stamps the audit trail.
 */
export function healAutofilerDefaultMetric(metric: AcceptanceMetric, source: unknown): { metric: AcceptanceMetric; healed: boolean } {
  if (source !== AUTOFILER_DEFAULT_METRIC_SOURCE) return { metric, healed: false };
  if (metric.probe !== 'app_error_log_count') return { metric, healed: false };
  if (metric.params.excludeLogClass) return { metric, healed: false };
  return { metric: { ...metric, params: { ...metric.params, excludeLogClass: 'external' } }, healed: true };
}

/**
 * HEAL an auto-filer default metric whose pattern was derived BEFORE the emitter
 * scope existed (ticket d634e874, 2026-11-07) — the SECOND such read-time heal,
 * and the same posture as `healAutofilerDefaultMetric` above.
 *
 * THE PROBLEM IT REPAIRS. The stored metric is what the post-deploy verifier
 * re-measures, so fixing the derivation in code does nothing for a ticket filed
 * under the old one. d634e874 stores
 * `messagePattern: 'flash (llm-cql (custom endpoint)) failed — timeout of'` —
 * a pattern that matches `pdf_ocr`, `vision_describe` AND `computer_vision`
 * rows. Its pdf_ocr fix was deployed and its own class fell to one row, yet the
 * verifier reopened it at 2026-11-07T15:05:49Z on `measured 3`, every one of the
 * three outside the emit class the ticket was filed about.
 *
 * SCOPE IS DELIBERATELY NARROW — all of:
 *   - source is `autofiler-default` (a hand-authored metric is never rewritten);
 *   - probe is `app_error_log_count`;
 *   - the TICKET's own fingerprint names an emitter (`<role> seat: …`);
 *   - an emitter-scoped run of the fingerprint exists;
 *   - the stored pattern does NOT already carry that emitter name.
 * When any of those fails the metric is returned untouched (`healed:false`), so
 * this can never widen or narrow a bar a lane chose for itself. Pure.
 *
 * `fingerprint` is the ticket's own normalized fingerprint, recovered by the
 * caller from the stable title (`log-signal: <fingerprint>`); passing null (an
 * untitled/legacy row) simply skips the heal.
 */
/**
 * The ticket's own log-signal FINGERPRINT, recovered from its stable title
 * (`log-signal: <fingerprint>` — log-signal-sweep.service.ts:915). Returns null
 * for any row that is not a log-signal ticket, so a caller can pass any title.
 */
export function fingerprintOfLogSignalTitle(title: unknown): string | null {
  const t = typeof title === 'string' ? title : '';
  const m = /^log-signal:\s*(.+)$/i.exec(t.trim());
  const fp = m ? m[1].trim() : '';
  return fp || null;
}

export function healEmitterScopedPattern(metric: AcceptanceMetric, source: unknown, fingerprint: unknown): { metric: AcceptanceMetric; healed: boolean; role?: string } {
  if (source !== AUTOFILER_DEFAULT_METRIC_SOURCE) return { metric, healed: false };
  if (metric.probe !== 'app_error_log_count') return { metric, healed: false };
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  if (!fp) return { metric, healed: false };
  const stored = String(metric.params?.messagePattern ?? '');
  const m = EMITTER_ROLE_PREFIX_RE.exec(fp);
  if (!m) return { metric, healed: false };
  const role = m[1];
  if (stored.toLowerCase().startsWith(`${role} seat:`)) return { metric, healed: false }; // already scoped
  const pieces = fp
    .split(/<[a-z_-]+>|\[REDACTED[^\]]*\]|…/i)
    .map((x) => x.replace(/^[\s:;,.\-—–'"`]+|[\s:;,\-—–'"`]+$/g, ''))
    .filter((x) => x.length >= LOG_FRAGMENT_MIN && !regexIntentOf(x));
  const scoped = emitterScopedRun(fp, pieces);
  if (!scoped.run) return { metric, healed: false };
  return { metric: { ...metric, params: { ...metric.params, messagePattern: scoped.run } }, healed: true, role };
}

/**
 * The framework-signal-sweep's default metric for an INSTANCE-KEYED finding
 * class (raw-marker:<MARKER>): its per-finding telemetry rows
 * (framework_signal_finding, meta.fingerprint) stay at 0 for 24 h after the
 * fix. Detector-wide classes (incomplete-card / missed-bug fingerprint one
 * owner question / message — they never recur) get no default: their
 * instances are distinct subjects. Pure.
 */
export function frameworkFindingDefaultMetric(fingerprint: unknown): AcceptanceMetric | null {
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  if (!/^raw-marker:[A-Za-z_]{1,80}$/.test(fp)) return null;
  return {
    probe: 'loop_metric_count',
    params: { kind: LOOP_METRIC_KINDS.FRAMEWORK_SIGNAL_FINDING, metaKey: 'fingerprint', metaValue: fp },
    operator: '<=',
    target: 0,
    windowHours: DEFAULT_METRIC_WINDOW_HOURS,
  };
}
