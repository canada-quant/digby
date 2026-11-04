/**
 * Owner 2026-09-26: "for chat session default all chats to auto even supervisors
 * and fleet supervisors". The web client's new-chat path creates the chat with
 * NO mode — the server's default ('auto') is the stored value — and the depth
 * of each send still rides the send itself (depthPrefToWire: the Account →
 * Advanced "Default depth" preset or Auto), never the chat row. Source pins
 * (same idiom as c3-legacy-retirement.test.tsx) + the API client's type.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { buildPlainDepthConfig } from './plain-session';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = readSrc('./page.tsx');
const API = readSrc('../../lib/api/crossmodel.ts');

describe('new chat → mode default (2026-09-26)', () => {
  it('the home-composer hand-off creates the chat WITHOUT a mode (server default = auto)', () => {
    // Ghost composer toggle (2026-10-22): the create goes through createChatWithGhost, which adds ONLY an
    // armed ghostMode:true (lib/ghost-composer.test.ts pins the unarmed body as byte-identical) — never a mode.
    expect(PAGE).toContain("createChatWithGhost(crossModelApi.createChat, { title, projectId: currentProjectIdRef.current || undefined }, newChatGhostRef.current)");
    expect(PAGE).not.toMatch(/crossModelApi\.createChat\(\{[^}]*\bmode:/);
    expect(PAGE).not.toMatch(/createChatWithGhost\(crossModelApi\.createChat, \{[^}]*\bmode:/);
    expect(PAGE).not.toContain('const pipelineMode = normalizePatienceMode(mode);');
  });

  it('the per-send depth rides the send (buildPlainDepthConfig), never the chat row — signed-in sends are Auto whatever the stored pref (roster 2026-10-06 B-3)', () => {
    expect(PAGE).toContain('...buildPlainDepthConfig({');
    expect(PAGE).toContain('pref: normalizePatienceMode(mode),');
    const base = { guest: false, isKid: false, deepResearchQuota: null };
    expect(buildPlainDepthConfig({ ...base, pref: 'auto' }).mode).toBe('auto');
    expect(buildPlainDepthConfig({ ...base, pref: 'thinking' })).toEqual({ mode: 'auto', deepResearchQuota: null, digDeeperEnabled: true });
  });

  it("the API client's createChat takes an optional mode that includes 'auto', and a chat row may carry 'auto'", () => {
    // Ghost mode (2026-10-22) extends the same body with ghostMode?: boolean.
    expect(API).toMatch(/createChat: async \(data: \{ title: string; mode\?: '[^']*'(?: \| '[^']*')* \| 'auto'; projectId\?: string; ghostMode\?: boolean \}\)/);
    expect(API).toContain("mode: 'auto' | 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent' | 'code';");
  });
});
