-- Spawn-time TITLE provenance (ticket 161d39e9): machine-launched coding
-- sessions derived their default chat title from the first prompt's
-- [PARENT SESSION CONTEXT] digest — the PARENT's run-outcome lines — instead
-- of the task, so the owner's sidebar read as a list of self-audit verdicts
-- ("post-sweep acceptance criteria verified", session 11449a0a). The fix has
-- two halves; this column is the provenance half: titleSource records WHERE
-- the initial title came from. NULL = default/derived ('Untitled session'
-- spawn default, frontend 'New chat', pre-column rows) — the opening turn may
-- derive a title from the task. 'spawn-param' = an explicit
-- start_coding_session `title` argument — the spawner named the work, so the
-- title is sticky by construction: the executor keeps it without consulting
-- the substring heuristic (which misread an explicit title echoing its own
-- task brief as placeholder scaffolding and let the LLM verdict-phrase
-- overwrite it — the 15fd6063 incident's residual hole).
-- ADDITIVE ONLY: one nullable column, no backfill — existing rows keep NULL
-- and byte-identical derive behavior.

-- AlterTable
ALTER TABLE "coding_sessions" ADD COLUMN IF NOT EXISTS "titleSource" TEXT;
