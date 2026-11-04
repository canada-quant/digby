/**
 * Depth UX wiring (compute policy, 2026-09-26 — Module C; docs/DEPTH_UX_SOTA_2026-09-26.md §4–5):
 *
 *   1. plain-session bridge — `check_state` normalizes + folds into `complete`;
 *      the followups event's chips ride `complete`; `progress` with a contract
 *      key renders the client lookup text (never the model's line); buildPlainMeta
 *      carries check / depth / chips; the revision poll keeps polling on a
 *      'checking' state.
 *   2. buildPlainStreamUrl — `escalationOf` rides the GET query, the >1500-char
 *      register body, and the register-failure fallback (and is absent otherwise).
 *   3. SOURCE pins (the p1-shell-pins idiom: stable identifiers, never line
 *      numbers) — no depth control anywhere in the web app (roster 2026-10-06
 *      B-3: the picker, its legacy switch and the Advanced presets are gone),
 *      the plain config sends depthPrefToWire (signed-in Auto), the ⋯ menu /
 *      settings carry only the kids' note, the chip → escalationOf send path,
 *      and Account → Advanced's one read-only line.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

vi.mock('@/lib/api-client', () => ({ ensureFreshAuthCookie: vi.fn(async () => {}) }));

import { buildPlainDepthConfig, buildPlainMeta, buildPlainStreamUrl, makeLegacyNormalizer, plainRevisionPending, pollPlainRevision } from './plain-session';
import { PROGRESS_KEY_TEXT } from '@/lib/depth-ux';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MSG = '11111111-1111-4111-8111-111111111111';

function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `region anchor ${JSON.stringify(to)} missing after ${JSON.stringify(from)}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

// ── 1. the bridge ────────────────────────────────────────────────────────────

describe('makeLegacyNormalizer — check_state / chips / keyed progress', () => {
  it('check_state normalizes to the coding vocabulary and the LAST state folds into complete', () => {
    const n = makeLegacyNormalizer();
    expect(n('check_state', { state: 'checking' })).toEqual({ type: 'check_state', data: { state: 'checking' } });
    expect(n('check_state', { state: 'bogus' })).toBeNull();
    expect(n('check_state', { state: 'checked', revisionId: 'r1' })).toEqual({ type: 'check_state', data: { state: 'checked', revisionId: 'r1' } });
    n('chunk', { content: 'answer' });
    const c = n('complete', {});
    expect(c?.data.check).toEqual({ state: 'checked', revisionId: 'r1' });
    expect(c?.data.finalText).toBe('answer');
  });

  it("the wire's own complete.check wins over the streamed state", () => {
    const n = makeLegacyNormalizer();
    n('check_state', { state: 'checking' });
    const c = n('complete', { check: { state: 'updated', changed: ['x'] } });
    expect(c?.data.check).toEqual({ state: 'updated', changed: ['x'] });
  });

  it('the followups event is still dropped, but its chips ride complete (a later frame replaces an earlier one)', () => {
    const n = makeLegacyNormalizer();
    expect(n('followups', { questions: ['a?'], chips: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }] })).toBeNull();
    expect(n('followups', { questions: ['a?'], chips: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'research', etaText: 'as long as it needs' }] })).toBeNull();
    const c = n('complete', { followUps: ['a?'] });
    expect(c?.data.chips).toEqual([{ kind: 'escalate', label: 'Dig deeper', escalationOf: MSG, nextRung: 'research', etaText: 'as long as it needs' }]);
    // complete's own chips win
    const n2 = makeLegacyNormalizer();
    n2('followups', { chips: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }] });
    expect(n2('complete', { chips: [{ kind: 'signin_deeper' }] })?.data.chips).toEqual([{ kind: 'signin_deeper' }]);
  });

  it('a progress frame with a contract key renders the lookup text, not the model line; unknown keys keep the message', () => {
    const n = makeLegacyNormalizer();
    expect(n('progress', { key: 'second_opinion', message: 'Digby is dispatching the Double Checker…' }))
      .toEqual({ type: 'progress', data: { message: PROGRESS_KEY_TEXT.second_opinion, key: 'second_opinion' } });
    expect(n('progress', { key: 'unknown_key', message: 'kept' })).toEqual({ type: 'progress', data: { message: 'kept' } });
    expect(n('progress', { key: 'unknown_key' })).toBeNull();
  });
});

describe('buildPlainMeta — check / depth / chips ride the just-answered meta', () => {
  it('carries the three fields and no longer bails out when only they are present', () => {
    const meta = buildPlainMeta({
      check: { state: 'checking' },
      depth: { plan: { preset: 'single_thinking', spawnChecker: true, source: 'gate_act' }, decisionId: 'd1' },
      chips: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }],
    }, 'auto');
    expect(meta?.check).toEqual({ state: 'checking' });
    expect(meta?.depth).toEqual({ plan: { preset: 'single_thinking', spawnChecker: true, source: 'gate_act' }, decisionId: 'd1' });
    expect(meta?.chips?.[0]).toMatchObject({ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' });
    expect(buildPlainMeta({ pendingCrossCheck: true }, 'thinking')?.pendingCrossCheck).toBe(true);
    expect(buildPlainMeta({}, 'thinking')).toBeUndefined();
    expect(buildPlainMeta({ check: { state: 'nope' } }, 'thinking')).toBeUndefined();
  });
});

describe('pollPlainRevision — keeps polling while metadata.check is checking', () => {
  const fetchSeq = (rows: any[][]) => {
    let i = 0;
    return async () => ({ messages: rows[Math.min(i++, rows.length - 1)] });
  };
  const noSleep = { intervalMs: 1, maxMs: 10_000, sleep: async () => {} };

  it('resolves once the check settles (checked / updated), even with pendingCrossCheck absent', async () => {
    const fetchChat = fetchSeq([
      [{ id: MSG, role: 'assistant', content: 'v1', metadata: { check: { state: 'checking' } } }],
      [{ id: MSG, role: 'assistant', content: 'v1', metadata: { check: { state: 'checking' } } }],
      [{ id: MSG, role: 'assistant', content: 'v2', metadata: { check: { state: 'updated', changed: ['x'] }, revision: { at: 't', reason: 'r', previousContent: 'v1' } } }],
    ]);
    const row = await pollPlainRevision('c1', MSG, fetchChat, noSleep);
    expect(row?.content).toBe('v2');
    expect(row?.plainMeta?.check).toEqual({ state: 'updated', changed: ['x'] });
  });

  it('plainRevisionPending: legacy flag OR checking; settled rows and legacy rows read false', () => {
    expect(plainRevisionPending({ pendingCrossCheck: true })).toBe(true);
    expect(plainRevisionPending({ check: { state: 'checking' } })).toBe(true);
    expect(plainRevisionPending({ check: { state: 'checked' } })).toBe(false);
    expect(plainRevisionPending({ pendingCrossCheck: false, check: { state: 'skipped' } })).toBe(false);
    expect(plainRevisionPending({})).toBe(false);
    expect(plainRevisionPending(undefined)).toBe(false);
  });
});

// ── 2. buildPlainStreamUrl — escalationOf on every wire shape ────────────────

describe('buildPlainStreamUrl — escalationOf', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ streamToken: '22222222-2222-4222-8222-222222222222' }) }));
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => { (globalThis as any).fetch = originalFetch; });
  const query = (url: string) => new URL(url).searchParams;

  it('short message: the GET query carries escalationOf and omits it when undefined', async () => {
    const url = await buildPlainStreamUrl({ chatId: 'c1', message: 'Dig deeper', mode: 'auto', webSearch: true, escalationOf: MSG });
    expect(query(url).get('escalationOf')).toBe(MSG);
    expect(query(url).get('mode')).toBe('auto');
    const none = await buildPlainStreamUrl({ chatId: 'c1', message: 'hi', mode: 'auto', webSearch: true });
    expect(query(none).has('escalationOf')).toBe(false);
  });

  it('long message: the register body carries escalationOf; the register-failure fallback GET still carries it', async () => {
    const long = 'x'.repeat(1600);
    await buildPlainStreamUrl({ chatId: 'c1', message: long, mode: 'auto', webSearch: true, escalationOf: MSG });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ chatId: 'c1', mode: 'auto', escalationOf: MSG });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any);
    const url = await buildPlainStreamUrl({ chatId: 'c1', message: long, mode: 'auto', webSearch: true, escalationOf: MSG });
    expect(query(url).get('escalationOf')).toBe(MSG);
  });
});

// ── 3. source pins ───────────────────────────────────────────────────────────

const PAGE = read('./page.tsx');
const VIEW = read('./components/CodeSessionView.tsx');
const CHROME = read('./components/FloatingChrome.tsx');
const SETTINGS = read('./components/SessionSettingsSection.tsx');
const ACCOUNT = read('./account/page.tsx');

describe('page.tsx — no depth control for anyone (roster 2026-10-06 B-3: Digby picks depth and models per message)', () => {
  it('no PatiencePicker mount, no level / Auto handler, no legacy switch, no mode-origin tracking survives', () => {
    for (const gone of ['<PatiencePicker', 'PatiencePicker', 'LEGACY_PICKER', 'legacyPickerEnabled', 'setPatienceLevel', 'selectAutoMode', 'onPatienceChange', 'onSelectAuto', 'autoSelected', 'composerRightActions', 'REVERSE_MAP', 'PATIENCE_MAP', 'modeOrigin']) {
      expect(PAGE, `${gone} must be gone from page.tsx`).not.toContain(gone);
    }
    expect(VIEW).not.toContain('composerRightActions');
  });

  it('the plain config is wired to buildPlainDepthConfig with the normalized pref (kids) + the guest flag (one smoke pin; the output is tested below)', () => {
    const cfg = region(PAGE, 'plain={(codeChatPlain || chatlessActive) ? {', 'onDepthRunSettled:');
    expect(cfg).toContain('...buildPlainDepthConfig({');
    expect(cfg).toContain('pref: normalizePatienceMode(mode),');
    expect(cfg).toContain('deepResearchQuota,');
    // the page no longer derives the wire itself
    expect(PAGE).not.toContain('depthPrefToWire(');
  });

  it('buildPlainDepthConfig: signed-in = Auto with no modeSource whatever the stored pref; guests forced Ensemble; kids untouched; quota + Dig-deeper switch ride through', () => {
    const quota = { remaining: 1, limit: 2, allowed: true, authenticated: true };
    const base = { guest: false, isKid: false, deepResearchQuota: quota };
    for (const pref of ['auto', 'single_thinking', 'thinking', 'deep_research'] as const) {
      expect(buildPlainDepthConfig({ ...base, pref })).toEqual({ mode: 'auto', deepResearchQuota: quota, digDeeperEnabled: true });
    }
    // guests: the forced Ensemble with 'default', whatever the pref
    expect(buildPlainDepthConfig({ ...base, guest: true, pref: 'auto' })).toMatchObject({ mode: 'thinking', modeSource: 'default' });
    expect(buildPlainDepthConfig({ ...base, guest: true, pref: 'deep_research' })).toMatchObject({ mode: 'thinking', modeSource: 'default' });
    // kids: the pref untouched, no modeSource, Dig deeper off
    expect(buildPlainDepthConfig({ ...base, isKid: true, pref: 'thinking', deepResearchQuota: null })).toEqual({ mode: 'thinking', deepResearchQuota: null, digDeeperEnabled: false });
  });

  it('opening a chat never restores its stored level into the send mode', () => {
    expect(PAGE).not.toContain('setMode(plainChatMode)');
    expect(PAGE).not.toContain('update({ patienceMode: plainChatMode })');
  });

  it('the composer-side deep-research quota badge (keyed on the retired Advanced default) is gone — the quota rides the research chip', () => {
    expect(PAGE).not.toContain("mode === 'deep_research' && deepResearchQuota");
    expect(VIEW).toContain('quota={plain.deepResearchQuota}');
  });

  it('Digby Frontier: no composer depth picker and no amber quota badge row (owner 2026-10-06)', () => {
    expect(PAGE).not.toContain("{user && !isKid && mode === 'deep_research' && deepResearchQuota && deepResearchQuota.authenticated && (");
    expect(PAGE).not.toContain('<EffortControl');
    expect(PAGE).not.toContain('composerLeftActions');
    expect(PAGE).not.toContain('EFFORT_PICKER');
  });
});

describe('FloatingChrome / SessionSettingsSection — no Patience levels; kids keep their note', () => {
  it('the side panel Settings tab renders the kids note; the header (no menus since 2026-10-06) carries none; no level radios / handlers anywhere', () => {
    expect(SETTINGS).toContain('{showPatience && isKid && (');
    expect(SETTINGS).toContain('Kids mode');
    expect(CHROME).not.toContain('Kids mode');
    for (const src of [CHROME, SETTINGS]) {
      for (const gone of ['onPatienceChange', 'onSelectAuto', 'patienceLevel', 'patienceLabels', 'autoSelected', 'Auto ✨']) expect(src).not.toContain(gone);
    }
  });
});

describe('CodeSessionView — pill + chip → escalationOf send', () => {
  it('the bubble renders ONE DepthPill (the two legacy text lines are gone) and a DepthChipRow under the latest answer', () => {
    expect(VIEW).not.toContain('data-crosscheck-pending');
    expect(VIEW).not.toContain('data-crosscheck-revised');
    // Digby Frontier (2026-10-06): the settled bubble's ONE pill is the
    // transparency pill (state from pillFromMeta; expands to "How Digby
    // answered"); DepthPill stays only on the live block.
    expect(VIEW).toContain('const pill = pillFromMeta(m.plainMeta);');
    expect(VIEW).toContain('<TransparencyPill');
    expect(VIEW).toContain('state={pill}');
    expect(VIEW).toContain('previousContent={m.plainMeta?.revision?.previousContent}');
    expect((VIEW.match(/<DepthPill/g) || []).length).toBe(1); // the live block
    expect(VIEW).toContain('const chip = digDeeperChipFor(m);');
    expect(VIEW).toContain('chip={chip}');
    expect(VIEW).toContain('quota={plain.deepResearchQuota}');
    // Audit 2026-09-26 (guest-persistence-4): the tap reports the ux_beacon before the send.
    expect(VIEW).toContain("onEscalate={(escalationOf) => { sendUxBeacon({ event: 'tap', target: 'escalate', chatId: chatId ?? undefined, messageId: escalationOf, mode: plain.mode }); void send(undefined, undefined, { escalationOf }); }}");
    expect(VIEW).toContain("onSigninDeeper={() => { sendUxBeacon({ event: 'tap', target: 'signin_deeper'");
  });

  it('digDeeperChipFor is fail-closed on the SERVER chips (+ the persisted plan for spent rungs, the origin stamp), latest answer only, never for kids — never the row\'s mode', () => {
    const fn = region(VIEW, 'const digDeeperChipFor = (m: CodingMessage) => {', 'const grouped = groupMachineRows(');
    expect(fn).toContain('chips: m.plainMeta?.chips,');
    expect(fn).toContain('depth: m.plainMeta?.depth,');
    expect(fn).toContain('origin: m.plainMeta?.origin,');
    expect(fn).not.toContain('mode: m.plainMeta?.mode');
    expect(fn).toContain('spent: countSpentEscalations(');
    expect(fn).toContain('isLast: m.id === lastAssistantId,');
    expect(fn).toContain('enabled: !isKid && plain.digDeeperEnabled !== false && (!!chatId || !!plain.guest),');
  });

  it('send() forwards escalationOf to buildPlainStreamUrl with the fixed label as the message; guests / chatless / streaming never escalate', () => {
    const fn = region(VIEW, 'const send = async (overrideMessage?: string, overrideImages?: ChatImage[], opts?: { bypassRunningGuard?: boolean; displayContent?: string; escalationOf?: string; overrideUploads?: AttachmentInfo[] })', 'const sendRoute = routeSend({');
    expect(fn).toContain('const escalationOf = opts?.escalationOf && chatId && !plainCfg.guest ? opts.escalationOf : undefined;');
    expect(fn).toContain('if (opts?.escalationOf && !escalationOf) return;');
    expect(fn).toContain('if (escalationOf && live.running) {');
    expect(fn).toContain('const effectiveMessage = escalationOf ? ESCALATE_LABEL : message ||');
    expect(fn).toContain('? { escalationOf }');
    expect(fn).toContain('userLocation: plainCfg.guest ? plainCfg.guestLocation?.() : undefined, escalationOf, ghost: plainCfg.ghost });');
  });

  it('a Dig-deeper tap never clears the composer draft or discards a voice recording (review MEDIUM #2)', () => {
    const fn = region(VIEW, 'const send = async (overrideMessage?: string, overrideImages?: ChatImage[], opts?: { bypassRunningGuard?: boolean; displayContent?: string; escalationOf?: string; overrideUploads?: AttachmentInfo[] })', 'const sendRoute = routeSend({');
    expect(fn).toContain('if (!overrideMessage && !escalationOf) { composerRef.current?.clear(); voice.discardRecording(); }');
    expect(fn).not.toContain('if (!overrideMessage) { composerRef.current?.clear();');
  });

  it("live.check is cleared at every run start / full-replay attach / complete reset — the previous turn's pill never renders under the next answer (review MEDIUM #3)", () => {
    // the four attach-to-active-run spreads (queued drain / initial load / resync / the GUEST resync —
    // stream drops 2026-10-20: it reattaches a guest through /session/:id/stream and clears the same state)
    expect((VIEW.match(/setLive\(l => \(\{ \.\.\.l, parts: \[\], workers: undefined, running: true, check: undefined, steps: undefined \}\)\)/g) || []).length).toBe(4);
    // the three complete resets (attach-complete reload + the plain complete swap + the audit 2026-10-06 T8-7
    // partsOmitted REST reload)
    // (Digby Frontier: the thinking steps clear with the status.)
    expect((VIEW.match(/setLive\(l => \(\{ \.\.\.l, parts: \[\], workers: undefined, verify: undefined, status: undefined, steps: undefined, check: undefined \}\)\)/g) || []).length).toBe(3);
    // a full replay (no resume cursor) clears it; a cursor resume keeps the same run's state
    expect((VIEW.match(/\.\.\.\(resumed \? \{\} : \{ parts: \[\], check: undefined \}\)/g) || []).length).toBe(2);
    // no run-start spread survives without the clear
    expect(VIEW).not.toMatch(/setLive\(l => \(\{ \.\.\.l, parts: \[\], workers: undefined, running: true \}\)\)/);
    expect(VIEW).not.toMatch(/setLive\(l => \(\{ \.\.\.l, parts: \[\], workers: undefined, verify: undefined, status: undefined \}\)\)/);
    // a fresh send() replaces the live object wholesale (no stale check either)
    expect(VIEW).toContain('setLive({ parts: [], pendingApproval: null, running: true });');
  });

  it('the stream handler folds check_state into live state and the completion poll honours a checking state', () => {
    expect(VIEW).toContain("else if (type === 'check_state') queueLive(l => ({ ...l, check: reduceCheckState(l.check, data) }));");
    expect(VIEW).toContain('(data.pendingCrossCheck === true || plainRevisionPending(meta))');
  });
});

describe('Account → Advanced retirement (roster 2026-10-06 B-3 → ticket c99b404a, 2026-10-27)', () => {
  it('the Advanced tab is GONE from the account page — no TABS entry, no render branch, no child-filter entry, no import (pinned in advanced-tab-retirement.c99b404a.test.ts)', () => {
    expect(ACCOUNT).not.toContain("{ id: 'advanced',     label: 'Advanced',      icon: SlidersHorizontal },");
    expect(ACCOUNT).not.toContain("{activeTab === 'advanced'     && !user?.isChild && <AdvancedTab />}");
    // The child filter no longer names the retired tab id.
    expect(ACCOUNT).not.toContain("'advanced'");
    expect(ACCOUNT).not.toContain('AdvancedTab');
    // The Feeds tab retired 2026-10-20 (ticket 43c24152) — the child filter
    // still excludes kids / integrations / developer for child accounts.
    expect(ACCOUNT).toContain("!['kids', 'integrations', 'developer'].includes(t.id)");
  });
});

describe('audit 2026-09-26 (sse-ui-restore-3): a refused tap never hides the live chip', () => {
  it('with `depth` on the complete payload (the server sends it now) the ladder re-derives the next rung after a spent echo; without it the chip vanished', async () => {
    const { escalationChipFor, ESCALATE_LABEL, RUNG_ETA_TEXT } = await import('@/lib/depth-ux');
    const meta = buildPlainMeta({ chips: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }], depth: { plan: { preset: 'single_thinking', spawnChecker: false, source: 'preset' } } }, 'auto');
    expect(escalationChipFor({ chips: meta?.chips, depth: meta?.depth, messageId: MSG, guest: false, spent: 1, isLast: true, running: false }))
      .toEqual({ kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'research', etaText: RUNG_ETA_TEXT.research });
    const legacy = buildPlainMeta({ chips: [{ kind: 'escalate', escalationOf: MSG, nextRung: 'verify' }] }, 'auto');
    expect(escalationChipFor({ chips: legacy?.chips, depth: legacy?.depth, messageId: MSG, guest: false, spent: 1, isLast: true, running: false })).toBeNull();
  });
});