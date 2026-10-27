-- Engine Part 4.4: style files measured from reference videos (analyze_reference), for the AI only.
CREATE TABLE "StyleFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'measuring',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StyleFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StyleFile_userId_createdAt_idx" ON "StyleFile"("userId", "createdAt");
ALTER TABLE "StyleFile" ADD CONSTRAINT "StyleFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
