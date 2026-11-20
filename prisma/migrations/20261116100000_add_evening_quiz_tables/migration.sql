-- 今晚测验：打印事件 + 测验回执（监管之夜，additive 无数据变更）
CREATE TABLE "PrintEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrintEvent_userId_kind_targetId_createdAt_idx" ON "PrintEvent"("userId", "kind", "targetId", "createdAt");

CREATE TABLE "EveningTest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "composedId" TEXT NOT NULL,
    "origTotal" INTEGER NOT NULL,
    "origRight" INTEGER NOT NULL,
    "variantTotal" INTEGER NOT NULL DEFAULT 0,
    "variantRight" INTEGER NOT NULL DEFAULT 0,
    "wrongQuestionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "durationSec" INTEGER,
    "releasedBy" TEXT NOT NULL DEFAULT 'quiz',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EveningTest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EveningTest_userId_createdAt_idx" ON "EveningTest"("userId", "createdAt");
CREATE INDEX "EveningTest_composedId_idx" ON "EveningTest"("composedId");
