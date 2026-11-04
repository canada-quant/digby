-- AddColumn
ALTER TABLE "crossmodel_projects" ADD COLUMN IF NOT EXISTS "contextState" JSONB;
