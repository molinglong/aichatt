/**
 * MiSans 字体分片同步脚本 —— npm 包 misans 驱动
 *
 * 来源: npm misans@5.x (dsrkafuu 维护, 按小米官方切片范围 ranges-sc.json 子集化,
 *       免费商用; 协议要求注明字体来源 —— 本注释与字体栈引用即为注明)
 *
 * 输入: npm pack misans → package/lib/Normal/ (简体主包, 每字重 1 css + ~300 woff2 分片)
 * 输出: public/fonts-subset/<weight>/ (result.css + 分片, unicode-range 按需加载)
 *
 * 用法:
 *   node scripts/sync-misans.mjs
 *
 * 说明:
 * - 字重映射: Thin→100 / Light→300 / Regular→400 / Medium→500 / Demibold→600
 * - font-display: 包内为 swap, 统一改写为 optional —— 字体晚到不能替换已上屏的
 *   fallback, 否则字宽/基线改变会让已完成段落重新断行(流式输出红线)
 * - woff2 文件名自带内容 hash, 与 next.config.mjs 的 immutable 长缓存策略兼容
 * - 苹方时代为 cn-font-split 本地分片(scripts/build-fonts.mjs), 换源后该脚本退役
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_BASE = path.join(root, 'public', 'fonts-subset')

// 字重 → 包内源文件前缀 映射
const WEIGHTS = [
  { weight: '100', src: 'MiSans-Thin' },
  { weight: '300', src: 'MiSans-Light' },
  { weight: '400', src: 'MiSans-Regular' },
  { weight: '500', src: 'MiSans-Medium' },
  { weight: '600', src: 'MiSans-Demibold' },
]

// 1. npm pack → 临时目录(stderr 透传以显示进度)
//    临时路径与包名均为自建常量, 但仍按安全规范走 argv 传参,
//    不做 shell 字符串拼接; Windows 下解析 npm.cmd 需 shell:true,
//    故对临时目录白名单校验, 拒绝含 shell 元字符的异常环境。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'misans-sync-'))
if (!/^[\w:\\./-]+$/.test(tmp)) {
  console.error(`临时目录含非常规字符, 拒绝继续: ${tmp}`)
  process.exit(1)
}
console.log('→ npm pack misans ...')
const pack = spawnSync('npm', ['pack', 'misans', '--pack-destination', tmp], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'inherit'],
})
if (pack.status !== 0) {
  console.error(`npm pack 失败, 退出码 ${pack.status}`)
  process.exit(1)
}
const tgzName = pack.stdout.split(/\r?\n/).filter((l) => /^[\w.-]+\.tgz$/.test(l.trim())).pop()
if (!tgzName) {
  console.error('npm pack 未产出 tgz')
  process.exit(1)
}

// 2. 解包(Windows 10+ 自带 bsdtar; tar 为原生 exe, argv 直传不经 shell)
const untar = spawnSync('tar', ['-xzf', path.join(tmp, tgzName), '-C', tmp], { stdio: 'inherit' })
if (untar.status !== 0) {
  console.error(`tar 解包失败, 退出码 ${untar.status}`)
  process.exit(1)
}
const libNormal = path.join(tmp, 'package', 'lib', 'Normal')
const pkgVersion = JSON.parse(fs.readFileSync(path.join(tmp, 'package', 'package.json'), 'utf8')).version
console.log(`→ 解包完成, misans@${pkgVersion}`)

// 3. 每字重: 清空目标目录 → css 改名改 font-display → 拷引用到的 woff2
for (const job of WEIGHTS) {
  const outDir = path.join(OUT_BASE, job.weight)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const cssPath = path.join(libNormal, `${job.src}.min.css`)
  if (!fs.existsSync(cssPath)) {
    console.error(`缺少源文件: ${cssPath}`)
    process.exit(1)
  }
  let css = fs.readFileSync(cssPath, 'utf8')
  css = css.replace(/font-display:swap/g, 'font-display:optional')
  const banner = `/* MiSans weight ${job.weight} 分片 —— 来源 npm misans@${pkgVersion}
   (小米官方切片范围子集化, 免费商用, 官方协议: hyperos.mi.com/font)。
   font-display 由包内 swap 改为 optional: 字体晚到不替换已上屏 fallback,
   防止字宽/基线变化导致已完成段落重新断行。
   重新同步: node scripts/sync-misans.mjs */
`
  fs.writeFileSync(path.join(outDir, 'result.css'), banner + css)
  // 只拷 css 实际引用到的分片, 严格配对
  const refs = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1])
  for (const f of refs) fs.copyFileSync(path.join(libNormal, f), path.join(outDir, f))
  const total = refs.reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0)
  console.log(`   ${job.weight} ← ${job.src}: ${refs.length} 分片, 共 ${(total / 1024).toFixed(0)} KB`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('全部完成 → public/fonts-subset/')
