/**
 * PDF 录题 · 客户端页图与题区定位(零 pdfjs——页图/文本坐标全部服务端产出):
 * - loadPage:拉某页的页图(dataUrl)+ 文本项坐标(PDF pt),带页级缓存
 * - locateStem:候选题干(归一化后最长中文段做锚点)在文本项序列里定位 → 外接矩形(PDF pt)
 * - cropFromImg:按矩形从页图上裁剪原图区域 → dataURL(编辑抽屉「原图对照」用)
 * 渲染细节见服务端 renderPageImageCached / getPageLayout(legacy pdfjs + @napi-rs/canvas,node 侧验证过)。
 */

export interface PageAsset {
  dataUrl: string
  /** 页面尺寸(PDF pt,与坐标同单位) */
  width: number
  height: number
  /** 文本项:文本 + 左上角起点与宽高(均 PDF pt,y 自页顶向下) */
  items: Array<{ s: string; x: number; y: number; w: number; h: number }>
}

const assetCache = new Map<string, Promise<PageAsset>>()

export function loadPage(importId: string, pageNo: number): Promise<PageAsset> {
  const key = `${importId}#${pageNo}`
  if (!assetCache.has(key)) {
    assetCache.set(
      key,
      fetch(`/api/papers/pdf-import/${importId}/page/${pageNo}`)
        .then((res) => {
          if (!res.ok) throw new Error(`page_${pageNo}_${res.status}`)
          return res.json() as Promise<PageAsset>
        })
        .catch((err) => {
          assetCache.delete(key)
          throw err
        })
    )
  }
  return assetCache.get(key)!
}

/** 匹配归一化:剥掉 CJK/字母/数字以外的一切(空白/全半角标点/LaTeX 记号都视为等价)。
 *  不用 \p{} + u 旗标(tsconfig target 低,TS1501),显式字符类等价且更快 */
const NORM_KEEP = /[^\u3400-\u4dbf\u4e00-\u9fffa-zA-Z0-9]+/g
const normText = (s: string) => s.replace(NORM_KEEP, '')

/** 候选题干 → 页上外接矩形(PDF pt)。
 *  锚点策略:题干里最长的中文段优先(AI 转录常清洗掉 \mathrm 等 LaTeX 记号,纯前缀匹配易碎),
 *  命中后向后延展约 28 个归一化字符盖住题块主体;全部落空返回 null。 */
export function locateStem(
  items: PageAsset['items'],
  stem: string
): { x: number; y: number; w: number; h: number } | null {
  if (!items.length) return null
  const normed = items.map((it) => ({ ...it, n: normText(it.s) }))
  const hay = normed.map((it) => it.n).join('')
  if (!hay) return null
  const full = normText(stem)
  if (full.length < 4) return null
  const cjkRuns = (full.match(/[\u4e00-\u9fff]{4,}/g) ?? []).sort((a, b) => b.length - a.length)
  const needles = [...cjkRuns.slice(0, 2), full.slice(0, 14)].filter((n) => n.length >= 4)
  for (const needle of needles) {
    const at = hay.indexOf(needle)
    if (at < 0) continue
    // 归一化区间 → 涉及的 item 集合(与 hay 的拼接口径一致)
    let acc = 0
    const involved = normed.filter((it) => {
      const s0 = acc
      acc += it.n.length
      return acc > at && s0 < at + needle.length + 28 && it.n
    })
    const usable = involved.filter((it) => Number.isFinite(it.x + it.y + it.w + it.h))
    if (!usable.length) continue
    const left = Math.min(...usable.map((it) => it.x))
    const top = Math.min(...usable.map((it) => it.y))
    const right = Math.max(...usable.map((it) => it.x + it.w))
    const bottom = Math.max(...usable.map((it) => it.y + it.h))
    return { x: left, y: top, w: right - left, h: bottom - top }
  }
  return null
}

/** 从页图裁剪矩形(pt 坐标)→ dataURL;img 为已加载的页图元素 */
export function cropFromImg(
  img: HTMLImageElement,
  rect: { x: number; y: number; w: number; h: number },
  pageWidthPt: number,
  maxOut = 720
): string | null {
  const k = img.naturalWidth / pageWidthPt // 显示 pt → PNG 像素
  const pad = 6 * k
  const sx = Math.max(0, (rect.x - 4) * k - pad)
  const sy = Math.max(0, (rect.y - 4) * k - pad)
  const sw = Math.min(img.naturalWidth - sx, (rect.w + 8) * k + pad * 2)
  const sh = Math.min(img.naturalHeight - sy, (rect.h + 8) * k + pad * 2)
  if (sw < 4 || sh < 4) return null
  const zoom = Math.min(1.6, Math.max(1, maxOut / Math.max(sw, sh)))
  const out = document.createElement('canvas')
  out.width = Math.floor(sw * zoom)
  out.height = Math.floor(sh * zoom)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}
