import styles from './PaperBrandSeal.module.css'

/**
 * 卷面右上角品牌钤印「墨印」(design/preview-paper-brandmark.html B案,2026-11-15 挑中)。
 * 启动页同源八形标 + 红点,整标做红钤(细红框 + 微倾 4°)。
 * 纯装饰不落库;纸面恒白不随主题;屏显品牌红,黑白打印恢复纯黑(卷面纪律:打印禁灰阶)。
 * 范围:拟卷卷面(composed/[id]);真题卷答题页(ExamRun)不落标 —— 那是原卷真题,不是「拟的卷」。
 * 父容器需 position:relative(拟卷 .sheet 已具备)。
 */
export function PaperBrandSeal() {
  return (
    <div className={styles.seal} aria-hidden="true">
      <svg className={styles.mark} viewBox="0 0 128 98" fill="none">
        <path d="M60 6 C46 32 28 60 8 90" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
        <path d="M68 24 C80 46 98 70 120 90" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
        <circle cx="86" cy="12" r="8" fill="currentColor" />
      </svg>
      <span className={styles.name}>aichatt</span>
    </div>
  )
}
