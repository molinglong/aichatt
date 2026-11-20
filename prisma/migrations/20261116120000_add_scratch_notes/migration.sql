-- 短期记忆(临时便签):AI 自动判记的「进行中状态」,带过期时间,topic 同用户内唯一。
--   与长期记忆 Memory 分层:短期=会过期的进行时态,长期=不过期的完成时态。
-- 生成方式:同 add_vocabulary,`prisma migrate diff` 取差量后手写落地(历史迁移 shadow 库回放冲突 P3006)。

-- CreateTable
CREATE TABLE "ScratchNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScratchNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScratchNote_userId_topic_key" ON "ScratchNote"("userId", "topic");

-- CreateIndex
CREATE INDEX "ScratchNote_userId_updatedAt_idx" ON "ScratchNote"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ScratchNote" ADD CONSTRAINT "ScratchNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
