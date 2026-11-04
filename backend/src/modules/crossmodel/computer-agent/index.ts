/**
 * Computer Agent — Digby's computer-use feature.
 *
 * A vision model sees the user's paired Mac screen and drives it (click, type,
 * keys, scroll, open apps) via the agentBroker channel. Entry point:
 * runComputerAgentSession (computer-loop.ts). Availability requires the paired
 * agent at v0.3.0+ (driver.ts computerAgentStatus).
 */

export { runComputerAgentSession } from './computer-loop';
export { computerAgentStatus, selectComputerDriver } from './driver';
export * from './types';
