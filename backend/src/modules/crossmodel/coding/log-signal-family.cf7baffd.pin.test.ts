/**
 * Replay pin — log-signal family lane cf7baffd (2026-10-30), 3 tickets.
 *
 * All three members share ONE root cause, verified per member against LIVE
 * app_error_logs rows rather than the ticket text: a DESIGNED / EXPECTED
 * outcome is emitted at warn with NO logClass tag, so the log-signal sweep
 * reads it as an internal fault and re-files it every week, forever. The
 * taxonomy is documented in utils/log-level.ts — `logHandled` for an expected
 * outcome (info, never persisted by the warn+ transport), `logExternal` for a
 * degraded dependency (warn + logClass:'external'), `logger.error` for a
 * genuine fault — and log-signal-sweep.service.ts isNonFaultLogRow() honours
 * exactly those two tags. These three sites simply never used it.
 *
 *   c6af45ef — `runModelTurn: … rejected max_tokens <n> (HTTP 400) — retrying
 *              once at <m>`. 21 live rows in 21 minutes, EVERY one
 *              `max_tokens 131072`: the budget ladder repaired the turn each
 *              time and the turn succeeded. The sibling ticket's fix (#2070,
 *              5eac7ef3) cured the RATCHET (the learned cap ratcheting
 *              131072 → … → 17268); this is the remaining half — the repair
 *              was still logged as a fault on every single turn.
 *  585e2688 — `coding-memory: project dream for <uuid> would remove <n>/<n>
 *              lines (>50%) — keeping existing memory`. 24 rows / 13 hours.
 *              The removal guard REFUSING an over-aggressive dream is the
 *              guard working; the refusal is already recorded per-project on
 *              the extraction_outcome row (outcome 'noop').
 *  0ae066fe — `coding agent turn failed: read ECONNRESET`. 22 rows / 10 hours.
 *              A status-less socket reset is external degradation the transient
 *              lane is designed to retry (agent.ts matches ECONNRESET there);
 *              only the exact 'aborted' wording was tagged external.
 *
 * THIS PIN asserts, per member: (a) the emit site carries the correct taxonomy
 * call and the message text is UNCHANGED (so greps and the other audit pins
 * keep matching), (b) the predicate/semantics behind it hold, and (c) the sweep
 * actually treats the resulting row as non-fault.
 */

import fs from 'fs';
import path from 'path';

// The sweep service's import graph reaches config/database → config/env, which
// calls process.exit(1) in a worker with no env (the repo's documented idiom —
// see model-endpoints/endpoint-verifier.test.ts:29). Only its PURE predicate
// (isNonFaultLogRow) is under test, so the DB/Redis/logger chain is stubbed.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));

import { isExternalTransportFailure, isStatuslessTransportAbort } from './turn-failure-classification';
import { isNonFaultLogRow } from '../fleet/log-signal-sweep.service';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

// ── c6af45ef — the output-budget REPAIR is handled, not a fault ──────────────
describe('c6af45ef — a working output-budget repair is logHandled, never a warn', () => {
  const src = read('coding-model.ts');

  it('the emit site uses logHandled and keeps the message text unchanged', () => {
    // The taxonomy call…
    expect(src).toContain('logHandled(`runModelTurn: ${provider.model} (${provider.label}) rejected ${capKey}');
    // …and NOT a raw warn at the same site.
    expect(src).not.toContain('logger.warn(`runModelTurn: ${provider.model} (${provider.label}) rejected ${capKey}');
    // Text preserved verbatim — the ticket fingerprint and the firing-55 audit
    // pin both match on this wording.
    expect(src).toContain('rejected ${capKey} ${sentCap} (HTTP 400) — retrying once at ${fix.cap}');
    expect(src).toContain('the cap the provider named, learned for this model');
  });

  it('the occurrences are still measurable — as a loop_metrics rate, not error rows', () => {
    // A repaired rejection must not simply vanish: the count belongs on a
    // metric row (which the acceptance-metric probe loop_metric_count reads)
    // rather than in app_error_logs where every occurrence files a ticket.
    expect(src).toContain("lane: 'output_budget'");
    expect(src).toContain('PROVIDER_REJECTED');
    expect(src).toContain("outcome: 'repaired'");
  });

  it('the repair still happens — the ladder is untouched (the turn is never sacrificed)', () => {
    expect(src).toContain('budgetOverride = fix.cap;');
    expect(src).toContain('const fix = outputBudgetFixForRejection(sentCap, detail);');
  });
});

// ── 585e2688 — a guard REFUSAL is the guard working ──────────────────────────
describe('585e2688 — the project-dream removal guard refusal is logHandled', () => {
  const src = read('coding-memory.service.ts');

  it('the removal-guard site logs handled and keeps the message text unchanged', () => {
    expect(src).toContain('logHandled(`coding-memory: project dream for ${projectId} would remove ${removed}/${linesBefore} lines');
    expect(src).not.toContain('logger.warn(`coding-memory: project dream for ${projectId} would remove ${removed}/${linesBefore} lines');
    // Fingerprint wording preserved.
    expect(src).toContain('— keeping existing memory`);');
  });

  it('the refusal is still recorded durably per project on the extraction row', () => {
    // logHandled drops the warn row, so the durable, per-project record must
    // survive on the extraction_outcome row — otherwise the refusal becomes
    // invisible and a real memory-wipe trend could not be measured at all.
    expect(src).toContain("return keep('noop', `removal guard: ${removed}/${linesBefore} lines;");
  });

  it('the guard itself is unchanged — the memory is still kept', () => {
    expect(src).toContain('if (projectDreamRemovalRefused(removed, linesBefore)) {');
  });

  it('a TRUE fault in the same dream path stays a warn (anti-wipe is unaffected)', () => {
    // The anti-wipe branch is a different, rarer signal; this lane only
    // re-classified the removal-ratio guard. Assert we did not widen the
    // change into the neighbouring branch.
    expect(src).toContain('logger.warn(`coding-memory: project dream for ${projectId} would empty the memory');
  });
});

// ── 0ae066fe — a status-less socket reset is external, not an internal fault ─
describe('0ae066fe — a status-less socket reset is external transport degradation', () => {
  it('the exact prod message classifies as external', () => {
    // Verbatim from the live rows.
    expect(isExternalTransportFailure({ message: 'read ECONNRESET' })).toBe(true);
    expect(isExternalTransportFailure({ message: 'ECONNRESET' })).toBe(true);
    expect(isExternalTransportFailure({ message: 'socket hang up' })).toBe(true);
    expect(isExternalTransportFailure({ message: 'read ETIMEDOUT' })).toBe(true);
    expect(isExternalTransportFailure({ message: 'connect EPIPE' })).toBe(true);
  });

  it('a status OR a drained body disqualifies it (the conservative axis)', () => {
    // The peer ANSWERED — 429/5xx is a real load/gateway signal, sweep-worthy.
    expect(isExternalTransportFailure({ message: 'read ECONNRESET', status: 502 })).toBe(false);
    expect(isExternalTransportFailure({ message: 'read ECONNRESET', status: 429 })).toBe(false);
    // The peer SPOKE — a diagnosable provider error, also sweep-worthy.
    expect(isExternalTransportFailure({ message: 'read ECONNRESET', bodyText: '{"error":"boom"}' })).toBe(false);
    // Arbitrary wording never matches.
    expect(isExternalTransportFailure({ message: 'Request failed with status code 400' })).toBe(false);
    expect(isExternalTransportFailure({ message: 'InternalError.Algo.DataInspectionFailed' })).toBe(false);
    expect(isExternalTransportFailure({ message: '' })).toBe(false);
    expect(isExternalTransportFailure({})).toBe(false);
  });

  it('the matched set EQUALS the transient lane agent.ts actually retries (PR #2103 S2)', () => {
    // Sweeping a class blind is only justified when the loop is DESIGNED to
    // survive it — i.e. the SAME set agent.ts:4387 retries. A wider predicate
    // would tag sweep-blind a failure nothing retries, which is strictly worse
    // than filing it. Pin the exclusions so a future widening is caught.
    const agentSrc = read('agent.ts');
    const lane = agentSrc.slice(agentSrc.indexOf('const transient = turn.errorStatus === 429'));
    const laneBody = lane.slice(0, 1_400);

    // ECONNREFUSED = "the provider is dead": never retried here, must stay filed.
    expect(isExternalTransportFailure({ message: 'connect ECONNREFUSED' })).toBe(false);
    expect(laneBody).not.toContain('ECONNREFUSED');

    // EAI_AGAIN (DNS) and ESOCKETTIMEDOUT are NOT in the retry lane — the
    // predicate must not claim them either.
    expect(isExternalTransportFailure({ message: 'getaddrinfo EAI_AGAIN' })).toBe(false);
    expect(isExternalTransportFailure({ message: 'ESOCKETTIMEDOUT' })).toBe(false);
    expect(laneBody).not.toContain('EAI_AGAIN');
    expect(laneBody).not.toContain('ESOCKETTIMEDOUT');

    // ...while every code the lane DOES retry is accepted by the predicate.
    for (const m of ['read ECONNRESET', 'read ETIMEDOUT', 'socket hang up', 'write EPIPE', 'ECONNABORTED']) {
      expect(laneBody.toLowerCase()).toContain(m.toLowerCase().split(' ').pop()!.toLowerCase());
      expect(isExternalTransportFailure({ message: m })).toBe(true);
    }
  });

  it('the pre-existing abort predicate is NOT widened (its pin must still hold)', () => {
    // turn-failure-classification.ts exists because 'aborted' had to stay exact;
    // ECONNRESET is deliberately a DIFFERENT predicate, not a broader one.
    expect(isStatuslessTransportAbort({ message: 'read ECONNRESET' })).toBe(false);
    expect(isStatuslessTransportAbort({ message: 'aborted' })).toBe(true);
  });

  it('the emit site tags the widened class external and keeps the row text', () => {
    const src = read('agent.ts');
    expect(src).toContain('const externalTransport = transportAbort || isExternalTransportFailure({ message: err.message, status, bodyText });');
    expect(src).toContain("externalTransport ? { logClass: 'external' } : undefined");
    // The fingerprint text is unchanged — the sweep's messagePattern and the
    // family pin at log-signal-family.4c691bfe.pin.test.ts:179 both match it.
    expect(src).toContain('coding agent turn failed: ${err.message}${status ? ` (HTTP ${status})` : \'\'}');
  });
});

// ── the sweep actually honours the tags these three sites now emit ───────────
describe('the log-signal sweep treats every one of these three as non-fault', () => {
  it('logClass handled (c6af45ef, 585e2688) is non-fault', () => {
    expect(isNonFaultLogRow({ context: { logClass: 'handled' } })).toBe(true);
  });

  it('logClass external (0ae066fe) is non-fault', () => {
    expect(isNonFaultLogRow({ context: { logClass: 'external' } })).toBe(true);
  });

  it('an UNTAGGED row is still a fault — the sweep is not blanketed off', () => {
    // The whole point: only these designed classes are exempt. A bare warn
    // with no context, or a different tag, must still reach the sweep.
    expect(isNonFaultLogRow({ context: null })).toBe(false);
    expect(isNonFaultLogRow({ context: {} })).toBe(false);
    expect(isNonFaultLogRow({ context: { logClass: 'fault' } })).toBe(false);
    expect(isNonFaultLogRow({ context: { source: 'run-model-turn' } })).toBe(false);
    expect(isNonFaultLogRow({})).toBe(false);
  });
});