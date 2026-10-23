-- Timelines as they were before the sequence model (Phase 2). The API converts each project's timeline at start-up
-- and keeps the old one here first.
CREATE TABLE "TimelineBackup" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER,
    "model" TEXT NOT NULL,
    "timeline" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimelineBackup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimelineBackup_projectId_idx" ON "TimelineBackup"("projectId");
