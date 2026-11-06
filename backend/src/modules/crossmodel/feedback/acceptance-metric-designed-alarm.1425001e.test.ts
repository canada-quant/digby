/**
 * REPLAY TEST — ticket 1425001e (2026-11-01): the autofiler's default
 * acceptance metric for a LOG-SIGNAL ticket measures warn VOLUME, not the loss
 * signal, so a correct fix REOPENS.
 *
 * THE DEFECT THIS REPLAYS (measured in production, not a fixture).
 * Ticket 8b62e61e — a fix that NAMED the gateway tool-call severance class
 * (`ec:'siv'`, commit 3fab55d1, deploy run 41355086175) and deliberately KEPT
 * the warn as the alarm — was filed by the hourly log-signal sweep carrying the
 * default metric:
 *
 *     app_error_log_count <= 2 over 24h
 *     params: { level:'warn', source:'run-model-turn',
 *               messagePattern:'tool-call stream [api-optimize-xiaomi-mimo-v' }
 *
 * That probe counts warn EMISSION at coding-model.ts:2145 — a file NOT in the
 * fix's diff (agent.ts, tool-arguments.ts, tests). The fix lane measured 28
 * rows/24h and stated the mismatch in its adminNote. Because
 * `certainEarlyVerdict` rules a `<=` breach with measured > target as CERTAIN,
 * the next post-deploy-verifier tick would have REOPENED a correctly-fixed
 * ticket, and the drain would have dispatched a fresh lane onto a non-defect.
 *
 * WHY THE OBVIOUS REMEDY IS ALSO WRONG — this is the part the ticket's own
 * proposal got wrong, and it is pinned here so nobody "simplifies" it back.
 * The proposal was "count the LOSS signal instead" (a small target on a new
 * unrecovered-severance kind). The live telemetry refutes it: the loss
 * population PERSISTS after a naming fix BY DESIGN, because the upstream
 * gateway really does end turns short. Rows at 22:54:40Z — seven minutes after
 * the 22:47:10Z deploy carrying the naming fix — still read
 * `sv:"complete-sibling"`. So a `<=` bar on the loss kind would reopen the same
 * correct fix one level down, and a `>= 1` bar would fail closed whenever the
 * gateway happened to stop severing. FOR A NAMING/CONTAINMENT FIX THERE IS NO
 * SOUND COUNT BAR; the honest autofiler behaviour is to attach none.
 *
 * Also pinned: the ticket proposed `sv != 'already-recovered'` for the new
 * kind. That predicate is INVERTED — the `reemit` arm `continue`s before the
 * turn is dispatched, so any cut reaching the executor is ALREADY unrecovered,
 * and `already-recovered` (budget spent) is precisely the unrecovered case.
 * Requiring `sv != 'already-recovered'` would have excluded the population the
 * ticket cites by name.
 *
 * WHAT IS PINNED HERE:
 *   1. isUnrecoveredSeverance: siv ⇒ counted (every non-cancelled arm,
 *      INCLUDING already-recovered), cancelled ⇒ not, every other class ⇒ not;
 *   2. designedAlarmOfFingerprint matches the GATEWAY-OR-OURS instrument and
 *      nothing else;
 *   3. logSignalMetricContext attaches NO volume bar to a designed alarm but
 *      FLAGS acceptanceMetricMissing (never a silent drop), and still attaches
 *      the normal default to an ordinary signal;
 *   4. designedAlarmOfMetric refuses a HAND-AUTHORED metric (only
 *      'autofiler-default' is eligible) — a lane can never use this to waive
 *      its own acceptance test — and matches the metric's own messagePattern,
 *      never a close-out note's prose;
 *   5. the live 8b62e61e shape end to end: the stored metric IS recognized as
 *      a designed alarm, so the verifier routes it to review rather than
 *      reopening.
 *
 * NOT pinned here (owned elsewhere, deliberately): the verifier's verdict
 * machinery (ticket-postdeploy-verifier.service.test.ts) and the sweep's own
 * filing/drop behaviour (log-signal-sweep.service.test.ts). This file imports
 * pure leaves only — no config/database, no config/env.
 */

import { isUnrecoveredSeverance } from '../coding/tool-arguments';
import {
  designedAlarmOfFingerprint,
  designedAlarmOfMetric,
  AUTOFILER_DEFAULT_METRIC_SOURCE,
} from './acceptance-metric-defaults';

/** The live fingerprint of ticket 8b62e61e (normalized), verbatim in shape. */
const LIVE_FINGERPRINT =
  'tool-call stream [api-optimize-xiaomi-mimo-v<n>-pro]: gateway-or-ours gateway recv=<n> acc=<n> drop=<n> frag=<n> buf=<n>';

/** The metric the sweep actually attached to 8b62e61e. */
const LIVE_METRIC = {
  probe: 'app_error_log_count' as const,
  params: {
    level: 'warn',
    source: 'run-model-turn',
    messagePattern: 'tool-call stream [api-optimize-xiaomi-mimo-v',
    excludeLogClass: 'external',
  },
  operator: '<=' as const,
  target: 2,
  windowHours: 24,
};

describe('isUnrecoveredSeverance (ticket 1425001e)', () => {
  it('counts the severed-in-transit class — EVERY non-cancelled arm, including already-recovered', () => {
    // These are the arms that reach the executor: the re-emit arms `continue`
    // before dispatch, so a row at this seam is already unrecovered.
    expect(isUnrecoveredSeverance('severed-in-transit', 'already-recovered')).toBe(true);
    expect(isUnrecoveredSeverance('severed-in-transit', 'complete-sibling')).toBe(true);
    expect(isUnrecoveredSeverance('severed-in-transit', 'no-transport-signal')).toBe(true);
    expect(isUnrecoveredSeverance('severed-in-transit', 'disabled')).toBe(true);
    expect(isUnrecoveredSeverance('severed-in-transit', undefined)).toBe(true);
    expect(isUnrecoveredSeverance('severed-in-transit', null)).toBe(true);
  });

  it("does NOT count 'cancelled' — a user-pressed Stop is not a loss the harness owes a fix for", () => {
    expect(isUnrecoveredSeverance('severed-in-transit', 'cancelled')).toBe(false);
  });

  it('does NOT count any other loss class (the kind is the severance loss signal, not every reject)', () => {
    for (const cls of ['cut-shape-unclassified', 'malformed', 'not-object'] as const) {
      expect(isUnrecoveredSeverance(cls, 'already-recovered')).toBe(false);
      expect(isUnrecoveredSeverance(cls, 'cancelled')).toBe(false);
      expect(isUnrecoveredSeverance(cls, undefined)).toBe(false);
    }
  });

  it('THE TICKET PROPOSAL WAS INVERTED — `sv != already-recovered` would have excluded the cited population', () => {
    // Guard against a future "simplification" back to the proposed predicate.
    const proposedPredicate = (sv?: string | null) => sv !== 'already-recovered';
    // The most common live arm is already-recovered (budget spent) …
    expect(isUnrecoveredSeverance('severed-in-transit', 'already-recovered')).toBe(true);
    // … which the proposed predicate would have DROPPED.
    expect(proposedPredicate('already-recovered')).toBe(false);
  });
});

describe('designedAlarmOfFingerprint (ticket 1425001e)', () => {
  it('recognizes the GATEWAY-OR-OURS instrument — the live 8b62e61e class', () => {
    const hit = designedAlarmOfFingerprint(LIVE_FINGERPRINT);
    expect(hit?.id).toBe('gateway-or-ours');
    expect(hit?.why).toContain('instrument');
  });

  it('leaves an ordinary log-signal alone (no behaviour change for real faults)', () => {
    expect(designedAlarmOfFingerprint('session-history-sync: push refused permanently')).toBeNull();
    expect(designedAlarmOfFingerprint('invalid signature on every request here')).toBeNull();
    expect(designedAlarmOfFingerprint('')).toBeNull();
    expect(designedAlarmOfFingerprint(null)).toBeNull();
    expect(designedAlarmOfFingerprint(undefined)).toBeNull();
  });

  // ── ADVERSARIAL REVIEW FIX (2026-11-01): THE SHARED HEAD IS NOT THE CLASS ──
  // Three families share the `tool-call stream [<model>]` head in
  // coding-model.ts. Only :2145 is the designed alarm; :2033 (dropped
  // duplicates) and :2062 (folded orphan ⇒ call dispatched truncated) are real
  // defects. Matching the head on the FINGERPRINT would suppress their metric
  // and leave a genuine truncation regression unmeasurable and unreopenable.
  const HEAD = 'tool-call stream [api-optimize-xiaomi-mimo-v<n>-pro]: ';
  it('REGRESSION PIN: a fingerprint from the orphan-fold (data-loss) family is NOT a designed alarm', () => {
    const folded = `${HEAD}folded orphaned continuation slot(s) <n> into their owning call — the nameless continuation was being discarded and its call dispatched truncated`;
    expect(designedAlarmOfFingerprint(folded)).toBeNull();
  });

  it('REGRESSION PIN: a fingerprint from the dropped-duplicates family is NOT a designed alarm', () => {
    const dup = `${HEAD}dropped <n> duplicate fragment(s) — a re-send of a call already assembled in full (same gateway id, tool and payload)`;
    expect(designedAlarmOfFingerprint(dup)).toBeNull();
  });

  it('the SHARED HEAD alone IS accepted on the METRIC surface (that is the 8b62e61e fragment)', () => {
    // A metric's messagePattern is a derived FRAGMENT, and the live one is
    // nothing BUT the head — which is why the head must be honored there.
    const sharedHead = 'tool-call stream [api-optimize-xiaomi-mimo-v';
    expect(designedAlarmOfMetric({ ...(LIVE_METRIC as any), params: { messagePattern: sharedHead } }, AUTOFILER_DEFAULT_METRIC_SOURCE)?.id).toBe('gateway-or-ours');
    // …but a fragment carrying a LATER family's TAIL is not routed away.
    expect(designedAlarmOfMetric({ ...(LIVE_METRIC as any), params: { messagePattern: `${HEAD}folded orphaned continuation` } }, AUTOFILER_DEFAULT_METRIC_SOURCE)).toBeNull();
  });

  // ── ADVERSARIAL REVIEW OF 35cd91a7 (2026-11-06): THE READ CUT IS POSITIONAL ──
  // The `ours` recall guard is what keeps our OWN stream bugs (unread arg bytes,
  // skipped raw lines, parse-fail frames) from being retired as an "instrument".
  // It tested the CULPRIT inside the FINGERPRINT — but the fingerprint is hard-cut
  // at FINGERPRINT_MAX_LEN (120) and the emit template puts the MODEL NAME before
  // the summary. A model id long enough therefore cuts `ours recv=` away while the
  // `gateway-or-ours` TOKEN survives past the cut independently: the culprit guard
  // misses, the token matches, and every `ours` verdict on that seat becomes a
  // permanently-silenced class. Measured before the fix: model length 74/78/82
  // silenced; 24/40/59/71 filed. This is a MISS, not the "safe direction" the
  // first cut's docblock claimed.
  const SUMMARY_OURS =
    'ours recv=812 acc=400 drop=0 frag=0 buf=0 fr=tool_calls sc=1 ur=412 verdict=no_complete_payload — receivedBytes=812 accumulatedBytes=400 droppedBytes=0';

  it('REGRESSION PIN: a long model id that cuts `ours recv=` out of the FINGERPRINT still FILES when the raw row is passed', () => {
    // The exact live emit template, with a model id long enough to push the
    // culprit past the 120-char cut but NOT so long that the token goes too
    // (measured window: 74–84 chars of model id; 90+ cuts the token as well and
    // then the class correctly files for the ordinary reason).
    const longModel = 'api-optimize-some-vendor-dated-preview-alias-v4.1-flash-2027-01-01-preview';
    const raw = `tool-call stream [${longModel}]: GATEWAY-OR-OURS ${SUMMARY_OURS}`;
    const fp = raw.replace(/\d+/g, '<n>').slice(0, 120);

    // PRECONDITION — prove the confound is real, so this test cannot rot into a
    // tautology if the cut or the template moves (learnings: pin the subject).
    expect(fp).toContain('GATEWAY-OR-OURS');   // the token survives the cut …
    expect(fp).not.toContain('ours recv=');    // … and the culprit does not.
    expect(raw).toContain('ours recv=');       // the RAW row still carries it.

    // WITHOUT the raw row the guard cannot see the culprit — a miss, NOT the
    // "safe direction" the first cut's docblock claimed: the token already
    // matched, so a culprit miss means SILENCE. WITH the raw row, the verdict
    // reads `ours` ⇒ a defect of ours ⇒ never an instrument.
    expect(designedAlarmOfFingerprint(fp)?.id).toBe('gateway-or-ours'); // the defect, demonstrated
    expect(designedAlarmOfFingerprint(fp, raw)).toBeNull();             // the fix
  });

  it('the same row on a SHORT model id is unaffected (no behaviour change for the shipped population)', () => {
    const raw = `tool-call stream [api-optimize-alibaba-deepseek-v4.1-flash]: GATEWAY-OR-OURS ${SUMMARY_OURS}`;
    const fp = raw.replace(/\d+/g, '<n>').slice(0, 120);
    expect(fp).toContain('ours recv=');
    expect(designedAlarmOfFingerprint(fp, raw)).toBeNull();
    expect(designedAlarmOfFingerprint(fp)).toBeNull();
  });

  it('a genuine `gateway` verdict on the SAME long model id is still an instrument (the guard did not become a blanket refusal)', () => {
    // Same model id as the regression pin above — its normalized length keeps the
    // TOKEN inside the 120-char cut (that is the whole confound being tested).
    const longModel = 'api-optimize-some-vendor-dated-preview-alias-v4.1-flash-2027-01-01-preview';
    const raw = `tool-call stream [${longModel}]: GATEWAY-OR-OURS gateway recv=0 acc=0 drop=1810 frag=3 buf=0 fr=tool_calls sc=0 verdict=no_complete_payload`;
    const fp = raw.replace(/\d+/g, '<n>').slice(0, 120);
    expect(fp).toContain('GATEWAY-OR-OURS');
    expect(designedAlarmOfFingerprint(fp, raw)?.id).toBe('gateway-or-ours');
  });
});

// NOTE: logSignalMetricContext's own behaviour (no metric + a FLAG for a
// designed alarm, the ordinary default unchanged, the kill switch still first)
// is pinned in fleet/log-signal-sweep.service.test.ts — that module drags
// config/database into its graph, which this pure-leaf file must not import.

describe('designedAlarmOfMetric — the verifier route (ticket 1425001e)', () => {
  it('recognizes the STORED 8b62e61e metric as a designed alarm (this is what stops the reopen)', () => {
    const hit = designedAlarmOfMetric(LIVE_METRIC as any, AUTOFILER_DEFAULT_METRIC_SOURCE);
    expect(hit?.id).toBe('gateway-or-ours');
  });

  it('REFUSES a hand-authored metric — a lane can never route its own acceptance test away', () => {
    // Same probe, but the lane attached it itself: its judgement, not ours to override.
    expect(designedAlarmOfMetric(LIVE_METRIC as any, 'filer')).toBeNull();
    expect(designedAlarmOfMetric(LIVE_METRIC as any, undefined)).toBeNull();
    expect(designedAlarmOfMetric(LIVE_METRIC as any, null)).toBeNull();
  });

  it('only judges the app_error_log_count probe (a loop_metric_count is never a "volume" default)', () => {
    const loopMetric = {
      probe: 'loop_metric_count' as const,
      params: { kind: 'tool_call_unrecovered_severance' },
      operator: '<=' as const,
      target: 2,
      windowHours: 24,
    };
    expect(designedAlarmOfMetric(loopMetric as any, AUTOFILER_DEFAULT_METRIC_SOURCE)).toBeNull();
  });

  it('matches the METRIC PATTERN, not a close-out note — prose cannot waive anything', () => {
    // An ordinary auto-filer metric keeps ruling exactly as before.
    const ordinary = { ...LIVE_METRIC, params: { ...LIVE_METRIC.params, messagePattern: 'session-history-sync: push refused' } };
    expect(designedAlarmOfMetric(ordinary as any, AUTOFILER_DEFAULT_METRIC_SOURCE)).toBeNull();
  });
});

// ── THE WIRING ITSELF — a predicate nobody calls measures nothing ────────────
// Adversarial review, 2026-11-01: `isUnrecoveredSeverance` was only unit-tested
// as a pure function, so the emit block in agent.ts could be DELETED and every
// suite would stay green. Read from SOURCE TEXT (the documented pattern for
// pinning a constant/site without importing the heavy module — agent.ts drags
// config/env, which process.exit(1)s in a keyless jest worker).
describe('the emit site is WIRED (ticket 1425001e)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const agentSrc = fs.readFileSync(path.join(__dirname, '../coding/agent.ts'), 'utf8');

  it('agent.ts actually records the new kind, gated on the loss predicate', () => {
    expect(agentSrc).toContain('TOOL_CALL_UNRECOVERED_SEVERANCE');
    expect(agentSrc).toContain('isUnrecoveredSeverance(lossClass, ctx.severedVerdict)');
    // rate-able: the row must be labelled, or the ok/fail aggregate reads null
    expect(agentSrc).toContain('ok: false');
  });

  it('the emit sits in the dispatch-reject branch, beside the existing finalize row', () => {
    const rejectAt = agentSrc.indexOf('seam: \'dispatch_reject\'');
    const emitAt = agentSrc.indexOf('TOOL_CALL_UNRECOVERED_SEVERANCE');
    expect(rejectAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(rejectAt);
  });
});