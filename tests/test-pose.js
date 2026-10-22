// 자세 검사(BodyAnalysis.checkPose) 테스트: 가짜 랜드마크로 정상/팔 듦/셀카/팔 교차/옆으로 섬/발 잘림
const B = require('C:/Users/oyohe/Desktop/피팅앱/body.js');
const W = 600, H = 1200;
function base() {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.99 }));
  const set = (i, x, y) => { p[i] = { x: x / W, y: y / H, visibility: 0.99 }; };
  set(0, 300, 150);                       // 코
  set(11, 230, 280); set(12, 370, 280);   // 어깨
  set(13, 215, 430); set(14, 385, 430);   // 팔꿈치
  set(15, 210, 560); set(16, 390, 560);   // 손목
  set(19, 208, 600); set(20, 392, 600);   // 손끝
  set(23, 255, 560); set(24, 345, 560);   // 골반
  set(25, 255, 800); set(26, 345, 800);   // 무릎
  set(27, 255, 1050); set(28, 345, 1050); // 발목
  set(29, 250, 1090); set(30, 350, 1090); // 발꿈치
  set(31, 265, 1100); set(32, 335, 1100); // 발끝
  return { p, set };
}
let fail = 0;
function check(name, mutate, expectKeys) {
  const { p, set } = base();
  mutate(set, p);
  const r = B.checkPose(p, W, H);
  const keys = r.issues.map((i) => i.key).sort();
  const ok = JSON.stringify(keys) === JSON.stringify(expectKeys.slice().sort());
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${keys.join(',') || '(문제 없음)'}${ok ? '' : ` (기대: ${expectKeys.join(',')})`}`);
}
check('정상 정면', () => {}, []);
check('오른팔 들기', (set) => { set(14, 420, 200); set(16, 400, 120); set(20, 400, 100); }, ['armUp']);
check('거울 셀카(손이 얼굴 앞)', (set) => { set(14, 400, 330); set(16, 320, 170); set(20, 315, 150); }, ['armUp', 'face']);
check('팔짱/팔이 몸 앞', (set) => { set(15, 310, 420); set(16, 290, 420); }, ['armCross']);
check('옆으로 섬', (set) => { set(11, 285, 280); set(12, 315, 280); set(23, 290, 560); set(24, 310, 560); }, ['turned']);
check('발 잘림', (set, p) => { p[29].visibility = 0.1; }, ['cut']);
check('얼굴 가림(코 안 보임)', (set, p) => { p[0].visibility = 0.1; }, ['head']);
console.log(fail ? `실패 ${fail}개` : '모두 통과');
process.exitCode = fail ? 1 : 0;
