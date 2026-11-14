-- 卷面助手变更计划快照：应用前自动落一份整卷状态，撤销=按快照还原后删行；只留最近一份。
CREATE TABLE "ComposedSnapshot" (
    "id" TEXT NOT NULL,
    "composedId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "totalScore" INTEGER NOT NULL,
    "slots" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComposedSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComposedSnapshot_composedId_createdAt_idx" ON "ComposedSnapshot"("composedId", "createdAt");
