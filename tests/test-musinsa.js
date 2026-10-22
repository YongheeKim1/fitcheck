const { parseSizeChart } = require('C:/Users/oyohe/Desktop/피팅앱/parse.js');
// 무신사 상품 페이지 "실측 사이즈" 영역을 그대로 복사했을 때의 텍스트(실제 페이지에서 확인한 구조)
const copied = `실측 사이즈
기준표 사이즈
바지 사이즈 실측 안내
cm
내 사이즈
1
2
3
4
1
총장	2
허리단면	3
엉덩이단면	4
허벅지단면	5
밑위	6
밑단단면
사이즈를 직접 입력해주세요
105.5	38.5	-	30	26	24.5
108	40	-	30.5	28	26
110	42	-	31	28.5	26.5
111	44	-	31.5	29	27`;
const r = parseSizeChart(copied);
console.log(r.category, JSON.stringify(r.rows, null, 0));
console.log(r.warnings);
