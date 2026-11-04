/**
 * Browser Agent — open-source (GLM-5.3, reasoning_effort:"high") web automation.
 *
 * Public surface used by the crossmodel controller's `browser_agent` patience mode.
 */

export { runBrowserAgentSession, BROWSER_TOOL_SCHEMA } from './glm-loop';
export { selectBrowserDriver } from './router';
export * from './types';
