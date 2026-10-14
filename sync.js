'use strict';

// ---------- 계정과 서버 동기화 ----------
// 앱은 기기(localStorage)에 먼저 저장하고, 로그인돼 있으면 Supabase와 동기화한다.
// 충돌은 "더 최근에 고친 쪽이 이긴다": 프로필(체형·분석·작성 중 표)은 통째로, 내 옷은 옷 하나씩.
// 서버에는 숫자만 간다(사진 없음).

// 로컬 상태와 서버 상태 합치기(순수 함수, 테스트 가능)
// local: { body, bodyAnalysis, personalColor, draft, updatedAt, closet: [item], tombstones: [{id, updatedAt}] }
// remote: fc_pull 결과 { profile: {...} | null, items: [{id, item, deleted, updatedAt}] }
function mergeSyncState(local, remote) {
  const out = {
    body: local.body, bodyAnalysis: local.bodyAnalysis, personalColor: local.personalColor,
    draft: local.draft, updatedAt: local.updatedAt || 0,
  };
  const rp = remote.profile;
  if (rp && (rp.updatedAt || 0) > out.updatedAt) {
    Object.assign(out, {
      body: rp.body || {}, bodyAnalysis: rp.bodyAnalysis ?? null, personalColor: rp.personalColor ?? null,
      draft: rp.draft ?? local.draft, updatedAt: rp.updatedAt,
    });
  }

  const byId = new Map();
  for (const it of local.closet || []) byId.set(it.id, { deleted: false, updatedAt: it.updatedAt || 0, item: it });
  for (const t of local.tombstones || []) {
    const cur = byId.get(t.id);
    if (!cur || t.updatedAt >= cur.updatedAt) byId.set(t.id, { deleted: true, updatedAt: t.updatedAt, item: null });
  }
  for (const r of remote.items || []) {
    const cur = byId.get(r.id);
    if (!cur || (r.updatedAt || 0) > cur.updatedAt) {
      byId.set(r.id, { deleted: r.deleted, updatedAt: r.updatedAt || 0, item: r.deleted ? null : { ...r.item, id: r.id, updatedAt: r.updatedAt } });
    }
  }
  out.closet = [...byId.values()].filter((v) => !v.deleted).map((v) => v.item);
  out.tombstones = [...byId.entries()].filter(([, v]) => v.deleted).map(([id, v]) => ({ id, updatedAt: v.updatedAt }));
  return out;
}

// 서버로 보낼 형태
function toPushPayload(st) {
  return {
    profile: { body: st.body || {}, bodyAnalysis: st.bodyAnalysis ?? null, personalColor: st.personalColor ?? null, draft: st.draft ?? null, updatedAt: st.updatedAt || 0 },
    items: [
      ...(st.closet || []).map(({ id, updatedAt, ...item }) => ({ id, item, deleted: false, updatedAt: updatedAt || 0 })),
      ...(st.tombstones || []).map((t) => ({ id: t.id, deleted: true, updatedAt: t.updatedAt })),
    ],
  };
}

if (typeof module !== 'undefined') module.exports = { mergeSyncState, toPushPayload };

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('#account')) {
  const AUTH_KEY = 'fitcheck:auth';
  const cfg = () => window.FITCHECK_CONFIG || {};
  const configured = () => !!(cfg().supabaseUrl && cfg().supabaseAnonKey);
  let auth = (() => { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; } })();
  let syncing = false;
  let again = false;
  let timer = null;
  let lastSync = null;
  let lastError = '';

  const saveAuth = () => {
    try {
      if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      else localStorage.removeItem(AUTH_KEY);
    } catch { /* 저장 실패는 무시 */ }
  };

  // Supabase RPC 호출(PostgREST). 오류 문구의 "FC_XXX: " 접두사는 떼고 보여 준다
  // 네트워크 오류(연결 실패·시간 초과)는 브라우저 영어 문구 대신 한국어로
  async function rpc(fn, args) {
    try {
      return await rpcRaw(fn, args);
    } catch (err) {
      if (err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
      }
      throw err;
    }
  }

  async function rpcRaw(fn, args) {
    const res = await fetch(`${cfg().supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000), // 네트워크가 멈춰도 "동기화 중"에 갇히지 않게
      headers: {
        apikey: cfg().supabaseAnonKey,
        Authorization: `Bearer ${cfg().supabaseAnonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('서버 키가 맞지 않아요. config.js의 anon 키를 확인해 주세요.');
    const data = text ? JSON.parse(text) : null;
    const msg = !res.ok ? data?.message || `서버 오류(${res.status})` : data?.error;
    if (msg) {
      const e = new Error(msg.replace(/^FC_[A-Z]+:\s*/, ''));
      e.code = (msg.match(/^FC_[A-Z]+/) || [''])[0];
      throw e;
    }
    return data;
  }

  function localSnapshot() {
    return {
      body: state.body, bodyAnalysis: state.bodyAnalysis ?? null, personalColor: state.personalColor ?? null,
      draft: state.draft, updatedAt: state.updatedAt || 0, closet: state.closet, tombstones: state.tombstones || [],
    };
  }

  function applyMerged(m) {
    Object.assign(state, m);
    saveState({ fromSync: true });
    renderAll();
  }

  async function syncNow() {
    if (!auth || !configured()) return;
    if (syncing) { again = true; return; }
    syncing = true;
    setBadge('동기화 중…');
    try {
      const remote = await rpc('fc_pull', { p_token: auth.token });
      const merged = mergeSyncState(localSnapshot(), remote);
      const payload = toPushPayload(merged);
      const after = await rpc('fc_push', { p_token: auth.token, p_profile: payload.profile, p_items: payload.items });
      applyMerged(mergeSyncState(merged, after));
      lastSync = new Date();
      lastError = '';
    } catch (err) {
      console.error(err);
      if (err.code === 'FC_AUTH') {
        auth = null;
        saveAuth();
        lastError = err.message;
      } else {
        lastError = navigator.onLine ? `동기화 실패: ${err.message}` : '오프라인이라 연결되면 다시 동기화해요.';
      }
    } finally {
      syncing = false;
      renderAccount();
      if (again) { again = false; scheduleSync(500); }
    }
  }

  // app.js의 saveState가 부른다
  window.scheduleSync = (delay = 2500) => {
    if (!auth || !configured()) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, delay);
  };

  function setBadge(text) {
    const b = $('#sync-badge');
    if (b) b.textContent = text;
  }

  // ---------- 화면 ----------
  let mode = 'login';

  function renderAccount() {
    const box = $('#account');
    if (!configured()) {
      box.innerHTML = `<h2>계정</h2><p class="hint">서버가 아직 연결되지 않았어요. 지금은 이 기기에만 저장돼요.</p>`;
      setBadge('');
      return;
    }
    if (auth) {
      const when = lastSync ? lastSync.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-';
      box.innerHTML = `
        <h2>계정</h2>
        <p><b>${esc(auth.name)}</b> <span class="hint">(${esc(auth.login)})</span></p>
        <p class="hint">마지막 동기화 ${when}${lastError ? ` · <span style="color:var(--bad)">${esc(lastError)}</span>` : ''}</p>
        <div class="btn-row">
          <button type="button" class="ghost" id="acc-sync">지금 동기화</button>
          <button type="button" class="ghost" id="acc-logout">로그아웃</button>
        </div>
        <details class="photo-guide" style="margin-top:10px">
          <summary>계정 삭제</summary>
          <p class="hint">서버에 저장된 내 데이터가 모두 지워져요. 이 기기의 데이터는 남아요.</p>
          <label class="field">비밀번호 확인<input type="password" id="acc-del-pw" autocomplete="current-password"></label>
          <button type="button" class="ghost block" id="acc-delete">계정 삭제</button>
        </details>`;
      setBadge(lastError ? '동기화 안 됨' : lastSync ? `동기화 ${when}` : '');
      return;
    }
    const signup = mode === 'signup';
    box.innerHTML = `
      <h2>계정</h2>
      <p class="hint">로그인하면 폰과 PC에서 같은 데이터를 써요. 서버에는 숫자만 저장하고 사진은 올리지 않아요.</p>
      <div class="segment" id="acc-mode">
        <button type="button" data-mode="login" class="${signup ? '' : 'active'}">로그인</button>
        <button type="button" data-mode="signup" class="${signup ? 'active' : ''}">가입</button>
      </div>
      <form id="acc-form">
        <label class="field">아이디<input id="acc-login" autocomplete="username" autocapitalize="none" required></label>
        <label class="field">비밀번호<input id="acc-pw" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
        ${signup ? `
          <label class="field">이름<input id="acc-name" autocomplete="name" required></label>
          <label class="field">가입 코드<input id="acc-code" autocapitalize="none" required></label>
          <p class="hint">아이디는 영문 소문자·숫자 3~30자, 비밀번호는 8자 이상이에요. 가입 코드는 관리자에게 받아요.</p>` : ''}
        <button type="submit" class="primary block">${signup ? '가입하기' : '로그인'}</button>
        <p class="hint import-status" id="acc-status"></p>
      </form>`;
    setBadge('');
  }

  $('#account').addEventListener('click', async (e) => {
    const m = e.target.dataset.mode;
    if (m) { mode = m; renderAccount(); return; }
    if (e.target.id === 'acc-sync') syncNow();
    if (e.target.id === 'acc-logout') {
      const wipe = confirm('로그아웃할게요.\n이 기기에 저장된 내 데이터도 지울까요?\n(다른 사람과 같이 쓰는 기기라면 "확인")');
      try { await rpc('fc_logout', { p_token: auth.token }); } catch { /* 이미 만료됐어도 로그아웃 */ }
      auth = null;
      saveAuth();
      if (wipe) {
        try { localStorage.removeItem(STORE_KEY); } catch { /* 무시 */ }
        location.reload();
        return;
      }
      lastSync = null;
      renderAccount();
    }
    if (e.target.id === 'acc-delete') {
      const pw = $('#acc-del-pw').value;
      if (!pw || !confirm('정말 계정을 삭제할까요? 서버의 내 데이터가 모두 지워지고 되돌릴 수 없어요.')) return;
      try {
        await rpc('fc_delete_account', { p_token: auth.token, p_password: pw });
        auth = null;
        saveAuth();
        renderAccount();
        alert('계정을 삭제했어요.');
      } catch (err) {
        alert(err.message);
      }
    }
  });

  $('#account').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#acc-status');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    status.className = 'hint import-status';
    status.textContent = '확인 중…';
    try {
      const login = $('#acc-login').value;
      const pw = $('#acc-pw').value;
      const res = mode === 'signup'
        ? await rpc('fc_signup', { p_login: login, p_password: pw, p_name: $('#acc-name').value, p_code: $('#acc-code').value })
        : await rpc('fc_login', { p_login: login, p_password: pw });
      auth = { token: res.token, login: res.login, name: res.name };
      saveAuth();
      renderAccount();
      await syncNow(); // 이 기기 데이터와 서버 데이터를 합친다
    } catch (err) {
      status.className = 'hint import-status err';
      status.textContent = err.message;
      btn.disabled = false;
    }
  });

  window.addEventListener('online', () => scheduleSync(500));
  renderAccount();
  if (auth) syncNow();
}
