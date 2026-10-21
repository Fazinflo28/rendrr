-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "outputSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "planRenewsAt" SET DEFAULT (now() + interval '30 days');
