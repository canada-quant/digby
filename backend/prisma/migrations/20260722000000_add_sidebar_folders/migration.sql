-- Sidebar folders: organize chats and coding projects into user-named folders.
-- Deleting a folder un-folders its contents (folderId → NULL via SetNull FK),
-- never deletes them.

-- AlterTable
ALTER TABLE "crossmodel_chats" ADD COLUMN "folderId" TEXT;

-- AlterTable
ALTER TABLE "crossmodel_projects" ADD COLUMN "folderId" TEXT;

-- CreateTable
CREATE TABLE "crossmodel_folders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crossmodel_folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crossmodel_folders_userId_idx" ON "crossmodel_folders"("userId");

-- CreateIndex
CREATE INDEX "crossmodel_chats_folderId_idx" ON "crossmodel_chats"("folderId");

-- CreateIndex
CREATE INDEX "crossmodel_projects_folderId_idx" ON "crossmodel_projects"("folderId");

-- AddForeignKey
ALTER TABLE "crossmodel_chats" ADD CONSTRAINT "crossmodel_chats_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "crossmodel_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crossmodel_projects" ADD CONSTRAINT "crossmodel_projects_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "crossmodel_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crossmodel_folders" ADD CONSTRAINT "crossmodel_folders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
