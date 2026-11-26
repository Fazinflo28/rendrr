-- Pins: a comment left on a spot of the picture keeps that spot (shares of the frame, 0-1 from the top left).
ALTER TABLE "ProjectComment" ADD COLUMN "x" DOUBLE PRECISION, ADD COLUMN "y" DOUBLE PRECISION;
ALTER TABLE "ReviewComment" ADD COLUMN "x" DOUBLE PRECISION, ADD COLUMN "y" DOUBLE PRECISION;
