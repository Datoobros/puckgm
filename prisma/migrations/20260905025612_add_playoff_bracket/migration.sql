-- AlterTable
ALTER TABLE "Matchup" ADD COLUMN     "awaySeed" INTEGER,
ADD COLUMN     "bracketSlot" INTEGER,
ADD COLUMN     "homeSeed" INTEGER;

-- AlterTable
ALTER TABLE "MatchupPeriod" ADD COLUMN     "isPlayoffs" BOOLEAN NOT NULL DEFAULT false;
