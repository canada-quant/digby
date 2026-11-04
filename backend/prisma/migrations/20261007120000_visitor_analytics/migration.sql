-- First-party visitor analytics (owner 2026-10-07: "i need a way to see activity on users/api cost/ ip addressed
-- or unique hash for users that use digby from what traffic source ie google ads facebook and the user flow").
-- Additive only: four NEW tables (visitors, visitor_links, visit_events, spend_daily_rollups) with their indexes
-- and FKs. No existing table is altered or rewritten. The legacy analytics_events table (raw ipAddress) is
-- untouched and NOT reused — a visitor carries an HMAC ip hash, never a raw IP. Account deletion cascades the
-- user's links + events (visitor rows stay pseudonymous).

-- CreateTable
CREATE TABLE "visitors" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT,
    "firstTouch" JSONB,
    "lastTouch" JSONB,
    "channel" TEXT,
    "campaign" TEXT,
    "lastChannel" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uaFamily" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_links" (
    "visitorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_links_pkey" PRIMARY KEY ("visitorId","userId")
);

-- CreateTable
CREATE TABLE "visit_events" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "path" TEXT,
    "props" JSONB,
    "source" TEXT NOT NULL DEFAULT 'client',
    "dedupeKey" TEXT,
    "spendSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spend_daily_rollups" (
    "day" DATE NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL DEFAULT '',
    "usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spend_daily_rollups_pkey" PRIMARY KEY ("day","subjectKind","subjectId")
);

-- CreateIndex
CREATE INDEX "visitors_firstSeen_idx" ON "visitors"("firstSeen");

-- CreateIndex
CREATE INDEX "visitors_lastSeen_idx" ON "visitors"("lastSeen");

-- CreateIndex
CREATE INDEX "visitors_channel_firstSeen_idx" ON "visitors"("channel", "firstSeen");

-- CreateIndex
CREATE INDEX "visitor_links_userId_linkedAt_idx" ON "visitor_links"("userId", "linkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "visit_events_dedupeKey_key" ON "visit_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "visit_events_visitorId_createdAt_idx" ON "visit_events"("visitorId", "createdAt");

-- CreateIndex
CREATE INDEX "visit_events_userId_createdAt_idx" ON "visit_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "visit_events_type_createdAt_idx" ON "visit_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "visit_events_spendSessionId_idx" ON "visit_events"("spendSessionId");

-- CreateIndex
CREATE INDEX "visit_events_createdAt_idx" ON "visit_events"("createdAt");

-- CreateIndex
CREATE INDEX "spend_daily_rollups_subjectKind_subjectId_idx" ON "spend_daily_rollups"("subjectKind", "subjectId");

-- AddForeignKey
ALTER TABLE "visitor_links" ADD CONSTRAINT "visitor_links_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_links" ADD CONSTRAINT "visitor_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_events" ADD CONSTRAINT "visit_events_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_events" ADD CONSTRAINT "visit_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
