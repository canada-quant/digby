/**
 * executeIntegrationTool — Google WRITE dispatch (2026-09-23): the JSON envelope
 * with harvested ids, the human-turn anchor on gmail_send_email, the kill switch,
 * and the label pass-through.
 */
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), del: jest.fn() }, redisSubscriber: { subscribe: jest.fn(), on: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../github/github-mcp', () => ({ __esModule: true }));
const mockRunWrite = jest.fn();
jest.mock('../google/google-mcp', () => ({ __esModule: true, runGoogleWriteTool: (...a: any[]) => mockRunWrite(...a), resolveGoogleAccount: jest.fn() }));
jest.mock('../slack/slack-mcp', () => ({ __esModule: true }));
jest.mock('../asana/asana-mcp', () => ({ __esModule: true }));
jest.mock('../x/x-mcp', () => ({ __esModule: true }));
jest.mock('../xero/xero-mcp', () => ({ __esModule: true }));
jest.mock('../plaid/plaid-mcp', () => ({ __esModule: true }));
jest.mock('../imessage/imessage.service', () => ({ __esModule: true, getPrimaryAgent: jest.fn(), isOnline: jest.fn() }));
jest.mock('../imessage/agent-link', () => ({ __esModule: true, agentBroker: { dispatch: jest.fn() } }));

import { executeIntegrationTool } from './coding-integrations';

beforeEach(() => { jest.clearAllMocks(); delete process.env.GOOGLE_WRITE_TOOLS_DISABLED; });

describe('Google write dispatch', () => {
  it('wraps the MCP text in an envelope with harvested ids + link and passes the label through', async () => {
    mockRunWrite.mockResolvedValue({ ok: true, account: 'Work (w@x.com)', text: 'Created Google Sheet "Q3" — spreadsheetId 1AbC-xyz_9 (3 row(s) written to Sheet1) — https://docs.google.com/spreadsheets/d/1AbC-xyz_9/edit' });
    const out = JSON.parse(await executeIntegrationTool('u', 'sheets_create_spreadsheet', { title: 'Q3', rows: [['a']], label: 'Work' }, { userTurnAt: new Date() }));
    expect(out).toMatchObject({ ok: true, tool: 'sheets_create_spreadsheet', account: 'Work (w@x.com)' });
    expect(out.ids).toEqual({ spreadsheetId: '1AbC-xyz_9', link: 'https://docs.google.com/spreadsheets/d/1AbC-xyz_9/edit' });
    expect(mockRunWrite).toHaveBeenCalledWith('u', 'sheets_create_spreadsheet', { title: 'Q3', rows: [['a']] }, 'Work');
  });
  it('gmail_send_email on a MACHINE run is refused before any call; a draft is allowed', async () => {
    const refused = JSON.parse(await executeIntegrationTool('u', 'gmail_send_email', { to: 'a@b.c', subject: 's', body: 'b' }));
    expect(refused).toMatchObject({ ok: false, reason: 'machine_run' });
    expect(refused.message).toContain('gmail_create_draft');
    expect(mockRunWrite).not.toHaveBeenCalled();
    mockRunWrite.mockResolvedValue({ ok: true, text: 'Draft created — draftId r-99abcd12' });
    const draft = JSON.parse(await executeIntegrationTool('u', 'gmail_create_draft', { to: 'a@b.c', subject: 's', body: 'b' }));
    expect(draft).toMatchObject({ ok: true, ids: { draftId: 'r-99abcd12' } });
  });
  it('gmail_send_email on a human-attended turn goes through', async () => {
    mockRunWrite.mockResolvedValue({ ok: true, text: 'Email sent — messageId 18f0abc' });
    const out = JSON.parse(await executeIntegrationTool('u', 'gmail_send_email', { to: 'a@b.c', subject: 's', body: 'b' }, { userTurnAt: new Date() }));
    expect(out).toMatchObject({ ok: true, ids: { messageId: '18f0abc' } });
  });
  it('a refusal from the resolver is an ok:false envelope; a thrown error never rejects', async () => {
    mockRunWrite.mockResolvedValue({ ok: false, text: 'The Google account "Personal" was connected without the documents permission…' });
    expect(JSON.parse(await executeIntegrationTool('u', 'docs_create_document', { title: 'x' }))).toMatchObject({ ok: false });
    mockRunWrite.mockRejectedValue(new Error('boom'));
    const out = JSON.parse(await executeIntegrationTool('u', 'docs_create_document', { title: 'x' }));
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toContain('boom');
  });
  it('GOOGLE_WRITE_TOOLS_DISABLED=1 refuses every write at dispatch', async () => {
    process.env.GOOGLE_WRITE_TOOLS_DISABLED = '1';
    const out = JSON.parse(await executeIntegrationTool('u', 'docs_create_document', { title: 'x' }, { userTurnAt: new Date() }));
    expect(out).toMatchObject({ ok: false, reason: 'disabled' });
    expect(mockRunWrite).not.toHaveBeenCalled();
  });
});
