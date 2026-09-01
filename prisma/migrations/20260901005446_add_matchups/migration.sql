-- CreateTable
CREATE TABLE "Matchup" (
    "id" TEXT NOT NULL,
    "matchupPeriodId" TEXT NOT NULL,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,

    CONSTRAINT "Matchup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Matchup_matchupPeriodId_idx" ON "Matchup"("matchupPeriodId");

-- AddForeignKey
ALTER TABLE "Matchup" ADD CONSTRAINT "Matchup_matchupPeriodId_fkey" FOREIGN KEY ("matchupPeriodId") REFERENCES "MatchupPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matchup" ADD CONSTRAINT "Matchup_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matchup" ADD CONSTRAINT "Matchup_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
