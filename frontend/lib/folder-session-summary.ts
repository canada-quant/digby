/**
 * Sidebar-folder session summary row (session titles + topology, deferred
 * piece shipped 2026-09-28): ONE compact line at the top of an EXPANDED
 * sidebar folder, computed from the same `GET /projects/:id/sessions` rows the
 * project page's Sessions tab renders — "2 running · 1 scheduled · last
 * receipt 12 m · $4.10 today". Pure: the page fetches, this module reduces.
 * A folder with no coding lanes (plain conversations only) yields null so the
 * sidebar shows nothing extra there.
 */
import type { ProjectSessionRow } from './api/crossmodel';
import { receiptAgeLabel } from './session-title';

export interface FolderSessionSummary {
  running: number;
  scheduled: number;
  idle: number;
  /** Seconds since the most recent receipt across the folder's lanes (null when none). */
  lastReceiptAgeSec: number | null;
  /** Sum of today's spend across the lanes (null when no row carried one). */
  spendTodayUsd: number | null;
  /** The rendered row, e.g. "2 running · 1 scheduled · last receipt 12 m · $4.10 today". */
  text: string;
}

/** Only lanes (chats with a workspace state or a supervisor role) count — a plain project chat never summarises. */
export function isSummaryLane(row: Pick<ProjectSessionRow, 'hasWorkspaceState' | 'isSupervisor' | 'status'>): boolean {
  return row.hasWorkspaceState === true || row.isSupervisor === true || row.status === 'running' || row.status === 'scheduled';
}

/** Reduce a folder's session rows to the summary row; null when the folder holds no lane (archived rows are ignored). */
export function summarizeFolderSessions(rows: readonly ProjectSessionRow[] | null | undefined): FolderSessionSummary | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  const lanes = rows.filter((r) => r && r.status !== 'archived' && isSummaryLane(r));
  if (!lanes.length) return null;
  let running = 0; let scheduled = 0; let idle = 0;
  let lastReceiptAgeSec: number | null = null;
  let spendTodayUsd: number | null = null;
  for (const r of lanes) {
    if (r.status === 'running') running++;
    else if (r.status === 'scheduled') scheduled++;
    else idle++;
    if (typeof r.lastReceiptAgeSec === 'number' && Number.isFinite(r.lastReceiptAgeSec)) {
      lastReceiptAgeSec = lastReceiptAgeSec === null ? r.lastReceiptAgeSec : Math.min(lastReceiptAgeSec, r.lastReceiptAgeSec);
    }
    if (typeof r.spendTodayUsd === 'number' && Number.isFinite(r.spendTodayUsd)) {
      spendTodayUsd = (spendTodayUsd ?? 0) + r.spendTodayUsd;
    }
  }
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (scheduled) parts.push(`${scheduled} scheduled`);
  if (!running && !scheduled) parts.push(`${idle} idle`);
  if (lastReceiptAgeSec !== null) parts.push(`last receipt ${receiptAgeLabel(lastReceiptAgeSec)}`);
  if (spendTodayUsd !== null && spendTodayUsd > 0) parts.push(`$${spendTodayUsd.toFixed(2)} today`);
  return { running, scheduled, idle, lastReceiptAgeSec, spendTodayUsd, text: parts.join(' · ') };
}

/** How long a fetched summary is reused before a re-expand refetches it. */
export const FOLDER_SESSION_SUMMARY_TTL_MS = 60_000;
