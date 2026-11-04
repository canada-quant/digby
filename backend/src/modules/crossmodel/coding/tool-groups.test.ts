/**
 * Progressive tool disclosure — the pure leaf (coding/tool-groups.ts).
 *
 * Owner 2026-09-27: "it should be way smarter than just trimming? or set a
 * group of tools behind another tool". Pins: the grouping is total and
 * deterministic; the core stays under CORE_MAX; the account group equals the
 * account-tools set; prompt hints are deterministic; the session loads,
 * auto-loads, LRU-evicts under a cap, re-fits when the cap drops, and its
 * snapshot / listing / notes read what happened. The REAL coding + chat lists
 * are pinned in tool-groups.registry.test.ts (which needs the agent scaffold).
 */

// account-tools.ts (isAccountTool) sits on the platform graph: boundary mocks
// so the leaf under test loads without a configured environment.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(async () => 1) },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));

import {
  groupForTool, hintGroupsForText, initialToolGroups, ToolGroupSession, toolGroupsSystemNote, toolGroupsProgressLine,
  CORE_TOOL_NAMES, CORE_MAX, ACCOUNT_GROUP_TOOLS, TOOL_GROUP_IDS, TOOL_GROUP_DESCRIPTIONS, TOOL_GROUP_META_TOOLS,
  LIST_TOOL_GROUPS_SCHEMA, LOAD_TOOLS_SCHEMA, toolGroupsDisabled, toolGroupsAlways, TOOL_GROUPS_NOTE_PREFIX,
} from './tool-groups';
import { PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS, PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';
import { INTEGRATION_TOOL_NAMES, GOOGLE_WRITE_TOOL_NAMES, CONNECTOR_WRITE_TOOL_NAMES } from './integration-tool-schema';
import { isAccountTool } from '../platform/account-tools';
import { SUPERVISOR_ONLY_TOOLS, TRIAGE_TOOLS } from './tool-scope';
import { NON_EVIDENCE_TOOLS } from './evidence-tools';
import { TOOL_TRIM_PINNED } from './provider-limits';

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } });

/** A synthetic full list: every platform tool + every connector tool + the core names (a superset of any real run). */
const ALL_NAMES = Array.from(new Set([
  ...CORE_TOOL_NAMES, ...PLATFORM_TOOL_NAMES, ...INTEGRATION_TOOL_NAMES, ...GOOGLE_WRITE_TOOL_NAMES, ...CONNECTOR_WRITE_TOOL_NAMES,
]));

beforeEach(() => { delete process.env.TOOL_GROUPS_DISABLED; delete process.env.TOOL_GROUPS_ALWAYS; });

describe('grouping is total, deterministic and consistent with the sibling leaves', () => {
  it('every name maps to exactly one known group (a rule, so a new tool anywhere is grouped without touching the file)', () => {
    for (const n of ALL_NAMES) expect(TOOL_GROUP_IDS).toContain(groupForTool(n));
    expect(groupForTool('')).toBe('core');
    expect(groupForTool('spawn_self')).toBe('core'); // a council extra tool: always visible
  });
  it('the explicit core is under CORE_MAX and names only real tools', () => {
    expect(CORE_TOOL_NAMES.length).toBeLessThanOrEqual(CORE_MAX);
    expect(new Set(CORE_TOOL_NAMES).size).toBe(CORE_TOOL_NAMES.length);
    const known = new Set<string>([...PLATFORM_TOOL_NAMES, ...TOOL_TRIM_PINNED, ...TOOL_GROUP_META_TOOLS]);
    expect(CORE_TOOL_NAMES.filter((n) => !known.has(n))).toEqual([]);
    for (const n of CORE_TOOL_NAMES) expect(groupForTool(n)).toBe('core');
  });
  it('the account group IS the account-tools set (platform/account-tools.ts isAccountTool)', () => {
    for (const n of ACCOUNT_GROUP_TOOLS) expect(isAccountTool(n)).toBe(true);
    const fromRegistry = PLATFORM_TOOL_NAMES.filter(isAccountTool).sort();
    expect([...ACCOUNT_GROUP_TOOLS].sort()).toEqual(fromRegistry);
    for (const n of ACCOUNT_GROUP_TOOLS) expect(groupForTool(n)).toBe('account');
  });
  it('triage / supervisor-only sets and the connector prefixes land in their groups; the rest of the platform registry splits by read vs mutating', () => {
    for (const n of TRIAGE_TOOLS) expect(groupForTool(n)).toBe('triage');
    for (const n of SUPERVISOR_ONLY_TOOLS) expect(groupForTool(n)).toBe('supervisor');
    expect(groupForTool('gmail_search')).toBe('connector_google');
    expect(groupForTool('sheets_append_rows')).toBe('connector_google');
    expect(groupForTool('github_list_prs')).toBe('connector_github');
    expect(groupForTool('slack_post_message')).toBe('connector_slack');
    expect(groupForTool('asana_create_task')).toBe('connector_asana');
    expect(groupForTool('x_get_trends')).toBe('connector_x');
    expect(groupForTool('xero_get_invoices')).toBe('connector_xero');
    expect(groupForTool('plaid_get_balances')).toBe('connector_plaid');
    expect(groupForTool('imessage_send')).toBe('connector_imessage');
    for (const n of INTEGRATION_TOOL_NAMES) expect(groupForTool(n)).toMatch(/^connector_/);
    for (const n of PLATFORM_READ_TOOLS) if (!CORE_TOOL_NAMES.includes(n) && !isAccountTool(n) && !TRIAGE_TOOLS.has(n) && !SUPERVISOR_ONLY_TOOLS.has(n)) expect(groupForTool(n)).toBe('platform_reads');
    for (const n of PLATFORM_MUTATING_TOOLS) if (!CORE_TOOL_NAMES.includes(n) && !isAccountTool(n) && !TRIAGE_TOOLS.has(n) && !SUPERVISOR_ONLY_TOOLS.has(n)) expect(groupForTool(n)).toBe('platform_actions');
  });
  it('every group has a description; the gateway pair is core, non-evidence and in the trim pin list', () => {
    for (const id of TOOL_GROUP_IDS) expect(TOOL_GROUP_DESCRIPTIONS[id].length).toBeGreaterThan(20);
    for (const t of TOOL_GROUP_META_TOOLS) {
      expect(groupForTool(t)).toBe('core');
      expect(NON_EVIDENCE_TOOLS.has(t)).toBe(true);
      expect(TOOL_TRIM_PINNED).toContain(t);
    }
    expect(LIST_TOOL_GROUPS_SCHEMA.function.name).toBe('list_tool_groups');
    expect(LOAD_TOOLS_SCHEMA.function.name).toBe('load_tools');
    expect(LOAD_TOOLS_SCHEMA.function.parameters.properties).toHaveProperty('group');
    expect(LOAD_TOOLS_SCHEMA.function.parameters.properties).toHaveProperty('query');
  });
});

describe('prompt hints (deterministic keyword → group)', () => {
  it('reads the obvious connector / account / triage cues', () => {
    expect(hintGroupsForText('Check my Gmail for the invoice from Acme')).toEqual(['connector_google', 'connector_xero']);
    expect(hintGroupsForText('open the pull request on GitHub and post to Slack')).toEqual(['connector_github', 'connector_slack']);
    expect(hintGroupsForText('create an Asana task and tweet about it')).toEqual(['connector_asana', 'connector_x']);
    expect(hintGroupsForText('what are my bank balances')).toEqual(['connector_plaid']);
    expect(hintGroupsForText('text me on iMessage when done')).toEqual(['connector_imessage']);
    // 1ea9a120: Apple-Calendar phrasing hints the paired-Mac group too (the
    // Google group's bare \bcalendar\b may co-hint; toContain is order-free).
    expect(hintGroupsForText('read my Apple Calendar events on the MacBook')).toContain('connector_imessage');
    expect(hintGroupsForText('remember that I prefer dark mode and notify me on Telegram')).toEqual(['account']);
    expect(hintGroupsForText('[TICKET DISPATCH] work the feedback tickets')).toEqual(['triage']);
    expect(hintGroupsForText('')).toEqual([]);
    expect(hintGroupsForText('fix the failing unit test in agent.ts')).toEqual([]);
  });
  it('a tool named verbatim counts only when THIS run carries it; never "core"; first mention wins, no duplicates', () => {
    expect(hintGroupsForText('call gmail_search then drive_get_doc', ['gmail_search', 'drive_get_doc', 'read_file'])).toEqual(['connector_google']);
    expect(hintGroupsForText('call gmail_search', ['read_file'])).toEqual([]);
    expect(hintGroupsForText('call read_file', ['read_file'])).toEqual([]);
    expect(hintGroupsForText('call gmail_search', undefined)).toEqual([]);
  });
  it('initialToolGroups: hints first, then the lane habits (chat ⇒ account; triage; supervisor)', () => {
    expect(initialToolGroups({ text: 'search slack', knownTools: [], chatLane: true, triage: true, supervisor: true })).toEqual(['connector_slack', 'account', 'triage', 'supervisor']);
    expect(initialToolGroups({ text: 'remember this', knownTools: [], chatLane: true, triage: false, supervisor: false })).toEqual(['account']);
    expect(initialToolGroups({ text: '', knownTools: [], chatLane: false, triage: false, supervisor: false })).toEqual([]);
  });
});

describe('ToolGroupSession', () => {
  const NAMES = [
    ...CORE_TOOL_NAMES,
    'gmail_search', 'gmail_send_email', 'drive_search',       // connector_google (3)
    'github_list_prs', 'github_search_code',                  // connector_github (2)
    'slack_search',                                           // connector_slack (1)
    'get_account_overview', 'remember_fact', 'notify_user',   // account (3)
    'list_feedback', 'update_feedback',                       // triage (2)
    'get_fleet_telemetry', 'get_model_roles',                 // platform_reads (2)
    'create_canvas', 'archive_project', 'set_chat_autonomy',  // platform_actions (3)
    'get_supervisor_state',                                   // supervisor (1)
  ];
  const core = CORE_TOOL_NAMES.length;

  it('starts with the core only; groups list with counts; load adds a group for the rest of the run', () => {
    const s = new ToolGroupSession(NAMES, undefined);
    expect(s.coreCount()).toBe(core);
    expect(s.visibleCount()).toBe(core);
    expect(s.headroom()).toBe(Number.POSITIVE_INFINITY);
    expect(s.isVisible('read_file')).toBe(true);
    expect(s.isVisible('gmail_search')).toBe(false);
    expect(s.available().map((g) => [g.id, g.tools])).toEqual([
      ['account', 3], ['triage', 2], ['supervisor', 1], ['platform_reads', 2], ['platform_actions', 3],
      ['connector_google', 3], ['connector_github', 2], ['connector_slack', 1],
    ]);
    const r = s.load('connector_google');
    expect(r.ok).toBe(true);
    expect(r.loaded).toEqual(['gmail_search', 'gmail_send_email', 'drive_search']);
    expect(s.isVisible('gmail_send_email')).toBe(true);
    expect(s.loadedGroups()).toEqual(['connector_google']);
    expect(s.load('connector_google')).toMatchObject({ ok: true, already: true, loaded: [] });
    expect(s.load('core')).toMatchObject({ ok: false, reason: 'unknown_group' });
    expect(s.load('nope')).toMatchObject({ ok: false, reason: 'unknown_group' });
    expect(s.load('connector_xero')).toMatchObject({ ok: false, reason: 'empty_group' });
    expect(s.listing().groups.find((g) => g.group === 'connector_google')).toMatchObject({ loaded: 'yes', tools: 3 });
    expect(s.listing().groups.find((g) => g.group === 'account')).toMatchObject({ loaded: 'no', names: ['get_account_overview', 'remember_fact', 'notify_user'] });
  });

  it('visible() keeps input order and filters to core + loaded', () => {
    const s = new ToolGroupSession(NAMES, undefined);
    s.load('connector_slack');
    const v = s.visible(NAMES.map(tool)).map((t) => t.function.name);
    expect(v).toEqual([...CORE_TOOL_NAMES, 'slack_search']);
  });

  it('loadQuery matches tool names and group words, loads across groups, and refuses an empty / no-match query honestly', () => {
    const s = new ToolGroupSession(NAMES, undefined);
    expect(s.loadQuery('gmail')).toMatchObject({ ok: true, loaded: ['gmail_search', 'gmail_send_email'] }); // NAME matches win over the group description
    expect(s.loadQuery('gmail')).toMatchObject({ ok: false, reason: 'no_match' }); // already in view
    expect(s.loadQuery('canvas')).toMatchObject({ ok: true, loaded: ['create_canvas'] });
    expect(s.loadQuery('seat')).toMatchObject({ ok: true, loaded: ['get_fleet_telemetry', 'get_model_roles'] }); // no name match ⇒ the group whose description says "seat tests"
    expect(s.loadQuery('xx')).toMatchObject({ ok: false, reason: 'no_match' });
    expect(s.loadQuery('zzzzzz')).toMatchObject({ ok: false, reason: 'no_match' });
    expect(s.listing().groups.find((g) => g.group === 'connector_google')).toMatchObject({ loaded: 'partial' });
  });

  it('under a cap: LRU eviction of the least-recently-USED non-core group makes room, and the result says so', () => {
    const s = new ToolGroupSession(NAMES, core + 5);
    expect(s.load('connector_google')).toMatchObject({ ok: true, evicted: [] });   // core + 3
    expect(s.headroom()).toBe(2);
    expect(s.load('connector_slack')).toMatchObject({ ok: true, evicted: [] });    // core + 4
    s.noteUse('gmail_search');                                                       // google is now the most recent
    const r = s.load('connector_github');                                            // needs 2, headroom 1: evicts slack (LRU), not google
    expect(r).toMatchObject({ ok: true, evicted: ['connector_slack'] });
    expect(r.message).toContain('evicted the least-recently-used group connector_slack');
    expect(s.isVisible('slack_search')).toBe(false);
    expect(s.isVisible('gmail_search')).toBe(true);
    expect(s.loadedGroups()).toEqual(['connector_github', 'connector_google']);
    expect(s.evictedLog).toEqual(['connector_slack']);
    // a group larger than the headroom after every eviction loads PARTIALLY, never fails silently
    const t = new ToolGroupSession(NAMES, core + 2);
    expect(t.load('connector_google')).toMatchObject({ ok: true, partial: true, loaded: ['gmail_search', 'gmail_send_email'] });
    const u = new ToolGroupSession(NAMES, core);
    expect(u.load('connector_google')).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('ensureLoadedFor auto-loads the whole group when it fits, else just the tool; null for core / unknown / visible', () => {
    const s = new ToolGroupSession(NAMES, core + 3);
    expect(s.ensureLoadedFor('read_file')).toBeNull();
    expect(s.ensureLoadedFor('not_a_tool')).toBeNull();
    const r = s.ensureLoadedFor('gmail_search');
    expect(r).toMatchObject({ ok: true, group: 'connector_google', loaded: ['gmail_search', 'gmail_send_email', 'drive_search'] });
    expect(s.autoLoads).toBe(1);
    expect(s.ensureLoadedFor('gmail_search')).toBeNull();
    // no room for the whole github group without evicting google: the LRU eviction happens, whole group fits
    const r2 = s.ensureLoadedFor('github_list_prs');
    expect(r2).toMatchObject({ ok: true, group: 'connector_github', evicted: ['connector_google'] });
    // cap of core + 1: only the tool itself fits
    const t = new ToolGroupSession(NAMES, core + 1);
    expect(t.ensureLoadedFor('gmail_send_email')).toMatchObject({ ok: true, partial: true, loaded: ['gmail_send_email'] });
    expect(t.isVisible('gmail_send_email')).toBe(true);
    expect(t.isVisible('gmail_search')).toBe(false);
  });

  it('setCap lowering the cap re-fits by evicting LRU groups; setTools drops names that left the list', () => {
    const s = new ToolGroupSession(NAMES, undefined);
    s.load('connector_google');
    s.load('connector_github');
    s.noteUse('github_list_prs');
    s.setCap(core + 2);
    expect(s.loadedGroups()).toEqual(['connector_github']);
    expect(s.evictedLog).toEqual(['connector_google']);
    s.setTools(NAMES.filter((n) => n !== 'github_list_prs'));
    expect(s.isVisible('github_search_code')).toBe(true);
    expect(s.hasTool('github_list_prs')).toBe(false);
    expect(s.snapshot()).toMatchObject({ cap: core + 2, core, loaded: ['connector_github'], evicted: ['connector_google'], autoLoads: 0, loads: 2 });
  });

  it('the per-turn note is ONE line naming what is in view and what is on demand; the status line reads "Tool groups: core + …"', () => {
    const s = new ToolGroupSession(NAMES, 128);
    s.load('account');
    const note = toolGroupsSystemNote(s, 'api-openai-gpt-6-astra');
    expect(note.startsWith(TOOL_GROUPS_NOTE_PREFIX)).toBe(true);
    expect(note.split('\n')).toHaveLength(1);
    expect(note).toContain(`${core + 3}/128 tools in view`);
    expect(note).toContain('core + account');
    expect(note).toContain('7 tool groups available on demand');
    expect(note).toContain('list_tool_groups');
    expect(toolGroupsProgressLine(s)).toBe(`Tool groups: core + account (${core + 3}/128 tools); 7 more on demand`);
    const u = new ToolGroupSession(NAMES, undefined);
    expect(toolGroupsProgressLine(u)).toBe(`Tool groups: core (${core} tools); 8 more on demand`);
  });

  // build 2026-10-08 A2b: a lane-aware starting set may HOLD BACK core tools — never a refusal.
  it('held-back core (A2b): out of view, listed as group "core", auto-loaded by name, load("core") / a query bring them back', () => {
    const s = new ToolGroupSession(NAMES, undefined);
    expect(s.deferredCount()).toBe(0);
    expect(s.load('core')).toMatchObject({ ok: false, reason: 'unknown_group' }); // nothing held back ⇒ unchanged
    expect(s.deferCore(['run_command', 'git_push', 'web_pipe', 'gmail_search', 'nope'])).toEqual(['run_command', 'git_push', 'web_pipe']);
    expect(s.isVisible('run_command')).toBe(false);
    expect(s.isVisible('read_file')).toBe(true);
    expect(s.coreCount()).toBe(core - 3);
    expect(s.visibleCount()).toBe(core - 3);
    expect(s.available()[0]).toMatchObject({ id: 'core', tools: core, loaded: core - 3, names: ['run_command', 'git_push', 'web_pipe'] });
    expect(s.listing().groups[0]).toMatchObject({ group: 'core', loaded: 'partial', names: ['run_command', 'git_push', 'web_pipe'] });
    expect(s.snapshot()).toMatchObject({ core: core - 3, held: 3 });
    const note = toolGroupsSystemNote(s, 'glm-5.3');
    expect(note).toContain('core (3 held back for this turn)');
    expect(note).toContain('(core, account');
    // a by-name call brings back THAT tool, counted as an auto-load
    expect(s.ensureLoadedFor('run_command')).toMatchObject({ ok: true, group: 'core', loaded: ['run_command'] });
    expect(s.isVisible('run_command')).toBe(true);
    expect(s.autoLoads).toBe(1);
    expect(s.ensureLoadedFor('run_command')).toBeNull();
    // a keyword query reaches held-back core tools by name
    expect(s.loadQuery('web_pipe')).toMatchObject({ ok: true, loaded: ['web_pipe'] });
    // load('core') brings back the rest
    expect(s.load('core')).toMatchObject({ ok: true, group: 'core', loaded: ['git_push'] });
    expect(s.deferredCount()).toBe(0);
    expect(s.snapshot().held).toBeUndefined();
    expect(s.load('core')).toMatchObject({ ok: false, reason: 'unknown_group' });
  });

  it('seedView (A2b): the view becomes exactly the given set — groups cleared, core outside held back, non-core inside loaded tool by tool', () => {
    const s = new ToolGroupSession(NAMES, undefined);
    s.load('account');
    s.load('connector_google');
    s.seedView(new Set(['read_file', 'web_pipe', 'remember_fact', 'gmail_search', 'not_in_list']));
    expect(NAMES.filter((n) => s.isVisible(n))).toEqual(['read_file', 'web_pipe', 'gmail_search', 'remember_fact']);
    expect(s.loads).toBe(0); // the seed is not a model load
    expect(s.loadedGroups().sort()).toEqual(['account', 'connector_google']);
    // a sibling of a seeded group auto-loads the rest of its group
    expect(s.ensureLoadedFor('gmail_send_email')).toMatchObject({ ok: true, group: 'connector_google', loaded: ['gmail_send_email', 'drive_search'] });
    // loadTools also brings a held-back core tool back
    expect(s.loadTools(['grep'])).toEqual(['grep']);
    expect(s.isVisible('grep')).toBe(true);
  });

  it('held-back core under a cap: an auto-load evicts the LRU group to make room', () => {
    const s = new ToolGroupSession(NAMES, core);
    s.deferCore(['run_command', 'git_push']);
    s.load('connector_slack'); // core − 2 + 1 = core − 1
    s.load('connector_github'); // needs 2, headroom 1 ⇒ evicts slack
    expect(s.loadedGroups()).toEqual(['connector_github']);
    const r = s.ensureLoadedFor('run_command');
    expect(r).toMatchObject({ ok: true, group: 'core', evicted: ['connector_github'] });
    expect(s.isVisible('run_command')).toBe(true);
  });

  it('kill switches read the env per call', () => {
    expect(toolGroupsDisabled()).toBe(false);
    expect(toolGroupsAlways()).toBe(false);
    process.env.TOOL_GROUPS_DISABLED = '1';
    process.env.TOOL_GROUPS_ALWAYS = 'true';
    expect(toolGroupsDisabled()).toBe(true);
    expect(toolGroupsAlways()).toBe(true);
  });
});
