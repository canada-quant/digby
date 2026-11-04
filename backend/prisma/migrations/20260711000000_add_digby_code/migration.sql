-- Digby Code — agentic coding tab (2026-07-11)

-- Preferences: open-source coding model + default permission mode
ALTER TABLE "user_preferences"
  ADD COLUMN IF NOT EXISTS "codingModel" TEXT NOT NULL DEFAULT 'glm-5.2',
  ADD COLUMN IF NOT EXISTS "codingPermissionMode" TEXT NOT NULL DEFAULT 'ask';

-- Imported codebases
CREATE TABLE IF NOT EXISTS "coding_projects" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "repoUrl"       TEXT NOT NULL,
  "defaultBranch" TEXT NOT NULL DEFAULT 'main',
  "provider"      TEXT NOT NULL DEFAULT 'github',
  "githubLabel"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coding_projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "coding_projects_userId_idx" ON "coding_projects"("userId");

-- Sessions (one git worktree + message thread each)
CREATE TABLE IF NOT EXISTS "coding_sessions" (
  "id"             TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "title"          TEXT NOT NULL DEFAULT 'Untitled session',
  "branch"         TEXT NOT NULL,
  "baseBranch"     TEXT NOT NULL DEFAULT 'main',
  "worktreePath"   TEXT,
  "permissionMode" TEXT NOT NULL DEFAULT 'ask',
  "model"          TEXT NOT NULL DEFAULT 'glm-5.2',
  "status"         TEXT NOT NULL DEFAULT 'provisioning',
  "errorMessage"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coding_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "coding_sessions_projectId_idx" ON "coding_sessions"("projectId");
CREATE INDEX IF NOT EXISTS "coding_sessions_userId_idx" ON "coding_sessions"("userId");

-- Messages
CREATE TABLE IF NOT EXISTS "coding_messages" (
  "id"        TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "role"      TEXT NOT NULL,
  "content"   TEXT NOT NULL,
  "parts"     JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coding_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "coding_messages_sessionId_idx" ON "coding_messages"("sessionId");
CREATE INDEX IF NOT EXISTS "coding_messages_sessionId_createdAt_idx" ON "coding_messages"("sessionId", "createdAt");

-- Foreign keys
ALTER TABLE "coding_projects" ADD CONSTRAINT "coding_projects_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "coding_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coding_messages" ADD CONSTRAINT "coding_messages_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "coding_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
