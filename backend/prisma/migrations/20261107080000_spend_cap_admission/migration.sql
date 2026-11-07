-- THE ONE USAGE LIMIT — ATOMIC ADMISSION (owner directive 2026-11-07T06:40Z; review
-- defect on the $100 lifetime spend cap, 2026-11-07).
--
-- ADDITIVE ONLY: one NEW table, no existing table/column/row is touched by this file.
--
-- WHY THIS TABLE EXISTS. The cap used to be a CHECK-THEN-RUN preflight: read the
-- lifetime total, throw if it is at/over $100, otherwise let the send go. That is not
-- a cap, it is a race. Two sends arriving together both read $99.50, both pass, both
-- spend, and the account settles past $100. The ledger (`loop_metrics` run_spend +
-- `spend_daily_rollups`) records cost AFTER a run, so it can never be read as an
-- admission gate without a hold in front of it. This table IS that hold: one row per
-- admitted send, created inside the same transaction that takes a Postgres
-- transaction-scoped advisory lock on the user id, so admission for one user is
-- serialized and no two concurrent sends can both see the same "room left".
--
-- WHY A HOLD AND NOT A CHARGE. The real cost of a send is unknown until the model has
-- run and `run_spend` is recorded. A row here is a RESERVATION of a small fixed amount
-- (`DIGBY_SPEND_RESERVATION_USD`, default $1) that is counted alongside settled spend
-- while it is live. It is never billed and never converted; it simply expires.
--
-- WHY expiresAt. A crashed / killed / timed-out run must not permanently hold budget:
-- every reservation carries a 30-minute TTL and rows past it are ignored by the
-- admission read. Expiry is a safety valve, not the accounting — the settled spend it
-- was standing in for arrives in `loop_metrics` regardless.
--
-- WHY NO FOREIGN KEY on userId. These rows are ephemeral budget holds, not
-- account history: a deleted user's holds should evaporate with their TTL, and a FK
-- would make account deletion either fail or cascade a write on the hot signup path.
-- The retiring work is a plain `DELETE ... WHERE "expiresAt" < now()` sweep.
--
-- The composite index is what the admission read uses: "live reservations for THIS
-- user" is `(userId, expiresAt > now())`, one index range scan per admission.
--
-- ROLLBACK: DROP TABLE "spend_cap_admissions"; nothing else references it (no FK,
-- no view, no trigger). Admission would then fail open (a missing relation is an
-- infra read error, and the guard allows on an unreadable ledger) — i.e. rolling this
-- back reverts to the pre-fix check-then-run behaviour, which is the reason it ships.

-- CreateTable
CREATE TABLE "spend_cap_admissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reservedUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_cap_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spend_cap_admissions_userId_expiresAt_idx" ON "spend_cap_admissions"("userId", "expiresAt");