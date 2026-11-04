-- CreateTable
CREATE TABLE IF NOT EXISTS "autopilot_status" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "pid" INTEGER,
    "uptimeSeconds" INTEGER,
    "lastTick" TIMESTAMP(3),
    "lastTicketId" TEXT,
    "openQueue" INTEGER NOT NULL DEFAULT 0,
    "clineState" TEXT NOT NULL DEFAULT 'closed',
    "tickCount" INTEGER NOT NULL DEFAULT 0,
    "version" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autopilot_status_pkey" PRIMARY KEY ("id")
);

-- Insert singleton row
INSERT INTO "autopilot_status" ("id", "status", "updatedAt")
VALUES ('singleton', 'unknown', NOW())
ON CONFLICT DO NOTHING;
