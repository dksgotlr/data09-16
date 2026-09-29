// 예시 데이터 파일 생성: node scripts/make-samples.js  (예시 도면 PDF 는 node scripts/make-sample-drawing.js)
// js/sample-data.js(가상 자료)를 samples/ 에 xlsx·csv 로 씁니다. 앱의 「예시 데이터 불러오기」와 같은 원본입니다.
const fs = require('fs');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');
const L = require('../js/logic.js');
const S = require('../js/sample-data.js');
const DS = require('../js/drawing-sample.js');
const LR = require('../js/drawing-learn.js');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });
function writeBook(file, sheet, aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  fs.writeFileSync(path.join(out, file), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
}
writeBook('예시데이터_부품매핑마스터.xlsx', '매핑마스터', S.mapAoa);
writeBook('예시데이터_ApplicationSpec.xlsx', 'ApplicationSpec', S.specAoa);
writeBook('예시데이터_통합자재마스터.xlsx', '통합자재마스터', DS.drawMapAoa); // 도면 자재 판별 예시용
writeBook('예시데이터_커넥터부자재마스터.xlsx', '커넥터부자재', DS.subAoa);      // 커넥터 → 부자재(사내 DB 흉내)
writeBook('예시데이터_고객사대조표_B.xlsx', '고객사대조표', DS.xrefAoa);          // 고객사 품번 → 제조사 품번
fs.writeFileSync(path.join(out, '예시데이터_고객사규칙.json'), JSON.stringify({ tool: 'data09-16', kind: 'customer-profiles', profiles: DS.profiles }, null, 2) + '\n');
const p = S.build();
fs.writeFileSync(path.join(out, '예시데이터_부품LIST_커넥터.csv'),
  L.toCsv([['커넥터 위치', '커넥터 품번', '극수']].concat(p.connectors.map(c => [c.pos, c.pn, c.poles]))));
fs.writeFileSync(path.join(out, '예시데이터_부품LIST_회로.csv'),
  L.toCsv([['커넥터 위치', '극 번호', '전선 규격', '전선 종류']].concat(p.circuits.map(c => [c.pos, c.pole, c.spec, c.wire]))));

// 검증: 방금 쓴 xlsx 를 앱과 같은 방식으로 다시 읽어 표준화 결과가 원본과 같은지 확인
function back(file, fields, build, src) {
  const wb = XLSX.read(fs.readFileSync(path.join(out, file)), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const hr = L.detectHeaderRow(aoa, fields), m = L.guessMapping(aoa[hr], fields);
  const a = build(aoa, hr, m).rows;
  const hr2 = L.detectHeaderRow(src, fields), b = build(src, hr2, L.guessMapping(src[hr2], fields)).rows;
  if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('왕복 불일치: ' + file); process.exit(1); }
  return a.length;
}
const n1 = back('예시데이터_부품매핑마스터.xlsx', L.MAP_FIELDS, L.buildMapTable, S.mapAoa);
const n2 = back('예시데이터_ApplicationSpec.xlsx', L.SPEC_FIELDS, L.buildSpecTable, S.specAoa);
const n3 = back('예시데이터_통합자재마스터.xlsx', L.MAP_FIELDS, L.buildMapTable, DS.drawMapAoa);
const n4 = back('예시데이터_커넥터부자재마스터.xlsx', LR.SUB_FIELDS, LR.buildSubTable, DS.subAoa);
const xb = XLSX.read(fs.readFileSync(path.join(out, '예시데이터_고객사대조표_B.xlsx')), { type: 'buffer' });
const n5 = LR.parseXref(XLSX.utils.sheet_to_json(xb.Sheets[xb.SheetNames[0]], { header: 1, raw: true, defval: '' })).length;
if (n5 !== DS.profiles[1].xref.length) { console.error('왕복 불일치: 고객사 대조표'); process.exit(1); }
console.log(`samples/ 생성·왕복 확인 완료: 매핑 ${n1}행, App Spec ${n2}행, 통합 자재 마스터 ${n3}행, 부자재 ${n4}행, 대조표 ${n5}행, 커넥터 ${p.connectors.length}, 회로 ${p.circuits.length}`);
