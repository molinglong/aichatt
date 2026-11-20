/**
 * predev 钩子 —— `npm run dev` 的前置步骤。
 *
 * 1) 同步跑 copy-monaco(原 predev 行为);
 * 2) 派生一个「分离进程」的预热任务:等 3456 就绪后把全站页面 + 热点 API
 *    顺序请求一遍,把 Next dev 按需编译的成本在后台付掉。
 *
 * 为什么放这里:dev server 谁都有可能重启(任何会话/手动/脚本),
 * 人工预热总会被忘掉;挂到 predev 后每次启动必然触发,且预热子进程
 * 以 detached 方式脱离 npm 进程树,不会被启动者会话回收
 * (AGENTS.md 环境红线:挂在会话后台任务里的 npm 会被回收)。
 * 日志:scripts/dev-warmup.log;手动预热仍是 `npm run warm`。
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// 1) monaco 拷贝(保持原 predev 语义)
execFileSync(process.execPath, [path.join(__dirname, 'copy-monaco.cjs')], { stdio: 'inherit' })

// 2) 分离派生预热(失败不阻断 dev 启动)
const LOG = path.join(__dirname, 'dev-warmup.log')
try {
  const out = fs.openSync(LOG, 'a')
  const err = fs.openSync(LOG, 'a')
  const child = spawn(process.execPath, [path.join(__dirname, 'dev-warmup.cjs')], {
    detached: true,
    stdio: ['ignore', out, err],
  })
  child.unref()
  fs.appendFileSync(LOG, `\n==== [${new Date().toISOString()}] predev 派生预热进程 pid=${child.pid} ====\n`)
} catch (e) {
  console.warn('[predev] 预热进程派生失败(不影响 dev 启动):', e.message)
}
