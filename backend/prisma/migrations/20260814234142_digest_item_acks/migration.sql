-- CreateTable
CREATE TABLE "digest_item_acks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "snoozeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_item_acks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "digest_item_acks_userId_itemKey_key" ON "digest_item_acks"("userId", "itemKey");

-- AddForeignKey
ALTER TABLE "digest_item_acks" ADD CONSTRAINT "digest_item_acks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

