/**
 * Trajectory evals — the system prompt a trial runs under (build 2026-10-08 E-7).
 *
 * TODAY's doctrine, the CASE's frozen state: the role layers come from the
 * live builders (buildFleetSupervisorPrompt / buildProjectSupervisorPrompt),
 * the chat doctrine from chat-agent's own chatDoctrine, the shared rules and
 * platform identity from chat-context — so a doctrine ablation (a deleted
 * playbook row, a trimmed role layer) shows up in the live suite. The frozen
 * part is the case's `input.context` (the [SUPERVISOR STATE] / [BOARD] /
 * lane-status blocks the incident run actually carried) and its clock.
 *
 * Every live source is wrapped: a builder that throws (or is renamed by a
 * parallel change) degrades to the leaf playbook + the frozen context, and
 * the trial records which sources it used (`sources`).
 */

import type { TrajectoryCase } from './types';

export interface BuiltPrompt {
  doctrine: string;
  /** Which live sources made it into the doctrine (reported per trial). */
  sources: string[];
}

/** A [CURRENT DATE & TIME] block for the frozen clock (UTC + the case's local zone). */
export function frozenDateBlock(nowIso: string, tz?: string): string {
  const now = new Date(nowIso);
  const lines = [`[CURRENT DATE & TIME]`, `UTC: ${now.toISOString()}`];
  if (tz) {
    try {
      const local = now.toLocaleString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short' });
      lines.push(`User local time (${tz}): ${local}`);
    } catch { /* invalid tz → UTC only */ }
  }
  return lines.join('\n');
}

function tryRequire<T = any>(path: string): T | null {
  try { return require(path) as T; } catch { return null; }
}

/** The role's stored chat prompt (the supervisor scaffold), built by today's code. */
function roleStoredPrompt(c: TrajectoryCase, sources: string[]): string {
  if (c.role === 'fleet_supervisor') {
    const m = tryRequire<any>('../../platform/supervisor.service');
    try {
      const p = m?.buildFleetSupervisorPrompt?.();
      if (p) { sources.push('fleet_supervisor_prompt'); return p; }
    } catch { /* fall through */ }
  }
  if (c.role === 'project_supervisor') {
    const m = tryRequire<any>('../../platform/project-supervisor.service');
    try {
      const p = m?.buildProjectSupervisorPrompt?.({
        projectName: c.input.projectName || 'Project',
        projectId: c.input.projectId || '00000000-0000-4000-8000-000000000000',
        fleetSupervisorChatId: null,
      });
      if (p) { sources.push('project_supervisor_prompt'); return p; }
    } catch { /* fall through */ }
  }
  return '';
}

export function buildTrialPrompt(c: TrajectoryCase): BuiltPrompt {
  const sources: string[] = [];
  const isSupervisor = c.role === 'fleet_supervisor' || c.role === 'project_supervisor';
  const hasUser = c.role !== 'guest_chat';
  const machine = c.trigger === 'machine_wake';
  const chatId = c.input.chatId || `eval-${c.id}`;

  const ctxMod = tryRequire<any>('../../chat-agent/chat-context');
  const stored = roleStoredPrompt(c, sources);
  const systemContext = [
    frozenDateBlock(c.input.now, c.input.timezone),
    stored,
    c.input.context ?? '',
    ctxMod?.SHARED_AI_RULES ?? '',
    ctxMod?.DIGBY_PLATFORM_IDENTITY ?? '',
  ].filter((s) => s && s.trim()).join('\n\n');
  if (ctxMod?.DIGBY_PLATFORM_IDENTITY) sources.push('platform_identity');

  if (c.role === 'checker') {
    const scope = tryRequire<any>('../../chat-agent/cross-check-scope');
    const rule = (() => { try { return scope?.crossCheckVerifySilenceRule?.() ?? ''; } catch { return ''; } })();
    if (rule) sources.push('verify_silence_rule');
    return { doctrine: [rule, systemContext].filter(Boolean).join('\n\n'), sources };
  }

  const chatAgent = tryRequire<any>('../../chat-agent/chat-agent.service');
  if (typeof chatAgent?.chatDoctrine === 'function') {
    try {
      const doctrine = chatAgent.chatDoctrine({
        mode: 'thinking',
        systemContext,
        crossCheckBlock: '',
        deadlineNote: '',
        chatId,
        chatTitle: c.input.chatTitle ?? null,
        projectId: c.input.projectId ?? null,
        isSupervisor,
        hasUser,
        machine,
      });
      sources.push('chat_doctrine');
      return { doctrine, sources };
    } catch { /* fall through to the leaf playbook */ }
  }
  const leaf = tryRequire<any>('../../chat-agent/capability-doctrine');
  let playbook = '';
  try {
    playbook = leaf?.platformPlaybookBlock?.({ chatId, chatTitle: c.input.chatTitle ?? null, projectId: c.input.projectId ?? null, isSupervisor, hasUser }) ?? '';
    if (playbook) sources.push('playbook_leaf');
  } catch { /* none */ }
  return { doctrine: ['You are Digby, the AI assistant at digby.ai.', playbook, systemContext].filter(Boolean).join('\n\n'), sources };
}
