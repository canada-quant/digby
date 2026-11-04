-- Ticket 26786762 (2026-10-17): agent→owner credential delivery through a
-- flag_owner_question card. The write-time inbound secret scan destroyed the
-- delivered value in the stored card text, so a card filed to hand the owner
-- a key rendered "[REDACTED: looked like a credential]" exactly where the key
-- was (specimen oq_f4472e5e, the LiteLLM gateway key the owner asked for and
-- never received). This table stores the delivered value ENCRYPTED
-- (AES-256-GCM, credentials-vault key derived from JWT_SECRET) with a
-- numbered reveal handle; reveal is owner-scoped REST only.
-- Additive only: one NEW table, no existing table altered.

-- CreateTable
CREATE TABLE "owner_question_secrets" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "spanName" TEXT NOT NULL,
    "revealedAt" TIMESTAMP(3),
    "revealCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_question_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "owner_question_secrets_questionId_ordinal_key" ON "owner_question_secrets"("questionId", "ordinal");

-- CreateIndex
CREATE INDEX "owner_question_secrets_userId_idx" ON "owner_question_secrets"("userId");
