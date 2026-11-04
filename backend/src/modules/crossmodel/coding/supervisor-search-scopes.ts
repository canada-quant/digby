/**
 * search_memory on a SUPERVISOR chat (2026-10-22, fs-durable-memory — the
 * owner's "the fleet supervisor doesn't fully have the context and memory of
 * everything").
 *
 * The chat agent runs every projectless chat with the placeholder projectId
 * 'chat' (chat-agent.service: `ctx.projectId || 'chat'`). On the Fleet
 * Supervisor that made search_memory ask for project 'chat' — a scope that
 * never passes the project gate — and, because the id was truthy, it also
 * hid the honest "no project context" note. Meanwhile the two stores that
 * hold what the owner told the supervisor were never searched:
 *   - the chat scope, where supervisor-state-memory mirrors every live and
 *     archived directive / owner ask and every dispatch (source
 *     'supervisor_state');
 *   - the owner's user scope 'conversation' distills of THIS chat (ref = the
 *     chat id — memory.graph distillConversationToUnifiedMemory).
 *
 * This leaf decides, from facts the caller already holds, what the tool
 * searches. Pure; the tool reads the supervisor flag (one row) and passes it
 * in. Every scope still goes through the per-user gate (memSearchForUser):
 * the user scope is only ever the caller's own id, the chat scope only a chat
 * the caller owns or may read through its project.
 *
 * Kill switch SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED=1 restores the old
 * search (the 'chat' placeholder project, session scope only).
 */

export function supervisorSearchMemoryScopesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED === '1';
}

/**
 * The ledger's memory mirror is switched off (SUPERVISOR_STATE_MEMORY_DISABLED=1
 * — the same literal supervisor-state-memory reads; this leaf imports nothing):
 * the chat scope then holds only what was mirrored before the switch, so it is
 * not searched and the coverage note says so (review 2026-10-23).
 */
export function supervisorLedgerMirrorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPERVISOR_STATE_MEMORY_DISABLED === '1';
}

/** search_memory can reach the supervisor ledger (the mirror writes AND the supervisor scopes are on). Pure. */
export function supervisorLedgerSearchable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !supervisorLedgerMirrorDisabled(env) && !supervisorSearchMemoryScopesDisabled(env);
}

/** The chat agent's projectless placeholder (chat-agent.service `ctx.projectId || 'chat'`). */
export const CHAT_PLACEHOLDER_PROJECT_ID = 'chat';

export interface SearchMemoryScopePlan {
  /** The project to search — the 'chat' placeholder dropped on a supervisor chat. */
  projectId: string | undefined;
  /** The supervisor's own chat scope (supervisor_state mirror rows). */
  chatScopeId?: string;
  /** The ref of the caller's own user-scope conversation distills to search (= this chat id). */
  conversationRef?: string;
  /** True when the supervisor scopes apply. */
  supervisor: boolean;
  /** Set when the ledger mirror is switched off — the chat scope is NOT searched (and the note says so). */
  ledgerUnmirrored?: true;
}

/** Should the tool read the supervisor flag at all? (skips the row read for anonymous runs and when the switch is off). Pure. */
export function supervisorSearchMemoryEligible(input: { sessionId?: string; userId?: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (supervisorSearchMemoryScopesDisabled(env)) return false;
  const userId = String(input.userId ?? '').trim();
  return !!String(input.sessionId ?? '').trim() && !!userId && userId !== 'anonymous';
}

/** What search_memory searches for this run. Pure. */
export function planSearchMemoryScopes(
  input: { sessionId: string; projectId?: string; userId?: string; supervisorChat: boolean },
  env: NodeJS.ProcessEnv = process.env,
): SearchMemoryScopePlan {
  if (!input.supervisorChat || !supervisorSearchMemoryEligible(input, env)) return { projectId: input.projectId, supervisor: false };
  const projectId = input.projectId && input.projectId !== CHAT_PLACEHOLDER_PROJECT_ID ? input.projectId : undefined;
  if (supervisorLedgerMirrorDisabled(env)) return { projectId, conversationRef: input.sessionId, supervisor: true, ledgerUnmirrored: true };
  return { projectId, chatScopeId: input.sessionId, conversationRef: input.sessionId, supervisor: true };
}

const LEDGER_UNMIRRORED_NOTE = 'your supervisor-state ledger — its search mirror is switched off, so search_memory holds no current copy of it; read it with get_supervisor_state';

/** digby_memory source of the supervisor-state mirror rows (supervisor-state-memory SUPERVISOR_STATE_MEM_SOURCE — literal here: this leaf imports nothing). */
export const LEDGER_SOURCE = 'supervisor_state';
/** digby_memory source of the conversation distills (coding-retrieval CONVERSATION_SOURCE). */
export const CONVERSATION_DISTILL_SOURCE = 'conversation';
/** digby_memory source of the project knowledge base (coding-retrieval KNOWLEDGE_BASE_SOURCE). */
export const DOCUMENT_SOURCE = 'document';

/**
 * The honest coverage note appended to a supervisor's search_memory answer
 * (and its empty result) — says what WAS searched, so an empty answer never
 * reads as "nothing was ever said". '' for scope 'project'.
 *
 * `sources` is the tool's source filter (review 2026-10-22): searchMemory
 * applies it to every leg, so a filter that excludes 'supervisor_state' never
 * reaches a ledger row and one that excludes 'conversation' skips the
 * past-exchange leg entirely (coding-retrieval wantsConversation) — the note
 * then lists ONLY the stores the filter let through and names the rest as NOT
 * searched, never the unfiltered set. Pure.
 */
export function supervisorSearchCoverageNote(plan: SearchMemoryScopePlan, scope: 'session' | 'project' | 'all', sources?: ReadonlyArray<string> | null): string {
  if (!plan.supervisor || scope === 'project') return '';
  const filter = (sources ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!filter.length) {
    const project = plan.projectId
      ? (scope === 'all' ? ' and this project\'s knowledge (documents, decisions, learnings, code index)' : '')
      : ' (no project knowledge — this supervisor chat has no project)';
    if (plan.ledgerUnmirrored) {
      return ` (NOTE: searched this run's findings and the summaries of your past exchanges with the owner in this chat${project}. NOT searched: ${LEDGER_UNMIRRORED_NOTE}. For the exact words of a message use get_chat_messages.)`;
    }
    return ` (NOTE: searched this run's findings, your supervisor-state ledger — live AND archived directives, owner asks and dispatches — and the summaries of your past exchanges with the owner in this chat${project}. For the exact words of a message use get_chat_messages.)`;
  }
  const lets = (src: string) => filter.includes(src);
  const label = filter.map((x) => `'${x}'`).join(' / ');
  const searched: string[] = ["this run's findings"];
  const skipped: string[] = [];
  const ledger = 'your supervisor-state ledger — live and archived directives, owner asks and dispatches';
  const past = 'the summaries of your past exchanges with the owner in this chat';
  if (plan.chatScopeId) (lets(LEDGER_SOURCE) ? searched : skipped).push(ledger);

  if (plan.conversationRef) (lets(CONVERSATION_DISTILL_SOURCE) ? searched : skipped).push(past);
  if (plan.projectId && scope === 'all') {
    searched.push(`this project's knowledge (source ${label} rows of its decisions, learnings and code index)`);
    if (!lets(DOCUMENT_SOURCE)) skipped.push("this project's knowledge-base documents");
  }
  const noProject = plan.projectId ? '' : ' This supervisor chat has no project, so no project knowledge exists to search.';
  const unmirrored = plan.ledgerUnmirrored ? ` NOT searched: ${LEDGER_UNMIRRORED_NOTE}.` : '';
  return ` (NOTE: source ${label} filter — searched only rows of that source in: ${searched.join('; ')}.${skipped.length ? ` NOT searched — the filter excludes them: ${skipped.join('; ')}; drop the source filter to search them.` : ''}${unmirrored}${noProject} For the exact words of a message use get_chat_messages.)`;
}
