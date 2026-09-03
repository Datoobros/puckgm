-- AlterTable
ALTER TABLE "League" ADD COLUMN     "waiverPriorityJson" JSONB;

-- AlterTable
ALTER TABLE "RosterSlot" ADD COLUMN     "waiverClaimedAt" TIMESTAMP(3),
ADD COLUMN     "waiverExpiresAt" TIMESTAMP(3);
