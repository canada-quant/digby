/**
 * Model endpoints dialog — the 2026-09-27 seat/provider-limits wave:
 *   5. the edit-endpoint dialog LAYOUT contract (owner screenshot: intro, label
 *      hint, flag chips and legend clipped past the right edge; a fixed-height
 *      model list inside a dialog that could not scroll) at 1280 px and 400 px;
 *   6. the Detect-capabilities UI (api functions, button, per-model action,
 *      results table, manual-flag protection, entry merge);
 *   7. the retired `coding` flag → chat-capable pickers + the seat `latched` badge.
 *
 * react-dom/server idiom (node-environment vitest, no jsdom / testing-library):
 * the pure presentational pieces render to static markup and are asserted on
 * their classes / structure; what only a mounted Radix portal would show
 * (the DialogContent itself) is pinned in the source, the same way
 * ModelRolesSection.test.tsx pins its section.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

vi.mock('@/lib/api-client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import {
  ENDPOINT_DIALOG_CONTENT_CLASS, MODEL_ROW_CLASS, MODEL_CHIPS_CLASS, LEGEND_CLASS,
  ModelFlagChips, ModelLimitControls, DetectReportTable, EndpointDialogLegend,
  withManualFlag, mergeDetectedEntry, isDecisionModelReport,
} from './ModelEndpointsSection';
import {
  isChatCapableModel, modelKindOf, heuristicModelKind, looksNonChatModelId, detectedModelKind,
  type EndpointModel, type DetectedModelReport,
} from '@/lib/api/model-endpoints';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SECTION = readSrc('./ModelEndpointsSection.tsx');
const ROLES = readSrc('./ModelRolesSection.tsx');
const CODING_TAB = readSrc('./CodingTab.tsx');
const SESSION_VIEW = readSrc('../components/CodeSessionView.tsx');
const API = readSrc('../../../lib/api/model-endpoints.ts');
const DIALOG = readSrc('../../../components/ui/dialog.tsx');

// ── Layout contract helpers ──────────────────────────────────────────────────

/** Every `w-[NNNpx]` / `min-w-[NNNpx]` in a class string or markup, in px. */
const fixedPxWidths = (s: string): number[] => [...s.matchAll(/(?:min-)?w-\[(\d+)px\]/g)].map(m => Number(m[1]));

/**
 * The dialog width the class contract yields at a viewport, resolved from the
 * classes themselves: `w-[calc(100%-2rem)]` + `max-w-[calc(100%-2rem)]` cap it
 * at viewport − 32 px; `sm:max-w-2xl` (Tailwind 2xl = 42rem = 672 px) applies
 * from the 640 px breakpoint. Pure arithmetic over the class string.
 */
function dialogWidthAt(cls: string, viewport: number): number {
  expect(cls).toMatch(/\bw-\[calc\(100%-2rem\)\]/);
  expect(cls).toMatch(/\bmax-w-\[calc\(100%-2rem\)\]/);
  const gutterCapped = viewport - 32;
  const sm = /\bsm:max-w-2xl\b/.test(cls) ? 672 : Number.POSITIVE_INFINITY;
  return viewport >= 640 ? Math.min(gutterCapped, sm) : gutterCapped;
}

const chips = [
  { key: 'vision', label: 'vision', on: true, flip: () => {}, title: 'Accepts image input', manual: true },
  { key: 'image', label: 'image', on: false, flip: () => {}, title: 'Image generation' },
  { key: 'matryoshka', label: 'MRL', on: false, flip: () => {}, title: 'MRL' },
  { key: 'no-think', label: 'no-think', on: false, flip: () => {}, title: 'no-think' },
  { key: 'typed-decisions', label: 'typed decisions', on: false, flip: () => {}, title: 'typed decisions' },
  { key: 'calibrated', label: 'calibrated', on: false, flip: () => {}, title: 'calibrated' },
];

const longModel: EndpointModel = {
  id: 'api-openai-gpt-6-astra-with-an-absurdly-long-model-identifier-that-must-break-not-overflow-the-dialog',
  maxTools: 128, reasoningEffort: 'unsupported', providerClass: 'openai', contextWindow: 200_000,
  manualFlags: ['maxTools'],
};

describe('5. edit-endpoint dialog — no horizontal overflow at 1280 px and 400 px', () => {
  it('the DialogContent class caps the width at the viewport (16 px gutters), widens on desktop, and scrolls the WHOLE dialog', () => {
    expect(SECTION).toContain('<DialogContent className={ENDPOINT_DIALOG_CONTENT_CLASS}>');
    expect(dialogWidthAt(ENDPOINT_DIALOG_CONTENT_CLASS, 1280)).toBe(672);   // desktop: the 2xl cap, well inside 1280
    expect(dialogWidthAt(ENDPOINT_DIALOG_CONTENT_CLASS, 400)).toBe(368);    // phone: viewport − gutters
    expect(dialogWidthAt(ENDPOINT_DIALOG_CONTENT_CLASS, 1280)).toBeLessThanOrEqual(1280);
    expect(dialogWidthAt(ENDPOINT_DIALOG_CONTENT_CLASS, 400)).toBeLessThanOrEqual(400);
    expect(ENDPOINT_DIALOG_CONTENT_CLASS).toMatch(/max-h-\[calc\(100dvh/);
    expect(ENDPOINT_DIALOG_CONTENT_CLASS).toContain('overflow-y-auto');
    expect(ENDPOINT_DIALOG_CONTENT_CLASS).toContain('overflow-x-hidden');
    expect(ENDPOINT_DIALOG_CONTENT_CLASS).toContain('min-w-0');
    expect(fixedPxWidths(ENDPOINT_DIALOG_CONTENT_CLASS)).toEqual([]);
    // The base DialogContent keeps its own gutter + dvh cap, so the merge can only tighten.
    expect(DIALOG).toContain('w-[calc(100%-2rem)] max-w-[calc(100%-2rem)]');
    expect(DIALOG).toMatch(/max-h-\[calc\(100dvh/);
  });

  it('the model list no longer scrolls on its own inside the dialog (the old max-h-48 box) — it flows and the dialog scrolls', () => {
    expect(SECTION).not.toContain('max-h-48');
    expect(SECTION).toContain('data-testid="model-list"');
    expect(SECTION).toContain('<div key={m.id} className={MODEL_ROW_CLASS} data-testid="model-row">');
  });

  it('every model row and its chip / control lines WRAP; the id breaks; nothing is nowrap or fixed wider than 400 px', () => {
    expect(MODEL_ROW_CLASS).toContain('flex-wrap');
    expect(MODEL_ROW_CLASS).toContain('min-w-0');
    expect(MODEL_CHIPS_CLASS).toContain('flex-wrap');
    expect(SECTION).toContain('className="flex-1 min-w-0 break-all font-mono text-xs"');
    const chipsHtml = renderToStaticMarkup(createElement(ModelFlagChips, { chips }));
    expect(chipsHtml).toContain('flex-wrap');
    expect(chipsHtml).not.toContain('whitespace-nowrap');
    expect(fixedPxWidths(chipsHtml).filter(px => px >= 400)).toEqual([]);
    for (const label of ['vision', 'image', 'MRL', 'no-think', 'typed decisions', 'calibrated']) expect(chipsHtml).toContain(`>${label}`);
    expect(chipsHtml).not.toContain('>coding<');
    expect(chipsHtml).toContain('vision*'); // a manual flag is marked
    const limitsHtml = renderToStaticMarkup(createElement(ModelLimitControls, { m: longModel, onChange: () => {} }));
    expect(limitsHtml).toContain('flex-wrap');
    expect(limitsHtml).not.toContain('whitespace-nowrap');
    expect(fixedPxWidths(limitsHtml).filter(px => px >= 400)).toEqual([]);
    for (const w of [1280, 400]) expect(Math.max(0, ...fixedPxWidths(limitsHtml))).toBeLessThan(w - 32);
  });

  it('the legend is a compact wrapped block (several lines, break-words), never one run-on line; the intro / hints break words', () => {
    const legend = renderToStaticMarkup(createElement(EndpointDialogLegend));
    expect(LEGEND_CLASS).toContain('break-words');
    expect(LEGEND_CLASS).toContain('leading-snug');
    expect(legend).toContain('break-words');
    expect(legend).not.toContain('whitespace-nowrap');
    expect((legend.match(/<p>/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(fixedPxWidths(legend)).toEqual([]);
    expect(SECTION).toContain('<DialogDescription className="break-words">');
    expect(SECTION).toContain('Lowercase letters, digits, dashes (auto-formatted as you type). Models are addressed as label:model-id.</p>');
    expect(SECTION).toContain('className="text-[11px] text-muted-foreground mt-1 break-words">Lowercase letters');
  });

  it('the whole dialog markup carries no whitespace-nowrap and no fixed width ≥ 400 px', () => {
    const dialog = SECTION.slice(SECTION.indexOf('{/* Add / edit dialog */}'), SECTION.indexOf('{/* Delete confirm */}'));
    expect(dialog).not.toContain('whitespace-nowrap');
    expect(fixedPxWidths(dialog).filter(px => px >= 400)).toEqual([]);
  });

  it('the Server type select round-trips all three shapes (the old handler folded systemone_chat back to openai_chat)', () => {
    expect(SECTION).toContain("providerShape: e.target.value === 'systemone' ? 'systemone' : e.target.value === 'systemone_chat' ? 'systemone_chat' : 'openai_chat'");
    expect(SECTION).not.toContain("providerShape: e.target.value === 'systemone' ? 'systemone' : 'openai_chat' })");
  });
});

describe('6. Detect capabilities', () => {
  it('the api exposes detect (whole endpoint) + detectModel (one model) on the new routes', () => {
    expect(API).toContain("detect: async (id: string, capabilities?: string[]): Promise<DetectEndpointResult> =>");
    expect(API).toContain('`/crossmodel/admin/model-endpoints/${id}/detect`');
    expect(API).toContain("detectModel: async (id: string, modelId: string, capabilities?: string[]): Promise<DetectEndpointResult> =>");
    expect(API).toContain('`/crossmodel/admin/model-endpoints/${id}/detect/${encodeURIComponent(modelId)}`');
    expect(API).toContain('export interface DetectedModelReport {');
    expect(API).toContain('export interface DetectEndpointResult {');
  });

  it('the dialog has the endpoint-wide button (saved endpoints only) + a per-model action, a running note, and merges the returned entries', () => {
    expect(SECTION).toContain('data-testid="detect-capabilities"');
    expect(SECTION).toContain('disabled={!draft.id || detecting !== null || draft.models.length === 0}');
    expect(SECTION).toContain("'Save the endpoint first — detection probes the saved endpoint with its stored key'");
    expect(SECTION).toContain('onClick={() => runDetect(m.id)}');
    expect(SECTION).toContain('data-testid="detecting-note"');
    expect(SECTION).toContain('(≤4 models at a time, ~20 s per probe)');
    expect(SECTION).toContain('modelEndpointsApi.detectModel(endpointId, modelId) : await modelEndpointsApi.detect(endpointId)');
    expect(SECTION).toContain('return r ? mergeDetectedEntry(m, r.entry) : m;');
    expect(SECTION).toContain('<DetectReportTable');
    // the endpoint-level default cap rides the save
    expect(SECTION).toContain('id="me-max-tools"');
    expect(SECTION).toContain('settings: draft.settings,');
    expect(API).toContain('settings?: EndpointSettings | null;');
  });

  it('DetectReportTable renders capability · detected value · evidence · when, highlights the rows whose flag changed, and collapses', () => {
    const report: DetectedModelReport = {
      id: 'api-openai-gpt-6-astra', detectedAt: '2026-09-27T19:30:00.000Z',
      changed: ['maxTools=128', 'reasoningEffort=unsupported'],
      entry: { id: 'api-openai-gpt-6-astra', maxTools: 128, reasoningEffort: 'unsupported' },
      results: [
        { capability: 'max_tools', ok: true, value: 128, evidence: "200 stub tools → 400 \"Invalid 'tools': array too long … maximum length 128\"", latencyMs: 1200, at: '2026-09-27T19:30:01.000Z' },
        { capability: 'reasoning_effort', ok: true, value: 'unsupported', evidence: 'reasoning_effort:low + ping tool → 400 "use /v1/responses or set reasoning_effort to none"', latencyMs: 900, at: '2026-09-27T19:30:02.000Z' },
        { capability: 'vision', ok: true, value: false, evidence: '1×1 PNG image part → 400', latencyMs: 400, at: '2026-09-27T19:30:03.000Z' },
        { capability: 'image_generation', ok: false, value: null, evidence: 'skipped — not an image model id', latencyMs: 0, at: '2026-09-27T19:30:03.000Z', skipped: true },
      ],
    };
    const open = renderToStaticMarkup(createElement(DetectReportTable, { report, open: true, onToggle: () => {} }));
    expect(open).toContain('4 capability result(s)');
    expect(open).toContain('changed: maxTools=128, reasoningEffort=unsupported');
    expect(open).toContain('Max tools per request');
    expect(open).toContain('>128<');
    expect(open).toContain('>unsupported<');
    expect(open).toContain('>no<');
    expect(open).toContain('>skipped<');
    expect((open.match(/data-changed="1"/g) || []).length).toBe(2);
    expect(open).toContain('2026-09-27 19:30Z');
    expect(open).not.toContain('whitespace-nowrap');
    const closed = renderToStaticMarkup(createElement(DetectReportTable, { report, open: false, onToggle: () => {} }));
    expect(closed).not.toContain('<table');
    expect(closed).toContain('4 capability result(s)');
  });

  // 2026-09-28 (owner: "when I try and test laya endpoint in endpoint ui it errors"): a typed-decision
  // model's report carries ONE 'decision' row (the Verify probe) and the table says the chat
  // capabilities are not applicable — never a chat-stream 500 rendered as an error.
  it('DetectReportTable on a typed-decision model renders the not-applicable note + the decision row', () => {
    const report: DetectedModelReport = {
      id: 'agx-laya', detectedAt: '2026-09-28T12:00:00.000Z',
      changed: ['kind=decision'],
      entry: { id: 'agx-laya', decision: 'systemone_chat', kind: 'decision' },
      results: [
        { capability: 'decision', ok: true, value: true, evidence: 'typed-decision model — one noul + choice via POST /chat/completions (questions map) → answers envelope parsed: typed decision OK; chat capabilities not applicable', latencyMs: 300, at: '2026-09-28T12:00:01.000Z' },
      ],
    };
    const html = renderToStaticMarkup(createElement(DetectReportTable, { report, open: true, onToggle: () => {} }));
    expect(html).toContain('data-testid="detect-decision-note"');
    expect(html).toContain('Typed-decision model — chat capabilities not applicable');
    expect(html).toContain('Typed decision (the Verify probe)');
    expect(html).toContain('>yes<');
    expect(html).not.toContain('Chat streaming');
    expect(isDecisionModelReport(report)).toBe(true);
    expect(isDecisionModelReport({ results: [{ capability: 'chat_stream', ok: true, value: 'json', evidence: '', latencyMs: 1, at: '' }] })).toBe(false);
    expect(API).toContain("| 'decision';");
    expect(API).toContain("decision: 'Typed decision (the Verify probe)'");
  });

  it('a manual flag toggle is remembered in manualFlags, and a detection merge never overwrites a manual field', () => {
    const m: EndpointModel = { id: 'x', vision: true };
    expect(withManualFlag(m, 'vision').manualFlags).toEqual(['vision']);
    expect(withManualFlag(withManualFlag(m, 'vision'), 'vision').manualFlags).toEqual(['vision']);
    const draftEntry: EndpointModel = { id: 'x', maxTools: 64, reasoningEffort: 'supported', manualFlags: ['maxTools'] };
    const detected: EndpointModel = { id: 'x', maxTools: 128, reasoningEffort: 'unsupported', providerClass: 'openai', capabilities: { detectedAt: '2026-09-27T19:30:00.000Z', results: [] } };
    const merged = mergeDetectedEntry(draftEntry, detected);
    expect(merged.maxTools).toBe(64);                 // manual field kept
    expect(merged.reasoningEffort).toBe('unsupported'); // detected field taken
    expect(merged.providerClass).toBe('openai');
    expect(merged.manualFlags).toEqual(['maxTools']);
    expect(merged.capabilities?.detectedAt).toBe('2026-09-27T19:30:00.000Z');
    expect(mergeDetectedEntry({ id: 'y' }, { id: 'y', maxTools: 10 })).toEqual({ id: 'y', maxTools: 10 });
    // every hand toggle in the dialog goes through withManualFlag
    expect(SECTION).toContain("patchModel(idx, m => withManualFlag({ ...m, [flag]: !m[flag] }, flag));");
    expect(SECTION).toContain("patchModel(idx, m => withManualFlag({ ...m, ...patch }, flag));");
  });

  it('the dialog copy states the two rules of the incident (128-tool cap trimmed automatically; reasoning_effort omitted unless supported + the LiteLLM fix) and names the kill switches', () => {
    const legend = renderToStaticMarkup(createElement(EndpointDialogLegend));
    expect(legend).toContain('OpenAI-like models accept at most 128 tools');
    expect(legend).toContain('trims the long tail automatically');
    expect(legend).toContain('custom endpoints do NOT receive reasoning_effort unless flagged supported');
    expect(legend).toContain('add `reasoning_effort: none` under litellm_params for that model group, or route it via /v1/responses');
    for (const k of ['TOOL_LIMIT_TRIM_DISABLED=1', 'SEAT_INVALID_REQUEST_FALLBACK_DISABLED=1']) expect(legend).toContain(k);
    // build 2026-10-08 S-2: ENDPOINT_CAPABILITY_DETECT_DISABLED was deleted (never forwarded to prod) — not advertised.
    expect(legend).not.toContain('ENDPOINT_CAPABILITY_DETECT_DISABLED');
    // the pins the roles test keeps for the older flags still hold
    expect(legend).toContain('image = generates pictures via an OpenAI-shaped /images/generations route');
    expect(legend).toContain('calibrated = a DECISION backend whose probabilities you assert are calibrated');
    expect(legend).toContain('typed decisions = a DECISION model behind an OpenAI-compatible proxy');
  });
});

describe('7. `coding` is retired as a model flag — chat-capable pickers + the seat latched badge', () => {
  it('modelKindOf / isChatCapableModel mirror the backend: explicit kind > legacy coding > image/decision flags > detection > id heuristic > chat', () => {
    expect(modelKindOf({ id: 'api-openai-gpt-6-astra' })).toBe('chat');
    expect(isChatCapableModel({ id: 'api-anthropic-claude-fable-5-1' })).toBe(true);
    expect(modelKindOf({ id: 'Qwen/Qwen3-Embedding-8B' })).toBe('embeddings');
    expect(modelKindOf({ id: 'bge-reranker-v2-m3' })).toBe('rerank');
    expect(modelKindOf({ id: 'whisper-large-v3' })).toBe('asr');
    expect(modelKindOf({ id: 'qwen3-tts-flash' })).toBe('tts');
    expect(modelKindOf({ id: 'stable-diffusion-xl' })).toBe('image');
    expect(modelKindOf({ id: 'agx-laya' })).toBe('decision');
    expect(isChatCapableModel({ id: 'Qwen/Qwen3-Embedding-8B' })).toBe(false);
    expect(isChatCapableModel({ id: 'Qwen/Qwen3-Embedding-8B', coding: true })).toBe(true);        // legacy flag asserts chat
    expect(isChatCapableModel({ id: 'bge-reranker-v2-m3', kind: 'chat' })).toBe(true);             // explicit kind wins
    expect(isChatCapableModel({ id: 'gpt-4o', kind: 'embeddings' })).toBe(false);
    expect(modelKindOf({ id: 'foo', image: true })).toBe('image');
    expect(modelKindOf({ id: 'foo', decision: 'systemone_chat' })).toBe('decision');
    expect(modelKindOf({ id: 'foo', capabilities: { detectedAt: 'x', results: [{ capability: 'embeddings', ok: true, value: 4096, evidence: '', latencyMs: 0, at: 'x' }] } })).toBe('embeddings');
    expect(modelKindOf({ id: 'mystery', capabilities: { detectedAt: 'x', results: [{ capability: 'tool_calling', ok: true, value: true, evidence: '', latencyMs: 0, at: 'x' }] } })).toBe('chat');
    expect(detectedModelKind(undefined)).toBeNull();
    expect(heuristicModelKind('')).toBeNull();
    expect(looksNonChatModelId('text-embedding-3-large')).toBe(true);
    expect(looksNonChatModelId('glm-5.3')).toBe(false);
    expect(modelKindOf(null)).toBe('chat');
  });

  it('every seat / coding picker filters by chat capability, not the legacy flag; the dialog has no coding toggle; the type keeps `coding` as a deprecated alias', () => {
    expect(ROLES).toContain('chatCapable: isChatCapableModel(m), image: m.image === true');
    expect(ROLES).toContain('const options = nonChat || decisionSeat ? registryOptions : registryOptions.filter(o => o.chatCapable);');
    expect(ROLES).not.toContain('registryOptions.filter(o => o.coding)');
    expect(CODING_TAB).toContain('e.models.filter(m => isChatCapableModel(m)).map(m => ({');
    expect(SESSION_VIEW).toContain('e.models.filter(m => isChatCapableModel(m)).map(m => ({');
    expect(CODING_TAB).not.toContain('filter(m => m.coding)');
    expect(SESSION_VIEW).not.toContain('filter(m => m.coding)');
    expect(SECTION).not.toContain("key: 'coding'");
    expect(SECTION).not.toContain("{m.coding && ' · coding'}");
    expect(SECTION).toContain("{kind !== 'chat' && ` · ${kind}`}");
    expect(API).toContain('@deprecated LEGACY alias (2026-09-27)');
    expect(API).toContain('coding?: boolean;');
    const legend = renderToStaticMarkup(createElement(EndpointDialogLegend));
    expect(legend).toContain('Any chat-capable model (kind: chat) can serve the chat, agent and coding seats — coding is a seat choice, not a model capability.');
    expect(ROLES).toContain('coding is a seat choice, not a model capability');
    expect(ROLES).toContain('(and be a chat model — kind: chat)');
  });

  it('the Model roles page badges a LATCHED seat next to the servable badge, and the api type carries `latched`', () => {
    expect(API).toContain('latched?: { from: string; to: string; reason: string; fingerprint?: string; since: string; until: string };');
    expect(ROLES).toContain('data-testid="seat-latched"');
    expect(ROLES).toContain('seat unusable: {role.latched.reason} — running on {role.latched.to || \'the built-in fallback\'} since {role.latched.since.slice(0, 16).replace(\'T\', \' \')}Z (retried after {role.latched.until.slice(11, 16)}Z)');
    expect(ROLES).toContain('border-warn/60 bg-warn/10');
    expect(ROLES).toContain('max-w-full whitespace-normal break-words');
    // it sits after the servable badge in the same badge row
    expect(ROLES.indexOf('data-testid="seat-latched"')).toBeGreaterThan(ROLES.indexOf("{role.missingEnvKey ? `add ${role.missingEnvKey}` : 'no API key on this instance'}"));
  });
});

describe('8. ticket 2df5ed65 — the endpoint Test result renders the healthy typed-decision shape note, never a bare "failed"', () => {
  it('a healthy verdict that carries a detail (the typed-decision shape note) is rendered inline after the Connected line and in the toast', () => {
    // The result line: the detail span renders when ok && test.detail.
    expect(SECTION).toContain('{test.ok && test.detail && (');
    expect(SECTION).toContain('<span className="text-[11px] text-muted-foreground break-all"> — {test.detail}</span>');
    // The toast carries it too.
    expect(SECTION).toContain("${result.detail ? ` — ${result.detail}` : ''}");
    // The API type surfaces detail ON THE TEST RESULT INTERFACE — structural,
    // not a substring another interface can satisfy (reviewer A8: the old
    // `toContain('detail?: string;')` was vacuously true of OTHER interfaces
    // and let a typecheck-red pass).
    const m = API.match(/export interface EndpointTestResult \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('detail?: string;');
    // completionAuth stays optional — a no-chat-probe verdict omits it (B1).
    expect(m![0]).toContain("completionAuth?: 'ok' | 'failed';");
  });

  it('the Test button tooltip tells the admin typed-decision models are probed with a typed decision (the old text said only the Verify button does)', () => {
    // The old gap text: "A model flagged [typed decisions] is probed with a typed decision by its own Verify button and by Model roles → Decision gate → Test."
    expect(SECTION).not.toContain('by its own Verify button and by Model roles');
    expect(SECTION).toContain('Typed-decision models — flagged [typed decisions], kind "decision", or a decision id like agx-laya — are probed with a typed decision here too');
    expect(SECTION).toContain('re-probed with the decision shape');
  });
});

// ── 9. ticket 780cd7a4 — the saved-card Sync button: the endpoint's model list
// refreshes from the server's live /v1/models without a manual edit round-trip ──

describe('9. ticket 780cd7a4 — Sync model list (saved card)', () => {
  it('the api client exposes refresh() on the exact route the backend serves', () => {
    // Structural: the exported api object carries a refresh member whose body
    // POSTs the :id/refresh route — not a substring another call can satisfy.
    const m = API.match(/refresh: async \(id: string\)[\s\S]*?\n  \},/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("apiClient.post(`/crossmodel/admin/model-endpoints/${id}/refresh`)");
    expect(m![0]).toContain('Promise<ModelEndpoint & { sync: EndpointModelsSyncDiff }>');
    // The diff type exists with all four legs.
    const t = API.match(/export interface EndpointModelsSyncDiff \{[\s\S]*?\n\}/);
    expect(t).not.toBeNull();
    for (const leg of ['added: string[];', 'retired: string[];', 'backButKeptRetired: string[];', 'unchanged: string[];']) {
      expect(t![0]).toContain(leg);
    }
  });

  it('the saved card renders a Sync button that calls runSync and reloads the persisted list (never mutates local state only)', () => {
    expect(SECTION).toContain('onClick={() => runSync(ep)}');
    expect(SECTION).toContain('disabled={syncingId === ep.id}');
    expect(SECTION).toContain('const [syncingId, setSyncingId] = useState<string | null>(null);');
    // The persisted endpoint lands in the card list — the WHOLE server summary,
    // not just models (review F2: frontierModelIds and every other derived
    // field would go stale on a models-only patch).
    expect(SECTION).toContain('const { sync, ...fresh } = result;');
    expect(SECTION).toContain('setEndpoints(prev => prev.map(e => e.id === ep.id ? { ...e, ...fresh } : e));');
    // The toast reports every diff leg, including the kept-retired note.
    expect(SECTION).toContain('sync.added.length');
    expect(SECTION).toContain('sync.retired.length');
    expect(SECTION).toContain('sync.backButKeptRetired.length');
    expect(SECTION).toContain('already in sync');
  });

  it('the Sync tooltip explains the merge semantics (retire-not-delete) and the dark-server refusal', () => {
    const btn = SECTION.slice(SECTION.indexOf('onClick={() => runSync(ep)}'));
    const tip = btn.slice(btn.indexOf('title="'), btn.indexOf('<RefreshCw'));
    expect(tip).toContain('ids the server no longer serves are marked retired');
    expect(tip).toContain('nothing is deleted');
    expect(tip).toContain('every model vanished');
  });
});

// ── 10. ticket 04c8ffd1 — the per-model image timeout input (slow local image
// backends: Qwen-Image behind LiteLLM, 5-10 min/generation, hard-died at the
// shipped 120 s custom-leg cap) ────────────────────────────────────────────────
describe('10. ticket 04c8ffd1 — per-model image timeout input', () => {
  it('an [image]-flagged model row renders the timeout input (label + placeholder + clamp hint); a non-image model never renders it', () => {
    // The input rides the model row right after the max-state-chars control,
    // shown ONLY when the entry is flagged [image] — the same conditional-input
    // idiom maxStateChars uses.
    expect(SECTION).toContain("patchModel(idx, m => withManualFlag({ ...m, imageTimeoutMs: positiveIntOrUndefined(raw) }, 'imageTimeoutMs'));");
    expect(SECTION).toContain('{m.image === true && (');
    expect(SECTION).toContain('image timeout (ms)');
    expect(SECTION).toContain('placeholder="120000"');
    expect(SECTION).toContain('aria-label={`${m.id} image timeout ms`}');
    expect(SECTION).toContain('min={30000}');
    // The other conditional inputs stay keyed to their own flags — the image
    // timeout input is gated ONLY on [image] (never the provider shape).
    const gatedOnImage = SECTION.slice(SECTION.indexOf('{m.image === true && ('), SECTION.indexOf('aria-label={`${m.id} image timeout ms`}'));
    expect(gatedOnImage).not.toContain('providerShape');
    // A non-image model never renders it: the render predicate is image === true.
    expect(SECTION).not.toContain('{m.maxStateChars !== undefined && (\n');
  });

  it('typing patches the entry imageTimeoutMs through the manual-flag path (a re-detect never overwrites it) and the api type carries the field', () => {
    // The setter goes through withManualFlag — same protection as every other hand-set field.
    expect(SECTION).toContain("patchModel(idx, m => withManualFlag({ ...m, imageTimeoutMs: positiveIntOrUndefined(raw) }, 'imageTimeoutMs'));");
    expect(withManualFlag({ id: 'x', image: true }, 'imageTimeoutMs').manualFlags).toEqual(['imageTimeoutMs']);
    // The type is part of the ManualFlag union (source pin — the type is not exported).
    expect(SECTION).toMatch(/\| 'unservable' \| 'imageTimeoutMs';/);
    // The api type carries the field with the 04c8ffd1 doc.
    expect(API).toContain('imageTimeoutMs?: number;');
    const t = API.match(/export interface EndpointModel \{[\s\S]*?\n\}/);
    expect(t).not.toBeNull();
    expect(t![0]).toContain('imageTimeoutMs?: number;');
  });

  it('the saved-card row summary shows the raised timeout only when set, and the legend documents the knob and the env default', () => {
    // Row summary: the marker rides the image badge, rounded to seconds.
    expect(SECTION).toContain("{m.image && m.imageTimeoutMs ? ` · timeout ${Math.round(m.imageTimeoutMs / 1000)}s` : ''}");
    // The knob is documented in the dialog legend.
    const legend = renderToStaticMarkup(createElement(EndpointDialogLegend));
    expect(legend).toContain('image timeout (ms) = the per-model image-generation wait');
    expect(legend).toContain('IMAGE_CUSTOM_TIMEOUT_MS');
    expect(legend).toContain('a per-model value wins');
  });

  it('the image seat client-side wait covers a per-model-raised probe (810 s = 720 s leg + 60 s download + margin) — a max-wait, not a live cut', () => {
    // The image seat's Test rides the SSE stream reader whose abort timer is
    // roleTestWaitMs + STREAM_GRACE_MS; the backend ALWAYS concludes (probe
    // never throws → ok:false), so a longer wait can only cover more, never
    // cut a live probe. 810 s covers the 720 s save-clamp ceiling + download.
    expect(API).toContain('export const IMAGE_TEST_WAIT_MS = 810_000;');
    expect(API).toMatch(/export function roleTestWaitMs\(role: string, model\?: string\): number \{\s*\n?\s*if \(role === 'image_generate'\) return IMAGE_TEST_WAIT_MS;/);
    expect(API).toContain('IMAGE_PROBE_HARD_CAP_GRACE_MS');
  });
});
