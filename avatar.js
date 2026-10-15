'use strict';

// ---------- 내 아바타: 체형 치수로 그린 정면 몸(2D 입체 일러스트) ----------
// 결과는 "가상의 내 사진"과 같은 모양이라(사진 캔버스·관절 좌표·1cm당 px·장면 분할), 사진 모드의 옷 입히기 엔진을
// 그대로 쓴다. 원래 입은 옷이 없으니 옷 지우기·배경 메우기가 필요 없고, 늘 같은 바른 자세라 실측이 그대로 보인다.
// 치수: 줄자로 잰 값 > 체형 사진 분석 > 키 기준 평균 비율. 얼굴: 내 사진에서 오린 얼굴(이 기기에만) 또는 기본 얼굴
const Avatar = (() => {
  const V = (x, y) => ({ x, y });
  const CW = 640, CH = 1280;

  // 쓸 치수 모으기(cm). 무엇에서 왔는지도 같이(화면 안내용)
  function measures(state, analysis) {
    const b = state.body || {}, a = analysis || {}, g = a.girths || {};
    const H = b.height || 170;
    const src = {};
    const pick = (key, tape, photo, avg) => {
      if (tape != null) { src[key] = 'tape'; return tape; }
      if (photo != null) { src[key] = 'photo'; return photo; }
      src[key] = 'avg'; return avg;
    };
    return {
      H,
      heads: a.heads && a.heads > 5.5 && a.heads < 9 ? a.heads : 7.3,
      shoulder: pick('shoulder', b.shoulder, a.shoulderWidthCm, H * 0.255),
      chest: pick('chest', b.chest, g.chest, H * 0.55),
      waist: pick('waist', b.waist, g.waist, H * 0.47),
      hip: pick('hip', b.hip, g.hip, H * 0.54),
      thigh: pick('thigh', b.thigh, g.thigh, H * 0.31),
      inseam: pick('inseam', b.inseam, a.inseamCm, H * 0.45),
      src,
    };
  }

  // 둘레 → 정면에서 보이는 폭(cm). garment.js와 같은 타원 근사
  const vis = (circ, kind) => GarmentRender.visW(circ, kind);
  const hexRGB = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  const rgbHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const shade = (rgb, f) => rgbHex(rgb.map((v) => v * f));
  const canvasOf = () => { const c = document.createElement('canvas'); c.width = CW; c.height = CH; return c; };

  // face(선택): { img(얼굴·머리카락만 남긴 캔버스), chinY, centerX, faceW, skin:[r,g,b] } — makeFace() 결과
  function build(state, analysis, pc, face) {
    const m = measures(state, analysis);
    const top = 40, floor = CH - 56;
    const s = (floor - top) / m.H;           // 1cm당 px
    const cx = CW / 2;
    const yAt = (cmFromFloor) => floor - cmFromFloor * s;
    const headH = m.H / m.heads;
    const P = (xcm, ycm) => V(cx + xcm * s, yAt(ycm));

    // 높이(바닥에서 cm)
    const yHeadTop = m.H, yChin = m.H - headH;
    const yShoulder = m.H - headH * 1.42;    // 어깨 관절
    const yCrotch = Math.min(m.inseam, m.H * 0.5);
    const yHipJoint = yCrotch + m.H * 0.055;
    const yWaist = yCrotch + (yShoulder - yCrotch) * 0.45;
    const yChest = yShoulder - (yShoulder - yWaist) * 0.33;
    const yHipWide = yCrotch + m.H * 0.045;
    const yKnee = yCrotch * 0.56, yCalf = yKnee - m.H * 0.075, yAnkle = m.H * 0.045;

    // 반폭(cm)
    const shHalf = m.shoulder / 2, jointHalf = Math.max(12, shHalf - 3.5);
    const chestHalf = vis(m.chest, 'chest') / 2, waistHalf = vis(m.waist, 'waist') / 2, hipHalf = vis(m.hip, 'hip') / 2;
    const thighHalf = vis(m.thigh, 'leg') / 2;
    const legC = Math.max(thighHalf * 0.9, hipHalf - thighHalf);       // 다리 중심(가운데선에서)
    const kneeC = legC * 0.84, ankleC = legC * 0.8;

    // 팔: 옷이 잘 보이게 아래로 약간 벌린 자세
    const upper = m.H * 0.186, fore = m.H * 0.146, hand = m.H * 0.09;
    const ang = (12 * Math.PI) / 180, ang2 = (8 * Math.PI) / 180;
    const armPts = (sd) => {
      const sh = P(sd * jointHalf, yShoulder);
      const el = V(sh.x + sd * Math.sin(ang) * upper * s, sh.y + Math.cos(ang) * upper * s);
      const wr = V(el.x + sd * Math.sin(ang2) * fore * s, el.y + Math.cos(ang2) * fore * s);
      const fi = V(wr.x + sd * Math.sin(ang2) * hand * s * 0.85, wr.y + Math.cos(ang2) * hand * s * 0.85);
      return { sh, el, wr, fi, sd };
    };
    const R = armPts(1), L = armPts(-1); // 화면 오른쪽(사람의 왼쪽, MediaPipe 11번 쪽) / 화면 왼쪽

    // ---------- 그리기 도구 ----------
    const lerp = (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    const unit = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return V(dx / l, dy / l); };
    // 점들을 그대로 지나는 매끈한 곡선(캣멀롬 → 베지어). 각진 다각형 대신 사람 몸 같은 곡선
    const curve = (ctx, pts, closed = true) => {
      const n = pts.length;
      const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
      }
      if (closed) ctx.closePath();
    };
    // 흐린 사본: 반씩 줄였다 다시 키운다(모든 브라우저에서 되는 가우스 비슷한 흐림)
    const blurOf = (src, px) => {
      const sizes = [];
      let w = CW, h = CH;
      while (w > CW / Math.max(1, px) && w > 8) { w = Math.max(4, Math.round(w / 2)); h = Math.max(4, Math.round(h / 2)); sizes.push([w, h]); }
      let cur = src;
      const step = (sw, sh) => {
        const t = document.createElement('canvas'); t.width = sw; t.height = sh;
        const tg = t.getContext('2d'); tg.imageSmoothingEnabled = true; tg.imageSmoothingQuality = 'high';
        tg.drawImage(cur, 0, 0, sw, sh); cur = t;
      };
      for (const [sw, sh] of sizes) step(sw, sh);
      for (let i = sizes.length - 2; i >= 0; i--) step(...sizes[i]);
      step(CW, CH);
      return cur;
    };
    // 모양 안에 색을 칠하되 흐린 모양을 (dx,dy)만큼 옮겨 빼서, 그 반대쪽 가장자리에만 남긴다(빛 반대편 그늘·빛 받는 테두리)
    const edgeTone = (mask, blur, color, dx, dy) => {
      const c = canvasOf(), cg = c.getContext('2d');
      cg.fillStyle = color; cg.fillRect(0, 0, CW, CH);
      cg.globalCompositeOperation = 'destination-out'; cg.drawImage(blur, -dx, -dy);
      cg.globalCompositeOperation = 'destination-in'; cg.drawImage(mask, 0, 0);
      return c;
    };
    // 윤곽선: 모양 - 깎아 낸 모양
    const outlineOf = (mask, color, wpx) => {
      const er = canvasOf(), eg = er.getContext('2d');
      eg.drawImage(mask, 0, 0);
      eg.globalCompositeOperation = 'destination-in';
      for (const [ox, oy] of [[wpx, 0], [-wpx, 0], [0, wpx], [0, -wpx]]) eg.drawImage(mask, ox, oy);
      const c = canvasOf(), cg = c.getContext('2d');
      cg.drawImage(mask, 0, 0);
      cg.globalCompositeOperation = 'destination-out'; cg.drawImage(er, 0, 0);
      cg.globalCompositeOperation = 'source-in'; cg.fillStyle = color; cg.fillRect(0, 0, CW, CH);
      return c;
    };
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const rgba = (rgb, a) => `rgba(${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')},${a})`;

    // ---------- 색: 피부톤(얼굴을 넣었으면 그 얼굴 피부색) ----------
    const skin = face?.skin ? face.skin : hexRGB(pc?.skin?.hex || '#e8c3a8');
    const hairRGB = hexRGB(pc?.hair?.hex || '#2a1f1b');
    const hairHex = rgbHex(hairRGB);
    const skinShadow = rgbHex([skin[0] * 0.9, skin[1] * 0.74, skin[2] * 0.72]); // 따뜻한 그늘(곱하기)
    const lineCol = rgba(mix(skin, [70, 30, 25], 0.62), 0.55);

    // 입체 명암: 빛은 왼쪽 위. 반대편 가장자리 그늘 + 테두리 감싸는 어둠 + 빛 받는 테두리
    const shadeForm = (layer, scale = 1) => {
      const lg = layer.getContext('2d');
      const b1 = blurOf(layer, 2.6 * s * scale), b2 = blurOf(layer, 6 * s * scale), b0 = blurOf(layer, 0.9 * s * scale);
      lg.save();
      lg.globalCompositeOperation = 'multiply';
      lg.globalAlpha = 0.62; lg.drawImage(edgeTone(layer, b1, skinShadow, 2.4 * s * scale, 1.2 * s * scale), 0, 0);
      lg.globalAlpha = 0.35; lg.drawImage(edgeTone(layer, b2, skinShadow, 0, 0), 0, 0);
      lg.globalCompositeOperation = 'screen';
      lg.globalAlpha = 0.28; lg.drawImage(edgeTone(layer, b0, 'rgb(255,226,208)', -0.9 * s * scale, -0.6 * s * scale), 0, 0);
      lg.restore();
    };
    // 부드러운 타원 빛·그늘(모양 안에서만)
    const soft = (ctx, x, y, rx, ry, rgb, a, op = 'source-atop') => {
      const r = Math.max(rx, ry);
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, rgba(rgb, a)); rg.addColorStop(1, rgba(rgb, 0));
      ctx.save(); ctx.globalCompositeOperation = op;
      ctx.translate(x, y); ctx.scale(rx / r, ry / r); ctx.translate(-x, -y);
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    };
    const softLine = (ctx, pts, rgb, a, wcm) => { // 근육 경계 같은 옅은 선: 넓고 옅게 + 좁고 조금 진하게
      ctx.save(); ctx.globalCompositeOperation = 'source-atop'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [k, f] of [[2.6, 0.35], [1, 0.8]]) { ctx.strokeStyle = rgba(rgb, a * f); ctx.lineWidth = wcm * k * s; curve(ctx, pts, false); ctx.stroke(); }
      ctx.restore();
    };

    // ---------- 몸 실루엣 ----------
    const bodyImg = canvasOf();
    const g = bodyImg.getContext('2d');
    g.fillStyle = rgbHex(skin);
    const fillCurve = (pts) => { curve(g, pts); g.fill(); };
    // 팔: 중심선(어깨 0 → 팔꿈치 1 → 손목 2)을 따라 바깥/안쪽 반폭(cm). 삼각근·이두·팔꿈치·전완 굴곡
    const armAt = (A, t) => (t <= 1 ? lerp(A.sh, A.el, t) : lerp(A.el, A.wr, t - 1));
    const armOut = (A, t) => { const d = t <= 1 ? unit(A.sh, A.el) : unit(A.el, A.wr); return V(A.sd * d.y, -A.sd * d.x); };
    const armPt = (A, t, w) => { const p = armAt(A, Math.max(0, t)), o = armOut(A, Math.max(0, t)); const up = unit(A.el, A.sh); const e = Math.min(0, t) * upper; return V(p.x + o.x * w * s - up.x * e * s, p.y + o.y * w * s - up.y * e * s); };
    for (const A of [R, L]) {
      const outer = [[-0.06, 1.6], [0.0, 4.2], [0.06, 4.9], [0.16, 5.1], [0.38, 4.4], [0.62, 4.0], [0.92, 3.4], [1.18, 3.95], [1.5, 3.25], [1.97, 2.35]];
      const inner = [[1.97, 2.25], [1.55, 2.85], [1.2, 3.35], [1.0, 3.0], [0.68, 3.6], [0.36, 3.7], [0.12, 3.4], [-0.03, 1.0]];
      fillCurve([...outer.map(([t, w]) => armPt(A, t, w)), ...inner.map(([t, w]) => armPt(A, t, -w))]);
      // 손: 손등이 살짝 보이게 늘어뜨린 손(엄지는 몸 쪽 앞)
      const d = unit(A.wr, A.fi), o = V(A.sd * d.y, -A.sd * d.x), Lh = Math.hypot(A.fi.x - A.wr.x, A.fi.y - A.wr.y);
      const hp = (u, w) => V(A.wr.x + d.x * u * Lh + o.x * w * s, A.wr.y + d.y * u * Lh + o.y * w * s);
      fillCurve([hp(-0.12, 2.3), hp(0.25, 2.65), hp(0.55, 2.45), hp(0.8, 1.85), hp(0.97, 0.7), hp(1.0, -0.3), hp(0.9, -1.5), hp(0.68, -2.1), hp(0.5, -2.45), hp(0.4, -3.05), hp(0.24, -2.95), hp(0.06, -2.4), hp(-0.12, -2.2)]);
    }
    // 몸통: 목 → 승모근 비탈 → 어깨 → 겨드랑이 → 가슴 → 허리(등 근육에서 좁아짐) → 골반
    const neckHalf = 5.4;
    const torsoSide = (sd) => [
      P(sd * neckHalf, yChin + 5), P(sd * (neckHalf + 0.6), yShoulder + 7.6), P(sd * (neckHalf + 4.5), yShoulder + 4.8),
      P(sd * (shHalf - 3.2), yShoulder + 1.9), P(sd * (shHalf - 0.8), yShoulder - 1.2),
      P(sd * (chestHalf + 0.9), yShoulder - 9), P(sd * (chestHalf + 0.2), yChest - 3), P(sd * (waistHalf + 0.6), yWaist + 4),
      P(sd * waistHalf, yWaist - 1), P(sd * hipHalf, yHipWide), P(sd * (hipHalf - 0.6), yCrotch + 1.5),
    ];
    fillCurve([...torsoSide(1), P(0, yCrotch - 1.2), ...torsoSide(-1).reverse()]);
    // 다리: 허벅지 바깥 곡선 → 무릎 → 종아리(안쪽이 더 높이 불룩) → 발목
    for (const sd of [-1, 1]) {
      fillCurve([
        P(sd * (legC + thighHalf), yHipWide + 1), P(sd * (legC + thighHalf * 0.99), yCrotch - 5), P(sd * (legC + thighHalf * 0.84), (yCrotch + yKnee) / 2),
        P(sd * (kneeC + 4.7), yKnee + 5), P(sd * (kneeC + 4.4), yKnee), P(sd * (kneeC + 4.6), yKnee - 5), P(sd * (kneeC + 5.0), yCalf + 1),
        P(sd * (ankleC + 3.3), yAnkle + 11), P(sd * (ankleC + 2.7), yAnkle + 2), P(sd * (ankleC + 2.7), yAnkle - 3),
        P(sd * (ankleC - 2.8), yAnkle - 3), P(sd * (ankleC - 2.9), yAnkle + 3), P(sd * (ankleC - 3.6), yAnkle + 12),
        P(sd * (kneeC - 5.1), yCalf + 5), P(sd * (kneeC - 4.2), yKnee - 4), P(sd * (kneeC - 4.5), yKnee + 2),
        P(sd * Math.max(0.6, legC - thighHalf * 0.86), (yCrotch + yKnee) / 2 + 4), P(sd * Math.max(0.4, legC - thighHalf), yCrotch - 3), P(sd * 0.2, yCrotch + 1.5),
      ]);
    }
    const bodyMask = canvasOf();
    bodyMask.getContext('2d').drawImage(bodyImg, 0, 0); // 피부만의 모양(속옷·신발 전)

    // 속옷: 골반에 걸치는 짙은 회색 드로즈(허리 밴드 + 허벅지 위쪽까지)
    {
      g.save();
      g.globalCompositeOperation = 'source-atop';
      const top = yHipWide + 2.5, bot = yCrotch - 8.5;
      const ux = Math.max(hipHalf, legC + thighHalf) + 1.2; // 손(옆에 늘어뜨린)까지 칠하지 않게
      g.fillStyle = '#3b404b';
      g.beginPath();
      g.moveTo(cx - ux * s, yAt(top - 0.6));
      g.quadraticCurveTo(cx, yAt(top + 0.8), cx + ux * s, yAt(top - 0.6));
      g.lineTo(cx + ux * s, yAt(bot - 1));
      g.quadraticCurveTo(cx + legC * s, yAt(bot - 0.2), cx + 0.6 * s, yAt(bot + 2.2));
      g.lineTo(cx - 0.6 * s, yAt(bot + 2.2));
      g.quadraticCurveTo(cx - legC * s, yAt(bot - 0.2), cx - ux * s, yAt(bot - 1));
      g.closePath(); g.fill();
      // 허리 밴드(진한 띠 + 가는 밝은 줄)
      g.fillStyle = '#22252c';
      g.beginPath();
      g.moveTo(cx - ux * s, yAt(top - 0.6)); g.quadraticCurveTo(cx, yAt(top + 0.8), cx + ux * s, yAt(top - 0.6));
      g.lineTo(cx + ux * s, yAt(top - 3.4)); g.quadraticCurveTo(cx, yAt(top - 2), cx - ux * s, yAt(top - 3.4)); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(210,214,222,0.55)'; g.lineWidth = 0.25 * s;
      g.beginPath(); g.moveTo(cx - ux * s, yAt(top - 2.6)); g.quadraticCurveTo(cx, yAt(top - 1.2), cx + ux * s, yAt(top - 2.6)); g.stroke();
      // 앞 봉제선
      g.strokeStyle = 'rgba(20,22,28,0.45)'; g.lineWidth = 0.22 * s;
      g.beginPath(); g.moveTo(cx - 3.5 * s, yAt(top - 3.6)); g.quadraticCurveTo(cx - 3.2 * s, yAt(yCrotch + 3), cx - 0.4 * s, yAt(yCrotch - 0.5)); g.stroke();
      g.restore();
    }
    shadeForm(bodyImg);

    // 근육·뼈 결(아주 옅게): 쇄골, 가슴 아래, 가운데선, 배꼽, 삼각근, 팔꿈치, 무릎
    {
      const dk = mix(skin, [90, 40, 30], 0.55), lt = [255, 240, 228];
      for (const sd of [-1, 1]) {
        softLine(g, [P(sd * 1.6, yShoulder + 3.2), P(sd * 6, yShoulder + 3.9), P(sd * 11, yShoulder + 3.2), P(sd * (shHalf - 4.5), yShoulder + 2.1)], dk, 0.22, 0.32);
        soft(g, cx + sd * 6 * s, yAt(yShoulder + 2.4), 5 * s, 1.4 * s, lt, 0.22); // 쇄골 위 빛
        softLine(g, [P(sd * 1.2, yChest - 5.2), P(sd * 6, yChest - 6.2), P(sd * (chestHalf - 3.5), yChest - 4.4), P(sd * (chestHalf - 1.2), yChest - 1.5)], dk, 0.2, 0.55);
        soft(g, cx + sd * 6.5 * s, yAt(yChest - 1), 6.5 * s, 4.5 * s, lt, 0.16); // 가슴 면 빛
        soft(g, cx + sd * (chestHalf + 0.8) * s, yAt(yShoulder - 8.5), 2.2 * s, 3.5 * s, dk, 0.35); // 겨드랑이 그늘
        soft(g, cx + sd * legC * s, yAt((yCrotch + yKnee) / 2), 3.6 * s, 13 * s, lt, 0.16); // 허벅지 앞 빛
        soft(g, cx + sd * kneeC * s, yAt((yKnee + yAnkle) / 2 + 3), 1.8 * s, 9 * s, lt, 0.16); // 정강이 빛
        softLine(g, [P(sd * (kneeC - 2.2), yKnee - 0.6), P(sd * kneeC, yKnee - 1.6), P(sd * (kneeC + 2.2), yKnee - 0.6)], dk, 0.22, 0.3);
        softLine(g, [P(sd * (kneeC - 1.8), yKnee + 3.2), P(sd * kneeC, yKnee + 3.8), P(sd * (kneeC + 1.8), yKnee + 3.2)], dk, 0.12, 0.3);
        soft(g, cx + sd * 0.4 * s, yAt(yCrotch - 1), 1.6 * s, 4 * s, dk, 0.3); // 다리 사이 그늘
      }
      for (const A of [R, L]) {
        softLine(g, [armPt(A, 0.1, -2.6), armPt(A, 0.3, -0.6), armPt(A, 0.42, 2.6)], dk, 0.13, 0.4); // 삼각근 경계
        soft(g, armPt(A, 0.2, 1.2).x, armPt(A, 0.2, 1.2).y, 2.2 * s, 3 * s, lt, 0.26); // 어깨 둥근 빛
        softLine(g, [armPt(A, 0.96, -1.2), armPt(A, 1.0, 0), armPt(A, 0.98, 1.2)], dk, 0.16, 0.25); // 팔꿈치
        soft(g, armPt(A, 1.25, 1).x, armPt(A, 1.25, 1).y, 1.8 * s, 3.5 * s, lt, 0.18);
        // 손가락 결
        const d = unit(A.wr, A.fi), o = V(A.sd * d.y, -A.sd * d.x), Lh = Math.hypot(A.fi.x - A.wr.x, A.fi.y - A.wr.y);
        const hp = (u, w) => V(A.wr.x + d.x * u * Lh + o.x * w * s, A.wr.y + d.y * u * Lh + o.y * w * s);
        for (const w of [-0.9, 0.2, 1.2]) softLine(g, [hp(0.55, w), hp(0.75, w * 1.05), hp(0.92, w * 0.9)], dk, 0.16, 0.12);
      }
      softLine(g, [P(0, yChest - 4.5), P(0, yWaist + 4)], dk, 0.06, 0.4); // 가운데선
      soft(g, cx, yAt(yWaist - 1.2), 0.55 * s, 0.75 * s, dk, 0.55); // 배꼽
      soft(g, cx, yAt(yWaist + 5), 9 * s, 6 * s, lt, 0.08);
    }

    // ---------- 머리 ----------
    const head = canvasOf();
    const hg = head.getContext('2d');
    const hcY = yAt(yHeadTop - headH * 0.5), hR = headH * 0.5 * s;
    const faceW = hR * 0.74 * 2; // 아바타 얼굴 폭(px)
    let faceMask = null, hairMask = null; // 장면 분할용(얼굴 3 / 머리카락 1)
    if (face?.img) {
      // 내 얼굴: 얼굴 폭을 맞추고 턱을 아바타 턱에, 가운데를 몸 가운데에
      const k = faceW / Math.max(1, face.faceW) * 0.98;
      const chinPx = yAt(yChin);
      hg.drawImage(face.img, cx - face.centerX * k, chinPx - face.chinY * k, face.img.width * k, face.img.height * k);
      faceMask = { k, chinPx };
    } else {
      const H2 = (u, v) => V(cx + u * hR, hcY + v * hR);
      // 얼굴: 관자놀이 → 광대 → 갸름한 턱선 → 작은 턱 + 귀
      const fm = canvasOf(), fg = fm.getContext('2d');
      fg.fillStyle = rgbHex(skin);
      const faceSide = (sd) => [H2(sd * 0.6, -0.78), H2(sd * 0.71, -0.25), H2(sd * 0.7, 0.18), H2(sd * 0.6, 0.52), H2(sd * 0.38, 0.8), H2(sd * 0.13, 0.97)];
      curve(fg, [H2(0, -0.92), ...faceSide(1), ...faceSide(-1).reverse()]); fg.fill();
      for (const sd of [-1, 1]) curve(fg, [H2(sd * 0.64, -0.05), H2(sd * 0.8, -0.1), H2(sd * 0.84, 0.08), H2(sd * 0.76, 0.3), H2(sd * 0.64, 0.36)]), fg.fill();
      // 턱 아래 목에 드리운 그늘(몸 위)
      {
        const sh = canvasOf(), sg = sh.getContext('2d');
        sg.drawImage(blurOf(fm, 1.2 * s), 0, 1.6 * s);
        sg.globalCompositeOperation = 'source-in'; sg.fillStyle = skinShadow; sg.fillRect(0, 0, CW, CH);
        sg.globalCompositeOperation = 'destination-in'; sg.drawImage(bodyMask, 0, 0);
        g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.8; g.drawImage(sh, 0, 0); g.restore();
      }
      shadeForm(fm, 0.45);
      const fx = fm.getContext('2d');
      // 귀 안쪽
      for (const sd of [-1, 1]) softLine(fx, [H2(sd * 0.7, -0.02), H2(sd * 0.78, 0.06), H2(sd * 0.72, 0.24)], mix(skin, [120, 50, 40], 0.5), 0.35, hR / s * 0.02);
      soft(fx, cx, hcY + 0.32 * hR, 0.5 * hR, 0.42 * hR, [255, 236, 224], 0.12); // 얼굴 가운데 빛
      for (const sd of [-1, 1]) soft(fx, cx + sd * 0.42 * hR, hcY + 0.36 * hR, 0.14 * hR, 0.08 * hR, [235, 130, 120], 0.12); // 볼
      // 앞머리 그림자(이마)
      const fringe = (ctx, dy = 0) => {
        const F = (u, v) => H2(u, v + dy);
        ctx.beginPath();
        let p = F(-0.75, 0.08); ctx.moveTo(p.x, p.y);
        const to = (u, v, cu, cv) => { const c = F(cu, cv), q = F(u, v); ctx.quadraticCurveTo(c.x, c.y, q.x, q.y); };
        to(-0.82, -0.42, -0.84, -0.12);
        to(-0.56, -0.97, -0.84, -0.86);
        to(0, -1.12, -0.3, -1.12);
        to(0.56, -0.97, 0.3, -1.12);
        to(0.82, -0.42, 0.84, -0.86);
        to(0.75, 0.08, 0.84, -0.12);
        to(0.66, 0.0, 0.7, 0.06);
        to(0.66, -0.34, 0.64, -0.16);
        // 옆으로 넘긴 앞머리 덩어리(끝이 뾰족하게)
        const clumps = [[0.52, -0.2, 0.47, -0.42], [0.31, -0.24, 0.21, -0.46], [0.08, -0.27, -0.03, -0.48], [-0.18, -0.3, -0.3, -0.5], [-0.46, -0.32, -0.58, -0.47]];
        let prev = [0.66, -0.34];
        for (const [tu, tv, vu, vv] of clumps) {
          to(tu, tv, (prev[0] + tu) / 2 + 0.02, Math.max(prev[1], tv) + 0.02); // 앞머리 끝으로 휘어 내려옴
          to(vu, vv, tu - 0.02, tv - 0.12);                                    // 다음 덩어리 사이 골
          prev = [vu, vv];
        }
        to(-0.66, -0.3, -0.64, -0.42);
        to(-0.66, 0.0, -0.66, -0.15);
        to(-0.75, 0.08, -0.7, 0.06);
        ctx.closePath();
      };
      fx.save(); fx.globalCompositeOperation = 'source-atop'; fx.fillStyle = rgba(mix(skin, [80, 35, 30], 0.5), 0.35);
      fringe(fx, 0.06); fx.fill(); fx.restore();
      // 이목구비
      const eyeV = 0.1, eyeU = 0.3, ew = 0.155, eh = 0.07;
      const dark = '#1d1513';
      for (const sd of [-1, 1]) {
        const ex = cx + sd * eyeU * hR, ey = hcY + eyeV * hR;
        const inn = V(ex - sd * ew * hR, ey + 0.012 * hR), out = V(ex + sd * ew * hR, ey - 0.012 * hR);
        const lidTop = (ctx) => { ctx.moveTo(inn.x, inn.y); ctx.bezierCurveTo(ex - sd * ew * 0.45 * hR, ey - eh * 1.45 * hR, ex + sd * ew * 0.55 * hR, ey - eh * 1.4 * hR, out.x, out.y); };
        // 흰자(아몬드형)
        fx.save();
        fx.beginPath(); lidTop(fx);
        fx.bezierCurveTo(ex + sd * ew * 0.5 * hR, ey + eh * 0.95 * hR, ex - sd * ew * 0.5 * hR, ey + eh * 1.05 * hR, inn.x, inn.y);
        fx.closePath(); fx.fillStyle = '#f4efec'; fx.fill(); fx.clip();
        // 눈동자: 위가 어둡고 아래가 밝은 갈색
        const ir = eh * 1.3 * hR, ix = ex + sd * 0.012 * hR, iy = ey + 0.004 * hR;
        const ig = fx.createLinearGradient(0, iy - ir, 0, iy + ir);
        ig.addColorStop(0, '#1a110d'); ig.addColorStop(0.55, '#3e2a1f'); ig.addColorStop(1, '#7a5638');
        fx.fillStyle = ig; fx.beginPath(); fx.arc(ix, iy, ir, 0, Math.PI * 2); fx.fill();
        fx.fillStyle = '#0d0907'; fx.beginPath(); fx.arc(ix, iy, ir * 0.42, 0, Math.PI * 2); fx.fill();
        const lid = fx.createLinearGradient(0, ey - eh * 1.4 * hR, 0, ey + eh * 0.2 * hR); // 윗눈꺼풀 그늘
        lid.addColorStop(0, 'rgba(60,30,25,0.45)'); lid.addColorStop(1, 'rgba(60,30,25,0)');
        fx.fillStyle = lid; fx.fillRect(ex - ew * hR * 1.2, ey - eh * 2 * hR, ew * hR * 2.4, eh * 2.4 * hR);
        fx.restore();
        fx.fillStyle = 'rgba(255,255,255,0.95)';
        fx.beginPath(); fx.arc(ix - 0.028 * hR, iy - 0.03 * hR, 0.022 * hR, 0, Math.PI * 2); fx.fill();
        fx.fillStyle = 'rgba(255,255,255,0.55)';
        fx.beginPath(); fx.arc(ix + 0.03 * hR, iy + 0.03 * hR, 0.011 * hR, 0, Math.PI * 2); fx.fill();
        // 윗눈선(속눈썹): 굵게, 눈꼬리에서 살짝 길게
        fx.strokeStyle = dark; fx.lineCap = 'round'; fx.lineJoin = 'round'; fx.lineWidth = 0.032 * hR;
        fx.beginPath(); lidTop(fx); fx.lineTo(out.x + sd * 0.025 * hR, out.y + 0.004 * hR); fx.stroke();
        // 아랫눈선(바깥쪽만 옅게), 쌍꺼풀
        fx.strokeStyle = 'rgba(70,40,34,0.4)'; fx.lineWidth = 0.011 * hR;
        fx.beginPath(); fx.moveTo(ex, ey + eh * 0.95 * hR); fx.quadraticCurveTo(ex + sd * ew * 0.6 * hR, ey + eh * 0.85 * hR, out.x, out.y + 0.006 * hR); fx.stroke();
        fx.strokeStyle = 'rgba(95,55,45,0.42)'; fx.lineWidth = 0.012 * hR;
        fx.beginPath(); fx.moveTo(ex - sd * ew * 0.35 * hR, ey - eh * 1.55 * hR); fx.quadraticCurveTo(ex + sd * ew * 0.3 * hR, ey - eh * 1.95 * hR, out.x - sd * 0.01 * hR, out.y - eh * 0.75 * hR); fx.stroke();
        // 눈썹: 안쪽이 굵고 바깥으로 가늘어지는 일자에 가까운 눈썹
        const bY = ey - 0.215 * hR;
        fx.fillStyle = rgbHex(hairRGB.map((v) => v * 0.9));
        fx.beginPath();
        fx.moveTo(ex - sd * 0.15 * hR, bY + 0.035 * hR);
        fx.quadraticCurveTo(ex - sd * 0.15 * hR, bY - 0.02 * hR, ex - sd * 0.08 * hR, bY - 0.025 * hR);
        fx.quadraticCurveTo(ex + sd * 0.08 * hR, bY - 0.045 * hR, ex + sd * 0.19 * hR, bY + 0.0 * hR);
        fx.quadraticCurveTo(ex + sd * 0.08 * hR, bY - 0.012 * hR, ex - sd * 0.06 * hR, bY + 0.025 * hR);
        fx.quadraticCurveTo(ex - sd * 0.12 * hR, bY + 0.04 * hR, ex - sd * 0.15 * hR, bY + 0.035 * hR);
        fx.fill();
      }
      // 코: 콧대 한쪽 그늘 + 코끝 아래 그늘 + 콧볼
      const nd = mix(skin, [90, 40, 30], 0.5);
      softLine(fx, [H2(0.07, 0.12), H2(0.08, 0.3), H2(0.07, 0.42)], nd, 0.12, hR / s * 0.03);
      softLine(fx, [H2(-0.07, 0.47), H2(0, 0.495), H2(0.07, 0.47)], nd, 0.5, hR / s * 0.018);
      for (const sd of [-1, 1]) softLine(fx, [H2(sd * 0.1, 0.43), H2(sd * 0.105, 0.465)], nd, 0.35, hR / s * 0.012);
      soft(fx, cx - 0.01 * hR, hcY + 0.42 * hR, 0.035 * hR, 0.03 * hR, [255, 245, 240], 0.5);
      // 입: 윗입술 선 + 아랫입술 혈색 + 그 아래 그늘
      const lipY = hcY + 0.655 * hR;
      fx.strokeStyle = '#8f4f48'; fx.lineWidth = 0.02 * hR; fx.lineCap = 'round';
      fx.beginPath(); fx.moveTo(cx - 0.13 * hR, lipY - 0.005 * hR);
      fx.bezierCurveTo(cx - 0.05 * hR, lipY + 0.02 * hR, cx + 0.05 * hR, lipY + 0.02 * hR, cx + 0.13 * hR, lipY - 0.005 * hR); fx.stroke();
      soft(fx, cx, lipY + 0.045 * hR, 0.1 * hR, 0.035 * hR, [205, 112, 102], 0.45);
      soft(fx, cx, lipY - 0.02 * hR, 0.09 * hR, 0.02 * hR, [190, 100, 92], 0.25);
      soft(fx, cx, lipY + 0.12 * hR, 0.07 * hR, 0.025 * hR, nd, 0.28);

      // 머리카락: 뒷머리(얼굴 뒤) → 얼굴 → 앞머리. 결·윤기 띠는 머리 모양 안에서만
      hairMask = canvasOf();
      const hm = hairMask.getContext('2d');
      hm.fillStyle = hairHex;
      hm.beginPath(); hm.ellipse(cx, hcY - 0.2 * hR, 0.85 * hR, 0.86 * hR, 0, 0, Math.PI * 2); hm.fill();
      hg.drawImage(hairMask, 0, 0);
      hg.save(); hg.globalCompositeOperation = 'source-atop'; hg.fillStyle = rgba(hairRGB.map((v) => v * 0.55), 1); hg.fillRect(0, 0, CW, CH); hg.restore(); // 뒷머리는 더 어둡게
      hg.drawImage(fm, 0, 0);
      const front = canvasOf(), frg = front.getContext('2d');
      frg.fillStyle = hairHex; fringe(frg); frg.fill();
      frg.save();
      frg.globalCompositeOperation = 'source-atop';
      const hgd = frg.createLinearGradient(cx - hR, hcY - hR, cx + hR * 0.8, hcY);
      hgd.addColorStop(0, rgbHex(mix(hairRGB, [255, 255, 255], 0.12))); hgd.addColorStop(1, rgbHex(hairRGB.map((v) => v * 0.7)));
      frg.fillStyle = hgd; frg.fillRect(0, 0, CW, CH);
      // 윤기 띠: 정수리 둥근 면을 따라 흐린 밝은 호(머리 모양 안에서만)
      frg.save();
      frg.translate(cx - 0.1 * hR, hcY - 0.62 * hR); frg.scale(1, 0.55);
      const shine = frg.createRadialGradient(0, 0, 0.42 * hR, 0, 0, 0.62 * hR);
      shine.addColorStop(0, rgba(mix(hairRGB, [255, 250, 245], 0.4), 0));
      shine.addColorStop(0.5, rgba(mix(hairRGB, [255, 250, 245], 0.4), 0.45));
      shine.addColorStop(1, rgba(mix(hairRGB, [255, 250, 245], 0.4), 0));
      frg.fillStyle = shine; frg.fillRect(-hR, -hR * 1.2, hR * 2, hR * 1.2); // 위쪽 반원만
      frg.restore();
      // 결: 가르마 쪽에서 앞머리 끝으로 흐르는 가는 선(제각각 시작)
      frg.strokeStyle = rgba(hairRGB.map((v) => v * 0.5), 0.35); frg.lineWidth = 0.012 * hR; frg.lineCap = 'round';
      for (const [u0, v0, u1, v1] of [[-0.5, -0.95, 0.5, -0.24], [-0.3, -1.0, 0.3, -0.28], [-0.12, -0.9, 0.08, -0.3], [0.05, -0.98, -0.18, -0.33], [-0.62, -0.75, -0.46, -0.36], [0.3, -0.92, 0.62, -0.32], [0.55, -0.8, 0.7, -0.3]]) {
        const a0 = H2(u0, v0), b0 = H2(u1, v1), c0 = H2((u0 + u1) / 2 + 0.1, (v0 + v1) / 2 - 0.08);
        frg.beginPath(); frg.moveTo(a0.x, a0.y); frg.quadraticCurveTo(c0.x, c0.y, b0.x, b0.y); frg.stroke();
      }
      // 앞머리 끝 쪽 그늘(겹친 머리 아래)
      const lo = frg.createLinearGradient(0, hcY - 0.5 * hR, 0, hcY - 0.2 * hR);
      lo.addColorStop(0, 'rgba(0,0,0,0)'); lo.addColorStop(1, 'rgba(0,0,0,0.28)');
      frg.fillStyle = lo; frg.fillRect(0, 0, CW, CH);
      frg.restore();
      hg.drawImage(front, 0, 0);
      hm.drawImage(front, 0, 0);
      // 머리·얼굴 윤곽선
      hg.drawImage(outlineOf(head, rgba(mix(hairRGB, skin, 0.25).map((v) => v * 0.6), 0.6), Math.max(1, 0.12 * s)), 0, 0);
    }
    // 몸 윤곽선(웹툰처럼 가는 선)
    g.drawImage(outlineOf(bodyImg, lineCol, Math.max(1, 0.14 * s)), 0, 0);
    // 신발(명암·윤곽선 뒤에 따로: 피부 그늘색이 물들지 않게): 흰 로우탑 운동화(발목이 보이게). 앞에서 본 모양 + 밑창 + 끈
    for (const sd of [-1, 1]) {
      const x0 = ankleC * sd + sd * 0.4;
      const Q = (dx, y) => P(x0 + dx, y);
      const sg2 = g.createLinearGradient(cx + (x0 - 5) * s, 0, cx + (x0 + 5) * s, 0);
      sg2.addColorStop(0, '#fbfbfa'); sg2.addColorStop(0.55, '#f1f0ed'); sg2.addColorStop(1, '#d9d7d2');
      g.fillStyle = sg2;
      curve(g, [Q(-3.2, yAnkle + 0.8), Q(0, yAnkle + 1.9), Q(3.2, yAnkle + 0.8), Q(4.3, yAnkle - 3), Q(4.7, 2.0), Q(4.8, 0.4), Q(0, 0.1), Q(-4.8, 0.4), Q(-4.7, 2.0), Q(-4.3, yAnkle - 3)]);
      g.fill();
      g.strokeStyle = 'rgba(120,115,110,0.45)'; g.lineWidth = Math.max(1, 0.14 * s); g.stroke();
      g.fillStyle = '#dcdad5';
      curve(g, [Q(-4.85, 1.7), Q(0, 1.95), Q(4.85, 1.7), Q(4.85, 0.35), Q(0, 0.05), Q(-4.85, 0.35)]); g.fill(); // 밑창
      g.fillStyle = '#e9e8e4';
      curve(g, [Q(-1.6, yAnkle + 1.2), Q(1.6, yAnkle + 1.2), Q(1.9, 3.4), Q(0, 2.9), Q(-1.9, 3.4)]); g.fill(); // 혀·끈 자리
      g.strokeStyle = 'rgba(150,150,145,0.8)'; g.lineWidth = 0.28 * s; g.lineCap = 'round';
      for (let k = 0; k < 4; k++) { const y = yAnkle - 0.4 - k * 1.25; g.beginPath(); g.moveTo(...Object.values(Q(-1.3, y))); g.lineTo(...Object.values(Q(1.3, y - 0.3))); g.stroke(); }
    }

    // ---------- 최종 "사진" ----------
    const canvas = canvasOf();
    const c = canvas.getContext('2d');
    const bgG = c.createLinearGradient(0, 0, 0, CH);
    bgG.addColorStop(0, '#f3f1ee'); bgG.addColorStop(1, '#e2ded8');
    c.fillStyle = bgG; c.fillRect(0, 0, CW, CH);
    const fl = c.createRadialGradient(cx, floor + 4, 0, cx, floor + 4, (legC + 14) * s);
    fl.addColorStop(0, 'rgba(0,0,0,0.18)'); fl.addColorStop(1, 'rgba(0,0,0,0)');
    c.save(); c.translate(cx, floor + 4); c.scale(1, 0.14); c.translate(-cx, -(floor + 4));
    c.fillStyle = fl; c.beginPath(); c.arc(cx, floor + 4, (legC + 14) * s, 0, Math.PI * 2); c.fill(); c.restore();
    c.drawImage(bodyImg, 0, 0);
    c.drawImage(head, 0, 0);

    // ---------- 관절 좌표(MediaPipe 33점과 같은 순서, 0~1) ----------
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
    const set = (i, p) => { lm[i] = { x: p.x / CW, y: p.y / CH, visibility: 1 }; };
    const noseY = yAt(yHeadTop - headH * 0.62);
    set(0, V(cx, noseY));
    for (const [i, dx, dy] of [[1, 1.5, -2.2], [2, 3, -2.2], [3, 4.5, -2.2], [4, -1.5, -2.2], [5, -3, -2.2], [6, -4.5, -2.2], [7, 7, -1], [8, -7, -1], [9, 2, 3], [10, -2, 3]]) set(i, V(cx + dx * s, noseY + dy * s));
    set(11, R.sh); set(12, L.sh); set(13, R.el); set(14, L.el); set(15, R.wr); set(16, L.wr);
    for (const [i, A, off] of [[17, R, 1.5], [18, L, -1.5], [19, R, 0], [20, L, 0], [21, R, -1.5], [22, L, 1.5]]) set(i, V(A.fi.x + off * s, A.fi.y - (i >= 21 ? 4 * s : 0)));
    set(23, P(hipHalf * 0.55, yHipJoint)); set(24, P(-hipHalf * 0.55, yHipJoint));
    set(25, P(kneeC, yKnee)); set(26, P(-kneeC, yKnee));
    set(27, P(ankleC, yAnkle)); set(28, P(-ankleC, yAnkle));
    set(29, P(ankleC - 0.5, 1.5)); set(30, P(-ankleC + 0.5, 1.5));
    set(31, P(ankleC + 3, 0.8)); set(32, P(-ankleC - 3, 0.8));

    // ---------- 장면 분할(사진 모드와 같은 형식): 0 배경, 1 머리카락, 2 몸 피부, 3 얼굴 ----------
    const w = CW / 2, h = CH / 2;
    const read = (cv) => { const t = document.createElement('canvas'); t.width = w; t.height = h; const tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(cv, 0, 0, w, h); return tg.getImageData(0, 0, w, h).data; };
    const ba = read(bodyImg), ha = read(head), hma = hairMask ? read(hairMask) : null;
    const cat = new Uint8Array(w * h);
    const chinRow = yAt(yChin) / 2;
    for (let i = 0; i < w * h; i++) {
      const row = Math.floor(i / w);
      if (ha[i * 4 + 3] > 127) {
        // 머리카락(어두운 위쪽) / 얼굴. 대략 눈썹 위는 머리카락으로 본다
        cat[i] = hma ? (hma[i * 4 + 3] > 127 ? 1 : 3) : row < (hcY - hR * 0.35) / 2 && row < chinRow ? 1 : 3;
      } else if (ba[i * 4 + 3] > 127) cat[i] = 2;
    }
    const scene = {
      cat, w, h,
      skinColor: skin, handColor: skin,
      head, skin: bodyImg, others: null,
      illum: { rgb: [246, 244, 240], Y: 245 },
      tilt: -0.15, shadeK: 1,
      isAvatar: true,
    };
    return { canvas, pose: lm, pxPerCm: s, scene, poseCheck: { ok: true, issues: [] }, isAvatar: true, measures: m, hasFace: !!face?.img };
  }

  // 내 사진에서 얼굴·머리카락만 오려낸다(사람 분할: 1 머리카락, 3 얼굴). 결과는 이 기기에만 저장
  // segment(canvas) → { cat, w, h }(tryon.js의 segmentScene)
  async function makeFace(canvas, segment) {
    const sc = await segment(canvas);
    const W = canvas.width, H = canvas.height, { cat, w, h } = sc;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, fx0 = w, fx1 = -1, chin = -1, fsum = 0, fn = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = cat[y * w + x];
      if (c !== 1 && c !== 3) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (c === 3) { if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y > chin) chin = y; fsum += x; fn++; }
    }
    if (fn < 30) throw new Error('사진에서 얼굴을 찾지 못했어요. 얼굴이 잘 보이는 정면 사진을 골라 주세요.');
    // 품질 검사: 얼굴이 너무 작으면(캡처·먼 사진) 깨져 보이고, 손·휴대폰이 얼굴을 가리면 그대로 붙는다
    if ((fx1 - fx0 + 1) * (W / w) < 140) throw new Error('얼굴이 너무 작게 나왔어요. 얼굴이 크게 나온 사진(셀카 거리)을 골라 주세요. 화면 캡처보다 원본 사진이 좋아요.');
    let occl = 0, area = 0;
    for (let y = y0; y <= chin; y++) for (let x = fx0; x <= fx1; x++) { area++; const c = cat[y * w + x]; if (c === 5 || c === 2) occl++; }
    if (occl > area * 0.12) throw new Error('손이나 휴대폰이 얼굴을 가리고 있어요. 얼굴 전체가 보이는 사진을 골라 주세요.');
    // 원본 해상도로 자르고, 얼굴·머리카락 마스크(가장자리 부드럽게)로 알파를 만든다
    const sx = W / w, sy = H / h, pad = 2;
    const cx0 = Math.max(0, (x0 - pad) * sx), cy0 = Math.max(0, (y0 - pad) * sy);
    const cw = Math.min(W, (x1 + pad + 1) * sx) - cx0, ch = Math.min(H, (y1 + pad + 1) * sy) - cy0;
    const out = document.createElement('canvas'); out.width = Math.round(cw); out.height = Math.round(ch);
    const og = out.getContext('2d', { willReadFrequently: true });
    og.drawImage(canvas, cx0, cy0, cw, ch, 0, 0, out.width, out.height);
    const mask = document.createElement('canvas'); mask.width = w; mask.height = h;
    const mg = mask.getContext('2d');
    const md = mg.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const c = cat[i]; md.data[i * 4 + 3] = c === 1 || c === 3 ? 255 : 0; }
    mg.putImageData(md, 0, 0);
    og.globalCompositeOperation = 'destination-in';
    og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
    if ('filter' in og) og.filter = `blur(${Math.max(0.5, sx * 0.6)}px)`;
    og.drawImage(mask, cx0 / sx, cy0 / sy, cw / sx, ch / sy, 0, 0, out.width, out.height);
    og.filter = 'none';
    og.globalCompositeOperation = 'source-over';
    // 얼굴 피부색(아바타 몸 피부를 얼굴에 맞춘다): 얼굴 가운데 영역의 중앙값
    const d = og.getImageData(0, 0, out.width, out.height).data;
    const ch3 = [[], [], []];
    const fcx = (fsum / fn) * sx - cx0, fcy = ((chin * sy - cy0) + (y0 * sy - cy0)) / 2;
    const rw = (fx1 - fx0) * sx * 0.25;
    for (let y = Math.max(0, Math.round(fcy - rw)); y < Math.min(out.height, fcy + rw); y += 2) for (let x = Math.max(0, Math.round(fcx - rw)); x < Math.min(out.width, fcx + rw); x += 2) {
      const i = (y * out.width + x) * 4;
      if (d[i + 3] < 200 || !(d[i] > d[i + 2])) continue;
      ch3[0].push(d[i]); ch3[1].push(d[i + 1]); ch3[2].push(d[i + 2]);
    }
    const med = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };
    return {
      img: out,
      chinY: (chin + 1) * sy - cy0,
      centerX: (fsum / fn) * sx - cx0,
      faceW: (fx1 - fx0 + 1) * sx,
      skin: ch3[0].length > 20 ? ch3.map(med) : null,
    };
  }

  // 치수가 어디서 왔는지 안내 문장
  function sourceNote(m) {
    const name = { shoulder: '어깨', chest: '가슴', waist: '허리', hip: '엉덩이', thigh: '허벅지', inseam: '다리 길이' };
    const by = { tape: [], photo: [], avg: [] };
    for (const [k, v] of Object.entries(m.src)) by[v].push(name[k]);
    const parts = [];
    if (by.tape.length) parts.push(`줄자 치수(${by.tape.join('·')})`);
    if (by.photo.length) parts.push(`체형 사진 분석(${by.photo.join('·')})`);
    if (by.avg.length) parts.push(`키 기준 평균(${by.avg.join('·')})`);
    return `아바타 체형: 키 ${m.H}cm, ${parts.join(', ')}`;
  }

  return { build, makeFace, measures, sourceNote };
})();

// ---------- 내 체형 탭: 내 아바타 미리보기 + 내 얼굴 넣기 ----------
// 얼굴은 이 기기(IndexedDB)에만 저장한다: { png, chinY, centerX, faceW, skin }
const avatarFace = { data: null, loaded: false };

async function loadAvatarFace() {
  if (avatarFace.loaded || typeof RefStore === 'undefined') return avatarFace.data;
  avatarFace.loaded = true;
  try {
    const rec = await RefStore.run('readonly', (st) => st.get('face'));
    if (rec?.png) {
      const img = await createImageBitmap(rec.png);
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      avatarFace.data = { img: c, chinY: rec.chinY, centerX: rec.centerX, faceW: rec.faceW, skin: rec.skin };
    }
  } catch (err) { console.error(err); }
  return avatarFace.data;
}

function renderAvatarCard() {
  const box = document.querySelector('#avatar-view');
  if (!box || typeof state === 'undefined') return;
  // 3D(실사)가 준비됐으면 그것을, 아니면 2D 그림(tryon.js avatarPhoto가 3D를 뒤에서 만든다)
  const a = typeof avatarPhoto === 'function' ? avatarPhoto()
    : Avatar.build(state, typeof usableAnalysis === 'function' ? usableAnalysis() : state.bodyAnalysis, state.personalColor, avatarFace.data);
  const view = document.createElement('canvas');
  view.width = a.canvas.width; view.height = a.canvas.height;
  view.getContext('2d').drawImage(a.canvas, 0, 0); // 같은 캔버스를 입혀 보기와 나눠 쓰지 않게 복사
  view.className = 'avatar-canvas';
  box.replaceChildren(view);
  document.querySelector('#avatar-note').textContent = Avatar.sourceNote(a.measures)
    + (state.body.height ? '' : ' (키를 넣으면 내 키로 그려요)');
  document.querySelector('#avatar-face-clear')?.classList.toggle('hidden', !avatarFace.data);
}

document.querySelector('#avatar-face')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = document.querySelector('#avatar-status');
  try {
    status.textContent = mp ? '얼굴 찾는 중…' : '사람 인식 모델 불러오는 중… (처음 한 번만)';
    await loadMediaPipe();
    const canvas = await photoToCanvas(file, 1280);
    const f = await Avatar.makeFace(canvas, segmentScene);
    const png = await new Promise((r) => f.img.toBlob(r, 'image/png'));
    await RefStore.run('readwrite', (st) => st.put({ png, chinY: f.chinY, centerX: f.centerX, faceW: f.faceW, skin: f.skin }, 'face'));
    avatarFace.data = f;
    avatarFace.loaded = true;
    if (typeof tryon !== 'undefined') tryon.avatar = null; // 다음에 다시 그리게
    status.textContent = '내 얼굴을 넣었어요. 이 기기에만 저장돼 있어요.';
    renderAvatarCard();
  } catch (err) {
    console.error(err);
    status.textContent = /[가-힣]/.test(err.message || '') ? err.message : '얼굴을 넣지 못했어요. 다른 사진으로 시도해 주세요.';
  }
});

document.querySelector('#avatar-face-clear')?.addEventListener('click', async () => {
  try { await RefStore.run('readwrite', (st) => st.delete('face')); } catch (err) { console.error(err); }
  avatarFace.data = null;
  if (typeof tryon !== 'undefined') tryon.avatar = null;
  document.querySelector('#avatar-status').textContent = '얼굴을 지웠어요.';
  renderAvatarCard();
});

renderAvatarCard();
loadAvatarFace().then((f) => { if (f) { if (typeof tryon !== 'undefined') tryon.avatar = null; renderAvatarCard(); } });
