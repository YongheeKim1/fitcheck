const { parseSizeChart } = require('C:/Users/oyohe/Desktop/피팅앱/parse.js');
// 에이블리 상품 "사이즈" 탭의 실측 사이즈 영역을 복사한 텍스트(실제 페이지 구조)
const top = `실측 사이즈
나한테 딱 맞는 사이즈 확인하기
사이즈
총장
어깨단면
가슴단면
소매길이
소매단면
암홀단면
밑단단면
FREE
62
-
58
68
9
21
32
총장
어깨단면`;
const r = parseSizeChart(top);
console.log('top', r.category, JSON.stringify(r.rows), r.warnings);
// 여러 사이즈 바지(같은 구조로 가정)
const pants = `사이즈
총장
허리단면
엉덩이단면
허벅지단면
밑위
밑단단면
S
100
34
-
29
30
21
M
101
36
-
30
31
22`;
const p = parseSizeChart(pants);
console.log('pants', p.category, JSON.stringify(p.rows), p.warnings);
