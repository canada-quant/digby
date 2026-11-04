-- Mobile push notification tokens (M1 — roadmap §3.2 item 2, todo 7cbf46a4).
-- One row per (user, device token); the backend fires on chat run completion
-- so a backgrounded mobile app can surface "your run finished". Expo Push
-- tokens by default; provider column distinguishes expo/apns/fcm addressing.
-- (userId, token) dedupes re-registrations; (userId, deviceId) is advisory
-- (a device may rotate its token — the new row wins, the old goes stale via
-- lastSeenAt).

CREATE TABLE "push_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'expo',
    "platform" TEXT,
    "deviceId" TEXT,
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- Create index for push_tokens_userId_idx
CREATE INDEX "push_tokens_userId_idx" ON "push_tokens"("userId");

-- Create unique index for push_tokens_userId_token_key
CREATE UNIQUE INDEX "push_tokens_userId_token_key" ON "push_tokens"("userId", "token");

-- Add foreign key constraint for push_tokens_userId_fkey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
