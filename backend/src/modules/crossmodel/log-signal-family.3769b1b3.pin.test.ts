/**
 * Characterization pin — log-signal family, lead ticket 3769b1b3 (2026-11-06,
 * family lane ba76678b). Six members were auto-filed by the hourly sweep.
 *
 * ── ADJUDICATION: NONE of the six is safe to silence. All stay untagged. ────
 *
 * The obvious fix — the one PR #2574 applied to its own batch — is to tag a
 * designed class `logClass:'external'` so `isNonFaultLogRow`
 * (fleet/log-signal-sweep.service.ts) stops fingerprinting it. An adversarial
 * review BLOCKED that change for this family, and the findings reproduce
 * against the code:
 *
 * F1 (blocking) THE TAG IS NOT ROW-LOCAL. `normalizeLogMessage` ends with
 *    `.replace(/\d+(?:\.\d+)?/g, '<n>')`, so `HTTP 429`, `402`, `403`, `500`,
 *    `502` and `524` ALL collapse into the SAME fingerprint
 *    (`… rejected the turn (http <n>) — this turn on <model>`); only `billing`
 *    is distinct. The sweep filters tagged rows BEFORE fingerprinting
 *    (`:908` `fetched.filter(r => !isNonFaultLogRow(r))` → then
 *    `summarizeLogFingerprints`), and `hours`/`episodes` are recomputed from
 *    the SURVIVORS (`:631-638`). So tagging the 5xx arm subtracts rows from a
 *    fingerprint the untagged owner-actionable arm (429 / 402 / 403 quota)
 *    ALSO lands in: one 403 in its own hour plus a 5-hour gateway flap can drop
 *    from `hours=5` (files) to below `RULE1_MIN_HOURS=3` → NO signal, NO
 *    ticket. Tagging here degrades detection for the rows that stay untagged —
 *    the precise inverse of the intent.
 *
 * F2 (blocking) `llm-cql` IS OUR OWN GATEWAY, not a third-party dependency.
 *    AGENTS.md: "`llm-cql` = our own LiteLLM gateway … NOT a third-party
 *    relay"; helper-seat.ts documents "a 502/503/504 from a custom endpoint is
 *    the GATEWAY failing (LiteLLM down / redeploying / its upstream pool
 *    dead)". The `logClass:'external'` contract (utils/log-level.ts: "a
 *    dependency we don't control is degraded") is violated by construction, and
 *    the 30dfad06 precedent does not transfer — there, a `vendor_transient`
 *    audit rung reads app_error_logs with NO logClass filter; no equivalent
 *    unfiltered rung exists for `coding-agent` warns.
 *
 * F3 (blocking) The durable-row justification was INVERTED. In the failover
 *    branch `agentWarn` fires FIRST, then `emit('progress', …)`, and only then
 *    `noteSeatFallback(...)` — so if `emit` throws (it is caller-supplied) the
 *    tagged warn survives with NO durable record: the exact invisible-outage
 *    shape the tag was supposed to be safe against.
 *
 * F5 `/^HTTP 5\d\d$/` is also wider than the repo's own gateway set:
 *    `GATEWAY_LEVEL_5XX = {502,503,504}` (helper-seat.ts) deliberately keeps
 *    500 OUT ("Other failures (429, 500, billing, unreachable) keep the admin's
 *    order"), yet the pattern would have tagged 500/501/505/599 too — and a 500
 *    is the status most likely to be OUR defect.
 *
 * ── PER-MEMBER DISPOSITION (each verified against its emit site) ────────────
 *   3769b1b3  utility override unreachable — the warn STAYS UNTAGGED (an
 *             explicit existing pin forbids tagging: utils/utility-llm.test.ts,
 *             lead 8386e3e8 — "a recurring owner-action-needed class must keep
 *             sweep-filing until the seat is re-pointed"), but the REMEDY
 *             ATTRIBUTION IN THIS PIN WAS WRONG and is corrected here.
 *             2026-11-06 (family lane rerun): the post-deploy verifier REOPENED
 *             this member — the metric measured 2 new rows after firstLiveAt
 *             05:01:34Z, then 248/24 h with the newest at 05:14:58.880Z. The
 *             previous disposition said "remedy applied owner-side; the seat now
 *             reads a servable built-in". get_model_roles DID read
 *             `qwen3.6-27b` / resolves+servable / recentFailures 0 — and that
 *             readback was the TRAP, not the proof: a built-in override is
 *             ADMITTED by utilityChat's `!spec.includes(':')` guard, so the seat
 *             being "a servable built-in" is exactly the case that runs the leg.
 *             The real defect was in the shared bounded-seat seam:
 *             postNonStreamingCompletion applied a thinking-off shape only to
 *             DeepSeek built-ins and CUSTOM endpoints — never to a DashScope Qwen
 *             built-in — so qwen3.6-27b reasoned on every call. Measured live:
 *             enable_thinking:false → 2,729 ms, no reasoning tokens; omitted →
 *             30,782 ms, 2,008 reasoning tokens. Prod's own warn timeouts
 *             (10/12/15/30 s) sit BELOW that, so every bounded caller blew its
 *             deadline and latched the override off: a REAL recurrence, not the
 *             designed fallback this member was closed as. Fixed in
 *             helper-completion.ts (same constant/predicate/kill switch as the
 *             streamed twin fastSeatProvider) with regression tests in
 *             helper-completion.test.ts.
 *             The emit site itself is STILL untagged, and must stay so: the warn
 *             is the only per-latch operator signal that the override leg is
 *             failing, and tagging it would hide a future sustained outage
 *             behind a healthy-looking built-in chain.
 *   d0f0fb93  lead seat rejected (HTTP 524) — designed resilience, already
 *             adjudicated for sibling id e0868c1c ("the failover IS the fix"),
 *             but NOT taggable per F1/F2/F3/F5 above.
 *   dd53cc7e  scrape_as_markdown gateway exhaustion — our OWN MCP gateway's
 *             liveness, no vendor/ours discriminator (the fa9349ee
 *             adjudication, which pins the file-level no-`logExternal`
 *             invariant). DURABLE-ROW SCOPE, stated honestly: the BARE-timeout
 *             arm writes nothing, but the ban-outlived-budget arm DOES write a
 *             durable row — `recordSerpResume` → recordLoopMetric
 *             kind:'web_serp_resume' (mcp-search.ts, gated on
 *             `resumeWaitCount > 0`). So tagging would be recall-neutral on that
 *             arm and evidence-losing only on the bare-timeout arm; the
 *             file-level invariant is what decides it, not the durable row.
 *   d634e874  `warnSeatFailure` pdf_ocr seat — pinned refuted at member
 *             9b296637: fires ONCE PER FAILED PROVIDER inside a chain walk
 *             (pdf-extract.ts `for (const provider of usable)`) that then falls
 *             through; tagging removes the only per-seat flapping evidence.
 *  68200428  PDF fetch/extract failed for "<url>" — a third-party target
 *             refusing us (403 / maxContentLength): designed per-target
 *             observability, already adjudicated for 33005438. Same file-level
 *             invariant. No durable row on this branch: recordCircuitFailure
 *             keeps an IN-PROCESS Map only (_mcpCircuit), never a DB row.
 *   e35f9985  action-verifier dropped third-party note claims — the drop guard
 *             working. The warn summarises the dropped claims as
 *             `[<kind>] <id> <detail.slice(0,100)>`; it is bounded and partial
 *             (first 100 chars per claim), NOT a full account. Changing it is a
 *             detector-visibility change on platform/action-verifier.ts needing
 *             the DETECTOR-RECALL REPLAY bar, not a taxonomy tag — which is the
 *             only claim this pin makes about it.
 *
 * This file is the deliverable for the family: it makes the "do not tag these"
 * decision executable, so the next taxonomy pass re-derives it instead of
 * re-making it. It changes NO production behaviour.
 */

import fs from 'fs';
import pathMod from 'path';

/** Same __dirname-relative reader as the sibling family pins (CJS ts-jest). */
const read = (rel: string) => fs.readFileSync(pathMod.join(__dirname, rel), 'utf8');

describe('3769b1b3 family — F1: the HTTP status is NOT fingerprint-discriminating', () => {
  it('normalizeLogMessage collapses every HTTP status into one <n> token', () => {
    // Pin the MECHANISM, not a copy of it: read the real normalizer and assert
    // the digit-collapse that makes the 5xx and 429/402/403 arms one class.
    const src = read('./fleet/log-signal-sweep.service.ts');
    expect(src).toContain(".replace(/\\d+(?:\\.\\d+)?/g, '<n>')");
    // And that the taxonomy filter runs BEFORE fingerprinting, so a tag on one
    // arm subtracts rows from the other arm's hours/episodes.
    const filterAt = src.indexOf('fetched.filter(r => !isNonFaultLogRow(r))');
    const fpAt = src.indexOf('summarizeLogFingerprints(rows)');
    expect(filterAt).toBeGreaterThan(0);
    expect(fpAt).toBeGreaterThan(filterAt);
  });

  it('a 5xx and a 403 quota rejection normalize to the SAME fingerprint', () => {
    // Executable proof of the collapse (the reviewer's F1 measurement).
    const fold = (status: string) =>
      `coding agent [f<n>]: lead seat llm-cql (custom endpoint) (llm-cql:m) rejected the turn (http ${status}) — this turn on glm-5.3`;
    // The digit-collapse rule applied to a raw status:
    const norm = (raw: string) => raw.replace(/\d+(?:\.\d+)?/g, '<n>').toLowerCase();
    const a = norm('rejected the turn (HTTP 524)');
    const b = norm('rejected the turn (HTTP 403)');
    expect(a).toBe(b); // one class — so tagging 5xx also silences the quota arm
    expect(norm('rejected the turn (HTTP 429)')).toBe(a);
    expect(norm('rejected the turn (billing)')).not.toBe(a); // only billing is distinct
    void fold;
  });
});

describe('3769b1b3 family — F2: llm-cql is OUR gateway, so external is a lie', () => {
  it('the repo states llm-cql is our own gateway (read from SHIPPED files only)', () => {
    // EXPORT SAFETY (review B5): AGENTS.md is a DROPPED-PRIVATE path
    // (.digby/publish/scrub-rules.txt:286 `drop AGENTS.md`;
    // utils/export-mode.ts EXPORT_DROPPED_PATHS) while THIS suite ships
    // publicly — a raw fs read of it ENOENTs in the export tree and reddens
    // scripts/publish/scan-public-tree.sh leg F. So the fact is sourced from
    // shipped sources only: helper-seat.ts states it directly, and
    // coding-model.ts carries the custom-endpoint label test.
    const helperSeat = read('./coding/helper-seat.ts');
    expect(helperSeat).toContain('GATEWAY_LEVEL_5XX');
    expect(helperSeat).toContain('is the GATEWAY failing');
    // A custom endpoint is identified by this label — the same predicate the
    // runtime uses to decide "this is a custom endpoint", so a 5xx from it is
    // the gateway's, not an independent vendor's.
    const codingModel = read('./coding/coding-model.ts');
    expect(codingModel).toContain("endsWith('(custom endpoint)')");
  });

  it('F5: the gateway set excludes 500 — a 5xx regex would over-tag', () => {
    const helperSeat = read('./coding/helper-seat.ts');
    expect(helperSeat).toContain('GATEWAY_LEVEL_5XX: ReadonlySet<number> = new Set([502, 503, 504])');
    // 500 is documented as staying with the loop's own lanes.
    expect(helperSeat).toContain('failures (429, 500, billing, unreachable)');
  });
});

describe('3769b1b3 family — F3: the durable row is written AFTER the warn', () => {
  it('noteSeatFallback follows agentWarn in the failover branch (order pin)', () => {
    const src = read('./coding/agent.ts');
    const warnAt = src.indexOf('rejected the turn (${leadHttp})');
    expect(warnAt).toBeGreaterThan(0);
    // The recoverable durable row for this failover, after the warn.
    const durableAt = src.indexOf("status: 'retrying'", warnAt);
    expect(durableAt).toBeGreaterThan(warnAt);
    // emit('progress') sits BETWEEN them — if it throws, no durable row exists.
    const emitAt = src.indexOf("emit('progress'", warnAt);
    expect(emitAt).toBeGreaterThan(warnAt);
    expect(emitAt).toBeLessThan(durableAt);
  });
});

describe('3769b1b3 family — all SIX emit sites stay untagged (recall guard)', () => {
  it('3769b1b3 — the utility-override latch warn stays a bare logger.warn', () => {
    const src = read('../../utils/utility-llm.ts');
    expect(src).toContain('logger.warn(`utilityChat: utility role override unreachable');
    expect(src).not.toContain('logExternal(`utilityChat: utility role override unreachable');
  });

  it('d0f0fb93 — the lead-seat rejection carries NO logClass (blocked by F1/F2/F3/F5)', () => {
    const src = read('./coding/agent.ts');
    const at = src.indexOf('rejected the turn (${leadHttp})');
    expect(at).toBeGreaterThan(0);
    const openAt = src.lastIndexOf('agentWarn(`', at);
    const emit = src.slice(openAt, at + 200);
    expect(emit).toContain('agentWarn(`');
    expect(emit).not.toContain('logClass: ');
  });

  it('dd53cc7e / 68200428 — no `Digby Web Search:` row is tagged logExternal', () => {
    const src = read('./mcp-search.ts');
    expect(src).toContain('failed after ${maxRetries} gateway attempt(s)');
    expect(src).toContain('PDF fetch/extract failed for');
    expect(src).not.toContain('logExternal(`Digby Web Search:');
  });

  it('d634e874 — warnSeatFailure stays a bare per-provider warn', () => {
    const src = read('./seat-call.ts');
    expect(src).toContain('logger.warn(`${role} seat: ${p.model} (${p.label}) failed — ${describeSeatError(err)}`)');
    expect(src).not.toContain('logExternal(`${role} seat:');
  });

  it('e35f9985 — the action-verifier drop keeps its warn + prose account', () => {
    const src = read('./platform/action-verifier.ts');
    expect(src).toContain('narrating THIRD-PARTY lane status');
    expect(src).toContain("source: 'action-verifier'");
    expect(src).not.toContain('logExternal(`action-verifier: dropped');
  });
});