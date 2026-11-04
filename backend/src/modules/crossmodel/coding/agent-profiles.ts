/**
 * Agent profiles (One-Digby Phase 2, step 1).
 *
 * A profile parameterizes the SHARED agentLoop so the coding orchestrator and
 * the (upcoming) chat engine run on one engine with different doctrine, tool
 * policy, and budgets. CODING_PROFILE is EXACTLY today's coding behavior — this
 * file changes nothing until a non-default profile is passed.
 */

import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names'; // leaf — NOT platform-tools.ts (drags in platform.service's chain)

export interface AgentProfile {
  kind: 'coding' | 'chat' | 'chat_research';
  /** Top-level orchestrator tool rounds. */
  maxSteps: number;
  /** Per-run cap on total worker delegations. */
  maxDelegations: number;
  /** Running-transcript compaction budget (chars). */
  contextCharBudget: number;
  /**
   * Wall-clock deadline: past it the loop forces the NEXT step to be the last
   * (tools omitted → the model must answer). undefined = no deadline (coding).
   */
  runDeadlineMs?: number;
  /**
   * Token-idle stall bound for every model turn (coding-model.ts runModelTurn `stallMs`): a stream that delivers no
   * token for this long is cut (ESTALL → the transient retry lane). Set by the deep-research council profiles,
   * which carry no wall clock (2026-10-20, chat-agent/council-dispatch.ts researchNoWallClock). undefined = no watchdog.
   */
  streamStallMs?: number;
  /**
   * Workspace features: repo context + agent guide + file/git/process/verify
   * tools + session container. false = pure conversational agent (Phase 2 chat).
   */
  workspaceTools: boolean;
  /** Re-inject <plan> reminders each turn (coding). */
  planReminders: boolean;
  /** Which memory tiers feed the system prompt. */
  memorySource: 'coding' | 'chat';
  /**
   * Supervisor chats only (fleet + project supervisors): keeps the
   * supervisor-state / infra-blocker tools in the offered schema. Every other
   * profile drops them — their executors refuse outside a supervisor chat, so
   * offering them elsewhere only gives a decoder a wrong target
   * (coding/tool-scope.ts, owner 2026-09-22).
   */
  supervisorTools?: boolean;
}

/**
 * Platform tools ("Digby can use Digby", P1) that the CHAT profile's orchestrator
 * opts into — chat-pipeline agents can manage chats/projects/schedules as the
 * user, exactly like the coding orchestrator. The schemas + dispatch live in
 * platform/platform-tools.ts (registered for coding runs via coding/tools.ts);
 * agent.ts's CHAT_ORCH_TOOLS filter unions this list so chat runs advertise them.
 *
 * Three-tier gating (chat runs hardcode permissionMode 'auto', so tier 3 is
 * the real guard there):
 *   1. READ tools (list_chats / get_chat_status / list_schedules): ungated.
 *   2. ORGANIZATIONAL mutations (create/move/rename/archive chats + folders):
 *      gated by checkPermission — auto-allowed in 'auto' runs (reversible, low
 *      blast radius).
 *   3. CONSEQUENTIAL tools (schedule_message / cancel_schedule /
 *      send_chat_message / start_coding_session): USER-TURN-ANCHORED
 *      confirmation enforced inside executePlatformTool regardless of
 *      permissionMode (platform/pending-confirmations.ts) — the first call
 *      registers a pending confirmation; only a re-call from a NEW real user
 *      turn (pending.createdAt < ctx.userTurnAt, args unchanged) executes.
 *      Prompt injection can register a pending but can never confirm one.
 * delete_chat/delete_project stay ask-only regardless of mode (in a chat run
 * the approval prompt auto-denies on timeout — destructive ops simply can't
 * proceed unattended).
 */
export const CHAT_PROFILE_PLATFORM_TOOLS: string[] = [...PLATFORM_TOOL_NAMES];

/** Digby Code orchestrator budgets. Raised to the practical ceiling (owner
 *  directive 2026-07-22: "make all turns and iterations and timeouts as maxed
 *  as possible") — coding runs are unattended long-haul work with no latency
 *  contract; compaction + the plan-drift nudges + the degeneration guard keep
 *  a long run healthy, and Stop/steer keep the user in control. Chat profiles
 *  below keep their tight interactive budgets. */
export const CODING_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 200,
  maxDelegations: 100,
  contextCharBudget: 90_000,
  workspaceTools: true,
  planReminders: true,
  memorySource: 'coding',
};

/**
 * Chat profiles by patience mode (One-Digby Phase 2, step 5+ uses these).
 * Budgets per the locked plan table — with amendment C2 applied: cross-checker
 * deadlines start at today's PROVEN draft numbers (soft ~180s / hard 240s),
 * tightened later from metrics, not hope.
 */
export function chatProfile(mode: 'single_thinking' | 'thinking', hasWorkspace: boolean): AgentProfile {
  void hasWorkspace; // read-only workspace tools are appended by the runner
  if (mode === 'thinking') {
    return {
      kind: 'chat',
      maxSteps: 8,            // research rounds + post-drafts synthesis (raised 2026-07-16: owner's CQL run was cut mid-deliverable at 4/240s)
      maxDelegations: 2,
      contextCharBudget: 100_000, // heavy research runs (SERP + drafts + web_pipe digests) compacted too eagerly at 60k
      runDeadlineMs: 480_000, // only binds when genuinely still working — normal L2 finishes far earlier
      workspaceTools: false,
      planReminders: false,
      memorySource: 'chat',
    };
  }
  return {
    kind: 'chat',
    maxSteps: 6,
    maxDelegations: 2,      // research helpers (web_researcher / cross_checker)
    contextCharBudget: 80_000, // web_pipe digests add up on deep questions
    // 2026-07-16: deep questions on L1 (Qwen + 2x web_pipe) were budget-cut at
    // 180s mid-research; the deadline only binds when genuinely still working,
    // so simple L1 questions stay just as fast.
    runDeadlineMs: 240_000,
    workspaceTools: false,
    planReminders: false,
    memorySource: 'chat',
  };
}

/**
 * The Auto QUICK lane (dynamic roster phase 2, 2026-10-03; owner chose option
 * B — docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md): a lookup / live fact answered by
 * the Quick answers seat with web tools, thinking off and no checker. Four
 * rounds cover search → read → answer with one retry; the deadline only binds
 * a turn that is genuinely still working (BrightData SERPs run 3–20 s each).
 */
export function quickChatProfile(): AgentProfile {
  return {
    kind: 'chat',
    maxSteps: 4,
    maxDelegations: 0,
    contextCharBudget: 60_000,
    runDeadlineMs: 120_000,
    workspaceTools: false,
    planReminders: false,
    memorySource: 'chat',
  };
}

/**
 * Fleet Supervisor profile (2026-08-22 rebuild, Phase 0). The supervisor is a
 * plain chat (isSupervisor=true) whose machine wakes must survey the fleet →
 * act → verify in ONE run. The stock 'thinking' budget (8 steps / 480s) was
 * the direct cause of the phantom-dispatch incident: tools are omitted on the
 * loop's last step (agent.ts), so a wake that burned its 8 rounds surveying
 * hit the forced answer step and NARRATED dispatches it never executed
 * (fabricated session UUIDs, prod 2026-08-21). Raised to survey→act→verify
 * headroom; still chat-tier (no workspace) — the boundary is runtime, not
 * rules. Selected in chat-agent.service for isSupervisor chats only.
 */
export function supervisorProfile(): AgentProfile {
  return {
    kind: 'chat',
    maxSteps: 24,           // survey (list_chats/status/goals) → act (dispatch/nudge) → verify + state update
    maxDelegations: 2,      // research helpers (web_researcher / cross_checker), same as chat
    // Owner 2026-09-11: the supervisor runs on a 1M-token seat (glm-5.3 max
    // thinking / kimi-k3) and must hold the whole fleet picture — 1M chars
    // (~250k tokens) of transcript before compaction, not the 100k chat
    // default. agent.ts caps this by the seat's real window (contextChars).
    contextCharBudget: 1_000_000,
    // 45 min (was 15). Measured 2026-09-11 on our ZAI key: a supervisor-shaped
    // glm-5.3 turn at reasoning_effort 'max' streams ~12 min of thinking before
    // its first content token (717 s; 'high' = 135 s). At 15 min the deadline
    // forced the tools-off final after ONE tool round — survey→act→verify never
    // fit. Binds only when genuinely still working; kimi-k3 wakes rarely reach it.
    runDeadlineMs: 2_700_000,
    workspaceTools: false,
    planReminders: false,
    memorySource: 'chat',
    supervisorTools: true,
  };
}

/**
 * Project Supervisor profile (per-project supervisor lanes, 2026-09-13). A
 * project supervisor is a plain chat (isProjectSupervisor=true) inside ONE
 * project — same machine-wake survey→act→verify shape as the Fleet
 * Supervisor, so it mirrors that budget (generous steps + deadline, chat-tier:
 * no workspace). Selected in chat-agent.service for isProjectSupervisor chats.
 * maxDelegations is raised past the fleet's 2: the lane's whole job is
 * FAN-OUT (delegate/start_coding_session parallel workers for independent
 * work — owner directive "generous caps"); start_coding_session spawns are
 * separately bounded by the spawn guard, so the delegation cap is not the
 * safety control here.
 */
export function projectSupervisorProfile(): AgentProfile {
  return {
    kind: 'chat',
    maxSteps: 24,           // survey the project → act (dispatch/steer) → verify + state update
    maxDelegations: 8,      // parallel worker fan-out for independent work
    contextCharBudget: 1_000_000, // same 1M-token seats as the fleet supervisor
    runDeadlineMs: 2_700_000,     // 45 min — see supervisorProfile for the measurement
    workspaceTools: false,
    planReminders: false,
    memorySource: 'chat',
    supervisorTools: true,
  };
}

/**
 * Cross-checker worker deadlines. Raised 2026-07-16 (owner's CQL research run:
 * BOTH checkers died at exactly 240.0s — the deadline was the failure, same
 * signature as the 2026-06-27 draft-phase raise). Soft = the worker's own
 * runDeadlineMs (model is told to wrap up); hard = harness kill. Checkers now
 * run IN PARALLEL with the orchestrator, so a bigger ceiling costs no extra
 * wall-clock unless the orchestrator is also still researching.
 */
export const CROSS_CHECK_SOFT_MS = 300_000; // worker self-wrap: forces its LAST turn here (240s → 300s owner 2026-09-03: the L2 checker is now a FULL 8-step agentic peer — an autonomous research run needs room the one-shot drafter never did; the L2 primary deadline is 480s, so drafts still land in time)
// Owner 2026-09-18 ("users get the first available answer") — 48 h of prod
// (273 Level 2 turns with a checker card): 55 checkers (20%) were KILLED at the
// old 420 s hard cap with no draft while the lead's tool loop had BLOCKED on
// them (the injector awaited the checker promise from its 2nd step) — the user
// got a 7–12 min single-model answer AND the checker's research was thrown
// away. Now the LEAD waits at most CROSS_CHECK_GATE_MS for the draft (measured
// from the run start), then answers from its own research; the checker keeps
// running to the wider HARD cap and chat-agent/late-crosscheck.ts reconciles
// its draft INTO the delivered message when it lands. 65 of the 273 finished in
// the 360–420 s bucket — the cap sat right on the checker's finishing curve.
export const CROSS_CHECK_GATE_MS = 300_000; // longest the lead's tool loop blocks for the draft; past it the answer ships and the draft reconciles late
export const CROSS_CHECK_HARD_MS = 900_000; // harness kill — bounds the background checker only (the lead no longer waits on it past the gate); was 420 s
// Step-0 fast answers (orchestrator finishes with no tool round, so the
// step≥1 injector never delivers the checker drafts — ~10/day in prod,
// 2026-08-18): how long finalize waits for a late draft before giving up on
// reconciling, and the one-shot reconcile pass's bound. NOTE: at maxSteps 1
// the profile runDeadlineMs never fires inside the loop (agent.ts only
// enforces it on mid-run steps) — the reconcile's real hard bound is the
// outer Promise.race (RECONCILE + 15s); the profile field only nudges the
// worker's own wrap-up if the loop internals ever grow steps.
// Owner 2026-09-18 ("users get the first available answer"): the late-wait
// used to be 60 s and the draft was DISCARDED when it missed — the Double
// Checker's full research (300 s soft cap since 2026-09-03) rarely made a
// 60 s window after a context-only lead answer (11 of 51 supervisor L2 turns
// in 48 h shipped single-model). Now: a short grace to catch a draft that is
// about to land, then the lead answer ships and chat-agent/late-crosscheck.ts
// reconciles the draft INTO the persisted message when it arrives ("Updated
// after the Double Checker finished").
export const CROSS_CHECK_LATE_WAIT_MS = 10_000;
export const CROSS_CHECK_RECONCILE_MS = 150_000;
// Late reconcile (chat-agent/late-crosscheck.ts) runs OFF the request path —
// the answer already shipped, so its bound is about cost, not latency. First
// four live late reconciles (2026-09-19 00:54–01:50Z): the one-shot pass took
// 150 s, 79 s, 165 s (killed at the cap → reconcile_failed, the checker's
// 502 s draft discarded) and 159 s. A kimi-k3 reconcile of two long drafts
// sits right at the inline cap, so the late path gets twice the room.
export const CROSS_CHECK_LATE_RECONCILE_MS = 300_000;
/** Machine wakes (supervisor hook/schedule turns — nobody is waiting on the
 *  stream): the late reconcile gets a wider bound. Autonomy loop #7: both
 *  reconcile_failed rows on 2026-09-19 were supervisor wakes whose pass hit the
 *  300 s bound at 315 s on ordinary 2–3k-char drafts / 6–7k-char checker blocks —
 *  the tail of Kimi's reasoning latency, not oversized input (ok passes ran
 *  93–299 s). 540 s keeps the revision inside the 900 s retiring drain. */
export const CROSS_CHECK_LATE_RECONCILE_MACHINE_MS = 540_000;
