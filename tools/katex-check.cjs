/**
 * 页面公式自检：提取 $...$ / $$...$$ 用 katex 渲染，errors 必须为 0
 * 用法: node tools/katex-check.cjs data/exam-papers/<slug>/page-NN.html
 */
const fs = require('fs')
const path = require('path')
let katex
try { katex = require('katex') } catch (e) { katex = require(path.join(__dirname, '..', 'node_modules', 'katex')) }
const file = process.argv[2]
if (!file || !fs.existsSync(file)) { console.error('用法: node tools/katex-check.cjs <page.html>'); process.exit(2) }
const html = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
let m, ok = 0, errors = 0, rawTags = 0
const texts = []
while ((m = re.exec(body(html)))) texts.push(m[1] !== undefined ? m[1] : m[2])
function body(h) { return h }
for (const t of texts) {
  try { katex.renderToString(t, { throwOnError: true, displayMode: false }); ok++ }
  catch (e) { errors++; console.error('KATEX ERR:', JSON.stringify(t).slice(0, 140), '=>', String(e.message).slice(0, 140)) }
}
const re2 = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
while ((m = re2.exec(html))) {
  const t = m[1] !== undefined ? m[1] : m[2]
  if (/<(\/?)(a|p|div|span|br|img|li|ol|ul|i|b|em|strong|sub|sup|h\d|table|tr|td)\b/i.test(t)) { rawTags++; console.error('MATH 内裸 HTML 标签:', JSON.stringify(t).slice(0, 140)) }
}
console.log(`${path.basename(file)}: formulas=${texts.length} katexOK=${ok} errors=${errors} rawTags=${rawTags}`)
process.exit(errors > 0 || rawTags > 0 ? 1 : 0)
