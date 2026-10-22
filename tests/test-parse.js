const { parseSizeChart } = require('C:/Users/oyohe/Desktop/피팅앱/parse.js');
const cases = {
  '무신사 탭 구분 (가로형)': `cm\t총장\t허리단면\t엉덩이단면\t허벅지단면\t밑위\t밑단단면
S\t100\t38\t50\t31\t28\t22
M\t102\t40\t52\t32\t29\t23
L\t104\t42\t54\t33\t30\t24`,
  '숫자 사이즈 + 공백 (OCR 느낌)': `사 이 즈  허 리  엉덩이  허벅지  밑위  밑단  총장
28  37  48  29.5  26  17  101
30  39.5  50  30.5  27  17.5  102
32  42  52  31.5  28  18  103`,
  '세로형': `사이즈 S M L XL
허리 단면 37 39 41 43
허벅지 30 31 32 33
밑위 27 28 29 30
밑단 20 21 22 23
총장 99 100 101 102`,
  '셀마다 줄바꿈': `사이즈\n허리\n허벅지\n밑단\n총장\nS\n38\n30\n20\n100\nM\n40\n31\n21\n101`,
  '둘레 표기 + 뒷밑위 + 파이프': `| 사이즈 | 허리둘레 | 허벅지둘레 | 앞밑위 | 뒷밑위 | 밑단둘레 | 기장 |
| M | 78 | 60 | 27 | 37 | 40 | 100 |
| L | 82 | 62 | 28 | 38 | 42 | 102 |`,
  'OCR 오인식 섞임': `SIZE 허리 허벅지 밑위 밑단 총장
S 3O 29 27 2l 98
M 4O 30 28 22 999`,
  '사이즈표 아님': `무료배송 이벤트 진행중\n오늘 출발`,
};
for (const [name, text] of Object.entries(cases)) {
  const r = parseSizeChart(text);
  console.log('### ' + name);
  console.log(JSON.stringify(r.rows));
  console.log('parts:', r.parts.join(','), '| warn:', r.warnings.join(' / '));
}
