#!/usr/bin/env node
/**
 * Decision gate — flip-readiness report + temperature fit (WI-I → E1,
 * 2026-09-25). Repo-root entry point.
 *
 * The implementation lives in backend/src/scripts/decision-gate-fit-temperature.ts
 * (moved under src/ 2026-09-25 so `tsc` compiles it into dist/scripts/ and the
 * PROD IMAGE can run it: `node dist/scripts/decision-gate-fit-temperature.js`).
 * It needs the backend's Prisma client and .env, which resolve from that
 * directory — the repo root has no node_modules. This file is the documented
 * root-level DEV entry: it re-runs the backend script under tsx with
 * cwd=backend/ so module resolution and dotenv both find what they need.
 *
 * The same report is produced AUTOMATICALLY every DECISION_GATE_READINESS_
 * INTERVAL_MIN by the worker's `decision-gate-readiness` cron job
 * (backend/src/modules/crossmodel/platform/decision-gate-readiness.job.ts) —
 * this CLI is the on-demand view.
 *
 *   npx tsx scripts/decision-gate-fit-temperature.ts [--days=14] [--purpose=wake_triage] [--min=50] [--json] [--stamp]
 *   (equivalent: cd backend && npm run decision-gate:fit -- …)
 *   --stamp writes the per-purpose READY / NOT READY verdict to the context
 *   store (instance:decision-gate/readiness) — the only evidence an act flip
 *   may be admitted on.
 */

import { spawnSync } from 'child_process';
import { resolve } from 'path';

const backendDir = resolve(__dirname, '..', 'backend');
const script = resolve(backendDir, 'src', 'scripts', 'decision-gate-fit-temperature.ts');
const result = spawnSync('npx', ['tsx', script, ...process.argv.slice(2)], { cwd: backendDir, stdio: 'inherit' });
process.exit(result.status ?? 1);
