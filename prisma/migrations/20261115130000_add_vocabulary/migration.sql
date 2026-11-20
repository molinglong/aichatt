-- 英语词汇底座:字典 / 我的词 / 计划 三层
--   DictEntry(全局词条) / DictList(词单) / DictListItem(词单条目)
--   UserWord(我的词 + FSRS 学习状态) / WordReviewLog(复习流水)
--   WordPlan(每日新词配额 + 词单游标)
-- 生成方式:此仓库历史迁移在 shadow 库回放时冲突(P3006),改由
--   `prisma migrate diff --from-config-datasource --to-schema` 从真实库取差量，再 migrate deploy 落地。

-- CreateTable
CREATE TABLE "DictEntry" (
    "id" TEXT NOT NULL,
    "headword" TEXT NOT NULL,
    "lemma" TEXT NOT NULL,
    "phoneticUs" TEXT,
    "phoneticUk" TEXT,
    "pos" TEXT,
    "trans" TEXT,
    "definition" TEXT,
    "exchange" TEXT,
    "senses" JSONB,
    "examples" JSONB,
    "collocations" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collins" INTEGER,
    "bncFreq" INTEGER,
    "freqRank" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'import',
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DictEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DictList" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'imported',
    "level" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "sourceFile" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DictList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DictListItem" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "unit" TEXT,

    CONSTRAINT "DictListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserWord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entryId" TEXT,
    "headword" TEXT NOT NULL,
    "lemma" TEXT NOT NULL,
    "trans" TEXT,
    "source" TEXT NOT NULL DEFAULT 'plan',
    "sourceRef" TEXT,
    "stability" DOUBLE PRECISION,
    "difficulty" DOUBLE PRECISION,
    "state" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "lastReviewAt" TIMESTAMP(3),
    "reps" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordReviewLog" (
    "id" TEXT NOT NULL,
    "userWordId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'flip',
    "masteryBefore" DOUBLE PRECISION NOT NULL,
    "masteryAfter" DOUBLE PRECISION NOT NULL,
    "elapsedDays" INTEGER,
    "scheduledDays" INTEGER,
    "ratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WordReviewLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WordPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listId" TEXT,
    "name" TEXT NOT NULL,
    "dailyNew" INTEGER NOT NULL DEFAULT 15,
    "dailyReview" INTEGER NOT NULL DEFAULT 100,
    "order" TEXT NOT NULL DEFAULT 'list',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WordPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DictEntry_lemma_key" ON "DictEntry"("lemma");

-- CreateIndex
CREATE INDEX "DictEntry_freqRank_idx" ON "DictEntry"("freqRank");

-- CreateIndex
CREATE INDEX "DictEntry_headword_idx" ON "DictEntry"("headword");

-- CreateIndex
CREATE UNIQUE INDEX "DictList_slug_key" ON "DictList"("slug");

-- CreateIndex
CREATE INDEX "DictList_level_idx" ON "DictList"("level");

-- CreateIndex
CREATE INDEX "DictListItem_listId_position_idx" ON "DictListItem"("listId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "DictListItem_listId_entryId_key" ON "DictListItem"("listId", "entryId");

-- CreateIndex
CREATE INDEX "UserWord_userId_dueAt_idx" ON "UserWord"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "UserWord_userId_suspended_dueAt_idx" ON "UserWord"("userId", "suspended", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserWord_userId_lemma_key" ON "UserWord"("userId", "lemma");

-- CreateIndex
CREATE INDEX "WordReviewLog_userId_ratedAt_idx" ON "WordReviewLog"("userId", "ratedAt");

-- CreateIndex
CREATE INDEX "WordReviewLog_userWordId_ratedAt_idx" ON "WordReviewLog"("userWordId", "ratedAt");

-- CreateIndex
CREATE INDEX "WordPlan_userId_active_idx" ON "WordPlan"("userId", "active");

-- AddForeignKey
ALTER TABLE "DictListItem" ADD CONSTRAINT "DictListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "DictList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DictListItem" ADD CONSTRAINT "DictListItem_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "DictEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWord" ADD CONSTRAINT "UserWord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserWord" ADD CONSTRAINT "UserWord_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "DictEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordReviewLog" ADD CONSTRAINT "WordReviewLog_userWordId_fkey" FOREIGN KEY ("userWordId") REFERENCES "UserWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordPlan" ADD CONSTRAINT "WordPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordPlan" ADD CONSTRAINT "WordPlan_listId_fkey" FOREIGN KEY ("listId") REFERENCES "DictList"("id") ON DELETE SET NULL ON UPDATE CASCADE;
