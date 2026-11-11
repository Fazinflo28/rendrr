-- Where a render was made: the user's Mac (the Rendrr Mac app) or Rendrr's cloud server.
ALTER TABLE "Render" ADD COLUMN "made" JSONB;
