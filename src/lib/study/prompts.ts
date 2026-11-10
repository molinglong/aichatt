import { z } from 'zod'

/**
 * 学习模式 v2 的提示词与结课工具定义(独立管线专用,与聊天路由的 studyMode 分支分家)。
 *
 * 与旧版的关键差异:
 * - 结课不再依赖正文里的 `<!-- study-complete -->` 标记,模型讲完直接调 finish_study 工具;
 *   用户手动「本题讲完了」走 /complete 接口兜底,两条路都确定性结束。
 * - 推进不再靠正文魔法字符串:每一步的 action(start/continue/easier/solution/followup)
 *   由前端显式传入,本模块把 action 翻译成给模型的指令段。
 * - 旧版的四道结课闸(mid-lesson 句式检测等)不再需要:结构化结束没有"误判正文"问题。
 */

export type StudyStartLevel = 'beginner' | 'partial' | 'review'
export type StudyActionType = 'start' | 'continue' | 'easier' | 'solution' | 'followup' | 'quiz' | 'drill'

export const STUDY_START_LEVELS: StudyStartLevel[] = ['beginner', 'partial', 'review']
export const STUDY_ACTIONS: StudyActionType[] = ['start', 'continue', 'easier', 'solution', 'followup', 'quiz', 'drill']

export function isStudyStartLevel(v: unknown): v is StudyStartLevel {
  return typeof v === 'string' && (STUDY_START_LEVELS as string[]).includes(v)
}

export function isStudyAction(v: unknown): v is StudyActionType {
  return typeof v === 'string' && (STUDY_ACTIONS as string[]).includes(v)
}

/** 结课工具:模型讲完时调用,summary 为给用户的要点总结(3 条以内) */
export const STUDY_FINISH_TOOL_NAME = 'finish_study'
export const studyFinishToolSchema = z.object({
  summary: z.string().min(1).max(600).describe('本次学习的要点总结,面向用户,3 条以内,每条一句'),
})

/** 掌握度上报工具:用户作答变式题/练习后,模型判分并调用(答对=good,答错=again) */
export const STUDY_MASTERY_TOOL_NAME = 'update_mastery'
export const studyMasteryToolSchema = z.object({
  rating: z.enum(['good', 'again']).describe('答对传 good,答错传 again'),
  topic: z.string().max(60).optional().describe('本题考点(可选,便于追踪)'),
})
export type StudyFinishInput = z.infer<typeof studyFinishToolSchema>

/** 学习起点文案(与 /study setup 三选卡一致) */
const LEVEL_RULES: Record<StudyStartLevel, string> = {
  beginner:
    '- 学习起点「完全不会」:直接给出第一个可理解的步骤,不重复问卡在哪;默认每次一小步,不强迫用户作答才能继续。',
  partial:
    '- 学习起点「只会一点」:认真分析用户已提供的思路,指出正确的部分和真实卡点,再从卡点继续;如果用户尚未提供思路,直接给第一层提示,不伪称分析过他的思路,不编造他的错误。',
  review:
    '- 学习起点「都会了复习」:先给一个关键回忆点或自检,不自动剧透完整答案;用户用「直接要答案」时,立即给精简解法,不再设门槛。',
}

/** 逐步讲解的总规则(所有 action 共享) */
const CORE_RULES = [
  '你是导师,目标是让用户真正学会,而不是替他给答案。讲解要口语、直接、一次只讲一小步。',
  '- 一步一卡:每次回复只讲一个步骤,讲完即停。界面有「懂了,继续」按钮,不要要求用户打字说「下一步/继续」,也不要替用户点这个按钮。',
  '- 不要以「现在轮到你」「写出…发我」「你来算一下」这类任务或提问结尾。',
  '- 知识库纪律:涉及具体知识点,先调用 search_knowledge(kind="textbook")再讲解;查询词拆成 2~4 个关键词。讲解中引用了课本内容时,自然带出书名和章节。知识库没命中时照常讲解,但在开头注明「这部分基于通用知识,未经课本核对」。',
  '- 作答判分:用户提交作答(变式题/练习的答案)时,先用文字给出判分结果与简要解析(答对了什么、错在哪),**然后**调用 update_mastery 工具(答对=good,答错=again);判分只依据作答内容本身,不迎合用户。解析文字必须在调用工具之前输出。',
  '- 学情参考(如提供):薄弱考点可在相关时自然带一句,不罗列清单,不提"系统给我看了你的数据"。',
].join('\n')

/** 真题检索规则(search_papers 挂载时注入;题块协议与变式练习共用同一套输出规范) */
const PAPER_RULES = [
  '## 真题检索能力',
  '你拥有 search_papers 工具(检索用户录入的试卷库:真题逐题索引,含卷名/年份/题号/分值/题干/选项/考点标签)。',
  '- 用户问某考点「考过几次/有没有考过/是不是高频」或想要真题时,先调用 search_papers 再回答;query 传 2-4 个考点关键词(优先考纲节名,如「解三角形」「基本不等式」),禁止把整句问题当 query。',
  '- 出真题时逐字转写题干与选项,选择题用 :::choice 块、大题用 :::question 块并紧跟 :::answer 块(仅官方答案存在时写);answer 为 null 的题必须注明「官方答案缺失」,不得编造。题干含 $...$ 公式原样保留,配图用 ![图N](URL) 内联,题块首行写出处「参考 试卷库 卷名 · 第N题」。',
  '- 变式练习/举一反三(quiz/drill)时:检索到同考点真题就优先转写真题原文(标出处),没有合适的再自编。',
  '- 报考次数字时注明口径「按考点标签计,一题多考点各计一次」。与卷子无关的讲解不需要调用。',
].join('\n')

/** 结课规则:finish_study 工具版 */
const FINISH_RULES = [
  '- 完成规则:只有同时满足三条才算本题讲完——①最终答案已经给出 ②没有尚未讲解的后续步骤 ③本回合不是「等你回一句继续」的中间态。满足时给出简短总结,并立即调用 finish_study 工具(summary 传给用户的要点总结),调用后结束回复。',
  '- 未完成规则:只讲了一小步、把「要不要继续」抛回用户、发生错误或仅给出回忆点/自检时,一律不调用 finish_study,也不写「小结」「本题讲完」「先到这里」这类收尾语。',
].join('\n')

/** 每个 action 的指令段(拼在 system 末尾,告诉模型这一步该干什么) */
const ACTION_INSTRUCTIONS: Record<StudyActionType, string> = {
  start: '## 本步动作:开讲\n用户刚提交题目。按学习起点给出第一个可理解的步骤,只讲一小步。',
  continue:
    '## 本步动作:继续\n用户已理解上一步。从当前进度推进到尚未讲解的下一步,不是重讲已有内容,不反复确认。若所有内容已讲完且最终答案已给出,给出收尾总结并调用 finish_study。',
  easier:
    '## 本步动作:换个说法\n用户没懂上一步。用更通俗的方式重新讲解同一个知识点(换类比、放慢、拆更细),不推进新内容,不引入新步骤。',
  solution:
    '## 本步动作:直接要答案\n用户要求完整解法。立即完整给出解法和最终答案,不隐藏任何步骤,然后调用 finish_study。',
  followup: '## 本步动作:追问\n用户就当前内容提了具体问题。直接回答这个追问,沿用已有题目与进度;回答完停在当前位置,一般不推进新步骤,除非追问本身就已覆盖该步。',
  quiz:
    '## 本步动作:变式练习\n出一道考察同一知识点的变式题(考点不变、难度相当,数字/情境必换)。严格按输出协议出题:选择题用 :::choice 块,大题用 :::question 块并紧跟 :::answer 块(含解析)。只出题,不先给答案解析;用户作答后你会收到作答内容并判分。出完题即停,不调用 finish_study。',
  drill:
    '## 本步动作:举一反三(巩固练习会话)\n本会话是错题的举一反三练习:围绕本题考点,持续出变式题让用户练手。本步先出**一道**变式练习题(考点不变、难度相当,数字/情境必换;选择题用 :::choice 块,大题用 :::question 块)。只出题,不给解析,不调用 finish_study。\n用户后续消息是作答时:先判分并调用 update_mastery(对=good,错=again),给简要解析,再出下一道变式题,循环巩固;用户说停或明显掌握时给一句鼓励收尾。',
}

export interface BuildStudySystemPromptOpts {
  startLevel: StudyStartLevel
  action: StudyActionType
  /** 学情回灌段(路由侧查询 StudyNote 后拼好传入;可选) */
  studyContext?: string | null
  /** 试卷库有题时挂 search_papers,注入真题检索纪律(可选,默认不挂) */
  paperSearch?: boolean
}

/** 组装学习模式的 system prompt */
export function buildStudySystemPrompt({ startLevel, action, studyContext, paperSearch }: BuildStudySystemPromptOpts): string {
  const parts: string[] = [
    '## 学习模式(导师,独立管线)',
    `本会话是学习模式:一道题按「一步一卡」推进。当前学习起点「${startLevel}」,本步动作「${action}」。`,
    LEVEL_RULES[startLevel],
    CORE_RULES,
  ]
  if (paperSearch) parts.push(PAPER_RULES)
  parts.push(FINISH_RULES, ACTION_INSTRUCTIONS[action])
  if (studyContext) parts.push(studyContext)
  return parts.join('\n\n')
}

/** 学情回灌段:到期数 + 薄弱点(由路由侧查询后传入文本行) */
export function buildStudyContextLines(dueCount: number, weakNotes: Array<{ topic: string | null; title: string; lapses: number; mastery: number }>): string | null {
  const weakLines = weakNotes.map(
    (n) => `- ${n.topic || n.title.slice(0, 16)}(遗忘 ${n.lapses} 次,掌握度 ${Math.round(n.mastery * 100)}%)`
  )
  const lines = [
    '## 当前学情(仅供自然参考,禁止照单罗列)',
    dueCount > 0
      ? `- 今日复习队列:${dueCount} 张到期卡;有当前题目时不得打断讲解,仅可在收尾时自然邀请`
      : '- 今日复习队列已清空',
    ...(weakLines.length ? ['- 近期薄弱考点:', ...weakLines] : []),
  ]
  return lines.join('\n')
}
