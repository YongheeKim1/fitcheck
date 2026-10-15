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
  let shadeK = 1; // 내 사진 그림자 세기(직사광일수록 크게, tryon.js의 shadowStrength)
  let drawCategory = 'top'; // 지금 그리는 옷 종류
  let noMarks = false; // 옷 사진 입히기 모드에서는 끼는 곳 표시선을 생략
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
  let liveMode = false;     // 카메라(실시간): 가볍게 그린다
  let shadeCache = null;   // 카메라에서 명암 지도를 몇 프레임 재사용
  let shadeAge = 0;
  let avatarShade = null;  // 아바타: 맨몸 사진의 명암(가슴·속옷 경계)이 옷에 비치면 안 된다 → 3D 조명 명암(또는 평평한 회색)
  function shadingMap() {
    if (avatarShade) return avatarShade;
    // 카메라에서는 4프레임에 한 번만 새로(화면 픽셀 읽기가 GPU를 기다리게 해서 느리다. 주름은 그렇게 빨리 안 바뀐다)
    if (liveMode && shadeCache && shadeCache.w === photo.width && ++shadeAge < 4) return shadeCache.c;
    shadeAge = 0;
    const c0 = shadingMapNow();
    shadeCache = liveMode ? { c: c0, w: photo.width } : null;
    return c0;
  }
  function shadingMapNow() {
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
    const r1 = Math.max(1, Math.round(sw / 160)); // 작은 흐림: 원래 옷의 잔무늬(청바지 워싱·니트 결)는 지운다
    const boxAt = (x, y, rr) => {
      const ya = Math.max(0, y - rr), yb = Math.min(sh, y + rr + 1), xa = Math.max(0, x - rr), xb = Math.min(sw, x + rr + 1);
      return (S[yb * (sw + 1) + xb] - S[ya * (sw + 1) + xb] - S[yb * (sw + 1) + xa] + S[ya * (sw + 1) + xa]) / ((yb - ya) * (xb - xa));
    };
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        // 띠 통과(작게 흐린 밝기 - 크게 흐린 밝기): 주름·그림자 크기의 명암만 남기고, 잔무늬와 큰 색 경계는 뺀다.
        // 주름(주변보다 어두움)은 살리고 밝은 쪽은 약하게
        const v = 128 + Math.max(-40, Math.min(15, boxAt(x, y, r1) - boxAt(x, y, r))) * 1.4;
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

  // 옷 그림자: 사진은 그대로(옷 전체에 부드러운 그림자), 아바타는 몸 위에만(멀리 있는 배경 벽에 그림자가 번지면 얼룩처럼 보인다)
  let avatarBody = null;
  function dropShadowed(ctx, layer, W, H, alpha = 0.35) {
    const blur = Math.max(6, W / 110), oy = Math.max(2, W / 420);
    if (!avatarBody) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${alpha})`; ctx.shadowBlur = blur; ctx.shadowOffsetY = oy;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      return;
    }
    const sh = buf('bodyShadow', W, H), sg = sh.getContext('2d');
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalCompositeOperation = 'source-over';
    sg.clearRect(0, 0, W, H);
    sg.save();
    sg.shadowColor = `rgba(0,0,0,${alpha})`; sg.shadowBlur = blur; sg.shadowOffsetY = oy; sg.shadowOffsetX = W * 2;
    sg.drawImage(layer, -W * 2, 0); // 그림자만 남기기(옷은 화면 밖)
    sg.restore();
    sg.globalCompositeOperation = 'destination-in';
    sg.drawImage(avatarBody, 0, 0, W, H);
    sg.globalCompositeOperation = 'source-over';
    ctx.drawImage(sh, 0, 0);
    ctx.drawImage(layer, 0, 0);
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
    dropShadowed(ctx, layer, W, H);
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
    // 원본 삼각형이 거의 납작하면 한 줄의 픽셀이 넓게 펴져 줄무늬가 된다 → 그리지 않는다
    if (Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])) > 12) return;
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

  // 주름: 흐린 어두운 선 + 그 옆의 흐린 밝은 선(접힌 천의 그늘과 빛). 옷 모양 안에만 그린다(source-atop).
  // 흐림은 ctx.filter 대신 그림자로 만든다(아이폰 사파리도 되게): 선은 화면 밖에 그리고 그림자만 제자리로 옮긴다
  // folds: [{ pts: [점들], w: 선 굵기, blur, a: 진하기(0~1), hl: 밝은 선을 둘 방향·거리(V) }]
  function drawFolds(g, folds) {
    if (!folds || !folds.length) return;
    const off = g.canvas.width * 4;
    g.save();
    g.globalCompositeOperation = 'source-atop';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#000';
    for (const f of folds) {
      if (!f.pts || f.pts.length < 2 || !(f.a > 0.01)) continue;
      const passes = [[`rgba(0,0,0,${f.a.toFixed(3)})`, 0, 0]];
      if (f.hl) passes.push([`rgba(255,255,255,${(f.a * 0.5).toFixed(3)})`, f.hl.x, f.hl.y]);
      for (const [col, dx, dy] of passes) {
        g.shadowColor = col;
        g.shadowBlur = f.blur;
        g.shadowOffsetX = off + dx;
        g.shadowOffsetY = dy;
        g.lineWidth = f.w;
        g.beginPath();
        smoothPath(g, f.pts.map((p) => V(p.x - off, p.y)), false);
        g.stroke();
      }
    }
    g.restore();
  }

  // 띠 단면 하나(c: 가운데, nrm: 바깥쪽 단위 벡터, w: 폭)에서 폭 비율 a~b를 가로지르는 처진 호(점 3개)
  function across(c, nrm, w, a, b, sag) {
    const down = V(-nrm.y, nrm.x).y >= 0 ? V(-nrm.y, nrm.x) : V(nrm.y, -nrm.x); // 화면 아래쪽 방향
    const p = (t) => add(c, mul(nrm, w * t));
    return [p(a), add(p((a + b) / 2), mul(down, w * sag)), p(b)];
  }

  // ---------- 옷 전체를 하나로 휘기(TPS: thin-plate spline) ----------
  // 띠(단면)마다 따로 휘면 몸판·소매·다리 사이에 이음매와 틈이 생긴다. 띠의 대응점(실측 cm로 정한 자리)을 모두 지나는
  // 하나의 매끄러운 휘기를 구해 옷 사진 전체를 한 번에 휜다. 계산: 목표 좌표 → 원본 좌표(역방향)
  function tpsFit(dst, src, lambda) {
    const n = dst.length, N = n + 3;
    const U = (r2) => (r2 > 1e-12 ? r2 * Math.log(r2) : 0);
    const A = Array.from({ length: N }, () => new Float64Array(N + 2));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dx = dst[i].x - dst[j].x, dy = dst[i].y - dst[j].y;
        A[i][j] = U(dx * dx + dy * dy) + (i === j ? lambda : 0);
      }
      A[i][n] = 1; A[i][n + 1] = dst[i].x; A[i][n + 2] = dst[i].y;
      A[n][i] = 1; A[n + 1][i] = dst[i].x; A[n + 2][i] = dst[i].y;
      A[i][N] = src[i].x; A[i][N + 1] = src[i].y;
    }
    // 가우스 소거(부분 피벗)
    for (let c = 0; c < N; c++) {
      let piv = c;
      for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < N; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < N + 2; k++) A[r][k] -= f * A[c][k];
      }
    }
    const wx = new Float64Array(N), wy = new Float64Array(N);
    for (let r = 0; r < N; r++) { wx[r] = A[r][N] / A[r][r]; wy[r] = A[r][N + 1] / A[r][r]; }
    return { dst, wx, wy, n, U };
  }
  function tpsEval(t, x, y) {
    const { dst, wx, wy, n, U } = t;
    let sx = wx[n] + wx[n + 1] * x + wx[n + 2] * y;
    let sy = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const dx = x - dst[i].x, dy = y - dst[i].y;
      const u = U(dx * dx + dy * dy);
      sx += wx[i] * u; sy += wy[i] * u;
    }
    return [sx, sy];
  }

  // WebGL로 격자 메시 하나를 텍스처와 함께 그린다(삼각형 수천 개를 한 번에, 조각 사이 틈 없음)
  let glState = null;
  function glWarp(img, W, H, verts, uvs, idx) {
    if (!canMakeCanvas) return null;
    if (!glState) {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
      if (!gl) { glState = { failed: true }; return null; }
      const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p;attribute vec2 t;uniform vec2 sz;varying vec2 v;void main(){v=t;gl_Position=vec4(p.x/sz.x*2.0-1.0,1.0-p.y/sz.y*2.0,0.0,1.0);}'));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, 'precision mediump float;varying vec2 v;uniform sampler2D s;void main(){if(v.x<0.0||v.y<0.0||v.x>1.0||v.y>1.0)discard;gl_FragColor=texture2D(s,v);}'));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { glState = { failed: true }; return null; }
      glState = { c, gl, prog, tex: gl.createTexture(), vb: gl.createBuffer(), tb: gl.createBuffer(), ib: gl.createBuffer(), lastImg: null,
        u32: !!gl.getExtension('OES_element_index_uint') };
    }
    if (glState.failed) return null;
    const { c, gl, prog, tex, vb, tb, ib } = glState;
    if (gl.isContextLost()) { glState = null; return null; }
    if (idx.length > 65535 * 3 && !glState.u32) return null;
    c.width = W; c.height = H;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (glState.lastImg !== img) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      glState.lastImg = img;
    }
    const bind = (buf2, data, name) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf2);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };
    bind(vb, verts, 'p');
    bind(tb, uvs, 't');
    gl.uniform2f(gl.getUniformLocation(prog, 'sz'), W, H);
    gl.uniform1i(gl.getUniformLocation(prog, 's'), 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    const big = verts.length / 2 > 65535;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(idx) : new Uint16Array(idx), gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, idx.length, big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    return c;
  }

  // 띠 짝들로 TPS를 맞추고, 목표 쪽 격자를 원본 좌표로 보내 WebGL로 그린다. 실패하면 null(띠 방식으로 그린다)
  function warpTPS(L, img, pairs, W, H) {
    const D = [], S = [];
    for (const pr of pairs) {
      // 허리 조각의 "다리와 겹치게 늘린 줄"(fade)은 대응점에서 뺀다(다리 대응점과 부딪힌다)
      const src = pr.fade ? pr.src.slice(0, 7) : pr.src, dst = pr.fade ? pr.dst.slice(0, 7) : pr.dst;
      const n = Math.min(9, Math.max(src.length, dst.length));
      const a = resample(src, n), b = resample(dst.map(byX), n);
      for (let i = 0; i < n; i++) {
        const ra = a[i][0].x <= a[i][1].x ? a[i] : [a[i][1], a[i][0]];
        for (const t of [0, 0.5, 1]) {
          D.push(lerpV(b[i][0], b[i][1], t));
          S.push(lerpV(ra[0], ra[1], t));
        }
      }
    }
    if (D.length < 6) return false;
    // 목표 쪽에서 너무 가까운 점은 합친다(서로 다른 원본을 가리키면 휘기가 접힌다)
    const minD = W / 120;
    const dd = [], ss = [];
    D.forEach((p, i) => {
      const k = dd.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < minD);
      if (k < 0) { dd.push(p); ss.push(S[i]); }
    });
    const sc = 1 / W; // 좌표를 0~1로 줄여 계산(수치 안정)
    const t = tpsFit(dd.map((p) => V(p.x * sc, p.y * sc)), ss.map((p) => V(p.x * sc, p.y * sc)), 1e-3);
    if (!t) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of dd) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const m = W * 0.04;
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W, x1 + m); y1 = Math.min(H, y1 + m);
    const step = Math.max(4, Math.round(Math.min(W, H) / (liveMode ? 40 : 90))); // 카메라에서는 성글게(빠르게)
    const nx = Math.max(2, Math.ceil((x1 - x0) / step) + 1), ny = Math.max(2, Math.ceil((y1 - y0) / step) + 1);
    const verts = new Float32Array(nx * ny * 2), uvs = new Float32Array(nx * ny * 2);
    const iw = img.width, ih = img.height;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = Math.min(x1, x0 + i * step), y = Math.min(y1, y0 + j * step);
      const [sx, sy] = tpsEval(t, x * sc, y * sc);
      const k = (j * nx + i) * 2;
      verts[k] = x; verts[k + 1] = y;
      uvs[k] = (sx / sc) / iw; uvs[k + 1] = (sy / sc) / ih;
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
    const out = glWarp(img, W, H, verts, uvs, idx);
    if (!out) return false;
    // 실측으로 정한 옷 모양(띠들의 합집합, 살짝 넓혀서) 안만 남긴다: 대응점 밖의 내용(벨트·긴소매 나머지·모델 손)은 버린다
    const clip = buf('tpsClip', W, H);
    const cg = clip.getContext('2d');
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.globalCompositeOperation = 'source-over';
    // 합집합 마스크: 띠마다 채우고 테두리를 넓힌 뒤 destination-in을 한 번만 적용한다
    const mask = buf('tpsMask', W, H);
    const mg = mask.getContext('2d');
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, W, H);
    mg.fillStyle = '#fff';
    mg.strokeStyle = '#fff';
    mg.lineJoin = 'round';
    mg.lineWidth = Math.max(2, W / 70);
    for (const pr of pairs) {
      const rows = pr.dst.map(byX);
      mg.beginPath();
      rows.forEach((r, i) => (i ? mg.lineTo(r[0].x, r[0].y) : mg.moveTo(r[0].x, r[0].y)));
      for (let i = rows.length - 1; i >= 0; i--) mg.lineTo(rows[i][1].x, rows[i][1].y);
      mg.closePath();
      mg.fill();
      mg.stroke();
    }
    for (const poly of pairs.caps || []) { // 어깨 덮개: 둥근 어깨 꼭대기를 덮는 띠
      mg.beginPath();
      poly.forEach((q, i) => (i ? mg.lineTo(q.x, q.y) : mg.moveTo(q.x, q.y)));
      mg.closePath();
      mg.fill();
    }
    cg.clearRect(0, 0, W, H);
    cg.drawImage(out, 0, 0);
    cg.globalCompositeOperation = 'destination-in';
    cg.drawImage(mask, 0, 0);
    cg.globalCompositeOperation = 'source-over';
    L.drawImage(clip, 0, 0);
    return true;
  }
  let useTPS = true; // draw()에서 자세에 따라 정한다(팔을 크게 들면 띠 방식이 낫다)
  let armsFront = false;
  let lastHole = null; // 마지막으로 그린 장면의 메울 곳(tryon.js가 AI로 다시 메울 때 쓴다)
  let lastGarment = null; // 마지막으로 그린 옷 레이어(투명 배경). 코디에서 먼저 입힌 옷 자리를 정확히 알 때 쓴다 // 팔이 몸 앞에 오는 자세(팔 듦·팔이 몸을 가림)

  // pairs: [{ src: 원본 띠, dst: 목표 띠 }]. 실측 크기로 휜 옷 사진에 내 사진 명암을 살짝 입히고 그림자와 함께 얹는다
  function paintTexture(ctx, img, pairs, folds) {
    if (!(canMakeCanvas && ctx.canvas && photo)) return false;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const layer = buf('layer', W, H);
    const L = layer.getContext('2d');
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.clearRect(0, 0, W, H);
    L.imageSmoothingEnabled = true;
    L.imageSmoothingQuality = 'high';
    const tpsDone = useTPS && warpTPS(L, img, pairs, W, H);
    for (const { src, dst, fade } of tpsDone ? [] : pairs) {
      if (!fade) { drawRibbon(L, img, src, dst); continue; }
      // 이어 붙이는 조각: 따로 그린 뒤 from(불투명) → to(투명)로 서서히 사라지게 해서 얹는다
      const pc = buf('piece', W, H);
      const pg = pc.getContext('2d');
      pg.setTransform(1, 0, 0, 1, 0, 0);
      pg.globalCompositeOperation = 'source-over';
      pg.clearRect(0, 0, W, H);
      pg.imageSmoothingEnabled = true;
      pg.imageSmoothingQuality = 'high';
      drawRibbon(pg, img, src, dst);
      const gr = pg.createLinearGradient(fade.from.x, fade.from.y, fade.to.x, fade.to.y);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      pg.globalCompositeOperation = 'destination-in';
      pg.fillStyle = gr;
      pg.fillRect(0, 0, W, H);
      pg.globalCompositeOperation = 'source-over';
      L.drawImage(pc, 0, 0);
    }
    // 조각 사이·두 다리 사이에 생긴 작은 빈틈은 주변 천 색으로 메운다(목표 모양 안에서만)
    if (pairs.some((p) => p.fill)) {
      const blurred = (k) => {
        const w = Math.max(1, Math.round(W / k)), h = Math.max(1, Math.round(H / k));
        const c = buf('gap' + k, w, h);
        const cg = c.getContext('2d');
        cg.clearRect(0, 0, w, h);
        cg.imageSmoothingEnabled = true;
        cg.imageSmoothingQuality = 'high';
        cg.drawImage(layer, 0, 0, w, h);
        return c;
      };
      const gf = buf('gapfill', W, H);
      const gg = gf.getContext('2d');
      gg.setTransform(1, 0, 0, 1, 0, 0);
      gg.globalCompositeOperation = 'source-over';
      gg.clearRect(0, 0, W, H);
      gg.imageSmoothingEnabled = true;
      gg.imageSmoothingQuality = 'high';
      // 거친 단계부터: 큰 구멍(사진 속 팔과 몸통 사이 배경 틈 등)은 넓게 흐린 천 색, 작은 틈은 가까운 천 색
      for (const k of [72, 32, 12, 5, 2.5]) { const b = blurred(k); for (let r = 0; r < 3; r++) gg.drawImage(b, 0, 0, W, H); } // 마지막 두 단계: 가장자리 바로 옆은 또렷한 천 색(흐린 띠 얼룩 방지)
      // 메울 범위: 목표 띠 모양 안(하나로 휜 경우엔 잘라 낸 옷 모양과 같게 테두리를 조금 넓힌다)
      const fm = buf('gapMask', W, H);
      const fmg = fm.getContext('2d');
      fmg.setTransform(1, 0, 0, 1, 0, 0);
      fmg.clearRect(0, 0, W, H);
      fmg.fillStyle = '#fff';
      fmg.strokeStyle = '#fff';
      fmg.lineJoin = 'round';
      fmg.lineWidth = Math.max(2, W / 70);
      for (const { dst, fill } of pairs) {
        if (!fill) continue;
        const rows = dst.slice(typeof fill === 'number' ? fill : 0).map(byX);
        fmg.beginPath();
        rows.forEach((r, i2) => (i2 ? fmg.lineTo(r[0].x, r[0].y) : fmg.moveTo(r[0].x, r[0].y)));
        for (let i2 = rows.length - 1; i2 >= 0; i2--) fmg.lineTo(rows[i2][1].x, rows[i2][1].y);
        fmg.closePath();
        fmg.fill();
        if (tpsDone) fmg.stroke();
      }
      for (const poly of pairs.caps || []) {
        fmg.beginPath();
        poly.forEach((q, i2) => (i2 ? fmg.lineTo(q.x, q.y) : fmg.moveTo(q.x, q.y)));
        fmg.closePath();
        fmg.fill();
      }
      gg.globalCompositeOperation = 'destination-in';
      gg.drawImage(fm, 0, 0);
      gg.globalCompositeOperation = 'source-over';
      L.save();
      L.globalCompositeOperation = 'destination-over';
      L.drawImage(gf, 0, 0);
      L.restore();
    }
    drawFolds(L, folds);
    // 둥근 몸에 감긴 느낌: 옷 가장자리로 갈수록 살짝 어둡게(외곽을 크게 흐린 알파의 반대값)
    const k = 24;
    const sw = Math.max(1, Math.round(W / k)), shh = Math.max(1, Math.round(H / k));
    const sm = buf('edgeSmall', sw, shh);
    const smg = sm.getContext('2d');
    smg.clearRect(0, 0, sw, shh);
    smg.imageSmoothingEnabled = true;
    smg.drawImage(layer, 0, 0, sw, shh);
    const ed = buf('edge', W, H);
    const eg = ed.getContext('2d');
    eg.globalCompositeOperation = 'source-over';
    eg.clearRect(0, 0, W, H);
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, W, H);
    eg.globalCompositeOperation = 'destination-out';
    eg.imageSmoothingEnabled = true;
    eg.imageSmoothingQuality = 'high';
    eg.drawImage(sm, 0, 0, W, H);
    eg.globalCompositeOperation = 'destination-in';
    eg.drawImage(layer, 0, 0);
    eg.globalCompositeOperation = 'source-over';
    L.save();
    L.globalCompositeOperation = 'source-atop';
    L.globalAlpha = 0.45;
    L.drawImage(ed, 0, 0);
    L.restore();
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
    // 옷 사진에 이미 주름이 있으니 내 사진 명암은 약하게(그림자가 진한 사진이면 조금 더). 바지는 원래 바지의 워싱 무늬가
    // 얼룩처럼 옮겨지기 쉬워 더 약하게
    L.globalAlpha = Math.min(0.32, (drawCategory === 'bottom' ? 0.1 : 0.18) * shadeK);
    L.drawImage(sh, 0, 0);
    L.restore();
    dropShadowed(ctx, layer, W, H);
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

  // ---------- 사진과 자연스럽게 합치기(사진 모드) ----------
  // 사진 속 몸이 있는 자리(원래 옷을 지울 때 남길 곳)와 손·팔뚝 자리(옷 위로 다시 올릴 곳)
  function bodyGeo(P, s, body) {
    const shA = P(11), shB = P(12), hA = P(23), hB = P(24);
    const M = mid(shA, shB), Hm = mid(hA, hB);
    const u = norm(sub(Hm, M)), n = norm(sub(shB, shA));
    const torso = len(sub(Hm, M));
    const at = (t) => add(M, mul(u, torso * t));
    const half = (circ, kind) => (visW(circ, kind) * s) / 2;
    const rows = [[at(0), (body.shoulder * s) / 2], [at(0.28), half(body.chest, 'chest')], [at(0.62), half(body.waist, 'waist')], [Hm, half(body.hip, 'hip')]];
    const torsoPoly = [...rows.map(([c, w]) => sub(c, mul(n, w))), ...rows.slice().reverse().map(([c, w]) => add(c, mul(n, w)))];
    const segs = [];
    const thighR = half(body.thigh, 'leg');
    for (const [h, k, a, heel] of [[23, 25, 27, 29], [24, 26, 28, 30]]) {
      segs.push({ a: P(h), b: P(k), r: thighR }, { a: P(k), b: P(a), r: thighR * 0.7 }, { a: P(a), b: P(heel), r: 5 * s });
    }
    const hands = [];
    const props = [];
    const arms = [];
    for (const [sh, el, wr, fi] of [[11, 13, 15, 19], [12, 14, 16, 20]]) {
      const armSegs = [{ a: P(sh), b: P(el), r: 5.5 * s }, { a: P(el), b: P(wr), r: 4.5 * s }, { a: P(wr), b: P(fi), r: 5 * s }];
      segs.push(...armSegs);
      // 피부로 덮어도 되는 곳: 위팔의 아래쪽(어깨에서 45% 아래부터 팔꿈치까지) — 소매 끝이 오는 자리
      arms.push({ a: lerpV(P(sh), P(el), 0.45), b: P(el), r: 5 * s });
      // 팔 전체(어깨~손끝)는 몸통 앞에 있다: 사진 속 피부가 보이는 곳은 옷 위로 올린다(새 소매 안쪽은 composeScene에서 뺀다)
      // 팔꿈치~손끝은 늘 옷 위로. 위팔은 팔을 들었거나 몸 앞을 가리는 자세일 때만(평소엔 새 소매 안쪽 피부가 비쳐 보인다)
      if (armsFront) hands.push({ a: lerpV(P(sh), P(el), 0.15), b: P(el), r: 5 * s });
      hands.push({ a: P(el), b: P(wr), r: 4.8 * s }, { a: P(wr), b: P(fi), r: 5.5 * s });
      props.push({ a: P(wr), b: P(fi), r: 10 * s }); // 손에 든 물건(휴대폰 등)
    }
    segs.push({ a: M, b: sub(M, mul(u, 12 * s)), r: 6 * s }); // 목
    // 어깨 윗부분(승모근): 어깨 관절에서 목 아래까지. 빠지면 그 자리의 원래 옷을 "몸 밖"으로 보고 배경으로 지운다
    for (const sh of [shA, shB]) segs.push({ a: sh, b: sub(M, mul(u, 5 * s)), r: 6.5 * s });
    return { torsoPoly, segs, hands, props, arms, s };
  }

  function strokeSegs(g, segs) {
    g.lineCap = 'round';
    for (const { a, b, r } of segs) {
      g.lineWidth = r * 2;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
  }

  // 구멍 메우기(push-pull): 구멍 밖 픽셀을 점점 거칠게 평균 낸 피라미드로 구멍을 주변 색으로 채운다.
  // 벽·바닥 같은 배경을 이어 붙이는 데 충분하고 빠르다
  function inpaint(img, W, hole, box) {
    const x0 = box.x0, y0 = box.y0, bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    const d = img.data;
    let lv = { w: bw, h: bh, c: new Float32Array(bw * bh * 3), a: new Float32Array(bw * bh) };
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const j = y * bw + x;
        if (hole(x + x0, y + y0)) continue;
        const i = ((y + y0) * W + (x + x0)) * 4;
        lv.c[j * 3] = d[i]; lv.c[j * 3 + 1] = d[i + 1]; lv.c[j * 3 + 2] = d[i + 2];
        lv.a[j] = 1;
      }
    }
    const levels = [lv];
    while (lv.w > 1 || lv.h > 1) {
      const w = Math.ceil(lv.w / 2), h = Math.ceil(lv.h / 2);
      const nx = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, s = 0;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const X = x * 2 + dx, Y = y * 2 + dy;
            if (X >= lv.w || Y >= lv.h) continue;
            const k = Y * lv.w + X, wt = lv.a[k];
            r += lv.c[k * 3] * wt; g += lv.c[k * 3 + 1] * wt; b += lv.c[k * 3 + 2] * wt; s += wt;
          }
          const j = y * w + x;
          if (s > 0) { nx.c[j * 3] = r / s; nx.c[j * 3 + 1] = g / s; nx.c[j * 3 + 2] = b / s; }
          nx.a[j] = Math.min(1, s);
        }
      }
      levels.push(nx);
      lv = nx;
    }
    // 위(거친 단계)에서 아래로: 비어 있는 만큼 윗단계 색(쌍선형 보간)으로 채운다
    for (let L = levels.length - 2; L >= 0; L--) {
      const f = levels[L], c = levels[L + 1];
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const j = y * f.w + x;
          const wt = f.a[j];
          if (wt >= 1) continue;
          const px = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), py = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
          const xa = Math.floor(px), ya = Math.floor(py), xb = Math.min(c.w - 1, xa + 1), yb = Math.min(c.h - 1, ya + 1);
          const fx = px - xa, fy = py - ya;
          for (let ch = 0; ch < 3; ch++) {
            const v = (c.c[(ya * c.w + xa) * 3 + ch] * (1 - fx) + c.c[(ya * c.w + xb) * 3 + ch] * fx) * (1 - fy)
              + (c.c[(yb * c.w + xa) * 3 + ch] * (1 - fx) + c.c[(yb * c.w + xb) * 3 + ch] * fx) * fy;
            f.c[j * 3 + ch] = f.c[j * 3 + ch] * wt + v * (1 - wt);
          }
          f.a[j] = 1;
        }
      }
    }
    const top = levels[0];
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (!hole(x + x0, y + y0)) continue;
        const j = y * bw + x, i = ((y + y0) * W + (x + x0)) * 4;
        d[i] = top.c[j * 3]; d[i + 1] = top.c[j * 3 + 1]; d[i + 2] = top.c[j * 3 + 2];
      }
    }
  }

  // G: 옷만 그린 투명 캔버스. scene: 내 사진 분석 결과 { cat, w, h, head, skin } (tryon.js)
  // 1) 새 옷 밖으로 삐져나온 원래 옷(몸이 없는 자리)을 배경으로 메운다
  // 2) 옷을 얹는다
  // 3) 손·팔뚝(소매 안 제외)과 얼굴·머리를 옷 위로 다시 올린다
  // 사진에 얹기 전 마무리: 옷이 "오려 붙인" 티가 나지 않게
  //   1) 외곽을 1~2px 부드럽게(사진 속 물체 경계는 칼로 자른 듯 날카롭지 않다)
  //   2) 내 사진의 입자감(노이즈)만큼 옷에도 입자를 넣는다(상품 사진은 보통 더 매끈하다)
  //   3) 배경 빛이 옷 가장자리에 살짝 번지게(light wrap)
  function finishGarment(G, W, H) {
    const g = G.getContext('2d', { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    // 1) 부드러운 외곽: 줄였다 키운 알파를 곱한다
    const f = Math.max(2, Math.round(W / 450));
    const sw = Math.max(1, Math.round(W / f)), sh = Math.max(1, Math.round(H / f));
    const small = buf('featherSmall', sw, sh);
    const sg = small.getContext('2d');
    sg.clearRect(0, 0, sw, sh);
    sg.imageSmoothingEnabled = true;
    sg.drawImage(G, 0, 0, sw, sh);
    g.save();
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, W, H);
    g.restore();

    // 3) 빛 번짐: 크게 흐린 배경을 옷 가장자리 띠에만 약하게
    if (photo) {
      const k = 20;
      const bw = Math.max(1, Math.round(W / k)), bh = Math.max(1, Math.round(H / k));
      const bp = buf('wrapPhoto', bw, bh);
      const bpg = bp.getContext('2d');
      bpg.imageSmoothingEnabled = true;
      bpg.drawImage(photo, 0, 0, bw, bh);
      const ba = buf('wrapAlpha', bw, bh);
      const bag = ba.getContext('2d');
      bag.clearRect(0, 0, bw, bh);
      bag.imageSmoothingEnabled = true;
      bag.drawImage(G, 0, 0, bw, bh);
      const wrap = buf('wrap', W, H);
      const wg = wrap.getContext('2d');
      wg.globalCompositeOperation = 'source-over';
      wg.clearRect(0, 0, W, H);
      wg.imageSmoothingEnabled = true;
      wg.drawImage(bp, 0, 0, W, H);
      wg.globalCompositeOperation = 'destination-out'; // 옷 안쪽 깊은 곳은 빼고 가장자리 띠만 남긴다
      wg.drawImage(ba, 0, 0, W, H);
      wg.globalCompositeOperation = 'destination-in';  // 옷 바깥은 빼기
      wg.drawImage(G, 0, 0);
      wg.globalCompositeOperation = 'source-over';
      g.save();
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = avatarBody ? 0.08 : 0.3; // 아바타는 배경이 밝은 단색이라 넓은 빛 번짐이 옷 가장자리에 회색 얼룩처럼 보인다
      g.drawImage(wrap, 0, 0);
      g.restore();
    }

    // 2) 입자감: 라플라시안 크기의 중앙값으로 노이즈 세기를 잰다(내 사진 vs 옷)
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const lumAt = (arr, i) => 0.299 * arr[i] + 0.587 * arr[i + 1] + 0.114 * arr[i + 2];
    const sigma = (arr, pick) => {
      const v = [];
      for (let y = 2; y < H - 2; y += 3) for (let x = 2; x < W - 2; x += 3) {
        const i = (y * W + x) * 4;
        if (!pick(i)) continue;
        const c = lumAt(arr, i);
        const n4 = (lumAt(arr, i - 4) + lumAt(arr, i + 4) + lumAt(arr, i - W * 4) + lumAt(arr, i + W * 4)) / 4;
        v.push(Math.abs(c - n4));
      }
      if (v.length < 200) return null;
      v.sort((a, b) => a - b);
      // med: 노이즈 세기(표준편차로 환산), p90: 선명도(밝기가 크게 바뀌는 곳의 세기)
      return { med: (v[Math.floor(v.length / 2)] * 1.4826) / 1.118, p90: v[Math.floor(v.length * 0.9)] };
    };
    const opaque = (i) => d[i + 3] === 255 && d[i - 4 + 3] === 255 && d[i + 4 + 3] === 255 && d[i - W * 4 + 3] === 255 && d[i + W * 4 + 3] === 255;
    const sg2 = sigma(d, opaque);
    let sp = null;
    if (photo) {
      const pd = photo.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      sp = sigma(pd, opaque); // 옷이 놓일 자리(원래 사진)의 입자감
    }
    // 선명도: 늘려 입힌 상품 사진이 내 사진보다 흐리면(가장자리 세기가 약하면) 그만큼 선명하게(라플라시안 샤프닝)
    if (sg2 != null && sp != null && sp.p90 > sg2.p90 * 1.15) {
      const amt = Math.min(1.2, sp.p90 / Math.max(1, sg2.p90) - 1);
      const src = new Uint8ClampedArray(d);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        if (!src[i + 3]) continue;
        for (let k = 0; k < 3; k++) {
          const n4 = (src[i - 4 + k] + src[i + 4 + k] + src[i - W * 4 + k] + src[i + W * 4 + k]) / 4;
          d[i + k] = src[i + k] + amt * (src[i + k] - n4);
        }
      }
      g.putImageData(img, 0, 0);
    }
    if (sg2 != null && sp != null) {
      const add = Math.min(8, Math.sqrt(Math.max(0, sp.med * sp.med - sg2.med * sg2.med)));
      if (add > 0.4) {
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          const nz = (rnd() + rnd() + rnd() - 1.5) * 2 * add; // 대략 정규분포, 표준편차 ≈ add
          d[i] = Math.max(0, Math.min(255, d[i] + nz));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + nz));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + nz));
        }
        g.putImageData(img, 0, 0);
      }
    }
  }

  function composeScene(ctx, G, scene, geo) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    lastHole = null;
    const gA = G.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const bodyC = buf('bodymask', W, H);
    const bg = bodyC.getContext('2d', { willReadFrequently: true });
    bg.clearRect(0, 0, W, H);
    bg.fillStyle = '#fff';
    bg.strokeStyle = '#fff';
    bg.beginPath();
    geo.torsoPoly.forEach((p, i) => (i ? bg.lineTo(p.x, p.y) : bg.moveTo(p.x, p.y)));
    bg.closePath();
    bg.fill();
    strokeSegs(bg, geo.segs);
    const bA = bg.getImageData(0, 0, W, H).data;
    const sx = scene.w / W, sy = scene.h / H;
    const [z0, z1] = geo.zone;
    const catAt = (x, y) => scene.cat[Math.floor(y * sy) * scene.w + Math.floor(x * sx)];
    // 바지: 새 바지 밑단 아래(발목까지)는 분할이 배경으로 잘못 본 원래 바지도 색으로 찾아낸다
    let gBottom = null, origC = null, src = null;
    if (geo.ankles) {
      gBottom = new Int32Array(W).fill(-1);
      for (let x = 0; x < W; x++) for (let y = H - 1; y >= 0; y--) if (gA[(y * W + x) * 4 + 3] > 25) { gBottom[x] = y; break; }
      src = ctx.getImageData(0, 0, W, H).data;
      let r = 0, g2 = 0, b = 0, n = 0;
      for (let y = Math.floor((z0 + H) / 2); y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (gA[i + 3] > 25 && bA[i + 3] > 100 && catAt(x, y) === 4) { r += src[i]; g2 += src[i + 1]; b += src[i + 2]; n++; }
      }
      if (n > 50) origC = [r / n, g2 / n, b / n];
    }
    // 발목: 무릎→발꿈치 선에서 발목 반지름 안쪽만 살. 바지 폭 전체를 살색으로 칠하면 발목이 뚱뚱해 보인다
    const segDist = (x, y, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
    };
    // 다리 둘레 안 정도(0 = 가운데 선, 1 = 가장자리, 1 넘으면 밖): 무릎에서 발목으로 가늘어진다
    const legT = (x, y) => {
      let best = Infinity;
      for (const sg of geo.ankles.segs) {
        const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y;
        const t = Math.max(0, Math.min(1, ((x - sg.a.x) * dx + (y - sg.a.y) * dy) / (dx * dx + dy * dy || 1)));
        const dd = Math.hypot(x - sg.a.x - dx * t, y - sg.a.y - dy * t) / (sg.ra + (sg.rb - sg.ra) * t);
        if (dd < best) best = dd;
      }
      return best;
    };
    const inAnkle = (x, y) => legT(x, y) < 1;
    // 새 바지 밑단 아래(발목까지) 원래 바지 / 새 바지 허리 위(허리선 아래) 원래 바지
    const belowHem = (x, y) => origC && gBottom[x] >= 0 && y > gBottom[x] && y <= geo.ankles.yMax;
    let gTop = null;
    if (geo.ankles) {
      gTop = new Int32Array(W).fill(-1);
      for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (gA[(y * W + x) * 4 + 3] > 25) { gTop[x] = y; break; }
    }
    // 내 상의도 같은 "옷"으로 잡히므로, 다리 쪽에서 잰 원래 바지 색과 비슷한 픽셀만 원래 바지로 본다
    const nearOrig = (x, y, t) => {
      const i = (y * W + x) * 4;
      return Math.hypot(src[i] - origC[0], src[i + 1] - origC[1], src[i + 2] - origC[2]) < t;
    };
    // 내 상의 색: 허리선 바로 위 옷 픽셀 평균. 허리선 아래 옷 픽셀은 상의/원래 바지 중 더 가까운 쪽으로 나눈다
    let topC = null;
    if (origC) {
      let r = 0, g2 = 0, b = 0, n = 0;
      const span = Math.round(H / 30);
      for (let y = Math.max(0, Math.round(geo.bandTop) - span); y < geo.bandTop; y++) for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (bA[i + 3] > 100 && catAt(x, y) === 4) { r += src[i]; g2 += src[i + 1]; b += src[i + 2]; n++; }
      }
      if (n > 30) topC = [r / n, g2 / n, b / n];
    }
    const dist = (x, y, c) => { const i = (y * W + x) * 4; return Math.hypot(src[i] - c[0], src[i + 1] - c[1], src[i + 2] - c[2]); };
    const aboveWaist = (x, y) => origC && gTop[x] >= 0 && y < gTop[x] && y >= geo.bandTop && catAt(x, y) === 4
      && (topC ? dist(x, y, origC) < dist(x, y, topC) : nearOrig(x, y, 55));
    const isOrig = (x, y) => {
      if (catAt(x, y) === 4) return true;
      if (!origC || gBottom[x] < 0 || y <= gBottom[x] || y > geo.ankles.yMax) return false;
      const i = (y * W + x) * 4;
      return Math.hypot(src[i] - origC[0], src[i + 1] - origC[1], src[i + 2] - origC[2]) < 70;
    };
    let armHole = null; // 드러난 팔 밖에 남은 원래 소매(아래 상의 팔 처리에서 채운다)
    const hole = (x, y) => {
      if (armHole && armHole[y * W + x]) return true;
      if (y < z0 || y > z1) return false;
      const k = (y * W + x) * 4 + 3;
      if (gA[k] > 25) return false;
      // 몸 안쪽이라도: 허리 위로 드러난 원래 바지, 발목 밖으로 남은 원래 바지는 지운다
      if (bA[k] > 100) return (!topC && aboveWaist(x, y)) || (belowHem(x, y) && !inAnkle(x, y) && isOrig(x, y));
      return isOrig(x, y); // 원래 옷
    };
    let box = null;
    for (let y = Math.max(0, Math.floor(z0)); y < Math.min(H, Math.ceil(z1)); y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (!hole(x, y)) continue;
        if (!box) box = { x0: x, y0: y, x1: x, y1: y };
        else { box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y); }
      }
    }
    // 허리 위로 드러난 원래 바지: 바로 위 내 상의 색으로 칠한다(상의를 바지 위로 꺼내 입은 모습).
    // 열마다 따로 복사하면 세로 줄무늬가 생기므로, 허리선 위 상의 띠를 가로로 넓게 평균 낸 색을 쓴다
    if (origC && topC) {
      const span = Math.round(H / 30), rad = Math.max(4, Math.round(W / 60));
      const y0 = Math.max(0, Math.round(geo.bandTop) - span), y1 = Math.round(geo.bandTop);
      const col = new Float64Array(W * 4); // 열별 상의 색 합계와 개수
      for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
        const i2 = (y * W + x) * 4;
        if (bA[i2 + 3] <= 100 || catAt(x, y) !== 4 || dist(x, y, topC) > 60) continue;
        col[x * 4] += src[i2]; col[x * 4 + 1] += src[i2 + 1]; col[x * 4 + 2] += src[i2 + 2]; col[x * 4 + 3]++;
      }
      const prof = [];
      for (let x = 0; x < W; x++) {
        let r = 0, g2 = 0, b = 0, n = 0;
        for (let k = Math.max(0, x - rad); k <= Math.min(W - 1, x + rad); k++) { r += col[k * 4]; g2 += col[k * 4 + 1]; b += col[k * 4 + 2]; n += col[k * 4 + 3]; }
        prof.push(n > 3 ? [r / n, g2 / n, b / n] : topC);
      }
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      let any = false;
      for (let x = 0; x < W; x++) {
        if (gTop[x] < 0) continue;
        let started = -1; // 이 열에서 원래 바지가 처음 나온 줄. 그 뒤로는 옷 픽셀을 모두 칠한다(박음질·밝은 점이 남지 않게)
        for (let y = Math.max(0, y1); y < gTop[x]; y++) {
          if (started < 0 && aboveWaist(x, y)) started = y;
          if (started < 0 || catAt(x, y) !== 4) continue;
          // 평평한 색 대신 바로 위 상의 천을 거울처럼 이어 붙인다(주름·결이 이어지게). 상의가 아닌 픽셀이면 평균색
          // 상의 밑단 단(그늘진 접힌 부분)은 건너뛰고 3cm 위의 깨끗한 천부터. 분할에서 옷인 픽셀만(벽색이 비슷해도 제외)
          const k = y - started;
          const skip = Math.round((geo.s || W / 100) * 3);
          const ys = Math.max(0, started - skip - (k % span));
          const j = (ys * W + x) * 4, pc = prof[x];
          const okSrc = catAt(x, ys) === 4 && dist(x, ys, topC) < 60 && bA[j + 3] > 100;
          // 평균색과 반씩 섞는다(결은 살리되 줄무늬처럼 튀지 않게)
          const c = okSrc ? [(src[j] + pc[0]) / 2, (src[j + 1] + pc[1]) / 2, (src[j + 2] + pc[2]) / 2] : pc;
          // 바지 허리 쪽으로 갈수록 살짝 어둡게(상의가 덮여 생기는 그늘)
          const f = 1 - 0.16 * (k / Math.max(1, gTop[x] - started));
          const i2 = (y * W + x) * 4;
          d[i2] = c[0] * f; d[i2 + 1] = c[1] * f; d[i2 + 2] = c[2] * f;
          any = true;
        }
      }
      if (any) ctx.putImageData(img, 0, 0);
    }
    // 상의: 새 옷이 반팔인데 원래 옷이 긴소매면 드러난 팔에 원래 소매가 남는다 → 피부로.
    // 팔은 원통이라 가운데가 밝고 가장자리가 어둡게, 원래 소매의 큰 명암(빛 방향)도 조금 살린다
    const skinC = scene.handColor || scene.skinColor;
    if (geo.armSkin && skinC) {
      // 선분까지 거리와 선분 위 위치(0~1)
      const segD = (x, y, a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return [Math.hypot(x - a.x - dx * t, y - a.y - dy * t), t];
      };
      let ax0 = W, ay0 = H, ax1 = 0, ay1 = 0;
      for (const sg of geo.armSkin) {
        ax0 = Math.min(ax0, sg.a.x - sg.R, sg.b.x - sg.R); ax1 = Math.max(ax1, sg.a.x + sg.R, sg.b.x + sg.R);
        ay0 = Math.min(ay0, sg.a.y - sg.R, sg.b.y - sg.R); ay1 = Math.max(ay1, sg.a.y + sg.R, sg.b.y + sg.R);
      }
      ax0 = Math.max(0, Math.floor(ax0)); ay0 = Math.max(0, Math.floor(ay0)); ax1 = Math.min(W - 1, Math.ceil(ax1)); ay1 = Math.min(H - 1, Math.ceil(ay1));
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      // 실제로 보이는 팔(분할에서 피부)의 중심선과 굵기를 팔마다 잰다: 관절 좌표로 잡은 선은 실제 팔보다
      // 바깥으로 치우칠 때가 있어, 원래 소매 자리에 칠한 피부가 팔에서 떠 보인다 → 실제 팔 선을 위로 이어 그린다
      const sides = [0, 1].map((side) => {
        const segs = geo.armSkin.slice(side * 2, side * 2 + 2);
        const rows = [];
        for (let y = ay0; y <= ay1; y += 2) {
          let l = Infinity, r = -Infinity;
          for (let x = ax0; x <= ax1; x++) {
            if (catAt(x, y) !== 2 || gA[(y * W + x) * 4 + 3] > 25) continue;
            if (!segs.some((sg) => segD(x, y, sg.a, sg.b)[0] <= sg.R)) continue;
            if (x < l) l = x;
            if (x > r) r = x;
          }
          if (r - l > 3) rows.push([y, (l + r) / 2, r - l]);
        }
        if (rows.length < 12) return null;
        // 중심선 x = a + b·y (최소제곱), 굵기는 중앙값
        let sy = 0, sx = 0, syy = 0, sxy = 0;
        for (const [y, cx] of rows) { sy += y; sx += cx; syy += y * y; sxy += y * cx; }
        const n = rows.length, den = n * syy - sy * sy;
        const b = den ? (n * sxy - sy * sx) / den : 0, a = (sx - b * sy) / n;
        const widths = rows.map((r) => r[2]).sort((p, q) => p - q);
        return { a, b, hw: (widths[widths.length >> 1] / 2) * 1.08 };
      });
      const pix = [];
      let lum = 0;
      for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) {
        const i = y * W + x;
        if (gA[i * 4 + 3] > 25 || catAt(x, y) !== 4) continue; // 새 옷 밑이거나 원래 옷이 아니면 그대로
        let best = Infinity, ring = false, near = 0, nearD = Infinity, above = false;
        geo.armSkin.forEach((sg, k) => {
          const [dist, t] = segD(x, y, sg.a, sg.b);
          const r = sg.ra + (sg.rb - sg.ra) * t;
          if (dist / r < best) best = dist / r;
          if (dist <= sg.R) ring = true;
          if (dist < nearD) {
            nearD = dist; near = k >> 1;
            // 위팔 시작점보다 위(어깨·목 옆)는 팔이 아니다: 피부를 칠하지 않는다
            above = k % 2 === 0 && ((x - sg.a.x) * (sg.b.x - sg.a.x) + (y - sg.a.y) * (sg.b.y - sg.a.y)) < 0;
          }
        });
        if (above) continue;
        const fit = sides[near];
        if (fit && ring) best = Math.abs(x - (fit.a + fit.b * y)) / fit.hw; // 실제 팔 선 기준
        if (best > 1) {
          // 팔 밖에 남은 원래 소매(헐렁한 소매 등): 배경으로 메운다
          if (ring) { (armHole || (armHole = new Uint8Array(W * H)))[i] = 1; }
          continue;
        }
        pix.push(i, best);
        lum += d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
      }
      if (pix.length > 40) {
        lum /= pix.length / 2;
        // 색: 이 사진에서 실제로 보이는 팔 피부(팔 둘레 안, 분할에서 피부) 중앙값. 없으면 손 색
        const armPx = [[], [], []];
        for (let y = ay0; y <= ay1; y += 2) for (let x = ax0; x <= ax1; x += 2) {
          if (catAt(x, y) !== 2) continue;
          let inArm = false;
          for (const sg of geo.armSkin) { const [dist] = segD(x, y, sg.a, sg.b); if (dist <= sg.ra) { inArm = true; break; } }
          if (!inArm) continue;
          const i = (y * W + x) * 4;
          if (!(d[i] > 60 && d[i] > d[i + 2])) continue;
          armPx[0].push(d[i]); armPx[1].push(d[i + 1]); armPx[2].push(d[i + 2]);
        }
        const med = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
        // 원통 명암의 평균(약 0.95)만큼 밝게 맞춰, 칠한 팔의 평균 밝기가 실제 팔과 같아지게
        const [r, g2, b] = armPx[0].length > 60 ? armPx.map((v) => med(v) / 0.95) : skinC;
        for (let k = 0; k < pix.length; k += 2) {
          const i = pix[k], t = pix[k + 1];
          const cyl = 0.62 + 0.45 * Math.sqrt(Math.max(0, 1 - t * t));                      // 원통 명암(가장자리로 갈수록 어둡게)
          const orig = Math.min(1.12, Math.max(0.85, (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / (lum || 1))); // 원래 명암 약간
          const f = cyl * (0.75 + 0.25 * orig);
          d[i * 4] = Math.min(255, r * f); d[i * 4 + 1] = Math.min(255, g2 * f); d[i * 4 + 2] = Math.min(255, b * f);
        }
        ctx.putImageData(img, 0, 0);
      }
    }
    // 새 바지가 원래 바지보다 짧으면 밑단 아래로 원래 바지가 보인다 → 발목 살색으로(원래 바지의 명암은 살린다)
    if (geo.ankles && scene.skinColor) {
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const ank = [];
      let lum = 0;
      for (let x = 0; x < W; x++) {
        if (gBottom[x] < 0) continue;
        for (let y = gBottom[x] + 1; y < H; y++) {
          const i = y * W + x;
          if (y > geo.ankles.yMax || !isOrig(x, y)) continue;
          const t = legT(x, y);
          if (t >= 1) continue;
          ank.push(i, t);
        }
      }
      if (ank.length) {
        // 드러난 다리: 원래 바지의 무늬 대신 원통 명암(가운데 밝고 가장자리 어둡게)의 피부. 색은 손·팔 피부
        const [r, g2, b] = scene.handColor || scene.skinColor;
        for (let k = 0; k < ank.length; k += 2) {
          const i = ank[k], t = ank[k + 1];
          const f = 0.62 + 0.45 * Math.sqrt(Math.max(0, 1 - t * t));
          d[i * 4] = Math.min(255, r * f); d[i * 4 + 1] = Math.min(255, g2 * f); d[i * 4 + 2] = Math.min(255, b * f);
        }
        ctx.putImageData(img, 0, 0);
      }
    }
    // 팔 밖에 남은 원래 소매도 메울 범위에 넣는다(범위 계산 뒤에 정해지므로 여기서 넓힌다)
    if (armHole) {
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        if (!armHole[y * W + x]) continue;
        if (!box) box = { x0: x, y0: y, x1: x, y1: y };
        else { box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y); }
      }
    }
    if (box) {
      const pad = Math.round(W / 30);
      box = { x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(W - 1, box.x1 + pad), y1: Math.min(H - 1, box.y1 + pad) };
      const img = ctx.getImageData(0, 0, W, H);
      // 새 옷 아래에 깔린 원래 옷 픽셀도 채움 재료에서 뺀다(안 그러면 지운 자리가 원래 옷 색으로 다시 채워진다)
      // 다리 아래쪽은 분할이 원래 바지를 배경으로 볼 때가 있어 색으로도 거른다
      const legY = (z0 + H) / 2;
      const under = (x, y) => gA[(y * W + x) * 4 + 3] > 25 && (catAt(x, y) === 4 || (origC && y > legY && nearOrig(x, y, 70)));
      // 메울 곳 표시(드러난 자리 + 새 옷 밑의 원래 옷: 원래 옷 무늬가 메움 재료로 쓰이지 않게)와 그 지문
      const holeMask = new Uint8Array(W * H);
      let key = 0;
      for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
        if (hole(x, y)) { holeMask[y * W + x] = 2; key = (key * 31 + y * W + x) % 1000000007; }
        // AI가 참고하면 안 되는 곳: 새 옷 밑의 원래 옷, 그리고 사람(피부·얼굴·머리·소품). 손 옆 구멍에 가짜 손이 생기지 않게
        else if (under(x, y) || catAt(x, y) !== 0) holeMask[y * W + x] = 1;
      }
      key = `${box.x0},${box.y0},${box.x1},${box.y1}:${key}`;
      lastHole = { mask: holeMask, box, key };
      const ai = scene.aiPatch && scene.aiPatch.key === key ? scene.aiPatch : (scene.aiPatches?.get(key) || null);
      if (ai) {
        // AI(MI-GAN, models.js)가 메운 조각에서 드러난 자리만 가져온다
        const pd = ai.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, ai.canvas.width, ai.canvas.height).data;
        const pw = ai.canvas.width, d = img.data;
        for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
          if (holeMask[y * W + x] !== 2) continue;
          const i = (y * W + x) * 4, q = ((y - box.y0) * pw + (x - box.x0)) * 4;
          d[i] = pd[q]; d[i + 1] = pd[q + 1]; d[i + 2] = pd[q + 2];
        }
      } else {
        inpaint(img, W, (x, y) => hole(x, y) || under(x, y), box);
      }
      ctx.putImageData(img, 0, 0);
    }
    // 입체 명암(models.js의 깊이 추정): 몸이 돌아가는 곳은 어둡게, 빛을 받는 곳은 밝게.
    // 명암 지도를 옷 모양으로 잘라 overlay로 얹는다(옷 밖에는 영향 없음)
    if (scene.depthShade) {
      const sh = buf('depthShade', W, H);
      const sg = sh.getContext('2d');
      sg.globalCompositeOperation = 'source-over';
      sg.clearRect(0, 0, W, H);
      sg.drawImage(scene.depthShade, 0, 0, W, H);
      sg.globalCompositeOperation = 'destination-in';
      sg.drawImage(G, 0, 0);
      sg.globalCompositeOperation = 'source-over';
      const gg2 = G.getContext('2d');
      gg2.save();
      gg2.globalCompositeOperation = 'overlay';
      gg2.globalAlpha = scene.isAvatar ? 0.5 : 0.35; // 아바타 명암은 3D 조명에서 온 것
      gg2.drawImage(sh, 0, 0);
      gg2.restore();
    }
    finishGarment(G, W, H);
    lastGarment = G;
    ctx.drawImage(G, 0, 0);

    // 손·팔뚝: 소매 안은 빼고 옷 위로
    const front = buf('front', W, H);
    const fg = front.getContext('2d');
    fg.globalCompositeOperation = 'source-over';
    fg.clearRect(0, 0, W, H);
    fg.strokeStyle = '#fff';
    strokeSegs(fg, geo.hands);
    if (geo.noSkin.length) {
      fg.globalCompositeOperation = 'destination-out';
      fg.fillStyle = '#fff';
      for (const pts of geo.noSkin) {
        fg.beginPath();
        pts.forEach((p, i) => (i ? fg.lineTo(p.x, p.y) : fg.moveTo(p.x, p.y)));
        fg.closePath();
        fg.fill();
      }
    }
    fg.globalCompositeOperation = 'source-in';
    fg.drawImage(scene.armsSkin || scene.skin, 0, 0, W, H); // 아바타는 팔·손만 있는 층
    fg.globalCompositeOperation = 'source-over';
    ctx.drawImage(front, 0, 0);
    // 손에 든 물건(휴대폰 등): 손 둘레 안의 소품 픽셀만
    if (scene.others && geo.props) {
      fg.clearRect(0, 0, W, H);
      fg.strokeStyle = '#fff';
      strokeSegs(fg, geo.props);
      fg.globalCompositeOperation = 'source-in';
      fg.drawImage(scene.others, 0, 0, W, H);
      fg.globalCompositeOperation = 'source-over';
      ctx.drawImage(front, 0, 0);
    }
    ctx.drawImage(scene.head, 0, 0, W, H);
  }

  // 끼는 곳: 빨간 점선
  function markTight(ctx, a, b, lw) {
    if (noMarks) return; // 옷 사진으로 입힌 실사 모드: 그림을 해치지 않게 문장으로만 안내
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
  // 바지 주름: 여유분(헐렁함)과 길이(바닥에 닿아 쌓이는지)로 위치와 진하기를 정한다
  function legFolds(legs, s, C, u) {
    const folds = [];
    for (const leg of legs) {
      const N = leg.outer.length;
      const sec = (j) => {
        const o = leg.outer[j], i = leg.inner[j];
        const w = len(sub(o, i)) || 1;
        return { c: mid(o, i), nrm: mul(sub(o, i), 1 / w), w };
      };
      const ease = Math.max(0, Math.min(1, (leg.tw - leg.twB) / leg.twB));
      const soft = { w: Math.max(1, s * 0.7), blur: Math.max(2, s * 1.3) };
      // 1) 헐렁하면 허벅지 아래로 세로로 늘어지는 주름 두 줄
      if (ease > 0.06) {
        const kStart = Math.max(3, Math.round((leg.kneeD / leg.L) * (N - 1)) - 2);
        for (const off of [leg.side > 0 ? 0.22 : -0.22]) {
          const pts = [];
          for (let j = kStart; j < N - 2; j++) {
            const { c, nrm, w } = sec(j);
            pts.push(add(c, mul(nrm, w * (off + 0.04 * Math.sin(j * 1.7 + off * 9)))));
          }
          const { nrm } = sec(Math.floor(N / 2));
          folds.push({ pts, ...soft, a: Math.min(0.18, 0.05 + ease * 0.35), hl: mul(nrm, s * 0.9) });
        }
      }
      // 2) 무릎: 살짝 처진 가로 주름 두 줄
      const kj = Math.max(2, Math.min(N - 3, Math.round((leg.kneeD / leg.L) * (N - 1))));
      for (const [dj, a0, a1] of [[-0.6, -0.3, 0.28], [0.35, -0.22, 0.32]]) {
        const j = Math.max(1, Math.min(N - 2, Math.round(kj + dj)));
        const { c, nrm, w } = sec(j);
        folds.push({ pts: across(c, nrm, w, a0, a1, 0.06), ...soft, a: 0.1 + ease * 0.12, hl: mul(u, s * 0.8) });
      }
      // 3) 밑단이 발목보다 길면 남는 길이만큼 밑단 위에 주름이 쌓인다(바닥에 닿으면 더 많이)
      const extraCm = (leg.L - leg.ankleAt) / s;
      const floorHits = leg.pts.filter((q) => q.p.y >= leg.floorY - 0.5).length;
      const stack = Math.min(4, Math.max(0, Math.round(extraCm / 2.5)) + Math.max(0, floorHits - 1));
      for (let k = 0; k < stack; k++) {
        const j = Math.max(1, N - 2 - k);
        const { c, nrm, w } = sec(j);
        const zig = k % 2 ? 0.07 : -0.05;
        folds.push({ pts: [add(c, mul(nrm, -w * 0.42)), add(add(c, mul(nrm, -w * 0.1)), mul(u, w * zig)), add(add(c, mul(nrm, w * 0.15)), mul(u, -w * zig)), add(c, mul(nrm, w * 0.42))],
          ...soft, a: 0.2, hl: mul(u, s * 0.9) });
      }
      // 4) 가랑이에서 허벅지 바깥으로 비스듬히 퍼지는 짧은 주름(몸에 붙는 바지일수록 진하게)
      if (ease < 0.25) {
        for (const t of [0.15, 0.45]) {
          const { c, nrm, w } = sec(Math.min(N - 1, 2));
          const from = add(C, mul(u, s * (1 + t * 3)));
          folds.push({ pts: [from, add(c, mul(nrm, w * (t - 0.1)))], ...soft, a: 0.1 * (1 - ease * 3), hl: mul(u, s * 0.7) });
        }
      }
    }
    return folds;
  }

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

    // 가랑이: 사진의 사람 분할에서 두 다리가 실제로 갈라지는 높이(가운데 세로줄에서 배경이 3줄 이어지는 첫 곳).
    // 바지는 여기서 밑위만큼 올라간 허리에 걸리고 총장은 그 허리에서 잰다. 분할이 없으면 관절 기준 어림값
    let C = add(hipMid, mul(u, thighLen * 0.1));
    if (o.seg) {
      const { cat, w, h } = o.seg;
      const col = Math.floor(((o.seg.mirror ? o.W - 1 - hipMid.x : hipMid.x) * w) / o.W);
      const r0 = Math.max(0, Math.floor((hipMid.y * h) / o.H)), r1 = Math.min(h - 3, Math.ceil(((hipMid.y + thighLen * 0.4) * h) / o.H));
      for (let r = r0; col >= 0 && col < w && r <= r1; r++) {
        if (cat[r * w + col] === 0 && cat[(r + 1) * w + col] === 0 && cat[(r + 2) * w + col] === 0) {
          const yC = (r * o.H) / h + 0.5 * s; // 바지 가랑이는 몸 가랑이 바로 아래
          if (yC > hipMid.y && yC < hipMid.y + thighLen * 0.35) C = add(hipMid, mul(u, (yC - hipMid.y) / (u.y || 1)));
          break;
        }
      }
    }
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
      return { side, outer, inner, L, polyLen, ankleAt, kneeD: kneeAt * polyLen, floorY, pts, tw, tight: 2 * g.thigh * give < body.thigh, twB, start };
    }).sort((a, b) => b.side - a.side); // +쪽 다리 먼저

    const [pos, neg] = legs;
    const poly = [
      add(T, mul(n, wW / 2)), add(Hl, mul(n, hW / 2)),
      ...pos.outer, ...pos.inner.slice().reverse(), C,
      ...neg.inner, ...neg.outer.slice().reverse(),
      sub(Hl, mul(n, hW / 2)), sub(T, mul(n, wW / 2)),
    ];
    const tex = o.texture && o.texture.category === 'bottom' ? o.texture : null;
    let wlL = sub(T, mul(n, wW / 2)), wlR = add(T, mul(n, wW / 2)); // 실제로 그린 바지 윗선 양 끝(아바타 허리 곡선용)
    let D0 = 0; // 바지를 실제로 그리기 시작하는 깊이(허리 위 T에서). 상품 사진에서 허리가 가려졌으면 0보다 크다
    if (tex) {
      // 허리 띠: 허리 밴드 위(T) → 엉덩이(Hl) → 가랑이(C) 7칸 + 다리 두 개(garmentsource.js의 원본 띠와 같은 구성)
      // 원본 허리 띠가 가랑이 아래 두 칸(9줄)까지 있으면 목표도 같이 늘리고, 다리 위에 겹친 부분은 서서히 투명하게 섞는다
      const sidePoly = (leg, sd) => [add(T, mul(n, (sd * wW) / 2)), add(Hl, mul(n, (sd * hW) / 2)), ...leg.outer];
      const rows = tex.ribbons.waist.length >= 9 ? 8 : 6;
      const dst = [];
      const dC = dot(sub(C, T), u);
      // 상품 사진에서 상의가 허리를 덮어 바지 윗부분이 조금만 보이면, 그 조금을 밑위 전체로 늘리지 않고
      // 실제 크기(다리 길이로 잰 상품 사진 배율)대로 가랑이 쪽에만 붙인다. 덮인 위쪽은 내 사진의 상의가 그대로 보인다
      const w0 = tex.ribbons.waist[0], w6 = tex.ribbons.waist[6];
      const srcLegs = (tex.ribbons.legs || []).filter(Boolean).map((l) => l.lengthPx).filter((v) => v > 0);
      D0 = 0;
      if (w0 && w6 && srcLegs.length && g.length > g.rise) {
        const srcPerCm = Math.max(...srcLegs) / (g.length - g.rise);
        const visCm = (w6[0].y - w0[0].y) / srcPerCm;
        if (visCm < g.rise * 0.8) D0 = Math.max(0, dC - Math.min(dC, visCm * 1.1 * s));
      }
      wlL = atDepth(sidePoly(neg, -1), T, u, D0); wlR = atDepth(sidePoly(pos, 1), T, u, D0);
      for (let k = 0; k <= rows; k++) {
        const D = D0 + (dC - D0) * (k / 6);
        dst.push([atDepth(sidePoly(neg, -1), T, u, D), atDepth(sidePoly(pos, 1), T, u, D)]);
      }
      const pairs = [];
      const targets = legs.slice().sort((a, b) => a.start.x - b.start.x);
      targets.forEach((leg, i) => {
        const srcLeg = tex.ribbons.legs?.[i];
        if (srcLeg) pairs.push({ src: srcLeg.ribbon, dst: leg.outer.map((p, j) => [p, leg.inner[j]]), fill: true });
      });
      const ext = ((dC - D0) * 2) / 6; // 가랑이 아래로 겹치는 길이
      const fade = rows > 6 ? { from: sub(C, mul(u, ext * 0.15)), to: add(C, mul(u, ext * 0.95)) } : null;
      pairs.push({ src: tex.ribbons.waist.slice(0, rows + 1), dst, fade, fill: true });
      paintTexture(ctx, tex.texture, pairs, legFolds(legs, s, C, u));
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

    // 끼는 곳 표시(자세가 나쁜 사진에서 관절 간격으로 추정한 몸 치수와는 비교하지 않는다)
    const unsure = (k) => body.estimated.includes(k) && (o.poseIssues || []).length > 0;
    if (2 * g.waist * give < body.waist && !unsure('waist')) {
      markTight(ctx, sub(T, mul(n, wW / 2)), add(T, mul(n, wW / 2)), lw);
      notes.push(`허리가 몸보다 ${cmText(body.waist - 2 * g.waist)} 작아요.`);
    }
    if (2 * gHip * give < body.hip && !unsure('hip')) {
      markTight(ctx, sub(Hl, mul(n, hW / 2)), add(Hl, mul(n, hW / 2)), lw);
      notes.push(`엉덩이가 몸보다 ${cmText(body.hip - 2 * gHip)} 작아요.`);
    }
    if (pos.tight && !unsure('thigh')) {
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

    if (body.estimated.length) {
      notes.push((o.poseIssues || []).length
        ? '이 사진 자세로는 몸 치수를 추정하기 어려워서 몸과의 비교(끼는 곳)는 뺐어요. 내 체형 탭에 줄자로 잰 치수를 넣으면 비교해 드려요.'
        : '몸 치수 일부를 관절 간격으로 추정했어요. 내 체형에 치수를 넣으면 더 정확해요.');
    }
    if (guessed.length) notes.push(`사이즈표에 ${guessed.join('·')} 실측이 없어서 다른 치수로 추정해 그렸어요.`);
    // 밑단 아래 원래 바지를 지울 수 있는 가장 낮은 줄: 발목과 발꿈치 사이(그 아래는 신발)
    const ankY = Math.max(P(27).y, P(28).y);
    const ankleMax = ankY + 0.85 * Math.max(0, Math.max(P(29).y, P(30).y, P(31).y, P(32).y) - ankY);
    return { ok: true, notes, geo: { ...bodyGeo(P, s, body), noSkin: [], zone: [T.y - 3 * s, o.H], ankles: { yMax: ankleMax, segs: [[25, 27, 29], [26, 28, 30]].flatMap(([k, a, h]) => [{ a: P(k), b: P(a), ra: 5.2 * s, rb: 3.4 * s }, { a: P(a), b: P(h), ra: 3.4 * s, rb: 3.2 * s }]) }, bandTop: T.y, waistLine: { l: wlL, r: wlR, u, show: true }, hipClip: { y0: T.y - 4 * s, y1: C.y + 2 * s, r: (0.8 + Math.max(0, 2 * gHip - body.hip) / 6.3) * s }, s }, waistTop: add(T, mul(u, D0)) };
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

  // 실제 어깨 윤곽선: 열(x)마다 위에서 내려가며 처음 만나는 몸(피부 2·옷 4) 픽셀의 y. 머리카락·얼굴(1·3)·소품(5)·배경(0)은 건너뛴다.
  // seg: { cat, w, h, mirror }(mirror면 분할은 좌우 반전 전 영상 기준). 찾지 못하면 null
  function shoulderContour(seg, W, H, yFrom, yTo) {
    const { cat, w, h } = seg;
    const cache = new Map();
    return (x) => {
      const cx = Math.round(x);
      if (cache.has(cx)) return cache.get(cx);
      let col = Math.floor(((seg.mirror ? W - 1 - cx : cx) * w) / W);
      let y = null;
      if (col >= 0 && col < w) {
        const r0 = Math.max(0, Math.floor((yFrom * h) / H)), r1 = Math.min(h - 1, Math.ceil((yTo * h) / H));
        for (let r = r0; r <= r1; r++) {
          const c = cat[r * w + col];
          // 피부·옷만(소품 5는 빼야 마스크 끈·가방끈을 어깨로 착각하지 않는다). 7: 코디에서 먼저 입힌 옷
          if (c === 2 || c === 4 || c === 7) { y = ((r + 0.5) * H) / h; break; }
        }
      }
      cache.set(cx, y);
      return y;
    };
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

    // 옷은 어깨에 걸린다: 사진 속 실제 어깨 윤곽선을 먼저 찾아 옷깃 옆 꼭대기(HPS)와 어깨 봉제선을 그 위에 올린다.
    // 총장은 HPS부터, 소매는 봉제선부터 재므로, 작은 옷은 자리가 바뀌지 않고 밑단·소매 끝이 짧아진다.
    // 분할 결과가 없으면(라이브 초기 등) 관절 기준 어림값
    const contour = o.seg ? shoulderContour(o.seg, o.W, o.H, M.y - torso * 0.7, M.y + torso * 0.35) : null;
    // p에서 방향 dir로 나가며 몸(피부 2·옷 4) 픽셀이 끝나는 거리(px). 분할이 없거나 시작점이 몸 밖이면 null
    const bodyEdge = (p, dir, maxD) => {
      const sg = o.seg;
      if (!sg) return null;
      const at = (x, y) => {
        const cx = Math.floor(((sg.mirror ? o.W - 1 - x : x) * sg.w) / o.W), cy = Math.floor((y * sg.h) / o.H);
        if (cx < 0 || cy < 0 || cx >= sg.w || cy >= sg.h) return false;
        const c = sg.cat[cy * sg.w + cx];
        return c === 2 || c === 4;
      };
      if (!at(p.x, p.y)) return null;
      const step = Math.max(1, o.W / sg.w);
      let last = 0;
      for (let t = step; t <= maxD; t += step) { if (at(p.x + dir.x * t, p.y + dir.y * t)) last = t; else break; }
      return last;
    };
    let HPS = sub(M, mul(u, 4 * s));                           // 옷깃 옆 어깨 가장 높은 곳
    if (contour) {
      // 관절 기준 어림값에서 너무 멀리 떨어진 값(머리카락·잡힌 물건)은 버리고, 양쪽 차이가 크면 낮은 쪽(어깨에 가까운 쪽)을 믿는다
      const guessY = M.y - 4 * s;
      const ys = [-1, 1].map((sd) => contour(add(M, mul(n, sd * 7.5 * s)).x))
        .filter((v) => v != null && v > guessY - 7 * s && v < guessY + 6 * s);
      if (ys.length) {
        const pick = ys.length === 2 && Math.abs(ys[0] - ys[1]) > 3 * s ? [Math.max(...ys)] : ys;
        const yN = pick.reduce((a, b) => a + b, 0) / pick.length - 0.4 * s; // 천 두께만큼 살짝 위
        const t = Math.max(-11 * s, Math.min(-1 * s, (yN - M.y) / (u.y || 1)));
        HPS = add(M, mul(u, t));
      }
    }
    const drop = Math.max(0, (g.shoulder - body.shoulder) / 2); // 몸 어깨보다 넓으면 어깨선이 팔로 내려온다
    const seamGuess = (side) => add(add(M, mul(n, (side * g.shoulder * s) / 2)), mul(u, (drop * 0.8 - 1) * s));
    // 봉제선: 어깨 너비 위치의 실제 어깨 윤곽 위. 옷 어깨가 몸보다 넓으면 윤곽이 팔로 내려가므로 저절로 드롭숄더가 된다
    const seam = (side) => {
      const b = seamGuess(side);
      if (!contour) return b;
      const halfG = (g.shoulder * s) / 2, halfB = (body.shoulder * s) / 2;
      // 옷 어깨가 몸보다 넓으면: 내 어깨 끝(윤곽선) 높이에서 넓은 만큼 팔 쪽으로 흘러내린다(드롭숄더).
      // 봉제선 자리를 그대로 재면 몸 밖이라 한쪽은 팔이, 한쪽은 빈 곳이 잡혀 좌우가 달라진다
      const atX = halfG > halfB ? add(M, mul(n, side * halfB * 0.92)).x : b.x;
      const y = contour(atX);
      // 봉제선은 목 옆 꼭대기보다 높을 수 없고, 겨드랑이보다 낮을 수 없다(엉뚱한 윤곽은 어림값으로)
      if (y == null || y < HPS.y - 1 * s || y > M.y + torso * 0.25) return b;
      const dropPx = halfG > halfB ? Math.max(0, drop) * 0.8 * s : 0;
      return V(b.x, y - 0.3 * s + dropPx);
    };
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
    // 몸판 윗선: 목 옆 → 봉제선. 실제 어깨 윤곽이 직선보다 높으면 그 윤곽(0.6cm 위)을 따라간다(어깨 꼭대기 살이 비치지 않게)
    const topEdge = (sd) => {
      const a = add(HPS, mul(n, sd * neckW)), b = seam(sd), pts = [];
      for (let k = 1; k < 8; k++) {
        const q = lerpV(a, b, k / 8);
        const y = contour ? contour(q.x) : null;
        pts.push(y != null && y < q.y && y > q.y - 6 * s ? V(q.x, y - 0.6 * s) : q);
      }
      return pts;
    };
    const bodyPoly = [
      seam(-1), ...topEdge(-1).reverse(), ...neck, ...topEdge(1), seam(1),
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
    const folds = [];
    const soft = { w: Math.max(1, s * 0.7), blur: Math.max(2, s * 1.3) };
    if (g.sleeve != null) {
      for (const [shI, elI, wrI, fiI] of [[11, 13, 15, 19], [12, 14, 16, 20]]) {
        const side = Math.sign(dot(sub(P(shI), M), n)) || 1;
        const sp = seam(side), ap = armpit(side);
        const elbow = P(elI), wrist = P(wrI), finger = P(fiI);
        // 소매 길이는 봉제선(sp)부터 잰다. 관의 중심선은 진동 가운데(S0)에서 시작하므로 그만큼 길이를 맞춘다
        const armPath = [sp, elbow, wrist, finger];
        // 팔을 내리고 있으면(lift 작음) 진동(어깨 끝→겨드랑이)은 팔과 나란한 세로선이다. 그 길이를 소매 단면 폭으로 쓰면
        // 소매가 옆으로 10cm쯤 튀어나와 어깨 패드처럼 보인다 → 소매는 위팔 중심(어깨 관절 쪽)에서 시작해 팔 굵기만큼만
        const lift0 = 1 - dot(norm(sub(elbow, sp)), u);
        const hang = Math.max(0, Math.min(1, 1 - lift0 / 0.3));
        const S0 = lerpV(mid(sp, ap), lerpV(mid(sp, ap), P(shI), 0.7), hang);
        const tubePath = [S0, elbow, wrist, finger];
        const toWrist = arcTo(armPath, wrist);
        const L = g.sleeve * s;
        const Lc = Math.max(L * 0.3, L - (toWrist - arcTo(tubePath, wrist)));
        const { pts } = walk(tubePath, Lc, 16);
        const armholeW = Math.max(len(sub(sp, ap)), 11 * s);
        const hangW = Math.max(12 * s, Math.min(armholeW * 0.62, 18 * s)); // 내린 팔의 소매 폭(위팔 + 여유)
        const startW = lerp(armholeW, hangW, hang);
        // 소매 끝은 겨드랑이보다 좁다(반팔도 끝으로 갈수록 좁아져야 상자처럼 안 보인다)
        const endW = g.sleeve > 40 ? Math.max(startW * 0.55, 8 * s) : Math.max(startW * 0.72, 10 * s);
        const outer = [], inner = [];
        pts.forEach(({ p, dir, d }) => {
          let nl = V(-dir.y, dir.x);
          if (dot(nl, n) * side < 0) nl = mul(nl, -1);   // 바깥쪽을 향하게
          const w = lerp(startW, endW, d / Lc) / 2;
          // 소매는 팔을 덮어야 한다: 사진(분할)에서 팔 바깥 가장자리까지 재서 모자라면 넓힌다(어깨 끝 살이 비치지 않게)
          const edge = bodyEdge(p, nl, w * 1.7);
          const wo = edge != null ? Math.max(w, Math.min(w * 1.6, edge + 0.8 * s)) : w;
          outer.push(add(p, mul(nl, wo)));
          inner.push(sub(p, mul(nl, w)));
        });
        const inner0 = inner[0];
        outer[0] = sp; // 소매 시작은 봉제선과 겨드랑이에 딱 붙인다(어깨 위로 튀어나오지 않게)
        // 내린 팔: 소매 안쪽 시작을 겨드랑이(몸판 옆)까지 끌어오면 안쪽 선이 갈고리처럼 꺾인다 → 소매 자체의 안쪽 선을 쓴다
        inner[0] = lerpV(ap, inner0, hang * 0.85);
        // 팔을 들면(위팔이 아래 방향에서 45° 넘게 벌어지면) 소매 시작선을 어깨 봉제선을 축으로 돌려 위팔에 수직이 되게 한다.
        // 그대로 두면 시작선은 "어깨 끝→겨드랑이"인데 소매는 위로 뻗어 비틀린 리본처럼 보인다
        const upArm = norm(sub(elbow, sp));
        const lift = 1 - dot(upArm, u); // 0 = 팔을 내림, 1 = 수평, 2 = 머리 위
        if (lift > 0.3) {
          let perp = V(-upArm.y, upArm.x);
          if (dot(perp, sub(M, sp)) < 0) perp = mul(perp, -1); // 몸 쪽(겨드랑이 쪽)을 향하게
          const rot = add(sp, mul(perp, len(sub(ap, sp))));
          const t = Math.min(1, (lift - 0.3) / 0.7);
          inner[0] = lerpV(ap, rot, t);
          for (let j = 1; j < Math.min(3, inner.length); j++) inner[j] = lerpV(inner[j], add(outer[j], mul(perp, len(sub(inner[j], outer[j])))), t * (1 - j / 3));
        }
        // 어깨 끝 덮개: 봉제선과 다음 바깥 점 사이 직선이 둥근 어깨를 가로지르면 살이 비친다 → 그 사이를 어깨 윤곽 밖으로 민 점 2개
        const capPts = [];
        if (outer.length > 1) {
          for (const t of [0.35, 0.7]) {
            const q = lerpV(outer[0], outer[1], t), dirq = norm(sub(q, S0));
            const e = bodyEdge(S0, dirq, 14 * s);
            const dq = len(sub(q, S0));
            capPts.push(e != null && e + 0.8 * s > dq ? add(S0, mul(dirq, e + 0.8 * s)) : q);
          }
        }
        sleeves.push([outer[0], ...capPts, ...outer.slice(1), ...inner.slice().reverse()]);
        sleeveTargets.push({ startX: sp.x, rib: outer.map((p, i) => [p, inner[i]]), poly: sleeves[sleeves.length - 1] });
        // 팔꿈치를 덮는 소매: 팔꿈치 안쪽에 짧은 주름(팔을 굽힐수록 진하게)
        const toElbow = arcTo(tubePath, elbow);
        if (Lc > toElbow + 3 * s) {
          const up = norm(sub(elbow, P(shI))), fore = norm(sub(wrist, elbow));
          const bend = Math.max(0, 1 - dot(up, fore)); // 0 = 쭉 편 팔, 1 = 직각
          const ej = Math.max(1, Math.min(pts.length - 2, Math.round((toElbow / Lc) * (pts.length - 1))));
          for (const dj of [-1, 0, 1]) {
            const j = Math.max(1, Math.min(pts.length - 2, ej + dj));
            const w = len(sub(outer[j], inner[j])) || 1;
            const nrm = mul(sub(outer[j], inner[j]), 1 / w);
            folds.push({ pts: across(mid(outer[j], inner[j]), nrm, w, -0.45, 0.1, 0.12), ...soft, a: 0.12 + bend * 0.35, hl: mul(pts[j].dir, s * 0.8) });
          }
        }
        const ck = outer.length - 2; // 끝에서 한 칸 안쪽(약 3~4cm)
        cuffs.push([outer[ck], inner[ck]]);
        const armOdd = (o.poseIssues || []).some((k) => k === 'armUp' || k === 'armCross' || k === 'face');
        if (side > 0 && !armOdd) {
          // 소매 끝 위치 안내(한쪽만). 팔을 들었거나 몸 앞에 있으면 손목 위치를 믿을 수 없어 뺀다
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
      // 어깨: 윗줄을 수평으로 두면 어깨가 각진 판처럼 뜬다. 몸판 윗부분(0~4줄)을 좌우 반쪽으로 나눠
      // 가운데(목)는 그대로 두고 양 끝만 내려서, 상품 사진의 어깨 관절이 내 어깨 봉제선(seam)에 오게 한다
      const srcT = tex.ribbons.torso;
      const f = tex.ribbons.shoulderFrac;
      const pairs = [];
      if (f != null && f < 0.95) {
        const dArm = dot(sub(armpitAt, HPS), u);
        const yoke = [];
        for (const sd of [-1, 1]) {
          const dSeam = dot(sub(seam(sd), HPS), u);
          // 몸판 윗모서리: 상품 사진의 어깨 관절이 봉제선에 오도록 정하되, 봉제선보다 2.5cm 넘게 위에 있지는 않게
          // (어깨가 넓은 옷에서 모서리가 목 높이에 남으면 어깨 끝이 수평 선반처럼 튀어나온다)
          const dTop = Math.max(0, (dSeam - f * dArm) / (1 - f), dSeam - 2.5 * s);
          const edgeTop = add(top(sd), mul(u, dTop));
          const src = [], dd = [];
          for (let k = 0; k <= 4; k++) {
            const r = byX(srcT[k]);
            const c = mid(r[0], r[1]);
            const cd = mid(dst[k][0], dst[k][1]);
            const e = lerpV(edgeTop, armpit(sd), k / 4);
            const leftHalf = e.x < cd.x; // 화면 왼쪽 반쪽이면 원본도 왼쪽 반쪽
            src.push(leftHalf ? [r[0], c] : [c, r[1]]);
            dd.push(leftHalf ? [e, cd] : [cd, e]);
          }
          yoke.push({ src, dst: dd });
        }
        pairs.push(...yoke, { src: srcT.slice(4), dst: dst.slice(4), fill: true });
        // 어깨 덮개: 옷은 둥근 어깨 면을 덮고 내려간다. 몸판 윗선(목 옆 → 봉제선 직선)이 어깨 꼭대기를 가로지르면
        // 그 사이로 원래 옷이 보이므로, 실제 윤곽을 따라 3cm 깊이 띠를 옷 모양에 더한다(천은 빈틈 메우기로 채워진다)
        if (contour) {
          pairs.caps = [-1, 1].map((sd) => {
            const neckPt = add(HPS, mul(n, sd * 7.5 * s));
            const sp = seam(sd);
            const pts = [];
            for (let k = 0; k <= 8; k++) {
              const x = neckPt.x + ((sp.x - neckPt.x) * k) / 8;
              const y = contour(x);
              const yLine = neckPt.y + ((sp.y - neckPt.y) * k) / 8;
              // 윤곽이 없거나 직선보다 아래면(덮을 필요 없음) 직선 위
              pts.push(V(x, y != null && y < yLine ? y - 0.6 * s : yLine));
            }
            return [...pts, add(sp, mul(u, 3 * s)), add(neckPt, mul(u, 3 * s))];
          });
        }
      } else {
        pairs.push({ src: srcT, dst, fill: 4 }); // 목둘레(위 4줄)는 비워 둔다
      }
      // 소매: 화면 왼쪽 소매끼리, 오른쪽 소매끼리 짝짓기
      const srcSleeves = tex.ribbons.sleeves || [];
      const targets = sleeveTargets.slice().sort((a, b) => a.startX - b.startX);
      const plain = [];
      // 상품 사진 배율(가슴 단면 폭으로 잰 px/cm): 사진 속 소매가 실측보다 길면(팔을 굽혔거나 소매 끝을 잘못 잡았을 때)
      // 실측 길이만큼만 잘라 쓴다. 전부 쓰면 긴 소매가 짧은 소매 안에 눌려 가로 줄무늬가 된다
      const chestRow = tex.ribbons.torso[4];
      const srcPerCm = chestRow ? (chestRow[1].x - chestRow[0].x) / g.chest : 0;
      targets.forEach((t, i) => {
        const srcS = srcSleeves[i];
        if (srcS) {
          const want = g.sleeve * srcPerCm;
          const f = srcPerCm > 0 && srcS.lengthPx > want * 1.1 ? want / srcS.lengthPx : 1;
          let rib = f < 1 ? resample(srcS.ribbon, 41).slice(0, Math.max(3, Math.round(40 * f) + 1)) : srcS.ribbon;
          // 팔이 몸통에 붙은 사진은 소매가 좁게 잡힌다. 그걸 넓은 소매에 펴면 가로 줄무늬가 되므로,
          // 너무 늘려야 하면 몸판 아랫부분(무늬 없는 천)을 실제 크기 그대로 떼어 소매에 입힌다
          const avgW = (rows) => rows.reduce((a, r) => a + len(sub(r[0], r[1])), 0) / rows.length;
          const dstWcm = avgW(t.rib) / s;
          const srcWcm = srcPerCm > 0 ? avgW(rib) / srcPerCm : dstWcm;
          const ribLen = (rows) => { let L = 0; for (let j = 1; j < rows.length; j++) L += len(sub(mid(...rows[j]), mid(...rows[j - 1]))); return L; };
          const dstLen = ribLen(t.rib);
          const srcLcm = srcPerCm > 0 ? ribLen(rib) / srcPerCm : dstLen / s;
          if (srcPerCm > 0 && Math.max(dstWcm / srcWcm, dstLen / s / Math.max(1, srcLcm)) > 1.5 && srcT.length >= 14) {
            const yA = srcT[7][0].y, yB = srcT[13][0].y;
            const cxs = (srcT[10][0].x + srcT[10][1].x) / 2;
            const pw = Math.min(dstWcm * srcPerCm, (srcT[10][1].x - srcT[10][0].x) * 0.8);
            const ph = Math.min((dstLen / s) * srcPerCm, yB - yA);
            const N = t.rib.length;
            rib = [];
            for (let j = 0; j < N; j++) { const y = yA + (ph * j) / (N - 1); rib.push([V(cxs - pw / 2, y), V(cxs + pw / 2, y)]); }
          }
          pairs.push({ src: rib, dst: t.rib, fill: true });
        }
        else plain.push(t.poly); // 원본에 소매가 안 보이면 옷 평균색으로
      });
      // 몸판 주름: 겨드랑이에서 가슴 쪽으로 당기는 주름, 넉넉하면 세로로 늘어지는 주름, 길면 밑단 위에 가로 주름
      const ease = Math.max(0, Math.min(1, loose / Math.max(1, body.chest)));
      for (const sd of [-1, 1]) {
        const a0 = add(armpit(sd), mul(n, -sd * cw * 0.04));
        for (const k of [0, 1]) {
          folds.push({ pts: [a0, add(add(armpitAt, mul(n, sd * cw * (0.3 - k * 0.06))), mul(u, torso * (0.1 + k * 0.07)))], ...soft, a: 0.1 + ease * 0.15, hl: mul(u, s * 0.8) });
        }
        if (ease > 0.08) {
          for (const f2 of [0.2, 0.36]) {
            const top2 = add(add(armpitAt, mul(n, sd * cw * f2)), mul(u, torso * 0.12));
            const bot = add(hemC, mul(n, sd * hw * (f2 + 0.04)));
            folds.push({ pts: [top2, add(lerpV(top2, bot, 0.5), mul(n, sd * s * 0.8)), bot], ...soft, a: Math.min(0.28, 0.06 + ease * 0.5), hl: mul(n, sd * s * 0.9) });
          }
        }
      }
      if (o.tucked) {
        // 넣어 입기: 바지 허리 바로 위에서 천이 모이며 살짝 부푼다(블라우징) → 허리선 위에 처진 가로 주름 몇 줄
        for (const [k, a] of [[1.2, 0.22], [2.6, 0.18], [4.2, 0.12]]) {
          const c = sub(hemC, mul(u, (k + 4) * s)); // 숨은 4cm 위부터
          folds.push({ pts: across(c, n, hw * 1.15, -0.42, 0.42, 0.03), ...soft, a, hl: mul(u, s * 0.9) });
        }
      } else if (hemDepth > 1.02) {
        for (const k of [1, 2]) {
          const c = sub(hemC, mul(u, k * 2.6 * s));
          folds.push({ pts: across(c, n, hw, -0.4, 0.4, 0.02), ...soft, a: 0.1 + Math.min(0.12, (hemDepth - 1) * 0.5), hl: mul(u, s * 0.8) });
        }
      }
      paintTexture(ctx, tex.texture, pairs, folds);
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

    const unsure = (k) => body.estimated.includes(k) && (o.poseIssues || []).length > 0;
    if (2 * g.chest * give < body.chest && !unsure('chest')) {
      markTight(ctx, armpit(-1), armpit(1), lw);
      notes.push(`가슴이 몸보다 ${cmText(body.chest - 2 * g.chest)} 작아요.`);
    }
    if (drop >= 2) notes.push(`어깨선이 내 어깨보다 약 ${cmText(drop)} 내려와요(드롭숄더).`);
    else if (g.shoulder < body.shoulder - 2 && !unsure('shoulder')) notes.push(`어깨가 내 어깨보다 ${cmText(body.shoulder - g.shoulder)} 좁아요. 어깨가 낄 수 있어요.`);

    const hemVsHip = dot(sub(hemC, hipMid), u) / s;
    if (o.tucked) notes.push('밑단을 바지 허리 안에 넣어 입었어요.');
    else notes.push(hemVsHip >= 0 ? `밑단이 골반선보다 약 ${cmText(hemVsHip)} 아래로 내려와요.` : `밑단이 골반선보다 약 ${cmText(hemVsHip)} 위에 와요(짧은 기장).`);
    if (body.estimated.length) {
      notes.push((o.poseIssues || []).length
        ? '이 사진 자세로는 몸 치수를 추정하기 어려워서 몸과의 비교(끼는 곳)는 뺐어요. 내 체형 탭에 줄자로 잰 치수를 넣으면 비교해 드려요.'
        : '몸 치수 일부를 관절 간격으로 추정했어요. 내 체형에 치수를 넣으면 더 정확해요.');
    }
    if (guessed.length) notes.push(`사이즈표에 ${guessed.join('·')} 실측이 없어서 다른 치수로 추정해 그렸어요.`);
    const zoneTop = Math.min(HPS.y, seam(-1).y, seam(1).y) - 3 * s;
    // 팔 둘레(어깨~손목): 새 옷 밖으로 드러난 팔에 원래 옷 소매가 남아 있으면 피부로 바꾼다(composeScene)
    const armSkin = [[11, 13, 15], [12, 14, 16]].map(([a, b, c]) => [
      { a: lerpV(P(a), P(b), 0.12), b: P(b), ra: 4.6 * s, rb: 3.9 * s, R: 6.5 * s },
      { a: P(b), b: P(c), ra: 3.8 * s, rb: 2.7 * s, R: 5.5 * s },
    ]).flat();
    return { ok: true, notes, geo: { ...bodyGeo(P, s, body), noSkin: sleeves, armSkin, zone: [zoneTop, Math.max(hemC.y, hipMid.y) + 4 * s], shoulderClip: { y: armpitAt.y, r: (1.5 + drop * 0.6) * s, band: 4 * s }, neckHole: neck, s } };
  }

  // 아바타 옷 다듬기(3D 몸 실루엣을 알 때만). 상의는 1)·2)도:
  // 1) 겨드랑이 위(어깨·소매 윗부분)는 몸 실루엣을 r만큼 키운 안쪽만 남긴다 → 각진 어깨 모서리가 둥근 어깨를 따라간다
  // 2) 목둘레: 라운드넥 반타원 안쪽 천을 파내고(머리 층 아래가 수평으로 잘려 보이던 것) 목에 옷깃 그늘
  function avatarGarmentShape(G, geo) {
    const W = G.width, H = G.height;
    const gg = G.getContext('2d', { willReadFrequently: true });
    // 0) 반투명하게 번진 가장자리(상품 사진 오리기 경계)를 또렷하게: 소매·밑단이 두 겹으로 비치지 않게
    {
      const im = gg.getImageData(0, 0, W, H), d = im.data;
      for (let i = 3; i < d.length; i += 4) { const a = d[i]; if (a && a < 255) { const t = Math.min(1, Math.max(0, (a - 70) / 110)); d[i] = Math.round(255 * t * t * (3 - 2 * t)); } }
      gg.putImageData(im, 0, 0);
    }
    const c = geo.shoulderClip;
    if (c) {
      const m = buf('shoulderClip', W, H), mg = m.getContext('2d');
      mg.setTransform(1, 0, 0, 1, 0, 0);
      mg.globalCompositeOperation = 'source-over';
      mg.clearRect(0, 0, W, H);
      for (const f of [0.35, 0.7, 1]) for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        mg.drawImage(avatarBody, Math.cos(a) * c.r * f, Math.sin(a) * c.r * f, W, H);
      }
      const gr = mg.createLinearGradient(0, c.y - c.band, 0, c.y);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
      mg.fillStyle = gr; mg.fillRect(0, c.y - c.band, W, c.band);
      mg.fillStyle = '#000'; mg.fillRect(0, c.y, W, H - c.y);
      gg.save(); gg.globalCompositeOperation = 'destination-in'; gg.drawImage(m, 0, 0); gg.restore();
    }
    const nk = geo.neckHole;
    if (nk && nk.length > 2) {
      const s = geo.s || W / 200;
      const a = nk[0], b = nk[nk.length - 1];
      gg.save();
      gg.globalCompositeOperation = 'destination-out';
      gg.beginPath();
      gg.moveTo(a.x, a.y - 30 * s);
      nk.forEach((p) => gg.lineTo(p.x, p.y));
      gg.lineTo(b.x, b.y - 30 * s);
      gg.closePath();
      gg.filter = `blur(${Math.max(0.6, s * 0.15)}px)`;
      gg.fill();
      gg.restore();
      // 옷깃 두께: 목둘레 안쪽 가장자리를 살짝 어둡게(시보리 그늘)
      gg.save();
      gg.globalCompositeOperation = 'source-atop';
      gg.strokeStyle = 'rgba(0,0,0,0.28)';
      gg.lineWidth = 1.6 * s;
      gg.filter = `blur(${s * 0.5}px)`;
      gg.beginPath(); nk.forEach((p, i) => (i ? gg.lineTo(p.x, p.y) : gg.moveTo(p.x, p.y))); gg.stroke();
      gg.restore();
    }
    // 3) 바지 허리·엉덩이: 엉덩이 실루엣(몸 + 여유)을 넘는 각진 모서리는 잘라 골반을 감싸게,
    //    허리 윗선은 앞 가운데가 살짝 내려간 곡선(몸통을 두르는 띠를 약간 위에서 본 모양) + 위쪽 살에 닿는 그늘
    const hc = geo.hipClip;
    if (hc) {
      const m = buf('hipClip', W, H), mg = m.getContext('2d');
      mg.setTransform(1, 0, 0, 1, 0, 0);
      mg.globalCompositeOperation = 'source-over';
      mg.clearRect(0, 0, W, H);
      for (const f of [0.5, 1]) for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        mg.drawImage(avatarBody, Math.cos(a) * hc.r * f, Math.sin(a) * hc.r * f, W, H);
      }
      mg.fillStyle = '#000';
      mg.fillRect(0, 0, W, hc.y0); mg.fillRect(0, hc.y1, W, H - hc.y1);
      gg.save(); gg.globalCompositeOperation = 'destination-in'; gg.drawImage(m, 0, 0); gg.restore();
    }
    const wl = geo.waistLine;
    if (wl && wl.show) {
      const s = geo.s || W / 200;
      const dip = 1.3 * s;
      const c = { x: (wl.l.x + wl.r.x) / 2 + wl.u.x * dip * 2, y: (wl.l.y + wl.r.y) / 2 + wl.u.y * dip * 2 };
      gg.save();
      gg.globalCompositeOperation = 'destination-out';
      gg.beginPath();
      gg.moveTo(wl.l.x - 10 * s, wl.l.y - 30 * s); gg.lineTo(wl.l.x - 10 * s, wl.l.y - 0.2 * s); gg.lineTo(wl.l.x, wl.l.y);
      gg.quadraticCurveTo(c.x, c.y, wl.r.x, wl.r.y);
      gg.lineTo(wl.r.x + 10 * s, wl.r.y - 0.2 * s); gg.lineTo(wl.r.x + 10 * s, wl.r.y - 30 * s);
      gg.closePath(); gg.fill();
      gg.restore();
      // 허리 밴드 바로 위 살에 지는 얇은 그늘(밴드가 살을 살짝 누른다)
      gg.save();
      gg.globalCompositeOperation = 'destination-over';
      gg.filter = `blur(${0.7 * s}px)`;
      gg.strokeStyle = 'rgba(40,25,20,0.22)';
      gg.lineWidth = 1.4 * s;
      gg.beginPath(); gg.moveTo(wl.l.x + 1.5 * s, wl.l.y - 0.3 * s); gg.quadraticCurveTo(c.x, c.y - 0.6 * s, wl.r.x - 1.5 * s, wl.r.y - 0.3 * s); gg.stroke();
      gg.restore();
    }
  }

  function draw(ctx, opts) {
    // 옷을 그리기 전의 화면을 찍어 둔다(명암 지도용). 캔버스를 못 만드는 환경이면 건너뛴다
    photo = null;
    lastGarment = null;
    if (canMakeCanvas && ctx.canvas) {
      photo = buf('photo', ctx.canvas.width, ctx.canvas.height);
      const pg = photo.getContext('2d');
      pg.clearRect(0, 0, photo.width, photo.height);
      pg.drawImage(ctx.canvas, 0, 0);
    }
    shadeK = opts.scene?.shadeK ?? 1;
    drawCategory = opts.category;
    avatarShade = null;
    avatarBody = opts.scene?.isAvatar && canMakeCanvas ? opts.scene.skin : null; // 아바타 몸 실루엣(그림자를 몸 위에만)
    if (opts.scene?.isAvatar && canMakeCanvas) {
      avatarShade = opts.scene.depthShade || null;
      if (!avatarShade) { avatarShade = buf('flatShade', 4, 4); const fg = avatarShade.getContext('2d'); fg.fillStyle = '#808080'; fg.fillRect(0, 0, 4, 4); }
    }
    if (!opts.seg && opts.scene?.cat) opts = { ...opts, seg: opts.scene }; // 어깨 윤곽선용 분할
    liveMode = !!opts.live;
    // 팔을 들었거나 몸 앞을 가리면 옷 사진(팔 내린 모델)과 자세 차이가 커서, 하나로 휘면 몸판이 끌려간다 → 띠 방식
    armsFront = (opts.poseIssues || []).some((k) => k === 'armUp' || k === 'armCross' || k === 'face');
    // 바지는 두 다리 사이 틈이 구불구불해져서 띠 방식이 낫다 → 상의에만 쓴다
    useTPS = opts.tps !== false && opts.category === 'top' && !(opts.poseIssues || []).some((k) => k === 'armUp' || k === 'armCross') && !opts.scene?.isAvatar; // 아바타는 팔이 몸에 가까워 소매 끝과 밑단 대응점이 붙으면 TPS가 천을 소용돌이처럼 접는다 → 띠 방식
    const drawFn = opts.category === 'top' ? drawTop : drawBottom;
    noMarks = !!(opts.texture && opts.texture.category === opts.category);
    if (!(opts.scene && photo)) return drawFn(ctx, opts);
    // 사진 모드: 옷을 투명 캔버스에 따로 그린 뒤 사진과 합친다(원래 옷 정리, 손·얼굴 앞으로)
    const G = buf('garment', ctx.canvas.width, ctx.canvas.height);
    const gg = G.getContext('2d');
    gg.setTransform(1, 0, 0, 1, 0, 0);
    gg.clearRect(0, 0, G.width, G.height);
    const res = drawFn(gg, opts);
    if (res.ok && avatarBody) avatarGarmentShape(G, res.geo);
    if (res.ok) composeScene(ctx, G, opts.scene, res.geo);
    return res;
  }

  root.GarmentRender = { draw, visW, walk, inpaint, lastHole: () => lastHole, lastGarment: () => lastGarment };
  if (typeof module !== 'undefined') module.exports = root.GarmentRender;
})(typeof window !== 'undefined' ? window : globalThis);
