/**
 * User Space (P3 — docs/USER_SPACE_DESIGN.md §3) — backfill runner.
 *
 * Files every pre-existing UNFILED chat (projectId NULL, non-supervisor) into its owner's hidden user-space project, creating that space
 * first when missing (ensureUserSpace — kid owners get the PLAIN variant).
 * New chats never need this (createChat auto-files); prod runs it ONCE
 * post-deploy. Idempotent: a filed chat no longer matches the predicate, and
 * the partial unique index crossmodel_projects_one_userspace_per_owner makes a
 * re-run's ensure a plain read.
 *
 * Default is DRY-RUN (per-user report only). Execute with:
 *   npx ts-node src/scripts/backfill-user-space.ts --apply
 * or compiled:
 *   node dist/scripts/backfill-user-space.js --apply
 */

import prisma from '../config/database';
import { ensureUserSpace } from '../modules/crossmodel/platform/user-space.service';

const APPLY = process.argv.includes('--apply');

/** The filing predicate, shared by the report and the apply pass. (Topic feeds
 *  were retired 2026-10-20, ticket 43c24152 — their chats are ordinary chats, so
 *  the old feed-relation clause is gone; keeping it would be a dead Prisma
 *  pointer that throws at runtime — adversarial-review finding 1.) */
const UNFILED = { projectId: null, isSupervisor: false } as const;

async function main() {
  const candidates = await prisma.crossModelChat.findMany({
    where: UNFILED,
    select: { userId: true },
  });
  const countByUser = new Map<string, number>();
  for (const c of candidates) countByUser.set(c.userId, (countByUser.get(c.userId) ?? 0) + 1);

  console.log(`backfill-user-space: ${candidates.length} unfiled chat(s) across ${countByUser.size} user(s)${APPLY ? '' : ' — DRY RUN (pass --apply to execute)'}`);
  for (const [userId, count] of [...countByUser.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  user ${userId.slice(0, 8)}…: ${count} chat(s)`);
  }
  if (!APPLY) {
    await prisma.$disconnect();
    return;
  }

  let filed = 0;
  let skipped = 0;
  for (const userId of [...countByUser.keys()].sort()) {
    const space = await ensureUserSpace(userId);
    if (!space) {
      skipped += countByUser.get(userId) ?? 0;
        console.error(`  user ${userId.slice(0, 8)}…: SKIPPED — user space could not be ensured (see warn logs)`);
      continue;
    }
    const { count } = await prisma.crossModelChat.updateMany({
      where: { userId, ...UNFILED },
      data: { projectId: space.id },
    });
    filed += count;
    console.log(`  user ${userId.slice(0, 8)}…: filed ${count} chat(s) → user space ${space.id.slice(0, 8)}…`);
  }
  console.log(`backfill-user-space: DONE — filed ${filed} chat(s)${skipped ? `, skipped ${skipped} (ensure failures)` : ''}`);
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
