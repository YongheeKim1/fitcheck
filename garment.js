'use strict';

// 몸 위에 옷 모양을 그린다(사진 모드와 라이브 카메라 모드가 함께 쓴다).
// 이미지 생성 AI 없이, 관절 위치 + cm→px 비율 + 몸 치수 + 옷 실측만으로 크기와 위치를 계산한다.
//
// draw(ctx, opts)
//   lm:       MediaPipe Pose 33개 랜드마크(0~1 정규화)
//   W, H:     그릴 캔버스 크기(px)
//   mirror:   전면 카메라처럼 좌우 반전해서 보여 줄 때 true
//   pxPerCm:  1cm가 몇 px인지
//   body:     몸 치수(cm) { shoulder, chest, waist, hip, thigh } — 없으면 관절 간격으로 추정
//   category: 'top' | 'bottom'
//   g:        옷 실측(단면 cm, 어깨는 전체 너비)
//   color:    '#rrggbb'
//   stretch:  'none' | 'some' | 'high'
// 반환: { notes: [문장], ok: 그렸는지 }
(function (root) {
  // 타원 둘레 ÷ 폭: 몸 단면을 타원으로 보고 "둘레 → 정면에서 보이는 폭"으로 바꾸는 계수
  const ellipseRatio = (depthRatio) => {
    const a = 0.5, b = depthRatio / 2;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  };
  const FACTOR = { chest: ellipseRatio(0.7), waist: ellipseRatio(0.75), hip: ellipseRatio(0.75), leg: Math.PI };
  const visW = (circ, kind) => circ / FACTOR[kind];
  const STRETCH = { none: 0, some: 0.03, high: 0.06 }; // 늘어나는 정도(둘레 비율)

  // ---- 벡터 ----
  const V = (x, y) => ({ x, y });
  const add = (a, b) => V(a.x + b.x, a.y + b.y);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y);
  const mul = (a, k) => V(a.x * k, a.y * k);
  const len = (a) => Math.hypot(a.x, a.y);
  const norm = (a) => { const l = len(a) || 1; return V(a.x / l, a.y / l); };
  const mid = (a, b) => V((a.x + b.x) / 2, (a.y + b.y) / 2);
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpV = (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  // 꺾인 선(poly) 위에서 기준점 origin으로부터 u 방향 깊이가 D인 점(옷 옆선에서 같은 높이 찾기)
  function atDepth(poly, origin, u, D) {
    const dep = poly.map((p) => dot(sub(p, origin), u));
    if (D <= dep[0]) return poly[0];
    for (let i = 0; i < poly.length - 1; i++) {
      if (D <= dep[i + 1]) return lerpV(poly[i], poly[i + 1], (D - dep[i]) / ((dep[i + 1] - dep[i]) || 1));
    }
    return poly[poly.length - 1];
  }

  // 꺾인 선(poly)을 따라 total 길이만큼 걸어가며 n개 점과 진행 방향을 만든다.
  // 선보다 길면 마지막 방향으로 연장하되 floorY 아래로는 내려가지 않는다
  function walk(poly, total, n, floorY = Infinity) {
    const segs = [];
    let acc = 0;
    for (let i = 0; i < poly.length - 1; i++) {
      const l = len(sub(poly[i + 1], poly[i]));
      segs.push({ a: poly[i], b: poly[i + 1], l, start: acc });
      acc += l;
    }
    const out = [];
    for (let k = 0; k <= n; k++) {
      const d = (total * k) / n;
      let seg = segs.find((s) => d <= s.start + s.l) || segs[segs.length - 1];
      const t = seg.l ? (d - seg.start) / seg.l : 0;
      const dir = norm(sub(seg.b, seg.a));
      let p = add(seg.a, mul(sub(seg.b, seg.a), t));
      if (p.y > floorY) p = V(p.x, floorY);
      out.push({ p, dir, d });
    }
    return { pts: out, polyLen: acc };
  }

  // 길이 d 지점이 꺾인 선 위에서 시작점부터 얼마나 떨어져 있는지(호 길이)
  function arcTo(poly, target) {
    let acc = 0;
    for (let i = 0; i < poly.length - 1; i++) {
      if (poly[i + 1] === target) return acc + len(sub(poly[i + 1], poly[i]));
      acc += len(sub(poly[i + 1], poly[i]));
    }
    return acc;
  }

  // amt < 0 이면 어둡게, > 0 이면 밝게. '#rrggbb' → '#rrggbb'
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c : 255 - c) * amt)));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('');
  }

  // 관절 → 화면 좌표
  function points(lm, W, H, mirror) {
    return (i) => V((mirror ? 1 - lm[i].x : lm[i].x) * W, lm[i].y * H);
  }

  // 몸 치수가 없을 때 어깨 관절 간격으로 대략 추정(cm)
  // keys: 이 옷을 그리는 데 실제로 쓰는 치수(추정 안내는 이것만 대상으로)
  function bodyDims(body, shoulderJointCm, keys) {
    const j = shoulderJointCm;
    return {
      shoulder: body.shoulder ?? j + 7,
      chest: body.chest ?? j * 3.0,
      waist: body.waist ?? j * 2.6,
      hip: body.hip ?? j * 3.0,
      thigh: body.thigh ?? j * 1.75,
      estimated: keys.filter((k) => body[k] == null),
    };
  }

  // ---------- 칠하기: 평평한 도형이 아니라 천처럼 보이게 ----------
  //   1) 꼭짓점을 곡선으로 이어 부드러운 외곽
  //   2) 사진 속 명암(원래 입은 옷의 주름·그림자)을 새 옷 색에 겹쳐 입힌다(overlay)
  //   3) 옷 아래 부드러운 그림자로 몸 위에 얹힌 느낌
  let photo = null; // draw()가 옷을 그리기 전에 찍어 둔 화면(사진 또는 카메라 프레임)
  const canMakeCanvas = typeof document !== 'undefined';
  const bufs = {};
  function buf(name, w, h) {
    const c = bufs[name] || (bufs[name] = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  // 닫힌 꼭짓점 목록 → 부드러운 곡선: 각 변의 가운데를 지나고 꼭짓점을 조절점으로 쓴다
  function smoothPath(path, pts, closed = true) {
    const m = (a, b) => V((a.x + b.x) / 2, (a.y + b.y) / 2);
    const n = pts.length;
    if (!closed) {
      path.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n - 1; i++) {
        const q = m(pts[i], pts[i + 1]);
        path.quadraticCurveTo(pts[i].x, pts[i].y, q.x, q.y);
      }
      path.lineTo(pts[n - 1].x, pts[n - 1].y);
      return path;
    }
    const s0 = m(pts[n - 1], pts[0]);
    path.moveTo(s0.x, s0.y);
    for (let i = 0; i < n; i++) {
      const q = m(pts[i], pts[(i + 1) % n]);
      path.quadraticCurveTo(pts[i].x, pts[i].y, q.x, q.y);
    }
    path.closePath();
    return path;
  }

  // 사진 명암 지도: 줄인 사진에서 "주변보다 얼마나 어둡고 밝은지"만 남긴 회색 이미지(128 = 변화 없음).
  // 원래 입은 옷끼리의 큰 밝기 차이(흰 티 vs 진청 바지)는 지우고, 주름·그림자 같은 작은 명암만 새 옷에 옮긴다
  function shadingMap() {
    const W = photo.width, H = photo.height;
    const sw = Math.max(1, Math.min(360, Math.round(W / 2)));
    const sh = Math.max(1, Math.round((H * sw) / W));
    const c = buf('shade', sw, sh);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(photo, 0, 0, sw, sh);
    const img = g.getImageData(0, 0, sw, sh);
    const d = img.data;
    const lum = new Float32Array(sw * sh);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // 합계 테이블로 넓은 상자 흐림 → 원래 밝기의 "큰 흐름"
    const S = new Float64Array((sw + 1) * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let row = 0;
      for (let x = 0; x < sw; x++) {
        row += lum[y * sw + x];
        S[(y + 1) * (sw + 1) + x + 1] = S[y * (sw + 1) + x + 1] + row;
      }
    }
    const r = Math.max(3, Math.round(sw / 40));
    for (let y = 0; y < sh; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(sh, y + r + 1);
      for (let x = 0; x < sw; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(sw, x + r + 1);
        const area = (yb - ya) * (xb - xa);
        const blur = (S[yb * (sw + 1) + xb] - S[ya * (sw + 1) + xb] - S[yb * (sw + 1) + xa] + S[ya * (sw + 1) + xa]) / area;
        // 주름(주변보다 어두움)은 살리고, 밝은 쪽과 큰 경계는 약하게
        const v = 128 + Math.max(-45, Math.min(18, lum[y * sw + x] - blur)) * 1.4;
        const i = (y * sw + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function bbox(polys) {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const pts of polys) for (const p of pts) {
      b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y);
      b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
    }
    return b;
  }

  // polys를 color로 칠한다. from→to: 좌우 가장자리가 살짝 어두워지는 방향(몸통의 둥근 느낌)
  function fillShape(ctx, polys, color, from, to) {
    const canvasOk = canMakeCanvas && ctx.canvas && photo && typeof Path2D !== 'undefined';
    const dark = parseInt(color.slice(1, 3), 16) + parseInt(color.slice(3, 5), 16) + parseInt(color.slice(5, 7), 16) < 120;
    const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    grad.addColorStop(0, shade(color, -0.25));
    grad.addColorStop(0.5, dark ? shade(color, 0.1) : color); // 아주 어두운 색은 가운데를 살짝 띄워 입체감
    grad.addColorStop(1, shade(color, -0.25));

    if (!canvasOk) {
      // 테스트(Node) 등 캔버스를 만들 수 없는 환경: 단순 채우기
      ctx.save();
      ctx.fillStyle = grad;
      for (const pts of polys) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      return null;
    }

    const W = ctx.canvas.width, H = ctx.canvas.height;
    const path = new Path2D();
    for (const pts of polys) smoothPath(path, pts);

    const layer = buf('layer', W, H);
    const L = layer.getContext('2d');
    L.clearRect(0, 0, W, H);
    L.fillStyle = grad;
    L.fill(path);
    // 사진 명암 입히기(옷 안쪽만)
    L.save();
    L.clip(path);
    L.globalCompositeOperation = 'overlay';
    L.globalAlpha = dark ? 0.9 : 0.7;
    L.imageSmoothingEnabled = true;
    L.imageSmoothingQuality = 'high';
    L.drawImage(shadingMap(), 0, 0, W, H);
    L.restore();

    // 그림자를 깔고 사진 위에 얹기
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = Math.max(6, W / 110);
    ctx.shadowOffsetY = Math.max(2, W / 420);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    // 가는 외곽선
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = shade(color, -0.55);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, W / 650);
    ctx.stroke(path);
    ctx.restore();
    return path;
  }

  // ---------- 옷 사진 그대로 입히기(삼각형 조각 휘기) ----------
  // 원본 삼각형(s0,s1,s2)이 목표 삼각형(d0,d1,d2)으로 가도록 아핀 변환해서 그 조각만 그린다
  function affine(s0, s1, s2, d0, d1, d2) {
    const den = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(den) < 1e-6) return null;
    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
    const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / den;
    const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / den;
    return [a, b, c, d, e, f];
  }

  function drawTri(g, img, s, d) {
    const m = affine(s[0], s[1], s[2], d[0], d[1], d[2]);
    if (!m) return;
    // 조각 사이 틈(가는 선)이 보이지 않게 목표 삼각형을 무게중심에서 2px 키워서 자른다
    const cx = (d[0].x + d[1].x + d[2].x) / 3, cy = (d[0].y + d[1].y + d[2].y) / 3;
    g.save();
    g.beginPath();
    d.forEach((p, i) => {
      const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1;
      const q = V(p.x + (dx / l) * 2, p.y + (dy / l) * 2);
      if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y);
    });
    g.closePath();
    g.clip();
    g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    g.drawImage(img, 0, 0);
    g.restore();
  }

  // 띠(단면 목록) 두 개를 같은 개수로 맞춰 사각형 → 삼각형 두 개씩 휘어 붙인다
  function resample(rib, N) {
    if (rib.length === N) return rib;
    const out = [];
    for (let i = 0; i < N; i++) {
      const t = (i * (rib.length - 1)) / (N - 1);
      const k = Math.min(rib.length - 2, Math.floor(t)), f = t - k;
      const a = rib[k], b = rib[k + 1];
      out.push([V(a[0].x + (b[0].x - a[0].x) * f, a[0].y + (b[0].y - a[0].y) * f), V(a[1].x + (b[1].x - a[1].x) * f, a[1].y + (b[1].y - a[1].y) * f)]);
    }
    return out;
  }
  const byX = (pair) => (pair[0].x <= pair[1].x ? pair : [pair[1], pair[0]]);

  function drawRibbon(g, img, src, dst) {
    const N = Math.max(src.length, dst.length);
    const S = resample(src, N), D = resample(dst.map(byX), N);
    for (let i = 0; i < N - 1; i++) {
      drawTri(g, img, [S[i][0], S[i][1], S[i + 1][1]], [D[i][0], D[i][1], D[i + 1][1]]);
      drawTri(g, img, [S[i][0], S[i + 1][1], S[i + 1][0]], [D[i][0], D[i + 1][1], D[i + 1][0]]);
    }
  }

  // pairs: [{ src: 원본 띠, dst: 목표 띠 }]. 실측 크기로 휜 옷 사진에 내 사진 명암을 살짝 입히고 그림자와 함께 얹는다
  function paintTexture(ctx, img, pairs) {
    if (!(canMakeCanvas && ctx.canvas && photo)) return false;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const layer = buf('layer', W, H);
    const L = layer.getContext('2d');
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.clearRect(0, 0, W, H);
    L.imageSmoothingEnabled = true;
    L.imageSmoothingQuality = 'high';
    for (const { src, dst } of pairs) drawRibbon(L, img, src, dst);
    // 내 사진의 주름·그림자를 옷 모양 안에만 약하게
    const sh = buf('shade2', W, H);
    const S = sh.getContext('2d');
    S.globalCompositeOperation = 'source-over';
    S.clearRect(0, 0, W, H);
    S.imageSmoothingEnabled = true;
    S.drawImage(shadingMap(), 0, 0, W, H);
    S.globalCompositeOperation = 'destination-in';
    S.drawImage(layer, 0, 0);
    S.globalCompositeOperation = 'source-over';
    L.save();
    L.globalCompositeOperation = 'overlay';
    L.globalAlpha = 0.18; // 옷 사진에 이미 주름이 있으니 내 사진 명암은 아주 약하게
    L.drawImage(sh, 0, 0);
    L.restore();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = Math.max(6, W / 110);
    ctx.shadowOffsetY = Math.max(2, W / 420);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    return true;
  }

  // 봉제선·밴드 같은 디테일 선. dash가 있으면 스티치(점선)
  function line(ctx, pts, { color, width, alpha = 1, dash = null, smooth = true }) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    if (smooth && typeof Path2D !== 'undefined' && pts.length > 2) {
      ctx.stroke(smoothPath(new Path2D(), pts, false));
    } else {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  // 끼는 곳: 빨간 점선
  function markTight(ctx, a, b, lw) {
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = lw * 2;
    ctx.setLineDash([lw * 3, lw * 2]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  const cmText = (v) => `${Math.round(Math.abs(v))}cm`;

  // ---------------- 바지 ----------------
  function drawBottom(ctx, o) {
    const { pxPerCm: s, color } = o;
    const { g, guessed } = fillBottom(o.g);
    if (g.length == null || g.waist == null) {
      return { ok: false, notes: ['입혀 보려면 총장과 허리(또는 허벅지) 실측이 필요해요. 사이즈표 숫자를 확인해 주세요.'] };
    }
    const P = points(o.lm, o.W, o.H, o.mirror);
    const hipA = P(23), hipB = P(24);
    const hipMid = mid(hipA, hipB);
    const kneeMid = mid(P(25), P(26));
    const shMid = mid(P(11), P(12));
    const u = norm(sub(kneeMid, hipMid));            // 다리 방향(아래)
    const n = norm(sub(hipB, hipA));                 // 몸 가로 방향
    const thighLen = len(sub(kneeMid, hipMid));
    const lw = Math.max(1.5, o.W / 400);
    const body = bodyDims(o.body, len(sub(P(11), P(12))) / s, ['waist', 'hip', 'thigh']);
    const give = 1 + STRETCH[o.stretch || 'none'];
    const notes = [];

    const C = add(hipMid, mul(u, thighLen * 0.1));   // 가랑이
    const T = sub(C, mul(u, g.rise * s));            // 허리 밴드 위
    const Hl = sub(C, mul(u, g.rise * s * 0.35));    // 엉덩이 높이
    const gHip = g.hip ?? (g.waist + g.thigh) / 1.5;
    const wW = Math.max(visW(2 * g.waist, 'waist'), visW(body.waist, 'waist')) * s;
    const hW = Math.max(visW(2 * gHip, 'hip'), visW(body.hip, 'hip')) * s;

    const legs = [[23, 25, 27, 29, 31], [24, 26, 28, 30, 32]].map((ids) => {
      const [h, k, a, heel, foot] = ids.map(P);
      const side = Math.sign(dot(sub(h, hipMid), n)) || 1;
      const twG = visW(2 * g.thigh, 'leg') * s;
      const twB = visW(body.thigh, 'leg') * s;
      const tw = Math.max(twG, twB);
      const start = add(C, mul(n, (side * tw) / 2));
      const floorY = Math.max(heel.y, foot.y);
      const poly = [start, k, a, V(a.x, floorY)];
      const L = (g.length - g.rise) * s;
      const { pts, polyLen } = walk(poly, L, 24, floorY);
      const hemG = visW(2 * (g.hem ?? g.thigh * 0.6), 'leg') * s;
      const kneeAt = arcTo(poly, k) / polyLen;
      const ankleAt = arcTo(poly, a);
      const bodyW = (d) => {
        const t = d / polyLen;
        if (t <= kneeAt) return lerp(twB, twB * 0.62, t / kneeAt);
        return lerp(twB * 0.62, 9 * s, Math.min(1, (t - kneeAt) / (1 - kneeAt)));
      };
      const outer = [];
      const inner = [];
      pts.forEach(({ p, dir, d }) => {
        let nl = V(-dir.y, dir.x);
        if (dot(nl, n) < 0) nl = mul(nl, -1);       // n과 같은 쪽을 향하게
        const w = Math.max(lerp(twG, hemG, d / L), bodyW(d)) / 2;
        outer.push(add(p, mul(nl, side * w)));
        inner.push(sub(p, mul(nl, side * w)));
      });
      return { side, outer, inner, L, polyLen, ankleAt, tight: 2 * g.thigh * give < body.thigh, twB, start };
    }).sort((a, b) => b.side - a.side); // +쪽 다리 먼저

    const [pos, neg] = legs;
    const poly = [
      add(T, mul(n, wW / 2)), add(Hl, mul(n, hW / 2)),
      ...pos.outer, ...pos.inner.slice().reverse(), C,
      ...neg.inner, ...neg.outer.slice().reverse(),
      sub(Hl, mul(n, hW / 2)), sub(T, mul(n, wW / 2)),
    ];
    const tex = o.texture && o.texture.category === 'bottom' ? o.texture : null;
    if (tex) {
      // 허리 띠: 허리 밴드 위(T) → 엉덩이(Hl) → 가랑이(C) 7칸 + 다리 두 개(garmentsource.js의 원본 띠와 같은 구성)
      const sidePoly = (leg, sd) => [add(T, mul(n, (sd * wW) / 2)), add(Hl, mul(n, (sd * hW) / 2)), leg.outer[0]];
      const dst = [];
      const dC = dot(sub(C, T), u);
      for (let k = 0; k <= 6; k++) {
        const D = dC * (k / 6);
        dst.push([atDepth(sidePoly(neg, -1), T, u, D), atDepth(sidePoly(pos, 1), T, u, D)]);
      }
      const pairs = [{ src: tex.ribbons.waist, dst }];
      const targets = legs.slice().sort((a, b) => a.start.x - b.start.x);
      targets.forEach((leg, i) => {
        const srcLeg = tex.ribbons.legs?.[i];
        if (srcLeg) pairs.push({ src: srcLeg.ribbon, dst: leg.outer.map((p, j) => [p, leg.inner[j]]) });
      });
      paintTexture(ctx, tex.texture, pairs);
    } else {
      fillShape(ctx, [poly], color, sub(Hl, mul(n, hW / 2)), add(Hl, mul(n, hW / 2)));
    }

    // ---- 디테일(단색 도식일 때만) ----
    if (!tex) {
      const seamC = shade(color, -0.5);                 // 봉제선(어두운 선)
      const stitchC = shade(color, 0.35);               // 스티치(밝은 점선)
      const thin = Math.max(1, lw * 0.6);
      const stitchDash = [lw * 1.6, lw * 1.2];
      // 다리 안쪽 솔기선: 다리를 붙이고 서도 두 다리가 구분되게
      for (const leg of legs) line(ctx, [C, ...leg.inner], { color: seamC, width: thin, alpha: 0.7 });
      // 앞 중심선과 지퍼 스티치(J자)
      const bandH = 4 * s;
      const flyTop = add(T, mul(u, bandH));
      const flyEnd = sub(C, mul(u, g.rise * s * 0.28));
      line(ctx, [flyTop, sub(C, mul(u, 2 * s))], { color: seamC, width: thin, alpha: 0.6, smooth: false });
      line(ctx, [add(flyTop, mul(n, 3.2 * s)), add(flyEnd, mul(n, 3.2 * s)), add(flyEnd, mul(n, 0.5 * s))],
        { color: stitchC, width: thin, alpha: 0.6, dash: stitchDash });
      // 앞주머니: 허리 옆에서 엉덩이 옆으로 내려가는 곡선
      for (const sd of [-1, 1]) {
        const a = add(T, mul(n, sd * (wW / 2 - 4.5 * s)));
        const b = add(add(Hl, mul(n, sd * (hW / 2 - 0.5 * s))), mul(u, -1 * s));
        const ctrl = add(add(T, mul(n, sd * (wW / 2 - 4 * s))), mul(u, g.rise * s * 0.45));
        line(ctx, [add(a, mul(u, bandH)), ctrl, b], { color: seamC, width: thin, alpha: 0.55 });
    }
    // 바지 주름(다리 가운데 세로선): 아주 옅게
    for (const leg of legs) {
      const centers = leg.outer.map((p, i) => mid(p, leg.inner[i]));
      line(ctx, centers.slice(2, -2), { color: shade(color, 0.3), width: lw * 0.9, alpha: 0.18 });
      // 밑단 스티치
      const k = leg.outer.length - 2;
      line(ctx, [leg.outer[k], leg.inner[k]], { color: stitchC, width: thin, alpha: 0.5, dash: stitchDash, smooth: false });
    }

    // 허리 밴드 + 벨트 고리
    const band = mul(u, bandH);
    const wl = sub(T, mul(n, wW / 2)), wr = add(T, mul(n, wW / 2));
    fillShape(ctx, [[wl, wr, add(wr, band), add(wl, band)]], shade(color, -0.12), wl, wr);
    line(ctx, [add(wl, mul(u, bandH * 0.82)), add(wr, mul(u, bandH * 0.82))], { color: stitchC, width: thin, alpha: 0.5, dash: stitchDash, smooth: false });
    for (const f of [-0.42, -0.18, 0.18, 0.42]) {
      const c0 = add(T, mul(n, wW * f));
      line(ctx, [sub(c0, mul(u, 0.4 * s)), add(c0, mul(u, bandH + 0.6 * s))], { color: shade(color, -0.3), width: 1.1 * s, alpha: 0.9, smooth: false });
    }
    }

    // 끼는 곳 표시
    if (2 * g.waist * give < body.waist) {
      markTight(ctx, sub(T, mul(n, wW / 2)), add(T, mul(n, wW / 2)), lw);
      notes.push(`허리가 몸보다 ${cmText(body.waist - 2 * g.waist)} 작아요.`);
    }
    if (2 * gHip * give < body.hip) {
      markTight(ctx, sub(Hl, mul(n, hW / 2)), add(Hl, mul(n, hW / 2)), lw);
      notes.push(`엉덩이가 몸보다 ${cmText(body.hip - 2 * gHip)} 작아요.`);
    }
    if (pos.tight) {
      for (const leg of legs) markTight(ctx, leg.outer[1], leg.inner[1], lw);
      notes.push(`허벅지가 몸보다 ${cmText(body.thigh - 2 * g.thigh)} 작아요.`);
    }

    // 밑단 위치
    const leg = pos;
    const overAnkle = (leg.L - leg.ankleAt) / s;
    const overFloor = (leg.L - leg.polyLen) / s;
    if (overFloor > 1) notes.push(`밑단이 바닥에 닿아 약 ${cmText(overFloor)} 접혀요.`);
    else if (overAnkle >= 0) notes.push(`밑단이 복숭아뼈보다 약 ${cmText(overAnkle)} 아래로 내려와요.`);
    else notes.push(`밑단이 복숭아뼈보다 약 ${cmText(overAnkle)} 위에 와요(발목이 보여요).`);

    // 허리선 높이: 골반 관절~어깨 거리 대비
    const torso = len(sub(hipMid, shMid));
    const above = dot(sub(hipMid, T), u) / torso;
    notes.push(above > 0.3 ? '허리선이 자연 허리 근처까지 올라와요(하이라이즈).'
      : above > 0.15 ? '허리선이 골반 위에 걸쳐요(미드라이즈).' : '허리선이 골반 아래에 걸쳐요(로우라이즈).');

    if (body.estimated.length) notes.push('몸 치수 일부를 관절 간격으로 추정했어요. 내 체형에 치수를 넣으면 더 정확해요.');
    if (guessed.length) notes.push(`사이즈표에 ${guessed.join('·')} 실측이 없어서 다른 치수로 추정해 그렸어요.`);
    return { ok: true, notes };
  }

  // ---------------- 상의 ----------------
  // 쇼핑몰 실측표에 어깨(래글런·드롭)나 가슴이 빠진 경우가 많아서, 하나만 있으면 다른 하나를 추정한다
  // (보통 상의는 가슴 단면이 어깨너비의 약 1.18배)
  function fillTop(g0) {
    const g = { ...g0 };
    const guessed = [];
    if (g.chest == null && g.shoulder != null) { g.chest = Math.round(g.shoulder * 1.18 * 10) / 10; guessed.push('가슴'); }
    if (g.shoulder == null && g.chest != null) { g.shoulder = Math.round((g.chest / 1.18) * 10) / 10; guessed.push('어깨'); }
    return { g, guessed };
  }

  function fillBottom(g0) {
    const g = { ...g0 };
    const guessed = [];
    if (g.thigh == null && g.waist != null) { g.thigh = Math.round(g.waist * 0.78 * 10) / 10; guessed.push('허벅지'); }
    if (g.waist == null && g.thigh != null) { g.waist = Math.round((g.thigh / 0.78) * 10) / 10; guessed.push('허리'); }
    if (g.rise == null) { g.rise = 27; guessed.push('밑위'); }
    return { g, guessed };
  }

  function drawTop(ctx, o) {
    const { pxPerCm: s, color } = o;
    const { g, guessed } = fillTop(o.g);
    if (g.length == null || g.chest == null) {
      return { ok: false, notes: ['입혀 보려면 총장과 가슴(또는 어깨) 실측이 필요해요. 사이즈표 숫자를 확인해 주세요.'] };
    }
    const P = points(o.lm, o.W, o.H, o.mirror);
    const shA = P(11), shB = P(12);
    const M = mid(shA, shB);
    const hipMid = mid(P(23), P(24));
    const u = norm(sub(hipMid, M));
    const n = norm(sub(shB, shA));
    const torso = len(sub(hipMid, M));
    const lw = Math.max(1.5, o.W / 400);
    const body = bodyDims(o.body, len(sub(shA, shB)) / s, ['shoulder', 'chest']);
    const give = 1 + STRETCH[o.stretch || 'none'];
    const notes = [];

    const HPS = sub(M, mul(u, 4 * s));                         // 옷깃 옆 어깨 가장 높은 곳
    const drop = Math.max(0, (g.shoulder - body.shoulder) / 2); // 몸 어깨보다 넓으면 어깨선이 팔로 내려온다
    const seam = (side) => add(add(M, mul(n, (side * g.shoulder * s) / 2)), mul(u, (drop * 0.8 - 1) * s));
    const cw = Math.max(visW(2 * g.chest, 'chest'), visW(body.chest, 'chest')) * s;
    const loose = Math.max(0, 2 * g.chest - body.chest);
    const armpitAt = add(M, mul(u, torso * 0.28 + (loose / 8) * s));
    const armpit = (side) => add(armpitAt, mul(n, (side * cw) / 2));
    const hemC = add(HPS, mul(u, g.length * s));
    const hemDepth = dot(sub(hemC, M), u) / torso;               // 0 = 어깨, 1 = 골반 관절
    const bodyAtHem = (hemDepth > 0.9 ? visW(body.hip, 'hip') : visW(body.waist, 'waist')) * s;
    const hw = Math.max(visW(2 * (g.hem ?? g.chest), 'chest') * s, bodyAtHem);
    const waistAt = add(M, mul(u, torso * 0.62));
    const ww = Math.max(lerp(cw, hw, 0.55), visW(body.waist, 'waist') * s);

    // 몸판
    const neckW = 7.5 * s;
    const neck = [];
    for (let k = 0; k <= 8; k++) {
      // 라운드넥: 옷깃 옆(HPS)에서 앞 중심으로 8cm 내려가는 반타원
      const t = Math.PI - (Math.PI * k) / 8;
      neck.push(add(HPS, add(mul(n, Math.cos(t) * neckW), mul(u, Math.sin(t) * 8 * s))));
    }
    const bodyPoly = [
      seam(-1), ...neck, seam(1),
      armpit(1), add(waistAt, mul(n, ww / 2)), add(hemC, mul(n, hw / 2)),
      sub(hemC, mul(n, hw / 2)), sub(waistAt, mul(n, ww / 2)), armpit(-1),
    ];
    // 옷 사진이 있으면 사진을 실측 크기로 휘어 붙이고, 없으면 단색 도식
    const tex = o.texture && o.texture.category === 'top' ? o.texture : null;
    if (!tex) fillShape(ctx, [bodyPoly], color, armpit(-1), armpit(1));

    // 소매: 팔(어깨 봉제선 → 팔꿈치 → 손목 → 손끝)을 따라가는 관. 몸판 위에 그린다(팔이 몸 옆에 있으므로)
    const cuffs = [];
    const sleeves = [];
    const sleeveTargets = [];
    if (g.sleeve != null) {
      for (const [shI, elI, wrI, fiI] of [[11, 13, 15, 19], [12, 14, 16, 20]]) {
        const side = Math.sign(dot(sub(P(shI), M), n)) || 1;
        const sp = seam(side), ap = armpit(side);
        const elbow = P(elI), wrist = P(wrI), finger = P(fiI);
        // 소매 길이는 봉제선(sp)부터 잰다. 관의 중심선은 진동 가운데(S0)에서 시작하므로 그만큼 길이를 맞춘다
        const armPath = [sp, elbow, wrist, finger];
        const S0 = mid(sp, ap);
        const tubePath = [S0, elbow, wrist, finger];
        const toWrist = arcTo(armPath, wrist);
        const L = g.sleeve * s;
        const Lc = Math.max(L * 0.3, L - (toWrist - arcTo(tubePath, wrist)));
        const { pts } = walk(tubePath, Lc, 16);
        const startW = Math.max(len(sub(sp, ap)), 11 * s);
        const endW = g.sleeve > 40 ? Math.max(startW * 0.55, 8 * s) : startW * 0.9;
        const outer = [], inner = [];
        pts.forEach(({ p, dir, d }) => {
          let nl = V(-dir.y, dir.x);
          if (dot(nl, n) * side < 0) nl = mul(nl, -1);   // 바깥쪽을 향하게
          const w = lerp(startW, endW, d / Lc) / 2;
          outer.push(add(p, mul(nl, w)));
          inner.push(sub(p, mul(nl, w)));
        });
        outer[0] = sp; // 소매 시작은 봉제선과 겨드랑이에 딱 붙인다(어깨 위로 튀어나오지 않게)
        inner[0] = ap;
        sleeves.push([...outer, ...inner.slice().reverse()]);
        sleeveTargets.push({ startX: sp.x, rib: outer.map((p, i) => [p, inner[i]]), poly: sleeves[sleeves.length - 1] });
        const ck = outer.length - 2; // 끝에서 한 칸 안쪽(약 3~4cm)
        cuffs.push([outer[ck], inner[ck]]);
        if (side > 0) {
          // 소매 끝 위치 안내(한쪽만)
          if (g.sleeve > 40) {
            const diff = g.sleeve - toWrist / s;
            notes.push(Math.abs(diff) < 1.5 ? '소매 끝이 손목에 딱 맞게 와요.'
              : diff > 0 ? `소매가 손목보다 약 ${cmText(diff)} 길어요.` : `소매가 손목보다 약 ${cmText(diff)} 짧아요.`);
          } else {
            const diff = arcTo(armPath, elbow) / s - g.sleeve;
            notes.push(diff > 0 ? `반소매 끝이 팔꿈치보다 약 ${cmText(diff)} 위에 와요.` : `반소매가 팔꿈치를 약 ${cmText(diff)} 덮어요.`);
          }
        }
      }
      if (!tex) {
        fillShape(ctx, sleeves, color, sub(M, mul(n, g.shoulder * s)), add(M, mul(n, g.shoulder * s)));
        // 소매 끝 밴드(시보리·커프스)
        for (const cuff of cuffs) line(ctx, cuff, { color: shade(color, -0.4), width: Math.max(1, lw * 0.6), alpha: 0.6, smooth: false });
      }
    }

    if (tex) {
      // 몸판 띠: 목 높이(어깨 끝) → 겨드랑이 4칸, 겨드랑이 → 밑단 10칸 (garmentsource.js의 원본 띠와 같은 구성)
      const top = (sd) => sub(seam(sd), mul(u, dot(sub(seam(sd), HPS), u)));
      const sidePoly = (sd) => [armpit(sd), add(waistAt, mul(n, (sd * ww) / 2)), add(hemC, mul(n, (sd * hw) / 2))];
      const dst = [];
      for (let k = 0; k <= 4; k++) dst.push([lerpV(top(-1), armpit(-1), k / 4), lerpV(top(1), armpit(1), k / 4)]);
      const d0 = dot(sub(armpitAt, HPS), u), d1 = dot(sub(hemC, HPS), u);
      for (let k = 1; k <= 10; k++) {
        const D = d0 + (d1 - d0) * (k / 10);
        dst.push([atDepth(sidePoly(-1), HPS, u, D), atDepth(sidePoly(1), HPS, u, D)]);
      }
      const pairs = [{ src: tex.ribbons.torso, dst }];
      // 소매: 화면 왼쪽 소매끼리, 오른쪽 소매끼리 짝짓기
      const srcSleeves = tex.ribbons.sleeves || [];
      const targets = sleeveTargets.slice().sort((a, b) => a.startX - b.startX);
      const plain = [];
      targets.forEach((t, i) => {
        const srcS = srcSleeves[i];
        if (srcS) pairs.push({ src: srcS.ribbon, dst: t.rib });
        else plain.push(t.poly); // 원본에 소매가 안 보이면 옷 평균색으로
      });
      paintTexture(ctx, tex.texture, pairs);
      if (plain.length) fillShape(ctx, plain, tex.avgColor, sub(M, mul(n, g.shoulder * s)), add(M, mul(n, g.shoulder * s)));
    }

    // ---- 디테일(단색 도식일 때만. 옷 사진에는 실제 디테일이 있다) ----
    if (!tex) {
      const seamC = shade(color, -0.5);
      const stitchC = shade(color, 0.35);
      const thin = Math.max(1, lw * 0.6);
      // 목둘레 시보리(립): 넓은 띠 + 안쪽 경계선
      line(ctx, neck, { color: shade(color, -0.15), width: 1.8 * s, alpha: 0.95 });
      line(ctx, neck.map((p) => add(p, mul(u, 0.9 * s))), { color: seamC, width: thin, alpha: 0.5 });
      // 어깨 봉제선(목 옆 → 어깨 끝)
      const toward = (a, b, t) => add(a, mul(sub(b, a), t));
      line(ctx, [neck[0], toward(neck[0], seam(-1), 0.82)], { color: seamC, width: thin, alpha: 0.5, smooth: false });
      line(ctx, [neck[neck.length - 1], toward(neck[neck.length - 1], seam(1), 0.82)], { color: seamC, width: thin, alpha: 0.5, smooth: false });
      // 밑단 스티치
      const hemL = add(sub(hemC, mul(n, hw / 2 - 1 * s)), mul(u, -2.5 * s));
      const hemR = add(add(hemC, mul(n, hw / 2 - 1 * s)), mul(u, -2.5 * s));
      line(ctx, [hemL, hemR], { color: stitchC, width: thin, alpha: 0.45, dash: [lw * 1.6, lw * 1.2], smooth: false });
    }

    if (2 * g.chest * give < body.chest) {
      markTight(ctx, armpit(-1), armpit(1), lw);
      notes.push(`가슴이 몸보다 ${cmText(body.chest - 2 * g.chest)} 작아요.`);
    }
    if (drop >= 2) notes.push(`어깨선이 내 어깨보다 약 ${cmText(drop)} 내려와요(드롭숄더).`);
    else if (g.shoulder < body.shoulder - 2) notes.push(`어깨가 내 어깨보다 ${cmText(body.shoulder - g.shoulder)} 좁아요. 어깨가 낄 수 있어요.`);

    const hemVsHip = dot(sub(hemC, hipMid), u) / s;
    notes.push(hemVsHip >= 0 ? `밑단이 골반선보다 약 ${cmText(hemVsHip)} 아래로 내려와요.` : `밑단이 골반선보다 약 ${cmText(hemVsHip)} 위에 와요(짧은 기장).`);
    if (body.estimated.length) notes.push('몸 치수 일부를 관절 간격으로 추정했어요. 내 체형에 치수를 넣으면 더 정확해요.');
    if (guessed.length) notes.push(`사이즈표에 ${guessed.join('·')} 실측이 없어서 다른 치수로 추정해 그렸어요.`);
    return { ok: true, notes };
  }

  function draw(ctx, opts) {
    // 옷을 그리기 전의 화면을 찍어 둔다(명암 지도용). 캔버스를 못 만드는 환경이면 건너뛴다
    photo = null;
    if (canMakeCanvas && ctx.canvas) {
      photo = buf('photo', ctx.canvas.width, ctx.canvas.height);
      const pg = photo.getContext('2d');
      pg.clearRect(0, 0, photo.width, photo.height);
      pg.drawImage(ctx.canvas, 0, 0);
    }
    return opts.category === 'top' ? drawTop(ctx, opts) : drawBottom(ctx, opts);
  }

  root.GarmentRender = { draw, visW, walk };
  if (typeof module !== 'undefined') module.exports = root.GarmentRender;
})(typeof window !== 'undefined' ? window : globalThis);
