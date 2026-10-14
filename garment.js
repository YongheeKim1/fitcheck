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

  function fillShape(ctx, polys, color, from, to) {
    const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    grad.addColorStop(0, shade(color, -0.28));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, shade(color, -0.28));
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = grad;
    ctx.strokeStyle = shade(color, -0.45);
    ctx.lineJoin = 'round';
    for (const pts of polys) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.globalAlpha = 0.88;
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
    const { g, pxPerCm: s, color } = o;
    if (['waist', 'thigh', 'rise', 'length'].some((k) => g[k] == null)) {
      return { ok: false, notes: ['입혀 보려면 허리·허벅지·밑위·총장이 필요해요.'] };
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
    fillShape(ctx, [poly], color, sub(Hl, mul(n, hW / 2)), add(Hl, mul(n, hW / 2)));

    // 다리 안쪽 솔기선: 다리를 붙이고 서도 두 다리가 구분되게
    ctx.save();
    ctx.strokeStyle = shade(color, -0.5);
    ctx.lineWidth = lw;
    for (const leg of legs) {
      ctx.beginPath();
      leg.inner.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();

    // 허리 밴드
    const band = mul(u, 4 * s);
    const wl = sub(T, mul(n, wW / 2)), wr = add(T, mul(n, wW / 2));
    fillShape(ctx, [[wl, wr, add(wr, band), add(wl, band)]], shade(color, -0.15), wl, wr);

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
    return { ok: true, notes };
  }

  // ---------------- 상의 ----------------
  function drawTop(ctx, o) {
    const { g, pxPerCm: s, color } = o;
    if (['shoulder', 'chest', 'length'].some((k) => g[k] == null)) {
      return { ok: false, notes: ['입혀 보려면 어깨·가슴·총장이 필요해요.'] };
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
    fillShape(ctx, [bodyPoly], color, armpit(-1), armpit(1));

    // 소매: 팔(어깨 봉제선 → 팔꿈치 → 손목 → 손끝)을 따라가는 관. 몸판 위에 그린다(팔이 몸 옆에 있으므로)
    if (g.sleeve != null) {
      const sleeves = [];
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
        sleeves.push([sp, ...outer, ...inner.slice().reverse(), ap]);
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
      fillShape(ctx, sleeves, color, sub(M, mul(n, g.shoulder * s)), add(M, mul(n, g.shoulder * s)));
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
    return { ok: true, notes };
  }

  function draw(ctx, opts) {
    return opts.category === 'top' ? drawTop(ctx, opts) : drawBottom(ctx, opts);
  }

  root.GarmentRender = { draw, visW, walk };
  if (typeof module !== 'undefined') module.exports = root.GarmentRender;
})(typeof window !== 'undefined' ? window : globalThis);
