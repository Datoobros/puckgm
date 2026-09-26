-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "datesAttempted" TEXT[],
    "gamesFound" INTEGER NOT NULL DEFAULT 0,
    "gamesIngested" INTEGER NOT NULL DEFAULT 0,
    "gamesSkipped" INTEGER NOT NULL DEFAULT 0,
    "statLinesWritten" INTEGER NOT NULL DEFAULT 0,
    "phaseErrorsJson" JSONB,
    "ingestErrorsJson" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestRun_startedAt_idx" ON "IngestRun"("startedAt");
