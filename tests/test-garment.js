const G = require('C:/Users/oyohe/Desktop/피팅앱/garment.js');
// 그리기 호출만 받아 주는 가짜 캔버스
const ctx = new Proxy({}, { get: (t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
const lm = [];
const P = (x, y) => ({ x: x / 600, y: y / 1100, visibility: 1 });
for (let i = 0; i < 33; i++) lm[i] = P(300, 500);
Object.assign(lm, { 11: P(215, 245), 12: P(385, 245), 13: P(190, 450), 14: P(410, 450), 15: P(185, 640), 16: P(415, 640), 19: P(185, 690), 20: P(415, 690),
  23: P(250, 560), 24: P(350, 560), 25: P(250, 800), 26: P(350, 800), 27: P(250, 1020), 28: P(350, 1020), 29: P(250, 1045), 30: P(350, 1045), 31: P(260, 1048), 32: P(340, 1048) });
const base = { lm, W: 600, H: 1100, mirror: false, pxPerCm: 5.7, body: {}, color: '#223344', stretch: 'none' };
const cases = {
  '상의: 어깨 없음(에이블리 FREE)': { category: 'top', g: { length: 62, chest: 58, sleeve: 68, hem: 32 } },
  '상의: 가슴 없음(폰에서 생긴 경우)': { category: 'top', g: { length: 62, shoulder: 48, sleeve: 52 } },
  '상의: 총장 없음': { category: 'top', g: { shoulder: 48, chest: 54 } },
  '바지: 허벅지·밑위 없음': { category: 'bottom', g: { waist: 40, length: 102, hem: 22 } },
  '바지: 정상': { category: 'bottom', g: { waist: 40, hip: 52, thigh: 32, rise: 29, hem: 23, length: 102 } },
};
for (const [name, c] of Object.entries(cases)) {
  const r = G.draw(ctx, { ...base, ...c });
  console.log(`${r.ok ? '그림 O' : '그림 X'} ${name} → ${r.notes.filter((n) => /추정|필요/.test(n)).join(' / ') || '(추정 없음)'}`);
}
