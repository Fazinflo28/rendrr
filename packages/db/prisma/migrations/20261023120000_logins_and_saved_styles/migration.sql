-- More logins per account, and the reference video a style saved by an AI came from.
CREATE TABLE "UserLogin" (
    "clerkId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserLogin_pkey" PRIMARY KEY ("clerkId")
);
CREATE INDEX "UserLogin_userId_idx" ON "UserLogin"("userId");
ALTER TABLE "UserLogin" ADD CONSTRAINT "UserLogin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Style" ADD COLUMN "sourceVideoId" TEXT;

-- One-time fix (2026-10-23): the owner signed in to the AI connector with a Google login that Rendrr had not seen,
-- so it got a new, empty account. Their edits (for example "IMG_0033 edit") live in their website account.
-- Link that Google login to the website account, and remove the empty account only while it is still empty.
-- Does nothing in any other database.
DO $$
DECLARE
  login TEXT := 'user_3L5M6UOmxsqiH8rJz6fCjKrcxDN';
  owner_id TEXT;
  empty_id TEXT;
BEGIN
  SELECT "userId" INTO owner_id FROM "Project" WHERE id = 'cmvkonv8t000nrw4lufqt1x3l';
  IF owner_id IS NULL THEN RETURN; END IF;
  SELECT id INTO empty_id FROM "User" WHERE "clerkId" = login;
  IF empty_id = owner_id THEN RETURN; END IF;
  IF empty_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "Video" WHERE "userId" = empty_id)
      OR EXISTS (SELECT 1 FROM "Project" WHERE "userId" = empty_id)
      OR EXISTS (SELECT 1 FROM "Style" WHERE "ownerId" = empty_id)
      OR EXISTS (SELECT 1 FROM "Graphic" WHERE "ownerId" = empty_id)
      OR EXISTS (SELECT 1 FROM "Reference" WHERE "userId" = empty_id)
      OR EXISTS (SELECT 1 FROM "Review" WHERE "userId" = empty_id)
      OR EXISTS (SELECT 1 FROM "GalleryItem" WHERE "userId" = empty_id)
      OR EXISTS (SELECT 1 FROM "DriveConnection" WHERE "userId" = empty_id) THEN
      RAISE NOTICE 'The second login has its own data, so it was not linked.';
      RETURN;
    END IF;
    -- Its empty "My edits" folder, connector status and usage log go with it (all cascade).
    DELETE FROM "User" WHERE id = empty_id;
  END IF;
  INSERT INTO "UserLogin" ("clerkId", "userId") VALUES (login, owner_id) ON CONFLICT ("clerkId") DO NOTHING;
END $$;
