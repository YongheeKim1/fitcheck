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
def add_proxy(name, tex, objname=None, kind='hair'):
    sc, ref, dele, ts, fs = load_clo(name, objname)
    r, ruv, tris = split(fs, ts)
    proxies.append({'name': name, 'tex': tex, 'kind': kind, 'scale': sc, 'ref': ref, 'split': r, 'uv': ruv, 'tris': tris, 'delete': dele})

add_proxy('short02', 'hair.png', kind='hair')
add_proxy('eyebrow001', 'eyebrow.png', kind='brow')
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
save('skin_diffuse.png', 'skin.jpg', 2048)
save('short02_diffuse.png', 'hair.png', 1024, True)
save('short02_normal.png', 'hair_n.jpg', 1024)
save('eyebrow001.png', 'eyebrow.png', 256, True)
save('eyelashes01.png', 'lashes.png', 256, True)
save('brownlight_eye.png', 'eye.png', 512, True)
save('shoes05_diffuse.png', 'shoes.jpg', 512)
for f in sorted(os.listdir(OUT)): print(f, os.path.getsize(os.path.join(OUT, f)))
