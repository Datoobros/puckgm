-- AlterTable
ALTER TABLE "IngestRun" ADD COLUMN     "pacerStatsJson" JSONB,
ADD COLUMN     "rateLimitedPhases" TEXT[] DEFAULT ARRAY[]::TEXT[];
