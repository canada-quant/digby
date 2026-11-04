/**
 * Prose grouping for the coding transcript (ticket 0b4575dd, owner report
 * 2026-08-28): interleaved-thinking models (kimi-k3) alternate text/reasoning
 * deltas at ~5/sec, and the frontend's trailing-same-kind merge opens a NEW
 * text part every time a reasoning part intervenes — so one continuous prose
 * answer persists as T,R,T,R,T,R… and renders as many small paragraph
 * fragments separated by full-width "Thought process" rows.
 *
 * This pure transform finds maximal runs of text/reasoning parts and groups
 * the ones where reasoning interleaved between prose fragments (≥2 non-empty
 * text parts + ≥1 reasoning part) into a single render item. Joining the
 * run's text parts with '' is BYTE-LOSSLESS: text deltas on either side of a
 * reasoning part are contiguous in the model's text channel (paragraph breaks
 * are emitted as text), so the joined string is exactly what the answer would
 * read without interleaved thinking. Tool calls/results, subagents, and
 * images break runs and always render at their arrival position.
 *
 * Runs that DON'T qualify as prose groups still get their consecutive
 * reasoning subruns (≥2 non-empty thoughts) collapsed into ONE 'thoughts'
 * item (owner report 2026-08-30 — the "Thought process" row spam: multi-
 * persona runs render a full-width collapsed row per persona part otherwise).
 *
 * Display-layer only — nothing here changes what is stored or sent to any
 * model. The raw run is preserved on the group for raw-order expansion.
 */

import type { MessagePart } from './api/coding';

export interface ProseGroupItem {
  kind: 'prose';
  /** ALL text parts of the run in arrival order — join('') is byte-lossless
   *  (whitespace-only parts included so no character is ever dropped). */
  texts: MessagePart[];
  /** Non-empty reasoning parts in arrival order (the interleaved thoughts). */
  thoughts: MessagePart[];
  /** The full run in arrival order — for raw-order (legacy) expansion. */
  raw: MessagePart[];
  /** Stable React key: first part's uid (live), else positional (persisted). */
  key: string;
}

export interface SinglePartItem {
  kind: 'part';
  part: MessagePart;
  /** Original index — the tool_call→tool_result merge peeks parts[index+1]. */
  index: number;
}

/** A collapsed run of consecutive reasoning parts (≥2 non-empty thoughts)
 *  inside a run that didn't qualify as a prose group — renders as ONE
 *  "Thought process" disclosure instead of a row per persona part. */
export interface ThoughtGroupItem {
  kind: 'thoughts';
  /** The subrun's non-empty reasoning parts in arrival order. */
  thoughts: MessagePart[];
  /** Stable React key: first part's uid (live), else positional (persisted). */
  key: string;
  /** Original index of the subrun's LAST part — the caller's live-flag calc
   *  (a group is "live" when it ends at the message's final part). */
  endIndex: number;
}

export type ProseRenderItem = ProseGroupItem | SinglePartItem | ThoughtGroupItem;

// Harness guard markers and struck (rejected) drafts render as their own
// blocks — they break a prose run instead of folding into it (2026-09-08).
const isProseKind = (p: MessagePart) => (p.type === 'text' && !p.marker && !p.struck) || p.type === 'reasoning';
const hasText = (p: MessagePart) => ((p.text as string | undefined) || '').trim().length > 0;

export function groupProseParts(parts: MessagePart[]): ProseRenderItem[] {
  const items: ProseRenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    if (!isProseKind(parts[i])) {
      items.push({ kind: 'part', part: parts[i], index: i });
      i++;
      continue;
    }
    // Maximal run of text/reasoning parts.
    let j = i;
    while (j < parts.length && isProseKind(parts[j])) j++;
    const run = parts.slice(i, j);
    const nonEmptyTexts = run.filter(p => p.type === 'text' && hasText(p)).length;
    const hasReasoning = run.some(p => p.type === 'reasoning');
    if (nonEmptyTexts >= 2 && hasReasoning) {
      items.push({
        kind: 'prose',
        texts: run.filter(p => p.type === 'text'),
        thoughts: run.filter(p => p.type === 'reasoning' && hasText(p)),
        raw: run,
        key: (run[0] as any).uid ?? `g${i}`,
      });
    } else {
      // Not a prose group — but still collapse maximal consecutive reasoning
      // subruns of ≥2 non-empty thoughts into ONE 'thoughts' item so
      // multi-persona thinking renders as a single disclosure, not a row per
      // persona part (owner report 2026-08-30).
      let k = i;
      while (k < j) {
        if (parts[k].type !== 'reasoning') {
          items.push({ kind: 'part', part: parts[k], index: k });
          k++;
          continue;
        }
        let m = k;
        while (m < j && parts[m].type === 'reasoning') m++;
        const sub = parts.slice(k, m);
        const nonEmpty = sub.filter(hasText);
        if (nonEmpty.length >= 2) {
          items.push({ kind: 'thoughts', thoughts: nonEmpty, key: (sub[0] as any).uid ?? `th${k}`, endIndex: m - 1 });
        } else {
          for (let n = k; n < m; n++) items.push({ kind: 'part', part: parts[n], index: n });
        }
        k = m;
      }
    }
    i = j;
  }
  return items;
}

/** The flowing paragraph for a group: byte-lossless text-channel join. */
export function proseGroupText(group: ProseGroupItem): string {
  return group.texts.map(t => (t.text as string | undefined) || '').join('');
}
