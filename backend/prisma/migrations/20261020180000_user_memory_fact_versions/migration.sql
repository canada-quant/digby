-- Memory upgrade (2026-10-20): value history for user-memory facts.
-- The user_memory.facts JSON blob stays CANONICAL. Until now every writer
-- (turn extractor, rebuild, nightly dream, Memory tab, remember/forget tools)
-- OVERWROTE or DELETED a fact with no history, no per-fact timestamp and no
-- source chat. memory/fact-versions.ts appends here after each blob write:
-- one row per value a key has held; "validTo" NULL = the current value. A
-- changed value closes the open row ("endedReason" 'replaced', "replacedBy" =
-- the new value); a dream merge closes it as 'consolidated' with "replacedBy"
-- `key:<newKey>`. A user-intent forget deletes the key's rows outright.
-- Additive only: no existing table or column changes. FK-less, like
-- user_memory_facts.
CREATE TABLE "user_memory_fact_versions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceChatId" TEXT,
    "validFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMPTZ(6),
    "endedReason" TEXT,
    "replacedBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_memory_fact_versions_pkey" PRIMARY KEY ("id")
);

-- Open-version lookup per key (validTo IS NULL) + the per-user history read.
CREATE INDEX "user_memory_fact_versions_userId_key_validTo_idx" ON "user_memory_fact_versions"("userId", "key", "validTo");
CREATE INDEX "user_memory_fact_versions_userId_validFrom_idx" ON "user_memory_fact_versions"("userId", "validFrom");
