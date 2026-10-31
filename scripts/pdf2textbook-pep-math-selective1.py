import pymupdf, re, json, html, glob

PDF = [x for x in glob.glob(r"D:\xiaz\教材下载\*数学（A版）选择性必修*.pdf") if "第一册" in x][0]
d = pymupdf.open(PDF)

CHAR_MAP = {
0x72d3:'x',0x72d4:'y',0x72aa:'a',0x7283:'A',0x72b3:'f',0x72ab:'b',0x7285:'B',0x69e1:'√',0x72bd:'k',0x7298:'P',0x72cb:'t',0x72c6:'p',0x729a:'R',0x72ae:'c',0x72c0:'n',0x72c7:'q',0x7297:'O',0x7286:'C',0x72c9:'r',0x7295:'M',0x72a3:'Z',0x72b5:'g',0x72bf:'m',0x7287:'D',0x72cf:'v',0x72be:'l',0x72d5:'z',0x729b:'S',0x7296:'N',0x7299:'Q',0x72b1:'d',0x72ba:'h',0x72ca:'s',0x729c:'T',0x729e:'V',0x729d:'U',0x7288:'E',0x7290:'I',0x74d3:'U',0x72d1:'w',0x728e:'H',0x7294:'L',0x72cc:'u',0x7289:'F',0x72bb:'i',0x728c:'G',0x72b2:'e',0x72a0:'W',0x7293:'K',0x72a1:'X',0x72bc:'j',0x72a2:'Y',
0xe011:'-',0xe010:'.',0xe02f:'∀',0xe03c:'⇒',0xe012:'*',0xe055:'∃',0xe020:'⊆',0xe07e:'∅',0xe047:'→',0xe039:'⇔',0xe05b:'∉',0xe08a:'⊃',0xe046:'↙',0xe021:'⊇',0xe089:'⊂',0xe064:'∅',0xe5c6:'',0xe01b:'⊂',0xe061:'⊄',0xe0b4:'▱',0xe54f:'ö',0xe677:'ˈ',0xe143:'ɪ',0xe135:'ə',0xf8f5:'',
}
SUP = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','−':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ'}
SUB = {'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','−':'₋','=':'₌','(':'₍',')':'₎','n':'ₙ'}

SPECIAL = {
28:('阅读与思考','向量概念的推广与应用','向量概念的推广'),
73:('探究与发现','方向向量与直线的参数方程','方向向量与直线'),
85:('阅读与思考','笛卡儿与解析几何','笛卡儿'),
94:('阅读与思考','坐标法与数学机械化','坐标法与数学机械化'),
121:('信息技术应用','用信息技术探究点的轨迹：椭圆','用信息技术探究'),
133:('探究与发现','为什么y=±b/a x是双曲线x²/a²－y²/b²=1的渐近线','渐近线'),
138:('探究与发现','为什么二次函数y=ax²+bx+c的图象是抛物线','二次函数'),
145:('阅读与思考','圆锥曲线的光学性质及其应用','光学性质'),
147:('文献阅读与数学写作','解析几何的形成与发展','解析几何的形成'),
}
SUMMARY = {50,105,148}

def fw_ascii(c):
    o=ord(c)
    if 0xFF10<=o<=0xFF19 or 0xFF21<=o<=0xFF3A or 0xFF41<=o<=0xFF5A:
        return chr(o-0xFEE0)
    return c

def char_text(ch, mode):
    ch=CHAR_MAP.get(ord(ch),ch)
    if ch=='':
        return ''
    ch=fw_ascii(ch)
    if mode=='sup': return SUP.get(ch, '^'+ch)
    if mode=='sub': return SUB.get(ch, '_'+ch)
    return ch

def fix_text(text):
    for a,b in [('belongto','belong to'),('emptyset','empty set'),('unionset','union set'),('intersectionset','intersection set'),('propersubset','proper subset')]:
        text=text.replace(a,b)
    text=text.replace('UUA','∁_U A').replace('UUB','∁_U B')
    text=text.replace('UU（','∁_U（')
    text=text.replace('UAB','∁_A B').replace('USA','∁_S A')
    text=text.replace('UR（','∁_U（').replace('（URA）','（∁_U A）')
    text=re.sub(r'UR([A-Z])', r'∁_U \1', text)
    text=text.replace('A＝x∈Rx²－2＝0','A＝｛x∈R｜x²－2＝0｝')
    text=text.replace('｛x∈Z10＜x＜20｝','｛x∈Z｜10＜x＜20｝')
    text=text.replace('A＝x｜x是长方形','A＝｛x｜x是长方形')
    text=text.replace('B＝x｜x是两条对角线相等的平行四边形','B＝｛x｜x是两条对角线相等的平行四边形｝')
    text=text.replace('祖^!','祖暅').replace('祖!','祖暅')
    # 上下标启发式在标点两侧留下的 caret 噪声
    text=re.sub(r'\^([（），。；：、])', r'\1', text)
    text=re.sub(r'([（），。；：、])\^', r'\1', text)
    for a,b in [('π₂','π/2'),('π₃','π/3'),('π₄','π/4'),('π₆','π/6'),('π₈','π/8')]:
        text=text.replace(a,b)
    return text

def line_from_dict(l):
    spans=l['spans']
    if not spans: return None
    main=max(spans,key=lambda s:s['size'])
    msz=main['size']; moy=main['origin'][1]
    parts=[]; fonts=set(); unassigned=0; total=0; prev_single=None
    for s in spans:
        fonts.add(s['font'].split('-')[0])
        mode='normal'
        if s['size'] < msz*0.78:
            if s['origin'][1] < moy-1.2: mode='sup'
            elif s['origin'][1] > moy+1.2: mode='sub'
        single=(len(s['text'])==1)
        for ch in s['text']:
            total+=1
            if ord(ch)<32: unassigned+=1
            if ch.isspace():
                parts.append(' ')
            else:
                if single and prev_single and mode=='normal' and prev_single['mode']=='normal':
                    if abs(s['bbox'][0]-prev_single['x'])<6 and s['origin'][1] > prev_single['oy']+8:
                        parts.append('/')
                txt=char_text(ch,mode)
                if txt=='^*': txt='*'
                parts.append(txt)
        prev_single={'x':s['bbox'][0],'oy':s['origin'][1],'mode':mode} if single else None
    text=re.sub(r'[ \t\u3000]+',' ',''.join(parts))
    text=fix_text(text)
    return {'text':text,'x0':l['bbox'][0],'x1':l['bbox'][2],'y':l['bbox'][1],'y1':l['bbox'][3],'size':msz,'fonts':fonts,'unassigned':unassigned,'total':total,'page':None}

def is_junk(lo):
    t=lo['text'].strip()
    if not t: return True
    if len(t)<=2 and not re.search(r'[\u4e00-\u9fff0-9A-Za-z]',t): return True
    if lo['total'] and lo['unassigned']/lo['total']>0.3: return True
    zh=sum(1 for c in t if '\u4e00'<=c<='\u9fff')
    letters=sum(1 for c in t if ('A'<=c<='Z') or ('a'<=c<='z'))
    math=any(c in t for c in '∈∉∩∪⊆⊂⊇⊃∅√≤≥≠≈∞παβ°±×÷→⇒⇔∀∃')
    if zh==0 and len(t)<35 and not math and not any('a'<=c<='z' for c in t):
        return True
    good=sum(1 for c in t if '\u4e00'<=c<='\u9fff' or c.isascii() or c in '∈∉∩∪⊆⊂⊇⊃∅√≤≥≠≈∞παβ°±×÷→⇒⇔∀∃')
    if len(t)>=4 and good/len(t)<0.35: return True
    return False

lines=[]
for pno in range(6,152):
    pg=d[pno-1]
    for b in pg.get_text('dict')['blocks']:
        if b['type']!=0: continue
        for l in b['lines']:
            if l['bbox'][1]>772 or l['bbox'][3]<40: continue
            lo=line_from_dict(l); lo['page']=pno
            if lo['text'].strip(): lines.append(lo)
lines=[l for l in lines if not is_junk(l)]

# 注入特殊节/小结/数学建模，并标记标题行
inject_at={}  # (page,y) -> (typ,text)
skip_at=set()
for pno,(typ,title,match) in SPECIAL.items():
    cand=[l for l in lines if l['page']==pno and l['size']>25]
    if not cand: continue
    key=match.replace(' ','')
    matches=[l for l in cand if key and key in l['text'].replace(' ','')]
    if not matches:
        matches=sorted(cand,key=lambda l:-l['size'])[:1]
    first=matches[0]
    inject_at.setdefault((pno,round(first['y'],1)),('h4',f'{typ} {title}',True))
    skip_at.add((pno,round(first['y'],1)))
    # 标题跨行：同页、下方 60pt 内、字号>25 的续行
    for l in cand:
        if 0<l['y']-first['y']<60: skip_at.add((pno,round(l['y'],1)))
for pno in SUMMARY:
    cand=[l for l in lines if l['page']==pno]
    if cand:
        cand.sort(key=lambda l:l['y'])
        first=next((l for l in cand if sum(1 for c in l['text'] if '一'<=c<='鿿')>=15), cand[0])
        for l in cand:
            if l['y'] < first['y']:
                skip_at.add((pno,round(l['y'],1)))
        inject_at.setdefault((pno,round(first['y'],1)),('h4','小结',False))
def is_skipped(l):
    return (l['page'],round(l['y'],1)) in skip_at

elements=[]
i=0
while i < len(lines):
    lo=lines[i]
    key=(lo['page'],round(lo['y'],1))
    if key in inject_at:
        typ,text,skip=inject_at.pop(key)
        elements.append((typ,text))
        if skip: i+=1
        continue
    if is_skipped(lo):
        i+=1; continue
    t=re.sub(r'\s+',' ',lo['text']).strip()
    # 右侧批注
    if lo['x0']>360 and lo['x1']<570:
        parts=[t]; y=lo['y']; j=i+1
        while j<len(lines):
            nx=lines[j]; gap=nx['y']-y
            if nx['x0']<=360 or gap>42: break
            parts.append(nx['text'].strip()); y=nx['y']; j+=1
        elements.append(('note',''.join(parts))); i=j; continue
    # 章
    if lo['size']>45 and re.match(r'^第[一二三四五六七八九十]+章$',t):
        title=t
        if i+1<len(lines) and lines[i+1]['page']==lo['page'] and lines[i+1]['size']>45:
            title+=' '+lines[i+1]['text'].strip(); i+=1
        elements.append(('h2',title)); i+=1; continue
    # 节
    if lo['size']>45 and re.match(r'^\d+\.\d+',t):
        elements.append(('h3',t)); i+=1; continue
    # HTJ 小标题
    htj='HTJ' in ''.join(lo['fonts'])
    if htj and len(t)<=30:
        if re.match(r'^习题\s*$',t) and i+1<len(lines):
            nt=lines[i+1]['text'].strip()
            if re.match(r'^\d+\.\d+$',nt): t=t+' '+nt; i+=1
        if re.match(r'^(列举法|描述法|并集|交集|补集|全集|小结|阅读与思考|探究与发现|信息技术应用|文献阅读与数学写作|习题|复习参考题|章末|数学建模)',t):
            elements.append(('h4',t)); i+=1; continue
    if lo['size']>26.5 and len(t)<=40 and re.match(r'^(阅读与思考|探究与发现|信息技术应用|文献阅读与数学写作|习题|复习参考题|小结)',t):
        elements.append(('h4',t)); i+=1; continue
    # 正文合并
    parts=[t]; x0=lo['x0']; x1=lo['x1']; y=lo['y']; page=lo['page']; j=i+1
    while j<len(lines):
        nx=lines[j]; nt=nx['text'].strip()
        gap=nx['y']-y
        if (nx['page'],round(nx['y'],1)) in inject_at: break
        if is_skipped(nx): break
        if nx['size']>45 or ('HTJ' in ''.join(nx['fonts']) and len(nt)<=30): break
        if re.match(r'^(阅读与思考|探究与发现|信息技术应用|文献阅读与数学写作|习题|复习参考题|小结)',nt): break
        if re.match(r'^\(\d+\)|^\d+[.．]',nt): break
        if nx['x0']>360 and x0<360: break
        # 跨页只在“上页底 + 下页顶”时续接，避免把下一页小结/新节首行吞进上一段
        if nx['page']!=page and not (y>700 and nx['y']<160): break
        same_col=abs(nx['x0']-x0)<64
        if not (same_col and gap<33): break
        prev=parts[-1] if parts else ''
        if prev and prev[-1] in '．。！？!?': break
        merge=False
        if nx['x0']<x0-8: merge=True
        elif nx['x0']<=x0+6 and (x1>430 or (prev and prev[-1] in '，、：（）“”‘’(,')): merge=True
        if not merge: break
        parts.append(nt); x0=nx['x0']; x1=nx['x1']; y=nx['y']; page=nx['page']; j+=1
    text=''.join(parts)
    text=re.sub(r'\s*第[一二三四五六七八九十]+章\s*[^ ]{2,20}\s*$','',text)
    if text.strip(): elements.append(('p',text.strip()))
    i=j

# 输出
out=[]; open_div=None
for typ,text in elements:
    if typ in ('h2','h3','h4'):
        text=text.replace('．','.').replace('　',' ')
    if typ in ('h2','h3','h4') and open_div:
        out.append('</div>'); open_div=None
    if typ=='note':
        if open_div: out.append('</div>'); open_div=None
        out.append(f'<div class="think"><p>{html.escape(text)}</p></div>')
    elif typ=='h2':
        if text.startswith('数学建模'):
            out.append(f'<h2>{html.escape(text)}</h2>')
        else:
            out.append(f'<h2 class="chapter-title">{html.escape(text)}</h2>')
    elif typ=='h3':
        out.append(f'<h3 class="section-title">{html.escape(text)}</h3>')
    elif typ=='h4':
        out.append(f'<h4>{html.escape(text)}</h4>')
        if re.match(r'^(习题|复习参考题)',text):
            out.append('<div class="exercise">'); open_div='exercise'
        elif text.startswith('阅读与思考'):
            out.append('<div class="reading">'); open_div='reading'
        elif text.startswith('探究与发现'):
            out.append('<div class="explore">'); open_div='explore'
        elif text.startswith('小结'):
            out.append('<div class="summary">'); open_div='summary'
        elif text.startswith('数学探究'):
            out.append('<div class="explore">'); open_div='explore'
        elif text.startswith('数学建模'):
            out.append('<div class="explore">'); open_div='explore'
    else:
        out.append(f'<p>{html.escape(text)}</p>')
if open_div: out.append('</div>')

body='\n'.join(out)
cover='''<div class="cover">
<div class="book-name">数学 高中</div>
<div class="grade">选择性必修 第一册</div>
<div class="publisher">人民教育出版社</div>
</div>'''
doc=f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>数学 高中 选择性必修 第一册</title></head><body>
{cover}
{body}
</body></html>'''
open('deliverables/math-selective1-full.import.html','w',encoding='utf-8').write(doc)
alltext=' '.join(t for _,t in elements)
stats={'pages':'6-151','elements':len(elements),'chars':len(alltext),'rare_left':sum(1 for c in alltext if 0xE000<=ord(c)<=0xF8FF),'pua':sum(1 for c in alltext if 0xE000<=ord(c)<=0xF8FF),'special':len(SPECIAL),'summary':len(SUMMARY)}
open('deliverables/math-selective1-full.stats.json','w',encoding='utf-8').write(json.dumps(stats,ensure_ascii=False,indent=2))
print(json.dumps(stats,ensure_ascii=False))
