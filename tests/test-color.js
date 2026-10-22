const PC = require('C:/Users/oyohe/Desktop/피팅앱/color.js');
let ok = true;
const check = (name, got, exp, tol) => {
  const pass = Math.abs(got - exp) <= tol;
  if (!pass) ok = false;
  console.log(`${pass ? '✓' : '✗'} ${name}: ${got.toFixed(4)} (기대 ${exp})`);
};

// Sharma, Wu, Dalal (2005) CIEDE2000 테스트 데이터 일부
const pairs = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.4146],
];
for (const [a, b, e] of pairs) {
  check('ΔE2000', PC.deltaE2000({ L: a[0], a: a[1], b: a[2] }, { L: b[0], a: b[1], b: b[2] }), e, 0.0005);
}
// sRGB → Lab
const red = PC.hexToLab('#ff0000');
check('red L', red.L, 53.2408, 0.01); check('red a', red.a, 80.0925, 0.02); check('red b', red.b, 67.2032, 0.02);
const white = PC.hexToLab('#ffffff');
check('white L', white.L, 100, 0.01); check('white a', white.a, 0, 0.01);

// 피부 판정: Lab을 선형 RGB로 되돌리기 번거로우니 hex로 만든 대표 피부색 사용
const lin = (hex) => PC.hexToLinear(hex);
const cases = {
  '붉은 기 밝은 피부 + 잿빛 갈색 머리(대비 약함)': { skin: lin('#e9c3b8'), hair: lin('#6e6460') },
  '붉은 기 피부 + 검정 머리(대비 강함)': { skin: lin('#e6c0b4'), hair: lin('#1c1a1c') },
  '노란 기 밝고 맑은 피부 + 밝은 갈색 머리': { skin: lin('#f2cfa6'), hair: lin('#8a5a35') },
  '노란 기 차분한 피부 + 짙은 갈색 머리': { skin: lin('#c99a72'), hair: lin('#3b2618') },
};
for (const [name, s] of Object.entries(cases)) {
  const r = PC.analyze(s);
  console.log(`- ${name}: 색상각 ${r.skin.h.toFixed(1)}° L ${r.skin.L.toFixed(1)} C ${r.skin.C.toFixed(1)} 대비 ${r.contrast} → ${r.undertone} / ${PC.SEASONS[r.season].name}${r.second ? ' + ' + PC.SEASONS[r.second].name : ''}`);
}

// 옷 색 평가: 여름 쿨 사람 기준
const summer = PC.analyze(cases['붉은 기 밝은 피부 + 잿빛 갈색 머리(대비 약함)']);
for (const [name, hex] of [['라벤더', '#b8a9d9'], ['머스터드', '#d1a020'], ['블랙', '#000000'], ['네이비', '#25305a'], ['카키', '#8a8550'], ['연분홍', '#f0b8c8']]) {
  const e = PC.evaluate(hex, summer);
  console.log(`  여름 쿨 × ${name}: ${e.verdict} (${e.score}) 가장 가까운: ${e.nearest.name}(${PC.SEASONS[e.nearest.season].name}, ΔE ${e.nearest.dE.toFixed(1)}) | ${e.reasons.join(' ')}${e.alternatives.length ? ' | 대안: ' + e.alternatives.map((a) => a.name).join(', ') : ''}`);
}
process.exit(ok ? 0 : 1);
