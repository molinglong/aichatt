'use client'

/**
 * 学新讲义卡（A+Alan 案，design/preview-word-learn-flow.html 2026-11-15 挑中）——
 * 新词不自测：讲解直接展开（复用 FlipCard 背面的全部内容块：义项/例句/搭配/助记），
 * 「记住了,考我一个」进小测队列；「还没牢,再看看」重听发音。
 * 讲解本身不提交任何排期 —— 第一次独立回忆发生在拼写小测里，那才是 FSRS 的输入。
 */
import { FlipCard } from './FlipCard'
import { speakWord } from '@/lib/words/speech'
import type { WordQueueItem } from '@/lib/words/types'

export function LearnCard({
  item,
  onMastered,
  onAgain,
}: {
  item: WordQueueItem
  /** 「记住了,考我一个」——进小测队列 */
  onMastered: () => void
  /** 「还没牢,再看看」——重听发音,留在本卡 */
  onAgain: () => void
}) {
  const accent: 'us' | 'uk' = item.phoneticUk && !item.phoneticUs ? 'uk' : 'us'

  return (
    <div className="w-full">
      {/* FlipCard 锁定在背面：讲解内容与复习卡完全同源（义项高亮/例句/搭配/助记编辑） */}
      <FlipCard item={item} flipped onFlip={() => {}} lockedBack />

      <div className="mx-auto mt-4 w-full max-w-[560px]">
        {/* 一行双胶囊（2026-11-16 用户点单）：左还没牢（重听发音留卡），右记住了（进小测） */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              speakWord(item.headword, { lang: accent })
              onAgain()
            }}
            aria-label="还没牢，再看看（重听发音）"
            title="重听发音，留在本卡再看一遍"
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface text-[13px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            还没牢
          </button>
          <button
            type="button"
            onClick={onMastered}
            className="h-11 min-w-0 flex-1 rounded-full bg-accent text-[13px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            记住了
          </button>
        </div>
        <p className="mt-3 text-center text-[11.5px] leading-relaxed text-content-muted">
          全部学完会来一轮拼写小测——第一次独立想起来的结果，才计入记忆排期。
        </p>
      </div>
    </div>
  )
}
