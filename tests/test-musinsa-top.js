const { parseSizeChart } = require('C:/Users/oyohe/Desktop/피팅앱/parse.js');
const copied = `실측 사이즈
기준표 사이즈
셔츠 사이즈 실측 안내
cm
내 사이즈
M
L
1
총장	2
어깨너비	3
가슴단면	4
소매길이	5
밑단단면	6
소매부리단면	7
암홀
사이즈를 직접 입력해주세요
72	58	61	61	-	-	-
77	60	63	62	-	-	-
* 해당 상품은 일부 실측 사이즈 정보가 제공되지 않으며, 무신사는 전체 실측 항목 입력을 권장하고 있습니다.`;
const r = parseSizeChart(copied);
console.log(r.category, JSON.stringify(r.rows), r.warnings);
