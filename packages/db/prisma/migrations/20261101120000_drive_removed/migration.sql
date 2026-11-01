-- Drive videos and folders the user deleted from the library: a folder sync does not bring them back.
CREATE TABLE "DriveRemoved" (
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriveRemoved_pkey" PRIMARY KEY ("userId","itemId")
);
ALTER TABLE "DriveRemoved" ADD CONSTRAINT "DriveRemoved_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
