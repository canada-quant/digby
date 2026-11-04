/**
 * Ticket 56df4bfc fix pin — lossy finals: audit/self-audit summaries displacing
 * the actual deliverable in coding-lane final messages (2nd same-day instance).
 *
 * The incident class: a lane's FINAL message — the one durable message the
 * supervisor, the owner, and future runs are guaranteed to see — carried only
 * an audit/ETA summary while the deliverable itself stayed in the worktree or
 * in non-durable mid-run text (CanLaw Path C lane cec340f2: the SFT-2 shard
 * plan existed at .digby/ops/sft2-dataset-v2-shard-plan.md but TWO consecutive
 * scheduled ticks delivered only an ETA line / an audit summary; fleet-wide
 * corroboration: dozens of lanes' lastMessage = "Self-audit PASSED…" only).
 *
 * The fix is doctrine at the two harness prompt surfaces that shape finals:
 *  1. coding/agent.ts FINAL_TURN_NOTICE — now deliverable-FIRST: lead with the
 *     work; audit/claim text may follow but must never displace it.
 *  2. feedback/ticket-dispatch.service CLAIM_BAR — the claim bar is explicitly
 *     SUBORDINATE to the deliverable.
 *
 * These pins assert the new deliverable-supremacy wording AND that the older
 * invariants the same strings carry were not weakened:
 *  - anti-transition-line (owner E2E 2026-07-16),
 *  - anti-confabulation honest-partial authorization (fabrication RCA
 *    2026-08-23 — the notice must keep authorizing honest partials),
 *  - the claim bar's anti-phantom rule.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn(), incr: jest.fn(), expire: jest.fn(), decr: jest.fn() },
}));

// MCP integration modules (the coding-integrations import chain).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { FINAL_TURN_NOTICE } from './agent';
import { CLAIM_BAR } from '../feedback/ticket-dispatch.service';

describe('ticket 56df4bfc — lossy finals: deliverable-supremacy doctrine', () => {
  it('FINAL_TURN_NOTICE: the deliverable LEADS and audit/claim text is explicitly subordinate', () => {
    expect(FINAL_TURN_NOTICE).toContain('DURABLE DELIVERABLE');
    expect(FINAL_TURN_NOTICE).toContain('LEAD with what the run produced');
    expect(FINAL_TURN_NOTICE).toContain('must never displace it');
    expect(FINAL_TURN_NOTICE).toContain('FAILED delivery');
    expect(FINAL_TURN_NOTICE).toContain('56df4bfc');
  });

  it('FINAL_TURN_NOTICE: the deliverable demand PRECEDES the claim discipline', () => {
    const lead = FINAL_TURN_NOTICE.indexOf('LEAD with what the run produced');
    const claims = FINAL_TURN_NOTICE.indexOf('citing the tool results you hold');
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(claims).toBeGreaterThanOrEqual(0);
    expect(lead).toBeLessThan(claims);
  });

  it('FINAL_TURN_NOTICE: pre-existing invariants NOT weakened (anti-transition, anti-confabulation honest-partial, no-invented-results)', () => {
    expect(FINAL_TURN_NOTICE).toContain('FINAL TURN: tool calls are no longer available');
    expect(FINAL_TURN_NOTICE).toContain('not a transition line');
    expect(FINAL_TURN_NOTICE).toContain('honest partial status IS the correct deliverable');
    expect(FINAL_TURN_NOTICE).toContain('NEVER describe an action, timestamp, PR, or result you did not obtain from a tool this run');
  });

  it('CLAIM_BAR: deliverable supremacy appended while the anti-phantom bar survives', () => {
    expect(CLAIM_BAR).toContain('Anti-phantom rule: report only actions whose tool results you hold, with ids.');
    expect(CLAIM_BAR).toContain('Deliverable supremacy');
    expect(CLAIM_BAR).toContain('SUBORDINATE to the deliverable');
    expect(CLAIM_BAR).toContain('FAILED delivery');
    expect(CLAIM_BAR).toContain('56df4bfc');
  });
});
