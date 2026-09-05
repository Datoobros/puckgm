-- AlterTable
ALTER TABLE "League" ADD COLUMN     "currentSeason" INTEGER NOT NULL DEFAULT 2026,
ADD COLUMN     "inviteCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "League_inviteCode_key" ON "League"("inviteCode");

