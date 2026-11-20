-- 学习事件记录:「今天在学校背了哪些/学了哪些单词」式一句话流水;
-- AI 聊天快记(record_study_event)与学习台手动补一条共用,按 eventDate(本地日)分组展示。
-- 生成方式:同 add_scratch_notes,`prisma migrate diff` 取差量后手写落地(历史迁移 shadow 库回放冲突 P3006)。

-- CreateTable
CREATE TABLE "StudyEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tag" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "eventDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudyEvent_userId_eventDate_idx" ON "StudyEvent"("userId", "eventDate");

-- AddForeignKey
ALTER TABLE "StudyEvent" ADD CONSTRAINT "StudyEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
