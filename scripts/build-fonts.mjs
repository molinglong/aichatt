/**
 * 苹方字体子集化分片脚本 —— cn-font-split 驱动
 *
 * 输入: 苹方字体/*.otf (全量 ~3 万字形)
 * 输出: src/styles/fonts-subset/<weight>/ (index.css + woff2 分片, unicode-range 按需加载)
 *
 * 用法:
 *   node scripts/build-fonts.mjs            # 全部 5 个字重
 *   node scripts/build-fonts.mjs 400        # 仅指定字重(调试用)
 *
 * 说明:
 * - family 统一命名 'PingFang SC Sub', 与 globals.css 的字体栈
 *   ('PingFang SC' 优先 → macOS 命中系统原生苹方零下载) 配合使用
 * - 换字体源(如商用切换 MiSans)只需改 FONTS 表的 input 路径, 栈与 CSS 不用动
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fontSplit } from 'cn-font-split'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(root, '苹方字体')
const OUT_BASE = path.join(root, 'public', 'fonts-subset')

// 字重 → OTF 源文件 映射
const FONTS = [
  { weight: '100', file: 'pingfangsc-ultralight.otf' },
  { weight: '300', file: 'pingfangsc-light.otf' },
  { weight: '400', file: 'pingfangsc-regular.otf' },
  { weight: '500', file: 'pingfangsc-medium.otf' },
  { weight: '600', file: 'pingfangsc-semibold.otf' },
]

const only = process.argv[2] // 可选: 仅处理某字重
const jobs = only ? FONTS.filter((f) => f.weight === only) : FONTS
if (jobs.length === 0) {
  console.error(`未知字重: ${only} (可选: ${FONTS.map((f) => f.weight).join(', ')})`)
  process.exit(1)
}

for (const job of jobs) {
  const inputPath = path.join(SRC_DIR, job.file)
  const outDir = path.join(OUT_BASE, job.weight)
  if (!fs.existsSync(inputPath)) {
    console.error(`缺少源文件: ${inputPath}`)
    process.exit(1)
  }
  console.log(`→ 分片 ${job.file} → weight ${job.weight}`)
  await fontSplit({
    input: new Uint8Array(fs.readFileSync(inputPath).buffer),
    outDir,
    css: {
      fontFamily: 'PingFang SC Sub',
      fontWeight: job.weight,
      // 字体晚到不能替换已上屏的 fallback:字宽/基线改变会让已完成段落重新断行。
      // optional 保留系统/缓存苹方;慢网超过短暂等待期就沿用 fallback,本页不再 swap。
      fontDisplay: 'optional',
    },
    // 产物精简: 不生成预览图/测试页/报告
    testHtml: false,
    reporter: false,
    previewImage: { name: 'noop', text: 'noop' },
    renameOutputFont: '[hash:6].[ext]',
    silent: true,
  })
  // 清掉无用产物(preview 图片即便不渲染也可能生成)
  for (const junk of ['noop.svg', 'noop.png', 'reporter.bin']) {
    const p = path.join(outDir, junk)
    if (fs.existsSync(p)) fs.rmSync(p)
  }
  const files = fs.readdirSync(outDir)
  const woff2 = files.filter((f) => f.endsWith('.woff2'))
  const total = woff2.reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0)
  console.log(`   完成: ${woff2.length} 个分片, 共 ${(total / 1024).toFixed(0)} KB`)
}
console.log('全部完成 → src/styles/fonts-subset/')
