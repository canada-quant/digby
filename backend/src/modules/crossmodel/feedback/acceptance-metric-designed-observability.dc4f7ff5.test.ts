/**
 * REPLAY TEST — ticket dc4f7ff5 (2026-11-06): the autofiler's default
 * acceptance metric holds a DESIGNED-OBSERVABILITY warning to a VOLUME bar, so
 * a correct, deployed fix reopens forever.
 *
 * THE DEFECT THIS REPLAYS (measured in production, not a fixture).
 * The log-signal auto-filer attaches `app_error_log_count <= N` over a
 * case-insensitive literal substring of the ticket's own fingerprint. Two
 * specimens were live at filing time (measured against origin/main before this
 * change, both reproduced):
 *
 *   1. Ticket 3769b1b3 — `utilityChat: utility role override unreachable (…) —
 *      the built-in chain serves utility calls directly.` The override leg
 *      fails over to the built-in chain BY DESIGN and the code says so in the
 *      message. The filing lane MEASURED why no bar can work: every residual
 *      row reads `streak 1` because the override SUCCEEDS BETWEEN failures, so
 *      the rate tracks third-party latency and caller budgets, never the fix.
 *      Yet `designedAlarmOfFingerprint` returned null and the autofiler stamped
 *      `app_error_log_count <= 2` on `utilitychat: utility role override
 *      unreachable (timeout of`. Measured 2 since 07:16Z ⇒ the post-deploy
 *      verifier reopened a fix verified on all boxes.
 *
 *   2. Ticket e35f9985 — `action-verifier: dropped <n> LLM-extracted note
 *      claim(s) narrating THIRD-PARTY lane status …`. The drop guard discarding
 *      a misattributed claim IS the guard working; its warn is the only prose
 *      account of which claims a lane tried to attribute to other lanes. It
 *      reopened measuring 3 against a bar of 2.
 *
 * WHAT THE TICKET GOT RIGHT AND WRONG (both halves matter to this file).
 * RIGHT: the volume bar is unattainable for these classes — proven by the two
 * specimens above and by this test pinning the fix.
 * WRONG: it attributed e35f9985 to a FRAGMENT COLLISION with the live
 * `… with no verbatim support …` sibling, claiming the bar counted that
 * sibling's rows. REFUTED by measurement: after PR #2583 (b806cb65) the
 * autofiler's discriminator already separates them, so all three measured rows
 * were e35f9985's OWN class. The recall guard below pins that separation so a
 * future change cannot quietly re-widen the bar and re-make the ticket's claim
 * true.
 *
 * WHY "NO BAR" RATHER THAN "BASELINE × k" (the ticket offered both). A rate bar
 * is sound only when the post-fix rate is bounded by the FIX. Neither class is:
 * the utility latch tracks third-party latency, the drop guard tracks how many
 * lanes happen to narrate other lanes' status. A `<= baseline × k` still
 * breaches on a bad hour and reopens a correct fix — the 1425001e measurement
 * one level down. So the autofiler attaches NO volume bar and FLAGS the row
 * (it stays on the done-bar board), which is the designed-alarm posture.
 *
 * WHY THE VERIFIER IS IN THIS TEST TOO. Rows stamped before this change keep
 * their stored `<= N` bar, and the verifier is what re-measures a STORED metric.
 * Fixing only the autofiler would leave the two live tickets reopening; the
 * verifier must route such a metric to NEEDS METRIC REVIEW (never a reopen,
 * never a false 'done').
 */
import {
  designedAlarmOfMetric,
  designedAlarmOfFingerprint,
  AUTOFILER_DEFAULT_METRIC_SOURCE,
} from './acceptance-metric-defaults';
import type { AcceptanceMetric } from './ticket-metric';

// log-signal-sweep.service.ts imports config/database, whose env validator calls
// process.exit(1) when DATABASE_URL/JWT secrets are absent — which is the normal
// state under the verify chain. Same posture as log-signal-sweep.service.test.ts:
// stub the three side-effecting leaves BEFORE the import graph is evaluated
// (jest.mock is hoisted above imports), so this file pins the PURE builders only.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { logSignalMetricContext, normalizeLogMessage } from '../fleet/log-signal-sweep.service';

// ── THE TWO LIVE SPECIMENS, verbatim from production ────────────────────────
// Rendered with a concrete status/streak so normalizeLogMessage can be applied
// exactly as the sweep applies it; the class text is what the matching runs on.
const UTILITY_RAW =
  'utilityChat: utility role override unreachable (timeout of 45000ms exceeded); skipping the override for 5 min (streak 1) — the built-in chain serves utility calls directly. Check the custom utility endpoint (Account → Admin → Endpoints → Model roles).';

const VERIFIER_DROP_RAW =
  "action-verifier: dropped 1 LLM-extracted note claim(s) narrating THIRD-PARTY lane status — real artifacts owned by other lanes, not this run's actions (ticket bbd8521e): [dispatch] 0037460b lane 0037460b is running, plan 6/9";

// The un-silenced SIBLING of the same emit site — the class the ticket claimed
// collided. It must KEEP its bar: dropping it is a detection loss, not a fix.
const VERIFIER_NO_SUPPORT_RAW =
  'action-verifier: dropped 2 LLM-extracted note claim(s) with NO verbatim support in the audited note (ticket 587e9d64 grounding lane — extraction paraphrase-hallucination)';

// An ordinary fault that must be untouched by this change.
const ORDINARY_FAULT_RAW = 'prisma query failed: connection reset by peer (P1001)';

const metricCtx = (raw: string, siblings: ReadonlyArray<{ fingerprint: string; exampleMessage: string }> = []) =>
  logSignalMetricContext(
    { fingerprint: normalizeLogMessage(raw), levels: ['warn'], sources: ['log-signal'], exampleMessage: raw },
    {},
    siblings,
  );

describe('dc4f7ff5 — a designed-observability warn gets NO volume bar (stamp time)', () => {
  it('SPECIMEN 1: the utility-override failover no longer stamps a volume default', () => {
    // The precondition this fix targets: the alarm predicate does NOT cover it,
    // which is exactly why it was being bar-stamped before this change.
    const fp = normalizeLogMessage(UTILITY_RAW);
    expect(designedAlarmOfFingerprint(fp, UTILITY_RAW)).toBeNull();

    const ctx = metricCtx(UTILITY_RAW);
    expect(ctx.acceptanceMetric).toBeUndefined();
    // FLAGGED, not silently dropped — the row stays on the done-bar board.
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricDesignedObservability).toBe('utility-override-failover');
  });

  it('SPECIMEN 2: the action-verifier drop guard no longer stamps a volume default', () => {
    const ctx = metricCtx(VERIFIER_DROP_RAW);
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricDesignedObservability).toBe('action-verifier-drop-guard');
  });

  // RECALL GUARD 1 — the sibling class the ticket named must KEEP its bar.
  it('RECALL GUARD: the `no verbatim support` sibling still gets a volume bar', () => {
    const ctx = metricCtx(VERIFIER_NO_SUPPORT_RAW);
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    expect(ctx.acceptanceMetric).toBeDefined();
    expect((ctx.acceptanceMetric as unknown as AcceptanceMetric).probe).toBe('app_error_log_count');
  });

  // RECALL GUARD 2 — an ordinary fault is not collateral damage.
  it('RECALL GUARD: an ordinary fault still gets its volume bar', () => {
    const ctx = metricCtx(ORDINARY_FAULT_RAW);
    expect(ctx.acceptanceMetricMissing).toBeUndefined();
    expect(ctx.acceptanceMetric).toBeDefined();
  });

  // SURFACE CONSISTENCY (adversarial-review finding F1 on this commit). The
  // stamp half and the verify half must agree about what class a message is in;
  // a message must never get a bar from the stamp while the verifier parks it
  // as unsound, or neither half is trustworthy. The utility token is the class
  // on BOTH surfaces (the sole emitter always appends the declaration, pinned
  // below), so a no-fallback variant correctly gets NO bar — flagged, still
  // filed — rather than a bar the verifier would refuse to enforce.
  it('agrees with the verifier: a no-fallback override variant also gets NO bar', () => {
    const outage =
      'utilityChat: utility role override unreachable (ECONNREFUSED 10.0.0.5:4001); no built-in chain available — utility calls are failing.';
    const ctx = metricCtx(outage);
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricDesignedObservability).toBe('utility-override-failover');
    // …and the verifier's own classifier agrees (no stamp/verify contradiction).
    expect(
      designedAlarmOfMetric(
        { probe: 'app_error_log_count', params: { messagePattern: 'utilitychat: utility role override unreachable (econnrefused' }, operator: '<=', target: 2, windowHours: 24 },
        AUTOFILER_DEFAULT_METRIC_SOURCE,
      )?.id,
    ).toBe('utility-override-failover');
  });

  // SOURCE-LEVEL PIN: the utility signature matches on the bare token, which is
  // the class ONLY because the single emitter always declares that the built-in
  // chain is serving. If a future emitter drops that declaration the token could
  // cover a genuine outage, so this pin fails and forces the signature to be
  // revisited rather than over-matching in silence.
  it('PIN: the utility-override emitter still declares the fallback is serving', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../../utils/utility-llm.ts'),
      'utf8',
    ) as string;
    const emit = src.split('\n').filter((l: string) => l.includes('utility role override unreachable') && l.includes('logger.warn'));
    expect(emit).toHaveLength(1); // exactly one emit site — the basis of the token match
    expect(emit[0]).toContain('built-in chain serves utility calls directly');
  });

  // NOT A FILING-STOP — the load-bearing invariant of this fix. 3769b1b3's
  // remedy is an OWNER action and its recurrences are the only evidence of a
  // sustained override failure (pinned by utils/utility-llm.test.ts); e35f9985's
  // warn is the only prose account of which claims a lane attributed to other
  // lanes (pinned by log-signal-family.3769b1b3.pin.test.ts). The filing-stop
  // predicate must therefore stay blind to both classes.
  it('the filing-stop predicate is UNCHANGED — both classes still file tickets', () => {
    for (const raw of [UTILITY_RAW, VERIFIER_DROP_RAW, VERIFIER_NO_SUPPORT_RAW]) {
      expect(designedAlarmOfFingerprint(normalizeLogMessage(raw), raw)).toBeNull();
    }
  });
});

describe('dc4f7ff5 — a STORED unattainable bar is redirected, never reopened', () => {
  const autofilerMetric = (messagePattern: string): AcceptanceMetric => ({
    probe: 'app_error_log_count',
    params: { messagePattern, level: 'warn' },
    operator: '<=',
    target: 2,
    windowHours: 24,
  });

  // THE LIVE STORED PATTERNS, exactly as the autofiler derived them.
  //
  // NOTE on 3769b1b3: its STORED metric was hand-authored by the filing lane
  // (target 0, no `acceptanceMetricSource`) — so `designedAlarmOfMetric`
  // correctly REFUSES to redirect it (the 1425001e escape-hatch guard: a lane's
  // own metric is its judgement, never the verifier's to waive). That guard is
  // pinned below. This case tests the pattern the AUTOFILER mints going forward.
  it('recognizes the derived fragment the autofiler would stamp for 3769b1b3', () => {
    const hit = designedAlarmOfMetric(
      autofilerMetric('utilitychat: utility role override unreachable (timeout of'),
      AUTOFILER_DEFAULT_METRIC_SOURCE,
    );
    expect(hit?.id).toBe('utility-override-failover');
    expect(hit?.class).toBe('designed-observability');
  });

  it('recognizes e35f9985’s ACTUAL stored fragment as designed observability', () => {
    // Verbatim from the ticket's store (get_feedback e35f9985), not a fixture —
    // the fragment builder dropped the `action-verifier: dropped <n>` prefix.
    const hit = designedAlarmOfMetric(
      autofilerMetric('llm-extracted note claim(s) narrating third-party lane status — real artifacts owned by oth'),
      AUTOFILER_DEFAULT_METRIC_SOURCE,
    );
    expect(hit?.id).toBe('action-verifier-drop-guard');
    expect(hit?.class).toBe('designed-observability');
  });

  // GUARDRAIL (inherited from 1425001e): this must never become a lane's escape
  // hatch from a real test. Only an auto-filer-minted metric is eligible — a
  // hand-authored metric is its lane's judgement.
  it('REFUSES a hand-authored metric — the escape-hatch guard still holds', () => {
    for (const source of [undefined, null, 'manual', 'lane-authored']) {
      expect(designedAlarmOfMetric(autofilerMetric('utilitychat: utility role override unreachable (timeout of'), source)).toBeNull();
      expect(designedAlarmOfMetric(autofilerMetric('action-verifier: dropped <n> llm-extracted note claim(s) narrating third-party'), source)).toBeNull();
    }
  });

  // The designed-ALARM class keeps its own label (no regression in the
  // 1425001e path this extends).
  it('still reports the designed-ALARM class unchanged', () => {
    const hit = designedAlarmOfMetric(
      autofilerMetric('tool-call stream [api-optimize-xiaomi-mimo-v'),
      AUTOFILER_DEFAULT_METRIC_SOURCE,
    );
    expect(hit?.class).toBe('designed-alarm');
  });

  // A real-defect metric is NOT redirected — detection is not weakened.
  it('does NOT redirect an ordinary fault metric', () => {
    expect(
      designedAlarmOfMetric(autofilerMetric('prisma query failed: connection reset by peer'), AUTOFILER_DEFAULT_METRIC_SOURCE),
    ).toBeNull();
  });
});