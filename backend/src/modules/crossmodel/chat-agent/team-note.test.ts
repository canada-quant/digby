/**
 * roster 2026-10-06 D-3 — the per-answer "team" note (metadata.depth.team): which models worked on this answer.
 */
import { shortModelName, teamNoteFor, teamNoteDisabled } from './team-note';

describe('shortModelName', () => {
  it('drops the endpoint label, the gateway route and a hosting vendor in front of a model line', () => {
    expect(shortModelName('cql-litellm:api-optimize-alibaba-qwen3.8-flash')).toBe('qwen3.8-flash');
    expect(shortModelName('cql-litellm:api-optimize-zai-glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(shortModelName('cql-litellm:api-optimize-moonshot-kimi-k3')).toBe('kimi-k3');
    expect(shortModelName('cql-litellm:api-optimize-alibaba-deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(shortModelName('cql-litellm:api-anthropic-claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(shortModelName('cql-litellm:spark-glm-5.3-flash')).toBe('glm-5.3-flash');
  });

  it('keeps a model line that merely starts like a vendor, and built-in ids', () => {
    expect(shortModelName('cql-litellm:api-deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(shortModelName('glm-5.3')).toBe('glm-5.3');
    expect(shortModelName('deepseek-flash')).toBe('deepseek-flash');
    expect(shortModelName('cql-litellm:mimo-v26-flash-rl')).toBe('mimo-v26-flash-rl');
  });

  it('the 2026-10-24 gateway swap: MiniMax M3.1 Flash ids keep their line (both the vendor-stemmed and bare alias forms)', () => {
    expect(shortModelName('llm-cql:minimax-m3.1-flash')).toBe('minimax-m3.1-flash');
    expect(shortModelName('llm-cql:m3.1-flash')).toBe('m3.1-flash');
    expect(shortModelName('spark-minimax-m3.1-flash')).toBe('minimax-m3.1-flash');
  });
});

describe('teamNoteFor', () => {
  it('the plan doc\'s example shape: "Quick · qwen3.8-flash + web"', () => {
    const t = teamNoteFor({ lane: 'quick', lead: 'cql-litellm:api-optimize-alibaba-qwen3.8-flash', web: true });
    expect(t).toEqual({ line: 'Quick · qwen3.8-flash + web', lane: 'quick', web: true, members: [{ role: 'lead', model: 'cql-litellm:api-optimize-alibaba-qwen3.8-flash' }] });
  });

  it('names the plan\'s checker, council colleagues and a called-in model', () => {
    expect(teamNoteFor({ lane: 'checked', lead: 'glm-5.3', checker: { model: 'cql-litellm:api-deepseek-v4.1-flash', via: 'plan' }, web: false })?.line)
      .toBe('Checked · glm-5.3 + deepseek-v4.1-flash');
    const called = teamNoteFor({ lane: 'standard', lead: 'glm-5.3', checker: { model: 'deepseek-flash', via: 'call_in' }, web: true });
    expect(called?.line).toBe('Standard · glm-5.3 + deepseek-flash (called in) + web');
    expect(called?.members[1]).toEqual({ role: 'checker', model: 'deepseek-flash', via: 'call_in' });
    const council = teamNoteFor({ lane: 'research', lead: 'kimi-k3', colleagues: [{ model: 'deepseek-flash', via: 'council' }, { model: 'glm-5.3', via: 'council' }, { model: 'glm-5.3', via: 'council' }], web: true });
    expect(council?.line).toBe('Research · kimi-k3 + deepseek-flash + glm-5.3 + web');
    expect(council?.members).toHaveLength(3);
  });

  it('no lead ⇒ no note; the kill switch reads TEAM_NOTE_DISABLED', () => {
    expect(teamNoteFor({ lane: 'standard', lead: null, web: false })).toBeNull();
    expect(teamNoteDisabled({ TEAM_NOTE_DISABLED: '1' })).toBe(true);
    expect(teamNoteDisabled({})).toBe(false);
  });
});
