-- Fonts the user adds once and uses by name in graphics, and what a graphic's recording noticed (missing fonts).
ALTER TABLE "Graphic" ADD COLUMN "warnings" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "Font" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 400,
    "style" TEXT NOT NULL DEFAULT 'normal',
    "format" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Font_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Font_userId_family_weight_style_key" ON "Font"("userId", "family", "weight", "style");
ALTER TABLE "Font" ADD CONSTRAINT "Font_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
