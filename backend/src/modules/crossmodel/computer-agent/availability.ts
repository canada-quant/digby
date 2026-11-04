/**
 * Computer-use availability — the PURE leaf (no Redis/Prisma imports), shared by
 * the computer driver, the browser router's three-way choice, and the iMessage
 * /status endpoint, so every surface answers "can Digby drive this user's Mac
 * right now?" from ONE gate: paired agent online AND app ≥ 0.3.0 (the version
 * that ships the computer_* methods). The vision-model check lives with the
 * caller (vision-client.ts visionConfigured()) — it is server config, not the
 * Mac's state.
 *
 * Windows client W0 (2026-09-25): the gate is now CAPABILITY-AWARE. An agent
 * that advertises a capability set (agent-capabilities.ts handshake — a Windows
 * agent advertises ['browser','computer']) answers from the advertisement; a
 * legacy row (no advertisement = every pre-W0 Mac) keeps the exact historical
 * version gate, so the existing fleet sees zero change.
 */

import { isOnline } from '../imessage/imessage.service';
import { advertisesCapabilities, hasCapability, platformNoun } from '../imessage/agent-capabilities';

/** Minimum agent version that ships the computer_* methods (legacy Mac gate). */
export const MIN_COMPUTER_VERSION = [0, 3, 0];

/** W3 (Windows agent 0.9.0, 2026-09-25): UI Automation commands
 *  (computer_uia_tree / computer_uia_invoke) ship ONLY in the Windows agent
 *  0.9.0 — dispatched with this stricter gate, and the matching model tools
 *  are OFFERED only to agents this new. Lives in this PURE leaf so both the
 *  driver (dispatch gate) and the loop (tool/instruction offer gate) share
 *  ONE constant — and so test suites that mock ./driver still see it. */
export const UIA_DISPATCH_MIN_AGENT_VERSION = '0.9.0';

export function versionAtLeast(version: string | null | undefined, min: number[]): boolean {
  if (!version) return false;
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a > min[i]) return true;
    if (a < min[i]) return false;
  }
  return true; // equal
}

export interface AgentLike {
  agentVersion?: string | null;
  lastSeenAt?: Date | null;
  platform?: string | null;
  capabilities?: readonly string[] | null;
}

/** True when the paired Mac can run computer_* commands right now.
 *  W0: an advertising agent answers from its advertisement (a Windows agent
 *  ships computer_* but not iMessage); a legacy Mac row keeps the version gate. */
export function computerUseAvailable(agent: AgentLike | null | undefined): boolean {
  if (!agent || !isOnline(agent.lastSeenAt)) return false;
  if (advertisesCapabilities(agent)) return hasCapability(agent, 'computer');
  return versionAtLeast(agent.agentVersion, MIN_COMPUTER_VERSION);
}

function lastSeenAgo(lastSeenAt: Date | null | undefined): string {
  if (!lastSeenAt) return 'never seen online';
  const mins = Math.max(0, Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 60000));
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `last seen ${hours} h ago`;
  return `last seen ${Math.round(hours / 24)} d ago`;
}

/** Human-readable computer-use availability for the paired Mac.
 *  W0: Windows rows get Windows-app copy; legacy/advertised Mac rows keep the
 *  exact historical strings (pinned by tests and surfaced in the product). */
export function computerAgentStatus(agent: AgentLike | null | undefined): string {
  if (!agent) {
    return 'not connected — no Digby Mac agent is paired (pair the Mac app to let Digby see and drive your computer)';
  }
  const isWindows = platformNoun(agent) === 'Windows PC';
  if (!isOnline(agent.lastSeenAt)) {
    return isWindows
      ? `offline — your paired Windows PC is ${lastSeenAgo(agent.lastSeenAt)} (open the Digby app to reconnect)`
      : `offline — your paired Mac is ${lastSeenAgo(agent.lastSeenAt)} (open the Digby Mac app to reconnect)`;
  }
  if (advertisesCapabilities(agent)) {
    if (hasCapability(agent, 'computer')) {
      return `connected (${isWindows ? 'Windows agent' : 'Mac app'} v${agent.agentVersion || 'unknown'})`;
    }
    return `connected — this ${isWindows ? 'Windows PC' : 'Mac'} does not support computer use`;
  }
  if (!versionAtLeast(agent.agentVersion, MIN_COMPUTER_VERSION)) {
    return `connected but too old — Mac app v${agent.agentVersion || 'unknown'}; computer use needs v${MIN_COMPUTER_VERSION.join('.')} or newer (update the Digby Mac app)`;
  }
  return `connected (Mac app v${agent.agentVersion || 'unknown'})`;
}
