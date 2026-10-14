'use strict';

// ---------- 측정 항목 정의 ----------
// 옷 실측: 모두 단면(cm). ok/warn: 이 차이(cm) 이내면 "비슷함"/"조금" 판정
// weight: 사이즈 추천 점수 가중치. 밑위·밑단은 사이즈보다 디자인이 좌우하므로 0
const PARTS = [
  { key: 'waist', label: '허리', kind: 'girth', ok: 1, warn: 2, weight: 3, body: 'waist' },
  { key: 'hip', label: '엉덩이', kind: 'girth', ok: 1.5, warn: 3, weight: 2, body: 'hip' },
  { key: 'thigh', label: '허벅지', kind: 'girth', ok: 1, warn: 2.5, weight: 2, body: 'thigh' },
  { key: 'rise', label: '밑위', kind: 'rise', ok: 1, warn: 2.5, weight: 0 },
  { key: 'hem', label: '밑단', kind: 'hem', ok: 1, warn: 2.5, weight: 0 },
  { key: 'length', label: '총장', kind: 'length', ok: 2, warn: 4, weight: 1 },
];

// 몸 치수: 둘레(cm)
const BODY_FIELDS = [
  { key: 'height', label: '키' },
  { key: 'waist', label: '허리둘레' },
  { key: 'hip', label: '엉덩이둘레' },
  { key: 'thigh', label: '허벅지둘레' },
  { key: 'inseam', label: '다리 안쪽 길이' },
];

const STRETCH_BONUS = { none: 0, some: 0.5, high: 1 };   // 신축성이 주는 여유(cm, 단면)
const FEEL_OFFSET = { good: 0, tight: 1.5, loose: -1.5 };     // 기준 바지 착용감 보정(cm, 단면)
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
    return { ...empty, ...JSON.parse(raw) };
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

// ---------- 내 바지 ----------
function renderCloset() {
  const list = $('#closet-list');
  if (!state.closet.length) {
    list.innerHTML = '<li class="empty">아직 등록한 바지가 없어요. 제일 잘 맞는 바지부터 넣어 보세요.</li>';
    return;
  }
  list.innerHTML = state.closet.map((p) => {
    const m = PARTS.filter((pt) => p[pt.key] != null).map((pt) => `${pt.label} ${fmt(p[pt.key])}`).join(' · ');
    return `
      <li>
        <div>
          <div><b>${esc(p.name)}</b> ${p.size ? `<span class="meta">(${esc(p.size)})</span>` : ''}</div>
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
  if (editId) openPantsForm(state.closet.find((p) => p.id === editId));
  if (delId) {
    const p = state.closet.find((x) => x.id === delId);
    if (p && confirm(`'${p.name}'을(를) 삭제할까요?`)) {
      state.closet = state.closet.filter((x) => x.id !== delId);
      saveState();
      renderCloset();
    }
  }
});

$('#p-measures').innerHTML = PARTS.map((pt) => `
  <label class="field">${pt.label}
    <input type="number" inputmode="decimal" step="0.1" name="${pt.key}">
  </label>`).join('');

function openPantsForm(p) {
  const form = $('#pants-form');
  form.reset();
  $('#pants-form-title').textContent = p ? '내 바지 수정' : '내 바지 추가';
  $('#p-id').value = p?.id ?? '';
  if (p) {
    $('#p-name').value = p.name;
    $('#p-size').value = p.size ?? '';
    $('#p-stretch').value = p.stretch;
    $('#p-feel').value = p.feel;
    for (const pt of PARTS) form.elements[pt.key].value = p[pt.key] ?? '';
  }
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth' });
}

$('#add-pants').addEventListener('click', () => openPantsForm(null));
$('#cancel-pants').addEventListener('click', () => $('#pants-form').classList.add('hidden'));

$('#pants-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const id = $('#p-id').value || uid();
  const pants = {
    id,
    name: $('#p-name').value.trim() || '이름 없는 바지',
    size: $('#p-size').value.trim(),
    stretch: $('#p-stretch').value,
    feel: $('#p-feel').value,
  };
  for (const pt of PARTS) pants[pt.key] = num(form.elements[pt.key].value);

  const idx = state.closet.findIndex((p) => p.id === id);
  if (idx >= 0) state.closet[idx] = pants;
  else state.closet.push(pants);
  saveState();
  form.classList.add('hidden');
  renderCloset();
});

// ---------- 새 바지 사이즈표 ----------
function defaultDraft() {
  return { name: '', stretch: 'none', refId: null, rows: [{ size: 'S' }, { size: 'M' }, { size: 'L' }] };
}
if (!state.draft) state.draft = defaultDraft();

function renderSizeTable() {
  $('#size-head').innerHTML = '<th>사이즈</th>' + PARTS.map((pt) => `<th>${pt.label}</th>`).join('') + '<th></th>';
  $('#size-body').innerHTML = state.draft.rows.map((r, i) => `
    <tr>
      <td><input type="text" data-row="${i}" data-key="size" value="${esc(r.size ?? '')}"></td>
      ${PARTS.map((pt) => `<td><input type="number" inputmode="decimal" step="0.1" data-row="${i}" data-key="${pt.key}" value="${r[pt.key] ?? ''}"></td>`).join('')}
      <td><button type="button" class="del" data-delrow="${i}" aria-label="행 삭제">✕</button></td>
    </tr>`).join('');
  $('#new-name').value = state.draft.name;
  $('#new-stretch').value = state.draft.stretch;
}

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
  if (!state.closet.length) {
    sel.innerHTML = '<option value="">먼저 \'내 바지\' 탭에서 바지를 추가해 주세요</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  // 기준 기본값: 저장된 선택 → "딱 좋음" 바지 → 첫 번째
  const ref = state.closet.find((p) => p.id === state.draft.refId)
    || state.closet.find((p) => p.feel === 'good')
    || state.closet[0];
  state.draft.refId = ref.id;
  sel.innerHTML = state.closet.map((p) =>
    `<option value="${p.id}" ${p.id === ref.id ? 'selected' : ''}>${esc(p.name)}${p.size ? ` (${esc(p.size)})` : ''} · ${FEEL_LABEL[p.feel]}</option>`).join('');
}

// ---------- 핏 계산 ----------
// 한 사이즈 행을 기준 바지와 비교해 부위별 판정을 만든다
function compareRow(row, ref, newStretch, body) {
  const parts = [];
  let score = 0;
  let used = 0;

  for (const pt of PARTS) {
    const nv = row[pt.key];
    const rv = ref[pt.key];
    if (nv == null || rv == null) continue;

    const raw = nv - rv;
    let eff = raw;
    if (pt.kind === 'girth') {
      // 새 바지가 더 잘 늘어나면 체감상 여유가 생기고, 기준 바지가 꼈다면 더 커야 "딱 좋음"
      eff += STRETCH_BONUS[newStretch] - STRETCH_BONUS[ref.stretch];
      eff -= FEEL_OFFSET[ref.feel];
    }

    const verdict = judge(pt, eff);

    // 몸 둘레 대비 여유분(옷 둘레 = 단면 × 2)
    let ease = null;
    if (pt.body && body[pt.body] != null) {
      ease = nv * 2 - body[pt.body];
      if (ease < 0 && newStretch === 'none') {
        verdict.level = 'bad';
        verdict.text = '몸보다 작음';
      }
    }

    parts.push({ ...pt, nv, rv, raw, eff, ease, verdict });
    if (pt.weight) {
      const tightPenalty = pt.kind === 'girth' && eff < 0 ? 2 : 1; // 큰 건 줄여 입어도 작은 건 못 입는다
      score += pt.weight * tightPenalty * (eff / pt.ok) ** 2;
      if (ease !== null && ease < 0 && newStretch === 'none') score += 1000;
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
    length: d < 0 ? '짧음' : '김',
  }[pt.kind];
  return { level, text: little + words };
}

function summarize(result, ref) {
  const off = result.parts.filter((p) => p.verdict.level !== 'ok');
  if (!result.parts.length) return '비교할 수 있는 실측이 없어요. 기준 바지와 같은 항목을 입력해 주세요.';
  if (!off.length) return `'${ref.name}'과(와) 거의 같은 핏이에요.`;
  const bits = off.map((p) => {
    if (p.verdict.text === '몸보다 작음') return `${p.label}가 몸 둘레보다 ${fmt(Math.abs(p.ease))}cm 작음`;
    return `${p.label} ${p.verdict.text}(${fmt(Math.abs(p.raw))}cm)`;
  });
  return `'${ref.name}' 대비 ${bits.join(', ')}.`;
}

// ---------- 비교 실행 / 결과 렌더 ----------
let lastResults = null;

$('#run-compare').addEventListener('click', () => {
  const ref = state.closet.find((p) => p.id === state.draft.refId);
  if (!ref) {
    alert('먼저 \'내 바지\' 탭에서 기준이 될 바지를 추가해 주세요.');
    showTab('closet');
    return;
  }
  const rows = state.draft.rows.filter((r) => PARTS.some((pt) => r[pt.key] != null));
  if (!rows.length) {
    alert('사이즈표에 실측을 한 줄 이상 입력해 주세요.');
    return;
  }

  const results = rows.map((row) => ({ row, ...compareRow(row, ref, state.draft.stretch, state.body) }));
  const best = results.reduce((a, b) => (b.score < a.score ? b : a));
  lastResults = { ref, results, best, selected: best };
  renderResult();
  $('#result').scrollIntoView({ behavior: 'smooth' });
});

function renderResult() {
  const { ref, results, best, selected } = lastResults;
  const box = $('#result');
  box.classList.remove('hidden');

  const tabs = results.length > 1 ? `
    <div class="size-tabs">
      ${results.map((r, i) => `<button type="button" data-pick="${i}" class="${r === selected ? 'active' : ''}">
        ${r === best ? '<span class="star">★</span> ' : ''}${esc(r.row.size || `#${i + 1}`)}</button>`).join('')}
    </div>` : '';

  const rec = results.length > 1
    ? `<p class="hint">★ 추천: <b>${esc(best.row.size || '')}</b> — 기준 바지와 가장 비슷한 사이즈예요.</p>` : '';

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
  if (ref.feel !== 'good') notes.push(`기준 바지가 '${FEEL_LABEL[ref.feel]}'이라서 그만큼 보정했어요.`);

  box.innerHTML = `
    <h2>${esc(state.draft.name || '새 바지')} 핏 예측</h2>
    ${tabs}
    ${rec}
    <p class="summary">${esc(summarize(selected, ref))}</p>
    <table class="diff-table">
      <thead><tr><th>부위</th><th>새 바지</th><th>내 바지</th><th>차이</th><th>판정</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${notes.length ? `<p class="hint" style="margin-top:10px">${notes.map(esc).join('<br>')}</p>` : ''}
    <h3>실루엣 비교</h3>
    ${renderSilhouette(selected.row, ref, state.body)}
  `;
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
  return { pts, minY: top, maxY: bottom, maxX: Math.max(w, hip, t, c + h) };
}

function renderSilhouette(row, ref, body) {
  const a = pantsShape(ref);
  const b = pantsShape(row);
  if (!a || !b) return '<p class="hint">실루엣을 그리려면 허리·허벅지·밑위·밑단·총장이 두 바지 모두 필요해요.</p>';

  const ankle = body.inseam ?? null;
  const pad = 6;
  const maxX = Math.max(a.maxX, b.maxX) + pad;
  const minY = Math.min(a.minY, b.minY) - pad;
  const maxY = Math.max(a.maxY, b.maxY, ankle ?? 0) + pad;
  const toPath = (s) => 'M' + s.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L') + ' Z';

  const ankleLine = ankle != null ? `
    <line x1="${-maxX}" x2="${maxX}" y1="${ankle}" y2="${ankle}" stroke="var(--muted)" stroke-width="0.4" stroke-dasharray="1.5 1.5"/>
    <text x="${maxX - 1}" y="${ankle - 1.2}" font-size="3" text-anchor="end" fill="var(--muted)">내 발목</text>` : '';

  return `
    <div class="silhouette">
      <svg viewBox="${-maxX} ${minY} ${maxX * 2} ${maxY - minY}" role="img" aria-label="두 바지 실루엣 비교">
        ${ankleLine}
        <path d="${toPath(a)}" fill="none" stroke="var(--ref)" stroke-width="0.8" stroke-dasharray="2 1.2" stroke-linejoin="round"/>
        <path d="${toPath(b)}" fill="var(--new)" fill-opacity="0.18" stroke="var(--new)" stroke-width="0.8" stroke-linejoin="round"/>
      </svg>
      <div class="legend">
        <span><i style="background:var(--ref)"></i>내 바지</span>
        <span><i style="background:var(--new)"></i>새 바지</span>
      </div>
    </div>`;
}

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
    Object.assign(state, { body: data.body, closet: data.closet, draft: data.draft || defaultDraft() });
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
}
renderAll();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
