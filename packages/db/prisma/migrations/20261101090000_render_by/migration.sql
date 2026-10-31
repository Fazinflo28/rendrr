-- Who asked for a render: "user" (the editor, the review page, the app in the chat) or the AI ("claude", "chatgpt").
-- One preview per change from an AI is counted from these.
ALTER TABLE "Render" ADD COLUMN "by" TEXT NOT NULL DEFAULT 'user';
