'use strict';

// ---------- 상품 사진에서 옷 가져오기 ----------
// 1) 옷만 오려낸다: MediaPipe 사람 부위 분할(머리·피부·옷...) 모델의 "옷" 영역
// 2) 옷의 뼈대를 찾는다: 사진 속 모델의 자세로 몸판·소매·다리를 나누고,
//    각 부분을 "가로 단면들의 띠(ribbon)"로 표현한다. 단면 = [왼쪽 끝, 오른쪽 끝] 두 점.
// garment.js가 이 띠를 실측 크기로 계산한 내 몸 위의 띠에 맞춰 조각조각 휘어 붙인다.
// 모두 기기 안에서 처리한다(무료, 사진 전송 없음). app.js의 mp, loadMediaPipe, photoToCanvas, detectPose를 쓴다.
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';
const SEG_CLOTHES = 4; // 0 배경, 1 머리카락, 2 몸 피부, 3 얼굴 피부, 4 옷, 5 기타(액세서리)
let clothesSegmenter = null;

async function getClothesSegmenter() {
  if (clothesSegmenter) return clothesSegmenter;
  const vision = await import(`${MP_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: SEG_MODEL, delegate },
    runningMode: 'IMAGE',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
  try {
    clothesSegmenter = await vision.ImageSegmenter.createFromOptions(fileset, opts('GPU'));
  } catch {
    clothesSegmenter = await vision.ImageSegmenter.createFromOptions(fileset, opts('CPU'));
  }
  return clothesSegmenter;
}

const GS = (() => {
  const V = (x, y) => ({ x, y });
  const add = (a, b) => V(a.x + b.x, a.y + b.y);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y);
  const mul = (a, k) => V(a.x * k, a.y * k);
  const len = (a) => Math.hypot(a.x, a.y);
  const norm = (a) => { const l = len(a) || 1; return V(a.x / l, a.y / l); };
  const mid = (a, b) => V((a.x + b.x) / 2, (a.y + b.y) / 2);
  const lerpP = (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

  // 꺾인 선 위에서 시작점부터 거리 d인 점과 진행 방향
  function along(path, d) {
    let acc = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = sub(path[i + 1], path[i]);
      const l = len(seg);
      if (d <= acc + l || i === path.length - 2) {
        const t = l ? Math.min(1.2, (d - acc) / l) : 0;
        return { p: add(path[i], mul(seg, t)), dir: norm(seg) };
      }
      acc += l;
    }
    return { p: path[path.length - 1], dir: V(0, 1) };
  }
  const pathLen = (path) => path.slice(1).reduce((s, p, i) => s + len(sub(p, path[i])), 0);

  // p에서 방향 dir로 마스크가 끝날 때까지 걸어간 거리(최대 max)
  function scan(on, p, dir, max) {
    let d = 0;
    while (d < max && on(p.x + dir.x * (d + 1), p.y + dir.y * (d + 1))) d++;
    return d;
  }

  // 길(path)을 따라 N개의 가로 단면을 만든다. 왼쪽/오른쪽은 화면 기준(x가 작은 쪽이 l)
  // innerLimit(p): 안쪽(몸 중심 쪽)으로 갈 수 있는 최대 거리(다리 사이·몸통과 붙은 소매 제한)
  function ribbonAlong(on, path, total, N, outward, maxHalf, innerLimit) {
    const secs = [];
    for (let i = 0; i < N; i++) {
      const { p, dir } = along(path, (total * i) / (N - 1));
      let nrm = V(-dir.y, dir.x);
      if (nrm.x * outward < 0) nrm = mul(nrm, -1); // 바깥쪽
      const o = Math.max(2, scan(on, p, nrm, maxHalf));
      const inMax = innerLimit ? innerLimit(p) : maxHalf;
      const inn = Math.max(2, scan(on, p, mul(nrm, -1), Math.max(2, inMax)));
      secs.push({ p, nrm, o, inn });
    }
    // 배경(커튼·의자 등)이 옷에 붙어 잡히면 그 단면만 튀게 넓어진다 → 중앙값의 1.35배로 자른다
    const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const mo = median(secs.map((s) => s.o)), mi = median(secs.map((s) => s.inn));
    // 반대로 너무 좁은 단면(옷 끝·가려진 곳)은 중앙값의 0.55배까지 넓힌다: 좁은 원본을 넓게 펴면 줄무늬가 생긴다(투명한 곳은 그려지지 않는다)
    const os = secs.map((s) => Math.max(mo * 0.55, Math.min(s.o, mo * 1.35 + 2)));
    const is = secs.map((s) => Math.max(mi * 0.55, Math.min(s.inn, mi * 1.35 + 2)));
    // 옆 단면과 평균 내서 폭이 들쭉날쭉하지 않게(양 끝은 그대로)
    const smooth = (arr) => arr.map((v, i) => (i === 0 || i === arr.length - 1 ? v : (arr[i - 1] + v * 2 + arr[i + 1]) / 4));
    const so = smooth(os), si = smooth(is);
    return secs.map(({ p, nrm }, i) => {
      const a = add(p, mul(nrm, so[i]));
      const b = sub(p, mul(nrm, si[i]));
      return a.x < b.x ? [a, b] : [b, a];
    });
  }

  return { V, add, sub, mul, len, norm, mid, lerpP, along, pathLen, scan, ribbonAlong };
})();

// 사진 속 모델이 입은 옷 분석. category: 'top' | 'bottom'
// 반환: { texture(옷만 남긴 캔버스), avgColor, ribbons, kind: 'model' | 'flat' }
async function analyzeGarmentPhoto(file, category) {
  await loadMediaPipe();
  const seg = await getClothesSegmenter();
  const canvas = await photoToCanvas(file, 1280);
  const W = canvas.width, H = canvas.height;
  const res = seg.segment(canvas);
  const cm = res.categoryMask;
  const mw = cm.width, mh = cm.height;
  const cat = Uint8Array.from(cm.getAsUint8Array());
  res.close?.();
  const sx = mw / W, sy = mh / H;
  const clothes = (x, y) => {
    const X = Math.floor(x * sx), Y = Math.floor(y * sy);
    return X >= 0 && Y >= 0 && X < mw && Y < mh && cat[Y * mw + X] === SEG_CLOTHES;
  };

  const det = detectPose(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H);
  let result;
  if (det && det.pose[11].visibility > 0.5 && det.pose[23].visibility > 0.4) {
    result = fromModelPhoto(det.pose, W, H, clothes, img, category);
  } else {
    result = fromFlatPhoto(W, H, img, category);
  }
  if (!result) return null;

  // 옷만 남긴 텍스처(가장자리 1px 부드럽게)
  const tex = document.createElement('canvas');
  tex.width = W;
  tex.height = H;
  const tg = tex.getContext('2d');
  const out = tg.createImageData(W, H);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!result.mask(x, y)) continue;
      out.data[i] = img.data[i];
      out.data[i + 1] = img.data[i + 1];
      out.data[i + 2] = img.data[i + 2];
      out.data[i + 3] = 255;
      if ((x + y) % 3 === 0) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    }
  }
  if (n < 200) return null; // 옷을 거의 못 찾음
  closeNotches(out, W, H, Math.max(3, Math.round(W * 0.012)));
  fillEnclosedHoles(out, W, H);
  if (result.coverFill) fillCoveredWaist(out, W, H, result.coverFill);
  // 옷 경계에서 배경이 옷으로 잘못 잡힌 조각 지우기: 평균색과 너무 다르고 가장자리에 붙은 픽셀
  const avg = [r / n, g / n, b / n];
  const far = (i) => Math.hypot(out.data[i] - avg[0], out.data[i + 1] - avg[1], out.data[i + 2] - avg[2]) > 110;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        if (!out.data[i + 3] || !far(i)) continue;
        const edge = !out.data[i - 4 + 3] || !out.data[i + 4 + 3] || !out.data[i - W * 4 + 3] || !out.data[i + W * 4 + 3];
        if (edge) out.data[i + 3] = 0;
      }
    }
  }
  tg.putImageData(out, 0, 0);
  // 가장자리를 살짝 흐리게(계단 현상 줄이기). 캔버스 filter를 못 쓰는 브라우저는 원본 그대로
  let texture = tex;
  if ('filter' in CanvasRenderingContext2D.prototype) {
    texture = document.createElement('canvas');
    texture.width = W;
    texture.height = H;
    const sg = texture.getContext('2d');
    sg.filter = 'blur(0.6px)';
    sg.drawImage(tex, 0, 0);
  }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  // 상품 사진의 조명 색(옷이 아닌 배경에서 가장 밝은 부분): 내 사진 조명에 맞출 때 쓴다(tryon.js)
  const illum = estimateIllum(img.data, W, H, (x, y) => !result.mask(x, y) && (result.kind === 'flat' || !clothes(x, y)));
  return {
    category,
    kind: result.kind,
    illum,
    texture,
    avgColor: `#${hex(r)}${hex(g)}${hex(b)}`,
    ribbons: result.ribbons,
    source: canvas,
  };
}

// 모델 착용 사진: 자세로 몸판·소매·다리를 나눈다
function fromModelPhoto(pose, W, H, clothes, img, category) {
  const { V, mid, pathLen, ribbonAlong } = GS;
  const P = (i) => V(pose[i].x * W, pose[i].y * H);
  const [shL, shR] = [P(11), P(12)].sort((a, b) => a.x - b.x);
  const [hipL, hipR] = [P(23), P(24)].sort((a, b) => a.x - b.x);
  const shoulderW = shR.x - shL.x;
  const shMid = mid(shL, shR), hipMid = mid(hipL, hipR);
  const torso = hipMid.y - shMid.y;
  const kneeY = (P(25).y + P(26).y) / 2;
  const wristY = Math.max(P(15).y, P(16).y);
  const cx = (shMid.x + hipMid.x) / 2;

  // 팔 선(어깨→팔꿈치→손목): 몸통 폭을 잴 때 팔을 빼기 위해
  const arms = [[11, 13, 15], [12, 14, 16]].map((ids) => ids.map(P)).sort((a, b) => a[0].x - b[0].x);
  const armX = (arm, y) => {
    for (let i = 0; i < arm.length - 1; i++) {
      const a = arm[i], b = arm[i + 1];
      if (y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y) && a.y !== b.y) return a.x + (b.x - a.x) * ((y - a.y) / (b.y - a.y));
    }
    return null;
  };
  const armHalf = shoulderW * 0.13;

  // 몸통 띠(가운데 영역): 이 밖은 소매나 손
  const bandL = Math.min(hipL.x, shL.x) - shoulderW * 0.1;
  const bandR = Math.max(hipR.x, shR.x) + shoulderW * 0.1;
  const inBand = (x) => x >= bandL && x <= bandR;

  // 상의/하의 경계: 골반 근처에서 옷 색이 가장 크게 바뀌는 줄
  const D = img.data;
  const rowColor = (y0, y1) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
      for (let x = Math.round(hipL.x); x <= Math.round(hipR.x); x += 2) {
        if (!clothes(x, y)) continue;
        const i = (y * W + x) * 4;
        r += D[i]; g += D[i + 1]; b += D[i + 2]; n++;
      }
    }
    return n ? [r / n, g / n, b / n] : null;
  };
  let split = hipMid.y, best = 0;
  const step = Math.max(2, Math.round(torso / 60));
  for (let y = shMid.y + torso * 0.45; y <= hipMid.y + (kneeY - hipMid.y) * 0.2; y += step) {
    const a = rowColor(y - step * 3, y), b = rowColor(y, y + step * 3);
    if (!a || !b) continue;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > best) { best = d; split = y; }
  }
  if (best < 25) split = hipMid.y; // 위아래 색이 같으면(원피스·셋업) 골반선에서 나눈다

  // 몸 모양 범위: 몸통 사다리꼴 + 팔·다리 관(넉넉하게). 배경(같은 색 커튼 등)이 옷으로 잡혀도 이 밖은 버린다
  const env = (() => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = g.strokeStyle = '#fff';
    g.beginPath();
    [V(shL.x - shoulderW * 0.45, shL.y - torso * 0.14), V(shR.x + shoulderW * 0.45, shR.y - torso * 0.14),
      V(hipR.x + shoulderW * 0.5, hipR.y + torso * 0.1), V(hipL.x - shoulderW * 0.5, hipL.y + torso * 0.1)]
      .forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
    g.lineCap = 'round';
    const tube = (ids, r) => {
      g.lineWidth = r * 2;
      g.beginPath();
      ids.map(P).forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
    };
    for (const arm of [[11, 13, 15, 19], [12, 14, 16, 20]]) tube(arm, shoulderW * 0.28);
    for (const leg of [[23, 25], [24, 26]]) tube(leg, shoulderW * 0.42);
    for (const leg of [[25, 27, 29], [26, 28, 30]]) tube(leg, shoulderW * 0.38);
    const a = g.getImageData(0, 0, W, H).data;
    return (x, y) => {
      x = Math.round(x); y = Math.round(y);
      return x >= 0 && y >= 0 && x < W && y < H && a[(y * W + x) * 4 + 3] > 100;
    };
  })();
  const clothesRaw = clothes;
  clothes = (x, y) => clothesRaw(x, y) && env(x, y);

  const sleeveZone = (x, y) => !inBand(x) && y < wristY + torso * 0.08;
  // 경계 부근(경계 ±15%)은 줄 하나로 딱 자르지 않고, 픽셀마다 위 옷/아래 옷 평균색 중 가까운 쪽으로 나눈다
  const zone = torso * 0.15;
  const topAvg = rowColor(split - zone * 2, split - zone * 0.3);
  const botAvg = rowColor(split + zone * 0.3, split + zone * 2);
  const isUpper = (x, y) => {
    if (y < split - zone) return true;
    if (y > split + zone || !topAvg || !botAvg || best < 25) return y < split;
    const i = (Math.round(y) * W + Math.round(x)) * 4;
    const dt = Math.hypot(D[i] - topAvg[0], D[i + 1] - topAvg[1], D[i + 2] - topAvg[2]);
    const db = Math.hypot(D[i] - botAvg[0], D[i + 1] - botAvg[1], D[i + 2] - botAvg[2]);
    return dt < db;
  };
  let mask;
  if (category === 'top') mask = (x, y) => clothes(x, y) && (isUpper(x, y) || sleeveZone(x, y));
  else mask = (x, y) => clothes(x, y) && !isUpper(x, y) && !sleeveZone(x, y);

  // 가운데에서 바깥으로 마스크 끝 찾기(팔 선 안쪽까지만)
  const rowEdges = (y) => {
    let l = cx, r = cx;
    if (!mask(Math.round(cx), Math.round(y))) {
      // 가운데가 비면(다리 사이 등) 가장 가까운 옷 픽셀부터
      let k = 0;
      while (k < shoulderW * 0.5 && !mask(Math.round(cx - k), Math.round(y)) && !mask(Math.round(cx + k), Math.round(y))) k++;
      // 이 줄에 옷이 없으면(상의에 가려진 바지 윗부분 등) 기본 폭: 그 칸은 투명이라 그려지지 않는다
      if (k >= shoulderW * 0.5) return [V(cx - shoulderW * 0.45, y), V(cx + shoulderW * 0.45, y)];
      l = r = mask(Math.round(cx - k), Math.round(y)) ? cx - k : cx + k;
    }
    // 팔 선에서 자르는 건 그 자리에 소매(옷)가 있을 때만: 팔이 맨살이면 옷의 실제 가장자리를 그대로 쓴다
    const aL = armX(arms[0], y), aR = armX(arms[1], y);
    const sleeveAt = (ax) => ax != null && mask(Math.round(ax), Math.round(y));
    const limL = sleeveAt(aL) ? aL + armHalf * 0.6 : bandL - shoulderW;
    const limR = sleeveAt(aR) ? aR - armHalf * 0.6 : bandR + shoulderW;
    while (l > limL && mask(Math.round(l - 1), Math.round(y))) l--;
    while (r < limR && mask(Math.round(r + 1), Math.round(y))) r++;
    return [V(l, y), V(r, y)];
  };

  if (category === 'top') {
    // 맨 위(목 옆)와 맨 아래(밑단) 찾기
    let topY = shMid.y;
    while (topY > shMid.y - torso * 0.35 && (mask(Math.round(shL.x + shoulderW * 0.25), Math.round(topY - 1)) || mask(Math.round(shR.x - shoulderW * 0.25), Math.round(topY - 1)))) topY--;
    // 밑단: 상의 색(가슴 쪽 평균)과 비슷한 천이 가운데 폭의 40% 이상 있는 마지막 줄.
    // 색만 보면 벨트·바지 허리가, 있고 없음만 보면 늘어진 끈·손이 밑단으로 잡혀 가로로 늘어난 줄무늬가 생긴다
    const ay = shMid.y + torso * 0.28;
    let tr = 0, tg = 0, tb = 0, tn = 0;
    for (let y = Math.round(ay); y < ay + torso * 0.3; y += 2) for (let x = Math.round(cx - shoulderW * 0.2); x <= cx + shoulderW * 0.2; x += 2) {
      if (!mask(x, y)) continue;
      const i = (y * W + x) * 4;
      tr += D[i]; tg += D[i + 1]; tb += D[i + 2]; tn++;
    }
    const topC = tn ? [tr / tn, tg / tn, tb / tn] : null;
    const isTop = (x, y) => {
      if (!mask(x, y)) return false;
      if (!topC) return true;
      const i = (Math.round(y) * W + Math.round(x)) * 4;
      return Math.hypot(D[i] - topC[0], D[i + 1] - topC[1], D[i + 2] - topC[2]) < 95;
    };
    let hemY = shMid.y;
    for (let y = Math.round(shMid.y); y < H; y++) {
      let hit = 0, tot = 0;
      for (let x = Math.round(cx - shoulderW * 0.3); x <= cx + shoulderW * 0.3; x += 3) { tot++; if (isTop(x, y)) hit++; }
      if (hit >= tot * 0.4) hemY = y; else if (y > hemY + 6) break;
    }
    if (hemY - topY < torso * 0.4) return null;
    const armpitY = shMid.y + torso * 0.28;
    const seamOut = shoulderW * 0.12;
    // 몸판 띠: 목 높이(어깨 끝 폭) → 겨드랑이 → 밑단
    const K1 = 4, K2 = 10;
    const torsoRibbon = [];
    for (let k = 0; k <= K1; k++) {
      const t = k / K1;
      const y = topY + (armpitY - topY) * t;
      // 목 높이에서는 어깨 끝(관절보다 조금 바깥)까지, 겨드랑이에서는 어깨 관절 x까지
      torsoRibbon.push([V(shL.x - seamOut * (1 - t), y), V(shR.x + seamOut * (1 - t), y)]);
    }
    for (let k = 1; k <= K2; k++) torsoRibbon.push(rowEdges(armpitY + (hemY - armpitY) * (k / K2)));
    // 너무 좁은 줄(가려진 곳·끈)은 위 줄 폭을 그대로 쓴다: 좁은 원본을 넓게 펴면 가로 줄무늬가 된다
    const widths = torsoRibbon.slice(K1 + 1).map((r) => r[1].x - r[0].x).sort((a, b) => a - b);
    const medW = widths[Math.floor(widths.length / 2)] || 0;
    for (let k = K1 + 1; k < torsoRibbon.length; k++) {
      const r = torsoRibbon[k], prev = torsoRibbon[k - 1];
      if (r[1].x - r[0].x < medW * 0.6) torsoRibbon[k] = [V(prev[0].x, r[0].y), V(prev[1].x, r[1].y)];
    }

    // 소매 띠: 어깨 → 팔꿈치 → 손목, 옷이 끝나는 곳까지
    const sleeves = arms.map((arm, si) => {
      const outward = si === 0 ? -1 : 1;
      const start = V(arm[0].x + outward * seamOut * 0.6, arm[0].y);
      const path = [start, arm[1], arm[2]];
      const total = pathLen(path);
      let end = 0, seen = false;
      for (let d = 0; d <= total * 1.15; d += 2) {
        const { p } = GS.along(path, d);
        let hit = false;
        // 몸통 쪽은 조금만 본다(팔이 몸에 붙어 있으면 옆구리 천을 소매로 착각해 소매가 길게 잡힌다)
        for (let o = -armHalf * 0.15; o <= armHalf * 0.6; o += 2) if (isTop(p.x + o * outward, p.y)) { hit = true; break; }
        if (hit) { end = d; seen = true; } else if (seen && d > end + 10) break;
      }
      if (end < shoulderW * 0.25) return null; // 민소매 등
      const innerLimit = (p) => Math.max(4, Math.abs(p.x - cx) - shoulderW * 0.35); // 몸통 쪽으로 너무 파고들지 않게
      return { ribbon: ribbonAlong(mask, path, end, 10, outward, shoulderW * 0.5, innerLimit), lengthPx: end };
    });
    return { kind: 'model', mask, ribbons: { torso: torsoRibbon, sleeves } };
  }

  // 하의: 허리 → 가랑이(몸판 띠) + 다리 두 개
  let topY = split;
  while (topY < hipMid.y + torso * 0.3 && !mask(Math.round(cx), Math.round(topY))) topY++;
  const thighLen = kneeY - hipMid.y;
  let crotchY = null;
  const crotchFrom = Math.max(Math.round(hipMid.y), Math.round(topY) + 2);
  for (let y = crotchFrom; y < crotchFrom + thighLen * 0.3; y++) {
    if (!mask(Math.round(hipMid.x), y) && !mask(Math.round(hipMid.x) - 1, y) && !mask(Math.round(hipMid.x) + 1, y)) { crotchY = y; break; }
  }
  if (crotchY == null) crotchY = Math.max(hipMid.y + thighLen * 0.1, topY + torso * 0.15);
  // 상의가 허리를 덮어 바지 윗부분이 거의 안 보이는 경우: 허리 띠를 일정 높이로 잡는다(가려진 곳은 투명이라 내 사진이 보인다)
  if (crotchY - topY < torso * 0.15) topY = crotchY - torso * 0.15;
  // 허리 띠는 줄마다 "가장 왼쪽 ~ 가장 오른쪽 바지 픽셀"로 잰다(가운데에서 재면 가랑이 줄에서 한쪽 다리만 잡힌다).
  // 상의에 가려 바지가 없는 줄은 바로 아래 줄의 폭을 그대로 쓴다(그 칸은 투명이라 그려지지 않는다)
  const hipHalf = Math.max(hipR.x - hipL.x, shoulderW * 0.6);
  const rowExtent = (y) => {
    const aL = armX(arms[0], y), aR = armX(arms[1], y);
    const lo = Math.max(cx - hipHalf * 1.4, aL != null ? aL + armHalf * 0.6 : -Infinity);
    const hi = Math.min(cx + hipHalf * 1.4, aR != null ? aR - armHalf * 0.6 : Infinity);
    let l = null, r = null;
    for (let x = Math.ceil(lo); x <= hi; x++) if (mask(x, Math.round(y))) { if (l == null) l = x; r = x; }
    return l == null ? null : [V(l, y), V(r, y)];
  };
  const waistRows = [];
  for (let k = 0; k <= 6; k++) waistRows.push(rowExtent(topY + 2 + (crotchY - topY - 2) * (k / 6)));
  for (let k = 5; k >= 0; k--) if (!waistRows[k] && waistRows[k + 1]) waistRows[k] = waistRows[k + 1].map((p) => V(p.x, topY + 2 + (crotchY - topY - 2) * (k / 6)));
  if (!waistRows[6]) return null;
  // 가랑이 아래로 두 칸 더(두 다리 바깥쪽 끝까지): 다리 띠와 겹쳐 부드럽게 섞어 이음매를 없앤다
  const rowStep = (crotchY - topY - 2) / 6;
  for (let k = 1; k <= 2; k++) waistRows.push(rowExtent(crotchY + rowStep * k) || waistRows[waistRows.length - 1].map((p) => V(p.x, crotchY + rowStep * k)));
  const waistRibbon = waistRows;
  // 바지 천이 실제로 보이기 시작하는 줄(가운데 기준)
  let visibleY = topY;
  while (visibleY < crotchY && !mask(Math.round(cx), Math.round(visibleY))) visibleY++;
  const coverFill = visibleY > topY + 3
    ? { poly: [...waistRibbon.map((r) => r[0]), ...waistRibbon.slice().reverse().map((r) => r[1])], yMax: visibleY + 3 }
    : null;
  const legs = [[23, 25, 27], [24, 26, 28]].map((ids) => ids.map(P)).sort((a, b) => a[0].x - b[0].x).map((leg, si) => {
    const outward = si === 0 ? -1 : 1;
    const start = V(leg[0].x, crotchY);
    const path = [start, leg[1], leg[2], V(leg[2].x, H)];
    let end = 0, seen = false;
    const total = pathLen(path);
    for (let d = 0; d <= total; d += 2) {
      const { p } = GS.along(path, d);
      let hit = false;
      for (let o = -shoulderW * 0.15; o <= shoulderW * 0.15; o += 2) if (mask(Math.round(p.x + o), Math.round(p.y))) { hit = true; break; }
      if (hit) { end = d; seen = true; } else if (seen && d > end + 10) break;
    }
    // 안쪽은 두 다리 사이 가운데선까지만
    const innerLimit = (p) => Math.max(3, Math.abs(p.x - hipMid.x) - 1);
    return { ribbon: ribbonAlong(mask, path, end, 12, outward, shoulderW * 0.45, innerLimit), lengthPx: end };
  });
  return { kind: 'model', mask, ribbons: { waist: waistRibbon, legs }, coverFill };
}

// 바닥에 펼친(플랫) 사진: 가장자리 색을 배경으로 보고 옷을 오려낸다. 몸판(바지는 다리까지)만 띠로 만든다
function fromFlatPhoto(W, H, img, category) {
  const { V } = GS;
  const D = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let x = 0; x < W; x += 4) for (const y of [2, H - 3]) { const i = (y * W + x) * 4; r += D[i]; g += D[i + 1]; b += D[i + 2]; n++; }
  for (let y = 0; y < H; y += 4) for (const x of [2, W - 3]) { const i = (y * W + x) * 4; r += D[i]; g += D[i + 1]; b += D[i + 2]; n++; }
  const bg = [r / n, g / n, b / n];
  const mask = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * 4;
    return Math.hypot(D[i] - bg[0], D[i + 1] - bg[1], D[i + 2] - bg[2]) > 38;
  };
  let y0 = -1, y1 = -1;
  const rowHas = (y) => { for (let x = 0; x < W; x += 3) if (mask(x, y)) return true; return false; };
  for (let y = 0; y < H; y++) if (rowHas(y)) { if (y0 < 0) y0 = y; y1 = y; }
  if (y0 < 0 || y1 - y0 < H * 0.2) return null;
  const cx = W / 2;
  const run = (y) => {
    let l = cx, rr = cx;
    while (l > 0 && mask(l - 1, y)) l--;
    while (rr < W - 1 && mask(rr + 1, y)) rr++;
    return [V(l, y), V(rr, y)];
  };
  const h = y1 - y0;
  if (category === 'top') {
    // 소매가 붙은 위쪽은 넓으니, 아래쪽(60%) 폭을 몸판 폭으로 보고 그 이상은 자른다
    const bodyHalf = (run(y0 + h * 0.6)[1].x - run(y0 + h * 0.6)[0].x) / 2;
    const torso = [];
    for (let k = 0; k <= 14; k++) {
      const y = y0 + h * (k / 14);
      const [a, b2] = run(y);
      torso.push([V(Math.max(a.x, cx - bodyHalf * 1.05), y), V(Math.min(b2.x, cx + bodyHalf * 1.05), y)]);
    }
    return { kind: 'flat', mask, ribbons: { torso, sleeves: [null, null] } };
  }
  // 바지: 위 30%는 허리 띠, 아래는 가운데를 기준으로 두 다리
  const crotch = y0 + h * 0.3;
  const waist = [];
  for (let k = 0; k <= 6; k++) waist.push(run(y0 + 1 + (crotch - y0 - 1) * (k / 6)));
  // 가랑이 아래 두 칸: 가운데가 비어 있으니 줄 전체에서 가장 왼쪽~오른쪽 옷 픽셀
  const extent = (y) => {
    let l = null, rr = null;
    for (let x = 0; x < W; x++) if (mask(x, y)) { if (l == null) l = x; rr = x; }
    return l == null ? waist[waist.length - 1].map((p) => V(p.x, y)) : [V(l, y), V(rr, y)];
  };
  for (let k = 1; k <= 2; k++) waist.push(extent(Math.round(crotch + ((crotch - y0 - 1) / 6) * k)));
  const legs = [-1, 1].map((sd) => {
    const rib = [];
    for (let k = 0; k <= 11; k++) {
      const y = crotch + (y1 - crotch) * (k / 11);
      let a = cx + sd * 2, b2 = a;
      while (Math.abs(a - cx) < W / 2 && !mask(a, y)) a += sd; // 다리 사이 빈 곳 건너기
      b2 = a;
      while (b2 > 0 && b2 < W - 1 && mask(b2 + sd, y)) b2 += sd;
      rib.push(a < b2 ? [V(a, y), V(b2, y)] : [V(b2, y), V(a, y)]);
    }
    return { ribbon: rib, lengthPx: y1 - crotch };
  });
  return { kind: 'flat', mask, ribbons: { waist, legs } };
}

// 옷 안에 완전히 갇힌 빈 곳(원본 모델의 손, 그림자, 앞을 가린 물건)을 찾아 주변 옷 색으로 메운다.
// 사진 가장자리와 이어진 빈 곳(다리 사이 등)은 진짜 바깥이라 그대로 둔다
function fillEnclosedHoles(out, W, H) {
  const d = out.data;
  const outside = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const j = y * W + x;
    if (outside[j] || d[j * 4 + 3]) return;
    outside[j] = 1;
    stack.push(j);
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const j = stack.pop(), x = j % W, y = (j - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  let box = null;
  const isHole = (x, y) => { const j = y * W + x; return !d[j * 4 + 3] && !outside[j]; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!isHole(x, y)) continue;
    if (!box) box = { x0: x, y0: y, x1: x, y1: y };
    else { box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y); }
  }
  if (!box) return;
  const holes = new Uint8Array(W * H);
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) if (isHole(x, y)) holes[y * W + x] = 1;
  // 구멍 주변의 "옷 픽셀"만 써서 채운다(배경 픽셀은 계산에서 뺀다)
  const pad = 8;
  const b = { x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(W - 1, box.x1 + pad), y1: Math.min(H - 1, box.y1 + pad) };
  GarmentRender.inpaint(out, W, (x, y) => holes[y * W + x] === 1 || !d[(y * W + x) * 4 + 3], b);
  for (let j = 0; j < holes.length; j++) if (holes[j]) d[j * 4 + 3] = 255;
}

// 가장자리의 작은 파임·틈 메우기(모폴로지 닫힘: 넓혔다가 다시 좁힘). 새로 생긴 칸은 주변 옷 색으로 채운다
function closeNotches(out, W, H, r) {
  const d = out.data;
  const m = new Uint8Array(W * H);
  for (let j = 0; j < m.length; j++) m[j] = d[j * 4 + 3] ? 1 : 0;
  // 상자 필터(누적합)로 넓히기/좁히기: 가로 → 세로
  const pass = (src, horiz, dilate) => {
    const dst = new Uint8Array(W * H);
    const L = horiz ? W : H, N = horiz ? H : W;
    for (let k = 0; k < N; k++) {
      const at = (t) => (horiz ? k * W + t : t * W + k);
      let sum = 0;
      for (let t = 0; t < Math.min(L, r); t++) sum += src[at(t)];
      for (let t = 0; t < L; t++) {
        if (t + r < L) sum += src[at(t + r)];
        if (t - r - 1 >= 0) sum -= src[at(t - r - 1)];
        const span = Math.min(L - 1, t + r) - Math.max(0, t - r) + 1;
        dst[at(t)] = dilate ? (sum > 0 ? 1 : 0) : (sum === span ? 1 : 0);
      }
    }
    return dst;
  };
  const closed = pass(pass(pass(pass(m, true, true), false, true), true, false), false, false);
  let any = false;
  for (let j = 0; j < m.length; j++) if (closed[j] && !m[j]) { any = true; break; }
  if (!any) return;
  GarmentRender.inpaint(out, W, (x, y) => !m[y * W + x], { x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
  for (let j = 0; j < m.length; j++) d[j * 4 + 3] = closed[j] ? 255 : 0;
}

// 상의에 가려 안 보이던 바지 허리 부분: 허리 띠 안쪽의 빈 곳을 바로 아래 바지 원단으로 이어 채운다
function fillCoveredWaist(out, W, H, { poly, yMax }) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.beginPath();
  poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.fill();
  const a = g.getImageData(0, 0, W, H).data;
  const d = out.data;
  const fill = (x, y) => y <= yMax && a[(y * W + x) * 4 + 3] > 100 && !d[(y * W + x) * 4 + 3];
  let box = null;
  for (let y = 0; y < Math.min(H, Math.ceil(yMax) + 1); y++) for (let x = 0; x < W; x++) {
    if (!fill(x, y)) continue;
    if (!box) box = { x0: x, y0: y, x1: x, y1: y };
    else { box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y); }
  }
  if (!box) return;
  const holes = new Uint8Array(W * H);
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) if (fill(x, y)) holes[y * W + x] = 1;
  const b = { x0: box.x0, y0: box.y0, x1: box.x1, y1: Math.min(H - 1, box.y1 + Math.round(H * 0.06)) };
  GarmentRender.inpaint(out, W, (x, y) => holes[y * W + x] === 1 || !d[(y * W + x) * 4 + 3], b);
  for (let j = 0; j < holes.length; j++) if (holes[j]) d[j * 4 + 3] = 255;
}
