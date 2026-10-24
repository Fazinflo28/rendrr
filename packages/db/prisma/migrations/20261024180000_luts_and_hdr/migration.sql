-- Phase 6: imported colour LUTs, and whether a video's original is HDR (for the check of previews).
ALTER TABLE "Video" ADD COLUMN "hdr" TEXT;

CREATE TABLE "Lut" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lut_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Lut_userId_idx" ON "Lut"("userId");
ALTER TABLE "Lut" ADD CONSTRAINT "Lut_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
