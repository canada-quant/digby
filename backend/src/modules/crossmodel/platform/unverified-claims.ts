/**
 * BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20) — the action claims the integrity
 * check could not verify on a SUPERVISOR machine wake, footnoted on the note and kept out of (or
 * marked in) the owner briefing.
 *
 * WHY: the owner steers by the briefing. Since the 2026-09-11 gate flip an ACTION-class conviction of
 * the pre-delivery action verifier is observe-only — the note is delivered UNMODIFIED, with no
 * annotation (only citation-class strikes get the W1-4 observe-only annotation) — and the briefing
 * gate (`!actionGuardStruck`) passes such a note straight to generateOwnerBriefing, which rewrites
 * the convicted "dispatched X" line into the owner's update as fact. The unbacked-claim machine leg
 * (`supervisor_unbacked_claim_machine`, 73 rows in 7 d; adjudicated true positives on 590d604e and
 * 99e63f86) flags the same shape on zero-tool wakes and changes nothing either.
 *
 * WHAT (pure helpers; the wiring is chat-agent.service.ts finalize + fleet/owner-briefing.service.ts):
 *   1. `collectUnverifiedClaims` — the ANNOTATABLE claims of a wake: the verifier's action-class
 *      convictions (kind dispatch / message / schedule / ticket, untagged LLM-lane details) and, on a
 *      run that made NO tool call, every send-class claim of the unbacked-claim lane (convicted by
 *      construction: nothing can have been sent). A verifier claim whose sentence cites EVIDENCE OF
 *      THE ACT — an id resolving to an executed action receipt of this chat or a message this chat
 *      sent — is exonerated and never annotated; the TARGET a claim names (the lane chat, the goal,
 *      the todo) existing is never evidence (review fix 2026-10-20: "I messaged lane <real id>" with
 *      no tool call used to be exonerated by the lane's own existence). Zero-tool claims are never
 *      id-probed (the unbacked lane already dropped sentences citing a real receipt of this chat). A
 *      claim that cannot be located in the delivered note is dropped (never a footnote about text that is gone).
 *   2. `renderUnverifiedClaimsFootnote` — ONE paragraph under the W1-4 annotation header at the note's
 *      tail, in front of the harness appendix (`placeUnverifiedFootnote`), so guard-chrome-redact strips it and
 *      every trailer before it from later wakes' context. Never a block, never an edit.
 *   3. `planUnverifiedBriefing` — the briefing's view of the note: the claim segments MARKED
 *      "(unverified)" (deterministic path) and DROPPED (the LLM rewrite path, which could otherwise
 *      restate them as fact). `extractAnnotationClaims` reads the claims back out of any embedded
 *      annotation paragraph, so the dashboard's bootstrap briefing (fleet.service — it only holds
 *      the stored note) filters the same lines.
 *
 * Kill switches: ACTION_CLASS_ANNOTATE_DISABLED=1 (no footnote), BRIEFING_UNVERIFIED_FILTER_DISABLED=1
 * (the briefing reads the note exactly as before). Fail toward delivery everywhere: an error, an
 * unlocatable claim or an id lookup failure means NOT annotating — content is never removed from the
 * delivered note.
 */

/** The W1-4 observe-only annotation header (mirrors action-verifier ACTION_GUARD_ANNOTATION_HEADER — a
 *  test pins the two; guard-chrome-redact's TRAILING_NOTE_HEADERS lists it). Duplicated so this leaf
 *  never pulls the action-verifier module graph into the briefing's importers. */
export const UNVERIFIED_FOOTNOTE_HEADER = '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]';
/** The inline marker the briefing's deterministic rendering carries after an unverified claim. */
export const UNVERIFIED_MARKER = '(unverified)';
/** The footnote's briefing sentence — conditional on the note, never a promise that a briefing runs. */
export const UNVERIFIED_BRIEFING_SENTENCE = 'An owner briefing written from this note marks them as unverified or leaves them out.';
/** Claim lines the footnote lists (the count line always states the full number). */
export const MAX_FOOTNOTE_CLAIMS = 6;
/** Claims collected per wake (bounds the id probes and the briefing's segment work). */
const MAX_COLLECTED_CLAIMS = 8;
/** Distinct ids probed per wake; past the cap an id counts as existing (fail toward NOT annotating). */
const MAX_ID_PROBES = 8;
const MAX_QUOTE_CHARS = 180;

/** Kill switch for the action-class footnote on supervisor machine wakes. */
export function actionClassAnnotateDisabled(): boolean {
  return process.env.ACTION_CLASS_ANNOTATE_DISABLED === '1';
}

/** Kill switch for the owner briefing's unverified-claim filter (mark / drop). */
export function briefingUnverifiedFilterDisabled(): boolean {
  return process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED === '1';
}

export type UnverifiedClaimSource = 'action_verifier' | 'zero_tool_dispatch' | 'annotation';
export interface UnverifiedClaim {
  /** The claim kind (dispatch / message / schedule / ticket, or the annotation line's label). */
  kind: string;
  /** The claim text as it reads in the note (verbatim or near-verbatim). */
  quote: string;
  source: UnverifiedClaimSource;
}

/** Structural view of an action-verifier ExtractedClaim (no import of that module). */
export interface VerifierClaimLike {
  kind?: unknown;
  detail?: unknown;
  id?: unknown;
  fabricatedId?: unknown;
  miscopiedFrom?: unknown;
}

/** Structural view of an unbacked-claim.ts UnbackedActionClaim. */
export interface UnbackedClaimLike {
  cls?: unknown;
  start?: unknown;
  end?: unknown;
}

/** The action-claim vocabulary of the verifier's LLM lane (action-verifier ClaimKind). */
const ACTION_KINDS = new Set(['dispatch', 'message', 'schedule', 'ticket']);

/**
 * True for a verifier conviction this lane annotates: an ACTION-class claim (citation-class ones —
 * fabricated / miscopied ids, the tagged evidence lanes — are already enforced and annotated by the
 * W1-4 path), from the LLM lane (untagged detail: the tagged deterministic miners carry ids, the
 * board lanes are about counts / statuses, args-surface claims are not in the note), carrying NO
 * cited id (an action-class conviction with an id is the mis-typed-but-REAL class — its id resolves
 * to an artifact, the 2026-09-11 false-positive history — so it is id-exonerated). Pure.
 */
export function annotatableVerifierClaim(p: VerifierClaimLike | null | undefined): boolean {
  if (!p || typeof p !== 'object') return false;
  if (!ACTION_KINDS.has(String(p.kind ?? ''))) return false;
  if (p.fabricatedId === true || (p.miscopiedFrom !== undefined && p.miscopiedFrom !== null)) return false;
  const detail = String(p.detail ?? '').trim();
  if (!detail || detail.startsWith('[')) return false;
  if (String(p.id ?? '').trim()) return false;
  return true;
}

/** True when the run made no tool call at all (the zero-tool construction). Pure. */
export function runMadeNoToolCall(parts: Array<{ type?: unknown }> | null | undefined): boolean {
  return !(parts ?? []).some((p) => p?.type === 'tool_call');
}

/**
 * The SEND-class claims of the unbacked-claim lane as quotes of `text` (the sentence span each claim
 * replaces). On a zero-tool run every one is convicted by construction. Pure.
 */
export function zeroToolDispatchQuotes(text: string, claims: UnbackedClaimLike[] | null | undefined): Array<{ quote: string }> {
  const t = String(text ?? '');
  const out: Array<{ quote: string }> = [];
  for (const c of claims ?? []) {
    if (!c || c.cls !== 'send') continue;
    const start = Number(c.start);
    const end = Number(c.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > t.length) continue;
    const quote = t.slice(start, end).trim();
    if (quote) out.push({ quote });
  }
  return out;
}

// ── tokens + segments ──────────────────────────────────────────────────────

/** The grounding stopwords of action-verifier groundExtractedClaims (same coverage rule below). */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you',
  'has', 'have', 'had', 'was', 'were', 'are', 'its', 'it', 'to', 'of', 'a',
  'an', 'in', 'on', 'at', 'is', 'be', 'been', 'by', 'as', 'or', 'not', 'no',
  'my', 'me', 'i', 'our', 'we', 'their', 'they', 'them', 'his', 'her', 'she',
  'he', 'so', 'if', 'then', 'than', 'but', 'also', 'just', 'now', 'all',
]);

/** Lower-case, alphanumerics only, single-spaced. Pure; exported for tests. */
export function normalizeClaimText(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const isContentToken = (t: string): boolean =>
  t.length >= 3
  && !STOPWORDS.has(t)
  && !/^\d+$/.test(t)
  && !/^[0-9a-f]{7,}$/.test(t)
  && !(/^[0-9a-f]+$/.test(t) && /\d/.test(t));

function contentTokens(s: string): string[] {
  return [...new Set(normalizeClaimText(s).split(' ').filter(isContentToken))];
}

/** A located claim: absolute [start, end) offsets into the searched text (whitespace-trimmed). */
export interface ClaimSegment { start: number; end: number }

/** Clause separators: sentence ends, arrows, semicolons, spaced dashes, table pipes. */
const CLAUSE_SEP_SRC = String.raw`(?<=[.!?])\s+|\s*(?:→|->)\s*|\s*;\s*|\s+[—–]\s+|\s*\|\s*`;
const SENTENCE_SEP_SRC = String.raw`(?<=[.!?])\s+`;

function lineRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let inFence = false;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const line = text.slice(start, i);
      if (/^\s*```/.test(line)) inFence = !inFence;
      else if (!inFence && !/^\s*>/.test(line) && /[a-z0-9]/i.test(line)) out.push([start, i]);
      start = i + 1;
    }
  }
  return out;
}

function splitLine(text: string, lineStart: number, lineEnd: number, sepSrc: string | null): ClaimSegment[] {
  const line = text.slice(lineStart, lineEnd);
  const raw: Array<[number, number]> = [];
  if (sepSrc === null) raw.push([0, line.length]);
  else {
    let cursor = 0;
    for (const m of line.matchAll(new RegExp(sepSrc, 'g'))) {
      const at = m.index ?? 0;
      if (m[0].length === 0) continue;
      raw.push([cursor, at]);
      cursor = at + m[0].length;
    }
    raw.push([cursor, line.length]);
  }
  const out: ClaimSegment[] = [];
  for (let [s, e] of raw) {
    while (s < e && /\s/.test(line[s])) s += 1;
    while (e > s && /\s/.test(line[e - 1])) e -= 1;
    if (e > s && /[a-z0-9]/i.test(line.slice(s, e))) out.push({ start: lineStart + s, end: lineStart + e });
  }
  return out;
}

/**
 * Where a claim sits in `text`: the TIGHTEST segment (clause → sentence → line) that holds the claim —
 * its normalized text verbatim, else the action-verifier grounding rule (all content tokens of a ≤4-token
 * claim, 80% of a longer one). Blockquotes and fenced code never match (a quoted claim is not this
 * note's claim). Null when nothing holds it — the caller then never annotates or filters it. Pure.
 */
export function locateClaimSegment(text: string, quote: string): ClaimSegment | null {
  const t = String(text ?? '');
  const qNorm = normalizeClaimText(quote);
  const qTokens = contentTokens(quote);
  if (!t.trim() || !qNorm || qTokens.length === 0) return null;
  const required = qTokens.length <= 4 ? qTokens.length : Math.ceil(qTokens.length * 0.8);
  const lines = lineRanges(t);
  for (const sep of [CLAUSE_SEP_SRC, SENTENCE_SEP_SRC, null]) {
    const segs = lines.flatMap(([s, e]) => splitLine(t, s, e, sep));
    for (const seg of segs) {
      if (normalizeClaimText(t.slice(seg.start, seg.end)).includes(qNorm)) return seg;
    }
    for (const seg of segs) {
      const have = new Set(normalizeClaimText(t.slice(seg.start, seg.end)).split(' '));
      if (qTokens.filter((tok) => have.has(tok)).length >= required) return seg;
    }
  }
  return null;
}

const overlaps = (a: ClaimSegment, b: ClaimSegment): boolean => a.start < b.end && b.start < a.end;

/** Distinct, non-overlapping segments, document order (the first of an overlapping pair wins). */
function disjointSegments(segs: ClaimSegment[]): ClaimSegment[] {
  const out: ClaimSegment[] = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (out.some((o) => overlaps(o, s))) continue;
    out.push(s);
  }
  return out;
}

/**
 * Insert " (unverified)" at the end of each segment, before its closing punctuation ("dispatched the
 * rerun." → "dispatched the rerun (unverified)."). Idempotent (a segment already carrying the marker is
 * left alone). Pure.
 */
export function markClaimSegments(text: string, segs: ClaimSegment[]): string {
  let out = String(text ?? '');
  for (const seg of disjointSegments(segs).sort((a, b) => b.start - a.start)) {
    if (out.slice(seg.start, seg.end).includes(UNVERIFIED_MARKER)) continue;
    let at = seg.end;
    while (at > seg.start && /[.!?;:,*_]/.test(out[at - 1])) at -= 1;
    if (at === seg.start) at = seg.end;
    const lead = at > 0 && /\s/.test(out[at - 1]) ? '' : ' ';
    out = `${out.slice(0, at)}${lead}${UNVERIFIED_MARKER}${out.slice(at)}`;
  }
  return out;
}

const SEP_RUN_RE = /\s*(→|->|;|—|–)(?:\s*(?:→|->|;|—|–))+\s*/g;
const LEAD_MARKUP_RE = /^\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)?/;

/**
 * Remove each segment from the text (the LLM rewrite path never sees the claim), then tidy the touched
 * lines: doubled separators collapse, a dangling separator goes, and a line left with no content beyond
 * its bullet / bold label goes entirely. Pure.
 */
export function dropClaimSegments(text: string, segs: ClaimSegment[]): string {
  const orig = String(text ?? '');
  let out = orig;
  // Segments never span a newline, so a line's INDEX survives every removal (its offset does not).
  const touched = new Set<number>();
  for (const seg of disjointSegments(segs).sort((a, b) => b.start - a.start)) {
    touched.add((orig.slice(0, seg.start).match(/\n/g) ?? []).length);
    out = `${out.slice(0, seg.start)}${out.slice(seg.end)}`;
  }
  const kept: string[] = [];
  for (const [idx, line] of out.split('\n').entries()) {
    if (!touched.has(idx)) { kept.push(line); continue; }
    const tidy = line
      .replace(SEP_RUN_RE, ' $1 ')
      .replace(/[\s→;—–:,|-]+$/, '')
      .replace(/(\*\*[^*\n]{1,80}\*\*)\s*(?:→|->|;|—|–|:)\s*$/, '$1')
      .replace(/[ \t]{2,}/g, ' ');
    const rest = tidy.replace(LEAD_MARKUP_RE, '').replace(/\*\*[^*\n]{1,80}\*\*/, '').replace(/[^a-z0-9]+/gi, '');
    if (!rest) continue;
    kept.push(tidy);
  }
  return kept.join('\n');
}

// ── the embedded annotation ────────────────────────────────────────────────

const ANNOTATION_CLAIM_LINE_RE = /^\s*-\s*\[([a-z_]+(?: [a-z_]+)*)\]\s*"(.*)"/i;

/**
 * The note text a verifier conviction's detail quotes: the lane tag of a deterministic conviction
 * ("[evidence citation] …") and a board conviction's "— asserted …; the ledger says …" tail are the
 * verifier's words, not the note's. Pure.
 */
export function claimQuoteFromDetail(detail: string): string {
  return String(detail ?? '')
    .replace(/^\[[^\]\n]{1,40}\]\s*/, '')
    .replace(/\s+—\s+asserted\b[\s\S]*$/, '')
    .trim();
}

/** One annotation claim line (`- [kind] "quote"…`, the claimDetailLines shape) → claim, else null. Pure. */
export function parseAnnotationClaimLine(line: string): UnverifiedClaim | null {
  const m = ANNOTATION_CLAIM_LINE_RE.exec(String(line ?? ''));
  if (!m) return null;
  const quote = claimQuoteFromDetail(m[2]);
  return normalizeClaimText(quote) ? { kind: m[1].toLowerCase(), quote, source: 'annotation' } : null;
}

/**
 * Strip every observe-only annotation paragraph (header line through the next blank line) from `text`
 * and return the claims its lines name. The note the model wrote is what is left. Pure.
 */
export function extractAnnotationClaims(text: string): { text: string; claims: UnverifiedClaim[] } {
  const lines = String(text ?? '').split('\n');
  const kept: string[] = [];
  const claims: UnverifiedClaim[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === UNVERIFIED_FOOTNOTE_HEADER) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        const c = parseAnnotationClaimLine(lines[j]);
        if (c) claims.push(c);
        j += 1;
      }
      while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
      i = j;
      continue;
    }
    kept.push(lines[i]);
    i += 1;
  }
  return { text: kept.join('\n').replace(/\s+$/, ''), claims };
}

// ── collection + the footnote ──────────────────────────────────────────────

/** Hex tokens that could be an id: 7–40 hex chars, optionally followed by uuid dash groups; must hold a digit. */
const ID_TOKEN_RE = /\b(?=[0-9a-f-]*\d)[0-9a-f]{7,40}(?:-[0-9a-f]{1,12}){0,4}\b/gi;
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PREFIX_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,3}$/;

/** One id reference a claim's text cites: a full uuid (exact lookup) or an 8-hex / dashed uuid prefix. */
export interface ClaimIdRef {
  /** Lower-case: the full uuid when `exact`, else the prefix as written (8 hex, or 8 hex + whole dash groups). */
  id: string;
  exact: boolean;
}

/**
 * The id references in `s` that could name a receipt or a message (both are uuids): a full uuid → an exact
 * lookup (the PK, never a prefix scan); an 8-hex token or a dashed uuid prefix → a prefix. A dashless hex run
 * longer than 8 (a commit sha, a digest) or a 7-hex token can name neither and is skipped — it would only
 * cost a prefix probe and could exonerate on a collision. De-duplicated, document order. Pure.
 */
export function claimIdRefs(s: string): ClaimIdRef[] {
  const out: ClaimIdRef[] = [];
  const seen = new Set<string>();
  for (const raw of String(s ?? '').match(ID_TOKEN_RE) ?? []) {
    const tok = raw.toLowerCase();
    let ref: ClaimIdRef | null = null;
    if (FULL_UUID_RE.test(tok)) ref = { id: tok, exact: true };
    else if (UUID_PREFIX_RE.test(tok)) ref = { id: tok, exact: false };
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

/** Total time budget for one wake's evidence probes; past it every further id counts as evidence (fail toward NOT annotating). */
export const EVIDENCE_PROBE_BUDGET_MS = 1500;

export interface CollectUnverifiedInput {
  /** The delivered note (any embedded annotation paragraphs are ignored when locating). */
  text: string;
  /** The verifier's action-class convictions this wake delivered unmodified. */
  verifierClaims?: VerifierClaimLike[];
  /**
   * Send-class claim quotes of a ZERO-TOOL run (zeroToolDispatchQuotes) — the caller passes [] when the run
   * made a tool call. Convicted by construction and NEVER id-probed: the unbacked-claim lane that found them
   * (residualUnbackedClaims → filterHonestReferences) already dropped every sentence citing a real receipt of
   * this chat, and the TARGET a dispatch names (the lane chat, the todo, the goal) existing proves nothing was sent.
   */
  zeroToolClaims?: Array<{ quote: string }>;
  /** Quotes an annotation already on the note names (the citation path's W1-4 annotation) — never listed twice. */
  alreadyAnnotated?: string[];
  /**
   * ACT-EVIDENCE probe for the verifier's claims: true only when the id resolves to evidence that an action
   * HAPPENED — an executed (ok) ACTION receipt of THIS chat, or a message THIS chat sent. Never "the id exists
   * anywhere": the lane / goal / todo / schedule a claim merely TARGETS always exists and would exonerate every
   * phantom dispatch. Absent, throwing, over the probe cap or past the time budget ⇒ the id counts as evidence
   * (fail toward NOT annotating).
   */
  actEvidence?: (ref: ClaimIdRef) => Promise<boolean>;
  /** Override for EVIDENCE_PROBE_BUDGET_MS (tests). */
  probeBudgetMs?: number;
}

/**
 * The claims to annotate / filter for one wake — located, evidence-exonerated (verifier claims only),
 * de-duplicated, capped. Never throws (a probe error exonerates; any other error returns what was collected so far).
 */
export async function collectUnverifiedClaims(input: CollectUnverifiedInput): Promise<UnverifiedClaim[]> {
  const out: UnverifiedClaim[] = [];
  try {
    const haystack = extractAnnotationClaims(input.text).text;
    if (!haystack.trim()) return out;
    const candidates: UnverifiedClaim[] = [
      ...(input.verifierClaims ?? []).filter(annotatableVerifierClaim).map((p) => ({ kind: String(p.kind), quote: String(p.detail).trim(), source: 'action_verifier' as const })),
      ...(input.zeroToolClaims ?? []).filter((c) => String(c?.quote ?? '').trim()).map((c) => ({ kind: 'dispatch', quote: String(c.quote).trim(), source: 'zero_tool_dispatch' as const })),
    ];
    if (!candidates.length) return out;
    const taken: ClaimSegment[] = (input.alreadyAnnotated ?? [])
      .map((q) => locateClaimSegment(haystack, claimQuoteFromDetail(q)))
      .filter((s): s is ClaimSegment => s !== null);
    const budgetMs = Math.max(0, input.probeBudgetMs ?? EVIDENCE_PROBE_BUDGET_MS);
    const deadline = Date.now() + budgetMs;
    const probed = new Map<string, boolean>();
    const isEvidence = async (ref: ClaimIdRef): Promise<boolean> => {
      if (probed.has(ref.id)) return probed.get(ref.id) as boolean;
      const left = deadline - Date.now();
      if (!input.actEvidence || probed.size >= MAX_ID_PROBES || left <= 0) return true;
      let found = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        found = await Promise.race([
          input.actEvidence(ref),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), left); }),
        ]);
      } catch {
        found = true;
      } finally {
        if (timer) clearTimeout(timer);
      }
      probed.set(ref.id, found);
      return found;
    };
    for (const c of candidates) {
      if (out.length >= MAX_COLLECTED_CLAIMS) break;
      const seg = locateClaimSegment(haystack, c.quote);
      if (!seg || taken.some((s) => overlaps(s, seg))) continue;
      if (c.source === 'action_verifier') {
        let exonerated = false;
        for (const ref of claimIdRefs(`${c.quote}\n${haystack.slice(seg.start, seg.end)}`)) {
          if (await isEvidence(ref)) { exonerated = true; break; }
        }
        if (exonerated) continue;
      }
      taken.push(seg);
      out.push(c);
    }
  } catch {
    // fail toward delivery: whatever was collected stands; nothing is ever removed from the note
  }
  return out;
}

const clipQuote = (q: string): string => {
  const one = String(q ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").replace(/\|/g, '/').trim();
  return one.length > MAX_QUOTE_CHARS ? `${one.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…` : one;
};

/**
 * The trailing observe-only footnote: ONE paragraph (no blank lines) under the W1-4 header, one
 * `- [kind] "quote"` line per claim (the shape extractAnnotationClaims reads back). The briefing sentence
 * appears only when `briefingFiltered` is true — the caller passes the briefing gate's own predicate (a
 * supervisor machine WAKE whose note the guard did not strike), so a drain / continuation run or a mixed
 * strike never promises a filter that will not run; it is worded for the note ("written from this note")
 * because the briefing's 90-min lock may still skip this wake. `harnessReplacedBlock` — the supervisor
 * harness stripped the note's own ACTIONS TAKEN list (platform/harness-receipts; review fix 2026-10-20): the
 * footnote then says so, never "delivered as written … nothing above was removed" (f16cc02a);
 * `harnessStrippedCopies` — it stripped model-typed copies of the harness's own lines, named separately so
 * the footnote never claims an ACTIONS TAKEN list the note did not have. Pure.
 */
/**
 * What the supervisor harness removed from a note before delivery (platform/harness-receipts phase 1 + the
 * late strip), worded for an "as written" annotation — null when it removed nothing, so the caller keeps its
 * own "delivered as written … nothing above was removed or changed" wording byte-identically. `block` = the
 * note's own ACTIONS TAKEN list; `copies` = model-typed copies of the harness's own lines. Pure.
 */
export function harnessStrippedWording(o: { block?: boolean; copies?: boolean } | null | undefined): { delivered: string; rest: string } | null {
  const block = o?.block === true;
  const copies = o?.copies === true;
  if (!block && !copies) return null;
  const minus = block && copies
    ? 'its own ACTIONS TAKEN list and its copies of harness-record lines'
    : block ? 'its own ACTIONS TAKEN list' : 'its copies of harness-record lines';
  return {
    delivered: `This note was delivered as written, minus ${minus} (the harness records this wake's actions itself).`,
    rest: 'no other line was removed or changed',
  };
}

export function renderUnverifiedClaimsFootnote(claims: UnverifiedClaim[], opts: { zeroTool: boolean; briefingFiltered?: boolean; harnessReplacedBlock?: boolean; harnessStrippedCopies?: boolean }): string {
  const shown = claims.slice(0, MAX_FOOTNOTE_CLAIMS);
  const stripped = harnessStrippedWording({ block: opts.harnessReplacedBlock, copies: opts.harnessStrippedCopies });
  const replaced = stripped !== null;
  return [
    UNVERIFIED_FOOTNOTE_HEADER,
    `${stripped ? stripped.delivered : 'This note was delivered as written.'} The integrity check could not verify ${claims.length} action claim(s) in it — ${opts.zeroTool ? 'this run made no tool call at all, so nothing was sent, dispatched or changed in it' : 'no matching tool call in this run'}:`,
    ...shown.map((c) => `- [${c.kind}] "${clipQuote(c.quote)}"`),
    ...(claims.length > shown.length ? [`- … and ${claims.length - shown.length} more`] : []),
    `Treat those lines as unverified until a fresh tool result confirms them; ${replaced && stripped ? stripped.rest : 'nothing above was removed or changed'}.${opts.briefingFiltered === true ? ` ${UNVERIFIED_BRIEFING_SENTENCE}` : ''}`,
  ].join('\n');
}

/**
 * The note with the footnote placed IN FRONT OF the supervisor harness appendix this finalize appended
 * (`harnessAppendix`, exact; '' when none), else on the tail (review fix 2026-10-20). guard-chrome-redact
 * treats a TRAILING harness appendix as transparent and this footnote as chrome: footnote last stopped the
 * transparent walk at once, the walk then stripped the footnote and stopped at the appendix, so every
 * annotate-lane trailer before it stayed model-visible (the ticket 9975b1f2 / ac835c00 exposure) and its
 * kept signal line never fired. With the appendix last the walk detaches it and strips the footnote and the
 * trailers before it. Pure.
 */
export function placeUnverifiedFootnote(text: string, footnote: string, harnessAppendix = ''): string {
  const t = String(text ?? '').replace(/\s+$/, '');
  if (harnessAppendix && t.endsWith(harnessAppendix)) {
    const head = t.slice(0, t.length - harnessAppendix.length).replace(/\s+$/, '');
    return `${head ? `${head}\n\n` : ''}${footnote}\n\n${harnessAppendix}`;
  }
  return `${t}\n\n${footnote}`;
}

/** The note without the footnote this lane appended (exact removal; unchanged when it is not there). Pure. */
export function stripUnverifiedFootnote(text: string, footnote: string): string {
  const t = String(text ?? '');
  if (!footnote) return t;
  const at = t.lastIndexOf(footnote);
  if (at < 0) return t;
  return `${t.slice(0, at).replace(/\s+$/, '')}${t.slice(at + footnote.length)}`;
}

// ── the briefing's view ────────────────────────────────────────────────────

export interface UnverifiedBriefingPlan {
  /** The note with every located claim marked "(unverified)" (the deterministic path's input). */
  markedNote: string;
  /** The note with every located claim removed (the LLM rewrite path's input). */
  droppedNote: string;
  /** How many claims were located in the note. */
  located: number;
}

/** Locate the claims once and derive both briefing inputs. Unlocated claims change nothing. Pure. */
export function planUnverifiedBriefing(note: string, claims: UnverifiedClaim[]): UnverifiedBriefingPlan {
  const n = String(note ?? '');
  const segs = disjointSegments((claims ?? [])
    .map((c) => locateClaimSegment(n, c.quote))
    .filter((s): s is ClaimSegment => s !== null));
  if (!segs.length) return { markedNote: n, droppedNote: n, located: 0 };
  return { markedNote: markClaimSegments(n, segs), droppedNote: dropClaimSegments(n, segs), located: segs.length };
}

/** De-duplicate claims by normalized quote, first one wins. Pure. */
export function dedupeUnverifiedClaims(claims: UnverifiedClaim[]): UnverifiedClaim[] {
  const seen = new Set<string>();
  const out: UnverifiedClaim[] = [];
  for (const c of claims ?? []) {
    const key = normalizeClaimText(c?.quote ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
