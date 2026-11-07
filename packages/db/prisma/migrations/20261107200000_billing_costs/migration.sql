-- Billing (7-day trial, $5 Starter + pay as you go) and measured costs. Everyone here today starts a 7-day trial now;
-- admins (ADMIN_EMAILS) are moved to "comp" by the API when it starts.
ALTER TABLE "User" ALTER COLUMN "plan" SET DEFAULT 'trial';
ALTER TABLE "User" ALTER COLUMN "storageLimitGB" SET DEFAULT 5;
ALTER TABLE "User" ADD COLUMN "billingStatus" TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE "User" ADD COLUMN "trialEndsAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '7 days');
ALTER TABLE "User" ADD COLUMN "periodStart" TIMESTAMP(3) NOT NULL DEFAULT now();
ALTER TABLE "User" ADD COLUMN "periodEnd" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '7 days');
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "User" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "User" ADD COLUMN "spendLimitCents" INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE "User" ADD COLUMN "bonusExportMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "bonusFootageMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "User" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "billingNotes" JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
UPDATE "User" SET "plan" = 'trial', "storageLimitGB" = 5, "billingStatus" = 'trialing';

CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "billable" DOUBLE PRECISION NOT NULL,
    "refId" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UsageRecord_metric_refId_key" ON "UsageRecord"("metric", "refId");
CREATE INDEX "UsageRecord_userId_createdAt_idx" ON "UsageRecord"("userId", "createdAt");
CREATE INDEX "UsageRecord_metric_createdAt_idx" ON "UsageRecord"("metric", "createdAt");
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobCost" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "queue" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "wallMs" INTEGER NOT NULL DEFAULT 0,
    "cpuSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memGbSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transcribeSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "egressBytes" BIGINT NOT NULL DEFAULT 0,
    "outputBytes" BIGINT NOT NULL DEFAULT 0,
    "costCompute" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costMemory" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costTranscribe" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costEgress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "measured" TEXT NOT NULL DEFAULT 'cgroup',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobCost_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobCost_userId_createdAt_idx" ON "JobCost"("userId", "createdAt");
CREATE INDEX "JobCost_createdAt_idx" ON "JobCost"("createdAt");
CREATE INDEX "JobCost_queue_createdAt_idx" ON "JobCost"("queue", "createdAt");

CREATE TABLE "StorageSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "byKind" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StorageSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StorageSnapshot_userId_day_key" ON "StorageSnapshot"("userId", "day");
CREATE INDEX "StorageSnapshot_day_idx" ON "StorageSnapshot"("day");

CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT,
    "number" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "baseCents" INTEGER NOT NULL DEFAULT 0,
    "usageCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "usageAdded" BOOLEAN NOT NULL DEFAULT false,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "hostedUrl" TEXT,
    "pdfUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingInvoice_stripeInvoiceId_key" ON "BillingInvoice"("stripeInvoiceId");
CREATE INDEX "BillingInvoice_userId_createdAt_idx" ON "BillingInvoice"("userId", "createdAt");
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ClientError" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "url" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ClientError_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientError_fingerprint_key" ON "ClientError"("fingerprint");
CREATE INDEX "ClientError_lastSeen_idx" ON "ClientError"("lastSeen");

CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetId" TEXT,
    "action" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAction_targetId_createdAt_idx" ON "AdminAction"("targetId", "createdAt");

CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);
