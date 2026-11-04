/**
 * Decision backends — the pure rules behind the admin panel (2026-09-26):
 * draft ↔ config diffing (only dirty purposes go out; '' clears a primary;
 * a purpose's own challenger list is TRI-STATE — null inherits the defaults,
 * [] is explicitly none, a list is its own), "Promote to primary" (old
 * primary becomes a challenger), the act→shadow warning set, role derivation
 * for report entries without a `role`, the tolerant metrics reader, the
 * view coercion that keeps a short PUT body from unmounting the section, and
 * the stripped-field detector behind the Endpoints dialog's warning. No DOM:
 * the section itself is pinned at source level in
 * app/crossmodel/account/ModelRolesSection.test.tsx.
 */

import { describe, expect, it } from 'vitest';
import type { DecisionBackendPurposeView, DecisionBackendsConfig, DecisionBackendsView, DecisionReadinessEntry } from './api/model-endpoints';
import {
  DECISION_PURPOSE_LABELS, PROMOTE_CONFIRM_COPY, backendRoleFor, coerceBackendsView, dirtyBackendPatch, draftFromConfig, effectiveChallengers, effectivePrimarySpec,
  entryBackendKey, fmtMetric, fmtMs, fmtPercent, isDecisionBackendsView, primaryChangesOnActPurposes, promotePatch, purposeKeys, purposeLabelFor, purposeView,
  readinessEntryMetrics, strippedDecisionFields,
} from './decision-backends';

const CONFIG: DecisionBackendsConfig = {
  purposes: {
    wake_triage: { primary: 'jev', challengers: ['laya:typed-decisions'] },
    sweep_triage: { primary: 'laya:typed-decisions' },
    auto_route: {},
    imessage_send: { challengers: [] },                   // explicitly NONE — overrides the defaults
  },
  defaultChallengers: ['jevk5:JevK5'],
};
const PURPOSES = ['wake_triage', 'sweep_triage', 'auto_route', 'drain_triage'];

/** The backend's view shape: purposes are OBJECTS (platform/decision-gate-backends.ts DecisionBackendPurposeView). */
const pv = (purpose: string, extra: Partial<DecisionBackendPurposeView> = {}): DecisionBackendPurposeView => ({
  purpose, label: purpose.replace('_', ' '), primary: null, challengers: null, effectivePrimary: 'jev', effectiveChallengers: [], chain: ['jev'], mode: 'shadow', ...extra,
});
const VIEW: DecisionBackendsView = {
  config: CONFIG,
  candidates: [{ spec: 'jev', kind: 'systemone', label: 'TypeSafe Jev', calibrated: true, servable: true }],
  purposes: [pv('wake_triage', { mode: 'act' }), pv('sweep_triage'), pv('auto_route'), pv('drain_triage')],
  seatModel: 'jev',
};

describe('purposeKeys / purposeView — the view sends purpose OBJECTS', () => {
  it('reads the keys off object entries, tolerates a bare string[] and a missing list, dedupes and drops blanks', () => {
    expect(purposeKeys(VIEW.purposes)).toEqual(PURPOSES);
    expect(purposeKeys(['a', 'b', 'a', ''])).toEqual(['a', 'b']);
    expect(purposeKeys([pv('a'), 'b', { purpose: '' } as DecisionBackendPurposeView, null as unknown as string])).toEqual(['a', 'b']);
    expect(purposeKeys(undefined)).toEqual([]);
  });

  it('finds the object for a purpose (null for strings / unknown purposes)', () => {
    expect(purposeView(VIEW.purposes, 'wake_triage')?.mode).toBe('act');
    expect(purposeView(['x'], 'x')).toBeNull();
    expect(purposeView(VIEW.purposes, 'nope')).toBeNull();
  });
});

describe('draftFromConfig / effective*', () => {
  it('gives every listed purpose a row (empty primary; own challengers as a list, null when it has none) and keeps the defaults', () => {
    const d = draftFromConfig(CONFIG, PURPOSES);
    expect(Object.keys(d.purposes)).toEqual([...PURPOSES, 'imessage_send']);
    expect(d.purposes.wake_triage).toEqual({ primary: 'jev', challengers: ['laya:typed-decisions'] });
    expect(d.purposes.sweep_triage).toEqual({ primary: 'laya:typed-decisions', challengers: null });
    expect(d.purposes.drain_triage).toEqual({ primary: '', challengers: null });
    // An explicit [] stays [] — it is a different state from "inherit".
    expect(d.purposes.imessage_send).toEqual({ primary: '', challengers: [] });
    expect(d.defaultChallengers).toEqual(['jevk5:JevK5']);
  });

  it('accepts the view\'s object purposes directly, and a missing purposes list', () => {
    expect(Object.keys(draftFromConfig(CONFIG, VIEW.purposes).purposes)).toEqual([...PURPOSES, 'imessage_send']);
    expect(Object.keys(draftFromConfig(CONFIG, undefined).purposes)).toEqual(['wake_triage', 'sweep_triage', 'auto_route', 'imessage_send']);
    expect(Object.keys(draftFromConfig(CONFIG).purposes)).toEqual(['wake_triage', 'sweep_triage', 'auto_route', 'imessage_send']);
  });

  it('tolerates a null config (pre-route backend / empty row)', () => {
    const d = draftFromConfig(null, ['x']);
    expect(d).toEqual({ purposes: { x: { primary: '', challengers: null } }, defaultChallengers: [] });
  });

  it('effective primary = configured primary, else the seat chain head; effective challengers = own list when it HAS one ([] = none), else the defaults', () => {
    expect(effectivePrimarySpec(CONFIG, 'wake_triage', 'jev')).toBe('jev');
    expect(effectivePrimarySpec(CONFIG, 'sweep_triage', 'jev')).toBe('laya:typed-decisions');
    expect(effectivePrimarySpec(CONFIG, 'auto_route', 'deepseek-flash')).toBe('deepseek-flash');
    expect(effectiveChallengers(CONFIG, 'wake_triage')).toEqual(['laya:typed-decisions']);
    expect(effectiveChallengers(CONFIG, 'sweep_triage')).toEqual(['jevk5:JevK5']);
    // The backend's `own ?? defaultChallengers`: an explicit [] means NONE, not "inherit".
    expect(effectiveChallengers(CONFIG, 'imessage_send')).toEqual([]);
    expect(effectiveChallengers(null, 'anything')).toEqual([]);
  });
});

describe('dirtyBackendPatch — only what changed goes out', () => {
  it('returns null when the draft equals the config (order-insensitive challenger lists; null ≡ absent)', () => {
    const d = draftFromConfig(CONFIG, PURPOSES);
    expect(dirtyBackendPatch(CONFIG, d)).toBeNull();
    d.purposes.wake_triage.challengers = ['laya:typed-decisions', 'laya:typed-decisions'];
    expect(dirtyBackendPatch(CONFIG, d)).toBeNull();
  });

  it('sends a changed primary as its own key, a changed challenger list as its own key, never the untouched purposes', () => {
    const d = draftFromConfig(CONFIG, PURPOSES);
    d.purposes.sweep_triage.primary = 'jev';
    d.purposes.auto_route.challengers = ['laya:typed-decisions', 'jevk5:JevK5'];
    expect(dirtyBackendPatch(CONFIG, d)).toEqual({
      purposes: {
        sweep_triage: { primary: 'jev' },
        auto_route: { challengers: ['laya:typed-decisions', 'jevk5:JevK5'] },
      },
    });
  });

  it("clearing a primary sends primary: '' (the backend maps '' → delete); dropping the own list sends challengers: null (inherit the defaults)", () => {
    const d = draftFromConfig(CONFIG, PURPOSES);
    d.purposes.wake_triage.primary = '';
    d.purposes.wake_triage.challengers = null;
    expect(dirtyBackendPatch(CONFIG, d)).toEqual({ purposes: { wake_triage: { primary: '', challengers: null } } });
  });

  it('the tri-state travels exactly: [] (explicitly none) ≠ null (inherit) ≠ a list — each transition is dirty in both directions', () => {
    const d = draftFromConfig(CONFIG, PURPOSES);
    // inherit → none
    d.purposes.auto_route.challengers = [];
    expect(dirtyBackendPatch(CONFIG, d)).toEqual({ purposes: { auto_route: { challengers: [] } } });
    // none → inherit
    const e = draftFromConfig(CONFIG, PURPOSES);
    e.purposes.imessage_send.challengers = null;
    expect(dirtyBackendPatch(CONFIG, e)).toEqual({ purposes: { imessage_send: { challengers: null } } });
    // none → a list
    const f = draftFromConfig(CONFIG, PURPOSES);
    f.purposes.imessage_send.challengers = ['jev'];
    expect(dirtyBackendPatch(CONFIG, f)).toEqual({ purposes: { imessage_send: { challengers: ['jev'] } } });
    // a list → none
    const g = draftFromConfig(CONFIG, PURPOSES);
    g.purposes.wake_triage.challengers = [];
    expect(dirtyBackendPatch(CONFIG, g)).toEqual({ purposes: { wake_triage: { challengers: [] } } });
  });

  it('defaultChallengers travel only when they changed', () => {
    const d = draftFromConfig(CONFIG, PURPOSES);
    d.defaultChallengers = [];
    expect(dirtyBackendPatch(CONFIG, d)).toEqual({ defaultChallengers: [] });
  });
});

describe('promotePatch — Promote to primary', () => {
  it('makes the challenger the primary and moves the old effective primary into the OWN challenger list (old − spec ∪ [old primary])', () => {
    expect(promotePatch(CONFIG, 'wake_triage', 'laya:typed-decisions', 'jev')).toEqual({
      purposes: { wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev'] } },
    });
  });

  it('a purpose on the seat chain (no primary of its own) keeps the seat head as a challenger and materialises the inherited defaults', () => {
    expect(promotePatch(CONFIG, 'auto_route', 'laya:typed-decisions', 'jev')).toEqual({
      purposes: { auto_route: { primary: 'laya:typed-decisions', challengers: ['jevk5:JevK5', 'jev'] } },
    });
  });

  it('a purpose with explicitly NO challengers gains only the old primary (the defaults stay overridden)', () => {
    expect(promotePatch(CONFIG, 'imessage_send', 'laya:typed-decisions', 'jev')).toEqual({
      purposes: { imessage_send: { primary: 'laya:typed-decisions', challengers: ['jev'] } },
    });
  });

  it('promoting the current primary is a no-op (null), as is an empty spec', () => {
    expect(promotePatch(CONFIG, 'wake_triage', 'jev', 'jev')).toBeNull();
    expect(promotePatch(CONFIG, 'auto_route', 'jev', 'jev')).toBeNull();
    expect(promotePatch(CONFIG, 'auto_route', '', 'jev')).toBeNull();
  });
});

describe('primaryChangesOnActPurposes — what the confirm dialog names', () => {
  const modes = { wake_triage: 'act', sweep_triage: 'shadow', auto_route: 'act' };

  it('names an act purpose whose primary the patch changes; ignores shadow purposes, challenger-only edits and unchanged primaries', () => {
    const patch = {
      purposes: {
        wake_triage: { primary: 'laya:typed-decisions' },       // act + changed → named
        sweep_triage: { primary: 'jev' },                       // shadow → not named
        auto_route: { challengers: ['jevk5:JevK5'] },           // act but challengers only → not named
      },
    };
    expect(primaryChangesOnActPurposes(CONFIG, patch, modes)).toEqual(['wake_triage']);
    expect(primaryChangesOnActPurposes(CONFIG, { purposes: { wake_triage: { primary: 'jev' } } }, modes)).toEqual([]);
    expect(primaryChangesOnActPurposes(CONFIG, null, modes)).toEqual([]);
  });

  it('an act purpose on the seat chain that gains an explicit primary is named too (its chain head moves)', () => {
    expect(primaryChangesOnActPurposes(CONFIG, { purposes: { auto_route: { primary: 'laya:typed-decisions' } } }, modes)).toEqual(['auto_route']);
  });

  it('the confirm copy is the plan-mandated sentence', () => {
    expect(PROMOTE_CONFIRM_COPY).toBe('act drops to shadow until the readiness job re-stamps this backend (≤6 h)');
  });
});

describe('isDecisionBackendsView / coerceBackendsView — a short PUT body never unmounts the panel', () => {
  it('accepts the full GET view (object purposes, or a bare string[]), rejects {config}, {ok:true}, null and a view without candidates', () => {
    expect(isDecisionBackendsView(VIEW)).toBe(true);
    expect(isDecisionBackendsView({ ...VIEW, purposes: PURPOSES })).toBe(true);
    expect(isDecisionBackendsView({ config: CONFIG })).toBe(false);
    expect(isDecisionBackendsView({ ok: true })).toBe(false);
    expect(isDecisionBackendsView(null)).toBe(false);
    expect(isDecisionBackendsView(undefined)).toBe(false);
    expect(isDecisionBackendsView({ config: CONFIG, purposes: [] })).toBe(false);
    expect(isDecisionBackendsView({ config: { purposes: 'nope' }, candidates: [], purposes: [] })).toBe(false);
  });

  it('returns a full view unchanged, and otherwise the previous view with only the complete parts of the body merged over it', () => {
    expect(coerceBackendsView(VIEW, VIEW)).toBe(VIEW);
    const cfg2: DecisionBackendsConfig = { purposes: { auto_route: { primary: 'laya:typed-decisions' } } };
    const merged = coerceBackendsView(VIEW, { config: cfg2 });
    expect(merged.config).toBe(cfg2);
    expect(merged.candidates).toBe(VIEW.candidates);
    expect(merged.purposes).toBe(VIEW.purposes);
    expect(merged.seatModel).toBe('jev');
    // {ok:true} / null / a string: nothing usable → exactly the previous view's parts.
    for (const raw of [{ ok: true }, null, undefined, 'saved', { config: 'x', candidates: 'y', purposes: 'z' }]) {
      const out = coerceBackendsView(VIEW, raw);
      expect(out.config).toBe(VIEW.config);
      expect(out.candidates).toBe(VIEW.candidates);
      expect(out.purposes).toBe(VIEW.purposes);
    }
    // Optional scalar fields ride along when present.
    expect(coerceBackendsView(VIEW, { challengerMax: 3 }).challengerMax).toBe(3);
  });
});

describe('strippedDecisionFields — the Endpoints dialog says when an older backend dropped the decision fields', () => {
  const sent = [
    { id: 'typed-decisions', calibrated: true, maxStateChars: 1200 },
    { id: 'multilingual', maxStateChars: 3000 },
    { id: 'plain' },
  ];

  it('names [calibrated] and max state chars when they were sent but not echoed; nothing when they round-tripped', () => {
    expect(strippedDecisionFields(sent, [{ id: 'typed-decisions' }, { id: 'multilingual' }, { id: 'plain' }])).toEqual(['[calibrated]', 'max state chars']);
    expect(strippedDecisionFields(sent, [{ id: 'typed-decisions', calibrated: true, maxStateChars: 1200 }, { id: 'multilingual', maxStateChars: 3000 }, { id: 'plain' }])).toEqual([]);
    expect(strippedDecisionFields(sent, [{ id: 'typed-decisions', calibrated: true }, { id: 'multilingual', maxStateChars: 3000 }])).toEqual(['max state chars']);
    expect(strippedDecisionFields(sent, [{ id: 'typed-decisions', maxStateChars: 1200 }, { id: 'multilingual', maxStateChars: 3000 }])).toEqual(['[calibrated]']);
  });

  it('Laya follow-up (2026-09-26): the [typed decisions] flag (decision "systemone_chat") is reported when sent but not echoed', () => {
    expect(strippedDecisionFields([{ id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 }], [{ id: 'agx-laya', maxStateChars: 3800 }])).toEqual(['[typed decisions]']);
    expect(strippedDecisionFields([{ id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 }], [{ id: 'agx-laya', decision: 'systemone_chat', maxStateChars: 3800 }])).toEqual([]);
    expect(strippedDecisionFields([{ id: 'agx-laya', decision: 'systemone_chat' }], [{ id: 'agx-laya' }])).toEqual(['[typed decisions]']);
  });

  it('a model the backend did not echo at all, an unset flag, or no echoed list say nothing (nothing to compare)', () => {
    expect(strippedDecisionFields(sent, [{ id: 'other' }])).toEqual([]);
    expect(strippedDecisionFields([{ id: 'x', calibrated: false }], [{ id: 'x' }])).toEqual([]);
    expect(strippedDecisionFields(sent, null)).toEqual([]);
    expect(strippedDecisionFields(sent, undefined)).toEqual([]);
  });

  it('bd51693b: a per-model imageTimeoutMs sent but not echoed is named — the 04c8ffd1 defect class (saved, 200, value gone on reload) must warn, not vanish', () => {
    // The exact defect the parent ticket proved expensive: an older backend's
    // zod schema drops the field silently; the guard list had not been extended
    // so no warning fired. A CLAMPED echo is fine (the backend stores what it
    // clamped to) — only a missing/changed value warns.
    expect(strippedDecisionFields([{ id: 'qwen-image', imageTimeoutMs: 600_000 }], [{ id: 'qwen-image' }])).toEqual(['image timeout']);
    expect(strippedDecisionFields([{ id: 'qwen-image', imageTimeoutMs: 600_000 }], [{ id: 'qwen-image', imageTimeoutMs: 600_000 }])).toEqual([]);
    expect(strippedDecisionFields([{ id: 'qwen-image', imageTimeoutMs: 600_000 }], [{ id: 'qwen-image', imageTimeoutMs: 720_000 }])).toEqual(['image timeout']); // clamped ≠ silently kept
    expect(strippedDecisionFields([{ id: 'qwen-image' }], [{ id: 'qwen-image' }])).toEqual([]); // never sent → nothing to say
    expect(strippedDecisionFields([{ id: 'qwen-image', imageTimeoutMs: 0 }], [{ id: 'qwen-image' }])).toEqual([]); // unset/zero is not a value
  });
});

describe('backendRoleFor / entryBackendKey — placing a report entry in its purpose chain', () => {
  const base: Omit<DecisionReadinessEntry, 'backendSpec' | 'role'> = { purpose: 'wake_triage', backend: 'x', ready: false };

  it("uses the report's own role when present", () => {
    expect(backendRoleFor({ ...base, role: 'challenger', backendSpec: 'jev' }, CONFIG, 'jev')).toBe('challenger');
  });

  it('derives primary / challenger / fallback from the stored config + seat head when the report has no role', () => {
    expect(backendRoleFor({ ...base, backendSpec: 'jev' }, CONFIG, 'jev')).toBe('primary');
    expect(backendRoleFor({ ...base, backendSpec: 'laya:typed-decisions' }, CONFIG, 'jev')).toBe('challenger');
    expect(backendRoleFor({ ...base, backendSpec: 'deepseek-flash' }, CONFIG, 'jev')).toBe('fallback');
    // A purpose on the seat chain: the seat head is the primary, the defaults are the challengers.
    expect(backendRoleFor({ purpose: 'auto_route', backend: 'x', backendSpec: 'jev' }, CONFIG, 'jev')).toBe('primary');
    expect(backendRoleFor({ purpose: 'auto_route', backend: 'x', backendSpec: 'jevk5:JevK5' }, CONFIG, 'jev')).toBe('challenger');
    // Explicitly no challengers: the default is NOT a challenger there.
    expect(backendRoleFor({ purpose: 'imessage_send', backend: 'x', backendSpec: 'jevk5:JevK5' }, CONFIG, 'jev')).toBe('fallback');
  });

  it('a spec-less (pre-2026-09-26) entry cannot be placed → null; its key falls back to the label', () => {
    expect(backendRoleFor({ ...base }, CONFIG, 'jev')).toBeNull();
    expect(entryBackendKey({ backend: 'TypeSafe Jev (systemone)' })).toBe('TypeSafe Jev (systemone)');
    expect(entryBackendKey({ backend: 'TypeSafe Jev (systemone)', backendSpec: 'jev' })).toBe('jev');
  });
});

describe('readinessEntryMetrics — tolerant of nested and flat shapes', () => {
  const nested: DecisionReadinessEntry = {
    purpose: 'p', backend: 'b', ready: true,
    metrics: { n: 12, accuracy: 0.9, brier: 0.1, ece: 0.05, auroc: 0.8, coverageAt5: { coverage: 0.6, threshold: 0.2, n: 12, errors: 1 }, actBand: { n: 5, correct: 5, precision: 1, coverage: 0.4, threshold: 0.85 }, calls: 20, failRate: 0.1, p50Ms: 120, p95Ms: 400 },
  };

  it('reads the nested metrics bag and carries the optional latency / fail fields', () => {
    const m = readinessEntryMetrics(nested)!;
    expect(m.n).toBe(12);
    expect(m.p95Ms).toBe(400);
    expect(m.failRate).toBe(0.1);
    expect(m.calls).toBe(20);
  });

  it('reads a flat entry (the REST shorthand) and leaves absent fields undefined', () => {
    const flat = { purpose: 'p', backend: 'b', ready: false, n: 3, accuracy: 0.5, brier: 0.3, ece: 0.2, auroc: 0.5, coverageAt5: { coverage: 0, threshold: null, n: 3, errors: 0 }, actBand: { n: 0, correct: 0, precision: NaN, coverage: 0, threshold: 0.85 } } as unknown as DecisionReadinessEntry;
    const m = readinessEntryMetrics(flat)!;
    expect(m.n).toBe(3);
    expect(m.p50Ms).toBeUndefined();
    expect(m.failRate).toBeUndefined();
  });

  it('returns null for an entry without n (nothing to rank)', () => {
    expect(readinessEntryMetrics({ purpose: 'p', backend: 'b', ready: false })).toBeNull();
    expect(readinessEntryMetrics(null)).toBeNull();
  });

  it('formatters never print NaN', () => {
    expect(fmtMetric(NaN)).toBe('n/a');
    expect(fmtMetric(0.12345)).toBe('0.123');
    expect(fmtPercent(undefined)).toBe('n/a');
    expect(fmtPercent(0.256, 1)).toBe('25.6%');
    expect(fmtMs(123.6)).toBe('124 ms');
    expect(fmtMs(null)).toBe('n/a');
  });
});

describe('purposeLabelFor — compute-policy purposes render with human labels (Module D, 2026-09-26)', () => {
  it('the three compute-policy purposes carry the agreed human labels in the client fallback map', () => {
    expect(DECISION_PURPOSE_LABELS.compute_policy).toBe('Compute policy');
    expect(DECISION_PURPOSE_LABELS.drafts_agree).toBe('Drafts agree');
    expect(DECISION_PURPOSE_LABELS.revision_material).toBe('Revision material');
  });

  it('a backend row without a label (older backend / bare string[] contract) still renders the human label', () => {
    expect(purposeLabelFor('compute_policy')).toBe('Compute policy');
    expect(purposeLabelFor('drafts_agree', null)).toBe('Drafts agree');
    expect(purposeLabelFor('revision_material', '')).toBe('Revision material');
    expect(purposeLabelFor('revision_material', '   ')).toBe('Revision material');
  });

  it("the backend's own label WINS over the client map (the registry is the source of truth)", () => {
    expect(purposeLabelFor('compute_policy', 'Compute policy (D0 depth / stakes / research)')).toBe('Compute policy (D0 depth / stakes / research)');
    expect(purposeLabelFor('wake_triage', 'Supervisor wake triage')).toBe('Supervisor wake triage');
  });

  it('an unknown purpose falls back to its raw key — never blank, never a throw', () => {
    expect(purposeLabelFor('some_future_purpose')).toBe('some_future_purpose');
    expect(purposeLabelFor('some_future_purpose', undefined)).toBe('some_future_purpose');
  });

  it('every purpose the 2026-09-25/26 registry lists has a client label (mixed blue/green waves stay readable)', () => {
    for (const k of ['wake_triage', 'delta_material', 'auto_route', 'imessage_send', 'browser_driver', 'memory_extract', 'self_audit',
      'guard_strike', 'sweep_triage', 'checker_route', 'coding_memory_fold', 'reflection_route', 'claim_evidenced', 'drain_triage',
      'firing_superseded', 'tool_intent', 'wake_effort', 'compute_policy', 'drafts_agree', 'revision_material']) {
      expect(DECISION_PURPOSE_LABELS[k], k).toBeTruthy();
      expect(DECISION_PURPOSE_LABELS[k]).not.toBe(k);
    }
  });

  it('the 2026-09-27 → 2026-10-20 purposes carry the backend registry labels too (task_kind: the task-aware pick)', () => {
    expect(DECISION_PURPOSE_LABELS.supervisor_turn_noop).toBe('Supervisor turn pre-triage (sweep + drain)');
    expect(DECISION_PURPOSE_LABELS.session_topology).toBe('Session topology (spawn / reuse / merge / retire)');
    expect(DECISION_PURPOSE_LABELS.turn_plan).toBe('Turn plan (dynamic roster)');
    expect(DECISION_PURPOSE_LABELS.task_kind).toBe('Task kind');
    expect(purposeLabelFor('task_kind', '')).toBe('Task kind');
  });
});
