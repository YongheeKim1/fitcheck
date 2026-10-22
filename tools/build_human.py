# MakeHuman(CC0) 자산 → 핏체크용 3D 인체 데이터(human.json + human.bin + 텍스처)
# 사용: python -I build.py <dl 폴더> <출력 폴더>
import sys, os, json, struct, re
import numpy as np
from PIL import Image

DL, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
P = lambda *a: os.path.join(DL, *a)

# ---------- 기본 메시 ----------
verts, uvs, faces = [], [], []  # faces: (group, [(vi, ti), ...])
group = None
for line in open(P('base.obj'), encoding='utf-8'):
    if line.startswith('v '):
        verts.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('vt '):
        uvs.append([float(x) for x in line.split()[1:3]])
    elif line.startswith('g '):
        group = line.split()[1]
    elif line.startswith('f '):
        fv = []
        for tok in line.split()[1:]:
            p = tok.split('/')
            fv.append((int(p[0]) - 1, int(p[1]) - 1 if len(p) > 1 and p[1] else -1))
        faces.append((group, fv))
V = np.array(verts, dtype=np.float64)
UV = np.array(uvs, dtype=np.float64)
NV = len(V)
print('verts', NV, 'faces', len(faces))

def target(name):
    if name is None: return np.zeros((NV, 3))
    if '+' in name: return sum(target(x) for x in name.split('+'))
    d = np.zeros((NV, 3))
    path = None
    for root, _, files in os.walk(P('t')):
        if name + '.target' in files: path = os.path.join(root, name + '.target')
    for line in open(path, encoding='utf-8'):
        if not line.strip() or line[0] == '#': continue
        a = line.split()
        d[int(a[0])] = [float(a[1]), float(a[2]), float(a[3])]
    return d

# 기본 체형: 아시아 남성 20대(MakeHuman 기준 몸에서) + 조금 이상적인 비율
V = V + target('asian-male-young') + target('male-young-averagemuscle-averageweight-idealproportions') * 0.5

# ---------- 체형 변형(증가/감소 쌍) ----------
PAIRS = {
    'weight': ('universal-male-young-averagemuscle-maxweight', 'universal-male-young-averagemuscle-minweight'),
    'muscle': ('universal-male-young-maxmuscle-averageweight', 'universal-male-young-minmuscle-averageweight'),
    'height': ('male-young-averagemuscle-averageweight-maxheight', 'male-young-averagemuscle-averageweight-minheight'),
    'vshape': ('torso-vshape-incr', 'torso-vshape-decr'),
    'belly': ('stomach-pregnant-incr', 'stomach-pregnant-decr'),
}
for m in ['bust-circ', 'underbust-circ', 'waist-circ', 'hips-circ', 'thigh-circ', 'shoulder-dist', 'upperarm-circ', 'calf-circ',
          'neck-circ', 'upperleg-height', 'lowerleg-height', 'napetowaist-dist', 'waisttohip-dist', 'upperarm-length', 'lowerarm-length']:
    PAIRS[m] = ('measure-%s-incr' % m, 'measure-%s-decr' % m)

# 얼굴 다듬기(그릴 때 값을 정한다): 이름 → (증가, 감소). 양쪽(l/r) 타깃은 + 로 합친다
LR = lambda a: 'l-%s+r-%s' % (a, a)
FACE = {
    'lowerlip-vol': ('mouth-lowerlip-volume-incr', 'mouth-lowerlip-volume-decr'),
    'lowerlip-h': ('mouth-lowerlip-height-incr', 'mouth-lowerlip-height-decr'),
    'mouth-angle': ('mouth-angles-up', 'mouth-angles-down'),
    'mouth-w': ('mouth-scale-horiz-incr', 'mouth-scale-horiz-decr'),
    'lowerlip-mid': ('mouth-lowerlip-middle-up', 'mouth-lowerlip-middle-down'),
    'upperlip-mid': ('mouth-upperlip-middle-up', 'mouth-upperlip-middle-down'),
    'chin-prom': ('chin-prominent-incr', 'chin-prominent-decr'),
    'chin-w': ('chin-width-incr', 'chin-width-decr'),
    'head-fat': ('head-fat-incr', 'head-fat-decr'),
    'head-oval': ('head-oval', None),
    'cheek-vol': (LR('cheek-volume-incr'), LR('cheek-volume-decr')),
    'cheek-bones': (LR('cheek-bones-incr'), LR('cheek-bones-decr')),
    'nose-w': ('nose-scale-horiz-incr', 'nose-scale-horiz-decr'),
    'nose-point': ('nose-point-width-incr', 'nose-point-width-decr'),
    'nose-flare': ('nose-flaring-incr', 'nose-flaring-decr'),
    'nose-vol': ('nose-volume-incr', 'nose-volume-decr'),
    'nose-hump': ('nose-hump-incr', 'nose-hump-decr'),
    'brow-y': ('eyebrows-trans-up', 'eyebrows-trans-down'),
    'brow-angle': ('eyebrows-angle-up', 'eyebrows-angle-down'),
    'neck-w': ('neck-scale-horiz-incr', 'neck-scale-horiz-decr'),
    'eye-open': (LR('eye-height2-incr'), LR('eye-height2-decr')),
    'eye-bag': (LR('eye-bag-incr'), LR('eye-bag-decr')),
    'eye-scale': (LR('eye-scale-incr'), LR('eye-scale-decr')),
}
if os.path.exists(os.path.join(DL, 't', 'head-oval.target')):
    for k, v in FACE.items(): PAIRS['f.' + k] = v

# ---------- 쓸 면: 몸(신체) ----------
body_faces = [fv for g, fv in faces if g == 'body']
used = sorted({vi for fv in body_faces for vi, _ in fv})

# 렌더 정점: (정점, uv) 쌍마다 하나(uv 이음매에서 갈라진다)
def split(face_list, uvarr):
    key2i, ref, ruv, tris = {}, [], [], []
    for fv in face_list:
        idx = []
        for vi, ti in fv:
            k = (vi, ti)
            if k not in key2i:
                key2i[k] = len(ref); ref.append(vi); ruv.append(uvarr[ti] if ti >= 0 else (0, 0))
            idx.append(key2i[k])
        for j in range(1, len(idx) - 1): tris += [idx[0], idx[j], idx[j + 1]]
    return np.array(ref, np.uint32), np.array(ruv, np.float32), np.array(tris, np.uint32)

# ---------- 뼈대: 관절 위치 = 관절 정점 묶음의 평균 ----------
sk = json.load(open(P('default.mhskel'), encoding='utf-8'))
joints = {k: v for k, v in sk['joints'].items()}
bones = sk['bones']
wts = json.load(open(P('default_weights.mhw'), encoding='utf-8'))['weights']
def subtree(root):
    out = {root}
    changed = True
    while changed:
        changed = False
        for b, d in bones.items():
            if d['parent'] in out and b not in out: out.add(b); changed = True
    return out
def weight_of(bset):
    w = np.zeros(NV)
    for b in bset:
        for vi, x in wts.get(b, []): w[vi] += x
    return np.clip(w, 0, 1)
pose = {}
for sd in ['L', 'R']:
    pose['arm' + sd] = weight_of(subtree('upperarm01.' + sd))
    pose['fore' + sd] = weight_of(subtree('lowerarm01.' + sd))
    pose['leg' + sd] = weight_of(subtree('upperleg01.' + sd))
headW = weight_of(subtree('head') | {'neck03'})
for sd in ['L', 'R']:
    pose['hand' + sd] = weight_of(subtree('wrist.' + sd))
# 도우미 정점(옷·신발이 기대는 보조 메시)은 뼈 가중치가 없다 → 가장 가까운 몸 정점의 가중치를 쓴다
_used = np.array(sorted({vi for g, fv in faces if g == 'body' for vi, _ in fv}))
_helpers = np.setdiff1d(np.arange(NV), _used)
_bv = V[_used]
_near = np.empty(len(_helpers), dtype=np.int64)
for c0 in range(0, len(_helpers), 512):
    hv = V[_helpers[c0:c0 + 512]]
    d = ((hv[:, None, :] - _bv[None, :, :]) ** 2).sum(-1)
    _near[c0:c0 + 512] = _used[d.argmin(1)]
for arrw in list(pose.values()) + [headW]:
    arrw[_helpers] = arrw[_near]
# 손가락 마디(자연스럽게 살짝 쥔 손): 마디마다 아래쪽 전체 가중치(듬성듬성 저장)
fingerW = {}
for sd in ['L', 'R']:
    for f in range(1, 6):
        for s in range(1, 4):
            nm = 'finger%d-%d.%s' % (f, s, sd)
            w = weight_of(subtree(nm))
            w[_helpers] = w[_near]
            fingerW[nm] = w

def jpos(name, X):
    return X[joints[name]].mean(axis=0)
for sd in ['L', 'R']:
    a, b = jpos('upperarm01.%s____head' % sd, V), jpos('lowerarm01.%s____head' % sd, V)
    d = b - a
    print('arm', sd, 'angle from down(deg)', np.degrees(np.arctan2(abs(d[0]), -d[1])))

# ---------- 덧붙이는 메시(머리카락·눈썹·속눈썹·눈·신발) ----------
def load_obj(path):
    vs, ts, fs = [], [], []
    for line in open(path, encoding='utf-8'):
        if line.startswith('v '): vs.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('vt '): ts.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('f '):
            fv = []
            for tok in line.split()[1:]:
                p = tok.split('/')
                fv.append((int(p[0]) - 1, int(p[1]) - 1 if len(p) > 1 and p[1] else -1))
            fs.append(fv)
    return np.array(vs), np.array(ts), fs

def load_clo(name, objname=None):
    lines = open(P(name + '.mhclo'), encoding='utf-8').read().split('\n')
    sc, ref, dele, mode = {}, [], [], None
    for ln in lines:
        s = ln.strip()
        if not s or s.startswith('#'): continue
        a = s.split()
        if a[0] in ('x_scale', 'y_scale', 'z_scale'): sc[a[0][0]] = (int(a[1]), int(a[2]), float(a[3])); continue
        if s == 'verts 0': mode = 'v'; continue
        if s == 'delete_verts': mode = 'd'; continue
        if mode == 'v' and re.match(r'^-?\d', a[0]):
            if len(a) == 1: ref.append((int(a[0]), int(a[0]), int(a[0]), 1, 0, 0, 0, 0, 0))
            elif len(a) >= 9: ref.append(tuple(int(x) for x in a[:3]) + tuple(float(x) for x in a[3:9]))
            else: mode = None
        elif mode == 'd':
            k = 0
            while k < len(a):
                if k + 2 < len(a) and a[k + 1] == '-': dele += list(range(int(a[k]), int(a[k + 2]) + 1)); k += 3
                else: dele.append(int(a[k])); k += 1
        elif mode == 'v': pass  # verts 뒤에 끼어든 머리글 줄(material 등)
    vs, ts, fs = load_obj(P((objname or name) + '.obj'))
    assert len(ref) == len(vs), (name, len(ref), len(vs))
    return sc, ref, dele, ts, fs

proxies = []
HAIR_ALT = [h for h in os.environ.get('HAIR_ALT', '').split(',') if h and os.path.exists(P(h + '.mhclo'))]  # 비교용 머리 모양(시험할 때만)
def add_proxy(name, tex, objname=None, kind='hair'):
    sc, ref, dele, ts, fs = load_clo(name, objname)
    r, ruv, tris = split(fs, ts)
    proxies.append({'name': name, 'tex': tex, 'kind': kind, 'scale': sc, 'ref': ref, 'split': r, 'uv': ruv, 'tris': tris, 'delete': dele})

add_proxy('short02', 'hair.png', kind='hair')
for _h in HAIR_ALT: add_proxy(_h, 'hair_%s.png' % _h, kind='hair')
BROW = os.environ.get('BROW', 'eyebrow001')  # 다른 눈썹(eyebrow002 등)을 시험할 때 BROW=이름
add_proxy(BROW, 'eyebrow.png', kind='brow')
add_proxy('eyelashes01', 'lashes.png', kind='lash')
add_proxy('eyes', 'eye.png', kind='eye')
add_proxy('shoes05', 'shoes.jpg', kind='shoes')

deleted = set()
for p in proxies: deleted |= set(p['delete'])
body_faces_vis = [fv for fv in body_faces if not all(vi in deleted for vi, _ in fv)]
b_ref, b_uv, b_tris = split(body_faces_vis, UV)
# 법선 계산용 원래 정점 기준 삼각형(몸 전체)
orig_tris = []
for fv in body_faces:
    for j in range(1, len(fv) - 1): orig_tris += [fv[0][0], fv[j][0], fv[j + 1][0]]

# ---------- 속옷(드로즈): 골반~허벅지 위쪽 몸 면을 그대로 복제(그릴 때 법선 방향으로 살짝 띄운다) ----------
yC = V[joints['upperleg01.L____head']].mean(axis=0)[1]  # 고관절 높이
crotch_y = None
def in_brief(vi):
    x, y, z = V[vi]
    return yC - 1.55 < y < yC + 0.75 and not (abs(x) > 1.9 and y > yC - 0.2)  # 팔(손) 제외
brief_faces = [fv for fv in body_faces if all(in_brief(vi) for vi, _ in fv)]
w_ref, w_uv, w_tris = split(brief_faces, UV)

# ---------- 측정용 정점 묶음(둘레 = 단면 볼록 껍질 둘레) ----------
X = V
body_set = np.array(used)
def ring(y, half=0.06, xmax=None, side=0):
    sel = [i for i in body_set if abs(X[i, 1] - y) < half and (xmax is None or abs(X[i, 0]) < xmax) and (side == 0 or X[i, 0] * side > 0.05)]
    return sel
nipple_y = jpos('breast.L____head', V)[1]
waist_y = jpos('spine03____head', V)[1] if 'spine03____head' in joints else None
hipJ = jpos('upperleg01.L____head', V)
spine = {k: jpos(k + '____head', V)[1] for k in ['spine01', 'spine02', 'spine03', 'spine04', 'spine05', 'root']}
print('spine heights', {k: round(v, 2) for k, v in spine.items()}, 'nipple', round(nipple_y, 2), 'hipJ', hipJ.round(2))
torsoMax = abs(jpos('upperarm01.L____head', V)[0]) * 0.92

crotch_y = min(X[i, 1] for i in body_set if abs(X[i, 0]) < 0.05 and hipJ[1] - 2 < X[i, 1] < hipJ[1] and X[i, 2] > -1)
print('crotch y', round(crotch_y, 3), 'height', round(V[used, 1].max() - V[used, 1].min(), 3))
# 사타구니 점(다리 사이 가장 높은 곳) 후보 정점
crotch_set = [i for i in body_set if abs(X[i, 0]) < 0.12 and abs(X[i, 1] - crotch_y) < 0.25]
# 어깨너비: 어깨 끝(삼각근 바깥쪽 위) 정점 - 위팔 관절에서 가장 바깥, 높이 근처
def shoulder_pts(sd):
    j = jpos('upperarm01.%s____head' % sd, V)
    return [i for i in body_set if abs(X[i, 1] - (j[1] + 0.15)) < 0.12 and abs(X[i, 2] - j[2]) < 0.4 and X[i, 0] * (1 if sd == 'L' else -1) > abs(j[0]) * 0.8]
shoulder = {'L': shoulder_pts('L'), 'R': shoulder_pts('R')}

# 관절(랜드마크) 이름 → 정점 묶음
LM = {}
for nm in ['upperarm01.L____head', 'upperarm01.R____head', 'lowerarm01.L____head', 'lowerarm01.R____head', 'wrist.L____head', 'wrist.R____head',
           'finger3-3.L____tail', 'finger3-3.R____tail', 'finger1-3.L____tail', 'finger1-3.R____tail', 'finger5-3.L____tail', 'finger5-3.R____tail',
           'upperleg01.L____head', 'upperleg01.R____head', 'lowerleg01.L____head', 'lowerleg01.R____head', 'foot.L____head', 'foot.R____head',
           'foot.L____tail', 'foot.R____tail', 'toe3-1.L____head', 'toe3-1.R____head', 'eye.L____head', 'eye.R____head', 'head____tail', 'neck01____head',
           'special04____head', 'jaw____tail', 'breast.L____head', 'finger2-3.L____tail', 'finger2-3.R____tail', 'spine03____head', 'neck03____head']:
    LM[nm] = joints[nm]
for nm in fingerW:
    LM[nm + '____head'] = joints[nm + '____head']
    LM[nm + '____tail'] = joints[nm + '____tail']
for sd in ['L', 'R']:
    LM['wrist.%s____head' % sd] = joints['wrist.%s____head' % sd]

# ---------- 바이너리 ----------
buf = bytearray()
meta = {'nv': NV, 'unit': 'dm', 'arrays': {}}
def put(name, arr, dtype):
    global buf
    a = np.ascontiguousarray(arr, dtype=dtype)
    while len(buf) % 4: buf.append(0)
    meta['arrays'][name] = {'offset': len(buf), 'count': int(a.size), 'type': np.dtype(dtype).name}
    buf += a.tobytes()
put('base', V.astype(np.float32).ravel(), np.float32)
put('normTris', np.array(orig_tris, np.uint32), np.uint32)
put('body.ref', b_ref, np.uint32); put('body.uv', b_uv.ravel(), np.float32); put('body.tris', b_tris, np.uint32)
put('brief.ref', w_ref, np.uint32); put('brief.uv', w_uv.ravel(), np.float32); put('brief.tris', w_tris, np.uint32)
for k, w in list(pose.items()) + [('head', headW)]:
    put('w.' + k, np.round(w * 255).astype(np.uint8), np.uint8)
meta['fingers'] = []
for nm, w in fingerW.items():
    nz = np.nonzero(w > 0.004)[0]
    put('f.%s.idx' % nm, nz.astype(np.uint16), np.uint16)
    put('f.%s.w' % nm, np.round(w[nz] * 255).astype(np.uint8), np.uint8)
    meta['fingers'].append(nm)
meta['morphs'] = {}
for k, (inc, dec) in PAIRS.items():
    for sgn, nm in (('+', inc), ('-', dec)):
        d = target(nm)
        nz = np.nonzero(np.abs(d).sum(axis=1) > 1e-6)[0]
        sc = float(np.abs(d[nz]).max()) / 32767 if len(nz) else 1
        put('m.%s%s.idx' % (k, sgn), nz.astype(np.uint16), np.uint16)
        put('m.%s%s.d' % (k, sgn), np.round(d[nz] / sc).astype(np.int16).ravel(), np.int16)
        meta['morphs'][k + sgn] = {'scale': sc, 'n': int(len(nz))}
meta['proxies'] = []
for p in proxies:
    ref = np.array(p['ref'])
    put('p.%s.vi' % p['name'], ref[:, :3].astype(np.uint16).ravel(), np.uint16)
    put('p.%s.w' % p['name'], ref[:, 3:9].astype(np.float32).ravel(), np.float32)
    put('p.%s.ref' % p['name'], p['split'], np.uint32)
    put('p.%s.uv' % p['name'], p['uv'].ravel(), np.float32)
    put('p.%s.tris' % p['name'], p['tris'], np.uint32)
    meta['proxies'].append({'name': p['name'], 'tex': p['tex'], 'kind': p['kind'], 'scale': p['scale']})
meta['crotch'] = [int(i) for i in crotch_set]
meta['shoulder'] = {k: [int(i) for i in v] for k, v in shoulder.items()}
meta['joints'] = {k: [int(i) for i in v] for k, v in LM.items()}
meta['bodyVerts'] = [int(min(used)), int(max(used))]
open(os.path.join(OUT, 'human.bin'), 'wb').write(bytes(buf))
json.dump(meta, open(os.path.join(OUT, 'human.json'), 'w'), separators=(',', ':'))
print('bin MB', round(len(buf) / 1e6, 2))

# ---------- 텍스처(용량 줄이기) ----------
def save(src, dst, size, alpha=False):
    im = Image.open(P(src))
    im = im.resize((size, size), Image.LANCZOS)
    if alpha: im.save(os.path.join(OUT, dst), optimize=True)
    else: im.convert('RGB').save(os.path.join(OUT, dst), quality=86, optimize=True)
def even_skin(src, dst):
    # 피부 고르게: 얼굴·몸·다리가 한 사람처럼 같은 톤이 되게 큰 흐림(저주파 색)을 가슴 색으로 바꾸고
    # 잔결(모공·주름)은 비율로 남긴다. 다리 털·배꼽 아래 털·유두는 결을 약하게, 입술은 그대로.
    from PIL import ImageFilter
    im = Image.open(P(src)).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    # 빈 바탕(단색)은 빼고 흐린다(조각 가장자리에 빛 테두리가 생기지 않게)
    H, W = a.shape[:2]
    m = (np.abs(a - a[5, 5]).max(-1) > 2).astype(np.float32)
    def box(x, r, ax):
        c = np.cumsum(np.pad(x, [(r + 1, r) if i == ax else (0, 0) for i in range(x.ndim)], mode='edge'), axis=ax, dtype=np.float64)
        n = x.shape[ax]
        return ((np.take(c, range(2 * r + 1, 2 * r + 1 + n), axis=ax) - np.take(c, range(0, n), axis=ax)) / (2 * r + 1)).astype(np.float32)
    def blur(x, r):  # 상자 흐림 세 번 = 가우스 흐림 근사
        x = x.astype(np.float32); b = max(1, int(r * 0.85))
        for _ in range(3): x = box(box(x, b, 0), b, 1)
        return x
    low = blur(a * m[..., None], 36) / (blur(m, 36)[..., None] + 1e-4) + 1
    low = low * m[..., None] + a[5, 5] * (1 - m[..., None]) + (1 - m[..., None])
    target = np.median(low[700:820, 700:860].reshape(-1, 3), axis=0)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    k = np.full((H, W), 0.8, np.float32)
    # 다리(몸 UV 아래쪽): 털·붉은 결 줄이기
    legs = np.clip((yy - 1050) / 200, 0, 1) * (xx < 1320)
    k = k * (1 - legs) + 0.45 * legs
    k[(xx > 1300) & (yy < 1760)] = 0.62  # 얼굴·두피: 잔결이 거칠어 보이지 않게
    k[(xx > 740) & (xx < 1580) & (yy > 1620)] = 0.35  # 손(손톱 끝 갈색 얼룩 줄이기)
    def ell(cx, cy, rx, ry):
        d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        return np.clip(1.6 - d, 0, 1) ** 1.5 * (d < 1.6)
    k = np.maximum(k * (1 - ell(1866, 1060, 40, 52)), 1.0 * ell(1866, 1060, 40, 52))  # 입술
    for cx, cy in [(663, 620), (893, 606)]:
        e = ell(cx, cy, 18, 18); k = k * (1 - e) + 0.6 * e  # 유두
    e = ell(780, 990, 30, 75) * (1 - ell(780, 890, 22, 22)); k = k * (1 - e) + 0.15 * e  # 배꼽 아래 털 줄
    k = np.asarray(Image.fromarray((k * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(8))).astype(np.float32) / 255
    ratio = a / low
    out = target * (1 + (ratio - 1) * k[..., None])
    # 얼굴 안의 자연스러운 혈색 차이(볼·코끝·귀가 살짝 붉고 이마가 밝은 것)는 조금 되살린다: 얼굴 평균에 대한 비율만(얼굴 전체 톤은 몸과 같게)
    head = (xx > 1300) & (yy < 1760) & (m > 0)
    hm = low[head].mean(0)
    vary = np.clip(low / hm, 0.75, 1.3)
    hmask = np.asarray(Image.fromarray((head * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(20))).astype(np.float32)[..., None] / 255
    out = out * (1 + (vary - 1) * 0.4 * hmask)
    # 입술은 원래 색 비율이 커서 저주파도 살짝 붉게 남긴다
    lip = ell(1866, 1060, 40, 52)[..., None]
    out = out * (1 - lip * 0.5) + (a * target / np.median(low[1000:1120, 1700:1800].reshape(-1, 3), axis=0)) * lip * 0.5
    # 입술: 주황빛 대신 차분한 장밋빛(#c98a80 쪽), 입술 사이 어두운 틈은 입술색으로 올린다
    rose = np.array([201, 138, 128], np.float32)
    lum_o = out.mean(-1, keepdims=True)
    lipc = rose * np.clip(lum_o / 150, 0.75, 1.15)
    out = out * (1 - lip * 0.62) + lipc * lip * 0.62
    # 입술 사이 틈이 검게 벌어져 보이지 않게: 입술 안 어두운 곳을 입술색의 70%까지 올린다
    floor_ = rose * 0.62
    out = out * (1 - lip) + np.maximum(out, floor_) * lip
    # 얼굴 조각 선명하게(언샤프 마스크, 반지름 약 1.5px, 0.6)와 볼·코 혈색 3%: 확대했을 때 흐릿한 밀랍처럼 보이지 않게
    hsel = ((xx > 1300) & (yy < 1760))[..., None].astype(np.float32)
    soft = blur(out, 2)
    out = out + 0.6 * (out - soft) * hsel
    cheeks = np.zeros((H, W), np.float32)
    for cx, cy, rx, ry in [(1760, 870, 120, 90), (1760, 1250, 120, 90), (1795, 1060, 40, 45)]:
        cheeks = np.maximum(cheeks, np.clip(1 - ((xx - cx) / rx) ** 2 - ((yy - cy) / ry) ** 2, 0, 1))
    out = out * (1 + cheeks[..., None] * np.array([0.03, -0.01, -0.01], np.float32))
    # 입 안 조각(입술 안쪽·잇몸·혀): 피부색으로 펴면 다문 입술 사이가 밝은 줄로 보인다 → 원래 색을 어둡게 되돌린다
    mouth = np.zeros((H, W), bool)
    mouth[720:940, 0:290] = True; mouth |= ((xx - 1724) / 182) ** 2 + ((yy - 1890) / 138) ** 2 < 1  # 오른쪽 아래 입 안 조각(바로 옆 손가락 끝은 빼기 - 손톱이 갈색으로 보이던 것)
    mouth &= m > 0
    out[mouth] = a[mouth] * 0.45
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(os.path.join(OUT, dst), quality=88, optimize=True)

def dark_iris(src, dst, size):
    # 눈동자: 회녹색으로 비치던 홍채를 짙은 갈색으로
    im = Image.open(P(src)).convert('RGBA').resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    rgb = a[..., :3]
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    f = size / 512
    iris = np.zeros((size, size, 1), np.float32)
    for cx, cy in [(362, 150), (150, 358)]:
        d = np.hypot(xx - cx * f, yy - cy * f) / f
        iris[..., 0] = np.maximum(iris[..., 0], np.clip((60 - d) / 4, 0, 1))
    mean = (rgb * iris).reshape(-1, 3).sum(0) / iris.sum()
    dark = rgb * (np.array([62, 38, 24], np.float32) / mean)  # 결은 남기고 짙은 갈색으로
    sclera = np.minimum(255, rgb * 0.55 + np.array([233, 228, 222], np.float32) * 0.5)  # 흰자: 푸른 회색 대신 따뜻한 미색
    a[..., :3] = dark * iris + sclera * (1 - iris)
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(os.path.join(OUT, dst), optimize=True)

even_skin('skin_diffuse.png', 'skin.jpg')
def soft_hair(src, dst, size):
    # 머리카락 가장자리: 알파를 살짝 번지게 해 앞머리·옆머리 끝이 가늘게 흩어지는 반투명 띠를 만든다(그릴 때 섞어 그림)
    from PIL import ImageFilter
    im = Image.open(P(src)).convert('RGBA').resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    al = a[..., 3]
    bl = np.asarray(Image.fromarray(al.astype(np.uint8)).filter(ImageFilter.GaussianBlur(9))).astype(np.float32)
    # 조각 가장자리 안쪽으로 알파를 줄여(가장자리 = 메시 끝) 딱 잘린 선 대신 점점 옅어지게
    edge = np.clip((bl / 255 - 0.5) / 0.45, 0, 1)
    a[..., 3] = al * (0.25 + 0.75 * edge)
    # 바깥으로 번진 곳의 색은 가까운 머리카락 색으로(검은 테 방지)
    rgb = a[..., :3] * (al[..., None] / 255)
    w = np.asarray(Image.fromarray(al.astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32)[..., None] + 1e-3
    blr = np.stack([np.asarray(Image.fromarray(np.clip(rgb[..., c], 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32) for c in range(3)], -1)
    fill = blr / (w / 255)
    m = (al < 140)[..., None]
    a[..., :3] = np.where(m, fill, a[..., :3])
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(os.path.join(OUT, dst), optimize=True)
soft_hair('short02_diffuse.png', 'hair.png', 1024)
save('short02_normal.png', 'hair_n.jpg', 1024)
for _h in HAIR_ALT:
    im = Image.open(P(_h + '_diffuse.png')).convert('RGBA').resize((1024, 1024), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32); l = (a[..., :3] @ np.array([0.3, 0.55, 0.15], np.float32))[..., None]
    a[..., :3] = l * np.array([1.0, 0.9, 0.82], np.float32)  # 색은 빼고 결(밝기)만: 그릴 때 머리색으로 물들인다
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'hair_%s.png' % _h), optimize=True)
def thick_brow(src, dst, size):
    # 눈썹: 작게 줄이면 가는 털이 흐려져 가는 선만 남는다 → 알파를 살짝 번지게 하고 진하게(숱 있는 눈썹)
    from PIL import ImageFilter
    im = Image.open(P(src)).convert('RGBA').resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    al = np.asarray(Image.fromarray(a[..., 3].astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.6))).astype(np.float32)
    a[..., 3] = np.clip(al * 1.3, 0, 255)
    a[..., :3] = np.minimum(a[..., :3], 90)
    Image.fromarray(a.astype(np.uint8)).save(os.path.join(OUT, dst), optimize=True)
thick_brow(BROW + '.png', 'eyebrow.png', 512)
save('eyelashes01.png', 'lashes.png', 256, True)
dark_iris('brownlight_eye.png', 'eye.png', 512)
def clean_shoes(src, dst, size):
    # 운동화: 초록 포인트(앞코 얼룩처럼 보임)는 회색으로, 양말(오른쪽 아래 조각)은 밝은 흰 양말로
    im = Image.open(P(src)).convert('RGB').resize((size, size), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # 색은 모두 빼고(초록 포인트 없음), 어두운 판·밑창·때를 밝은 회색으로 올려 깨끗한 흰 운동화로
    from PIL import ImageFilter
    lum = (r * 0.3 + g * 0.45 + b * 0.25)
    blurL = np.asarray(Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10 * size / 1024))).astype(np.float32) + 8
    detail = np.clip(lum / blurL, 0.4, 1.6)                       # 끈·구멍·패널 결
    base = np.clip(125 + blurL * 0.4, 0, 215)                     # 큰 밝기: 흰 갑피(조명에서 날아가지 않게 약간 낮게), 어두운 판·밑창은 중간 회색
    l2 = np.clip(base * (0.45 + 0.65 * detail), 0, 232)  # 끈·구멍·밑창 경계가 보이게 결 대비를 더
    a = np.repeat(l2[..., None], 3, -1) * np.array([1.0, 0.993, 0.98])
    # 신발 앞(512 기준 좌표 × f): 끈·혀 자리 18% 어둡게, 혀의 하트 로고는 지우고, 앞코가 접히는 자리에 부드러운 주름 그늘
    f2 = size / 1024
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / f2
    def ellm(cx, cy, rx, ry, p=1.5):
        d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        return np.clip(1 - d, 0, 1) ** p
    logo = ellm(500, 540, 46, 30, 0.3)[..., None]
    a = a * (1 - logo) + np.median(a[int(560 * f2):int(600 * f2), int(440 * f2):int(560 * f2)].reshape(-1, 3), axis=0) * logo
    a = a * (1 - 0.32 * ellm(495, 635, 125, 160, 0.7))[..., None]
    crease = np.exp(-((yy - (780 + 0.0006 * (xx - 505) ** 2)) / 18) ** 2) * ((xx > 320) & (xx < 690))
    a = a * (1 - 0.25 * crease)[..., None]
    f = size / 512
    y0, x0 = int(430 * f), int(388 * f)
    sock = a[y0:, x0:]
    l = sock.mean(-1, keepdims=True)
    sock[:] = np.clip(225 + (l - l.mean()) * 1.6, 0, 255) * np.array([1.0, 0.995, 0.985])
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(os.path.join(OUT, dst), quality=88, optimize=True)
clean_shoes('shoes05_diffuse.png', 'shoes.jpg', 1024)
for f in sorted(os.listdir(OUT)): print(f, os.path.getsize(os.path.join(OUT, f)))


# ---------- 3D 옷(아바타 전용, 따로 받는 cloth.json + cloth.bin): MakeHuman 시스템 옷(CC0)에서 상의·바지만 떼어 낸다 ----------
# male_casualsuit04: 반팔 티 + 청바지, male_casualsuit02: 긴팔 티(+ 같은 청바지). 한 메시라 UV 위치로 나눈다(바지 = 왼쪽 아래).
def cloth_part(name, want):
    if not os.path.exists(P(name + '.mhclo')): return None
    sc, ref, dele, ts, fs = load_clo(name)
    vs = load_obj(P(name + '.obj'))[0]
    keep = []
    for fv in fs:
        u = np.mean([ts[ti][0] for _, ti in fv]); v = np.mean([ts[ti][1] for _, ti in fv])
        y = np.mean([vs[vi][1] for vi, _ in fv]); ax = abs(np.mean([vs[vi][0] for vi, _ in fv]))
        # 바지 지퍼 덮개·바깥 가장자리 조각은 u가 0.7을 넘는다(긴팔 소매 조각과는 위치로 구분: 소매는 몸 바깥·높은 곳)
        isPants = v < 0.58 and (u < 0.7 or (ax < 2.0 and y < 1.7))
        if (want == 'pants') == isPants: keep.append(fv)
    r, ruv, tris = split(keep, ts)
    return {'scale': sc, 'ref': ref, 'split': r, 'uv': ruv, 'tris': tris, 'cover': sorted(set(dele))}

CLOTH = [('tee', 'male_casualsuit04', 'top'), ('longtee', 'male_casualsuit02', 'top'), ('jeans', 'male_casualsuit04', 'pants')]
parts = [(nm, cloth_part(src, 'pants' if w == 'pants' else 'top'), src) for nm, src, w in CLOTH]
if all(c for _, c, _ in parts):
    cbuf = bytearray(); cmeta = {'arrays': {}, 'cloth': []}
    def cput(name, arr, dtype):
        a = np.ascontiguousarray(arr, dtype=dtype)
        while len(cbuf) % 4: cbuf.append(0)
        cmeta['arrays'][name] = {'offset': len(cbuf), 'count': int(a.size), 'type': np.dtype(dtype).name}
        cbuf.extend(a.tobytes())
    for nm, c, src in parts:
        ref = np.array(c['ref'])
        cput('c.%s.vi' % nm, ref[:, :3].astype(np.uint16).ravel(), np.uint16)
        cput('c.%s.w' % nm, ref[:, 3:9].astype(np.float32).ravel(), np.float32)
        cput('c.%s.ref' % nm, c['split'], np.uint32)
        cput('c.%s.uv' % nm, c['uv'].ravel(), np.float32)
        cput('c.%s.tris' % nm, c['tris'], np.uint32)
        cput('c.%s.cover' % nm, np.array(c['cover'], np.uint16), np.uint16)
        cmeta['cloth'].append({'name': nm, 'scale': c['scale'], 'src': src})
    os.makedirs(os.path.join(OUT, 'cloth'), exist_ok=True)
    open(os.path.join(OUT, 'cloth', 'cloth.bin'), 'wb').write(bytes(cbuf))
    json.dump(cmeta, open(os.path.join(OUT, 'cloth', 'cloth.json'), 'w'), separators=(',', ':'))
    # 옷 결 지도: 접힘 그늘(AO, 회색) / 청바지는 원래 무늬의 밝기 결 + 노멀맵
    def gray_save(src, dst, size, q=85):
        im = Image.open(P(src)).convert('L').resize((size, size), Image.LANCZOS)
        im.save(os.path.join(OUT, 'cloth', dst), quality=q, optimize=True)
    gray_save('male_casualsuit04_ao.png', 'tee_ao.jpg', 1024)
    gray_save('male_casualsuit02_ao.png', 'longtee_ao.jpg', 1024)
    from PIL import ImageFilter
    im = Image.open(P('male_casualsuit04_diffuse.png')).convert('RGB').resize((1024, 1024), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32); l = a @ np.array([0.3, 0.5, 0.2], np.float32)
    bl = np.asarray(Image.fromarray(np.clip(l, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(40))).astype(np.float32) + 1
    det = np.clip(205 * (0.55 * (l / bl - 1) + 1) * (bl / bl[420:1000, 0:700].mean()) ** 0.35, 0, 255)  # 무늬는 남기고 전체 밝기 차이는 줄인다
    Image.fromarray(det.astype(np.uint8)).save(os.path.join(OUT, 'cloth', 'jeans_d.jpg'), quality=85, optimize=True)
    Image.open(P('male_casualsuit04_normal.png')).convert('RGB').resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'cloth', 'jeans_n.jpg'), quality=88, optimize=True)
    for f in sorted(os.listdir(os.path.join(OUT, 'cloth'))): print('cloth/' + f, os.path.getsize(os.path.join(OUT, 'cloth', f)))
