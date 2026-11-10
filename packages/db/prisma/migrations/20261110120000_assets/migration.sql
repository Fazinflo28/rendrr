-- Assets page: favourites and the Trash on videos, pictures, elements and audio; elements (logos, overlays) as graphics.
ALTER TABLE "Video" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Video" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Video_userId_deletedAt_idx" ON "Video"("userId", "deletedAt");

ALTER TABLE "Sound" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Sound" ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "Graphic" ADD COLUMN "sourceKey" TEXT;
ALTER TABLE "Graphic" ADD COLUMN "thumbKey" TEXT;
ALTER TABLE "Graphic" ADD COLUMN "sizeBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Graphic" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Graphic" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Graphic_ownerId_kind_idx" ON "Graphic"("ownerId", "kind");
