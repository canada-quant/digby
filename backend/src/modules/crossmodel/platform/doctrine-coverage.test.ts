/**
 * DOCTRINE COVERAGE (WI-B, 2026-09-25): every registered platform tool has at
 * least one doctrine row somewhere a model that can call it will read.
 *
 * Why: the 2026-09-25 doctrine inventory at HEAD 37f0255a found 52 of 133
 * platform tools with ZERO mentions across the chat playbook, the fleet /
 * project supervisor system prompts, the sweep prompts and the coding
 * orchestrator guidance — and production telemetry showed the same split:
 * every tool with a row was adopted within a day, every tool without one
 * had zero calls (chat_platform_usage.tools). A tool the schema offers but no
 * doctrine names is a tool the model never calls.
 *
 * Contract: the set of PLATFORM_TOOL_NAMES with no whole-token mention in ANY
 * doctrine source must EQUAL the explicit allowlist below. Adding a tool to
 * platform-tool-names.ts without a doctrine row fails here; so does
 * dropping a row. A tool deliberately left rowless is added to the allowlist
 * WITH the reason.
 *
 * Doctrine sources (the prompt text, composed exactly as the runs see it):
 *   - chat playbook  — chat-agent/capability-doctrine.ts platformPlaybookBlock
 *     (signed-in variant; rides every signed-in chat turn AND supervisor wake)
 *   - machine-wake preamble — chat-agent/machine-wake.ts machineWakePreamble
 *     (prepended to every machine-triggered plain-chat run)
 *   - fleet supervisor system prompt — supervisor.service buildFleetSupervisorPrompt
 *   - project supervisor system prompt — project-supervisor.service buildProjectSupervisorPrompt
 *   - the two sweep prompts — buildFleetSweepPrompt / buildProjectSupervisorSweepPrompt
 *   - coding orchestrator guidance — coding/roles.ts orchestratorRoleGuidance
 *
 * Boundary mocks mirror wake-prompt-size.test.ts (the supervisor services
 * import prisma / crossmodel.service / schedule.service at module scope).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  emitScheduleDisabled: jest.fn(async () => undefined),
}));

import { PLATFORM_TOOL_NAMES } from './platform-tool-names';
import { MODEL_FACING_TOOL_NAMES } from '../coding/tool-scope';
import { TOOL_GROUP_META_TOOLS } from '../coding/tool-groups';
import { FRONTIER_COUNCIL_TOOL } from '../coding/frontier-council';
import { coreDoctrine } from './core-doctrine';
import { platformPlaybookBlock } from '../chat-agent/capability-doctrine';
import { machineWakePreamble } from '../chat-agent/machine-wake';
import { buildFleetSupervisorPrompt, buildFleetSweepPrompt } from './supervisor.service';
import { buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } from './project-supervisor.service';
import { orchestratorRoleGuidance } from '../coding/roles';

/**
 * Tools deliberately left WITHOUT a doctrine row (state the reason; a row
 * would either invite calls the owner drives from the UI, or the tool is
 * covered by a hard-refusal line rather than a trigger row).
 *
 * NOTE on test_model_role (fleet supervisor prompt names it — "is a seat alive
 * before re-seating it"): a sibling branch registers the tool in
 * platform-tool-names.ts. It is NOT in this allowlist because the fleet prompt
 * already mentions it — once the registration lands the name is covered, and
 * until then it is not a PLATFORM_TOOL_NAMES entry, so it cannot be uncovered.
 */
const DELIBERATELY_ROWLESS: readonly string[] = [
  // admin, ask-only, instance-wide seat change — the owner drives it from
  // Account → Admin → Endpoints; a trigger row would invite calls.
  'set_model_role_fallback',
];

const DOCTRINE_SOURCES: Array<{ name: string; text: string }> = [
  {
    name: 'chat playbook (platformPlaybookBlock, signed-in)',
    text: platformPlaybookBlock({
      chatId: '0f3c2a1b-1111-2222-3333-444455556666', chatTitle: 'Doctrine coverage',
      projectId: '9e8d7c6b-1111-2222-3333-444455556666', isSupervisor: true, hasUser: true,
    }),
  },
  { name: 'machine-wake preamble', text: machineWakePreamble(new Date('2026-09-25T12:00:00.000Z')) },
  { name: 'fleet supervisor system prompt', text: buildFleetSupervisorPrompt() },
  {
    name: 'project supervisor system prompt',
    text: buildProjectSupervisorPrompt({ projectName: 'crossmodel', projectId: 'proj_cov000', fleetSupervisorChatId: 'chat_fleet000' }),
  },
  { name: 'fleet sweep prompt', text: buildFleetSweepPrompt() },
  {
    name: 'project sweep prompt',
    text: buildProjectSupervisorSweepPrompt({ projectName: 'crossmodel', projectId: 'proj_cov000', fleetSupervisorChatId: 'chat_fleet000' }),
  },
  { name: 'coding orchestrator guidance', text: orchestratorRoleGuidance() },
];

/** Whole-token mention: `get_project` must not be satisfied by `get_project_x`. */
function mentions(text: string, tool: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`);
  return re.test(text);
}

/**
 * A tool is covered when the doctrine names it by its INTERNAL name or by the
 * MODEL-FACING name the prompts render through modelToolName (update_feedback
 * → triage_ticket, update_supervisor_state → save_supervisor_state — the name
 * the model actually calls; coding/tool-scope.ts).
 */
function coveredBy(tool: string): string[] {
  const names = [tool, MODEL_FACING_TOOL_NAMES[tool]].filter((n): n is string => !!n);
  return DOCTRINE_SOURCES.filter(s => names.some(n => mentions(s.text, n))).map(s => s.name);
}

describe('doctrine coverage — every platform tool has a row (WI-B 2026-09-25)', () => {
  it('the uncovered set equals the explicit allowlist', () => {
    const uncovered = PLATFORM_TOOL_NAMES.filter(t => coveredBy(t).length === 0).sort();
    expect(uncovered).toEqual([...DELIBERATELY_ROWLESS].sort());
  });

  it('the tool-groups gateway pair (list_tool_groups / load_tools) is named in the chat playbook, the coding orchestrator guidance and the supervisor core doctrine (progressive disclosure, 2026-09-27)', () => {
    const chat = DOCTRINE_SOURCES.find(s => s.name.startsWith('chat playbook'))!.text;
    const coding = DOCTRINE_SOURCES.find(s => s.name.startsWith('coding orchestrator'))!.text;
    const fleet = DOCTRINE_SOURCES.find(s => s.name.startsWith('fleet supervisor'))!.text;
    const project = DOCTRINE_SOURCES.find(s => s.name.startsWith('project supervisor'))!.text;
    for (const t of TOOL_GROUP_META_TOOLS) {
      for (const text of [chat, coding, fleet, project, coreDoctrine('fleet'), coreDoctrine('project')]) expect(mentions(text, t)).toBe(true);
    }
  });

  it('the harness-owned consult_frontier_council (F2, owner 2026-10-06 late) has its row in the chat playbook, the coding orchestrator guidance and the supervisor core doctrine — with the owner\'s "cite every failure, your goal and where you are"', () => {
    const chat = DOCTRINE_SOURCES.find(s => s.name.startsWith('chat playbook'))!.text;
    const coding = DOCTRINE_SOURCES.find(s => s.name.startsWith('coding orchestrator'))!.text;
    const fleet = DOCTRINE_SOURCES.find(s => s.name.startsWith('fleet supervisor'))!.text;
    const project = DOCTRINE_SOURCES.find(s => s.name.startsWith('project supervisor'))!.text;
    for (const text of [chat, coding, fleet, project, coreDoctrine('fleet'), coreDoctrine('project')]) {
      expect(mentions(text, FRONTIER_COUNCIL_TOOL)).toBe(true);
      expect(text).toContain('cite every failure, your goal and where you are');
    }
  });

  it('the allowlist names only registered tools that are REALLY rowless (a stale allowlist entry is a lie)', () => {
    for (const t of DELIBERATELY_ROWLESS) {
      expect(PLATFORM_TOOL_NAMES).toContain(t);
      expect(coveredBy(t)).toEqual([]);
    }
  });

  it('the 2026-09-25 rows land in the source the inventory assigned them', () => {
    const by = (name: string) => DOCTRINE_SOURCES.find(s => s.name.startsWith(name))!.text;
    const chat = by('chat playbook');
    const fleet = by('fleet supervisor');
    const project = by('project supervisor');
    const fleetSweep = by('fleet sweep');
    const projectSweep = by('project sweep');
    const coding = by('coding orchestrator');
    // A — chat playbook: housekeeping / self-service / read-back / T3a reads
    for (const t of ['set_feed', 'refresh_feed', 'delete_feed', 'create_canvas', 'share_canvas', 'revoke_canvas_share', 'delete_canvas',
      'add_knowledge_file', 'remove_knowledge_document', 'list_chat_uploads', 'read_chat_upload', 'delete_chat_upload', 'delete_document', 'create_chat',
      'archive_project', 'share_project', 'add_project_member', 'remove_project_member', 'get_preferences', 'set_preferences',
      'consolidate_memory', 'rebuild_memory', 'memory_rebuild_status', 'get_chat_webhook', 'create_chat_webhook',
      'revoke_chat_webhook', 'resolve_feedback', 'get_feedback', 'get_chat_autonomy', 'search_chats',
      'list_pending_confirmations', 'schedule_get', 'goal_get', 'todo_get', 'hook_list']) {
      expect(mentions(chat, t)).toBe(true);
    }
    // B — fleet supervisor: supervisor-only + fleet-ops tools
    for (const t of ['get_supervisor_state', 'register_infra_blocker', 'clear_infra_blocker', 'list_infra_blockers',
      'get_platform_network_info', 'ack_digest_item', 'unack_digest_item', 'list_instances', 'revoke_chat_webhook',
      'create_chat', 'release_watched_resource', 'goal_get', 'todo_get', 'schedule_get', 'hook_list', 'get_project', 'get_feedback']) {
      expect(mentions(fleet, t)).toBe(true);
    }
    // sibling-branch tools named in the fleet prompt (not yet registered here — see the note above)
    expect(mentions(fleet, 'test_model_role')).toBe(true);
    expect(fleet).toContain('prune_build_cache');
    expect(fleet).toContain('propose_volume_growth');
    // C — project supervisor: state doc, read-back, uploads, resources
    for (const t of ['get_supervisor_state', 'goal_get', 'todo_get', 'schedule_get', 'hook_list', 'get_project', 'get_feedback',
      'list_chat_uploads', 'read_chat_upload', 'add_knowledge_file', 'register_watched_resource', 'observe_resource',
      'register_artifact', 'verify_durable', 'release_watched_resource', 'revoke_chat_webhook']) {
      expect(mentions(project, t)).toBe(true);
    }
    // D — sweep prompts: step 2 + step 5 suffixes
    for (const sweep of [fleetSweep, projectSweep]) {
      expect(sweep).toContain('[SUPERVISOR STATE] (get_supervisor_state for the full doc)');
      expect(sweep).toContain("schedule_get reads a cadence's STORED prompt when its firings look wrong.");
    }
    // E — coding orchestrator: infra + resource tools
    expect(coding).toContain('INFRA + RESOURCES');
    for (const t of ['infra_action', 'restart_dev_tailnet', 'list_infra_blockers', 'get_platform_network_info',
      'register_watched_resource', 'observe_resource', 'register_artifact', 'verify_durable', 'release_watched_resource']) {
      expect(mentions(coding, t)).toBe(true);
    }
    // Layered prompts 2026-09-27: the switch is NAMED, never as a `=1` toggle instruction (prompt-hygiene lint).
    for (const kind of ['env_probe', 'dev_container_resize', 'reap_orphans', 'worker_restart', 'prune_build_cache', 'propose_volume_growth', 'INFRA_ACTIONS_ENABLED']) {
      expect(coding).toContain(kind);
    }
  });
});
