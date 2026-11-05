#!/usr/bin/env node
/**
 * did-it-work-probe.js — read-only post-switch error-rate probe (T2d, ticket
 * b4824553, owner answer oq_e4f4e382 2026-10-16: "Yes to both — autonomous
 * deploy loop").
 *
 * Runs INSIDE the just-deployed backend container (docker cp + docker exec,
 * the scripts/framework-audit/prodq.sh pattern) so it sees the production DB
 * with the backend's own Prisma client and .env. Read-only: two COUNTs on
 * app_error_logs, nothing else.
 *
 * The question it answers: after the nginx switch, is the NEW version
 * generating errors at a rate meaningfully above its OWN pre-switch baseline?
 * Absolute-zero-error would be the ideal bar, but the prod boxes emit a
 * standing error hum (e.g. the revoked-key 401 class, ~56 rows/4h) that would
 * false-fail every deploy — so the gate compares LIKE WITH LIKE:
 *
 *   window  = errors since SWITCH_EPOCH_UTC (the deploy's flip moment)
 *             normalized per-minute over WINDOW_MINUTES
 *   baseline= errors in the WINDOW_MINUTES immediately BEFORE the switch,
 *             same normalization, SAME DB, SAME shape (old version live)
 *
 * A healthy deploy's window ≈ baseline (traffic just moved color). A broken
 * deploy (502 storm, crash loop, auth regression) spikes window far above
 * baseline — and the comparison is immune to the standing hum because both
 * sides carry it. Guard rails:
 *   - DID_IT_WORK_ERROR_ROWS_FLOOR (default 10): below it the rate difference
 *     is statistically meaningless → PASS (a deploy producing 5 errors in 6
 *     minutes vs a 1-error baseline is noise, not a verdict).
 *   - DID_IT_WORK_ERROR_FACTOR (default 5): window rate must exceed baseline
 *     rate × FACTOR to fail.
 *   - baseline scaled to the SAME length as the window, so a short window is
 *     compared fairly.
 *
 * Exit codes (pinned by scripts/deploy/did-it-work-gate.test.sh):
 *   0  ok      — error rate not meaningfully above baseline
 *   1  FAIL    — error rate above baseline × factor (over the row floor)
 *   3  unknown — probe could not answer (DB unreachable, bad args). The GATE
 *               treats unknown as probe-unreliable: retried, then the deploy
 *               is allowed through WITHOUT a green error-rate verdict ONLY
 *               after the retry budget is exhausted (never rolls back prod on
 *               a measurement we could not take; the rest of the gate —
 *               health + authenticated smoke — stays hard-fatal).
 *
 * Usage (stdin contract of did-it-work-gate.sh):
 *   SWITCH_EPOCH_UTC=2026-10-17T00:00:00Z WINDOW_MINUTES=6 \
 *     node did-it-work-probe.js
 * Env: SWITCH_EPOCH_UTC (required, ISO 8601 UTC), WINDOW_MINUTES (default 6,
 * 1–30), DID_IT_WORK_ERROR_FACTOR (default 5), DID_IT_WORK_ERROR_ROWS_FLOOR
 * (default 10).
 */

'use strict';

const DEFAULT_FACTOR = 5;
const DEFAULT_FLOOR = 10;
const DEFAULT_WINDOW_MINUTES = 6;

function dieUnknown(msg) {
  console.log(`DID_IT_WORK_PROBE=unknown ${msg}`);
  process.exit(3);
}

const epochRaw = process.env.SWITCH_EPOCH_UTC;
if (!epochRaw) dieUnknown('SWITCH_EPOCH_UTC is not set');

const epoch = Date.parse(epochRaw);
if (Number.isNaN(epoch)) dieUnknown(`SWITCH_EPOCH_UTC is not an ISO instant: ${epochRaw}`);

let windowMinutes = Number(process.env.WINDOW_MINUTES || DEFAULT_WINDOW_MINUTES);
if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 30) {
  windowMinutes = DEFAULT_WINDOW_MINUTES;
}
const factor = Number(process.env.DID_IT_WORK_ERROR_FACTOR || DEFAULT_FACTOR);
const floor = Number(process.env.DID_IT_WORK_ERROR_ROWS_FLOOR || DEFAULT_FLOOR);

const now = Date.now();
if (epoch > now) dieUnknown(`SWITCH_EPOCH_UTC is in the future: ${epochRaw}`);
const windowMs = now - epoch;
if (windowMs < 1000) dieUnknown('window is empty (switch epoch is now)');

const windowStart = new Date(epoch);
// Baseline: the same-length interval immediately BEFORE the switch. If the
// deploy has been live longer than the nominal window (slow host-1 phase on a
// later host, or the gate's own retries), windowMinutes only sizes the
// baseline look-back — the window is [epoch, now] either way, and both rates
// are per-minute so they stay comparable.
const baselineEnd = new Date(epoch);
const baselineStart = new Date(epoch - windowMinutes * 60 * 1000);

let prisma;
try {
  // /app/dist/config/database is the backend's own client (prodq.sh pattern):
  // same DATABASE_URL, same credentials, generated client already in the image.
  // DID_IT_WORK_DB_MODULE is a TEST SEAM only (did-it-work-gate.test.sh points
  // it at a fixture module); in prod it is never set.
  prisma = require(process.env.DID_IT_WORK_DB_MODULE || '/app/dist/config/database').default; // eslint-disable-line global-require
} catch (e) {
  dieUnknown(`Prisma client unavailable: ${e.message}`);
}

(async () => {
  let windowCount;
  let baselineCount;
  try {
    [windowCount, baselineCount] = await Promise.all([
      prisma.appErrorLog.count({ where: { level: 'error', createdAt: { gte: windowStart } } }),
      prisma.appErrorLog.count({
        where: { level: 'error', createdAt: { gte: baselineStart, lt: baselineEnd } },
      }),
    ]);
  } catch (e) {
    dieUnknown(`app_error_logs count failed: ${e.message}`);
    return; // unreachable — keeps linters honest
  }

  // Per-minute rates, window measured by its true length.
  const windowMinutesActual = windowMs / 60000;
  const windowRate = windowCount / windowMinutesActual;
  const baselineRate = baselineCount / windowMinutes;

  console.log(
    `DID_IT_WORK_PROBE=ok window_rows=${windowCount} window_minutes=${windowMinutesActual.toFixed(2)} ` +
      `baseline_rows=${baselineCount} baseline_minutes=${windowMinutes} ` +
      `window_rate=${windowRate.toFixed(3)}/min baseline_rate=${baselineRate.toFixed(3)}/min ` +
      `factor=${factor} floor=${floor}`
  );

  // Meaningfulness floor: without enough rows the comparison is noise.
  if (windowCount < floor) {
    console.log(`VERDICT=ok (window_rows ${windowCount} < floor ${floor} — not enough signal to fail)`);
    process.exit(0);
  }

  if (windowRate > baselineRate * factor) {
    console.log(
      `VERDICT=fail (window ${windowRate.toFixed(3)}/min > baseline ${baselineRate.toFixed(3)}/min × ${factor})`
    );
    process.exit(1);
  }

  console.log(`VERDICT=ok (window ${windowRate.toFixed(3)}/min ≤ baseline ${baselineRate.toFixed(3)}/min × ${factor})`);
  process.exit(0);
})().catch((e) => {
  dieUnknown(`unhandled: ${e.message}`);
});
