import test from 'node:test'
import assert from 'node:assert/strict'
import { parseExamSegments, parseChoice, parseYellowFish, forceRankLineBreaks, promoteRankRunsToBlocks, type ExamSegment } from '../../src/lib/ai/exam-markdown'

/**
 * 试卷块切分（parseExamSegments）的回归口径：
 *   ① 规范协议（每块独立闭合）必须原样切块，不许被容错逻辑误伤
 *   ② 尾随闭合容错：闭合 ::: 写在内容行尾时拆开入块再闭合
 *   ③ 兜底不吞内容：真正未闭合的块整段还原纯文本
 *   （注：「开块容错／孤儿选项归位」属试卷线另一批未落地改动，本文件暂不覆盖）
 */

const exams = (md: string) => parseExamSegments(md).filter((s): s is Extract<ExamSegment, { type: 'exam' }> => s.type === 'exam')

test('规范协议：choice/answer 各自闭合，切块与正文不受容错影响', () => {
  const segs = exams([
    ':::choice',
    '关于牛顿第一定律，下列说法正确的是',
    'A. 可以通过实验直接验证',
    'D. 揭示力是改变物体运动状态的原因',
    ':::',
    '',
    ':::answer',
    '**答案：D**',
    '',
    'A 错：现实中不存在不受力的物体。',
    ':::',
  ].join('\n'))
  assert.equal(segs.length, 2)
  assert.equal(segs[0].kind, 'choice')
  assert.equal(segs[1].kind, 'answer')
  assert.ok(!segs[0].text.includes(':::answer'), 'choice 块内不得混入答案块开标记')
  assert.ok(!segs[0].text.includes('答案：D'), 'choice 块内不得混入答案（防剧透）')
  assert.ok(segs[1].text.includes('**答案：D**'))
  assert.ok(segs[1].text.includes('A 错'))
})

test('尾随闭合容错：闭合 ::: 写在内容行尾时拆开入块再闭合', () => {
  const segs = exams([':::answer', '**答案：C** 就选它 :::', '后文'].join('\n'))
  const answer = segs.find((s) => s.kind === 'answer')
  assert.ok(answer)
  assert.equal(answer.text.trim(), '**答案：C** 就选它')
})

test('兜底不吞内容：从未闭合也从未另起新块时还原纯文本', () => {
  const segs = parseExamSegments([':::choice', '题干只有这些', '再没有闭合了'].join('\n'))
  assert.ok(segs.every((s) => s.type === 'md'))
  const joined = segs.map((s) => (s.type === 'md' ? s.text : s.text)).join('\n')
  assert.ok(joined.includes(':::choice'))
  assert.ok(joined.includes('题干只有这些'))
})

test('闲鱼分组推荐：三档块各自独立成段，块内标题/条目归位，正文总述不被吞', () => {
  const md = [
    'iPhone 15 现在挂价大概 ¥3100~3280，按成色分三档：',
    ':::yellow-fish',
    '🟢 全新/仅拆封 —— 货源少，价格贴近渠道价才算数',
    '3｜国行未激活全套在保｜价格贴近渠道价才可信',
    '7｜商家充新勿信｜⚠ 查激活日期',
    ':::',
    '',
    ':::yellow-fish',
    '💰 性价比之选 —— 电池 85%+ 无拆修',
    '1｜电池 91% 循环 466｜成色最好',
    '5｜个人自用全原装｜可问细节视频',
    '9｜99新国行有气密｜实体店可到店验机',
    ':::',
    '',
    ':::yellow-fish',
    '⚠️ 瑕疵/换件机 —— 风险自担，务必验机',
    '12｜换过电池功能全好｜⚠ 大修史，砍价 200+',
    ':::',
  ].join('\n')
  const segs = parseExamSegments(md)
  const yf = segs.filter((s): s is Extract<ExamSegment, { type: 'exam' }> => s.type === 'exam' && s.kind === 'yellow-fish')
  assert.equal(yf.length, 3, '三个档位块各自独立成段，不得被容错逻辑误合并')
  const t1 = parseYellowFish(yf[0].text)
  assert.equal(t1.title, '🟢 全新/仅拆封 —— 货源少，价格贴近渠道价才算数', '块内首行作档位标题')
  assert.deepEqual(t1.items.map((i) => i.no), [3, 7])
  const t2 = parseYellowFish(yf[1].text)
  assert.ok(t2.title.startsWith('💰'))
  assert.equal(t2.items.length, 3)
  const t3 = parseYellowFish(yf[2].text)
  assert.equal(t3.items.length, 1)
  assert.equal(t3.items[0].risk, '⚠ 大修史，砍价 200+')
  const mds = segs.filter((s) => s.type === 'md').map((s) => s.text).join('\n')
  assert.ok(mds.includes('¥3100~3280'), '块外总述正文不被吞')
})

test('forceRankLineBreaks: 模型漏写 :::yellow-fish 块时,相邻「序号｜」行兜底硬换行', () => {
  // 真实事故原文(2026-11-05 deepseek-flash):档内条目单换行,markdown 会黏成一段
  const md = [
    '🟢 无拆无修、电池还撑得住(最省心的一档)',
    '',
    '1｜电池 82%、无拆无修、参数报得最全可验货，顺丰包邮｜商家号',
    '5｜国行白，屏幕无划痕，电池健康度高，包邮可自提',
    '4｜电池 78%，成色新，支持当场验机(石家庄)',
    '',
    '💰 换过电池/换过屏(价格最实在)',
    '',
    '13｜电池 100%、循环仅 147 次，只换过电池其余全原',
    '15｜7 月换电池 100%，爱思 86 分，包邮可砍价｜边框磕碰',
  ].join('\n')
  const out = forceRankLineBreaks(md)
  // 相邻条目行之间补了硬换行的两空格
  assert.ok(out.includes('顺丰包邮｜商家号  \n5｜'), '1→5 之间硬换行')
  assert.ok(out.includes('支持当场验机(石家庄)\n\n'), '档末行到空行不加尾随空格污染')
  assert.ok(out.includes('其余全原  \n15｜'), '跨档条目行同样兜底')
  // 非条目行不受影响
  assert.ok(out.includes('🟢 无拆无修、电池还撑得住(最省心的一档)\n'), '档名行不动')
  // 单行「1｜」孤立出现(无相邻行)不加空格
  assert.equal(forceRankLineBreaks('已知 1｜x｜2 求值'), '已知 1｜x｜2 求值')
  // 空串安全
  assert.equal(forceRankLineBreaks(''), '')
})

test('forceRankLineBreaks: 半角竖线与行首空格也认,已有的两空格硬换行不重复堆', () => {
  assert.ok(forceRankLineBreaks('1 | a\n2 | b').includes('1 | a  \n2 | b'), '半角 | 也兜底')
  assert.equal(forceRankLineBreaks('1｜a  \n2｜b'), '1｜a  \n2｜b', '已有硬换行不重复加')
})

test('promoteRankRunsToBlocks: 漏写块语法的分档段落升级合成 :::yellow-fish 块(事故原文回放)', () => {
  // 2026-11-05 deepseek-flash 事故原文:模型完全没写块语法
  const md = [
    '🟢 无拆无修、电池还撑得住(最省心的一档)',
    '',
    '1｜电池 82%、无拆无修、参数报得最全可验货，顺丰包邮｜商家号',
    '5｜国行白，屏幕无划痕，电池健康度高，包邮可自提',
    '4｜电池 78%，成色新，支持当场验机(石家庄)',
    '',
    '💰 换过电池/换过屏(价格最实在)',
    '',
    '13｜电池 100%、循环仅 147 次，只换过电池其余全原',
    '15｜7 月换电池 100%，爱思 86 分，包邮可砍价｜边框磕碰',
  ].join('\n')
  const out = promoteRankRunsToBlocks(md)
  const segs = parseExamSegments(out)
  const yf = segs.filter((s): s is Extract<ExamSegment, { type: 'exam' }> => s.type === 'exam' && s.kind === 'yellow-fish')
  assert.equal(yf.length, 2, '两个档各自合成独立块')
  const t1 = parseYellowFish(yf[0].text)
  assert.equal(t1.title, '🟢 无拆无修、电池还撑得住(最省心的一档)', '档名行被收作块标题')
  assert.deepEqual(t1.items.map((i) => i.no), [1, 5, 4])
  const t2 = parseYellowFish(yf[1].text)
  assert.equal(t2.title, '💰 换过电池/换过屏(价格最实在)')
  assert.deepEqual(t2.items.map((i) => i.no), [13, 15])
})

test('promoteRankRunsToBlocks: 幂等——合成过的文本再跑一遍输出不变', () => {
  const md = ['低价捡漏档', '', '1｜a', '2｜b'].join('\n')
  const once = promoteRankRunsToBlocks(md)
  assert.equal(promoteRankRunsToBlocks(once), once, '二次调用幂等')
  assert.ok(once.includes(':::yellow-fish\n低价捡漏档\n1｜a\n2｜b\n:::'), '标题进块内首行')
})

test('promoteRankRunsToBlocks: 已写好的块原样保留,块内条目不再被二次包裹', () => {
  const md = [
    '总述一句。',
    '',
    ':::yellow-fish',
    '💰 性价比之选',
    '1｜a',
    '2｜b',
    ':::',
  ].join('\n')
  assert.equal(promoteRankRunsToBlocks(md), md, '规范输出零改动')
})

test('promoteRankRunsToBlocks: 代码围栏与长开场白不误伤', () => {
  const fenced = ['```text', '1｜a', '2｜b', '```'].join('\n')
  assert.equal(promoteRankRunsToBlocks(fenced), fenced, '围栏内的条目行不动')
  const longIntro = [
    '这台机器我对比了三天的成交价和当前挂价，把能查到的在售样本按可靠度排了个序，建议你重点看前面几条，后面的当补充参考就好，下面是整理结果：',
    '',
    '1｜a',
    '2｜b',
  ].join('\n')
  const out = promoteRankRunsToBlocks(longIntro)
  assert.ok(!out.includes(':::yellow-fish\n这台机器'), '长开场白(>40字)不被收作标题')
  assert.ok(out.includes(':::yellow-fish\n1｜a'), '条目照常成块,只是无标题')
})

test('promoteRankRunsToBlocks: 单行条目与正文里的「数字｜」不成块', () => {
  assert.equal(promoteRankRunsToBlocks('已知 1｜x｜2 求值'), '已知 1｜x｜2 求值', '单行不合成')
  assert.equal(promoteRankRunsToBlocks('普通段落,没有条目'), '普通段落,没有条目')
})
