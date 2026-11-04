/**
 * Per-run tool-family profile (owner 2026-09-19: "I don't see it ever use
 * read memory… or web search… or execute subagents").
 *
 * Every top-level agent run (coding lanes AND the chat-tier supervisor wakes —
 * both go through runCodingAgent) records ONE `run_tool_profile` loop metric
 * at finalize with the counts below, so the fleet can SEE how each lane works:
 * alone and offline (run_command only), or with memory, the web, delegation
 * and sub-sessions. Measured before this existed (2026-09-19, 24 h, 57 kimi-k3
 * coding sessions): delegation in 5 sessions, web in 1, memory in 21 — the
 * agent guide asks for all three, and nobody could tell which lanes ignored it.
 *
 * `get_fleet_telemetry` view 'collab' aggregates these rows per lane; the
 * supervisor doctrine's COLLABORATION WATCH reads that view each sweep.
 * Pure leaf — no imports.
 */

export const TOOL_FAMILY_MEMORY: ReadonlySet<string> = new Set(['search_memory']);
export const TOOL_FAMILY_WEB: ReadonlySet<string> = new Set(['search_engine', 'scrape_as_markdown', 'web_pipe', 'youtube_pipe', 'browser_task']);
export const TOOL_FAMILY_DELEGATE: ReadonlySet<string> = new Set(['delegate', 'delegate_parallel']);
export const TOOL_FAMILY_SPAWN: ReadonlySet<string> = new Set(['start_coding_session']);
export const TOOL_FAMILY_MESSAGES: ReadonlySet<string> = new Set(['send_chat_message', 'send_to_instance']);
/**
 * WRITE counters (2026-10-04, coding option D prerequisite): did this run CHANGE anything? Orthogonal to the
 * families above (a send_chat_message is a message AND a platform write). A schedule / hook firing that wrote
 * nothing is the no-op the A4 effort step-down could not see (machine-firing-effort.ts: "run_tool_profile carries
 * no mutation count") and the label a firing-size predictor learns from. run_command stays its own counter — it
 * runs reads and writes alike. A worker's edits ride its delegate part (count `delegate`), never these.
 */
export const TOOL_WRITE_CODE: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'ast_rewrite']);
export const TOOL_WRITE_GIT: ReadonlySet<string> = new Set(['git_commit', 'git_push', 'open_pull_request', 'merge_pull_request']);

/** Connector tools are prefix-named (gmail_search, drive_get_doc, slack_search, github_…). */
export const TOOL_FAMILY_CONNECTOR_PREFIXES: readonly string[] = ['gmail_', 'calendar_', 'drive_', 'sheets_', 'slack_', 'github_', 'asana_', 'xero_', 'docs_', 'slides_', 'x_', 'plaid_', 'imessage_', 'discord_'];

export interface ToolFamilyProfile {
  calls: number;
  memory: number;
  web: number;
  delegate: number;
  spawn: number;
  messages: number;
  connectors: number;
  runCommand: number;
  /** write_file / edit_file / ast_rewrite calls. */
  codeWrites: number;
  /** git_commit / git_push / open_pull_request / merge_pull_request calls. */
  gitWrites: number;
  /** Platform-mutating calls (the caller's set — platform-tool-names PLATFORM_MUTATING_TOOLS); 0 without one. */
  platformWrites: number;
  /** Distinct tool names used (bounded, sorted) — the shape of the run at a glance. */
  distinct: string[];
}

export const TOOL_PROFILE_DISTINCT_CAP = 24;

/** Count tool families over a run's persisted parts (only `tool_call` parts count). Pure; tolerant of junk. */
export function toolFamilyProfile(
  parts: ReadonlyArray<unknown> | null | undefined,
  opts: { platformMutating?: ReadonlySet<string> } = {},
): ToolFamilyProfile {
  const p: ToolFamilyProfile = { calls: 0, memory: 0, web: 0, delegate: 0, spawn: 0, messages: 0, connectors: 0, runCommand: 0, codeWrites: 0, gitWrites: 0, platformWrites: 0, distinct: [] };
  const seen = new Set<string>();
  for (const raw of parts ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as { type?: unknown; name?: unknown };
    if (part.type !== 'tool_call' || typeof part.name !== 'string' || !part.name) continue;
    const name = part.name;
    p.calls += 1;
    seen.add(name);
    if (TOOL_WRITE_CODE.has(name)) p.codeWrites += 1;
    else if (TOOL_WRITE_GIT.has(name)) p.gitWrites += 1;
    else if (opts.platformMutating?.has(name)) p.platformWrites += 1;
    if (TOOL_FAMILY_MEMORY.has(name)) p.memory += 1;
    else if (TOOL_FAMILY_WEB.has(name)) p.web += 1;
    else if (TOOL_FAMILY_DELEGATE.has(name)) p.delegate += 1;
    else if (TOOL_FAMILY_SPAWN.has(name)) p.spawn += 1;
    else if (TOOL_FAMILY_MESSAGES.has(name)) p.messages += 1;
    else if (name === 'run_command') p.runCommand += 1;
    else if (TOOL_FAMILY_CONNECTOR_PREFIXES.some((pre) => name.startsWith(pre))) p.connectors += 1;
  }
  p.distinct = [...seen].sort().slice(0, TOOL_PROFILE_DISTINCT_CAP);
  return p;
}

/** True when the run changed something itself (a code / git / platform write) or handed work to a worker. */
export function runDidWrite(p: Pick<ToolFamilyProfile, 'codeWrites' | 'gitWrites' | 'platformWrites' | 'delegate'>): boolean {
  return p.codeWrites + p.gitWrites + p.platformWrites + p.delegate > 0;
}

/** True when a run reached for none of the collaboration / research families. */
export function workedAlone(p: Pick<ToolFamilyProfile, 'memory' | 'web' | 'delegate' | 'spawn'>): boolean {
  return p.memory + p.web + p.delegate + p.spawn === 0;
}
