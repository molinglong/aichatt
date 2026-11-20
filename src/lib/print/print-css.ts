/**
 * 打印基建共享层 —— 三个打印产物共用的 @media print 骨架：
 *   拟卷卷面 /papers/composed/[id]、背词卷 /papers/words、英语短文弹窗 PassageDialog。
 *
 * 组装方式：各产物在页内 <style> 注入自己的 @media print 块，公共骨架用这里的
 * 常量/函数拼进去（全局类选择器不能进 CSS 模块，purity 检查要求选择器带本地类）。
 * 两种打印策略：
 *   - 页面级（拟卷/背词卷）：壳豁免链解除裁剪，浏览器原生分页只输出卷面；
 *   - portal（短文弹窗）：打印副本挂 body，body > *:not(副本) 全藏，不需要壳豁免链。
 *
 * 纪律（历史上三处注释的定案，集中一处维护）：
 * - 页边距必须上交 @page：卷面自身 padding 只落第一页顶/最后一页底，
 *   连排跨页后中间页直接顶到纸边（2026-11-12 修「分页奇怪」）；
 * - html/body 与壳容器打印时必须解锁归零，否则内容被 h-screen + overflow-hidden
 *   裁剪链钉在一屏，分页只算出一页（2026-11-11 修「只能打印一张」）；
 * - 壳豁免名单必须与根布局/壳结构同步维护（layout.tsx 的 app-viewport/app-viewport-body
 *   与 (app) shell 的 app-frame/app-shell/app-shell-column/app-main）；
 * - Next dev 报错浮标（nextjs-portal）是 body 直挂元素，不藏会印进纸面；
 * - 黑白打印禁灰阶：这台打印机对灰字一概发虚，文字一律纯黑 #000，
 *   层次靠字号/字重/斜体区分，浅色只留给分隔线/虚线/横线等非文字元素
 *   （2026-11-17 升级定案）。
 */

/** html/body 复位 + dev 浮标隐藏：页面级与 portal 两种策略都要的底座 */
export const PRINT_BASE_CSS = `
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  /* Next dev 报错浮标（chunk 失效 toast）是 body 直挂元素，不挡会印进纸面 */
  nextjs-portal { display: none !important; }
`

/**
 * 壳豁免链：解除根布局两层壳 + (app) shell 的 h-screen/overflow-hidden 裁剪、
 * 隐藏侧栏/顶栏等导航装饰。仅页面级打印策略使用；portal 策略整页直藏，不需要。
 * 名单与根布局/壳结构同步维护（见文件头纪律）。
 */
export const PRINT_SHELL_UNCHAIN_CSS = `
  .app-viewport, .app-viewport-body, .app-frame, .app-shell, .app-shell-column, .app-main {
    height: auto !important; max-height: none !important; overflow: visible !important;
    background: #fff !important; border: none !important; box-shadow: none !important;
    border-radius: 0 !important; padding: 0 !important; margin: 0 !important;
  }
  .app-shell > *:not(.app-shell-column) { display: none !important; }
  .app-shell-column > *:not(.app-main) { display: none !important; }
`

/**
 * @page 口径：A4。边距集中一处：拟卷/背词卷 14mm 15mm（原 sheet padding），
 * 短文弹窗 16mm 15mm（卷头给钤印让位）。
 */
export function printPageCss(margin = '14mm 15mm'): string {
  return `@page { size: A4; margin: ${margin}; }`
}
