-- CreateTable: user_preferences
-- Stores per-user model set preference (frontier vs open_source)

CREATE TABLE "user_preferences" (
    "userId"    TEXT NOT NULL,
    "modelSet"  TEXT NOT NULL DEFAULT 'frontier',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_preferences"
    ADD CONSTRAINT "user_preferences_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
