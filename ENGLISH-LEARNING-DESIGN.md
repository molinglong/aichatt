# 英语学习模块设计（第一版）

> 状态：方案稿，2026-11-15。数据层已落地，UI 与接口未开工。
> 前置：DESIGN.md（审美红线）/ AGENTS.md（流程红线：先原型后落码、3456 验收、截图自检）。

## 一、定位

一句话：**一本能查的字典 + 一份自己的计划 + 一条语法线，挂在学习台，不新开第二个首页。**

三条硬约束（定了就不再讨论）：

1. **不做词书货架**。词库是字典，谁来都能查；背哪些词由「我的计划」决定，不由产品推荐。
2. **单词只学一次**。一个词一条学习状态，跨词单共享——高考词单和雅思词单重叠的部分不会重复排期。
3. **一个入口**。学习台一张「英语」卡，点进去是全屏工作台；侧栏不新增一级入口。

## 二、数据分层（已落地）

| 层 | 表 | 职责 |
|---|---|---|
| 字典（全局） | `DictEntry` | 词条本体：音标（英美）、词性、释义、例句、搭配、词形变化、考试标签、柯林斯星级、词频 |
| 字典（全局） | `DictList` / `DictListItem` | 词单与顺序（高考 3500 / 雅思核心 / 我自己的清单） |
| 我的 | `UserWord` | 学过/要学的词 + FSRS 状态 + 掌握度；`entryId` 为空表示字典里没有的自由词（划词遇到、手动输入） |
| 我的 | `WordReviewLog` | 每次评级流水：掌握度曲线、正确率、记忆保持率 |
| 我的 | `WordPlan` | 每日新词配额、复习上限、从哪份词单推进、游标到第几个 |

为什么这么切：字典是**数据**，会越来越大、需要反复重导；学习状态是**个人进度**，绝不能因为重导词表被清掉。两张表分开，重导就是安全的。计划只存游标与配额，**不预生成每日任务行**——表不涨、改计划零成本、断了能续。

## 三、每日闭环（目标 15 分钟）

```
学习台 /study
  └─ 「英语」卡：今日新词 15 · 到期 42 · 语法 1   ← 一张卡，一行数字
        └─ 点进去 → 全屏工作台 /study/english
              今天的队列（到期优先，新词按比例穿插）
              一张卡一个动作 → 结束页一行小结
```

结束页只给三行：今天过了多少词、几个要重来、明天大概多少。不做徽章、不做连续打卡弹窗（已有的 streak 组件可复用，但不新增激励体系）。

## 四、卡面三型

| 卡型 | 正面 | 判定 | 用途 |
|---|---|---|---|
| **快认卡** | 英文词 + 音标 | 翻面看释义，自评 4 档：认识 / 模糊 / 不认识 / 秒答 | 主力，通勤碎片时间 |
| **拼写卡** | 中文释义（+ 首字母提示） | 键盘输入英文，程序判分；错一个字母必须重打整词 | 中英双向，防"认得拼不出" |
| **句子卡**（P1） | 一个你读到/写过的句子，目标词挖空 | 填空程序判分；翻面是成分拆解 + 语法点 + 搭配 | 词与法绑定，最有价值也最贵 |

**4 档 → FSRS 映射**：不认识/忘记 = Again(1)、模糊 = Hard(2)、认识 = Good(3)、秒答 = Easy(4)。拼写卡由程序判定：错 = Again，对且超过 8 秒 = Hard，对 = Good，对且 4 秒内 = Easy。判分来源写进 `WordReviewLog.source`，用来比较不同卡型的记忆效果。

发音不接付费 TTS：先用浏览器 `speechSynthesis`（`en-US` / `en-GB` 各一档），快认卡、拼写卡都能听。音质不够再议。

## 五、计划的推进算法

```
取今日队列(userId):
  plan   = WordPlan where userId, active
  due    = UserWord  dueAt <= now, !suspended, 按 dueAt 升序, 上限 plan.dailyReview
  newLeft = plan.dailyNew - 今日已建(createdAt 今天, source=plan)
  if newLeft > 0 and plan.listId:
     items = DictListItem where listId, position >= plan.cursor, 按 position 升序, 取 newLeft*1.5
     跳过 lemma 已在 UserWord 里的（跨词单去重）
     建 UserWord（state=New, dueAt=now, source=plan, entryId）
     plan.cursor = 最后一个用到的 position + 1
  queue = 交错(due, newWords)   // 开头放 2-3 个新词暖场，其余按到期顺序
```

复习上限的意义：某天没来，到期会堆到几百个；`dailyReview` 截断后只还最近的，避免"打开就被劝退"。

## 六、语法线（P1）

不做语法书目录，做**受控语法点表 + 改错卡**：

- 语法点是全局受控表（约 90 个，六大类：时态 / 非谓语 / 从句 / 语态 / 情态与虚拟 / 其他）。AI 只能往这 90 个里归类，**不许自己起名**——否则统计一漂就废。
- 主轴卡是**改错卡**：给一句有病的句子，找出错处并改正，比选择题更接近写作能力。
- 讲解复用现成渲染：`:::sentence` 成分分析块（主语/谓语/定语从句分色、主干加粗），零新增渲染成本。
- 队列暂时与单词**分开**（单词卡 15 分钟已是满负荷），进度各自记、各自 FSRS。

## 七、值得抄的（按价值排序）

| 来源 | 抄什么 | 落到我们哪 |
|---|---|---|
| [qwerty-learner](https://github.com/RealKai42/qwerty-learner) | ① 词库 JSON 结构（`name/trans/usphone/ukphone`）② **拼写错必须重打整词**，防错误肌肉记忆 ③ 卡面「音标 + 发音 + 释义」并排的密度 | 导入器已认它的格式；拼写卡的判分与重打交互照搬 |
| [ECDICT](https://github.com/skywind3000/ECDICT) | ① `stardict.csv` 字段（音标/词频/柯林斯/考试标签）② `exchange` 词形编码（`p:/d:/i:/3:/r:/t:`）→ 查到 `abandoned` 能还原成 `abandon` | 直接作字典底表；`DictEntry.exchange` + 查词时做词形归并 |
| [English-Grammar-Cards](https://github.com/31i45/English-Grammar-Cards) | ① 91 张卡的「形式 + 用法 + 例句」三段式 ② 只挑中国人高频错的点（时态、虚拟、非谓语）③ 单页循环翻卡，没有多余机制 | 语法点表的骨架与卡片模板 |
| [kaoyan-sentence-analyzer](https://github.com/water0523/kaoyan-sentence-analyzer) | ① 层级：主干加粗+底色 / 修饰彩色字 / 从句色块 ② 点成分看解析 ③ 图例可筛选（只看定语从句）④ 粘整篇→断句→逐句拆 | 句子卡背面、阅读页；与我们 `--sent-*` 色板同构 |
| [english-syntax-extension](https://github.com/javaside/english-syntax-extension) | ① **解析结果缓存**（同一句只解析一次，跨页面复用）② 解析不满意可以纠正并单独缓存 ③ 流式逐成分出现 | 语法分析结果入库缓存，省 token；错误反馈按钮 |
| [AI-English-Reader-Extension](https://github.com/Blues-Blues-Blues/AI-English-Reader-Extension) | 划词浮条：翻译 / 拆解 / 收藏，收藏时记来源 | 聊天与课文划词存 `UserWord.source/sourceRef` |
| [Vocab-for-Android](https://github.com/VocabGroup/Vocab-for-Android) | local-first 的导入 + SRS + 备份骨架 | 只当架构对照，不抄它的功能堆叠 |

**不抄**：百词斩式图片记忆、词根词缀拆解花活、打卡社区/排行榜、语法游戏化关卡、"AI 猜你想学"。这些是别人的差异化，不是我们的；我们赢在「用你自己的句子和错误喂同一套复习引擎」。

## 八、分期

- **MVP**：字典已就绪 → 计划 + 今日队列接口 → 快认卡 / 拼写卡 → 学习台入口卡。目标：每天真会打开。
- **P1**：句子卡（挖空 + 成分拆解）、语法点表 + 改错卡、写作批改把生词与错因反哺进队列。
- **P2**：听力听写（TTS）、跟读评分（ASR，成本高）、词形反查与阅读页点词。

## 九、已定参数（2026-11-15 拍板）

- **每日配额**：默认新词 15 / 复习 100，后期进设置页可改（`WordPlan.dailyNew/dailyReview`，接口已支持 PATCH）。
- **语法节奏**：每天 1 个语法点，**独立队列**，不与单词混排；进度各自记。
- **MVP 卡型**：快认卡 + 拼写卡先上；句子卡留到 P1。
- **发音**：先用浏览器 `speechSynthesis`（en-US / en-GB），不接付费 TTS。

## 十、进度（2026-11-15）

| 项 | 状态 |
|---|---|
| 字典 / 我的词 / 计划 六张表 + 迁移 | 已落地 |
| 词库导入器（csv/tsv/txt/json/xlsx，识别 GBK） | 已落地，`npm run words:import` |
| `GET /api/words/queue` 今日队列（按计划推进新词、混排） | 已落地，端到端验过 |
| `POST /api/words/review` 4 档评级 / 拼写判分 | 已落地，端到端验过 |
| `GET/PATCH /api/words/plan` 配额与词单切换 | 已落地 |
| `GET /api/words/lists`、`GET /api/words/lookup?q=` | 已落地（含词形反查：abandoned → abandon） |
| 工作台 UI（方案 A：居中沉浸 + 真卡片） | 已落地：入口卡、`/study/english`、快认卡（牌堆 + 3D 翻转）、拼写卡（整词重打）、结束页 |
| 助记 | 已落地：`DictEntry.mnemonic` + 卡面「助记」块（可现场写）+ 导入列 + `PATCH /api/words/mnemonic` |
| 打印单 | 已落地：`/papers/words?list=&from=&to=&mode=A\|B\|C\|D&mn=1&sh=1&psg=1&dlg=1` —— 词单 A4（对照单/默写纸/折叠单/英译中四版式）+ 末尾附 AI 短文页（取缓存里同一篇；没生成过就现场生成），助记印在释义下方 |
| 智能选词 | 已落地（2026-11-16）：`/papers/words` URL 不带 `list/from/to` 时新词卷按计划自动选——先取「我的词」里 `reps=0` 的待背词（上限 dailyNew），不够再从计划游标往后补词单词（跳过已有 lemma，跨词单去重）；**只读不建行不推游标**，打印不消耗计划。显式给 list/from/to 即手动，`手动选段` 是智能态唯一出口 |
| 复习卷 | 已落地（2026-11-16）：`src=review` 印今日到期词集（dueAt≤now、未暂停、reps>0，按到期升序，上限 dailyReview，与队列复习桶同口径），序号重排 1..n，自由词（entryId 空）用释义快照兜底；工具条「新词/复习」分段切换（原型方案 A：分段前置，复习钮带到期角标） |
| AI 小短文 | 已落地：工作台顶栏「AI 短文」→ `POST /api/words/passage`，用今天队列里的词串一篇高一难度的短故事；**默认再掺 4 个到期复习词 + 3 个明日预习词**（弹层底部可各自关掉），目标词高亮 + 可折叠中文译文；「打印」出 A4（标题 + 正文 + 译文 + 词表） |
| 短文缓存 | 已落地：`WordPassage` 表，`key` = 最终词集（含掺词）排序去重 hash；同组词第二次打开直接复用（弹层标「复用上次」），「重新生成」才覆盖同一条并重写缓存 |
| 划词翻译 | 已落地：全站选中正文文字 → 选区旁「译」按钮 → 小卡翻译（单词先查本地字典，未命中走 AI），可「加入我的词」/复制；输入框与可编辑区除外 |
| 语法线 | 待做：受控语法点表 + 改错卡（参考 `D:\xiaz\项目表\eglish 最新` 的 spaCy 确定性成分解析） |

