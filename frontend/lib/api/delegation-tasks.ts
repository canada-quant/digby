/**
 * Account → Admin → Jobs → "Delegation ledger" — API client (build 2026-10-08 D).
 * Admin-only, read-only view of the SHADOW delegation task ledger and the
 * tool-intent journal (backend platform/delegation-tasks.controller.ts). Nothing
 * reads the ledger to decide anything yet — this is its measurement window.
 */
import apiClient from '../api-client';

export const DELEGATION_KINDS = ['session', 'message_ask', 'ticket', 'background_worker', 'schedule_firing', 'continuation'] as const;
export const DELEGATION_STATES = ['submitted', 'working', 'input_required', 'completed', 'failed', 'canceled'] as const;

export interface DelegationTaskRow {
  id: string;
  kind: string;
  source: string;
  state: string;
  stale: boolean;
  parentChatId: string | null;
  childChatId: string | null;
  childRef: string | null;
  projectId: string | null;
  brief: string | null;
  origin: string | null;
  duplicateOfId: string | null;
  artifactCount: number;
  eventCount: number;
  resultRef: string | null;
  reason: string | null;
  createdAt: string | null;
  lastEventAt: string | null;
  completedAt: string | null;
}

export interface DelegationSummary {
  hours: number;
  total: number;
  byKind: Record<string, Record<string, number>>;
  open: number;
  stale: number;
  duplicateKeys: number;
}

export interface ToolIntentSummary {
  hours: number;
  total: number;
  byState: Record<string, number>;
  byVerdict: Record<string, number>;
  byTool: Record<string, number>;
  orphanPending: number;
}

export interface MetricReadout { at: string; value: number | null; meta: Record<string, unknown> | null }

export interface DelegationLedgerData {
  summary: DelegationSummary;
  tasks: DelegationTaskRow[];
  toolIntents: ToolIntentSummary;
  lastReconcile: MetricReadout | null;
  lastIntentDaily: MetricReadout | null;
}

export interface DelegationLedgerFilter { kind?: string; state?: string; chatId?: string; stale?: boolean; hours?: number; limit?: number }

export const delegationTasksApi = {
  async list(f: DelegationLedgerFilter = {}): Promise<DelegationLedgerData> {
    const params: Record<string, string> = {};
    if (f.kind) params.kind = f.kind;
    if (f.state) params.state = f.state;
    if (f.chatId) params.chatId = f.chatId;
    if (f.stale) params.stale = '1';
    if (f.hours) params.hours = String(f.hours);
    if (f.limit) params.limit = String(f.limit);
    const res = await apiClient.get('/crossmodel/admin/delegation-tasks', { params });
    return res.data.data;
  },
};

/** Pure: the summary's terminal agreement readout line ("—" before the first nightly reconcile). */
export function reconcileLine(r: MetricReadout | null): string {
  if (!r || !r.meta) return 'No nightly reconcile yet — it runs once a day.';
  const m = r.meta as Record<string, unknown>;
  const pct = typeof m.agreementPct === 'number' ? `${m.agreementPct}%` : '—';
  return `Agreement ${pct} over ${Number(m.checked ?? 0)} tasks · missing parent ${Number(m.missingParent ?? 0)} · missing rows ${Number(m.missingRows ?? 0)} · stale ${Number(m.stale ?? 0)}`;
}
