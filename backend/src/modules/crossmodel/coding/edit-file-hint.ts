/**
 * edit_file miss diagnostics (tool-failure-streak CLASS fix — tickets efcdcbca
 * + bb77c6ad, Fleet Supervisor ask 2026-10-22). Two lanes each missed
 * edit_file 3× in a row and tripped the derail breaker: the one-line refusal
 * told the model THAT it missed, nothing about WHY, so a stale quote (the
 * file moved since the lane's last read, or the quote came from aged /
 * compacted context) became a guessing streak. On a miss the handler now
 * appends ONE deterministic hint inside a bracketed tail —
 * ` [edit_file hint: …]` — so the failure markers in
 * learnings-index.service.ts keep their full-envelope anchoring (a model's
 * own trailing narration still does NOT match) while the model gets the why:
 *   (a) a line-ending mismatch (file CRLF vs old_string LF, or vice versa);
 *   (b) a match up to TRAILING whitespace;
 *   (c) a match at DIFFERENT INDENTATION (the file's indent + line named);
 *   (d) the nearest window by token-Jaccard with its line range and a short
 *       excerpt (the stale-quote class — the consumed anchor's successor);
 *   (e) the SATURATION DELTA (ticket 065a5b5f, 2026-10-23): when the nearest
 *       window is ≥SATURATION_DELTA_MIN_PCT (89) token-similar, "N% similar"
 *       + "not found" is a dead end — the differing BYTES are the only
 *       remaining signal, and token-Jaccard is blind to exactly the class
 *       that survives at 100% (a missing ` total {sum(x.values())}` fragment
 *       whose every token already appears elsewhere in the block).
 *       FLOOR 95 → 89 (ticket 0b5c73bc, 2026-11-02): at 95 the dead end came
 *       straight back one band down. That lane was byte-mismatching ONE line
 *       of its OWN uncommitted, in-flux draft (`const sample = {` where the
 *       file it was writing had `const samples: Record<string, string> = {`)
 *       and its two misses read "89% similar at lines 87–92: 'const sample =
 *       {'" then "93% similar at lines 85–93: 'for (const alt of
 *       LEAK_ALTERNATIVES) {'" — a line-START excerpt plus "re-read that
 *       region", with the one differing line left unnamed, i.e. the SAME
 *       ambiguity 065a5b5f closed at saturation, surviving in the band just
 *       under it. The band now takes (e): the nearest window is already the
 *       best Jaccard candidate, so naming WHICH line differs can only add
 *       signal. Below the floor the legacy (d) tail is byte-unchanged.
 *       The hint
 *       then names the first differing line + column with RAW excerpts
 *       windowed around the diff (never identical by construction), so the
 *       model copies the file's line instead of re-sending identical bytes
 *       (the incident's attempts 2 and 3 were byte-identical after a CORRECT
 *       diagnosis).
 * MARKER SAFETY (same ticket): every hint passes clipEditFileHint, which
 * neutralizes `]` — the failure markers in learnings-index.service.ts admit
 * a hint body of `[^\]\n]{0,320}`, so a raw `]` in a file excerpt (this
 * incident's own region contains `ct['total_rows']`) would break the tail
 * match and the refusal would read as SUCCESS to the derail breaker (the
 * d2e6b0fb blind-spot class reintroduced by the hint feature itself).
 * On a non-unique match the hint lists the occurrence start lines.
 * Every probe reads the already-loaded file buffer — zero added I/O. Bounds:
 * Jaccard is skipped when the file tops 20_000 lines or old_string tops 200
 * lines, so the error path stays flat on huge inputs; no probe firing ⇒ no
 * hint (the exact pre-2026-10-22 envelope, byte-for-byte).
 * EDIT_FILE_MISS_DIAGNOSTICS_DISABLED=1 restores the pre-hint envelope on
 * both refusals (a model-context change must be revertible from box env).
 * Pure leaf: no imports, no I/O.
 */

const HINT_TAIL_MAX = 300;
const JACCARD_MIN = 0.4;
const JACCARD_MAX_FILE_LINES = 20_000;
const JACCARD_MAX_OLD_LINES = 200;
/**
 * The floor (as a ROUNDED percent, the number the hint prints) at which the
 * nearest window is close enough that withholding the differing LINE is a
 * dead end, so probe (e) names it instead. Raised coverage 95 → 89 by ticket
 * 0b5c73bc (2026-11-02): that lane's misses sat at 89% then 93% — one line of
 * its OWN in-flux draft quoted a word behind the file — and both hints named
 * only a line-START excerpt plus "re-read that region", leaving the model to
 * guess which of 6–9 lines differed. The nearest window is already the best
 * Jaccard candidate, so naming WHICH line differs only ever adds signal;
 * under the floor the legacy (d) tail is byte-unchanged.
 */
const SATURATION_DELTA_MIN_PCT = 89;

function lineStartOffsets(s: string): number[] {
  const offs = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') offs.push(i + 1);
  return offs;
}

function lineNoAt(offs: number[], idx: number): number {
  let lo = 0, hi = offs.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offs[mid] <= idx) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans + 1; // 1-based
}

function stripTrailingWs(s: string): string {
  return s.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
}

function stripLeadingWs(s: string): string {
  return s.split('\n').map(l => l.replace(/^[ \t]+/, '')).join('\n');
}

function tokenSet(s: string): Set<string> {
  const m = s.toLowerCase().match(/[a-z0-9_$]+/g);
  return new Set(m ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Bound the bracketed tail so a miss can never blow up the model's context.
 * MARKER SAFETY (ticket 065a5b5f): also neutralizes `]` — the failure markers
 * admit a hint body of `[^\]\n]{0,320}`, so a raw `]` in a file excerpt (e.g.
 * `ct['total_rows']`) would terminate the tail match early and the whole
 * refusal would read as SUCCESS to the derail breaker. `]`→`］` (fullwidth,
 * visually unmistakable) keeps the excerpt readable and deterministic; the
 * clip happens AFTER, so the 300-char bound holds on the sanitized text. */
export function clipEditFileHint(hint: string): string {
  const safe = hint.includes(']') ? hint.replace(/\]/g, '］') : hint;
  return safe.length > HINT_TAIL_MAX ? `${safe.slice(0, HINT_TAIL_MAX - 1)}…` : safe;
}

/**
 * The count === 0 diagnostic: ONE hint (no brackets), or '' when no probe
 * fires (the handler then returns the byte-exact pre-hint envelope).
 */
export function editFileMissDiagnostic(cur: string, oldStr: string): string {
  if (!oldStr) return '';
  // (a) line-ending mismatch — the cheapest exact explanation.
  const curCrlf = cur.includes('\r\n');
  const oldCrlf = oldStr.includes('\r\n');
  if (curCrlf !== oldCrlf) {
    return curCrlf
      ? "line-ending mismatch: the file uses CRLF (\\r\\n) line endings but old_string uses LF — re-read the file and match its endings"
      : "line-ending mismatch: the file uses LF line endings but old_string uses CRLF (\\r\\n) — re-read the file and match its endings";
  }
  // (b) trailing-whitespace-tolerant match.
  if (stripTrailingWs(cur).includes(stripTrailingWs(oldStr))) {
    return "old_string matches except for TRAILING whitespace — one or more of the file's lines end with spaces/tabs your old_string lacks (or vice versa); re-read and copy byte-exactly";
  }
  const curLines = cur.split('\n');
  const oldLines = oldStr.split('\n');
  // (c) indentation-tolerant match — name the file's indent and first line.
  if (stripLeadingWs(cur).includes(stripLeadingWs(oldStr))) {
    const strippedOld = oldLines.map(l => l.replace(/^[ \t]+/, ''));
    outer: for (let i = 0; i + oldLines.length <= curLines.length; i++) {
      for (let j = 0; j < oldLines.length; j++) {
        if (curLines[i + j].replace(/^[ \t]+/, '') !== strippedOld[j]) continue outer;
      }
      const indent = curLines[i].match(/^[ \t]*/)?.[0] ?? '';
      return `old_string matches at DIFFERENT INDENTATION — the file's block starts at line ${i + 1} indented ${indent.length} char(s); re-read and copy the leading whitespace byte-exactly`;
    }
  }
  // (d) nearest window by token-Jaccard — the stale-quote class (bounded).
  if (curLines.length <= JACCARD_MAX_FILE_LINES && oldLines.length <= JACCARD_MAX_OLD_LINES) {
    const oldTok = tokenSet(oldStr);
    if (oldTok.size) {
      const w = Math.min(oldLines.length, curLines.length);
      const lineToks = curLines.map(tokenSet);
      let best = 0, bestAt = 0;
      for (let i = 0; i + w <= curLines.length; i++) {
        const winTok = new Set<string>();
        for (let j = 0; j < w; j++) for (const t of lineToks[i + j]) winTok.add(t);
        const s = jaccard(oldTok, winTok);
        if (s > best) { best = s; bestAt = i; }
      }
      if (best >= JACCARD_MIN) {
        // (e) SATURATION DELTA (ticket 065a5b5f): near token-saturation the
        // percentage is a dead end — it can read "100%" while exact match says
        // "not found", because the missing/extra bytes are punctuation or a
        // fragment whose tokens ALL appear elsewhere in the block. Name the
        // FIRST differing line + column with RAW excerpts windowed around the
        // diff (adversarial review of the first cut: line-start excerpts
        // truncated to 80 chars can come out IDENTICAL on both sides when the
        // diff sits past the cut, and trim() erases indent-only diffs — the
        // dead end again). Windowing the raw bytes around the first differing
        // column makes identical excerpts impossible by construction; the
        // excerpt is cut at the first ']' (the copy authority is the FILE line
        // number — a neutralized '］' inside a "copy byte-exactly" target would
        // mint the NEXT mismatch), and clipEditFileHint remains the final
        // marker-safety net for every other branch.
        // ROUNDING CONSISTENCY (ticket 8a988455 review, 2026-10-25): branch on
        // the ROUNDED percentage, the same number the hint prints — a raw ratio
        // in [0.945, 0.95) printed "95% similar" while this raw-threshold branch
        // withheld the named diff and fell to the (d) tail: the incident's exact
        // self-contradiction ("95% similar" + no differing byte named) surviving
        // one fix later, at the boundary. Anything that PRINTS at or above
        // SATURATION_DELTA_MIN_PCT now takes (e).
        // FLOOR 95 → 89 (ticket 0b5c73bc, 2026-11-02): an 89%-and-93% pair of
        // misses was the SAME dead end one band lower — a line-start excerpt
        // plus "re-read that region" while exactly ONE line differed.
        if (Math.round(best * 100) >= SATURATION_DELTA_MIN_PCT) {
          for (let j = 0; j < w; j++) {
            const fileLine = curLines[bestAt + j] ?? '';
            const oldLine = oldLines[j] ?? '';
            if (fileLine !== oldLine) {
              let c = 0;
              while (c < fileLine.length && c < oldLine.length && fileLine[c] === oldLine[c]) c++;
              const win = (s: string) => {
                const from = Math.max(0, c - 25);
                const to = Math.min(s.length, c + 45);
                let body = s.slice(from, to);
                const br = body.indexOf(']');
                if (br !== -1) body = body.slice(0, br);
                return `${from > 0 ? '…' : ''}${body}${to < s.length ? '…' : ''}`;
              };
              return `nearest match is ${Math.round(best * 100)}% similar at lines ${bestAt + 1}–${bestAt + w} but line ${bestAt + j + 1} differs at col ${c + 1}: file '${win(fileLine)}' vs yours '${win(oldLine)}' — copy the file's line ${bestAt + j + 1} byte-exactly`;
            }
          }
          // Window lines all equal yet exact match failed. When old_string is
          // LONGER than the whole file's window the surplus lines were never
          // compared — say so (review #3: "blank lines" sent the model
          // hunting for blanks that did not exist).
          const surplus = oldLines.length > curLines.length
            ? ` — your old_string has ${oldLines.length - curLines.length} MORE line(s) than the file; trim it`
            : ' (blank lines or their placement)';
          return `nearest match is ${Math.round(best * 100)}% similar at lines ${bestAt + 1}–${bestAt + w} and every line matches — the difference is BETWEEN lines${surplus}; re-read with line numbers and copy byte-exactly`;
        }
        const first = curLines[bestAt].trim();
        const excerpt = first.length > 60 ? `${first.slice(0, 59)}…` : first;
        return `nearest match is ${Math.round(best * 100)}% similar at lines ${bestAt + 1}–${bestAt + w}: '${excerpt}' — re-read that region and quote it byte-exactly`;
      }
    }
  }
  return '';
}

/** The count > 1 diagnostic: the occurrence start lines (≤ 10). */
export function editFileMultiDiagnostic(cur: string, oldStr: string): string {
  const offs = lineStartOffsets(cur);
  const lines: number[] = [];
  let idx = cur.indexOf(oldStr);
  while (idx !== -1 && lines.length < 10) {
    lines.push(lineNoAt(offs, idx));
    idx = cur.indexOf(oldStr, idx + Math.max(oldStr.length, 1));
  }
  const more = lines.length === 10 && idx !== -1 ? ', …' : '';
  return `occurrences start at lines: ${lines.join(', ')}${more} — widen old_string with surrounding context unique to your target`;
}
