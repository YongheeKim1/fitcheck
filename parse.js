'use strict';

// 쇼핑몰 사이즈표 텍스트(복사한 표 또는 OCR 결과)를 사이즈 행으로 바꾼다.
// 지원 형태:
//   1) 가로형: 헤더 줄(사이즈 허리 허벅지 ...) + 사이즈별 줄
//   2) 세로형: 사이즈 줄(S M L) + 부위별 줄(허리 38 40 42)
//   3) 셀마다 줄바꿈된 형태(웹페이지 표를 복사하면 종종 이렇게 나온다)
// 하의(허리·허벅지·밑위...)와 상의(어깨·가슴·소매...)를 모두 읽고, 어느 쪽인지 category로 알려 준다
(function (root) {
  // OCR이 한글 글자 사이에 공백을 넣는 경우가 많아 글자 사이 공백을 허용한다
  const kw = (word) => word.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const re = (...words) => new RegExp(words.map((w) => (/^[a-z]+$/i.test(w) ? w : kw(w))).join('|'), 'gi');

  // 순서가 중요: 긴/구체적인 패턴(뒷밑위, 안기장)을 먼저 잡아야 밑위·기장으로 잘못 잡히지 않는다
  // key: null 은 표에는 있지만 앱에서 쓰지 않는 열(숫자 자리만 차지)
  // 허벅치·밑의·종장 등은 OCR이 자주 잘못 읽는 형태
  const COLUMNS = [
    { key: null, re: re('뒷밑위', '뒤밑위', '인심', '안기장', '안쪽기장', '무릎', '종아리', 'inseam', 'knee',
      '소매부리', '소매통', '소매단', '소매폭', '커프스', '소매둘레', '암홀', '진동', '화장', '팔통', '목너비', '넥') },
    { key: 'size', re: re('사이즈', '호칭', '치수', 'size') },
    { key: 'waist', re: re('허리', 'waist') },
    { key: 'hip', re: re('엉덩이', '힙', 'hip') },
    { key: 'thigh', re: re('허벅지', '허벅치', 'thigh') },
    { key: 'rise', re: re('앞밑위', '밑위', '밑의', 'rise') },
    { key: 'hem', re: re('밑단', '밑통', 'hem') },
    // 가슴·어깨는 뒤에 붙은 "둘레/단면"을 따로 확인해야 해서 짧게 잡는다
    { key: 'shoulder', re: re('어깨', 'shoulder') },
    { key: 'chest', re: re('가슴', 'chest', 'bust') },
    { key: 'sleeve', re: re('소매길이', '소매기장', '소매', '팔길이', 'sleeve') },
    { key: 'length', re: re('총기장', '총장', '종장', '총징', '바지길이', '기장', 'length') },
  ];

  const GIRTH = ['waist', 'hip', 'thigh', 'hem', 'chest'];
  // 단면이라면 이 값을 넘기 어렵다 → 넘으면 둘레로 보고 반으로 나눈다 (어깨너비는 원래 전체 폭이라 제외)
  const CIRC_THRESHOLD = {
    bottom: { waist: 55, hip: 70, thigh: 45, hem: 35, chest: 85 },
    top: { waist: 75, hip: 80, thigh: 45, hem: 85, chest: 85 },
  };
  // 단면 기준 상식적인 범위. 벗어나면 OCR 오인식으로 보고 버린다
  const RANGE = {
    bottom: { waist: [20, 70], hip: [25, 80], thigh: [12, 55], rise: [15, 45], hem: [7, 45], length: [30, 135] },
    top: { shoulder: [28, 80], chest: [30, 90], sleeve: [8, 95], hem: [30, 90], waist: [25, 80], length: [35, 110] },
  };
  const LABEL = {
    waist: '허리', hip: '엉덩이', thigh: '허벅지', rise: '밑위', hem: '밑단',
    shoulder: '어깨', chest: '가슴', sleeve: '소매', length: '총장',
  };
  const TOP_KEYS = ['shoulder', 'chest', 'sleeve'];
  const BOTTOM_KEYS = ['waist', 'thigh', 'rise', 'hip'];

  function findColumns(line) {
    const taken = [];
    const found = [];
    for (const col of COLUMNS) {
      col.re.lastIndex = 0;
      let m;
      while ((m = col.re.exec(line))) {
        const s = m.index;
        const e = s + m[0].length;
        if (taken.some(([a, b]) => s < b && e > a)) continue;
        taken.push([s, e]);
        found.push({ key: col.key, start: s, end: e });
      }
    }
    found.sort((a, b) => a.start - b.start);
    // 열 이름 뒤에 붙은 "둘레"/"단면" 표기 확인
    found.forEach((c, i) => {
      const tail = line.slice(c.end, found[i + 1]?.start ?? line.length);
      c.circ = /둘\s*레/.test(tail);
    });
    return found;
  }

  function cleanToken(t) {
    let s = t;
    // OCR 흔한 오인식: 숫자 속 O→0, l/I→1, /→7 (잡문자 제거 전에 해야 3/ 같은 경우를 살린다)
    if (/\d/.test(s) && /^[\dOoIl/.,]+$/.test(s)) s = s.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/\//g, '7');
    // 앞뒤에 붙은 잡문자(괄호, 밑줄, 따옴표 등) 제거
    return s.replace(/^[^0-9A-Za-z가-힣]+|[^0-9A-Za-z가-힣]+$/g, '').replace(/cm$/i, '');
  }

  function toNumber(t) {
    const s = cleanToken(t).replace(',', '.');
    return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
  }

  function tokens(line) {
    return line.split(/[\t|│_]+|\s+/).map((t) => t.trim()).filter(Boolean);
  }

  // 빈 칸 표시(무신사는 값이 없는 칸을 '-'로 보여 준다): 칸 위치는 유지하고 값은 비운다
  const isBlankCell = (t) => /^[-–—]$/.test(t.trim());
  const BLANK = NaN;

  const isSizeLike = (t) => /^(free|f|xxs|xs|s|m|l|xl|xxl|xxxl|\d?x{1,3}l|\d{1,2})$/i.test(cleanToken(t));
  const isModifier = (t) => /^(단\s*면|둘\s*레|\(?cm\)?|단\s*위|:)$/i.test(t);

  // ---- 1) 가로형 ----
  function parseRowWise(lines, headerIdx) {
    const cols = findColumns(lines[headerIdx]);
    const hasSizeCol = cols.some((c) => c.key === 'size');
    const valueCols = cols.filter((c) => c.key !== 'size');
    const rows = [];
    let shortRows = 0;

    for (const line of lines.slice(headerIdx + 1)) {
      if (findColumns(line).filter((c) => c.key && c.key !== 'size').length >= 2) break; // 다른 표 시작
      const toks = tokens(line);
      if (!toks.length) continue;
      let label = '';
      let nums = toks.map((t) => (isBlankCell(t) ? BLANK : toNumber(t)));
      if (nums[0] === null) {
        label = cleanToken(toks[0]);
        nums = nums.slice(1);
      }
      nums = nums.filter((n) => n !== null); // 빈 칸(NaN)은 남겨서 열 위치를 지킨다
      if (!label && (hasSizeCol || nums.length > valueCols.length) && nums.length >= 2) {
        label = String(nums.shift());
      }
      // OCR이 붙여 읽은 숫자(31 25 → 3125)는 칸 수가 모자랄 때만 나눈다
      for (let k = 0; k < nums.length && nums.length < valueCols.length; k++) {
        if (Number.isInteger(nums[k]) && nums[k] >= 1000 && nums[k] <= 9999) {
          nums.splice(k, 1, Math.floor(nums[k] / 100), nums[k] % 100);
        }
      }
      if (nums.length < 2) continue;
      if (nums.length < valueCols.length) shortRows++;
      const row = { size: label };
      valueCols.forEach((c, i) => {
        if (c.key && nums[i] !== undefined && !Number.isNaN(nums[i])) row[c.key] = nums[i];
      });
      rows.push(row);
    }

    // 사이즈 이름이 표 밖에 따로 나열된 경우(무신사: "1 2 3 4"가 표 위에 세로로):
    // 헤더 바로 위의 "한 단어짜리 사이즈 줄"들을 행 순서대로 붙인다
    if (rows.length && rows.every((r) => !r.size)) {
      const run = [];
      for (let k = headerIdx - 1; k >= 0; k--) {
        const t = tokens(lines[k]);
        if (t.length !== 1 || !isSizeLike(t[0])) break;
        run.unshift(cleanToken(t[0]));
      }
      if (run.length >= rows.length) rows.forEach((r, k) => { r.size = run[k]; });
    }
    return { rows, cols: valueCols, shortRows };
  }

  // ---- 2) 세로형 ----
  function parseColumnWise(lines) {
    const rows = [];
    const cols = [];
    let sizes = null;
    for (const line of lines) {
      const found = findColumns(line);
      const part = found.find((c) => c.key && c.key !== 'size' && c.start <= 2);
      const toks = tokens(line);
      if (found.some((c) => c.key === 'size' && c.start <= 2) || (!part && !sizes && toks.length >= 2 && toks.every(isSizeLike))) {
        sizes = toks.filter((t) => !findColumns(t).some((c) => c.key === 'size') && !isModifier(t)).map(cleanToken);
        continue;
      }
      if (!part && !found.some((c) => c.key === null && c.start <= 2)) continue;
      const nums = tokens(line.slice((part || found[0]).end)).map(toNumber).filter((n) => n !== null);
      if (nums.length < 1) continue;
      if (!part) continue; // 쓰지 않는 열(뒷밑위 등)
      cols.push({ key: part.key, circ: part.circ || /둘\s*레/.test(line) });
      nums.forEach((n, i) => {
        rows[i] = rows[i] || { size: sizes?.[i] ?? '' };
        rows[i][part.key] = n;
      });
    }
    return { rows, cols, shortRows: 0 };
  }

  // ---- 3) 셀마다 줄바꿈 ----
  function parseCellPerLine(text) {
    const toks = tokens(text.replace(/\n/g, ' '));
    const first = toks.findIndex((t) => findColumns(t).length);
    if (first < 0) return null;
    const header = [];
    let i = first;
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (isModifier(t)) {
        if (/둘\s*레/.test(t) && header.length) header[header.length - 1].circ = true;
        continue;
      }
      const f = findColumns(t);
      if (!f.length) break;
      header.push(...f);
    }
    const valueCols = header.filter((c) => c.key !== 'size');
    if (valueCols.filter((c) => c.key).length < 2) return null;
    const hasSizeCol = header.some((c) => c.key === 'size');
    const rest = toks.slice(i).filter((t) => toNumber(t) !== null || isSizeLike(t));
    const width = valueCols.length + (hasSizeCol || toNumber(rest[0] ?? '') === null ? 1 : 0);
    const withLabel = width > valueCols.length;
    const rows = [];
    for (let j = 0; j + width <= rest.length; j += width) {
      const chunk = rest.slice(j, j + width);
      const row = { size: withLabel ? cleanToken(chunk[0]) : '' };
      const nums = (withLabel ? chunk.slice(1) : chunk).map(toNumber);
      valueCols.forEach((c, k) => {
        if (c.key && nums[k] !== null) row[c.key] = nums[k];
      });
      rows.push(row);
    }
    return { rows, cols: valueCols, shortRows: 0 };
  }

  const partCount = (l) => findColumns(l).filter((c) => c.key && c.key !== 'size').length;

  // 쇼핑몰 표를 복사하면 헤더와 칸이 여러 줄로 쪼개져 나온다. 가로형(헤더 한 줄 + 행마다 한 줄)으로 다시 묶는다.
  //   무신사: "1 / 총장<탭>2 / 허리단면<탭>3 / ..." (열 이름과 열 번호가 섞임) + 행 데이터는 한 줄씩
  //   에이블리: "사이즈 / 총장 / 어깨단면 / ... / FREE / 62 / - / 58 ..." (모든 칸이 한 줄씩)
  function normalizeLines(lines) {
    if (lines.some((l) => partCount(l) >= 2)) return lines;
    const numCount = (l) => tokens(l).filter((t) => toNumber(t) !== null).length;
    // 쓰지 않는 열(암홀 등)도 헤더 조각이다 — 빠뜨리면 열 개수가 어긋난다
    const anyCol = (l) => findColumns(l).filter((c) => c.key !== 'size').length;
    // 헤더 조각: 열 이름 한 단어("사이즈", "어깨단면"), 열 이름 + 열 번호("총장<탭>2"), 단위·수식어,
    // 그리고 바로 뒤에 열 이름이 오는 열 번호. "어깨 45 47 49" 같은 세로형 데이터 줄은 조각이 아니다
    const isPiece = (l, next) => {
      const toks = tokens(l);
      if (/^\d{1,2}$/.test(l)) return next != null && anyCol(next) >= 1;
      if (toks.every(isModifier)) return true;
      if (toks.length === 1 && findColumns(l).length >= 1) return true;
      return toks.length <= 2 && anyCol(l) >= 1 && numCount(l) <= 1;
    };

    for (let start = 0; start < lines.length; start++) {
      if (!isPiece(lines[start], lines[start + 1])) continue;
      let end = start;
      while (end < lines.length && isPiece(lines[end], lines[end + 1])) end++;
      const header = lines.slice(start, end).flatMap(tokens).filter((t) => !/^\d{1,2}$/.test(t)).join('\t');
      if (partCount(header) < 2) { start = end; continue; }

      // 헤더 뒤가 "칸마다 한 줄"이면 열 개수만큼씩 묶어 행을 만든다
      const cells = [];
      let k = end;
      while (k < lines.length) {
        const t = tokens(lines[k]);
        if (t.length !== 1 || findColumns(lines[k]).length) break;
        if (!(isBlankCell(t[0]) || toNumber(t[0]) !== null || isSizeLike(t[0]))) break;
        cells.push(t[0]);
        k++;
      }
      const cols = findColumns(header);
      let width = cols.length;
      // 헤더에 사이즈 열이 없는데 첫 칸이 글자(FREE, M 등)면 사이즈 칸이 하나 더 있는 것
      if (!cols.some((c) => c.key === 'size') && cells.length && toNumber(cells[0]) === null && !isBlankCell(cells[0])) width++;
      const out = [...lines.slice(0, start), header];
      if (cells.length >= width) {
        for (let j = 0; j + width <= cells.length; j += width) out.push(cells.slice(j, j + width).join('\t'));
        out.push(...lines.slice(k));
      } else {
        out.push(...lines.slice(end));
      }
      return out;
    }
    return lines;
  }

  function parseSizeChart(text) {
    const lines = normalizeLines(String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean));
    const warnings = [];

    let result = null;
    const headerIdx = lines.findIndex((l) => partCount(l) >= 2);
    if (headerIdx >= 0) result = parseRowWise(lines, headerIdx);
    if (!result || !result.rows.length) {
      const cw = parseColumnWise(lines);
      if (cw.rows.length) result = cw;
    }
    if (!result || !result.rows.length) result = parseCellPerLine(text) || result;
    if (!result || !result.rows.length) {
      return { rows: [], parts: [], category: null, warnings: ['사이즈표를 찾지 못했어요. 허리·가슴 같은 항목 이름이 포함돼 있는지 확인해 주세요.'] };
    }

    const { rows, cols, shortRows } = result;
    if (shortRows) warnings.push(`${shortRows}개 행은 숫자가 모자라요. 빠진 칸이 없는지 확인해 주세요.`);

    // 상의/하의 판별: 어깨·가슴·소매가 더 많이 보이면 상의
    const has = (k) => rows.some((r) => r[k] != null);
    const category = TOP_KEYS.filter(has).length > BOTTOM_KEYS.filter(has).length ? 'top' : 'bottom';
    const range = RANGE[category];

    // 둘레 → 단면 변환, 범위 밖 값 제거
    const halved = new Set();
    const dropped = new Set();
    for (const key of GIRTH) {
      const vals = rows.map((r) => r[key]).filter((v) => v != null);
      if (!vals.length) continue;
      const headerSaysCirc = cols.some((c) => c.key === key && c.circ);
      const median = vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)];
      if (headerSaysCirc || median > CIRC_THRESHOLD[category][key]) {
        rows.forEach((r) => { if (r[key] != null) r[key] = Math.round((r[key] / 2) * 10) / 10; });
        halved.add(LABEL[key]);
      }
    }
    const inRange = (key, v) => v >= range[key][0] && v <= range[key][1];
    for (const r of rows) {
      for (const key of Object.keys(LABEL)) {
        if (r[key] == null) continue;
        if (!range[key]) { delete r[key]; continue; } // 다른 종류 옷의 항목(상의 표의 허벅지 등)
        if (inRange(key, r[key])) continue;
        // 소수점이 빠진 경우(44.5 → 445) 복구
        if (inRange(key, r[key] / 10)) {
          r[key] /= 10;
        } else {
          delete r[key];
          dropped.add(LABEL[key]);
        }
      }
    }

    // 다른 행이 글자 사이즈(S/M/L)면 '5'·'$'는 S를 잘못 읽은 것
    const letterRows = rows.filter((r) => /^[a-z]+$/i.test(r.size)).length;
    if (letterRows >= rows.length / 2) {
      rows.forEach((r) => { if (r.size === '5' || r.size === '$') r.size = 'S'; });
    }
    if (halved.size) warnings.push(`${[...halved].join('·')}은(는) 둘레로 보여서 단면(÷2)으로 바꿨어요.`);
    if (dropped.size) warnings.push(`${[...dropped].join('·')}에 말이 안 되는 숫자가 있어서 비웠어요. 직접 확인해 주세요.`);

    const parts = Object.keys(LABEL).filter((k) => rows.some((r) => r[k] != null));
    const cleanRows = rows.filter((r) => parts.some((k) => r[k] != null));
    return { rows: cleanRows, parts: parts.map((k) => LABEL[k]), warnings, category };
  }

  root.parseSizeChart = parseSizeChart;
  if (typeof module !== 'undefined') module.exports = { parseSizeChart };
})(typeof window !== 'undefined' ? window : globalThis);
