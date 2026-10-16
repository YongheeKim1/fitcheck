'use strict';

// ---------- 실사 3D 아바타: MakeHuman(CC0) 인체 모델을 내 치수로 바꿔 조명까지 렌더링 ----------
// 결과는 avatar.js(2D)와 같은 "가상의 내 사진" 모양이라 옷 입히기 엔진을 그대로 쓴다.
// 모델·텍스처는 models/human/에서 한 번만 받고(약 4.5MB), 그리기는 모두 이 기기(WebGL)에서 한다.
const Avatar3D = (() => {
  const CW = 640, CH = 1280, TOP = 40, FLOOR = CH - 56;
  const SS = 2; // 두 배 크기로 그려 줄여서 계단 현상 없애기
  const BASE = 'models/human/';
  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.169.0';
  const THREE_URL = CDN + '/build/three.module.min.js';
  let data = null, THREE = null, renderer = null, loading = null, studioEnv = null;

  // ---------- 데이터 읽기 ----------
  async function load() {
    if (data) return data;
    if (loading) return loading;
    loading = (async () => {
      const [meta, bin, three] = await Promise.all([
        fetch(BASE + 'human.json').then((r) => r.json()),
        fetch(BASE + 'human.bin').then((r) => r.arrayBuffer()),
        import(THREE_URL),
      ]);
      THREE = three;
      const T = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array, int16: Int16Array, uint8: Uint8Array };
      const arr = (name) => { const a = meta.arrays[name]; return new T[a.type](bin, a.offset, a.count); };
      const morphs = {};
      for (const [k, m] of Object.entries(meta.morphs)) morphs[k] = { idx: arr(`m.${k}.idx`), d: arr(`m.${k}.d`), scale: m.scale };
      const tex = {};
      const loader = new THREE.TextureLoader();
      const texNames = ['skin.jpg', 'hair_n.jpg', ...meta.proxies.map((p) => p.tex)];
      await Promise.all(texNames.map((n) => new Promise((res, rej) => loader.load(BASE + n, (t) => { if (!n.endsWith('_n.jpg')) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; tex[n] = t; res(); }, undefined, rej))));
      data = {
        meta, morphs, tex,
        base: arr('base'), normTris: arr('normTris'),
        body: { ref: arr('body.ref'), uv: arr('body.uv'), tris: arr('body.tris') },
        brief: { ref: arr('brief.ref'), uv: arr('brief.uv'), tris: arr('brief.tris') },
        w: Object.fromEntries(['armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'handL', 'handR', 'head'].map((k) => [k, arr('w.' + k)])),
        fingers: Object.fromEntries((meta.fingers || []).map((nm) => [nm, { idx: arr(`f.${nm}.idx`), w: arr(`f.${nm}.w`) }])),
        proxies: meta.proxies.map((p) => ({ ...p, vi: arr(`p.${p.name}.vi`), pw: arr(`p.${p.name}.w`), ref: arr(`p.${p.name}.ref`), uv: arr(`p.${p.name}.uv`), tris: arr(`p.${p.name}.tris`) })),
      };
      data.skinAvg = avgColor(tex['skin.jpg'].image);
      data.hairAvg = {};
      for (const p of meta.proxies) if (p.kind === 'hair') data.hairAvg[p.name] = avgColor(tex[p.tex].image, true);
      return data;
    })();
    try { return await loading; } finally { loading = null; }
  }

  // 텍스처 평균색(머리카락은 불투명한 곳만)
  function avgColor(img, alphaOnly) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data;
    const s = [0, 0, 0]; let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (alphaOnly && d[i + 3] < 200) continue;
      if (!alphaOnly && d[i] + d[i + 1] + d[i + 2] < 120) continue; // 텍스처 빈 곳(검정) 빼기
      s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++;
    }
    return s.map((v) => v / Math.max(1, n));
  }

  // ---------- 변형(체형) ----------
  // w: { name: -1..1 } → 정점 좌표(dm, Float32Array)
  function morph(w) {
    const P = new Float32Array(data.base);
    for (const [k, v] of Object.entries(w)) {
      if (!v) continue;
      const m = data.morphs[k + (v > 0 ? '+' : '-')];
      if (!m) continue;
      const f = Math.abs(v) * m.scale;
      for (let j = 0; j < m.idx.length; j++) {
        const i = m.idx[j] * 3;
        P[i] += m.d[j * 3] * f; P[i + 1] += m.d[j * 3 + 1] * f; P[i + 2] += m.d[j * 3 + 2] * f;
      }
    }
    return P;
  }
  const jpos = (P, name) => {
    const ids = data.meta.joints[name];
    let x = 0, y = 0, z = 0;
    for (const i of ids) { x += P[i * 3]; y += P[i * 3 + 1]; z += P[i * 3 + 2]; }
    return [x / ids.length, y / ids.length, z / ids.length];
  };

  // 수평면 y에서 몸 단면 → 볼록 껍질 둘레(줄자 둘레). filt(x, z)로 한쪽 다리만 등
  function sliceCirc(P, y, filt) {
    const t = data.normTris, pts = [];
    for (let k = 0; k < t.length; k += 3) {
      for (let e = 0; e < 3; e++) {
        const a = t[k + e] * 3, b = t[k + (e + 1) % 3] * 3;
        const ya = P[a + 1], yb = P[b + 1];
        if ((ya - y) * (yb - y) >= 0 || ya === yb) continue;
        const u = (y - ya) / (yb - ya);
        const x = P[a] + (P[b] - P[a]) * u, z = P[a + 2] + (P[b + 2] - P[a + 2]) * u;
        if (!filt || filt(x, z)) pts.push([x, z]);
      }
    }
    return hullPerim(pts);
  }
  function hullPerim(pts) {
    if (pts.length < 3) return 0;
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const h = lo.slice(0, -1).concat(up.slice(0, -1));
    let s = 0;
    for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; s += Math.hypot(a[0] - b[0], a[1] - b[1]); }
    return s;
  }

  // 치수 재기(cm, 키를 목표 키로 맞춘 뒤)
  function measure(P, Htarget) {
    const [v0, v1] = data.meta.bodyVerts;
    let minY = Infinity, maxY = -Infinity;
    for (let i = v0; i <= v1; i++) { const y = P[i * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const k = Htarget / (maxY - minY); // cm / dm 단위
    const shL = jpos(P, 'upperarm01.L____head'), hipJ = jpos(P, 'upperleg01.L____head');
    const chestY = jpos(P, 'breast.L____head')[1];
    const torso = (x) => Math.abs(x) < Math.abs(shL[0]) * 0.92;
    const torsoF = (x) => torso(x);
    let waist = Infinity, hip = 0;
    for (let i = 0; i <= 10; i++) { const y = hipJ[1] + 0.5 + (chestY - 0.8 - hipJ[1] - 0.5) * i / 10; waist = Math.min(waist, sliceCirc(P, y, torsoF)); }
    for (let i = 0; i <= 8; i++) { const y = hipJ[1] - 1.0 + 1.3 * i / 8; hip = Math.max(hip, sliceCirc(P, y, torsoF)); }
    let crotch = -Infinity;
    for (const i of data.meta.crotch) if (Math.abs(P[i * 3]) < 0.08) crotch = Math.max(crotch, P[i * 3 + 1]);
    if (crotch === -Infinity) crotch = hipJ[1] - 0.8;
    const thigh = sliceCirc(P, crotch - 0.25, (x) => x > 0.03);
    const shR = jpos(P, 'upperarm01.R____head');
    return {
      k, minY,
      chest: sliceCirc(P, chestY, torsoF) * k,
      waist: waist * k, hip: hip * k, thigh: thigh * k,
      shoulder: Math.hypot(shL[0] - shR[0], shL[1] - shR[1]) * k + 7, // 어깨 관절 사이 + 양쪽 어깨 끝(뼈 바깥)까지
      inseam: (crotch - minY) * k,
    };
  }

  // 내 치수에 맞는 변형값 찾기(감쇠 가우스-뉴턴, 수치 미분)
  const VARS = ['weight', 'muscle', 'vshape', 'bust-circ', 'waist-circ', 'hips-circ', 'thigh-circ', 'shoulder-dist', 'upperleg-height', 'lowerleg-height'];
  // 같은 치수로 다시 그릴 때(옷 입히기·코디·체형 카드)는 맞춘 변형값을 다시 쓴다(맞추기가 가장 오래 걸린다)
  const fitCache = new Map();
  function fit(m) {
    const ck = JSON.stringify([m.H, m.chest, m.waist, m.hip, m.thigh, m.shoulder, m.inseam]);
    if (fitCache.has(ck)) return fitCache.get(ck);
    const r = fitNow(m);
    if (fitCache.size > 8) fitCache.clear();
    fitCache.set(ck, r);
    return r;
  }
  function fitNow(m) {
    const goal = { chest: m.chest, waist: m.waist, hip: m.hip, thigh: m.thigh, shoulder: m.shoulder, inseam: m.inseam + 4 }; // 줄자 안쪽 길이는 발목뼈 근처까지 → 가랑이 높이는 4cm쯤 더 높다
    const keys = Object.keys(goal);
    const wt = { chest: 1, waist: 1, hip: 1, thigh: 1.2, shoulder: 1.5, inseam: 1.5 };
    let x = new Array(VARS.length).fill(0);
    const evalAt = (xv) => { const w = {}; VARS.forEach((v, i) => { w[v] = Math.max(-1, Math.min(1, xv[i])); }); return measure(morph(w), m.H); };
    let cur = evalAt(x);
    for (let it = 0; it < 8; it++) {
      const r = keys.map((k) => (goal[k] - cur[k]) * wt[k]);
      const J = VARS.map((_, j) => {
        const x2 = x.slice(); const h = x[j] > 0.7 ? -0.15 : 0.15; x2[j] += h;
        const m2 = evalAt(x2);
        return keys.map((k) => ((m2[k] - cur[k]) / h) * wt[k]);
      });
      // (JᵀJ + λI) dx = Jᵀr - λ' x  (변형값은 작을수록 자연스럽다)
      const n = VARS.length, A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) A[i][j] = keys.reduce((s, _, q) => s + J[i][q] * J[j][q], 0);
        A[i][i] += 1; b[i] = keys.reduce((s, _, q) => s + J[i][q] * r[q], 0) - 0.5 * x[i];
      }
      const dx = solve(A, b);
      x = x.map((v, i) => Math.max(-1, Math.min(1, v + dx[i])));
      cur = evalAt(x);
    }
    const w = {}; VARS.forEach((v, i) => { w[v] = x[i]; });
    return { w, got: cur };
  }
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-9) continue;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => (Math.abs(r[i]) < 1e-9 ? 0 : r[n] / r[i]));
  }

  // ---------- 자세: 팔은 몸 옆으로, 다리는 골반 너비로(관절 중심 회전, 뼈 가중치로 섞기) ----------
  // 정면(z축) 회전만 쓴다. rot[이름](점)은 관절 좌표(랜드마크)에 같은 회전을 적용
  function poseLimbs(P0, armDeg, legDeg, handTwist = 5, foreAdd = 4) {
    let P = P0;
    const rot = {};
    const turn = (P, pivot, child, W, deg, sign, extra) => {
      const J = extra ? extra(jpos(P0, pivot)) : jpos(P, pivot);
      const E = extra ? extra(jpos(P0, child)) : jpos(P, child);
      const cur = Math.atan2(Math.abs(E[0] - J[0]), J[1] - E[1]) * 180 / Math.PI;
      const a = (sign * (cur - deg) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const out = new Float32Array(P);
      for (let i = 0; i < W.length; i++) {
        const w = W[i] / 255;
        if (!w) continue;
        const x = P[i * 3] - J[0], y = P[i * 3 + 1] - J[1];
        out[i * 3] += w * (J[0] + x * c - y * s - P[i * 3]);
        out[i * 3 + 1] += w * (J[1] + x * s + y * c - P[i * 3 + 1]);
      }
      return { P: out, f: (p) => { const x = p[0] - J[0], y = p[1] - J[1]; return [J[0] + x * c - y * s, J[1] + x * s + y * c, p[2]]; } };
    };
    for (const [sd, sign] of [['L', -1], ['R', 1]]) {
      // 위팔(팔 전체)을 내리고, 바깥으로 꺾인 아래팔을 위팔 방향에 가깝게 편다
      const r1 = turn(P, `upperarm01.${sd}____head`, `lowerarm01.${sd}____head`, data.w['arm' + sd], armDeg, sign);
      P = r1.P;
      const r2 = turn(P, `lowerarm01.${sd}____head`, `wrist.${sd}____head`, data.w['fore' + sd], armDeg + foreAdd, sign, r1.f);
      P = r2.P;
      rot['arm' + sd] = r1.f;
      rot['fore' + sd] = (p) => r2.f(r1.f(p));
      // 손: 손바닥이 앞을 보던 것을 허벅지 쪽으로(아래팔 축 둘레로 돌린다)
      {
        const E = rot['fore' + sd](jpos(P0, `lowerarm01.${sd}____head`)), Wr = rot['fore' + sd](jpos(P0, `wrist.${sd}____head`));
        const ax = [Wr[0] - E[0], Wr[1] - E[1], Wr[2] - E[2]], l = Math.hypot(...ax);
        const u = ax.map((v) => v / l), a = (handTwist * sign * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const R3 = (x, y, z) => { // 로드리게스 회전
          const d = u[0] * x + u[1] * y + u[2] * z;
          return [x * c + (u[1] * z - u[2] * y) * s + u[0] * d * (1 - c), y * c + (u[2] * x - u[0] * z) * s + u[1] * d * (1 - c), z * c + (u[0] * y - u[1] * x) * s + u[2] * d * (1 - c)];
        };
        const W = data.w['hand' + sd], out = new Float32Array(P);
        for (let i = 0; i < W.length; i++) {
          const w = W[i] / 255;
          if (!w) continue;
          const q = R3(P[i * 3] - Wr[0], P[i * 3 + 1] - Wr[1], P[i * 3 + 2] - Wr[2]);
          for (let k = 0; k < 3; k++) out[i * 3 + k] += w * (Wr[k] + q[k] - P[i * 3 + k]);
        }
        P = out;
        const fr = rot['fore' + sd];
        rot['hand' + sd] = (p) => { const r = fr(p); const q = R3(r[0] - Wr[0], r[1] - Wr[1], r[2] - Wr[2]); return [Wr[0] + q[0], Wr[1] + q[1], Wr[2] + q[2]]; };
      }
      const r3 = turn(P, `upperleg01.${sd}____head`, `foot.${sd}____head`, data.w['leg' + sd], legDeg, sign);
      P = r3.P;
      rot['leg' + sd] = r3.f;
    }
    return { P, rot };
  }

  // ---------- 손: 손가락을 모으고 살짝 굽힌 편안한 손(차렷 자세의 손) ----------
  // 마디마다(끝 마디부터) 원래 관절 위치를 축으로 돌린다 → 정방향 운동학과 같다
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nrm3 = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
  const crs3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function rodrigues(u, deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return (x, y, z) => {
      const d = u[0] * x + u[1] * y + u[2] * z;
      return [x * c + (u[1] * z - u[2] * y) * s + u[0] * d * (1 - c), y * c + (u[2] * x - u[0] * z) * s + u[1] * d * (1 - c), z * c + (u[0] * y - u[1] * x) * s + u[2] * d * (1 - c)];
    };
  }
  function relaxHands(P0, curl = HAND_CURL) {
    if (!data.fingers['finger2-1.L']) return P0;
    const P = new Float32Array(P0);
    for (const sd of ['L', 'R']) {
      const jn = (n) => jpos(P0, n);
      const wr = jn(`wrist.${sd}____head`);
      // 손바닥 법선: (손목→가운뎃손가락) × (검지→새끼) — 손바닥 쪽을 향하게 부호를 맞춘다
      const d = nrm3(sub3(jn(`finger3-1.${sd}____head`), wr));
      const across = nrm3(sub3(jn(`finger5-1.${sd}____head`), jn(`finger2-1.${sd}____head`)));
      let pn = nrm3(crs3(d, across));
      if (sd === 'R') pn = pn.map((v) => -v);
      pn = pn.map((v) => v * curl.palmSign);
      const rotSeg = (nm, deg, axisFn) => {
        const f = data.fingers[nm];
        if (!f || !deg) return;
        const h = jpos(P0, nm + '____head'), t = jpos(P0, nm + '____tail');
        const ax = axisFn(nrm3(sub3(t, h)));
        const R = rodrigues(ax, deg);
        // 이미 굽은(끝 마디) 정점도 같이 돌려야 하므로 현재 P에서 돌리고, 축 위치는 아직 안 돌린 마디 관절(원래 자리)
        for (let j = 0; j < f.idx.length; j++) {
          const i = f.idx[j] * 3, w = f.w[j] / 255;
          const q = R(P[i] - h[0], P[i + 1] - h[1], P[i + 2] - h[2]);
          P[i] += w * (h[0] + q[0] - P[i]); P[i + 1] += w * (h[1] + q[1] - P[i + 1]); P[i + 2] += w * (h[2] + q[2] - P[i + 2]);
        }
      };
      const bend = (dir) => nrm3(crs3(dir, pn));
      for (let f = 2; f <= 5; f++) {
        const spread = (f - 3.2) * curl.close; // 손가락 사이를 모은다(가운데로)
        for (let s = 3; s >= 1; s--) rotSeg(`finger${f}-${s}.${sd}`, curl.seg[s - 1] + (f - 2) * curl.more, bend);
        rotSeg(`finger${f}-1.${sd}`, spread * (sd === 'L' ? 1 : -1), () => pn);
      }
      // 엄지: 검지 옆으로 붙이고 살짝 굽힌다
      for (let s = 3; s >= 2; s--) rotSeg(`finger1-${s}.${sd}`, curl.thumb[s - 1], bend);
      rotSeg(`finger1-1.${sd}`, curl.thumb[0] * (sd === 'L' ? 1 : -1), () => d);
      rotSeg(`finger1-1.${sd}`, curl.thumbIn * (sd === 'L' ? 1 : -1), () => pn);
      // 손 크기: 아래팔에 비해 커 보이던 손을 손목 기준으로 조금 줄인다
      if (curl.scale && curl.scale !== 1) {
        const W = data.w['hand' + sd];
        for (let i = 0; i < W.length; i++) {
          const w = W[i] / 255; if (!w) continue;
          const f = 1 - (1 - curl.scale) * w;
          for (let k = 0; k < 3; k++) P[i * 3 + k] = wr[k] + (P[i * 3 + k] - wr[k]) * f;
        }
      }
    }
    return P;
  }
  const FACE = {
    'lowerlip-vol': -0.7, 'lowerlip-h': -0.3, 'lowerlip-mid': 0.8, 'upperlip-mid': -0.6, 'mouth-angle': 0.3, 'mouth-w': -0.1,
    'chin-prom': 0.25, 'chin-w': -0.45, 'head-fat': -0.5, 'head-oval': 0,
    'cheek-vol': -0.6, 'cheek-bones': 0, 'nose-w': -0.15, 'nose-point': -0.3, 'nose-flare': -0.3, 'nose-vol': -0.1, 'nose-hump': 0,
    'brow-y': -0.15, 'brow-angle': 0, 'neck-w': 0.3, 'eye-open': 0.3, 'eye-bag': -0.4, 'eye-scale': 0.12,
  };
  const LIGHT = { key: 2.6, fill: 0.3, rim: 2.2, rim2: 1.6, env: 0.35, exposure: 0.84 };
  const POSE = { arm: 7.5, fore: 0, leg: 2.5, twist: -8, head: 0.96, hairThick: 0.8, hair: 'short02', cav: 0.6, browThick: 1.55, hairShells: 3, hairShellGap: 0.16, hairNormal: 0, hairBump: 2.0, pores: 0.35, lipClose: 0.2, fringe: 4.2, headTilt: 1.5 };
  const HAND_CURL = { palmSign: -1, seg: [7, 16, 10], more: 0.8, close: 1, thumb: [0, 8, 8], thumbIn: -55, scale: 0.95 };

  // 원래 정점 기준 법선(uv 이음매에서도 끊기지 않게)
  function normals(P) {
    const N = new Float32Array(P.length), t = data.normTris;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) { N[i] += nx; N[i + 1] += ny; N[i + 2] += nz; }
    }
    for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
    return N;
  }

  // 덧붙이는 메시 좌표: 기준 몸 정점 3개의 가중 평균 + 오프셋(몸 크기에 비례)
  function proxyPos(p, P, thick = 1) {
    const n = p.vi.length / 3, out = new Float32Array(n * 3);
    const sc = {};
    for (const ax of ['x', 'y', 'z']) { const [a, b, ref] = p.scale[ax]; const k = { x: 0, y: 1, z: 2 }[ax]; sc[ax] = Math.abs(P[a * 3 + k] - P[b * 3 + k]) / ref; }
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        let v = 0;
        for (let j = 0; j < 3; j++) v += p.pw[i * 6 + j] * P[p.vi[i * 3 + j] * 3 + k];
        out[i * 3 + k] = v + p.pw[i * 6 + 3 + k] * sc['xyz'[k]] * thick;
      }
    }
    return out;
  }

  // 정점 배열 + 갈라진 정점 목록 → three 지오메트리
  function geom(ref, uv, tris, P, N) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(ref.length * 3), nor = N ? new Float32Array(ref.length * 3) : null;
    for (let i = 0; i < ref.length; i++) for (let k = 0; k < 3; k++) { pos[i * 3 + k] = P[ref[i] * 3 + k]; if (N) nor[i * 3 + k] = N[ref[i] * 3 + k]; }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1));
    if (N) g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); else g.computeVertexNormals();
    return g;
  }

  // 사진 스튜디오 같은 환경: 안쪽을 보는 회색 상자 방에 밝은 판(소프트박스)을 왼쪽 앞 위·오른쪽·위에 둔다
  function makeStudio() {
    const room = new THREE.Scene();
    const box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial({ color: 0x5a5652, side: THREE.BackSide }));
    room.add(box);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: 0x8a847e }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -4.9; room.add(floor);
    const panel = (w, h, x, y, z, lum, tint = [1, 1, 1]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(tint[0] * lum, tint[1] * lum, tint[2] * lum), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m);
    };
    panel(3.2, 4.2, -3, 2, 4.4, 9, [1, 0.96, 0.9]);  // 주광 소프트박스(왼쪽 앞 위)
    panel(2.5, 4, 4.4, 0.5, 2, 3.5, [0.92, 0.96, 1]); // 보조(오른쪽)
    panel(5, 2.5, 0, 4.8, 0, 4);                     // 천장
    panel(3, 3, 1.5, 2.5, -4.6, 5);                  // 뒤 윤곽광
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromScene(room, 0.03).texture;
    pm.dispose();
    return env;
  }

  // 오목함(0~1): 이웃 평균을 여러 번 해 큰 굴곡(눈두덩)까지 잡는다
  let adj = null;
  function cavity(P, N) {
    const n = P.length / 3, t = data.normTris;
    if (!adj) {
      const sets = Array.from({ length: n }, () => new Set());
      for (let k = 0; k < t.length; k += 3) for (let e = 0; e < 3; e++) { const a = t[k + e], b = t[k + (e + 1) % 3]; sets[a].add(b); sets[b].add(a); }
      const off = new Uint32Array(n + 1); sets.forEach((st, i) => { off[i + 1] = off[i] + st.size; });
      const idx = new Uint32Array(off[n]); sets.forEach((st, i) => { let j = off[i]; for (const v of st) idx[j++] = v; });
      adj = { off, idx };
    }
    const { off, idx } = adj;
    let S = new Float32Array(P), T2 = new Float32Array(P.length);
    const out = new Float32Array(n);
    for (let it = 1; it <= 12; it++) {
      for (let i = 0; i < n; i++) {
        const a = off[i], b = off[i + 1];
        if (a === b) { T2[i * 3] = S[i * 3]; T2[i * 3 + 1] = S[i * 3 + 1]; T2[i * 3 + 2] = S[i * 3 + 2]; continue; }
        let x = 0, y = 0, z = 0;
        for (let j = a; j < b; j++) { const v = idx[j] * 3; x += S[v]; y += S[v + 1]; z += S[v + 2]; }
        const m = b - a;
        T2[i * 3] = (S[i * 3] + x / m) / 2; T2[i * 3 + 1] = (S[i * 3 + 1] + y / m) / 2; T2[i * 3 + 2] = (S[i * 3 + 2] + z / m) / 2;
      }
      [S, T2] = [T2, S];
      if (it === 3 || it === 12) {
        const sc = it === 3 ? 0.18 : 0.7; // 작은 굴곡 / 큰 굴곡 기준 깊이(cm)
        const hw = data.w.head;
        for (let i = 0; i < n; i++) {
          const d = (S[i * 3] - P[i * 3]) * N[i * 3] + (S[i * 3 + 1] - P[i * 3 + 1]) * N[i * 3 + 1] + (S[i * 3 + 2] - P[i * 3 + 2]) * N[i * 3 + 2];
          // 큰 굴곡은 얼굴(눈두덩·콧방울·입꼬리)에만 진하게: 몸통에 쓰면 가슴·쇄골에 멍처럼 얼룩진다
          const wgt = it === 3 ? 0.15 + 0.4 * (hw[i] / 255) : 0.06 + 0.28 * (hw[i] / 255); // 몸통도 아주 약하게(쇄골·가슴 윤곽)
          out[i] += Math.max(0, Math.min(1, d / sc)) * wgt;
        }
      }
    }
    return out;
  }

  // 피부 모공 무늬(범프): 잔 점 노이즈를 작은 타일로(몸 전체 UV에 여러 번 반복)
  let poreT = null;
  function poreTex() {
    if (poreT) return poreT;
    const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), im = g.createImageData(N, N);
    let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const v = new Float32Array(N * N);
    for (let i = 0; i < v.length; i++) v[i] = rnd();
    // 살짝 흐려 점이 아니라 작은 우묵한 자국으로
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += v[((y + dy + N) % N) * N + ((x + dx + N) % N)];
      const q = Math.round(128 + (s / 9 - 0.5) * 300);
      const i = (y * N + x) * 4; im.data[i] = im.data[i + 1] = im.data[i + 2] = Math.max(0, Math.min(255, q)); im.data[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    poreT = new THREE.CanvasTexture(c);
    poreT.wrapS = poreT.wrapT = THREE.RepeatWrapping; poreT.repeat.set(24, 24);
    return poreT;
  }

  // 머리카락 가닥 무늬(알파): 가는 세로 획을 무작위로 겹쳐 그린 캔버스(한 번만 만든다)
  let strandT = null;
  function strandTex() {
    if (strandT) return strandT;
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    g.lineCap = 'round';
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 512, y = rnd() * 512, L = 25 + rnd() * 60, a = (rnd() - 0.5) * 0.35;
      const v = Math.round(120 + rnd() * 135);
      g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 0.7 + rnd() * 1.1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * L, y + Math.cos(a) * L); g.stroke();
    }
    strandT = new THREE.CanvasTexture(c);
    strandT.wrapS = strandT.wrapT = THREE.RepeatWrapping; strandT.repeat.set(3, 3);
    return strandT;
  }

  // 머리카락 그늘: 머리 피부 정점마다 가장 가까운 머리카락 정점까지 거리(cm) → 가까울수록 1
  function hairShade(H, P) {
    const C = 2, cells = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
    for (let i = 0; i < H.length; i += 3) {
      const k = key(Math.floor(H[i] / C), Math.floor(H[i + 1] / C), Math.floor(H[i + 2] / C));
      let a = cells.get(k); if (!a) cells.set(k, (a = [])); a.push(i);
    }
    const ref = data.body.ref, hw = data.w.head, out = new Float32Array(ref.length);
    for (let j = 0; j < ref.length; j++) {
      const r = ref[j];
      if (hw[r] < 30) continue;
      const x = P[r * 3], y = P[r * 3 + 1], z = P[r * 3 + 2];
      const cx = Math.floor(x / C), cy = Math.floor(y / C), cz = Math.floor(z / C);
      let d2 = Infinity;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const L = cells.get(key(cx + a, cy + b, cz + c)); if (!L) continue;
        for (const i of L) { const dx = H[i] - x, dy = H[i + 1] - y, dz = H[i + 2] - z; const q = dx * dx + dy * dy + dz * dz; if (q < d2) d2 = q; }
      }
      const d = Math.sqrt(d2), t = Math.min(1, Math.max(0, (d - 0.15) / 0.9));
      out[j] = 1 - t * t * (3 - 2 * t);
    }
    return out;
  }

  const hexRGB = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));

  // 입 다물기: 피부 UV에서 입술 자리(얼굴 조각이 90도 돌아 있어 윗입술은 왼쪽, 아랫입술은 오른쪽)를 찾아
  // 입술 사이 선에 가까운 정점일수록 윗입술은 아래로, 아랫입술은 위로 옮긴다(cm)
  function closeLips(P, amt) {
    const ref = data.body.ref, uv = data.body.uv, done = new Uint8Array(P.length / 3);
    const SX = 1862, CY = 1060, RX = 46, RY = 62;
    for (let j = 0; j < ref.length; j++) {
      const i = ref[j]; if (done[i]) continue;
      const px = uv[j * 2] * 2048, py = (1 - uv[j * 2 + 1]) * 2048;
      const e = ((px - SX) / RX) ** 2 + ((py - CY) / RY) ** 2;
      if (e > 1) continue;
      done[i] = 1;
      const d = px - SX, w = Math.max(0, 1 - Math.abs(d) / 30) * (1 - e) ** 0.5;
      P[i * 3 + 1] += (d < 0 ? -1 : 1) * amt * w;
    }
  }

  // ---------- 3D 옷(아바타 전용): MakeHuman 옷 메시를 몸에 붙여 사이즈표대로 넓히고 자른다 ----------
  // 팔 위치 판정(원래 A자세 좌표): 어깨 관절보다 바깥이면 어깨 관절에서 손목 쪽으로 잰 거리(cm), 아니면 -1
  const CLOTH_GLSL = `
uniform vec3 uShL, uShR, uAxL, uAxR;
uniform float uTopOn, uBotOn, uHem, uSleeve, uWaist, uPHem, uHemM, uSleeveM, uWaistM, uPHemM, uZc;
float armParam(vec3 p) {
  vec3 sh = p.x > 0.0 ? uShL : uShR;
  vec3 ax = p.x > 0.0 ? uAxL : uAxR;
  if (abs(p.x) < abs(sh.x) - 1.0) return -1.0;
  float t = dot(p - sh, ax);
  if (length(p - sh - ax * t) > 9.0 && t > 0.0) return -1.0; // 팔 축에서 먼 곳(골반 옆 등)은 팔이 아니다
  return max(0.0, t);
}
`;
  function clothArmUniforms(cmP) {
    const u = {};
    for (const sd of ['L', 'R']) {
      const sh = jpos(cmP, `upperarm01.${sd}____head`), wr = jpos(cmP, `wrist.${sd}____head`);
      const ax = nrm3(sub3(wr, sh));
      u['uSh' + sd] = { value: new THREE.Vector3(...sh) };
      u['uAx' + sd] = { value: new THREE.Vector3(...ax) };
    }
    return u;
  }

  let cloth = null, clothLoading = null;
  async function loadCloth() {
    if (cloth) return cloth;
    if (clothLoading) return clothLoading;
    clothLoading = (async () => {
      const B = BASE + 'cloth/';
      const [meta, bin] = await Promise.all([fetch(B + 'cloth.json').then((r) => r.json()), fetch(B + 'cloth.bin').then((r) => r.arrayBuffer())]);
      const T = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array };
      const arr = (name) => { const a = meta.arrays[name]; return new T[a.type](bin, a.offset, a.count); };
      const loader = new THREE.TextureLoader();
      const tex = {};
      await Promise.all(['tee_ao.jpg', 'longtee_ao.jpg', 'jeans_d.jpg', 'jeans_n.jpg'].map((n) => new Promise((res, rej) => loader.load(B + n, (t) => { if (!n.endsWith('_n.jpg')) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; tex[n] = t; res(); }, undefined, rej))));
      const items = {};
      for (const c of meta.cloth) {
        items[c.name] = { name: c.name, scale: c.scale, vi: arr(`c.${c.name}.vi`), pw: arr(`c.${c.name}.w`), ref: arr(`c.${c.name}.ref`), uv: arr(`c.${c.name}.uv`), tris: arr(`c.${c.name}.tris`), cover: arr(`c.${c.name}.cover`) };
      }
      cloth = { items, tex };
      return cloth;
    })();
    try { return await clothLoading; } finally { clothLoading = null; }
  }

  // 니트(저지) 잔결 범프: 가로로 촘촘한 코 무늬(한 번만 만든다)
  let knitT = null;
  function knitTex() {
    if (knitT) return knitT;
    const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), im = g.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = 128 + 60 * Math.sin((x / N) * Math.PI * 2 * 32) * Math.abs(Math.sin((y / N) * Math.PI * 2 * 24)) + (Math.random() - 0.5) * 30;
      const i = (y * N + x) * 4; im.data[i] = im.data[i + 1] = im.data[i + 2] = Math.max(0, Math.min(255, v)); im.data[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    knitT = new THREE.CanvasTexture(c);
    knitT.wrapS = knitT.wrapT = THREE.RepeatWrapping; knitT.repeat.set(36, 36); knitT.anisotropy = 8; // 촘촘하게(골지처럼 보이지 않게)
    return knitT;
  }

  // 상품 사진(오린 옷 캔버스)의 대표색: 가운데 영역의 불투명 픽셀 중 살색·배경색(밝은 무채색)을 뺀 중앙값
  function garmentColor(canvas) {
    if (!canvas?.width) return null;
    const S = 96, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(canvas, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data;
    // 옷이 있는 범위의 가운데 40%
    let x0 = S, x1 = 0, y0 = S, y1 = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (d[(y * S + x) * 4 + 3] > 200) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 <= x0) return null;
    const cx0 = x0 + (x1 - x0) * 0.3, cx1 = x1 - (x1 - x0) * 0.3, cy0 = y0 + (y1 - y0) * 0.2, cy1 = y1 - (y1 - y0) * 0.35;
    const R = [], G = [], Bl = [];
    for (let y = Math.floor(cy0); y < cy1; y++) for (let x = Math.floor(cx0); x < cx1; x++) {
      const i = (y * S + x) * 4; if (d[i + 3] < 200) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const skin = r > 95 && gg > 40 && b > 20 && r > gg && r > b && r - Math.min(gg, b) > 15 && Math.abs(r - gg) > 15 && r > 150; // 살색 근처
      const bg = Math.min(r, gg, b) > 225 && Math.max(r, gg, b) - Math.min(r, gg, b) < 12;
      if (skin || bg) continue;
      R.push(r); G.push(gg); Bl.push(b);
    }
    if (R.length < 20) return null;
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const h = (v) => Math.round(v).toString(16).padStart(2, '0');
    return '#' + h(med(R)) + h(med(G)) + h(med(Bl));
  }

  // 옷 색: 아주 어두운 색은 무채색 쪽으로(검은 옷이 갈색으로 뜨지 않게), 밝기 바닥 0.07(데님 결이 보이게)
  function clothColor(hex) {
    const [r, g, b] = hexRGB(hex || '#808080').map((v) => v / 255);
    let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let c = [r, g, b];
    if (L < 0.22) { const t = Math.min(1, (1 - L / 0.22) * 1.3) * 0.9; c = c.map((v) => v * (1 - t) + L * t); }
    if (L < 0.09) { const k = 0.09 / Math.max(0.005, L); c = c.map((v) => Math.min(1, v * k + (0.09 - L) * (L < 0.005 ? 1 : 0))); }
    return new THREE.Color(c[0], c[1], c[2]).convertSRGBToLinear();
  }

  const hexToLin = (hex) => new THREE.Color(...hexRGB(hex || '#808080').map((v) => v / 255)).convertSRGBToLinear();

  // 옷 메시 하나 만들기: it(옷 데이터), P(자세 잡은 몸), cmP(원래 자세 몸), ease(정점별 넓힐 cm를 돌려주는 함수)
  // extendTo: 몸판 밑단을 이 높이(원래 자세 y, cm)까지 늘린다(사이즈표 총장이 옷 메시보다 길 때)
  // radial(x, y, z): 0~1, 1이면 몸 세로축에서 바깥(수평) 방향으로 넓힌다(앞 지퍼 덮개처럼 겹친 천이 서로 뚫고 나오지 않게)
  function clothMesh(it, P, cmP, ease, mat, extendTo, radial, zc = 0) {
    const PP = proxyPos({ ...it, scale: it.scale }, P);
    const R = proxyPos({ ...it, scale: it.scale }, cmP);
    const n = PP.length / 3, t = it.tris, ref = it.ref;
    const used = new Uint8Array(n); for (let j = 0; j < ref.length; j++) used[ref[j]] = 1; // 이 옷 조각이 쓰는 정점만(같은 원본의 다른 옷 정점 빼기)
    // 메시가 덮는 범위(원래 자세): 몸 숨기기를 이 안으로만
    let yMin = Infinity, yMax = -Infinity, sMax = 0;
    const isArm = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      if (!used[i]) continue;
      const aS = armParamJS(cmP, R[i * 3], R[i * 3 + 1], R[i * 3 + 2]);
      if (aS >= 0) { isArm[i] = 1; sMax = Math.max(sMax, aS); } else { yMin = Math.min(yMin, R[i * 3 + 1]); yMax = Math.max(yMax, R[i * 3 + 1]); }
    }
    // 겹치지 않은 정점 기준 법선(이음매가 벌어지지 않게)
    const Nn = new Float32Array(n * 3);
    for (let k = 0; k < t.length; k += 3) {
      const a = ref[t[k]] * 3, b = ref[t[k + 1]] * 3, c = ref[t[k + 2]] * 3;
      const ux = PP[b] - PP[a], uy = PP[b + 1] - PP[a + 1], uz = PP[b + 2] - PP[a + 2];
      const vx = PP[c] - PP[a], vy = PP[c + 1] - PP[a + 1], vz = PP[c + 2] - PP[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) { Nn[i] += nx; Nn[i + 1] += ny; Nn[i + 2] += nz; }
    }
    // 몸판 밑단 높이: 아래쪽 몇 개 튀는 정점 대신 아래에서 5% 지점
    {
      const ys = [];
      for (let i = 0; i < n; i++) if (used[i] && !isArm[i]) ys.push(R[i * 3 + 1]);
      ys.sort((a, b) => a - b);
      if (ys.length) yMin = ys[Math.floor(ys.length * 0.05)];
    }
    // 긴 기장: 허리 아래 몸판을 아래로 고르게 늘린다(밑단 쪽일수록 많이)
    const drop = extendTo != null && extendTo < yMin ? yMin - extendTo : 0;
    const y0 = yMin + 18;
    for (let i = 0; i < n; i++) {
      if (!used[i]) continue;
      const l = Math.hypot(Nn[i * 3], Nn[i * 3 + 1], Nn[i * 3 + 2]) || 1;
      const e = ease(R[i * 3], R[i * 3 + 1], R[i * 3 + 2]);
      const wr = radial ? radial(R[i * 3], R[i * 3 + 1], R[i * 3 + 2]) : 0;
      let dx = Nn[i * 3] / l, dy = Nn[i * 3 + 1] / l, dz = Nn[i * 3 + 2] / l;
      if (wr > 0) {
        const rx = PP[i * 3], rz = PP[i * 3 + 2] - zc, rl = Math.hypot(rx, rz) || 1;
        dx = dx * (1 - wr) + (rx / rl) * wr; dy *= 1 - wr; dz = dz * (1 - wr) + (rz / rl) * wr;
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      }
      PP[i * 3] += dx * e; PP[i * 3 + 1] += dy * e; PP[i * 3 + 2] += dz * e;
      if (drop && !isArm[i] && R[i * 3 + 1] < y0) {
        const d = drop * (y0 - R[i * 3 + 1]) / (y0 - yMin);
        PP[i * 3 + 1] -= d; R[i * 3 + 1] -= d;
      }
    }
    // 소매(팔 정점)는 넓힌 뒤 이웃 평균으로 3번 다듬는다: 정점마다 다른 여유 때문에 각진 다면체처럼 보이지 않게
    {
      const nb = Array.from({ length: n }, () => new Set());
      for (let k = 0; k < t.length; k += 3) for (let e = 0; e < 3; e++) { const a = ref[t[k + e]], b = ref[t[k + (e + 1) % 3]]; if (a !== b) { nb[a].add(b); nb[b].add(a); } }
      for (let it2 = 0; it2 < 3; it2++) {
        const Q = new Float32Array(PP);
        for (let i = 0; i < n; i++) {
          if (!used[i] || !isArm[i] || !nb[i].size) continue;
          let x = 0, y = 0, z = 0;
          for (const j of nb[i]) { x += PP[j * 3]; y += PP[j * 3 + 1]; z += PP[j * 3 + 2]; }
          const m = nb[i].size;
          Q[i * 3] = PP[i * 3] * 0.5 + (x / m) * 0.5; Q[i * 3 + 1] = PP[i * 3 + 1] * 0.5 + (y / m) * 0.5; Q[i * 3 + 2] = PP[i * 3 + 2] * 0.5 + (z / m) * 0.5;
        }
        PP.set(Q);
      }
    }
    const g = geom(ref, it.uv, t, PP, null);
    const rest = new Float32Array(ref.length * 3);
    for (let i = 0; i < ref.length; i++) for (let k = 0; k < 3; k++) rest[i * 3 + k] = R[ref[i] * 3 + k];
    g.setAttribute('restPos', new THREE.BufferAttribute(rest, 3));
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.ext = { yMin: yMin - drop, yMax, sMax };
    mesh.userData.rest = R; mesh.userData.used = used;
    return mesh;
  }

  // 옷 재질: 사이즈표 길이로 자르기(원래 자세 좌표로 판정) + 3D 조명
  function clothMaterial(kind, opts, U) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: clothColor(opts.color).multiplyScalar(kind === 'bottom' ? 1.25 : 1), side: THREE.DoubleSide, roughness: kind === 'bottom' ? 0.93 : 0.9, // 데님 결 지도 평균(약 0.8)만큼 밝혀 상품색에 맞춘다
      sheen: kind === 'bottom' ? 0 : 0.5, sheenRoughness: 0.7, sheenColor: clothColor(opts.color).multiplyScalar(0.6).addScalar(0.12),
      ...(opts.map ? { map: opts.map } : {}), ...(opts.normalMap ? { normalMap: opts.normalMap, normalScale: new THREE.Vector2(0.8, 0.8) } : {}),
      ...(opts.bump ? { bumpMap: opts.bump, bumpScale: 0.25 } : {}),
    });
    mat.customProgramCacheKey = () => 'cloth-' + kind; // 상의·바지는 자르는 식이 달라 셰이더를 따로
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 restPos;\nvarying vec3 vRest;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = restPos;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vRest;\n' + CLOTH_GLSL)
        .replace('#include <clipping_planes_fragment>', kind === 'top' ? `#include <clipping_planes_fragment>
          float hemY = uHem - 1.2 * smoothstep(0.0, 12.0, uZc - vRest.z); // 뒤·옆이 조금 더 길다
          float aS = armParam(vRest);
          if (aS >= 0.0 ? aS > uSleeve : vRest.y < hemY) discard;
          float edgeD = aS >= 0.0 ? uSleeve - aS : vRest.y - hemY;` : `#include <clipping_planes_fragment>
          if (vRest.y > uWaist || vRest.y < uPHem) discard;
          float edgeD = min(uWaist - vRest.y, vRest.y - uPHem);`)
        // 안쪽 면(밑단·소매 안으로 보이는 곳)은 어둡게
        .replace('#include <map_fragment>', '#include <map_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb *= ' + (kind === 'top' ? '0.7' : '0.8') + ';' // 바지는 앞 지퍼 쪽 겹친 천 사이로 안쪽이 보여 덜 어둡게
          + '\ndiffuseColor.rgb *= mix(0.82, 1.0, smoothstep(1.2, 1.5, edgeD));'); // 밑단·소매 끝 접어 박은 단(1.2~1.5cm, 18% 어둡게)
    };
    return mat;
  }

  // 아바타에 3D 옷 입히기. photo: build() 결과, outfit: { top?: { g, color, stretch }, bottom?: { g, color, stretch } }
  // 돌려주는 것: 옷 입은 아바타 캔버스(같은 640x1280, 얼굴·배경 포함)
  async function dress(photo, outfit) {
    const X = photo?._3d;
    if (!X) return null;
    const key = JSON.stringify(outfit);
    if (X.cache.has(key)) return X.cache.get(key);
    const C = await loadCloth();
    const { scene, body, briefU: U, P, cmP, m, crotchY } = X;
    const meshes = [];
    const cov = body.geometry.attributes.aCov, ca = cov.array;
    ca.fill(0);
    // 옷 밑 몸 숨기기: 덮는 목록에 있고, 몸 자리가 옷이 남는 범위 안(keep)이며, 3.5cm 안에 남은 옷 정점이 있을 때만
    const bodyIdx = (list, slot, mesh, keep) => {
      const R = mesh.userData.rest, used = mesh.userData.used, C2 = 3.5, cells = new Map(), kk = (a, b, c) => a + ',' + b + ',' + c;
      for (let i = 0; i < R.length / 3; i++) {
        if (!used[i] || !keep(R[i * 3], R[i * 3 + 1], R[i * 3 + 2], 0)) continue;
        const key = kk(Math.floor(R[i * 3] / C2), Math.floor(R[i * 3 + 1] / C2), Math.floor(R[i * 3 + 2] / C2));
        let a = cells.get(key); if (!a) cells.set(key, (a = [])); a.push(i);
      }
      const set = new Uint8Array(P.length / 3);
      for (const i of list) {
        const x = cmP[i * 3], y = cmP[i * 3 + 1], z = cmP[i * 3 + 2];
        if (!keep(x, y, z, 1.5)) continue;
        const cx = Math.floor(x / C2), cy = Math.floor(y / C2), cz = Math.floor(z / C2);
        let hit = false;
        for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) for (let c = -1; c <= 1 && !hit; c++) {
          const L = cells.get(kk(cx + a, cy + b, cz + c)); if (!L) continue;
          for (const j of L) { const dx = R[j * 3] - x, dy = R[j * 3 + 1] - y, dz = R[j * 3 + 2] - z; if (dx * dx + dy * dy + dz * dz < C2 * C2) { hit = true; break; } }
        }
        if (hit) set[i] = 1;
      }
      const ref = data.body.ref;
      for (let j = 0; j < ref.length; j++) if (set[ref[j]]) ca[j * 2 + slot] = 1;
    };
    const give = (st) => 1 + ({ none: 0, some: 0.04, lots: 0.08 }[st] ?? 0);
    const neckY = jpos(cmP, 'neck01____head')[1];
    const TAU = Math.PI * 2;
    U.uTopOn.value = 0; U.uBotOn.value = 0;
    if (outfit.top?.g) {
      const g = outfit.top.g;
      const it = C.items[g.sleeve != null && g.sleeve > 40 ? 'longtee' : 'tee'];
      const hps = neckY + 1; // 옷깃 옆 어깨 꼭대기(목 밑)
      U.uHem.value = hps - (g.length ?? 70);
      U.uSleeve.value = g.sleeve != null ? g.sleeve + 2 : 100;
      U.uTopOn.value = 1;
      // 넓히기: 가슴 둘레 여유(옷 - 몸)를 반지름으로(원래 옷 메시가 가진 여유 약 1.2cm는 뺀다). 목 근처는 넓히지 않는다
      const chestE = Math.max(-0.4, Math.min(9, ((g.chest ? 2 * g.chest * give(outfit.top.stretch) : m.chest + 8) - m.chest) / TAU - 1.2));
      const ease = (x, y, z) => {
        const aS = armParamJS(X.cmP, x, y, z);
        const f = Math.min(1, Math.max(0, (neckY - 2 - y) / 10));
        // 소매는 몸통 여유를 거의 받지 않는다(진동에서 6cm 안에 서서히 줄여 0.2cm): 풍선 소매 방지
        // 바지와 함께 입으면 허리 아래 몸판을 0.6cm 더 띄워 바지 허리가 옆으로 뚫고 나오지 않게
        const over = outfit.bottom?.g ? 0.6 * Math.min(1, Math.max(0, (crotchY + 22 - y) / 6)) : 0;
        // 소매 윗부분(어깨 관절에서 6cm 안)은 0.5cm까지만: 부푼 소매산 방지
        return aS >= 0 ? (Math.min(0.5, chestE * Math.max(0, 1 - aS / 6)) - 0.25 * Math.min(1, Math.max(0, (aS - 3) / 5))) * f : chestE * f + over;
      };
      const zcT = jpos(cmP, 'spine03____head')[2];
      const radialT = (x, y, z) => (armParamJS(X.cmP, x, y, z) >= 0 ? 0 : Math.min(1, Math.max(0, (neckY - 4 - y) / 8)));
      const mat = clothMaterial('top', { color: outfit.top.color, map: C.tex[it.name + '_ao.jpg'], bump: knitTex() }, U);
      U.uZc.value = zcT;
      const mesh = clothMesh(it, P, cmP, ease, mat, U.uHem.value, radialT, zcT);
      U.uHemM.value = mesh.userData.ext.yMin; U.uSleeveM.value = mesh.userData.ext.sMax;
      meshes.push(mesh);
      const sl = Math.min(U.uSleeve.value, U.uSleeveM.value), hem = Math.max(U.uHem.value, U.uHemM.value);
      bodyIdx(it.cover, 0, mesh, (x, y, z, mg) => { const aS = armParamJS(cmP, x, y, z); return aS >= 0 ? aS <= sl - mg : y >= hem + mg; });
    }
    if (outfit.bottom?.g) {
      const g = outfit.bottom.g;
      const it = C.items.jeans;
      const waist = crotchY + (g.rise ?? 27);
      U.uWaist.value = waist;
      U.uPHem.value = Math.max(2.5, waist - (g.length ?? 100));
      U.uBotOn.value = 1;
      const wE = Math.max(-0.4, ((g.waist ? 2 * g.waist * give(outfit.bottom.stretch) : m.waist) - m.waist) / TAU - 0.8);
      const tE = Math.max(-0.3, ((g.thigh ? 2 * g.thigh * give(outfit.bottom.stretch) : m.thigh + 6) - m.thigh) / TAU - 0.8);
      const hE = Math.max(-0.3, ((g.hem ? 2 * g.hem : 40) - 26) / TAU - 1.6);
      const ankleY = 8;
      const ease = (x, y) => {
        if (y > crotchY + 3) return wE; // 허리~엉덩이
        const tt = Math.min(1, Math.max(0, (crotchY - y) / (crotchY - ankleY)));
        const blend = Math.min(1, Math.max(0, (crotchY + 3 - y) / 6));
        return wE * (1 - blend) + (tE * (1 - tt) + hE * tt) * blend;
      };
      const mat = clothMaterial('bottom', { color: outfit.bottom.color, map: C.tex['jeans_d.jpg'], normalMap: C.tex['jeans_n.jpg'] }, U);
      const zcB = jpos(cmP, 'upperleg01.L____head')[2];
      const mesh = clothMesh(it, P, cmP, ease, mat, null, (x, y) => Math.min(1, Math.max(0, (y - crotchY) / 4)), zcB);
      U.uWaistM.value = mesh.userData.ext.yMax; U.uPHemM.value = mesh.userData.ext.yMin;
      // 앞 가운데 허리선(지퍼 위)이 뒤보다 낮다: 그보다 위로 자르면 바지 안쪽(뒤판 안감)이 비친다
      {
        const R = mesh.userData.rest, used = mesh.userData.used;
        let front = -Infinity;
        for (let i = 0; i < R.length / 3; i++) if (used[i] && R[i * 3 + 2] > 0 && Math.abs(R[i * 3]) < 3 && R[i * 3 + 1] > crotchY) front = Math.max(front, R[i * 3 + 1]);
        if (front > crotchY) U.uWaist.value = Math.min(U.uWaist.value, front - 0.3);
      }
      meshes.push(mesh);
      const wt = Math.min(U.uWaist.value, U.uWaistM.value), ph = Math.max(U.uPHem.value, U.uPHemM.value);
      // 바지는 덮는 목록 + 팔·손이 아닌 몸 전부(앞 지퍼 쪽 살·속옷이 바지를 뚫고 나오지 않게)
      const cand = new Set(it.cover), wa = data.w.armL, wb = data.w.armR;
      for (let i = 0; i < wa.length; i++) if (wa[i] + wb[i] < 40) cand.add(i);
      bodyIdx(cand, 1, mesh, (x, y, z, mg) => y <= wt - mg * 0.3 && y >= ph + mg);
    }
    cov.needsUpdate = true;
    meshes.forEach((o) => scene.add(o));
    // 다른 패스에서 꺼 둔 조명을 켜고 같은 설정으로 그린다
    scene.children.filter((o) => o.isLight).forEach((l) => { l.visible = true; });
    renderer.setPixelRatio(1); renderer.setSize(CW * SS, CH * SS, false);
    scene.environment = studioEnv; scene.environmentIntensity = LIGHT.env;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = LIGHT.exposure;
    const full = X.shot();
    meshes.forEach((o) => { scene.remove(o); o.geometry.dispose(); o.material.dispose(); });
    U.uTopOn.value = 0; U.uBotOn.value = 0; ca.fill(0); cov.needsUpdate = true;
    if (X.facePaste && X.face?.img) full.getContext('2d').drawImage(X.face.img, X.facePaste.x, X.facePaste.y, X.face.img.width * X.facePaste.k, X.face.img.height * X.facePaste.k);
    const canvas = X.backdrop(full);
    if (X.cache.size > 12) X.cache.clear();
    X.cache.set(key, canvas);
    return canvas;
  }
  function armParamJS(cmP, x, y, z) {
    const sd = x > 0 ? 'L' : 'R';
    const sh = jpos(cmP, `upperarm01.${sd}____head`);
    if (Math.abs(x) < Math.abs(sh[0]) - 1) return -1;
    const ax = nrm3(sub3(jpos(cmP, `wrist.${sd}____head`), sh));
    const t = (x - sh[0]) * ax[0] + (y - sh[1]) * ax[1] + (z - sh[2]) * ax[2];
    if (t > 0 && Math.hypot(x - sh[0] - ax[0] * t, y - sh[1] - ax[1] * t, z - sh[2] - ax[2] * t) > 9) return -1;
    return Math.max(0, t);
  }

  // ---------- 아바타 만들기 ----------
  // face(선택): avatar.js makeFace() 결과 { img, chinY, centerX, faceW, skin } — 내 사진에서 오린 얼굴·머리카락
  async function build(state, analysis, pc, face) {
    await load();
    const m = Avatar.measures(state, analysis);
    const { w } = fit(m);
    // 얼굴 다듬기(몸 치수와 무관): 아랫입술을 얇게, 입꼬리 살짝 위로, 갸름한 턱, 콧볼 좁게, 목 조금 굵게 등
    const fw = {};
    for (const [k, v] of Object.entries(FACE)) fw['f.' + k] = v;
    let P = morph({ ...w, ...fw });
    const meas = measure(P, m.H);
    const k = meas.k * 1; // dm → cm(목표 키)
    // 단위 맞추기: cm, 바닥 y=0, 가운데 x=0
    const cmP = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) { cmP[i] = P[i] * k; cmP[i + 1] = (P[i + 1] - meas.minY) * k; cmP[i + 2] = P[i + 2] * k; }
    const cmH = relaxHands(cmP);
    // 머리를 조금 작게(정수리 기준으로 줄여 키는 그대로): 어깨에 비해 머리가 커 보이던 것
    if (POSE.head !== 1) {
      const hw0 = data.w.head;
      let top = -Infinity;
      for (let i = 0; i < hw0.length; i++) if (hw0[i] > 200 && cmH[i * 3 + 1] > top) top = cmH[i * 3 + 1];
      const c0 = jpos(cmH, 'head____tail'), cz = jpos(cmH, 'neck03____head');
      for (let i = 0; i < hw0.length; i++) {
        const w = hw0[i] / 255; if (!w) continue;
        const f = 1 - (1 - POSE.head) * w;
        cmH[i * 3] = c0[0] + (cmH[i * 3] - c0[0]) * f;
        cmH[i * 3 + 1] = top + (cmH[i * 3 + 1] - top) * f;
        cmH[i * 3 + 2] = cz[2] + (cmH[i * 3 + 2] - cz[2]) * f;
      }
    }
    if (POSE.lipClose) closeLips(cmH, POSE.lipClose);
    // 머리를 아주 조금(1.5도) 기울여 마네킹 같은 완전 대칭을 깬다(목 관절 중심, 머리 가중치만큼)
    if (POSE.headTilt) {
      const hw0 = data.w.head, c0 = jpos(cmH, 'neck03____head'), a = (POSE.headTilt * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      for (let i = 0; i < hw0.length; i++) {
        const w = hw0[i] / 255; if (!w) continue;
        const x = cmH[i * 3] - c0[0], y = cmH[i * 3 + 1] - c0[1];
        cmH[i * 3] += w * (c0[0] + x * ca - y * sa - cmH[i * 3]);
        cmH[i * 3 + 1] += w * (c0[1] + x * sa + y * ca - cmH[i * 3 + 1]);
      }
    }
    const posed = poseLimbs(cmH, POSE.arm, POSE.leg, POSE.twist, POSE.fore);
    P = posed.P;
    const N = normals(P);

    // 씬
    const scene = new THREE.Scene();
    const s = (FLOOR - TOP) / m.H; // 1cm당 px
    const cam = new THREE.OrthographicCamera(-CW / 2 / s, CW / 2 / s, FLOOR / s, (FLOOR - CH) / s, 1, 1000);
    cam.position.set(0, 0, 400); cam.lookAt(0, 0, 0); cam.position.set(0, 0, 400);
    cam.updateProjectionMatrix();

    const skinT = data.tex['skin.jpg'];
    const want = face?.skin || hexRGB(pc?.skin?.hex || '#cf9f7c'); // 내 얼굴을 넣으면 몸 피부를 그 얼굴색에 맞춘다
    const tint = want.map((v, i) => Math.max(0.6, Math.min(1.35, v / data.skinAvg[i])));
    const skinMat = new THREE.MeshPhysicalMaterial({
      map: skinT, color: new THREE.Color(tint[0], tint[1], tint[2]).convertSRGBToLinear(),
      roughness: 0.63, metalness: 0, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.9, 0.45, 0.38), clearcoat: 0.05, clearcoatRoughness: 0.6,
      ...(POSE.pores ? { bumpMap: poreTex(), bumpScale: POSE.pores } : {}), // 모공 결: 매끈한 플라스틱 피부 대신 빛이 잘게 흩어지게
    });
    const body = new THREE.Mesh(geom(data.body.ref, data.body.uv, data.body.tris, P, N), skinMat);
    body.castShadow = body.receiveShadow = true;
    scene.add(body);
    // 속옷(드로즈): 피부 셰이더에서 원래 자세 좌표로 골반~허벅지 위를 천 색으로 칠한다(경계가 매끈하다)
    const rest = new Float32Array(data.body.ref.length * 3);
    for (let i = 0; i < data.body.ref.length; i++) for (let q = 0; q < 3; q++) rest[i * 3 + q] = cmP[data.body.ref[i] * 3 + q];
    body.geometry.setAttribute('restPos', new THREE.BufferAttribute(rest, 3));
    // 오목한 곳 그늘(눈두덩·콧방울 아래·입꼬리·턱 밑·겨드랑이·배꼽·손가락 사이): 이웃 평균으로 부드럽게 한 면이 법선 쪽으로 얼마나 떠 있나
    {
      const cav = cavity(P, N), ref = data.body.ref, a = new Float32Array(ref.length);
      for (let i = 0; i < ref.length; i++) a[i] = cav[ref[i]];
      body.geometry.setAttribute('cav', new THREE.BufferAttribute(a, 1));
    }
    const hipY = jpos(cmP, 'upperleg01.L____head')[1];
    let crotchY = -Infinity;
    for (const i of data.meta.crotch) if (Math.abs(cmP[i * 3]) < 1) crotchY = Math.max(crotchY, cmP[i * 3 + 1]);
    const briefU = { uTop: { value: hipY + 7.5 }, uBot: { value: crotchY - 7 }, uHalf: { value: GarmentRender.visW(m.hip, 'hip') / 2 + 4 }, uCav: { value: POSE.cav } };
    // 3D 옷을 입혔을 때 옷 밑 몸 숨기기(dress()가 값을 바꾼다): 덮는 정점(aCov)이면서 옷이 남은 자리
    Object.assign(briefU, { uTopOn: { value: 0 }, uBotOn: { value: 0 }, uHem: { value: -1e3 }, uSleeve: { value: -1 }, uWaist: { value: -1e3 }, uPHem: { value: 1e3 }, uHemM: { value: -1e3 }, uSleeveM: { value: 100 }, uWaistM: { value: 1e3 }, uPHemM: { value: -1e3 }, uZc: { value: 0 }, ...clothArmUniforms(cmP) });
    body.geometry.setAttribute('aCov', new THREE.BufferAttribute(new Float32Array(data.body.ref.length * 2), 2));
    skinMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, briefU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 restPos;\nattribute float hairOcc;\nattribute float cav;\nattribute vec2 aCov;\nvarying vec3 vRest;\nvarying float vHairOcc;\nvarying float vCav;\nvarying vec2 vCov;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = restPos;\nvHairOcc = hairOcc;\nvCav = cav;\nvCov = aCov;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vRest;\nvarying float vHairOcc;\nvarying float vCav;\nvarying vec2 vCov;\nuniform float uTop, uBot, uHalf, uCav;\nfloat briefM;\n' + CLOTH_GLSL)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          {
            if (uTopOn > 0.5 && vCov.x > 0.99) discard;
            if (uBotOn > 0.5 && vCov.y > 0.99) discard;
          }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          diffuseColor.rgb *= (1.0 - 0.4 * vHairOcc) * (1.0 - uCav * vCav) ; // 앞머리 아래 그늘 · 오목한 곳 그늘(따뜻한 쪽으로)
          diffuseColor.r += uCav * vCav * 0.04;
          {
            float e = max(fwidth(vRest.y), 0.05);
            float ax = abs(vRest.x);
            float bot = uBot + 1.6 * (1.0 - clamp(ax / (uHalf * 0.55), 0.0, 1.0)); // 안쪽 허벅지에서 살짝 올라간 다리 트임
            float top = uTop - 0.6 * (1.0 - clamp(ax / uHalf, 0.0, 1.0));          // 앞 가운데가 살짝 낮다
            if (uBotOn > 0.5) top = min(top, uWaist - 0.8); // 바지를 입으면 속옷 허리 밴드가 바지 위로 보이지 않게
            briefM = smoothstep(bot - e, bot + e, vRest.y) * (1.0 - smoothstep(top - e, top + e, vRest.y)) * (1.0 - step(uHalf, ax));
            vec3 fab = vec3(0.028, 0.032, 0.042);
            float band = smoothstep(top - 3.4 - e, top - 3.4 + e, vRest.y);
            fab = mix(fab, vec3(0.012, 0.013, 0.016), band);
            float stripe = band * (1.0 - smoothstep(0.12, 0.12 + e, abs(vRest.y - (top - 2.5))));
            fab = mix(fab, vec3(0.32, 0.33, 0.36), stripe);
            diffuseColor.rgb = mix(diffuseColor.rgb, fab, briefM);
          }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.92, briefM);')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.sheenColor *= 1.0 - briefM;\nmaterial.clearcoat *= 1.0 - briefM;');
    };
    const hairRGB = hexRGB(pc?.hair?.hex || '#1e1712');
    const headParts = [];
    const hairName = data.proxies.some((p) => p.name === POSE.hair) ? POSE.hair : 'short02';
    // 앞머리·옆머리 끝(이마 높이 아래)만 세로 가닥 노이즈로 알파를 깎아 성글게(텍스처 이음매가 있는 정수리는 건드리지 않는다)
    const eyeY = (jpos(P, 'eye.L____head')[1] + jpos(P, 'eye.R____head')[1]) / 2;
    const eyeZ = (jpos(P, 'eye.L____head')[2] + jpos(P, 'eye.R____head')[2]) / 2;
    const fringeU = { uFringe: { value: eyeY + POSE.fringe }, uFrontZ: { value: eyeZ } };
    const fringe = (m) => {
      m.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, fringeU);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nuniform float uFringe, uFrontZ;')
          .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
            {
              // 앞머리 끝: 눈썹을 따라 관자놀이 쪽이 1.2cm 높은 아치 + 낮은 주파수 굴곡, 7mm에 걸쳐 부드럽게 옅어진다(앞쪽 머리만)
              float ax = abs(vWP.x);
              float cut = uFringe + 0.9 * smoothstep(1.5, 6.5, ax) + 0.25 * sin(vWP.x * 1.3) + 0.15 * sin(vWP.x * 2.9 + 1.0);
              float front = smoothstep(uFrontZ - 5.0, uFrontZ - 0.5, vWP.z);
              diffuseColor.a *= mix(1.0, smoothstep(cut - 0.7, cut + 0.05, vWP.y), front);
            }`);
      };
      m.customProgramCacheKey = () => 'hair-fringe-' + (m.transparent ? 't' : 'o');
      return m;
    };
    for (const p of data.proxies) {
      if (p.kind === 'hair' && p.name !== hairName) continue;
      const PP = proxyPos(p, P, p.kind === 'hair' ? POSE.hairThick : 1); // 머리카락은 두피에 더 붙여 헬멧처럼 부풀지 않게
      if (p.kind === 'brow' && POSE.browThick !== 1) {
        // 눈썹 메시가 얇아 가는 선처럼 보인다: 좌우 눈썹 각각 가운데 높이를 기준으로 위아래로 늘린다(아치 모양은 거의 그대로)
        for (const sd of [1, -1]) {
          const ids = [];
          for (let i = 0; i < PP.length; i += 3) if (PP[i] * sd > 0) ids.push(i);
          // x 위치별 가운데 높이(아치)를 따라 늘려야 아치가 과장되지 않는다: x를 8칸으로 나눠 칸마다 평균 y
          let x0 = Infinity, x1 = -Infinity;
          for (const i of ids) { x0 = Math.min(x0, PP[i]); x1 = Math.max(x1, PP[i]); }
          const B = 8, sum = new Float64Array(B), cnt = new Float64Array(B);
          const bin = (x) => Math.min(B - 1, Math.floor(((x - x0) / Math.max(1e-6, x1 - x0)) * B));
          for (const i of ids) { const b = bin(PP[i]); sum[b] += PP[i + 1]; cnt[b]++; }
          for (const i of ids) { const b = bin(PP[i]); const cy = sum[b] / Math.max(1, cnt[b]); PP[i + 1] = cy + (PP[i + 1] - cy) * POSE.browThick; }
        }
      }
      if (p.kind === 'shoes') {
        // 양말 윗단: 뒤쪽이 솟은 톱니(노치)를 한 높이로 고르게(발마다 윗단 높이에서 0.8cm 아래로 자른다)
        for (const sd of [1, -1]) {
          let top = -Infinity;
          for (let i = 0; i < PP.length; i += 3) if (PP[i] * sd > 0) top = Math.max(top, PP[i + 1]);
          const cut = top - 0.8;
          for (let i = 0; i < PP.length; i += 3) if (PP[i] * sd > 0 && PP[i + 1] > cut) PP[i + 1] = cut + (PP[i + 1] - cut) * 0.15;
        }
      }
      let tris = p.tris;
      if (p.kind === 'lash') {
        // 아래 속눈썹은 빼기: 낮은 눈꺼풀 아래로 흰자 사이에 가시처럼 늘어져 보인다
        const eyeY = (jpos(P, 'eye.L____head')[1] + jpos(P, 'eye.R____head')[1]) / 2;
        const keep = [];
        for (let i = 0; i < tris.length; i += 3) {
          const y = (PP[p.ref[tris[i]] * 3 + 1] + PP[p.ref[tris[i + 1]] * 3 + 1] + PP[p.ref[tris[i + 2]] * 3 + 1]) / 3;
          if (y > eyeY) keep.push(tris[i], tris[i + 1], tris[i + 2]);
        }
        tris = new Uint32Array(keep);
      }
      const g = geom(p.ref, p.uv, tris, PP, null);
      if (p.kind === 'hair') body.geometry.setAttribute('hairOcc', new THREE.BufferAttribute(hairShade(PP, P), 1));
      let mat;
      if (p.kind === 'hair') {
        const ht = hairRGB.map((v, i) => Math.max(0.05, Math.min(2.5, v / Math.max(8, data.hairAvg[p.name][i]))));
        mat = new THREE.MeshPhysicalMaterial({ map: data.tex[p.tex], ...(p.name === 'short02' && POSE.hairNormal ? { normalMap: data.tex['hair_n.jpg'], normalScale: new THREE.Vector2(POSE.hairNormal, POSE.hairNormal) } : {}), ...(POSE.hairBump ? { bumpMap: strandTex(), bumpScale: POSE.hairBump } : {}), color: new THREE.Color(ht[0], ht[1], ht[2]).convertSRGBToLinear(), roughness: 0.62, specularIntensity: 0.35, sheen: 0.35, sheenRoughness: 0.4, sheenColor: new THREE.Color(0.4, 0.32, 0.26), alphaTest: 0.55, alphaToCoverage: true, side: THREE.DoubleSide });
        fringe(mat);
      } else if (p.kind === 'brow' || p.kind === 'lash') {
        mat = new THREE.MeshStandardMaterial({ map: data.tex[p.tex], color: p.kind === 'brow' ? new THREE.Color(Math.min(1, hairRGB[0] / 255 * 1.5), Math.min(1, hairRGB[1] / 255 * 1.5), Math.min(1, hairRGB[2] / 255 * 1.5)).convertSRGBToLinear() : new THREE.Color(0.06, 0.05, 0.045), roughness: 0.8, ...(p.kind === 'lash' && POSE.lashOpaque ? { alphaTest: 0.4 } : { transparent: true, opacity: p.kind === 'brow' ? 0.78 : 1, alphaTest: 0.05, depthWrite: false }), side: THREE.DoubleSide });
      } else if (p.kind === 'eye') {
        mat = new THREE.MeshPhysicalMaterial({ map: data.tex[p.tex], roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.8, transparent: true, alphaTest: 0.02 }); // 소프트박스가 눈에 비친 반짝임
      } else {
        mat = new THREE.MeshStandardMaterial({ map: data.tex[p.tex], roughness: 0.7, emissive: new THREE.Color(0.05, 0.05, 0.05) }); // 신발 밑면이 새까만 띠로 보이지 않게
      }
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = p.kind === 'hair' || p.kind === 'shoes';
      mesh.receiveShadow = true;
      mesh.userData.kind = p.kind;
      mesh.renderOrder = p.kind === 'brow' || p.kind === 'lash' ? 2 : 1;
      if (POSE.hide?.includes(p.kind)) mesh.visible = false; // 개발용
      scene.add(mesh);
      if (p.kind !== 'shoes') headParts.push(mesh);
      if (p.kind === 'hair') {
        // 머리카락 끝(반투명한 가닥)은 섞어 그려 앞머리 끝이 톱니처럼 잘리지 않고 가늘게 흩어지게
        const soft = new THREE.Mesh(g, fringe(Object.assign(mat.clone(), { alphaTest: 0.04, transparent: true, depthWrite: false, alphaToCoverage: false })));
        soft.userData.kind = 'hair'; soft.renderOrder = 3; soft.receiveShadow = true;
        scene.add(soft); headParts.push(soft);
        // 털 껍질: 머리카락 겉에 가닥 무늬로 듬성듬성 뚫린 얇은 막을 몇 겹 씌워 윤곽이 매끈한 덩어리(헬멧)가 아니라 보송하게
        if (POSE.hairShells > 0) {
          g.computeVertexNormals();
          const pos = g.attributes.position.array, nor = g.attributes.normal.array;
          for (let k = 1; k <= POSE.hairShells; k++) {
            const off = k * POSE.hairShellGap;
            const gk = g.clone(), pk = gk.attributes.position.array;
            for (let i = 0; i < pk.length; i++) pk[i] = pos[i] + nor[i] * off;
            gk.attributes.position.needsUpdate = true;
            const mk = fringe(Object.assign(mat.clone(), { alphaMap: strandTex(), alphaTest: 0.3 + 0.12 * k, transparent: false, alphaToCoverage: true }));
            mk.color = mat.color.clone().multiplyScalar(1 + 0.08 * k); // 바깥 가닥이 빛을 조금 더 받는다
            const sh = new THREE.Mesh(gk, mk);
            sh.userData.kind = 'hair'; sh.renderOrder = 1; sh.receiveShadow = true;
            scene.add(sh); headParts.push(sh);
          }
        }
      }
    }

    // 내 얼굴을 넣으면 3D 눈썹·속눈썹·눈은 숨긴다(사진 얼굴이 덮는다). 3D 머리카락은 남겨 사진이 못 덮은 정수리를 채운다
    if (face?.img) {
      for (const o of scene.children) if (o.isMesh && ['brow', 'lash', 'eye'].includes(o.userData.kind)) o.visible = false;
      for (let i = headParts.length - 1; i >= 0; i--) if (!headParts[i].visible) headParts.splice(i, 1);
    }
    // 조명: 왼쪽 위 앞 주광(그림자) + 오른쪽 보조광 + 뒤 윤곽광 + 하늘/바닥 반사
    scene.add(new THREE.HemisphereLight(0xfff6ee, 0x6a5a52, 0.18));
    const key = new THREE.DirectionalLight(0xfff1e4, LIGHT.key);
    key.position.set(-110, 230, 480); key.castShadow = true; // 왼쪽 위 앞: 코 반대편·광대 아래에 부드러운 그늘
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -60, right: 60, top: 200, bottom: -10, near: 10, far: 900 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.6; key.shadow.radius = 18; key.shadow.blurSamples = 24;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8eeff, LIGHT.fill); fill.position.set(200, 80, 200); scene.add(fill);
    // 윤곽광 두 개(뒤 양옆): 어깨·팔·머리 가장자리에 얇은 빛 테두리 → 배경과 분리
    const rim = new THREE.DirectionalLight(0xffffff, LIGHT.rim); rim.position.set(160, 140, -250); scene.add(rim);
    const rim2 = new THREE.DirectionalLight(0xfff4ea, LIGHT.rim2); rim2.position.set(-170, 120, -240); scene.add(rim2);

    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap; // 부드러운 그림자(손·턱 그림자 가장자리)
    }
    renderer.setPixelRatio(1);
    renderer.setSize(CW * SS, CH * SS, false);
    // 스튜디오 반사광(환경 조명): 회색 방 + 소프트박스 3개를 미리 구워 피부·머리카락에 부드러운 빛과 반사를 준다
    if (!studioEnv) studioEnv = makeStudio();
    scene.environment = studioEnv;
    scene.environmentIntensity = LIGHT.env;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = LIGHT.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const shot = () => {
      renderer.render(scene, cam);
      const c = document.createElement('canvas'); c.width = CW; c.height = CH;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(renderer.domElement, 0, 0, CW, CH);
      return c;
    };
    const full = shot();
    // 옷 명암 지도: 흰 석고 몸을 같은 조명으로 그려 밝기만 얻는다(옷 입히기 엔진의 depthShade와 같은 형식, 128 = 그대로)
    let shadeMap = null;
    {
      const vis = scene.children.filter((o) => o.isMesh).map((o) => [o, o.visible]);
      vis.forEach(([o]) => { o.visible = o === body; });
      const plaster = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
      body.material = plaster;
      renderer.toneMapping = THREE.NoToneMapping;
      const lit = shot();
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      body.material = skinMat; plaster.dispose();
      vis.forEach(([o, v]) => { o.visible = v; });
      const S2 = 160, H2 = 320; // 작게 줄여(잔굴곡 없애기) 밝기 평균에서 벗어난 만큼
      const t2 = document.createElement('canvas'); t2.width = S2; t2.height = H2;
      const g2 = t2.getContext('2d', { willReadFrequently: true });
      g2.drawImage(lit, 0, 0, S2, H2);
      const d2 = g2.getImageData(0, 0, S2, H2), px = d2.data;
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200) { sum += px[i]; n++; }
      const avg = sum / Math.max(1, n);
      // 몸 가장자리 3칸(옷이 덮고 넘어가는 곳)과 다리 사이는 빼고 몸 안쪽의 굴곡만(옷에 몸 윤곽이 찍히지 않게)
      const inside = (x, y) => x >= 0 && y >= 0 && x < S2 && y < H2 && px[(y * S2 + x) * 4 + 3] > 200;
      const vals = new Float32Array(S2 * H2);
      for (let y = 0; y < H2; y++) for (let x = 0; x < S2; x++) {
        let ok = true;
        for (let d = -3; d <= 3 && ok; d++) ok = inside(x + d, y) && inside(x, y + d);
        vals[y * S2 + x] = ok ? 128 + Math.max(-30, Math.min(26, (px[(y * S2 + x) * 4] - avg) * 0.7)) : 128;
      }
      for (let i = 0; i < vals.length; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = vals[i]; px[i * 4 + 3] = 255; }
      g2.putImageData(d2, 0, 0);
      shadeMap = document.createElement('canvas'); shadeMap.width = CW; shadeMap.height = CH;
      const sg = shadeMap.getContext('2d'); sg.imageSmoothingQuality = 'high';
      sg.fillStyle = '#808080'; sg.fillRect(0, 0, CW, CH); sg.filter = 'blur(9px)'; sg.drawImage(t2, 0, 0, CW, CH); sg.filter = 'none';
    }
    // 머리 층(옷 위에 다시 얹는 얼굴·머리카락·목 위쪽): 몸에서 머리 가중치가 큰 면만
    const headTris = [];
    const bt = data.body.tris, br = data.body.ref, hw = data.w.head;
    for (let i = 0; i < bt.length; i += 3) if (hw[br[bt[i]]] > 150 && hw[br[bt[i + 1]]] > 150 && hw[br[bt[i + 2]]] > 150) headTris.push(bt[i], bt[i + 1], bt[i + 2]);
    const headMesh = new THREE.Mesh(body.geometry.clone().setIndex(headTris), skinMat);
    headMesh.receiveShadow = true;
    const keep = scene.children.filter((o) => o.isMesh);
    const keepVis = new Map(keep.map((o) => [o, o.visible]));
    keep.forEach((o) => { o.visible = headParts.includes(o); });
    scene.add(headMesh);
    // 머리카락이 목 뒤로 가려지게: 몸은 깊이만 쓴다
    const occ = new THREE.Mesh(body.geometry, new THREE.MeshBasicMaterial({ colorWrite: false }));
    occ.renderOrder = -1; scene.add(occ);
    const head = shot();
    // 장면 분할: 1 머리카락(눈썹 포함), 2 몸, 3 얼굴
    occ.visible = false;
    keep.forEach((o) => { o.visible = keepVis.get(o); });
    const flat = (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide });
    const saved = new Map();
    for (const o of [...keep, headMesh]) {
      saved.set(o, o.material);
      const kind = o.userData.kind;
      o.material = o === headMesh ? flat(0x00ff00) : kind === 'hair' || kind === 'brow' ? Object.assign(flat(0xff0000), { map: o.material.map, alphaTest: 0.35, transparent: false }) : kind === 'eye' || kind === 'lash' ? flat(0x00ff00) : flat(0x0000ff);
    }
    headMesh.position.z = 0.05;
    renderer.toneMapping = THREE.NoToneMapping;
    scene.children.filter((o) => o.isLight).forEach((l) => { l.visible = false; });
    const idc = shot();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    for (const [o, mt] of saved) { o.material.dispose(); o.material = mt; }
    scene.remove(headMesh, occ);
    // 팔·손만 있는 층(옷 위에 다시 얹는 손): 손 둘레 원통으로 오리면 손 옆의 속옷·허벅지까지 옷 위로 올라온다
    let armsSkin = null;
    {
      const armTris = [], wa = data.w.armL, wb = data.w.armR;
      const isArm = (k) => wa[br[k]] + wb[br[k]] > 100;
      for (let i = 0; i < bt.length; i += 3) if (isArm(bt[i]) && isArm(bt[i + 1]) && isArm(bt[i + 2])) armTris.push(bt[i], bt[i + 1], bt[i + 2]);
      const armMesh = new THREE.Mesh(body.geometry.clone().setIndex(armTris), Object.assign(flat(0xffffff), { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
      const vis = scene.children.filter((o) => o.isMesh).map((o) => [o, o.visible]);
      vis.forEach(([o]) => { o.visible = o === body; });
      const bm = body.material; body.material = flat(0x000000);
      scene.add(armMesh);
      renderer.toneMapping = THREE.NoToneMapping;
      const am = shot();
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      scene.remove(armMesh); armMesh.material.dispose(); armMesh.geometry.dispose();
      body.material.dispose(); body.material = bm;
      vis.forEach(([o, v]) => { o.visible = v; });
      const ad = am.getContext('2d').getImageData(0, 0, CW, CH);
      const fd = full.getContext('2d').getImageData(0, 0, CW, CH);
      for (let i = 0; i < ad.data.length; i += 4) fd.data[i + 3] = Math.min(fd.data[i + 3], ad.data[i]);
      armsSkin = document.createElement('canvas'); armsSkin.width = CW; armsSkin.height = CH;
      armsSkin.getContext('2d').putImageData(fd, 0, 0);
    }

    // 내 얼굴 붙이기: 사진 얼굴 폭을 3D 얼굴 폭(광대 사이)에, 턱을 3D 턱에, 가운데를 몸 가운데에 맞춘다
    let facePaste = null;
    if (face?.img) {
      const toPxL = (x, y) => ({ x: CW / 2 + x * s, y: FLOOR - y * s });
      let chinY = Infinity, noseZ = -Infinity, noseY = 0;
      for (let i = 0; i < hw.length; i++) {
        if (hw[i] < 240) continue;
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        if (Math.abs(x) < 1.5 && z > 0 && y < chinY) chinY = y;
        if (Math.abs(x) < 1.5 && z > noseZ) { noseZ = z; noseY = y; }
      }
      // 광대 높이(코끝보다 살짝 위)에서 앞쪽(귀 빼고) 정점들의 좌우 폭
      let x0 = Infinity, x1 = -Infinity;
      for (let i = 0; i < hw.length; i++) {
        if (hw[i] < 240) continue;
        const y = P[i * 3 + 1], z = P[i * 3 + 2];
        if (Math.abs(y - (noseY + 1.5)) < 1.2 && z > noseZ - 7) { x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]); }
      }
      // 3D 턱 아래쪽 면을 그대로 두면 사진 턱선 밖으로 비친다: 얼굴 폭은 광대 폭, 턱은 3D 턱보다 0.3cm 아래
      const fw = (x1 - x0) * s;
      const k = (fw / Math.max(1, face.faceW)) * 1.04;
      const chin = toPxL(0, chinY - 0.3);
      facePaste = { k, x: CW / 2 - face.centerX * k, y: chin.y - face.chinY * k, eyeY: toPxL(0, noseY + 3.5).y, fw };
      for (const cv of [full, head]) cv.getContext('2d').drawImage(face.img, facePaste.x, facePaste.y, face.img.width * k, face.img.height * k);
    }

    // 바탕(스튜디오 회색 그라데이션 + 발밑 그림자) 위에 합치기
    const backdrop = (full) => {
    const canvas = document.createElement('canvas'); canvas.width = CW; canvas.height = CH;
    const c = canvas.getContext('2d');
    const bg = c.createLinearGradient(0, 0, 0, CH); bg.addColorStop(0, '#f2f0ed'); bg.addColorStop(1, '#dedad4');
    c.fillStyle = bg; c.fillRect(0, 0, CW, CH);
    // 스튜디오 조명처럼 사람 뒤가 밝고 가장자리로 갈수록 아주 조금 어둡게(인물이 배경에서 떠 보이게)
    const vg = c.createRadialGradient(CW / 2, CH * 0.42, CH * 0.12, CW / 2, CH * 0.42, CH * 0.75);
    vg.addColorStop(0, 'rgba(255,255,255,0.10)'); vg.addColorStop(1, 'rgba(60,50,40,0.10)');
    c.fillStyle = vg; c.fillRect(0, 0, CW, CH);
    const cx = CW / 2, fy = FLOOR + 2, rr = 24 * s;
    const fl = c.createRadialGradient(cx, fy, 0, cx, fy, rr);
    fl.addColorStop(0, 'rgba(0,0,0,0.28)'); fl.addColorStop(1, 'rgba(0,0,0,0)');
    c.save(); c.translate(cx, fy); c.scale(1, 0.13); c.translate(-cx, -fy); c.fillStyle = fl; c.beginPath(); c.arc(cx, fy, rr, 0, Math.PI * 2); c.fill(); c.restore();
    c.drawImage(full, 0, 0);
    return canvas;
    };
    const canvas = backdrop(full);
    const c = canvas.getContext('2d');
    const cx = CW / 2;

    // 분할 지도(반 해상도)
    const sw = CW / 2, sh = CH / 2;
    const t = document.createElement('canvas'); t.width = sw; t.height = sh;
    const tg = t.getContext('2d', { willReadFrequently: true }); tg.imageSmoothingEnabled = false; tg.drawImage(idc, 0, 0, sw, sh);
    const id = tg.getImageData(0, 0, sw, sh).data;
    const cat = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      const r = id[i * 4], gg = id[i * 4 + 1], b = id[i * 4 + 2];
      if (id[i * 4 + 3] < 128) continue;
      cat[i] = r > gg && r > b ? 1 : gg > b ? 3 : 2;
    }
    if (facePaste) {
      const fc = document.createElement('canvas'); fc.width = sw; fc.height = sh;
      const fg = fc.getContext('2d', { willReadFrequently: true });
      fg.drawImage(face.img, facePaste.x / 2, facePaste.y / 2, face.img.width * facePaste.k / 2, face.img.height * facePaste.k / 2);
      const fa = fg.getImageData(0, 0, sw, sh).data;
      const hairRow = (facePaste.eyeY - facePaste.fw * 0.32) / 2; // 대략 눈썹 위는 머리카락
      for (let i = 0; i < sw * sh; i++) if (fa[i * 4 + 3] > 127) cat[i] = Math.floor(i / sw) < hairRow ? 1 : 3;
    }
    // 피부색(가슴 가운데 평균)
    const chestPx = c.getImageData(cx - 4 * s, toPy(jpos(P, 'breast.L____head')[1] + 4), 8 * s, 6 * s).data;
    const skinColor = [0, 0, 0]; let sn = 0;
    for (let i = 0; i < chestPx.length; i += 4) { skinColor[0] += chestPx[i]; skinColor[1] += chestPx[i + 1]; skinColor[2] += chestPx[i + 2]; sn++; }
    skinColor.forEach((_, i) => { skinColor[i] /= sn; });
    function toPx(p) { return { x: cx + p[0] * s, y: FLOOR - p[1] * s }; }
    function toPy(y) { return FLOOR - y * s; }

    // 관절 좌표(MediaPipe 33점 순서, 0~1). 11 = 사람의 왼쪽 어깨(화면 오른쪽, MakeHuman L)
    const J = (name, part) => { let p = jpos(P0(), name); if (part) p = posed.rot[part](p); return toPx(p); };
    const cmCache = cmH;
    function P0() { return cmCache; }
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
    const set = (i, p) => { lm[i] = { x: p.x / CW, y: p.y / CH, visibility: 1 }; };
    const eL = J('eye.L____head'), eR = J('eye.R____head');
    // 코끝: 머리에서 가장 앞으로 나온 정점
    let nose = null, nz = -Infinity;
    for (let i = 0; i < hw.length; i++) if (hw[i] > 240 && P[i * 3 + 2] > nz && Math.abs(P[i * 3]) < 2) { nz = P[i * 3 + 2]; nose = [P[i * 3], P[i * 3 + 1]]; }
    const noseP = nose ? toPx(nose) : { x: cx, y: (eL.y + eR.y) / 2 + 4 * s };
    set(0, noseP);
    const ex = Math.abs(eL.x - eR.x) / 2;
    set(1, { x: eL.x - ex * 0.3, y: eL.y }); set(2, eL); set(3, { x: eL.x + ex * 0.3, y: eL.y });
    set(4, { x: eR.x + ex * 0.3, y: eR.y }); set(5, eR); set(6, { x: eR.x - ex * 0.3, y: eR.y });
    set(7, { x: eL.x + ex * 1.3, y: eL.y + 1.5 * s }); set(8, { x: eR.x - ex * 1.3, y: eR.y + 1.5 * s });
    set(9, { x: noseP.x + 2 * s, y: noseP.y + 3 * s }); set(10, { x: noseP.x - 2 * s, y: noseP.y + 3 * s });
    // 어깨: MakeHuman 관절은 뼈 속 중심이라 사진 인식(MediaPipe)의 어깨점보다 3cm쯤 낮다 → 사진과 같은 기준으로 올린다
    const up3 = (q) => ({ x: q.x, y: q.y - 3 * s });
    set(11, up3(J('upperarm01.L____head'))); set(12, up3(J('upperarm01.R____head')));
    set(13, J('lowerarm01.L____head', 'armL')); set(14, J('lowerarm01.R____head', 'armR'));
    set(15, J('wrist.L____head', 'foreL')); set(16, J('wrist.R____head', 'foreR'));
    set(17, J('finger5-3.L____tail', 'handL')); set(18, J('finger5-3.R____tail', 'handR'));
    set(19, J('finger2-3.L____tail', 'handL')); set(20, J('finger2-3.R____tail', 'handR'));
    set(21, J('finger1-3.L____tail', 'handL')); set(22, J('finger1-3.R____tail', 'handR'));
    set(23, J('upperleg01.L____head')); set(24, J('upperleg01.R____head'));
    set(25, J('lowerleg01.L____head', 'legL')); set(26, J('lowerleg01.R____head', 'legR'));
    const aL = J('foot.L____head', 'legL'), aR = J('foot.R____head', 'legR');
    set(27, aL); set(28, aR);
    set(29, { x: aL.x, y: FLOOR - 1.5 * s }); set(30, { x: aR.x, y: FLOOR - 1.5 * s });
    set(31, J('toe3-1.L____head', 'legL')); set(32, J('toe3-1.R____head', 'legR'));

    const sceneOut = {
      cat, w: sw, h: sh,
      skinColor, handColor: skinColor,
      head, skin: full, armsSkin, others: null, // armsSkin: 팔·손만(옷 위에 다시 얹을 때)
      illum: { rgb: [244, 242, 238], Y: 243 },
      tilt: -0.15, shadeK: 1,
      isAvatar: true,
      depthShade: shadeMap, // 3D 조명에서 얻은 옷 명암(AI 깊이 추정 대신)
    };
    const out = { canvas, pose: lm, pxPerCm: s, scene: sceneOut, poseCheck: { ok: true, issues: [] }, isAvatar: true, is3D: true, measures: m, fitted: meas, hasFace: !!face?.img };
    // 3D 옷 입히기(dress)에 쓸 장면 정보(열거되지 않게)
    Object.defineProperty(out, '_3d', { value: { scene, cam, body, briefU, P, cmP, s, face, facePaste, shot, backdrop, crotchY, hipY, m, cache: new Map() } });
    return out;
  }

  return { load, build, dress, garmentColor, fit, measure, morph, HAND_CURL, POSE, FACE, LIGHT };
})();

// 내 체형 탭의 아바타 카드를 3D로 바꿔 그리기(첫 화면을 막지 않게 한가할 때)
(window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => { if (typeof renderAvatarCard === 'function') renderAvatarCard(); });
