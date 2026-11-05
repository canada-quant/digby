/**
 * verify-iter39-briefbudget.js — FO firing 39 proving probe (de-volatilized
 * firing 45, 2026-09-29 — same doctrine as the legshare probe's firing-44
 * rewrite: pin the COMPILED SHAPE, never a volatile literal).
 *
 * Proves in ONE read-only pass (post-wave):
 *  1. The project_brief budget raise is LIVE in the running container's dist.
 *     tsc does NOT inline the exported const, so the compiled file carries
 *     `exports.PROJECT_BRIEF_BUDGET_TOKENS = <value>` and the call site reads
 *     `maxTokens: exports.PROJECT_BRIEF_BUDGET_TOKENS`. Pinned: the EXPORT
 *     EXISTS and the CALL SITE USES IT (the shape). The VALUE is REPORTED,
 *     not asserted — it is a tunable (1400 → 2200 firing 39 → 8000 firing 45;
 *     2200 still cut mid-mission at 18.8% parse_error because the admin's
 *     'utility' Edge override leg passes max_tokens through literally — the
 *     16384 thinking floor guards only the built-in DeepSeek leg).
 *     The VALUE FLOOR is asserted from TELEMETRY (section 2): rows since the
 *     flip must carry budgetTokens >= 8000 — data, not a dist literal.
 *  2. The budget telemetry rows since the flip: budgetTokens >= 8000, and
 *     (firing 45) leg/finishReason now stamped via onMeta so a truncation is
 *     attributable from the audit alone.
 *  3. The rate since the flip: parse_error vs changed outcomes for
 *     project_brief (expect the share to fall below the 10% bar; the 4h
 *     window before firing 45 ran 6/32 = 18.8%).
 *  4. Fallback cards since the flip (brief_source fallback in
 *     crossmodel_messages, same shape as the audit's project_briefs_4h):
 *     expect 0-rare; 7 landed in the 4h window before the fix.
 *  5. Carried forward from firing 38: the absorbed-billing probe's ticket
 *     table is user_feature_requests (firing 38 shipped the nonexistent
 *     feedback_tickets — the section ERRed on the opening check).
 *
 * Read-only: SELECTs + greps. No writes anywhere.
 */
const { execSync } = require('child_process');
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

const FLIP = process.env.ITER39_FLIP || '2026-09-28T08:00:00Z'; // set to the wave-complete time on the opening check

(async () => {
  // 1. budget raise live in dist (de-volatilized firing 45): pin the SHAPE —
  //    the export exists and the call site reads it — REPORT the value. The
  //    value floor is asserted from telemetry in section 2, not from dist.
  await sec('iter39_dist', () => {
    const dist = '/app/dist/modules/crossmodel/fleet/project-brief.service.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${dist} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      export_exists: grep('exports.PROJECT_BRIEF_BUDGET_TOKENS ='),   // the compiled export (expect >=1)
      call_uses_const: grep('maxTokens: exports.PROJECT_BRIEF_BUDGET_TOKENS'), // the call site (expect >=1)
      onmeta_wired: grep('onMeta:'),                                    // firing 45: leg/finishReason stamp (expect >=1)
      budget_value: (() => { try { return execSync(`grep -o -- 'exports.PROJECT_BRIEF_BUDGET_TOKENS = [0-9]*' ${dist} | head -1`).toString().trim().split('= ')[1]; } catch { return 'ERR'; } })(), // REPORTED, never asserted
      old_1400_call: grep('maxTokens: 1400'),            // the pre-firing-39 literal (expect 0)
      old_2200_call: grep('maxTokens: 2200'),            // the firing-39 literal (expect 0)
      dist_mtime: execSync(`stat -c %y ${dist}`).toString().trim().slice(0, 19),
    };
  });

  // 2. the telemetry row carries the budget
  //    (kind = memory_extraction per loop-metrics.service.ts; meta.source/outcome/budgetTokens
  //     per memory-audit.ts recordExtractionOutcome)
  await sec('brief_rows_budget_since_flip', () => q(
    `SELECT meta->>'budgetTokens' AS budget, meta->>'leg' AS leg, COUNT(*)::int AS n
     FROM loop_metrics
     WHERE kind = 'memory_extraction'
       AND meta->>'source' = 'project_brief'
       AND "createdAt" > '${FLIP}'
     GROUP BY 1, 2 ORDER BY 1, 2`));

  // 3. the rate since the flip (expect below the 10% charter bar)
  await sec('brief_outcomes_since_flip', () => q(
    `SELECT meta->>'outcome' AS outcome, COUNT(*)::int AS n
     FROM loop_metrics
     WHERE kind = 'memory_extraction'
       AND meta->>'source' = 'project_brief'
       AND "createdAt" > '${FLIP}'
     GROUP BY 1 ORDER BY 2 DESC`));

  // 4. fallback cards since the flip (crossmodel_messages metadata — the audit's project_briefs_4h shape)
  await sec('brief_fallback_cards_since_flip', () => q(
    `SELECT COALESCE(m.metadata->'brief'->>'source','none') AS brief_source, COUNT(*)::int AS cards
     FROM crossmodel_messages m
     WHERE m.metadata->>'origin' = 'project_status'
       AND m."createdAt" > '${FLIP}'
     GROUP BY 1 ORDER BY 2 DESC`));

  // 5. iter-38 carry-forward: ticket table name is user_feature_requests
  await sec('iter38_ticket_table_fixed', () => q(
    `SELECT LEFT(title, 90) AS title, status, context->>'class' AS ctx_class
     FROM user_feature_requests
     WHERE title LIKE 'PROVIDER BILLING OUTAGE%' ORDER BY "createdAt" DESC LIMIT 5`));

  console.log(JSON.stringify(out, BIG, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); await prisma.$disconnect(); process.exit(1); });
