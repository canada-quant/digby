/**
 * "How Digby answered" — the transparency pill + disclosure under every
 * assistant answer (Digby Frontier redesign, 2026-10-06). Replaces the depth
 * pill + the admin-only "More info" toggle with ONE pill whose label carries
 * the check state ("Checked by 2 models", "Checking…", "Updated · 1
 * correction", "Quick answer", "Check didn't finish · Retry") and expands to
 * one row per SEAT that worked on the answer: number · seat name · role · a
 * one-line note · time. Model ids (Geist Mono) are ADMIN-ONLY (owner,
 * 2026-10-06: "how Digby answered shouldn't show model names whatsoever, only
 * to admin") — everyone else sees seat names (Digby, Double Checker) only.
 *
 * Pure — no React — so the rows and labels are pinned in node vitest.
 */
import type { PillState } from '@/lib/depth-ux';

export const SEAT_NAMES: Record<SeatKey, string> = {
  digby: 'Digby',
  double_checker: 'Double Checker',
  triple_checker: 'Triple Checker',
};

export type SeatKey = 'digby' | 'double_checker' | 'triple_checker';

/** Legacy transcripts keyed cards by vendor; map them onto their seat. */
const LEGACY_SEAT: Record<string, SeatKey> = {
  digby: 'digby', kimi: 'digby',
  double_checker: 'double_checker', deepseek: 'double_checker',
  triple_checker: 'triple_checker', glm: 'triple_checker',
};
const SEAT_ORDER: SeatKey[] = ['digby', 'double_checker', 'triple_checker'];

export interface ModelResponseLike {
  response?: string;
  time?: number;
  error?: string;
  modelUsed?: string;
  model?: string;
  webSearchUsed?: boolean;
  toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
}

export interface TransparencyMetaInput {
  models?: Record<string, unknown>;
  modelLabels?: Record<string, string>;
  mode?: string;
  totalTime?: number;
  revision?: { reason?: string; checkerTimeMs?: number } | null;
  crossCheck?: { outcome?: string; checkerTimeMs?: number } | null;
  depth?: { plan?: { spawnChecker?: boolean; lane?: string; preset?: string } };
}

export interface HowRow {
  /** The models-map key this row came from (admin drill-down). */
  key: string;
  seat: SeatKey;
  n: number;
  name: string;
  role: string;
  note: string;
  /** "kimi-k3 · web search" — admins only (`showModels`); undefined otherwise. */
  model?: string;
  /** "8.4s" */
  time?: string;
  response?: ModelResponseLike;
}

const SEARCH_TOOLS = /search|scrape|browse|fetch|web/i;

function fmtSecs(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return `${(ms / 1000).toFixed(1)}s`;
}

function firstSentence(text?: string, max = 140): string {
  if (!text) return '';
  const clean = text
    .replace(/^<think>[\s\S]*?<\/think>\s*/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(clean);
  const s = m ? m[1] : clean;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function searchCount(r?: ModelResponseLike): number {
  return (r?.toolCalls ?? []).filter((t) => SEARCH_TOOLS.test(t.name)).length;
}

function leadNote(r?: ModelResponseLike, webSearchConfigured = true): string {
  if (r?.error) return "Couldn't finish this part.";
  const n = searchCount(r);
  // Self-host setup hardening (2026-10-20): on an instance with no search backend
  // a search tool call returned the honest "not configured" text, not results —
  // "Searched the web once" would be a lie.
  if (!webSearchConfigured) return n > 0 ? 'Tried a web search, but web search is not set up on this instance.' : 'Answered without a web search (not set up on this instance).';
  if (n > 0) return `Searched the web ${n === 1 ? 'once' : `${n} times`} before answering.`;
  if (r?.webSearchUsed) return 'Searched the web before answering.';
  // Never echo the role line ("wrote the answer") — say what is informative.
  return 'Answered without a web search.';
}

function checkerNote(state: PillState, meta: TransparencyMetaInput, r?: ModelResponseLike): string {
  if (r?.error) return "Didn't finish reviewing.";
  switch (state?.kind) {
    case 'checking': return 'Still reviewing the answer…';
    case 'interrupted': return "Didn't finish reviewing.";
    case 'updated': {
      const n = state.changed.length;
      if (n === 0) return meta.revision?.reason ? `Revised the answer: ${firstSentence(meta.revision.reason, 120)}` : 'Revised the answer.';
      return `Made ${n} ${n === 1 ? 'correction' : 'corrections'}: ${state.changed.slice(0, 2).join('; ')}${n > 2 ? '…' : ''}`;
    }
    case 'checked': return 'Agreed with the answer.';
  }
  if (meta.crossCheck?.outcome === 'unchanged') return 'Agreed with the answer.';
  const s = firstSentence(r?.response);
  return s || 'Reviewed the answer.';
}

function modelLine(r?: ModelResponseLike): string | undefined {
  const id = (r?.modelUsed || r?.model || '').trim();
  const web = searchCount(r) > 0 || !!r?.webSearchUsed;
  if (!id) return web ? 'web search' : undefined;
  return web ? `${id} · web search` : id;
}

/**
 * One row per seat that worked on the answer, in seat order. Rows come from
 * `metadata.models` (seat or legacy vendor keys); with no models map, the
 * depth plan still yields the lead (+ the checker when one ran) so the panel
 * is never empty for a checked answer.
 */
export function buildHowRows(
  meta: TransparencyMetaInput | undefined,
  state: PillState,
  opts: { showModels?: boolean; /** false on an instance with no search backend (self-host setup hardening 2026-10-20). */ webSearchConfigured?: boolean } = {},
): HowRow[] {
  const showModels = opts.showModels === true;
  const webSearchConfigured = opts.webSearchConfigured !== false;
  const models = (meta?.models && typeof meta.models === 'object') ? meta.models : {};
  const bySeat = new Map<SeatKey, { key: string; r: ModelResponseLike }>();
  for (const [key, val] of Object.entries(models)) {
    const seat = LEGACY_SEAT[key];
    if (!seat || bySeat.has(seat) || !val || typeof val !== 'object') continue;
    bySeat.set(seat, { key, r: val as ModelResponseLike });
  }
  if (bySeat.size === 0 && meta) {
    // No per-model map (non-admin payloads / older rows): derive from the plan.
    bySeat.set('digby', { key: 'digby', r: {} });
    const checkerRan = state?.kind === 'checked' || state?.kind === 'updated' || state?.kind === 'checking' || state?.kind === 'interrupted'
      || meta.depth?.plan?.spawnChecker === true;
    if (checkerRan) bySeat.set('double_checker', { key: 'double_checker', r: { time: meta.crossCheck?.checkerTimeMs ?? meta.revision?.checkerTimeMs } });
  }
  const rows: HowRow[] = [];
  for (const seat of SEAT_ORDER) {
    const hit = bySeat.get(seat);
    if (!hit) continue;
    const lead = seat === 'digby';
    rows.push({
      // The models-map key can be a legacy vendor name — non-admins get the seat.
      key: showModels ? hit.key : seat,
      seat,
      n: rows.length + 1,
      // modelLabels can carry a vendor name — admins only; everyone else
      // sees the fixed seat name.
      name: (showModels && (meta?.modelLabels?.[hit.key] || meta?.modelLabels?.[seat])) || SEAT_NAMES[seat],
      role: lead ? 'wrote the answer' : 'reviewed it',
      note: lead ? leadNote(hit.r, webSearchConfigured) : checkerNote(state, meta ?? {}, hit.r),
      model: showModels ? modelLine(hit.r) : undefined,
      time: fmtSecs(hit.r.time),
      response: hit.r,
    });
  }
  return rows;
}

export type PillTone = 'ok' | 'spin' | 'updated' | 'quick' | 'warn' | 'neutral';

/**
 * The pill's label + tone. `seats` = how many seats worked on the answer;
 * `open` swaps the label for "Hide how Digby answered". Null = no pill
 * (nothing harness-given to say and no seat rows).
 */
export function transparencyLabel(state: PillState, seats: number, open: boolean): { label: string; tone: PillTone } | null {
  if (open) return { label: 'Hide how Digby answered', tone: state?.kind === 'checking' ? 'spin' : state?.kind === 'interrupted' ? 'warn' : state?.kind === 'updated' ? 'updated' : state?.kind === 'quick' ? 'quick' : seats > 1 ? 'ok' : 'neutral' };
  switch (state?.kind) {
    case 'checking': return { label: 'Checking…', tone: 'spin' };
    case 'checked': return { label: `Checked by ${Math.max(seats, 2)} models`, tone: 'ok' };
    case 'updated': {
      const n = state.changed.length;
      return { label: n > 0 ? `Updated · ${n} ${n === 1 ? 'correction' : 'corrections'}` : 'Updated', tone: 'updated' };
    }
    case 'quick': return { label: 'Quick answer', tone: 'quick' };
    case 'interrupted': return { label: "Check didn't finish · Retry", tone: 'warn' };
  }
  if (seats > 1) return { label: `Checked by ${seats} models`, tone: 'ok' };
  if (seats === 1) return { label: 'How Digby answered', tone: 'neutral' };
  return null;
}
