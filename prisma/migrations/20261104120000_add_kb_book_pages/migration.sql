-- 课本翻原文：页图目录名 + 页数 + 切块页码
-- KnowledgeDoc.bookKey/pageCount 供书架与阅读器定位 public/kb-pages/{bookKey}/pNNN.webp；
-- KnowledgeChunk.page(1-based) 支撑「检索命中 → 跳转原文页」。按页导入的书才有值，HTML/文本导入保持 null。
ALTER TABLE "KnowledgeDoc" ADD COLUMN "bookKey" TEXT;
ALTER TABLE "KnowledgeDoc" ADD COLUMN "pageCount" INTEGER;
ALTER TABLE "KnowledgeChunk" ADD COLUMN "page" INTEGER;
