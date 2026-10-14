'use strict';

// 퍼스널 컬러 계산(이미지 AI 없이 색채학으로).
// - sRGB → CIELab 변환, CIEDE2000 색차
// - 피부·머리·눈 색으로 언더톤(웜/쿨)과 4계절 타입 추정
// - 옷 색이 내 타입 팔레트와 얼마나 가까운지 평가
// 판정 기준값은 일반적인 퍼스널 컬러 이론을 수치로 옮긴 경험칙이라, 조명과 카메라에 따라 달라질 수 있다.
(function (root) {
  // ---------- 색 변환 ----------
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function hexToLinear(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [n >> 16, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
  }

  function linearToHex(rgb) {
    return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, toSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');
  }

  // 선형 RGB(0~1) → Lab(D65)
  function linearToLab([r, g, b]) {
    const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  const hexToLab = (hex) => linearToLab(hexToLinear(hex));

  function lch({ L, a, b }) {
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { L, C: Math.hypot(a, b), h };
  }

  // CIEDE2000 색차(사람 눈에 보이는 차이). 1 = 겨우 구분, 2~10 = 비슷함, 10+ = 다른 색
  function deltaE2000(l1, l2) {
    const rad = Math.PI / 180;
    const C1 = Math.hypot(l1.a, l1.b), C2 = Math.hypot(l2.a, l2.b);
    const Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1 = (1 + G) * l1.a, a2 = (1 + G) * l2.a;
    const c1 = Math.hypot(a1, l1.b), c2 = Math.hypot(a2, l2.b);
    const hue = (b, a) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1 = hue(l1.b, a1), h2 = hue(l2.b, a2);
    const dL = l2.L - l1.L, dC = c2 - c1;
    let dh = 0;
    if (c1 * c2 !== 0) {
      dh = h2 - h1;
      if (dh > 180) dh -= 360;
      else if (dh < -180) dh += 360;
    }
    const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
    const Lb = (l1.L + l2.L) / 2, cb = (c1 + c2) / 2;
    let hb = h1 + h2;
    if (c1 * c2 !== 0) {
      if (Math.abs(h1 - h2) > 180) hb = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
      else hb = (h1 + h2) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad)
      + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
    const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(cb ** 7 / (cb ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
    const Sc = 1 + 0.045 * cb;
    const Sh = 1 + 0.015 * cb * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
  }

  // ---------- 화이트밸런스 ----------
  // 흰 종이/벽처럼 원래 무채색인 곳의 선형 RGB로 보정 계수를 만든다
  function whiteBalanceFrom(whiteLinear) {
    const m = (whiteLinear[0] + whiteLinear[1] + whiteLinear[2]) / 3;
    return whiteLinear.map((c) => (c > 0 ? m / c : 1));
  }

  // ---------- 픽셀 샘플링 ----------
  // ImageData에서 (cx, cy) 반경 r 원 안의 픽셀을 모아, 그림자(어두운 20%)와 반사광(밝은 20%)을 빼고 평균
  function sampleCircle(img, cx, cy, r, wb = [1, 1, 1], ring = 0) {
    const px = [];
    const { width: w, height: h, data } = img;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r || d < ring) continue;
        const i = (y * w + x) * 4;
        const lin = [toLinear(data[i] / 255) * wb[0], toLinear(data[i + 1] / 255) * wb[1], toLinear(data[i + 2] / 255) * wb[2]];
        px.push({ lin, Y: 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] });
      }
    }
    return px;
  }

  function robustMean(px, lo = 0.2, hi = 0.8) {
    if (px.length < 5) return null;
    const s = px.slice().sort((a, b) => a.Y - b.Y);
    const keep = s.slice(Math.floor(s.length * lo), Math.max(Math.floor(s.length * lo) + 1, Math.ceil(s.length * hi)));
    const sum = [0, 0, 0];
    for (const p of keep) for (let k = 0; k < 3; k++) sum[k] += p.lin[k];
    return sum.map((v) => v / keep.length);
  }

  // ---------- 계절 팔레트 ----------
  const SEASONS = {
    spring: {
      name: '봄 웜', temp: 'warm',
      desc: '밝고 맑은 노란 기 색이 얼굴에 생기를 줘요.',
      palette: [
        ['코랄', '#ff7f50'], ['피치', '#ffb07c'], ['아이보리', '#fff3d6'], ['골든 옐로', '#ffd34e'],
        ['라이트 카멜', '#c9a26b'], ['애프리콧', '#fbceb1'], ['웜 핑크', '#f88379'], ['터콰이즈', '#30c5c0'],
        ['연두', '#a4c639'], ['토마토 레드', '#f0452f'],
      ],
    },
    summer: {
      name: '여름 쿨', temp: 'cool',
      desc: '부드럽고 흐린 푸른 기 색이 피부를 맑아 보이게 해요.',
      palette: [
        ['라벤더', '#b4a7d6'], ['파우더 블루', '#b0c4de'], ['로즈 핑크', '#e8a0b4'], ['쿨 그레이', '#a3a6b4'],
        ['더스티 모브', '#b48ea0'], ['스카이 블루', '#8ec5e8'], ['민트', '#a8dcc8'], ['그레이 네이비', '#4f5d75'],
        ['소프트 화이트', '#f4f4f2'], ['라즈베리', '#c2577a'],
      ],
    },
    autumn: {
      name: '가을 웜', temp: 'warm',
      desc: '깊고 차분한 노란 기 색이 얼굴을 또렷하게 해요.',
      palette: [
        ['카멜', '#c19a6b'], ['올리브', '#708238'], ['머스터드', '#d4a017'], ['테라코타', '#e2725b'],
        ['카키', '#8b864e'], ['초콜릿 브라운', '#6b4226'], ['번트 오렌지', '#cc5500'], ['딥 틸', '#1f5f5b'],
        ['브릭 레드', '#a0412d'], ['크림 베이지', '#e8d8b0'],
      ],
    },
    winter: {
      name: '겨울 쿨', temp: 'cool',
      desc: '선명하고 대비가 강한 푸른 기 색이 잘 받아요.',
      palette: [
        ['퓨어 화이트', '#ffffff'], ['블랙', '#111111'], ['네이비', '#1f2a55'], ['로열 블루', '#2547a8'],
        ['쿨 레드', '#c8102e'], ['푸시아', '#d1007a'], ['에메랄드', '#00875a'], ['차콜', '#36454f'],
        ['아이시 핑크', '#f3d1dc'], ['딥 퍼플', '#5b2c83'],
      ],
    },
  };
  for (const s of Object.values(SEASONS)) s.palette = s.palette.map(([name, hex]) => ({ name, hex, lab: hexToLab(hex) }));
  const OPPOSITE = { spring: 'winter', summer: 'autumn', autumn: 'summer', winter: 'spring' };

  // ---------- 퍼스널 컬러 판정 ----------
  // 입력: 선형 RGB 평균 { skin, hair?, eye? }
  function analyze({ skin, hair = null, eye = null }) {
    const S = lch(linearToLab(skin));
    const sLab = linearToLab(skin);
    const H = hair ? lch(linearToLab(hair)) : null;
    const E = eye ? lch(linearToLab(eye)) : null;

    // 언더톤: 피부 색상각. 붉은 기(작은 각)면 쿨, 노란 기(큰 각)면 웜. 53~58°는 중간
    const warmth = (S.h - 55.5) / 2.5;           // +면 웜, -면 쿨
    let undertone = warmth > 1 ? 'warm' : warmth < -1 ? 'cool' : 'neutral';
    // 중간이면 머리카락 색 온도로 한 번 더 본다(갈색·황갈색 머리 → 웜, 검정·잿빛 → 쿨)
    if (undertone === 'neutral' && H && H.C > 6) undertone = H.h > 60 ? 'warm' : 'cool';

    // 대비: 피부와 머리(없으면 눈)의 밝기 차이
    const darkFeature = H ?? E;
    const contrast = darkFeature ? S.L - darkFeature.L : null;
    // ITA(피부 밝기 지표): 55↑ 매우 밝음, 41~55 밝음, 28~41 중간, 10~28 그을림
    const ita = (Math.atan((S.L - 50) / sLab.b) * 180) / Math.PI;

    // 계절: 웜이면 밝고 맑으면 봄 / 깊고 차분하면 가을, 쿨이면 대비 강하면 겨울 / 부드러우면 여름
    const scores = {};
    // 봄/가을: 피부가 밝고 머리와 대비가 약하면 봄, 피부가 깊거나 짙은 머리와 대비가 크면 가을.
    // (채도는 피부가 진할수록 높게 측정돼서 기준에서 뺐다)
    const brightness = (S.L - 72) / 5 - (contrast != null ? (contrast - 40) / 10 : 0);
    const strong = contrast != null ? (contrast - 40) / 8 : (60 - S.L) / 5; // 대비가 클수록 +
    const w = Math.max(0, warmth + 1), c = Math.max(0, -warmth + 1);
    scores.spring = w * (1 + Math.max(0, brightness));
    scores.autumn = w * (1 + Math.max(0, -brightness));
    scores.winter = c * (1 + Math.max(0, strong));
    scores.summer = c * (1 + Math.max(0, -strong));
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const season = ranked[0];
    // 뉴트럴이면 두 번째 계절도 같이 쓴다(팔레트를 넓게)
    const second = undertone === 'neutral' ? ranked.find((k) => SEASONS[k].temp !== SEASONS[season].temp) : null;

    return {
      skin: { ...S, a: sLab.a, b: sLab.b, hex: linearToHex(skin) },
      hair: H && { ...H, hex: linearToHex(hair) },
      eye: E && { ...E, hex: linearToHex(eye) },
      undertone, warmth: Math.round(warmth * 10) / 10,
      contrast: contrast == null ? null : Math.round(contrast),
      ita: Math.round(ita),
      season, second,
    };
  }

  function myPalette(pc) {
    return [...SEASONS[pc.season].palette, ...(pc.second ? SEASONS[pc.second].palette : [])];
  }

  // ---------- 옷 색 평가 ----------
  function evaluate(hex, pc) {
    const lab = hexToLab(hex);
    const c = lch(lab);
    const mine = myPalette(pc).map((p) => ({ ...p, dE: deltaE2000(lab, p.lab) })).sort((a, b) => a.dE - b.dE);
    let nearest = null;
    for (const [key, s] of Object.entries(SEASONS)) {
      for (const p of s.palette) {
        const dE = deltaE2000(lab, p.lab);
        if (!nearest || dE < nearest.dE) nearest = { ...p, dE, season: key };
      }
    }
    const mySeasons = [pc.season, pc.second].filter(Boolean);
    const myTemp = SEASONS[pc.season].temp;
    const neutralColor = c.C < 8; // 흰·검·회색 계열
    const reasons = [];
    let verdict;

    if (mySeasons.includes(nearest.season) || mine[0].dE <= 10) {
      verdict = 'good';
      reasons.push(`내 팔레트의 '${mine[0].name}'과(와) 가까운 색이에요.`);
    } else if (SEASONS[nearest.season].temp === myTemp || (neutralColor && mine[0].dE <= 20)) {
      verdict = 'ok';
      reasons.push(`${SEASONS[nearest.season].name} 쪽 색이라 무난하게 어울려요.`);
    } else {
      verdict = 'caution';
      reasons.push(myTemp === 'cool'
        ? '노란 기가 도는 웜 계열 색이라 얼굴이 칙칙하거나 누렇게 보일 수 있어요.'
        : '푸른 기가 도는 쿨 계열 색이라 얼굴이 창백하거나 푸석해 보일 수 있어요.');
    }

    // 대비: 대비가 약한 타입에 아주 진한 색, 강한 타입에 흐릿한 중간 톤
    const skinL = pc.skin.L;
    if (pc.contrast != null && pc.contrast < 35 && c.L < 25) reasons.push('아주 진한 색은 대비가 커서 얼굴보다 옷이 먼저 보일 수 있어요. 얼굴에서 먼 하의로 입으면 좋아요.');
    if (pc.contrast != null && pc.contrast > 50 && Math.abs(c.L - skinL) < 15 && c.C < 25) reasons.push('피부와 밝기가 비슷한 흐린 색이라 인상이 흐려 보일 수 있어요.');

    // 점수는 판정 구간 안에서 내 팔레트와의 거리로 매긴다: 어울림 75~100, 무난 45~74, 주의 5~44
    const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
    const d = mine[0].dE;
    const score = verdict === 'good' ? clamp(100 - d * 1.5, 75, 100)
      : verdict === 'ok' ? clamp(74 - (d - 10), 45, 74) : clamp(44 - d * 0.5, 5, 44);
    const alternatives = verdict === 'good' ? [] : mine.slice(0, 3);
    return { verdict, score, nearest, reasons, alternatives, mineNearest: mine[0] };
  }

  const api = {
    hexToLinear, linearToHex, linearToLab, hexToLab, lch, deltaE2000,
    whiteBalanceFrom, sampleCircle, robustMean, analyze, evaluate, myPalette, SEASONS, OPPOSITE,
  };
  root.PersonalColor = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
