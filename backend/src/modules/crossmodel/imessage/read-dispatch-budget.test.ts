/**
 * Mac iMessage READ-path dispatch budget pin (2026-10-22, Mac-wedge class
 * fix, Fleet Supervisor ask). The owner's outdated v0.6.3 Mac agent reads a
 * large chat.db slowly — the 8 s hardcoded dispatch budget expired before
 * list_chats / get_messages answered, so the read path silently degraded
 * (non-blocking warns) while the Mac itself was healthy. One shared budget
 * IMESSAGE_READ_DISPATCH_TIMEOUT_MS (agent-link.ts) now defaults 30 s at
 * every read-path site; IMESSAGE_READ_DISPATCH_BUDGET_30S_DISABLED=1 restores
 * the 8 s budget (switch-registry ledger 663). Source pins (the
 * cross-check-action-claims pattern): agent-link.ts's import graph reaches
 * config/env, so the constant's SHAPE is pinned from source, and every
 * read-path dispatch site is pinned to use it — a future hardcoded-8000
 * regression in the Mac read path fails here.
 */

import * as fs from 'fs';
import * as path from 'path';

const AGENT_LINK = fs.readFileSync(path.join(__dirname, 'agent-link.ts'), 'utf8');
const CODING_INTEGRATIONS = fs.readFileSync(path.join(__dirname, '../coding/coding-integrations.ts'), 'utf8');
const INTEGRATION_CONTEXT = fs.readFileSync(path.join(__dirname, '../integration-context.ts'), 'utf8');
const CHAT_AGENT = fs.readFileSync(path.join(__dirname, '../chat-agent/chat-agent.service.ts'), 'utf8');

describe('IMESSAGE_READ_DISPATCH_TIMEOUT_MS — the shared Mac read budget', () => {
  it('agent-link.ts defines it: 30 s default, 8 s under the kill switch', () => {
    expect(AGENT_LINK).toContain(
      "export const IMESSAGE_READ_DISPATCH_TIMEOUT_MS = process.env.IMESSAGE_READ_DISPATCH_BUDGET_30S_DISABLED === '1' ? 8_000 : 30_000;",
    );
  });

  it('the lane tools (imessage_list_chats / imessage_get_messages) dispatch with it', () => {
    expect(CODING_INTEGRATIONS).toContain("await agentBroker.dispatch(selection.agent.id, 'list_chats', { limit: args.limit ? Number(args.limit) : undefined }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS)");
    expect(CODING_INTEGRATIONS).toContain("await agentBroker.dispatch(selection.agent.id, 'get_messages', { chat: S(args.chat), limit: args.limit ? Number(args.limit) : undefined }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS)");
  });

  it('the plain-chat read enrichment (integration-context) dispatches with it', () => {
    expect(INTEGRATION_CONTEXT).toContain("await agentBroker.dispatch(agent.id, 'list_chats', { limit: 25 }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS)");
    expect(INTEGRATION_CONTEXT).toContain("await agentBroker.dispatch(agent.id, 'get_messages', { chat: target, limit: 25 }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS)");
  });

  it('the send-flow name resolution (chat-agent) dispatches with it — the same wedge class', () => {
    expect(CHAT_AGENT).toContain("await agentBroker.dispatch(args.imessagePairedAgentId, 'list_chats', { limit: 25 }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS)");
  });

  it('no hardcoded 8 s Mac read dispatch survives in the read path', () => {
    for (const [name, src] of [['coding-integrations', CODING_INTEGRATIONS], ['integration-context', INTEGRATION_CONTEXT], ['chat-agent', CHAT_AGENT]] as const) {
      expect(src).not.toMatch(/agentBroker\.dispatch\([^)]*'(list_chats|get_messages)'[^)]*,\s*8000\)/);
      void name;
    }
  });
});
