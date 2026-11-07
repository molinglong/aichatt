'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, FileText, PenLine, Plus, Loader2 } from 'lucide-react'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { WriteDocList } from '@/components/write/WriteDocList'
import { WriteEditor } from '@/components/write/WriteEditor'
import { WriteWorkPanel } from '@/components/write/WriteWorkPanel'
import { MobileWorkHead } from '@/components/mobile/MobileWorkHead'
import type { WriteDocSummary } from '@/components/write/types'

/**
 * 写作画布(/write) —— 豆包式「帮我写作」独立工作区。
 * 布局:桌面左列表右编辑器,移动端列表收进抽屉。
 * 列表数据在页面持有(空态/自动选中要用),WriteDocList 只做渲染与增删。
 */
export default function WritePage() {
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  /** 左栏 Tab:文档列表 / 作品设定 */
  const [tab, setTab] = useState<'docs' | 'work'>('docs')

  const { data, isPending } = useQuery({
    queryKey: queryKeys.write.list(),
    queryFn: () => fetchJson<{ docs: WriteDocSummary[] }>('/api/write/docs'),
    staleTime: 30_000,
  })
  const docs = data?.docs ?? []
  const activeDoc = docs.find((d) => d.id === activeId) ?? null

  // 深链定位 /write?doc=<id>(聊天文档卡片跳转):读一次 URL,列表到位后优先选中
  const deepLinkRef = useRef<string | null>(null)
  useEffect(() => {
    deepLinkRef.current = new URLSearchParams(window.location.search).get('doc')
  }, [])

  // 首次加载(或当前文档被删后)自动选中最近更新的文档;深链文档存在则优先
  useEffect(() => {
    if (isPending || activeId || docs.length === 0) return
    const target = deepLinkRef.current
    if (target && docs.some((d) => d.id === target)) {
      deepLinkRef.current = null
      setActiveId(target)
      return
    }
    setActiveId(docs[0].id)
  }, [isPending, activeId, docs])

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    try {
      const doc = await fetchJson<WriteDocSummary>('/api/write/docs', {
        method: 'POST',
        json: { title: '未命名' },
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.list() })
      setActiveId(doc.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '新建失败', { title: '写作画布' })
    } finally {
      setCreating(false)
    }
  }

  // 删除回调:先把该文档从缓存列表剔除,再清空选中 —— 否则自动选中会回落到
  // 已删除的 id(refetch 未返回前 docs 仍是旧列表),进入 404「加载失败」死状态
  function handleDocDeleted(id: string) {
    queryClient.setQueryData<{ docs: WriteDocSummary[] }>(queryKeys.write.list(), (prev) =>
      prev ? { ...prev, docs: prev.docs.filter((d) => d.id !== id) } : prev
    )
    setActiveId((cur) => (cur === id ? null : cur))
  }

  const listNode = (
    <>
      {/* Tab 切换:文档 / 设定 */}
      <div className="shrink-0 flex items-center gap-1 p-2 border-b border-line">
        {(
          [
            { key: 'docs', label: '文档', icon: FileText },
            { key: 'work', label: '设定', icon: BookMarked },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              tab === key
                ? 'bg-surface-muted text-content-primary'
                : 'text-content-muted hover:text-content-secondary hover:bg-surface-subtle'
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'docs' ? (
          <WriteDocList
            docs={docs}
            isPending={isPending}
            activeId={activeId}
            onSelect={setActiveId}
            onDeleted={handleDocDeleted}
          />
        ) : (
          <WriteWorkPanel activeDoc={activeDoc} />
        )}
      </div>
    </>
  )

  return (
    <div className="h-full flex overflow-hidden">
      {/* 桌面左栏 */}
      <aside className="hidden md:flex md:flex-col md:w-[280px] shrink-0 border-r border-line">
        {listNode}
      </aside>

      {/* 移动端抽屉 */}
      {listOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setListOpen(false)} />
          <div className="relative w-[280px] max-w-[82vw] h-full flex flex-col bg-surface border-r border-line shadow-xl">
            {listNode}
          </div>
        </div>
      )}

      {/* 主编辑区 */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {activeId ? (
          <WriteEditor key={activeId} docId={activeId} onOpenList={() => setListOpen(true)} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center max-md:justify-start max-md:px-5">
            <MobileWorkHead icon={PenLine} title="写作画布" subtitle="长篇创作 · AI 加持,人物卡/大纲续写不跑偏" />
            <div className="flex flex-col items-center justify-center gap-3 max-md:my-auto max-md:w-full max-md:rounded-[18px] max-md:border max-md:border-white/55 max-md:bg-surface/80 max-md:p-6 max-md:shadow-[0_8px_24px_rgb(0_0_0_/_0.10)]">
            <div className="w-12 h-12 rounded-2xl bg-surface-subtle flex items-center justify-center">
              <PenLine className="w-5 h-5 text-content-muted" />
            </div>
            <div>
              <div className="text-sm font-medium text-content-primary">开始你的第一部小说</div>
              <p className="mt-1.5 text-xs text-content-muted leading-relaxed max-w-xs">
                新建文档开始写作,选中任意文字可润色、扩写、改写、去AI味;
                长篇建议先在左侧「设定」里建作品与人物卡、大纲,续写时 AI 自动遵守,不怕跨章吃书。
              </p>
            </div>
            <button
              onClick={() => void handleCreate()}
              disabled={creating}
              className="mt-1 flex items-center gap-1.5 px-4 h-9 rounded-lg text-xs font-medium
                bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-60 transition-colors"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              新建文档
            </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
