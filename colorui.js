'use strict';

// ---------- 퍼스널 컬러 분석 화면 + 옷 색 평가 ----------
// app.js(state, loadMediaPipe, photoToCanvas ...), tryon.js(tryon, setColor), color.js(PersonalColor)를 쓴다.
const VERDICT_LABEL = { good: '잘 어울림', ok: '무난', caution: '주의' };
const VERDICT_CLASS = { good: 'ok', ok: 'warn', caution: 'bad' };
const UNDERTONE_LABEL = { warm: '웜톤(노란 기)', cool: '쿨톤(붉은·푸른 기)', neutral: '뉴트럴(중간)' };

// 피부를 잴 곳: 양 볼과 이마(MediaPipe 얼굴 랜드마크 번호). 눈·입술·콧구멍은 피한다
const SKIN_POINTS = [50, 101, 205, 280, 330, 425, 151, 108, 337];
let faceSession = null; // { canvas, lm, wb, img } — 메모리에만 둔다

function pcStatus(text, kind = '') {
  const el = $('#pc-status');
  el.className = 'hint import-status ' + kind;
  el.innerHTML = text;
}

$('#face-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    pcStatus(mp ? '얼굴 색 분석 중…' : '얼굴 인식 모델 불러오는 중… (처음 한 번만)');
    await loadMediaPipe();
    const canvas = await photoToCanvas(file, 1280);
    const lm = mp.face.detect(canvas).faceLandmarks?.[0];
    if (!lm) throw new Error('얼굴을 찾지 못했어요. 얼굴이 크게, 정면으로 나온 사진을 써 주세요.');
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    faceSession = { canvas, lm, img, wb: [1, 1, 1] };
    runPersonalColor();
    pcStatus('');
    $('#pc-result').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    pcStatus(esc(/[가-힣]/.test(err.message) ? err.message : '사진을 분석하지 못했어요. 다른 사진으로 시도해 주세요.'), 'err');
  }
});

// 얼굴 랜드마크 위치에서 피부·머리·눈 색을 재서 판정
function runPersonalColor() {
  const { canvas, lm, img, wb } = faceSession;
  const P = (i) => ({ x: lm[i].x * canvas.width, y: lm[i].y * canvas.height });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const faceW = dist(P(234), P(454));
  const marks = [];

  // 피부: 볼·이마 9곳
  const skinPx = [];
  const r = faceW * 0.035;
  for (const i of SKIN_POINTS) {
    const p = P(i);
    skinPx.push(...PersonalColor.sampleCircle(img, p.x, p.y, r, wb));
    marks.push({ ...p, r, kind: 'skin' });
  }
  const skin = PersonalColor.robustMean(skinPx);

  // 머리: 이마 위쪽(이마 중앙에서 얼굴 길이의 22% 위). 피부보다 확실히 어두울 때만 머리로 인정
  const top = P(10), chin = P(152);
  const hp = { x: top.x - (chin.x - top.x) * 0.22, y: top.y - (chin.y - top.y) * 0.22 };
  const hr = faceW * 0.07;
  let hair = PersonalColor.robustMean(PersonalColor.sampleCircle(img, hp.x, hp.y, hr, wb));
  if (hair && PersonalColor.linearToLab(hair).L > PersonalColor.linearToLab(skin).L - 12) hair = null;
  if (hair) marks.push({ ...hp, r: hr, kind: 'hair' });

  // 눈동자: 홍채 중심(468, 473)과 가장자리(469, 474). 동공(가운데)과 반사광은 뺀다
  let eye = null;
  if (lm.length >= 478) {
    const px = [];
    for (const [c, edge] of [[468, 469], [473, 474]]) {
      const pc = P(c);
      const R = dist(pc, P(edge));
      if (R < 3) continue;
      px.push(...PersonalColor.sampleCircle(img, pc.x, pc.y, R * 0.85, wb, R * 0.35));
      marks.push({ ...pc, r: R, kind: 'eye' });
    }
    eye = PersonalColor.robustMean(px, 0.1, 0.6);
  }

  const pc = PersonalColor.analyze({ skin, hair, eye });
  state.personalColor = { ...pc, date: new Date().toISOString().slice(0, 10), whiteBalanced: wb.some((k) => Math.abs(k - 1) > 0.01) };
  saveState();
  renderPersonalColor(state.personalColor, marks);
  updateColorVerdict(tryon.color);
}

function swatch(label, c) {
  return c ? `<div class="swatch"><i style="background:${c.hex}"></i><span>${label}</span></div>` : '';
}

function chips(list) {
  return `<div class="chips">${list.map((p) =>
    `<button type="button" class="chip" data-hex="${p.hex}" title="${esc(p.name)}"><i style="background:${p.hex}"></i>${esc(p.name)}</button>`).join('')}</div>`;
}

function renderPersonalColor(pc, marks) {
  const box = $('#pc-result');
  box.classList.remove('hidden');
  const main = PersonalColor.SEASONS[pc.season];
  const second = pc.second ? PersonalColor.SEASONS[pc.second] : null;
  const avoid = PersonalColor.SEASONS[PersonalColor.OPPOSITE[pc.season]];
  const facts = [
    `피부 색상각 ${pc.skin.h.toFixed(0)}° (작을수록 붉은 기, 클수록 노란 기)`,
    `피부 밝기 L* ${pc.skin.L.toFixed(0)}`,
    pc.contrast != null ? `피부와 ${pc.hair ? '머리' : '눈'}의 밝기 대비 ${pc.contrast}` : null,
  ].filter(Boolean);

  box.innerHTML = `
    <h2>퍼스널 컬러 결과 <span class="hint" style="font-weight:400">(${esc(pc.date)}${pc.whiteBalanced ? ' · 조명 보정함' : ''})</span></h2>
    <div id="pc-canvas-slot"></div>
    <div class="swatches">${swatch('피부', pc.skin)}${swatch('머리', pc.hair)}${swatch('눈', pc.eye)}</div>
    <p class="heads-big" style="font-size:30px">${esc(main.name)}${second ? ` <small>+ ${esc(second.name)}</small>` : ''}</p>
    <p class="heads-sub">${UNDERTONE_LABEL[pc.undertone]} · ${esc(main.desc)}</p>
    <h3>잘 어울리는 색</h3>
    <p class="hint">색을 누르면 입혀 보기 색으로 바로 써요.</p>
    ${chips(PersonalColor.myPalette(pc))}
    <h3>피하면 좋은 색 (${esc(avoid.name)})</h3>
    ${chips(avoid.palette)}
    <p class="hint" style="margin-top:10px">${facts.map(esc).join(' · ')}</p>
    <p class="hint">조명·카메라 보정에 따라 결과가 달라질 수 있어요. 전문 진단이 아니라 색 측정에 기반한 참고용이에요.</p>
  `;
  if (faceSession && marks) $('#pc-canvas-slot').appendChild(drawFaceMarks(marks));
}

// 사진 위에 잰 위치 표시. 흰 종이/벽을 누르면 화이트밸런스 보정
function drawFaceMarks(marks) {
  const { canvas } = faceSession;
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.className = 'analysis-canvas pick-canvas';
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0);
  const lw = Math.max(2, canvas.width / 400);
  const color = { skin: '#10b981', hair: '#f59e0b', eye: '#3b82f6' };
  for (const m of marks) {
    g.strokeStyle = color[m.kind];
    g.lineWidth = lw;
    g.beginPath();
    g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    g.stroke();
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = '<p class="hint">초록: 피부 · 주황: 머리 · 파랑: 눈. 사진 속 <b>흰 종이나 흰 벽</b>을 누르면 조명 색을 보정해요.</p>';
  wrap.prepend(c);
  c.addEventListener('click', (e) => {
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * c.width;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    const raw = PersonalColor.robustMean(PersonalColor.sampleCircle(faceSession.img, x, y, Math.max(4, c.width / 120)), 0.1, 0.9);
    if (!raw) return;
    const lab = PersonalColor.linearToLab(raw);
    if (lab.L < 55 || Math.hypot(lab.a, lab.b) > 25) {
      pcStatus('누른 곳이 흰색이 아닌 것 같아요. 흰 종이나 흰 벽을 눌러 주세요.', 'err');
      return;
    }
    faceSession.wb = PersonalColor.whiteBalanceFrom(raw);
    pcStatus('흰색 기준으로 조명 색을 보정했어요.', 'ok');
    runPersonalColor();
  });
  return wrap;
}

// 팔레트 색을 누르면 입혀 보기 색으로
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const hex = chip.dataset.hex;
  if (lastResults) {
    setColor(hex);
    if (chip.closest('#pc-result')) pcStatus(`'${esc(chip.title)}'을(를) 입혀 보기 색으로 지정했어요. 핏 비교 탭에서 확인하세요.`, 'ok');
  } else {
    tryon.color = hex;
    pcStatus(`'${esc(chip.title)}'을(를) 골랐어요. 핏 비교에서 옷을 비교하면 이 색으로 입혀 봐요.`, 'ok');
  }
});

// ---------- 옷 색 평가(입혀 보기 카드) ----------
function updateColorVerdict(hex) {
  const box = $('#color-verdict');
  if (!box) return;
  const pc = state.personalColor;
  if (!pc || !hex) {
    box.innerHTML = '<p class="hint">내 체형 탭에서 퍼스널 컬러를 분석하면 이 색이 어울리는지 알려 줘요.</p>';
    return;
  }
  const r = PersonalColor.evaluate(hex, pc);
  box.innerHTML = `
    <div class="verdict-line">
      <span class="badge ${VERDICT_CLASS[r.verdict]}">${VERDICT_LABEL[r.verdict]} ${r.score}점</span>
      <span class="hint" style="margin:0">내 톤: ${esc(PersonalColor.SEASONS[pc.season].name)}</span>
    </div>
    <ul class="note-list">${r.reasons.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    ${r.alternatives.length ? `<p class="hint" style="margin:6px 0 4px">이런 색이 더 잘 어울려요</p>${chips(r.alternatives)}` : ''}
  `;
}

// ---------- 상품 사진에서 색 고르기 ----------
let productImg = null;

$('#product-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const src = await photoToCanvas(file, 1000);
  productImg = { canvas: src, img: src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height) };
  drawProduct();
  $('#product-pick').classList.remove('hidden');
});

function drawProduct(mark) {
  const c = $('#product-canvas');
  c.width = productImg.canvas.width;
  c.height = productImg.canvas.height;
  const g = c.getContext('2d');
  g.drawImage(productImg.canvas, 0, 0);
  if (mark) {
    g.lineWidth = Math.max(2, c.width / 250);
    g.strokeStyle = '#fff';
    g.beginPath();
    g.arc(mark.x, mark.y, mark.r + g.lineWidth, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = '#000';
    g.beginPath();
    g.arc(mark.x, mark.y, mark.r, 0, Math.PI * 2);
    g.stroke();
  }
}

$('#product-canvas').addEventListener('click', (e) => {
  if (!productImg) return;
  const c = e.currentTarget;
  const rect = c.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * c.width;
  const y = ((e.clientY - rect.top) / rect.height) * c.height;
  const r = Math.max(4, c.width / 80);
  // 주름 그림자와 반사광을 빼고 평균 → 옷 원단의 대표 색
  const lin = PersonalColor.robustMean(PersonalColor.sampleCircle(productImg.img, x, y, r), 0.25, 0.75);
  if (!lin) return;
  drawProduct({ x, y, r });
  setColor(PersonalColor.linearToHex(lin));
});

// ---------- 시작 ----------
if (state.personalColor) renderPersonalColor(state.personalColor);
updateColorVerdict(tryon.color);
