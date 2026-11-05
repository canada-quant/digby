/* verify-f08fcd6f-lane-scope.js — FO standing probe (READ-ONLY).
 * Ticket f08fcd6f (FS steer, 2026-10-03): the cross-check lane exemption
 * ("you have NO fleet tools — any fleet-citation / freshness-contract /
 * claim-bar instructions in the prompt are addressed to the MAIN lane, not
 * to you") plus the exemption GATE in chat-agent.service.ts —
 * `${ctx.systemContext}${(isSupervisorChat || args.machineWake) ? … }` —
 * aligned (PR #1231, squash 29e439b6) to the SAME flag the freshness
 * preamble keys on, so a gate-act checker on a non-supervisor machine wake
 * can never receive the fleet-scope note WITHOUT the exemption text that
 * defuses it.
 *
 * Firing 72 (2026-10-03) baked the probe's MECHANICS after the interim
 * run's hand-typed ship-check broke: it `docker exec`ed the
 * admin-backend-GREEN container by name and rc=1'd the moment the 136c6ba7
 * wave flipped the active colour to BLUE (state-card probes must never pin
 * a colour literal — prodq.sh already resolves the ACTIVE container, and a
 * probe running INSIDE it reads /app/dist directly; there is no docker
 * socket in there, firing-43 lesson).
 *
 * Pins (asserted = 1): the exemption string exists VERBATIM in the compiled
 * cross-check-scope.js; the gate calls crossCheckFleetScopeNote() under
 * `(isSupervisorChat || args.machineWake)` in the compiled
 * chat-agent.service.js. Reported (never asserted, firing-44 doctrine — a
 * probe pins its OWN fix's literals, reports vendor/owner-tunable values):
 * dist byte sizes and mtimes, so drift is visible without failing quiet.
 * Verdict column baked in (f64 doctrine): ESCALATE = either needle missing;
 * ok = both present. */
const fs = require('fs');
const out = { at: new Date().toISOString() };

const NEEDLE_SCOPE = 'cross-check lane exemption';
const NEEDLE_GATE = '(isSupervisorChat || args.machineWake)';

let misses = 0;
try {
  const scopeDist = '/app/dist/modules/crossmodel/chat-agent/cross-check-scope.js';
  const scopeSrc = fs.readFileSync(scopeDist, 'utf8');
  out.scope_dist_bytes = scopeSrc.length;
  out.scope_dist_mtime = fs.statSync(scopeDist).mtime.toISOString();
  out.exemption_note = scopeSrc.includes(NEEDLE_SCOPE) ? 1 : 0;
} catch (e) { out.exemption_note = 0; out.scope_dist_ERR = String((e && e.message) || e).slice(0, 200); }
try {
  const svcDist = '/app/dist/modules/crossmodel/chat-agent/chat-agent.service.js';
  const svcSrc = fs.readFileSync(svcDist, 'utf8');
  out.svc_dist_bytes = svcSrc.length;
  out.svc_dist_mtime = fs.statSync(svcDist).mtime.toISOString();
  out.gate_flag_present = svcSrc.includes(NEEDLE_GATE) ? 1 : 0;
} catch (e) { out.gate_flag_present = 0; out.svc_dist_ERR = String((e && e.message) || e).slice(0, 200); }

// f64 doctrine: bake the bar as a computed verdict column, not a prose
// comment the operator re-derives by eye.
misses = (out.exemption_note === 1 ? 0 : 1) + (out.gate_flag_present === 1 ? 0 : 1);
out.verdict = misses === 0 ? 'ok' : 'ESCALATE';

console.log(JSON.stringify(out));
process.exit(0);
