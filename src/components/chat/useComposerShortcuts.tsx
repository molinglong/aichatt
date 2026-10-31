'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject, type KeyboardEvent } from 'react'
import { ArrowLeft, Brain, Check, ChevronRight, Drama, Globe, Layers, Loader2, MessageSquare, Paperclip, Search, X, type LucideIcon } from 'lucide-react'
import { BUILTIN_MASKS } from '@/lib/ai/builtin-masks'
import { BUILTIN_GAMES } from '@/lib/ai/builtin-games'
import type { MaskDTO } from '@/lib/ai/mask-types'
import type { ModelDefinition } from '@/lib/ai/types'
import { getShortcutToken, replaceShortcutToken, MAX_CHAT_REFERENCES, type ShortcutToken, type ConversationReference } from '@/lib/chat-shortcuts'
import { searchShortcutConversations, loadConversationReference, type ConversationChoice } from '@/lib/chat-shortcut-references'
import { useBackToClose } from '@/hooks/useBackToClose'
import styles from './ComposerShortcuts.module.css'

type Category = 'model' | 'mask' | 'conversation' | null
type ShortcutGroup = 'action' | 'conversation' | 'file'
const GROUP_LABELS: Record<ShortcutGroup, string> = { action: '操作', conversation: '聊天记录', file: '文件附件' }
interface Options {
  input: string
  setInput: Dispatch<SetStateAction<string>>
  textareaRef: RefObject<HTMLTextAreaElement>
  scopeKey: string
  isLoading: boolean
  models: ModelDefinition[]
  selectedModel: string
  onModelChange: (id: string) => void
  compareMode: boolean
  deepThink: boolean
  onDeepThinkChange: (value: boolean) => void
  webSearch: boolean
  webSearchAvailable: boolean
  onWebSearchChange?: (value: boolean) => void
  maskId?: string | null
  userMasks?: MaskDTO[]
  /** 面具面板已下载的内置面具；未下载的库/新面具不进入快捷选择 */
  installedMasks?: readonly { id: string; name: string; description: string }[]
  onMaskChange?: (id: string | null) => void
  onUpload: () => void
  onOpen: () => void
  references: ConversationReference[]
  setReferences: Dispatch<SetStateAction<ConversationReference[]>>
}
interface Item {
  id: string
  label: string
  keywords?: string
  group: ShortcutGroup
  headingGroup?: ShortcutGroup
  icon: LucideIcon
  detail?: string
  category?: Exclude<Category, null>
  selected?: boolean
  action?: () => void
  conversation?: ConversationChoice
}

/** 两个符号共用一份注册表与弹层；仅默认分组顺序不同。 */
export function useComposerShortcuts(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const [token, setToken] = useState<ShortcutToken | null>(null)
  const [category, setCategory] = useState<Category>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [collapsedGroups, setCollapsedGroups] = useState<Partial<Record<ShortcutGroup, boolean>>>({})
  const [searchCollapsed, setSearchCollapsed] = useState<{ query: string; groups: Partial<Record<ShortcutGroup, boolean>> }>({ query: '', groups: {} })
  const [panelQuery, setPanelQuery] = useState('')
  const lastTokenQuery = useRef('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [maxHeight, setMaxHeight] = useState(320)
  const [result, setResult] = useState<{ query: string; items: ConversationChoice[]; hasMore: boolean; error?: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [pendingTitle, setPendingTitle] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const composing = useRef(false)
  const groupNavigationKey = useRef<string | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const resolveController = useRef<AbortController | null>(null)
  const resolveVersion = useRef(0)
  const pendingCaret = useRef<{ text: string; caret: number; scope: string } | null>(null)
  // 在 React 提交本次替换后立即还原光标，不用下一帧回调覆盖用户随后的选区。
  useLayoutEffect(() => {
    const pending = pendingCaret.current
    if (!pending) return
    pendingCaret.current = null
    const textarea = options.textareaRef.current
    if (pending.scope === options.scopeKey && textarea?.value === pending.text) textarea.setSelectionRange(pending.caret, pending.caret)
  })
  const id = useId().replace(/:/g, '')
  const listId = `composer-shortcuts-${id}`
  const open = token !== null && !options.isLoading
  // 面板搜索框是筛选项的主输入；正文里的符号后文字仍会同步进来，保持原有打法。
  const query = panelQuery.trim().toLocaleLowerCase()
  const lookupKey = `${options.scopeKey}:${query}`
  const searchesConversations = open && (!category || category === 'conversation')
  useEffect(() => { setSearchCollapsed({ query, groups: {} }) }, [query])

  const close = useCallback(() => {
    setToken(null)
    setCategory(null)
    setActiveIndex(-1)
    setPanelQuery('')
    lastTokenQuery.current = ''
  }, [])
  const cancelReference = useCallback(() => {
    resolveVersion.current++
    resolveController.current?.abort()
    resolveController.current = null
    setPendingTitle(null)
  }, [])

  useEffect(() => {
    close()
    cancelReference()
    setFeedback('')
    setResult(null)
    return () => { resolveVersion.current++; resolveController.current?.abort() }
  }, [options.scopeKey, close, cancelReference])
  useEffect(() => { if (options.isLoading) close() }, [options.isLoading, close])
  // 程序性清空、草稿切换、外部插入不应留下旧 token 的坐标。
  useEffect(() => {
    if (!composing.current && token && !getShortcutToken(options.input, token.end)) close()
  }, [options.input, token, close])

  useEffect(() => {
    if (!searchesConversations) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchShortcutConversations(query, controller.signal).then(data => {
        if (!controller.signal.aborted) setResult({ query: lookupKey, ...data })
      }).catch(error => {
        if (!controller.signal.aborted) setResult({ query: lookupKey, items: [], hasMore: false, error: error instanceof Error ? error.message : '会话加载失败，请重试' })
      })
    }, query ? 200 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, lookupKey, searchesConversations, retry])

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const box = anchorRef.current?.getBoundingClientRect()
      if (!box) return
      const viewportTop = window.visualViewport?.offsetTop ?? 0
      const space = box.top - viewportTop
      // 矮视口优先保留一行可点选项；不能用最小高度把面板顶出屏幕。
      setMaxHeight(Math.max(0, Math.min(420, space - (space < 240 ? 8 : 60))))
    }
    update()
    const observer = new ResizeObserver(update)
    if (anchorRef.current) observer.observe(anchorRef.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open, options.input, options.references.length, pendingTitle, feedback])

  useEffect(() => {
    if (!open) return
    const onOutside = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onOutside)
    return () => document.removeEventListener('pointerdown', onOutside)
  }, [open, close])
  useBackToClose(open, () => {
    if (category) { setCategory(null); setActiveIndex(-1); return false }
    close()
  })

  const updateFromTextarea = (element: HTMLTextAreaElement) => {
    if (composing.current || latest.current.isLoading) return
    const next = getShortcutToken(element.value, element.selectionStart, element.selectionEnd)
    if (!next) { close(); return }
    if (!token || token.start !== next.start || token.sigil !== next.sigil) {
      setCategory(null)
      setFeedback('')
      latest.current.onOpen()
    }
    if (next.query !== lastTokenQuery.current) {
      lastTokenQuery.current = next.query
      setPanelQuery(next.query)
    }
    setToken(next)
    setActiveIndex(-1)
  }

  const replace = (replacement = '') => {
    if (!token) return
    const current = latest.current
    const textarea = current.textareaRef.current
    const actual = textarea && getShortcutToken(current.input, textarea.selectionStart, textarea.selectionEnd)
    if (!actual || actual.start !== token.start || actual.end !== token.end || actual.sigil !== token.sigil || actual.query !== token.query) { close(); return }
    const next = replaceShortcutToken(current.input, actual, replacement)
    pendingCaret.current = { ...next, scope: current.scopeKey }
    current.setInput(next.text)
    // 同步聚焦保留手机用户激活；光标由提交期 layout effect 恢复。
    textarea?.focus({ preventScroll: true })
    return next
  }

  const rootActions: Item[] = [
    { id: 'think', label: '深度思考', keywords: '思考 推理 think reasoning', icon: Brain, group: 'action', detail: options.deepThink ? '已开启' : '已关闭', action: () => { options.onDeepThinkChange(!options.deepThink); setFeedback(`深度思考已${options.deepThink ? '关闭' : '开启'}`) } },
    ...(options.webSearchAvailable && options.onWebSearchChange ? [{ id: 'search', label: '联网搜索', keywords: '智能搜索 联网 search web', icon: Globe, group: 'action' as const, detail: options.webSearch ? '已开启' : '已关闭', action: () => { options.onWebSearchChange?.(!options.webSearch); setFeedback(`联网搜索已${options.webSearch ? '关闭' : '开启'}`) } }] : []),
    ...(!options.compareMode ? [{ id: 'models', label: '切换模型', keywords: 'model models', icon: Layers, group: 'action' as const, category: 'model' as const }] : []),
    ...(options.onMaskChange ? [{ id: 'masks', label: '切换面具', keywords: 'mask persona 角色', icon: Drama, group: 'action' as const, category: 'mask' as const }] : []),
  ]
  const models: Item[] = options.compareMode ? [] : options.models.map(model => ({
    id: `model:${model.id}`, label: model.name, keywords: `${model.id} ${model.provider} 模型 model`, group: 'action', icon: Layers,
    selected: model.id === options.selectedModel, action: () => { options.onModelChange(model.id); setFeedback(`已切换模型：${model.name}`) },
  }))
  // 已下载面具若已升入精选（策展调整），扁平合并时去重
  const curatedMaskIds = new Set(BUILTIN_MASKS.map((m) => m.id))
  const masks: Item[] = options.onMaskChange ? [
    { id: 'mask:none', label: '不使用面具', keywords: '面具 mask', icon: Drama, group: 'action', selected: !options.maskId, action: () => { options.onMaskChange?.(null); setFeedback('已取消面具') } },
    ...[...(options.userMasks ?? []), ...BUILTIN_MASKS, ...BUILTIN_GAMES, ...(options.installedMasks ?? []).filter((m) => !curatedMaskIds.has(m.id))].map(mask => ({
      id: `mask:${mask.id}`, label: mask.name, keywords: `面具 mask ${mask.description}`, group: 'action' as const, icon: Drama,
      selected: options.maskId === mask.id, action: () => { options.onMaskChange?.(mask.id); setFeedback(`已切换面具：${mask.name}`) },
    })),
  ] : []
  const visibleResult = result?.query === lookupKey ? result : null
  const conversations: Item[] = (visibleResult?.items ?? []).filter(item => item.id !== options.scopeKey).map(conversation => ({
    id: `conversation:${conversation.id}`, label: conversation.title || '未命名会话', icon: MessageSquare, group: 'conversation', conversation,
    detail: options.references.some(ref => ref.id === conversation.id) ? '已添加' : '会话',
  }))
  const file: Item = { id: 'upload', label: '添加文件或图片', keywords: '文件 附件 图片 PDF file upload', group: 'file', icon: Paperclip, action: options.onUpload }
  const matches = (item: Item) => !query || `${item.label} ${item.keywords ?? ''}`.toLocaleLowerCase().includes(query)
  const collapsed = query ? (searchCollapsed.query === query ? searchCollapsed.groups : {}) : collapsedGroups
  const order: ShortcutGroup[] = token?.sigil === '@' ? ['conversation', 'file', 'action'] : ['action', 'conversation', 'file']
  const grouped: Record<ShortcutGroup, Item[]> = {
    action: [...rootActions, ...(query ? [...models, ...masks] : [])].filter(matches),
    conversation: conversations,
    file: [file].filter(matches),
  }
  const groups = order.filter(group => !query || grouped[group].length > 0 || (group === 'conversation' && (!visibleResult || visibleResult.error)))
  let items: Item[]
  if (category === 'model') items = models.filter(matches)
  else if (category === 'mask') items = masks.filter(matches)
  else if (category === 'conversation') items = conversations
  else items = groups.flatMap(group => [
    { id: `group:${group}`, label: GROUP_LABELS[group], group, headingGroup: group, icon: ChevronRight },
    ...(collapsed[group] ? [] : grouped[group]),
  ])
  // 首次打开仍选中第一项操作/引用；方向键也能到达分组标题。
  const selectedIndex = activeIndex < 0
    ? Math.max(0, items.findIndex(item => !item.headingGroup))
    : Math.min(activeIndex, Math.max(0, items.length - 1))
  const toggleGroup = (group: ShortcutGroup, collapse = !collapsed[group]) => {
    if (query) setSearchCollapsed({ query, groups: { ...collapsed, [group]: collapse } })
    else setCollapsedGroups(previous => ({ ...previous, [group]: collapse }))
    setActiveIndex(items.findIndex(item => item.headingGroup === group))
  }
  const activeId = open && items.length ? `${listId}-${selectedIndex}` : undefined
  useEffect(() => {
    if (!activeId) return
    const element = document.getElementById(activeId)
    const target = element?.querySelector('[data-composer-group]') ?? element
    target?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  // 从面板输入框用键盘选中后，把焦点交还正文；鼠标/触屏点击保持原行为。
  const restoreComposerFocus = () => {
    if (panelRef.current?.contains(document.activeElement) && !window.matchMedia('(pointer: coarse)').matches) {
      latest.current.textareaRef.current?.focus({ preventScroll: true })
    }
  }
  const choose = async (item: Item) => {
    if (latest.current.isLoading || composing.current || !token) return
    if (item.headingGroup) { toggleGroup(item.headingGroup); return }
    const textarea = latest.current.textareaRef.current
    const actual = textarea && getShortcutToken(textarea.value, textarea.selectionStart, textarea.selectionEnd)
    if (!actual || actual.start !== token.start || actual.end !== token.end || actual.sigil !== token.sigil || actual.query !== token.query) { close(); return }
    if (item.category) {
      const next = replace(token.sigil)
      if (!next) return
      setToken({ ...token, end: next.caret, query: '' })
      setCategory(item.category)
      setPanelQuery('')
      lastTokenQuery.current = ''
      setActiveIndex(-1)
      return
    }
    if (item.conversation) {
      const current = latest.current
      if (resolveController.current) { setFeedback('正在读取上一条引用，请稍候'); return }
      if (current.references.some(ref => ref.id === item.conversation!.id)) { replace(); close(); setFeedback('该会话已添加'); restoreComposerFocus(); return }
      if (current.references.length >= MAX_CHAT_REFERENCES) { setFeedback(`最多引用 ${MAX_CHAT_REFERENCES} 个会话，请先移除一个`); return }
      const scope = current.scopeKey
      const version = ++resolveVersion.current
      const controller = new AbortController()
      resolveController.current = controller
      setPendingTitle(item.label)
      setFeedback('')
      replace()
      close()
      restoreComposerFocus()
      try {
        const reference = await loadConversationReference(item.conversation, controller.signal)
        if (controller.signal.aborted || version !== resolveVersion.current || scope !== latest.current.scopeKey) return
        latest.current.setReferences(previous => previous.some(ref => ref.id === reference.id) ? previous : [...previous, reference].slice(0, MAX_CHAT_REFERENCES))
        setFeedback(reference.truncated ? '会话较长，已引用最近的部分正文；发送内容会注明截断。' : '已引用会话正文；不包含附件与隐藏思考。')
      } catch (error) {
        if (!controller.signal.aborted && version === resolveVersion.current) setFeedback(error instanceof Error ? error.message : '引用读取失败，请重新选择')
      } finally {
        if (version === resolveVersion.current) { setPendingTitle(null); resolveController.current = null }
      }
      return
    }
    replace()
    close()
    restoreComposerFocus()
    item.action?.()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, allowHorizontal = true): boolean => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return true
    if (!open) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length) setActiveIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
      return true
    }
    const activeGroup = items[selectedIndex]?.headingGroup
    if (allowHorizontal && activeGroup && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      groupNavigationKey.current = event.key
      if (event.key === 'ArrowRight' && !collapsed[activeGroup] && items[selectedIndex + 1]?.group === activeGroup) setActiveIndex(selectedIndex + 1)
      else toggleGroup(activeGroup, event.key === 'ArrowLeft')
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (items[selectedIndex]) void choose(items[selectedIndex]); return true }
    if (event.key === 'Escape') { event.preventDefault(); close(); return true }
    if (event.key === 'Tab') close()
    return false
  }

  const renderItem = (item: Item) => {
    const index = items.indexOf(item)
    const Icon = item.icon
    return <button key={item.id} type="button" id={`${listId}-${index}`} data-shortcut-id={item.id} role="treeitem" aria-selected={selectedIndex === index} tabIndex={-1} className={styles.option} title={item.label}
      onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault() }} onClick={() => void choose(item)}>
      <span className={styles.glyph}><Icon size={16} /></span><span className={styles.label}>{item.label}</span>
      <span className={styles.end}>{item.selected ? <Check size={15} /> : item.category ? <ChevronRight size={15} /> : item.detail}</span>
    </button>
  }
  const conversationStatus = <>
    {!visibleResult && <div className={styles.status} role="status">正在查找会话…</div>}
    {visibleResult?.error && <div className={styles.status} role="alert">{visibleResult.error} <button type="button" className="underline min-h-[44px] px-2" onClick={() => { setResult(null); setRetry(value => value + 1) }}>重试</button></div>}
    {visibleResult && !visibleResult.error && !conversations.length && !query && <div className={styles.status}>暂无可引用的聊天记录</div>}
  </>
  const panel = open ? (
    <div ref={panelRef} className={styles.panel} style={{ maxHeight }} data-compact={maxHeight < 200 || undefined} data-composer-shortcuts="" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); options.textareaRef.current?.focus() } }}>
      <div className={styles.header}>
        <span className={styles.sigil} aria-hidden>{token.sigil}</span>
        <div className={styles.title}>{category === 'model' ? '选择模型' : category === 'mask' ? '选择面具' : '快捷入口'}<span className={styles.priority}>{token.sigil === '@' ? '引用优先' : '操作优先'}</span></div>
        {category && <button type="button" className={styles.iconButton} aria-label="返回全部快捷项" onClick={() => { replace(token.sigil); setToken({ ...token, query: '', end: token.start + 1 }); setCategory(null); setPanelQuery(''); lastTokenQuery.current = ''; setActiveIndex(-1) }}><ArrowLeft size={16} /></button>}
        <span className={styles.keys} aria-label="方向键选择，回车确认">
          <kbd className={styles.keycap}>↑</kbd><kbd className={styles.keycap}>↓</kbd><span>选择</span><span aria-hidden>·</span><kbd className={styles.keycap}>Enter</kbd><span>确认</span>
        </span>
        <button type="button" className={styles.iconButton} aria-label="关闭快捷面板" onClick={() => { close(); options.textareaRef.current?.focus({ preventScroll: true }) }}><X size={16} /></button>
      </div>
      <div className={styles.searchBar}>
        <Search size={14} aria-hidden />
        <input ref={searchInputRef} data-composer-search="" type="text" inputMode="search" value={panelQuery} aria-label="搜索快捷操作与聊天记录"
          placeholder={category === 'model' ? '筛选模型' : category === 'mask' ? '筛选面具' : '搜索操作或聊天记录'}
          onChange={event => { setPanelQuery(event.target.value); setActiveIndex(-1) }}
          onKeyDown={event => { handleKeyDown(event, false) }} />
        {panelQuery && <button type="button" className={styles.searchClear} aria-label="清空搜索" onClick={() => {
          const next = replace(token.sigil)
          if (next) setToken({ ...token, end: next.caret, query: '' })
          setPanelQuery('')
          lastTokenQuery.current = ''
          searchInputRef.current?.focus()
        }}><X size={13} /></button>}
      </div>
      <div className={styles.list} id={listId} role="tree" aria-label="快捷操作与引用">
        {category ? items.map(renderItem) : groups.map(group => {
          const index = items.findIndex(item => item.headingGroup === group)
          const expanded = !collapsed[group]
          return <div key={group} role="treeitem" id={`${listId}-${index}`} aria-label={GROUP_LABELS[group]} aria-expanded={expanded} aria-selected={selectedIndex === index} tabIndex={-1} className={styles.section}>
            <div className={styles.groupToggle} data-composer-group={group} data-active={selectedIndex === index || undefined}
              onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault() }} onClick={() => toggleGroup(group)}>
              <ChevronRight size={13} className={styles.groupChevron} data-expanded={expanded} aria-hidden />
              <span>{GROUP_LABELS[group]}</span>
              <span className={styles.groupCount}>{group === 'conversation' && !visibleResult ? '…' : `${grouped[group].length}${group === 'conversation' && visibleResult?.hasMore ? '+' : ''}`}</span>
            </div>
            <div className={styles.groupBody} data-expanded={expanded} aria-hidden={!expanded}>
              <div role="group" aria-label={GROUP_LABELS[group]}>
                {grouped[group].map(renderItem)}
                {group === 'conversation' && conversationStatus}
              </div>
            </div>
          </div>
        })}
      </div>
      {feedback && <div className={styles.status} role="status" aria-live="polite">{feedback}</div>}
      {category === 'conversation' && conversationStatus}
      {!items.length && (!searchesConversations || visibleResult) && !visibleResult?.error && <div className={styles.status}>没有匹配项，换个关键词试试</div>}
    </div>
  ) : null

  const referenceChips = options.references.length || pendingTitle ? (
    <div className={styles.references} aria-label="待发送会话引用">
      {options.references.map(reference => <div className={styles.chip} key={reference.id}>
        <MessageSquare size={15} aria-hidden /><span className={styles.chipLabel} title={`${reference.title} · ${reference.messageCount} 条消息${reference.truncated ? ' · 部分正文' : ''}`}>{reference.title}{reference.truncated ? '（部分）' : ''}</span>
        <button type="button" className={styles.iconButton} aria-label={`移除引用 ${reference.title}`} onClick={() => options.setReferences(previous => previous.filter(ref => ref.id !== reference.id))}><X size={14} /></button>
      </div>)}
      {pendingTitle && <div className={styles.chip} role="status"><Loader2 size={15} className="animate-spin" /><span className={styles.chipLabel}>正在读取 {pendingTitle}</span><button type="button" className={styles.iconButton} aria-label="取消读取引用" onClick={cancelReference}><X size={14} /></button></div>}
    </div>
  ) : null

  return {
    open, close, anchorRef, anchorClassName: open ? styles.attached : '', panel, referenceChips,
    feedback: feedback ? <div role="status" aria-live="polite" className={styles.feedback}>{feedback}</div> : null,
    clearFeedback: () => setFeedback(''), pending: pendingTitle !== null,
    isPending: () => resolveController.current !== null,
    handleKeyDown, updateFromTextarea,
    textareaProps: {
      role: 'combobox' as const, 'aria-label': '输入消息，使用 / 或 @ 打开快捷入口', 'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'tree' as const, 'aria-expanded': open, 'aria-controls': open ? listId : undefined, 'aria-activedescendant': activeId,
      onClick: (event: React.MouseEvent<HTMLTextAreaElement>) => updateFromTextarea(event.currentTarget),
      onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (groupNavigationKey.current === event.key) { groupNavigationKey.current = null; return }
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateFromTextarea(event.currentTarget)
      },
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
        if (!token || composing.current) return
        const element = event.currentTarget
        const next = getShortcutToken(element.value, element.selectionStart, element.selectionEnd)
        if (!next) close()
        else if (next.start !== token.start || next.end !== token.end || next.query !== token.query || next.sigil !== token.sigil) updateFromTextarea(element)
      },
      // 组合输入期间不执行快捷项，但保留子分类与历史哨兵。
      onCompositionStart: () => { composing.current = true },
      onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => { composing.current = false; updateFromTextarea(event.currentTarget) },
    },
  }
}
