// 치수를 아는 합성 인체 마스크로 body.js 계산 검증
const B = require('C:/Users/oyohe/Desktop/피팅앱/body.js');
const W = 600, H = 1100;
const data = new Float32Array(W * H);
const fill = (fn) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fn(x, y)) data[y * W + x] = 1; };
const lerp = (a, b, t) => a + (b - a) * t;

// 키 1000px (y 50~1049) = 175cm → 1px = 0.175cm
fill((x, y) => ((x - 300) / 50) ** 2 + ((y - 117) / 67) ** 2 <= 1);           // 머리 (정수리 50, 턱 184)
fill((x, y) => y >= 180 && y < 212 && Math.abs(x - 300) <= 25);                // 목
fill((x, y) => {                                                                // 몸통
  if (y < 210 || y >= 590) return false;
  let half;
  if (y < 300) half = 120;                                // 어깨 폭 240
  else if (y < 430) half = lerp(120, 80, (y - 300) / 130); // 허리 폭 160
  else if (y < 540) half = lerp(80, 100, (y - 430) / 110); // 엉덩이 폭 200
  else half = 100;
  return Math.abs(x - 300) <= half && !(y >= 580 && Math.abs(x - 300) <= 5);
});
fill((x, y) => {                                                                // 다리 (가랑이 580)
  if (y < 580 || y >= 1040) return false;
  const w = lerp(90, 60, (y - 580) / 460);
  return (x >= 295 - w && x < 295) || (x > 305 && x <= 305 + w);
});
fill((x, y) => y >= 1040 && y < 1050 && ((x >= 230 && x < 290) || (x > 310 && x <= 370))); // 발
fill((x, y) => y >= 250 && y < 650 && ((x >= 140 && x < 170) || (x > 430 && x <= 460)));  // 팔(몸에서 떨어짐)

const n = (x, y, v = 1) => ({ x: x / W, y: y / H, visibility: v });
const pose = [];
pose[0] = n(300, 120); pose[2] = n(285, 105); pose[5] = n(315, 105); pose[9] = n(290, 150); pose[10] = n(310, 150);
pose[11] = n(215, 245); pose[12] = n(385, 245); pose[15] = n(155, 640); pose[16] = n(445, 640);
pose[23] = n(250, 560); pose[24] = n(350, 560); pose[25] = n(250, 800); pose[26] = n(350, 800);
pose[27] = n(250, 1020); pose[28] = n(350, 1020); pose[29] = n(250, 1045); pose[30] = n(350, 1045); pose[31] = n(260, 1048); pose[32] = n(340, 1048);
for (let i = 0; i < 33; i++) pose[i] = pose[i] || n(300, 500);
const face = []; face[152] = { x: 0.5, y: 184 / H }; face[10] = { x: 0.5, y: 74 / H };

const mask = { data, width: W, height: H };
const f = B.analyzeFront({ mask, pose, face, heightCm: 175 });
const expect = { heads: 1000 / 134, shoulderCm: 241 * 0.175, waistWidthCm: 161 * 0.175, hipWidthCm: 201 * 0.175, thighWidthCm: 88.7 * 0.175, inseamCm: 470 * 0.175 };
let ok = true;
for (const [k, e] of Object.entries(expect)) {
  const err = Math.abs(f[k] - e) / e;
  if (err > 0.03) ok = false;
  console.log(k.padEnd(14), 'got', String(f[k]).padEnd(6), 'expected', e.toFixed(1), err > 0.03 ? '  ✗' : '  ✓');
}
console.log('legRatio', f.legRatio, 'upper/lower', f.upperLowerRatio, 'warnings', f.warnings);
console.log('shape', B.bodyShape(f));
console.log('girths(no side)', B.estimateGirths(f, null));
// 원 둘레 검사: 폭=두께=10 → 31.4
console.log('ellipse circle 10 →', B.ellipse(10, 10).toFixed(2));

// 머리카락 볼륨 보정: 머리 위에 머리카락 40px 추가
fill((x, y) => y >= 10 && y < 52 && Math.abs(x - 300) <= 45);
const f2 = B.analyzeFront({ mask, pose, face, heightCm: 175 });
console.log('hair corrected heads', f2.heads, f2.warnings.filter((w) => w.includes('머리카락')).length ? '✓ 보정됨' : '✗');
process.exit(ok ? 0 : 1);
