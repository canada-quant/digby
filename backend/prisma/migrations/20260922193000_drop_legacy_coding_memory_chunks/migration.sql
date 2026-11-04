-- Owner 2026-09-22 ("if no one used it past few days just delete it now"):
-- the pre-unified-store session memory table. Last write 2026-07-18; the
-- instrumented fallback read (legacy_chunks_read) never returned a row after
-- the unified digby_memory store took over; the nightly full DB dump on box A
-- holds the final copy. 13,722 rows / 259 MB at drop time.
DROP TABLE IF EXISTS coding_memory_chunks;
