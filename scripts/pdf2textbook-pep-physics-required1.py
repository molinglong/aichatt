# -*- coding: utf-8 -*-
"""
人教社《普通高中教科书·物理》PDF → 知识库导入 HTML（必修一/二/三通用）

要点（与数学册不同）：
- 中文文本层完好，无需字符映射；字体是正常 Unicode。
- 公式是“更小字号 + 基线偏移”的上下标，分式是上下堆叠（按字符坐标 + 横线还原为 a/b）。
- 练习与应用/复习与提高是 10.5pt 双栏；学生实验正文是 12pt 双栏，按栏读取。
- 图注/脚注 9pt，旁批 12pt 楷体贴边；页码/页眉/水印在 y>772。
- 表格用 PyMuPDF find_tables 抽取并过滤图区误检。

用法：
  python scripts/pdf2textbook-pep-physics-required1.py            # 默认必修一
  python scripts/pdf2textbook-pep-physics-required1.py --pdf xxx.pdf --start 6 --end 112 \
      --skip 111 --out-html deliverables/xxx.html --out-stats deliverables/xxx.json \
      --grade "必修 第二册" --title "物理 高中 必修 第二册"
"""
import pymupdf, re, json, html, os, argparse, statistics

PDF = r"D:\xiaz\教材下载\普通高中教科书·物理必修 第一册.pdf"
OUT_HTML = "deliverables/physics-required1-full.import.html"
OUT_STATS = "deliverables/physics-required1-full.stats.json"
START_PAGE, END_PAGE = 6, 132
SKIP_PAGES = {130, 131}  # 索引
BOOK_NAME = '物理 高中'
GRADE = '必修 第一册'
TITLE = '物理 高中 必修 第一册'

SUP = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹',
       '+':'⁺','-':'⁻','−':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ'}
SUB = {'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉',
       '+':'₊','-':'₋','−':'₋','=':'₌','(':'₍',')':'₎','n':'ₙ',
       'a':'ₐ','e':'ₑ','h':'ₕ','i':'ᵢ','j':'ⱼ','k':'ₖ','l':'ₗ','m':'ₘ','o':'ₒ','p':'ₚ',
       'r':'ᵣ','s':'ₛ','t':'ₜ','u':'ᵤ','v':'ᵥ','x':'ₓ'}

LABELS = {'问题','实验','演示','思考与讨论','做一做','科学方法','拓展学习','STSE','科学漫步',
          '练习与应用','复习与提高'}
EXERCISE_LABELS = {'练习与应用','复习与提高'}
CIRCLED = set('①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮')
MATH_CHARS = re.compile(r"^[A-Za-z0-9\u0391-\u03c9\u0394\u03a3\u2211\u221a\u00b1\u00d7\u00f7\u00b7"
                        r"\u2032\u2033\u221d\u25b3\u00b0\u2212\u2014\-\(\)\[\]\{\}\+\*/=<>≤≥≈≠,\.\uff0d\uff1d\uff0b\uff0f\uff08\uff09\uff1c\uff1e]$")

d = None

# 少量显示器公式的排版修复（逐条对照教材页面核对后固化；避免通用正则误伤）
FIXES = [
    (r'√\((Gm_地 / R)\) √\((.+?)\) v＝ ＝ m/s', r'v＝√(\1)＝√(\2) m/s'),
    (r'√\((Gm_地 / r)\) 但由公式 v＝ 可知', r'但由公式 v＝√(\1) 可知'),
    (r'逃逸速度是√\((2Gm / R)\) 环绕速度的 2倍，即 v[\'′]?＝ 。',
     r'逃逸速度是环绕速度的√2倍，即 v′＝√(\1)。'),
    (r'l＝l₀ √\(－（v / c）²\)1', 'l＝l₀√(1－(v/c)²)'),
    (r'√\((2F_合l / m)\) v＝ ＝', r'v＝√(\1)＝'),
    (r'得v＝ 2neu / m', '得v＝√(2neu/m)'),
    (r'第n个圆筒的长度为vT T l＝vt＝ ＝ 2 2m√\(2neum\)',
     '第n个圆筒的长度为 l＝vt＝vT/2＝(T/2m)√(2neum)'),
]


def apply_fixes(t):
    for pat, rep in FIXES:
        t = re.sub(pat, rep, t)
    return t


def clean_text(t):
    t = t.replace('\u00ad', '').replace('\u200b', '')
    t = ''.join(ch for ch in t if ch >= ' ')
    t = ''.join(ch for ch in t if not (0x0300 <= ord(ch) <= 0x036F))
    t = t.replace('〜', '～').replace('\u3000', ' ')
    t = re.sub(r'^[~～∼]\s*(?=图)', '', t)
    t = re.sub(r'(?<=\d)\s+(?=\d{2}\s*世纪)', '～', t)
    t = re.sub(r'[ \t]{2,}', ' ', t)
    t = re.sub(r'\s+([，。、；：？！）》”’])', r'\1', t)
    t = re.sub(r'([（《“‘])\s+', r'\1', t)
    # 图区内一串孤立字母（如 t₁ t₂ t₃ t₄ t）夹在中文句中时清掉
    t = re.sub(r'(?<=[\u4e00-\u9fff])[a-zA-Z][₀-₉]?(?:\s+[a-zA-Z][₀-₉]?){3,}\s*(?=[\u4e00-\u9fff])', '', t)
    t = re.sub(r'(?<=[\u4e00-\u9fff，。；：])(?:\s+[A-Za-z]){2,}\s*(?=[\u4e00-\u9fff])', '', t)
    t = re.sub(r'\s+(?=[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺₀₁₂₃₄₅₆₇₈₉])', '', t)
    t = re.sub(r'＝\s+√', '＝√', t)
    t = re.sub(r'＝\s+√', '＝√', t)
    return apply_fixes(t).strip()


def page_chars(pno):
    pg = d[pno - 1]
    out = []
    for b in pg.get_text('rawdict')['blocks']:
        if b['type'] != 0:
            continue
        for l in b['lines']:
            for s in l['spans']:
                for ch in s['chars']:
                    c = ch['c']
                    x, y = ch['origin']
                    if y > 772 or y < 40:
                        continue
                    out.append({'c': c, 'x': x, 'y': y, 'size': s['size'],
                                'font': s['font'], 'x0': ch['bbox'][0], 'x1': ch['bbox'][2]})
    return out


def page_bars(pno):
    pg = d[pno - 1]
    out = []
    try:
        drawings = pg.get_drawings()
    except Exception:
        return out
    for dr in drawings:
        for it in dr['items']:
            if it[0] == 'l':
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 0.8:
                    x0, x1 = sorted((a.x, b.x))
                    if 6 < x1 - x0 < 260 and 40 < a.y < 772:
                        out.append((x0, x1, (a.y + b.y) / 2))
    return out


def page_radicals(pno, chars):
    """识别根号：横线上方无数学字符、横线下有数学字符，且横线左侧有 √ 小图形。"""
    pg = d[pno - 1]
    out = []
    try:
        drawings = pg.get_drawings()
    except Exception:
        return out
    glyphs = []
    bars = []
    for dr in drawings:
        r = dr['rect']
        for it in dr['items']:
            if it[0] == 'l':
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 0.8:
                    x0, x1 = sorted((a.x, b.x))
                    if 15 < x1 - x0 < 220 and 40 < a.y < 772:
                        bars.append((x0, x1, a.y))
        if 6 <= r.width <= 18 and 12 <= r.height <= 22 and r.y0 > 40:
            lines = [it for it in dr['items'] if it[0] == 'l']
            if len(lines) >= 4 and len(lines) >= 0.8 * len(dr['items']):
                glyphs.append(r)
    for x0, x1, y in bars:
        below = [c for c in chars if y + 1 <= c['y'] <= y + 18 and x0 - 1 <= c['x'] <= x1 + 2 and MATH_CHARS.match(c['c'])]
        above = [c for c in chars if y - 18 <= c['y'] <= y - 1 and x0 - 1 <= c['x'] <= x1 + 2 and MATH_CHARS.match(c['c'])]
        has_glyph = any(g.x1 <= x0 + 2 and g.x1 >= x0 - 15 and g.y0 <= y + 6 and g.y1 >= y - 6 for g in glyphs)
        if below and not above and has_glyph:
            out.append((x0, x1, y))
    return out


def detect_fractions(chars, bars):
    """上下堆叠的数学字符行 + 分式横线 → '分子 / 分母'。"""
    cand = [c for c in chars if 10 <= c['size'] <= 13.5 and MATH_CHARS.match(c['c'])]
    rows = []
    for c in sorted(cand, key=lambda z: (z['y'], z['x'])):
        if rows and abs(rows[-1][-1]['y'] - c['y']) < 2.0:
            rows[-1].append(c)
        else:
            rows.append([c])
    rows = [sorted(r, key=lambda z: z['x']) for r in rows]
    # 同一 y 上可能并排多个分式，按 x 间隙切开，避免把两个分式拼成一个
    rows2 = []
    for r in rows:
        seg = []
        for c in r:
            if seg and c['x0'] - seg[-1]['x1'] > 25:
                rows2.append(seg)
                seg = []
            seg.append(c)
        if seg:
            rows2.append(seg)
    rows = rows2
    fracs, used = [], set()
    for i, upper in enumerate(rows):
        if id(upper[0]) in used:
            continue
        umin, umax = min(c['x0'] for c in upper), max(c['x1'] for c in upper)
        for j in range(i + 1, min(i + 9, len(rows))):
            lower = rows[j]
            if id(lower[0]) in used:
                continue
            if not (9.5 <= lower[0]['y'] - upper[0]['y'] <= 19.0):
                continue
            lmin, lmax = min(c['x0'] for c in lower), max(c['x1'] for c in lower)
            ov = min(umax, lmax) - max(umin, lmin)
            uw, lw = umax - umin, lmax - lmin
            if ov <= 0 or ov < 0.5 * min(uw, lw) or uw > 200 or lw > 200:
                continue
            if any('\u4e00' <= c['c'] <= '\u9fff' for c in upper + lower):
                continue
            if len(upper) + len(lower) > 30:
                continue
            # 必须有横线（真分式），排除图区/双栏文字偶然上下相邻
            bar_ok = any(abs(by - (upper[0]['y'] + lower[0]['y']) / 2) <= 6.0
                         and bx0 <= umin + 2 and bx1 >= max(umax, lmax) - 2
                         for bx0, bx1, by in bars)
            if not bar_ok:
                continue
            def row_text(row, ry):
                items = list(row) + [c for c in chars
                                     if c['size'] < 8.7 and min(umin, lmin) - 3 <= c['x0'] <= max(umax, lmax) + 6
                                     and abs(c['y'] - ry) <= 7.0]
                items.sort(key=lambda c: c['x0'])
                buf = []
                for c in items:
                    if c['size'] < 8.7:
                        mode = 'sub' if c['y'] > ry else ('sup' if c['y'] < ry - 1.0 else 'body')
                        buf.append(map_small(c['c'], mode) if mode != 'body' else c['c'])
                    else:
                        buf.append(c['c'])
                return ''.join(buf)
            smalls = [c for c in chars if c['size'] < 8.7 and min(umin, lmin) - 3 <= c['x0'] <= max(umax, lmax) + 6
                      and (abs(c['y'] - upper[0]['y']) <= 7.0 or abs(c['y'] - lower[0]['y']) <= 7.0)]
            used.update(id(c) for c in smalls)
            upper_t = row_text(upper, upper[0]['y'])
            lower_t = row_text(lower, lower[0]['y'])
            def wrap_frac(s):
                return f'（{s}）' if re.search(r'[－+\-−×÷]', s) else s
            fracs.append({'text': wrap_frac(upper_t) + ' / ' + wrap_frac(lower_t),
                          'x0': umin, 'x1': umax, 'y': (upper[0]['y'] + lower[0]['y']) / 2,
                          'size': max(c['size'] for c in upper + lower)})
            used.update(id(c) for c in upper + lower)
            break
    return fracs, used


def map_small(txt, mode):
    out = []
    for ch in txt:
        if ch.isspace():
            continue
        if ch in CIRCLED or ch in '*﹡†‡':
            out.append(ch)
            continue
        m = SUP if mode == 'sup' else SUB
        out.append(m.get(ch, ('^' if mode == 'sup' else '_') + ch))
    return ''.join(out)


def assemble_text(tokens, size):
    parts, prev = [], None
    no_space = '，。、；：？！）》”’）]},.;:?!'
    for t in tokens:
        if t['text'] == ' ':
            if parts and not parts[-1].endswith(' '):
                parts.append(' ')
            continue
        if prev is not None:
            gap = t['x0'] - prev['x1']
            a, b = prev['text'][-1:], t['text'][:1]
            if gap > max(2.0, 0.45 * size) and a and b and b not in no_space and a not in '（《“‘([{' \
                    and not b[0] in '₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺':
                parts.append(' ')
        parts.append(t['text'])
        prev = t
    return clean_text(''.join(parts))


def build_lines(pno):
    chars = page_chars(pno)
    if not chars:
        return []
    bars = page_bars(pno)
    rads = page_radicals(pno, chars)
    rad_bars = []
    for rx0, rx1, ry in rads:
        for b in bars:
            if abs(b[2] - ry) < 1.0 and abs(b[0] - rx0) < 2.0:
                rad_bars.append(b)
    fracs, used = detect_fractions(chars, [b for b in bars if b not in rad_bars])
    radical_tokens = []
    for rx0, rx1, ry in rads:
        items = [c for c in chars if id(c) not in used and ry + 2 <= c['y'] <= ry + 24
                 and rx0 - 1 <= c['x0'] < rx1]
        while items and items[-1]['c'] in '＝=＋+－-×÷（(【[' and items[-1]['x0'] > rx1 - 8:
            items.pop()
        frac_items = [f for f in fracs if ry + 2 <= f['y'] <= ry + 24 and f['x1'] > rx0 and f['x0'] < rx1]
        if not items and not frac_items:
            continue
        mains = [c for c in items if c['size'] >= 10]
        baseline = statistics.median(c['y'] for c in mains) if mains else ry + 9
        toks = [{'text': f['text'], 'x0': f['x0'], 'x1': f['x1'], 'size': f['size']} for f in frac_items]
        for c in items:
            txt = c['c']
            if c['size'] < 8.7:
                mode = 'sup' if c['y'] < baseline - 1 else ('sub' if c['y'] > baseline + 1 else 'body')
                if mode != 'body':
                    txt = map_small(txt, mode)
            toks.append({'text': txt, 'x0': c['x0'], 'x1': c['x1'], 'size': c['size']})
            used.add(id(c))
        toks.sort(key=lambda z: z['x0'])
        inner = assemble_text(toks, max((z['size'] for z in toks), default=12))
        if not re.search(r'[a-z0-9α-ωΑ-Ω＋+\-×÷]', inner):
            continue
        radical_tokens.append({'text': '√(' + inner + ')', 'x0': rx0 - 12,
                               'x1': max(z['x1'] for z in toks), 'y': baseline,
                               'size': 12, 'font': 'RADICAL', 'kind': 'frac'})
        fracs = [f for f in fracs if f not in frac_items]
    base, small = list(radical_tokens), []
    for f in fracs:
        base.append({'text': f['text'], 'x0': f['x0'], 'x1': f['x1'], 'y': f['y'],
                     'size': f['size'], 'font': 'MATHFRAC', 'kind': 'frac'})
    for c in chars:
        if id(c) in used:
            continue
        t = {'text': c['c'], 'x0': c['x0'], 'x1': c['x1'], 'y': c['y'],
             'size': c['size'], 'font': c['font'], 'kind': 'char'}
        if c['c'].isspace():
            if c['size'] >= 8.7:
                base.append(t)
            continue
        (base if c['size'] >= 8.7 else small).append(t)
    if not base:
        return []
    nonchar = [t for t in base if t['kind'] != 'char']
    if nonchar:
        base = [t for t in base if not (t['text'] == ' ' and any(o['x0'] <= t['x0'] <= o['x1'] for o in nonchar))]

    base.sort(key=lambda t: (t['y'], t['x0']))
    clusters = []
    for t in base:
        if clusters and abs(clusters[-1]['y'] - t['y']) <= 3.2 and abs(clusters[-1]['size'] - t['size']) <= 2.2:
            g = clusters[-1]
            g['tokens'].append(t)
            g['y'] = sum(x['y'] for x in g['tokens']) / len(g['tokens'])
        else:
            clusters.append({'y': t['y'], 'tokens': [t], 'size': t['size']})
    for g in clusters:
        g['tokens'].sort(key=lambda t: t['x0'])

    # 同一基线上跨度 >25pt 的断点视为分栏/分块（旁批、图注等），切成独立行；大字号标题不切
    split = []
    for g in clusters:
        seg = []
        for t in g['tokens']:
            if seg and t['x0'] - seg[-1]['x1'] > 12 and g['size'] < 20:
                split.append({'y': g['y'], 'tokens': seg, 'size': g['size']})
                seg = []
            seg.append(t)
        if seg:
            split.append({'y': g['y'], 'tokens': seg, 'size': g['size']})
    clusters = split

    # 小字号字符只吸附到紧贴基字符右侧的上下标/脚注号
    for t in small:
        best = None
        for g in clusters:
            dy = t['y'] - g['y']
            if abs(dy) > 8.5:
                continue
            near = [b for b in g['tokens'] if b['kind'] == 'char' and -2 <= t['x0'] - b['x1'] <= 9]
            if not near:
                continue
            score = abs(dy) - 0.05 * (t['x0'] - near[0]['x1'])
            if best is None or score < best[0]:
                best = (score, g, dy)
        if not best:
            continue
        _, g, dy = best
        mode = 'sup' if dy < -1.0 else ('sub' if dy > 1.0 else 'body')
        txt = map_small(t['text'], mode) if mode != 'body' else t['text']
        g['tokens'].append({'text': txt, 'x0': t['x0'], 'x1': t['x1'], 'y': t['y'],
                            'size': t['size'], 'font': t['font'], 'kind': 'small'})
        g['tokens'].sort(key=lambda z: z['x0'])

    lines = []
    for g in clusters:
        text = assemble_text(g['tokens'], g['size'])
        if not text:
            continue
        g['text'] = text
        g['x0'] = min(t['x0'] for t in g['tokens'])
        g['x1'] = max(t['x1'] for t in g['tokens'])
        g['size'] = max(t['size'] for t in g['tokens'])
        # 以“占字符数最多”的字号为语义字号（避免装饰性大问号抬高整行）
        cnt = {}
        for t in g['tokens']:
            cnt[round(t['size'], 1)] = cnt.get(round(t['size'], 1), 0) + len(t['text'])
        g['core_size'] = max(cnt.items(), key=lambda kv: kv[1])[0]
        g['has_body'] = any(11.5 <= t['size'] <= 12.6 for t in g['tokens'])
        g['fonts'] = set(t['font'] for t in g['tokens'] if t['kind'] == 'char')
        lines.append(g)
    lines.sort(key=lambda g: (g['y'], g['x0']))
    return lines


def page_tables(pno):
    pg = d[pno - 1]
    try:
        tabs = pg.find_tables()
    except Exception:
        return []
    out = []
    for tb in tabs.tables:
        data = tb.extract()
        if not data:
            continue
        rows = []
        for r in data:
            rows.append([re.sub(r'\s+', ' ', str(c).replace('\n', ' ')).strip() if c is not None else ''
                         for c in r])
        ncols = max(len(r) for r in rows)
        keepcols = [ci for ci in range(ncols) if any(ci < len(r) and r[ci] for r in rows)]
        rows = [[r[ci] for ci in keepcols if ci < len(r)] for r in rows]
        rows = [r for r in rows if any(r)]
        nonempty = sum(1 for r in rows for c in r if c)
        total = sum(len(r) for r in rows)
        good_rows = sum(1 for r in rows if sum(1 for c in r if c) >= 2)
        bbox = tb.bbox
        if len(rows) < 3 or good_rows < 2 or nonempty < 6 or nonempty / max(total, 1) < 0.2:
            continue
        if bbox[2] - bbox[0] < 120 or bbox[3] - bbox[1] < 35:
            continue
        # 过滤掉明显是图区网格的误检（列多且空）
        if len(keepcols) > 8 and nonempty / max(total, 1) < 0.45:
            continue
        # 图区字母标签误检：几乎全是单字符且没有中文/长词
        contentish = sum(1 for r in rows for c in r if c and (re.search(r'[\u4e00-\u9fff]', c) or len(c) >= 3))
        if contentish < 2:
            continue
        out.append({'bbox': bbox, 'rows': rows})
    return out


def in_bbox(c, bb):
    return bb[0] - 1 <= c['x0'] <= bb[2] + 1 and bb[1] - 1 <= c['y'] <= bb[3] + 1


def fix_table_cell(s):
    s = re.sub(r'm\s*·\s*s\s*-\s*2', 'm·s⁻²', s)
    s = re.sub(r'm\s*·\s*s\s*-\s*1', 'm·s⁻¹', s)
    s = re.sub(r'm\s*/\s*s\s*-\s*2', 'm/s²', s)
    s = re.sub(r'm\s*/\s*s\s*2', 'm/s²', s)
    s = re.sub(r'×\s*10([0-9])', lambda m: '×10' + SUP.get(m.group(1), m.group(1)), s)
    s = re.sub(r'10\s*-\s*([0-9])', lambda m: '10⁻' + SUP.get(m.group(1), m.group(1)), s)
    s = re.sub(r'(kg|km|cm|mm)\s*-\s*1', lambda m: m.group(1) + '⁻¹', s)
    return s


def split_atom_at(atom, boundary):
    """把跨栏的正文行按 x 边界拆成左右两段（练习/学生实验双栏）。"""
    if atom['kind'] != 'role' or atom['role'][0] != 'body':
        return [atom]
    if len(atom['role'][1].get('text', '')) <= 4:
        return [atom]
    ln = atom['line']
    toks = ln.get('tokens') or []
    if not toks:
        return [atom]
    res = []
    for part in ([t for t in toks if t['x0'] < boundary], [t for t in toks if t['x0'] >= boundary]):
        if not part:
            continue
        txt = assemble_text(part, ln['size'])
        if not txt:
            continue
        x0 = min(t['x0'] for t in part)
        res.append({'kind': 'role', 'role': ('body', dict(atom['role'][1], text=txt), {'y': ln['y'], 'x0': x0}),
                    'y': ln['y'], 'x0': x0, 'line': {'y': ln['y'], 'x0': x0}})
    return res


def find_gutter(atoms):
    """在双栏内容里找出栏间空隙的中点；找不到返回 None。"""
    spans = []
    for a in atoms:
        if a['kind'] != 'role' or a['role'][0] != 'body':
            continue
        toks = a['line'].get('tokens') or []
        spans.extend((t['x0'], t['x1']) for t in toks if t['text'].strip())
    if not spans:
        return None
    spans.sort()
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + 1.0:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    best = None
    for i in range(len(merged) - 1):
        gap = merged[i + 1][0] - merged[i][1]
        if gap >= 10 and merged[i][1] > 150 and merged[i + 1][0] < 460:
            if best is None or gap > best[0]:
                best = (gap, merged[i][1], merged[i + 1][0])
    if not best:
        return None
    return (best[1] + best[2]) / 2


def convert():
    elements = []
    chapter_no = 0
    section = None
    block = None
    prev_body = None
    prev_body_idx = None
    last_kind = None
    last_page = None

    def push(kind, payload):
        nonlocal prev_body, prev_body_idx, last_kind
        elements.append((kind, payload))
        last_kind = kind
        if kind != 'body':
            prev_body = None
            prev_body_idx = None

    for pno in range(START_PAGE, END_PAGE + 1):
        if pno in SKIP_PAGES:
            continue
        lines = build_lines(pno)
        tables = page_tables(pno)
        if tables:
            def in_table(l):
                return any(in_bbox({'x0': l['x0'], 'x1': l['x1'], 'y': l['y']}, t['bbox']) for t in tables)
            lines = [l for l in lines if not in_table(l) or l['text'].startswith(('图', '表'))]

        # 本页正文主字号（章首页正文是 14pt，普通页 12pt）
        size_cnt = {}
        for l in lines:
            if l['core_size'] >= 11 and len(re.findall(r'[\u4e00-\u9fff]', l['text'])) >= 8:
                k = round(l['core_size'], 1)
                size_cnt[k] = size_cnt.get(k, 0) + 1
        page_body_sz = 12.0
        if size_cnt:
            sz0, n0 = max(size_cnt.items(), key=lambda kv: kv[1])
            if n0 >= 4:
                page_body_sz = sz0
        body_col_x0 = min((l['x0'] for l in lines
                           if abs(l['core_size'] - page_body_sz) <= 0.7
                           and len(re.findall(r'[\u4e00-\u9fff]', l['text'])) >= 8), default=0)

        # 旁批分组：楷体、贴边、12pt；单行短句不算（可能是思考框末行）
        note_cand = [l for l in lines if 11.5 <= l['core_size'] <= 12.6 and 'FZKT' in ''.join(l['fonts'])
                     and (l['x1'] < 215 or l['x0'] > 385) and l['text'].replace(' ', '') not in LABELS]
        note_cand.sort(key=lambda l: (l['x0'] > 385, l['y']))
        note_groups = []
        for l in note_cand:
            placed = False
            for grp in note_groups:
                if (grp[0]['x0'] > 385) == (l['x0'] > 385) and abs(grp[-1]['x0'] - l['x0']) <= 26 and 0 < l['y'] - grp[-1]['y'] <= 30:
                    grp.append(l)
                    placed = True
                    break
            if not placed:
                note_groups.append([l])
        page_notes = []
        note_ids = set()
        for grp in note_groups:
            if len(grp) >= 2 or sum(len(x['text']) for x in grp) >= 22:
                page_notes.append(grp)
                note_ids.update(id(x) for x in grp)
        if page_notes:
            lines = [l for l in lines if id(l) not in note_ids]

        roles = []   # (kind, payload, line)
        skip_next = False
        last9 = None
        i = 0
        while i < len(lines):
            if skip_next:
                skip_next = False
                i += 1
                continue
            l = lines[i]
            t, sz, fonts = l['text'], l['core_size'], ''.join(l['fonts'])
            plain = t.replace(' ', '')
            lab = plain.rstrip('？?')

            if sz >= 100:
                i += 1
                continue

            m = re.match(r'^第([一二三四五六七八九十]+)章$', plain)
            if m and sz >= 22:
                subtitle = ''
                if i + 1 < len(lines) and lines[i + 1]['core_size'] >= 26 and 0 < lines[i + 1]['y'] - l['y'] < 60:
                    subtitle = lines[i + 1]['text']
                    skip_next = True
                chapter_no = '一二三四五六七八九十'.index(m.group(1)[0]) + 1 if len(m.group(1)) == 1 else chapter_no + 1
                section = None
                block = None
                roles.append(('h2', {'text': (t + ' ' + subtitle).strip(), 'chapter': True}, l))
                i += 1
                continue
            if sz >= 28 and plain == '序言':
                subtitle = ''
                if i + 1 < len(lines) and 16 <= lines[i + 1]['core_size'] <= 20 and 0 < lines[i + 1]['y'] - l['y'] < 50:
                    subtitle = lines[i + 1]['text']
                    skip_next = True
                section = None
                block = None
                roles.append(('h2', {'text': (t + ' ' + subtitle).strip(), 'chapter': False}, l))
                i += 1
                continue
            if 22 <= sz <= 26 and l['y'] < 320:
                mnum = re.match(r'^\s*(\d+)\s+(.+)$', t)
                if mnum:
                    title = re.sub(r'\s+', ' ', mnum.group(2)).strip()
                    section = f'{chapter_no}.{mnum.group(1)} {title}' if chapter_no else title
                    block = None
                    roles.append(('h3', {'text': section}, l))
                    i += 1
                    continue
                if plain in ('课题研究', '学生实验', '索引', '后记', '致同学们'):
                    if plain == '索引':
                        roles.append(('skip_all', {}, l))
                        break
                    section = plain
                    block = None
                    roles.append(('h2', {'text': plain, 'chapter': False}, l))
                    i += 1
                    continue
            if 17 <= sz <= 19 and plain == '章小结示例':
                section = plain
                block = 'summary'
                roles.append(('h3', {'text': plain}, l))
                i += 1
                continue

            if 11.5 <= sz <= 15.5 and lab in LABELS:
                if lab in EXERCISE_LABELS:
                    roles.append(('h3', {'text': lab}, l))
                    block = 'exercise'
                else:
                    roles.append(('h4', {'text': lab}, l))
                    block = lab
                i += 1
                continue
            if page_body_sz < 13 and 13 <= sz <= 15.5 and not l['has_body'] and len(re.findall(r'[\u4e00-\u9fff]', t)) >= 2:
                roles.append(('h4', {'text': t}, l))
                block = 'sub'
                i += 1
                continue
            if abs(sz - page_body_sz) <= 0.7 and 11.5 <= sz <= 15.5 and 'FZKT' in fonts and (l['x1'] < 215 or l['x0'] > 385):
                roles.append(('body', {'text': t, 'size': sz, 'exercise': block == 'exercise'}, l))
                i += 1
                continue
            if sz <= 9.4:
                tp = t.strip()
                if tp.startswith(('图', '表')):
                    roles.append(('caption', {'text': tp}, l))
                    last9 = ('caption', l)
                    i += 1
                    continue
                if tp[:1] in CIRCLED:
                    roles.append(('footnote', {'text': tp}, l))
                    last9 = ('footnote', l)
                    i += 1
                    continue
                if last9 and last9[0] in ('caption', 'footnote'):
                    pl = last9[1]
                    if 0 < l['y'] - pl['y'] <= 24 and abs(l['x0'] - pl['x0']) <= 28:
                        roles.append((last9[0], {'text': tp}, l))
                        last9 = (last9[0], l)
                        i += 1
                        continue
                i += 1
                continue
            # 序言等页面的装饰性公式碎片（在正文栏左外侧、无汉字）
            if not re.search(r'[\u4e00-\u9fff]', t) and body_col_x0 > 215 and l['x1'] < 212:
                i += 1
                continue

            is_body = abs(sz - page_body_sz) <= 0.7 and sz >= 11.5
            is_block_text = 9.5 <= sz <= 11.4 and block is not None
            if is_body or is_block_text:
                roles.append(('body', {'text': t, 'size': sz, 'exercise': block == 'exercise'}, l))
                i += 1
                continue
            i += 1

        # 双栏检测（仅本页主字号正文，排除旁批/练习）
        two_col = None
        body12 = [r for r in roles if r[0] == 'body' and abs(r[1]['size'] - page_body_sz) <= 0.7 and not r[1].get('exercise')]
        if len(body12) >= 12:
            groups = []
            for v in sorted(r[2]['x0'] for r in body12):
                if groups and v - groups[-1][-1] <= 42:
                    groups[-1].append(v)
                else:
                    groups.append([v])
            big = [g for g in groups if len(g) >= 6]
            if len(big) >= 2:
                centers = sorted(statistics.mean(g) for g in big)
                c1, c2 = centers[0], centers[-1]
                if c2 - c1 > 90:
                    l1 = [r for r in body12 if abs(r[2]['x0'] - c1) <= 45]
                    l2 = [r for r in body12 if abs(r[2]['x0'] - c2) <= 45]
                    o1 = (min(r[2]['y'] for r in l1), max(r[2]['y'] for r in l1))
                    o2 = (min(r[2]['y'] for r in l2), max(r[2]['y'] for r in l2))
                    if min(o1[1], o2[1]) - max(o1[0], o2[0]) > 60:
                        two_col = find_gutter([{'kind': 'role', 'role': r, 'line': r[2]} for r in body12])

        # 分页 → 段落（按标签切段）
        has_ex = any(r[0] == 'body' and r[1].get('exercise') for r in roles)
        if two_col and not has_ex:
            def col_key(r):
                ln = r[2]
                if r[0] in ('h2', 'h3') and ln['x1'] - ln['x0'] > 350:
                    return (-1, ln['y'])
                return (0 if ln['x0'] < two_col else 1, ln['y'])
            roles.sort(key=col_key)

        segments = []
        cur = {'label': None, 'atoms': []}
        for r in roles:
            if r[0] == 'h2' or r[0] == 'h3' or r[0] == 'h4':
                if cur['label'] is not None or cur['atoms']:
                    segments.append(cur)
                cur = {'label': r, 'atoms': []}
            elif r[0] == 'skip_all':
                continue
            else:
                cur['atoms'].append({'kind': 'role', 'role': r, 'y': r[2]['y'], 'x0': r[2]['x0'], 'line': r[2]})
        segments.append(cur)

        # 表格按 y 插入所属段
        for tb in tables:
            ty = tb['bbox'][1]
            target = None
            for sg in segments:
                ly = sg['label'][2]['y'] if sg['label'] else -1
                if ly <= ty:
                    target = sg
            (target or segments[-1])['atoms'].append({'kind': 'table', 'y': ty, 'x0': tb['bbox'][0], 'rows': tb['rows']})

        for sg in segments:
            if sg['label'] is not None:
                kind, payload, ln = sg['label']
                push(kind, payload)
            atoms = sg['atoms']
            if not atoms:
                continue
            is_ex = any(a['kind'] == 'role' and a['role'][0] == 'body' and a['role'][1].get('exercise') for a in atoms)
            if is_ex:
                ex_boundary = find_gutter([a for a in atoms if a['kind'] == 'role' and a['role'][1].get('exercise')]) or 290
                parts = []
                for a in atoms:
                    parts += split_atom_at(a, ex_boundary)
                left = [a for a in parts if a['x0'] < ex_boundary]
                right = [a for a in parts if a['x0'] >= ex_boundary]
                ordered = sorted(left, key=lambda a: (a['y'], a['x0'])) + sorted(right, key=lambda a: (a['y'], a['x0']))
            elif two_col and not has_ex:
                ordered = atoms
            elif two_col and any(a['kind'] == 'role' and a['role'][0] == 'body' and abs(a['role'][1]['size'] - page_body_sz) <= 0.7 for a in atoms):
                parts = []
                for a in atoms:
                    parts += split_atom_at(a, two_col)
                left = [a for a in parts if a['x0'] < two_col]
                right = [a for a in parts if a['x0'] >= two_col]
                ordered = sorted(left, key=lambda a: (a['y'], a['x0'])) + sorted(right, key=lambda a: (a['y'], a['x0']))
            else:
                ordered = sorted(atoms, key=lambda a: (a['y'], a['x0']))

            for a in ordered:
                if a['kind'] == 'table':
                    rows = [[fix_table_cell(c) for c in row] for row in a['rows']]
                    for ri, row in enumerate(rows):
                        push('table', ('【表】' if ri == 0 else '') + ' | '.join(row))
                    continue
                kind, payload, ln = a['role']
                if kind == 'body':
                    text = re.sub(r'^(\d+)[.．](?=[^\d\s])', r'\1. ', payload['text'])
                    x0 = ln['x0']
                    merged = False
                    if prev_body_idx is not None and prev_body_idx < len(elements):
                        pe = elements[prev_body_idx]
                        ptext, px0, ppage, py = pe[1], pe[2], pe[3], pe[4]
                        same_line = (ppage == pno and abs(ln['y'] - py) < 4)
                        if ppage == pno:
                            cont = same_line or (0 < ln['y'] - py <= 30)
                        else:
                            cont = (ppage == pno - 1 and py > 650 and ln['y'] < 170)
                        if cont and not re.search(r'[。！？!?…]$', ptext) and not re.match(r'^\d+[.．]', text) \
                                and not re.match(r'^[（(]\d+[）)]', text) and not re.match(r'^[AB]组$', text):
                            joiner = '' if re.search(r'[\u4e00-\u9fff]$', ptext) else ' '
                            elements[prev_body_idx] = ('body', ptext + joiner + text, x0, pno, ln['y'])
                            merged = True
                    if not merged:
                        elements.append(('body', text, x0, pno, ln['y']))
                        prev_body_idx = len(elements) - 1
                        prev_body = elements[-1]
                        last_kind = 'body'
                elif kind == 'note':
                    keep_idx = prev_body_idx
                    if last_kind == 'note' and elements and elements[-1][0] == 'note' and elements[-1][2] == pno:
                        elements[-1] = ('note', elements[-1][1] + payload['text'], pno)
                    else:
                        push('note', payload['text'])
                        elements[-1] = ('note', elements[-1][1], pno)
                    prev_body_idx = keep_idx
                elif kind == 'caption':
                    keep_idx = prev_body_idx
                    if last_kind == 'caption' and elements and elements[-1][0] == 'caption' and elements[-1][2] == pno:
                        elements[-1] = ('caption', elements[-1][1] + payload['text'], pno)
                    else:
                        push('caption', payload['text'])
                        elements[-1] = ('caption', elements[-1][1], pno)
                    prev_body_idx = keep_idx
                elif kind == 'footnote':
                    keep_idx = prev_body_idx
                    if last_kind == 'footnote' and elements and elements[-1][0] == 'footnote' and elements[-1][2] == pno:
                        sep = ' ' if payload['text'][:1] in CIRCLED else ''
                        elements[-1] = ('footnote', elements[-1][1] + sep + payload['text'], pno)
                    else:
                        push('footnote', payload['text'])
                        elements[-1] = ('footnote', elements[-1][1], pno)
                    prev_body_idx = keep_idx
        # 本页旁批：页末集中输出，避免与正文逐行交错
        for grp in sorted(page_notes, key=lambda g: g[0]['y']):
            txt = ''
            for x in grp:
                j = '' if (not txt or re.search(r'[\u4e00-\u9fff]$', txt)) else ' '
                txt += j + x['text']
            push('note', txt)
        last_page = pno

    # ---------- HTML ----------
    body = []
    for el in elements:
        kind = el[0]
        if kind == 'h2':
            cls = ' class="chapter-title"' if el[1].get('chapter') else ''
            body.append(f'<h2{cls}>{html.escape(el[1]["text"])}</h2>')
        elif kind == 'h3':
            body.append(f'<h3 class="section-title">{html.escape(el[1]["text"])}</h3>')
        elif kind == 'h4':
            body.append(f'<h4>{html.escape(el[1]["text"])}</h4>')
        elif kind == 'body':
            body.append(f'<p>{html.escape(apply_fixes(el[1]))}</p>')
        elif kind == 'note':
            body.append(f'<p>【旁注】{html.escape(el[1])}</p>')
        elif kind == 'caption':
            body.append(f'<p>（{html.escape(el[1])}）</p>')
        elif kind == 'footnote':
            body.append(f'<p>【注释】{html.escape(el[1])}</p>')
        elif kind == 'table':
            body.append(f'<p>{html.escape(el[1])}</p>')

    cover = f'''<div class="cover">
<div class="book-name">{html.escape(BOOK_NAME)}</div>
<div class="grade">{html.escape(GRADE)}</div>
<div class="publisher">人民教育出版社</div>
</div>'''
    doc = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(TITLE)}</title></head><body>
{cover}
{chr(10).join(body)}
</body></html>'''
    os.makedirs('deliverables', exist_ok=True)
    open(OUT_HTML, 'w', encoding='utf-8').write(doc)

    alltext = ''.join(el[1] if isinstance(el[1], str) else el[1].get('text', '') for el in elements)
    stats = {
        'pages': f'{START_PAGE}-{END_PAGE}', 'elements': len(elements), 'chars': len(alltext),
        'h2': sum(1 for e in elements if e[0] == 'h2'),
        'h3': sum(1 for e in elements if e[0] == 'h3'),
        'h4': sum(1 for e in elements if e[0] == 'h4'),
        'body': sum(1 for e in elements if e[0] == 'body'),
        'notes': sum(1 for e in elements if e[0] == 'note'),
        'captions': sum(1 for e in elements if e[0] == 'caption'),
        'footnotes': sum(1 for e in elements if e[0] == 'footnote'),
        'tables': sum(1 for e in elements if e[0] == 'table'),
        'pua': sum(1 for ch in alltext if 0xE000 <= ord(ch) <= 0xF8FF),
        'control': sum(1 for ch in alltext if ord(ch) < 32 and ch != '\n'),
        'rare': sum(1 for ch in alltext if 0x3400 <= ord(ch) <= 0x4DBF),
    }
    open(OUT_STATS, 'w', encoding='utf-8').write(json.dumps(stats, ensure_ascii=False, indent=2))
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', default=PDF)
    ap.add_argument('--start', type=int, default=START_PAGE)
    ap.add_argument('--end', type=int, default=END_PAGE)
    ap.add_argument('--skip', default=','.join(str(x) for x in sorted(SKIP_PAGES)),
                    help='逗号分隔的跳过页（如 130,131）')
    ap.add_argument('--out-html', default=OUT_HTML)
    ap.add_argument('--out-stats', default=OUT_STATS)
    ap.add_argument('--book-name', default=BOOK_NAME)
    ap.add_argument('--grade', default=GRADE)
    ap.add_argument('--title', default=TITLE)
    a = ap.parse_args()
    PDF, START_PAGE, END_PAGE = a.pdf, a.start, a.end
    SKIP_PAGES = {int(x) for x in a.skip.split(',') if x.strip()}
    OUT_HTML, OUT_STATS = a.out_html, a.out_stats
    BOOK_NAME, GRADE, TITLE = a.book_name, a.grade, a.title
    d = pymupdf.open(PDF)
    convert()
