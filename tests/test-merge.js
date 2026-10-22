const { mergeSyncState, toPushPayload } = require('C:/Users/oyohe/Desktop/피팅앱/sync.js');
let fails = 0;
const ok = (c, n) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const local = {
  body: { height: 175 }, bodyAnalysis: null, personalColor: null, draft: { category: 'top' }, updatedAt: 100,
  closet: [{ id: 'a', name: '로컬 셔츠', updatedAt: 50 }, { id: 'b', name: '로컬만 있는 바지', updatedAt: 60 }],
  tombstones: [{ id: 'c', updatedAt: 70 }],
};
const remote = {
  profile: { body: { height: 180 }, draft: { category: 'bottom' }, updatedAt: 90 },
  items: [
    { id: 'a', item: { name: '서버 셔츠' }, deleted: false, updatedAt: 80 },   // 서버가 더 최근
    { id: 'c', item: { name: '지운 옷' }, deleted: false, updatedAt: 40 },     // 로컬에서 나중에 지움
    { id: 'd', item: { name: '다른 기기에서 추가' }, deleted: false, updatedAt: 30 },
    { id: 'b', item: {}, deleted: true, updatedAt: 10 },                         // 옛 삭제 < 로컬 수정
  ],
};
const m = mergeSyncState(local, remote);
ok(m.body.height === 175 && m.updatedAt === 100, '프로필: 로컬이 더 최근이면 로컬 유지');
ok(mergeSyncState({ ...local, updatedAt: 10 }, remote).body.height === 180, '프로필: 서버가 더 최근이면 서버 것');
const names = Object.fromEntries(m.closet.map((i) => [i.id, i.name]));
ok(names.a === '서버 셔츠', '옷 a: 서버 수정이 더 최근 → 서버 것');
ok(names.b === '로컬만 있는 바지', '옷 b: 서버의 옛 삭제보다 로컬 수정이 최근 → 살아남음');
ok(!('c' in names) && m.tombstones.some((t) => t.id === 'c'), '옷 c: 로컬 삭제가 더 최근 → 삭제 유지');
ok(names.d === '다른 기기에서 추가', '옷 d: 다른 기기에서 추가한 옷 가져옴');
const pay = toPushPayload(m);
ok(pay.items.find((i) => i.id === 'c').deleted === true && pay.items.find((i) => i.id === 'b').item.name === '로컬만 있는 바지', '올릴 데이터에 삭제 표시와 옷 내용 포함');
ok(!('id' in pay.items[0].item) && !('updatedAt' in pay.items[0].item), '옷 내용(item)에는 id·updatedAt을 중복으로 넣지 않음');
ok(mergeSyncState(local, { profile: null, items: [] }).closet.length === 2, '빈 서버와 합치면 로컬 그대로');
process.exit(fails ? 1 : 0);
