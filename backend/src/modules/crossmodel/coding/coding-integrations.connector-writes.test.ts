/**
 * executeIntegrationTool — #26 connector WRITE dispatch (2026-09-24): the JSON
 * envelope, the human-turn anchor on imessage_send / slack_post_message / x_post,
 * the unattended Asana edits, the iMessage daily cap, the kill switch, and the
 * worker-role exclusion of every write tool.
 */
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
const redisMock = { get: jest.fn(), set: jest.fn(), del: jest.fn(), incr: jest.fn(async () => 1), decr: jest.fn(async () => 0), expire: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock, redisSubscriber: { subscribe: jest.fn(), on: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../github/github-mcp', () => ({ __esModule: true }));
jest.mock('../google/google-mcp', () => ({ __esModule: true, runGoogleWriteTool: jest.fn(), resolveGoogleAccount: jest.fn() }));
const slackPost = jest.fn();
jest.mock('../slack/slack-mcp', () => ({ __esModule: true, postMessage: (...a: any[]) => slackPost(...a) }));
const asanaCreate = jest.fn(); const asanaUpdate = jest.fn();
jest.mock('../asana/asana-mcp', () => ({ __esModule: true, createTask: (...a: any[]) => asanaCreate(...a), updateTask: (...a: any[]) => asanaUpdate(...a) }));
const xPost = jest.fn();
jest.mock('../x/x-mcp', () => ({ __esModule: true, postTweet: (...a: any[]) => xPost(...a) }));
jest.mock('../xero/xero-mcp', () => ({ __esModule: true }));
jest.mock('../plaid/plaid-mcp', () => ({ __esModule: true }));
const selectAgent = jest.fn();
jest.mock('../imessage/imessage.service', () => ({ __esModule: true, selectAgent: (...a: any[]) => selectAgent(...a), agentDisplayName: (a: any) => a.label ?? 'Mac' }));
const dispatch = jest.fn();
jest.mock('../imessage/agent-link', () => ({ __esModule: true, agentBroker: { dispatch: (...a: any[]) => dispatch(...a) } }));
const metrics = { recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: { GOOGLE_WRITE_TOOL: 'google_write_tool', CONNECTOR_WRITE_TOOL: 'connector_write_tool' } };
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, ...metrics }));

import { executeIntegrationTool } from './coding-integrations';
import { CONNECTOR_WRITE_TOOL_NAMES, INTEGRATION_WRITE_TOOL_NAMES, HUMAN_TURN_CONNECTOR_WRITES } from './integration-tool-schema';
import { toolsForRole, ROLE_TOOLS } from './roles';

const human = { userTurnAt: new Date() };
beforeEach(() => { jest.clearAllMocks(); delete process.env.CONNECTOR_WRITE_TOOLS_DISABLED; delete process.env.IMESSAGE_SEND_DAILY_CAP; redisMock.incr.mockResolvedValue(1); });

describe('connector write dispatch (#26)', () => {
  it('registers the seven tools; five are human-turn-only; every write (Google + #26) is out of every worker role', () => {
    expect([...CONNECTOR_WRITE_TOOL_NAMES].sort()).toEqual(['asana_create_task', 'asana_update_task', 'discord_send_dm', 'discord_send_message', 'imessage_send', 'slack_post_message', 'x_post']);
    expect([...HUMAN_TURN_CONNECTOR_WRITES].sort()).toEqual(['discord_send_dm', 'discord_send_message', 'imessage_send', 'slack_post_message', 'x_post']);
    for (const role of Object.keys(ROLE_TOOLS)) {
      const names = toolsForRole(role as any, []).map((t: any) => t.function.name);
      for (const w of INTEGRATION_WRITE_TOOL_NAMES) expect(names).not.toContain(w);
    }
  });
  it('imessage_send / slack_post_message / x_post / discord sends on a MACHINE run are refused before any call; Asana edits run unattended', async () => {
    for (const t of ['imessage_send', 'slack_post_message', 'x_post', 'discord_send_message', 'discord_send_dm']) {
      const r = JSON.parse(await executeIntegrationTool('u', t, { to: '+15551234567', text: 'hi', channel: '#g', channelId: '123', userId: '456' }));
      expect(r).toMatchObject({ ok: false, tool: t, reason: 'machine_run' });
    }
    expect(dispatch).not.toHaveBeenCalled(); expect(slackPost).not.toHaveBeenCalled(); expect(xPost).not.toHaveBeenCalled();
    asanaCreate.mockResolvedValue('Created task "Ship it" — taskId 120044 — https://app.asana.com/0/1/120044');
    const c = JSON.parse(await executeIntegrationTool('u', 'asana_create_task', { name: 'Ship it', project: 'p1' }));
    expect(c).toMatchObject({ ok: true, tool: 'asana_create_task', ids: { taskId: '120044', link: 'https://app.asana.com/0/1/120044' } });
    expect(asanaCreate).toHaveBeenCalledWith('u', { name: 'Ship it', project: 'p1' });
    asanaUpdate.mockResolvedValue('Updated task "Ship it" — taskId 120044 — completed');
    expect(JSON.parse(await executeIntegrationTool('u', 'asana_update_task', { taskId: '120044', completed: true }))).toMatchObject({ ok: true, ids: { taskId: '120044' } });
    expect(asanaUpdate).toHaveBeenCalledWith('u', '120044', { completed: true });
  });
  it('human-attended sends go through with an envelope; iMessage needs an online Mac and respects the daily cap', async () => {
    selectAgent.mockResolvedValue({ agent: { id: 'ag-1', label: 'MacBook' } });
    dispatch.mockResolvedValue({ sent: true });
    const s = JSON.parse(await executeIntegrationTool('u', 'imessage_send', { to: '+15551234567', text: 'hi' }, human));
    expect(s).toMatchObject({ ok: true, tool: 'imessage_send', device: 'MacBook' });
    expect(dispatch).toHaveBeenCalledWith('ag-1', 'send_message', { to: '+15551234567', text: 'hi' }, 20_000);
    selectAgent.mockResolvedValue({ agent: null, error: 'no Mac online' });
    expect(JSON.parse(await executeIntegrationTool('u', 'imessage_send', { to: 'x@y.z', text: 'hi' }, human))).toMatchObject({ ok: false, reason: 'no_agent' });
    redisMock.incr.mockResolvedValue(41);
    expect(JSON.parse(await executeIntegrationTool('u', 'imessage_send', { to: 'x@y.z', text: 'hi' }, human))).toMatchObject({ ok: false, reason: 'rate_limited' });
    slackPost.mockResolvedValue('Posted to C123 — ts 1727200000.000100');
    expect(JSON.parse(await executeIntegrationTool('u', 'slack_post_message', { channel: '#general', text: 'hello', thread_ts: '1.2' }, human))).toMatchObject({ ok: true, ids: { ts: '1727200000.000100' } });
    expect(slackPost).toHaveBeenCalledWith('u', '#general', 'hello', '1.2');
    slackPost.mockResolvedValue('Error slackPostMessage: missing_scope — reconnect Slack in Account → Integrations to grant posting (chat:write)');
    expect(JSON.parse(await executeIntegrationTool('u', 'slack_post_message', { channel: '#g', text: 'x' }, human))).toMatchObject({ ok: false, reason: 'missing_scopes' });
    slackPost.mockResolvedValue(null);
    expect(JSON.parse(await executeIntegrationTool('u', 'slack_post_message', { channel: '#g', text: 'x' }, human))).toMatchObject({ ok: false, reason: 'not_connected' });
    xPost.mockResolvedValue('Posted tweet — tweetId 1839000000000000001');
    expect(JSON.parse(await executeIntegrationTool('u', 'x_post', { text: 'gm', replyToTweetId: '99' }, human))).toMatchObject({ ok: true, ids: { tweetId: '1839000000000000001' } });
    expect(xPost).toHaveBeenCalledWith('u', 'gm', { replyToTweetId: '99' });
  });
  it('a thrown wrapper never rejects; CONNECTOR_WRITE_TOOLS_DISABLED=1 refuses every write at dispatch', async () => {
    asanaCreate.mockRejectedValue(new Error('boom'));
    const out = JSON.parse(await executeIntegrationTool('u', 'asana_create_task', { name: 'x' }));
    expect(out).toMatchObject({ ok: false, reason: 'error' });
    expect(out.message).toContain('boom');
    process.env.CONNECTOR_WRITE_TOOLS_DISABLED = '1';
    expect(JSON.parse(await executeIntegrationTool('u', 'asana_create_task', { name: 'x' }, human))).toMatchObject({ ok: false, reason: 'disabled' });
    expect(JSON.parse(await executeIntegrationTool('u', 'x_post', { text: 'x' }, human))).toMatchObject({ ok: false, reason: 'disabled' });
  });
});
