-- Digby Kids: child sub-accounts under a parent User.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isChild" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "childAge" INTEGER,
ADD COLUMN     "childGuardrails" TEXT,
ADD COLUMN     "parentPinHash" TEXT,
ADD COLUMN     "parentId" TEXT;

-- CreateIndex
CREATE INDEX "users_parentId_idx" ON "users"("parentId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
