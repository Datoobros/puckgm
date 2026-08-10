-- CreateEnum
CREATE TYPE "TeamState" AS ENUM ('ACTIVE', 'ORPHAN_FROZEN');

-- CreateEnum
CREATE TYPE "RosterSlotType" AS ENUM ('ACTIVE', 'FARM', 'IR');

-- CreateEnum
CREATE TYPE "TradeState" AS ENUM ('PROPOSED', 'UNDER_REVIEW', 'VETOED', 'PROCESSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TradeItemType" AS ENUM ('PLAYER', 'PICK', 'FAAB');

-- CreateEnum
CREATE TYPE "FaBidResult" AS ENUM ('PENDING', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "WaiverClaimResult" AS ENUM ('PENDING', 'AWARDED', 'CLEARED');

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "dob" TIMESTAMP(3),
    "primaryPosition" TEXT,
    "shoots" TEXT,
    "currentNhlOrg" TEXT,
    "careerNhlGp" INTEGER NOT NULL DEFAULT 0,
    "officialRosterStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSourceId" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,

    CONSTRAINT "PlayerSourceId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameStatLine" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "league" TEXT NOT NULL DEFAULT 'NHL',
    "statsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameStatLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "League" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seasonFounded" INTEGER NOT NULL,
    "settingsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "League_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueSettingsLog" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "LeagueSettingsLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "managerUserId" TEXT NOT NULL,
    "state" "TeamState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterSlot" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "slotType" "RosterSlotType" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "RosterSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftPick" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "originalTeamId" TEXT NOT NULL,
    "currentOwnerId" TEXT NOT NULL,
    "lotteryResult" INTEGER,
    "usedOnPlayerId" TEXT,

    CONSTRAINT "DraftPick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewEndsAt" TIMESTAMP(3) NOT NULL,
    "state" "TradeState" NOT NULL DEFAULT 'PROPOSED',

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeItem" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "fromTeamId" TEXT NOT NULL,
    "toTeamId" TEXT NOT NULL,
    "itemType" "TradeItemType" NOT NULL,
    "playerId" TEXT,
    "draftPickId" TEXT,
    "faabAmount" INTEGER,

    CONSTRAINT "TradeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaabBudget" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "startingAmount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,

    CONSTRAINT "FaabBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaBid" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "targetSlot" "RosterSlotType" NOT NULL,
    "processDate" TIMESTAMP(3) NOT NULL,
    "result" "FaBidResult" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaiverClaim" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "priorityAtClaim" INTEGER NOT NULL,
    "result" "WaiverClaimResult" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaiverClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchupPeriod" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchupPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineupEntry" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "lineupSlot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineupEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionLog" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorTeamId" TEXT,
    "payload" JSONB NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Player_currentNhlOrg_idx" ON "Player"("currentNhlOrg");

-- CreateIndex
CREATE INDEX "PlayerSourceId_playerId_idx" ON "PlayerSourceId"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerSourceId_source_sourceId_key" ON "PlayerSourceId"("source", "sourceId");

-- CreateIndex
CREATE INDEX "GameStatLine_gameDate_idx" ON "GameStatLine"("gameDate");

-- CreateIndex
CREATE UNIQUE INDEX "GameStatLine_playerId_gameId_key" ON "GameStatLine"("playerId", "gameId");

-- CreateIndex
CREATE INDEX "Team_leagueId_idx" ON "Team"("leagueId");

-- CreateIndex
CREATE INDEX "RosterSlot_teamId_slotType_idx" ON "RosterSlot"("teamId", "slotType");

-- CreateIndex
CREATE INDEX "RosterSlot_playerId_idx" ON "RosterSlot"("playerId");

-- CreateIndex
CREATE INDEX "DraftPick_leagueId_season_idx" ON "DraftPick"("leagueId", "season");

-- CreateIndex
CREATE INDEX "Trade_leagueId_state_idx" ON "Trade"("leagueId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "FaabBudget_teamId_season_key" ON "FaabBudget"("teamId", "season");

-- CreateIndex
CREATE UNIQUE INDEX "MatchupPeriod_leagueId_season_periodNo_key" ON "MatchupPeriod"("leagueId", "season", "periodNo");

-- CreateIndex
CREATE UNIQUE INDEX "LineupEntry_teamId_playerId_gameDate_key" ON "LineupEntry"("teamId", "playerId", "gameDate");

-- CreateIndex
CREATE INDEX "TransactionLog_leagueId_type_idx" ON "TransactionLog"("leagueId", "type");

-- CreateIndex
CREATE INDEX "TransactionLog_actorTeamId_idx" ON "TransactionLog"("actorTeamId");

-- AddForeignKey
ALTER TABLE "PlayerSourceId" ADD CONSTRAINT "PlayerSourceId_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameStatLine" ADD CONSTRAINT "GameStatLine_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueSettingsLog" ADD CONSTRAINT "LeagueSettingsLog_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterSlot" ADD CONSTRAINT "RosterSlot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterSlot" ADD CONSTRAINT "RosterSlot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_originalTeamId_fkey" FOREIGN KEY ("originalTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_currentOwnerId_fkey" FOREIGN KEY ("currentOwnerId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_usedOnPlayerId_fkey" FOREIGN KEY ("usedOnPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeItem" ADD CONSTRAINT "TradeItem_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeItem" ADD CONSTRAINT "TradeItem_fromTeamId_fkey" FOREIGN KEY ("fromTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeItem" ADD CONSTRAINT "TradeItem_toTeamId_fkey" FOREIGN KEY ("toTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeItem" ADD CONSTRAINT "TradeItem_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeItem" ADD CONSTRAINT "TradeItem_draftPickId_fkey" FOREIGN KEY ("draftPickId") REFERENCES "DraftPick"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaabBudget" ADD CONSTRAINT "FaabBudget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaBid" ADD CONSTRAINT "FaBid_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaBid" ADD CONSTRAINT "FaBid_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverClaim" ADD CONSTRAINT "WaiverClaim_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverClaim" ADD CONSTRAINT "WaiverClaim_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchupPeriod" ADD CONSTRAINT "MatchupPeriod_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineupEntry" ADD CONSTRAINT "LineupEntry_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineupEntry" ADD CONSTRAINT "LineupEntry_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
