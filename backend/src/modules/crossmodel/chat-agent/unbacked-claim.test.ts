/**
 * 2026-09-29 — the unbacked dispatch claim check (unbacked-claim.ts). The
 * chat-lane wiring is pinned in chat-agent.service.test.ts ("unbacked claim").
 */
const mockPrisma: any = { runToolReceipt: { findFirst: jest.fn() } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { unbackedDispatchClaimIds, inventedReceiptIds, unbackedClaimNotice, unbackedFreshnessClaim, unbackedFreshnessNotice, unbackedFreshnessRetryDisabled } from './unbacked-claim';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED;
});

describe('unbackedDispatchClaimIds', () => {
  it.each([
    ['Dispatched this turn — receipt: 9e1c13ea.', ['9e1c13ea']],
    ['Re-dispatched (RETRY 2): forwarded verbatim to session b2404d2f — receipt 0b87c657 (from this turn\'s send_chat_message result).', ['0b87c657']],
    ['Dispatched: the TASK INSTRUCTION was forwarded via send_chat_message (send receipt e5ecdd3e).', ['e5ecdd3e']],
    ['Sent — receipts d0490bf8, 403b3ad5.', ['d0490bf8', '403b3ad5']],
    ['Delivered; receipt 403B3AD5-1111-2222-3333-444444444444', ['403b3ad5']],
  ])('%s → %j', (text, ids) => {
    expect(unbackedDispatchClaimIds(text, [{ type: 'text' }])).toEqual(ids);
  });
  it('a run that called ANY tool is never judged (a real receipt may exist)', () => {
    expect(unbackedDispatchClaimIds('Dispatched — receipt 9e1c13ea', [{ type: 'tool_call' }])).toBeNull();
  });
  it('no dispatch verb, or no receipt citation → null', () => {
    expect(unbackedDispatchClaimIds('The receipt 9e1c13ea looks odd to me.', [])).toBeNull();
    expect(unbackedDispatchClaimIds('Dispatched the task to session b2404d2f.', [])).toBeNull();
    expect(unbackedDispatchClaimIds('', [])).toBeNull();
  });
});

describe('inventedReceiptIds', () => {
  it('keeps only ids that match no receipt of the chat', async () => {
    mockPrisma.runToolReceipt.findFirst.mockImplementation(async (a: any) => (a.where.id.startsWith === 'd0490bf8' ? { id: 'd0490bf8-x' } : null));
    expect(await inventedReceiptIds('chat-1', ['d0490bf8', '9e1c13ea'])).toEqual(['9e1c13ea']);
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: 'chat-1', id: { startsWith: '9e1c13ea' } } }));
  });
  it('fails closed on a read error: nothing is treated as invented', async () => {
    mockPrisma.runToolReceipt.findFirst.mockRejectedValue(new Error('db down'));
    expect(await inventedReceiptIds('chat-1', ['9e1c13ea'])).toEqual([]);
  });
});

describe('unbackedClaimNotice', () => {
  it('names the ids, asks for the real tool call, and forbids a duplicate send', () => {
    const n = unbackedClaimNotice(['9e1c13ea']);
    expect(n).toContain('receipt 9e1c13ea');
    expect(n).toContain('call the tool NOW (send_chat_message');
    expect(n).toContain('do not send again');
  });
});

// Audit 2026-10-06 T6-3 (others.md F2, fleet.md F4): owner turns on supervisor chats that claim fresh reads with
// ZERO tool calls (de5f8f58, 3c447c15, 2441cb60, 5c6cfe23 — `depth.facts.leadToolCalls: 0`).
describe('unbackedFreshnessClaim', () => {
  it.each([
    ['FULL STATE CHECK — fresh reads at 06:55Z: 4 lanes running, 2 idle.'],
    ['Lane totals verified against the live ledger just now: $41.20 today.'],
    ['Everything below is verified fresh this run.'],
    ['Fresh probe across the repo and S3 (00:16Z): 22,050,049,724 B exact recount just now.'],
    ['I re-read the ledger and the counts hold.'],
    ['The board was checked live — 3 goals active.'],
  ])('claims fresh verification: %s', (text) => {
    expect(unbackedFreshnessClaim(text, [{ type: 'text' }])).toEqual(expect.any(String));
  });
  it('quotes the claimed fragment (bounded)', () => {
    const hit = unbackedFreshnessClaim('Status. Fresh probe across the repo and S3 shows 22 GB.', []);
    expect(hit).toContain('Fresh probe');
    expect(hit!.length).toBeLessThanOrEqual(160);
  });
  it('a run that called ANY tool is never judged', () => {
    expect(unbackedFreshnessClaim('Fresh reads at 06:55Z: all idle.', [{ type: 'tool_call' }])).toBeNull();
  });
  it.each([
    ['No fresh reads this turn — figures are from the 05:40Z wake.'],
    ['These are from context (not read this wake).'],
    ["I'll do a fresh read next wake."],
    ['Want me to do a fresh probe of S3?'],
    ['The lane finished its build an hour ago; 3 goals are active.'],
    ['I read your message just now and will dispatch the lane.'],
    [''],
  ])('honest disclaimers, plans and plain answers are not claims: %s', (text) => {
    expect(unbackedFreshnessClaim(text, [])).toBeNull();
  });
  it('the notice quotes the phrase and asks for the reads or an honest "from earlier context"', () => {
    const n = unbackedFreshnessNotice('fresh reads at 06:55Z');
    expect(n).toContain('HARNESS CHECK — NO TOOL CALL');
    expect(n).toContain('fresh reads at 06:55Z');
    expect(n).toContain('make the reads NOW');
    expect(n).toContain('earlier context');
  });
  it('SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED=1 turns it off', () => {
    expect(unbackedFreshnessRetryDisabled()).toBe(false);
    process.env.SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED = '1';
    expect(unbackedFreshnessRetryDisabled()).toBe(true);
  });
});
