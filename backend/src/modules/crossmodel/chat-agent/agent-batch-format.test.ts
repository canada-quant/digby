import { riderBody, wakeRiderHeader, formatWakeRider, fallbackProvenanceLine, WAKE_RIDER_OPENER, RIDER_SEPARATOR } from './agent-batch-format';

describe('agent-batch-format (wake rider, hardening loop iteration 7)', () => {
  it('keeps an existing [AGENT-SENT MESSAGE header and synthesizes one for header-less rows', () => {
    expect(riderBody('[AGENT-SENT MESSAGE — from chat "x" (abcdefgh)] delta', 'zzzzzzzz-0000', null)).toBe('[AGENT-SENT MESSAGE — from chat "x" (abcdefgh)] delta');
    expect(riderBody('  bare delta  ', '615723ba-0000-0000-0000-000000000000', null)).toBe('[queued agent message from chat 615723ba — another Digby agent, NOT the owner]\nbare delta');
    expect(riderBody('bare', undefined, null)).toBe('bare');
    expect(fallbackProvenanceLine(undefined)).toBe('');
  });

  it('prepends the supersession note when present', () => {
    expect(riderBody('[AGENT-SENT MESSAGE x', 'a', '⚠ SUPERSEDED? note')).toBe('⚠ SUPERSEDED? note\n[AGENT-SENT MESSAGE x');
  });

  it('header names the count and the remainder; the block joins bodies with the separator', () => {
    const h = wakeRiderHeader(2, 0);
    expect(h.startsWith('[QUEUED WHILE BUSY — 2 ')).toBe(true);
    expect(h).toContain(WAKE_RIDER_OPENER);
    expect(h).not.toContain('more remain');
    expect(wakeRiderHeader(1, 4)).toContain('4 more remain queued and drain after this turn.');
    const block = formatWakeRider(['alpha-one', 'beta-two'], 0);
    expect(block.indexOf('alpha-one')).toBeLessThan(block.indexOf('beta-two'));
    expect(block).toContain(RIDER_SEPARATOR);
    expect(block.startsWith(wakeRiderHeader(2, 0))).toBe(true);
  });
});
