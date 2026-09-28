/*
 * 예시 데이터 (가상) — 실제 고객사·제조사·사내 자재 코드가 아닙니다.
 * 도구가 문제를 빠짐없이 잡는지 보려고 일부러 넣은 경우:
 *  - CN2 커넥터 품번 「CA1002」: 하이픈이 빠진 표기 → 「표기 차이로 매칭됨」
 *  - CN4 「CA-1004」: 제조사 품번 후보 2개 → 담당자 선택
 *  - CN5 「CA-9999」: 매핑 마스터에 없음
 *  - CN2 0.85sq: 적용 가능한 터미널 2개(TM-085-A, TM-085-B)
 *  - 실 「SL-085-R」: 사내 코드가 2개(RM-S0002, RM-S0012)
 *  - CN3 2.0sq: Application Spec 적용 범위 밖
 * 열 이름도 일부러 표준 항목 이름과 조금 다르게 적어 열 매핑 화면을 거치게 했습니다.
 */
(function (root) {
  'use strict';
  var mapAoa = [
    ['[예시 데이터] 부품 매핑 마스터 — 가상 자료'],
    ['고객사 P/N', '제조사', '제조사 P/N', '사내 자재코드', '품명', '자재 구분'],
    ['CA-1001', '예시커넥터사', 'MX-2P-001', 'RM-C0001', '2P 방수 커넥터 하우징', '커넥터'],
    ['CA-1002', '예시커넥터사', 'MX-4P-010', 'RM-C0002', '4P 방수 커넥터 하우징', '커넥터'],
    ['CA-1003', '예시커넥터사', 'MX-6P-020', 'RM-C0003', '6P 커넥터 하우징(비방수)', '커넥터'],
    ['CA-1004', '예시커넥터사', 'MX-3P-030', 'RM-C0004', '3P 방수 커넥터 하우징', '커넥터'],
    ['CA-1004', '예시커넥터사', 'MX-3P-031', 'RM-C0005', '3P 방수 커넥터 하우징(대체품)', '커넥터'],
    ['', '예시커넥터사', 'TM-050-A', 'RM-T0001', '터미널 0.3~0.5sq', '터미널'],
    ['', '예시커넥터사', 'TM-085-A', 'RM-T0002', '터미널 0.75~1.25sq', '터미널'],
    ['', '예시커넥터사', 'TM-085-B', 'RM-T0003', '터미널 0.75~1.25sq(도금 사양 다름)', '터미널'],
    ['', '예시커넥터사', 'TM-200-A', 'RM-T0004', '터미널 2.0sq', '터미널'],
    ['', '예시커넥터사', 'SL-050-R', 'RM-S0001', '와이어 실 0.3~0.5sq', '실'],
    ['', '예시커넥터사', 'SL-085-R', 'RM-S0002', '와이어 실 0.75~1.25sq', '실'],
    ['', '예시커넥터사', 'SL-085-R', 'RM-S0012', '와이어 실 0.75~1.25sq(구 코드)', '실'],
    ['', '예시커넥터사', 'PL-2P-01', 'RM-P0001', '방수전 2P용', '방수전'],
    ['', '예시커넥터사', 'PL-4P-01', 'RM-P0002', '방수전 4P용', '방수전']
  ];
  var specAoa = [
    ['[예시 데이터] Application Spec — 가상 자료'],
    ['Connector P/N', '적용 전선 하한(sq)', '적용 전선 상한(sq)', 'Terminal P/N', 'Wire Seal P/N', '방수전 P/N'],
    ['MX-2P-001', 0.3, 0.5, 'TM-050-A', 'SL-050-R', 'PL-2P-01'],
    ['MX-2P-001', 0.75, 1.25, 'TM-085-A', 'SL-085-R', 'PL-2P-01'],
    ['MX-4P-010', 0.3, 0.5, 'TM-050-A', 'SL-050-R', 'PL-4P-01'],
    ['MX-4P-010', 0.75, 1.25, 'TM-085-A, TM-085-B', 'SL-085-R', 'PL-4P-01'],
    ['MX-6P-020', 0.3, 0.5, 'TM-050-A', '', ''],
    ['MX-6P-020', 0.75, 1.25, 'TM-085-A', '', ''],
    ['MX-3P-030', 0.3, 1.25, 'TM-085-A', 'SL-085-R', '']
  ];
  var header = { drawingNo: 'EX-HN-0001', drawingName: '예시 도면 — 가상 하네스', rev: 'A', customer: '', bomType: '신규' };
  var connectors = [
    { pos: 'CN1', pn: 'CA-1001', poles: '2' },
    { pos: 'CN2', pn: 'CA1002', poles: '4' },
    { pos: 'CN3', pn: 'CA-1003', poles: '6' },
    { pos: 'CN4', pn: 'CA-1004', poles: '3' },
    { pos: 'CN5', pn: 'CA-9999', poles: '2' }
  ];
  var circuits = [
    { pos: 'CN1', pole: '1', spec: '0.5', wire: '' },
    { pos: 'CN1', pole: '2', spec: '0.85', wire: '' },
    { pos: 'CN2', pole: '1', spec: '0.5', wire: '' },
    { pos: 'CN2', pole: '2', spec: '0.85', wire: '' },
    { pos: 'CN2', pole: '3', spec: '0.85', wire: '' },
    { pos: 'CN3', pole: '1', spec: '0.5', wire: '' },
    { pos: 'CN3', pole: '2', spec: '0.5', wire: '' },
    { pos: 'CN3', pole: '3', spec: '2.0', wire: '' },
    { pos: 'CN4', pole: '1', spec: '0.5', wire: '' },
    { pos: 'CN5', pole: '1', spec: '0.5', wire: '' }
  ];
  var api = {
    mapAoa: mapAoa, specAoa: specAoa,
    build: function () {
      return {
        header: JSON.parse(JSON.stringify(header)),
        connectors: JSON.parse(JSON.stringify(connectors)),
        circuits: JSON.parse(JSON.stringify(circuits))
      };
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BomSample = api;
})(typeof window !== 'undefined' ? window : this);
