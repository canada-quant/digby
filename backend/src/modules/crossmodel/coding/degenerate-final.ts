/**
 * Degenerate-final detector (feedback ticket e8f71984, 2026-09-29).
 *
 * A coding run on a custom LiteLLM seat finalized thousands of chars of
 * multilingual garbage tokens (mixed Cyrillic/Chinese/English glugs like
 * `top0 ФедT76583057fe3📝Since File0Heading EDFull9 ipcpricingwork64_rhoенты…`)
 * as its persisted transcript final, with NO detection, quarantine, or
 * "output degraded" marker. A harness continuation recovered cleanly, so the
 * impact was self-healing — but the platform had (and has) no guard rail that
 * the corruption was even NOTICED.
 *
 * This module is that rail, at the run-finalize seam (run-executor.ts, before
 * the final assistant row is persisted). It is:
 *
 *   - SYNCHRONOUS and CHEAP — pure text statistics, zero LLM calls.
 *   - STRICTLY observe-and-mark — it stamps a metadata marker
 *     (`metadata.outputDegenerate`) and records a `degenerate_final` loop
 *     metric. It NEVER replaces, redacts, or retries content: the
 *     false-positive bar is the core risk (ticket constraint 1) and
 *     legitimate Digby answers are ROUTINELY multilingual
 *     (Chinese/Cyrillic/English mixed technical prose). Content is
 *     delivered byte-identical either way — the marker is downstream-
 *     consumable (quarantine/ignore) but nothing is mutated.
 *     A bounded auto-retry was deliberately NOT implemented — at finalize the
 *     agent loop has exited, so a "retry" means re-running the whole turn,
 *     which is invasive and loop-prone; detect-and-mark is the safe v1.
 *
 * ── Detection: a CONJUNCTION of four independent signals, ALL required ──────
 *
 * Extreme-degenerate output is not "multilingual" — it is the simultaneous
 * collapse of every statistical signature of natural text. Each signal below
 * is individually common in legitimate answers; only their conjunction is
 * diagnostic, which is what makes the false-positive bar hold.
 *
 *   S1 script-mix chaos (text level) — ≥3 distinct letter-script families
 *      each carrying ≥3% of the text's letters (and ≥20 chars). A legit
 *      Chinese-technical answer has 2 (Han + Latin), a Russian answer 1-2.
 *      Han + Kana are grouped as ONE family (Japanese), Hangul separate.
 *   S2 token-glue collapse — ≥35% of tokens glue what should never be glued:
 *      two letter-script families inside ONE word (`ipcpricingwork64_rhoенты`),
 *      or a long alpha↔digit glug (≥2 letter/digit transitions, ≥8 chars, no
 *      separators — `F76583057fe3`, `File0Heading`). Version tokens
 *      (`glm-5.3`, `v0.5.0`, `sha256`, `utf-8`) have ≤1 transition and never
 *      trip this.
 *   S3 sentence-structure absence — <0.2 sentence terminators or paragraph
 *      breaks per 100 chars. Real prose (any script) runs ~1-6 per 100
 *      (。！？ .!? … plus newlines); garbage runs ~0.
 *   S4 coherent-word collapse — <30% of tokens are plain words (single
 *      letter-script family, letters only, ≥2 chars, after stripping thin
 *      surrounding punctuation — `使用。` and `(Done)` are words).
 *
 * Before scoring, fenced code blocks, inline `code` spans, and URLs are
 * stripped: code is legitimately dense token salad, and a code-heavy legit
 * answer must score on its PROSE remainder only. Texts under 400 chars are
 * never flagged — short garbage is harmless and the false-positive bar
 * dominates at small n. The detector never throws (fail-open: not
 * degenerate) — a guard rail must not be able to kill a run's finalize.
 */

/** Ticket id prefix, cited in metadata/telemetry so sightings trace back. */
export const DEGENERATE_FINAL_TICKET = 'e8f71984';

/**
 * Threshold calibration (ticket e8f71984). These four constants are a
 * CONJUNCTION: all four signals must trip for a verdict of `degenerate`. That
 * conjunction is what keeps legit multilingual prose (zh / ru / en+zh technical
 * answers) clean while flagging provider token-soup. The FP safety is anchored
 * by degenerate-output.e8f71984.test.ts, which asserts the invariant that legit
 * multilingual fixtures score far from every threshold (e.g. terminatorDensity
 * of every legit fixture is > 2× DEGENERATE_MAX_TERMINATORS_PER_100, i.e. an
 * order-of-magnitude margin, while the tiled ticket garbage trips all four).
 * Retune a constant only with a matching fixture change in that suite, else the
 * calibration claim here goes stale.
 */

/** Texts shorter than this (post code/URL strip) are never scored. */
export const DEGENERATE_MIN_CHARS = 400;

/** S2: minimum fraction of glue tokens (script-glued or long alpha-digit glugs). */
export const DEGENERATE_GLUE_RATIO = 0.35;

/** S3: maximum sentence terminators + paragraph breaks per 100 chars. */
export const DEGENERATE_MAX_TERMINATORS_PER_100 = 0.2;

/** S4: maximum fraction of tokens that are plain single-script words. */
export const DEGENERATE_MAX_WORD_RATIO = 0.3;

/** S1: a script family counts toward "chaos" at ≥3% of letter chars… */
export const DEGENERATE_FAMILY_SHARE = 0.03;
/** …and at least this many characters (tiny traces never count). */
export const DEGENERATE_FAMILY_MIN_CHARS = 20;
/** S1: how many families at that share constitute chaos. */
export const DEGENERATE_FAMILY_CHAOS_COUNT = 3;

export interface DegenerateFinalScore {
  /** letters analyzed (after code/URL strip) */
  chars: number;
  /** letter-script families at ≥ share threshold, with their letter counts */
  families: Record<string, number>;
  familyChaos: boolean;
  glueRatio: number;
  terminatorDensity: number;
  wordRatio: number;
}

export interface DegenerateFinalVerdict {
  degenerate: boolean;
  /** present when the text was long enough to score */
  score?: DegenerateFinalScore;
}

/* ── Script classification ───────────────────────────────────────────────────
 * Per-CODEPOINT classification via Unicode property escapes (ES2022 target).
 * Families: latin | cyrillic | greek | cjk (Han+Hiragana+Katakana — Japanese
 * mixes them BY DESIGN) | hangul | arabic | hebrew | devanagari | thai |
 * other (any other letter). Digits, punctuation, emoji, symbols: no family.
 */
const SCRIPT_TESTS: Array<[string, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['cjk', /\p{Script=Han}/u],
  ['cjk', /\p{Script=Hiragana}/u],
  ['cjk', /\p{Script=Katakana}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
];

function scriptFamily(ch: string): string | null {
  for (const [family, re] of SCRIPT_TESTS) if (re.test(ch)) return family;
  return /\p{L}/u.test(ch) ? 'other' : null;
}

/* ── Cleaning ──────────────────────────────────────────────────────────────── */

/** Harness chrome footer (run-executor.ts unfinished-plan note). Not model
 *  output — appended by the harness at finalize — so it is dropped before
 *  scoring (same convention as thread-grounding's chrome drop). */
const HARNESS_NOTE_FOOTER = /\n*\s*⏳ HARNESS NOTE:[^]*$/;

/** Drop harness-appended chrome footers so they cannot dilute the score of
 *  the model's own (possibly degenerate) text. */
export function stripHarnessChrome(text: string): string {
  return text.replace(HARNESS_NOTE_FOOTER, '');
}

export function stripCodeAndUrls(text: string): string {
  return stripHarnessChrome(text)
    // fenced code blocks (``` or ~~~, multiline)
    .replace(/(```|~~~)[^]*?\1/g, ' ')
    // inline code spans
    .replace(/`[^`\n]*`/g, ' ')
    // URLs (www. / http(s):// — bare domains left alone, they read as tokens)
    .replace(/(https?:\/\/|www\.)\S+/g, ' ');
}

/* ── Token analysis ────────────────────────────────────────────────────────── */

const URL_TOKEN = /^(https?:\/\/|www\.)/i;
/** leading/trailing punctuation, emoji, symbols and digits shaved off a token */
const THIN_EDGE = /^[\p{P}\p{S}\p{C}\s]+|[\p{P}\p{S}\p{C}\s]+$/gu;

interface TokenStats {
  tokens: number;
  glue: number;
  words: number;
  letters: number;
  families: Record<string, number>;
}

function analyzeTokens(cleaned: string): TokenStats {
  const stats: TokenStats = { tokens: 0, glue: 0, words: 0, letters: 0, families: {} };
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    if (URL_TOKEN.test(raw)) continue; // belt & braces post-strip
    const token = raw.replace(THIN_EDGE, '');
    if (!token) continue;
    stats.tokens += 1;

    // letter families inside this ONE token
    const fams = new Set<string>();
    for (const ch of token) {
      const fam = scriptFamily(ch);
      if (fam) {
        fams.add(fam);
        stats.letters += 1;
        stats.families[fam] = (stats.families[fam] ?? 0) + 1;
      }
    }

    const hasLetters = fams.size > 0;
    const isAllLetters = hasLetters && /^[\p{L}]+$/u.test(token);

    // S2a script-glue: two letter-script families inside one word
    // (`ipcpricingwork64_rhoенты`-class). Never legitimate.
    if (fams.size >= 2) {
      stats.glue += 1;
      continue;
    }
    // S4 word: letters-only, single family (cjk group already folded), ≥2 chars
    // (`使用`, `配置`, `Done`, `модель`). Single CJK chars are words too in
    // headlines/lists, so ≥2 chars applies to non-cjk only… keep it simple:
    // any all-letters token of ≥2 chars counts.
    if (isAllLetters && token.length >= 2) {
      stats.words += 1;
      continue;
    }
    // S2b digit-glug: long glued alpha↔digit with ≥2 transitions and NO
    // separators (`F76583057fe3`, `File0Heading`). Version-ish tokens
    // (`glm-5.3`, `sha256`, `utf-8`, `top0`) have ≤1 transition or a
    // separator and land here harmlessly as "other".
    if (
      hasLetters &&
      token.length >= 8 &&
      !/[\-._/@:]/.test(token) &&
      (token.match(/(?:\p{L}+\d+|\d+\p{L}+)/gu) ?? []).length >= 2
    ) {
      stats.glue += 1;
    }
    // everything else (pure numbers, ids, punctuation shards) is inert "other"
  }
  return stats;
}

/* ── Sentence structure ────────────────────────────────────────────────────── */

function terminatorDensity(cleaned: string): number {
  // terminators: . 。 ! ？ ? ！ … at token/line end …
  const terminators = (cleaned.match(/[.。!?！?…](?=\s|$)/gu) ?? []).length;
  // …plus paragraph breaks (blank-line) and any newline as soft structure
  const breaks = (cleaned.match(/\n/gu) ?? []).length;
  const per100 = ((terminators + breaks) * 100) / Math.max(1, cleaned.length);
  return per100;
}

/* ── The detector ──────────────────────────────────────────────────────────── */

export function detectDegenerateFinal(text: string): DegenerateFinalVerdict {
  try {
    if (!text || typeof text !== 'string') return { degenerate: false };
    const cleaned = stripCodeAndUrls(text);
    if (cleaned.trim().length < DEGENERATE_MIN_CHARS) return { degenerate: false };

    const stats = analyzeTokens(cleaned);
    if (stats.tokens === 0 || stats.letters === 0) return { degenerate: false };

    // S1 — script-mix chaos at text level
    const significant = Object.fromEntries(
      Object.entries(stats.families).filter(
        ([, n]) =>
          n >= DEGENERATE_FAMILY_MIN_CHARS && n / stats.letters >= DEGENERATE_FAMILY_SHARE,
      ),
    );
    const familyChaos =
      Object.keys(significant).length >= DEGENERATE_FAMILY_CHAOS_COUNT;

    // S2 — glue collapse
    const glueRatio = stats.glue / stats.tokens;
    // S3 — no sentence structure
    const density = terminatorDensity(cleaned);
    // S4 — word collapse
    const wordRatio = stats.words / stats.tokens;

    const score: DegenerateFinalScore = {
      chars: cleaned.trim().length,
      families: significant,
      familyChaos,
      glueRatio: Number(glueRatio.toFixed(4)),
      terminatorDensity: Number(density.toFixed(4)),
      wordRatio: Number(wordRatio.toFixed(4)),
    };
    return {
      degenerate:
        familyChaos &&
        glueRatio >= DEGENERATE_GLUE_RATIO &&
        density <= DEGENERATE_MAX_TERMINATORS_PER_100 &&
        wordRatio <= DEGENERATE_MAX_WORD_RATIO,
      score,
    };
  } catch {
    // fail-open, always: a telemetry/marker rail must never break finalize
    return { degenerate: false };
  }
}
