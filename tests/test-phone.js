const { parseSizeChart } = require('C:/Users/oyohe/Desktop/피팅앱/parse.js');
// 폰에서 들어온 데이터를 재현: 무신사 앱 사이즈표 캡처 OCR (내 사이즈 줄, 번호 붙은 사이즈, 가슴 오인식)
const ocr = `사이즈  총장  어깨너비  가숨단면  소매길이
내 사이즈  74  50  58  60
0.S  58  44  50  48
1M  60  46  52  50
2.L  62  48  54  52
3.XL  64  50  56  54`;
const r = parseSizeChart(ocr);
console.log(r.category, JSON.stringify(r.rows));
console.log(r.warnings);
// 가슴 열 이름을 아예 못 읽은 경우 → 경고가 나와야 함
const r2 = parseSizeChart(ocr.replace('가숨단면', '#$%'));
console.log('unreadable col →', r2.warnings);
