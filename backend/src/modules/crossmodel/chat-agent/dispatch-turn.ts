/**
 * Pure DISPATCH / COORDINATION turn detector (audit 2026-10-06 T6-5, stanne P3).
 *
 * The Double Checker is an independent research lane with web + retrieval
 * tools ONLY (cross-check-scope.ts) — it cannot read fleet state, send a
 * message, start a session or move a todo. On a turn whose ONLY work was
 * coordination (send_chat_message / start_coding_session / todo_* / schedule
 * edits / supervisor-state writes …, optionally after platform READS) its
 * draft has nothing to cross-check: prod e748a8ce (StAnne, a pure dispatch
 * turn) waited 315 s for a reconcile that "resolved empty". The chat lane now
 * skips the late reconcile on such a turn, stops the checker at its next step
 * and reads the pill as "skipped".
 *
 * A turn that ran ANY other tool (web search / scrape / browser, connector
 * reads, memory or knowledge writes, documents, images …) keeps the checker:
 * its answer may carry facts the checker can verify. LEAF — no imports.
 * Kill switch CROSSCHECK_DISPATCH_SKIP_DISABLED=1.
 */

/** The coordination tools whose effect IS the turn's deliverable (the checker can neither see nor repeat it). */
export const DISPATCH_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'start_coding_session', 'dispatch_platform_task', 'send_to_instance',
  'create_chat', 'move_chat', 'rename_chat', 'archive_chat', 'attach_workspace', 'configure_workspace', 'import_repo',
  'todo_create', 'todo_update', 'goal_create', 'goal_update', 'goal_premise_set',
  'schedule_message', 'update_schedule', 'cancel_schedule', 'pause_schedule', 'resume_schedule',
  'hook_subscribe', 'hook_update', 'hook_unsubscribe',
  'update_supervisor_state', 'register_infra_blocker', 'clear_infra_blocker',
  'flag_owner_question', 'answer_owner_question', 'dismiss_owner_question',
  'stop_run', 'answer_chat_question', 'approve_request', 'cancel_confirmation',
  'set_chat_instructions', 'set_chat_mode', 'set_session_model', 'set_session_permission_mode', 'set_chat_autonomy',
  'file_feedback', 'update_feedback', 'notify_user',
]);

/** Platform READS (fleet / account state the checker cannot see either) and the harness's own tool-loading helpers. */
export const DISPATCH_TURN_READ_TOOLS: ReadonlySet<string> = new Set([
  'list_chats', 'get_chat_status', 'get_chat_messages', 'list_schedules', 'get_project', 'topology_check', 'list_projects',
  'schedule_get', 'list_owner_questions', 'list_feedback', 'get_feedback', 'goal_list', 'todo_list', 'hook_list', 'goal_get',
  'todo_get', 'list_infra_blockers', 'get_fleet_telemetry', 'get_supervisor_state', 'get_run_receipts', 'get_chat_autonomy',
  'search_chats', 'list_pending_confirmations', 'get_chat_instructions', 'get_session_diff', 'resolve_id', 'get_spend',
  'get_account_overview', 'get_preferences', 'list_session_files', 'read_session_file',
  // build 2026-10-11 DL-1: the delegation ledger's reads (the status source that replaces lane polls).
  'task_get', 'task_list',
  'load_tools', 'list_tool_groups', 'load_tool_group', 'update_plan',
]);

export function dispatchTurnSkipDisabled(): boolean {
  const v = String(process.env.CROSSCHECK_DISPATCH_SKIP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * The coordination tools a turn called when the turn was PURE dispatch /
 * coordination (≥ 1 DISPATCH_TOOLS call, every other call a platform read or a
 * harness helper); null otherwise — including when the kill switch is set.
 */
export function dispatchOnlyTurnTools(parts: Array<{ type?: string; name?: string }> | undefined | null): string[] | null {
  if (dispatchTurnSkipDisabled()) return null;
  const dispatched: string[] = [];
  for (const p of parts || []) {
    if (p?.type !== 'tool_call') continue;
    const name = String(p.name ?? '');
    if (DISPATCH_TOOLS.has(name)) { if (!dispatched.includes(name)) dispatched.push(name); continue; }
    if (DISPATCH_TURN_READ_TOOLS.has(name)) continue;
    return null; // research / connector / content work — the checker may have something to verify
  }
  return dispatched.length ? dispatched : null;
}
