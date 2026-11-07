/** 一次性侦察:11 本新课本 PDF 的页数/P1 尺寸/P1 文本层字符数(用后即删) */
const fs = require('fs')
const path = require('path')

const DIR = 'D:/xiaz/教材下载'
const FILES = [
  '普通高中教科书·思想政治必修1 中国特色社会主义.pdf',
  '普通高中教科书·思想政治必修2 经济与社会.pdf',
  '普通高中教科书·思想政治必修3 政治与法治.pdf',
  '普通高中教科书·思想政治必修4 哲学与文化.pdf',
  '普通高中教科书·思想政治选择性必修1 当代国际政治与经济.pdf',
  '普通高中教科书·思想政治选择性必修2 法律与生活.pdf',
  '普通高中教科书·思想政治选择性必修3 逻辑与思维.pdf',
  '普通高中教科书·地理必修 第一册.pdf',
  '普通高中教科书·地理必修 第二册.pdf',
  '普通高中教科书·地理选择性必修1 自然地理基础.pdf',
  '普通高中教科书·地理选择性必修2 区域发展.pdf',
]

;(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  for (const name of FILES) {
    const f = path.join(DIR, name)
    const t0 = Date.now()
    try {
      const data = new Uint8Array(fs.readFileSync(f))
      const doc = await pdfjs.getDocument({
        data,
        useSystemFonts: true,
        cMapUrl: 'node_modules/pdfjs-dist/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
        wasmUrl: 'node_modules/pdfjs-dist/wasm/',
      }).promise
      const p1 = await doc.getPage(1)
      const vp = p1.getViewport({ scale: 1 })
      const tc = await p1.getTextContent()
      let chars = 0
      for (const it of tc.items) chars += (it.str || '').length
      // 再抽中间一页看文本量(封面常无字,中页更有代表性)
      const mid = await doc.getPage(Math.floor(doc.numPages / 2))
      const tcm = await mid.getTextContent()
      let midChars = 0
      for (const it of tcm.items) midChars += (it.str || '').length
      console.log(
        `${name.replace('普通高中教科书·', '')} | ${doc.numPages}页 | P1 ${Math.round(vp.width)}x${Math.round(vp.height)} | 文本 P1:${chars}字 中页:${midChars}字 | ${((Date.now() - t0) / 1000).toFixed(1)}s`
      )
      p1.cleanup()
      mid.cleanup()
      await doc.destroy()
    } catch (e) {
      console.log(`${name} | FAIL: ${e.message}`)
    }
  }
})()
