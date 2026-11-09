-- Where an AI's final goes besides Google Drive (the user's Mac through the Rendrr Mac app). Renders are always made on
-- Rendrr's cloud server; this only records the destination and whether the Mac app took the file.
ALTER TABLE "Render" ADD COLUMN "delivery" JSONB;
