-- The user's own audio files (add_audio): a voice made better outside Rendrr, their own music.
CREATE TABLE "Sound" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sound_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Sound_userId_createdAt_idx" ON "Sound"("userId", "createdAt");
ALTER TABLE "Sound" ADD CONSTRAINT "Sound_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
