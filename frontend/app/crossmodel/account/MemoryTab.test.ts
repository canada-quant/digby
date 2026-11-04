/**
 * Renderer tests for the account-settings MemoryTab fact filter
 * (feedback ticket 8929d1ef).
 *
 * The connected MemoryTab wrapper fetches via apiClient (not testable under
 * the repo's node-environment vitest idiom — no jsdom, no effects), so this
 * targets the exported PURE filter (visibleFactEntries) — the same
 * pattern as ChatFilesSection.test.tsx / markdown-content.test.tsx.
 *
 * The bug: the memory system writes internal bookkeeping into the SAME
 * UserMemory.facts blob the tab renders (`__rejections`, `__dream`,
 * `persona_label`, `__contextState`, `persona`…). The tab showed them as
 * editable/deletable "facts", inflated the "N facts Digby remembers" count,
 * and let a user wipe persistent state (e.g. banned-topic rejections).
 */

import { describe, it, expect } from 'vitest';
import { visibleFactEntries } from './MemoryTab';

describe('visibleFactEntries (ticket 8929d1ef)', () => {
  it('keeps real user facts', () => {
    const out = visibleFactEntries({ name: 'Ada', location: 'Toronto' });
    expect(out).toEqual([['name', 'Ada'], ['location', 'Toronto']]);
  });

  it('filters __-prefixed bookkeeping keys (rejections, dream, contextState)', () => {
    const facts: Record<string, unknown> = {
      name: 'Ada',
      __rejections: '{"topics":["x"]}',
      __dream: '{"lastCycle":"2026-09-01"}',
      __contextState: '{"summary":"…"}',
      __anything_else: 'hidden',
    };
    const out = visibleFactEntries(facts);
    expect(out).toEqual([['name', 'Ada']]);
  });

  it('filters persona keys (interview-assigned, not editable facts)', () => {
    const out = visibleFactEntries({
      name: 'Ada',
      persona: 'tech professional',
      persona_label: 'tech_professional',
    });
    expect(out).toEqual([['name', 'Ada']]);
  });

  it('round-trips the real blob shape the tab loads (mixed live keys)', () => {
    // Shape sampled from the explorer's schema map: user_memory.facts Json.
    const blob: Record<string, unknown> = {
      name: 'Ada',
      occupation: 'engineer',
      location: 'Toronto',
      tech_level: 'advanced',
      interests: 'climbing, chess',
      response_style: 'concise',
      persona: 'tech professional',
      persona_label: 'tech_professional',
      __rejections: '[]',
      __dream: '{}',
      __contextState: '{}',
    };
    const out = visibleFactEntries(blob);
    expect(out.map(([k]) => k).sort()).toEqual(
      ['interests', 'location', 'name', 'occupation', 'response_style', 'tech_level'],
    );
  });

  it('empty blob → empty list (never a crash)', () => {
    expect(visibleFactEntries({})).toEqual([]);
  });
});
