-- The deeper footage measurements (Engine Part 2): sound every 10 ms, word alignment, faces and picture measures.
ALTER TABLE "FootageAnalysis" ADD COLUMN "audio" JSONB,
ADD COLUMN "alignment" JSONB,
ADD COLUMN "vision" JSONB,
ADD COLUMN "deepVersion" INTEGER,
ADD COLUMN "deepError" TEXT,
ADD COLUMN "deepAt" TIMESTAMP(3);
