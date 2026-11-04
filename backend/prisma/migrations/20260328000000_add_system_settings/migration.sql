-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- Seed default settings
INSERT INTO "system_settings" ("key", "value", "updatedAt")
VALUES ('deep_research_daily_limit', '5', NOW())
ON CONFLICT ("key") DO NOTHING;
