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
export function stableLiteralFragment(fingerprint: unknown, exampleMessage?: unknown): string | null {
  const fp = typeof fingerprint === 'string' ? fingerprint : '';
  const trimEdges = (x: string) => x.replace(/^[\s:;,.\-—–'"`]+|[\s:;,\-—–'"`]+$/g, '');
  const pieces = fp
    .split(/<[a-z_-]+>|\[REDACTED[^\]]*\]|…/i)
    .map(trimEdges)
    .filter((x) => x.length >= LOG_FRAGMENT_MIN && !regexIntentOf(x));
  if (!pieces.length) return null;
  const best = [...pieces].sort((a, b) => b.length - a.length)[0].slice(0, LOG_FRAGMENT_MAX).trim();
  const raw = typeof exampleMessage === 'string' ? exampleMessage : '';
  // No raw example (direct callers / older shapes): the fingerprint fragment,
  // as before — the filing-time baseline gate still measures every stored
  // metric against the real rows and drops a vacuous one.
  if (!raw || raw.toLowerCase().includes(best.toLowerCase())) return best;
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
  const chosen = stable ?? rawBest;
  const out = chosen.slice(0, LOG_FRAGMENT_MAX).trim();
  return out.length >= LOG_FRAGMENT_MIN ? out : null;
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

/** Does this probe measure the VOLUME of a designed alarm? Only an auto-filer default can be unsound this way — a hand-authored metric is its lane's judgement. Pure. */
export function designedAlarmOfMetric(metric: AcceptanceMetric, source: unknown): { id: string; why: string } | null {
  if (source !== AUTOFILER_DEFAULT_METRIC_SOURCE) return null;
  if (metric.probe !== 'app_error_log_count') return null;
  const pattern = String(metric.params.messagePattern ?? '');
  if (!pattern) return null;
  // A metric's messagePattern IS the pattern (a short derived fragment); fall back
  // to it as the raw so the culprit test still runs on whatever text we hold.
  return DESIGNED_ALARM_SIGNATURES.find((s) => s.test(pattern, 'metric', pattern)) ?? null;
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
export function logSignalDefaultMetric(signal: { fingerprint: string; levels?: readonly string[]; sources?: readonly string[]; quietTarget?: number; exampleMessage?: string | null }): AcceptanceMetric | null {
  const fragment = stableLiteralFragment(signal.fingerprint, signal.exampleMessage ?? undefined);
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
