/**
 * Supervisor doctrine constants shared by the Fleet Supervisor
 * (supervisor.service.ts), the per-project supervisor
 * (project-supervisor.service.ts), the fire-time sweep doctrine rebuild
 * (sweep-doctrine-rebuild.ts) and the note classifiers — a LEAF module so they
 * can all import it without a load-time cycle.
 *
 * build 2026-10-08 S-2 (simplify.md): the pre-layering doctrine text that lived
 * here (the dated standing-directive header, both precedence rules, the
 * directive-scope rule, FLEET_FACTS_2026_09_26, AUDIT_CHURN_RULE, the
 * wake-close contract + its duplicate WAKE_* markers, the fleet changelog note
 * and the dated KPI / time-box blocks) fed only the legacy builders behind
 * PROMPT_LAYERING_DISABLED, which docker-compose.app.yml never forwarded —
 * deleted with them. The layered prompts carry the generic versions
 * (core-doctrine.ts — incl. the WAKE_* markers — and role-profiles.ts).
 */

/** Stock sweep-prompt openers — BOTH a heal key and a trigger key:
 *  ensureSweepSchedule / ensureProjectSweepSchedule key their stale-prompt
 *  heal on startsWith(<opener>) so a user-customized prompt is never touched,
 *  and the fire-time doctrine rebuild (sweep-doctrine-rebuild.ts — R&D stream
 *  3 experiment #2, 2026-09-18) matches the same prefixes to recognize a stock
 *  sweep firing. Defined in this LEAF module so the rebuild can key on them
 *  without importing the services (schedule.service → rebuild → supervisor
 *  .service → schedule.service would cycle); both services re-export them, so
 *  existing import sites are unchanged. */
export const SWEEP_PROMPT_OPENER = 'Fleet Supervisor sweep';
export const PROJECT_SWEEP_PROMPT_OPENER = 'Project Supervisor sweep';

/** Doctrine-presence probe marker — the first line of the standing-directives
 *  section (core-doctrine.ts CORE_STANDING_DIRECTIVES; the pre-layering header
 *  opened with the same line). A lane system prompt (or a legacy pre-dedup
 *  stored sweep body) containing this string carries the standing doctrine;
 *  the fire-time rebuild probes it. */
export const DOCTRINE_PROBE_MARKER = '## Standing owner directives';
