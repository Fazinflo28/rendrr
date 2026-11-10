-- "Send to Claude" in the Rendrr app: the comments the user sent to a connected AI.
CREATE TABLE "AiHandoff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ai" TEXT NOT NULL,
    "commentIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "noticedAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),

    CONSTRAINT "AiHandoff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiHandoff_userId_seenAt_idx" ON "AiHandoff"("userId", "seenAt");
CREATE INDEX "AiHandoff_projectId_idx" ON "AiHandoff"("projectId");

ALTER TABLE "AiHandoff" ADD CONSTRAINT "AiHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiHandoff" ADD CONSTRAINT "AiHandoff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase lockdown (scripts/supabase-move): no access through the Data API roles, row security on.
ALTER TABLE "AiHandoff" ENABLE ROW LEVEL SECURITY;
