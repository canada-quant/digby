/** audit 2026-10-08 W4-2 — memory/answer-grounding.ts (pure). */
import {
  answerGroundingFromParts, isUngroundedAnswer, hasConfirmationClaim, neutralizeConfirmations, ungroundedSpecifics, dropUngroundedItem,
} from './answer-grounding';

describe('answerGroundingFromParts', () => {
  it('a zero-tool turn is ungrounded', () => {
    expect(answerGroundingFromParts([{ type: 'text', text: 'It is an SN2010' }])).toEqual({ toolBacked: false, evidenceCalls: 0, tools: [] });
    expect(answerGroundingFromParts(null)).toEqual({ toolBacked: false, evidenceCalls: 0, tools: [] });
  });
  it('memory reads, plan / meta tools and other models\' opinions never ground a memory write', () => {
    const parts = ['search_memory', 'list_memory', 'update_plan', 'remember_fact', 'call_in', 'load_tools'].flatMap((name) => [
      { type: 'tool_call', name }, { type: 'tool_result', name, result: 'ok' },
    ]);
    expect(answerGroundingFromParts(parts).toolBacked).toBe(false);
  });
  it('an evidence tool that RETURNED grounds it; an errored one does not', () => {
    const ok = answerGroundingFromParts([{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine', result: '10 results' }, { type: 'tool_result', name: 'get_account_overview', result: '{"ok":true}' }]);
    expect(ok).toEqual({ toolBacked: true, evidenceCalls: 2, tools: ['search_engine', 'get_account_overview'] });
    expect(answerGroundingFromParts([{ type: 'tool_result', name: 'scrape_as_markdown', result: 'Error: 504 upstream' }, { type: 'tool_result', name: 'get_feedback', result: '{"ok": false, "reason": "x"}' }]).toolBacked).toBe(false);
  });
  it('a transcript with only tool_call parts counts the calls (no result parts recorded)', () => {
    expect(answerGroundingFromParts([{ type: 'tool_call', name: 'web_pipe' }]).toolBacked).toBe(true);
  });
  it('MEMORY_ANSWER_GROUNDING_DISABLED=1 ⇒ never ungrounded; unknown grounding ⇒ never ungrounded', () => {
    const g = answerGroundingFromParts([]);
    expect(isUngroundedAnswer(g, {} as any)).toBe(true);
    expect(isUngroundedAnswer(g, { MEMORY_ANSWER_GROUNDING_DISABLED: '1' } as any)).toBe(false);
    expect(isUngroundedAnswer(null, {} as any)).toBe(false);
  });
});

describe('the backstops', () => {
  it('confirmation claims — the assistant\'s, never the user\'s', () => {
    expect(hasConfirmationClaim('Cloudflare API access confirmed missing')).toBe(true);
    expect(hasConfirmationClaim('The hardware is confirmed as an NVIDIA Mellanox SN2010')).toBe(true);
    expect(hasConfirmationClaim('verified working on the staging box')).toBe(true);
    expect(hasConfirmationClaim('The user confirmed the deploy target is Cloudflare Pages')).toBe(false);
    expect(hasConfirmationClaim('Owner verified the budget')).toBe(false);
    expect(hasConfirmationClaim('Deploy the site on Cloudflare Pages')).toBe(false);
  });
  it('neutralizeConfirmations rewrites the claim words, keeping the case of the first letter', () => {
    expect(neutralizeConfirmations('The hardware is confirmed as an SN2010. Verified by spec.')).toBe('The hardware is stated as an SN2010. Stated by spec.');
    expect(neutralizeConfirmations('this confirms it')).toBe('this states it');
  });
  it('ungroundedSpecifics — specific tokens only the ungrounded answer carries', () => {
    const answer = "It's an NVIDIA Mellanox SN2010 with 18x 25GbE ports";
    expect(ungroundedSpecifics('switch: NVIDIA Mellanox SN2010', answer, ['i know its a mellanox'])).toEqual(['NVIDIA', 'SN2010']);
    expect(ungroundedSpecifics('switch vendor: Mellanox', answer, ['i know its a mellanox'])).toEqual([]);
    expect(ungroundedSpecifics('budget: $4000', answer, ['the budget is $4000'])).toEqual([]); // the user said it
  });
  it('dropUngroundedItem combines both', () => {
    expect(dropUngroundedItem('Cloudflare API access confirmed missing', 'Confirmed — no token', ['deploy to cloudflare'])).toMatchObject({ drop: true, why: 'confirmation claim with no source' });
    expect(dropUngroundedItem('network_switch: SN2010', 'It is an SN2010', ['which mellanox?'])).toMatchObject({ drop: true });
    expect(dropUngroundedItem('Deploy the site on Cloudflare Pages', 'I will deploy it to Cloudflare Pages', ['deploy the site to cloudflare pages'])).toEqual({ drop: false });
  });
});
