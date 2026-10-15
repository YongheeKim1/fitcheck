'use strict';

// ---------- 내 몸에 입혀 보기: 사진 모드 / 라이브 카메라 모드 ----------
// app.js의 전역(state, lastResults, lastPhoto, loadMediaPipe, detectPose ...)과 garment.js의 GarmentRender를 쓴다.
const LIVE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const DEFAULT_COLOR = { bottom: '#34507f', top: '#d9d4c7' };

const tryon = {
  sizeIndex: 0,
  category: null,
  color: null,
  photo: null,       // { canvas, pose, pxPerCm }
  live: null,        // { stream, raf, landmarker, facing, smooth, scale, lastHint }
  liveModel: null,
  garment: null,     // 상품 사진에서 오려낸 옷(garmentsource.js 결과)
  garmentFile: null, // 종류(상의/바지)가 바뀌면 다시 분석하려고 보관
  useTexture: true,  // 옷 사진으로 입히기 / 단색 도식
};

function tryonStatus(text, kind = '') {
  const el = $('#tryon-status');
  el.className = 'hint import-status ' + kind;
  el.innerHTML = text;
}

// 몸 치수: 줄자로 잰 값 우선, 없으면 사진 분석 추정치
function bodyForRender() {
  const b = state.body;
  const a = usableAnalysis();
  const g = a?.girths || {};
  return {
    shoulder: b.shoulder ?? a?.shoulderWidthCm ?? undefined,
    chest: b.chest ?? g.chest ?? undefined,
    waist: b.waist ?? g.waist ?? undefined,
    hip: b.hip ?? g.hip ?? undefined,
    thigh: b.thigh ?? g.thigh ?? undefined,
  };
}

// 체형 탭 사진 분석 결과: 자세가 나쁜 사진(팔을 들었거나 거울 셀카 등)으로 한 분석은 판정에 쓰지 않는다
function usableAnalysis() {
  const a = state.bodyAnalysis;
  return a && !(a.poseIssues && a.poseIssues.length) ? a : null;
}

// 판정에 쓴 몸 치수가 어디서 왔는지(줄자 / 체형 사진 분석 / 이 사진에서 추정)
const PART_NAMES = { shoulder: '어깨', chest: '가슴', waist: '허리', hip: '엉덩이', thigh: '허벅지' };
function bodySourceNote(category) {
  const keys = category === 'top' ? ['shoulder', 'chest'] : ['waist', 'hip', 'thigh'];
  const a = usableAnalysis();
  const groups = { tape: [], photo: [], est: [] };
  for (const k of keys) {
    if (state.body[k] != null) groups.tape.push(PART_NAMES[k]);
    else if (a && (k === 'shoulder' ? a.shoulderWidthCm : a.girths?.[k]) != null) groups.photo.push(PART_NAMES[k]);
    else groups.est.push(PART_NAMES[k]);
  }
  const parts = [];
  if (groups.tape.length) parts.push(`줄자로 잰 값(${groups.tape.join('·')})`);
  if (groups.photo.length) parts.push(`체형 사진 분석(${groups.photo.join('·')})`);
  if (groups.est.length) parts.push(`이 사진에서 추정(${groups.est.join('·')})`);
  return `판정에 쓴 내 몸 치수: ${parts.join(', ')}`;
}

// 자세 검사 결과를 안내 문장으로
function poseAdvice(check) {
  if (!check || check.ok) return '';
  return `${check.issues.map((i) => i.text).join(', ')}. 옷 위치와 판정이 부정확할 수 있어요. `
    + '정면으로 서서 팔은 몸 옆에 내리고, 머리부터 발끝까지 나오게 찍은 사진이 가장 정확해요(타이머나 다른 사람이 찍어 주기).';
}

function shoulderJointCm() {
  return state.bodyAnalysis?.shoulderJointCm ?? (state.body.height ? state.body.height * 0.177 : 31);
}

function garmentOpts(extra) {
  const r = lastResults.results[tryon.sizeIndex] || lastResults.selected;
  return {
    category: lastResults.category,
    g: r.row,
    color: tryon.color,
    stretch: state.draft.stretch,
    body: bodyForRender(),
    texture: tryon.useTexture && tryon.garment?.category === lastResults.category ? tryon.garment : null,
    ...extra,
  };
}

// 비교 결과가 새로 나오거나 사이즈 탭이 바뀌면 app.js가 부른다
function onCompareResult() {
  const { results, best, selected, category } = lastResults;
  $('#tryon').classList.remove('hidden');
  tryon.sizeIndex = results.indexOf(selected);
  if (tryon.category !== category) {
    tryon.category = category;
    tryon.color = DEFAULT_COLOR[category];
  }
  // 상품 사진을 이미 골랐는데 종류(상의/바지)가 바뀌었으면 그 종류의 옷을 다시 오려낸다(colorui.js)
  if (tryon.garmentFile && tryon.garment?.category !== category && typeof cutGarment === 'function') cutGarment();
  const options = results.map((r, i) =>
    `<option value="${i}">${esc(r.row.size || `#${i + 1}`)}${r === best ? ' (추천)' : ''}</option>`).join('');
  for (const id of ['#tryon-size', '#live-size']) {
    $(id).innerHTML = options;
    $(id).value = String(tryon.sizeIndex);
  }
  $('#tryon-color').value = tryon.color;
  $('#live-color').value = tryon.color;
  if (typeof updateColorVerdict === 'function') updateColorVerdict(tryon.color);
  // 여기서 따로 고른 사진이 없으면 내 체형 탭에서 마지막으로 분석한 사진으로 바로 입혀 본다
  // 순서: 여기서 직접 고른 사진 > 저장해 둔 기준 사진 > 체형 탭 사진
  if (!tryon.photoUploaded) {
    if (tryon.refPhoto) tryon.photo = tryon.refPhoto;
    else if (lastPhoto) tryon.photo = lastPhoto;
    if (!tryon.refPhoto && !tryon.refLoading && !tryon.refChecked) loadRefPhoto();
  }
  if (tryon.photo) renderTryonPhoto();
  else if (!tryon.refLoading) tryonStatus('전신 사진을 고르거나 카메라로 볼 수 있어요.');
}

function setSize(i) {
  tryon.sizeIndex = Number(i);
  $('#tryon-size').value = String(i);
  $('#live-size').value = String(i);
  if (tryon.photo) renderTryonPhoto();
}

function setColor(c) {
  tryon.color = c;
  $('#tryon-color').value = c;
  $('#live-color').value = c;
  if (typeof updateColorVerdict === 'function') updateColorVerdict(c); // colorui.js
  if (tryon.photo) renderTryonPhoto();
}

$('#tryon-size').addEventListener('change', (e) => setSize(e.target.value));
$('#live-size').addEventListener('change', (e) => setSize(e.target.value));
$('#tryon-color').addEventListener('input', (e) => setColor(e.target.value));
$('#live-color').addEventListener('input', (e) => setColor(e.target.value));

// ---------- 사진 모드 ----------
// ---------- 내 사진 분석: 피부·얼굴·머리 자리와 조명 색 ----------
// 사진 속 원래 옷 위치(지우기용), 손·얼굴·머리(옷 위로 다시 올리기용), 조명 색(옷 사진 색 맞추기용)
// 사진은 메모리에만 있고 저장·전송하지 않는다
async function segmentScene(canvas) {
  const seg = await getClothesSegmenter(); // garmentsource.js
  const r = seg.segment(canvas);
  const m = r.categoryMask;
  const cat = Uint8Array.from(m.getAsUint8Array());
  const w = m.width, h = m.height;
  r.close?.();
  const W = canvas.width, H = canvas.height;
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const layer = (keep) => {
    const out = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      const row = Math.floor((y * h) / H) * w;
      for (let x = 0; x < W; x++) {
        if (!keep(cat[row + Math.floor((x * w) / W)])) continue;
        const i = (y * W + x) * 4;
        out.data[i] = src.data[i]; out.data[i + 1] = src.data[i + 1]; out.data[i + 2] = src.data[i + 2]; out.data[i + 3] = 255;
      }
    }
    const raw = document.createElement('canvas');
    raw.width = W; raw.height = H;
    raw.getContext('2d').putImageData(out, 0, 0);
    if (!('filter' in CanvasRenderingContext2D.prototype)) return raw;
    const soft = document.createElement('canvas'); // 가장자리를 살짝 흐려 오려 붙인 티가 덜 나게
    soft.width = W; soft.height = H;
    const sg = soft.getContext('2d');
    sg.filter = 'blur(0.8px)';
    sg.drawImage(raw, 0, 0);
    return soft;
  };
  // 피부 평균색(손·팔·얼굴): 원래 옷이 살짝 삐져나온 곳을 덮을 때 쓴다
  let sr = 0, sgc = 0, sbc = 0, sn = 0;
  const handPx = []; let hn = 0; // 손·팔 피부만(얼굴은 화장·조명이 달라 팔 색으로 쓰기엔 덜 맞는다)
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const c = cat[Math.floor((y * h) / H) * w + Math.floor((x * w) / W)];
    if (c !== 2 && c !== 3) continue;
    const i = (y * W + x) * 4;
    sr += src.data[i]; sgc += src.data[i + 1]; sbc += src.data[i + 2]; sn++;
    // 분할 경계에 섞인 배경 픽셀은 빼고 피부다운 색만(붉은 기가 가장 강한 색)
    if (c === 2) {
      const R = src.data[i], G = src.data[i + 1], B = src.data[i + 2];
      if (R > 60 && R > G && R > B && R - Math.min(G, B) > 12) { handPx.push(R, G, B); hn++; }
    }
  }
  return {
    cat, w, h,
    skinColor: sn > 50 ? [sr / sn, sgc / sn, sbc / sn] : null,
    handColor: hn > 50 ? [0, 1, 2].map((k) => { const v = []; for (let j = k; j < handPx.length; j += 3) v.push(handPx[j]); v.sort((a, b) => a - b); return v[v.length >> 1]; }) : null,
    head: layer((c) => c === 1 || c === 3), // 머리카락·얼굴
    skin: layer((c) => c === 2),            // 몸 피부(손·팔)
    others: layer((c) => c === 5),          // 소품(손에 든 휴대폰·가방 등): 손 근처만 옷 위로
    illum: estimateIllum(src.data, W, H, (x, y) => cat[Math.floor((y * h) / H) * w + Math.floor((x * w) / W)] === 0),
    // 빛 방향: 옷·피부의 줄마다 왼쪽→오른쪽 밝기 기울기
    tilt: rowTilt(src.data, W, H, (x, y) => { const c = cat[Math.floor((y * h) / H) * w + Math.floor((x * w) / W)]; return c === 2 || c === 4; }),
    // 그림자 세기: 피부 밝기의 퍼짐(밝은 쪽 90% / 어두운 쪽 10%). 직사광일수록 크다
    shadeK: shadowStrength(src.data, W, H, (x, y) => cat[Math.floor((y * h) / H) * w + Math.floor((x * w) / W)] === 2),
  };
}

// 줄마다 "가장 왼쪽 → 가장 오른쪽까지 밝기가 몇 % 바뀌는지"를 재서 중앙값을 낸다(+면 오른쪽이 밝다).
// 줄 안에서만 비교하므로 위아래로 색이 다른 상의·바지 경계에 속지 않는다
function rowTilt(d, W, H, isIn) {
  const rel = [];
  for (let y = 0; y < H; y += 3) {
    let n = 0, sx = 0, sl = 0, sxx = 0, sxl = 0, x0 = Infinity, x1 = -Infinity;
    for (let x = 0; x < W; x += 2) {
      if (!isIn(x, y)) continue;
      const i = (y * W + x) * 4;
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++; sx += x; sl += L; sxx += x * x; sxl += x * L;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    if (n < 15 || x1 - x0 < W * 0.05) continue;
    const mx = sx / n, ml = sl / n, vx = sxx / n - mx * mx;
    if (vx <= 0 || ml < 8) continue;
    rel.push((((sxl / n - mx * ml) / vx) * (x1 - x0)) / ml);
  }
  if (rel.length < 8) return 0;
  rel.sort((a, b) => a - b);
  return Math.max(-0.6, Math.min(0.6, rel[Math.floor(rel.length / 2)]));
}

function shadowStrength(d, W, H, isIn) {
  const L = [];
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    if (!isIn(x, y)) continue;
    const i = (y * W + x) * 4;
    L.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  if (L.length < 60) return 1;
  L.sort((a, b) => a - b);
  const ratio = L[Math.floor(L.length * 0.9)] / Math.max(8, L[Math.floor(L.length * 0.1)]);
  return Math.max(0.6, Math.min(1.8, (ratio - 1) / 0.5)); // 1.5배 퍼짐을 보통(1)으로
}

// 조명 색 추정: 배경에서 가장 밝은 5% 픽셀의 평균(흰 벽·흰 배경이 조명 색을 띤다고 본다)
function estimateIllum(d, W, H, isBg) {
  const lum = [];
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      if (!isBg(x, y)) continue;
      const i = (y * W + x) * 4;
      lum.push([0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], d[i], d[i + 1], d[i + 2]]);
    }
  }
  if (lum.length < 50) return null;
  lum.sort((a, b) => b[0] - a[0]);
  const top = lum.slice(0, Math.max(10, Math.floor(lum.length * 0.05)));
  const avg = [1, 2, 3].map((k) => top.reduce((sum, p) => sum + p[k], 0) / top.length);
  return { rgb: avg, Y: 0.299 * avg[0] + 0.587 * avg[1] + 0.114 * avg[2] };
}

// 옷 사진의 조명 색·밝기를 내 사진 조명에 맞춘다(사진마다 한 번 계산해 둔다)
function harmonizedTexture(g, scene) {
  if (!scene) return g.texture;
  if (g._harm?.scene === scene) return g._harm.canvas;
  let k = [1, 1, 1];
  if (g.illum && scene.illum) {
    const gains = scene.illum.rgb.map((v, j) => v / Math.max(1, g.illum.rgb[j]));
    const mean = (gains[0] + gains[1] + gains[2]) / 3;
    // 색 차이는 다 맞추되, 밝기는 절반만(검은 옷이 회색이 되지 않게) 0.75~1.25배 안에서
    const expo = Math.min(1.25, Math.max(0.75, Math.sqrt(scene.illum.Y / Math.max(1, g.illum.Y))));
    k = gains.map((v) => (v / mean) * expo);
  }
  const W = g.texture.width, H = g.texture.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cg = c.getContext('2d', { willReadFrequently: true });
  cg.drawImage(g.texture, 0, 0);
  const img = cg.getImageData(0, 0, W, H);
  const d = img.data;
  // 빛 방향: 상품 사진의 좌우 밝기 기울기는 걷어내고 내 사진의 기울기를 입힌다(줄마다 옷 폭 기준)
  const tp = rowTilt(d, W, H, (x, y) => d[(y * W + x) * 4 + 3] > 0);
  const tu = (scene.tilt || 0) * 0.85;
  const relight = Math.abs(tp) > 0.02 || Math.abs(tu) > 0.02;
  // 기준 폭은 옷 전체(줄마다 재면 소매 있는 줄과 없는 줄의 밝기가 달라져 가로 띠가 생긴다)
  let x0 = W, x1 = -1;
  if (relight) for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  const cx = (x0 + x1) / 2, wd = Math.max(1, x1 - x0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!d[i + 3]) continue;
      const t = relight && x1 > x0 ? (x - cx) / wd : 0;
      const f = Math.min(1.4, Math.max(0.7, (1 + tu * t) / (1 + tp * t)));
      d[i] = Math.min(255, d[i] * k[0] * f); d[i + 1] = Math.min(255, d[i + 1] * k[1] * f); d[i + 2] = Math.min(255, d[i + 2] * k[2] * f);
    }
  }
  g._tilt = { tp, tu };
  cg.putImageData(img, 0, 0);
  g._harm = { scene, canvas: c };
  return c;
}

// ---------- AI 보정(models.js): 사진마다 한 번, 끝나면 다시 그린다 ----------
function aiEnabled() {
  try { return localStorage.getItem('fc-ai') !== 'off'; } catch { return true; }
}
function updateAiToggle() {
  $('#ai-toggle').textContent = aiEnabled() ? 'AI 보정 끄기' : 'AI 보정 켜기';
}
$('#ai-toggle').addEventListener('click', () => {
  try { localStorage.setItem('fc-ai', aiEnabled() ? 'off' : 'on'); } catch { /* 저장 못 해도 이번 화면에서는 적용 */ }
  updateAiToggle();
  if (tryon.photo) renderTryonPhoto();
});
updateAiToggle();

// 깊이(입체 명암)는 사진마다 한 번. 드러난 자리 메우기는 그릴 때마다 구멍이 바뀌므로(옷·사이즈) 구멍 지문별로 한 번
async function enhanceScene(photo) {
  const scene = photo.scene;
  if (!scene || scene.depthStarted || typeof AIModels === 'undefined') return;
  scene.depthStarted = true;
  try {
    $('#ai-hint').textContent = 'AI 보정 준비 중… 처음엔 모델을 받느라 시간이 걸려요. 그동안 기본 결과를 보여 드려요.';
    scene.depthShade = await AIModels.depthShade(photo.canvas, scene);
    if (tryon.photo === photo) renderTryonPhoto();
    $('#ai-hint').textContent = 'AI 보정 적용됨(입체 명암·드러난 배경 메우기). 사진은 기기 밖으로 나가지 않아요.';
  } catch (err) {
    console.error(err);
    scene.depthStarted = false;
    $('#ai-hint').textContent = /[가-힣]/.test(err.message || '') ? err.message : 'AI 보정을 하지 못했어요. 기본 결과로 보여 드려요.';
  }
}

async function aiFillHole(photo) {
  const scene = photo.scene;
  const h = GarmentRender.lastHole();
  if (!scene || !h || scene.aiPatch?.key === h.key || scene.aiBusyKey === h.key || typeof AIModels === 'undefined') return;
  scene.aiBusyKey = h.key;
  try {
    const canvas = await AIModels.inpaintHole(photo.canvas, h.mask, h.box);
    scene.aiPatch = { key: h.key, canvas };
    if (tryon.photo === photo) renderTryonPhoto();
  } catch (err) {
    console.error(err);
  } finally {
    if (scene.aiBusyKey === h.key) scene.aiBusyKey = null;
  }
}

function renderTryonPhoto() {
  const { canvas, pose, pxPerCm, scene } = tryon.photo;
  if (scene && aiEnabled() && !scene.depthStarted) enhanceScene(tryon.photo);
  if (!scene && !tryon.photo.sceneLoading) {
    // 체형 탭에서 가져온 사진 등 아직 분석 안 된 사진: 분석이 끝나면 다시 그린다
    tryon.photo.sceneLoading = true;
    const target = tryon.photo;
    segmentScene(canvas).then((sc) => { target.scene = sc; if (tryon.photo === target) renderTryonPhoto(); }).catch((err) => console.error(err));
  }
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.className = 'analysis-canvas';
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  if (!tryon.photo.poseCheck) tryon.photo.poseCheck = BodyAnalysis.checkPose(pose, canvas.width, canvas.height);
  const check = tryon.photo.poseCheck;
  // AI 보정을 끄면 이미 계산한 결과도 쓰지 않는다
  const sceneForDraw = scene && !aiEnabled() ? { ...scene, aiPatch: null, depthShade: null } : scene;
  const opts = garmentOpts({ lm: pose, W: c.width, H: c.height, mirror: false, pxPerCm, scene: sceneForDraw || null, poseIssues: check.issues.map((i) => i.key) });
  if (opts.texture && scene) opts.texture = { ...opts.texture, texture: harmonizedTexture(opts.texture, scene) };
  const res = GarmentRender.draw(ctx, opts);
  if (scene && aiEnabled()) aiFillHole(tryon.photo); // 드러난 자리가 있으면 AI로 메운 뒤 다시 그린다
  $('#tryon-view').replaceChildren(c);
  const notes = res.ok ? [...res.notes, bodySourceNote(opts.category)] : res.notes;
  $('#tryon-notes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
  $('#size-compare-btn').classList.toggle('hidden', !res.ok || (lastResults?.results.length || 0) < 2);
  if (!$('#size-compare').classList.contains('hidden')) renderSizeCompare(); // 비교를 펼쳐 둔 상태면 같이 갱신
  const advice = poseAdvice(check);
  if (advice) tryonStatus(esc(advice), 'warn');
  else tryonStatus(tryon.photo === tryon.refPhoto ? '저장해 둔 기준 사진으로 입혀 봤어요.' : '');
  updateRefUI();
}

// 사진(파일·Blob) → 입혀 보기용 { canvas, pose, pxPerCm, scene, poseCheck }
async function analyzeTryonPhoto(file) {
  const heightCm = state.body.height;
  tryonStatus(mp ? '사진 분석 중…' : '체형 인식 모델 불러오는 중… (처음 한 번만, 약 15MB)');
  await loadMediaPipe();
  const canvas = await photoToCanvas(file);
  const det = detectPose(canvas);
  if (!det) throw new Error('사진에서 사람을 찾지 못했어요. 전신이 나온 사진인지 확인해 주세요.');
  let pxPerCm;
  try {
    const f = BodyAnalysis.analyzeFront({ mask: det.mask, pose: det.pose, face: null, heightCm });
    pxPerCm = f.pxPerCm * (canvas.width / f.maskW);
  } catch {
    // 발이 잘린 사진 등: 어깨 관절 간격으로 비율을 정한다
    const sw = Math.hypot((det.pose[11].x - det.pose[12].x) * canvas.width, (det.pose[11].y - det.pose[12].y) * canvas.height);
    pxPerCm = sw / shoulderJointCm();
  }
  tryonStatus('사진 속 손·얼굴·옷 위치 분석 중…');
  const scene = await segmentScene(canvas).catch((err) => { console.error(err); return null; });
  return { canvas, pose: det.pose, pxPerCm, scene, poseCheck: BodyAnalysis.checkPose(det.pose, canvas.width, canvas.height) };
}

$('#tryon-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!state.body.height) {
    tryonStatus("'내 체형' 탭에서 키를 먼저 입력해 주세요. 키로 사진 속 크기를 cm로 바꿔요.", 'err');
    return;
  }
  try {
    tryon.photo = await analyzeTryonPhoto(file);
    tryon.photoUploaded = true;
    renderTryonPhoto();
  } catch (err) {
    console.error(err);
    tryonStatus(esc(/[가-힣]/.test(err.message) ? err.message : '사진을 분석하지 못했어요. 다른 사진으로 시도해 주세요.'), 'err');
  }
});

// ---------- 사이즈 나란히 비교: 같은 내 사진에 사이즈마다 입혀 옆에 놓는다(최대 3개, 고른 사이즈를 가운데로) ----------
function renderSizeCompare() {
  const photo = tryon.photo;
  if (!photo || !lastResults) return;
  const { results, best } = lastResults;
  const i0 = tryon.sizeIndex;
  let idx = [i0 - 1, i0, i0 + 1].filter((i) => i >= 0 && i < results.length);
  if (idx.length < 3 && results.length >= 3) idx = i0 === 0 ? [0, 1, 2] : [results.length - 3, results.length - 2, results.length - 1];
  const { canvas, pose, pxPerCm, scene } = photo;
  const check = photo.poseCheck || BodyAnalysis.checkPose(pose, canvas.width, canvas.height);
  const sceneForDraw = scene && !aiEnabled() ? { ...scene, aiPatch: null, depthShade: null } : scene;
  const figs = idx.map((i) => {
    const r = results[i];
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const opts = garmentOpts({ lm: pose, W: c.width, H: c.height, mirror: false, pxPerCm, scene: sceneForDraw || null, poseIssues: check.issues.map((x) => x.key) });
    opts.g = r.row;
    if (opts.texture && scene) opts.texture = { ...opts.texture, texture: harmonizedTexture(opts.texture, scene) };
    GarmentRender.draw(ctx, opts);
    // 나란히 놓으면 작아지므로 옷이 있는 부분만 잘라 크게(상의: 어깨 위~골반 아래, 바지: 허리 위~발끝)
    const P = (k) => ({ x: pose[k].x * c.width, y: pose[k].y * c.height });
    const sh = (P(11).y + P(12).y) / 2, hip = (P(23).y + P(24).y) / 2, torso = Math.max(10, hip - sh);
    const cx = (P(11).x + P(12).x + P(23).x + P(24).x) / 4;
    const y0 = Math.max(0, lastResults.category === 'top' ? sh - torso * 0.45 : hip - torso * 0.5);
    const y1 = Math.min(c.height, lastResults.category === 'top' ? hip + torso * 0.7 : c.height);
    const half = Math.min(c.width / 2, ((y1 - y0) * 0.62) / 2);
    const x0 = Math.max(0, Math.min(c.width - 2 * half, cx - half));
    const crop = document.createElement('canvas');
    crop.width = Math.round(2 * half); crop.height = Math.round(y1 - y0);
    crop.getContext('2d').drawImage(c, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    // 짧은 판정: 기준 옷과 다른 곳 두 개까지(예: "허리 조금 낌 · 총장 김")
    const off = (r.parts || []).filter((p) => p.verdict.level !== 'ok').slice(0, 2).map((p) => `${p.label} ${p.verdict.text}`);
    cap.innerHTML = `<b class="${r === best ? 'best' : ''}">${esc(r.row.size || `#${i + 1}`)}${r === best ? ' (추천)' : ''}</b>${esc(off.join(' · ') || '기준 옷과 비슷')}`;
    fig.append(crop, cap);
    return fig;
  });
  $('#size-compare').replaceChildren(...figs);
}

$('#size-compare-btn').addEventListener('click', () => {
  const box = $('#size-compare');
  const open = box.classList.toggle('hidden') === false;
  $('#size-compare-btn').textContent = open ? '사이즈 비교 닫기' : '사이즈 나란히 비교';
  if (open) renderSizeCompare();
});

// ---------- 기준 사진: 좋은 정면 사진 한 장을 이 기기(IndexedDB)에만 저장해 두고 매번 그 사진에 입힌다 ----------
// 서버 동기화 대상이 아니다(사진은 기기 밖으로 나가지 않는다)
// 저장소 칸: photos(기준 사진), garments(옷장 옷 사진, 옷 id별)
const RefStore = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fitcheck-local', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['photos', 'garments']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn, store = 'photos') {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  },
  get() { return this.run('readonly', (st) => st.get('ref')); },
  put(blob) { return this.run('readwrite', (st) => st.put(blob, 'ref')); },
  clear() { return this.run('readwrite', (st) => st.delete('ref')); },
  // 옷장 옷 사진(이 기기에만. 서버에는 치수 숫자만 동기화된다)
  getGarment(id) { return this.run('readonly', (st) => st.get(id), 'garments'); },
  putGarment(id, blob) { return this.run('readwrite', (st) => st.put(blob, id), 'garments'); },
  deleteGarment(id) { return this.run('readwrite', (st) => st.delete(id), 'garments'); },
};

// 기준 사진 불러오기(핏 비교·옷장 코디가 함께 쓴다. 동시에 불려도 한 번만 분석)
function loadRefPhoto() {
  if (tryon.refPromise) return tryon.refPromise;
  if (!('indexedDB' in window) || !state.body.height) return Promise.resolve(null);
  tryon.refLoading = true;
  tryon.refPromise = (async () => {
    try {
      const blob = await RefStore.get();
      tryon.refChecked = true;
      tryon.refSaved = !!blob;
      if (!blob) return null;
      const photo = await analyzeTryonPhoto(blob);
      tryon.refPhoto = photo;
      if (!tryon.photoUploaded && lastResults) { tryon.photo = photo; renderTryonPhoto(); }
      return photo;
    } catch (err) {
      console.error(err);
      tryon.refPromise = null; // 다음에 다시 시도
      return null;
    } finally {
      tryon.refLoading = false;
      updateRefUI();
      if (lastResults && !tryon.photo) tryonStatus('전신 사진을 고르거나 카메라로 볼 수 있어요.');
    }
  })();
  return tryon.refPromise;
}

function updateRefUI() {
  const p = tryon.photo;
  const canSave = !!p && p !== tryon.refPhoto;
  const bad = !!(p?.poseCheck && !p.poseCheck.ok);
  $('#ref-photo').classList.toggle('hidden', !canSave && !tryon.refSaved);
  $('#ref-save').classList.toggle('hidden', !canSave);
  $('#ref-save').disabled = bad;
  $('#ref-clear').classList.toggle('hidden', !tryon.refSaved);
  $('#ref-status').textContent = p && p === tryon.refPhoto
    ? '기준 사진으로 입혀 보고 있어요. 사진은 이 기기에만 저장돼 있어요.'
    : bad ? '자세가 좋은 사진만 기준 사진으로 저장할 수 있어요.'
    : tryon.refSaved ? '저장해 둔 기준 사진이 있어요(이 기기에만). 이 사진으로 바꿔 저장할 수도 있어요.'
    : '이 사진을 저장해 두면 다음부터 사진을 고르지 않아도 바로 입혀 볼 수 있어요(이 기기에만 저장).';
}

$('#ref-save').addEventListener('click', async () => {
  const p = tryon.photo;
  if (!p) return;
  $('#ref-save').disabled = true;
  tryonStatus('기준 사진 저장 중…');
  try {
    const blob = await new Promise((r) => p.canvas.toBlob(r, 'image/jpeg', 0.92));
    await RefStore.put(blob);
    tryon.refPhoto = p;
    tryon.refPromise = Promise.resolve(p);
    tryon.refSaved = true;
    tryonStatus('기준 사진으로 저장했어요. 이 기기에만 저장되고 서버로 보내지 않아요.', 'ok');
  } catch (err) {
    console.error(err);
    tryonStatus('기준 사진을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.', 'err');
  }
  updateRefUI();
});

$('#ref-clear').addEventListener('click', async () => {
  try { await RefStore.clear(); } catch (err) { console.error(err); }
  if (tryon.photo === tryon.refPhoto && !tryon.photoUploaded) tryon.photo = lastPhoto || null;
  tryon.refPhoto = null;
  tryon.refSaved = false;
  tryon.refPromise = null;
  if (tryon.photo) renderTryonPhoto();
  else { $('#tryon-view').replaceChildren(); $('#tryon-notes').innerHTML = ''; }
  tryonStatus('기준 사진을 지웠어요.');
  updateRefUI();
});

// ---------- 라이브 카메라 모드 ----------
async function getLiveModel() {
  if (tryon.liveModel) return tryon.liveModel;
  const vision = await import(`${MP_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: LIVE_MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  try {
    tryon.liveModel = await vision.PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    tryon.liveModel = await vision.PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  return tryon.liveModel;
}

// 실시간 사람 분할(가벼운 selfie_multiclass, VIDEO 모드): 손·팔을 옷 위로 올리고 배경으로 조명 색을 잰다
async function getLiveSegmenter() {
  if (tryon.liveSeg) return tryon.liveSeg;
  const vision = await import(`${MP_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: SEG_MODEL, delegate }, // garmentsource.js
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
  try {
    tryon.liveSeg = await vision.ImageSegmenter.createFromOptions(fileset, opts('GPU'));
  } catch {
    tryon.liveSeg = await vision.ImageSegmenter.createFromOptions(fileset, opts('CPU'));
  }
  return tryon.liveSeg;
}

// 분할 결과(256×256 라벨) → 피부 알파 마스크 캔버스, 배경 비율로 잰 조명(2초마다)
function updateLiveSeg(l, video, now) {
  // 초당 약 6번이면 손 움직임을 따라간다. 한 프레임에 일이 몰리지 않게 두 프레임에 한 번만
  l.frame = (l.frame || 0) + 1;
  if (!l.seg || now - (l.segAt || 0) < 150 || l.frame % 2) return;
  l.segAt = now;
  let r;
  try { r = l.seg.segmentForVideo(video, now); } catch { return; }
  const m = r.categoryMask;
  if (!m) return;
  const cat = m.getAsUint8Array();
  const w = m.width, h = m.height;
  r.close?.();
  if (!l.skinMask || l.skinMask.width !== w) { l.skinMask = document.createElement('canvas'); l.skinMask.width = w; l.skinMask.height = h; }
  const g = l.skinMask.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = cat[i] === 2 ? 255 : 0;
  g.putImageData(img, 0, 0);
  l.cat = { cat: Uint8Array.from(cat), w, h };
}

function updateLiveLight(l, canvas, now) {
  if (now - (l.lightAt || 0) < 2000) return;
  l.lightAt = now;
  const sw = 96, sh = Math.max(1, Math.round((canvas.height * sw) / canvas.width));
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  const mirror = l.facing === 'user';
  const bg = l.cat ? (x, y) => {
    const xx = mirror ? sw - 1 - x : x;
    return l.cat.cat[Math.floor((y * l.cat.h) / sh) * l.cat.w + Math.floor((xx * l.cat.w) / sw)] === 0;
  } : () => true;
  const illum = estimateIllum(d, sw, sh, bg);
  if (illum) l.scene = { illum, tilt: 0 }; // 새 객체 → harmonizedTexture가 다시 계산
}

async function startCamera(facing) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const video = $('#live-video');
  video.srcObject = stream;
  await video.play();
  return stream;
}

function stopCamera() {
  const l = tryon.live;
  if (!l) return;
  cancelAnimationFrame(l.raf);
  l.stream?.getTracks().forEach((t) => t.stop());
  $('#live-video').srcObject = null;
}

function liveHint(text) {
  const l = tryon.live;
  const now = performance.now();
  if (l.lastHintText === text || now - l.lastHint < 400) return; // 글자가 깜빡이지 않게
  l.lastHint = now;
  l.lastHintText = text;
  $('#live-hint').textContent = text;
}

// 관절 좌표를 부드럽게(손떨림·검출 흔들림 줄이기)
function smoothLandmarks(prev, next, a = 0.45) {
  if (!prev) return next.map((p) => ({ ...p }));
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * a,
    y: prev[i].y + (p.y - prev[i].y) * a,
    visibility: p.visibility,
  }));
}

function liveLoop() {
  const l = tryon.live;
  if (!l) return;
  const video = $('#live-video');
  const canvas = $('#live-canvas');
  if (video.readyState >= 2 && video.videoWidth) {
    // 처리 해상도: 긴 변 640px(폰 화면에서는 차이가 거의 안 보이고, 그리는 시간이 크게 준다)
    const k = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const cw = Math.round(video.videoWidth * k), ch = Math.round(video.videoHeight * k);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const mirror = l.facing === 'user';
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();

    const now = performance.now();
    const res = l.landmarker.detectForVideo(video, now);
    updateLiveSeg(l, video, now);
    updateLiveLight(l, canvas, now);
    let lm = res.landmarks?.[0];
    // 어깨가 골반보다 아래로 잡히면 몸을 거꾸로 잘못 인식한 것(얼굴이 가려졌을 때 등): 그 프레임은 건너뛴다
    if (lm && lm[11].y > lm[23].y && lm[12].y > lm[24].y) lm = null;
    if (!lm) {
      l.smooth = null;
      liveHint('몸이 보이게 카메라에서 조금 떨어져 주세요. 얼굴이 가려지지 않게 해 주세요.');
    } else {
      l.smooth = smoothLandmarks(l.smooth, lm);
      const cats = l.outfit ? l.outfit.map((o) => o.category) : [lastResults.category];
      const need = [...new Set(cats.flatMap((c) => (c === 'top' ? [11, 12, 23, 24] : [23, 24, 25, 26, 27, 28])))];
      if (need.some((i) => (lm[i].visibility ?? 1) < 0.5)) {
        liveHint(cats.includes('bottom') ? (cats.includes('top') ? '머리부터 발끝까지 보이게 해 주세요.' : '골반부터 발끝까지 보이게 해 주세요.') : '어깨부터 골반까지 보이게 해 주세요.');
      } else {
        // 어깨 관절 간격(px) ÷ 내 어깨 관절 간격(cm) = 1cm당 px. 거리가 바뀌어도 크기가 맞는다
        const sw = Math.hypot((l.smooth[11].x - l.smooth[12].x) * W, (l.smooth[11].y - l.smooth[12].y) * H);
        const scale = sw / shoulderJointCm();
        l.scale = l.scale ? l.scale + (scale - l.scale) * 0.2 : scale;
        const check = BodyAnalysis.checkPose(l.smooth, W, H);
        const base = { lm: l.smooth, W, H, mirror, pxPerCm: l.scale, live: true, tps: false, poseIssues: check.issues.map((i) => i.key),
          seg: l.cat ? { ...l.cat, mirror } : null }; // 어깨 윤곽선(옷을 실제 어깨에 건다)
        // 옷장 코디면 여러 벌을 정한 순서대로(꺼내 입기: 바지 → 상의), 아니면 사이즈표 한 벌
        const specs = l.outfit ? l.outfit.map((o) => ({ ...o.opts, body: bodyForRender(), ...base })) : [garmentOpts(base)];
        let r = null, front = null;
        const notes = [];
        for (const opts of specs) {
          if (opts.texture && l.scene) opts.texture = { ...opts.texture, texture: harmonizedTexture(opts.texture, l.scene) };
          r = GarmentRender.draw(ctx, opts);
          if (r.ok && r.geo) front = opts.category === 'top' || !front ? r.geo : front; // 손 둘레·소매는 상의 기준
          notes.push(...(r.notes || []).slice(0, 1));
        }
        if (front && l.skinMask) liveFront(ctx, video, front, l, W, H, mirror);
        // 자세 문제가 있으면 그것부터 알려 준다(팔을 내리면 더 정확해요 등)
        liveHint(check.ok ? notes.slice(0, 2).join(' ') : `${check.issues[0].text}. 팔을 내리고 정면으로 서면 더 정확해요.`);
      }
    }
  }
  l.raf = requestAnimationFrame(liveLoop);
}

// 손·팔(피부)을 옷 위로: 손 둘레(geo.hands) 안이면서 분할에서 피부인 곳의 카메라 화면. 새 소매 안쪽은 뺀다
function liveFront(ctx, video, geo, l, W, H, mirror) {
  if (!l.front) l.front = document.createElement('canvas');
  const f = l.front;
  if (f.width !== W || f.height !== H) { f.width = W; f.height = H; }
  const g = f.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  for (const s of geo.hands) {
    g.lineWidth = s.r * 2;
    g.beginPath(); g.moveTo(s.a.x, s.a.y); g.lineTo(s.b.x, s.b.y); g.stroke();
  }
  if (geo.noSkin?.length) {
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#fff';
    for (const pts of geo.noSkin) {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fill();
    }
  }
  g.globalCompositeOperation = 'destination-in';
  g.save();
  if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
  g.imageSmoothingEnabled = true;
  g.drawImage(l.skinMask, 0, 0, W, H);
  g.restore();
  g.globalCompositeOperation = 'source-in';
  g.save();
  if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
  g.drawImage(video, 0, 0, W, H);
  g.restore();
  g.globalCompositeOperation = 'source-over';
  ctx.drawImage(f, 0, 0);
}

// 찍기: 지금 화면(보이는 그대로, 셀카면 좌우 반전)을 원본 해상도로 찍어 사진 모드의 정밀 결과로 넘긴다
async function liveShot() {
  const l = tryon.live;
  const video = $('#live-video');
  if (!l || !video.videoWidth) return;
  if (!state.body.height) { $('#live-hint').textContent = "'내 체형' 탭에서 키를 먼저 입력해 주세요."; return; }
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  const g = c.getContext('2d');
  if (l.facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(video, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const outfitMode = !!l.outfit;
  closeLive();
  if (outfitMode && typeof outfitShot === 'function') { outfitShot(blob); return; } // wardrobe.js
  try {
    tryon.photo = await analyzeTryonPhoto(blob);
    tryon.photoUploaded = true;
    renderTryonPhoto();
    $('#tryon-view').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    console.error(err);
    tryonStatus(esc(/[가-힣]/.test(err.message) ? err.message : '찍은 사진을 분석하지 못했어요. 다시 찍어 주세요.'), 'err');
  }
}

// outfit: 옷장 코디 [{ category, opts }](wardrobe.js가 만든다). 없으면 핏 비교의 사이즈표 한 벌
async function openLive(outfit = null) {
  const report = (text) => (outfit && typeof outfitStatus === 'function' ? outfitStatus(text, 'err') : tryonStatus(text, 'err'));
  if (!outfit && !lastResults) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    report('이 브라우저에서는 카메라를 쓸 수 없어요. https 주소로 열었는지 확인해 주세요.');
    return;
  }
  $('#live').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  // 옷장 코디에서는 사이즈·색 고르기가 필요 없다
  $('#live-size').classList.toggle('hidden', !!outfit);
  $('#live-color').classList.toggle('hidden', !!outfit);
  $('#live-hint').textContent = tryon.liveModel ? '카메라 켜는 중…' : '자세 인식 모델 불러오는 중… (처음 한 번만)';
  tryon.live = { facing: 'user', lastHint: 0, lastHintText: '', outfit };
  try {
    tryon.live.landmarker = await getLiveModel();
    // 분할 모델은 없어도 카메라는 돈다(손을 옷 위로 올리는 것만 빠진다)
    tryon.live.seg = await getLiveSegmenter().catch((err) => { console.error(err); return null; });
    tryon.live.stream = await startCamera(tryon.live.facing);
    $('#live-hint').textContent = '전신이 보이게 서 주세요. 마음에 드는 장면에서 "찍기"를 누르면 더 정밀하게 다시 그려요.';
    liveLoop();
  } catch (err) {
    console.error(err);
    closeLive();
    report(err.name === 'NotAllowedError'
      ? '카메라 권한이 거부됐어요. 브라우저 설정에서 카메라를 허용해 주세요.'
      : '카메라를 켜지 못했어요.');
  }
}

function closeLive() {
  stopCamera();
  tryon.live = null;
  $('#live').classList.add('hidden');
  document.body.classList.remove('no-scroll');
}

$('#open-live').addEventListener('click', () => openLive());
$('#live-close').addEventListener('click', closeLive);
$('#live-shot').addEventListener('click', liveShot);
$('#live-flip').addEventListener('click', async () => {
  const l = tryon.live;
  if (!l) return;
  stopCamera();
  l.facing = l.facing === 'user' ? 'environment' : 'user';
  l.smooth = null;
  l.scale = null;
  try {
    l.stream = await startCamera(l.facing);
    liveLoop();
  } catch {
    $('#live-hint').textContent = '이 카메라를 켜지 못했어요.';
  }
});
