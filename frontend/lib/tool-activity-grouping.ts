/**
 * Ticket 295068fa (long-running session UI polish) — tool-ACTIVITY accordion
 * for the parts stream, the in-run continuation of the machine-turn accordion
 * precedent (lib/machine-turn-grouping.ts, which groups whole ROWS).
 *
 * A long coding run persists as ONE assistant row whose parts[] interleave
 * prose with dozens of one-line ToolCards. History (and the live view's
 * finished phases) render every card — the wall of near-identical rows is the
 * clutter the owner keeps asking to tame ("keep the ui chat clear for the
 * user to follow along just like we did with previous accordian notes").
 *
 * This pure pass over the prose-grouped render items collapses a run of
 * ≥ MIN_TOOL_RUN consecutive tool parts (tool_call / tool_result) into ONE
 * collapsed "Tool activity" pill with a plain-English summary; expanding
 * renders the original cards verbatim (byte-lossless, display-layer only —
 * nothing here changes what is stored or sent to any model).
 *
 * TAIL RULE (follow-along contract, coding sessions): a tool run that reaches
 * the END of the parts list is the run's live edge — the activity the user is
 * watching RIGHT NOW — and stays expanded. Only completed runs (a prose/
 * thought/subagent boundary follows) collapse.
 *
 * PLAIN CHATS fold the tail too (owner 2026-09-15: a Level 2 answer showed
 * ~30 flat "Searched the web / Searched project memory / Read a page" rows
 * above the Double Checker chip — every one of them was the live edge). The
 * caller passes `foldTail`; the folded live run is flagged `live` so the
 * renderer can keep the CURRENT action visible under the collapsed header
 * (the follow-along signal survives, the wall does not), and MIN_LIVE_TOOL_RUN
 * (3) is the fold floor there — a pair of lookups can stay inline.
 */

import type { MessagePart } from '@/lib/api/coding';
import type { ProseRenderItem } from './prose-grouping';

export const MIN_TOOL_RUN = 4;
/** Fold floor for the LIVE tail in plain chats (owner 2026-09-15). */
export const MIN_LIVE_TOOL_RUN = 3;

export interface ToolActivityItem {
  kind: 'toolActivity';
  /** Parts indices making up the run (contiguous, all tool_call/tool_result). */
  indices: number[];
  /** React key base — first part's uid or its index. */
  key: string;
  /** Ordered tool names for the summary label. */
  names: string[];
  /** Distinct seat personas that produced the run's rows (plain chats stamp
   *  `label` on tool parts — "Digby", "Double Checker", …), in first-seen
   *  order. Empty when parts carry no label (coding sessions). */
  labels: string[];
  /** True when this run reaches the parts tail and was folded under
   *  `foldTail` — the renderer keeps the current action visible. */
  live?: boolean;
}

export type ToolAwareRenderItem = ProseRenderItem | ToolActivityItem;

export interface ToolActivityGroupingOptions {
  /** Fold the run at the parts tail too (plain chats). Default false. */
  foldTail?: boolean;
  /** Fold floor for the tail run when `foldTail` (default MIN_LIVE_TOOL_RUN). */
  minTailRun?: number;
}

// update_plan is EXCLUDED: its PlanCard is a distinct, valuable visual that
// must never fold into a collapsed pill (it breaks the run instead).
const isToolSingle = (item: ProseRenderItem): item is Extract<ProseRenderItem, { kind: 'part' }> =>
  item.kind === 'part'
  && (item.part.type === 'tool_call' || item.part.type === 'tool_result')
  && item.part.name !== 'update_plan';

/**
 * Collapse qualifying tool runs. `items` is the output of groupProseParts;
 * `parts` is the underlying parts array (for the tail check + labels).
 */
export function groupToolActivityItems(items: ProseRenderItem[], parts: MessagePart[], options: ToolActivityGroupingOptions = {}): ToolAwareRenderItem[] {
  const out: ToolAwareRenderItem[] = [];
  const minTail = options.minTailRun ?? MIN_LIVE_TOOL_RUN;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (!isToolSingle(it)) {
      out.push(it);
      i++;
      continue;
    }
    // Measure the consecutive tool-single run starting here.
    let j = i;
    const indices: number[] = [];
    const names: string[] = [];
    const labels: string[] = [];
    while (j < items.length && isToolSingle(items[j])) {
      const single = items[j] as Extract<ProseRenderItem, { kind: 'part' }>;
      indices.push(single.index);
      names.push(single.part.name ?? 'tool');
      const label = typeof (single.part as any).label === 'string' ? String((single.part as any).label).trim() : '';
      if (label && !labels.includes(label)) labels.push(label);
      j++;
    }
    const reachesTail = indices.length > 0 && indices[indices.length - 1] >= parts.length - 1;
    const folds = reachesTail
      ? options.foldTail === true && indices.length >= minTail
      : indices.length >= MIN_TOOL_RUN;
    if (folds) {
      out.push({
        kind: 'toolActivity',
        indices,
        // Key stability (review N1): uid-first like prose-grouping's `g` keys —
        // a purely positional key re-keys every pill on each MAX_LIVE_PARTS
        // front-slice in long live runs, remounting it snapped-shut.
        key: (parts[indices[0]] as any)?.uid ?? `ta${indices[0]}`,
        names,
        labels,
        ...(reachesTail ? { live: true } : {}),
      });
    } else {
      for (let k = i; k < j; k++) out.push(items[k]);
    }
    i = j;
  }
  return out;
}

/**
 * Plain-English KIND for a tool name — the noun the summary counts (owner
 * directive 2026-07-24: raw tool names never reach the UI; the 295068fa pill
 * used to read "run_command ×3, read_file ×2"). Returns [singular, plural].
 */
export function toolKindNoun(name: string): [string, string] {
  switch (name) {
    case 'search_engine': return ['web search', 'web searches'];
    case 'web_pipe': return ['research pass', 'research passes'];
    case 'search_memory': return ['memory search', 'memory searches'];
    case 'scrape_as_markdown': return ['page read', 'pages read'];
    case 'scrape_batch': return ['batch of pages read', 'batches of pages read'];
    case 'browser_task': return ['site browsed', 'sites browsed'];
    case 'read_file': return ['file read', 'files read'];
    case 'edit_file': return ['edit', 'edits'];
    case 'write_file': return ['file created', 'files created'];
    case 'run_command': return ['command', 'commands'];
    case 'grep': case 'glob': case 'search_code_semantic': case 'ast_search': return ['code search', 'code searches'];
    case 'ast_rewrite': return ['code rewrite', 'code rewrites'];
    case 'verify': return ['check', 'checks'];
    case 'delegate': case 'spawn_subagent': case 'delegate_parallel': return ['helper', 'helpers'];
    case 'gmail_search': return ['Gmail search', 'Gmail searches'];
    case 'drive_search': return ['Drive search', 'Drive searches'];
    case 'slack_search': return ['Slack search', 'Slack searches'];
    case 'asana_search': return ['Asana search', 'Asana searches'];
    case 'list_chats': case 'get_chat_status': case 'get_chat_messages': return ['chat lookup', 'chat lookups'];
    case 'list_schedules': case 'schedule_get': return ['schedule lookup', 'schedule lookups'];
    case 'get_fleet_telemetry': case 'get_platform_network_info': case 'list_infra_blockers': return ['platform check', 'platform checks'];
    default: {
      if (name.startsWith('github_')) return ['GitHub call', 'GitHub calls'];
      const human = name.replace(/_/g, ' ').trim() || 'action';
      return [human, human];
    }
  }
}

/**
 * One-line summary for the pill — plain English, per-kind counts, biggest
 * kinds first: "12 actions · 5 web searches · 3 memory searches · 4 pages
 * read" (top 3 kinds, then "…"). A tool_call and its tool_result are ONE
 * action: results are not counted twice.
 */
export function toolActivityLabel(names: string[], parts?: MessagePart[]): string {
  // De-duplicate call/result pairs when the caller hands us the parts (the
  // legacy signature passed names only — count every name then).
  const counted = parts
    ? names.filter((_, i) => parts[i]?.type !== 'tool_result')
    : names;
  const kinds = new Map<string, number>();
  for (const n of counted) kinds.set(n, (kinds.get(n) ?? 0) + 1);
  const total = counted.length;
  const top = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => {
      const [one, many] = toolKindNoun(n);
      return c === 1 ? `1 ${one}` : `${c} ${many}`;
    })
    .join(' · ');
  return `${total} action${total === 1 ? '' : 's'} · ${top}${kinds.size > 3 ? ' · …' : ''}`;
}


/**
 * Pair every tool_result with its tool_call (owner 2026-09-15, Level 2 live
 * feed): the Double Checker's calls interleave with Digby's on ONE stream, so
 * the renderer's old adjacency merge (parts[i+1] must be the result) rarely
 * matched — a call rendered as a card AND its late result rendered as a
 * second card. Each result now binds to the NEAREST EARLIER unpaired call
 * with the same tool name and, when both carry a seat `label`, the same seat.
 * Pure; indices refer to `parts`. Adjacent pairs bind exactly as before.
 */
export interface ToolPairing {
  /** tool_call index → its tool_result index. */
  resultFor: Map<number, number>;
  /** Every tool_result index that found a call (render nothing for it). */
  pairedResults: Set<number>;
}
export function pairToolActions(parts: MessagePart[]): ToolPairing {
  const resultFor = new Map<number, number>();
  const pairedResults = new Set<number>();
  const openCalls: number[] = [];
  const labelOf = (p: MessagePart): string => (typeof (p as any).label === 'string' ? String((p as any).label).trim() : '');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === 'tool_call') { openCalls.push(i); continue; }
    if (p.type !== 'tool_result') continue;
    const rl = labelOf(p);
    for (let k = openCalls.length - 1; k >= 0; k--) {
      const ci = openCalls[k];
      const c = parts[ci];
      if (c.name !== p.name) continue;
      const cl = labelOf(c);
      if (cl && rl && cl !== rl) continue;
      resultFor.set(ci, i);
      pairedResults.add(i);
      openCalls.splice(k, 1);
      break;
    }
  }
  return { resultFor, pairedResults };
}
