-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "claimCode" TEXT,
ADD COLUMN     "division" TEXT,
ADD COLUMN     "isCoCommissioner" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Team_claimCode_key" ON "Team"("claimCode");

