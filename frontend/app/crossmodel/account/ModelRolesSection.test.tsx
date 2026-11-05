/**
 * ModelRolesSection — ASR seat pins (ticket 4806298b-7032-4c21-9d9e-cc6af9d6a24f;
 * owner ask 2026-09-13: "switch asr model on the custom endpoints ui page so
 * i can test other STT asr models").
 *
 * The asr role row flows from the backend MODEL_ROLES list through the API
 * (the UI hardcodes no role rows), so these pins use the repo's SOURCE-LEVEL
 * idiom for effectful components (c1-convergence-smoke.test.tsx: the section
 * fetches in effects — a full SSR render only shows the loading spinner):
 * readFileSync of the component source + toContain on stable identifiers.
 * Pins: the NON_CHAT_ROLES mirror includes 'asr' (so its picker offers ANY
 * registered endpoint model, never a built-in chat id, and gets no built-in
 * optgroup — the `builtIns = nonChat ? [] : …` rule), the copy names the
 * speech-to-text seat, and the backend-facing api file documents the chain.
 *
 * 2026-09-26 (decision backends): the same idiom pins the Decision gate seat's
 * picker fix (ANY registry model, not only [coding]-flagged), the per-purpose
 * primary / challenger panel, the comparison table, the promote confirm copy
 * and the Endpoints dialog's [calibrated] / max-state-chars fields. The pure
 * promote / dirty-diff / role rules are unit-tested in lib/decision-backends.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// The seat-apply summary helper is imported from the component module (2026-09-28);
// the api client is stubbed the way ModelEndpointsSection.test.tsx does it.
vi.mock('@/lib/api-client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));
import { seatApplySummaryLines } from './ModelRolesSection';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SECTION = readSrc('./ModelRolesSection.tsx');
const API = readSrc('../../../lib/api/model-endpoints.ts');

describe('ModelRolesSection — ASR seat (2026-09-13)', () => {
  it('the NON_CHAT_ROLES mirror includes asr alongside embeddings + rerank', () => {
    // asr must be non-chat so its picker takes ANY registered endpoint model
    // (no [coding] flag gate) and never offers built-in chat ids.
    expect(SECTION).toContain("const NON_CHAT_ROLES = new Set(['embeddings', 'rerank', 'asr', 'tts']);");
  });

  it('the section renders rows generically from the API role list (no per-role hardcoding to drift)', () => {
    // The rows come from roles.map — the asr row flows through this exact
    // path once the backend lists it, with its persona/description text.
    expect(SECTION).toContain('roles.map(role => {');
    expect(SECTION).toContain('const nonChat = NON_CHAT_ROLES.has(role.key);');
    // Non-chat rows take ALL registry options (no coding filter) and NO
    // built-in models group.
    expect(SECTION).toContain('const options = nonChat || decisionSeat ? registryOptions : registryOptions.filter(o => o.chatCapable);');
    expect(SECTION).toContain('const builtIns = builtInsFor(role);');
  });

  it('the section copy names the speech-to-text seat (header + empty-registry hint + footer)', () => {
    expect(SECTION).toContain('and speech-to-text plus text-to-speech.');
    expect(SECTION).toContain('The speech-to-text (ASR) seat expects an OpenAI-compatible /audio/transcriptions route');
  });

  it('the api type documents the built-in chain for the empty default (utility/embeddings/rerank/asr)', () => {
    expect(API).toContain('(utility/embeddings/rerank/asr/tts)');
  });
});

describe('ModelRolesSection — seat names + custom fallbacks (owner 2026-09-15)', () => {
  it("the NON_STREAMING_ROLES mirror is utility + coding_helper (the utility_fallback SEAT is gone — it is the Utility seat's fallback slot now)", () => {
    // 2026-09-22: per-seat built-in lists come from the backend (builtInOptions) — no client-side seat tables.
    expect(SECTION).not.toContain('BUILT_IN_AGENT_MODELS');
    expect(SECTION).toContain("const builtInsFor = (role: ModelRole): string[] => role.builtInOptions ?? [];");
    expect(SECTION).not.toContain("role.key === 'utility_fallback'");
  });

  it("the Utility seat's custom fallback offers NO built-ins — custom endpoint specs only (review F1)", () => {
    // Built-in ids are already legs of the built-in chain (DeepSeek primary /
    // DashScope safety net) and the backend 400s them at save time.
    expect(SECTION).toContain("const fallbackBuiltIns = role.key === 'utility' ? [] : builtIns;");
  });

  it('fallbackable seats get an "Add custom fallback" control that reveals a second picker + its own Test', () => {
    expect(SECTION).toContain('Add custom fallback');
    expect(SECTION).toContain('data-testid={`add-fallback-${role.key}`}');
    expect(SECTION).toContain('data-testid={`fallback-${role.key}`}');
    // Ticket 61d33af9: the call is built once ({ role, model, opts }) and
    // dispatched to testStream for image seats, test for every other seat.
    expect(SECTION).toContain("const call = slot === 'fallback'");
    expect(SECTION).toContain("? { role: role.key, model: fallbackDraft[role.key] ?? '', opts: { fallback: true } as const }");
    expect(SECTION).toContain(": { role: role.key, model: draft[role.key] ?? '', opts: undefined as undefined | { fallback: true } };");
    expect(SECTION).toContain('<option value="">None — Digby&apos;s built-in fallback</option>');
    // What happens without one is spelled out from the backend's plain-words field.
    expect(SECTION).toContain('Without one: {role.builtInFallback}');
  });

  it('saving sends role overrides AND fallbacks through one PUT (both dirty sets counted)', () => {
    expect(SECTION).toContain('const { roles: rs, warnings } = await modelRolesApi.updateWithWarnings(patch, fallbacks);');
    expect(SECTION).toContain('const dirtyCount = dirtyKeys.length + dirtyFallbackKeys.length;');
    expect(API).toContain('update: async (roles: Record<string, string>, fallbacks: Record<string, string> = {}): Promise<ModelRole[]>');
    expect(API).toContain('fallbackable: boolean;');
    expect(API).toContain('fallback: string | null;');
  });

  it('the copy uses the seat vocabulary and none of the retired names', () => {
    expect(SECTION).toContain('Digby (the lead), the Double Checker');
    expect(SECTION).toContain('the Triple Checker (Level 3 council)');
    const visibleCopy = SECTION.slice(SECTION.indexOf('return ('));
    expect(visibleCopy).not.toMatch(/fact-checker|Logician|Professor|Cross-checker/i);
  });

  it('the non-streaming gate feeds the picker the FAST built-ins list', () => {
    expect(SECTION).toContain('data-testid="model-map"');
    expect(API).toContain('builtInOptions?: string[];');
  });

  it('the footer hint names the Helper and Utility seats (and their fallbacks) as non-streaming', () => {
    expect(SECTION).toContain('The Helper and Utility seats (and their custom fallbacks) are called non-streaming');
  });

  it('the api module exposes the per-model parse-verification battery', () => {
    // POST /crossmodel/admin/model-endpoints/:id/verify { modelId } → the
    // 4-shape PARSE results (chat_stream / utility / embeddings / rerank).
    // 'decision' joined the union with the decision-gate seat (a18fef4f, 2026-09-24).
    expect(API).toContain("shape: 'chat_stream' | 'utility' | 'embeddings' | 'rerank' | 'decision';");
    expect(API).toContain('/verify`, { modelId }');
  });
});

describe('ModelRolesSection — Image generator seat (owner ask 2026-09-24)', () => {
  const ENDPOINTS = readSrc('./ModelEndpointsSection.tsx');

  it('the IMAGE_ROLES mirror is exactly image_generate (backend IMAGE_ROLES)', () => {
    expect(SECTION).toContain("const IMAGE_ROLES = new Set(['image_generate']);");
    // The existing role tables are untouched by the new seat.
    expect(SECTION).toContain("const NON_CHAT_ROLES = new Set(['embeddings', 'rerank', 'asr', 'tts']);");
    expect(SECTION).toContain("const VISION_ROLES = new Set(['vision_describe', 'pdf_ocr', 'computer_vision']);");
  });

  it('the image seat picker = role.builtInOptions + registry models flagged [image] (never the [coding] filter)', () => {
    // The pinned coding filter stays for agent seats; the image seat swaps in
    // the [image]-flagged registry models for BOTH the seat and fallback pickers.
    expect(SECTION).toContain('const options = nonChat || decisionSeat ? registryOptions : registryOptions.filter(o => o.chatCapable);');
    expect(SECTION).toContain('const imageSeat = IMAGE_ROLES.has(role.key);');
    expect(SECTION).toContain('const seatOptions = imageSeat ? registryOptions.filter(o => o.image) : options;');
    expect(SECTION).toContain('image: m.image === true');
    expect(SECTION.match(/seatOptions\.map\(o => <option key=\{o\.spec\}/g) || []).toHaveLength(2);
    expect(SECTION).not.toMatch(/\boptions\.map\(o => <option/);
    // Built-ins still flow from the backend — no client-side image-id table.
    expect(SECTION).toContain('const builtIns = builtInsFor(role);');
    expect(SECTION).not.toMatch(/qwen-image-3\.0|z-image-turbo|cogview-4/);
  });

  it('a test result carrying image renders an expandable probe thumbnail under the Test line (seat + fallback slots)', () => {
    expect(SECTION).toContain("import { ExpandableDataImage } from '@/components/ui/custom/prompt/expandable-data-image';");
    expect(SECTION).toContain('data-testid="probe-image"');
    expect(SECTION).toContain('{test?.ok && test.image && <ProbeImage image={test.image}');
    expect(SECTION).toContain('{fallbackTest?.ok && fallbackTest.image && <ProbeImage image={fallbackTest.image}');
    expect(SECTION).toContain('src={`data:${image.mediaType};base64,${image.data}`}');
    expect(API).toContain('image?: { mediaType: string; data: string };');
  });

  it('the copy names the Image generator seat (header + row hint + footer) and keeps the pinned sentences', () => {
    expect(SECTION).toContain('and speech-to-text plus text-to-speech.');
    expect(SECTION).toContain('The Image generator seat draws the pictures generate_image makes');
    expect(SECTION).toContain('a custom endpoint model must be flagged [image] on its endpoint entry');
    expect(SECTION).toContain('The Image generator seat takes the built-in image models');
    expect(SECTION).toContain('The Helper and Utility seats (and their custom fallbacks) are called non-streaming');
  });

  it('the Endpoints dialog exposes the [image] flag chip on registry models and the api type carries it', () => {
    expect(API).toContain('image?: boolean;');
    // 2026-09-27: `coding` is no longer a toggle — "coding is a seat choice, not a model capability".
    expect(ENDPOINTS).toContain("const toggleFlag = (idx: number, flag: 'vision' | 'image' | 'matryoshka' | 'calibrated') =>");
    expect(ENDPOINTS).not.toContain("toggleFlag(i, 'coding')");
    expect(ENDPOINTS).toContain("{ key: 'image', label: 'image', on: !!m.image, flip: () => toggleFlag(i, 'image')");
    expect(ENDPOINTS).toContain("{m.image && ' · image'}");
    expect(ENDPOINTS).toContain('image = generates pictures via an OpenAI-shaped /images/generations route');
  });
});

describe('ModelRolesSection — decision-gate modes control (WI-S, 2026-09-25)', () => {
  it('the Decision gate seat row carries a per-purpose mode control fed by the store-backed admin route', () => {
    expect(SECTION).toContain("const DECISION_ROLE_KEY = 'decision';");
    expect(SECTION).toContain('{role.key === DECISION_ROLE_KEY && decisionModes && (');
    expect(SECTION).toContain('data-testid="decision-gate-modes"');
    expect(SECTION).toContain('data-testid={`decision-mode-${p.purpose}`}');
    expect(SECTION).toContain('data-testid="save-decision-modes"');
    // Loaded next to the seats, tolerated on a pre-WI-S backend (no route → the control hides).
    expect(SECTION).toContain('decisionGateApi.listModes().catch(() => null),');
    // Saves ONLY the dirty purposes through the fleet-wide PUT ('' clears back to env).
    expect(SECTION).toContain('const cfg = await decisionGateApi.updateModes(patch);');
    expect(SECTION).toContain("{ value: '', label: 'Not set — env / default' },");
    expect(SECTION).toContain("{ value: 'act', label: 'act — skip / route on a confident answer' },");
    // The live kill switches are named where the admin flips modes (build 2026-10-08 S-2: the deleted
    // DECISION_GATE_STORE_MODE_DISABLED / _AUTO_DEMOTE_DISABLED are no longer advertised).
    expect(SECTION).toContain('DECISION_GATE_DISABLED=1');
    expect(SECTION).toContain('DECISION_GATE_ADMISSION_DISABLED=1');
    expect(SECTION).not.toContain('DECISION_GATE_STORE_MODE_DISABLED');
  });

  it('E12 (2026-09-25): every purpose row carries a flip-readiness badge — "ready" on a fresh READY stamp, "not ready" otherwise, and names the refusal when act is drafted without one', () => {
    expect(SECTION).toContain('data-testid={`decision-readiness-${p.purpose}`}');
    expect(SECTION).toContain("const readyNow = !!p.readiness?.ready && !p.readiness?.stale;");
    expect(SECTION).toContain("{readyNow ? 'ready' : v === 'act' && !admitted ? 'not ready — act will be refused' : 'not ready'}");
    // The backend's refusal reason (409) is what the badge title shows, so the bar is named before the save.
    expect(SECTION).toContain('title={p.admission.reason ?? readinessTitle}');
    expect(SECTION).toContain('admission off');
    // The api type carries the stamp + verdict as OPTIONAL fields (pre-E12 backends omit them).
    expect(API).toContain('readiness?: { ready: boolean; at: string | null; metrics: Record<string, unknown>; reasons?: string[]; stale: boolean } | null;');
    expect(API).toContain('admission?: { admitted: boolean; reason?: string };');
    expect(API).toContain('admissionDisabled?: boolean;');
  });

  it('the api module exposes the decision-gate modes GET/PUT next to model roles', () => {
    expect(API).toContain("apiClient.get('/crossmodel/admin/model-roles/decision-modes')");
    expect(API).toContain("apiClient.put('/crossmodel/admin/model-roles/decision-modes', { modes })");
    expect(API).toContain("storeMode: 'off' | 'shadow' | 'act' | null;");
    // backlog E13 (2026-09-28): + 'registry_cap' (an act-capped purpose) and 'retired_default' (a retired purpose's bare default).
    expect(API).toContain("effectiveSource: 'disabled' | 'store' | 'env_purpose' | 'env_default' | 'default' | 'registry_cap' | 'retired_default';");
  });

  it('the Decision gate seat row carries the flip-readiness readout fed by the stamp route (E1, 2026-09-25)', () => {
    expect(API).toContain("apiClient.get('/crossmodel/admin/model-roles/decision-readiness')");
    expect(API).toContain('purposes: Record<string, PurposeReadiness> | null;');
    // Loaded next to the modes, tolerated on a pre-E1 backend (no route → "no report stamped yet").
    expect(SECTION).toContain('decisionGateApi.readiness().catch(() => null),');
    expect(SECTION).toContain('data-testid="decision-gate-readiness"');
    expect(SECTION).toContain('data-testid={`decision-readiness-${p.purpose}`}');
    expect(SECTION).toContain("{r.ready ? 'READY' : 'NOT READY'}");
    expect(SECTION).toContain('no report stamped yet');
    // The readout names the command that produces a stamp; it never flips anything itself (the deleted
    // DECISION_GATE_READINESS_STAMP_DISABLED badge is gone — build 2026-10-08 S-2).
    expect(SECTION).not.toContain('DECISION_GATE_READINESS_STAMP_DISABLED');
    expect(SECTION).toContain('npm run decision-gate:fit -- --days=14 --stamp');
  });

  it('the pre-existing seat-picker pins are untouched by the new control', () => {
    expect(SECTION).toContain('roles.map(role => {');
    expect(SECTION).toContain('const { roles: rs, warnings } = await modelRolesApi.updateWithWarnings(patch, fallbacks);');
    expect(SECTION).toContain('const dirtyCount = dirtyKeys.length + dirtyFallbackKeys.length;');
  });
});

describe('ModelRolesSection — decision backends: per-purpose primary + challengers (2026-09-26)', () => {
  const ENDPOINTS = readSrc('./ModelEndpointsSection.tsx');
  const LIB = readSrc('../../../lib/decision-backends.ts');

  it('the Decision gate seat picker offers EVERY registry model (systemone servers carry no [coding] flag) — the old coding filter hid them', () => {
    expect(SECTION).toContain("const decisionSeat = role.key === DECISION_ROLE_KEY;");
    expect(SECTION).toContain('const options = nonChat || decisionSeat ? registryOptions : registryOptions.filter(o => o.chatCapable);');
    // The other seats keep their filters untouched.
    expect(SECTION).toContain('const seatOptions = imageSeat ? registryOptions.filter(o => o.image) : options;');
    expect(SECTION).toContain("const NON_CHAT_ROLES = new Set(['embeddings', 'rerank', 'asr', 'tts']);");
  });

  it('the panel loads from the decision-backends route beside the modes + readiness, tolerated on an older backend (no route → the panel hides)', () => {
    // A body that is not the full view hides the panel too (reviewer 2026-09-26) — never a crash of the whole section.
    expect(SECTION).toContain('decisionBackendsApi.get().then(v => (isDecisionBackendsView(v) ? v : null)).catch(() => null),');
    expect(SECTION).toContain('{role.key === DECISION_ROLE_KEY && decisionBackends && (');
    expect(SECTION).toContain('<DecisionBackendsPanel');
    expect(SECTION).toContain('seatEffective={role.effective}');
    expect(SECTION).toContain('data-testid="decision-gate-backends"');
    expect(API).toContain("apiClient.get('/crossmodel/admin/model-roles/decision-backends')");
    expect(API).toContain("apiClient.put('/crossmodel/admin/model-roles/decision-backends', patch)");
    // Laya follow-up (2026-09-26): a typed-decision model reached through /chat/completions is its own candidate kind.
    expect(API).toContain("kind: 'systemone' | 'logit' | 'systemone_chat';");
    expect(API).toContain('purposes: Record<string, { primary?: string; challengers?: string[] }>;');
    expect(API).toContain('defaultChallengers?: string[];');
  });

  it('every purpose row = primary select over the candidates + challenger toggle chips; default challengers have their own row', () => {
    expect(SECTION).toContain('data-testid={`decision-backend-purpose-${p}`}');
    expect(SECTION).toContain("<option value=\"\">Seat chain — {seatEffective || 'built-in'} first</option>");
    expect(SECTION).toContain('aria-label={`${purposeLabel(p)} primary decision backend`}');
    expect(SECTION).toContain('testId={`challenger-${p}-${c.spec}`}');
    expect(SECTION).toContain('data-testid="decision-default-challengers"');
    expect(SECTION).toContain('testId={`default-challenger-${c.spec}`}');
    // Only the dirty purposes / defaults go out, through the fleet-wide PUT.
    expect(SECTION).toContain('const pendingPatch = dirtyBackendPatch(view.config, draft);');
    expect(SECTION).toContain('const raw = await decisionBackendsApi.update(patch);');
    expect(SECTION).toContain('data-testid="save-decision-backends"');
  });

  it('the PUT response is CHECKED, never trusted: a short body re-GETs, and coerceBackendsView keeps the previous view on failure (reviewer 2026-09-26 — a {ok:true} PUT must never unmount the section)', () => {
    expect(SECTION).toContain('if (!isDecisionBackendsView(raw)) next = await decisionBackendsApi.get().catch(() => raw);');
    expect(SECTION).toContain('onSaved(coerceBackendsView(view, next));');
    // The view's purposes are the backend's OBJECTS — keys / labels / modes come off them (a bare string[] is tolerated).
    expect(SECTION).toContain('const out = purposeKeys(view.purposes);');
    expect(SECTION).toContain("purposeView(view.purposes, purpose)?.label");
    expect(SECTION).toContain('const seatEffective = view.seatModel || seatEffectiveProp;');
    expect(SECTION).toContain('const candidates: DecisionBackendCandidate[] = Array.isArray(view.candidates) ? view.candidates : [];');
    expect(API).toContain('export interface DecisionBackendPurposeView {');
    expect(API).toContain('purposes: Array<DecisionBackendPurposeView | string>;');
    expect(API).toContain('update: async (patch: DecisionBackendsPatch): Promise<Partial<DecisionBackendsView> | null | undefined> =>');
    // build 2026-10-08 S-2: the primaries-off / challengers-off badges went with their deleted kill switches.
    expect(SECTION).not.toContain('data-testid="decision-backends-primaries-off"');
    expect(SECTION).not.toContain('data-testid="decision-backends-challengers-off"');
  });

  it("a purpose's own challenger list is TRI-STATE like the backend's (null = inherit the defaults, [] = explicitly none via the \"none\" chip, else its own list); primary '' clears", () => {
    expect(SECTION).toContain('testId={`challenger-${p}-none`}');
    expect(SECTION).toContain('const toggleNoChallengers = (purpose: string) =>');
    expect(SECTION).toContain("return { ...d, purposes: { ...d.purposes, [purpose]: { ...row, challengers: next.length ? next : null } } };");
    expect(SECTION).toContain('const explicitNone = own !== null && own.length === 0;');
    expect(SECTION).toContain('(default: none)');
    expect(API).toContain('purposes?: Record<string, { primary?: string; challengers?: string[] | null }>;');
    expect(LIB).toContain('challengers: string[] | null;');
    expect(LIB).toContain("challengersDirty ? { challengers: row.challengers === null || row.challengers === undefined ? null : uniq(row.challengers) } : {}");
  });

  it('Test per backend reuses the seat probe (POST /admin/model-roles/test { role: decision, model: spec })', () => {
    expect(SECTION).toContain('data-testid="decision-backend-candidates"');
    expect(SECTION).toContain('data-testid={`test-decision-backend-${c.spec}`}');
    expect(SECTION).toContain('const result = await modelRolesApi.test(DECISION_ROLE_KEY, spec);');
    // Badges: kind, calibration, servability.
    expect(SECTION).toContain("{c.kind === 'systemone' ? 'systemone' : c.kind === 'systemone_chat' ? 'typed decisions via chat' : 'logprob readout'}");
    expect(SECTION).toContain('>uncalibrated</Badge>');
    expect(SECTION).toContain('>unservable</Badge>');
  });

  it('the comparison table renders one row per (purpose, backend) from decision-readiness.report.entries with n / agreement / act band / Brier / ECE / AUROC / p50-p95 / fail + role, READY and uncalibrated badges', () => {
    expect(SECTION).toContain('data-testid="decision-backend-comparison"');
    expect(SECTION).toContain('data-testid="decision-backend-table"');
    expect(SECTION).toContain('data-testid={`decision-backend-row-${p}-${key}`}');
    expect(SECTION).toContain('for (const e of readiness?.report?.entries ?? []) {');
    expect(SECTION).toContain('const role = backendRoleFor(e, view.config, seatEffective);');
    for (const col of ['>n</th>', '>agree</th>', '>act band</th>', '>Brier</th>', '>ECE</th>', '>AUROC</th>', '>p50 / p95</th>', '>fail</th>']) expect(SECTION).toContain(col);
    expect(SECTION).toContain('{role === \'primary\' && <Badge className="text-[10px] bg-brand-accent">primary</Badge>}');
    expect(SECTION).toContain('{role === \'challenger\' && <Badge variant="secondary" className="text-[10px]">challenger</Badge>}');
    expect(SECTION).toContain('>READY</Badge>');
    expect(SECTION).toContain("{m.p50Ms === undefined && m.p95Ms === undefined ? 'n/a' : `${fmtMs(m.p50Ms)} / ${fmtMs(m.p95Ms)}`}");
    expect(SECTION).toContain('{fmtPercent(m.failRate, 1)}');
    // The api type keeps every 2026-09-26 field OPTIONAL (pre-challenger reports omit them).
    expect(API).toContain('report?: DecisionReadinessReport | null;');
    expect(API).toContain('backendSpec?: string;');
    expect(API).toContain("role?: 'primary' | 'challenger' | 'fallback';");
    for (const f of ['calls?: number;', 'failRate?: number;', 'p50Ms?: number;', 'p95Ms?: number;']) expect(API).toContain(f);
  });

  it('"Promote to primary" confirms with the act→shadow copy before the PUT (plan item G) and never on a non-act purpose', () => {
    expect(SECTION).toContain('data-testid={`promote-${p}-${spec}`}');
    expect(SECTION).toContain('promotePatch(view.config, purpose, spec, seatEffective)');
    expect(SECTION).toContain('const dropping = primaryChangesOnActPurposes(view.config, patch, modeByPurpose);');
    expect(SECTION).toContain('if (dropping.length) { setConfirm({ patch, purposes: dropping, what }); return; }');
    expect(SECTION).toContain('data-testid="confirm-decision-backend-change"');
    // The exact confirm copy, from the shared constant, in the dialog AND the footer.
    expect(SECTION.match(/PROMOTE_CONFIRM_COPY/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(LIB).toContain("export const PROMOTE_CONFIRM_COPY = 'act drops to shadow until the readiness job re-stamps this backend (≤6 h)';");
  });

  it('the footer names the live knobs where the admin edits backends (never the deleted kill switches)', () => {
    for (const k of ['DECISION_GATE_CHALLENGER_MAX', 'DECISION_GATE_CHALLENGER_GRACE_MS']) expect(SECTION).toContain(k);
    for (const k of ['DECISION_GATE_PURPOSE_BACKENDS_DISABLED', 'DECISION_GATE_CHALLENGERS_DISABLED', 'DECISION_GATE_CHALLENGER_DETACH_DISABLED']) expect(SECTION).not.toContain(k);
    // The pre-existing modes/readiness controls are untouched.
    expect(SECTION).toContain('data-testid="decision-gate-modes"');
    expect(SECTION).toContain('data-testid="decision-gate-readiness"');
  });

  it('the Endpoints dialog gains the [calibrated] chip + a max-state-chars input on decision servers, badges them on the card, and its systemone copy names Laya / openjev / JevK5 / NeoHorse and what Test checks', () => {
    expect(ENDPOINTS).toContain("{ key: 'calibrated', label: 'calibrated', on: !!m.calibrated, flip: () => toggleFlag(i, 'calibrated')");
    // Laya follow-up (2026-09-26): the input also shows for the systemone_chat shape and a model flagged [typed decisions].
    expect(ENDPOINTS).toContain("(draft.providerShape === 'systemone' || draft.providerShape === 'systemone_chat' || m.decision === 'systemone_chat' || m.maxStateChars !== undefined) && (");
    expect(ENDPOINTS).toContain('onChange={e => setMaxStateChars(i, e.target.value)}');
    expect(ENDPOINTS).toContain("{m.calibrated && ' · calibrated'}");
    expect(ENDPOINTS).toContain("{m.maxStateChars ? ` · ≤${m.maxStateChars} state chars` : ''}");
    const systemoneCopy = ENDPOINTS.slice(ENDPOINTS.indexOf("draft?.providerShape === 'systemone'"), ENDPOINTS.indexOf('Any OpenAI-compatible /chat/completions server.'));
    for (const name of ['Laya', 'openjev', 'JevK5', 'NeoHorse', 'CC BY-NC', 'GET /models', 'POST /systemone', 'not that it is calibrated']) expect(systemoneCopy).toContain(name);
    expect(ENDPOINTS).toContain('calibrated = a DECISION backend whose probabilities you assert are calibrated');
    expect(ENDPOINTS).toContain('max state chars = the decision gate truncates the state');
    expect(API).toContain('calibrated?: boolean;');
    expect(API).toContain('maxStateChars?: number;');
  });

  it('after a save the Endpoints dialog compares what it sent with what the backend echoed and WARNS when [calibrated] / max state chars were stripped (an older backend drops them silently — reviewer 2026-09-26)', () => {
    expect(ENDPOINTS).toContain("import { strippedDecisionFields } from '@/lib/decision-backends';");
    expect(ENDPOINTS).toContain('const stripped = strippedDecisionFields(sent, saved?.models);');
    expect(ENDPOINTS).toContain('const saved = await modelEndpointsApi.update(draft.id, patch);');
    expect(ENDPOINTS).toContain('const saved = await modelEndpointsApi.create({');
    expect((ENDPOINTS.match(/warnStrippedDecisionFields\(models, saved\);/g) ?? []).length).toBe(2);
    // bd51693b review F2: clamp-aware copy — the echo can differ because it was
    // DROPPED (older backend) or CLAMPED to a stored bound; both are named.
    expect(ENDPOINTS).toContain('toast.warning(`This backend did not keep ${stripped.join(\' / \')} as saved');
  });

  it('the live model-map chain text names every decision-backends switch, and every switch it names is READ by backend code (integration 2026-09-26: the core + challengers branches are both in backend/src)', () => {
    const ROLES_SERVICE = readSrc('../../../../backend/src/modules/crossmodel/model-endpoints/model-roles.service.ts');
    const chain = ROLES_SERVICE.slice(ROLES_SERVICE.indexOf("key: 'decision_chain'"), ROLES_SERVICE.indexOf("key: 'decision_chain'") + 8000);
    const envKeys = chain.slice(chain.indexOf('envKeys: ['), chain.indexOf(']', chain.indexOf('envKeys: [')));
    // Readers: platform/decision-gate-backends.ts (per-purpose primary + challengers), platform/decision-gate.ts
    // (systemone noul criteria, stored temps, calibrated-only), platform/decision-gate-readiness.ts (temps autofit).
    const readers = [
      readSrc('../../../../backend/src/modules/crossmodel/platform/decision-gate-backends.ts'),
      readSrc('../../../../backend/src/modules/crossmodel/platform/decision-gate.ts'),
      readSrc('../../../../backend/src/modules/crossmodel/platform/decision-gate-readiness.ts'),
    ].join('\n');
    for (const k of [
      'DECISION_GATE_CHALLENGER_MAX', 'DECISION_GATE_CHALLENGER_GRACE_MS',
      'DECISION_GATE_TEMP_AUTOFIT_ENABLED', 'DECISION_GATE_TEMP_AUTOFIT_DISABLED',
      // Laya follow-up (2026-09-26): detached challengers, confidence normalisation, sampled state.
      'DECISION_GATE_CHALLENGER_TIMEOUT_MS',
      'DECISION_GATE_STATE_SAMPLE_RATE', 'DECISION_GATE_STATE_SAMPLE_MAX_CHARS', 'DECISION_GATE_STATE_SAMPLE_DISABLED',
    ]) {
      expect(chain).toContain(k);
      expect(envKeys).toContain(k);
      // `process.env.X` or an `env: NodeJS.ProcessEnv` parameter's `env.X` (decision-gate-readiness.ts).
      expect(readers).toMatch(new RegExp(`\\benv\\.${k}\\b`));
    }
    // The merged calibration rule is what the map says — a bare systemone server is NOT presumed calibrated.
    expect(chain).toContain('NOT presumed calibrated');
    expect(chain).not.toContain('Calibrated = a systemone backend');
  });
});

describe('Laya via LiteLLM — the [typed decisions] model flag + the systemone_chat shape (2026-09-26)', () => {
  const ENDPOINTS = readSrc('./ModelEndpointsSection.tsx');
  const LIB = readSrc('../../../lib/decision-backends.ts');

  it('the Endpoints dialog offers the [typed decisions] chip (decision "systemone_chat" ⇄ unset), shows the max-state-chars input for a flagged model, badges the card, and its copy names llm.cql.ca / agx-laya / ≈ 3800 / the [typed decisions] flag as the documented way', () => {
    expect(ENDPOINTS).toContain("{ key: 'typed-decisions', label: 'typed decisions', on: m.decision === 'systemone_chat', flip: () => toggleTypedDecisions(i)");
    expect(ENDPOINTS).toContain("decision: m.decision === 'systemone_chat' ? undefined : 'systemone_chat'");
    expect(ENDPOINTS).toContain("(draft.providerShape === 'systemone' || draft.providerShape === 'systemone_chat' || m.decision === 'systemone_chat' || m.maxStateChars !== undefined) && (");
    expect(ENDPOINTS).toContain("{m.decision === 'systemone_chat' && ' · typed decisions'}");
    expect(ENDPOINTS).toContain('<option value="systemone_chat">Typed-decision proxy (LiteLLM /chat/completions + questions — decision models only)</option>');
    for (const s of ['llm.cql.ca', 'agx-laya', '3800', '[typed decisions]', '1,024 input tokens']) expect(ENDPOINTS).toContain(s);
    expect(ENDPOINTS).toContain('typed decisions = a DECISION model behind an OpenAI-compatible proxy');
    // The API type + the stripped-fields warning cover the new flag.
    expect(API).toContain("decision?: 'systemone_chat';");
    expect(API).toContain("providerShape?: 'openai_chat' | 'systemone' | 'systemone_chat';");
    expect(LIB).toContain("if (m.decision === 'systemone_chat' && echo.decision !== 'systemone_chat') add('[typed decisions]');");
    // The seat copy + the panel copy name the flagged prod model and the detached challengers.
    expect(SECTION).toContain('cql-litellm:agx-laya');
    expect(SECTION).toContain('DECISION_GATE_CHALLENGER_TIMEOUT_MS');
    expect(SECTION).not.toContain('a slow one is cut at the grace window');
  });

  it('the backend registers the flag on the model entry (validation + service whitelist) and the decision gate resolves it to the chat transport', () => {
    const VALIDATION = readSrc('../../../../backend/src/modules/crossmodel/model-endpoints/model-endpoints.validation.ts');
    const SERVICE = readSrc('../../../../backend/src/modules/crossmodel/model-endpoints/model-endpoints.service.ts');
    const GATE = readSrc('../../../../backend/src/modules/crossmodel/platform/decision-gate.ts');
    expect(VALIDATION).toContain("decision: z.enum(['systemone_chat']).optional(),");
    expect(SERVICE).toContain("if (m.decision === PROVIDER_SHAPE_SYSTEMONE_CHAT) entry.decision = PROVIDER_SHAPE_SYSTEMONE_CHAT;");
    expect(GATE).toContain("if (reg.providerShape === PROVIDER_SHAPE_SYSTEMONE_CHAT || reg.decision === PROVIDER_SHAPE_SYSTEMONE_CHAT) return 'chat';");
  });
});

describe('ModelRolesSection — compute-policy purposes render with human labels (Module D, 2026-09-26)', () => {
  const LIB = readSrc('../../../lib/decision-backends.ts');

  it('the client fallback map names the three compute-policy purposes', () => {
    expect(LIB).toContain("compute_policy: 'Compute policy',");
    expect(LIB).toContain("drafts_agree: 'Drafts agree',");
    expect(LIB).toContain("revision_material: 'Revision material',");
    expect(LIB).toContain('export function purposeLabelFor(purpose: string, backendLabel?: string | null): string {');
  });

  it('the Gate-mode table, its aria-label and the flip-readiness rows all go through purposeLabelFor (backend label first, client map second, raw key last)', () => {
    expect(SECTION).toContain('purposeKeys, purposeLabelFor, purposeView, readinessEntryMetrics,');
    expect(SECTION).toContain('<span className="font-medium min-w-[180px]" title={p.description}>{purposeLabelFor(p.purpose, p.label)}</span>');
    expect(SECTION).toContain('aria-label={`${purposeLabelFor(p.purpose, p.label)} decision-gate mode`}');
    // Readiness rows used to show the bare purpose code only — now the human label sits beside it.
    expect(SECTION).toContain('<span className="font-medium min-w-[150px]">{purposeLabelFor(p.purpose, p.label)}</span>');
    expect(SECTION).toContain('<code className="font-mono text-muted-foreground min-w-[120px]">{p.purpose}</code>');
  });

  it('the Decision backends panel resolves its purpose label through the same helper (no raw-key fallback of its own)', () => {
    expect(SECTION).toContain('const purposeLabel = (purpose: string): string => purposeLabelFor(purpose, purposeView(view.purposes, purpose)?.label ?? modes?.purposes.find(p => p.purpose === purpose)?.label);');
    expect(SECTION).not.toContain("?.label ?? purpose;");
  });
});

// ── DOI-17 (2026-09-28): the Decision gate seat renders the backend auth-latch
// state + the stamp's per-purpose health counters (both were exported by the
// backend since the 2026-09-26 audit with no GET consumer and no UI).
describe('decision backend health + auth latch readout (DOI-17, 2026-09-28)', () => {
  it('the readiness view type carries `latches` (null = view disabled on that backend; absent = older backend) and PurposeReadiness carries `health`', () => {
    expect(API).toContain('latches?: DecisionLatchView | null;');
    expect(API).toContain('export interface DecisionLatchView {');
    expect(API).toContain('export interface DecisionLatchEntry {');
    expect(API).toContain('health?: { calls: number; fails: number; downgraded: number; fellThrough: number; latched: number };');
  });

  it('the Flip readiness panel renders a "Backend health" line that branches on absent / none / latched entries', () => {
    expect(SECTION).toContain('data-testid="decision-backend-latches"');
    expect(SECTION).toContain('<span className="font-medium">Backend health</span>');
    expect(SECTION).toContain('latch state not reported by this backend');
    // build 2026-10-08 S-2: the view-disabled / latch-disabled branches went with their deleted kill switches.
    expect(SECTION).not.toContain('>latch view disabled here</Badge>');
    expect(SECTION).not.toContain('>auth latch disabled here</Badge>');
    expect(SECTION).toContain('>no backend latched</Badge>');
    expect(SECTION).toContain('data-testid={`decision-latch-${l.spec}`}');
    expect(SECTION).toContain("variant={l.holding ? 'destructive' : 'secondary'}");
    expect(SECTION).toContain("{l.holding ? 'latched' : 'probing'}: {l.backend} · HTTP {l.status}");
  });

  it('each readiness row carries the health counters (calls / fails / fell-through / latched / downgraded), amber when any degradation counter is non-zero', () => {
    expect(SECTION).toContain('const h = r?.health;');
    expect(SECTION).toContain('data-testid={`decision-health-${p.purpose}`}');
    expect(SECTION).toContain("(h.downgraded > 0 || h.latched > 0 || h.fails > 0) && 'text-warn-ink'");
    expect(SECTION).toContain('· health {h.calls}c/{h.fails}f');
  });
});

describe('2026-09-26 (audit, telemetry-readiness-9) — a non-human segment entry in the comparison table', () => {
  it('the entry type carries `segment`; the row is keyed by it, stamps data-segment, shows a "<segment> segment" badge instead of the fallback badge, and the testid pin is unchanged', () => {
    expect(API).toContain('segment?: string;');
    expect(SECTION).toContain('data-testid={`decision-backend-row-${p}-${key}`} data-segment={e.segment ?? \'human\'}');
    expect(SECTION).toContain("<tr key={`${p}|${key}${e.segment ? `|${e.segment}` : ''}`}");
    expect(SECTION).toContain("{role === 'fallback' && !e.segment && <Badge");
    expect(SECTION).toContain('{e.segment} segment</Badge>');
    expect(SECTION).toContain('never the stamp and never READY');
  });
});

// ── Seat governance — frontier-class badges (audit E3, 2026-09-27; review fixer same day) ──
// The backend derives providerClass from the endpoint host / model id and
// records a frontier-class registry model on the chat / supervisor seats
// (observe-only by default; the opt-in FRONTIER_SEATS_REFUSE=1 makes the SAVE
// refuse); the UI badges the seat, its fallback, the endpoint and each frontier
// model id, and the badge title branches on whether refusal is on.
describe('seat governance badges (audit E3, 2026-09-27)', () => {
  const ENDPOINTS = readSrc('./ModelEndpointsSection.tsx');
  it('the API types carry the server-derived class fields (present only when frontier; absent on old backends)', () => {
    expect(API).toContain("providerClass?: 'frontier' | 'open';");
    expect(API).toContain('frontierModelIds?: string[];');
    expect(API).toContain("providerClass?: 'frontier';");
    expect(API).toContain("fallbackProviderClass?: 'frontier';");
    expect(API).toContain('frontierSeatsAllowed?: boolean;');
  });

  it('a seat whose effective model is frontier-class gets a destructive "frontier" badge whose title branches on the refusal switch (an old backend without the flag reads as allowed); the fallback gets its own badge', () => {
    expect(SECTION).toContain("{role.providerClass === 'frontier' && (");
    expect(SECTION).toContain('title={role.frontierSeatsAllowed !== false');
    expect(SECTION).toContain('FRONTIER_SEATS_REFUSE=1');
    expect(SECTION).not.toContain('FRONTIER_SEATS_ALLOWED');
    expect(ENDPOINTS).toContain('FRONTIER_SEATS_REFUSE=1');
    expect(ENDPOINTS).not.toContain('FRONTIER_SEATS_ALLOWED');
    expect(SECTION).toContain("{role.fallbackProviderClass === 'frontier' && (");
    expect(SECTION).toContain('frontier fallback');
  });

  it('the endpoint card badges a frontier HOST or listed frontier MODEL IDS, and each frontier model id is suffixed in its chip', () => {
    expect(ENDPOINTS).toContain("{(ep.providerClass === 'frontier' || (ep.frontierModelIds?.length ?? 0) > 0) && (");
    expect(ENDPOINTS).toContain("{ep.providerClass === 'frontier' ? 'frontier host' : 'frontier models'}");
    expect(ENDPOINTS).toContain("{(ep.frontierModelIds ?? []).includes(m.id) && ' · frontier'}");
  });
});

describe('ModelRolesSection — decision-role registry + rollout automaton (rollout self-governance, 2026-09-27)', () => {
  it('the api module exposes the registry GET and the rollout GET/PUT next to the modes', () => {
    expect(API).toContain("apiClient.get('/crossmodel/admin/model-roles/decision-registry')");
    expect(API).toContain("apiClient.get('/crossmodel/admin/model-roles/decision-rollout')");
    expect(API).toContain("apiClient.put('/crossmodel/admin/model-roles/decision-rollout', { enabled })");
    expect(API).toContain('export interface DecisionRegistryRow {');
    expect(API).toContain('tier: 1 | 2 | 3;');
  });

  it('the panel loads from the registry route (tolerated on an older backend), renders ONE sortable table with tier / now / readiness / what-act-does columns, the rollout switch and the ledger', () => {
    expect(SECTION).toContain('decisionGateApi.registry().catch(() => null),');
    expect(SECTION).toContain('{role.key === DECISION_ROLE_KEY && decisionRegistry && (');
    expect(SECTION).toContain('data-testid="decision-gate-registry"');
    expect(SECTION).toContain('data-testid="decision-registry-table"');
    expect(SECTION).toContain('data-testid={`decision-registry-sort-${key}`}');
    expect(SECTION).toContain('data-testid={`decision-registry-${r.purpose}`}');
    expect(SECTION).toContain('data-testid={`decision-registry-detail-${r.purpose}`}');
    expect(SECTION).toContain('data-testid="decision-rollout-switch"');
    expect(SECTION).toContain('data-testid="toggle-decision-rollout"');
    expect(SECTION).toContain('data-testid="decision-rollout-ledger"');
    expect(SECTION).toContain('data-testid="decision-rollout-inconsistencies"');
    expect(SECTION).toContain('const next = await decisionGateApi.setRollout(!sw.enabled);');
  });

  it('2026-09-28 (owner: "add jev to api costs"): every registry row shows its 24 h calls + recorded USD next to the mode (calls24h / costUsd24h / pricedCalls24h from GET decision-registry), tolerating an older backend', () => {
    expect(API).toContain('calls24h?: number;');
    expect(API).toContain('costUsd24h?: number;');
    expect(API).toContain('pricedCalls24h?: number;');
    expect(SECTION).toContain('data-testid={`decision-registry-cost-${r.purpose}`}');
    expect(SECTION).toContain("typeof r.calls24h === 'number' ?");
    expect(SECTION).toContain('<td colSpan={6}');
  });

  it('roster 2026-10-06 B-2: a purpose retired on HUMAN turns shows a "human: retired" badge + a detail line naming its lift env (tolerating an older backend)', () => {
    expect(API).toContain('retiredOnHumanTurns?: { since: string; why: string; sites: string; liftEnv: string; globalLiftEnv: string; active: boolean } | null;');
    expect(SECTION).toContain('{r.retiredOnHumanTurns?.active && <Badge');
    expect(SECTION).toContain('data-testid={`decision-registry-human-retired-${r.purpose}`}');
    expect(SECTION).toContain('>human: retired</Badge>}');
    expect(SECTION).toContain('<span className="font-medium text-foreground">Human turns:</span> not asked since {r.retiredOnHumanTurns.since}');
  });

  it('sortRegistryRows (lib/decision-registry.ts, imported by the section) orders by tier / effective / readiness / label with the purpose id as the tie-break, in both directions', async () => {
    expect(SECTION).toContain("import { sortRegistryRows, TIER_TITLE, type RegistrySortKey } from '@/lib/decision-registry';");
    const { sortRegistryRows } = await import('../../../lib/decision-registry');
    const row = (purpose: string, over: Record<string, unknown> = {}) => ({
      purpose, label: purpose, description: '', decides: '', consumerSite: '', consumer: '', actDoes: '', harnessLabel: '', question: '', questionShape: '', defaultThreshold: 0.85,
      killSwitches: [], ownerLock: null, tier: 1, tierWhy: '', bars: { minLabels: 200, minDays: 3, minActBandN: 20, minActBandPrecision: 0.9, minAuroc: 0.8, minCoverageAt5: 0.6, controlGated: false },
      actCap: null, effective: 'shadow', effectiveSource: 'default', storeMode: null, readiness: null, admission: null, primarySpec: null, parked: false, ...over,
    }) as any;
    const rows = [row('b', { tier: 2, effective: 'act' }), row('a', { tier: 1, readiness: { ready: true, at: null, stale: false } }), row('c', { tier: 1, effective: 'off', readiness: { ready: false, at: null, stale: false } })];
    expect(sortRegistryRows(rows, 'tier', 'asc').map(r => r.purpose)).toEqual(['a', 'c', 'b']);
    expect(sortRegistryRows(rows, 'tier', 'desc').map(r => r.purpose)).toEqual(['b', 'c', 'a']);
    expect(sortRegistryRows(rows, 'effective', 'asc').map(r => r.purpose)).toEqual(['b', 'a', 'c']);
    expect(sortRegistryRows(rows, 'ready', 'asc').map(r => r.purpose)).toEqual(['a', 'c', 'b']);
    expect(sortRegistryRows(rows, 'label', 'asc').map(r => r.purpose)).toEqual(['a', 'b', 'c']);
  });
});

// Seats govern sessions (2026-09-28): the "Apply seats to existing sessions" panel
// (dry-run preview first, then apply), the api function it calls, and the header copy
// that says seats govern EXISTING sessions. The pure summary lines are rendered with
// the source-level idiom + a direct call on the exported helper.
describe('ModelRolesSection — Apply seats to existing sessions (2026-09-28)', () => {
  it('the panel is rendered under the header, previews before applying, and calls modelRolesApi.applySeats(dryRun)', () => {
    expect(SECTION).toContain('<SeatApplyPanel onApplied={() => { void load(); }} />');
    expect(SECTION).toContain('data-testid="seat-apply-preview"');
    expect(SECTION).toContain('data-testid="seat-apply-run"');
    expect(SECTION).toContain('disabled={busy !== null || !preview}'); // apply needs a preview first
    expect(SECTION).toContain('await modelRolesApi.applySeats(true)');
    expect(SECTION).toContain('await modelRolesApi.applySeats(false)');
    expect(SECTION).toContain('Seats govern EXISTING coding sessions too');
    expect(API).toContain("apiClient.post('/crossmodel/admin/model-roles/apply-seats', { dryRun })");
    expect(API).toContain('export interface SeatApplyReport {');
  });

  it('seatApplySummaryLines names the seat, the cleared / kept overrides, the re-stamped / explicit sessions and the preference split', () => {
    const lines = seatApplySummaryLines({
      dryRun: true, seat: 'cql-litellm:api-optimize-glm-5.3', at: '2026-09-28T12:00:00.000Z',
      projects: { cleared: 5, kept: 1, rows: [] },
      sessions: { restamped: 55, explicit: 2, alreadyOnSeat: 3, rows: [] },
      prefs: { explicit: 1, ignored: 4, rows: [] },
      errors: [],
    });
    expect(lines[0]).toBe('Seat: cql-litellm:api-optimize-glm-5.3');
    expect(lines[1]).toContain('5 overrides to clear');
    expect(lines[1]).toContain('1 human / registry pick left alone');
    expect(lines[2]).toContain('55 live sessions to re-stamp');
    expect(lines[2]).toContain('2 explicit picks left alone');
    expect(lines[3]).toContain('4 stored values with no explicit marker');
    expect(lines).toHaveLength(4);
    const applied = seatApplySummaryLines({ dryRun: false, seat: 's', at: 'x', projects: { cleared: 1, kept: 0, rows: [] }, sessions: { restamped: 1, explicit: 0, alreadyOnSeat: 0, rows: [] }, prefs: { explicit: 0, ignored: 0, rows: [] }, errors: ['session abc: boom'] });
    expect(applied[1]).toContain('1 override cleared');
    expect(applied[2]).toContain('1 live session re-stamped');
    expect(applied[4]).toContain('Errors: 1 — session abc: boom');
  });
});
