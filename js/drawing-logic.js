/*
 * 도면 자재 판별 — 순수 로직 모듈 (화면·저장소·pdf.js 와 무관)
 * 기획서 v0.2 1차 목표: 도면 위 자재 위치(좌표) + 사내 자재 매핑 + 기존/매핑 필요/신규 판별 + 독립 데이터 추출.
 *
 *  1) PDF 텍스트 레이어 글자 조각(item) → 한 줄로 이어 붙이기 → 낱말로 나누기 → 품번 후보 고르기(좌표 포함)
 *  2) 도면 품번을 통합 자재 마스터와 대조 → 기존(초록) / 매핑 필요(노랑) / 신규(빨강) / 품번 미입력(회색)
 *  3) 판별 결과를 엑셀 시트(자재 판별 · 품번별 요약 · 확인 필요 · 도면 정보)로 정리
 *
 * 좌표는 모두 「쪽 왼쪽 위가 (0,0), 오른쪽·아래로 커지는」 값입니다.
 * PDF 는 pt(1/72 inch, 쪽 원래 크기 기준), 이미지는 픽셀(px)입니다.
 * 브라우저에서는 window.DrawLogic, Node(테스트)에서는 module.exports 로 씁니다.
 * 품번 정리(normalizePn)와 매핑 조회(lookupPart)는 js/logic.js(BomLogic)의 것을 그대로 씁니다.
 */
(function (root) {
  'use strict';
  var B = (typeof module !== 'undefined' && module.exports) ? require('./logic.js') : root.BomLogic;

  function str(v) { return v == null ? '' : String(v).trim(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ── 설정 ──────────────────────────────────────────────────────
  var DEFAULT_DRAW_SETTINGS = {
    minLen: 4,          // 품번 후보 최소 글자 수(공백·하이픈 뺀 길이)
    needMix: true,      // 영문과 숫자가 함께 있어야 후보(치수 250, 글자 REV 같은 것 거르기)
    wireFilter: true,   // 0.5SQ · 0.85mm2 · 20AWG 같은 전선 규격 표기 거르기
    exclude: '',        // 제외 목록 — 한 줄에 하나, * 는 아무 글자(예: HN-24-*)
    fuzzy: 1,           // 유사 품번 후보로 볼 최대 글자 차이(0 이면 안 찾음)
    confusable: true,   // O↔0 · I·L↔1 · S↔5 · B↔8 · Z↔2 같은 헷갈리는 글자를 같은 것으로 보고 후보 찾기
    unmappedCust: 'customer' // 마스터·대조표에 없는 고객사 품번: 'customer'(노랑, 매핑 없음) | 'new'(빨강, 신규)
  };
  function mergeDrawSettings(s) {
    var d = clone(DEFAULT_DRAW_SETTINGS);
    if (!s) return d;
    Object.keys(d).forEach(function (k) { if (s[k] !== undefined && s[k] !== null) d[k] = s[k]; });
    d.minLen = Math.max(1, parseInt(d.minLen, 10) || DEFAULT_DRAW_SETTINGS.minLen);
    d.fuzzy = Math.max(0, Math.min(3, parseInt(d.fuzzy, 10) || 0));
    d.needMix = !!d.needMix; d.wireFilter = !!d.wireFilter; d.confusable = !!d.confusable;
    d.exclude = String(d.exclude || '');
    d.unmappedCust = d.unmappedCust === 'new' ? 'new' : 'customer';
    return d;
  }

  // ── 판별 상태 ─────────────────────────────────────────────────
  // 색만으로 구분하지 않도록 선 모양·글자 라벨을 함께 씁니다(색약 고려).
  // 2026-09-29 저녁(수강생 답): 노랑 = 「도면에 제조사 품번이 아닌 고객사 품번이 적힌 자재」.
  //   그래서 고객사 품번(customer)을 노랑으로 따로 두고, 사람이 골라야 하는 애매한 경우(후보 여러 개·코드 빈칸 등)는
  //   「확인 필요」(보라 점선)로 옮겼습니다. 내부 키 mapping 은 저장된 자료와 맞추려고 그대로 둡니다.
  var STATUS = {
    existing: { label: '기존', long: '기존 자재', color: '#1b7f3b', line: 'solid', width: 2 },
    customer: { label: '고객사 품번', long: '고객사 품번', color: '#b07800', line: 'solid', width: 3 },
    mapping: { label: '확인 필요', long: '확인 필요', color: '#6a3d9a', line: 'dashed', width: 2.5 },
    'new': { label: '신규', long: '신규 자재', color: '#c62828', line: 'double', width: 3 },
    empty: { label: '미입력', long: '품번 미입력', color: '#6b7280', line: 'dotted', width: 2 }
  };
  var STATUS_ORDER = ['existing', 'customer', 'mapping', 'new', 'empty'];

  var REASON = {
    cust_exact: '도면에 고객사 품번 — 통합 자재 마스터로 제조사 품번·사내 코드 매핑',
    cust_norm: '도면에 고객사 품번(표기 차이: 공백·하이픈·대소문자) — 마스터로 매핑',
    xref: '도면에 고객사 품번 — 고객사 대조표로 제조사 품번 매핑',
    xref_new: '고객사 대조표로 제조사 품번을 찾았으나 사내 마스터에 없음 — 신규 자재',
    cust_unmapped: '고객사 품번 형식인데 마스터·대조표에 없음 — 제조사 품번·사내 코드를 입력해 주세요',
    mfr: '도면에 제조사 품번 — 사내 자재와 일치',
    code: '사내 자재 코드로 일치',
    map_multi: '제조사 품번 후보가 여러 개 — 하나를 골라 주세요',
    map_dup_code: '한 품번에 사내 코드가 여러 개 — 하나를 골라 주세요',
    map_no_code: '마스터에 있으나 사내 자재 코드가 비어 있음',
    other_customer: '다른 고객사 품번으로만 등록됨 — 이 고객사 매핑 추가 필요',
    similar: '마스터에 같은 품번은 없고 비슷한 품번이 있음 — 오기인지 확인해 주세요',
    none: '통합 자재 마스터에 없음',
    empty: '위치만 표시되고 품번이 없음 — 품번을 입력해 주세요',
    pick: '담당자가 후보 중 선택',
    manual: '담당자가 사내 코드 직접 입력',
    confirm_new: '담당자가 신규 자재로 확정'
  };

  // ── 문자열 도우미 ─────────────────────────────────────────────
  // 편집 거리(글자 삽입·삭제·바꾸기 횟수). max 를 넘으면 max+1 을 돌려 일찍 끝냅니다.
  function levenshtein(a, b, max) {
    a = String(a); b = String(b);
    if (max == null) max = Infinity;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i]; var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var c = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  // 헷갈리기 쉬운 글자를 한 글자로 모은 비교용 열쇠 (도면 글꼴·스캔 판독에서 흔한 오독)
  var CONFUSE = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
  function confusableKey(s) {
    return String(s).toUpperCase().replace(/[OQDILSBZG]/g, function (c) { return CONFUSE[c]; });
  }
  var NORM_ALL = { space: true, hyphen: true, upper: true, dot: true };
  function wildcardRe(p) {
    var esc = String(p).trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + esc + '$', 'i');
  }
  function excludeList(text) {
    return String(text || '').split(/\r?\n|,/).map(str).filter(Boolean);
  }
  function isExcluded(token, list) {
    var t = str(token), nt = B.normalizePn(t, NORM_ALL);
    return list.some(function (p) {
      if (p.indexOf('*') >= 0) return wildcardRe(p).test(t) || wildcardRe(B.normalizePn(p.replace(/\*/g, '\u0001'), NORM_ALL).replace(/\u0001/g, '*')).test(nt);
      return B.normalizePn(p, NORM_ALL) === nt;
    });
  }
  var WIRE_RE = /^\d+(\.\d+)?(SQ|SQMM|MM2|MM²|㎟|AWG|SQ\.)$/i;

  // ── 1) PDF 글자 조각 → 줄 → 낱말 ─────────────────────────────
  // items: [{ page, str, x, y, w, h, vert? }] — x·y 는 글자 상자 왼쪽 위, h 는 글자 높이
  // pdf.js 는 한 품번을 여러 조각(「CA-」 + 「1003」)으로 줄 때가 있어, 같은 줄에서 거의 붙어 있는 조각은 잇습니다.
  // opts.maxGap: 이어 붙일 최대 간격(글자 높이 배수). 표 칸은 서로 가까워 0.35 정도로 좁혀 씁니다.
  function mergeTextItems(items, opts) {
    var maxGap = opts && opts.maxGap != null ? opts.maxGap : 1.0;
    var list = (items || []).filter(function (it) { return it && str(it.str) !== '' && it.w >= 0 && it.h > 0; })
      .map(function (it, i) { return { page: it.page || 1, s: String(it.str), x: +it.x, y: +it.y, w: +it.w, h: +it.h, vert: !!it.vert, i: i }; });
    list.sort(function (a, b) {
      if (a.page !== b.page) return a.page - b.page;
      var ha = Math.max(a.h, b.h) * 0.5;
      if (Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) > ha) return a.y - b.y;
      return a.x - b.x;
    });
    var segs = [], cur = null;
    function charBoxes(it) {
      var n = it.s.length || 1, cw = it.w / n, out = [];
      for (var k = 0; k < it.s.length; k++) out.push({ x: it.x + cw * k, w: cw });
      return out;
    }
    function startSeg(it) {
      cur = { page: it.page, str: it.s, x: it.x, y: it.y, w: it.w, h: it.h, vert: it.vert, cx: it.vert ? null : charBoxes(it) };
      segs.push(cur);
    }
    list.forEach(function (it) {
      if (!cur || it.vert || cur.vert || it.page !== cur.page) { startSeg(it); return; }
      var hh = Math.max(cur.h, it.h);
      var sameLine = Math.abs((cur.y + cur.h / 2) - (it.y + it.h / 2)) <= hh * 0.35 && Math.min(cur.h, it.h) >= hh * 0.6;
      var gap = it.x - (cur.x + cur.w);
      if (!sameLine || gap < -hh * 0.3 || gap > hh * maxGap) { startSeg(it); return; }
      if (gap > hh * 0.2 && !/\s$/.test(cur.str) && !/^\s/.test(it.s)) {
        cur.str += ' '; cur.cx.push({ x: cur.x + cur.w, w: Math.max(gap, 0) });
      }
      cur.str += it.s;
      cur.cx = cur.cx.concat(charBoxes(it));
      var right = Math.max(cur.x + cur.w, it.x + it.w), top = Math.min(cur.y, it.y), bottom = Math.max(cur.y + cur.h, it.y + it.h);
      cur.w = right - cur.x; cur.y = top; cur.h = bottom - top;
    });
    return segs;
  }
  // 줄을 낱말로 — 공백·쉼표·세미콜론·콜론·괄호·등호로 나눕니다(「P/N:CA-1001」 → 「P/N」 「CA-1001」)
  var TOKEN_RE = /[^\s,;:=()\[\]{}<>"'`]+/g;
  function tokenize(seg) {
    var out = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(seg.str))) {
      var t = m[0].replace(/[.·]+$/, ''), start = m.index, end = start + t.length;
      if (!t) continue;
      var box;
      if (seg.vert || !seg.cx || !seg.cx[start]) box = { x: seg.x, y: seg.y, w: seg.w, h: seg.h };
      else {
        var last = seg.cx[Math.min(end, seg.cx.length) - 1];
        box = { x: seg.cx[start].x, y: seg.y, w: last.x + last.w - seg.cx[start].x, h: seg.h };
      }
      out.push({ page: seg.page, str: t, x: box.x, y: box.y, w: box.w, h: box.h });
    }
    return out;
  }

  // 마스터에 있는 품번(고객사·제조사·사내 코드)을 정리한 모음 — 형식 규칙에 안 맞아도 이 모음에 있으면 후보로 둡니다
  function buildMasterIndex(mapRows, norm) {
    var idx = {};
    (mapRows || []).forEach(function (r) {
      ['cust', 'mfr', 'code'].forEach(function (k) { if (r[k]) idx[B.normalizePn(r[k], norm)] = 1; });
    });
    return idx;
  }
  // ── 고객사 프로필(고객사별 학습 규칙) ────────────────────────
  // 프로필 원본: { id, name, keywords[], layout:'label'|'table', examples:{mfr[],cust[]}, patterns:[{re,type}],
  //               strict, xref:[{cust,mfr,code,name}], table:{roles:{머리글:역할}}, exclude }
  // 여기서는 판별·추출에 쓰는 모양으로 한 번 정리(compile)만 합니다. 예시로 규칙을 만드는 일은 js/drawing-learn.js.
  function compileProfile(profile, norm) {
    if (!profile) return null;
    if (profile.__compiled) return profile;
    var pats = [];
    (profile.patterns || []).forEach(function (p) {
      if (!p || !p.re) return;
      try { pats.push({ re: new RegExp(p.re, 'i'), type: p.type === 'cust' ? 'cust' : 'mfr', src: p.re }); } catch (e) { /* 잘못된 식은 건너뜀 */ }
    });
    var xref = {};
    (profile.xref || []).forEach(function (x) {
      if (x && str(x.cust)) xref[B.normalizePn(x.cust, norm)] = { cust: str(x.cust), mfr: str(x.mfr), code: str(x.code), name: str(x.name) };
    });
    return {
      __compiled: true, id: profile.id, name: str(profile.name), layout: profile.layout === 'table' ? 'table' : 'label',
      patterns: pats, strict: !!profile.strict && pats.length > 0, xref: xref, exclude: excludeList(profile.exclude)
    };
  }
  // 학습한 품번 모양으로 이 글자가 제조사 품번인지 고객사 품번인지 (둘 다 맞으면 먼저 등록한 것)
  // 숫자 사이·옆에 낀 헷갈리는 영문(O·I·S …)은 숫자로 보고도 한 번 더 맞춰 봅니다 — 「CL-2O02」 가 모양 규칙에서 빠지지 않게
  function digitFix(t) {
    var prev = null, s = String(t);
    while (prev !== s) { prev = s; s = s.replace(/(\d)([OQDILSBZG])|([OQDILSBZG])(\d)/gi, function (m, d1, c1, c2, d2) { return d1 ? d1 + CONFUSE[c1.toUpperCase()] : CONFUSE[c2.toUpperCase()] + d2; }); }
    return s;
  }
  // 제조사·고객사 모양에 둘 다 맞으면 구분할 수 없으므로 '' (마스터·대조표 조회로 정함)
  function patternType(token, prof) {
    if (!prof || !prof.patterns.length) return '';
    var t = str(token), f = digitFix(t);
    function types(v) {
      var got = {};
      prof.patterns.forEach(function (p) { if (p.re.test(v)) got[p.type] = 1; });
      return Object.keys(got);
    }
    var g = types(t);
    if (!g.length && f !== t) g = types(f);
    return g.length === 1 ? g[0] : '';
  }

  // 이 낱말이 품번 후보인가. 결과: { ok, why, pnType }
  // prof(선택): compileProfile 결과 — 고객사 대조표·학습한 품번 모양·고객사별 제외 목록을 씁니다
  function candidateCheck(token, settings, index, norm, prof) {
    var st = mergeDrawSettings(settings), t = str(token);
    if (!t) return { ok: false, why: 'empty' };
    if (isExcluded(t, excludeList(st.exclude))) return { ok: false, why: 'exclude' };
    if (prof && prof.exclude.length && isExcluded(t, prof.exclude)) return { ok: false, why: 'exclude' };
    var pt = prof ? patternType(t, prof) : '';
    if (index && index[B.normalizePn(t, norm)]) return { ok: true, why: 'master', pnType: pt };
    if (prof && prof.xref[B.normalizePn(t, norm)]) return { ok: true, why: 'xref', pnType: 'cust' };
    if (pt) return { ok: true, why: 'learned', pnType: pt };
    if (prof && prof.strict) {
      // 제조사·고객사 모양에 둘 다 맞아 종류를 못 정한 글자도 모양에는 맞으므로 후보로 둠
      var f = digitFix(t), any = prof.patterns.some(function (p) { return p.re.test(t) || p.re.test(f); });
      return any ? { ok: true, why: 'learned', pnType: '' } : { ok: false, why: 'not_learned' };
    }
    if (st.wireFilter && WIRE_RE.test(t)) return { ok: false, why: 'wire' };
    var core = B.normalizePn(t, NORM_ALL);
    if (core.length < st.minLen) return { ok: false, why: 'short' };
    if (st.needMix && !(/[A-Z]/i.test(core) && /\d/.test(core))) return { ok: false, why: 'mix' };
    if (!/^[A-Z0-9]/i.test(t)) return { ok: false, why: 'shape' };
    return { ok: true, why: 'pattern', pnType: '' };
  }
  // PDF 글자 조각 → 품번 후보 표시 목록 [{ page, x, y, w, h, pn, src:'pdf', why }]
  function extractCandidates(items, opts) {
    opts = opts || {};
    var norm = opts.norm, index = opts.index || null, seen = {}, out = [];
    var prof = compileProfile(opts.profile, norm);
    mergeTextItems(items).forEach(function (seg) {
      tokenize(seg).forEach(function (tk) {
        var c = candidateCheck(tk.str, opts.settings, index, norm, prof);
        if (!c.ok) return;
        // 굵은 글씨를 두 번 찍은 PDF 처럼 같은 자리에 같은 품번이 겹치면 하나만 둡니다
        var key = tk.page + '|' + B.normalizePn(tk.str, NORM_ALL) + '|' + Math.round(tk.x / 3) + '|' + Math.round(tk.y / 3);
        if (seen[key]) return;
        seen[key] = 1;
        out.push({ page: tk.page, x: round2(tk.x), y: round2(tk.y), w: round2(tk.w), h: round2(tk.h), pn: tk.str, src: 'pdf', why: c.why, pnType: c.pnType || '' });
      });
    });
    return sortMarks(out);
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function sortMarks(marks) {
    return marks.slice().sort(function (a, b) {
      if ((a.page || 1) !== (b.page || 1)) return (a.page || 1) - (b.page || 1);
      if (Math.abs(a.y - b.y) > Math.max(a.h || 0, b.h || 0) * 0.5) return a.y - b.y;
      return a.x - b.x;
    });
  }

  // ── 2) 도면 품번 판별 ─────────────────────────────────────────
  function custKey(v) { return B.normalizePn(v, { space: true, hyphen: false, upper: true, dot: false }); }
  function rowIndex(mapRows) { var m = {}; (mapRows || []).forEach(function (r) { m[r.row] = r; }); return m; }
  function enrich(cands, byRow) {
    return cands.map(function (c) {
      var rows = c.rows.map(function (n) { return byRow[n]; }).filter(Boolean);
      var kind = '', custs = {}, customers = {};
      rows.forEach(function (r) { if (!kind && r.kind) kind = r.kind; if (r.cust) custs[r.cust] = 1; if (r.customer) customers[r.customer] = 1; });
      return { id: c.id, mfr: c.mfr, code: c.code, name: c.name, kind: kind, rows: c.rows, cust: Object.keys(custs).join(', '), customer: Object.keys(customers).join(', ') };
    });
  }
  // 비슷한 품번 찾기 — 헷갈리는 글자(O↔0 등)만 다르면 거리 0, 그 밖에는 편집 거리 fuzzy 이하
  function similarCandidates(pn, mapRows, st) {
    var q = B.normalizePn(pn, NORM_ALL);
    if (q.length < 4) return [];
    var qk = confusableKey(q), groups = {}, list = [];
    (mapRows || []).forEach(function (r) {
      ['cust', 'mfr', 'code'].forEach(function (col) {
        if (!r[col]) return;
        var v = B.normalizePn(r[col], NORM_ALL), d, why;
        if (v === q) { d = 0; why = '표기 차이(점·밑줄·슬래시)'; }
        else if (st.confusable && v.length === q.length && confusableKey(v) === qk) { d = 0.5; why = '헷갈리는 글자 차이(예: O↔0)'; }
        else if (st.fuzzy > 0 && q.length >= 5) {
          d = levenshtein(q, v, st.fuzzy);
          if (d > st.fuzzy) return;
          why = d + '글자 차이';
        } else return;
        var id = r.mfr + '|' + r.code;
        var g = groups[id];
        if (!g) { g = groups[id] = { id: id, mfr: r.mfr, code: r.code, name: r.name, kind: r.kind, rows: [], d: d, why: why, via: r[col], col: col, cust: r.cust || '', customer: r.customer || '' }; list.push(g); }
        if (g.rows.indexOf(r.row) < 0) g.rows.push(r.row);
        if (d < g.d) { g.d = d; g.why = why; g.via = r[col]; g.col = col; }
      });
    });
    list.sort(function (a, b) { return a.d - b.d || String(a.via).localeCompare(String(b.via)); });
    return list.slice(0, 3);
  }
  // 새 품번의 자재 종류 짐작 — 앞 영문 머리(CA-, CL- …)가 같은 마스터 품번들의 종류 중 가장 많은 것
  function guessKind(pn, mapRows) {
    var m = /^[A-Z]+/.exec(B.normalizePn(pn, NORM_ALL));
    if (!m) return '';
    var pre = m[0], count = {}, best = '', bestN = 0;
    (mapRows || []).forEach(function (r) {
      if (!r.kind) return;
      var hit = ['cust', 'mfr'].some(function (k) {
        var v = B.normalizePn(r[k], NORM_ALL), mm = /^[A-Z]+/.exec(v);
        return mm && mm[0] === pre;
      });
      if (!hit) return;
      count[r.kind] = (count[r.kind] || 0) + 1;
      if (count[r.kind] > bestN) { bestN = count[r.kind]; best = r.kind; }
    });
    return best;
  }

  // 한 품번 판별. opts: { customer, norm, settings, choice, profile, pnType }
  //  profile: 고객사 프로필(원본 또는 compileProfile 결과) — 고객사 대조표·학습한 품번 모양
  //  pnType : 'mfr' | 'cust' | '' — 도면 표의 열(제조사 품번 열·고객사 품번 열)이나 학습한 모양으로 이미 아는 품번 종류
  // 결과: { status, reason, detail, by, match, code, mfr, name, kind, kindGuess, candidates[], confirmed, isCust }
  //  status: existing(제조사 품번·사내 코드로 일치, 초록) · customer(도면에 고객사 품번, 노랑)
  //          · mapping(확인 필요 — 후보 여러 개·코드 빈칸·다른 고객사·비슷한 품번) · new(신규, 빨강) · empty
  function classifyPart(pn, mapRows, opts) {
    opts = opts || {};
    var norm = opts.norm, st = mergeDrawSettings(opts.settings), rows = mapRows || [], byRow = rowIndex(rows);
    var prof = compileProfile(opts.profile, norm);
    var q = str(pn);
    var res = { pn: q, status: 'empty', reason: 'empty', by: null, match: 'none', code: '', mfr: '', name: '', kind: '', kindGuess: false, candidates: [], confirmed: false, isCust: false };
    if (!q) { res.detail = REASON.empty; return res; }
    var hint = opts.pnType || (prof ? patternType(q, prof) : '');
    var cust = str(opts.customer) || (prof ? prof.name : ''), ck = custKey(cust);
    var same = cust ? rows.filter(function (r) { return !r.customer || custKey(r.customer) === ck; }) : rows;
    var other = cust ? rows.filter(function (r) { return r.customer && custKey(r.customer) !== ck; }) : [];
    function take(lk) {
      var cands = enrich(lk.candidates, byRow);
      res.by = lk.by; res.match = lk.status; res.candidates = cands;
      if (!lk.issue) {
        var c = cands[0];
        res.status = lk.by === 'cust' ? 'customer' : 'existing';
        res.reason = lk.by === 'cust' ? (lk.status === 'exact' ? 'cust_exact' : 'cust_norm') : lk.by;
        res.code = c.code; res.mfr = c.mfr; res.name = c.name || ''; res.kind = c.kind;
      } else {
        res.status = 'mapping'; res.reason = lk.issue;
        if (cands.length === 1) { res.mfr = cands[0].mfr; res.name = cands[0].name || ''; res.kind = cands[0].kind; }
        else res.kind = cands[0].kind || '';
      }
      if (lk.by === 'cust') res.isCust = true;
    }
    var xr = prof ? prof.xref[B.normalizePn(q, norm)] : null;
    var lk = { status: 'none' };
    // 1) 고객사 대조표(프로필) — 도면 표기가 고객사 품번이면 제조사 품번으로 바꿔 마스터에서 찾음
    if (xr && hint !== 'mfr') {
      res.isCust = true; res.by = 'xref'; res.match = 'xref';
      var viaM = xr.mfr ? B.lookupPart(xr.mfr, rows, { order: ['mfr'], norm: norm }) : { status: 'none' };
      if (viaM.status === 'none' && xr.code) viaM = B.lookupPart(xr.code, rows, { order: ['code'], norm: norm });
      if (viaM.status !== 'none' && !viaM.issue) {
        var c0 = enrich(viaM.candidates, byRow)[0];
        res.status = 'customer'; res.reason = 'xref'; res.candidates = [c0];
        res.code = c0.code; res.mfr = c0.mfr; res.name = c0.name || xr.name; res.kind = c0.kind;
      } else if (viaM.status !== 'none') {
        res.status = 'mapping'; res.reason = viaM.issue; res.candidates = enrich(viaM.candidates, byRow);
        res.mfr = xr.mfr; res.kind = res.candidates[0].kind || '';
      } else if (xr.code) {
        res.status = 'customer'; res.reason = 'xref'; res.code = xr.code; res.mfr = xr.mfr; res.name = xr.name;
        res.kind = guessKind(xr.mfr || q, rows); res.kindGuess = !!res.kind;
      } else {
        res.status = 'new'; res.reason = 'xref_new'; res.mfr = xr.mfr; res.name = xr.name;
        res.kind = guessKind(xr.mfr || q, rows); res.kindGuess = !!res.kind;
      }
    } else {
      // 2) 이 고객사 품번(마스터 고객사 품번 열) → 3) 제조사 품번·사내 코드. 도면 표에서 제조사 품번 열로 온 것은 제조사부터
      var order = hint === 'mfr' ? [['mfr', 'code'], ['cust']] : [['cust'], ['mfr', 'code']];
      for (var oi = 0; oi < order.length && lk.status === 'none'; oi++) {
        lk = B.lookupPart(q, order[oi][0] === 'cust' ? same : rows, { order: order[oi], norm: norm });
      }
      if (lk.status !== 'none') take(lk);
      else {
        var lo = other.length ? B.lookupPart(q, other, { order: ['cust'], norm: norm }) : lk;
        if (lo.status !== 'none') {
          res.status = 'mapping'; res.reason = 'other_customer'; res.by = 'cust'; res.match = lo.status; res.isCust = true;
          res.candidates = enrich(lo.candidates, byRow);
          res.kind = res.candidates[0].kind || '';
        } else {
          var sim = similarCandidates(q, rows, st);
          if (sim.length) {
            res.status = 'mapping'; res.reason = 'similar'; res.match = 'similar';
            res.candidates = sim.map(function (s) { return { id: s.id, mfr: s.mfr, code: s.code, name: s.name, kind: s.kind, rows: s.rows, cust: s.cust, customer: s.customer, via: s.via, why: s.why }; });
            res.kind = sim[0].kind || '';
            if (res.kind) res.kindGuess = true;
          } else if (hint === 'cust' && st.unmappedCust !== 'new') {
            // 학습한 고객사 품번 모양(또는 도면 표의 고객사 품번 열)인데 어디에도 없음 → 노랑, 담당자가 제조사 품번·코드 입력
            res.status = 'customer'; res.reason = 'cust_unmapped'; res.isCust = true;
            res.kind = guessKind(q, rows); res.kindGuess = !!res.kind;
          } else {
            res.status = 'new'; res.reason = 'none';
            res.kind = guessKind(q, rows); res.kindGuess = !!res.kind;
          }
        }
      }
    }
    if (hint === 'cust') res.isCust = true;
    // 담당자 처리(후보 선택 · 사내 코드 직접 입력 · 신규 확정). 고객사 품번이면 확정 뒤에도 노랑(고객사 품번)으로 둡니다
    var ch = opts.choice, okStatus = res.isCust ? 'customer' : 'existing';
    if (ch) {
      if (ch.pick) {
        var p = res.candidates.filter(function (x) { return x.id === ch.pick && x.code; })[0];
        if (p) {
          res.status = okStatus; res.reason = 'pick'; res.confirmed = true;
          res.code = p.code; res.mfr = p.mfr; res.name = p.name || ''; if (p.kind) { res.kind = p.kind; res.kindGuess = false; }
        }
      } else if (ch.code) {
        res.status = okStatus; res.reason = 'manual'; res.confirmed = true;
        res.code = str(ch.code); res.mfr = str(ch.mfr) || res.mfr; res.name = str(ch.name) || res.name;
      } else if (ch.isNew) {
        res.status = 'new'; res.reason = 'confirm_new'; res.confirmed = true; res.code = '';
      }
    }
    res.detail = REASON[res.reason] || '';
    return res;
  }
  // 아직 사람이 손봐야 하는가(확인 필요 · 품번 미입력 · 매핑 없는 고객사 품번 · 확정 안 한 신규)
  function isOpen(r) {
    return r.status === 'mapping' || r.status === 'empty' || (r.status === 'customer' && !r.code) || (r.status === 'new' && !r.confirmed);
  }
  function choiceKey(pn, norm) { return B.normalizePn(pn, norm); }

  // 표시 목록 전체 판별. input: { marks, mapRows, customer, norm, settings, choices, profile }
  // mark 에 pnType(도면 표 열·학습 모양으로 아는 품번 종류)·custPn·qty·desc 가 있으면 함께 씁니다(도면 표에서 뽑은 표시)
  // 결과 rows 는 쪽·위치 순서, no 는 1부터(도면 라벨·표·엑셀이 같은 번호를 씁니다)
  function classifyMarks(input) {
    var marks = sortMarks(input.marks || []);
    var choices = input.choices || {}, cache = {};
    var prof = compileProfile(input.profile, input.norm);
    var rows = marks.map(function (m, i) {
      var key = choiceKey(m.pn, input.norm);
      var ck = key + '\u0001' + (m.pnType || '') + '\u0001' + (choices[key] ? JSON.stringify(choices[key]) : '');
      var r = cache[ck];
      if (!r) r = cache[ck] = classifyPart(m.pn, input.mapRows, { customer: input.customer, norm: input.norm, settings: input.settings, choice: choices[key], profile: prof, pnType: m.pnType || '' });
      var kind = str(m.kind) || r.kind;
      return {
        no: i + 1, id: m.id, page: m.page || 1, x: m.x, y: m.y, w: m.w, h: m.h, src: m.src || 'manual',
        pn: str(m.pn), key: key, kind: kind, kindGuess: !str(m.kind) && r.kindGuess, kindManual: !!str(m.kind),
        status: r.status, reason: r.reason, detail: r.detail, match: r.match, by: r.by,
        code: r.code, mfr: r.mfr, name: r.name, candidates: r.candidates, confirmed: r.confirmed,
        isCust: r.isCust, pnType: m.pnType || '', custPn: str(m.custPn) || (r.isCust ? str(m.pn) : ''),
        qty: m.qty != null && m.qty !== '' ? m.qty : '', desc: str(m.desc)
      };
    });
    var count = { existing: 0, customer: 0, mapping: 0, 'new': 0, empty: 0 };
    rows.forEach(function (r) { count[r.status]++; });
    return { rows: rows, count: count, total: rows.length, open: rows.filter(isOpen).length };
  }

  // 같은 품번끼리 묶은 요약(품번별 한 줄)
  function groupByPart(rows) {
    var g = {}, list = [];
    rows.forEach(function (r) {
      if (!r.pn) return;
      var k = r.key;
      if (!g[k]) { g[k] = { pn: r.pn, kind: r.kind, code: r.code, mfr: r.mfr, name: r.name, status: r.status, detail: r.detail, isCust: r.isCust, count: 0, qty: 0, pages: [], nos: [] }; list.push(g[k]); }
      g[k].count++;
      g[k].qty += qtyOf(r);
      if (g[k].pages.indexOf(r.page) < 0) g[k].pages.push(r.page);
      g[k].nos.push(r.no);
    });
    return list;
  }

  // 표시 한 개의 수량 — 도면 표의 수량 칸이 숫자면 그 값, 아니면 1(도면 위 표기 한 곳 = 1개)
  function qtyOf(r) {
    var n = parseFloat(String(r.qty == null ? '' : r.qty).replace(/[^0-9.]/g, ''));
    return isFinite(n) && n > 0 ? n : 1;
  }

  // ── 3) 내보내기 시트 ─────────────────────────────────────────
  // info: { fileName, drawingNo, customer, unit('pt'|'px'), pages, date }
  function statusText(r) {
    var s = STATUS[r.status].long;
    if (r.status === 'customer') s += r.code ? '(매핑됨)' : '(매핑 없음)';
    return r.confirmed ? s + '(담당자 확정)' : s;
  }
  var PNTYPE_TEXT = { mfr: '제조사 품번', cust: '고객사 품번', code: '사내 코드' };
  function pnTypeText(r) {
    if (r.isCust) return PNTYPE_TEXT.cust;
    if (r.by === 'mfr' || r.pnType === 'mfr') return PNTYPE_TEXT.mfr;
    if (r.by === 'code') return PNTYPE_TEXT.code;
    return '';
  }
  function candText(r) {
    return (r.candidates || []).map(function (c) {
      return (c.via ? c.via + ' → ' : '') + (c.code || '(사내 코드 없음)') + ' / ' + (c.mfr || '-') + (c.customer ? ' [' + c.customer + ']' : '') + (c.why ? ' (' + c.why + ')' : '');
    }).join(' | ');
  }
  var SRC_TEXT = { pdf: 'PDF 글자 자동 추출', table: 'PDF 도면 표(부품표) 추출', manual: '도면 위 직접 표시' };
  function drawingSheets(result, info) {
    info = info || {};
    var unit = info.unit || 'pt';
    // 수강생 요청 순서: 자재 종류 | 도면 표기 품번 | 매핑된 사내 자재 코드 | 신규 여부 — 그 뒤에 위치·근거
    // 2026-09-29 저녁: 뒤에 「도면 품번 구분 · 고객사 품번 · 수량 · 적용 고객사 규칙」 열을 붙임(앞 열 순서는 그대로)
    var main = [['번호', '자재 종류', '도면 표기 품번', '매핑된 사내 자재 코드', '신규 여부', '판별 근거', '제조사 품번', '품명', '후보(확인 필요 시)', '쪽', 'X', 'Y', '너비', '높이', '좌표 단위', '추출 방식', '도면 품번 구분', '고객사 품번', '수량', '적용 고객사 규칙']];
    result.rows.forEach(function (r) {
      main.push([r.no, r.kind + (r.kindGuess ? '(추정)' : ''), r.pn, r.code, statusText(r), r.detail, r.mfr, r.name,
        r.status === 'mapping' ? candText(r) : '', r.page, round2(r.x), round2(r.y), round2(r.w), round2(r.h), unit, SRC_TEXT[r.src] || r.src,
        pnTypeText(r), r.custPn || '', qtyOf(r), info.profile || '']);
    });
    var sum = [['자재 종류', '도면 표기 품번', '매핑된 사내 자재 코드', '신규 여부', '제조사 품번', '품명', '도면 표기 횟수', '쪽', '번호', '수량 합계']];
    groupByPart(result.rows).forEach(function (g) {
      sum.push([g.kind, g.pn, g.code, STATUS[g.status].long, g.mfr, g.name, g.count, g.pages.join(', '), g.nos.join(', '), g.qty]);
    });
    var todo = [['번호', '신규 여부', '도면 표기 품번', '자재 종류', '사유', '후보', '쪽', 'X', 'Y']];
    result.rows.forEach(function (r) {
      if (!isOpen(r)) return;
      todo.push([r.no, statusText(r), r.pn, r.kind, r.detail, candText(r), r.page, round2(r.x), round2(r.y)]);
    });
    var c = result.count;
    var meta = [
      ['도면 파일', info.fileName || ''], ['도면 번호', info.drawingNo || ''], ['고객사', info.customer || ''],
      ['쪽 수', info.pages || ''], ['판별일', info.date || ''], ['적용 고객사 규칙', info.profile || '(없음)'],
      ['좌표 기준', unit === 'px' ? '이미지 왼쪽 위 (0,0), 단위 픽셀(px)' : '쪽 왼쪽 위 (0,0), 단위 pt(1/72 inch), 쪽 원래 크기 기준'],
      [],
      ['전체 표시', result.total], ['기존 자재(제조사 품번)', c.existing], ['고객사 품번', c.customer || 0], ['확인 필요', c.mapping], ['신규 자재', c['new']], ['품번 미입력', c.empty]
    ];
    return { '자재 판별': main, '품번별 요약': sum, '확인 필요': todo, '도면 정보': meta };
  }

  // 이미지·스캔 도면에서 클릭 한 번으로 표시할 때의 기본 상자 크기(쪽 폭 기준)
  function defaultBox(pageW, pageH, cx, cy) {
    var w = Math.max(pageW * 0.07, 8), h = Math.max(pageW * 0.02, 6);
    var x = Math.min(Math.max(cx - w / 2, 0), Math.max(pageW - w, 0));
    var y = Math.min(Math.max(cy - h / 2, 0), Math.max(pageH - h, 0));
    return { x: round2(x), y: round2(y), w: round2(w), h: round2(h) };
  }
  // 붙여 넣은 품번 목록(한 줄에 하나, 앞의 번호·기호와 AI 가 붙인 [?] 는 뗌) → 배치 대기열
  function parsePnList(text) {
    return String(text || '').split(/\r?\n/).map(function (l) {
      return str(l.replace(/^\s*(\d+[.)]|[-*•·])\s+/, '').split(/\t/)[0].replace(/\s*\[\?\]\s*$/, ''));
    }).filter(Boolean);
  }

  // 대시보드 「AI 분석 결과 요약」 — 자재 종류별로 도면 표기 수와 사내 자재 코드로 맞춘 수를 나란히 셉니다.
  // 이 도구는 두 도면을 비교하지 않고 도면 한 장을 통합 자재 마스터와 대조하므로, 시안의 A/B 두 칸을
  // 「도면 표기」(A)와 「사내 코드 매핑」(B)으로 옮겼습니다. 차이(diff) = 표기 − 매핑 = 사내 코드가 아직 없는 곳 수
  function kindSummary(rows) {
    var list = [], g = {};
    (rows || []).forEach(function (r) {
      var k = str(r.kind) || '종류 미정';
      if (!g[k]) { g[k] = { kind: k, total: 0, mapped: 0, count: { existing: 0, customer: 0, mapping: 0, 'new': 0, empty: 0 }, open: 0, custUnmapped: 0 }; list.push(g[k]); }
      var x = g[k];
      x.total++;
      x.count[r.status] = (x.count[r.status] || 0) + 1;
      if (r.code && (r.status === 'existing' || r.status === 'customer')) x.mapped++;
      if (r.status === 'customer' && !r.code) x.custUnmapped++;
      if (isOpen(r)) x.open++;
    });
    list.forEach(function (x) { x.diff = x.total - x.mapped; x.match = x.diff === 0; });
    return list;
  }
  // 분석 기록 — 같은 도면(파일 이름 + 도면 번호)은 한 줄로 두고, 판별 결과가 바뀌었을 때만 맨 위로 올려 시각을 고칩니다.
  // 결과: { list, changed }. list 는 새 배열(changed 가 false 면 받은 것 그대로)
  function historyKey(e) { return str(e.fileName) + '\u0001' + str(e.drawingNo); }
  function historySig(e) { return JSON.stringify([e.total, e.open, e.count, str(e.customer), str(e.profile), !!e.sample]); }
  function upsertHistory(list, entry, now, max) {
    list = Array.isArray(list) ? list : [];
    max = max || 30;
    var key = historyKey(entry), i = -1;
    for (var j = 0; j < list.length; j++) if (historyKey(list[j]) === key) { i = j; break; }
    if (i >= 0 && historySig(list[i]) === historySig(entry)) return { list: list, changed: false };
    var e = Object.assign({}, entry, { at: now, id: i >= 0 ? list[i].id : 'h' + String(now).replace(/\D/g, '') + '-' + list.length });
    var out = list.filter(function (_, k) { return k !== i; });
    out.unshift(e);
    return { list: out.slice(0, max), changed: true };
  }

  var api = {
    DEFAULT_DRAW_SETTINGS: DEFAULT_DRAW_SETTINGS, mergeDrawSettings: mergeDrawSettings,
    STATUS: STATUS, STATUS_ORDER: STATUS_ORDER, REASON: REASON,
    levenshtein: levenshtein, confusableKey: confusableKey, isExcluded: isExcluded, excludeList: excludeList,
    mergeTextItems: mergeTextItems, tokenize: tokenize, buildMasterIndex: buildMasterIndex,
    compileProfile: compileProfile, patternType: patternType, digitFix: digitFix, isOpen: isOpen, qtyOf: qtyOf, pnTypeText: pnTypeText, round2: round2, str: str,
    candidateCheck: candidateCheck, extractCandidates: extractCandidates, sortMarks: sortMarks,
    similarCandidates: similarCandidates, guessKind: guessKind, classifyPart: classifyPart, choiceKey: choiceKey,
    classifyMarks: classifyMarks, groupByPart: groupByPart, drawingSheets: drawingSheets, statusText: statusText,
    defaultBox: defaultBox, parsePnList: parsePnList,
    kindSummary: kindSummary, upsertHistory: upsertHistory, historyKey: historyKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DrawLogic = api;
})(typeof window !== 'undefined' ? window : this);
