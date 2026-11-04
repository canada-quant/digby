/**
 * One-Digby merge — post-cutover reconciliation (Phase 1 Commit A).
 *
 * During the blue-green overlap the OLD color may have written coding_projects /
 * coding_sessions rows the additive migration didn't see. This sweeps them into
 * the merged tables (same idempotent SQL as the migration) and removes orphaned
 * code chats (amendment D3). Safe to run any number of times.
 *
 * Run (inside the backend container):
 *   npx ts-node src/scripts/reconcile-coding-unify.ts
 * or compiled:
 *   node dist/scripts/reconcile-coding-unify.js
 */

import { reconcileCodingUnify } from '../modules/crossmodel/coding/coding-data.service';
import prisma from '../config/database';

async function main() {
  const result = await reconcileCodingUnify();
  // eslint-disable-next-line no-console
  console.log(`reconcile-coding-unify: projects=${result.projects} chats=${result.chats} orphans=${result.orphans}`);
  // Invariant report: every coding_sessions row must have a chat row.
  const missing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s."id" FROM "coding_sessions" s
     WHERE NOT EXISTS (SELECT 1 FROM "crossmodel_chats" c WHERE c."id" = s."id") LIMIT 20`,
  );
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`INVARIANT VIOLATION: ${missing.length} coding_sessions row(s) still lack chat rows:`, missing.map(m => m.id));
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('invariants OK: every coding session has a chat row');
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
