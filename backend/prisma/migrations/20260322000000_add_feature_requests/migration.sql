-- CreateTable
CREATE TABLE "user_feature_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_feature_requests_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "user_feature_requests" ADD CONSTRAINT "user_feature_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "user_feature_requests_userId_idx" ON "user_feature_requests"("userId");

-- CreateIndex
CREATE INDEX "user_feature_requests_status_idx" ON "user_feature_requests"("status");
