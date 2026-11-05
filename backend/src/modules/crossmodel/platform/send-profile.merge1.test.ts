/**
 * MERGE-1 slice 2 (owner completion directive 2026-11-03) — ONE per-message
 * harness-profile rule.
 *
 * THE DEFECT THIS PINS. "Does THIS message run the coding harness?" was
 * re-implemented at three send seams; two were correct copies, the third
 * (the GET /chats/:id/stream `?message=` back-compat start) read
 *
 *     if (capability.codeCapable) streamCapabilityRun(...)
 *
 * with no owner/supervisor/escalation guard, no code-intent trigger and no
 * task-kind gate. `codeCapable` includes the folder-chain leg and every chat is
 * auto-filed into a capable user-space project, so ANY
 * `GET /chats/<plain-chat>/stream?message=hello` attached a PERMANENT workspace
 * satellite — converting a plain chat into a coding session for good. A
 * mutating GET, ungated, at the exact seam the 2026-10-20 workspace-attach
 * audit exists to close.
 *
 * WHAT IS FROZEN HERE:
 *   1. THE ROUTING INVARIANT — `hasWorkspaceState` (the satellite), never
 *      `codeCapable`, selects the coding profile. This is the slice's
 *      charter line: "no session enters a stream path its capability does not
 *      grant", where the granting capability IS the satellite.
 *   2. The probe gates: owner, non-supervisor (both kinds), non-escalation,
 *      non-child, code-intent, and the task-kind gate's verdict. Each declines
 *      to the CHAT profile and attaches nothing.
 *   3. A satellite chat routes coding regardless of those flags — except an
 *      escalation, which is the controller's long-standing behaviour and is
 *      preserved verbatim (this convergence must not smuggle a routing change).
 *   4. The ATTACH receipt: `attached` is true only when THIS send created the
 *      satellite, so a caller can log/audit a conversion and never a mere read.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockIsChild = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { user: { findUnique: (...a: any[]) => mockIsChild(...a) } },
}));

const mockGetChatCapability = jest.fn();
const mockEnsure = jest.fn();
jest.mock('../coding/coding-data.service', () => ({
  getChatCapability: (...a: any[]) => mockGetChatCapability(...a),
  ensureChatWorkspaceState: (...a: any[]) => mockEnsure(...a),
}));

const mockNeedsWorkspace = jest.fn();
jest.mock('./auto-router', () => ({
  routeMessageHeuristic: (...a: any[]) => mockNeedsWorkspace(...a),
}));

const mockGate = jest.fn();
jest.mock('./workspace-attach-gate', () => ({
  shouldAttachWorkspace: (...a: any[]) => mockGate(...a),
}));

import { resolveSendProfile } from './send-profile';

const CHAT = {
  id: 'chat-0000-1111',
  userId: 'u1',
  projectId: 'p1',
  title: 'T',
  isSupervisor: false,
  isProjectSupervisor: false,
};

const CAP_SATELLITE = { codeCapable: true, hasWorkspaceState: true, workspaceReady: true };
const CAP_CAPABLE_ONLY = { codeCapable: true, hasWorkspaceState: false, workspaceReady: false };
const CAP_PLAIN = { codeCapable: false, hasWorkspaceState: false, workspaceReady: false };

const attachedDecision = (reason = 'kind_code') =>
  ({ attach: true, wouldAttach: true, mode: 'act', reason, label: 'code intent', kind: 'code', p: 0.9 });
const declinedDecision = () =>
  ({ attach: false, wouldAttach: false, mode: 'act', reason: 'kind_not_code', label: 'code intent', kind: 'writing', p: 0.97 });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsChild.mockResolvedValue({ isChild: false });
  mockNeedsWorkspace.mockReturnValue({ needsWorkspace: true });
  mockGate.mockResolvedValue(attachedDecision());
  mockEnsure.mockResolvedValue({ id: CHAT.id });
  mockGetChatCapability.mockResolvedValue(CAP_CAPABLE_ONLY);
});

describe('resolveSendProfile — THE ROUTING RULE (the satellite decides)', () => {
  it('a chat CARRYING a satellite runs coding, and never probes for another one', async () => {
    mockGetChatCapability.mockResolvedValue(CAP_SATELLITE);
    const d = await resolveSendProfile({
      chat: { ...CHAT, isProjectSupervisor: true }, // even a supervisor satellite routes coding
      senderUserId: 'u1',
      message: 'what is the weather',
    });
    expect(d.profile).toBe('coding');
    expect(d.attached).toBe(false);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockNeedsWorkspace).not.toHaveBeenCalled();
  });

  it('codeCapable WITHOUT a satellite does NOT route coding on a non-code message — nothing is attached', async () => {
    mockNeedsWorkspace.mockReturnValue({ needsWorkspace: false });
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'what is the weather' });
    expect(d.profile).toBe('chat');
    expect(d.declined).toBe('no_code_intent');
    expect(d.attached).toBe(false);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockGate).not.toHaveBeenCalled(); // the gate is never even asked
  });

  it('an INCAPABLE chat (no satellite, no resolvable folder) falls to chat and mints nothing', async () => {
    mockGetChatCapability.mockResolvedValue(CAP_PLAIN);
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the failing build' });
    expect(d.profile).toBe('chat');
    expect(d.declined).toBe('not_capable');
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe('resolveSendProfile — the probe guards (each one declines to CHAT)', () => {
  it('a MEMBER send never converts the owner’s chat', async () => {
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'someone-else', message: 'fix the build' });
    expect(d).toMatchObject({ profile: 'chat', declined: 'not_owner', attached: false });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('a FLEET supervisor lane is never converted (it orchestrates workers, it is not one)', async () => {
    const d = await resolveSendProfile({
      chat: { ...CHAT, isSupervisor: true }, senderUserId: 'u1', message: 'fix the build',
    });
    expect(d).toMatchObject({ profile: 'chat', declined: 'supervisor_lane', attached: false });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('a PROJECT supervisor lane is never converted (the 2026-09-14 rollout watch)', async () => {
    const d = await resolveSendProfile({
      chat: { ...CHAT, isProjectSupervisor: true }, senderUserId: 'u1', message: 'fix the build',
    });
    expect(d).toMatchObject({ profile: 'chat', declined: 'supervisor_lane', attached: false });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('a CHILD account never converts a chat (coding is an adult surface, §4c)', async () => {
    mockIsChild.mockResolvedValue({ isChild: true });
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the build' });
    expect(d).toMatchObject({ profile: 'chat', declined: 'child_account', attached: false });
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('the task-kind gate keeps a confidently non-code ask a chat — a conversion is PERMANENT, a retry is not', async () => {
    // "fix the grammar: their going to there house later" — the 2026-10-20 audit's case.
    mockGate.mockResolvedValue(declinedDecision());
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the grammar: their going to there house later' });
    expect(d).toMatchObject({ profile: 'chat', declined: 'gate_declined', attached: false });
    expect(d.gate).toMatchObject({ reason: 'kind_not_code', kind: 'writing' });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('probe:false forbids conversion outright (the viewer-attach posture)', async () => {
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the build', probe: false });
    expect(d).toMatchObject({ profile: 'chat', declined: 'probe_disabled', attached: false });
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe('resolveSendProfile — a conversion that IS granted', () => {
  it('owner + capable + code intent + gate.attach ⇒ attach ONCE and route THIS message coding', async () => {
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the failing build' });
    expect(d.profile).toBe('coding');
    expect(d.attached).toBe(true);
    expect(d.capability.hasWorkspaceState).toBe(true);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    // The gate is told which chat and who authored the text.
    expect(mockGate).toHaveBeenCalledWith('fix the failing build', expect.objectContaining({ chatId: CHAT.id, origin: 'user' }));
  });

  it('an attach that FAILS yields the chat profile — never a coding route to a satellite that is not there', async () => {
    mockEnsure.mockResolvedValue(null);
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the failing build' });
    expect(d.profile).toBe('chat');
    expect(d.attached).toBe(false);
    expect(d.capability.hasWorkspaceState).toBe(false);
  });

  it('a capability read failure is fail-CLOSED to chat (a wrong permanent conversion is not recoverable)', async () => {
    mockGetChatCapability.mockRejectedValue(new Error('db down'));
    const d = await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the failing build' });
    expect(d.profile).toBe('chat');
    expect(d.attached).toBe(false);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('uploads ride to the gate as hasUploads (the ask could not see the same state)', async () => {
    await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the build', hasUploads: true });
    expect(mockGate).toHaveBeenCalledWith('fix the build', expect.objectContaining({ hasUploads: true }));
  });

  it('an AGENT-origin send reaches the gate with its own origin (webhook text is never a human turn)', async () => {
    await resolveSendProfile({ chat: CHAT, senderUserId: 'u1', message: 'fix the build', origin: 'agent' });
    expect(mockGate).toHaveBeenCalledWith('fix the build', expect.objectContaining({ origin: 'agent' }));
  });
});