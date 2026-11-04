/**
 * Minimal view (2026-10-16, lib/view-mode.ts): tool activity as Grok-style one-line rows — "Terminal · Ran 3
 * commands", "Files · Edited 2 files", "Web · Searched 4 times". Consecutive calls of the same kind fold into
 * one row; prose, images and task cards break a run. A row opens to the short labels the server kept (the
 * command, the path, the query) — never arguments or output. Pure — no React.
 */

import type { MessagePart } from './api/coding';

export type ActivityKind =
  | 'terminal' | 'edit' | 'read' | 'web' | 'browser' | 'computer' | 'github' | 'message' | 'routine'
  | 'session' | 'memory' | 'image' | 'email' | 'calendar' | 'drive' | 'app' | 'other';

export interface ActivityRow {
  kind: 'activity';
  activity: ActivityKind;
  /** "Terminal", "Files", "Web" … */
  title: string;
  /** "Ran 3 commands", "Created routine MuseSpark hourly check-in" … */
  summary: string;
  /** The short labels the server kept, in order (may be empty). */
  labels: string[];
  /** Index of the first part in the run (stable React key). */
  start: number;
  /** Background traffic the person only needs to know happened (a routine set up, a message sent) — rendered as one
   *  centred grey line, Grok-style ("Created routine ⟳ Counsel email watch"), not a box. */
  note?: boolean;
  /** Calls folded into this row. */
  count: number;
  /** The first tool's name (routine verbs). */
  firstTool: string;
}

export interface PartItem {
  kind: 'part';
  index: number;
}

/**
 * Every activity row between two pieces of prose, as ONE quiet grey line (owner 2026-10-16: "much uglier … the
 * small little text in light gray instead of these big boxes … it was supposed to appear less"). Rows of the same
 * kind merge across the run ("Read 4 emails · Checked memory"), in first-seen order.
 */
export interface ActivityLine {
  kind: 'activityLine';
  /** "Read 4 emails · Checked memory" */
  text: string;
  /** The merged rows (opened on click: one line per kind, with its labels). */
  rows: ActivityRow[];
  /** Index of the first part in the run (stable React key). */
  start: number;
}

export type MinimalItem = ActivityRow | PartItem;
export type MinimalLineItem = ActivityLine | ActivityRow | PartItem;

/** Bookkeeping tools that never show as a row. */
const SILENT = new Set(['update_plan', 'todo_write', 'think', 'load_tools', 'list_tool_groups', 'load_tool_group']);

const RULES: Array<[ActivityKind, RegExp]> = [
  ['routine', /schedule|routine|cron/],
  ['message', /send_chat_message|send_to_instance|notify_user|send_email|message_chat|reply_to|imessage_send|slack_post|x_post/],
  ['email', /gmail|email|inbox|mail_/],
  ['calendar', /calendar/],
  ['drive', /drive_|gdrive|google_doc/],
  ['app', /^(slack|asana|xero|plaid|imessage|x|discord|notion|linear|jira|mcp)_/],
  ['session', /start_coding_session|delegate|spawn|subsession|call_in/],
  ['github', /git_|pull_request|push_to_github|github|merge_/],
  ['browser', /browser/],
  ['computer', /computer_task|computer_/],
  ['image', /generate_image|image_generate/],
  ['web', /web|search_engine|scrape|fetch_url|fetch|serp|url/],
  ['edit', /write_file|edit_file|apply_patch|str_replace|create_file|multi_edit|delete_file|move_file|rename_file|patch/],
  ['read', /read_file|list_files|list_dir|glob|grep|search_files|view_file|find_files|^ls$|file/],
  ['terminal', /run_command|bash|shell|exec|terminal|run_tests|verify|process|command/],
  ['memory', /memory|remember|forget|fact/],
];

export function activityKindOf(toolName: string | undefined): ActivityKind {
  const n = String(toolName || '').toLowerCase();
  for (const [kind, re] of RULES) if (re.test(n)) return kind;
  return 'other';
}

const TITLES: Record<ActivityKind, string> = {
  terminal: 'Terminal', edit: 'Files', read: 'Files', web: 'Web', browser: 'Browser', computer: 'Your Mac',
  github: 'GitHub', message: 'Messages', routine: 'Routine', session: 'Session', memory: 'Memory', image: 'Image',
  email: 'Email', calendar: 'Calendar', drive: 'Drive', app: 'Apps', other: 'Tools',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const APP_NAMES: Record<string, string> = {
  slack: 'Slack', asana: 'Asana', xero: 'Xero', plaid: 'your bank', imessage: 'Messages', x: 'X', discord: 'Discord',
  notion: 'Notion', linear: 'Linear', jira: 'Jira',
};

/** "Slack" for slack_search, "Granola" for mcp_granola_list_meetings, else "an app". */
function appName(toolName: string): string {
  const n = toolName.toLowerCase();
  const mcp = n.match(/^mcp_([a-z0-9-]+)_/);
  if (mcp) return mcp[1].charAt(0).toUpperCase() + mcp[1].slice(1).replace(/-/g, ' ');
  const prefix = n.split('_')[0];
  return APP_NAMES[prefix] || 'an app';
}

const ROUTINE_VERBS: Array<[RegExp, string]> = [
  [/cancel|delete|stop/, 'Stopped routine'],
  [/pause/, 'Paused routine'],
  [/resume/, 'Resumed routine'],
  [/update|edit/, 'Updated routine'],
];

function routineVerb(toolName: string): string {
  const n = toolName.toLowerCase();
  for (const [re, verb] of ROUTINE_VERBS) if (re.test(n)) return verb;
  return 'Created routine';
}

function summaryFor(kind: ActivityKind, n: number, labels: string[], firstTool = ''): string {
  switch (kind) {
    case 'terminal': return `Ran ${plural(n, 'command', 'commands')}`;
    case 'edit': return `Edited ${plural(n, 'file', 'files')}`;
    case 'read': return `Looked at ${plural(n, 'file', 'files')}`;
    case 'web': return n === 1 ? 'Searched the web' : `Searched ${n} times`;
    case 'browser': return 'Used the browser';
    case 'computer': return 'Used your Mac';
    case 'github': return n === 1 ? 'Updated GitHub' : `${n} GitHub updates`;
    case 'message': return n === 1 ? 'Sent a message' : `Sent ${n} messages`;
    case 'routine': return n === 1 ? (labels.length === 1 ? `${routineVerb(firstTool)} ${labels[0]}` : routineVerb(firstTool)) : `Updated ${n} routines`;
    case 'session': return labels.length === 1 ? `Started ${labels[0]}` : n === 1 ? 'Started a session' : `Started ${n} sessions`;
    case 'memory': return n === 1 ? 'Checked memory' : `Checked memory ${n} times`;
    case 'image': return n === 1 ? 'Created an image' : `Created ${n} images`;
    case 'email': return n === 1 ? 'Checked email' : `Read ${n} emails`;
    case 'calendar': return 'Checked the calendar';
    case 'drive': return n === 1 ? 'Checked Drive' : `Looked at ${n} files in Drive`;
    case 'app': return `Checked ${appName(firstTool)}`;
    default: return `Used ${plural(n, 'tool', 'tools')}`;
  }
}

/** Merge the non-note activity rows between two pieces of prose into one quiet line (see ActivityLine). */
export function groupMinimalLines(items: MinimalItem[]): MinimalLineItem[] {
  const out: MinimalLineItem[] = [];
  let pending: ActivityRow[] = [];
  const flush = () => {
    if (!pending.length) return;
    const merged: ActivityRow[] = [];
    // Same kind merges across the run; an app row merges only with the same app.
    const keyOf = (r: ActivityRow) => (r.activity === 'app' ? `app:${appName(r.firstTool)}` : r.activity);
    const byKey = new Map<string, ActivityRow>();
    for (const r of pending) {
      const k = keyOf(r);
      const hit = byKey.get(k);
      if (hit) {
        hit.count += r.count;
        hit.labels = [...hit.labels, ...r.labels];
        hit.summary = summaryFor(hit.activity, hit.count, hit.labels, hit.firstTool);
      } else {
        const copy = { ...r, labels: [...r.labels] };
        byKey.set(k, copy);
        merged.push(copy);
      }
    }
    out.push({ kind: 'activityLine', text: merged.map(r => r.summary).join(' · '), rows: merged, start: pending[0].start });
    pending = [];
  };
  for (const it of items) {
    if (it.kind === 'activity' && !it.note) { pending.push(it); continue; }
    flush();
    out.push(it);
  }
  flush();
  return out;
}

/** The one label a minimal tool call carries (server-reduced args), or ''. */
export function labelOf(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  for (const v of Object.values(args as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Fold a message's parts into minimal items: activity rows + the parts that still render (text, images, tasks). */
export function buildMinimalItems(parts: MessagePart[]): MinimalItem[] {
  const out: MinimalItem[] = [];
  let run: { kind: ActivityKind; start: number; count: number; labels: string[]; firstTool: string } | null = null;
  const flush = () => {
    if (!run) return;
    const note = run.kind === 'routine' || run.kind === 'message';
    out.push({
      kind: 'activity', activity: run.kind, title: TITLES[run.kind], summary: summaryFor(run.kind, run.count, run.labels, run.firstTool),
      labels: run.labels, start: run.start, ...(note ? { note: true } : {}), count: run.count, firstTool: run.firstTool,
    });
    run = null;
  };
  parts.forEach((p, i) => {
    if (!p) return;
    if (p.type === 'tool_result' || p.type === 'reasoning' || p.type === 'subagent') return;
    if (p.type === 'tool_call') {
      if (SILENT.has(String(p.name))) return;
      const kind = activityKindOf(p.name);
      const label = labelOf(p.args);
      if (run && run.kind === kind) {
        run.count++;
        if (label) run.labels.push(label);
      } else {
        flush();
        run = { kind, start: i, count: 1, labels: label ? [label] : [], firstTool: String(p.name || '') };
      }
      return;
    }
    if (p.type === 'text') {
      if (p.marker || p.struck) return;
      const t = (p.text || '').trim();
      if (!t || t.startsWith('↳ steering:')) return;
    }
    flush();
    out.push({ kind: 'part', index: i });
  });
  flush();
  return out;
}
