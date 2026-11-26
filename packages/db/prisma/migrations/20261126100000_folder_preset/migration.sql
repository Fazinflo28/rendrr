-- Client presets (audit #24): what a folder's edits last used, for its next edits.
ALTER TABLE "Folder" ADD COLUMN "preset" JSONB;
