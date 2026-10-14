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
  const a = state.bodyAnalysis;
  const g = a?.girths || {};
  return {
    shoulder: b.shoulder ?? a?.shoulderWidthCm ?? undefined,
    chest: b.chest ?? g.chest ?? undefined,
    waist: b.waist ?? g.waist ?? undefined,
    hip: b.hip ?? g.hip ?? undefined,
    thigh: b.thigh ?? g.thigh ?? undefined,
  };
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
  if (!tryon.photoUploaded && lastPhoto) tryon.photo = lastPhoto;
  if (tryon.photo) renderTryonPhoto();
  else tryonStatus('전신 사진을 고르거나 카메라로 볼 수 있어요.');
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
function renderTryonPhoto() {
  const { canvas, pose, pxPerCm } = tryon.photo;
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.className = 'analysis-canvas';
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const res = GarmentRender.draw(ctx, garmentOpts({ lm: pose, W: c.width, H: c.height, mirror: false, pxPerCm }));
  $('#tryon-view').replaceChildren(c);
  $('#tryon-notes').innerHTML = res.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  tryonStatus('');
}

$('#tryon-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const heightCm = state.body.height;
  if (!heightCm) {
    tryonStatus("'내 체형' 탭에서 키를 먼저 입력해 주세요. 키로 사진 속 크기를 cm로 바꿔요.", 'err');
    return;
  }
  try {
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
    tryon.photo = { canvas, pose: det.pose, pxPerCm };
    tryon.photoUploaded = true;
    renderTryonPhoto();
  } catch (err) {
    console.error(err);
    tryonStatus(esc(/[가-힣]/.test(err.message) ? err.message : '사진을 분석하지 못했어요. 다른 사진으로 시도해 주세요.'), 'err');
  }
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
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const mirror = l.facing === 'user';
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();

    const res = l.landmarker.detectForVideo(video, performance.now());
    const lm = res.landmarks?.[0];
    if (!lm) {
      l.smooth = null;
      liveHint('몸이 보이게 카메라에서 조금 떨어져 주세요.');
    } else {
      l.smooth = smoothLandmarks(l.smooth, lm);
      const need = lastResults.category === 'top' ? [11, 12, 23, 24] : [23, 24, 25, 26, 27, 28];
      if (need.some((i) => (lm[i].visibility ?? 1) < 0.5)) {
        liveHint(lastResults.category === 'top' ? '어깨부터 골반까지 보이게 해 주세요.' : '골반부터 발끝까지 보이게 해 주세요.');
      } else {
        // 어깨 관절 간격(px) ÷ 내 어깨 관절 간격(cm) = 1cm당 px. 거리가 바뀌어도 크기가 맞는다
        const sw = Math.hypot((l.smooth[11].x - l.smooth[12].x) * W, (l.smooth[11].y - l.smooth[12].y) * H);
        const scale = sw / shoulderJointCm();
        l.scale = l.scale ? l.scale + (scale - l.scale) * 0.2 : scale;
        const r = GarmentRender.draw(ctx, garmentOpts({ lm: l.smooth, W, H, mirror, pxPerCm: l.scale }));
        liveHint(r.notes.slice(0, 2).join(' '));
      }
    }
  }
  l.raf = requestAnimationFrame(liveLoop);
}

async function openLive() {
  if (!lastResults) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    tryonStatus('이 브라우저에서는 카메라를 쓸 수 없어요. https 주소로 열었는지 확인해 주세요.', 'err');
    return;
  }
  $('#live').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  $('#live-hint').textContent = tryon.liveModel ? '카메라 켜는 중…' : '자세 인식 모델 불러오는 중… (처음 한 번만)';
  tryon.live = { facing: 'user', lastHint: 0, lastHintText: '' };
  try {
    tryon.live.landmarker = await getLiveModel();
    tryon.live.stream = await startCamera(tryon.live.facing);
    $('#live-hint').textContent = '전신이 보이게 서 주세요.';
    liveLoop();
  } catch (err) {
    console.error(err);
    closeLive();
    tryonStatus(err.name === 'NotAllowedError'
      ? '카메라 권한이 거부됐어요. 브라우저 설정에서 카메라를 허용해 주세요.'
      : '카메라를 켜지 못했어요.', 'err');
  }
}

function closeLive() {
  stopCamera();
  tryon.live = null;
  $('#live').classList.add('hidden');
  document.body.classList.remove('no-scroll');
}

$('#open-live').addEventListener('click', openLive);
$('#live-close').addEventListener('click', closeLive);
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
