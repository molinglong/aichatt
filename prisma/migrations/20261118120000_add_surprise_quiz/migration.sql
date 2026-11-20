-- 突击测试(第 1 波):错题回流来源标记 + 突袭回执表
-- 生成方式同 add_study_event:migrate diff 取差量手写落地(历史迁移 shadow 库回放会撞 P3006)。

-- AlterTable
ALTER TABLE "StudyNote" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "SurpriseQuizAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "items" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "escaped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurpriseQuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SurpriseQuizAttempt_userId_createdAt_idx" ON "SurpriseQuizAttempt"("userId", "createdAt");
