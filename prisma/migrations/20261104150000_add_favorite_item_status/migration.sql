-- 商品收藏增加下架/现价检测字段:status 三态(onSale/off/unknown)+状态原文+现价+检测时间。
-- unknown 表示"查了但没拿到可信结论"(超时/风控/输出异常),UI 不当作下架误标。
ALTER TABLE "FavoriteItem" ADD COLUMN "status" TEXT;
ALTER TABLE "FavoriteItem" ADD COLUMN "statusText" TEXT;
ALTER TABLE "FavoriteItem" ADD COLUMN "checkedPrice" DOUBLE PRECISION;
ALTER TABLE "FavoriteItem" ADD COLUMN "checkedAt" TIMESTAMP(3);
