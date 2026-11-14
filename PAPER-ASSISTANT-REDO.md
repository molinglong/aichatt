# PAPER-ASSISTANT-REDO.md — 拟卷卷面 AI 助手重置方案

> 2026-11-13 立项。背景：用户反馈卷面右侧 AI 助手「真的很废物」，决定重置。
> 本文档只定方案，不含实现；实现按 AGENTS.md 流程走（本方案 A 不涉可见 UI 改动，免原型；C 涉 UI 必须先出 design/ 原型）。

## 1. 现状架构（重置对象）

调用链：

```
ComposedAssistant.tsx（右缘停靠列，useChat，对话仅前端内存不落库）
  → POST /api/papers/composed/[id]/assistant/route.ts
      ├─ system prompt（卷面结构 + 模式政策 + 口径红线）
      ├─ read_paper / search_candidates / exec_op|propose_op / set_allow_ai
      └─ 四路上下文工具（search_knowledge / search_papers / search_notes / web_search）
  → compose.ts（replaceSlot / listCandidates / insertSlot / …）
  → prisma（ComposedPaper / ComposedSlot / PaperQuestion）
```

两种模式：自动执行（exec_op 服务端真执行）/ 手动（propose_op 出卡用户点执行）。

## 2. 诊断：为什么废

模型层（prompt、工具政策）写得没问题，废在**选题主干太原始**，模型巧妇难为无米之炊：

| # | 短板 | 现状代码 | 后果 |
|---|---|---|---|
| D1 | 换题是盲盒 | `compose.ts replaceSlot`：同桶（section/kind/score）`Math.random` 纯随机抽 | 用户说「换简单点/换道动点的」，它随机换一道，考点难度全不管 |
| D2 | 找题靠死匹配 | `compose.ts listCandidates`：`String.includes` 子串过滤 | 搜「动点」搜不到「二次函数动点问题」；搜不到就谎报「池里没有」 |
| D3 | 模型看摘要挑题 | 候选 stem 截 80 字、卷面结构 stem 截 60 字，不给答案摘要、不给考点 | insert/replace 挑错题；模型对题的理解全是猜 |
| D4 | 已有的好主干没接上 | `paper-tool-server.ts searchPaperQuestions`（ILIKE 粗筛 + 加权精排 + `PaperQuestion.topics` 考点字段 + pg_trgm 索引）**只挂在 chat 管线**，拟卷助手根本没用 | 明明有结构化考点数据和加权检索，白放着 |

另：助手对话不落库（刷新即清），「重置对话」不需要开发，随口向用户说明即可。

## 3. 目标

1. 「换一道 XX 考点的题」「换简单点」类诉求的命中率显著提升（不再盲盒）。
2. 找题从子串死匹配升级为考点加权检索，搜不到时如实、且给出最接近的候选。
3. 模型挑题时看到足够信息（题干完整、带考点、带答案摘要）。
4. 保持既有红线：助手不生成/不改写题目内容；一切修改只从真题池选真操作。

## 4. 方案 A：换题/搜题主干重置（先做，不涉 UI、不动 schema）

### A1 · search_candidates 接上加权检索（修 D2/D4）

- `listCandidates`（compose.ts）的 `q` 分支改为委托 `searchPaperQuestions(userId, q, subject)`：
  粗筛含 topics/stem/options，精排按命中强度加权（考点整串 6 / 题干整串 4 / …）。
- 在其结果上叠加拟卷池口径（`answer != null`、`flagged=false`、`answerSource` 按 allowAiAnswers、排除本卷已用），再做 kind/score 桶过滤。
- 无关键词结果时如实返回空 + 附同桶随机 3 条作「最接近候选」（标注「无考点命中，仅同桶近似」），杜绝谎报。

### A2 · replaceSlot 加意图主干（修 D1）

- `replaceSlot` 增加可选参数 `topicHint?: string`（模型从用户诉求提炼，如「动点」「文言文实词」）：
  1. 同桶候选按考点命中打分（topics/stem 命中数），取**前 5 名随机**（兼顾匹配与防重复）；
  2. 0 命中 → 回退现行纯随机，并在回执里注明「无考点命中，已按同题型同分值随机换入」。
- `exec_op` schema 增加对应 `topicHint` 字段；prompt「操作能力」段教模型：用户说了考点/方向就传，没说就不传。

### A3 · 候选与卷面信息扩容（修 D3）

- `search_candidates` 返回：stem 放宽到 150 字、加 `topics`（前 3 个）、加答案摘要（answer 前 60 字）。
- `read_paper` / system 卷面结构：stem 放宽到 120 字，槽位带 `inlineSource`（AI 拟题槽标注），让模型分得清真题槽和内联槽（内联槽 replace 本来就 no_candidate，现在模型不知道为什么）。

### A4 · 失败回执与 prompt 校准

- `exec_op` 失败回执带 `paper` 摘要（成功路径已带），失败后模型不用再猜当前题号。
- prompt 增补：replace 前若用户给了考点就先 search_candidates 确认池里有货再动手；失败超过一次必须停下如实汇报（已有，重申）。

### A 涉及文件

| 文件 | 改动 |
|---|---|
| `src/lib/papers/compose.ts` | `replaceSlot` 加 topicHint 打分主干；`listCandidates` q 分支接 searchPaperQuestions、返回字段扩容 |
| `src/app/api/papers/composed/[id]/assistant/route.ts` | exec_op/propose_op schema 加 topicHint；prompt 校准；失败回执带 paper |
| schema / UI | **不动**（操作卡渲染字段不变） |

### A 验收标准

- 「第 3 题换成动点相关的」→ 换入题 stem/topics 命中「动点」；池内无命中 → 回执如实说明。
- 「找一道牛顿第二定律的选择题」→ 返回候选全部 topics/stem 命中，且带答案摘要。
- 浅/深双态截图自检（助手卡文案不变，回归确认布局不破）。

## 5. 方案 B：难度档结构化（A 之后做）

D1/D2 的「难度方向」目前只能拿 paperTitle/year 当代理。根治需要难度字段：

1. **schema**：`PaperQuestion` 增加 `difficulty String?`（建议受控三档：`basic` / `standard` / `hard`，注释写明口径=按来源卷性质判定：学考模拟基础卷→basic、正式学考/期末→standard、高考卷/压轴→hard），`@@index([userId, difficulty])`。
2. **回填**：`scripts/` 新增幂等可续跑的回填脚本（只处理 difficulty 为空的行），判定先用确定性规则（来源卷 examType/年份/大题位置），规则判不了的才走 AI 批量打标（走 resolveChatModel 公共池口径，限额）。
3. **入库管线**：`import-exam-paper.cjs`（PaperQuestion 的生成入口）在导入时同步落 difficulty（规则优先）。
4. **消费**：`replaceSlot` 的 topicHint 扩展为 `{ topic?, direction?: 'easier'|'harder'|'same' }`；`search_candidates` 加 difficulty 过滤；`composeForReview`/`composeFromOutline` 的桶匹配可选带难度。

红线：改 schema 后必须 `prisma generate` 并重启 3456 dev server；迁移前先备份（backups/ 已有先例）。

## 6. 方案 C：审卷模式（B 之后，涉 UI 必须先原型）

助手从「听指令干活」升级为「主动审卷」：

- 新只读工具 `review_paper`：汇聚 ①本卷考点覆盖（slots 的 topics）②考频统计（`getPaperTopicStats` 已有）③错题本薄弱考点（studyNote mastery 最低前 N）④难度结构（依赖 B）。
- 产出「审卷建议卡」：如「本卷 0 道题覆盖你的薄弱考点『函数单调性』（近 3 卷考 5 次），建议加 2 道」——建议卡一键转 exec_op/propose_op。
- **UI 改动**：新卡片类型，按 AGENTS.md 硬性流程先在 design/ 出多方案 HTML 原型给用户挑稿，再落 3456 验收 + 双态截图自检。

## 7. 排期与边界

| 顺序 | 内容 | 性质 |
|---|---|---|
| 1 | 方案 A | 纯服务端逻辑，零迁移，最快见效 |
| 2 | 方案 B | schema 迁移 + 回填脚本，需备份 + 重启 dev |
| 3 | 方案 C | 涉 UI，先原型后落码 |

明确不做：助手生成/改写题目内容（口径红线）；助手对话持久化（未立项，需要另说）。
