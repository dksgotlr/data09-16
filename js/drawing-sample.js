/*
 * 도면 자재 판별 예시 데이터 (가상) — 실제 고객사·제조사·사내 자재 코드·도면이 아닙니다.
 * 통합 자재 마스터(부품 분류 · 사내 자재 코드 · 제조사 품번 · 고객사 · 고객사 품번)와
 * 예시 도면(A4 가로 1쪽, samples/예시도면_하네스_가상.pdf)의 그림 요소 목록입니다.
 * 예시 도면 PDF 는 scripts/make-sample-drawing.js 가 이 목록으로 만듭니다(글자가 선택되는 벡터 PDF).
 * 2026-09-29 저녁: 부품표형 도면(예시고객사B)·고객사 규칙 2개·고객사 대조표·커넥터 부자재 마스터를 덧붙였습니다(파일 아래쪽).
 *
 * 예시 도면(고객사 「예시고객사A」)에 일부러 넣은 경우:
 *  - CA-1001 두 곳, CA-1003, CL-2001 두 곳: 고객사 품번 그대로 일치 → 기존
 *  - CA1002: 하이픈 빠진 표기 → 기존(표기 차이)
 *  - CA-1003: PDF 안에서 「CA-」 「1003」 두 조각으로 나뉘어 있음 → 이어 붙여 한 품번으로 읽는지
 *  - MX-8P-040: 도면에 제조사 품번이 바로 적힘 → 기존(제조사 품번으로 일치)
 *  - CA-1004: 제조사 품번 후보 2개 → 매핑 필요
 *  - CL-2O02: 숫자 0 자리에 영문 O → 매핑 필요(비슷한 품번 CL-2002)
 *  - GR-3001: 예시고객사B 품번으로만 등록 → 매핑 필요(이 고객사 매핑 추가)
 *  - PT-5001: 마스터에 있으나 사내 코드 빈칸 → 매핑 필요
 *  - CA-1099 · CL-7788 · TP-0019: 마스터에 없음 → 신규(자재 종류는 앞머리로 추정)
 *  - HN-24-0001: 표제란의 도면 번호 — 품번처럼 생겨 후보로 잡힘 → 「제외」로 빼는 연습용
 *  - 0.5SQ · 0.85SQ(전선 규격), 250 · 400(치수), CN1~CN7(위치 기호)은 후보에서 걸러짐
 */
(function (root) {
  'use strict';
  var A = '예시고객사A', Bc = '예시고객사B';
  var drawMapAoa = [
    ['[예시 데이터] 통합 자재 마스터 — 가상 자료'],
    ['부품 분류', '사내 자재코드', '제조사', '제조사 P/N', '고객사명', '고객사 P/N', '품명'],
    ['커넥터', 'RM-C0001', '예시커넥터사', 'MX-2P-001', A, 'CA-1001', '2P 방수 커넥터 하우징'],
    ['커넥터', 'RM-C0002', '예시커넥터사', 'MX-4P-010', A, 'CA-1002', '4P 방수 커넥터 하우징'],
    ['커넥터', 'RM-C0003', '예시커넥터사', 'MX-6P-020', A, 'CA-1003', '6P 커넥터 하우징(비방수)'],
    ['커넥터', 'RM-C0004', '예시커넥터사', 'MX-3P-030', A, 'CA-1004', '3P 방수 커넥터 하우징'],
    ['커넥터', 'RM-C0005', '예시커넥터사', 'MX-3P-031', A, 'CA-1004', '3P 방수 커넥터 하우징(대체품)'],
    ['커넥터', 'RM-C0006', '예시커넥터사', 'MX-8P-040', Bc, 'CB-2208', '8P 커넥터 하우징'],
    ['클립', 'RM-K0001', '예시클립사', 'KP-100-B', A, 'CL-2001', '배선 고정 클립'],
    ['클립', 'RM-K0002', '예시클립사', 'KP-120-B', A, 'CL-2002', '배선 고정 클립(대)'],
    ['그로멧', 'RM-G0001', '예시고무사', 'GM-30-01', Bc, 'GR-3001', '관통 그로멧'],
    ['프로텍터', '', '예시튜브사', 'PR-50-01', A, 'PT-5001', '코루게이트 튜브 10파이'],
    ['테이프', 'RM-A0001', '예시테이프사', 'VT-19-BK', A, 'TP-0100', '비닐 테이프 19mm 흑색']
  ];
  var customer = A;
  var drawingNo = 'HN-24-0001';

  // 예시 도면 그림 요소 — 좌표는 쪽 왼쪽 위 (0,0), 단위 pt, 쪽 크기 842 × 595(A4 가로)
  // t: 글자(x, y=글자 바탕선, s=크기), line: 선, rect: 사각형
  var page = { w: 842, h: 595 };
  var shapes = [];
  function T(x, y, text, size) { shapes.push({ t: 'text', x: x, y: y, s: size || 9, text: text }); }
  function Ln(x1, y1, x2, y2, wd) { shapes.push({ t: 'line', x1: x1, y1: y1, x2: x2, y2: y2, wd: wd || 1 }); }
  function R(x, y, w, h, wd) { shapes.push({ t: 'rect', x: x, y: y, w: w, h: h, wd: wd || 1 }); }
  // 테두리·표제란
  R(15, 15, 812, 565, 1.2);
  R(560, 470, 267, 110, 1);
  Ln(560, 492, 827, 492); Ln(560, 514, 827, 514); Ln(560, 536, 827, 536); Ln(560, 558, 827, 558);
  T(566, 486, 'TITLE: SAMPLE HARNESS ASSY (FICTITIOUS DATA)', 8);
  T(566, 508, 'DWG NO. HN-24-0001', 9);
  T(566, 530, 'CUSTOMER: SAMPLE-A', 8);
  T(566, 552, 'REV A   SCALE NTS   SHEET 1/1', 8);
  T(566, 574, 'ALL PART NUMBERS ARE FICTITIOUS', 7);
  T(30, 40, 'WIRING HARNESS - SAMPLE DRAWING FOR PART MAPPING', 11);
  // 간선·분기
  Ln(120, 260, 700, 260, 3);
  Ln(200, 260, 200, 150, 2); Ln(290, 260, 290, 370, 2); Ln(380, 260, 380, 370, 2);
  Ln(520, 260, 520, 150, 2); Ln(640, 260, 640, 370, 2);
  // 커넥터(사각형) + 위치 기호 + 품번
  function conn(x, y, pos, pnParts, lx, ly) {
    R(x, y, 44, 30, 1.2);
    T(x + 12, y + 19, pos, 8);
    var cx = lx;
    pnParts.forEach(function (p) { T(cx, ly, p, 9); cx += p.length * 5.2; });
  }
  conn(76, 245, 'CN1', ['CA-1001'], 70, 294);
  conn(178, 120, 'CN2', ['CA1002'], 176, 112);
  // CN3: 「CA-」 와 「1003」 을 따로 찍어 PDF 안에서 두 조각이 되게 함(Helvetica 9pt 에서 「CA-」 폭 15.5pt)
  shapes.push({ t: 'rect', x: 268, y: 370, w: 44, h: 30, wd: 1.2 }); T(280, 389, 'CN3', 8);
  T(266, 414, 'CA-', 9); T(266 + 15.5, 414, '1003', 9);
  conn(358, 370, 'CN4', ['CA-1004'], 356, 414);
  conn(498, 120, 'CN5', ['CA-1099'], 496, 112);
  conn(618, 370, 'CN6', ['MX-8P-040'], 610, 414);
  conn(700, 245, 'CN7', ['CA-1001'], 698, 294);
  // 클립(작은 사각형) + 품번
  function clip(x, pn) { R(x - 4, 256, 8, 8, 1); T(x - 16, 250, pn, 7.5); }
  clip(160, 'CL-2001'); clip(330, 'CL-2001'); clip(455, 'CL-2O02'); clip(590, 'CL-7788');
  // 그로멧·프로텍터·테이프
  R(420, 266, 14, 10, 1); T(402, 290, 'GR-3001', 8);
  Ln(230, 270, 280, 270, 1); T(226, 284, 'PT-5001 (L=250)', 7.5);
  T(536, 200, 'TP-0019', 8); Ln(528, 198, 521, 200, 0.6);
  // 전선 규격·치수(후보에서 걸러져야 하는 것)
  T(206, 200, '0.5SQ', 7); T(386, 320, '0.85SQ AVSS', 7); T(646, 320, '0.5SQ', 7);
  T(150, 276, '250', 7); T(420, 246, '400', 7);
  T(30, 470, 'NOTE 1. DIMENSIONS IN MM', 7);
  T(30, 482, 'NOTE 2. ALL CLIPS PER CUSTOMER STANDARD', 7);

  // 스캔 이미지 예시에서 배치 대기열에 넣을 품번(사람이나 AI 가 읽어 낸 목록이라고 가정)
  var scanList = ['CA-1001', 'CA1002', 'CA-1003', 'CA-1004', 'CA-1099', 'MX-8P-040', 'CA-1001', 'CL-2001', 'CL-2001', 'CL-2O02', 'CL-7788', 'GR-3001', 'PT-5001', 'TP-0019'];

  // ── 2026-09-29 저녁: 표형 도면(예시고객사B)·고객사 규칙·부자재 마스터 (모두 가상) ──────────
  // 예시고객사B 는 품번을 도면 그림 위가 아니라 오른쪽 위 「부품표」에 모아 적는 고객사라고 가정합니다.
  // 부품표 열: ITEM | CUSTOMER P/N | MAKER P/N | DESCRIPTION | Q'TY — 제조사 품번 칸이 빈 행(-)은 고객사 품번만 적힌 경우
  //  1 CB-2208 + MX-8P-040 : 제조사 품번이 적힘 → 기존(초록)
  //  2 CB-2210            : 고객사 대조표(규칙 B)로 MX-2P-001 → 고객사 품번(노랑, 매핑됨)
  //  3 GR-3001            : 마스터의 예시고객사B 고객사 품번 → 고객사 품번(노랑, 매핑됨)
  //  4 CB-2299            : 고객사 품번 열인데 마스터·대조표에 없음 → 고객사 품번(노랑, 매핑 없음)
  //  5 KP-100-B           : 제조사 품번만 → 기존(초록)
  //  6 MX-9P-900          : 제조사 품번이 마스터에 없음 → 신규(빨강)
  //  7 CB-3301            : 대조표로 VT-19-BK → 고객사 품번(노랑, 매핑됨)
  //  8 CB-4410            : 대조표로 PR-99-01 을 찾았으나 사내 마스터에 없음 → 신규(빨강)
  var customerB = Bc, drawingNoB = 'HN-25-0107';
  var shapesB = [];
  function TB(x, y, text, size) { shapesB.push({ t: 'text', x: x, y: y, s: size || 8, text: text }); }
  function LB(x1, y1, x2, y2, wd) { shapesB.push({ t: 'line', x1: x1, y1: y1, x2: x2, y2: y2, wd: wd || 1 }); }
  function RB(x, y, w, h, wd) { shapesB.push({ t: 'rect', x: x, y: y, w: w, h: h, wd: wd || 1 }); }
  RB(15, 15, 812, 565, 1.2);
  RB(560, 470, 267, 110, 1);
  LB(560, 492, 827, 492); LB(560, 514, 827, 514); LB(560, 536, 827, 536); LB(560, 558, 827, 558);
  TB(566, 486, 'TITLE: SAMPLE HARNESS B (FICTITIOUS DATA)', 8);
  TB(566, 508, 'DWG NO. ' + drawingNoB, 9);
  TB(566, 530, 'CUSTOMER: SAMPLE-B', 8);
  TB(566, 552, 'REV 0   SCALE NTS   SHEET 1/1', 8);
  TB(566, 574, 'ALL PART NUMBERS ARE FICTITIOUS', 7);
  TB(30, 40, 'WIRING HARNESS - TABLE STYLE SAMPLE (PARTS LIST ON SHEET)', 11);
  // 부품표 — 열 왼쪽 x, 머리행 바탕선 y=78, 행 간격 16
  var TX = [440, 474, 552, 632, 760], TW = 377, TOP = 64, RH = 16;
  var tableRows = [
    ['ITEM', 'CUSTOMER P/N', 'MAKER P/N', 'DESCRIPTION', "Q'TY"],
    ['1', 'CB-2208', 'MX-8P-040', '8P CONNECTOR', '1'],
    ['2', 'CB-2210', '-', '2P CONNECTOR', '2'],
    ['3', 'GR-3001', '-', 'GROMMET', '1'],
    ['4', 'CB-2299', '-', '4P CONNECTOR', '1'],
    ['5', '-', 'KP-100-B', 'CLIP', '4'],
    ['6', '-', 'MX-9P-900', '9P CONNECTOR', '1'],
    ['7', 'CB-3301', '-', 'VINYL TAPE', '2'],
    ['8', 'CB-4410', '-', 'CORRUGATE TUBE', '1']
  ];
  TB(TX[0], TOP - 6, 'PARTS LIST', 9);
  RB(TX[0] - 6, TOP, TW, RH * tableRows.length, 1);
  tableRows.forEach(function (row, i) {
    if (i) LB(TX[0] - 6, TOP + RH * i, TX[0] - 6 + TW, TOP + RH * i, i === 1 ? 1 : 0.5);
    row.forEach(function (cell, j) { TB(TX[j], TOP + RH * i + 11, cell, 7.5); });
  });
  TX.slice(1).forEach(function (x) { LB(x - 5, TOP, x - 5, TOP + RH * tableRows.length, 0.5); });
  // 그림 — 간선·커넥터와 풍선 번호(부품표 ITEM 번호). 그림 위에는 품번을 적지 않음
  LB(90, 330, 520, 330, 3);
  LB(180, 330, 180, 280, 2); LB(300, 330, 300, 420, 2); LB(420, 330, 420, 280, 2);
  function connB(x, y, pos, item) { RB(x, y, 44, 30, 1.2); TB(x + 12, y + 19, pos, 8); balloon(x + 52, y - 6, item); }
  function balloon(cx, cy, n) {
    // 원 대신 작은 사각형 + 번호(예시라 단순하게)
    RB(cx - 7, cy - 7, 14, 14, 0.8); TB(cx - 2.5, cy + 3, String(n), 7);
  }
  connB(46, 315, 'CN1', 1); connB(158, 250, 'CN2', 2); connB(278, 420, 'CN3', 2); connB(398, 250, 'CN4', 4); connB(520, 315, 'CN5', 6);
  balloon(240, 316, 5); balloon(360, 316, 5); balloon(300, 350, 3); balloon(470, 346, 7); balloon(120, 346, 8);
  TB(200, 300, '0.5SQ', 7); TB(430, 300, '0.85SQ', 7);
  TB(30, 470, 'NOTE 1. PART NUMBERS ARE LISTED IN THE PARTS LIST ONLY', 7);

  // 고객사별 학습 규칙(가상) — 담당자가 도면 글자를 눌러 알려 준 결과라고 가정
  var profiles = [
    {
      id: 'sample-a', name: A, keywords: ['CUSTOMER: SAMPLE-A'], layout: 'label',
      examples: { mfr: ['MX-8P-040'], cust: ['CA-1001', 'CL-2001'] },
      patterns: [{ re: '^[A-Z]{2}-[0-9][A-Z]-[0-9]{3}$', type: 'mfr', auto: true }, { re: '^[A-Z]{2}-[0-9]{4}$', type: 'cust', auto: true }],
      strict: true, xref: [], table: { roles: {} }, exclude: '', at: ''
    },
    {
      id: 'sample-b', name: Bc, keywords: ['CUSTOMER: SAMPLE-B'], layout: 'table',
      examples: { mfr: ['MX-8P-040', 'KP-100-B'], cust: ['CB-2208'] },
      patterns: [{ re: '^[A-Z]{2}-[0-9][A-Z]-[0-9]{3}$', type: 'mfr', auto: true }, { re: '^[A-Z]{2}-[0-9]{3}-[A-Z]$', type: 'mfr', auto: true }, { re: '^[A-Z]{2}-[0-9]{4}$', type: 'cust', auto: true }],
      strict: false,
      xref: [
        { cust: 'CB-2210', mfr: 'MX-2P-001', code: '', name: '' },
        { cust: 'CB-3301', mfr: 'VT-19-BK', code: '', name: '' },
        { cust: 'CB-4410', mfr: 'PR-99-01', code: '', name: '코루게이트 튜브 13파이' }
      ],
      table: { roles: { 'ITEM': 'item', 'CUSTOMERP/N': 'cust', 'MAKERP/N': 'mfr', 'DESCRIPTION': 'desc', "Q'TY": 'qty' } },
      exclude: '', at: ''
    }
  ];
  // 고객사 대조표 파일 예시(규칙 B 의 대조표를 엑셀로 받는 경우)
  var xrefAoa = [['고객사 품번', '제조사 품번', '사내 자재 코드', '품명']].concat(profiles[1].xref.map(function (x) { return [x.cust, x.mfr, x.code, x.name]; }));
  // 커넥터 → 부자재 마스터(사내 DB 에서 커넥터를 검색하면 함께 나오는 부자재를 흉내 냄)
  var subAoa = [
    ['[예시 데이터] 커넥터별 부자재 — 가상 자료'],
    ['커넥터 품번', '부자재 구분', '부자재 품번', '부자재 사내코드', '커넥터 1개당 수량', '품명'],
    ['MX-2P-001', '터미널', 'TM-050-A', 'RM-T0001', 2, '0.5sq 암 터미널'],
    ['MX-2P-001', '와이어 실', 'SL-050-R', 'RM-S0001', 2, '0.5sq 와이어 실'],
    ['MX-2P-001', '리테이너', 'RT-2P-01', 'RM-R0001', 1, '2P 리테이너'],
    ['MX-4P-010', '터미널', 'TM-050-A', 'RM-T0001', 4, '0.5sq 암 터미널'],
    ['MX-4P-010', '와이어 실', 'SL-050-R', 'RM-S0001', 4, '0.5sq 와이어 실'],
    ['MX-6P-020', '터미널', 'TM-085-B', 'RM-T0003', 6, '0.85sq 암 터미널'],
    ['MX-8P-040', '터미널', 'TM-050-A', 'RM-T0001', 8, '0.5sq 암 터미널'],
    ['MX-8P-040', '와이어 실', 'SL-050-R', 'RM-S0001', 8, '0.5sq 와이어 실'],
    ['MX-8P-040', '리테이너', 'RT-8P-01', '', 1, '8P 리테이너(사내 코드 미등록)']
  ];

  var api = {
    drawMapAoa: drawMapAoa, customer: customer, drawingNo: drawingNo, page: page, shapes: shapes, scanList: scanList,
    customerB: customerB, drawingNoB: drawingNoB, shapesB: shapesB, tableRows: tableRows, profiles: profiles, xrefAoa: xrefAoa, subAoa: subAoa
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DrawSample = api;
})(typeof window !== 'undefined' ? window : this);
