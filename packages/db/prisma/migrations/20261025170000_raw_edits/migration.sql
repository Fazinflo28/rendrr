-- A new edit starts as the raw footage: no style applied. A reference the user attaches is stored on its own and
-- never applied. Existing edits keep their style (it was applied when they were made).
ALTER TABLE "Project" ALTER COLUMN "styleId" DROP NOT NULL;
ALTER TABLE "Project" ADD COLUMN "reference" JSONB;
