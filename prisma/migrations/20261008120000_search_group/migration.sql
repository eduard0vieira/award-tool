-- AlterTable
ALTER TABLE "Search" ADD COLUMN "groupArgs" TEXT;
ALTER TABLE "Search" ADD COLUMN "groupId" TEXT;
ALTER TABLE "Search" ADD COLUMN "groupLeg" INTEGER;

-- CreateIndex
CREATE INDEX "Search_groupId_idx" ON "Search"("groupId");
