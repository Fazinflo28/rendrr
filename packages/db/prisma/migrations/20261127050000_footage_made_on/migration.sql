-- Where a video's preview copy and transcript were made: on the user's computer or Rendrr's cloud.
ALTER TABLE "Video" ADD COLUMN "madeOn" JSONB;
