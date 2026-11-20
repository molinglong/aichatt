'use client'

/**
 * 课堂截图「先截后框」框选层(原型 design/preview-client-shot-crop.html,方案 B 挑定)。
 *
 * 课程区是原生 WebView2 子窗口,浮在主界面之上,DOM 框选层会被它整个盖住 ——
 * 所以流程是:先 GDI 截整张 → 临时隐藏课程层 → 在本层把冻结帧铺回原位框选 →
 * 裁切上传 → 恢复课程层。纯 DOM + Shadow DOM 实现(不依赖 React 挂载点,
 * 三处入口共用;样式走 shadow 内建样式表,不受主站 CSS 影响)。
 *
 * 交互(方案 B):拖拽框选 → 松开浮出「就这块 / 重选 / 用整张 / 取消」;
 * 回车=就这块,Esc=取消;选区过小视为重选。返回 CSS 视口坐标 rect,取消返回 null。
 */

export interface ShotImage {
  /** data:image/png;base64,… */
  dataUrl: string
  /** 位图物理尺寸(px) */
  width: number
  height: number
}

export interface CssRect {
  x: number
  y: number
  w: number
  h: number
}

const HOST_ID = 'aichatt-course-shot-crop'

const CROP_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root {
    position: fixed; inset: 0; cursor: crosshair;
    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    user-select: none; -webkit-user-select: none; touch-action: none;
  }
  .veil { position: absolute; inset: 0; background: rgba(8, 9, 12, 0.62); }
  .shot {
    position: absolute; overflow: hidden; border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14), 0 18px 50px rgba(0, 0, 0, 0.45);
    background: #0e1119;
  }
  .shot img { display: block; width: 100%; height: 100%; pointer-events: none; }
  .hint {
    position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 999px; white-space: nowrap;
    background: rgba(17, 19, 25, 0.94); color: #eef1f7;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
    pointer-events: none;
  }
  .hint kbd {
    padding: 2px 6px; border-radius: 6px; background: rgba(255, 255, 255, 0.12);
    color: #c9d2e4; font: inherit; font-size: 11px;
  }
  .sel {
    position: absolute; display: none;
    border: 1.5px solid #7ea2ff; border-radius: 3px;
    background: rgba(126, 162, 255, 0.08);
    pointer-events: none;
  }
  .sel .size {
    position: absolute; right: -1px; bottom: -24px; padding: 2px 6px; border-radius: 5px;
    background: #1a2030; color: #dfe6f5;
    font: 500 11px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap;
  }
  .bar {
    position: absolute; display: none; align-items: center; gap: 6px;
    padding: 6px; border-radius: 12px;
    background: rgba(22, 24, 31, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
    cursor: default;
  }
  .bar button {
    all: unset; height: 27px; padding: 0 11px; border-radius: 999px;
    display: inline-flex; align-items: center; gap: 5px;
    background: rgba(255, 255, 255, 0.09); color: #e6ebf7;
    font: 600 11.5px/1 inherit; font-family: inherit; cursor: pointer;
    transition: background 140ms ease, opacity 140ms ease;
  }
  .bar button:hover { background: rgba(255, 255, 255, 0.16); }
  .bar button:active { transform: scale(0.96); }
  .bar button.primary { background: #e9eef9; color: #14161c; font-weight: 700; }
  .bar button.primary:hover { background: #ffffff; }
  .bar kbd { font: inherit; font-size: 10.5px; opacity: 0.62; }
  .bar .sep { width: 1px; height: 16px; background: rgba(255, 255, 255, 0.14); margin: 0 2px; }
`

/** 单例:同一时刻只允许一个框选层 */
let busy = false

/**
 * 打开框选层。base = 冻结帧在视口里的摆放矩形(CSS px,业务侧按课程区算好)。
 * resolve:确认的 CSS 视口矩形;取消/Esc/用整张之外的异常路径返回 null。
 */
export function pickCourseShotRegion(shot: ShotImage, base: CssRect): Promise<CssRect | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  if (busy) return Promise.resolve(null)
  busy = true

  return new Promise<CssRect | null>((resolve) => {
    const host = document.createElement('div')
    host.id = HOST_ID
    // 高于站内一切浮层(toast 是 99999),且必须盖住原生层隐藏后的整个窗口
    host.style.cssText =
      'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000;'
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CROP_CSS
    shadow.appendChild(style)

    const root = document.createElement('div')
    root.className = 'root'
    root.innerHTML = `
      <div class="veil"></div>
      <div class="shot"><img alt="" /></div>
      <div class="hint">拖拽框选要问的区域 <kbd>Esc</kbd> 取消</div>
      <div class="sel"><span class="size"></span></div>
      <div class="bar" role="toolbar" aria-label="框选确认">
        <button data-act="confirm" class="primary">就这块 <kbd>↵</kbd></button>
        <button data-act="reselect">重选</button>
        <span class="sep"></span>
        <button data-act="full">用整张</button>
        <button data-act="cancel">取消</button>
      </div>
    `
    shadow.appendChild(root)

    const shotEl = root.querySelector<HTMLDivElement>('.shot')!
    const imgEl = shotEl.querySelector<HTMLImageElement>('img')!
    const hintEl = root.querySelector<HTMLDivElement>('.hint')!
    const selEl = root.querySelector<HTMLDivElement>('.sel')!
    const sizeEl = selEl.querySelector<HTMLSpanElement>('.size')!
    const barEl = root.querySelector<HTMLDivElement>('.bar')!

    imgEl.src = shot.dataUrl
    shotEl.style.left = `${base.x}px`
    shotEl.style.top = `${base.y}px`
    shotEl.style.width = `${base.w}px`
    shotEl.style.height = `${base.h}px`

    /** 当前选区(视口坐标);未确认前为空 */
    let selection: CssRect | null = null
    let drag: { sx: number; sy: number } | null = null
    let settled = false

    const clampToBase = (x: number, y: number) => ({
      x: Math.min(Math.max(x, base.x), base.x + base.w),
      y: Math.min(Math.max(y, base.y), base.y + base.h),
    })

    function paintSel() {
      if (!selection) {
        selEl.style.display = 'none'
        return
      }
      selEl.style.display = 'block'
      selEl.style.left = `${selection.x}px`
      selEl.style.top = `${selection.y}px`
      selEl.style.width = `${selection.w}px`
      selEl.style.height = `${selection.h}px`
      sizeEl.textContent = `${Math.round(selection.w)} × ${Math.round(selection.h)}`
    }

    function placeBar() {
      if (!selection) {
        barEl.style.display = 'none'
        return
      }
      barEl.style.display = 'inline-flex'
      // 先显形再量宽,下面 / 上面各自夹进视口
      const bw = barEl.offsetWidth
      const bh = barEl.offsetHeight
      let top = selection.y + selection.h + 10
      if (top + bh > window.innerHeight - 10) top = Math.max(10, selection.y - bh - 10)
      const left = Math.min(Math.max(8, selection.x), Math.max(8, window.innerWidth - bw - 8))
      barEl.style.top = `${top}px`
      barEl.style.left = `${left}px`
    }

    function finish(result: CssRect | null) {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    function cleanup() {
      window.removeEventListener('keydown', onKey, true)
      host.remove()
      busy = false
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
        return
      }
      if (e.key === 'Enter' && selection) {
        e.preventDefault()
        finish(selection)
      }
    }

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      // 确认条上的点击不当作新的框选
      if ((e.target as HTMLElement).closest('.bar')) return
      e.preventDefault()
      const p = clampToBase(e.clientX, e.clientY)
      drag = { sx: p.x, sy: p.y }
      selection = null
      barEl.style.display = 'none'
      hintEl.innerHTML = '松开完成框选 <kbd>Esc</kbd> 取消'
      try {
        root.setPointerCapture(e.pointerId)
      } catch {}
      paintSel()
    })

    root.addEventListener('pointermove', (e) => {
      if (!drag) return
      e.preventDefault()
      const p = clampToBase(e.clientX, e.clientY)
      selection = {
        x: Math.min(drag.sx, p.x),
        y: Math.min(drag.sy, p.y),
        w: Math.abs(p.x - drag.sx),
        h: Math.abs(p.y - drag.sy),
      }
      paintSel()
    })

    root.addEventListener('pointerup', (e) => {
      if (!drag) return
      e.preventDefault()
      const p = clampToBase(e.clientX, e.clientY)
      const rect: CssRect = {
        x: Math.min(drag.sx, p.x),
        y: Math.min(drag.sy, p.y),
        w: Math.abs(p.x - drag.sx),
        h: Math.abs(p.y - drag.sy),
      }
      drag = null
      if (rect.w < 12 || rect.h < 12) {
        // 点一下/太小:当作重选,不弹确认条
        selection = null
        barEl.style.display = 'none'
        hintEl.innerHTML = '拖拽框选要问的区域 <kbd>Esc</kbd> 取消'
        paintSel()
        return
      }
      selection = rect
      paintSel()
      placeBar()
      hintEl.textContent = '确认「就这块」或重选'
    })

    root.addEventListener('pointercancel', () => {
      drag = null
    })

    barEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
      if (!btn) return
      const act = btn.dataset.act
      if (act === 'confirm' && selection) finish(selection)
      else if (act === 'full') finish({ x: base.x, y: base.y, w: base.w, h: base.h })
      else if (act === 'cancel') finish(null)
      else if (act === 'reselect') {
        selection = null
        barEl.style.display = 'none'
        paintSel()
        hintEl.innerHTML = '拖拽框选要问的区域 <kbd>Esc</kbd> 取消'
      }
    })

    root.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('keydown', onKey, true)

    document.body.appendChild(host)
    requestAnimationFrame(() => {
      // 图解码完再摆确认条相关尺寸(避免首帧量到 0)
      void imgEl.decode?.().catch(() => {})
    })
  })
}