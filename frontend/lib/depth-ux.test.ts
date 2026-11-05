/**
 * Depth UX contract (compute policy, 2026-09-26 — Module C): the pill state
 * machine, the progress-key lookup, chip parsing / derivation, the wire mode
 * a human send carries (signed-in = Auto since roster 2026-10-06 B-3). Pure
 * functions; the server is mocked by the event shapes in lib/depth-ux.ts.
 */

import { describe, expect, it } from 'vitest';
import * as depthUx from './depth-ux';
import {
  ESCALATE_LABEL, PILL_TEXT, PROGRESS_KEY_TEXT, RUNG_ETA_TEXT, SIGNIN_DEEPER_LABEL,
  countSpentEscalations, depthPrefToWire, describeAutoOnlyState, escalationChipFor, isEscalatableMessageId,
  nextRungFor, parseCheckState, parseChips, pillFromMeta, presetFromMode, progressTextFor, quotaBlocksResearch,
  quotaHintFor, reduceCheckState,
} from './depth-ux';

// Audit 2026-09-26: the always-Auto policy's admin fact line (the Advanced lock helpers retired with the radios — roster 2026-10-06 B-3; DEPTH_AUTO_LINE joined them when the Advanced TAB was removed — c99b404a, 2026-10-27).
describe('always-Auto policy helpers', () => {
  it('roster 2026-10-06 B-3 + c99b404a: the Advanced-preset + legacy-picker helpers are gone, and so is the read-only line the removed tab rendered', () => {
    for (const gone of ['DEFAULT_DEPTH_OPTIONS', 'AUTO_ONLY_NOTICE', 'AUTO_ONLY_NOTE', 'defaultDepthLocked', 'depthPresetLock', 'depthOptionDisabled', 'legacyPickerEnabled', 'DEPTH_AUTO_LINE']) {
      expect(depthUx, `${gone} must be gone from lib/depth-ux.ts`).not.toHaveProperty(gone);
    }
  });

  it('describeAutoOnlyState: since + by; the pre-audit row is honest about its unrecorded actor; env default reads as default', () => {
    const base = { enabled: true, since: '2026-09-26T20:35:16.556Z', updatedBy: null, source: 'setting' as const, envVar: 'PATIENCE_AUTO_ONLY' };
    expect(describeAutoOnlyState(base)).toBe('ON since 2026-09-26 20:35Z (actor unrecorded — pre-audit flip)');
    expect(describeAutoOnlyState({ ...base, updatedBy: 'example-user@example.com' })).toBe('ON since 2026-09-26 20:35Z by example-user@example.com');
    expect(describeAutoOnlyState({ ...base, enabled: false, since: '2026-09-27T01:00:00Z', updatedBy: 'a@b.c' })).toBe('OFF since 2026-09-27 01:00Z by a@b.c');
    expect(describeAutoOnlyState({ enabled: false, since: null, updatedBy: null, source: 'env', envVar: 'PATIENCE_AUTO_ONLY' })).toBe('OFF (default, env PATIENCE_AUTO_ONLY)');
    expect(describeAutoOnlyState({ ...base, since: 'junk' })).toBe('ON (default, env PATIENCE_AUTO_ONLY)');
  });
});

const MSG = '11111111-1111-4111-8111-111111111111';

describe('check_state parsing + the pill state machine', () => {
  it('parses the five states, keeps only non-empty changed strings, drops junk', () => {
    expect(parseCheckState({ state: 'checking' })).toEqual({ state: 'checking' });
    expect(parseCheckState({ state: 'updated', changed: ['price 12 → 14', '', 7, '  '], revisionId: 'r1' }))
      .toEqual({ state: 'updated', changed: ['price 12 → 14'], revisionId: 'r1' });
    expect(parseCheckState({ state: 'done' })).toBeNull();
    expect(parseCheckState('checked')).toBeNull();
    expect(parseCheckState(null)).toBeNull();
  });

  it('a valid event replaces the previous state; a malformed one keeps it', () => {
    let s = reduceCheckState(undefined, { state: 'checking' });
    expect(s).toEqual({ state: 'checking' });
    s = reduceCheckState(s, { state: 'nonsense' });
    expect(s).toEqual({ state: 'checking' });
    s = reduceCheckState(s, { state: 'checked' });
    expect(s).toEqual({ state: 'checked' });
    s = reduceCheckState(s, { state: 'interrupted' });
    expect(s?.state).toBe('interrupted');
  });

  it("an 'updated' never regresses to checked/skipped for the same revision (replayed frames)", () => {
    const updated = reduceCheckState(undefined, { state: 'updated', changed: ['x'], revisionId: 'r1' });
    expect(reduceCheckState(updated, { state: 'checked' })).toBe(updated);
    expect(reduceCheckState(updated, { state: 'skipped', revisionId: 'r1' })).toBe(updated);
    // a NEW revision id is a new check — it may report checked
    expect(reduceCheckState(updated, { state: 'checked', revisionId: 'r2' })).toEqual({ state: 'checked', revisionId: 'r2' });
  });

  it('pillFromMeta: a Quick-lane answer (metadata.depth.plan.lane quick) shows the quiet Quick pill; a live / persisted check state still wins', () => {
    expect(pillFromMeta({ depth: { plan: { lane: 'quick' } } })).toEqual({ kind: 'quick' });
    expect(pillFromMeta({ depth: { plan: { lane: 'quick' } }, check: { state: 'checking' } })).toEqual({ kind: 'checking' });
    expect(pillFromMeta({ depth: { plan: {} } })).toBeNull();
  });

  it('pillFromMeta: live state beats persisted, persisted beats legacy, skipped renders nothing', () => {
    expect(pillFromMeta({ check: { state: 'checked' } }, { state: 'checking' })).toEqual({ kind: 'checking' });
    expect(pillFromMeta({ check: { state: 'updated', changed: ['a', 'b'] }, pendingCrossCheck: true })).toEqual({ kind: 'updated', changed: ['a', 'b'] });
    expect(pillFromMeta({ check: { state: 'skipped' }, revision: { previousContent: 'old' } })).toBeNull();
    expect(pillFromMeta({ check: { state: 'interrupted' } })).toEqual({ kind: 'interrupted' });
  });

  it('pillFromMeta: legacy rows — pendingCrossCheck ⇒ checking, revision ⇒ updated, crossCheck outcomes map, nothing ⇒ null', () => {
    expect(pillFromMeta({ pendingCrossCheck: true })).toEqual({ kind: 'checking' });
    expect(pillFromMeta({ revision: { previousContent: 'old' } })).toEqual({ kind: 'updated', changed: [] });
    expect(pillFromMeta({ crossCheck: { outcome: 'unchanged' } })).toEqual({ kind: 'checked' });
    expect(pillFromMeta({ crossCheck: { outcome: 'reconcile_failed' } })).toEqual({ kind: 'interrupted' });
    expect(pillFromMeta({ crossCheck: { outcome: 'timeout' } })).toEqual({ kind: 'interrupted' });
    expect(pillFromMeta({ crossCheck: { outcome: 'no_draft' } })).toBeNull();
    expect(pillFromMeta({})).toBeNull();
    expect(pillFromMeta(undefined)).toBeNull();
  });

  it('pill copy is fixed strings, never prose from the wire', () => {
    expect(PILL_TEXT).toEqual({ checking: 'Checking…', checked: 'Checked ✓', updated: 'Updated', interrupted: 'Check didn’t finish', quick: 'Quick answer' });
  });
});

describe('progress keys — status text from a client lookup table', () => {
  it('the six contract keys each map to fixed text and win over the server message', () => {
    for (const key of ['planning', 'checking_web', 'second_opinion', 'double_checking_stakes', 'deeper_findings_started', 'deeper_findings_ready'] as const) {
      expect(typeof PROGRESS_KEY_TEXT[key]).toBe('string');
      expect(progressTextFor({ key, message: 'THE MODEL WROTE THIS' })).toEqual({ message: PROGRESS_KEY_TEXT[key], key });
    }
  });

  it('an unknown key / no key falls back to the server message (kid lines, harness stages); nothing usable → null', () => {
    expect(progressTextFor({ key: 'made_up', message: 'Sniffing… 🐾' })).toEqual({ message: 'Sniffing… 🐾' });
    expect(progressTextFor({ message: 'Reading a page' })).toEqual({ message: 'Reading a page' });
    expect(progressTextFor({ key: 'made_up' })).toBeNull();
    expect(progressTextFor({})).toBeNull();
    expect(progressTextFor(undefined)).toBeNull();
  });
});

describe('chips — parsing and derivation', () => {
  it('parseChips keeps at most one escalate + one signin_deeper, defaults labels, drops junk', () => {
    const chips = parseChips([
      { kind: 'escalate', escalationOf: MSG, nextRung: 'verify', etaText: 'about 2 minutes' },
      { kind: 'escalate', escalationOf: MSG, nextRung: 'research' },
      { kind: 'escalate', nextRung: 'verify' },
      { kind: 'escalate', escalationOf: MSG, nextRung: 'moon' },
      { kind: 'signin_deeper' },
      { kind: 'signin_deeper', label: 'dupe' },
      { kind: 'other' },
      null,
      'x',
    ]);
    expect(chips).toEqual([
      { kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'verify', etaText: 'about 2 minutes' },
      { kind: 'signin_deeper', label: SIGNIN_DEEPER_LABEL },
    ]);
    expect(parseChips(undefined)).toEqual([]);
    expect(parseChips({})).toEqual([]);
  });

  it('the rung ladder: L1 → verify → research; L2 → research; L3 / council → nothing', () => {
    expect(nextRungFor('single_thinking', 0)).toBe('verify');
    expect(nextRungFor('single_thinking', 1)).toBe('research');
    expect(nextRungFor('single_thinking', 2)).toBeNull();
    expect(nextRungFor('thinking', 0)).toBe('research');
    expect(nextRungFor('thinking', 1)).toBeNull();
    expect(nextRungFor('deep_research', 0)).toBeNull();
    expect(nextRungFor(null, 0)).toBeNull();
    expect(presetFromMode('fast')).toBe('single_thinking');
    expect(presetFromMode('deep_research_all')).toBe('deep_research');
    expect(presetFromMode('auto')).toBeNull();
  });

  it('server chips win for a signed-in latest answer; not under older answers; never while streaming; never when disabled', () => {
    const server = { kind: 'escalate' as const, label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'research' as const, etaText: 'as long as it needs' };
    const base = { chips: [server], messageId: MSG, guest: false, isLast: true, running: false };
    expect(escalationChipFor(base)).toBe(server);
    expect(escalationChipFor({ ...base, isLast: false })).toBeNull();
    expect(escalationChipFor({ ...base, running: true })).toBeNull();
    expect(escalationChipFor({ ...base, enabled: false })).toBeNull();
  });

  it('FAIL-CLOSED: no server chip ⇒ no control — a persisted depth plan, a stored level or an empty row never invents one', () => {
    const base = { messageId: MSG, guest: false, isLast: true, running: false };
    // today's backend / DIG_DEEPER_DISABLED=1 / a legacy row: no chips at all
    expect(escalationChipFor(base)).toBeNull();
    expect(escalationChipFor({ ...base, chips: [] })).toBeNull();
    // a reloaded row whose depth plan says L1 — still nothing without the server's chip
    expect(escalationChipFor({ ...base, depth: { plan: { preset: 'single_thinking' } } })).toBeNull();
    expect(escalationChipFor({ ...base, depth: { plan: { preset: 'single_thinking' } }, spent: 1 })).toBeNull();
    // the row's mode is not an input any more — a stored level cannot reach the ladder
    // @ts-expect-error — `mode` was removed from EscalationChipInput on purpose (review HIGH #1)
    expect(escalationChipFor({ ...base, mode: 'thinking' })).toBeNull();
    // presetFromMode survives as an alias helper only; the id guard is a standalone utility
    expect(isEscalatableMessageId(MSG)).toBe(true);
    expect(isEscalatableMessageId('tmp-1')).toBe(false);
  });

  it('machine-origin rows (supervisor / scheduled / relayed / webhook replies) never carry a control, even with a server chip', () => {
    const server = { kind: 'escalate' as const, label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'verify' as const };
    const base = { chips: [server], messageId: MSG, guest: false, isLast: true, running: false };
    for (const origin of ['schedule', 'hook', 'agent', 'webhook', 'machine']) expect(escalationChipFor({ ...base, origin })).toBeNull();
    expect(escalationChipFor({ ...base, origin: 'user' })).toBe(server);
    expect(escalationChipFor({ ...base, origin: undefined })).toBe(server);
  });

  it('a server chip whose rung was already spent this session yields to the PERSISTED plan\'s next rung — never re-offers a spent rung, never invents a plan', () => {
    const server = { kind: 'escalate' as const, label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'verify' as const };
    const chip = escalationChipFor({ chips: [server], depth: { plan: { preset: 'single_thinking' } }, messageId: MSG, guest: false, spent: 1, isLast: true, running: false });
    expect(chip).toEqual({ kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'research', etaText: RUNG_ETA_TEXT.research });
    // the ladder ends: L2's only rung spent; no persisted plan to walk
    expect(escalationChipFor({ chips: [{ ...server, nextRung: 'research' }], depth: { plan: { preset: 'thinking' } }, messageId: MSG, guest: false, spent: 1, isLast: true, running: false })).toBeNull();
    // audit 2026-09-26 (routing-unify-3): a `council:'background'` marker is not a council that ran — the ladder walks the preset
    expect(escalationChipFor({ chips: [server], depth: { plan: { preset: 'single_thinking', council: 'background' } }, messageId: MSG, guest: false, spent: 1, isLast: true, running: false })).toMatchObject({ kind: 'escalate', nextRung: 'research' });
    expect(escalationChipFor({ chips: [server], messageId: MSG, guest: false, spent: 1, isLast: true, running: false })).toBeNull();
  });

  it('guests get the sign-in affordance ONLY when the server sent it (never an escalate chip, never invented client-side)', () => {
    expect(escalationChipFor({ messageId: 'tmp-9', guest: true, isLast: true, running: false })).toBeNull();
    expect(escalationChipFor({ chips: [{ kind: 'signin_deeper', label: 'Sign in to dig deeper' }], messageId: MSG, guest: true, isLast: true, running: false }))
      .toEqual({ kind: 'signin_deeper', label: 'Sign in to dig deeper' });
    expect(escalationChipFor({ chips: [{ kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'verify' }], messageId: MSG, guest: true, isLast: true, running: false })).toBeNull();
    expect(escalationChipFor({ chips: [{ kind: 'signin_deeper', label: SIGNIN_DEEPER_LABEL }], messageId: MSG, guest: true, isLast: false, running: false })).toBeNull();
  });

  it('countSpentEscalations counts user echoes carrying escalationOf for that message', () => {
    const rows = [
      { role: 'assistant', escalationOf: undefined },
      { role: 'user', escalationOf: MSG },
      { role: 'assistant' },
      { role: 'user', escalationOf: 'other' },
      { role: 'user', escalationOf: MSG },
    ];
    expect(countSpentEscalations(rows, MSG)).toBe(2);
    expect(countSpentEscalations(rows, 'nope')).toBe(0);
  });
});

describe('quota on the research rung', () => {
  it('hint + block only for research, only for authenticated quotas', () => {
    const q = { remaining: 1, limit: 2, allowed: true, authenticated: true };
    expect(quotaHintFor(q, 'research')).toBe('1/2 deeper looks left today');
    expect(quotaHintFor(q, 'verify')).toBeNull();
    expect(quotaHintFor({ ...q, authenticated: false }, 'research')).toBeNull();
    expect(quotaHintFor(null, 'research')).toBeNull();
    expect(quotaBlocksResearch({ ...q, allowed: false, remaining: 0 }, 'research')).toBe(true);
    expect(quotaBlocksResearch({ ...q, allowed: false, remaining: 0 }, 'verify')).toBe(false);
    expect(quotaBlocksResearch(q, 'research')).toBe(false);
    expect(quotaBlocksResearch(undefined, 'research')).toBe(false);
  });
});

describe('depthPrefToWire — what a human send carries', () => {
  it("signed-in: ALWAYS mode='auto' with no modeSource — a preset stored by the retired Advanced radios is ignored (roster 2026-10-06 B-3)", () => {
    for (const pref of ['auto', 'single_thinking', 'thinking', 'deep_research'] as const) {
      expect(depthPrefToWire(pref, { guest: false })).toEqual({ mode: 'auto' });
    }
  });

  it("guests: the POPULATION policy only — forced Ensemble with modeSource 'default'; the stored pref (a picker-era pick or a signed-in Advanced pick on the same browser) is ignored", () => {
    for (const pref of ['auto', 'single_thinking', 'thinking', 'deep_research'] as const) {
      expect(depthPrefToWire(pref, { guest: true })).toEqual({ mode: 'thinking', modeSource: 'default' });
    }
  });

  it('kids: the stored mode as today, no modeSource (the kid pipeline never routes)', () => {
    expect(depthPrefToWire('auto', { guest: false, isKid: true })).toEqual({ mode: 'auto' });
    expect(depthPrefToWire('thinking', { guest: false, isKid: true })).toEqual({ mode: 'thinking' });
  });
});

describe('audit 2026-09-26 (sse-ui-restore-3): the Dig-deeper refusal table', () => {
  it('every server code is known; a rung that is gone strips the chip; quota codes re-read the quota; BUSY / SIGNIN keep the chip', async () => {
    const { ESCALATION_REFUSAL_CODES, escalationRefusalFor } = await import('./depth-ux');
    for (const c of ['SIGNIN_DEEPER', 'ESCALATION_BUSY', 'ESCALATION_EXHAUSTED', 'ESCALATION_QUOTA', 'DEPTH_BUDGET_EXCEEDED', 'DIG_DEEPER_DISABLED', 'ESCALATION_NOT_FOUND', 'ESCALATION_NO_QUESTION', 'ESCALATION_NO_CHAT', 'RATE_LIMIT_DEEP_RESEARCH']) expect(ESCALATION_REFUSAL_CODES.has(c)).toBe(true);
    expect(escalationRefusalFor('ESCALATION_BUSY')).toEqual({ code: 'ESCALATION_BUSY', stripChips: false, refreshQuota: false });
    expect(escalationRefusalFor('SIGNIN_DEEPER')).toMatchObject({ stripChips: false, refreshQuota: false });
    expect(escalationRefusalFor('ESCALATION_EXHAUSTED')).toMatchObject({ stripChips: true, refreshQuota: false });
    expect(escalationRefusalFor('DEPTH_BUDGET_EXCEEDED')).toMatchObject({ stripChips: true });
    expect(escalationRefusalFor('ESCALATION_QUOTA')).toMatchObject({ stripChips: true, refreshQuota: true });
    expect(escalationRefusalFor('RATE_LIMIT_DEEP_RESEARCH')).toMatchObject({ refreshQuota: true });
  });
});