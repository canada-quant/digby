-- Absorb the #67 flat sidebar folders (crossmodel_folders + folderId columns on
-- chats/projects) into the P2 nested project folder tree — the one-folder-model
-- decision (DIGBY_PLATFORM_UNIFICATION_PLAN Pillar 2): CrossModelProject IS the
-- folder; folders nest via parentId/depth/path.
--
-- Hardened (review Finding 4):
--   * TRANSACTIONAL — the whole absorb is wrapped in BEGIN/COMMIT (Prisma does
--     NOT wrap migration.sql files; a mid-script failure previously left the
--     tree half-rewired with the source table already dropped).
--   * NO SILENT SKIPS — every anomalous row is EXPLICIT: a RAISE WARNING with
--     counts + ids, then a DELIBERATE resolution (never a quietly-skipped row):
--       - orphan memberships (folderId matches NO folder row — FK drift / a
--         folder hard-deleted outside its SetNull FK) → ungrouped (set NULL);
--       - folder ids colliding with an existing project id → the folder is NOT
--         absorbed (its id already means something else); its memberships are
--         ungrouped and the folder row is dropped;
--       - projects that are BOTH flat-folder-filed AND already tree-nested
--         (the ~1-day window where both models were live) → the tree filing
--         wins; their folderId is nulled so the uniform "+1 depth" descendant
--         math below stays exact.
--   * IDEMPOTENT — safe to re-run from any partial state (a failed run rolls
--     back cleanly, but a hand-patched or legacy half-applied state also
--     converges): every phase is guarded on the table/columns actually present.
--   * LIVE-PROD SAFE — pure row moves + guarded DDL, no table rewrites beyond
--     the touched rows; runs via `prisma migrate deploy` in the deploy
--     healthcheck.
--
-- Mapping (FK-order safe):
--   1. each crossmodel_folders row  → a ROOT folder-node in crossmodel_projects
--      (the folder's id is REUSED, so every reference resolves without a mapping
--      table);
--   2. chats filed directly in a folder → members of that folder-node — ONLY when
--      they don't already belong to a project (a project chat stays with its
--      project; the project itself nests in step 3);
--   3. projects filed in a folder → depth-1 children of the folder-node, with
--      their DESCENDANTS re-anchored too (depth-shift FIRST on the old path
--      prefix, then path-prefix swaps — the folder-tree-ops discipline);
--   4. the absorbed columns + table drop.
-- sortOrder has no tree equivalent and is dropped with the table (sidebar order
-- reverts to updatedAt-desc until a tree-order field is introduced).

BEGIN;

DO $$
DECLARE
  folders_table boolean := to_regclass('public.crossmodel_folders') IS NOT NULL;
  chats_col boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crossmodel_chats' AND column_name = 'folderId');
  projects_col boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crossmodel_projects' AND column_name = 'folderId');
  orphan_chats int := 0;  orphan_chat_ids text := '';
  orphan_projects int := 0;  orphan_project_ids text := '';
  colliding int := 0;  colliding_ids text := '';
  collision_chats int := 0;  collision_projects int := 0;
  nested_filed int := 0;  nested_filed_ids text := '';
  drifted int := 0;  drifted_ids text := '';
  absorbed int := 0;
  filed_chats int := 0;
  nested_projects int := 0;
BEGIN
  -- ── 0a. Orphan chat memberships → EXPLICIT ungroup ──────────────────────────
  IF folders_table AND chats_col THEN
    SELECT count(*), coalesce(string_agg(c."id", ',' ORDER BY c."id"), '')
      INTO orphan_chats, orphan_chat_ids
      FROM "crossmodel_chats" c
     WHERE c."folderId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "crossmodel_folders" f WHERE f."id" = c."folderId");
    IF orphan_chats > 0 THEN
      RAISE WARNING '[absorb_sidebar_folders] % chat(s) referenced a MISSING folder and were deliberately ungrouped (folderId → NULL): %',
        orphan_chats, orphan_chat_ids;
      UPDATE "crossmodel_chats" c
         SET "folderId" = NULL
       WHERE c."folderId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "crossmodel_folders" f WHERE f."id" = c."folderId");
    END IF;
  END IF;

  -- ── 0b. Orphan project memberships → EXPLICIT ungroup ───────────────────────
  IF folders_table AND projects_col THEN
    SELECT count(*), coalesce(string_agg(p."id", ',' ORDER BY p."id"), '')
      INTO orphan_projects, orphan_project_ids
      FROM "crossmodel_projects" p
     WHERE p."folderId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "crossmodel_folders" f WHERE f."id" = p."folderId");
    IF orphan_projects > 0 THEN
      RAISE WARNING '[absorb_sidebar_folders] % project(s) referenced a MISSING folder and were deliberately unfiled (folderId → NULL): %',
        orphan_projects, orphan_project_ids;
      UPDATE "crossmodel_projects" p
         SET "folderId" = NULL
       WHERE p."folderId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "crossmodel_folders" f WHERE f."id" = p."folderId");
    END IF;
  END IF;

  -- ── 0c. Folder/project id collisions → EXPLICIT non-absorb ──────────────────
  -- A folder id that ALREADY exists as a project id cannot become a folder-node
  -- (ON CONFLICT would silently skip it and its members would re-point at the
  -- WRONG project). Deliberate policy: ungroup its memberships, drop the folder
  -- row, and say so loudly.
  IF folders_table THEN
    SELECT count(*), coalesce(string_agg(f."id", ',' ORDER BY f."id"), '')
      INTO colliding, colliding_ids
      FROM "crossmodel_folders" f
     WHERE EXISTS (SELECT 1 FROM "crossmodel_projects" p WHERE p."id" = f."id");
    IF colliding > 0 THEN
      RAISE WARNING '[absorb_sidebar_folders] % folder(s) COLLIDE with an existing project id and were NOT absorbed (folder rows dropped): %',
        colliding, colliding_ids;
      IF chats_col THEN
        UPDATE "crossmodel_chats" c
           SET "folderId" = NULL
         WHERE EXISTS (SELECT 1 FROM "crossmodel_folders" f
                       WHERE f."id" = c."folderId"
                         AND EXISTS (SELECT 1 FROM "crossmodel_projects" p WHERE p."id" = f."id"));
        GET DIAGNOSTICS collision_chats = ROW_COUNT;
      END IF;
      IF projects_col THEN
        UPDATE "crossmodel_projects" p
           SET "folderId" = NULL
         WHERE EXISTS (SELECT 1 FROM "crossmodel_folders" f
                       WHERE f."id" = p."folderId"
                         AND EXISTS (SELECT 1 FROM "crossmodel_projects" p2 WHERE p2."id" = f."id"));
        GET DIAGNOSTICS collision_projects = ROW_COUNT;
      END IF;
      DELETE FROM "crossmodel_folders" f
       WHERE EXISTS (SELECT 1 FROM "crossmodel_projects" p WHERE p."id" = f."id");
      RAISE WARNING '[absorb_sidebar_folders] ungrouped % chat(s) and % project(s) from colliding folder(s)',
        collision_chats, collision_projects;
    END IF;
  END IF;

  -- ── 0d. Projects BOTH flat-filed AND tree-nested → tree wins, EXPLICITLY ────
  -- The flat-folder model and the tree model overlapped for ~1 day. A project
  -- with folderId set AND a tree parent (or non-zero depth) would break the
  -- uniform descendant math in step 3 — keep it where the tree put it instead.
  IF folders_table AND projects_col THEN
    SELECT count(*), coalesce(string_agg(p."id", ',' ORDER BY p."id"), '')
      INTO nested_filed, nested_filed_ids
      FROM "crossmodel_projects" p
     WHERE p."folderId" IS NOT NULL
       AND (p."parentId" IS NOT NULL OR p."depth" <> 0);
    IF nested_filed > 0 THEN
      RAISE WARNING '[absorb_sidebar_folders] % project(s) were filed in a flat folder AND nested in the tree — the TREE filing wins (folderId → NULL): %',
        nested_filed, nested_filed_ids;
      UPDATE "crossmodel_projects" p
         SET "folderId" = NULL
       WHERE p."folderId" IS NOT NULL
         AND (p."parentId" IS NOT NULL OR p."depth" <> 0);
    END IF;

    -- Path drift (rows the P0 backfill missed): step 3 matches descendants on
    -- the materialized path — a drifted foldered project would re-root while
    -- its children keep stale paths. Flag loudly; unfile it rather than guess.
    SELECT count(*), coalesce(string_agg(p."id", ',' ORDER BY p."id"), '')
      INTO drifted, drifted_ids
      FROM "crossmodel_projects" p
     WHERE p."folderId" IS NOT NULL
       AND (p."path" IS NULL OR p."path" = '' OR p."path" <> '/' || p."id");
    IF drifted > 0 THEN
      RAISE WARNING '[absorb_sidebar_folders] % foldered project(s) have a DRIFTED path (expected ''/<id>'') and were unfiled instead of re-rooted: %',
        drifted, drifted_ids;
      UPDATE "crossmodel_projects" p
         SET "folderId" = NULL
       WHERE p."folderId" IS NOT NULL
         AND (p."path" IS NULL OR p."path" = '' OR p."path" <> '/' || p."id");
    END IF;
  END IF;

  -- ── 1. Folder → root folder-node (workspace fields NULL = plain folder) ─────
  IF folders_table THEN
    INSERT INTO "crossmodel_projects"
      ("id", "userId", "name", "depth", "path", "createdAt", "updatedAt")
    SELECT "id", "userId", "name", 0, '/' || "id", "createdAt", "updatedAt"
      FROM "crossmodel_folders"
    ON CONFLICT ("id") DO NOTHING; -- unreachable after 0c; guard for re-runs
    GET DIAGNOSTICS absorbed = ROW_COUNT;
  END IF;

  -- ── 2. Directly-foldered chats join the folder-node ─────────────────────────
  IF folders_table AND chats_col THEN
    UPDATE "crossmodel_chats" c
       SET "projectId" = c."folderId"
     WHERE c."folderId" IS NOT NULL AND c."projectId" IS NULL;
    GET DIAGNOSTICS filed_chats = ROW_COUNT;
  END IF;

  -- ── 3. Foldered projects become children — WITH their subtrees ──────────────
  -- After 0d every foldered project is a truthful root (depth 0, path '/<id>'),
  -- so its descendants shift by exactly +1 and no row can sit under two
  -- foldered roots. Order matters: shift depths on the OLD path prefix FIRST
  -- (after the path swap the old prefix matches zero rows).
  IF folders_table AND projects_col THEN
    UPDATE "crossmodel_projects" d
       SET "depth" = d."depth" + 1
      FROM "crossmodel_projects" p
     WHERE p."folderId" IS NOT NULL
       AND d."id" <> p."id"
       AND left(d."path", length(p."path") + 1) = p."path" || '/';

    UPDATE "crossmodel_projects" d
       SET "path" = '/' || p."folderId" || d."path"
      FROM "crossmodel_projects" p
     WHERE p."folderId" IS NOT NULL
       AND d."id" <> p."id"
       AND left(d."path", length(p."path") + 1) = p."path" || '/';

    UPDATE "crossmodel_projects" p
       SET "parentId" = p."folderId",
           "depth" = 1,
           "path" = '/' || p."folderId" || '/' || p."id"
     WHERE p."folderId" IS NOT NULL;
    GET DIAGNOSTICS nested_projects = ROW_COUNT;
  END IF;

  IF folders_table THEN
    RAISE NOTICE '[absorb_sidebar_folders] absorbed % folder(s) as root folder-nodes; filed % chat(s); nested % project(s)',
      absorbed, filed_chats, nested_projects;
  END IF;

  -- ── 4. Drop the absorbed columns + table (guarded for partial re-runs) ──────
  IF chats_col THEN
    ALTER TABLE "crossmodel_chats" DROP COLUMN "folderId";
  END IF;
  IF projects_col THEN
    ALTER TABLE "crossmodel_projects" DROP COLUMN "folderId";
  END IF;
  IF folders_table THEN
    DROP TABLE "crossmodel_folders"; -- FK constraints + indexes drop with it
  END IF;
END $$;

COMMIT;
