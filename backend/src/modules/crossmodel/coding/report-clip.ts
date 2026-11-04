/**
 * Boundary-aware clipping for cross-agent result transport (audit 2026-10-08
 * W2-6 — lanes.md F7).
 *
 * Evidence: every background-worker report in the audit window landed at
 * 4,023–4,923 chars — 4,000 chars of prose cut MID-WORD ("…**refetch-",
 * "It was demonstr") plus the status line — and get_chat_messages cut
 * cross-chat reads at the same hard 4,000. One ticket lane started a whole
 * reviewer run (4287a47e) just to get findings 2–6 re-sent. Delegations exist
 * to RETURN findings; a hard mid-sentence slice drops the verdict and gives
 * the reader no way to fetch the rest.
 *
 * Now: worker reports carry up to WORKER_REPORT_CAP_CHARS (default 12,000),
 * a report over the cap is cut at a paragraph / sentence / line / word
 * boundary (never mid-word) and ends with "(… N more chars — <how to read the
 * rest>)": the full report is written to the worktree
 * (.digby/session/worker-reports/, git-ignored scratch) and the tail names
 * that file. get_chat_messages cuts at a boundary too and names
 * `get_chat_messages({chatId, messageId})` — which returns ONE message in
 * full, paged by `offset`.
 *
 * Kill switch REPORT_CLIP_V2_DISABLED=1 restores the hard 4,000 slices
 * byte-for-byte (read per call). Pure leaf — no I/O.
 */

export const LEGACY_REPORT_CAP = 4_000;
export const WORKER_REPORT_CAP_DEFAULT = 12_000;
const WORKER_REPORT_CAP_MIN = 2_000;
const WORKER_REPORT_CAP_MAX = 60_000;
/** A boundary cut never keeps less than this share of the cap (else hard-cut at a word). */
const MIN_KEEP_SHARE = 0.6;

export function reportClipV2Disabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.REPORT_CLIP_V2_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** WORKER_REPORT_CAP_CHARS (2,000–60,000) else 12,000. */
export function workerReportCapChars(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env.WORKER_REPORT_CAP_CHARS ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return WORKER_REPORT_CAP_DEFAULT;
  return Math.min(WORKER_REPORT_CAP_MAX, Math.max(WORKER_REPORT_CAP_MIN, Math.floor(n)));
}

/**
 * Cut `text` to ≤ `cap` chars at the latest paragraph break, else sentence
 * end, else line break, else whitespace — never mid-word unless the text has
 * no boundary in the last 40% of the window. Returns the kept head (right-
 * trimmed) and how many chars were dropped. Pure.
 */
export function clipAtBoundary(text: string, cap: number): { text: string; omitted: number } {
  const s = String(text ?? '');
  const c = Math.max(1, Math.floor(cap));
  if (s.length <= c) return { text: s, omitted: 0 };
  const window = s.slice(0, c);
  const minCut = Math.floor(c * MIN_KEEP_SHARE);
  const lastAt = (re: RegExp): number => {
    let best = -1;
    let m: RegExpExecArray | null;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    while ((m = g.exec(window))) {
      const end = m.index + m[0].length;
      if (end >= minCut) best = end;
      if (m[0].length === 0) g.lastIndex += 1;
    }
    return best;
  };
  let cut = lastAt(/\n\s*\n/);
  if (cut < 0) cut = lastAt(/[.!?…](?:["')\]*_`]+)?(?=\s)/);
  if (cut < 0) cut = lastAt(/\n/);
  if (cut < 0) cut = lastAt(/\s/);
  if (cut < 0) cut = c;
  const head = s.slice(0, cut).replace(/\s+$/, '');
  return { text: head, omitted: s.length - head.length };
}

/** The tail line appended to a clipped text. Pure. */
export function clippedTail(omitted: number, howToReadRest: string): string {
  return `\n\n(… ${omitted} more chars — ${howToReadRest})`;
}

/** The sentence appended to the worker report contract (WORKER_ENVELOPE_INSTRUCTION). Pure. */
export function workerReportBudgetSentence(cap: number): string {
  return `Keep your prose report under ${cap} characters: lead with the findings / verdict, then the evidence. Put long listings, logs or full diffs in a file under .digby/session/ (or session memory) and name it — text past the budget is cut.`;
}
