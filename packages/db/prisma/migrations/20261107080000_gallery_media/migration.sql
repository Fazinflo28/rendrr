-- A published video's own copy of its export (and a still from it), kept with the gallery item: what the gallery
-- shows and plays, independent of the project's render retention.
ALTER TABLE "GalleryItem" ADD COLUMN "videoKey" TEXT;
ALTER TABLE "GalleryItem" ADD COLUMN "posterKey" TEXT;
ALTER TABLE "GalleryItem" ADD COLUMN "seconds" DOUBLE PRECISION;
