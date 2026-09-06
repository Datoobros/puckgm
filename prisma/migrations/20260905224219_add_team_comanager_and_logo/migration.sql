-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "secondManagerClaimCode" TEXT,
ADD COLUMN     "secondManagerUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Team_secondManagerClaimCode_key" ON "Team"("secondManagerClaimCode");
