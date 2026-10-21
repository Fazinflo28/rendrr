-- AlterTable
ALTER TABLE "AiAction" ADD COLUMN     "via" TEXT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "planRenewsAt" SET DEFAULT (now() + interval '30 days');
