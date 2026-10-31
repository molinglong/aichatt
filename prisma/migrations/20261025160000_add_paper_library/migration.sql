-- 试卷库：整卷 Paper + 分页 PaperPage。
-- 源文件按页存 data/exam-papers/<slug>/page-NN.html，导入器合并为一条 Paper；
-- 题目暂不写入 Question（卷面答案手写/缺失，空答案会污染抽题池），
-- 仅预留 paperId/number/score 供官方答案齐备后回填。
CREATE TABLE IF NOT EXISTS "Paper" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "year" TEXT,
    "region" TEXT,
    "examType" TEXT,
    "totalScore" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "sourceDir" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Paper_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Paper_userId_slug_key" ON "Paper"("userId", "slug");
CREATE INDEX IF NOT EXISTS "Paper_userId_subject_createdAt_idx" ON "Paper"("userId", "subject", "createdAt");

CREATE TABLE IF NOT EXISTS "PaperPage" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "html" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaperPage_paperId_pageNo_key" ON "PaperPage"("paperId", "pageNo");

ALTER TABLE "Paper" ADD CONSTRAINT "Paper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperPage" ADD CONSTRAINT "PaperPage_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Question 预留试卷定位（可空，不影响既有出题链路）
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "paperId" TEXT;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "number" INTEGER;
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "score" INTEGER;
CREATE INDEX IF NOT EXISTS "Question_paperId_number_idx" ON "Question"("paperId", "number");
ALTER TABLE "Question" ADD CONSTRAINT "Question_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE SET NULL ON UPDATE CASCADE;
