/**
 * Per-label streaming-delta merge for message parts (owner report 2026-08-30 —
 * the "Thought process" row spam). Concurrent personas (Digby orchestrator +
 * Double Checker/Triple Checker cross-check and council seats) stream reasoning
 * deltas INTERLEAVED on one SSE connection at token rate. The old
 * trailing-only, label-keyed merge (ticket 01c69ca9 review B2) prevented
 * word-salad but opened a NEW part on every label alternation — dozens of
 * collapsed "Thought process" rows per turn, each holding a mid-word fragment
 * ("The", "ute Montreal"). The legacy chat feed solved this exact zebra in
 * 2026-07 with a per-label Map (page.tsx agentReasoningByLabelRef); this is
 * the unified view's port, shared by plain-session's normalizer,
 * CodeSessionView's live parts, and SupervisorChatTab's live parts.
 *
 * Semantics:
 *  - A reasoning delta with label L appends to the persona's EXISTING part
 *    (wherever it sits — the part keeps its first-appearance position and
 *    uid), so one run yields at most one reasoning part per persona.
 *  - Unlabeled reasoning appends to the MOST RECENT reasoning part (any
 *    label) — the thinking-summary channel mirrors a labeled stream, so this
 *    keeps the ticket-6201d579 "never split the run on a summary tick"
 *    guarantee without keying undefined as its own label.
 *  - Text deltas keep the plain trailing-same-kind merge. Text does NOT close
 *    a reasoning part: interleaved-thinking models (kimi-k3) alternate T/R at
 *    ~5/sec, and letting R coalesce into one fixed-position part means later
 *    text deltas trailing-merge again — the run settles into a [text,
 *    reasoning, text] shape that prose-grouping renders as one prose block.
 *
 * Pure + immutable: returns a NEW array (and a new part object on merge) so
 * React functional state updates re-render correctly. `stamp` marks newly
 * created parts (stable uid for React keys).
 */

import type { MessagePart } from './api/coding';

export interface MergeDeltaOpts {
  label?: string;
  stamp?: (p: MessagePart) => MessagePart;
}

/**
 * The lead seat's label — the one producer whose TEXT channel this merge
 * guards. The backend stamps it on the lead's own tool events
 * (chat-agent.service.ts SEAT_LABELS.lead = 'Digby'; sse-adapter.ts sends
 * `{kind:'tool', label:'Digby'}` for the lead), so a tool part carrying a
 * DIFFERENT label is provably a CONCURRENT seat's — the Double Checker /
 * Triple Checker / council colleague runs stream their tool activity on the
 * SAME SSE while the lead's answer streams (Promise.all in
 * chat-agent.service.ts), and their frames can land between two deltas of
 * one word. Unlabelled tool parts (coding sessions, pre-2026-09-15 servers)
 * are treated as the lead's own trail — never crossed.
 */
const LEAD_SEAT_LABEL = 'Digby';

/** True for a tool part stamped with a seat label that is NOT the lead's —
 *  a concurrent seat's activity (label present + non-empty + ≠ lead). */
function isForeignSeatToolPart(p: MessagePart): boolean {
  const label = typeof (p as any).label === 'string' ? (p as any).label.trim() : '';
  return !!label && label !== LEAD_SEAT_LABEL;
}

export function mergeDeltaIntoParts(
  parts: MessagePart[],
  kind: 'text' | 'reasoning',
  delta: string,
  opts: MergeDeltaOpts = {},
): MessagePart[] {
  if (!delta) return parts;
  const { label, stamp } = opts;
  const mk = (p: MessagePart): MessagePart => (stamp ? stamp(p) : p);

  if (kind === 'text') {
    const last = parts[parts.length - 1];
    // A harness guard marker is its own block — streamed text after it starts
    // a NEW part (mirrors run-executor's accumulate; 2026-09-08).
    if (last && last.type === 'text' && !last.marker) {
      const next = parts.slice();
      next[next.length - 1] = { ...last, text: (last.text || '') + delta };
      return next;
    }
    // Ticket 53c0b979 (user report 2026-10-24: "ui responses chronologically
    // sometimes breaks words with tool calls"): the trailing part is not
    // mergeable text, but the lead's answer may have been mid-word when a
    // CONCURRENT seat's tool card landed between two of its deltas. The Double
    // Checker / Triple Checker / council colleagues run in parallel with the
    // lead's live answer stream (chat-agent.service.ts Promise.all) and emit
    // their agent-activity tool events on the SAME SSE — so their frames
    // interleave at token rate with the lead's `chunk` frames. The old
    // trailing-only rule opened a NEW text part after every such card, and
    // AssistantParts renders parts in ARRIVAL ORDER: the word streamed as
    // "Mont" + [Double Checker's card] + "real" — one word broken across a
    // tool card (the screenshot's defect). Walk back over a window of
    // foreign-seat tool parts (+ any reasoning interleaved among them) to the
    // lead's still-open text part and CONTINUE it there — the card keeps its
    // chronological slot in the parts array while the lead's text channel
    // stays whole. REASONING-ONLY crossings do NOT merge: the [text, reasoning,
    // text] zebra is the intentional interleaved-thinking shape (kimi-k3
    // alternates T/R at ~5/sec) that prose-grouping joins byte-losslessly at
    // render (lib/prose-grouping.ts) — a merge there would change a pinned
    // contract for no visible gain. The walk stops at the first non-crossable
    // part: the lead's OWN tool parts (label 'Digby' or unlabelled — its tool
    // trail legitimately separates pre/post text; coding sessions are
    // unlabelled and stay untouched), images, subagents, task cards, guard
    // markers and struck drafts.
    const crossable = (p: MessagePart): boolean =>
      p.type === 'reasoning' || ((p.type === 'tool_call' || p.type === 'tool_result') && isForeignSeatToolPart(p));
    let sawForeignTool = false;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      // The walk TERMINATES at a text part: continue it only when a concurrent
      // seat's tool card(s) were crossed (sawForeignTool). A guard marker or
      // struck draft is its own block — text after either starts a NEW part.
      if (p.type === 'text') {
        if (p.marker || p.struck || !sawForeignTool) break;
        const next = parts.slice();
        next[i] = { ...p, text: (p.text || '') + delta };
        return next;
      }
      if ((p.type === 'tool_call' || p.type === 'tool_result') && isForeignSeatToolPart(p)) {
        sawForeignTool = true;
        continue;
      }
      if (!crossable(p)) break;
    }
    return [...parts, mk({ type: 'text', text: delta })];
  }

  // reasoning
  if (label !== undefined) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === 'reasoning' && p.label === label) {
        const next = parts.slice();
        next[i] = { ...p, text: (p.text || '') + delta };
        return next;
      }
    }
    return [...parts, mk({ type: 'reasoning', text: delta, label })];
  }
  // Unlabeled: ride the most recent reasoning part (any label) so a summary
  // tick never splits a persona run; an unlabeled part that later sees a
  // labeled delta is handled by the labeled branch above (it creates the
  // persona's own part — no adoption needed now that summaries carry labels).
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === 'reasoning') {
      const next = parts.slice();
      next[i] = { ...p, text: (p.text || '') + delta };
      return next;
    }
  }
  return [...parts, mk({ type: 'reasoning', text: delta })];
}

/**
 * thinking-summary payloads are prefixed with the persona name server-side
 * (`Digby: …`, `Fact-checker: …` — sse-adapter.ts / chat-agent.service.ts).
 * Split the prefix so the summary routes into that persona's reasoning part
 * instead of wildcard-merging into whichever persona streamed last (the
 * misattribution the 6201d579 wildcard rule accepted). Returns the bare label
 * + the summary text without its prefix. No prefix → label undefined.
 */
export function splitSummaryLabel(summary: string): { label?: string; text: string } {
  const m = /^([^\n:]{1,40}):\s+([\s\S]*)$/.exec(summary);
  if (!m) return { text: summary };
  return { label: m[1].trim() || undefined, text: m[2] };
}
