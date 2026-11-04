/**
 * MIGRATION ↔ SCHEMA COLUMN PARITY — the guard that would have caught the
 * c468f922 near-miss (2026-11-02).
 *
 * WHAT WENT WRONG. The (d) pre-login helper migration shipped
 * `ADD COLUMN "prelogin_helper"` (snake_case) while `schema.prisma` declared
 * `preloginHelper` with NO `@map` (its model's only @map is the table-level
 * `@@map("imessage_agents")`). Prisma Client therefore emits
 * `SELECT "preloginHelper"` — a column that would not exist — so EVERY
 * IMessageAgent read would have thrown P2022: agent authentication
 * (`imessage.service.ts` findUnique by tokenHash), polling, pairing and the
 * account device list. It was caught in review, before the deploy that carried
 * it applied migrations.
 *
 * WHY THE EXISTING CHECKS MISSED IT. `verify` runs typecheck/lint/switches/test.
 * Typecheck cannot see SQL; a unit test that mocks Prisma never touches a
 * database; and nothing compared a migration's DDL to the schema it must
 * materialise. That is the gap this file closes — it needs no database, parses
 * both sides as text, and fails the build on the exact class of typo that was
 * one cancelled deploy away from taking agent auth down.
 *
 * SCOPE, deliberately narrow: it checks the name a migration ADDS matches a
 * column Prisma expects (field name, or the field's `@map`). It does not try to
 * model types, defaults or indexes — a false failure on unrelated DDL would
 * train people to ignore it, which is worse than the gap.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

// __dirname is backend/src/scripts → two levels up is backend/.
const BACKEND = join(__dirname, '..', '..');
const PRISMA = join(BACKEND, 'prisma');
const MIGRATIONS = join(PRISMA, 'migrations');

/** Parse `model X { ... }` blocks → { model, table, columns:Set } where
 *  `columns` holds the identifier Prisma actually queries (the @map value when
 *  present, else the field name). */
function schemaColumns(): Map<string, Set<string>> {
  const text = readFileSync(join(PRISMA, 'schema.prisma'), 'utf8');
  const out = new Map<string, Set<string>>();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(text))) {
    const [, model, body] = m;
    const tableMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = tableMatch ? tableMatch[1] : model;
    const cols = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@') || line.startsWith('///')) continue;
      const field = line.match(/^(\w+)\s+\S/);
      if (!field) continue;
      const mapped = line.match(/@map\("([^"]+)"\)/);
      cols.add(mapped ? mapped[1] : field[1]);
    }
    out.set(table, cols);
  }
  return out;
}

/**
 * The guard polices migrations from here ON. Earlier migrations are baselined,
 * not ignored by accident: several added columns that were later renamed or
 * dropped, so their absence from today's schema is correct history, not a
 * defect. (E.g. crossmodel_projects.contextState / crossmodel_chats.threadState
 * from 2026-02/03, and the folderId pair from 2026-07-22.) Re-litigating those
 * would make this test fail for reasons nobody should act on — which trains
 * people to ignore it, the failure mode worse than the gap it closes.
 *
 * The class this exists to catch is a NEW migration whose column name does not
 * match what Prisma will query, so a date floor is the honest scope: every
 * migration at or after this point must line up.
 */
const GUARD_FROM = '20261101000000';

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((d) => {
      const p = join(MIGRATIONS, d);
      return statSync(p).isDirectory() && /^\d{14}_/.test(d) && d >= GUARD_FROM;
    })
    .sort();
}

describe('every ADD COLUMN in a migration matches a column Prisma will query', () => {
  const tables = schemaColumns();

  it('the schema parser actually found the models (guards against a vacuous pass)', () => {
    // Without this, a regex that silently matched nothing would make every
    // assertion below pass on an empty set — the classic vacuous green.
    expect(tables.size).toBeGreaterThan(20);
    expect(tables.has('imessage_agents')).toBe(true);
    expect(tables.get('imessage_agents')!.has('remoteAccess')).toBe(true);
    expect(tables.get('imessage_agents')!.has('unattended')).toBe(true);
    expect(tables.get('imessage_agents')!.has('preloginHelper')).toBe(true);
  });

  it('the EFFECTIVE post-replay schema matches what Prisma queries', () => {
    // Simulate, never inspect single files in isolation. The 2026-11-02 outage
    // taught this the hard way: migration 20261101234500 adds `prelogin_helper`
    // (wrong) and 20261102013000 drops it again, so no single-file rule can be
    // right about both. What matters is the column set left behind after the
    // whole replay — exactly what prod ends up with.
    //
    // added-then-dropped is FINE (it is the shape of a repair — history is
    // immutable, so the wrong statement stays on disk forever by design).
    // added-and-still-present must be a column Prisma queries.
    // dropped must NOT be one Prisma needs.
    const offenders: string[] = [];
    /** `${table}.${column}` → the migration that added it */
    const live = new Map<string, string>();

    for (const dir of migrationDirs()) {
      const sqlPath = join(MIGRATIONS, dir, 'migration.sql');
      let sql: string;
      try {
        sql = readFileSync(sqlPath, 'utf8');
      } catch {
        continue; // a directory without migration.sql is not our business
      }
      // Attribute each statement to the nearest preceding ALTER TABLE.
      let currentTable: string | null = null;
      for (const line of sql.split('\n')) {
        const alter = line.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i);
        if (alter) currentTable = alter[1];
        if (!currentTable) continue;
        // Only DDL counts — prose mentioning "ADD COLUMN" is a comment, and the
        // repair migration's header quotes the bad statement on purpose.
        if (line.trim().startsWith('--')) continue;
        for (const m of line.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) {
          live.set(`${currentTable}.${m[1]}`, dir);
        }
        for (const m of line.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi)) {
          const key = `${currentTable}.${m[1]}`;
          const known = tables.get(currentTable);
          if (known?.has(m[1])) {
            offenders.push(
              `${dir}: drops "${currentTable}"."${m[1]}", but Prisma still queries it — ` +
                `a schema.prisma column cannot be dropped by a migration`,
            );
          }
          live.delete(key);
        }
      }
    }

    for (const [key, dir] of live) {
      const dot = key.indexOf('.');
      const table = key.slice(0, dot);
      const column = key.slice(dot + 1);
      const known = tables.get(table);
      if (known && !known.has(column)) {
        // The c468f922 class: migration leaves prelogin_helper behind, Prisma
        // says preloginHelper. Name both so the fix is obvious.
        const near = [...known].filter((c) =>
          c.toLowerCase().includes(column.replace(/_/g, '').toLowerCase()),
        );
        offenders.push(
          `${dir}: "${table}"."${column}" is not a column Prisma queries ` +
            `(schema fields: ${near.join(', ') || 'no near match'})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('an APPLIED migration file is never edited — the repair is a NEW migration', () => {
    // THE 2026-11-02 OUTAGE, PINNED. 20261101234500 was applied to prod at
    // 00:53:56.888Z with checksum 79d1ee28…; the review fix edited that same
    // file to say `preloginHelper`. Two failures followed: Prisma keys applied
    // migrations by NAME, so prod never got the corrected statement and every
    // IMessageAgent read threw P2022; and `migrate deploy` compares the
    // recorded checksum to the file, so the edited file would have broken the
    // next deploy's migrate step too.
    //
    // The hash pin is the point: if someone "fixes" this file again, this test
    // fails and says to add a migration instead. Update the expected value ONLY
    // for a database that was never migrated — which, for a file already
    // applied to prod, is never.
    const APPLIED_CHECKSUM =
      '79d1ee28126c1cfd644e3d21ca16e39836c223189f64c554ce0f5ea1fbf209d9';
    const applied = readFileSync(
      join(MIGRATIONS, '20261101234500_agent_prelogin_helper', 'migration.sql'),
    );
    expect(createHash('sha256').update(applied).digest('hex')).toBe(APPLIED_CHECKSUM);

    // …and the correction lives where corrections belong.
    const repair = readFileSync(
      join(MIGRATIONS, '20261102013000_agent_prelogin_helper_column_repair', 'migration.sql'),
      'utf8',
    );
    expect(repair).toContain('ADD COLUMN IF NOT EXISTS "preloginHelper"');
    expect(repair).toContain('DROP COLUMN IF EXISTS "prelogin_helper"');
  });
});