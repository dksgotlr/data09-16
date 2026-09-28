// 실행: node test/logic.test.mjs   (의존성 없음)
// 기대값은 js/sample-data.js 의 예시 데이터를 손으로 따라가며 계산한 값입니다.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const S = require('../js/sample-data.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

function masters() {
  const hm = L.detectHeaderRow(S.mapAoa, L.MAP_FIELDS);
  const hs = L.detectHeaderRow(S.specAoa, L.SPEC_FIELDS);
  const mm = L.guessMapping(S.mapAoa[hm], L.MAP_FIELDS);
  const ms = L.guessMapping(S.specAoa[hs], L.SPEC_FIELDS);
  return { hm, hs, mm, ms, map: L.buildMapTable(S.mapAoa, hm, mm), spec: L.buildSpecTable(S.specAoa, hs, ms) };
}
function run(choices, settings) {
  const m = masters();
  const p = S.build();
  const r = L.compute({ mapRows: m.map.rows, specRows: m.spec.rows, header: p.header, connectors: p.connectors, circuits: p.circuits, settings: settings || {}, choices: choices || {} });
  return { r, bom: L.aggregateBom(r.lines, settings || {}) };
}
const qtyOf = (bom, code) => bom.filter(b => b.code === code).reduce((a, b) => a + b.qty, 0);

console.log('품번 정규화·규격 읽기');
test('공백·하이픈·대소문자 정리', () => assert.equal(L.normalizePn(' ca-10 02 '), 'CA1002'));
test('점·밑줄은 기본값에서 그대로', () => assert.equal(L.normalizePn('A.1_2'), 'A.1_2'));
test('점·밑줄 설정을 켜면 제거', () => assert.equal(L.normalizePn('A.1_2', { space: true, hyphen: true, upper: true, dot: true }), 'A12'));
test('한 칸 여러 품번 나누기(쉼표·세미콜론·줄바꿈, 중복 제거)', () => assert.deepEqual(L.splitMulti('TM-1, TM-2;TM-1\nTM-3'), ['TM-1', 'TM-2', 'TM-3']));
test('규격 읽기: 0.5sq·0,85·1.25mm2·숫자', () => {
  assert.equal(L.parseSpec('0.5sq'), 0.5);
  assert.equal(L.parseSpec('0,85'), 0.85);
  assert.equal(L.parseSpec('1.25 mm2'), 1.25);
  assert.equal(L.parseSpec(2), 2);
});
test('AWG·빈칸·문자는 읽지 않음', () => {
  assert.equal(L.parseSpec('20AWG'), null);
  assert.equal(L.parseSpec(''), null);
  assert.equal(L.parseSpec('굵음'), null);
});
test('범위 한 칸: 0.3~0.5 / 0.75-1.25sq / 단일값', () => {
  assert.deepEqual(L.parseRange('0.3~0.5'), { min: 0.3, max: 0.5 });
  assert.deepEqual(L.parseRange('0.75-1.25sq'), { min: 0.75, max: 1.25 });
  assert.deepEqual(L.parseRange('2.0'), { min: 2, max: 2 });
});

console.log('열 매핑');
test('제목 행을 건너뛰고 머리행(2행)을 찾음', () => { const m = masters(); assert.equal(m.hm, 1); assert.equal(m.hs, 1); });
test('매핑 마스터 열 짐작', () => assert.deepEqual(masters().mm, { cust: 0, mfr: 2, code: 3, name: 4, kind: 5 }));
test('Application Spec 열 짐작 — 하한·상한을 범위 칸으로 오인하지 않음', () =>
  assert.deepEqual(masters().ms, { conn: 0, min: 1, max: 2, term: 3, seal: 4, plug: 5 }));
test('저장한 매핑(열 이름)이 짐작보다 우선', () => {
  const g = L.guessMapping(['품명', '코드A', '코드B'], L.MAP_FIELDS, { code: '코드B', mfr: '코드A' });
  assert.equal(g.code, 2); assert.equal(g.mfr, 1); assert.equal(g.name, 0);
});
test('필수 항목 빠지면 이름으로 알려 줌', () => assert.deepEqual(L.checkMapping({ mfr: 0 }, L.MAP_FIELDS), ['사내 자재 코드']));
test('표준화 행 수: 매핑 14행, App Spec 7행(엑셀 행 번호 유지)', () => {
  const m = masters();
  assert.equal(m.map.rows.length, 14); assert.equal(m.map.rows[0].row, 3);
  assert.equal(m.spec.rows.length, 7); assert.deepEqual(m.spec.rows[3].term, ['TM-085-A', 'TM-085-B']);
});
test('범위를 숫자로 못 읽는 App Spec 행은 건너뛰고 행 번호 보고', () => {
  const t = L.buildSpecTable([['커넥터 품번', '하한', '상한', '터미널 품번'], ['C1', '가', 1, 'T1'], ['C1', 0.5, 1, 'T1']], 0, { conn: 0, min: 1, max: 2, term: 3 });
  assert.equal(t.rows.length, 1); assert.deepEqual(t.badRange, [2]);
});

console.log('품번 교차 검증');
const mapRows = () => masters().map.rows;
test('정확히 일치 → exact, 사내 코드', () => {
  const r = L.lookupPart('CA-1001', mapRows());
  assert.equal(r.status, 'exact'); assert.equal(r.by, 'cust'); assert.equal(r.candidates[0].code, 'RM-C0001'); assert.equal(r.issue, null);
});
test('하이픈 빠진 CA1002 → 표기 차이로 매칭(normalized)', () => {
  const r = L.lookupPart('CA1002', mapRows());
  assert.equal(r.status, 'normalized'); assert.equal(r.candidates[0].code, 'RM-C0002');
});
test('제조사 품번으로 적힌 도면도 찾음(고객사 열 → 제조사 열 순서)', () => {
  const r = L.lookupPart('MX-6P-020', mapRows());
  assert.equal(r.by, 'mfr'); assert.equal(r.candidates[0].code, 'RM-C0003');
});
test('CA-1004 → 제조사 후보 2개(map_multi)', () => {
  const r = L.lookupPart('CA-1004', mapRows());
  assert.equal(r.issue, 'map_multi'); assert.deepEqual(r.candidates.map(c => c.code), ['RM-C0004', 'RM-C0005']);
});
test('SL-085-R → 사내 코드 2개(map_dup_code)', () => assert.equal(L.lookupPart('SL-085-R', mapRows(), { order: ['mfr'] }).issue, 'map_dup_code'));
test('없는 품번 → map_none', () => assert.equal(L.lookupPart('CA-9999', mapRows()).issue, 'map_none'));
test('고객사 열을 매핑하면 다른 고객사 행은 후보에서 뺌', () => {
  const rows = [{ row: 2, cust: 'P1', mfr: 'M1', code: 'C1', customer: '갑' }, { row: 3, cust: 'P1', mfr: 'M2', code: 'C2', customer: '을' }];
  assert.equal(L.lookupPart('P1', rows).issue, 'map_multi');
  const r = L.lookupPart('P1', rows, { customer: '을' });
  assert.equal(r.issue, null); assert.equal(r.candidates[0].code, 'C2');
});

console.log('Application Spec 조회');
const specRows = () => masters().spec.rows;
test('MX-2P-001 0.85sq → TM-085-A + SL-085-R (App Spec 4행 — 1행 제목, 2행 머리)', () => {
  const r = L.specLookup(['MX-2P-001'], 0.85, '', specRows());
  assert.equal(r.issue, null); assert.equal(r.terminals[0].pn, 'TM-085-A'); assert.equal(r.seals[0].pn, 'SL-085-R'); assert.deepEqual(r.terminals[0].rows, [4]);
});
test('MX-4P-010 0.85sq → 터미널 후보 2개', () => assert.equal(L.specLookup(['MX-4P-010'], 0.85, '', specRows()).issue, 'spec_multi_term'));
test('MX-6P-020 2.0sq → 범위 밖', () => assert.equal(L.specLookup(['MX-6P-020'], 2.0, '', specRows()).issue, 'spec_out_of_range'));
test('MX-6P-020 0.6sq(두 범위 사이) → 범위 밖', () => assert.equal(L.specLookup(['MX-6P-020'], 0.6, '', specRows()).issue, 'spec_out_of_range'));
test('없는 커넥터 → spec_no_conn', () => assert.equal(L.specLookup(['MX-3P-031'], 0.5, '', specRows()).issue, 'spec_no_conn'));
test('경계값 0.5: 기본은 포함, 「경계값 확인」 설정이면 확인 대상', () => {
  assert.equal(L.specLookup(['MX-2P-001'], 0.5, '', specRows()).issue, null);
  assert.equal(L.specLookup(['MX-2P-001'], 0.5, '', specRows(), { boundary: 'review' }).issue, 'spec_boundary');
});
test('비방수 커넥터는 실 없음(빈 칸)으로 산출', () => assert.equal(L.specLookup(['MX-6P-020'], 0.5, '', specRows()).seals[0].pn, ''));

console.log('전체 산출 — 예시 도면, 선택 전');
test('확인 대상 5건: 실 사내코드 중복·CN2 터미널 2개·CN3 범위 밖·CN4 후보 2개·CN5 없음', () => {
  const { r } = run();
  assert.equal(r.open, 5);
  assert.deepEqual(r.issues.map(i => i.code).sort(), ['map_dup_code', 'map_multi', 'map_none', 'spec_multi_term', 'spec_out_of_range']);
});
test('터미널 RM-T0001 = CN1 1 + CN2 1 + CN3 2 = 4', () => assert.equal(qtyOf(run().bom, 'RM-T0001'), 4));
test('실 RM-S0001 = CN1 1 + CN2 1 = 2, CN3(비방수)는 실 없음', () => assert.equal(qtyOf(run().bom, 'RM-S0001'), 2));
test('CN2 는 「표기 차이 매칭」으로 BOM 에 들어감', () => assert.equal(run().bom.find(b => b.code === 'RM-C0002').check, '표기 차이 매칭'));
test('미확정 행도 BOM 에서 빠지지 않고 「확인 필요」로 남음(커넥터 2 + 터미널 2 + 실 1)', () =>
  assert.equal(run().bom.filter(b => b.check === '확인 필요').length, 5));
test('커넥터가 미확정이면 그 회로는 산출 보류(CN4·CN5 각 1회로)', () =>
  assert.equal(run().r.circuits.filter(c => c.state === 'pending').length, 2));

console.log('전체 산출 — 담당자 선택 후');
const CHOICES = {
  'map|커넥터|CA1004': { pick: 'MX-3P-030|RM-C0004' },
  'map|커넥터|CA9999': { manual: { code: 'RM-C9999', name: '직접 입력 커넥터' } },
  'spec|CN2|0.85|': { pick: 'TM-085-B|SL-085-R' },
  'spec|CN3|2|': { manual: { term: 'TM-200-A', seal: '' } },
  'map|실|SL085R': { pick: 'SL-085-R|RM-S0002' },
  'spec|CN5|0.5|': { manual: { term: 'TM-050-A', seal: '' } }
};
test('모두 처리하면 미해결 0건', () => assert.equal(run(CHOICES).r.open, 0));
test('CN5 는 직접 입력 코드라 App Spec 에 없어 새 확인 대상이 생기고, 직접 입력으로 처리', () => {
  const partial = { ...CHOICES }; delete partial['spec|CN5|0.5|'];
  const { r } = run(partial);
  assert.equal(r.open, 1); assert.equal(r.issues.find(i => !i.resolved).code, 'spec_no_conn');
});
test('터미널: T0001 5(=4+CN5 1), T0002 2(CN1·CN4), T0003 2(CN2), T0004 1(CN3)', () => {
  const { bom } = run(CHOICES);
  assert.deepEqual(['RM-T0001', 'RM-T0002', 'RM-T0003', 'RM-T0004'].map(c => qtyOf(bom, c)), [5, 2, 2, 1]);
});
test('실: S0001 2, S0002 4(CN1 1 + CN2 2 + CN4 1), 구 코드 S0012 0', () => {
  const { bom } = run(CHOICES);
  assert.deepEqual(['RM-S0001', 'RM-S0002', 'RM-S0012'].map(c => qtyOf(bom, c)), [2, 4, 0]);
});
test('커넥터 5종 각 1개, 직접 입력 표시', () => {
  const { bom } = run(CHOICES);
  const cons = bom.filter(b => b.kind === '커넥터');
  assert.equal(cons.length, 5); assert.ok(cons.every(b => b.qty === 1));
  assert.equal(cons.find(b => b.code === 'RM-C9999').check, '직접 입력');
});
test('BOM 순서: 커넥터 → 터미널 → 실', () => {
  const kinds = run(CHOICES).bom.map(b => b.kind);
  assert.deepEqual([...new Set(kinds)], ['커넥터', '터미널', '실']);
});
test('여유율 10% → 종속 자재만 올림(T0001 5→6, T0004 1→2), 커넥터는 그대로', () => {
  const { bom } = run(CHOICES, { margin: 10 });
  assert.equal(qtyOf(bom, 'RM-T0001'), 6); assert.equal(qtyOf(bom, 'RM-T0004'), 2); assert.equal(qtyOf(bom, 'RM-C0001'), 1);
});
test('방수전 켜면 빈 극 수만큼: CN2 4극 중 3극 사용 → PL-4P-01(RM-P0002) 1, CN1 빈 극 없음, 비방수 CN3 없음', () => {
  const { bom } = run(CHOICES, { plug: true });
  assert.equal(qtyOf(bom, 'RM-P0002'), 1); assert.equal(qtyOf(bom, 'RM-P0001'), 0);
  assert.equal(bom.filter(b => b.kind === '방수전').length, 1);
});
test('방수전 기본값은 꺼짐', () => assert.equal(run(CHOICES).bom.filter(b => b.kind === '방수전').length, 0));

console.log('입력 점검');
test('극수보다 많은 회로·같은 극 번호 중복·없는 위치 회로를 잡음', () => {
  const m = masters();
  const r = L.compute({
    mapRows: m.map.rows, specRows: m.spec.rows,
    connectors: [{ pos: 'X1', pn: 'CA-1001', poles: '2' }],
    circuits: [{ pos: 'X1', pole: '1', spec: '0.5' }, { pos: 'X1', pole: '1', spec: '0.5' }, { pos: 'X1', pole: '2', spec: '0.5' }, { pos: 'X1', pole: '3', spec: '0.5' }, { pos: 'Y9', pole: '1', spec: '0.5' }]
  });
  assert.deepEqual(r.issues.map(i => i.code).sort(), ['circuit_no_conn', 'pole_dup', 'pole_over']);
});
test('규격 칸을 못 읽으면 spec_bad', () => {
  const m = masters();
  const r = L.compute({ mapRows: m.map.rows, specRows: m.spec.rows, connectors: [{ pos: 'A', pn: 'CA-1001', poles: '2' }], circuits: [{ pos: 'A', pole: '1', spec: '20AWG' }] });
  assert.equal(r.issues[0].code, 'spec_bad');
});

console.log('붙여넣기·내보내기');
test('엑셀 복사(탭 구분) 붙여넣기, 머리행 건너뜀', () => {
  const rows = L.parsePaste('위치\t커넥터 품번\t극수\nCN1\tCA-1001\t2\n\nCN2\tCA1002\t4\n', ['pos', 'pn', 'poles'], ['커넥터품번', '극수']);
  assert.deepEqual(rows, [{ pos: 'CN1', pn: 'CA-1001', poles: '2' }, { pos: 'CN2', pn: 'CA1002', poles: '4' }]);
});
test('BOM 시트: 머리 정보 + 표, 확인 대상·회로별 근거 시트', () => {
  const { r, bom } = run(CHOICES);
  const sh = L.bomSheets(r, bom, S.build().header);
  assert.deepEqual(Object.keys(sh), ['BOM', '확인 대상', '회로별 산출 근거']);
  assert.equal(sh['BOM'][1][1], 'EX-HN-0001');
  assert.equal(sh['BOM'][8][0], '번호');
  assert.equal(sh['BOM'].length, 9 + bom.length);
  assert.equal(sh['회로별 산출 근거'].length, 11);
});
test('CSV: 쉼표·따옴표 감싸기, BOM 문자 시작', () => {
  const c = L.toCsv([['a,b', 'x"y'], [1, '']]);
  assert.equal(c, '\ufeff"a,b","x""y"\r\n1,');
});

console.log(`\n${passed}개 통과` + (process.exitCode ? ' — 실패 있음' : ''));
