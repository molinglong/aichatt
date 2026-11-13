-- 智能拟卷（真题重组卷）：ComposedPaper + ComposedSlot，PaperQuestion 加 flagged 存疑拉黑。
-- 重组卷与真题库严格分表（不进考频统计）；槽位 = 一槽一题，position 升序即卷面顺序。
-- position 不设唯一约束：重排会中途撞键，唯一性由写路径事务内整体重排保证。
ALTER TABLE "PaperQuestion" ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ComposedPaper" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "baseSlug" TEXT NOT NULL,
    "onlyChoice" BOOLEAN NOT NULL DEFAULT false,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposedPaper_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComposedSlot" (
    "id" TEXT NOT NULL,
    "composedPaperId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "section" TEXT,
    "kind" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "paperQuestionId" TEXT,
    "historyIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ComposedSlot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComposedPaper_userId_subject_createdAt_idx" ON "ComposedPaper"("userId", "subject", "createdAt");
CREATE INDEX "ComposedSlot_composedPaperId_position_idx" ON "ComposedSlot"("composedPaperId", "position");
CREATE INDEX "ComposedSlot_paperQuestionId_idx" ON "ComposedSlot"("paperQuestionId");

ALTER TABLE "ComposedPaper" ADD CONSTRAINT "ComposedPaper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComposedSlot" ADD CONSTRAINT "ComposedSlot_composedPaperId_fkey" FOREIGN KEY ("composedPaperId") REFERENCES "ComposedPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComposedSlot" ADD CONSTRAINT "ComposedSlot_paperQuestionId_fkey" FOREIGN KEY ("paperQuestionId") REFERENCES "PaperQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
