-- Plan 应用备忘录：长期沉淀的自由文本，与 Todo（待办/排程）分表。
-- 标题可为空，列表回退到正文首行；pinned 置顶，按更新时间倒序。
CREATE TABLE "PlanMemo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanMemo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanMemo_userId_pinned_updatedAt_idx"
    ON "PlanMemo"("userId", "pinned", "updatedAt");

ALTER TABLE "PlanMemo"
    ADD CONSTRAINT "PlanMemo_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
