-- CreateEnum
CREATE TYPE "DraftType" AS ENUM ('STARTUP', 'ROOKIE');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('SETUP', 'IN_PROGRESS', 'COMPLETE');

-- AlterTable
ALTER TABLE "DraftPick" ADD COLUMN     "draftId" TEXT,
ADD COLUMN     "overallPick" INTEGER;

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "amateurClubName" TEXT,
ADD COLUMN     "amateurLeague" TEXT,
ADD COLUMN     "draftOverallPick" INTEGER,
ADD COLUMN     "draftRound" INTEGER,
ADD COLUMN     "draftYear" INTEGER;

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "type" "DraftType" NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'SETUP',
    "pickTimerSeconds" INTEGER NOT NULL DEFAULT 90,
    "currentPickDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Draft_leagueId_season_type_key" ON "Draft"("leagueId", "season", "type");

-- AddForeignKey
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
