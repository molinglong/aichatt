-- DictEntry 加 isPhrase:短语/多词条目标记(如 "according to"),
-- 助记按短语出卡、拼写默写按此排除。默认 false,导入器/回填脚本按 headword 是否含空格写值。
ALTER TABLE "DictEntry" ADD COLUMN     "isPhrase" BOOLEAN NOT NULL DEFAULT false;
