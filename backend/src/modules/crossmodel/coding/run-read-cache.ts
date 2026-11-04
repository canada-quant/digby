/**
 * Per-run READ CACHE for identical read-only platform calls (audit 2026-10-08
 * W2-12 — sota.md #4, fleet.md F1/F12).
 *
 * Evidence: `schedule_get` ×481 in 52 h for a drift-check duty; within ONE
 * owner turn `list_owner_questions` ×7, `todo_list` (same project) ×5,
 * `list_chats` ×5. Each repeat re-runs the DB reads AND pastes the same block
 * into the context again.
 *
 * Rule: inside one agent loop (a run, or one worker), the SAME allowlisted
 * read-only tool with the SAME (canonical) arguments within its TTL — and with
 * no state-changing call dispatched since — returns the first result with a
 * one-line "(cached from step k …)" note instead of executing again. Any
 * dispatched call that is neither an allowlisted read nor a known pure local
 * read (read_file / grep / search_memory …) clears the cache: a send, a
 * schedule edit, a todo update, a run_command, a delegation — anything that
 * could have moved the state the reads describe. Error / refusal results are
 * never cached. A cached answer mints NO new receipt (the first call's receipt
 * — named in the note — is the evidence).
 *
 * Kill switch RUN_READ_CACHE_DISABLED=1 (read per loop start). Pure leaf.
 */

export function runReadCacheDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.RUN_READ_CACHE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const FIVE_MIN = 5 * 60_000;
const ONE_MIN = 60_000;

/** Allowlisted read-only tools → how long an identical result is served from the cache. */
export const READ_CACHE_TTL_MS: Readonly<Record<string, number>> = {
  // configuration-like state: changes only when someone edits it
  schedule_get: FIVE_MIN,
  list_schedules: FIVE_MIN,
  list_owner_questions: FIVE_MIN,
  todo_list: FIVE_MIN,
  todo_get: FIVE_MIN,
  goal_list: FIVE_MIN,
  goal_get: FIVE_MIN,
  list_projects: FIVE_MIN,
  get_project: FIVE_MIN,
  hook_list: FIVE_MIN,
  get_account_overview: FIVE_MIN,
  get_supervisor_state: FIVE_MIN,
  // live state (other lanes' runs move it): a short window only
  get_chat_status: ONE_MIN,
  list_chats: ONE_MIN,
};

/** Pure local / web reads that cannot move the platform state the cached reads describe — they never clear the cache. */
const NON_INVALIDATING: ReadonlySet<string> = new Set([
  'read_file', 'list_files', 'list_dir', 'glob', 'grep', 'search_code', 'search_code_semantic',
  'search_memory', 'list_memory', 'search_engine', 'scrape_as_markdown', 'scrape_as_html', 'web_search', 'web_fetch',
  'update_plan', 'think', 'delegate_status', 'list_tool_groups', 'load_tools', 'load_tool_group',
  'get_chat_messages', 'get_run_receipts', 'get_fleet_telemetry', 'list_feedback', 'get_feedback',
]);

export function isCacheableRead(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(READ_CACHE_TTL_MS, String(name ?? ''));
}

/** Canonical JSON (sorted keys, recursively; strings trimmed) of a tool's raw argument string, or null when unparseable. Pure. */
export function canonicalArgs(argsJson: string | undefined | null): string | null {
  let v: unknown;
  try { v = JSON.parse(argsJson && String(argsJson).trim() ? String(argsJson) : '{}'); } catch { return null; }
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) out[k] = norm((x as Record<string, unknown>)[k]);
      return out;
    }
    return typeof x === 'string' ? x.trim() : x;
  };
  return JSON.stringify(norm(v));
}

/** A result that must never be served again (an error, a refusal, a staged / not-ok envelope). Pure. */
export function isUncacheableResult(result: string): boolean {
  const r = String(result ?? '');
  if (!r.trim()) return true;
  if (/^(?:Error\b|Tool "|Tool [a-z_]+ failed|\[tool call rejected|\[command REFUSED|\[HARNESS|Unknown|No such|Not found|Chat not found)/i.test(r.trimStart())) return true;
  const head = r.trimStart();
  if (head.startsWith('{')) {
    try {
      const o = JSON.parse(head);
      if (o && typeof o === 'object' && ((o as any).ok === false || (o as any).needsConfirmation === true || typeof (o as any).error === 'string')) return true;
    } catch { /* not a JSON envelope — prose results are cacheable */ }
  }
  return false;
}

export interface CachedRead {
  /** The model-facing text: the one-line note + the first result. */
  text: string;
  /** The step / receipt the result came from. */
  step: number;
  receiptId: string | null;
  ageMs: number;
}

interface Entry { result: string; step: number; at: number; receiptId: string | null; tool: string }

export class RunReadCache {
  private readonly entries = new Map<string, Entry>();
  private readonly byTool = new Map<string, { hits: number; misses: number }>();
  hits = 0;
  misses = 0;
  invalidations = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private keyOf(name: string, argsJson: string | undefined | null): string | null {
    if (!isCacheableRead(name)) return null;
    const a = canonicalArgs(argsJson);
    return a === null ? null : `${name}:${a}`;
  }

  /** Call for EVERY dispatched tool call, before it runs: a state-changing call clears the cache. */
  noteDispatch(name: string): void {
    const n = String(name ?? '');
    if (isCacheableRead(n) || NON_INVALIDATING.has(n)) return;
    if (this.entries.size) { this.entries.clear(); this.invalidations += 1; }
  }

  lookup(name: string, argsJson: string | undefined | null): CachedRead | null {
    const key = this.keyOf(name, argsJson);
    if (!key) return null;
    const e = this.entries.get(key);
    const t = this.now();
    const stat = this.byTool.get(name) ?? { hits: 0, misses: 0 };
    this.byTool.set(name, stat);
    if (!e || t - e.at > READ_CACHE_TTL_MS[name]) {
      if (e) this.entries.delete(key);
      this.misses += 1; stat.misses += 1;
      return null;
    }
    this.hits += 1; stat.hits += 1;
    const ageMs = t - e.at;
    const ttlS = Math.round(READ_CACHE_TTL_MS[name] / 1000);
    const note = `(cached from step ${e.step}, ${Math.max(0, Math.round(ageMs / 1000))} s ago${e.receiptId ? `, receipt ${e.receiptId}` : ''} — an identical ${name} call already returned this and nothing state-changing has run since, so it was not re-executed; an identical read within ${ttlS} s returns this same copy — use the result you have, or wait / change something before reading again)`;
    return { text: `${note}\n${e.result}`, step: e.step, receiptId: e.receiptId, ageMs };
  }

  record(name: string, argsJson: string | undefined | null, result: string, step: number, receiptId: string | null): void {
    const key = this.keyOf(name, argsJson);
    if (!key || isUncacheableResult(result)) return;
    this.entries.set(key, { result, step, at: this.now(), receiptId, tool: name });
  }

  /** Per-run telemetry summary (null when the cache was never consulted). */
  summary(): { hits: number; misses: number; invalidations: number; byTool: Record<string, { hits: number; misses: number }> } | null {
    if (!this.hits && !this.misses) return null;
    return { hits: this.hits, misses: this.misses, invalidations: this.invalidations, byTool: Object.fromEntries(this.byTool) };
  }
}
