-- Phase 22: a video's start timecode, read when it is probed ("" = read, none; null = not read yet).
ALTER TABLE "Video" ADD COLUMN "timecode" TEXT;
