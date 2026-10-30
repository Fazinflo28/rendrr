-- When a graphic's code or a recording of it was last replaced: a preview made before it is out of date.
ALTER TABLE "Graphic" ADD COLUMN "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Graphic" SET "changedAt" = "createdAt";
