# 在途改动审阅报告（游戏中心竖切 + 壁纸 v3）

审阅日期：2026-10-10 · 审阅人：Qoder · **§1–§6 为只读审阅（未改未提）；§7 记录同日之后落地的搜索第零波**
基线：`main @ c514046` + 工作区未提交改动（12 个已跟踪文件修改 + 1 个未跟踪新文件）

> **先读 §7**：搜索「平台定向」已落地并全绿，且它和游戏车道在 `route.ts` 物理绞在一起——§5 的"先收口再开波次"建议被违反了，提交拆分口径以 §7 为准。

---

## §0 结论（TLDR）

**这波在途改动是一个完整的竖切功能，不是半成品垃圾。** 游戏面具从「人格定义 → 干净车道闸门 → 面板协议解析 → 渲染与样式 → 点击直发 → 大纲健壮性」六层全部接通，内部逻辑自洽，`tsc --noEmit` 退出码 0，`wp-plate` 旧 DOM 与 CSS 同步清理干净（无死代码）。

**唯一的高信号缺口是「干净车道没扫全」：闸门只挡了 13 处，11 段工具规则与约 16 个工具在游戏回合照旧注入，Web 端每轮白烧 ≈ 2.2k token、桌面端 ≈ 4.2k token，并且带来实际出戏行为（模型可以在人生模拟器里帮你建待办、改设置、写文档）。**

可提交性判定：**补完 §4 的第 1、2 项后可提**；否则建议先别提成 `feat`，因为它现在是"能跑但漏气"的状态。

---

## §1 改动全景

体量：`611 insertions(+), 115 deletions(-)`（不含未跟踪的 `builtin-games.ts` 147 行）。按意图分三组：

**A 组｜游戏中心竖切（主体，8 文件）**

| 文件 | 干了什么 |
|---|---|
| `src/lib/ai/builtin-games.ts`（新增，未跟踪） | 1 个游戏面具 `life-sim`「都市人生模拟器」，39 条规则的世界引擎 prompt，内含 `:::gamestatus` / `:::gamechoice` 面板协议铁律（见 84–134 行） |
| `mask-types.ts` / `builtin-masks.ts` | `BuiltinMask` 加 `kind?: 'game'`；`getBuiltinMask` 与 `ALL_BUILTIN_MASKS` 合并游戏池（三处查找链：精选 → 面具库 → 游戏） |
| `mask-resolve.ts` | `ResolvedMask` 透传 `kind`，供 route 层判定 |
| `MaskPickerMenu.tsx` | 新增「游戏」折叠分组，`BUILTIN_GAMES.length > 0` 才挂组（清空即自动隐组，判定正确） |
| `api/chat/route.ts` | 13 处 `isGameMask` 闸门 + 游戏面板钉子（807–830 区） |
| `exam-markdown.ts` | `ExamKind` 加两态；`parseGameStatus`（含「首个空白优先于冒号」的切分判定，防「时间 …07:12」误切）、`parseGameChoice`（剥行首 `- * • >` 与 `A.`/`1.`） |
| `MarkdownRenderer.tsx` | `GameGauge`（纯 SVG 270° 车仪表，零依赖）、`GameStatusCard`、`GameChoiceCard`；`RichMarkdown` 由 JSX map 重写为 nodes 数组 + `flushMd`，游戏对局的连续 md 段合并进 `.game-narrative` 阅读卡 |
| `input-bridge.ts` / `ChatPanel.tsx` | 新增 `INPUT_SEND_EVENT` 直发桥（与既有 insert 桥并列），ChatPanel 挂监听复用 `handleSend` |
| `globals.css` | 新增 30 余条 `.game-*` 规则，变量全走主题 token（`--accent/--surface/--line`），深浅色自适应 |
| `OutlineSidebar.tsx` | 无标题兜底取首行时跳过 `^:::` 块标记行——修的是**游戏与试卷共用**的「面板行被当成大纲节点名」缺陷 |

**B 组｜壁纸可读性 v3（2 文件）**：`WelcomeWallpaperLayer.tsx` + `globals.css`。桌面会话页壁纸改「压暗 + 降饱和 + 模糊」由壁纸层自身挂 `.is-session` 承担，撤掉 ChatPanel 里的 `.wp-plate` 独立纱层。附带一个真 bug 修复：`backdropMode` 初值直读 `localStorage` 导致 SSR 首帧分歧，React 整份替换 document 时会把 layout 首帧写好的 `.dark` 冲掉（实测刷新后 body 回浅色），现改客户端挂载后再出壁纸。

**C 组｜顺手健壮性**：`OutlineSidebar` 的 `:::` 跳过（同上，属 A 组连带）。

---

## §2 已核实安全的点（证据链可复查）

1. **游戏面板钉子不入库、不显示给客户端 —— 结论成立。**
   钉子写在 `messages`（`route.ts:699` = `convertToModelMessages(effectiveRawMessages)` 的输出），而落库与标题生成用的 `userContent` 取自 `rawMessages`（`route.ts:847-848`）。两个数组无共享引用，追加文本只进模型上下文。注释口径与代码一致，没有说谎。
2. **`wp-plate` 清理干净。** `grep -rn "wp-plate" src` 零命中——DOM 与 CSS 同批撤除，无孤儿样式。
3. **逃生舱保留。** `route.ts:1684-1686` 末尾统一追加 `MASK_ESCAPE_HATCH`，游戏面具同样适用，注释所述与代码一致。
4. **非游戏路径零回归。** `RichMarkdown` 里 `isGame` 为 false 时，`flushMd` 走 `mdRun.forEach(→ RichSegment)`，与改前逐个渲染等价。
5. **记忆自动提取已在游戏回合关掉。** `route.ts:2077` 加 `!isGameMask`——沉浸叙事里的「我今年 18 岁」不会污染长期记忆，这条判断很关键且做对了。
6. **`npx tsc --noEmit` 退出码 0。**

---

## §3 缺口与风险

### 高｜干净车道漏挂（最大熵增点）

已挡：记忆注入/档案/澄清/回复长度/课本检索/练题/学习模式/记忆工具/记忆提取（9 类，13 处判定）。
**未挡（游戏回合照旧生效）**：

| 注入段 | 行号 | 字符数 | 游戏里的后果 |
|---|---|---|---|
| AI 设置控制段（`SETTINGS_TOOL_PROMPT` + 快照 + 服务商模型 + 中转站模型） | 922 / 930 / 933 / 936 | 545+ | 模型可发起 `update_settings`，在人生模拟器里改你的推理开关 |
| 面具工坊 `MASK_TOOL_PROMPT` | 957 | 329 | 「帮我生成个面具」会打断对局 |
| `WRITE_DOC_TOOL_PROMPT` / `WRITE_CODE_TOOL_PROMPT` | 1010 / 1017 | 1172 + 879 | 写作/代码落库规则常驻 |
| `TRIP_TOOL_PROMPT` | 1023 | 448 | 玩家说「去旅行」可能触发行程卡 |
| `TODO_TOOL_PROMPT` / `TODO_DISABLED_PROMPT` | 1030 / 1032 | 329 | 待办工具规则 |
| `URL_READER_TOOL_PROMPT`（随 webSearch） | 1120 | 204 | 联网读页 |
| 生图与可视化能力段 | 1066 / 1076 | — | **生图功能是暂缓状态**，游戏回合却仍被诱导生图 |
| 本地文件 / 代码编辑 / 预览检查 / 项目检查 | 1184 / 1209 / 1218 / 1227 | 2069+547+342+670 | 仅桌面且开开关时命中，量最大 |
| MCP 段 | 1133 | 按已配 MCP 数 | — |

实测数字（`npx tsx` 逐段取常量长度求和）：**Web 端 3906 字符 ≈ 2.2k token，桌面全开 7534 字符 ≈ 4.2k token**。这还不含同样挂进 `tools` 映射的约 16 个工具的 JSON schema（每轮上传，未单列）。面具 system prompt 本身已经很长，游戏又是长会话（几十回合），这块浪费是复利式的。

### 中｜面板块吞正文

`exam-markdown.ts` 收尾处（435–442 区）对 `gamestatus` / `gamechoice` 做了「漏写闭合也强制成面板」的兜底。方向对，但副作用是：模型若漏写 `:::gamestatus` 的闭合 `:::`，其后的**整段叙事会被当成状态行解析成 chip**，玩家看不到正文。廉价加固：状态块内出现含句读的长句或超过 N 行时判为漏写闭合，改按叙事渲染。

### 中｜生成中点行动的队列语义未定

`ChatPanel` 监听器直接复用 `handleSend`（1469–1481），生成中点击会**入队**而非打断。玩家手快连点两下就排两条行动。这不是 bug，是需要你拍板的产品语义（打断 vs 排队）。

### 中｜零核验脚本

项目惯例是每波改动配 `tmp-check-*.cjs` + 断言。`scripts` 下 8 个 `tmp-mask-*` 脚本都不覆盖游戏路径：面板协议解析、干净车道闸门、`:::gamestatus` 进度条切分、行动按钮直发，四条都无断言。按你定过的纪律（「改代码重打包后必须小批 smoke test」「断言改判据前先问它在已知坏实现上会不会红」），这块必须补完再提。

### 低

- `toGameNarrativeMd` 的对话判定 `/^[^：\n]{1,12}：「/` 会把「注：「……」」这类行文误转成引用块；纯观感问题。
- `WelcomeWallpaperLayer` 文件头注释写「判据走路由不靠 store」，但 `wallClass` 用了 store 的 `active`（`chatWelcomeActive`）判会话态。口径与实现有出入，注释需改或判定需换。
- `MarkdownRenderer.tsx` 触发 git `LF will be replaced by CRLF` 警告，与仓库行尾规范不一致，提交前统一。
- 游戏池只有 1 个内容：`life-sim` 的 prompt 质量决定这套基建的第一印象，建议实测跑三回合看面板漏写率（钉子那段注释已自陈「实测第 3 回合只写叙事、两块全丢」是修前状态）。

---

## §4 建议收口顺序（都在游戏这条线内，不与主线混提）

1. 补干净车道闸门：`maskGeneratorTool` / `todoTool` / `writeDocTool` / `writeCodeTool` / `tripTool` / `localFileTool` / `codeEditTool` / `previewCheckTool` / `projectCheckTool` / `settingsTool` / `providerModelTool` / `customModelTool` / `deleteCustomModelTool` 及对应 `*_PROMPT` 注入段统一加 `!isGameMask`；生图段（1066/1076）同批。
2. 补 `tmp-check-game-lane.cjs`：断言「游戏回合 system 段里不含 `TODO_TOOL_PROMPT`/`SETTINGS_TOOL_PROMPT` 等字样」+「非游戏回合仍含」（同变量对照，否则断言在坏实现上不会变红，等于没测）。
3. 面板吞正文加固（§3 中）。
4. 生成中点行动的语义拍板（排队 or 打断）。
5. 再补第 2、3 个游戏面具（纯 prompt，零代码）。

## §5 与主线的关系

搜索第零波（平台定向）与这波在途改动**文件重叠仅在 `api/chat/route.ts`**。建议游戏车道收口先落地提交，再开搜索波次，避免同一个 route 文件两条改动绞在一起——route.ts 已 2100+ 行，绞两条线必然出现 §4 纪律里禁止的「同一文件竞态」。

## §6 复核记录

- 已跑：`npx tsc --noEmit`（exit 0）；`git diff --stat` / 逐文件 diff 通读；`grep` 取证 13 处闸门与 37 处 `systemParts.push` 门控归属；`npx tsx` 量 11 段工具规则字符数（脚本 `tmp-measure-game-prompts.ts` 跑完即删，已复核不存在）。
- 未跑：游戏对局真机/浏览器实测（面板渲染、仪表进度条、行动直发、闸门实际 token 前后对比）；`tmp-mask-*` 既有脚本回归（本次未改其覆盖面）。
- 未做：任何文件修改、任何 `git add` / `commit`。

---

## §7 修订（v2，同日）：搜索第零波已落地，§5 的顺序建议被我自己违反了

拍板「搜索第零波」后我按 §5 的建议应先等游戏车道收口，但实际直接在同一工作区开了搜索波次。**结果如实记录：两条线现在在 `route.ts` 内物理绞在一起，已无法按文件拆分提交**，只能走 hunk 级（`git add -p`）或接受一次混合提交。这是我自己给的纪律没执行，写下来防下次再犯。

当前工作区：21 个条目（17 改 + 4 新增），`git diff --stat` = 874 insertions / 134 deletions。

搜索第零波（平台定向）新增/改动 8 处：

| 文件 | 角色 |
| --- | --- |
| `src/lib/ai/search-platforms.ts` (140 行，新) | 口径表单一事实源：9 档（自动/全网 + 7 平台）、域名白名单、脏值落 `auto`；表头写死 2026-10-10 小红书实测结论 |
| `src/lib/ai/search-engines/tavily.ts` | 加可选 `includeDomains` → `include_domains` |
| `src/lib/ai/search-engines/qianfan.ts` | 加可选 `siteFilter` → `search_filter.match.site` |
| `src/lib/ai/search.ts` (156 行，重写) | 用户选定平台时把 `platform` 从 zod schema **整个摘掉**（能力面收窄 > 提示词约束）；站内零结果自动回退全网并在 note 里交代 |
| `src/app/api/chat/route.ts` | `body.searchPlatform` → `toSearchPlatformId` 消毒 → 传工具；`platformGuidance` 按 auto/all/具体平台三态注入 |
| `src/store/chat-store.ts` | `searchPlatform` + `chat:searchPlatform` 持久化（SSR 与脏值都落 `auto`） |
| `src/components/chat/ChatPanel.tsx` | transport getter `get searchPlatform()`；两处 ChatInput 挂载点传参；对比模式**故意不接** |
| `src/components/chat/ChatInput.tsx` | 桌面「知乎 ⌄」胶囊（联网开才出）+ 手机 ⋯ 面板九档 chips；用 document pointerdown 收合，避开 backdrop-blur 内 fixed 退化 |

核验（全部零花费、零写库、零污染）：

- 单元 `tests/unit/search-platform.test.ts` 10/10；全量 `tests/unit/*.test.ts` **70/70 通过、exit 0**（无回归）。
- `npx tsc --noEmit` exit 0（不走管道重取退出码）。
- Playwright `scripts/tmp-check-search-platform.cjs` **22/22**：桌面 1440×900 + 手机 412×915，含「请求体真带上 `searchPlatform=zhihu` 且 `webSearch=true`」（`/api/chat` 截获 postData 后 abort，模型零调用）；截图 `public/preview-search-platform-shots/{desktop,desktop-popover,mobile}.png` 已人眼核对九宫格与选中态。
- 两引擎过滤字段除文档核对外，上一轮已用真 Key 实调验证（结论：千帆小红书 0 命中、Tavily 小红书只回备案/开放平台子域 —— 故小红书不当卖点，表头与 tip 已写明会自动回退）。

两处判据/环境侧的坑，留证据：

1. **刷新后盲点 Globe 会把已恢复的开关点灭**。联网开关与平台口径各走 `chat:webSearch` / `chat:searchPlatform` 两份 localStorage，刷新后双双恢复；核验脚本原先注释写「刷新后需重开一次」是错的，等钮必超时。已改为「钮不在场才补开」，并把它自己变成一条断言（`刷新后联网钮直接恢复`）。
2. **主动 abort 会污染「零控制台报错」**。分流只放走含 `net::ERR_FAILED` 的 console error 并单独计数打印（本轮实测 1 条，正是我 abort 的那次 `/api/chat`）；`pageerror` 与其它 error 一律照算，判据未放宽。

行尾：本轮 `git diff` 的 `LF will be replaced by CRLF` 警告从 1 个文件涨到 4 个（`ChatInput.tsx`、`MarkdownRenderer.tsx`、`search-engines/qianfan.ts`、`chat-store.ts`），提交前统一。

下一步仍按 §4 走游戏车道收口（第 1 条闸门补齐是最大熵增点），提交时 route.ts 需要 hunk 级拆分。
