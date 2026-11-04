/**
 * Minimal view — the server-side filter (owner 2026-10-16, see view-mode.ts). A 'minimal' viewer never
 * RECEIVES the machinery; it is not merely hidden by the client. Applied at every seam a transcript leaves
 * the server: the stored-row reads (chat + coding session), the coding SSE tail/replay (createFrameWriter),
 * the chat re-attach (attachRunToResponse) and the chat agent's foreground stream.
 *
 * What a minimal viewer gets (Grok-Bot style):
 *  - their own messages and the replies written FOR them (human-turn answers, owner briefings, owner-armed
 *    digests, answers to their asks, delivered results, status cards);
 *  - tool activity as LABELS only — the tool name plus one short field (the command, the path, the query,
 *    the url, the name) — never arguments, never results;
 *  - a one-line note for an inter-agent message ("Message from <session>");
 *  - task cards without steps / receipts / spend / ETA.
 * What is withheld: machine wakes and the machine turns they open, system notices, harness chrome
 * (verification footers, claims manifests, evidence-guard notes, auto-verify lines), guard markers and
 * struck drafts, worker frames, plan cards, reasoning, model ids, token / cost figures, verify / loop /
 * process / context events.
 *
 * A hidden stored row is replaced by a STUB (same id / role / createdAt, empty content,
 * metadata.minimal.hidden) — never dropped — so client-side indexes, cursors and counts stay aligned.
 * Pure — no I/O.
 */

import { splitHarnessChrome } from './harness-chrome-split';

// ── Row classification (parity with frontend/lib/machine-wake.ts + machine-turn-grouping.ts) ─────────────

const WAKE_PREFIX = '[MACHINE-TRIGGERED RUN';
const AGENT_SEND_PREFIX = '[AGENT-SENT MESSAGE';
const WAKE_ORIGINS = ['schedule', 'hook', 'webhook'];
const SYSTEM_ORIGINS = ['machine', 'attention-watchdog', 'orphan-recovery', 'heartbeat'];
const MACHINE_STAMP_ORIGINS = ['schedule', 'hook', 'machine', 'agent', 'webhook'];
const ASSISTANT_CHROME_PREFIXES = ['[ACTION VERIFIER', '[HARNESS EVIDENCE GUARD', '[Owner inbox]'];
/** Assistant rows written FOR the person — visible even inside a machine turn. */
const OWNER_FACING_KINDS = new Set(['owner_briefing', 'owner_digest', 'deliverable_handoff', 'continuation_result', 'project_status', 'session_status']);
const OWNER_FACING_ORIGINS = new Set(['deliverable_handoff', 'project_status', 'session_status']);

type Row = { role?: unknown; content?: unknown; metadata?: any; parts?: unknown; [k: string]: unknown };

/** Row metadata, with the flattened fields some readers use (fleet thread rows carry origin/kind top-level). */
function md(row: Row): any {
  const flat: any = {};
  for (const k of ['origin', 'kind', 'ownerAskReply', 'scheduleOwnerArmed', 'childResult']) if (row[k] !== undefined) flat[k] = row[k];
  return row.metadata && typeof row.metadata === 'object' ? { ...flat, ...row.metadata } : flat;
}

function contentOf(row: Row): string {
  return typeof row.content === 'string' ? row.content : '';
}

export type UserRowKind = 'human' | 'wake' | 'agent' | 'system';

export function classifyUserRow(row: Row): UserRowKind {
  const c = contentOf(row);
  const origin = md(row).origin;
  if (c.startsWith(WAKE_PREFIX) || WAKE_ORIGINS.includes(origin)) return 'wake';
  if (origin === 'agent' || c.startsWith(AGENT_SEND_PREFIX)) return 'agent';
  if (SYSTEM_ORIGINS.includes(origin)) return 'system';
  return 'human';
}

/** The sender title of an inter-agent message ('[AGENT-SENT MESSAGE — from chat "<title>" (<id8>), …]'). */
export function agentSenderTitle(content: string): string | undefined {
  const m = content.match(/^\[AGENT-SENT MESSAGE — ([^\]\n]*)\]/);
  if (!m) return undefined;
  const t = m[1].match(/from chat "([^"]*)"/);
  // Harness titles are "<name> · <step>" ("crossmodel Supervisor · idle since 17:39Z") — the step half is the
  // sender's state when it sent, stale by the time anyone reads it. The minimal note names the sender only.
  const title = t?.[1]?.split(' · ')[0]?.trim();
  return title || undefined;
}

function isOwnerFacingAssistant(row: Row): boolean {
  const m = md(row);
  if (OWNER_FACING_KINDS.has(m.kind) || OWNER_FACING_ORIGINS.has(m.origin)) return true;
  if (m.ownerAskReply) return true;
  return false;
}

function isMachineAssistant(row: Row): boolean {
  const c = contentOf(row).trimStart();
  if (ASSISTANT_CHROME_PREFIXES.some(p => c.startsWith(p))) return true;
  const origin = md(row).origin;
  return typeof origin === 'string' && (MACHINE_STAMP_ORIGINS.includes(origin) || origin === 'owner-inbox');
}

/** A wake that opens a turn whose reply IS for the owner (owner-armed schedule, an owner ask). */
function wakeIsOwnerFacing(row: Row): boolean {
  const m = md(row);
  return m.scheduleOwnerArmed === true || m.ownerAskReply === true;
}

const CONTINUATION_MARKERS = ['[HARNESS CONTINUATION', '[RESUME AFTER PROVIDER LIMIT'];

function isContinuationWake(row: Row): boolean {
  const c = contentOf(row);
  return CONTINUATION_MARKERS.some(m => c.includes(m));
}

// ── Text ───────────────────────────────────────────────────────────────────────────────────────────────

const WITHHELD_LINE = 'This update was withdrawn.';
const HARNESS_NOTE_RE = /(?:^|\n\n)⏳ HARNESS NOTE:[\s\S]*?(?=\n\n|$)/g;

/** Strip harness chrome from an assistant text: footers, manifests, guard notes, auto-verify, backstop notes. */
export function minimalText(text: string): string {
  if (!text) return text;
  const lead = text.trimStart();
  if (lead.startsWith('[HARNESS EVIDENCE GUARD —') || lead.startsWith('[ACTION VERIFIER —')) return WITHHELD_LINE;
  let body = splitHarnessChrome(text).body;
  body = body.replace(HARNESS_NOTE_RE, '').trim();
  return body;
}

// ── Tool labels ────────────────────────────────────────────────────────────────────────────────────────

/** The ONLY argument fields a minimal viewer receives — one short label per call. */
const LABEL_KEYS = ['command', 'cmd', 'path', 'file', 'filePath', 'file_path', 'query', 'q', 'url', 'title', 'name', 'label', 'pattern', 'task'];
const LABEL_MAX = 160;

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one;
}

/** Reduce tool-call arguments to at most one short label field. */
export function minimalToolArgs(args: unknown): Record<string, string> {
  let a: any = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return {}; } }
  if (!a || typeof a !== 'object') return {};
  for (const k of LABEL_KEYS) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return { [k]: clip(v) };
    if (Array.isArray(v) && typeof v[0] === 'string') return { [k]: clip(v.slice(0, 3).join(', ')) };
  }
  // A schedule's prompt opens with its short name (offers doctrine: "Name: Flintstones counsel email watch") —
  // only that first line is the label, never the instruction body.
  if (typeof a.prompt === 'string' && a.prompt.trim()) {
    const first = a.prompt.trim().split('\n')[0].replace(/^\s*(?:name|title)\s*:\s*/i, '').replace(/[*_#`]/g, '').trim();
    if (first) return { name: first.length > 60 ? `${first.slice(0, 59)}…` : first };
  }
  return {};
}

/** Tool calls that never show as a row (internal bookkeeping). */
const SILENT_TOOLS = new Set(['update_plan', 'todo_write', 'think', 'load_tools', 'list_tool_groups', 'load_tool_group']);

// ── Task cards ─────────────────────────────────────────────────────────────────────────────────────────

export function minimalTask<T extends Record<string, unknown>>(task: T): T {
  if (!task || typeof task !== 'object') return task;
  const { etaText: _eta, ...rest } = task as any;
  return { ...rest, steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0 } as T;
}

// ── Parts ──────────────────────────────────────────────────────────────────────────────────────────────

export function minimalParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) return parts;
  const out: any[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const type = (p as any).type;
    if (type === 'reasoning' || type === 'subagent') continue;
    if (type === 'text') {
      if ((p as any).marker || (p as any).struck) continue;
      const text = typeof (p as any).text === 'string' ? (p as any).text : '';
      if (text.startsWith('↳ steering:')) continue;
      const t = minimalText(text);
      if (t) out.push({ ...p, text: t });
      continue;
    }
    if (type === 'tool_call') {
      if (SILENT_TOOLS.has((p as any).name)) continue;
      out.push({ type: 'tool_call', name: (p as any).name, args: minimalToolArgs((p as any).args), ...((p as any).ts ? { ts: (p as any).ts } : {}) });
      continue;
    }
    if (type === 'tool_result') {
      if (SILENT_TOOLS.has((p as any).name)) continue;
      out.push({ type: 'tool_result', name: (p as any).name, result: '', ...((p as any).ts ? { ts: (p as any).ts } : {}) });
      continue;
    }
    if (type === 'task') {
      out.push({ ...p, task: minimalTask((p as any).task) });
      continue;
    }
    out.push(p); // image and future part types
  }
  return out;
}

// ── Metadata ───────────────────────────────────────────────────────────────────────────────────────────

/** Metadata keys a minimal viewer never receives (models, spend, tokens, receipts, harness bookkeeping). */
const METADATA_DROP = [
  'model', 'modelUsed', 'modelSource', 'leadModel', 'usage', 'tokens', 'tokensIn', 'tokensOut',
  'spendUsd', 'costUsd', 'cost', 'receipts', 'receiptIds', 'guard', 'guardNotes', 'verify', 'claims',
  'evidence', 'runId', 'turnPlan', 'workers',
];

function minimalMetadata(md: any): any {
  if (!md || typeof md !== 'object') return md;
  const out: any = { ...md };
  for (const k of METADATA_DROP) delete out[k];
  // Per-model cards keep ONE fact a user surface reads (Digby Kids' "I looked it up on the web" line) — never the
  // model, the response or the timing.
  if (out.models && typeof out.models === 'object') {
    const slim: Record<string, { webSearchUsed?: boolean }> = {};
    for (const [k, v] of Object.entries(out.models as Record<string, any>)) {
      slim[k] = v && typeof v === 'object' && typeof v.webSearchUsed === 'boolean' ? { webSearchUsed: v.webSearchUsed } : {};
    }
    out.models = slim;
  }
  if (out.task && typeof out.task === 'object') out.task = minimalTask(out.task);
  if (out.depth && typeof out.depth === 'object') {
    // The client reads only depth.plan (lane / preset / spawnChecker — Dig deeper and the check pill); team names the
    // seats' models ("Standard · glm-5.3"), facts / budget are harness bookkeeping (prod check 2026-10-16).
    const { turnPlan: _tp, models: _m, team: _t, facts: _f, budget: _b, ...depth } = out.depth;
    out.depth = depth;
  }
  return out;
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────────────────────

function stub<T extends Row>(row: T, minimal: Record<string, unknown>): T {
  const keep: Record<string, unknown> = {};
  for (const k of ['id', 'role', 'createdAt', 'timestamp', 'sessionId', 'chatId', 'seq']) {
    if (row[k] !== undefined) keep[k] = row[k];
  }
  return { ...keep, content: '', ...(Array.isArray(row.parts) ? { parts: [] } : {}), minimal, metadata: { minimal } } as unknown as T;
}

/**
 * A watch's quiet firing (offers doctrine QUIET_RUN_REPLY, chat-agent/capability-doctrine.ts — keep in step):
 * "Quiet days, you won't hear from me." A minimal viewer never sees it.
 */
const QUIET_RUN_REPLY_RE = /^\s*nothing new\.?\s*$/i;

function isQuietReply(row: Row): boolean {
  return QUIET_RUN_REPLY_RE.test(contentOf(row));
}

function keepAssistant<T extends Row>(row: T): T {
  const next: any = { ...row };
  if (typeof row.content === 'string') next.content = minimalText(row.content);
  if (Array.isArray(row.parts)) next.parts = minimalParts(row.parts);
  if (row.metadata) next.metadata = minimalMetadata(row.metadata);
  return next;
}

/**
 * Minimal transcript: same length, same order. Machine user rows and the machine turns they open become
 * hidden stubs; an inter-agent message becomes a one-line note; kept assistant rows lose their chrome.
 */
export function minimalMessages<T extends Row>(rows: T[]): T[] {
  if (!Array.isArray(rows)) return rows;
  let inMachineTurn = false;
  let turnOwnerFacing = false;
  // A background continuation of the person's OWN ask (the harness finishing it after the turn ended) is theirs:
  // it stays visible while the chain since their last message is unbroken by any other machine turn.
  let humanChain = false;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.role === 'user') {
      const kind = classifyUserRow(row);
      if (kind === 'human') { inMachineTurn = false; turnOwnerFacing = false; humanChain = true; return row; }
      inMachineTurn = true;
      const continuation = kind === 'wake' && isContinuationWake(row);
      if (!continuation) humanChain = false;
      turnOwnerFacing = kind === 'wake' && (wakeIsOwnerFacing(row) || (continuation && humanChain));
      if (kind === 'agent') {
        const from = agentSenderTitle(contentOf(row));
        return stub(row, { note: 'message_from', label: from || 'another session' });
      }
      return stub(row, { hidden: true });
    }
    if (row.role === 'assistant') {
      if (inMachineTurn && isQuietReply(row)) return stub(row, { hidden: true });
      if (isOwnerFacingAssistant(row)) return keepAssistant(row);
      if (isMachineAssistant(row) || inMachineTurn) {
        return turnOwnerFacing && !isMachineAssistant(row) ? keepAssistant(row) : stub(row, { hidden: true });
      }
      return keepAssistant(row);
    }
    // system / tool rows: never shown to a minimal viewer
    return stub(row, { hidden: true });
  });
}

// ── Stream events ──────────────────────────────────────────────────────────────────────────────────────

/** Event types a minimal viewer never receives. */
const DROP_EVENTS = new Set([
  'guard_marker', 'subagent_start', 'subagent_end', 'verify_start', 'verify_result', 'context', 'loop_update',
  'process_update', 'reasoning', 'subagent:reasoning', 'thinking-summary', 'run_spend', 'receipt', 'receipts',
  'tool_groups',
]);

/**
 * Filter one stream event for a minimal viewer: null ⇒ do not send; otherwise the (possibly reduced) payload.
 * Unknown event types pass through unchanged (they are UI plumbing — replay markers, progress, titles).
 */
export function minimalEvent(type: string, data: any): { type: string; data: any } | null {
  if (DROP_EVENTS.has(type)) return null;
  switch (type) {
    case 'tool_call':
      if (SILENT_TOOLS.has(data?.name)) return null;
      return { type, data: { name: data?.name, args: minimalToolArgs(data?.args) } };
    case 'tool_result':
      if (SILENT_TOOLS.has(data?.name)) return null;
      return { type, data: { name: data?.name, result: '' } };
    case 'text':
      return { type, data };
    case 'init': {
      if (!data || typeof data !== 'object') return { type, data };
      const { model: _m, modelSource: _s, models: _ms, leadModel: _l, ...rest } = data;
      return { type, data: rest };
    }
    case 'complete': {
      if (!data || typeof data !== 'object') return { type, data };
      const next: any = minimalMetadata(data);
      if (typeof data.finalText === 'string') next.finalText = minimalText(data.finalText);
      if (typeof data.summary === 'string') next.summary = minimalText(data.summary);
      if (Array.isArray(data.parts)) next.parts = minimalParts(data.parts);
      return { type, data: next };
    }
    case 'task':
      return { type, data: minimalTask(data) };
    case 'permission_request':
      return { type, data: { ...data, args: minimalToolArgs(data?.args) } };
    case 'agent-activity': {
      if (data?.kind === 'reasoning' || data?.kind === 'sub_start' || data?.kind === 'sub_end') return null;
      if (data?.kind === 'tool' || data?.kind === 'tool_done') {
        // `detail` is the chat adapter's short query / url / task snippet — the row's label, clipped.
        const { args: _a, result: _r, output: _o, detail: _d, model: _m, ...rest } = data;
        return {
          type,
          data: {
            ...rest,
            ...(typeof data.detail === 'string' && data.detail.trim() ? { detail: clip(data.detail) } : {}),
            ...(data.args !== undefined ? { args: minimalToolArgs(data.args) } : {}),
          },
        };
      }
      const { model: _m, ...rest } = data || {};
      return { type, data: rest };
    }
    case 'model-response':
      // The per-model drafts (Double Checker, council) never reach a minimal viewer.
      return null;
    case 'browser_observation':
    case 'browser-observation':
    case 'computer-observation': {
      const { reasoning: _r, ...rest } = data || {};
      return { type, data: rest };
    }
    default:
      return { type, data };
  }
}

// ── DTOs ───────────────────────────────────────────────────────────────────────────────────────────────

/** A chat DTO for a minimal viewer: minimal transcript; a supervisor's doctrine prompt and seat stay home. */
export function minimalChatDto<T extends Record<string, any>>(chat: T): T {
  const next: any = { ...chat };
  if (Array.isArray(chat.messages)) next.messages = minimalMessages(chat.messages);
  delete next.leadModel;
  if (chat.isSupervisor || chat.isProjectSupervisor) delete next.systemPrompt;
  return next;
}
