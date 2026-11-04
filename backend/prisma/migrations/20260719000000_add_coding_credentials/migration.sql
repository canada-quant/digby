-- Per-user CLI/API credentials injected into coding-session shells
-- (Cloudflare, AWS, Namecheap, Brev, custom). Values AES-256-GCM encrypted.
CREATE TABLE "coding_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "envKey" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coding_credentials_userId_envKey_key" ON "coding_credentials"("userId", "envKey");
CREATE INDEX "coding_credentials_userId_idx" ON "coding_credentials"("userId");

ALTER TABLE "coding_credentials" ADD CONSTRAINT "coding_credentials_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
