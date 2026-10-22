// garment.js의 inpaint()를 꺼내 검증: 가로 그라데이션 벽 한가운데 구멍을 메우면 주변 색이 이어져야 한다
const src = require('fs').readFileSync('C:/Users/oyohe/Desktop/피팅앱/garment.js', 'utf8');
const body = src.slice(src.indexOf('function inpaint('), src.indexOf('// G: 옷만 그린 투명 캔버스'));
const inpaint = new Function(body + '; return inpaint;')();
const W = 200, H = 120;
const img = { data: new Uint8ClampedArray(W * H * 4) };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4; img.data[i] = x; img.data[i + 1] = 100; img.data[i + 2] = 200 - x / 2; img.data[i + 3] = 255;
}
// 구멍에는 엉뚱한 색(원래 옷)을 칠해 둔다
const hole = (x, y) => x >= 80 && x < 120 && y >= 40 && y < 80;
for (let y = 40; y < 80; y++) for (let x = 80; x < 120; x++) { const i = (y * W + x) * 4; img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; }
inpaint(img, W, hole, { x0: 60, y0: 20, x1: 139, y1: 99 });
let maxErr = 0;
for (let y = 40; y < 80; y++) for (let x = 80; x < 120; x++) {
  const i = (y * W + x) * 4;
  maxErr = Math.max(maxErr, Math.abs(img.data[i] - x), Math.abs(img.data[i + 1] - 100), Math.abs(img.data[i + 2] - (200 - x / 2)));
}
console.log('구멍 안 최대 오차(0~255):', maxErr.toFixed(1), maxErr < 25 ? '✓ 주변 그라데이션으로 자연스럽게 채움' : '✗');
const outside = img.data[(10 * W + 10) * 4];
console.log('구멍 밖은 그대로:', outside === 10 ? '✓' : '✗');
process.exit(maxErr < 25 && outside === 10 ? 0 : 1);
