/*
  Warnings:

  - Added the required column `proposedByTeamId` to the `Trade` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "TradeState" ADD VALUE 'DECLINED';

-- AlterTable
ALTER TABLE "RosterSlot" ADD COLUMN     "tradeAcquiredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "proposedByTeamId" TEXT NOT NULL,
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ALTER COLUMN "reviewEndsAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TradeVeto" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeVeto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeVeto_tradeId_teamId_key" ON "TradeVeto"("tradeId", "teamId");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_proposedByTeamId_fkey" FOREIGN KEY ("proposedByTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeVeto" ADD CONSTRAINT "TradeVeto_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeVeto" ADD CONSTRAINT "TradeVeto_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
