/**
 * ARTIFACT ATTRIBUTION (todo 13dfa16d, framework-audit monitor lesson 7) —
 * board artifacts are keyed by the work item they serve AT EVENT TIME, never
 * by the lane's CURRENT title at read time (a slowly-changing-dimension trap:
 * lane 5f90c628's title todo switched at 14:14:53Z 2026-10-16 and every later
 * digest then labelled PR #1590 — branch block-escalation-27c215d6, body
 * "Todo 27c215d6" — with the new title todo 908f48a7; baseline 7 of 24
 * checkable labels wrong, 6 false "merged/pushed on" sentences in 3 h).
 *
 * Event-sourcing rule: an event carries its context when written. The
 * git_push / open_pull_request / merge_pull_request tool results append a
 * short "— serves todo <prefix>" stamp; extractReceipt stores it in
 * ids.todoId / ids.ticketId; the wake ledger renders THAT stamp. The fixed
 * extraction order (Jira smart-commit / GitHub closing-keyword / Gerrit
 * Change-Id convention):
 *   (a) a work-item id in the branch name / PR body / commit message;
 *   (b) else the todo of the run's in-progress plan step;
 *   (c) else 'unattributed' — printed, never guessed.
 *
 * This module is a DEPENDENCY-FREE leaf: no prisma, no config/env reads for
 * the pure pieces (the env kill switch is a one-line literal read so the
 * switch-registry scanner still sees it in this file). Pure, deterministic,
 * never throws.
 */

import type { ToolReceipt } from './run-receipts';

/** One attribution decision — what matched and where (for the metric + tests). */
export interface ArtifactAttribution {
  /** Full work-item id ('todo …' / 'ticket …' / the sentinel 'unattributed'). */
  workItem: string;
  /** 8-char prefix every surface renders. */
  prefix: string;
  /** Which leg of the fixed order produced it. */
  source: 'branch' | 'body' | 'commit' | 'plan' | 'none';
}
/** The sentinel — printed, never guessed. */
export const UNATTRIBUTED = 'unattributed';

/** An 8+-hex work-item id (todo/ticket uuid head — the platform's own id shape). */
const WORK_ITEM_ID_RE = /\b(?:todo|ticket)\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4})/gi;
/** The stamp appended to the three artifact tool results: "— serves todo 27c215d6". */
export const SERVES_STAMP_RE = /— serves (todo|ticket) ([0-9a-f]{8})/i;

/**
 * The fleet's BRANCH-name convention: the work-item id as a hyphen-separated
 * SEGMENT — block-escalation-27c215d6, digby/learnings-954b7910, fix-36fe141e.
 * Scans segments right-to-left (a uuid's head segment is the id); exactly 8
 * hex (a shorter run is never an id; a longer bare run is a sha fragment).
 * The session namespace (digby/session-<chatid>) is a CHAT id, never a work
 * item — excluded.
 */
export function branchWorkItemId(branch: unknown): string | null {
  const last = String(branch ?? '').split('/').pop() ?? '';
  const segs = last.split('-');
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i].toLowerCase();
    if (i > 0 && segs[i - 1].toLowerCase() === 'session') continue; // digby/session-<chatid>
    if (/^[0-9a-f]{8}$/.test(seg)) return seg;
  }
  return null;
}

/** Kill switch: disables BOTH the stamping and the cross-check metric (one lever, the switch-registry row). */
export function artifactAttributionDisabled(): boolean {
  return process.env.ARTIFACT_ATTRIBUTION_DISABLED === '1';
}

/** Pure: the work-item ids a text names ("Todo 27c215d6", "ticket 2c203dac", "todo 13dfa16d-0c6d-…"). */
export function workItemIdsInText(text: unknown): string[] {
  const out: string[] = [];
  const t = String(text ?? '');
  for (const m of t.matchAll(WORK_ITEM_ID_RE)) {
    const id = m[1].toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * PURE leg (a): a work-item id the ARTIFACT ITSELF carries — the branch name
 * first, then the PR body, then the commit message. The branch wins because it
 * is the work's own identity (specimen: block-escalation-27c215d6). Only
 * 8-hex-or-longer runs count — a branch like "fix-27" never vouches an id.
 */
export function attributionFromArtifact(artifact: { branch?: unknown; body?: unknown; commitMessage?: unknown }): ArtifactAttribution | null {
  // Leg (a), field 1 — the BRANCH SEGMENT convention (the strongest signal:
  // block-escalation-27c215d6). Scanned before any keyword match.
  const branchId = branchWorkItemId(artifact.branch);
  if (branchId) {
    const kind = /ticket/i.test(String(artifact.branch ?? '')) ? 'ticket' : 'todo';
    return { workItem: `${kind} ${branchId.slice(0, 8)}`, prefix: branchId.slice(0, 8), source: 'branch' };
  }
  const SOURCE_OF_FIELD = { body: 'body', commitMessage: 'commit' } as const;
  for (const field of ['body', 'commitMessage'] as const) {
    const ids = workItemIdsInText(artifact[field]);
    if (ids.length) {
      const kind = /ticket/i.test(String(artifact[field] ?? '')) ? 'ticket' : 'todo';
      return { workItem: `${kind} ${ids[0].slice(0, 8)}`, prefix: ids[0].slice(0, 8), source: SOURCE_OF_FIELD[field] };
    }
  }
  return null;
}

/**
 * PURE leg (b): the todo the run's in-progress plan step names (the plan's own
 * naming convention — an id prefix or a full todo title, exactly the
 * lane-todos text matcher's inputs). Returns null when no in-progress step
 * names a todo (⇒ leg (c), never a guess).
 */
export function attributionFromPlan(
  plan: { steps?: Array<{ text?: unknown; note?: unknown; status?: unknown }> } | null | undefined,
  knownTodos: ReadonlyArray<{ id: string; title: string }> = [],
): ArtifactAttribution | null {
  const steps = Array.isArray(plan?.steps) ? plan!.steps! : [];
  const inProgress = steps.filter((s) => String(s?.status ?? '') === 'in_progress');
  for (const st of [...inProgress, ...steps]) {
    const text = `${String(st?.text ?? '')}\n${String(st?.note ?? '')}`;
    if (!text.trim()) continue;
    const byId = workItemIdsInText(text);
    if (byId.length) return { workItem: `todo ${byId[0]}`, prefix: byId[0].slice(0, 8), source: 'plan' };
    for (const t of knownTodos) {
      const title = String(t.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (title.split(' ').length >= 3 && text.toLowerCase().replace(/\s+/g, ' ').includes(title)) {
        return { workItem: `todo ${t.id}`, prefix: t.id.slice(0, 8), source: 'plan' };
      }
    }
  }
  return null;
}

/** The complete pure decision — legs (a) → (b) → (c), the fixed order. */
export function attributeArtifact(
  artifact: { branch?: unknown; body?: unknown; commitMessage?: unknown },
  plan: { steps?: Array<{ text?: unknown; note?: unknown; status?: unknown }> } | null | undefined,
  knownTodos: ReadonlyArray<{ id: string; title: string }> = [],
): ArtifactAttribution {
  return attributionFromArtifact(artifact) ?? attributionFromPlan(plan, knownTodos) ?? { workItem: UNATTRIBUTED, prefix: UNATTRIBUTED, source: 'none' };
}

/** The stamp the tool results append (≤ 30 chars): "— serves todo 27c215d6". */
export function servesStamp(a: ArtifactAttribution): string {
  return ` — serves ${a.workItem}`;
}

/**
 * PURE: the attribution a tool RESULT string's stamp carries ("— serves todo
 * 27c215d6" — the extractor's read-side). The id is the 8-hex prefix the stamp
 * renders; full ids ride the ids fields via attributionIds, this only proves
 * WHICH work item the event named. Null when the result carries no stamp
 * (legacy results, or the kill switch held at stamp time).
 */
export function attributionOfStampText(result: unknown): { workItem: string; prefix: string } | null {
  const m = String(result ?? '').match(SERVES_STAMP_RE);
  if (!m) return null;
  return { workItem: `${m[1].toLowerCase()} ${m[2].toLowerCase()}`, prefix: m[2].toLowerCase() };
}

/** The ids fields the receipt stores: { todoId?, ticketId?, workItemSource } (both fields from ONE decision). */
export function attributionIds(a: ArtifactAttribution): { todoId?: string; ticketId?: string; workItemSource: string } {
  const isTicket = a.workItem.startsWith('ticket ');
  const id = a.workItem.replace(/^(todo|ticket) /, '');
  return { [isTicket ? 'ticketId' : 'todoId']: id, workItemSource: a.source };
}

/** Pure: read the attribution back from a receipt's ids (render + cross-check side). */
export function attributionOfReceiptIds(ids: unknown): { workItem: string; prefix: string } | null {
  const x = ids && typeof ids === 'object' ? ids as Record<string, unknown> : {};
  const todoId = typeof x.todoId === 'string' ? x.todoId : null;
  const ticketId = typeof x.ticketId === 'string' ? x.ticketId : null;
  const id = todoId ?? ticketId;
  if (!id) return null;
  const kind = ticketId && !todoId ? 'ticket' : 'todo';
  return { workItem: `${kind} ${String(id).slice(0, 8)}`, prefix: String(id).slice(0, 8) };
}

// ── The deterministic cross-check (observe-only, the 6f8b52b7 / PR #1548 ladder) ──

/** One '<work-item> merged/landed/shipped' sentence a supervisor note offers. */
export interface AttributionClaimSentence {
  workItem: string;
  prefix: string;
  /** merged | landed | shipped */
  verb: string;
  phrase: string;
}

const ATTRIBUTION_VERBS = 'merged|landed|shipped';
/** "todo 27c215d6 merged", "27c215d6 is done — merged", "PR #1590 merged" (todo id must be near the verb). */
const CLAIM_SENTENCE_RE = new RegExp(
  `\\btodo\\s+([0-9a-f]{8})[0-9a-f-]*\\b[^.\\n]{0,120}\\b(?:${ATTRIBUTION_VERBS})\\b|\\b(?:${ATTRIBUTION_VERBS})\\b[^.\\n]{0,120}\\btodo\\s+([0-9a-f]{8})`,
  'gi',
);

/**
 * PURE: the '<todo> merged/landed/shipped' sentences a note offers. The gate is
 * the todo id + a mapped verb in the SAME sentence (leftmost verb wins; a
 * sentence with no mapped verb judges nothing — fail-open). Capped at 6.
 */
export function attributionClaimSentences(text: unknown): AttributionClaimSentence[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const out: AttributionClaimSentence[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(CLAIM_SENTENCE_RE)) {
    const prefix = String(m[1] ?? m[2] ?? '').toLowerCase();
    if (!prefix || seen.has(prefix)) continue;
    // The sentence the claim sits in (bounded scan to the nearest boundary).
    const at = m.index ?? 0;
    const s0 = Math.max(0, t.lastIndexOf('.', at) + 1, t.lastIndexOf('\n', at) + 1);
    const seMatch = t.slice(at).match(/[.!\n]/);
    const se = at + (seMatch ? (seMatch.index ?? 120) : 120);
    const sentence = t.slice(s0, se).trim();
    const verbMatch = sentence.match(new RegExp(`\\b(${ATTRIBUTION_VERBS})\\b`, 'i'));
    seen.add(prefix);
    out.push({ workItem: `todo ${prefix}`, prefix, verb: verbMatch ? verbMatch[1].toLowerCase() : 'merged', phrase: sentence.slice(0, 160) });
    if (out.length >= 6) break;
  }
  return out;
}

/** One cross-check mismatch: the sentence, the todo row it disagreed with, and the artifact truth (when one exists). */
export interface AttributionMismatch {
  prefix: string;
  claimedWorkItem: string;
  /** The todo row's status at check time. */
  todoStatus: string | null;
  /** The row's evidence text (does it name a PR?). */
  todoEvidence: string | null;
  /** The work item the PR/push receipt for this sentence was stamped with, when one exists. */
  stampedWorkItem: string | null;
  verb: string;
  phrase: string;
}

export interface TodoRowForCheck { id: string; status: string; evidence?: string | null }

/**
 * PURE: the disagreements — a '<todo> merged' sentence where (1) the todo row
 * is NOT done, or (2) the todo row's evidence names no PR number, or (3) a PR
 * receipt for the same sentence IS stamped with a DIFFERENT work item (the
 * #1590 specimen class: the sentence said todo 908f48a7, the PR served
 * 27c215d6). A claim with NO todo row at all is the phantom lane's own
 * business (mineBoardAssertions already convicts it) — not an attribution
 * mismatch. Observe-only caller.
 */
export function attributionMismatches(
  claims: ReadonlyArray<AttributionClaimSentence>,
  todoRows: ReadonlyArray<TodoRowForCheck>,
  stamped: ReadonlyArray<{ prNumber?: number | null; workItem: string }> = [],
): AttributionMismatch[] {
  const byPrefix = new Map(todoRows.map((r) => [r.id.slice(0, 8).toLowerCase(), r]));
  const out: AttributionMismatch[] = [];
  for (const c of claims) {
    const row = byPrefix.get(c.prefix);
    if (!row) continue; // phantom todo id — the board-assertion lane's business
    const stamp = stamped.find((s) => c.phrase.includes(`#${s.prNumber}`) && s.prNumber != null);
    const badStatus = row.status !== 'done';
    const badEvidence = !/PR\s*#?\d+/i.test(String(row.evidence ?? ''));
    const badStamp = stamp != null && stamp.workItem.replace(/^todo /, '').slice(0, 8) !== c.prefix;
    if (badStatus || badEvidence || badStamp) {
      out.push({
        prefix: c.prefix, claimedWorkItem: c.workItem,
        todoStatus: row.status ?? null, todoEvidence: row.evidence ? String(row.evidence).slice(0, 160) : null,
        stampedWorkItem: stamp ? stamp.workItem : null,
        verb: c.verb, phrase: c.phrase,
      });
    }
  }
  return out;
}

/** PURE: stamp→receipt lookup helper for the async checker — the receipts of the three artifact tools. */
export function stampedWorkItemsOf(receipts: ReadonlyArray<ToolReceipt>): Array<{ prNumber?: number | null; sha?: string; workItem: string }> {
  const out: Array<{ prNumber?: number | null; sha?: string; workItem: string }> = [];
  for (const r of receipts) {
    if (r.tool !== 'open_pull_request' && r.tool !== 'merge_pull_request' && r.tool !== 'git_push') continue;
    const a = attributionOfReceiptIds(r.ids);
    if (!a) continue;
    const x = (r.ids && typeof r.ids === 'object' ? r.ids : {}) as Record<string, unknown>;
    out.push({ prNumber: Number.isFinite(Number(x.prNumber)) ? Number(x.prNumber) : null, sha: typeof x.sha === 'string' ? x.sha : undefined, workItem: a.workItem });
  }
  return out.slice(0, 50);
}
