-- 试卷逐题索引层：PaperQuestion（方案乙——与练题池 Question 隔离，官方答案齐备后另行回填）。
-- PaperPage = 整卷原件；本表为逐题投影（检索/考点统计/打标都查它）。
-- topics 为受控词表考点标签数组，「考了几次」按标签计数（一题多考点各计一次）。
CREATE TABLE IF NOT EXISTS "PaperQuestion" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "section" TEXT,
    "kind" TEXT NOT NULL,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER NOT NULL,
    "stem" TEXT NOT NULL,
    "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "images" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "answer" TEXT,
    "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaperQuestion_paperId_number_key" ON "PaperQuestion"("paperId", "number");
CREATE INDEX IF NOT EXISTS "PaperQuestion_userId_section_idx" ON "PaperQuestion"("userId", "section");

-- 题干关键词检索走 pg_trgm（与 KnowledgeChunk.content 同款）
CREATE INDEX IF NOT EXISTS "PaperQuestion_stem_trgm_idx" ON "PaperQuestion" USING gin ("stem" gin_trgm_ops);

ALTER TABLE "PaperQuestion" ADD CONSTRAINT "PaperQuestion_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperQuestion" ADD CONSTRAINT "PaperQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
