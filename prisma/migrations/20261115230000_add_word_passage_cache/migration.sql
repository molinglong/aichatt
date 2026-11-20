-- AI 短文缓存：同一组目标词只生成一次（重新生成会覆盖同一条，不堆积版本）。
-- key = 目标词排序去重后的 sha256 前 32 位。

-- CreateTable
CREATE TABLE "WordPassage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "words" TEXT[],
    "title" TEXT NOT NULL,
    "titleZh" TEXT,
    "body" TEXT NOT NULL,
    "translation" TEXT,
    "usedWords" JSONB,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WordPassage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WordPassage_userId_createdAt_idx" ON "WordPassage"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WordPassage_userId_key_key" ON "WordPassage"("userId", "key");

-- AddForeignKey
ALTER TABLE "WordPassage" ADD CONSTRAINT "WordPassage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
