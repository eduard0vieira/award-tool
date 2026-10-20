-- CreateTable
CREATE TABLE "QueueItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER,
    "source" TEXT NOT NULL,
    "args" TEXT NOT NULL,
    "legs" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "runAfter" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "nextLeg" INTEGER NOT NULL DEFAULT 0,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "jobId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "QueueItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QueueItem_status_runAfter_idx" ON "QueueItem"("status", "runAfter");
