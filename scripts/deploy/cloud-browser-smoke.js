#!/usr/bin/env node
/**
 * cloud-browser-smoke.js — automated production smoke check for the interactive
 * cloud browser (ticket bbe53f95).
 *
 * WHY THIS EXISTS
 * ---------------
 * The owner's directive (Fleet Supervisor chat c0e22e36, 2026-11-02) asked why
 * the cloud browser was not "properly enabled, tested and working on
 * production". It could read a page but not scroll: every interactive action
 * was refused because CLOUD_BROWSER_CDP was off. Nothing in the deploy path
 * ever proved the capability works, so a broken cloud browser was only ever
 * discovered by the MODEL narrating a refusal to the user — the worst possible
 * detection surface, days late.
 *
 * A separate, real defect was hiding underneath it: scroll/screenshot/liveView
 * called `callMcpTool` directly instead of the driver's own `cdp()` helper, so
 * they lost the MCP wire session and the stateful `/browser/mcp` mount. With
 * CDP on, `open` and `follow-link` worked while `scroll` hung 75 s to the 60 s
 * SSE cap — a shape that ONLY a real open/scroll/follow-link probe can catch.
 * Code review and unit tests both missed it for a day.
 *
 * WHAT IT CHECKS (all read-only, all against the DEPLOYED driver)
 * ---------------------------------------------------------------
 *   (a) OPEN          navigate example.com → ok, non-empty content
 *   (b) SCROLL        scroll down on that live session → ok
 *   (c) FOLLOW-LINK   navigate to a second URL on the same session → ok
 *   (d) SCRAPE URL    a COMPLETE url passes the pre-dispatch preflight and a
 *                     TRUNCATED url is refused with the actionable "it was cut
 *                     off" message — never the raw gateway `400 "url" must be a
 *                     valid uri` that reads to the model as an infra fault
 *
 * On (a)/(c) the page's own marker text is logged as INFO but NEVER gates the
 * verdict: the gateway wraps every page in a preamble that pushes the page's
 * text past the first chunk (measured on prod: a healthy open returned 1565
 * bytes with no marker at all). Gating on a marker would make a healthy
 * gateway read as a regression.
 *
 * SECURITY: this probe runs as ROOT inside the backend container, so it can
 * see MCP_DIGBY_TOKEN and every other secret in that env. NEVER add a
 * `console.log(process.env)` / `JSON.stringify(env)` / error-object dump here —
 * log only the flag value, lengths, timings and errors sliced short.
 *
 * It deliberately exercises the driver through its PUBLIC surface
 * (`execute()`), not `callMcpTool`, because that is what production runs.
 *
 * RUNNING IT
 * ----------
 * Inside the deployed backend container (it needs the driver's dist, the MCP
 * gateway token and the compose env — see scripts/deploy/cloud-browser-smoke.sh,
 * which is the supported entrypoint):
 *
 *   node /tmp/cloud-browser-smoke.js
 *
 * EXIT CODES
 *   0  every check passed
 *   1  ARMED (CLOUD_BROWSER_CDP on) but a check failed — a real regression
 *   2  could not run (driver/dist missing) — never a silent pass
 *   3  NOT ARMED: CLOUD_BROWSER_CDP is off, so the interactive path is
 *      deliberately unavailable. This is a distinct outcome from "broken" so a
 *      caller can report the config state instead of failing a deploy for a
 *      capability nobody switched on.
 *
 * A CLOUD_BROWSER_CDP=off container CANNOT pass (a)/(b)/(c) by design: the
 * driver refuses interactive actions in that config, so the probe names the
 * config cause instead of blaming the gateway. That is the point — the flip is
 * what the check is there to hold.
 */

'use strict';

const CHECKS = [];
function record(name, ok, detail) {
  CHECKS.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // The driver is a CommonJS build under the container's /app. Resolve it the
  // way the app does so a layout change fails loudly (exit 2) rather than
  // silently probing nothing.
  let mod;
  try {
    mod = require('/app/dist/modules/crossmodel/browser-agent/cloud-driver.js');
  } catch (e) {
    console.log(`FAIL driver-import — cannot load the deployed cloud driver: ${e.message}`);
    console.log('VERDICT: COULD-NOT-RUN');
    process.exit(2);
  }
  const { CloudBrowserDriver } = mod;
  if (typeof CloudBrowserDriver !== 'function') {
    console.log('FAIL driver-import — cloud-driver.js exports no CloudBrowserDriver');
    console.log('VERDICT: COULD-NOT-RUN');
    process.exit(2);
  }

  const driver = new CloudBrowserDriver();
  const capability = driver.interactionCapability();
  console.log(`INFO capability_before=${capability} CLOUD_BROWSER_CDP=${JSON.stringify(process.env.CLOUD_BROWSER_CDP || '')}`);

  // ── (a) OPEN ────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  let open;
  try {
    open = await driver.execute({ name: 'navigate', url: 'https://example.com' });
  } catch (e) {
    open = { ok: false, error: e.message };
  }
  const openMs = Date.now() - t0;
  const openLen = String(open.content || '').length;
  // NOTE on the body marker: the gateway WRAPS every page in a long
  // "SECURITY NOTICE … untrusted web source" preamble, so the page's own text
  // sits below it and may not appear in the first chunk. Matching "Example
  // Domain" therefore false-failed against a perfectly healthy open (measured
  // on prod: ok=true len=1565, no marker). The honest discriminator is what the
  // driver itself guarantees — ok + non-empty content (it has an explicit guard
  // against `ok:true` with 0 bytes). Keep the marker as INFO, never a verdict.
  const openHasBodyMarker = /example domain/i.test(String(open.content || ''));
  record(
    'open',
    open.ok === true && openLen > 0,
    `ok=${open.ok} len=${openLen} bodyMarker=${openHasBodyMarker} ${openMs}ms${open.error ? ` err=${String(open.error).slice(0, 160)}` : ''}`,
  );

  const afterOpen = driver.interactionCapability();
  console.log(`INFO capability_after_open=${afterOpen}`);

  // ONE source of truth for "is this box armed?" — `capability`, captured
  // BEFORE any action. Gating the branch on the POST-open value while the
  // verdict gates on the PRE-open one let the two disagree if a CDP attempt
  // demoted `mode` to 'scrape' mid-run (afterOpen would read 'unavailable',
  // not 'disabled-by-config', manufacturing three failures that the verdict
  // then excused by luck). Thread the pre-action reading through both.
  const notArmed = capability === 'disabled-by-config';
  if (notArmed) {
    console.log('INFO CLOUD_BROWSER_CDP is OFF — the interactive path is not armed on this box.');
    record('scroll', false, 'not attempted: interactive cloud browsing is disabled by config (CLOUD_BROWSER_CDP off)');
    record('follow-link', false, 'not attempted: interactive cloud browsing is disabled by config (CLOUD_BROWSER_CDP off)');
  } else {
    // ── (b) SCROLL ────────────────────────────────────────────────────────────
    // THE check that caught the dropped-session defect: on the stateless mount
    // this times out at 60 s instead of answering in well under a second.
    const t1 = Date.now();
    let scroll;
    try {
      scroll = await driver.execute({ name: 'scroll', direction: 'down' });
    } catch (e) {
      scroll = { ok: false, error: e.message };
    }
    record(
      'scroll',
      scroll.ok === true,
      `ok=${scroll.ok} ${Date.now() - t1}ms${scroll.error ? ` err=${String(scroll.error).slice(0, 160)}` : ''}`,
    );

    // ── (c) FOLLOW-LINK ───────────────────────────────────────────────────────
    // A fresh navigate on the SAME session: proves the session is still alive
    // after an interaction (and that page state did not wedge the browser).
    const t2 = Date.now();
    let link;
    try {
      link = await driver.execute({ name: 'navigate', url: 'https://www.iana.org/domains/reserved' });
    } catch (e) {
      link = { ok: false, error: e.message };
    }
    const linkLen = String(link.content || '').length;
    // Same reasoning as `open`: the gateway wraps every page in a preamble that
    // pushes the page's own text past the first chunk (measured: a healthy
    // open of example.com returned 1565 bytes with NO page marker), so a
    // content marker here is a latent false-fail — exactly the "third-party
    // wobble turns CI red" outcome the retry exists to prevent. Assert what the
    // driver guarantees (ok + non-empty) and keep the marker as INFO only.
    const linkHasMarker = /iana/i.test(String(link.content || ''));
    record(
      'follow-link',
      link.ok === true && linkLen > 0,
      `ok=${link.ok} len=${linkLen} marker=${linkHasMarker} ${Date.now() - t2}ms${link.error ? ` err=${String(link.error).slice(0, 160)}` : ''}`,
    );
  }

  // ── (d) SCRAPE URL VALIDATION ─────────────────────────────────────────────
  // The owner's screenshot showed `scrape_as_markdown` failing with a raw
  // gateway body: HTTP 400 `"url" must be a valid uri` on a TRUNCATED
  // facebook.com ad-library URL. Two things must hold:
  //   1. a COMPLETE url of exactly that shape is ACCEPTED (no over-eager
  //      rejection — the module's own review-B1 lesson), and
  //   2. a TRUNCATED url is REFUSED before dispatch with the actionable
  //      "it was cut off" wording (BS-1 D5), not a raw validation 400.
  let preflightFn;
  try {
    ({ preflightUrl: preflightFn } = require('/app/dist/modules/crossmodel/coding/url-preflight.js'));
  } catch (e) {
    console.log(`FAIL scrape-url-validation — cannot load url-preflight: ${e.message}`);
  }
  if (typeof preflightFn === 'function') {
    const complete = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=political_and_issue_ads&country=US';
    const truncated = 'https://www.facebook.com/ads/library/?acti';
    let completeVerdict, truncatedVerdict, truncatedMsg = '';
    try { completeVerdict = preflightFn(complete); } catch { completeVerdict = { ok: false, kind: 'threw' }; }
    try { truncatedVerdict = preflightFn(truncated); } catch { truncatedVerdict = { ok: true, kind: 'threw' }; }
    if (!truncatedVerdict.ok) truncatedMsg = String(truncatedVerdict.reason || '');

    // The refusal must READ as a truncation the model can act on — not as an
    // infrastructure fault, and never the gateway's zod text.
    const refusalIsActionable = /incomplete|cut off/i.test(truncatedMsg) && !/must be a valid uri/i.test(truncatedMsg);
    record(
      'scrape-url-validation',
      completeVerdict.ok === true && truncatedVerdict.ok === false && refusalIsActionable,
      `complete_accepted=${completeVerdict.ok === true} truncated_refused=${truncatedVerdict.ok === false} ` +
        `cause=${truncatedVerdict.kind} actionable=${refusalIsActionable}`,
    );
  } else if (!CHECKS.some((c) => c.name === 'scrape-url-validation')) {
    record('scrape-url-validation', false, 'url-preflight module unavailable in the deployed dist');
  }

  // ── release the session ───────────────────────────────────────────────────
  try { await driver.close(); } catch { /* best-effort: never fail the verdict on teardown */ }

  const failed = CHECKS.filter((c) => !c.ok);
  // Distinguish "deliberately not armed" from "armed and broken", gated on the
  // SAME pre-action reading the branch above used (single source of truth).
  if (failed.length > 0 && notArmed) {
    console.log('VERDICT: NOT-ARMED (CLOUD_BROWSER_CDP off — interactive cloud browsing is disabled on this box)');
    process.exit(3);
  }
  console.log(`VERDICT: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.map((c) => c.name).join(', ')})`}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e && e.message ? e.message : String(e)}`);
  console.log('VERDICT: FAIL (unexpected)');
  process.exit(1);
});