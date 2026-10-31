# -*- coding: utf-8 -*-
"""
湘教版《地理 选择性必修1 自然地理基础》PDF → 知识库导入 HTML

特点（实测）:
- 文本层正常（无 PUA/生僻字替换），正文 12pt，章标题 18pt+40pt，节标题 26pt，
  小节标题 14pt/12pt 黑体；阅读/探究/活动标签 13pt；图注 9pt；表格 10.5pt。
- 版式为杂志式混排（整宽栏目框 + 左右栏 + 图片穿插），PDF 内容流顺序不可用，
  按 (y, x) 几何排序读取；段落按首行缩进与行距合并。
- 部分章/节标题是图片，文本层没有；因此以目录页（PDF 第 6 页，印刷页码 1 起）
  为权威结构，按 offset=6 注入 h2/h3。
- 表格用 find_tables 抽取，表格区域内的文本行不重复入正文。

用法:
  python scripts/pdf2textbook-geo-selective1.py
  python scripts/pdf2textbook-geo-selective1.py --start 7 --end 132 --dry

产物:
  deliverables/geo-selective1-full.import.html
  deliverables/geo-selective1-full.stats.json
"""
import pymupdf, re, json, html, os, argparse, collections

DEFAULT_PDF = r"D:\xiaz\教材下载\普通高中教科书·地理选择性必修1 自然地理基础.pdf"
OUT_HTML = "deliverables/geo-selective1-full.import.html"
OUT_STATS = "deliverables/geo-selective1-full.stats.json"
TOC_PAGE_INDEX = 5
PRINT_OFFSET = 6          # PDF 第 7 页 = 印刷第 1 页
BOOK = "地理"
GRADE = "选择性必修1 自然地理基础"
PUBLISHER = "湖南教育出版社"

LABELS = {'探究', '阅读', '活动', '问题研究', '思考', '讨论', '实践活动', '单元活动'}
LIST_RE = re.compile(r'^(\d+[.．]|（\d+）|\(\d+\)|[①②③④⑤⑥⑦⑧⑨⑩])')
H4_RE = re.compile(r'^([一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\))')
CAPTION_RE = re.compile(r'^图\s*\d+\s*[-—]\s*\d+')
CHAPTER_RE = re.compile(r'^第[一二三四五六七八九十]+章')
SECTION_RE = re.compile(r'^第[一二三四五六七八九十]+节')


def norm(s):
    return re.sub(r'[\s\u3000]+', '', s or '')


def parse_toc(doc):
    """目录 → [{kind, title, printPage}]；页码按出现顺序与标题一一对应。"""
    text = doc[TOC_PAGE_INDEX].get_text('text')
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    titles, nums = [], []
    for l in lines:
        if CHAPTER_RE.match(norm(l)) or SECTION_RE.match(norm(l)):
            titles.append(l)
        elif re.fullmatch(r'\d{1,3}', l):
            nums.append(int(l))
    entries = []
    for i, t in enumerate(titles):
        if i >= len(nums):
            break
        entries.append({
            'kind': 'chapter' if CHAPTER_RE.match(norm(t)) else 'section',
            'title': re.sub(r'[\s\u3000]+', ' ', t).strip(),
            'printPage': nums[i],
            'pdfPage': nums[i] + PRINT_OFFSET,
        })
    return entries


def inside(bb, boxes):
    x0, y0, x1, y1 = bb
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for (a, b, c, d) in boxes:
        if a <= cx <= c and b <= cy <= d:
            return True
    return False


def page_lines(page):
    """返回 (lines, tables)。line = {text,size,font,x0,y0,x1,y1}"""
    lines = []
    for b in page.get_text('dict')['blocks']:
        if b.get('type') != 0:
            continue
        for l in b['lines']:
            if l.get('dir') != (1.0, 0.0):
                continue
            spans = [s for s in l['spans'] if s['text'].strip()]
            if not spans:
                continue
            t = ''.join(s['text'] for s in spans)
            t = re.sub(r'[ \t\u3000]+', ' ', t).strip()
            if not t:
                continue
            mx = max(s['size'] for s in spans)
            font = spans[0]['font']
            x0, y0, x1, y1 = l['bbox']
            if y0 > 785 or y1 < 60 or mx > 60:
                continue
            lines.append({'text': t, 'size': round(mx, 1), 'font': font,
                          'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1})
    tabs = []
    try:
        found = page.find_tables()
        for t in found.tables:
            rows = t.extract()
            rows = [[(c or '').replace('\n', ' ').strip() for c in r] for r in rows]
            rows = [r for r in rows if any(c for c in r)]
            if len(rows) < 2 or len(rows[0]) < 2:
                continue
            # 杂志式栏目框会被 find_tables 误判成表：真表格单元格短、多列非空
            max_len = max((len(c) for r in rows for c in r), default=0)
            multi = sum(1 for r in rows if sum(1 for c in r if c) >= 2)
            x0, y0, x1, y1 = t.bbox
            area_ratio = (x1 - x0) * (y1 - y0) / (page.rect.width * page.rect.height)
            if max_len > 80 or multi < 2 or area_ratio > 0.6:
                continue
            tabs.append((t.bbox, rows))
    except Exception:
        pass
    return lines, tabs


def merge_same_row(lines, tol=2.5):
    """同一 y 上的相邻文本块合成一行（节标题常被拆成「第一节」「地球的自转」）。
    仅合并标题行或紧邻的碎片，避免把左右两栏同高的正文拼在一起。"""
    lines = sorted(lines, key=lambda l: (l['y0'], l['x0']))
    out = []
    for l in lines:
        if out and abs(l['y0'] - out[-1]['y0']) <= tol:
            prev = out[-1]
            both_heading = prev['size'] >= 13.5 and l['size'] >= 13.5
            close = l['x0'] - prev['x1'] <= 10
            if both_heading or close:
                prev['text'] = (prev['text'] + ' ' + l['text']).strip()
                prev['x1'] = max(prev['x1'], l['x1'])
                prev['size'] = max(prev['size'], l['size'])
                prev['y1'] = max(prev['y1'], l['y1'])
                continue
        out.append(dict(l))
    return out


def table_text(rows, print_page):
    lines = [f'【表】表（P{print_page}）']
    for r in rows:
        lines.append(' | '.join(c for c in r if c))
    return '\n'.join(lines)


def convert(pdf_path, start, end, dry=False):
    doc = pymupdf.open(pdf_path)
    toc = parse_toc(doc)
    by_page = collections.defaultdict(list)
    for e in toc:
        by_page[e['pdfPage']].append(e)

    parts = []
    stats = {'pages': 0, 'chars': 0, 'tables': 0, 'captions': 0, 'h2': 0, 'h3': 0, 'h4': 0,
             'tocMismatch': []}
    detected = {}

    para = []
    pending_label = None
    pending_chapter = None
    marker_queue = []
    total_chars = 0

    def flush_para():
        nonlocal para, pending_label, total_chars
        text = ''.join(para).strip()
        if text:
            if pending_label:
                text = f'【{pending_label}】{text}'
                pending_label = None
            parts.append(f'<p>{html.escape(text)}</p>')
            total_chars += len(text)
        para = []
        while marker_queue:
            parts.append(f'<p>{marker_queue.pop(0)}</p>')

    for pno in range(start - 1, min(end, len(doc))):
        page = doc[pno]
        pdf_page = pno + 1
        print_page = pdf_page - PRINT_OFFSET
        lines, tabs = page_lines(page)
        tb = [t[0] for t in tabs]
        lines = [l for l in lines if not inside((l['x0'], l['y0'], l['x1'], l['y1']), tb)]
        lines = merge_same_row(lines)
        if not lines and not tabs:
            continue
        stats['pages'] += 1

        # 结构注入（目录为权威）。先把上一页跨页段落收口，避免章引言被新一节的 h3 抢走
        flush_para()
        injected = set()
        chapter_injected = False
        for e in by_page.get(pdf_page, []):
            tag = 'h2' if e['kind'] == 'chapter' else 'h3'
            attr = ' class="chapter-title"' if tag == 'h2' else ''
            parts.append(f"<{tag}{attr}>{html.escape(e['title'])}</{tag}>")
            stats['h2' if tag == 'h2' else 'h3'] += 1
            injected.add(norm(e['title']))
            if tag == 'h2':
                chapter_injected = True
        # 页码标记延后到当前段落结束，避免把跨页句子切断
        marker = f'〔P{print_page}〕'
        if para:
            marker_queue.append(marker)
        else:
            parts.append(f'<p>{marker}</p>')

        items = []
        for bb, rows in tabs:
            items.append({'y': bb[1], 'x': bb[0], 'kind': 'table', 'rows': rows})
        for l in lines:
            items.append({'kind': 'line', 'y': l['y0'], 'x': l['x0'], **l})
        items.sort(key=lambda i: (i['y'], i['x']))
        pending_chapter = None

        for it in items:
            if it['kind'] == 'table':
                flush_para()
                parts.append('<p>' + html.escape(table_text(it['rows'], print_page)).replace('\n', '<br/>') + '</p>')
                stats['tables'] += 1
                continue

            t = it['text']
            size = it['size']
            font = it['font']
            is_ht = 'HT' in font
            n = norm(t)
            if re.fullmatch(r'[\W_]+', n):
                continue  # 知识结构图里的花括号/箭头等纯符号

            # 章标题（目录未覆盖时兜底）：18pt 章号 + 40pt 标题
            if chapter_injected and size >= 24:
                continue
            if 15 <= size <= 22 and CHAPTER_RE.match(n):
                pending_chapter = t
                continue
            if size >= 35:
                flush_para()
                title = f'{pending_chapter} {t}' if pending_chapter else t
                parts.append(f'<h2 class="chapter-title">{html.escape(title)}</h2>')
                stats['h2'] += 1
                injected.add(norm(title))
                pending_chapter = None
                continue
            if size >= 24 and size < 30 and SECTION_RE.match(n):
                if n not in injected:
                    flush_para()
                    parts.append(f'<h3>{html.escape(t)}</h3>')
                    stats['h3'] += 1
                    injected.add(n)
                else:
                    # 目录已注入，记录用于页偏移校验
                    detected[n] = pdf_page
                continue
            if H4_RE.match(n) and ((size >= 13.5 and is_ht) or (size >= 12 and is_ht and len(n) <= 18)):
                flush_para()
                heading = re.sub(r'^([一二三四五六七八九十]+、)\s+', r'\1', t)
                parts.append(f'<h4>{html.escape(heading)}</h4>')
                stats['h4'] += 1
                continue
            if n in LABELS and size >= 12:
                flush_para()
                pending_label = n
                continue
            if CAPTION_RE.match(n) and size <= 10:
                flush_para()
                parts.append(f'<p>【图】{html.escape(t)}（P{print_page}）</p>')
                stats['captions'] += 1
                continue
            if size <= 9.5:
                continue  # 9pt 除图注外均为图内注释/脚注，入正文会打碎句子
            if size >= 13.5 and not CHAPTER_RE.match(n) and not SECTION_RE.match(n) and len(n) <= 24:
                # 阅读/探究框的小标题（如「傅科摆」）
                flush_para()
                if pending_label:
                    parts.append(f'<p>【{pending_label}】{html.escape(t)}</p>')
                    pending_label = None
                else:
                    parts.append(f'<p>{html.escape(t)}</p>')
                continue

            # 正文行
            if para and (LIST_RE.match(n) or it['x0'] > para_x0 + 8 or it['y0'] - para_y1 > 9):
                flush_para()
            if not para:
                para_x0 = it['x0']
            para.append(t)
            para_y1 = it['y1']

    flush_para()
    stats['chars'] = total_chars

    # 目录 vs 实际页偏移校验
    for e in toc:
        if e['kind'] != 'section':
            continue
        key = norm(e['title'])
        if key in detected and detected[key] != e['pdfPage']:
            stats['tocMismatch'].append({'title': e['title'], 'toc': e['pdfPage'], 'text': detected[key]})

    body = '\n'.join(parts)
    out = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(BOOK)} 高中 {html.escape(GRADE)}（湘教版）</title></head><body>
<div class="cover"><h1 class="book-name">{html.escape(BOOK)}</h1><p class="grade">{html.escape(GRADE)}</p><p class="publisher">{html.escape(PUBLISHER)}</p></div>
{body}
</body></html>
'''
    doc.close()
    return out, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', default=DEFAULT_PDF)
    ap.add_argument('--start', type=int, default=7)
    ap.add_argument('--end', type=int, default=132)
    ap.add_argument('--out-html', default=OUT_HTML)
    ap.add_argument('--out-stats', default=OUT_STATS)
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    out, stats = convert(args.pdf, args.start, args.end, args.dry)
    for p in (args.out_html, args.out_stats):
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
    with open(args.out_html, 'w', encoding='utf-8') as f:
        f.write(out)
    with open(args.out_stats, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print(f'\nHTML: {args.out_html}  {os.path.getsize(args.out_html) // 1024}KB')


if __name__ == '__main__':
    main()
