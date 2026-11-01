-- Library folders linked to a Google Drive folder (new videos there come in), and images kept as still clips.
ALTER TABLE "LibraryFolder" ADD COLUMN "driveFolderId" TEXT;
ALTER TABLE "LibraryFolder" ADD COLUMN "driveId" TEXT;
ALTER TABLE "LibraryFolder" ADD COLUMN "driveKind" TEXT;
ALTER TABLE "LibraryFolder" ADD COLUMN "driveSubfolders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LibraryFolder" ADD COLUMN "driveSyncedAt" TIMESTAMP(3);
ALTER TABLE "Video" ADD COLUMN "still" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "LibraryFolder_driveFolderId_idx" ON "LibraryFolder"("driveFolderId");
