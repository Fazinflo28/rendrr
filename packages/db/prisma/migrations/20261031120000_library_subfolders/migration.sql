-- Subfolders in the video library: a folder inside another.
ALTER TABLE "LibraryFolder" ADD COLUMN "parentId" TEXT;
CREATE INDEX "LibraryFolder_parentId_idx" ON "LibraryFolder"("parentId");
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LibraryFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
