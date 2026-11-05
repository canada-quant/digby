/**
 * MERGE-1 slice 2 (owner completion directive 2026-11-03) — ONE per-message
 * harness-profile rule, in ONE place.
 *
 * THE DEFECT THIS FIXES. The "does THIS message run the coding harness?"
 * decision was re-implemented at three send seams and the copies had drifted:
 *
 *   1. platform.service.ts sendChatMessage  — capability → code-intent
 *      heuristic → workspace-attach-gate → attach. Correct.
 *   2. crossmodel.controller.ts streamQuery — same shape, same guards. Correct,
 *      but a second copy of every guard (owner / supervisor / escalation /
 *      kid / uploads).
 *   3. crossmodel.controller.ts streamChatRun's `?message=` back-compat start
 *      — `if (codeCapable) streamCapabilityRun(...)`. NO gate, NO code-intent
 *      heuristic, NO supervisor guard. Since `codeCapable` includes the
 *      folder-chain leg and every chat is auto-filed into a capable user-space
 *      project, that seam attached a PERMANENT workspace (converting the chat
 *      into a coding session for good) on ANY GET carrying a message —
 *      including `GET /chats/<plain-chat-id>/stream?message=hello`. A GET that
 *      mutates, ungated, at exactly the seam the 2026-10-20 workspace-attach
 *      audit built the gate to close.
 *
 * THE RULE (one place, now):
 *   - The SATELLITE decides routing. `hasWorkspaceState` ⇒ the coding profile,
 *     full stop. `codeCapable` alone NEVER routes — it means exactly
 *     "attachable on demand" (User Space §4). This is what makes the stream
 *     path invariant true: no session enters a stream path its capability does
 *     not grant, because the capability that grants the path IS the satellite.
 *   - With no satellite, the attach PROBE may convert the chat for THIS send.
 *     The probe is gated exactly as before: owner send (members are read-only
 *     on runs), not a supervisor lane (fleet or project — those orchestrate
 *     workers, they are not workers), not a Dig-deeper escalation (it deepens a
 *     chat answer), not a child account (coding is an adult surface), a
 *     code-intent message, and the task-kind gate's verdict.
 *   - The guards gate ONLY the probe, never the satellite leg. A chat that
 *     already carries a satellite routes coding on every seam regardless of the
 *     supervisor/escalation flags — that is today's behavior at seams 1 and 2
 *     and changing it here would be a routing change dressed as a refactor.
 *
 * The probe's own telemetry (the `workspace_attach_gate` loop_metrics row) stays
 * in workspace-attach-gate.ts — this module only decides who may ask it.
 */

import { routeMessageHeuristic } from './auto-router';
import type { AttachDecision, AttachOrigin } from './workspace-attach-gate';
import type { ChatCapability } from '../coding/coding-data.service';

/** Which harness a single message runs. */
export type SendProfile = 'coding' | 'chat';

/**
 * Why the probe declined to attach — kept distinct from the gate's own reason so
 * a log line says WHICH guard fired (the three seams used to disagree here).
 */
export type ProbeDecline =
  | 'not_owner'          // a member's send: read-only on runs, fall through to chat
  | 'supervisor_lane'    // fleet or project supervisor — a plain chat by design
  | 'escalation'         // Dig-deeper deepens a chat answer, never converts
  | 'child_account'      // coding is an adult surface (§4c)
  | 'probe_disabled'     // the caller forbade conversion (e.g. a viewer attach)
  | 'not_capable'        // no satellite and no resolvable workspace — nothing to attach
  | 'no_code_intent'     // the code-intent keyword list did not fire
  | 'gate_declined';     // the task-kind gate kept the turn a chat

export interface SendProfileChat {
  id: string;
  userId: string;
  projectId?: string | null;
  title?: string;
  isSupervisor?: boolean | null;
  isProjectSupervisor?: boolean | null;
}

export interface ResolveSendProfileInput {
  chat: SendProfileChat;
  /** The user id performing the send. */
  senderUserId: string;
  message: string;
  /** Who authored the text — the gate treats machine text differently. */
  origin?: AttachOrigin;
  /** The gate's state segment (the seams pass 'user'; agent sends pass their own). */
  segment?: string;
  /** The send carries attachments (the ask could not see the same state). */
  hasUploads?: boolean;
  /** A Dig-deeper escalation: it deepens a chat answer and never routes coding. */
  escalation?: boolean;
  /**
   * Whether the sender is a child account. `undefined` = not known by the
   * caller: this resolver reads it lazily, and ONLY when it would otherwise
   * attach (the same single query the seams made before).
   */
  senderIsChild?: boolean;
  /** `false` skips the attach probe entirely — the caller must never convert. */
  probe?: boolean;
}

export interface SendProfileDecision {
  profile: SendProfile;
  capability: ChatCapability;
  /** TRUE only when THIS send caused the satellite to be created. */
  attached: boolean;
  /** Why the probe declined (null when it was never asked). */
  declined: ProbeDecline | null;
  /** The gate's verdict, when the probe actually asked it. */
  gate: AttachDecision | null;
}

const CAP_NONE: ChatCapability = { codeCapable: false, hasWorkspaceState: false, workspaceReady: false };

/**
 * THE per-message harness-profile rule. Both the REST send seam and the
 * back-compat GET start call this instead of re-deriving the guards.
 *
 * Never throws for a routing reason: a capability read failure degrades to the
 * chat profile (fail-closed — a chat answer is recoverable, a wrong permanent
 * conversion is not). The attach itself is still allowed to throw upward at the
 * callers that today `.catch(() => null)` it; a failed attach yields the chat
 * profile.
 */
export async function resolveSendProfile(input: ResolveSendProfileInput): Promise<SendProfileDecision> {
  const { chat, senderUserId, message } = input;
  const origin: AttachOrigin = input.origin ?? 'user';
  const probeAllowed = input.probe !== false;

  const { getChatCapability } = await import('../coding/coding-data.service');
  const capability = await getChatCapability(chat as any).catch(() => CAP_NONE);

  // A Dig-deeper escalation deepens a CHAT answer — it never enters the coding
  // harness, not even on a chat that already carries a satellite. This is the
  // controller's long-standing behaviour (`hasWorkspaceState && !escalation`),
  // preserved verbatim so the convergence does not smuggle in a routing change.
  if (input.escalation) return { profile: 'chat', capability, attached: false, declined: 'escalation', gate: null };

  // THE ROUTING RULE: the satellite, never folder capability, selects coding.
  if (capability.hasWorkspaceState) {
    return { profile: 'coding', capability, attached: false, declined: null, gate: null };
  }

  if (!probeAllowed) return { profile: 'chat', capability, attached: false, declined: 'probe_disabled', gate: null };
  if (chat.userId !== senderUserId) return { profile: 'chat', capability, attached: false, declined: 'not_owner', gate: null };
  if (chat.isSupervisor === true || chat.isProjectSupervisor === true) {
    return { profile: 'chat', capability, attached: false, declined: 'supervisor_lane', gate: null };
  }
  if (!capability.codeCapable) return { profile: 'chat', capability, attached: false, declined: 'not_capable', gate: null };

  // The keyword hit is a TRIGGER; the task-kind gate below is the verdict.
  if (!routeMessageHeuristic({ content: message, hasWorkspace: capability.codeCapable }).needsWorkspace) {
    return { profile: 'chat', capability, attached: false, declined: 'no_code_intent', gate: null };
  }

  // Child read is lazy — one query, only on the path that could convert (§4c).
  const isChild = input.senderIsChild !== undefined
    ? input.senderIsChild
    : (await import('../../../config/database').then((m) => m.default.user
        .findUnique({ where: { id: senderUserId }, select: { isChild: true } })
        .catch(() => null))
      .catch(() => null))?.isChild === true;
  if (isChild) return { profile: 'chat', capability, attached: false, declined: 'child_account', gate: null };

  const { shouldAttachWorkspace } = await import('./workspace-attach-gate');
  // The gate's call shape is a PINNED CONTRACT at BOTH seams, and they differ:
  // the controller's send passes `segment`, the platform send does not
  // (crossmodel.controller.attach-gate.test.ts:156 and
  // platform.service.test.ts:1987 assert the exact object). So `hasUploads`
  // always rides and `segment` rides only when the caller passes one — each
  // seam keeps its own pinned shape, byte for byte.
  const gate = await shouldAttachWorkspace(message, {
    chatId: chat.id,
    origin,
    ...(input.segment !== undefined ? { segment: input.segment } : {}),
    hasUploads: !!input.hasUploads,
  }).catch(() => null);
  // A gate that could not answer is today's keyword behaviour (attach) — the
  // gate documents the same fail-open on its own side.
  if (gate && !gate.attach) {
    const label = String(chat.id).slice(0, 8);
    (await import('../../../utils/logger').then((m) => m.default)).info(
      `userspace: chat ${label} kept a chat — "${gate.label}" keyword, ${gate.reason} (task kind ${gate.kind}, p ${gate.p?.toFixed(2)})`,
    );
    return { profile: 'chat', capability, attached: false, declined: 'gate_declined', gate };
  }

  const { ensureChatWorkspaceState } = await import('../coding/coding-data.service');
  const attachedSession = await ensureChatWorkspaceState(chat as any).catch(() => null);
  if (!attachedSession) {
    return { profile: 'chat', capability, attached: false, declined: 'not_capable', gate };
  }
  const logger = (await import('../../../utils/logger').then((m) => m.default));
  logger.info(
    `userspace: router attached workspace to chat ${String(chat.id).slice(0, 8)} (code-intent send; ${gate?.reason ?? 'attached'})`,
  );
  return {
    profile: 'coding',
    capability: { ...capability, hasWorkspaceState: true },
    attached: true,
    declined: null,
    gate,
  };
}