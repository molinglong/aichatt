'use client'

import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { ArrowLeft, ArrowUp, Check, ChevronRight, Menu, MoreHorizontal, Square, X } from 'lucide-react'
import { studyMessageText, type StudyAction } from '@/lib/study/lesson-flow'
import {
  blankStudyLesson,
  clearStudyLesson,
  loadStudyLesson,
  patchStudyLesson,
  type StudyApproach,
} from '@/lib/study/lesson-session'
import { toast } from '@/lib/toast'
import { useChatStore } from '@/store/chat-store'
import { FileUpload, type Attachment } from '@/components/chat/FileUpload'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { MessageList } from '@/components/chat/MessageList'
import { ChatImageLightbox } from '@/components/chat/ChatImageLightbox'
import { useBackToClose } from '@/hooks/useBackToClose'
import styles from './StudyRoom.module.css'

export type { StudyApproach }

/** 学习工具条目的描述式定义:由页面提供数据(抽屉开关/计数),本组件只管排布 */
export interface StudyTool {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  onClick: () => void
}

const approaches = {
  beginner: { name: '完全不会', description: '从第一步开始，一起找到切入点' },
  partial: { name: '只会一点', description: '说说你的思路，从卡住的地方接着走' },
  review: { name: '都会了，复习一下', description: '回想关键方法，再核对解题过程' },
}

interface StudyRoomProps {
  messages: ComponentProps<typeof MessageList>['messages']
  /** 当前学习室对应的会话 id(`/study?c=` 恢复时由页面传入);用于判断本地快照是否属于这堂课 */
  conversationId?: string | null
  isLoading: boolean
  isPending: boolean
  onSend: (text: string, attachments: Attachment[] | undefined, approach: StudyApproach, action?: StudyAction) => void
  completedReply: StudyRoomProps['messages'][number] | null
  onStop: () => void
  messageActions: Pick<ComponentProps<typeof MessageList>, 'onRegenerate' | 'onFavoriteChange' | 'onClarifySubmit' | 'onLocalFileDecision' | 'onOpenEditor'>
  error: ReactNode
  tools?: StudyTool[]
  settings: ReactNode
  continuation?: ReactNode
}

/** 学习室首条消息的固定前缀(题目正文 + 学习起点拼在后面) */
const FIRST_MESSAGE_PREFIX = '请帮我理解这道题。'

/** 从服务端首条用户消息反推这堂课的题目与学习起点(快照丢失 / 从历史打开旧课时的兜底) */
function deriveLessonStage(
  messages: StudyRoomProps['messages']
): { question: string; approach: StudyApproach | null } | null {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser) return null
  const text = firstUser.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text?: string }).text ?? '')
    .join('')
  if (!text) return null
  const approachMatch = text.match(/学习起点：(完全不会|只会一点|都会了)/)
  const approach: StudyApproach | null = approachMatch
    ? approachMatch[1] === '完全不会' ? 'beginner' : approachMatch[1] === '只会一点' ? 'partial' : 'review'
    : null
  // 只认学习室自己拼的首条形态;手动发的开场白(自定义文本)不反推题目,留空让原题区只显示附件
  let question = ''
  if (text.startsWith(FIRST_MESSAGE_PREFIX)) {
    const body = text.slice(FIRST_MESSAGE_PREFIX.length).split('\n\n学习起点：')[0].trim()
    question = body === '题目见附件。' ? '' : body
  }
  return { question, approach }
}

export function StudyRoom({ messages, isLoading, isPending, onSend, completedReply, onStop, messageActions, error, tools, settings, continuation, conversationId }: StudyRoomProps) {
  // 续课:刷新前那道题的题目/附件/学习起点/草稿从本地快照恢复,消息由页面按会话 id 回拉。
  // 只在首次挂载读一次,之后所有变化反向写回(见下方 patch 副作用)。
  const snapshot = loadStudyLesson()
  // 快照属于另一堂课(从历史列表打开旧课)时整体作废:否则题目区会顶着现在那堂课的题。
  // 作废后走「从服务端消息反推」,把旧课的题目与学习起点还原出来。
  const fromThisLesson = (snapshot.conversationId ?? null) === (conversationId ?? null)
  const restored = fromThisLesson ? snapshot : blankStudyLesson()
  // 库里还没有任何消息 = 首条题目还没落库(刷新撞在发送瞬间)或会话是空的。
  // 这种情况已经把「选起点」点过去了,但讲解无从恢复 —— 回落选择页,让用户重选起点重新发
  const hasServerMessages = messages.length > 0
  // 历史打开旧课/换设备/清缓存时首帧就按消息反推阶段,不先闪一次「从一道题开始」
  const derivedStage = !fromThisLesson && hasServerMessages ? deriveLessonStage(messages) : null
  const resumeLesson = hasServerMessages && (restored.questionReady || !!derivedStage)
  const [question, setQuestion] = useState(derivedStage?.question ?? restored.question)
  const [attachments, setAttachments] = useState<Attachment[]>(restored.attachments)
  const [questionReady, setQuestionReady] = useState(restored.questionReady || !!derivedStage)
  const [uploading, setUploading] = useState(false)
  const [approach, setApproach] = useState<StudyApproach | null>(derivedStage?.approach ?? restored.approach)
  const [choosing, setChoosing] = useState(derivedStage ? false : resumeLesson ? restored.choosing : true)
  const [thought, setThought] = useState(restored.thought)
  const [collectingThought, setCollectingThought] = useState(derivedStage ? false : resumeLesson && restored.collectingThought)
  const [drafts, setDrafts] = useState<Record<StudyApproach, string>>(restored.drafts)
  const [followupAttachments, setFollowupAttachments] = useState<Attachment[]>([])
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [recallOpen, setRecallOpen] = useState(false)
  const [questionVisible, setQuestionVisible] = useState(true)
  const [imageIndex, setImageIndex] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [endScreenOpen, setEndScreenOpen] = useState(false)
  // 模型没吐完成标记时,用户点「本题讲完了」在本地结课;刷新后由服务端 metadata 接管
  const [manualCompletedReply, setManualCompletedReply] = useState<StudyRoomProps['messages'][number] | null>(null)
  const completedIdRef = useRef<string | null>(null)
  const bumpNewChatNonce = useChatStore((state) => state.bumpNewChatNonce)
  const completionRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const questionRef = useRef<HTMLElement>(null)
  const lessonRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  // 只有服务端已有消息才算「这题已发出」:快照可能停在首条消息返回前那一瞬,
  // 此时点起点要重新完整发送题目,而不是当成熟课去「切换讲解方式」
  const sentRef = useRef(resumeLesson)
  const submitLockRef = useRef(false)
  const images = attachments.filter((attachment) => attachment.type.startsWith('image/'))
  const draft = approach ? drafts[approach] : ''
  const hasUnsentDraft = Object.values(drafts).some((value) => value.trim())
  const lessonActive = questionReady && !choosing && !collectingThought
  // 结课页数据源:模型标记优先,其次用户显式结课
  const finalReply = completedReply ?? manualCompletedReply
  // 本题已结课:此后选起点等于"重讲一遍",文案和指令都要按重讲办
  const lessonDone = !!finalReply
  const toggleSidebar = useChatStore((state) => state.toggleSidebar)
  const setSettingsOpen = useChatStore((state) => state.setSettingsOpen)
  const [toolsOpen, setToolsOpen] = useState(false)
  const dialogOpen = recallOpen || toolsOpen
  const closeRecall = useCallback(() => { setRecallOpen(false); setToolsOpen(false) }, [])
  useBackToClose(dialogOpen, closeRecall)

  // 快照不属于本课(从历史打开旧课)时先把归属对齐到当前会话,
  // 否则下面的阶段回写会把旧课的 key 带着继续用,下次打开还是错配。
  useEffect(() => {
    if (fromThisLesson) return
    patchStudyLesson({ conversationId: conversationId ?? null })
    // 只在首次挂载对齐一次(conversationId 是页面级常量)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 阶段快照回写:题目、附件、起点选择、追问草稿任何一项变化都续到本地,
  // 刷新后由上面的 useState 初值原样接住。conversationId 由页面/面板维护,这里不覆盖。
  useEffect(() => {
    patchStudyLesson({ question, attachments, questionReady, approach, thought, choosing, collectingThought, drafts })
  }, [question, attachments, questionReady, approach, thought, choosing, collectingThought, drafts])

  // 兜底推断:本地快照丢了(换设备/清缓存)但服务端已有讲解时,从首条消息反推阶段,
  // 让用户看到的仍是「这道题 + 讲解」,而不是重新从贴题目开始。
  const derivedRef = useRef(questionReady)
  useEffect(() => {
    if (derivedRef.current || messages.length === 0) return
    derivedRef.current = true
    const stage = deriveLessonStage(messages)
    if (!stage) return
    setQuestionReady(true)
    setChoosing(false)
    setCollectingThought(false)
    if (stage.approach) setApproach(stage.approach)
    if (stage.question) setQuestion(stage.question)
  }, [messages])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (dialogOpen && !dialog.open) dialog.showModal()
    if (!dialogOpen && dialog.open) dialog.close()
  }, [dialogOpen])

  useEffect(() => {
    if (!questionReady || !questionRef.current || !scrollerRef.current) return
    const observer = new IntersectionObserver(([entry]) => setQuestionVisible(entry.isIntersecting), {
      root: scrollerRef.current,
    })
    observer.observe(questionRef.current)
    return () => observer.disconnect()
  }, [questionReady])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const resize = () => {
      const css = getComputedStyle(textarea)
      const base = Math.max(44, parseFloat(css.lineHeight) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom))
      textarea.style.height = `${base}px`
      if (textarea.value && textarea.getClientRects().length) {
        textarea.style.height = `${Math.max(base, Math.min(textarea.scrollHeight, 144, innerHeight * .22))}px`
      }
    }
    resize()
    window.addEventListener('resize', resize)
    void document.fonts.ready.then(resize)
    return () => window.removeEventListener('resize', resize)
  }, [draft, lessonActive])

  useEffect(() => {
    if (!isLoading) submitLockRef.current = false
  }, [isLoading, messages.length])

  useEffect(() => {
    if (!completedReply || isLoading || error || completedIdRef.current === completedReply.id) return
    completedIdRef.current = completedReply.id
    setEndScreenOpen(true)
    setChoosing(false)
    setCollectingThought(false)
    requestAnimationFrame(() => {
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0
      completionRef.current?.focus({ preventScroll: true })
    })
  }, [completedReply, isLoading, error])

  const scrollToLesson = useCallback(() => {
    requestAnimationFrame(() => {
      const scroller = scrollerRef.current
      const lesson = lessonRef.current
      if (scroller && lesson) {
        scroller.scrollTop += lesson.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        lesson.focus({ preventScroll: true })
      }
    })
  }, [])

  // 模型没吐完成标记时的兜底:本地先结课,再请求服务端持久化 + 自动归档。
  // 网络失败也保留本地结课页,不让用户卡在"讲完了但没有结束态"。
  const finishLesson = useCallback(async () => {
    if (isLoading) return
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!last) return
    setManualCompletedReply(last)
    setEndScreenOpen(true)
    setChoosing(false)
    setCollectingThought(false)
    requestAnimationFrame(() => {
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0
      completionRef.current?.focus({ preventScroll: true })
    })
    if (!conversationId) return
    try {
      const res = await fetch('/api/study/lesson/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, messageId: last.id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.error('[StudyRoom] finish lesson failed:', err)
      toast.hint('已结课；自动归档失败，可稍后手动存入')
    }
  }, [messages, isLoading, conversationId])

  function send(text: string, nextApproach: StudyApproach, files?: Attachment[], action: StudyAction | null = 'instruction') {
    if (isLoading || uploading || submitLockRef.current) return
    submitLockRef.current = true
    setEndScreenOpen(false)
    setManualCompletedReply(null)
    setChoosing(false)
    setCollectingThought(false)
    setApproach(nextApproach)
    if (!sentRef.current) {
      sentRef.current = true
      onSend(`请帮我理解这道题。\n\n${question.trim() || '题目见附件。'}\n\n学习起点：${approaches[nextApproach].name}。\n${text}`, attachments, nextApproach, 'instruction')
      scrollToLesson()
    } else {
      onSend(text, files, nextApproach, action ?? undefined)
      requestAnimationFrame(() => {
        const scroller = scrollerRef.current
        if (scroller) scroller.scrollTop = scroller.scrollHeight
      })
    }
  }

  function choose(next: StudyApproach) {
    if (isLoading || submitLockRef.current) return
    if (next === 'partial') {
      setChoosing(false)
      setCollectingThought(true)
      scrollToLesson()
      return
    }
    // 已结课时不能再发"从我卡住的位置继续"——用户根本没提供卡点,模型只能猜着重讲一遍。
    // 这时明确说"从第一步完整重讲",让它按重讲的语义办事。
    const replay = lessonDone && sentRef.current
    send(next === 'beginner'
      ? replay
        ? '这道题已经讲完，我想换一种更基础的讲法重讲一遍。请从第一步开始完整重讲，不要沿用刚才的措辞，也不要接着旧进度。'
        : sentRef.current ? '切换为完全不会的讲解方式，请保留已讲内容，从我当前卡住的位置给一个更基础的小步骤。' : '我完全不会，请直接带我看第一个切入点，一次讲一个小步骤。'
      : replay
        ? '这道题已经讲完，请换用复习方式重讲一遍：先给一个关键回忆点或自检问题，等我要求展开时再给精简解法。'
        : '切换为复习方式。先给我一个关键回忆点或自检问题，等我要求展开时再核对精简解法。', next)
  }

  function submitFollowup() {
    if (!approach || (!draft.trim() && followupAttachments.length === 0) || isLoading || uploading || submitLockRef.current) return
    send(draft.trim() || '请结合附件解释我卡住的地方。', approach, followupAttachments, null)
    setDrafts((previous) => ({ ...previous, [approach]: '' }))
    setFollowupAttachments([])
    setOptionsOpen(false)
  }

  const questionContent = (inDialog = false) => (
    <>
      {question.trim() && <MarkdownRenderer content={question} rich />}
      {images.map((image, index) => inDialog ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={image.url} className={styles.questionImage} src={image.url} alt={`原题图片：${image.name}`} />
      ) : (
        <button key={image.url} type="button" className={styles.imageButton} onClick={() => setImageIndex(index)} aria-label={`放大题目图片：${image.name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.questionImage} src={image.url} alt={image.name} />
        </button>
      ))}
      {attachments.filter((attachment) => !attachment.type.startsWith('image/')).map((attachment) => (
        <a className={styles.fileLink} key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer">{attachment.name}</a>
      ))}
    </>
  )

  return (
    <div className={styles.room} data-study-room>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div className="md:hidden"><button type="button" className={styles.iconButton} aria-label="打开侧边栏" onClick={toggleSidebar}><Menu size={20} /></button></div>
          {questionReady && (
            <button type="button" className={styles.iconButton} disabled={isLoading || uploading} aria-label={endScreenOpen ? '返回讲解' : choosing ? (sentRef.current ? '返回当前讲解' : '修改题目') : lessonDone ? '查看本题小结' : '返回学习方式选择'} onClick={() => {
              if (endScreenOpen) { setEndScreenOpen(false); scrollToLesson() }
              else if (choosing && !sentRef.current) setQuestionReady(false)
              // 已发过题的选择页:退回讲解。别让它再绕进结课卡,也别把用户推去"换学习方式"
              else if (choosing) { setChoosing(false); scrollToLesson() }
              // 已结课:只在结课卡与讲解之间切换。结课后再进"换学习方式"等于误触重讲一遍(会再调一次模型)
              else if (lessonDone) { setEndScreenOpen(true); if (scrollerRef.current) scrollerRef.current.scrollTop = 0 }
              else { setChoosing(true); setCollectingThought(false); scrollToLesson() }
            }}><ArrowLeft size={20} /></button>
          )}
          <div className={styles.title}><h1>学习模式</h1></div>
          {questionReady && !questionVisible && <button type="button" className={styles.secondary} onClick={() => setRecallOpen(true)}>查看原题</button>}
          <button type="button" className={styles.iconButton} aria-label="学习工具" onClick={() => setToolsOpen(true)}><MoreHorizontal size={20} /></button>
        </div>
      </header>

      <div className={styles.workspace} ref={scrollerRef} data-study-scroll>
        {endScreenOpen && finalReply && <section ref={completionRef} className={styles.completion} tabIndex={-1} aria-labelledby="study-complete-title" data-study-complete>
          <div className={styles.completionIcon}><Check size={24} aria-hidden="true" /></div>
          <h2 id="study-complete-title">本题讲解完成</h2>
          <p className={styles.muted}>先到这里。可以回看思路，也可以带着新的问题再来。</p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={uploading || isLoading || hasUnsentDraft || followupAttachments.length > 0} onClick={() => { clearStudyLesson(); bumpNewChatNonce() }}>再学一道 <ChevronRight size={18} /></button>
            <button type="button" className={styles.secondary} onClick={() => { setEndScreenOpen(false); scrollToLesson() }}>回看讲解</button>
            <button type="button" className={styles.textButton} onClick={() => { setEndScreenOpen(false); requestAnimationFrame(() => textareaRef.current?.focus()) }}>还有疑问</button>
          </div>
          {(hasUnsentDraft || followupAttachments.length > 0 || uploading) && <p className={styles.note}>还有未发送的追问或附件，请先点「还有疑问」处理。其他学习方式的草稿可通过「换种方式」找回，不会替你清空。</p>}
          <div className={styles.wrapUp}><p className={styles.eyebrow}>本次讲解小结</p><MarkdownRenderer content={studyMessageText(finalReply)} rich /></div>
        </section>}
        {!questionReady ? (
          <section className={styles.setup}>
            <p className={styles.eyebrow}>从一道题开始</p>
            <h2>一起把这题弄懂。</h2>
            <p className={styles.muted}>贴上题目或上传题图，再选一个适合你的起点。</p>
            <form onSubmit={(event) => { event.preventDefault(); if (!uploading && (question.trim() || attachments.length)) setQuestionReady(true) }}>
              <label htmlFor="study-question">题目</label>
              <textarea id="study-question" className={styles.thought} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={20000} placeholder="输入或粘贴题目，也可以只上传题图…" />
              <FileUpload attachments={attachments} onAttachmentsChange={setAttachments} onUploadingChange={setUploading} variant="pill" pillClassName="min-h-11 px-4" />
              <div className={styles.settings}>{settings}</div>
              <button type="submit" className={styles.primary} disabled={uploading || (!question.trim() && !attachments.length)}>选个学习起点 <ChevronRight size={18} /></button>
            </form>
          </section>
        ) : (
          <div hidden={endScreenOpen} style={{ display: endScreenOpen ? 'none' : 'contents' }}>
            <section ref={questionRef} className={styles.question} aria-label="原题">
              <div className={styles.sectionHeading}><span className={styles.eyebrow}>当前题目</span><button type="button" className={styles.textButton} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开题目' : '收起题目'}</button></div>
              {!collapsed && questionContent()}
            </section>
            <section className={styles.lesson} ref={lessonRef} tabIndex={-1} aria-label="讲解区域">
              {choosing ? (
                <>
                  <h2>{lessonDone ? '要换一种讲法重讲吗？' : '这道题，你会到哪一步？'}</h2>
                  <p className={styles.muted}>{lessonDone ? '这道题已经讲完。选任意起点都会从第一步重新讲一遍，并再消耗一次模型额度。' : '不用急着看答案，选一个适合你的起点。'}</p>
                  <div className={styles.paths}>
                    {(Object.entries(approaches) as [StudyApproach, typeof approaches.beginner][]).map(([key, value], index) => (
                      <button type="button" key={key} className={styles.path} onClick={() => choose(key)} disabled={isLoading || uploading}>
                        <span className={styles.pathNumber}>0{index + 1}</span><span><strong>{value.name}</strong><small>{lessonDone ? `重讲 · ${value.description}` : value.description}</small></span><ChevronRight size={18} />
                      </button>
                    ))}
                  </div>
                  <p className={styles.note}>{lessonDone ? '原讲解会保留，重讲内容追加在后面，不会覆盖。' : '没有选错一说。已讲内容会保留，随时可以换。'}</p>
                  {sentRef.current && <button type="button" className={styles.secondary} onClick={() => setChoosing(false)}>回到当前讲解</button>}
                </>
              ) : collectingThought ? (
                <>
                  <p className={styles.eyebrow}>先接住你的思路</p><h2>你已经想到哪儿了？</h2>
                  <label htmlFor="study-thought">我的思路</label>
                  <textarea id="study-thought" className={styles.thought} value={thought} onChange={(event) => setThought(event.target.value)} maxLength={10000} placeholder="知道一个条件、试过一个方法，或者只差某一步，都可以从这里开始。" />
                  <div className={styles.actions}>
                    <button type="button" className={styles.primary} disabled={!thought.trim() || isLoading} onClick={() => send(`我只会一点。我的思路是：\n${thought.trim()}\n请检查我的思路，从卡住的位置接着讲。`, 'partial')}>从这里接着讲 <ChevronRight size={18} /></button>
                    <button type="button" className={styles.textButton} disabled={isLoading || uploading} onClick={() => send('我只会一点，但暂时说不清思路，请先给一层提示。', 'partial')}>说不清，先给提示</button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.sectionHeading}><span className={styles.modePill}>{approach && approaches[approach].name}</span><button type="button" className={styles.textButton} disabled={isLoading || uploading} onClick={() => { setChoosing(true); scrollToLesson() }}>{lessonDone ? '换种讲法重讲' : '换种方式'}</button></div>
                  {thought.trim() && <blockquote className={styles.userThought}>{thought}</blockquote>}
                </>
              )}
              <div hidden={!lessonActive} className={styles.messages}>
                {isPending && <p className={styles.muted} role="status">{messages.length <= 1 ? '正在读题，准备第一步讲解…' : '正在准备讲解…'}</p>}
                <MessageList {...messageActions} messages={messages} studyQuestion={[question.trim(), ...attachments.map((attachment) => attachment.type.startsWith('image/') ? `![题图](${attachment.url})` : `[题目附件](${attachment.url})`)].filter(Boolean).join('\n\n')} isStreaming={isLoading} isPending={false} />
                {error}
                {!isLoading && !error && messages.at(-1)?.role === 'user' && <button type="button" className={styles.primary} onClick={messageActions.onRegenerate}>重新开始讲解</button>}
                {continuation}
                {finalReply && !isLoading && !error ? <div className={styles.actions}>
                  <button type="button" className={styles.secondary} onClick={() => { setEndScreenOpen(true); if (scrollerRef.current) scrollerRef.current.scrollTop = 0 }}>查看本题小结</button>
                </div> : messages.some((message) => message.role === 'assistant') && !isLoading && !error && approach && (
                  <div className={styles.actions}>
                    {approach !== 'review' && <button type="button" className={styles.primary} disabled={uploading} onClick={() => send('继续讲下一步。如果这道题已经讲完，请简短总结关键方法，不必自动出新题。', approach, undefined, 'next')}>继续，往下讲 <ChevronRight size={18} /></button>}
                    <button type="button" className={styles.secondary} disabled={uploading} onClick={() => send(approach === 'review' ? '现在展开精简解法，让我核对关键步骤和答案。' : '请直接给出这道题的完整分步解法和答案，不再反问。', approach, undefined, 'solution')}>{approach === 'review' ? '展开精简解法' : '看完整解法'}</button>
                    <button type="button" className={styles.textButton} disabled={uploading} onClick={() => void finishLesson()}>本题讲完了</button>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>

      {lessonActive && (
        <footer hidden={endScreenOpen} className={styles.footer} data-study-composer>
          <div hidden={!optionsOpen} className={styles.options}><div className={styles.settings}>{settings}</div><FileUpload attachments={followupAttachments} onAttachmentsChange={setFollowupAttachments} onUploadingChange={setUploading} variant="pill" disabled={isLoading || uploading} pillClassName="min-h-11 px-4" /></div>
          {!optionsOpen && followupAttachments.length > 0 && <button type="button" className={styles.textButton} onClick={() => setOptionsOpen(true)}>已附 {followupAttachments.length} 个文件</button>}
          <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); submitFollowup() }}>
            <button type="button" className={styles.iconButton} aria-label="附件与模型设置" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}><MoreHorizontal size={20} /></button>
            <label className="sr-only" htmlFor="study-followup">随时追问，不打断当前进度</label>
            <textarea id="study-followup" ref={textareaRef} rows={1} value={draft} maxLength={10000} placeholder="哪里没懂？" onChange={(event) => { if (approach) setDrafts((previous) => ({ ...previous, [approach]: event.target.value })) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submitFollowup() } }} />
            {isLoading ? <button type="button" className={styles.send} aria-label="停止生成" onClick={onStop}><Square size={17} /></button> : <button type="submit" className={styles.send} aria-label="发送追问" disabled={uploading || (!draft.trim() && !followupAttachments.length)}><ArrowUp size={20} /></button>}
          </form>
        </footer>
      )}

      <dialog ref={dialogRef} data-kind={toolsOpen ? 'tools' : 'recall'} className={styles.dialog} aria-labelledby="study-recall-title" onCancel={(event) => { event.preventDefault(); closeRecall() }} onClose={closeRecall} onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeRecall()
      }}>
        <div className={styles.sheetHandle} aria-hidden="true" />
        <div className={styles.sectionHeading}><h2 id="study-recall-title">{toolsOpen ? '学习工具' : '查看原题'}</h2><button type="button" className={styles.iconButton} aria-label={toolsOpen ? '关闭学习工具' : '关闭原题'} onClick={closeRecall}><X size={20} /></button></div>
        {toolsOpen ? (
          <>
            {tools && tools.length > 0 && (
              <div className={styles.tools}>
                {tools.map((tool) => (
                  <button key={tool.id} type="button" className={styles.tool} onClick={() => { closeRecall(); tool.onClick() }}>
                    {tool.icon && <span className={styles.toolIcon} aria-hidden="true">{tool.icon}</span>}
                    <span className={styles.toolText}>
                      <strong>{tool.label}</strong>
                      {tool.description && <small>{tool.description}</small>}
                    </span>
                    <ChevronRight size={18} className={styles.toolChevron} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            <section className={styles.toolSection}>
              <p className={styles.eyebrow}>讲题设置</p>
              <div className={styles.settings}>{settings}</div>
            </section>
            <button type="button" className={styles.toolLink} onClick={() => { closeRecall(); setSettingsOpen(true) }}>
              <span>应用设置</span><ChevronRight size={16} aria-hidden="true" />
            </button>
          </>
        ) : <>{questionContent(true)}<p className={styles.note}>关闭后继续刚才的讲解。</p></>}
      </dialog>
      {imageIndex !== null && <ChatImageLightbox images={images} index={imageIndex} onIndexChange={setImageIndex} onClose={() => setImageIndex(null)} />}
    </div>
  )
}
