/**
 * 记忆模块统一出口。
 *
 * 五模块划分（对齐 NextChat fork 验证过的架构）：
 *   store      — Prisma 读写集中层
 *   parser     — LLM 提取结果的宽容解析
 *   extractor  — 调用 LLM 提取记忆的完整流程
 *   dedupe     — 矛盾替换与去重
 *   relevance  — 注入相关性打分
 *   prompt     — 系统提示词格式化
 *   import-parser — 用户粘贴文本导入解析（独立功能）
 *
 * 对外 API 与拆分前保持一致，调用方无需感知内部结构。
 */

export { getCategoryLabel, buildMemorySystemPrompt } from "./prompt"
export { getRelevantMemories, toBigrams, type InjectableMemory } from "./relevance"
export { saveExtractedMemories, upsertMemories, type MemoryWriteItem, type MemoryWriteResult } from "./dedupe"
export { extractAndSaveMemories } from "./extractor"
export { parseMemoryArray, VALID_CATEGORIES, type ExtractedMemoryItem } from "./parser"
export {
  findConflicts,
  findPairConflict,
  detectConflictGroups,
  suppressConflicting,
  extractSlots,
  type ConflictGroup,
  type ConflictHit,
} from "./conflict"
export {
  listMemoryFacts,
  listAllMemoryFacts,
  listMemoryContents,
  createMemory,
  deleteMemory,
  supersedeMemories,
  restoreMemory,
  markKeptBoth,
  clearConflictPeers,
  deleteMemoriesByIds,
  MEMORY_STATUS_ACTIVE,
  MEMORY_STATUS_SUPERSEDED,
  type MemoryFact,
} from "./store"
