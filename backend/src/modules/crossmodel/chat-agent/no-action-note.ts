/**
 * 2026-10-21 (FSN1021) — the harness's no-action-tool line, as a pure leaf (no DB, no logger) so the
 * history redactor (guard-chrome-redact.ts) can strip it without loading the chat-agent graph. The
 * decision of WHEN the line applies lives in unbacked-claim.ts noActionToolNote.
 */
export const NO_ACTION_TOOL_NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';

/**
 * Kill switch for the FSN1021 change set: the note, the copy strips, the reconcile-draft strip and the revision
 * re-judge. The model-history strip (guard-chrome-redact) is deliberately NOT behind it — after a rollback the
 * stored lines must still never reach the model as its own words.
 */
export function noActionToolNoteDisabled(): boolean {
  return process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED === '1';
}

/** A CommonMark fence delimiter line (0–3 spaces, then 3+ backticks or tildes), or null. */
function fenceDelimiter(line: string): { ch: string; len: number; rest: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, '')); // CRLF text: the \r is not part of the delimiter
  return m ? { ch: m[1][0], len: m[1].length, rest: m[2] } : null;
}

/**
 * Walks the lines with CommonMark fence state: an opener is 3+ backticks / tildes indented at most 3
 * spaces (a backtick opener's info string has no backtick — "```npm test``` is the check" is inline code,
 * not a fence); it closes on the same character, at least as long, with nothing after it. Calls `visit`
 * with each line and whether it is inside (or delimits) a fenced block; returns whether the text ends
 * inside an open fence.
 */
function walkFences(lines: string[], visit: (line: string, fenced: boolean) => void): boolean {
  let fence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const d = fenceDelimiter(line);
    if (fence) {
      if (d && d.ch === fence.ch && d.len >= fence.len && !d.rest.trim()) fence = null;
      visit(line, true);
      continue;
    }
    if (d && !(d.ch === '`' && d.rest.includes('`'))) {
      fence = { ch: d.ch, len: d.len };
      visit(line, true);
      continue;
    }
    visit(line, false);
  }
  return fence !== null;
}

/** True when the text ends inside an unclosed code fence — a line appended there would render as code. */
export function endsInsideOpenFence(text: string): boolean {
  return walkFences(String(text ?? '').split('\n'), () => {});
}

/**
 * The text with every STANDALONE line equal to `line` removed — the shape the harness writes and a model
 * copy of it takes. A quotation, an inline mention, a blockquote, an indented (4+ spaces) code line or a
 * line inside a fenced block (``` or ~~~) is left alone: the harness never deletes words it cannot prove
 * are its own. Only the blank lines around a removed line are normalised (one paragraph break between the
 * text before and after it; none at the end); every other byte is kept. Unchanged input is the same
 * string. Generic over the harness line since 2026-10-22: the no-action note and the unread-state note
 * (unread-state-note.ts) share the exact strip / insert rules.
 */
export function stripHarnessLine(text: string, harnessLine: string): string {
  const t = String(text ?? '');
  if (!harnessLine || !t.includes(harnessLine)) return t;
  const out: string[] = [];
  let removed = false;
  let pendingBreak = false;
  walkFences(t.split('\n'), (line, fenced) => {
    if (!fenced && /^ {0,3}\S/.test(line) && line.trim() === harnessLine) {
      removed = true;
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      pendingBreak = true;
      return;
    }
    if (pendingBreak) {
      if (line.trim() === '') return;
      if (out.length) out.push('');
      pendingBreak = false;
    }
    out.push(line);
  });
  return removed ? out.join('\n') : t;
}

/** True when the text carries `harnessLine` as a standalone line (the harness's shape). */
export function hasHarnessLine(text: string, harnessLine: string): boolean {
  const t = String(text ?? '');
  return !!harnessLine && t.includes(harnessLine) && stripHarnessLine(t, harnessLine) !== t;
}

/** Puts `harnessLine` at the end of the prose: before a [FOLLOWUPS] block (parseFollowUps reads an unterminated block to the end), else after the last paragraph. */
export function insertHarnessLine(text: string, harnessLine: string): string {
  const t = String(text ?? '');
  // Already there, or the text ends inside an open fence (the line would render as code): unchanged.
  if (hasHarnessLine(t, harnessLine) || endsInsideOpenFence(t)) return t;
  // In front of the FIRST [FOLLOWUPS] anywhere — exactly where parseFollowUps starts the chip block (round 8: a
  // line-start-only anchor let the parser swallow the line into the chips). When that point is inside a code
  // fence, the line goes at the end instead; the callers (unbacked-claim.ts noActionToolNote, unread-state-note.ts
  // unreadStateNoteText) then run the finalize's own parsers and leave the line off whenever they would swallow it.
  const at = t.search(/\[FOLLOWUPS\]/i);
  if (at >= 0 && !endsInsideOpenFence(t.slice(0, at))) {
    return `${t.slice(0, at).replace(/\s+$/, '')}\n\n${harnessLine}\n\n${t.slice(at)}`;
  }
  return `${t.replace(/\s+$/, '')}\n\n${harnessLine}`;
}

/** The text with every STANDALONE no-action line removed (stripHarnessLine over NO_ACTION_TOOL_NOTE). */
export function stripNoActionToolNote(text: string): string {
  return stripHarnessLine(text, NO_ACTION_TOOL_NOTE);
}

/** True when the text carries the note as a standalone line (the harness's shape). */
export function hasNoActionToolNote(text: string): boolean {
  return hasHarnessLine(text, NO_ACTION_TOOL_NOTE);
}

/** Puts the note at the end of the prose: before a [FOLLOWUPS] block (parseFollowUps reads an unterminated block to the end), else after the last paragraph. */
export function insertNoActionToolNote(text: string): string {
  return insertHarnessLine(text, NO_ACTION_TOOL_NOTE);
}
