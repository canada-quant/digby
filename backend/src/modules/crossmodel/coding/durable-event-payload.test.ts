/**
 * durable-event-payload — what the agent_events log and the plain-chat Redis
 * mirror keep of an event (2026-09-24 review): a url-backed generated image
 * loses its base64 (the bytes live in generated_files); everything else is
 * the live payload, untouched and identity-preserved.
 */
import { durableEventData, isUrlBackedGeneratedImage } from './durable-event-payload';

const URL = '/api/crossmodel/generated-files/f1/inline';

describe('durableEventData', () => {
  it('strips `data` from a generated image event that carries a lazy url; keeps url/fileId/prompt/name/mediaType', () => {
    const live = { mediaType: 'image/png', data: 'A'.repeat(1_000), name: 'Generated · "fox"', source: 'generated', url: URL, fileId: 'f1', prompt: 'a fox' };
    expect(isUrlBackedGeneratedImage('image', live)).toBe(true);
    const durable = durableEventData('image', live);
    expect(durable).toEqual({ mediaType: 'image/png', name: 'Generated · "fox"', source: 'generated', url: URL, fileId: 'f1', prompt: 'a fox' });
    expect(durable).not.toHaveProperty('data');
    expect(live.data).toHaveLength(1_000); // the live payload (fan-out) is untouched
  });

  it('keeps screenshots (no url at emit time) and every other event byte-identical — same object', () => {
    const shot = { mediaType: 'image/png', data: 'BBBB', name: 'Final page', source: 'browser', pageUrl: 'https://x' };
    expect(isUrlBackedGeneratedImage('image', shot)).toBe(false);
    expect(durableEventData('image', shot)).toBe(shot);
    const text = { delta: 'hello' };
    expect(durableEventData('text', text)).toBe(text);
    // A generated image WITHOUT a url (nothing to render from) keeps its bytes.
    const noUrl = { mediaType: 'image/png', data: 'CCCC', source: 'generated' };
    expect(durableEventData('image', noUrl)).toBe(noUrl);
    // Not an image event at all — even with the generated shape.
    expect(durableEventData('tool_result', { source: 'generated', url: URL, data: 'x' })).toEqual({ source: 'generated', url: URL, data: 'x' });
  });

  it('tolerates non-object payloads', () => {
    expect(durableEventData('image', null)).toBeNull();
    expect(durableEventData('image', undefined)).toBeUndefined();
    expect(durableEventData('image', 'str' as any)).toBe('str');
    expect(durableEventData('context', null)).toBeNull();
    expect(durableEventData('context', 'str' as any)).toBe('str');
  });
});

describe('durableEventData — context slim (audit 2026-10-06 T9-3)', () => {
  const seenRuns = Array.from({ length: 50 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const agents = [{ agent: 'Digby', model: 'glm-5.3', inTokens: 10, outTokens: 2, costUsd: 0.01, turns: 1, estimated: false }];
  const live = () => ({
    chars: 1234, budget: 100_000, compactions: 1,
    usage: { runId: 'r1', totalInTokens: 10, totalOutTokens: 2, totalCostUsd: 0.01, turns: 1, estimated: false, agents },
    sessionUsage: { inTokens: 100, outTokens: 20, costUsd: 0.1, turns: 9, runs: 51, estimated: false, agents, seenRuns },
  });
  afterEach(() => { delete process.env.AGENT_EVENTS_CONTEXT_SLIM_DISABLED; });

  it('drops ONLY sessionUsage.seenRuns from the durable copy; every field the meter reads is kept; the live payload is untouched', () => {
    const payload = live();
    const durable = durableEventData('context', payload) as any;
    expect(durable.sessionUsage).not.toHaveProperty('seenRuns');
    expect(durable).toEqual({ ...payload, sessionUsage: { inTokens: 100, outTokens: 20, costUsd: 0.1, turns: 9, runs: 51, estimated: false, agents } });
    expect(durable.usage).toBe(payload.usage);
    expect(payload.sessionUsage.seenRuns).toHaveLength(50); // the live fan-out still carries it
    expect(JSON.stringify(durable).length).toBeLessThan(JSON.stringify(payload).length - 1_800);
  });

  it('a context event without the ledger (compaction-only shape / no sessionUsage) is the same object; other types untouched', () => {
    const bare = { chars: 5, budget: 10, compactions: 2 };
    expect(durableEventData('context', bare)).toBe(bare);
    const noLedger = { chars: 5, budget: 10, compactions: 2, sessionUsage: { inTokens: 1 } };
    expect(durableEventData('context', noLedger)).toBe(noLedger);
    const other = { sessionUsage: { seenRuns: ['x'] } };
    expect(durableEventData('progress', other)).toBe(other);
  });

  it('kill switch AGENT_EVENTS_CONTEXT_SLIM_DISABLED=1 persists the live payload byte-for-byte (read per call)', () => {
    process.env.AGENT_EVENTS_CONTEXT_SLIM_DISABLED = '1';
    const payload = live();
    expect(durableEventData('context', payload)).toBe(payload);
    delete process.env.AGENT_EVENTS_CONTEXT_SLIM_DISABLED;
    expect(durableEventData('context', payload)).not.toBe(payload);
  });
});
