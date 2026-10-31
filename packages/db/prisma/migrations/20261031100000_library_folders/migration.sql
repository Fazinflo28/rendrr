-- Folders in the video library.
CREATE TABLE "LibraryFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LibraryFolder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LibraryFolder_userId_idx" ON "LibraryFolder"("userId");
ALTER TABLE "LibraryFolder" ADD CONSTRAINT "LibraryFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Video" ADD COLUMN "libraryFolderId" TEXT;
ALTER TABLE "Video" ADD CONSTRAINT "Video_libraryFolderId_fkey" FOREIGN KEY ("libraryFolderId") REFERENCES "LibraryFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
