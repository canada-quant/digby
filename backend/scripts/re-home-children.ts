/**
 * re-home-children — move misfiled child sessions (chat row + coding satellite)
 * into the project their work belongs to, in ONE transaction per chat.
 *
 * Why (misfiled-spawns-3, tt-rd audit 2026-09-27): nine framework children
 * spawned from crossmodel-project parents sit in foreign projects (tt-rd,
 * spark-cluster, CanLaw, Workspace) — all pre-dating the 2026-09-22 home-
 * project pin, which deliberately did no backfill. `move_chat` cannot fix
 * them: crossmodel.service.updateChat refuses to move a CODING chat into
 * another WORKSPACE project ("would re-key its repo"), which is exactly the
 * move these archived / idle rows need. This script is the owner-run admin
 * path: the same two rows updateChat moves together, with the refusal lifted
 * ONLY for sessions that are not running / provisioning. It never touches a
 * worktree (already reaped for these rows; a live one is chatId-keyed and
 * survives untouched either way).
 *
 * Usage (DRY-RUN by default — prints the plan, writes nothing):
 *   cd backend && npx tsx scripts/re-home-children.ts --target=<projectId> <chatId> [<chatId> …]
 *   cd backend && npx tsx scripts/re-home-children.ts --target=<projectId> <chatId…> --apply
 *   … --title=<chatId>:<new title>   (optional, repeatable: rename while moving —
 *                                     f0429496's stored title came from the parent
 *                                     digest, a defect fixed forward by cdc7bf77)
 *
 * The 2026-09-27 inventory (VERIFIED prod, child.projectId ≠ parent.projectId,
 * parent in crossmodel e5734bd2): f0429496 b1f74238 bf235679 9c867f21 df50d3e1
 * 173f6b6e 536067cf 3368d41b 299ad15f → target e5734bd2-7c44-4895-8204-84e456918f18.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/** Minimal DB surface — injectable for tests. */
export interface RehomeDb {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: RehomeDb) => Promise<T>): Promise<T>;
}

export interface ChatRow {
  id: string;
  title: string;
  projectId: string | null;
  parentChatId: string | null;
  archivedAt: Date | null;
  isSupervisor: boolean;
  isProjectSupervisor: boolean;
  /** coding_sessions satellite (same id) — null when the chat is plain. */
  codingProjectId: string | null;
  codingStatus: string | null;
}

export interface RehomeMove { id: string; from: string | null; codingFrom: string | null; title?: string; hasSatellite: boolean }
export interface RehomeRefusal { id: string; reason: string }
export interface RehomePlan { target: string; moves: RehomeMove[]; refusals: RehomeRefusal[] }

/** Satellite states in which a move is refused (the run path keys off the satellite's projectId). */
export const LIVE_CODING_STATUSES = ['running', 'provisioning'] as const;

/** Pure: decide, per requested chat, move vs refuse. Never throws. */
export function planRehome(requested: string[], rows: ChatRow[], target: string, titles: Record<string, string> = {}): RehomePlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const moves: RehomeMove[] = [];
  const refusals: RehomeRefusal[] = [];
  for (const id of requested) {
    const r = byId.get(id);
    if (!r) { refusals.push({ id, reason: 'not found' }); continue; }
    if (r.isSupervisor || r.isProjectSupervisor) { refusals.push({ id, reason: 'supervisor chat — its projectId is its identity' }); continue; }
    if (r.codingStatus && (LIVE_CODING_STATUSES as readonly string[]).includes(r.codingStatus)) {
      refusals.push({ id, reason: `coding session is ${r.codingStatus} — wait for it to finish` });
      continue;
    }
    const alreadyThere = r.projectId === target && (r.codingProjectId === null || r.codingProjectId === target);
    if (alreadyThere && !titles[id]) { refusals.push({ id, reason: 'already in the target project (no-op)' }); continue; }
    moves.push({ id, from: r.projectId, codingFrom: r.codingProjectId, hasSatellite: r.codingProjectId !== null, ...(titles[id] ? { title: titles[id] } : {}) });
  }
  return { target, moves, refusals };
}

export async function loadRows(db: RehomeDb, ids: string[]): Promise<ChatRow[]> {
  if (ids.length === 0) return [];
  return db.$queryRawUnsafe<ChatRow[]>(
    `SELECT c.id, c.title, c."projectId", c."parentChatId", c."archivedAt", c."isSupervisor", c."isProjectSupervisor",
            s."projectId" AS "codingProjectId", s.status AS "codingStatus"
       FROM "crossmodel_chats" c
       LEFT JOIN "coding_sessions" s ON s.id = c.id
      WHERE c.id = ANY($1::text[])`,
    ids,
  );
}

/** Apply one move: chat row + satellite (when present) in ONE transaction. */
export async function applyMove(db: RehomeDb, move: RehomeMove, target: string): Promise<void> {
  await db.$transaction(async (tx) => {
    if (move.title) {
      await tx.$executeRawUnsafe(`UPDATE "crossmodel_chats" SET "projectId" = $1, "title" = $2, "updatedAt" = NOW() WHERE id = $3`, target, move.title, move.id);
    } else {
      await tx.$executeRawUnsafe(`UPDATE "crossmodel_chats" SET "projectId" = $1, "updatedAt" = NOW() WHERE id = $2`, target, move.id);
    }
    if (move.hasSatellite) {
      await tx.$executeRawUnsafe(`UPDATE "coding_sessions" SET "projectId" = $1, "updatedAt" = NOW() WHERE id = $2`, target, move.id);
    }
  });
}

export function parseArgs(argv: string[]): { target: string; ids: string[]; apply: boolean; titles: Record<string, string> } {
  let target = '';
  let apply = false;
  const ids: string[] = [];
  const titles: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith('--target=')) target = a.slice('--target='.length).trim();
    else if (a === '--apply') apply = true;
    else if (a.startsWith('--title=')) {
      const body = a.slice('--title='.length);
      const i = body.indexOf(':');
      if (i > 0) titles[body.slice(0, i).trim()] = body.slice(i + 1).trim();
    } else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else ids.push(a.trim());
  }
  if (!target) throw new Error('--target=<projectId> is required');
  if (ids.length === 0) throw new Error('at least one chat id is required');
  return { target, ids, apply, titles };
}

export async function main(argv: string[] = process.argv.slice(2), db?: RehomeDb & { $disconnect(): Promise<void> }, log: (s: string) => void = console.log): Promise<number> {
  const { target, ids, apply, titles } = parseArgs(argv);
  const ownDb = db ?? (new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }), log: ['error'] }) as unknown as RehomeDb & { $disconnect(): Promise<void> });
  try {
    const rows = await loadRows(ownDb, ids);
    const plan = planRehome(ids, rows, target, titles);
    for (const r of plan.refusals) log(`SKIP ${r.id}: ${r.reason}`);
    for (const m of plan.moves) log(`${apply ? 'MOVE' : 'PLAN'} ${m.id}: ${m.from ?? '(ungrouped)'} → ${target}${m.hasSatellite ? ` (+ coding_sessions ${m.codingFrom} → ${target})` : ''}${m.title ? ` title="${m.title}"` : ''}`);
    if (!apply) { log(`dry-run: ${plan.moves.length} move(s), ${plan.refusals.length} skip(s) — re-run with --apply to write`); return 0; }
    for (const m of plan.moves) await applyMove(ownDb, m, target);
    log(`applied ${plan.moves.length} move(s), ${plan.refusals.length} skipped`);
    return 0;
  } finally {
    if (!db) await ownDb.$disconnect();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
}
