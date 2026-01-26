-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "msal_cache" TEXT,
ADD COLUMN     "msal_cache_updated" TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "ThreadTracker_emailAccountId_type_resolved_followUpAppliedAt_id" RENAME TO "ThreadTracker_emailAccountId_type_resolved_followUpAppliedA_idx";
