import { ArrowRight, RotateCw } from 'lucide-react'

interface ContinueRoundBarProps {
  /** 本轮已执行的工具调用次数(取自 metadata.toolCalls 长度,未知时不显示数字) */
  toolCallCount?: number
  /** 熔断态:连续续跑达上限,按钮灰化并附建议文案 */
  exhausted?: boolean
  onContinue: () => void
}

/**
 * 工具步数耗尽后的「继续处理」条(方案 A 定稿):助手消息停在过渡语上、
 * 工具结果已就位未汇总时,挂在消息下方。点击按钮不产生用户消息——走
 * body.continueRound 标记直接续跑一轮(服务端跳过用户消息落库与第 0 步强制
 * 检索,stepBudget 按请求重算=每确认一次拿全新预算)。
 * 视觉口径:通铺灰状态条 + 发丝线,内容层不配环影(DESIGN.md);按钮对齐
 * 消息流内 CTA 惯例(桌面 h-8 / 移动 h-11 全宽,见 MessageBubble 同款)。
 */
export function ContinueRoundBar({ toolCallCount, exhausted = false, onContinue }: ContinueRoundBarProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line bg-surface-muted px-3 py-2.5"
      data-continue-round-bar
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <RotateCw className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden />
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold leading-snug text-content-primary">
            工具调用已达本轮上限
          </span>
          <span className="block text-xs leading-snug text-content-muted">
            {typeof toolCallCount === 'number' ? `已调用 ${toolCallCount} 次` : '已执行多轮工具调用'}
            · 结果已就位，未汇总作答
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={exhausted ? undefined : onContinue}
        disabled={exhausted}
        className={
          exhausted
            ? 'inline-flex h-8 max-md:h-11 max-md:w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg bg-surface-subtle px-4 text-xs font-medium text-content-muted max-md:text-[13.5px]'
            : 'inline-flex h-8 max-md:h-11 max-md:w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-xs font-medium text-accent-foreground max-md:text-[13.5px] transition-opacity hover:opacity-90'
        }
      >
        继续处理
        <ArrowRight className="h-3 w-3" aria-hidden />
      </button>
      {exhausted && (
        <p className="w-full border-t border-dashed border-line pt-2 text-xs leading-relaxed text-content-muted">
          已连续续跑 8 次。建议补充一句要求（如「只要结论」）再继续，避免原地打转。
        </p>
      )}
    </div>
  )
}
