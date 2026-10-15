'use strict';

// ---------- 옷장: 옷 사진(이 기기에만) + 코디 미리보기(상의·하의를 내 사진에 함께 입히기) ----------
// app.js(state, renderCloset, CATEGORY_LABEL), tryon.js(RefStore, analyzeTryonPhoto, segmentScene, harmonizedTexture,
// bodyForRender, loadRefPhoto, tryon), garmentsource.js(analyzeGarmentPhoto), garment.js(GarmentRender)를 쓴다.
const wardrobe = {
  thumbs: new Map(),     // 옷 id → 사진 미리보기 URL
  cuts: new Map(),       // `${id}:${updatedAt}` → 오려낸 옷(analyzeGarmentPhoto 결과)
  pendingPhoto: null,    // 등록 폼에서 고른 사진(저장 누를 때 기기에 저장)
  model: null,           // 코디를 입힐 내 사진({ canvas, pose, pxPerCm, scene, poseCheck })
  patches: new Map(),    // 구멍 지문 → AI(MI-GAN)가 메운 조각(코디 미리보기용)
  aiBusy: false,
};

function outfitStatus(text, kind = '') {
  const el = $('#outfit-status');
  el.className = 'hint import-status ' + kind;
  el.textContent = text;
}

// ---------- 옷 사진 ----------
async function garmentPhoto(id) {
  try { return await RefStore.getGarment(id); } catch { return null; }
}

async function fillThumb(img, id) {
  if (!wardrobe.thumbs.has(id)) {
    const blob = await garmentPhoto(id);
    wardrobe.thumbs.set(id, blob ? URL.createObjectURL(blob) : null);
  }
  const url = wardrobe.thumbs.get(id);
  if (url) { img.src = url; img.classList.remove('hidden'); return; }
  // 옷장 격자에서는 사진이 없어도 자리를 채운다(카드 높이가 들쭉날쭉하지 않게)
  if (img.closest('.closet-grid')) { img.src = NO_PHOTO; img.classList.remove('hidden'); } else img.classList.add('hidden');
}
const NO_PHOTO = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#8884"/>'
  + '<text x="50" y="54" font-size="11" text-anchor="middle" fill="#888" font-family="sans-serif">사진 없음</text></svg>');

function onClosetRendered() {
  document.querySelectorAll('#closet-list img[data-thumb]').forEach((img) => fillThumb(img, img.dataset.thumb));
  renderOutfitPickers();
  renderSavedOutfits();
}

function onItemFormOpened(p) {
  wardrobe.pendingPhoto = null;
  $('#p-photo').value = '';
  const img = $('#p-photo-preview');
  if (p) fillThumb(img, p.id); else img.classList.add('hidden');
}

$('#p-photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  wardrobe.pendingPhoto = file;
  const img = $('#p-photo-preview');
  img.src = URL.createObjectURL(file);
  img.classList.remove('hidden');
});

async function onClosetItemSaved(item) {
  if (!wardrobe.pendingPhoto) return;
  const file = wardrobe.pendingPhoto;
  wardrobe.pendingPhoto = null;
  try {
    await RefStore.putGarment(item.id, file);
    const old = wardrobe.thumbs.get(item.id);
    if (old) URL.revokeObjectURL(old);
    wardrobe.thumbs.delete(item.id);
    for (const k of [...wardrobe.cuts.keys()]) if (k.startsWith(item.id + ':')) wardrobe.cuts.delete(k);
    renderCloset();
  } catch (err) {
    console.error(err);
    alert('옷 사진을 이 기기에 저장하지 못했어요. 저장 공간을 확인해 주세요.');
  }
}

async function onClosetItemDeleted(id) {
  try { await RefStore.deleteGarment(id); } catch { /* 사진이 없던 옷 */ }
  const url = wardrobe.thumbs.get(id);
  if (url) URL.revokeObjectURL(url);
  wardrobe.thumbs.delete(id);
}

// ---------- 코디 고르기 ----------
function renderOutfitPickers() {
  for (const [cat, sel] of [['top', '#outfit-top'], ['bottom', '#outfit-bottom']]) {
    const el = $(sel);
    const prev = el.value;
    const items = state.closet.filter((p) => p.category === cat);
    el.innerHTML = '<option value="">입지 않음(지금 사진 그대로)</option>'
      + items.map((p) => `<option value="${p.id}">${esc(p.name)}${p.size ? ` (${esc(p.size)})` : ''}</option>`).join('');
    if (items.some((p) => p.id === prev)) el.value = prev;
    else if (items.length && !prev) el.value = items[0].id;
  }
}

// 옷장 옷의 실측 → 그리기용 치수 행(사이즈표 행과 같은 이름)
function itemRow(p) {
  const row = { size: p.size };
  for (const pt of partsOf(p.category)) if (p[pt.key] != null) row[pt.key] = p[pt.key];
  return row;
}

async function garmentCut(p) {
  const key = `${p.id}:${p.updatedAt || 0}`;
  if (wardrobe.cuts.has(key)) return wardrobe.cuts.get(key);
  const blob = await garmentPhoto(p.id);
  if (!blob) { wardrobe.cuts.set(key, null); return null; }
  const cut = await analyzeGarmentPhoto(blob, p.category).catch((err) => { console.error(err); return null; });
  wardrobe.cuts.set(key, cut);
  return cut;
}

// 모델 사진: 직접 고른 사진 > 저장한 기준 사진 > 핏 비교에서 쓰던 사진 > 체형 탭 사진
async function outfitModel() {
  if (wardrobe.model) return wardrobe.model;
  const ref = tryon.refPhoto || await loadRefPhoto();
  return ref || tryon.photo || lastPhoto || null;
}

$('#outfit-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!state.body.height) { outfitStatus("'내 체형' 탭에서 키를 먼저 입력해 주세요.", 'err'); return; }
  try {
    outfitStatus('사진 분석 중…');
    wardrobe.model = await analyzeTryonPhoto(file);
    wardrobe.patches.clear();
    runOutfit();
  } catch (err) {
    console.error(err);
    outfitStatus(/[가-힣]/.test(err.message) ? err.message : '사진을 분석하지 못했어요. 다른 사진으로 시도해 주세요.', 'err');
  }
});

// 넣어 입기용 상의 치수: 바지 허리선(밑위로 정한 위치) 아래 4cm까지만 내려오고(나머지는 바지 속), 밑단 폭은 바지 허리 + 2cm로 모은다.
// 상의가 원래 그보다 짧으면 null(넣어 입을 필요 없음). 계산은 garment.js의 바지·상의 위치 정하는 방식과 같다
function tuckRow(model, top, bottom, waistTop) {
  const row = itemRow(top);
  if (row.length == null || bottom.rise == null) return null;
  const { pose, pxPerCm: s } = model;
  const W = model.canvas.width, H = model.canvas.height;
  const P = (i) => ({ x: pose[i].x * W, y: pose[i].y * H });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const norm = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
  const M = mid(P(11), P(12)), hip = mid(P(23), P(24)), knee = mid(P(25), P(26));
  const uLeg = norm({ x: knee.x - hip.x, y: knee.y - hip.y });
  const thigh = Math.hypot(knee.x - hip.x, knee.y - hip.y);
  // 바지 허리 위(T) = 가랑이(골반 관절 + 허벅지 길이 10%) - 밑위
  const C = { x: hip.x + uLeg.x * thigh * 0.1, y: hip.y + uLeg.y * thigh * 0.1 };
  // 바지가 실제로 그려지기 시작하는 곳(상품 사진에서 허리가 가려졌으면 허리선보다 아래). 모르면 허리선
  const T = waistTop || { x: C.x - uLeg.x * bottom.rise * s, y: C.y - uLeg.y * bottom.rise * s };
  const uTop = norm({ x: hip.x - M.x, y: hip.y - M.y });
  const HPS = { x: M.x - uTop.x * 4 * s, y: M.y - uTop.y * 4 * s };
  const toWaist = ((T.x - HPS.x) * uTop.x + (T.y - HPS.y) * uTop.y) / s;
  const len = toWaist + 4;
  if (row.length <= len) return null;
  row.length = Math.round(len * 10) / 10;
  if (bottom.waist != null) row.hem = Math.min(row.hem ?? row.chest ?? Infinity, bottom.waist + 2);
  return row;
}

// ---------- 코디 색 조언: 퍼스널 컬러(color.js)와 위아래 색 조합 ----------
function renderOutfitColor(topHex, bottomHex) {
  const box = $('#outfit-color');
  if (!topHex && !bottomHex) { box.innerHTML = ''; return; }
  const lines = [];
  const pc = state.personalColor;
  const LABEL = { good: '잘 어울림', ok: '무난', caution: '주의' };
  const CLS = { good: 'ok', ok: 'warn', caution: 'bad' };
  for (const [name, hex] of [['상의', topHex], ['하의', bottomHex]]) {
    if (!hex) continue;
    if (!pc) continue;
    const r = PersonalColor.evaluate(hex, pc);
    // 하의는 얼굴에서 멀어 퍼스널 컬러 영향이 작다
    const note = name === '하의' && r.verdict === 'caution' ? ' 하의는 얼굴에서 멀어서 영향이 크지 않아요.' : '';
    lines.push(`<li><span class="color-dot" style="background:${hex}"></span><b>${name}</b> <span class="badge ${CLS[r.verdict]}">${LABEL[r.verdict]} ${r.score}점</span> ${esc(r.reasons[0] || '')}${esc(note)}</li>`);
  }
  if (topHex && bottomHex) lines.push(`<li>${esc(comboAdvice(topHex, bottomHex))}</li>`);
  if (!pc) lines.push('<li class="hint">내 체형 탭에서 퍼스널 컬러를 분석하면 옷 색이 나에게 어울리는지도 알려 줘요.</li>');
  box.innerHTML = `<p class="hint" style="margin:8px 0 4px">코디 색</p><ul class="note-list">${lines.join('')}</ul>`;
}

// 위아래 색 조합: 밝기 대비와 색상 관계(같은 계열 / 보색 / 무채색)
function comboAdvice(a, b) {
  const la = PersonalColor.hexToLab(a), lb = PersonalColor.hexToLab(b);
  const ca = PersonalColor.lch(la), cb = PersonalColor.lch(lb);
  const dL = Math.abs(la.L - lb.L);
  const grayA = ca.C < 10, grayB = cb.C < 10;
  let hue;
  if (grayA && grayB) hue = '둘 다 무채색이라 차분하고 실패 없는 조합이에요.';
  else if (grayA || grayB) hue = '한쪽이 무채색이라 다른 색이 자연스럽게 살아나요.';
  else {
    const dh = Math.abs(((ca.h - cb.h + 540) % 360) - 180); // 0 = 같은 색상, 180 = 정반대
    hue = dh < 35 ? '같은 계열 색(톤온톤)이라 정돈돼 보여요.'
      : dh > 140 ? '보색에 가까운 대비 조합이에요. 한쪽 채도를 낮추면 더 안정적이에요.'
      : '서로 다른 계열 색이라 경쾌한 느낌이에요.';
  }
  const light = dL < 12 ? ' 위아래 밝기가 비슷해 한 벌처럼 이어져 보여요(키가 커 보이는 효과).'
    : dL > 45 ? ' 위아래 밝기 차이가 커서 허리선이 또렷하게 나뉘어 보여요.' : '';
  return hue + light;
}

// 첫 번째 옷을 그린 자리는 두 번째 옷을 그릴 때 "원래 입던 옷"으로 지우지 않도록 라벨을 바꾼다(4 → 7)
function markDrawn(scene, before, after, W, H) {
  const cat = Uint8Array.from(scene.cat);
  const { w, h } = scene;
  const a = before.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const b = after.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  for (let y = 0; y < h; y++) {
    const py = Math.min(H - 1, Math.floor(((y + 0.5) * H) / h));
    for (let x = 0; x < w; x++) {
      const px = Math.min(W - 1, Math.floor(((x + 0.5) * W) / w));
      const i = (py * W + px) * 4;
      const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (diff > 30) cat[y * w + x] = 7; // 새로 입힌 옷
    }
  }
  return { ...scene, cat, aiPatch: null };
}

async function runOutfit() {
  const top = state.closet.find((p) => p.id === $('#outfit-top').value) || null;
  const bottom = state.closet.find((p) => p.id === $('#outfit-bottom').value) || null;
  if (!top && !bottom) { outfitStatus('입혀 볼 상의나 하의를 골라 주세요.', 'err'); return; }
  if (!state.body.height) { outfitStatus("'내 체형' 탭에서 키를 먼저 입력해 주세요. 키로 사진 속 크기를 cm로 바꿔요.", 'err'); return; }
  const btn = $('#outfit-run');
  btn.disabled = true;
  try {
    outfitStatus('모델 사진 준비 중…');
    const model = await outfitModel();
    if (!model) {
      outfitStatus("모델로 쓸 내 사진이 없어요. '모델 사진 바꾸기'로 정면 전신 사진을 골라 주세요(핏 비교에서 기준 사진을 저장해 두면 자동으로 써요).", 'err');
      return;
    }
    if (!model.scene) {
      outfitStatus('사진 속 손·얼굴·옷 위치 분석 중…');
      model.scene = await segmentScene(model.canvas).catch((err) => { console.error(err); return null; });
    }
    outfitStatus('옷 사진 오려내는 중…');
    const cuts = { top: top ? await garmentCut(top) : null, bottom: bottom ? await garmentCut(bottom) : null };
    if (!model.poseCheck) model.poseCheck = BodyAnalysis.checkPose(model.pose, model.canvas.width, model.canvas.height);

    const W = model.canvas.width, H = model.canvas.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(model.canvas, 0, 0);
    // 꺼내 입기: 바지 먼저, 그 위에 상의 / 넣어 입기: 상의 먼저, 그 위에 바지
    const tuckIn = $('#outfit-tuck').value === 'in';
    const order = tuckIn ? [top, bottom] : [bottom, top];
    // 넣어 입기: 바지를 먼저 시험 삼아 그려 실제로 그려지는 허리 위치를 알아낸 뒤, 상의가 거기까지 내려와 바지 속으로 들어가게
    let waistTop = null;
    if (tuckIn && top && bottom) {
      const tmp = document.createElement('canvas');
      tmp.width = model.canvas.width; tmp.height = model.canvas.height;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(model.canvas, 0, 0);
      const cut = cuts.bottom;
      const r0 = GarmentRender.draw(tctx, {
        category: 'bottom', g: itemRow(bottom), color: DEFAULT_COLOR.bottom, stretch: bottom.stretch, body: bodyForRender(),
        texture: cut && cut.category === 'bottom' ? cut : null,
        lm: model.pose, W: tmp.width, H: tmp.height, mirror: false, pxPerCm: model.pxPerCm, scene: null,
        seg: model.scene || null, // 실제 가랑이 위치(본 그리기와 같게)
      });
      waistTop = r0.ok ? r0.waistTop : null;
    }
    const tuck = tuckIn && top && bottom ? tuckRow(model, top, bottom, waistTop) : null;
    // AI 보정을 꺼 두었으면 입체 명암도 쓰지 않는다
    let scene = model.scene && !aiEnabled() ? { ...model.scene, depthShade: null, aiPatch: null } : model.scene;
    if (scene && aiEnabled()) scene = { ...scene, aiPatches: wardrobe.patches };
    if (scene && aiEnabled() && !scene.depthShade && typeof AIModels !== 'undefined' && !model.depthStarted) {
      // 입체 명암은 사진마다 한 번(끝나면 다시 그린다)
      model.depthStarted = true;
      AIModels.depthShade(model.canvas, model.scene).then((d) => { model.scene.depthShade = d; runOutfit(); })
        .catch((err) => { console.error(err); model.depthStarted = false; });
    }
    const holes = []; // 옷마다 드러난 자리(AI로 메운 뒤 다시 그린다)
    const notes = [];
    for (const p of order) {
      if (!p) continue;
      const cut = cuts[p.category];
      const before = document.createElement('canvas');
      before.width = W; before.height = H;
      before.getContext('2d').drawImage(c, 0, 0);
      const texture = cut && cut.category === p.category ? { ...cut, texture: scene ? harmonizedTexture(cut, scene) : cut.texture } : null;
      const res = GarmentRender.draw(ctx, {
        category: p.category,
        g: p.category === 'top' && tuck ? tuck : itemRow(p),
        tucked: p.category === 'top' && !!tuck,
        color: cut?.avgColor || DEFAULT_COLOR[p.category],
        stretch: p.stretch,
        body: bodyForRender(),
        texture,
        lm: model.pose, W, H, mirror: false, pxPerCm: model.pxPerCm,
        scene: scene || null,
        poseIssues: model.poseCheck.issues.map((i) => i.key),
      });
      const label = CATEGORY_LABEL[p.category];
      const h = GarmentRender.lastHole();
      if (h && !wardrobe.patches.has(h.key)) holes.push({ ...h, base: before });
      if (!res.ok) { notes.push(`${label}: ${res.notes.join(' ')}`); continue; }
      notes.push(...res.notes.map((n) => `${label}: ${n}`));
      if (!cut) notes.push(`${label}: 옷 사진이 없어서 단색으로 그렸어요. 옷장에서 사진을 넣으면 그 옷 그대로 입혀 봐요.`);
      if (scene) scene = markDrawn(scene, before, c, W, H);
    }
    $('#outfit-view').replaceChildren(c);
    if (tuckIn && top && bottom && !tuck) notes.push('상의가 짧아서 바지 허리까지 오지 않아요(넣어 입을 필요가 없는 기장이에요).');
    $('#outfit-notes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    renderOutfitColor(top && cuts.top?.avgColor, bottom && cuts.bottom?.avgColor);
    const advice = model.poseCheck.ok ? '' : `${model.poseCheck.issues.map((i) => i.text).join(', ')}. 정면으로 서서 팔을 내린 사진이 가장 정확해요.`;
    outfitStatus(advice || (model === tryon.refPhoto ? '저장해 둔 기준 사진에 입혀 봤어요.' : ''), advice ? 'warn' : '');
    if (holes.length && aiEnabled()) fillOutfitHoles(holes);
  } catch (err) {
    console.error(err);
    outfitStatus('입혀 보지 못했어요. 다시 시도해 주세요.', 'err');
  } finally {
    btn.disabled = false;
  }
}

// 드러난 배경을 AI로 메우고(옷마다 한 번) 다시 그린다. 같은 구멍은 지문으로 기억해 다시 계산하지 않는다
async function fillOutfitHoles(holes) {
  if (wardrobe.aiBusy || typeof AIModels === 'undefined') return;
  wardrobe.aiBusy = true;
  let added = false;
  try {
    for (const h of holes) {
      if (wardrobe.patches.has(h.key)) continue;
      const canvas = await AIModels.inpaintHole(h.base, h.mask, h.box);
      wardrobe.patches.set(h.key, { key: h.key, canvas });
      added = true;
    }
  } catch (err) {
    console.error(err);
  } finally {
    wardrobe.aiBusy = false;
  }
  if (added) runOutfit();
}

// ---------- 코디 저장(이 기기에만) ----------
function renderSavedOutfits() {
  const list = $('#outfit-saved');
  const outfits = state.outfits || [];
  const nameOf = (id) => state.closet.find((p) => p.id === id)?.name;
  list.innerHTML = outfits.map((o) => {
    const parts = [nameOf(o.top), nameOf(o.bottom)].filter(Boolean).map(esc).join(' + ') || '옷장에서 지운 옷';
    return `
      <li>
        <div class="grow">
          <div><b>${esc(o.name)}</b></div>
          <div class="meta">${parts} · ${o.tuck === 'in' ? '넣어 입기' : '꺼내 입기'}</div>
        </div>
        <div class="actions">
          <button type="button" data-wear="${o.id}">입혀 보기</button>
          <button type="button" data-drop="${o.id}">삭제</button>
        </div>
      </li>`;
  }).join('');
}

$('#outfit-save').addEventListener('click', () => {
  const top = $('#outfit-top').value, bottom = $('#outfit-bottom').value;
  if (!top && !bottom) { outfitStatus('저장할 상의나 하의를 골라 주세요.', 'err'); return; }
  const name = $('#outfit-name').value.trim() || `코디 ${(state.outfits || []).length + 1}`;
  state.outfits = [...(state.outfits || []), { id: uid(), name, top, bottom, tuck: $('#outfit-tuck').value, createdAt: Date.now() }];
  saveState();
  $('#outfit-name').value = '';
  renderSavedOutfits();
  outfitStatus(`'${name}' 코디를 저장했어요(이 기기에만).`, 'ok');
});

$('#outfit-saved').addEventListener('click', (e) => {
  const wear = e.target.dataset.wear, drop = e.target.dataset.drop;
  const o = (state.outfits || []).find((x) => x.id === (wear || drop));
  if (!o) return;
  if (drop) {
    if (!confirm(`'${o.name}' 코디를 삭제할까요?`)) return;
    state.outfits = state.outfits.filter((x) => x.id !== o.id);
    saveState();
    renderSavedOutfits();
    return;
  }
  $('#outfit-top').value = state.closet.some((p) => p.id === o.top) ? o.top : '';
  $('#outfit-bottom').value = state.closet.some((p) => p.id === o.bottom) ? o.bottom : '';
  $('#outfit-tuck').value = o.tuck || 'out';
  runOutfit();
  $('#outfit').scrollIntoView({ behavior: 'smooth' });
});

$('#outfit-run').addEventListener('click', runOutfit);

// ---------- 카메라로 입어 보기: 고른 상의·하의를 실시간으로 함께 입힌다 ----------
async function outfitSpecs() {
  const top = state.closet.find((p) => p.id === $('#outfit-top').value) || null;
  const bottom = state.closet.find((p) => p.id === $('#outfit-bottom').value) || null;
  const order = $('#outfit-tuck').value === 'in' ? [top, bottom] : [bottom, top];
  const specs = [];
  for (const p of order) {
    if (!p) continue;
    const cut = await garmentCut(p);
    specs.push({
      category: p.category,
      opts: {
        category: p.category,
        g: itemRow(p),
        color: cut?.avgColor || DEFAULT_COLOR[p.category],
        stretch: p.stretch,
        texture: cut && cut.category === p.category ? cut : null,
      },
    });
  }
  return specs;
}

$('#outfit-live').addEventListener('click', async () => {
  const btn = $('#outfit-live');
  btn.disabled = true;
  try {
    outfitStatus('옷 사진 준비 중…');
    await loadMediaPipe();
    const specs = await outfitSpecs();
    if (!specs.length) { outfitStatus('입어 볼 상의나 하의를 골라 주세요.', 'err'); return; }
    outfitStatus('');
    openLive(specs);
  } catch (err) {
    console.error(err);
    outfitStatus('카메라를 준비하지 못했어요.', 'err');
  } finally {
    btn.disabled = false;
  }
});

// 카메라에서 "찍기": 찍은 장면을 모델 사진으로 삼아 정밀하게 다시 그린다
async function outfitShot(blob) {
  try {
    outfitStatus('찍은 사진 분석 중…');
    wardrobe.model = await analyzeTryonPhoto(blob);
    wardrobe.patches.clear();
    await runOutfit();
    $('#outfit').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    outfitStatus('찍은 사진을 분석하지 못했어요. 다시 찍어 주세요.', 'err');
  }
}

// 옷장 카드의 "코디에 넣기": 그 옷을 상의/하의 칸에 넣고 바로 입혀 본다
function wearInOutfit(id) {
  const p = state.closet.find((x) => x.id === id);
  if (!p) return;
  $(p.category === 'top' ? '#outfit-top' : '#outfit-bottom').value = id;
  $('#outfit').scrollIntoView({ behavior: 'smooth' });
  runOutfit();
}
onClosetRendered(); // app.js가 먼저 목록을 그렸으므로 사진·고르기 칸을 채운다
