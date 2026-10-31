import { z } from 'zod'

/**
 * calculate —— 内置验算器（isomorphic 常量模块）。
 *
 * 解决"模型嘴会讲、手不会算"的问题：凡具体数字运算、代入检验、最终答案，
 * 先交给 mathjs 精确算一遍再写进正文。高精度（BigNumber 32 位有效数字），
 * 0.1+0.2 不会算成 0.30000000000000004；支持分数、根式、三角、对数、组合数、
 * 矩阵、求导、化简、单位换算。它不会解方程/积分，这类交给 Wolfram MCP 或分步手算。
 *
 * 拆分铁律：本文件零服务端依赖（mathjs 全在 calc-tool.server.ts），
 * 客户端 ToolCallCard 只允许 import 本模块。
 */

export const CALC_TOOL_NAME = 'calculate'

/** 表达式长度上限：防止一次塞进整页算式把事件循环拖死 */
export const CALC_MAX_EXPRESSION_CHARS = 300

export const CALC_TOOL_PROMPT = [
  '## 验算能力 calculate',
  '你拥有 calculate 工具（mathjs 高精度计算器）。以下场景**必须先调用再写结论**，不得口算：',
  '- 任何具体数字的四则/幂/根式/三角/对数运算，以及分数通分、化简',
  '- 解完方程后把解代回原式检验；核对用户给出的计算结果对不对',
  '- 求导、多项式化简（derivative("x^2+3x","x")、simplify("2x+3x")）',
  '- 组合数/阶乘/最大公约数（combinations(5,2)、12!、gcd(12,18)）、单位换算（5 km to m）',
  '语法为 mathjs：乘号写 *，幂用 ^，分数用 fraction(1,3)，可用 ; 分隔多条并用变量（a=3; b=4; sqrt(a^2+b^2)）。',
  '它不会解方程、不定积分、不等式——这类分步手算，并在关键数值处用它核对。',
  '调用后在正文自然引用结果即可，不要复述"我调用了工具"；工具报错就改写表达式重试一次，仍失败则如实说明未验算。',
].join('\n')

/** zod 字段集合（isomorphic，服务端工厂用 z.object 包成 inputSchema） */
export const CALC_INPUT_SCHEMA = {
  expression: z
    .string()
    .min(1)
    .max(CALC_MAX_EXPRESSION_CHARS)
    .describe('mathjs 表达式，可用 ; 分隔多条，如 "2*5+3" / "fraction(1,3)+fraction(1,6)" / "derivative(\\"x^2\\",\\"x\\")"'),
  purpose: z
    .string()
    .max(40)
    .optional()
    .describe('一句话说明这步在算什么（给用户看的标签，如"代入检验 x=5"），可省略'),
}

/** 工具 output 形状（服务端 execute 返回，前端卡片渲染） */
export interface CalcOutput {
  expression: string
  purpose?: string
  /**
   * 每条表达式的 LaTeX（与 expression 按 ; 切分后逐条对齐），卡片展开区据此渲染正式书写。
   * 由服务端 mathjs AST 的 toTex() 产出——客户端包不能引 mathjs，所以这里只传结果。
   * 语法不合法或历史旧消息缺此字段时，前端回退为原始表达式文本。
   */
  tex?: string[]
  /** 格式化后的结果；多条表达式按行拼接 */
  result?: string
  error?: string
  note?: string
}
