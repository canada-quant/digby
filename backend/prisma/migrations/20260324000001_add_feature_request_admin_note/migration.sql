-- AlterTable: add adminNote and updatedAt to user_feature_requests
ALTER TABLE "user_feature_requests" ADD COLUMN "adminNote" TEXT;
ALTER TABLE "user_feature_requests" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
