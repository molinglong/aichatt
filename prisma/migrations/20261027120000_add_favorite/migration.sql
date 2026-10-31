-- 收藏(消息快照):与错题本(StudyNote)分家,不参与 FSRS 复习。
-- 只存来源消息的正文/附件快照;消息或会话删除后收藏仍可查看。
CREATE TABLE IF NOT EXISTS "Favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "conversationId" TEXT,
    "conversationTitle" TEXT,
    "role" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- 同一条消息幂等收藏(Postgres 下 NULL 不冲突,允许非消息来源的收藏并存)
CREATE UNIQUE INDEX IF NOT EXISTS "Favorite_userId_sourceMessageId_key" ON "Favorite"("userId", "sourceMessageId");
CREATE INDEX IF NOT EXISTS "Favorite_userId_createdAt_idx" ON "Favorite"("userId", "createdAt");

ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
