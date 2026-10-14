'use strict';

// ---------- 측정 항목 정의 ----------
// 옷 실측: 둘레는 단면(cm), 어깨는 전체 너비(cm). ok/warn: 이 차이(cm) 이내면 "비슷함"/"조금" 판정
// weight: 사이즈 추천 점수 가중치. 밑위·밑단은 사이즈보다 디자인이 좌우하므로 0
// body: 몸 치수 항목. bodyMul: 옷 값을 몸 치수와 비교할 때 곱하는 수(단면 → 둘레는 2, 어깨는 1)
const CATEGORY_PARTS = {
  bottom: [
    { key: 'waist', label: '허리', kind: 'girth', ok: 1, warn: 2, weight: 3, body: 'waist' },
    { key: 'hip', label: '엉덩이', kind: 'girth', ok: 1.5, warn: 3, weight: 2, body: 'hip' },
    { key: 'thigh', label: '허벅지', kind: 'girth', ok: 1, warn: 2.5, weight: 2, body: 'thigh' },
    { key: 'rise', label: '밑위', kind: 'rise', ok: 1, warn: 2.5, weight: 0 },
    { key: 'hem', label: '밑단', kind: 'hem', ok: 1, warn: 2.5, weight: 0 },
    { key: 'length', label: '총장', kind: 'length', ok: 2, warn: 4, weight: 1 },
  ],
  top: [
    { key: 'shoulder', label: '어깨', kind: 'shoulder', ok: 1, warn: 2.5, weight: 2, body: 'shoulder', bodyMul: 1 },
    { key: 'chest', label: '가슴', kind: 'girth', ok: 1.5, warn: 3, weight: 3, body: 'chest' },
    { key: 'sleeve', label: '소매', kind: 'length', ok: 1.5, warn: 3, weight: 0.5 },
    { key: 'length', label: '총장', kind: 'length', ok: 2, warn: 4, weight: 1 },
    { key: 'hem', label: '밑단', kind: 'hem', ok: 2, warn: 4, weight: 0 },
  ],
};
const CATEGORY_LABEL = { bottom: '바지', top: '상의' };
const partsOf = (cat) => CATEGORY_PARTS[cat] || CATEGORY_PARTS.bottom;

// 몸 치수: 둘레(cm), 어깨너비는 양 어깨 끝 사이 직선(cm)
const BODY_FIELDS = [
  { key: 'height', label: '키' },
  { key: 'shoulder', label: '어깨너비' },
  { key: 'chest', label: '가슴둘레' },
  { key: 'waist', label: '허리둘레' },
  { key: 'hip', label: '엉덩이둘레' },
  { key: 'thigh', label: '허벅지둘레' },
  { key: 'inseam', label: '다리 안쪽 길이' },
];

const STRETCH_BONUS = { none: 0, some: 0.5, high: 1 };   // 신축성이 주는 여유(cm, 단면)
const FEEL_OFFSET = { good: 0, tight: 1.5, loose: -1.5 };     // 기준 옷 착용감 보정(cm, 단면)
const STRETCH_LABEL = { none: '신축성 없음', some: '신축성 약간', high: '신축성 많음' };
const FEEL_LABEL = { good: '딱 좋음', tight: '조금 낌', loose: '조금 큼' };

// ---------- 저장소 ----------
const STORE_KEY = 'fitcheck:v1';
const state = loadState();

function loadState() {
  const empty = { body: {}, closet: [], draft: null };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return empty;
    const st = { ...empty, ...JSON.parse(raw) };
    // 상의 지원 이전에 저장한 데이터는 모두 바지
    st.closet.forEach((p) => { p.category = p.category || 'bottom'; });
    if (st.draft) st.draft.category = st.draft.category || 'bottom';
    return st;
  } catch {
    return empty;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // 저장 실패(사생활 보호 모드 등)는 무시: 화면은 계속 동작
  }
}

// ---------- 유틸 ----------
const $ = (sel) => document.querySelector(sel);

function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function signed(n) {
  if (Math.abs(n) < 0.05) return '±0';
  return (n > 0 ? '+' : '−') + fmt(Math.abs(n));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 받침에 따라 조사 고르기: josa('가슴', '이', '가') → '가슴이'
function josa(word, withBatchim, without) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const has = code >= 0 && code <= 11171 && code % 28 !== 0;
  return word + (has ? withBatchim : without);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- 탭 ----------
document.querySelectorAll('.bottom-nav button').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function showTab(name) {
  document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'compare') renderRefSelect();
  window.scrollTo(0, 0);
}

// ---------- 내 체형 ----------
function renderBodyForm() {
  $('#b-measures').innerHTML = BODY_FIELDS.map((f) => `
    <label class="field">${f.label}
      <input type="number" inputmode="decimal" step="0.1" name="${f.key}" value="${state.body[f.key] ?? ''}">
    </label>`).join('');
  $('#an-height').value = state.body.height ?? '';
}

$('#body-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = {};
  for (const f of BODY_FIELDS) {
    const v = num(e.target.elements[f.key].value);
    if (v !== null) body[f.key] = v;
  }
  state.body = body;
  saveState();
  const msg = $('#body-saved');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 1500);
});

// ---------- 내 옷 ----------
function renderCloset() {
  const list = $('#closet-list');
  if (!state.closet.length) {
    list.innerHTML = '<li class="empty">아직 등록한 옷이 없어요. 제일 잘 맞는 바지나 상의부터 넣어 보세요.</li>';
    return;
  }
  list.innerHTML = state.closet.map((p) => {
    const m = partsOf(p.category).filter((pt) => p[pt.key] != null).map((pt) => `${pt.label} ${fmt(p[pt.key])}`).join(' · ');
    return `
      <li>
        <div>
          <div><span class="tag">${CATEGORY_LABEL[p.category]}</span> <b>${esc(p.name)}</b> ${p.size ? `<span class="meta">(${esc(p.size)})</span>` : ''}</div>
          <div class="meta">${FEEL_LABEL[p.feel]} · ${STRETCH_LABEL[p.stretch]}</div>
          <div class="meta">${m || '실측 없음'}</div>
        </div>
        <div class="actions">
          <button type="button" data-edit="${p.id}">수정</button>
          <button type="button" data-del="${p.id}">삭제</button>
        </div>
      </li>`;
  }).join('');
}

$('#closet-list').addEventListener('click', (e) => {
  const editId = e.target.dataset.edit;
  const delId = e.target.dataset.del;
  if (editId) openItemForm(state.closet.find((p) => p.id === editId));
  if (delId) {
    const p = state.closet.find((x) => x.id === delId);
    if (p && confirm(`'${p.name}'을(를) 삭제할까요?`)) {
      state.closet = state.closet.filter((x) => x.id !== delId);
      saveState();
      renderCloset();
    }
  }
});

// 종류를 바꾸면 입력 칸도 바뀐다(같은 이름의 칸 값은 유지)
function renderItemMeasures(cat, values = {}) {
  $('#p-measures').innerHTML = partsOf(cat).map((pt) => `
    <label class="field">${pt.label}
      <input type="number" inputmode="decimal" step="0.1" name="${pt.key}" value="${values[pt.key] ?? ''}">
    </label>`).join('');
}

function currentMeasureValues() {
  const values = {};
  $('#p-measures').querySelectorAll('input').forEach((i) => { values[i.name] = num(i.value); });
  return values;
}

$('#p-category').addEventListener('change', (e) => renderItemMeasures(e.target.value, currentMeasureValues()));

function openItemForm(p) {
  const form = $('#item-form');
  form.reset();
  $('#item-form-title').textContent = p ? '내 옷 수정' : '내 옷 추가';
  $('#p-id').value = p?.id ?? '';
  const cat = p?.category ?? state.draft.category;
  $('#p-category').value = cat;
  renderItemMeasures(cat, p || {});
  if (p) {
    $('#p-name').value = p.name;
    $('#p-size').value = p.size ?? '';
    $('#p-stretch').value = p.stretch;
    $('#p-feel').value = p.feel;
  }
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth' });
}

$('#add-item').addEventListener('click', () => openItemForm(null));
$('#cancel-item').addEventListener('click', () => $('#item-form').classList.add('hidden'));

$('#item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const id = $('#p-id').value || uid();
  const category = $('#p-category').value;
  const item = {
    id,
    category,
    name: $('#p-name').value.trim() || `이름 없는 ${CATEGORY_LABEL[category]}`,
    size: $('#p-size').value.trim(),
    stretch: $('#p-stretch').value,
    feel: $('#p-feel').value,
  };
  // form.elements['length']는 칸 개수(숫자)를 돌려주므로 이름으로 직접 찾는다
  for (const pt of partsOf(category)) item[pt.key] = num(form.querySelector(`[name="${pt.key}"]`).value);

  const idx = state.closet.findIndex((p) => p.id === id);
  if (idx >= 0) state.closet[idx] = item;
  else state.closet.push(item);
  saveState();
  form.classList.add('hidden');
  renderCloset();
});

// ---------- 새 옷 사이즈표 ----------
function defaultDraft() {
  return { category: 'bottom', name: '', stretch: 'none', refId: null, rows: [{ size: 'S' }, { size: 'M' }, { size: 'L' }] };
}
if (!state.draft) state.draft = defaultDraft();

function renderSizeTable() {
  const parts = partsOf(state.draft.category);
  $('#size-head').innerHTML = '<th>사이즈</th>' + parts.map((pt) => `<th>${pt.label}</th>`).join('') + '<th></th>';
  $('#size-body').innerHTML = state.draft.rows.map((r, i) => `
    <tr>
      <td><input type="text" data-row="${i}" data-key="size" value="${esc(r.size ?? '')}"></td>
      ${parts.map((pt) => `<td><input type="number" inputmode="decimal" step="0.1" data-row="${i}" data-key="${pt.key}" value="${r[pt.key] ?? ''}"></td>`).join('')}
      <td><button type="button" class="del" data-delrow="${i}" aria-label="행 삭제">삭제</button></td>
    </tr>`).join('');
  $('#new-name').value = state.draft.name;
  $('#new-name').placeholder = state.draft.category === 'top' ? '예: 오버핏 셔츠' : '예: 와이드 데님';
  $('#new-stretch').value = state.draft.stretch;
  document.querySelectorAll('#new-category button').forEach((b) => b.classList.toggle('active', b.dataset.cat === state.draft.category));
}

// 바지/상의 전환: 다른 종류 결과는 숨기고 기준 옷 목록을 다시 고른다
function setCategory(cat) {
  const d = state.draft;
  if (d.category === cat) return;
  // 사이즈표·상품명은 종류별로 따로 보관한다(바지 숫자가 상의 표에 섞이지 않게)
  d.stash = d.stash || {};
  d.stash[d.category] = { rows: d.rows, name: d.name };
  const next = d.stash[cat];
  d.rows = next?.rows || defaultDraft().rows;
  d.name = next?.name ?? '';
  d.category = cat;
  d.refId = null;
  saveState();
  renderSizeTable();
  renderRefSelect();
  lastResults = null;
  $('#result').classList.add('hidden');
  $('#tryon').classList.add('hidden');
}

$('#new-category').addEventListener('click', (e) => {
  const cat = e.target.dataset.cat;
  if (cat) setCategory(cat);
});

$('#size-body').addEventListener('input', (e) => {
  const { row, key } = e.target.dataset;
  if (row === undefined) return;
  state.draft.rows[row][key] = key === 'size' ? e.target.value : num(e.target.value);
  saveState();
});

$('#size-body').addEventListener('click', (e) => {
  const i = e.target.dataset.delrow;
  if (i === undefined) return;
  state.draft.rows.splice(Number(i), 1);
  if (!state.draft.rows.length) state.draft.rows.push({ size: '' });
  saveState();
  renderSizeTable();
});

$('#add-size').addEventListener('click', () => {
  state.draft.rows.push({ size: '' });
  saveState();
  renderSizeTable();
});

$('#new-name').addEventListener('input', (e) => { state.draft.name = e.target.value; saveState(); });
$('#new-stretch').addEventListener('change', (e) => { state.draft.stretch = e.target.value; saveState(); });
$('#ref-select').addEventListener('change', (e) => { state.draft.refId = e.target.value; saveState(); });

function renderRefSelect() {
  const sel = $('#ref-select');
  const items = state.closet.filter((p) => p.category === state.draft.category);
  if (!items.length) {
    sel.innerHTML = `<option value="">먼저 '내 옷' 탭에서 ${CATEGORY_LABEL[state.draft.category]}를 추가해 주세요</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  // 기준 기본값: 저장된 선택 → "딱 좋음" 옷 → 첫 번째
  const ref = items.find((p) => p.id === state.draft.refId)
    || items.find((p) => p.feel === 'good')
    || items[0];
  state.draft.refId = ref.id;
  sel.innerHTML = items.map((p) =>
    `<option value="${p.id}" ${p.id === ref.id ? 'selected' : ''}>${esc(p.name)}${p.size ? ` (${esc(p.size)})` : ''} · ${FEEL_LABEL[p.feel]}</option>`).join('');
}

// ---------- 사이즈표 가져오기 (텍스트 / 이미지 OCR) ----------
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let ocrWorker = null;
let ocrProgress = () => {};
let previewUrl = null;

function setImportStatus(text, kind = '') {
  const el = $('#import-status');
  el.className = 'hint import-status ' + kind;
  el.innerHTML = text;
}

function openPasteBox() {
  $('#paste-box').classList.remove('hidden');
}

$('#toggle-paste').addEventListener('click', () => {
  const box = $('#paste-box');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) $('#chart-text').focus();
});

function applyChartText(text) {
  const { rows, parts, warnings, category } = parseSizeChart(text);
  if (!rows.length) {
    setImportStatus(esc(warnings.join('\n')), 'err');
    return false;
  }
  const switched = category !== state.draft.category;
  setCategory(category);
  state.draft.rows = rows;
  saveState();
  renderSizeTable();
  const sizes = rows.map((r) => r.size || '?').join('·');
  const msg = [`${CATEGORY_LABEL[category]} 사이즈표 · ${rows.length}개 사이즈(${sizes}) · ${parts.join(', ')} 인식했어요. 아래 표에서 숫자를 확인해 주세요.`, ...warnings];
  if (switched) msg.push(`${CATEGORY_LABEL[category]} 표로 보여서 종류를 ${CATEGORY_LABEL[category]}로 바꿨어요.`);
  setImportStatus(esc(msg.join('\n')), warnings.length ? '' : 'ok');
  return true;
}

$('#apply-chart').addEventListener('click', () => applyChartText($('#chart-text').value));

$('#chart-text').addEventListener('paste', (e) => {
  const img = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
  if (img) {
    e.preventDefault();
    importImage(img.getAsFile());
    return;
  }
  // 붙여넣은 내용이 textarea에 들어간 뒤 바로 적용
  setTimeout(() => applyChartText($('#chart-text').value), 0);
});

$('#chart-image').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importImage(file);
});

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('script load failed'));
    document.head.appendChild(s);
  });
}

async function getOcrWorker() {
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker(['kor', 'eng'], 1, { logger: (m) => ocrProgress(m) });
    await ocrWorker.setParameters({
      tessedit_pageseg_mode: '6',      // 하나의 텍스트 블록: 표의 줄 구조를 유지
      preserve_interword_spaces: '1',
    });
  }
  return ocrWorker;
}

// 작은 스크린샷은 키우고, 흑백으로 바꾸고, 다크모드 스크린샷은 반전해서 인식률을 높인다
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(3, Math.max(1, 1800 / bmp.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  if (sum / (d.length / 4) < 110) {
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function importImage(file) {
  openPasteBox();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  const preview = $('#chart-preview');
  preview.src = previewUrl;
  preview.classList.remove('hidden');

  const first = !ocrWorker;
  setImportStatus(`${first ? '글자 인식 엔진 불러오는 중… (처음 한 번만, 몇 MB)' : '글자 인식 중…'}<div class="progress"><div></div></div>`);
  const bar = () => $('#import-status .progress > div');
  ocrProgress = (m) => {
    if (bar() && typeof m.progress === 'number') {
      // 엔진/언어 로딩은 앞 40%, 실제 인식은 뒤 60%
      const p = m.status === 'recognizing text' ? 40 + m.progress * 60 : m.progress * 40;
      bar().style.width = `${Math.round(p)}%`;
    }
  };

  try {
    const worker = await getOcrWorker();
    const canvas = await prepareImage(file);
    const { data } = await worker.recognize(canvas);
    // 보기 좋게: 긴 공백은 두 칸으로, 빈 줄은 제거
    $('#chart-text').value = data.text.replace(/[ \t]{2,}/g, '  ').replace(/\n{2,}/g, '\n').trim();
    if (!applyChartText(data.text)) {
      setImportStatus(esc('표를 읽지 못했어요. 사이즈표 부분만 잘라서 다시 올리거나, 아래 인식된 글자를 고친 뒤 "다시 적용"을 눌러 주세요.'), 'err');
    }
  } catch (err) {
    console.error(err);
    setImportStatus(esc(navigator.onLine
      ? '이미지를 읽는 중 문제가 생겼어요. 다시 시도해 주세요.'
      : '처음 이미지 인식에는 인터넷 연결이 필요해요.'), 'err');
  } finally {
    ocrProgress = () => {};
  }
}

// ---------- 핏 계산 ----------
// 한 사이즈 행을 기준 옷과 비교해 부위별 판정을 만든다
function compareRow(row, ref, newStretch, body) {
  const parts = [];
  let score = 0;
  let used = 0;

  for (const pt of partsOf(ref.category)) {
    const nv = row[pt.key];
    const rv = ref[pt.key];
    if (nv == null || rv == null) continue;

    const raw = nv - rv;
    let eff = raw;
    if (pt.kind === 'girth') {
      // 새 옷이 더 잘 늘어나면 체감상 여유가 생기고, 기준 옷이 꼈다면 더 커야 "딱 좋음"
      eff += STRETCH_BONUS[newStretch] - STRETCH_BONUS[ref.stretch];
      eff -= FEEL_OFFSET[ref.feel];
    }

    const verdict = judge(pt, eff);

    // 몸 치수 대비 여유분(둘레 = 단면 × 2, 어깨는 그대로)
    let ease = null;
    if (pt.body && body[pt.body] != null) {
      ease = nv * (pt.bodyMul ?? 2) - body[pt.body];
      if (pt.kind === 'girth' && ease < 0 && newStretch === 'none') {
        verdict.level = 'bad';
        verdict.text = '몸보다 작음';
      }
    }

    parts.push({ ...pt, nv, rv, raw, eff, ease, verdict });
    if (pt.weight) {
      const tightPenalty = pt.kind === 'girth' && eff < 0 ? 2 : 1; // 큰 건 줄여 입어도 작은 건 못 입는다
      score += pt.weight * tightPenalty * (eff / pt.ok) ** 2;
      if (pt.kind === 'girth' && ease !== null && ease < 0 && newStretch === 'none') score += 1000;
      used += pt.weight;
    }
  }

  return { parts, score: used ? score / used : Infinity };
}

function judge(pt, d) {
  const a = Math.abs(d);
  if (a <= pt.ok) return { level: 'ok', text: '비슷함' };
  const level = a <= pt.warn ? 'warn' : 'bad';
  const little = level === 'warn' ? '조금 ' : '';
  const words = {
    girth: d < 0 ? '낌' : '여유',
    rise: d < 0 ? '짧음' : '김',
    hem: d < 0 ? '좁음' : '넓음',
    shoulder: d < 0 ? '좁음' : '넓음',
    length: d < 0 ? '짧음' : '김',
  }[pt.kind];
  return { level, text: little + words };
}

function summarize(result, ref) {
  const off = result.parts.filter((p) => p.verdict.level !== 'ok');
  if (!result.parts.length) return '비교할 수 있는 실측이 없어요. 기준 옷과 같은 항목을 입력해 주세요.';
  if (!off.length) return `'${ref.name}'과(와) 거의 같은 핏이에요.`;
  const bits = off.map((p) => {
    if (p.verdict.text === '몸보다 작음') return `${josa(p.label, '이', '가')} 몸 둘레보다 ${fmt(Math.abs(p.ease))}cm 작음`;
    return `${p.label} ${p.verdict.text}(${fmt(Math.abs(p.raw))}cm)`;
  });
  return `'${ref.name}' 대비 ${bits.join(', ')}.`;
}

// ---------- 비교 실행 / 결과 렌더 ----------
let lastResults = null;

$('#run-compare').addEventListener('click', () => {
  const cat = state.draft.category;
  const ref = state.closet.find((p) => p.id === state.draft.refId && p.category === cat);
  if (!ref) {
    alert(`먼저 '내 옷' 탭에서 기준이 될 ${CATEGORY_LABEL[cat]}를 추가해 주세요.`);
    showTab('closet');
    return;
  }
  const rows = state.draft.rows.filter((r) => partsOf(cat).some((pt) => r[pt.key] != null));
  if (!rows.length) {
    alert('사이즈표에 실측을 한 줄 이상 입력해 주세요.');
    return;
  }

  const results = rows.map((row) => ({ row, ...compareRow(row, ref, state.draft.stretch, state.body) }));
  const best = results.reduce((a, b) => (b.score < a.score ? b : a));
  lastResults = { category: cat, ref, results, best, selected: best };
  renderResult();
  $('#result').scrollIntoView({ behavior: 'smooth' });
});

function renderResult() {
  const { category, ref, results, best, selected } = lastResults;
  const box = $('#result');
  box.classList.remove('hidden');

  const tabs = results.length > 1 ? `
    <div class="size-tabs">
      ${results.map((r, i) => `<button type="button" data-pick="${i}" class="${r === selected ? 'active' : ''}">
        ${r === best ? '<span class="star">추천</span> ' : ''}${esc(r.row.size || `#${i + 1}`)}</button>`).join('')}
    </div>` : '';

  const rec = results.length > 1
    ? `<p class="hint">추천 사이즈: <b>${esc(best.row.size || '')}</b> — 기준 옷과 가장 비슷한 사이즈예요.</p>` : '';

  const rowsHtml = selected.parts.map((p) => `
    <tr>
      <td>${p.label}</td>
      <td class="num">${fmt(p.nv)}</td>
      <td class="num">${fmt(p.rv)}</td>
      <td class="num">${signed(p.raw)}</td>
      <td>
        <span class="badge ${p.verdict.level}">${p.verdict.text}</span>
        ${p.ease != null ? `<span class="ease">몸 대비 ${signed(p.ease)}cm</span>` : ''}
      </td>
    </tr>`).join('');

  const notes = [];
  if (state.draft.stretch !== ref.stretch) notes.push(`신축성 차이(${STRETCH_LABEL[state.draft.stretch]} vs ${STRETCH_LABEL[ref.stretch]})를 판정에 반영했어요.`);
  if (ref.feel !== 'good') notes.push(`기준 옷이 '${FEEL_LABEL[ref.feel]}'이라서 그만큼 보정했어요.`);

  box.innerHTML = `
    <h2>${esc(state.draft.name || `새 ${CATEGORY_LABEL[category]}`)} 핏 예측</h2>
    ${tabs}
    ${rec}
    <p class="summary">${esc(summarize(selected, ref))}</p>
    <table class="diff-table">
      <thead><tr><th>부위</th><th>새 옷</th><th>내 옷</th><th>차이</th><th>판정</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${notes.length ? `<p class="hint" style="margin-top:10px">${notes.map(esc).join('<br>')}</p>` : ''}
    <h3>실루엣 비교</h3>
    ${renderSilhouette(selected.row, ref, state.body, category)}
  `;
  // 입혀 보기 카드(tryon.js)에 결과가 바뀐 것을 알린다
  if (typeof onCompareResult === 'function') onCompareResult();
}

$('#result').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pick]');
  if (!btn) return;
  lastResults.selected = lastResults.results[Number(btn.dataset.pick)];
  renderResult();
});

// ---------- 2D 실루엣 ----------
// 바지를 펼쳐 놓은 앞모습. 두 바지는 가랑이 높이를 맞춰 겹친다(실제로 입으면 가랑이가 몸에 걸리므로)
function pantsShape(p) {
  const need = ['waist', 'thigh', 'rise', 'hem', 'length'];
  if (need.some((k) => p[k] == null)) return null;
  const w = p.waist / 2;
  const hip = (p.hip ?? (p.waist + p.thigh) / 1.5) / 2;
  const t = p.thigh;
  const h = p.hem / 2;
  const top = -p.rise;              // 가랑이 = y 0
  const hipY = -p.rise * 0.3;
  const bottom = p.length - p.rise; // 안쪽 길이
  const c = t / 2;                  // 한쪽 다리 중심선
  const pts = [
    [-w, top], [w, top], [hip, hipY], [t, 0], [c + h, bottom], [c - h, bottom],
    [0, 0],
    [-(c - h), bottom], [-(c + h), bottom], [-t, 0], [-hip, hipY],
  ];
  return { paths: [pts], minY: top, maxY: bottom, maxX: Math.max(w, hip, t, c + h) };
}

// 상의를 펼쳐 놓은 앞모습. 어깨 가장 높은 곳(옷깃 옆) = y 0. 두 옷은 이 높이를 맞춰 겹친다
function topShape(p) {
  if (['shoulder', 'chest', 'length'].some((k) => p[k] == null)) return null;
  const s = p.shoulder / 2;
  const c = p.chest / 2;
  const h = (p.hem ?? p.chest) / 2;
  const armpitY = Math.min(28, Math.max(18, p.length * 0.33));
  const neck = 9;
  const paths = [[[-s, 3], [-neck, 0], [0, 6], [neck, 0], [s, 3], [c, armpitY], [h, p.length], [-h, p.length], [-c, armpitY]]];
  let maxX = Math.max(s, c, h);
  let maxY = p.length;
  if (p.sleeve != null) {
    // 소매: 어깨 끝에서 바깥 아래(55도)로 펼친 모양. 소매 입구 폭 = 진동(어깨 끝~겨드랑이) 길이
    const ang = (55 * Math.PI) / 180;
    for (const side of [-1, 1]) {
      const sp = [side * s, 3];
      const ap = [side * c, armpitY];
      const end = [sp[0] + side * Math.cos(ang) * p.sleeve, sp[1] + Math.sin(ang) * p.sleeve];
      const holeW = Math.hypot(ap[0] - sp[0], ap[1] - sp[1]);
      const cuffW = holeW * (p.sleeve > 40 ? 0.55 : 0.85);
      const cuff = [end[0] + ((ap[0] - sp[0]) / holeW) * cuffW, end[1] + ((ap[1] - sp[1]) / holeW) * cuffW];
      paths.push([sp, end, cuff, ap]);
      maxX = Math.max(maxX, Math.abs(end[0]), Math.abs(cuff[0]));
      maxY = Math.max(maxY, end[1], cuff[1]);
    }
  }
  return { paths, minY: 0, maxY, maxX };
}

function renderSilhouette(row, ref, body, category) {
  const shape = category === 'top' ? topShape : pantsShape;
  const a = shape(ref);
  const b = shape(row);
  if (!a || !b) {
    return category === 'top'
      ? '<p class="hint">실루엣을 그리려면 어깨·가슴·총장이 두 옷 모두 필요해요.</p>'
      : '<p class="hint">실루엣을 그리려면 허리·허벅지·밑위·밑단·총장이 두 바지 모두 필요해요.</p>';
  }

  const ankle = category === 'bottom' ? body.inseam ?? null : null;
  const pad = 6;
  const maxX = Math.max(a.maxX, b.maxX) + pad;
  const minY = Math.min(a.minY, b.minY) - pad;
  const maxY = Math.max(a.maxY, b.maxY, ankle ?? 0) + pad;
  const toPath = (s) => s.paths.map((pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z').join(' ');

  const ankleLine = ankle != null ? `
    <line x1="${-maxX}" x2="${maxX}" y1="${ankle}" y2="${ankle}" stroke="var(--muted)" stroke-width="0.4" stroke-dasharray="1.5 1.5"/>
    <text x="${maxX - 1}" y="${ankle - 1.2}" font-size="3" text-anchor="end" fill="var(--muted)">내 발목</text>` : '';

  return `
    <div class="silhouette">
      <svg viewBox="${-maxX} ${minY} ${maxX * 2} ${maxY - minY}" role="img" aria-label="두 옷 실루엣 비교">
        ${ankleLine}
        <path d="${toPath(a)}" fill="none" stroke="var(--ref)" stroke-width="0.8" stroke-dasharray="2 1.2" stroke-linejoin="round"/>
        <path d="${toPath(b)}" fill="var(--new)" fill-opacity="0.18" stroke="var(--new)" stroke-width="0.8" stroke-linejoin="round"/>
      </svg>
      <div class="legend">
        <span><i style="background:var(--ref)"></i>내 옷</span>
        <span><i style="background:var(--new)"></i>새 옷</span>
      </div>
    </div>`;
}

// ---------- 사진 체형 분석 (MediaPipe) ----------
const MP_VER = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let mp = null; // { pose, face }
const photos = { front: null, side: null };
// 마지막으로 분석한 정면 사진(입혀 보기에 다시 쓴다). 메모리에만 두고 저장하지 않는다
let lastPhoto = null; // { canvas, pose, pxPerCm }

function setAnalysisStatus(text, kind = '') {
  const el = $('#analysis-status');
  el.className = 'hint import-status ' + kind;
  el.innerHTML = text;
}

for (const which of ['front', 'side']) {
  $(`#${which}-photo`).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    photos[which] = file;
    $(`#${which}-name`).textContent = file.name;
    e.target.closest('label').classList.add('picked');
  });
}

async function loadMediaPipe() {
  if (mp) return mp;
  const vision = await import(`${MP_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
  // GPU가 안 되는 기기는 CPU로
  const create = async (Task, options) => {
    try {
      return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
    } catch {
      return Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    }
  };
  const pose = await create(vision.PoseLandmarker, {
    baseOptions: { modelAssetPath: POSE_MODEL },
    runningMode: 'IMAGE',
    numPoses: 1,
    outputSegmentationMasks: true,
  });
  const face = await create(vision.FaceLandmarker, {
    baseOptions: { modelAssetPath: FACE_MODEL },
    runningMode: 'IMAGE',
    numFaces: 1,
  });
  mp = { pose, face };
  return mp;
}

// 사진 방향(EXIF)을 반영해 그리고, 너무 크면 줄인다
async function photoToCanvas(file, maxSide = 1280) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

function detectPose(canvas) {
  const res = mp.pose.detect(canvas);
  const pose = res.landmarks?.[0];
  const m = res.segmentationMasks?.[0];
  if (!pose || !m) return null;
  const mask = { data: Float32Array.from(m.getAsFloat32Array()), width: m.width, height: m.height };
  res.segmentationMasks.forEach((x) => x.close());
  return { pose, mask };
}

// 전신 사진에서는 얼굴이 작아 잘 안 잡히므로, 머리 주변만 잘라 키워서 찾는다
function detectFace(canvas, pose) {
  const W = canvas.width, H = canvas.height;
  const sw = Math.abs(pose[11].x - pose[12].x) * W;
  const size = Math.max(sw * 1.1, 80);
  const x0 = pose[0].x * W - size / 2;
  const y0 = pose[0].y * H - size / 2;
  const crop = document.createElement('canvas');
  crop.width = crop.height = 512;
  crop.getContext('2d').drawImage(canvas, x0, y0, size, size, 0, 0, 512, 512);
  const lm = mp.face.detect(crop).faceLandmarks?.[0];
  if (!lm) return null;
  return lm.map((p) => ({ x: (x0 + p.x * size) / W, y: (y0 + p.y * size) / H }));
}

$('#run-analysis').addEventListener('click', async () => {
  const heightCm = num($('#an-height').value);
  if (!heightCm || heightCm < 100 || heightCm > 230) {
    setAnalysisStatus('키를 cm로 입력해 주세요.', 'err');
    return;
  }
  if (!photos.front) {
    setAnalysisStatus('정면 전신 사진을 골라 주세요.', 'err');
    return;
  }
  state.body.height = heightCm;
  saveState();
  renderBodyForm();

  const btn = $('#run-analysis');
  btn.disabled = true;
  try {
    setAnalysisStatus(mp ? '분석 중…' : '체형 인식 모델 불러오는 중… (처음 한 번만, 약 15MB)');
    await loadMediaPipe();
    setAnalysisStatus('분석 중…');

    const frontCanvas = await photoToCanvas(photos.front);
    const det = detectPose(frontCanvas);
    if (!det) throw new Error('사진에서 사람을 찾지 못했어요. 전신이 나온 사진인지 확인해 주세요.');
    const face = detectFace(frontCanvas, det.pose);
    const front = BodyAnalysis.analyzeFront({ mask: det.mask, pose: det.pose, face, heightCm });

    let sideDepth = null;
    if (photos.side) {
      const sideCanvas = await photoToCanvas(photos.side);
      const sideDet = detectPose(sideCanvas);
      if (sideDet) sideDepth = BodyAnalysis.analyzeSide({ mask: sideDet.mask, heightCm, levels: front.levels });
      else front.warnings.push('옆모습 사진에서 사람을 찾지 못해 둘레는 일반 비율로 추정했어요.');
    }

    const girths = BodyAnalysis.estimateGirths(front, sideDepth);
    const shape = BodyAnalysis.bodyShape(front);
    lastPhoto = { canvas: frontCanvas, pose: det.pose, pxPerCm: front.pxPerCm * (frontCanvas.width / front.maskW) };
    const { draw, levels, pxPerCm, maskW, ...numbers } = front;
    state.bodyAnalysis = { date: new Date().toISOString().slice(0, 10), ...numbers, girths, shape };
    saveState();

    setAnalysisStatus('');
    renderAnalysis(state.bodyAnalysis, frontCanvas, draw);
    $('#analysis-result').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    const msg = err.message && /[가-힣]/.test(err.message) ? err.message
      : navigator.onLine ? '분석 중 문제가 생겼어요. 다른 사진으로 다시 시도해 주세요.' : '처음 분석에는 인터넷 연결이 필요해요.';
    setAnalysisStatus(esc(msg), 'err');
  } finally {
    btn.disabled = false;
  }
});

function describeHeads(h) {
  if (h < 6.5) return '머리가 큰 편인 아담한 비율';
  if (h < 7.2) return '일반적인 성인 비율';
  if (h < 7.8) return '평균보다 머리가 작고 키가 길어 보이는 비율';
  return '모델에 가까운 비율';
}

function describeLegs(inseam, height) {
  const r = inseam / height;
  if (r >= 0.47) return '다리가 긴 편';
  if (r <= 0.43) return '상체가 긴 편';
  return '상하체 균형이 보통';
}

// 사진 위에 등신 눈금과 측정선을 그린다
function drawOverlay(src, d) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.className = 'analysis-canvas';
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const sx = src.width / d.maskW, sy = src.height / d.maskH;
  const lw = Math.max(2, src.width / 300);
  const font = Math.max(12, src.width / 40);

  // 등신 눈금(머리 길이 간격)
  g.font = `bold ${font}px sans-serif`;
  g.textBaseline = 'middle';
  let i = 0;
  for (let y = d.headTop; y <= d.bottomY + 1; y += d.headLen, i++) {
    g.strokeStyle = 'rgba(37,99,235,0.55)';
    g.lineWidth = lw * 0.6;
    g.setLineDash([lw * 3, lw * 2]);
    g.beginPath();
    g.moveTo(0, y * sy);
    g.lineTo(c.width, y * sy);
    g.stroke();
    if (i > 0) {
      g.fillStyle = '#2563eb';
      g.fillText(String(i), lw * 2, (y - d.headLen / 2) * sy);
    }
  }
  g.setLineDash([]);

  // 측정선
  const colors = { 어깨: '#f59e0b', 가슴: '#0ea5e9', 허리: '#ef4444', 엉덩이: '#8b5cf6', 허벅지: '#10b981' };
  for (const line of d.lines) {
    g.strokeStyle = colors[line.key];
    g.lineWidth = lw * 1.5;
    g.beginPath();
    g.moveTo(line.l * sx, line.y * sy);
    g.lineTo(line.r * sx, line.y * sy);
    g.stroke();
  }
  // 가랑이 점
  g.fillStyle = '#10b981';
  g.beginPath();
  g.arc(d.crotchX * sx, d.crotchY * sy, lw * 2.5, 0, Math.PI * 2);
  g.fill();
  return c;
}

function renderAnalysis(a, canvas, draw) {
  const box = $('#analysis-result');
  box.classList.remove('hidden');
  const g = a.girths || {};
  const row = (label, value, note = '') => (value == null ? '' : `
    <tr><td>${label}</td><td class="num">${value}</td><td class="hint" style="margin:0">${note}</td></tr>`);

  box.innerHTML = `
    <h2>체형 분석 결과 <span class="hint" style="font-weight:400">(${esc(a.date)} · 키 ${fmt(a.heightCm)}cm)</span></h2>
    <div id="analysis-canvas-slot"></div>
    <p class="heads-big">${fmt(a.heads)}<small>등신</small></p>
    <p class="heads-sub">머리 길이 ${fmt(a.headCm)}cm · ${describeHeads(a.heads)}</p>
    <table class="diff-table">
      <thead><tr><th>항목</th><th>값</th><th></th></tr></thead>
      <tbody>
        ${row('어깨너비', a.shoulderWidthCm != null ? `약 ${fmt(a.shoulderWidthCm)}cm` : null, `옷 어깨 기준 · 겉 실루엣 ${fmt(a.shoulderCm)}cm`)}
        ${row('가슴 둘레', g.chest != null ? `약 ${g.chest}cm` : null, a.chestWidthCm != null ? `정면 폭 ${fmt(a.chestWidthCm)}cm` : '')}
        ${row('허리 둘레', g.waist != null ? `약 ${g.waist}cm` : null, `정면 폭 ${fmt(a.waistWidthCm)}cm`)}
        ${row('엉덩이 둘레', g.hip != null ? `약 ${g.hip}cm` : null, `정면 폭 ${fmt(a.hipWidthCm)}cm`)}
        ${row('허벅지 둘레', g.thigh != null ? `약 ${g.thigh}cm` : null, a.thighWidthCm != null ? `정면 폭 ${fmt(a.thighWidthCm)}cm` : '')}
        ${row('다리 안쪽 길이', a.inseamCm != null ? `${fmt(a.inseamCm)}cm` : null, `${describeLegs(a.inseamCm, a.heightCm)}${a.crotchEstimated ? ' (추정)' : ''}`)}
        ${row('상체 : 하체', `${a.upperLowerRatio} : 1`, '정수리~가랑이 : 가랑이~발')}
      </tbody>
    </table>
    <p class="hint" style="margin-top:8px">둘레는 ${g.fromSide ? '정면 폭과 옆모습 두께로' : '정면 폭과 일반적인 몸 두께 비율로'} 계산한 추정치예요(±5cm 정도 오차). 줄자로 잰 값이 더 정확해요.</p>
    ${a.shape ? `<div class="shape-box"><b>${esc(a.shape.name)}</b><p>${esc(a.shape.desc)}</p><p class="tip">옷 고를 때: ${esc(a.shape.tip)}</p></div>` : ''}
    ${a.warnings?.length ? `<ul class="warn-list">${a.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <button type="button" class="primary block" id="apply-analysis" style="margin-top:12px">추정치를 내 체형에 채우기</button>
  `;
  if (canvas && draw) $('#analysis-canvas-slot').appendChild(drawOverlay(canvas, draw));
}

$('#analysis-result').addEventListener('click', (e) => {
  if (e.target.id !== 'apply-analysis') return;
  const a = state.bodyAnalysis;
  const g = a.girths || {};
  const est = { shoulder: a.shoulderWidthCm, chest: g.chest, waist: g.waist, hip: g.hip, thigh: g.thigh, inseam: a.inseamCm };
  const filled = Object.keys(est).filter((k) => state.body[k] != null && est[k] != null);
  if (filled.length && !confirm('이미 입력한 치수가 있어요. 사진 추정치로 바꿀까요?\n(줄자로 잰 값이 더 정확해요)')) return;
  for (const [k, v] of Object.entries(est)) if (v != null) state.body[k] = v;
  saveState();
  renderBodyForm();
  $('#body-form').scrollIntoView({ behavior: 'smooth' });
});

// ---------- 백업 ----------
$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fitcheck-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.closet) || typeof data.body !== 'object') throw new Error('형식 오류');
    if (!confirm('지금 데이터를 백업 파일로 덮어쓸까요?')) return;
    Object.assign(state, { body: data.body, closet: data.closet, draft: data.draft || defaultDraft(), bodyAnalysis: data.bodyAnalysis || null });
    saveState();
    renderAll();
    alert('가져왔어요.');
  } catch {
    alert('백업 파일을 읽지 못했어요.');
  } finally {
    e.target.value = '';
  }
});

// ---------- 시작 ----------
function renderAll() {
  renderBodyForm();
  renderCloset();
  renderSizeTable();
  renderRefSelect();
  if (state.bodyAnalysis) renderAnalysis(state.bodyAnalysis);
  else $('#analysis-result').classList.add('hidden');
}
renderAll();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
