/**
 * FO firing 35 (2026-09-27) — REPLAY test: the api-openai-gpt-6-astra tools-400 storm.
 *
 * Defect: that OpenAI-compat custom endpoint caps the `tools` array at 128
 * ("Invalid 'tools': array too long. Expected an array with maximum length 128,
 * but got an array with length 195"), and the coding fleet's agent surface sends
 * ~195 tools, so EVERY turn on it 400s deterministically — 122 error rows in
 * 16:00Z–18:00Z alone (lane hard-down, no fallback).
 *
 * Fix (as shipped): runModelTurn truncated the tools array for custom endpoints
 * to the first CUSTOM_ENDPOINT_TOOLS_MAX (default 128). SUPERSEDED 2026-09-27
 * late ("who said 128 is the limit??"): the blanket DEFAULT is gone — the cap
 * comes from the registry (model > endpoint > DOCUMENTED provider class, the
 * incident model's OpenAI class = 128), a cap learned from a live 400, or the
 * now OPT-IN env; a custom endpoint with none is unlimited. Built-ins are never
 * capped. This suite pins capToolsForProvider, the pure gate.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { capToolsForProvider } from './coding-model';
import type { ProviderConfig } from './coding-model';

// The incident seat as the registry resolves it today: the OpenAI class's DOCUMENTED 128.
const CUSTOM: ProviderConfig = { url: 'https://api.example/v1', apiKey: 'k', model: 'gpt-6-astra', label: 'Astra (custom endpoint)', extra: {}, maxTools: 128, maxToolsSource: 'class', providerClass: 'openai' };
// A custom endpoint with NO known cap (a Kimi behind a proxy).
const UNCAPPED: ProviderConfig = { url: 'https://api.example/v1', apiKey: 'k', model: 'api-optimize-moonshot-kimi-k3', label: 'api-optimize (custom endpoint)', extra: {} };
const BUILTIN: ProviderConfig = { url: 'https://api.z.ai/v1', apiKey: 'k', model: 'glm-5.3', label: 'GLM', extra: {} };

const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: 'x', parameters: {} } }));

afterEach(() => { delete process.env.CUSTOM_ENDPOINT_TOOLS_MAX; });

describe('FO firing 35: capToolsForProvider — custom-endpoint tools-400 fix', () => {
  it('truncates a 195-tool array to the OpenAI class\'s documented 128 for the incident custom endpoint', () => {
    const t = tools(195);
    const capped = capToolsForProvider(CUSTOM, t);
    expect(capped).toHaveLength(128);
    expect(capped![0]).toBe(t[0]); // first N in harness order, no importance guessing
    expect(capped![127]).toBe(t[127]);
  });

  it('NEVER caps a custom endpoint with no known cap (the blanket 128 default is gone — a proxy Kimi sends its full list)', () => {
    const t = tools(196);
    expect(capToolsForProvider(UNCAPPED, t)).toBe(t);
  });

  it('never caps built-in providers, whatever the size', () => {
    const t = tools(195);
    expect(capToolsForProvider(BUILTIN, t)).toBe(t);
  });

  it('never caps at or under the cap', () => {
    const t = tools(128);
    expect(capToolsForProvider(CUSTOM, t)).toBe(t);
    expect(capToolsForProvider(CUSTOM, tools(5))).toHaveLength(5);
  });

  it('CUSTOM_ENDPOINT_TOOLS_MAX is the OPT-IN blanket for endpoints with NO known cap; a specific cap always wins over it', () => {
    const t = tools(195);
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '200';
    expect(capToolsForProvider(UNCAPPED, t)).toBe(t); // ≥ fleet tool count = capping off
    expect(capToolsForProvider(CUSTOM, t)).toHaveLength(128); // the registry cap still binds
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '50';
    expect(capToolsForProvider(UNCAPPED, t)).toHaveLength(50);
    expect(capToolsForProvider(CUSTOM, t)).toHaveLength(128);
  });

  it('undefined/empty tools pass through untouched', () => {
    expect(capToolsForProvider(CUSTOM, undefined)).toBeUndefined();
    expect(capToolsForProvider(CUSTOM, [])).toEqual([]);
  });

  it('a non-numeric or non-positive override means NO blanket (no crash, no invented cap)', () => {
    const t = tools(195);
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = 'not-a-number';
    expect(capToolsForProvider(UNCAPPED, t)).toBe(t);
    expect(capToolsForProvider(CUSTOM, t)).toHaveLength(128);
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '0';
    expect(capToolsForProvider(UNCAPPED, t)).toBe(t);
  });

  // ── 2026-09-27 seat/provider-limits composition (supersedes the first-N shape) ──
  // The cap COUNT and the built-in exemption above are unchanged; WHICH tools
  // survive is now the stable PRIORITY order (provider-limits.ts): pinned core /
  // doctrine tools first, then platform reads, platform actions, connector
  // reads, connector writes — input order inside a tier (which is why the
  // all-unknown `tool_N` fixtures above still keep their first N in order).
  const named = (names: string[]) => names.map((name) => ({ type: 'function', function: { name, description: 'x', parameters: {} } }));
  const MIXED = named([
    ...Array.from({ length: 126 }, (_, i) => `gmail_send_thing_${i}`), // connector writes — dropped FIRST
    'update_supervisor_state',                                          // pinned core (doctrine) — at position 126
    'gmail_search',                                                     // connector read
    'read_file',                                                        // pinned core — at position 128
    'list_session_files',                                               // platform read
    'create_canvas',                                                    // platform action
  ]);

  it('PRIORITY: a late pinned core tool survives over an early connector write (first-N would have dropped it)', () => {
    const capped = capToolsForProvider(CUSTOM, MIXED)!;
    expect(capped).toHaveLength(128);
    const names = capped.map((t: any) => t.function.name);
    expect(names).toContain('update_supervisor_state');
    expect(names).toContain('read_file');
    expect(names).toContain('list_session_files');
    expect(names).toContain('create_canvas');
    expect(names).toContain('gmail_search');
    // 131 tools → 3 dropped, all connector writes (the lowest tier), from the tail of that tier
    expect(names.filter((n: string) => n.startsWith('gmail_send_thing_'))).toHaveLength(123);
    expect(names).not.toContain('gmail_send_thing_125');
    // survivors keep their ORIGINAL relative order
    expect(names.indexOf('update_supervisor_state')).toBeLessThan(names.indexOf('read_file'));
  });

  it('a specific registry cap on the provider beats the blanket env', () => {
    const t = tools(195);
    expect(capToolsForProvider({ ...CUSTOM, maxTools: 64 }, t)).toHaveLength(64);
    process.env.CUSTOM_ENDPOINT_TOOLS_MAX = '200'; // a wide blanket …
    expect(capToolsForProvider(UNCAPPED, t)).toBe(t);
    expect(capToolsForProvider({ ...CUSTOM, maxTools: 64 }, t)).toHaveLength(64); // … but the specific cap still applies
  });

  it('the cap itself never switches off — first-N is an explicit opt-in, not env', () => {
    // TOOL_LIMIT_TRIM_DISABLED was DELETED 2026-11-02 (RSW-1): its first-N
    // default baked out and the priority order is now unconditional. The cap
    // is independent of ordering, which is the claim this case keeps.
    const capped = capToolsForProvider(CUSTOM, MIXED)!;
    expect(capped).toHaveLength(128);
    const names = capped.map((t: any) => t.function.name);
    expect(names).toContain('read_file'); // priority order keeps the pinned core
  });
});
