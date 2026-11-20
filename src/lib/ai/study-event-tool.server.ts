/**
 * 学习事件记录工具——服务端工厂（server-only，依赖 prisma）。
 *
 * 常量/schema/日期换算在 study-event-tool.ts（isomorphic），REST API
 * (/api/study/events) 与学习台「学习记录」贴纸共用同一张 StudyEvent 表：
 * AI 聊天快记 source='chat'，学习台手动补一条 source='manual'，展示按 eventDate 分组。
 *
 * 去重口径：同 userId + 同归属日 + 文字完全相同 → 跳过（duplicates 回传），
 * 防止用户重复说「记一下今天背了单词」刷出两条一样的流水。
 */
import { tool } from 'ai'
import { prisma } from '@/lib/db'
import {
  recordStudyEventInputSchema,
  queryStudyEventsInputSchema,
  dateISOToUtc,
  dateUtcToISO,
  todayEventISO,
  EVENT_TAG_VALUES,
  type EventTag,
  type RecordStudyEventToolOutput,
  type QueryStudyEventsToolOutput,
  type StudyEventToolRow,
} from './study-event-tool'

export function createRecordStudyEventTool(userId: string) {
  return tool({
    description:
      '学习事件记录工具。用户明确要求记录今天/某天的学习流水时调用（如「记一下今天背了 Unit 5 的单词」「帮我记着，今天刷了两套卷子」）：一句话+自动标签，存进学习记录时间线。用户没有要求时禁止主动调用。',
    inputSchema: recordStudyEventInputSchema,
    execute: async (input): Promise<RecordStudyEventToolOutput> => {
      const saved: StudyEventToolRow[] = []
      const duplicates: string[] = []
      try {
        for (const ev of input.events) {
          // 归属日：非法日期回退今天（schema 正则已挡住绝大多数，兜底不抛整批）
          const dateISO = ev.date && dateISOToUtc(ev.date) ? ev.date : todayEventISO()
          const eventDate = dateISOToUtc(dateISO)!
          // 同日同文字视为重复，跳过
          const dup = await prisma.studyEvent.findFirst({
            where: { userId, eventDate, text: ev.text },
            select: { id: true },
          })
          if (dup) {
            duplicates.push(ev.text)
            continue
          }
          const row = await prisma.studyEvent.create({
            data: {
              userId,
              text: ev.text,
              tag: ev.tag ?? null,
              source: 'chat',
              eventDate,
            },
            select: { id: true, text: true, tag: true, source: true, eventDate: true, createdAt: true },
          })
          saved.push({
            id: row.id,
            text: row.text,
            tag: row.tag,
            source: row.source,
            eventDate: dateUtcToISO(row.eventDate),
            createdAt: row.createdAt.toISOString(),
          })
        }
        return { ok: saved.length > 0, saved, duplicates }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知记录错误'
        console.error('[record-study-event-tool]', message)
        return {
          ok: false,
          saved: [],
          duplicates,
          error: message,
        }
      }
    },
  })
}

export function createQueryStudyEventsTool(userId: string) {
  return tool({
    description:
      '学习记录查询工具。用户问「今天/这周/最近学了什么、背了什么单词、记了哪些东西」时调用：返回按日分组的学习流水与标签统计。回答必须基于查询结果，不要凭记忆编造。',
    inputSchema: queryStudyEventsInputSchema,
    execute: async (input): Promise<QueryStudyEventsToolOutput> => {
      const days = input.days ?? 7
      try {
        // 最近 days 天：从今天（含）往前推 days-1 天，按 UTC 零点口径与存入一致
        const to = dateISOToUtc(todayEventISO())!
        const from = new Date(to)
        from.setUTCDate(from.getUTCDate() - (days - 1))
        const rows = await prisma.studyEvent.findMany({
          where: {
            userId,
            eventDate: { gte: from, lte: to },
            ...(input.tag ? { tag: input.tag } : {}),
          },
          orderBy: [{ eventDate: 'desc' }, { createdAt: 'asc' }],
          take: 300,
          select: { text: true, tag: true, eventDate: true },
        })
        const tagCounts: Partial<Record<EventTag, number>> = {}
        for (const r of rows) {
          if (r.tag && (EVENT_TAG_VALUES as readonly string[]).includes(r.tag)) {
            tagCounts[r.tag as EventTag] = (tagCounts[r.tag as EventTag] ?? 0) + 1
          }
        }
        const groups = new Map<string, Array<{ text: string; tag: string | null }>>()
        for (const r of rows) {
          const iso = dateUtcToISO(r.eventDate)
          const arr = groups.get(iso) ?? []
          arr.push({ text: r.text, tag: r.tag })
          groups.set(iso, arr)
        }
        return {
          ok: true,
          days,
          total: rows.length,
          tagCounts,
          groups: Array.from(groups.entries()).map(([date, items]) => ({ date, items })),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知查询错误'
        console.error('[query-study-events-tool]', message)
        return { ok: false, days, total: 0, tagCounts: {}, groups: [], error: message }
      }
    },
  })
}
