-- CreateTable
CREATE TABLE "user_memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_memory_userId_key" ON "user_memory"("userId");

-- CreateIndex
CREATE INDEX "user_memory_userId_idx" ON "user_memory"("userId");

-- AddForeignKey
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
