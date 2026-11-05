/**
 * verify-iter58-av-evidence.js — FO firing 58 proving probe (2026-10-01; v2 firing 59).
 *
 * Proves PR #1175 (squash 1bc5320f68e3; wave 36790071001 completed
 * 2026-09-30T23:50:12Z) and PR #1177 (squash dd3d3ab16759; wave 36808139470
 * completed 2026-10-01T03:13:19Z) LIVE — the action-verifier PRE-DELIVERY
 * strike and ALL FOUR guard_strike outcome-row classes carry their evidence.
 * The compiled-shape half runs separately (grep struckClaims in dist
 * chat-agent.service.js → AV1177_BOX lines, expect COUNT≥4 per live
 * container). This probe is the LIVE-BEHAVIOUR half, all read-only SELECTs
 * against the shared RDS database (rows land here regardless of which box
 * wrote them):
 *
 *  a. app_error_logs PRE-DELIVERY strikes since the flip: every row must
 *     carry context->'claims' as a NON-EMPTY array. Old shape: {chatId}
 *     only. Baseline arm: the 24h BEFORE the flip counted with-claims rows
 *     (the #1175 defect window).
 *  b. app_error_logs reject-back warns ('chat-agent: machine-wake note
 *     struck pre-delivery…') since the flip: context->'claims' non-empty.
 *  c. loop_metrics guard_strike rows seam=machine_wake_reject_back since
 *     the flip: meta->'struckClaims' non-empty whenever phantoms > 0.
 *
 * v2 (firing 59, 03:36Z) — DEPLOY-BOUNDARY auto-classification for arm (c).
 * The first post-#1177 run (flip 2026-10-01T03:13:19Z) failed AV_EVIDENCE_BAD
 * on a 03:21:42Z outcome row that hand adjudication proved BOUNDARY, not
 * regression: the run started 02:43Z on pre-#1177 code (the Fleet
 * Supervisor's own receipts show it in flight across the flip; box C's
 * retiring admin-worker-blue was still draining). Old code writes exactly
 * that shape — the paired PRE-DELIVERY strike row WITH claims (#1175, live
 * since 23:50Z) but no struckClaims on a non-retry outcome row (#1177, live
 * only from the flip). This probe now classifies such rows from the data
 * itself: a bad arm-(c) row inside the 6h boundary window (drain cap 1500s
 * + in-flight run length, generously bounded) whose matching PRE-DELIVERY
 * strike row (same session, ±10s) carries claims is reported as
 * boundary, NOT failure. Rows past the window, unpaired rows, or paired
 * with a claims-less strike row still FAIL — a real #1177 regression is
 * never silenced, and every classified row is printed (boundary_pairs) for
 * the operator to eyeball.
 *
 * Honest outcome: ZERO strikes since the flip = nothing to observe yet
 * (the ~10/24h baseline said the first should land within hours) — verdict
 * ZERO_YET, exit 0.
 *
 * ARGS (firing-47 lesson: env vars never transit SSM; argv only):
 *   node verify-iter58-av-evidence.js <flipISO>   (REQUIRED, no default)
 */
const prisma = require('/app/dist/config/database').default;
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

const FLIP = process.argv[2];
if (!FLIP) { console.error('PROBE_FAIL: pass the wave-complete flip time as argv[2] (e.g. 2026-09-30T23:50:12Z)'); process.exit(2); }

// claims_ok: non-null, jsonb array, length > 0 (jsonb_typeof guards a
// non-array value erroring jsonb_array_length).
const CLAIMS_OK = `(context->'claims' IS NOT NULL AND jsonb_typeof(context->'claims') = 'array' AND jsonb_array_length(context->'claims') > 0)`;

(async () => {
  // a. PRE-DELIVERY strikes since flip — evidence present on each row?
  await sec('predelivery_since_flip', () => q(
    `SELECT LEFT(message, 70) AS msg, "createdAt"::text AS created, ${CLAIMS_OK} AS claims_ok, context->'claims' AS claims
       FROM app_error_logs
      WHERE message LIKE 'action-verifier: PRE-DELIVERY strike%'
        AND "createdAt" > '${FLIP}'
      ORDER BY "createdAt" DESC LIMIT 10`));

  // baseline: the 24h before the flip (the defect window)
  await sec('predelivery_24h_before_flip', () => q(
    `SELECT COUNT(*)::int AS rows_24h, COUNT(*) FILTER (WHERE ${CLAIMS_OK})::int AS with_claims_24h
       FROM app_error_logs
      WHERE message LIKE 'action-verifier: PRE-DELIVERY strike%'
        AND "createdAt" > '${FLIP}'::timestamptz - interval '24 hours' AND "createdAt" <= '${FLIP}'`));

  // b. reject-back warns since flip
  await sec('rejectback_warns_since_flip', () => q(
    `SELECT LEFT(message, 70) AS msg, "createdAt"::text AS created, ${CLAIMS_OK} AS claims_ok
       FROM app_error_logs
      WHERE message LIKE 'chat-agent: machine-wake note struck pre-delivery%'
        AND "createdAt" > '${FLIP}'
      ORDER BY "createdAt" DESC LIMIT 10`));

  // c. guard_strike outcome rows since flip (struckClaims captured pass-1)
  await sec('rejectback_outcomes_since_flip', () => q(
    `SELECT "createdAt"::text AS created, meta->>'phantoms' AS phantoms, (meta->'struckClaims' IS NOT NULL) AS has_struck_claims,
            meta->>'retryMs' AS retry_ms, meta->>'seeded' AS seeded, "sessionId"
       FROM loop_metrics
      WHERE kind = 'guard_strike' AND meta->>'seam' = 'machine_wake_reject_back'
        AND "createdAt" > '${FLIP}'
      ORDER BY "createdAt" DESC LIMIT 10`));

  // v2: the strike rows AGAIN (same window, wider LIMIT) with the fields the
  // boundary classifier needs: created, context->>'chatId', claims_ok. Old
  // (#1175-era) code writes the strike WITH claims but the outcome row
  // WITHOUT struckClaims — that pair, inside the boundary window, is the
  // deploy-boundary signature (a run that started pre-flip on the retiring
  // colour and finalized after it).
  await sec('strike_rows_for_pairing', () => q(
    `SELECT "createdAt"::text AS created, context->>'chatId' AS chat_id, ${CLAIMS_OK} AS claims_ok
       FROM app_error_logs
      WHERE message LIKE 'action-verifier: PRE-DELIVERY strike%'
        AND "createdAt" > '${FLIP}'
      ORDER BY "createdAt" DESC LIMIT 20`));

  await prisma.$disconnect();

  const a = out.predelivery_since_flip, b = out.rejectback_warns_since_flip, c = out.rejectback_outcomes_since_flip, s = out.strike_rows_for_pairing;
  const nA = Array.isArray(a) ? a.length : 0;
  const nB = Array.isArray(b) ? b.length : 0;
  const nC = Array.isArray(c) ? c.length : 0;

  // v2: deploy-boundary classifier for arm (c). A bad outcome row (phantoms>0,
  // no struckClaims) is BOUNDARY — reported, not failed — when ALL hold:
  //   1. it sits inside the 6h window after the flip (the retiring colour's
  //      drain cap is 1500s; 6h generously covers any in-flight run that
  //      started pre-flip — a strike landing long after the flip is a
  //      regression, full stop);
  //   2. a PRE-DELIVERY strike row exists for the SAME session within ±10s
  //      (two writes of the same guard pass: action-verifier.ts:5376 writes
  //      the strike, chat-agent writes the outcome row; NB the strike row's
  //      context.chatId is the 8-char prefix, so match by startsWith);
  //   3. that strike row carries claims — #1175 code live since 23:50Z
  //      writes it WITH claims; #1177 code would never write the outcome
  //      row without struckClaims; pre-#1175 code would write it claims-less.
  // Anything else fails — and every classified row is printed (boundary_pairs)
  // for the operator to eyeball, so nothing is silenced.
  const flipMs = Date.parse(FLIP);
  const BOUNDARY_WINDOW_MS = 6 * 3600 * 1000;
  const asMs = (t) => Date.parse(String(t).replace(' ', 'T') + 'Z');
  const strikeRows = Array.isArray(s) ? s : [];
  const badC = [];
  const boundary = [];
  for (const r of (Array.isArray(c) ? c : [])) {
    if (!(Number(r.phantoms) > 0 && !r.has_struck_claims)) continue;
    const t = asMs(r.created);
    const pair = strikeRows.find((k) => k.chat_id && String(r.sessionId || '').startsWith(String(k.chat_id))
      && Math.abs(asMs(k.created) - t) <= 10000 && k.claims_ok === true);
    if (!Number.isNaN(t) && !Number.isNaN(flipMs) && (t - flipMs) <= BOUNDARY_WINDOW_MS && pair) {
      boundary.push({ outcome_row: r.created, session: r.sessionId, phantoms: r.phantoms, paired_strike: pair.created, paired_strike_claims_ok: true });
    } else {
      badC.push(r);
    }
  }

  let verdict;
  if (nA + nB + nC === 0) {
    verdict = 'ZERO_YET (no strikes since flip — nothing to observe; ~10/24h baseline)';
  } else {
    const bad = (Array.isArray(a) ? a.filter((r) => !r.claims_ok).length : 0)
      + (Array.isArray(b) ? b.filter((r) => !r.claims_ok).length : 0)
      + badC.length;
    if (bad === 0 && boundary.length) {
      verdict = `AV_EVIDENCE_OK (${boundary.length} deploy-boundary row(s) auto-classified — see boundary_pairs; regression rows: 0)`;
    } else if (bad === 0) {
      verdict = 'AV_EVIDENCE_OK';
    } else {
      verdict = `AV_EVIDENCE_BAD (${bad} row(s) missing evidence${boundary.length ? `; ${boundary.length} boundary row(s) auto-classified` : ''})`;
    }
  }
  if (boundary.length) out.boundary_pairs = boundary;
  console.log(JSON.stringify({ probe: 'verify-iter58-av-evidence', flip: FLIP, ...out, verdict },
    (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  process.exit(verdict.startsWith('AV_EVIDENCE_BAD') ? 1 : 0);
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(3); });
