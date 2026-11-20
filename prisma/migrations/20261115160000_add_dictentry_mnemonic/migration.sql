-- DictEntry 加助记字段：一句话的联想/口诀，短语尤其需要。
-- 来源可为导入（文件里的「助记」列）、手填，或后续 AI 生成；卡面背面展示。

-- AlterTable
ALTER TABLE "DictEntry" ADD COLUMN     "mnemonic" TEXT;
