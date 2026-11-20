'use client'

import { getIsTauri } from '@/lib/tauri'
import { getWorkspaceDir, pickWorkspaceDir, writeFile, sanitizeFileName } from '@/lib/tauri-files'
import { toast } from '@/lib/toast'

/**
 * 一键导出到授权工作区（桌面端专用）——CodePanel（代码编辑器）与 WriteDocPanel
 * （写作画布）等「导出到本地文件」入口共用的桌面检查 + 授权流 + 写盘 + 提示，
 * 收敛此前各写一遍的实现。
 *
 * 流程：非桌面端直接 toast 提示（不触发 load）→ 未授权工作区先弹目录选择
 * （选完即授权并继续）→ load() 取内容（调用方决定来源 API 与扩展名）→
 * writeFile 写入 <sanitize 后文件名>.<ext> → 成功/失败 toast。
 * load 抛错也走统一的错误 toast。返回 true = 已落盘。
 */
export async function exportToWorkspaceFile(opts: {
  load: () => Promise<{ fileNameBase: string; content: string; ext: string }>
}): Promise<boolean> {
  if (!getIsTauri()) {
    toast.error('导出到本地文件仅桌面客户端可用')
    return false
  }
  try {
    const base = await getWorkspaceDir()
    if (!base) {
      // 未授权引导流：直接弹目录选择，选完即授权并继续导出
      const pick = await pickWorkspaceDir()
      if (pick.cancelled) return false
      if (!pick.ok || !pick.base) {
        toast.error(pick.error || '选择工作区失败')
        return false
      }
    }
    const { fileNameBase, content, ext } = await opts.load()
    const fileName = `${sanitizeFileName(fileNameBase)}.${ext}`
    const w = await writeFile(fileName, content)
    if (w.ok) {
      toast.success(`已导出到工作区: ${fileName}`, { title: '本地文件' })
      return true
    }
    toast.error(w.error || '导出失败')
    return false
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '导出失败')
    return false
  }
}
