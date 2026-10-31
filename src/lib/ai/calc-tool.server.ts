import { tool } from 'ai'
import { z } from 'zod'
import { create, all, type MathJsInstance, type MathNode } from 'mathjs'
import { CALC_TOOL_NAME, CALC_INPUT_SCHEMA, type CalcOutput } from './calc-tool'

/**
 * calculate 工具工厂 —— 服务端专用（勿客户端 import：mathjs 体积大且只在这里用）。
 *
 * 执行管线：AST 预检（挡大矩阵/大区间）→ evaluate（BigNumber 32 位）→ 格式化。
 * 安全收口照 mathjs 官方建议：禁掉 import / createUnit / evaluate / compile / reviver
 * 这几个能"写进实例"或"套娃求值"的函数。parse 不能禁——mathjs 的依赖注入会把 override
 * 后的 parse 重新注入 simplify / derivative，它们接受字符串参数时会跟着失效（实测）；
 * parse 本身只产出 AST 节点、不触碰 JS 对象，留着无害。
 * 同步求值会占住事件循环，所以只挡显式常量的大区间；表达式长度由 schema 限 300 字符，
 * 调用方是已登录用户自己的对话，这里防的是模型手滑，不是防攻击。
 */

const FORMAT_PRECISION = 14
const MAX_RESULT_CHARS = 2_000
/** 区间/矩阵构造的显式常量上限：1:100000 直接拒绝，不让它真去建一个十万元素的矩阵 */
const MAX_RANGE_SIZE = 10_000
const MAX_MATRIX_DIM = 500

const MATRIX_BUILDERS = new Set(['zeros', 'ones', 'identity', 'random', 'randomInt', 'resize', 'reshape', 'matrixFromFunction'])

interface CalcRuntime {
  math: MathJsInstance
  /** override 前捕获的原始 evaluate：实例上的同名函数已被替换成抛错版 */
  evaluate: MathJsInstance['evaluate']
  parse: MathJsInstance['parse']
}

let runtime: CalcRuntime | null = null

function getRuntime(): CalcRuntime {
  if (runtime) return runtime
  const math = create(all, { number: 'BigNumber', precision: 32 })
  const evaluate = math.evaluate
  const parse = math.parse
  const fraction = math.fraction
  const disabled = (name: string) => () => {
    throw new Error(`函数 ${name} 已禁用`)
  }
  math.import(
    {
      import: disabled('import'),
      createUnit: disabled('createUnit'),
      evaluate: disabled('evaluate'),
      compile: disabled('compile'),
      reviver: disabled('reviver'),
      // BigNumber 模式下 fraction(1,3) 两参形式不被接受，但模型几乎一定这么写（实测首次就失败重试）；
      // 这里包一层：两参 → 拼成 "n/d" 字符串走原函数，其余形式原样透传。
      fraction: (a: unknown, b?: unknown) =>
        b === undefined ? fraction(a as never) : fraction(`${String(a)}/${String(b)}`),
    },
    { override: true }
  )
  runtime = { math, evaluate, parse }
  return runtime
}

function constantValue(node: MathNode): number | null {
  if (node.type === 'ConstantNode') {
    const v = Number((node as unknown as { value: unknown }).value)
    return Number.isFinite(v) ? v : null
  }
  return null
}

/** 解析后先过一遍 AST：显式常量写出来的大区间 / 大矩阵直接拒绝，防止同步求值把进程拖死 */
function preflight(parse: CalcRuntime['parse'], expression: string): string | null {
  const root = parse(expression)
  let reason: string | null = null
  root.traverse((node) => {
    if (reason) return
    if (node.type === 'RangeNode') {
      const r = node as unknown as { start: MathNode; end: MathNode; step?: MathNode }
      const s = constantValue(r.start)
      const e = constantValue(r.end)
      const st = r.step ? constantValue(r.step) : 1
      if (s !== null && e !== null && st !== null && st !== 0 && Math.abs((e - s) / st) > MAX_RANGE_SIZE) {
        reason = `区间元素超过 ${MAX_RANGE_SIZE} 个`
      }
      return
    }
    if (node.type === 'FunctionNode') {
      const fn = node as unknown as { fn: { name?: string }; args: MathNode[] }
      const name = fn.fn?.name ?? ''
      if (name === 'range') {
        const nums = fn.args.map(constantValue)
        const [s, e, st = 1] = nums
        if (s != null && e != null && st != null && st !== 0 && Math.abs((e - s) / st) > MAX_RANGE_SIZE) {
          reason = `区间元素超过 ${MAX_RANGE_SIZE} 个`
        }
      } else if (MATRIX_BUILDERS.has(name)) {
        if (fn.args.some((a) => (constantValue(a) ?? 0) > MAX_MATRIX_DIM)) {
          reason = `矩阵维度超过 ${MAX_MATRIX_DIM}`
        }
      }
    }
  })
  return reason
}

/** 单值格式化：整数 BigNumber 原样全打（2^64 要看得到 18446744073709551616），其余 14 位有效数字 */
function formatValue(math: MathJsInstance, value: unknown): string {
  if (math.isBigNumber(value) && value.isInteger() && value.precision(true) <= 32) {
    return value.toFixed(0)
  }
  return math.format(value, { precision: FORMAT_PRECISION, lowerExp: -9, upperExp: 21 })
}

function formatResult(math: MathJsInstance, value: unknown): string {
  // 多条语句返回 ResultSet；以 ; 结尾的中间赋值已被 mathjs 自动静默
  if (math.isResultSet(value)) {
    const entries = (value as unknown as { entries: unknown[] }).entries
    return entries.map((v) => formatValue(math, v)).join('\n')
  }
  return formatValue(math, value)
}

/**
 * 逐条表达式 → LaTeX（卡片展开区的"正式书写"）。
 * 按 ; 或换行切段,与 formatResult 的行数口径一致,便于前端把「式 = 值」对齐;
 * 任一条解析失败就整体返回 undefined,让前端回退原始文本(不半截公式、不半截代码)。
 */
function toTexList(parse: CalcRuntime['parse'], expression: string): string[] | undefined {
  const parts = expression
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.length) return undefined
  try {
    const tex = parts.map((p) => parse(p).toTex({ parenthesis: 'auto' }).trim())
    return tex.every(Boolean) ? tex : undefined
  } catch {
    return undefined
  }
}

export function createCalcTool() {
  return tool({
    description:
      '高精度计算器（mathjs）。做任何具体数字运算、代入检验、求导化简、分数通分、组合数、单位换算前先用它算，再把结果写进正文。不会解方程/积分。乘号写 *，幂写 ^，分数写 fraction(1,3)，多条用 ; 分隔并可用变量。',
    inputSchema: z.object(CALC_INPUT_SCHEMA),
    execute: async ({ expression, purpose }): Promise<CalcOutput> => {
      const base: CalcOutput = { expression, ...(purpose ? { purpose } : {}) }
      const { math, evaluate, parse } = getRuntime()
      // 正式书写先备好:evaluate 失败(date() 之类未定义符号)时语法通常仍可解析,
      // 展开区照样能显示用户看懂的式子,配合下面返回的 error 说明为什么没算成
      const tex = toTexList(parse, expression)
      if (tex) base.tex = tex
      try {
        const blocked = preflight(parse, expression)
        if (blocked) {
          return { ...base, error: blocked, note: `表达式被拒绝：${blocked}。请缩小范围或改写。` }
        }
        const value = evaluate(expression)
        let result = formatResult(math, value)
        if (result.length > MAX_RESULT_CHARS) {
          result = `${result.slice(0, MAX_RESULT_CHARS)}…(结果过长已截断)`
        }
        return { ...base, result, note: '以上为精确计算结果，请在正文中直接引用，无需复述调用过程。' }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误'
        console.error(`[${CALC_TOOL_NAME}]`, message, expression)
        return {
          ...base,
          error: message,
          note: `计算失败：${message}。请检查 mathjs 语法（乘号 *、分数 fraction(1,3)）改写后重试一次；仍失败则分步手算并告知用户未经工具验算。`,
        }
      }
    },
  })
}
