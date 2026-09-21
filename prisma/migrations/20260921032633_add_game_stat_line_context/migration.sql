-- AlterTable
ALTER TABLE "GameStatLine" ADD COLUMN     "isHome" BOOLEAN,
ADD COLUMN     "lastPeriodType" TEXT,
ADD COLUMN     "opponentAbbrev" TEXT,
ADD COLUMN     "opponentScore" INTEGER,
ADD COLUMN     "teamAbbrev" TEXT,
ADD COLUMN     "teamScore" INTEGER;
