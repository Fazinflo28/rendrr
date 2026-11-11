-- The original of footage added in the Rendrr Mac app stays on that Mac: what it is (size, picture, sound).
ALTER TABLE "Video" ADD COLUMN "macOriginal" JSONB;
