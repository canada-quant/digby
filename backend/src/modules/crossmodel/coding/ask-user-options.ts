/**
 * ask_user quick picks — a pure leaf (no imports) so the tool executor and its tests share one parser.
 */

/** One ask_user quick pick as the card renders it: the label is what the answer returns. */
export interface AskUserOptionDetail { label: string; description?: string }
/** ask_user extras beyond the question + option labels (2026-10-20: clarify / creative-direction asks). */
export interface AskUserOpts {
  /** Per-option one-line descriptions, aligned with the labels — present only when at least one option has one. */
  optionDetails?: AskUserOptionDetail[];
  /** The user may pick several options; the answer comes back as the picks joined by ", ". */
  multiSelect?: boolean;
}

/**
 * ask_user's `options` → labels + per-option descriptions. A string option may carry its description after an EM or
 * EN dash ("Playful — cartoon pup", the shape the doctrine asks for); a plain " - " is part of the label ("9 am - 5 pm",
 * "Toronto - Ottawa" are labels, not label + description). An object {label, description} is accepted too (a model
 * that ignores the string schema). The LABEL is what the user's pick returns to the model, so it is never cut; exact
 * duplicates and blanks are dropped; at most 6 options; descriptions ≤ 160 chars. Pure.
 */
export function parseAskUserOptions(raw: unknown): { labels: string[]; details: AskUserOptionDetail[] } {
  const details: AskUserOptionDetail[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(raw) ? raw : []) {
    let label = '';
    let description = '';
    if (o && typeof o === 'object') {
      label = String((o as any).label ?? (o as any).title ?? '').trim();
      description = String((o as any).description ?? '').trim();
    } else if (o != null) {
      const text = String(o).trim();
      const m = /^(.+?)\s+[—–]\s+(.+)$/.exec(text);
      if (m) { label = m[1].trim(); description = m[2].trim(); } else label = text;
    }
    if (!label || seen.has(label)) continue;
    seen.add(label);
    details.push(description ? { label, description: description.slice(0, 160) } : { label });
    if (details.length >= 6) break;
  }
  return { labels: details.map(d => d.label), details };
}
