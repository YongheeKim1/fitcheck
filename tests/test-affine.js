// garment.js 안의 affine()을 꺼내 수치 검증: 원본 세 점이 목표 세 점으로 정확히 가는지
const src = require('fs').readFileSync('C:/Users/oyohe/Desktop/피팅앱/garment.js', 'utf8');
const body = src.slice(src.indexOf('function affine('), src.indexOf('function drawTri('));
const affine = new Function(body + '; return affine;')();
const S = [{ x: 10, y: 20 }, { x: 200, y: 35 }, { x: 60, y: 300 }];
const D = [{ x: 400, y: 100 }, { x: 520, y: 140 }, { x: 380, y: 700 }];
const [a, b, c, d, e, f] = affine(...S, ...D);
let ok = true;
S.forEach((p, i) => {
  const x = a * p.x + c * p.y + e, y = b * p.x + d * p.y + f;
  const err = Math.hypot(x - D[i].x, y - D[i].y);
  console.log(`점${i}: (${x.toFixed(3)}, ${y.toFixed(3)}) 목표 (${D[i].x}, ${D[i].y}) 오차 ${err.toExponential(1)}`);
  if (err > 1e-6) ok = false;
});
process.exit(ok ? 0 : 1);
