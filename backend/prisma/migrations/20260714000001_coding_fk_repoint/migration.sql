-- One-Digby merge, Phase 1 Commit D — the DEFERRED FK repoint (amendment A2).
-- Commit A's migration was additive-only because old-color code during the
-- blue-green overlap created coding_sessions rows without chat rows. Three
-- deploys later the overlap is long drained, the reconciliation script ran
-- clean in prod (0 stragglers, invariants OK), and all writers create
-- chat+satellite together in one transaction — so the constraints are now safe.

-- Belt-and-braces: sweep any (impossible) stragglers before constraining.
INSERT INTO "crossmodel_projects"
  ("id","userId","name","emoji","repoUrl","repoProvider","defaultBranch","githubLabel","createdAt","updatedAt")
SELECT cp."id", cp."userId", cp."name", '🛠️', NULLIF(cp."repoUrl",''), cp."provider",
       cp."defaultBranch", cp."githubLabel", cp."createdAt", cp."updatedAt"
FROM "coding_projects" cp
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "crossmodel_chats"
  ("id","userId","projectId","title","mode","messages","createdAt","updatedAt")
SELECT cs."id", cs."userId", cs."projectId", cs."title", 'code', ARRAY[]::jsonb[],
       cs."createdAt", cs."updatedAt"
FROM "coding_sessions" cs
ON CONFLICT ("id") DO NOTHING;

-- Coding state dies with its PROJECT (worktrees/branches are project-keyed)…
ALTER TABLE "coding_sessions"
  ADD CONSTRAINT "coding_sessions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "crossmodel_projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- …and with its CHAT (satellite row of the chat).
ALTER TABLE "coding_sessions"
  ADD CONSTRAINT "coding_sessions_id_fkey"
  FOREIGN KEY ("id") REFERENCES "crossmodel_chats"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
