/**
 * E2E probe — ticket 7a078b4d (2026-09-28): the DEPLOYED surface heals the
 * incident inputs. Runs inside the ACTIVE admin-backend-{color} container via
 * prodq.sh (shipped to /tmp on the box), calling the deployed dist code —
 * the same executeFleetOpsTool the Fleet Supervisor's tool loop calls.
 *
 * Verifies, against the live container at the post-merge sha:
 *   1. the incident input {role:'decision_gate'} heals to the 'decision'
 *      seat with healedFrom echoed (a failed live probe still passes the
 *      heal assertion — attribution, not success, is the fix);
 *   2. the second guess {role:'jev'} heals to decision with candidate 'jev';
 *   3. a genuinely unknown role refuses with the seat keys listed INLINE;
 *   4. the deployed service resolves the synonym (pure check).
 * Exit 0 + E2E_7A078B4D_OK = pass.
 */
const ADMIN = process.env.E2E_ADMIN_USER || '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

(async () => {
  const { executeFleetOpsTool } = require('/app/dist/modules/crossmodel/platform/fleet-ops-tools.js');
  const deps = { platform: null, isAdmin: async (u) => u === ADMIN };
  const ctx = { sessionId: 'e2e-7a078b4d-probe', userId: ADMIN };
  const call = async (args) => {
    try { return { r: JSON.parse(await executeFleetOpsTool(ctx, 'test_model_role', args, deps)) }; }
    catch (e) { return { throw: String((e && e.message) || e) }; }
  };

  const dg = await call({ role: 'decision_gate' });
  const jv = await call({ role: 'jev' });
  const un = await call({ role: 'not-a-seat-e2e' });

  let svc = null;
  try {
    const m = require('/app/dist/modules/crossmodel/model-endpoints/model-roles.service.js');
    svc = { decision_gate: m.normalizeRoleKey('decision_gate'), decision: m.normalizeRoleKey('decision'), jev: m.normalizeRoleKey('jev') };
  } catch (e) { svc = { throw: String((e && e.message) || e) }; }

  const out = {
    heal_decision_gate: dg.throw ? dg : {
      ok: dg.r.ok, role: dg.r.role, healedFrom: dg.r.healedFrom ?? null,
      model: dg.r.model ?? null, latencyMs: dg.r.latencyMs ?? null, error: dg.r.error ?? null,
      msgHead: String(dg.r.message || '').slice(0, 90),
    },
    heal_jev: jv.throw ? jv : {
      ok: jv.r.ok, role: jv.r.role, healedFrom: jv.r.healedFrom ?? null, candidate: jv.r.candidate ?? null,
      model: jv.r.model ?? null, latencyMs: jv.r.latencyMs ?? null, error: jv.r.error ?? null,
    },
    unknown_role: un.throw ? un : {
      ok: un.r.ok, reason: un.r.reason,
      hasInlineKeys: String(un.r.message || '').includes('the seat keys are:'),
      namesDecision: String(un.r.message || '').includes('decision'),
    },
    service_synonyms: svc,
  };
  console.log('E2E_7A078B4D ' + JSON.stringify(out));

  const h = out.heal_decision_gate, j = out.heal_jev, u = out.unknown_role, s = out.service_synonyms;
  const healOk = (x, from, cand) => x && !x.throw && x.role === 'decision' && x.healedFrom === from
    && (cand === undefined || x.candidate === cand) && typeof x.latencyMs === 'number';
  const pass = healOk(h, 'decision_gate') && healOk(j, 'jev', 'jev')
    && u && !u.throw && u.ok === false && u.reason === 'invalid' && u.hasInlineKeys && u.namesDecision
    && s && !s.throw && s.decision_gate === 'decision' && s.decision === 'decision' && s.jev === null;
  console.log(pass ? 'E2E_7A078B4D_OK' : 'E2E_7A078B4D_FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('E2E_7A078B4D_FATAL ' + String((e && e.message) || e)); process.exit(2); });
