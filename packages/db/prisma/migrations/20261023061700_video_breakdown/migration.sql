-- Video breakdown (text + contact sheets for the AI) and reference videos.
ALTER TABLE "Video" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'footage';
ALTER TABLE "FootageAnalysis" ADD COLUMN "breakdown" JSONB;
