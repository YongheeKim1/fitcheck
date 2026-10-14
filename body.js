'use strict';

// 전신 사진에서 얻은 ML 결과(포즈 랜드마크 + 사람 윤곽 마스크 + 얼굴 랜드마크)와
// 사용자가 입력한 키로 몸 치수를 계산한다. 계산은 모두 마스크 픽셀 좌표에서 한다.
//
// 입력
//   mask:  { data: Float32Array(0~1), width, height }  사람일 확률
//   pose:  MediaPipe Pose 33개 랜드마크 [{x, y, visibility}] (0~1 정규화)
//   face:  MediaPipe Face 랜드마크 [{x, y}] (0~1 정규화, 원본 이미지 기준) 또는 null
//   heightCm: 키
(function (root) {
  const P = {
    nose: 0, lEye: 2, rEye: 5, mouthL: 9, mouthR: 10,
    lShoulder: 11, rShoulder: 12, lWrist: 15, rWrist: 16,
    lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
    lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
  };
  const FACE_CHIN = 152;
  const FACE_FOREHEAD = 10;

  // 둘레 추정: 옆모습 사진이 없을 때 쓰는 "두께 ÷ 폭" 일반 비율
  const DEFAULT_DEPTH_RATIO = { chest: 0.7, waist: 0.75, hip: 0.75, thigh: 1.05 };

  function makeGrid(mask) {
    const { data, width: w, height: h } = mask;
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y | 0) * w + (x | 0)] > 0.5;
    // y 줄에서 x를 포함하는 연속 구간 [l, r]. x가 비어 있으면 가까운(±maxGap) 칸에서 찾는다
    function runAt(y, x, maxGap = 0) {
      y = Math.round(y);
      x = Math.round(x);
      let sx = null;
      for (let d = 0; d <= maxGap; d++) {
        if (on(x - d, y)) { sx = x - d; break; }
        if (on(x + d, y)) { sx = x + d; break; }
      }
      if (sx === null) return null;
      let l = sx;
      let r = sx;
      while (on(l - 1, y)) l--;
      while (on(r + 1, y)) r++;
      return { l, r, w: r - l + 1 };
    }
    return { w, h, on, runAt };
  }

  const avg = (...v) => v.reduce((a, b) => a + b, 0) / v.length;

  function analyzeFront({ mask, pose, face, heightCm }) {
    const g = makeGrid(mask);
    const pt = (i) => ({ x: pose[i].x * g.w, y: pose[i].y * g.h, v: pose[i].visibility ?? 1 });
    const warnings = [];

    const lS = pt(P.lShoulder), rS = pt(P.rShoulder);
    const lH = pt(P.lHip), rH = pt(P.rHip);
    const cx = avg(lS.x, rS.x, lH.x, rH.x);
    const shoulderY = avg(lS.y, rS.y);
    const hipY = avg(lH.y, rH.y);
    const shoulderJoint = Math.abs(lS.x - rS.x);

    // 정수리: 머리 주변 열에서 가장 위에 있는 사람 픽셀
    const nose = pt(P.nose);
    const half = shoulderJoint * 0.5;
    let topY = null;
    for (let y = 0; y < g.h && topY === null; y++) {
      for (let x = Math.max(0, nose.x - half); x <= Math.min(g.w - 1, nose.x + half); x++) {
        if (g.on(x, y)) { topY = y; break; }
      }
    }
    // 발끝: 발 주변 열에서 가장 아래 사람 픽셀
    const feet = [P.lAnkle, P.rAnkle, P.lHeel, P.rHeel, P.lFoot, P.rFoot].map(pt);
    const fx0 = Math.min(...feet.map((f) => f.x)) - shoulderJoint * 0.3;
    const fx1 = Math.max(...feet.map((f) => f.x)) + shoulderJoint * 0.3;
    let bottomY = null;
    for (let y = g.h - 1; y >= 0 && bottomY === null; y--) {
      for (let x = Math.max(0, fx0); x <= Math.min(g.w - 1, fx1); x++) {
        if (g.on(x, y)) { bottomY = y; break; }
      }
    }
    if (topY === null || bottomY === null) throw new Error('몸 윤곽을 찾지 못했어요.');
    bottomY = Math.max(bottomY, ...feet.map((f) => f.y));
    if (topY <= 1) warnings.push('머리 윗부분이 사진에서 잘린 것 같아요.');
    if (bottomY >= g.h - 2) warnings.push('발끝이 사진에서 잘린 것 같아요.');
    if (feet.some((f) => f.v < 0.5)) warnings.push('발이 잘 보이지 않아요. 발끝까지 나오게 찍어 주세요.');

    // 턱: 얼굴 랜드마크가 있으면 그대로, 없으면 눈·입 위치로 추정
    let chinY;
    let faceLen = null;
    if (face) {
      chinY = face[FACE_CHIN].y * g.h;
      faceLen = chinY - face[FACE_FOREHEAD].y * g.h;
    } else {
      const eyeY = avg(pt(P.lEye).y, pt(P.rEye).y);
      const mouthY = avg(pt(P.mouthL).y, pt(P.mouthR).y);
      chinY = mouthY + (mouthY - eyeY) * 0.75;
      warnings.push('얼굴을 정확히 찾지 못해 턱 위치를 추정했어요.');
    }

    // 머리숱/헤어스타일 때문에 윤곽 꼭대기가 실제 정수리보다 높을 수 있다.
    // 랜드마크10은 이마 중간쯤이라 정수리~턱은 보통 그 1.4~1.5배 → 훨씬 길면 머리카락으로 보고 보정
    let headTop = topY;
    if (faceLen && chinY - topY > faceLen * 1.6) {
      headTop = chinY - faceLen * 1.45;
      warnings.push('머리카락 볼륨을 빼고 정수리 위치를 보정했어요.');
    }

    const Hpx = bottomY - headTop;
    const cm = heightCm / Hpx;
    const headLen = chinY - headTop;

    // 가랑이: 골반 중심 아래로 내려가며 다리 사이 빈 공간이 처음 나오는 곳.
    // 다리가 붙어 있으면 빈틈이 무릎 가까이에서야 나오므로, 골반~무릎의 25%보다 아래면 믿지 않는다
    const kneeY = avg(pt(P.lKnee).y, pt(P.rKnee).y);
    const midHipX = avg(lH.x, rH.x);
    const thighLen = kneeY - hipY;
    let crotchY = null;
    for (let y = Math.round(hipY); y < hipY + thighLen * 0.25; y++) {
      if (!g.on(midHipX, y) && !g.on(midHipX - 1, y) && !g.on(midHipX + 1, y)) { crotchY = y; break; }
    }
    let crotchEstimated = false;
    if (crotchY === null) {
      // MediaPipe 골반 점은 실제 가랑이보다 조금 위: 사진 실측 기준 골반~무릎의 약 10% 아래
      crotchY = hipY + thighLen * 0.1;
      crotchEstimated = true;
      warnings.push('다리 사이가 붙어 있어서 가랑이 위치를 추정했어요. 다리를 어깨너비로 벌리면 더 정확해요.');
    }

    // 팔이 몸통에 붙어 있으면 윤곽 마스크만으로는 팔과 몸을 구분할 수 없다.
    // 어깨→팔꿈치→손목→손끝 선을 따라 팔 위치를 구하고, 몸통 구간에서 팔 두께만큼 잘라낸다
    const armHalf = Hpx * 0.022; // 팔뚝 반폭 ≈ 키의 2.2%
    const arms = [
      [P.lShoulder, 13, P.lWrist, 19].map(pt),
      [P.rShoulder, 14, P.rWrist, 20].map(pt),
    ];
    const armX = (arm, y) => {
      for (let i = 0; i < arm.length - 1; i++) {
        const a = arm[i], b = arm[i + 1];
        if (y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y) && a.y !== b.y) {
          return a.x + (b.x - a.x) * ((y - a.y) / (b.y - a.y));
        }
      }
      return null;
    };
    let armsClipped = false;
    function bodyRunAt(y, x) {
      const raw = g.runAt(y, x, 3);
      if (!raw) return null;
      const r = { ...raw };
      for (const arm of arms) {
        const ax = armX(arm, y);
        if (ax == null) continue;
        // 팔 안쪽 가장자리가 구간 안에 들어와 있고, 팔이 구간 가장자리 근처면(몸 앞이 아니라 옆) 잘라낸다
        if (ax < cx && ax + armHalf > r.l && ax - r.l < armHalf * 3) {
          r.l = Math.round(ax + armHalf);
          armsClipped = true;
        }
        if (ax > cx && ax - armHalf < r.r && r.r - ax < armHalf * 3) {
          r.r = Math.round(ax - armHalf);
          armsClipped = true;
        }
      }
      r.w = r.r - r.l + 1;
      // 너무 많이 잘렸으면(팔 위치 오인식) 자르지 않은 값을 쓴다
      return r.w >= raw.w * 0.5 ? r : raw;
    }

    // 어깨: 어깨 높이 겉 실루엣 폭
    const shoulderRun = g.runAt(shoulderY, cx, 5);

    // 가슴: 겨드랑이 높이(어깨~골반의 28% 아래)의 몸통 폭
    const chestY = shoulderY + (hipY - shoulderY) * 0.28;
    const chest = bodyRunAt(chestY, cx);

    // 허리: 어깨와 골반 사이 아래쪽에서 가장 잘록한 곳
    let waist = null;
    for (let y = shoulderY + (hipY - shoulderY) * 0.45; y <= hipY - (hipY - shoulderY) * 0.05; y++) {
      const r = bodyRunAt(y, cx);
      if (r && (!waist || r.w < waist.w)) waist = { ...r, y };
    }
    // 엉덩이: 골반 관절 조금 위부터 가랑이 바로 위까지 가장 넓은 곳
    let hip = null;
    for (let y = hipY - Hpx * 0.04; y <= crotchY - Hpx * 0.005; y++) {
      const r = bodyRunAt(y, cx);
      if (r && (!hip || r.w > hip.w)) hip = { ...r, y };
    }
    // 허벅지: 가랑이 바로 아래, 한쪽 다리 폭(양쪽 평균)
    const thighY = crotchY + Hpx * 0.02;
    const legRuns = [bodyRunAt(thighY, lH.x), bodyRunAt(thighY, rH.x)].filter(Boolean);
    if (armsClipped) warnings.push('팔이 몸에 붙어 있어서 팔 부분을 빼고 쟀어요. 팔을 몸에서 살짝 떼고 찍으면 더 정확해요.');
    let thighW = null;
    if (legRuns.length === 2 && legRuns[0].l !== legRuns[1].l) thighW = avg(legRuns[0].w, legRuns[1].w);
    else if (legRuns.length) thighW = legRuns[0].w / 2;

    const toCm = (px) => (px == null ? null : Math.round(px * cm * 10) / 10);
    const frac = (y) => (y - headTop) / Hpx; // 옆모습 사진에서 같은 높이를 찾기 위한 키 대비 위치

    return {
      heightCm,
      heads: Math.round((Hpx / headLen) * 10) / 10,
      headCm: toCm(headLen),
      shoulderCm: toCm(shoulderRun?.w),
      shoulderJointCm: toCm(shoulderJoint),
      // 옷 어깨너비(봉제선 끝~끝)는 관절 사이와 겉 실루엣의 중간쯤 + 2cm
      shoulderWidthCm: shoulderRun ? Math.round(((shoulderJoint + shoulderRun.w) / 2) * cm + 2) : null,
      chestWidthCm: toCm(chest?.w),
      pxPerCm: 1 / cm, // 마스크 픽셀 기준
      maskW: g.w,
      waistWidthCm: toCm(waist?.w),
      hipWidthCm: toCm(hip?.w),
      thighWidthCm: toCm(thighW),
      inseamCm: toCm(bottomY - crotchY),
      legRatio: Math.round(((bottomY - hipY) / Hpx) * 1000) / 1000,       // 골반 관절 높이 ÷ 키
      upperLowerRatio: Math.round(((crotchY - headTop) / (bottomY - crotchY)) * 100) / 100,
      crotchEstimated,
      levels: { chest: chest && frac(chestY), waist: waist && frac(waist.y), hip: hip && frac(hip.y), thigh: frac(thighY) },
      // 화면에 그릴 때 쓰는 픽셀 좌표(마스크 기준)
      draw: {
        maskW: g.w, maskH: g.h, headTop, chinY, bottomY, crotchY, crotchX: midHipX, headLen,
        lines: [
          shoulderRun && { key: '어깨', y: shoulderY, l: shoulderRun.l, r: shoulderRun.r },
          chest && { key: '가슴', y: chestY, l: chest.l, r: chest.r },
          waist && { key: '허리', y: waist.y, l: waist.l, r: waist.r },
          hip && { key: '엉덩이', y: hip.y, l: hip.l, r: hip.r },
          ...legRuns.map((r) => ({ key: '허벅지', y: thighY, l: r.l, r: r.r })),
        ].filter(Boolean),
      },
      warnings,
    };
  }

  // 옆모습: 정면에서 구한 높이 비율(levels)에서 몸 두께를 잰다
  function analyzeSide({ mask, heightCm, levels }) {
    const g = makeGrid(mask);
    let topY = null, bottomY = null;
    for (let y = 0; y < g.h && topY === null; y++) for (let x = 0; x < g.w; x++) if (g.on(x, y)) { topY = y; break; }
    for (let y = g.h - 1; y >= 0 && bottomY === null; y--) for (let x = 0; x < g.w; x++) if (g.on(x, y)) { bottomY = y; break; }
    if (topY === null) throw new Error('옆모습에서 몸을 찾지 못했어요.');
    const Hpx = bottomY - topY;
    const cm = heightCm / Hpx;
    const depth = {};
    for (const [key, f] of Object.entries(levels)) {
      if (f == null) continue;
      const y = Math.round(topY + f * Hpx);
      // 그 줄에서 가장 긴 구간 = 몸통(팔이 따로 잡혀도 무시)
      let best = 0, x = 0;
      while (x < g.w) {
        if (g.on(x, y)) {
          const r = g.runAt(y, x);
          best = Math.max(best, r.w);
          x = r.r + 1;
        } else x++;
      }
      depth[key] = best ? Math.round(best * cm * 10) / 10 : null;
    }
    return depth;
  }

  // 타원 둘레(라마누잔 근사)
  function ellipse(width, depth) {
    const a = width / 2, b = depth / 2;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }

  function estimateGirths(front, sideDepth) {
    const widths = { chest: front.chestWidthCm, waist: front.waistWidthCm, hip: front.hipWidthCm, thigh: front.thighWidthCm };
    const out = {};
    for (const [key, w] of Object.entries(widths)) {
      if (w == null) continue;
      // 옆모습은 팔·엉덩이가 겹쳐 두께가 부풀기 쉬워서 폭의 0.5~1.4배로 제한
      const side = sideDepth?.[key];
      const d = side != null ? Math.min(Math.max(side, w * 0.5), w * 1.4) : w * DEFAULT_DEPTH_RATIO[key];
      out[key] = Math.round(ellipse(w, d));
    }
    out.fromSide = !!sideDepth;
    return out;
  }

  // 정면 폭 비율로 보는 체형 타입(옷 고를 때 참고용)
  function bodyShape(f) {
    const S = f.shoulderCm, W = f.waistWidthCm, H = f.hipWidthCm;
    if (!S || !W || !H) return null;
    const sh = S / H, wh = W / H;
    if (wh <= 0.78 && sh >= 0.95 && sh <= 1.2) {
      return { name: '모래시계형', desc: '어깨와 엉덩이 폭이 비슷하고 허리가 잘록해요.', tip: '상의는 허리선이 들어간 핏이 잘 어울려요. 바지는 허리에 맞추면 엉덩이·허벅지가 낄 수 있으니 엉덩이 실측부터 확인하세요.' };
    }
    if (sh >= 1.2) {
      return { name: '역삼각형', desc: '엉덩이보다 어깨가 넓은 상체 중심 체형이에요.', tip: '상의는 어깨너비를 먼저 맞추고 가슴 여유를 확인하세요. 바지는 허리 기준으로, 와이드·스트레이트 핏이 균형을 잡아 줘요.' };
    }
    if (sh <= 0.95) {
      return { name: '삼각형(하체형)', desc: '어깨보다 엉덩이·허벅지 쪽이 넓은 체형이에요.', tip: '상의는 어깨가 살짝 넓거나 밑단이 골반을 덮는 기장이 균형을 잡아 줘요. 바지는 엉덩이·허벅지 실측을 먼저 보세요.' };
    }
    if (wh >= 0.88) {
      return { name: '일자형', desc: '어깨·허리·엉덩이 폭 차이가 크지 않은 체형이에요.', tip: '상의는 가슴, 바지는 허리 실측이 가장 중요해요. 대부분의 핏이 무난하게 맞아요.' };
    }
    return { name: '균형형', desc: '어깨와 엉덩이 비율이 고른 체형이에요.', tip: '상의는 어깨, 바지는 허리 기준으로 고르고 가슴·허벅지 여유만 확인하면 돼요.' };
  }

  const api = { analyzeFront, analyzeSide, estimateGirths, bodyShape, ellipse };
  root.BodyAnalysis = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
