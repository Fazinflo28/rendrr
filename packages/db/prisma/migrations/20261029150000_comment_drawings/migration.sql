-- The Rendrr app in the chat: comments with a drawing on the picture, pictures, the preview they were made on, edits.
ALTER TABLE "ProjectComment" ADD COLUMN "renderId" TEXT;
ALTER TABLE "ProjectComment" ADD COLUMN "drawing" JSONB;
ALTER TABLE "ProjectComment" ADD COLUMN "images" JSONB;
ALTER TABLE "ProjectComment" ADD COLUMN "editedAt" TIMESTAMP(3);
