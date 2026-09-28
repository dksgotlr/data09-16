/*
 * 하네스 BOM 산출 — 순수 로직 모듈 (화면·저장소와 무관)
 * 기획서 8장 1단계: 마스터 엑셀 열 매핑 → 품번 교차 검증 → 종속 자재(터미널·실·방수전) 산출
 * → 확인 대상 표시 → BOM 집계.
 * 브라우저에서는 window.BomLogic, Node(테스트)에서는 module.exports 로 씁니다.
 * ES module 이 아닌 이유: index.html 을 로컬 파일(file://)로 열었을 때
 * 브라우저가 module 스크립트를 막기 때문입니다.
 */
(function (root) {
  'use strict';

  // ── 표준 항목 (열 매핑 대상) ─────────────────────────────────────
  // syn: 실제 파일의 열 이름을 자동으로 짐작할 때 쓰는 낱말(정규화 후 포함 여부로 비교)
  var MAP_FIELDS = [
    { key: 'cust', label: '고객사 품번', need: false, syn: ['고객사품번', '고객품번', '고객사partno', 'customerpart', 'custpn', '고객사p/n'] },
    { key: 'mfr', label: '제조사 품번', need: true, syn: ['제조사품번', '메이커품번', '제조사partno', 'makerpart', 'mfrpn', '실제품번', '제조사p/n'] },
    { key: 'code', label: '사내 자재 코드', need: true, syn: ['사내자재코드', '사내코드', '자재코드', '품목코드', 'itemcode', 'materialcode'] },
    { key: 'name', label: '품명', need: false, syn: ['품명', '자재명', '품목명', 'description', 'desc', '규격명'] },
    { key: 'kind', label: '구분', need: false, syn: ['구분', '자재구분', '분류', 'category', 'type'] },
    { key: 'customer', label: '고객사', need: false, syn: ['고객사명', '고객사', 'customer'] }
  ];
  var SPEC_FIELDS = [
    { key: 'conn', label: '커넥터 품번', need: true, syn: ['커넥터품번', '커넥터', 'connector', 'housing', '하우징'] },
    { key: 'min', label: '전선 규격 하한', need: false, syn: ['하한', '최소', 'min', '규격하한'] },
    { key: 'max', label: '전선 규격 상한', need: false, syn: ['상한', '최대', 'max', '규격상한'] },
    { key: 'range', label: '전선 규격 범위(한 칸)', need: false, syn: ['전선규격범위', '적용전선규격', '규격범위', '전선규격', 'wirerange', 'wiresize'] },
    { key: 'term', label: '터미널 품번', need: true, syn: ['터미널품번', '터미널', 'terminal'] },
    { key: 'seal', label: '와이어 실 품번', need: false, syn: ['와이어실품번', '와이어실', '실품번', 'seal'] },
    { key: 'plug', label: '방수전 품번', need: false, syn: ['방수전품번', '방수전', '더미플러그', 'plug', 'dummy'] },
    { key: 'wire', label: '전선 종류', need: false, syn: ['전선종류', '전선종', '전선타입', 'wiretype'] }
  ];
  var KIND_ORDER = ['커넥터', '터미널', '실', '방수전'];

  var DEFAULT_SETTINGS = {
    margin: 0,            // 종속 자재(터미널·실·방수전) 여유율 % — 사내 규칙 확인 전이라 0
    boundary: 'include',  // 'include' 경계값 포함 / 'review' 경계값이면 확인 대상
    plug: false,          // 빈 극에 방수전 넣기 — 규칙 확인 전이라 기본 꺼짐
    unit: 'sq',           // 화면 표시용 단위 이름
    multiSep: ',;\n',     // 한 칸에 여러 품번이 있을 때 나누는 기호
    norm: { space: true, hyphen: true, upper: true, dot: false }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function mergeSettings(s) {
    var d = clone(DEFAULT_SETTINGS);
    if (!s) return d;
    Object.keys(d).forEach(function (k) {
      if (k === 'norm') { if (s.norm) Object.keys(d.norm).forEach(function (n) { if (typeof s.norm[n] === 'boolean') d.norm[n] = s.norm[n]; }); }
      else if (s[k] !== undefined && s[k] !== null) d[k] = s[k];
    });
    d.margin = Number(d.margin) || 0;
    if (d.margin < 0) d.margin = 0;
    return d;
  }

  function str(v) { return v == null ? '' : String(v).trim(); }

  // ── 품번 정규화 ─────────────────────────────────────────────────
  function normalizePn(v, norm) {
    var n = norm || DEFAULT_SETTINGS.norm;
    var s = str(v);
    if (n.space) s = s.replace(/[\s\u00a0\u3000]+/g, '');
    if (n.hyphen) s = s.replace(/[-‐-―−]/g, '');
    if (n.dot) s = s.replace(/[._/]/g, '');
    if (n.upper) s = s.toUpperCase();
    return s;
  }

  // 한 칸 안의 여러 품번 나누기 (기본 구분: 쉼표·세미콜론·줄바꿈)
  function splitMulti(v, seps) {
    var s = str(v);
    if (!s) return [];
    var chars = (seps == null ? DEFAULT_SETTINGS.multiSep : seps).split('');
    var out = [s];
    chars.forEach(function (c) {
      var next = [];
      out.forEach(function (part) { part.split(c).forEach(function (x) { next.push(x); }); });
      out = next;
    });
    var seen = {};
    return out.map(str).filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; });
  }

  // 전선 규격 숫자 읽기: 0.5 / "0.5sq" / "0.5 mm2" / "0,5㎟" → 0.5. AWG 는 단위가 달라 읽지 않음(null)
  function parseSpec(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = str(v);
    if (!s) return null;
    if (/awg/i.test(s)) return null;
    s = s.replace(/(sq|mm2|mm²|㎟|스퀘어)$/i, '').trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
    return parseFloat(s);
  }

  // 범위 한 칸: "0.3~0.5" / "0.3-0.5" / "0.3 ~ 0.5sq" / "0.5"(한 값)
  function parseRange(v) {
    var s = str(v);
    if (!s) return null;
    var m = s.match(/^(.+?)\s*[~∼〜]\s*(.+)$/) || s.match(/^([\d.,]+)\s*-\s*([\d.,]+\s*(?:sq|mm2|mm²|㎟)?)$/i);
    if (m) {
      var a = parseSpec(m[1]), b = parseSpec(m[2]);
      if (a == null || b == null) return null;
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    var one = parseSpec(s);
    return one == null ? null : { min: one, max: one };
  }

  // ── 열 매핑 ─────────────────────────────────────────────────────
  function headerKey(h) { return str(h).toLowerCase().replace(/[\s_\-()（）\[\]·.:]/g, ''); }

  // 헤더 한 줄에서 표준 항목별 열 번호 짐작. saved = { 필드: 열 이름 } (지난번 저장한 매핑)
  function guessMapping(headers, fields, saved) {
    var res = {};
    var used = {};
    var keys = headers.map(headerKey);
    fields.forEach(function (f) {
      if (saved && saved[f.key]) {
        var i = keys.indexOf(headerKey(saved[f.key]));
        if (i >= 0 && !used[i]) { res[f.key] = i; used[i] = 1; }
      }
    });
    // 긴 낱말(구체적인 것)부터 맞춰 「터미널」이 「터미널품번」 자리를 빼앗지 않게 함
    var cand = [];
    fields.forEach(function (f) { f.syn.forEach(function (s) { cand.push({ f: f.key, s: s }); }); });
    cand.sort(function (a, b) { return b.s.length - a.s.length; });
    cand.forEach(function (c) {
      if (res[c.f] !== undefined) return;
      for (var i = 0; i < keys.length; i++) {
        if (used[i] || !keys[i]) continue;
        if (keys[i] === c.s || keys[i].indexOf(c.s) >= 0) { res[c.f] = i; used[i] = 1; return; }
      }
    });
    return res;
  }

  // 머리행 찾기: 처음 15행 중 표준 항목 이름이 가장 많이 맞는 행 (없으면 첫 비어 있지 않은 행)
  function detectHeaderRow(aoa, fields) {
    var best = -1, bestScore = 0, firstFilled = -1;
    for (var r = 0; r < Math.min(aoa.length, 15); r++) {
      var row = aoa[r] || [];
      var filled = row.filter(function (c) { return str(c) !== ''; }).length;
      if (filled >= 2 && firstFilled < 0) firstFilled = r;
      if (filled < 2) continue;
      var score = Object.keys(guessMapping(row, fields)).length;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best >= 0 ? best : Math.max(firstFilled, 0);
  }

  function checkMapping(mapping, fields) {
    var missing = fields.filter(function (f) { return f.need && mapping[f.key] === undefined; }).map(function (f) { return f.label; });
    return missing;
  }

  // 매핑 마스터 표준화. 결과 행: { row(엑셀 행 번호), cust, mfr, code, name, kind, customer }
  function buildMapTable(aoa, headerRow, mapping) {
    var rows = [], skipped = 0;
    function cell(r, k) { return mapping[k] === undefined ? '' : str(r[mapping[k]]); }
    for (var i = headerRow + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var o = { row: i + 1, cust: cell(r, 'cust'), mfr: cell(r, 'mfr'), code: cell(r, 'code'), name: cell(r, 'name'), kind: cell(r, 'kind'), customer: cell(r, 'customer') };
      if (!o.cust && !o.mfr && !o.code) { if (r.some(function (c) { return str(c) !== ''; })) skipped++; continue; }
      rows.push(o);
    }
    return { rows: rows, skipped: skipped };
  }

  // Application Spec 표준화. 결과 행: { row, conn[], term[], seal[], plug[], min, max, wire, noRange }
  function buildSpecTable(aoa, headerRow, mapping, seps) {
    var rows = [], skipped = 0, noRange = 0, badRange = [];
    function cell(r, k) { return mapping[k] === undefined ? '' : r[mapping[k]]; }
    for (var i = headerRow + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var conn = splitMulti(cell(r, 'conn'), seps);
      var term = splitMulti(cell(r, 'term'), seps);
      if (!conn.length || !term.length) { if (r.some(function (c) { return str(c) !== ''; })) skipped++; continue; }
      var min = parseSpec(cell(r, 'min')), max = parseSpec(cell(r, 'max'));
      var rawMin = str(cell(r, 'min')), rawMax = str(cell(r, 'max'));
      if (min == null && max == null && mapping.range !== undefined) {
        var rg = parseRange(cell(r, 'range'));
        if (rg) { min = rg.min; max = rg.max; }
        else if (str(cell(r, 'range'))) { badRange.push(i + 1); skipped++; continue; }
      }
      if ((rawMin && min == null) || (rawMax && max == null)) { badRange.push(i + 1); skipped++; continue; }
      var o = {
        row: i + 1, conn: conn, term: term,
        seal: splitMulti(cell(r, 'seal'), seps), plug: splitMulti(cell(r, 'plug'), seps),
        min: min, max: max, wire: str(cell(r, 'wire'))
      };
      if (min == null && max == null) { o.noRange = true; noRange++; }
      rows.push(o);
    }
    return { rows: rows, skipped: skipped, noRange: noRange, badRange: badRange };
  }

  // ── 품번 조회 (교차 검증) ───────────────────────────────────────
  // order: 어느 열부터 찾을지. 도면 품번은 고객사→제조사→사내 코드, App Spec 에서 나온 품번은 제조사부터.
  // 결과: { status: 'exact'|'normalized'|'none', by, candidates:[{id, mfr, code, name, rows[]}], issue }
  function lookupPart(pn, mapRows, opts) {
    opts = opts || {};
    var order = opts.order || ['cust', 'mfr', 'code'];
    var norm = opts.norm || DEFAULT_SETTINGS.norm;
    var customer = str(opts.customer);
    var q = str(pn);
    var res = { pn: q, status: 'none', by: null, candidates: [], issue: 'map_none' };
    if (!q) { res.issue = 'map_empty'; return res; }
    var pool = mapRows;
    if (customer) {
      var nc = normalizePn(customer, { space: true, hyphen: false, upper: true, dot: false });
      pool = mapRows.filter(function (r) { return !r.customer || normalizePn(r.customer, { space: true, hyphen: false, upper: true, dot: false }) === nc; });
    }
    var nq = normalizePn(q, norm);
    for (var oi = 0; oi < order.length; oi++) {
      var col = order[oi];
      var hit = pool.filter(function (r) { return r[col] && r[col] === q; });
      var status = 'exact';
      if (!hit.length) {
        hit = pool.filter(function (r) { return r[col] && normalizePn(r[col], norm) === nq; });
        status = 'normalized';
      }
      if (!hit.length) continue;
      var groups = {}, list = [];
      hit.forEach(function (r) {
        var id = r.mfr + '|' + r.code;
        if (!groups[id]) { groups[id] = { id: id, mfr: r.mfr, code: r.code, name: r.name, rows: [] }; list.push(groups[id]); }
        groups[id].rows.push(r.row);
        if (!groups[id].name && r.name) groups[id].name = r.name;
      });
      res.status = status; res.by = col; res.candidates = list;
      if (list.length === 1) res.issue = list[0].code ? null : 'map_no_code';
      else {
        var mfrs = {};
        list.forEach(function (c) { mfrs[normalizePn(c.mfr, norm)] = 1; });
        res.issue = Object.keys(mfrs).length > 1 ? 'map_multi' : 'map_dup_code';
      }
      return res;
    }
    return res;
  }

  // ── Application Spec 조회 ───────────────────────────────────────
  // keys: 커넥터를 찾을 품번들(확정된 제조사 품번, 도면 원래 품번). spec: 숫자 규격.
  function specLookup(keys, spec, wire, specRows, settings) {
    var st = mergeSettings(settings);
    var nkeys = {};
    keys.forEach(function (k) { if (str(k)) nkeys[normalizePn(k, st.norm)] = 1; });
    var connRows = specRows.filter(function (r) {
      return r.conn.some(function (c) { return nkeys[normalizePn(c, st.norm)]; });
    });
    var res = { connRows: connRows, rows: [], terminals: [], seals: [], boundary: false, issue: null };
    if (!connRows.length) { res.issue = 'spec_no_conn'; return res; }
    if (spec == null) { res.issue = 'spec_bad'; return res; }
    var nw = normalizePn(wire, st.norm);
    var rows = connRows.filter(function (r) {
      if (nw && r.wire && normalizePn(r.wire, st.norm) !== nw) return false;
      var lo = r.min == null ? -Infinity : r.min, hi = r.max == null ? Infinity : r.max;
      return spec >= lo - 1e-9 && spec <= hi + 1e-9;
    });
    if (!rows.length) { res.issue = 'spec_out_of_range'; return res; }
    res.rows = rows;
    res.boundary = rows.some(function (r) {
      return (r.min != null && Math.abs(spec - r.min) < 1e-9) || (r.max != null && Math.abs(spec - r.max) < 1e-9);
    });
    var tm = {}, sm = {};
    rows.forEach(function (r) {
      r.term.forEach(function (t) {
        var k = normalizePn(t, st.norm);
        if (!tm[k]) { tm[k] = { id: t, pn: t, rows: [] }; res.terminals.push(tm[k]); }
        tm[k].rows.push(r.row);
      });
      var seals = r.seal.length ? r.seal : [''];
      seals.forEach(function (s) {
        var k = s ? normalizePn(s, st.norm) : '';
        if (!sm[k]) { sm[k] = { id: s, pn: s, rows: [] }; res.seals.push(sm[k]); }
        sm[k].rows.push(r.row);
      });
    });
    if (res.terminals.length > 1) res.issue = 'spec_multi_term';
    else if (res.seals.length > 1) res.issue = 'spec_multi_seal';
    else if (res.boundary && st.boundary === 'review') res.issue = 'spec_boundary';
    return res;
  }

  var REASON = {
    map_none: '매핑 마스터에 없는 품번입니다',
    map_empty: '품번이 비어 있습니다',
    map_multi: '제조사 품번 후보가 여러 개입니다',
    map_dup_code: '같은 품번에 사내 코드가 여러 개입니다',
    map_no_code: '매핑 마스터에 사내 코드가 비어 있습니다',
    spec_no_conn: 'Application Spec 에 이 커넥터가 없습니다',
    spec_bad: '전선 규격을 숫자로 읽지 못했습니다',
    spec_out_of_range: '전선 규격이 적용 범위 밖입니다',
    spec_boundary: '전선 규격이 적용 범위 경계값입니다',
    spec_multi_term: '적용 가능한 터미널이 여러 개입니다',
    spec_multi_seal: '적용 가능한 와이어 실이 여러 개입니다',
    plug_multi: '적용 가능한 방수전이 여러 개입니다',
    pole_over: '사용 극 수가 극수보다 많습니다',
    pole_dup: '같은 극 번호가 두 번 이상 입력되었습니다',
    circuit_no_conn: '커넥터 표에 없는 위치의 회로입니다',
    conn_dup_pos: '같은 커넥터 위치가 두 번 이상 입력되었습니다'
  };

  function fmtSpec(v) { return v == null ? '' : String(Math.round(v * 1000) / 1000); }

  // ── 전체 산출 ───────────────────────────────────────────────────
  // input = { mapRows, specRows, header:{customer}, connectors:[{pos,pn,poles}], circuits:[{pos,pole,spec,wire}], settings, choices }
  // choices[issueKey] = { pick: 후보 id } | { manual: { code, mfr, name } } | { manual: { term, seal } } | { manual: { plug } }
  function compute(input) {
    var st = mergeSettings(input.settings);
    var mapRows = input.mapRows || [], specRows = input.specRows || [];
    var choices = input.choices || {};
    var customer = input.header && input.header.customer;
    var issues = [], issueMap = {}, lines = [], circuitsOut = [];

    function addIssue(key, o) {
      if (issueMap[key]) {
        var ex = issueMap[key];
        o.where.forEach(function (w) { if (ex.where.indexOf(w) < 0) ex.where.push(w); });
        ex.qty += o.qty || 0;
        return ex;
      }
      o.key = key; o.reason = REASON[o.code] || o.code; o.qty = o.qty || 0;
      o.choice = choices[key] || null;
      o.resolved = false;
      issueMap[key] = o; issues.push(o);
      return o;
    }

    // 사내 코드 붙이기(교차 검증). 결과 { ok, mfr, code, name, basis, status, issueKey }
    function resolvePart(pn, kindLabel, where, qty, order) {
      var lk = lookupPart(pn, mapRows, { order: order, norm: st.norm, customer: customer });
      var basis = lk.candidates.length ? lk.candidates.map(function (c) { return '매핑 ' + c.rows.join('·') + '행'; }).join(', ') : '';
      if (!lk.issue) {
        var c = lk.candidates[0];
        return { ok: true, mfr: c.mfr, code: c.code, name: c.name, status: lk.status, basis: '매핑 ' + c.rows.join('·') + '행' };
      }
      var key = 'map|' + kindLabel + '|' + normalizePn(pn, st.norm);
      var cands = lk.candidates.map(function (c) {
        return { id: c.id, label: (c.mfr || '(제조사 품번 없음)') + ' → ' + (c.code || '(사내 코드 없음)') + (c.name ? ' · ' + c.name : ''), mfr: c.mfr, code: c.code, name: c.name, rows: c.rows };
      }).filter(function (c) { return c.code; });
      var iss = addIssue(key, { code: lk.issue, kind: kindLabel, pn: str(pn), where: [where], qty: qty, candidates: cands, manual: 'code' });
      var ch = iss.choice;
      if (ch && ch.pick) {
        var p = cands.filter(function (c) { return c.id === ch.pick; })[0];
        if (p) { iss.resolved = true; return { ok: true, mfr: p.mfr, code: p.code, name: p.name, status: 'chosen', basis: '매핑 ' + p.rows.join('·') + '행 (담당자 선택)', issueKey: key }; }
      }
      if (ch && ch.manual && str(ch.manual.code)) {
        iss.resolved = true;
        return { ok: true, mfr: str(ch.manual.mfr) || (lk.by === 'mfr' ? str(pn) : ''), code: str(ch.manual.code), name: str(ch.manual.name), status: 'manual', basis: '담당자 직접 입력', issueKey: key };
      }
      return { ok: false, status: 'issue', basis: basis, issueKey: key, candidates: cands };
    }

    function pushLine(kind, pos, srcPn, qty, r, extraBasis) {
      lines.push({
        kind: kind, pos: pos, srcPn: srcPn, qty: qty,
        mfr: r && r.ok ? r.mfr : '', code: r && r.ok ? r.code : '', name: r && r.ok ? r.name : '',
        status: r ? r.status : 'issue', ok: !!(r && r.ok),
        basis: [extraBasis, r && r.basis].filter(Boolean).join(', '),
        issueKey: r && r.issueKey
      });
    }

    // 입력 점검: 위치 중복
    var byPos = {};
    (input.connectors || []).forEach(function (c) {
      var p = str(c.pos) || '(위치 없음)';
      if (byPos[p]) addIssue('input|dup|' + p, { code: 'conn_dup_pos', kind: '입력', pn: str(c.pn), where: [p], candidates: [], manual: null });
      else byPos[p] = [];
    });
    (input.circuits || []).forEach(function (cc, idx) {
      var p = str(cc.pos);
      if (byPos[p]) byPos[p].push(cc);
      else addIssue('input|nocon|' + p, { code: 'circuit_no_conn', kind: '입력', pn: '', where: [p + ' 회로' + (str(cc.pole) ? ' ' + str(cc.pole) + '극' : ' ' + (idx + 1) + '행')], qty: 1, candidates: [], manual: null });
    });

    var seenPos = {};
    (input.connectors || []).forEach(function (c) {
      var pos = str(c.pos) || '(위치 없음)';
      if (seenPos[pos]) return; seenPos[pos] = 1;
      var circ = byPos[pos] || [];
      var poles = parseInt(c.poles, 10);
      // 1) 커넥터 본체
      var cr = resolvePart(c.pn, '커넥터', pos, 1, ['cust', 'mfr', 'code']);
      pushLine('커넥터', pos, str(c.pn), 1, cr, '');

      // 2) 사용 극 수
      var poleSet = {}, used = 0, dup = false;
      circ.forEach(function (x) {
        var pl = str(x.pole);
        if (!pl) { used++; return; }
        if (poleSet[pl]) { dup = true; return; }
        poleSet[pl] = 1; used++;
      });
      if (dup) addIssue('input|poledup|' + pos, { code: 'pole_dup', kind: '입력', pn: str(c.pn), where: [pos], candidates: [], manual: null });
      if (poles > 0 && used > poles) addIssue('input|poleover|' + pos, { code: 'pole_over', kind: '입력', pn: str(c.pn), where: [pos + ' (극수 ' + poles + ', 사용 ' + used + ')'], candidates: [], manual: null });

      // 커넥터 품번이 확정되지 않으면 종속 자재 산출은 보류
      if (!cr.ok) {
        circ.forEach(function (x) { circuitsOut.push({ pos: pos, pole: str(x.pole), spec: str(x.spec), wire: str(x.wire), state: 'pending', note: '커넥터 품번 확정 후 산출' }); });
        return;
      }
      var keys = [cr.mfr, str(c.pn)];

      // 3) 회로를 (규격, 전선 종류)로 묶어 터미널·실 산출
      var groups = {}, gl = [];
      circ.forEach(function (x) {
        var sp = parseSpec(x.spec);
        var gk = (sp == null ? 'bad:' + str(x.spec) : fmtSpec(sp)) + '|' + normalizePn(x.wire, st.norm);
        if (!groups[gk]) { groups[gk] = { spec: sp, rawSpec: str(x.spec), wire: str(x.wire), list: [] }; gl.push(groups[gk]); }
        groups[gk].list.push(x);
      });
      gl.forEach(function (g) {
        var n = g.list.length;
        var specTxt = (g.spec == null ? g.rawSpec || '(빈 규격)' : fmtSpec(g.spec) + st.unit) + (g.wire ? ' ' + g.wire : '');
        var where = pos + ' ' + specTxt;
        var sl = specLookup(keys, g.spec, g.wire, specRows, st);
        var termPn = null, sealPn = null, specBasis = '', decided = false;
        if (!sl.issue) {
          termPn = sl.terminals[0].pn; sealPn = sl.seals[0].pn; decided = true;
          specBasis = 'App Spec ' + sl.terminals[0].rows.join('·') + '행';
        } else {
          var skey = 'spec|' + pos + '|' + (g.spec == null ? 'bad:' + g.rawSpec : fmtSpec(g.spec)) + '|' + normalizePn(g.wire, st.norm);
          var cands = [], manual = null;
          if (sl.issue === 'spec_multi_term' || sl.issue === 'spec_boundary') {
            sl.terminals.forEach(function (t) {
              // 터미널별로 함께 쓰는 실 목록(같은 App Spec 행 기준)
              var sealsFor = {};
              sl.rows.forEach(function (r) { if (r.term.some(function (x) { return normalizePn(x, st.norm) === normalizePn(t.pn, st.norm); })) (r.seal.length ? r.seal : ['']).forEach(function (s) { sealsFor[s] = 1; }); });
              Object.keys(sealsFor).forEach(function (s) {
                cands.push({ id: t.pn + '|' + s, term: t.pn, seal: s, label: '터미널 ' + t.pn + ' + ' + (s ? '실 ' + s : '실 없음'), rows: t.rows });
              });
            });
          } else if (sl.issue === 'spec_multi_seal') {
            sl.seals.forEach(function (s) { cands.push({ id: sl.terminals[0].pn + '|' + s.pn, term: sl.terminals[0].pn, seal: s.pn, label: '터미널 ' + sl.terminals[0].pn + ' + ' + (s.pn ? '실 ' + s.pn : '실 없음'), rows: s.rows }); });
          }
          manual = 'termseal'; // 어느 사유든 담당자가 터미널·실 품번을 직접 적을 수 있음
          var iss = addIssue(skey, { code: sl.issue, kind: '종속 자재', pn: cr.mfr || str(c.pn), where: [where], qty: n, candidates: cands, manual: manual });
          var ch = iss.choice;
          if (ch && ch.pick) {
            var p = cands.filter(function (x) { return x.id === ch.pick; })[0];
            if (p) { termPn = p.term; sealPn = p.seal; decided = true; iss.resolved = true; specBasis = 'App Spec ' + p.rows.join('·') + '행 (담당자 선택)'; }
          }
          if (!decided && ch && ch.manual && str(ch.manual.term)) {
            termPn = str(ch.manual.term); sealPn = str(ch.manual.seal); decided = true; iss.resolved = true; specBasis = '담당자 직접 입력';
          }
          if (!decided) {
            g.list.forEach(function (x) { circuitsOut.push({ pos: pos, pole: str(x.pole), spec: str(x.spec), wire: str(x.wire), state: 'issue', note: REASON[sl.issue], issueKey: skey }); });
            pushLine('터미널', pos, '', n, null, where);
            lines[lines.length - 1].issueKey = skey;
            return;
          }
        }
        g.list.forEach(function (x) { circuitsOut.push({ pos: pos, pole: str(x.pole), spec: str(x.spec), wire: str(x.wire), state: 'ok', term: termPn, seal: sealPn || '', note: specBasis }); });
        var tr = resolvePart(termPn, '터미널', where, n, ['mfr', 'cust', 'code']);
        pushLine('터미널', pos, termPn, n, tr, specBasis);
        if (sealPn) {
          var sr = resolvePart(sealPn, '실', where, n, ['mfr', 'cust', 'code']);
          pushLine('실', pos, sealPn, n, sr, specBasis);
        }
      });

      // 4) 방수전 — 설정에서 켠 경우, 빈 극 수만큼
      if (st.plug && poles > 0 && used < poles) {
        var empty = poles - used;
        var nkeys = {};
        keys.forEach(function (k) { if (str(k)) nkeys[normalizePn(k, st.norm)] = 1; });
        var plugs = [], pm = {};
        specRows.forEach(function (r) {
          if (!r.conn.some(function (x) { return nkeys[normalizePn(x, st.norm)]; })) return;
          r.plug.forEach(function (pl) {
            var k = normalizePn(pl, st.norm);
            if (!pm[k]) { pm[k] = { id: pl, pn: pl, label: pl, rows: [] }; plugs.push(pm[k]); }
            pm[k].rows.push(r.row);
          });
        });
        if (!plugs.length) return; // 방수전이 적힌 행이 없으면 비방수 커넥터로 보고 넣지 않음
        var plugPn = null, pBasis = '';
        if (plugs.length === 1) { plugPn = plugs[0].pn; pBasis = 'App Spec ' + plugs[0].rows.join('·') + '행 · 빈 극 ' + empty; }
        else {
          var pkey = 'plug|' + pos;
          var pi = addIssue(pkey, { code: 'plug_multi', kind: '방수전', pn: cr.mfr, where: [pos + ' 빈 극 ' + empty], qty: empty, candidates: plugs, manual: 'plug' });
          if (pi.choice && pi.choice.pick) {
            var pp = plugs.filter(function (x) { return x.id === pi.choice.pick; })[0];
            if (pp) { plugPn = pp.pn; pi.resolved = true; pBasis = 'App Spec ' + pp.rows.join('·') + '행 (담당자 선택) · 빈 극 ' + empty; }
          }
          if (!plugPn && pi.choice && pi.choice.manual && str(pi.choice.manual.plug)) { plugPn = str(pi.choice.manual.plug); pi.resolved = true; pBasis = '담당자 직접 입력 · 빈 극 ' + empty; }
          if (!plugPn) { pushLine('방수전', pos, '', empty, null, pos + ' 빈 극 ' + empty); lines[lines.length - 1].issueKey = pkey; return; }
        }
        var prr = resolvePart(plugPn, '방수전', pos + ' 빈 극', empty, ['mfr', 'cust', 'code']);
        pushLine('방수전', pos, plugPn, empty, prr, pBasis);
      }
    });

    var open = issues.filter(function (i) { return !i.resolved; }).length;
    return { lines: lines, issues: issues, circuits: circuitsOut, open: open, settings: st };
  }

  // ── BOM 집계 ───────────────────────────────────────────────────
  // 같은 구분·사내 코드(없으면 품번)끼리 수량 합산. 여유율은 종속 자재(터미널·실·방수전)에만, 올림.
  function aggregateBom(lines, settings) {
    var st = mergeSettings(settings);
    var map = {}, out = [];
    lines.forEach(function (l) {
      var id = l.ok ? l.kind + '|' + (l.code || 'pn:' + normalizePn(l.mfr || l.srcPn, st.norm)) : l.kind + '|issue|' + (l.issueKey || l.pos);
      if (!map[id]) {
        map[id] = { kind: l.kind, code: l.code, mfr: l.mfr, srcPns: [], name: l.name, baseQty: 0, positions: [], basis: [], statuses: {}, ok: l.ok, issueKey: l.issueKey };
        out.push(map[id]);
      }
      var m = map[id];
      m.baseQty += l.qty;
      if (l.srcPn && m.srcPns.indexOf(l.srcPn) < 0) m.srcPns.push(l.srcPn);
      if (m.positions.indexOf(l.pos) < 0) m.positions.push(l.pos);
      var b = l.pos + ': ' + (l.basis || '-');
      if (m.basis.indexOf(b) < 0) m.basis.push(b);
      m.statuses[l.status] = 1;
    });
    out.forEach(function (m) {
      var dep = m.kind !== '커넥터';
      m.qty = dep && st.margin ? Math.ceil(m.baseQty * (1 + st.margin / 100) - 1e-9) : m.baseQty;
      m.check = !m.ok ? '확인 필요' : m.statuses.manual ? '직접 입력' : m.statuses.chosen ? '담당자 선택' : m.statuses.normalized ? '표기 차이 매칭' : '자동';
    });
    out.sort(function (a, b) {
      var k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      if (k) return k;
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return (a.code || '~').localeCompare(b.code || '~');
    });
    out.forEach(function (m, i) { m.no = i + 1; });
    return out;
  }

  // ── 부품 LIST 붙여넣기(엑셀에서 복사한 탭 구분 글) ─────────────
  // cols: 열 순서 키 배열. 첫 줄이 머리행(숫자 칸이 없고 머리 낱말이 있음)이면 건너뜀
  function parsePaste(text, cols, headerWords) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var rows = [];
    lines.forEach(function (ln, i) {
      if (!ln.trim()) return;
      var cells = ln.indexOf('\t') >= 0 ? ln.split('\t') : ln.split(/\s{2,}|,/);
      if (i === 0 || rows.length === 0) {
        var joined = headerKey(cells.join(''));
        if ((headerWords || []).some(function (w) { return joined.indexOf(headerKey(w)) >= 0; })) return;
      }
      var o = {};
      cols.forEach(function (c, j) { o[c] = str(cells[j]); });
      if (cols.some(function (c) { return o[c]; })) rows.push(o);
    });
    return rows;
  }

  // ── 내보내기용 시트 ─────────────────────────────────────────────
  function bomSheets(result, bom, header) {
    var hd = header || {};
    var info = [
      ['BOM 구분', hd.bomType || '신규'],
      ['도면 번호', hd.drawingNo || ''],
      ['도면명', hd.drawingName || ''],
      ['REV', hd.rev || ''],
      ['고객사', hd.customer || ''],
      ['산출일', hd.date || ''],
      ['미해결 확인 대상', result.open]
    ];
    var bomRows = [['번호', '구분', '사내 자재 코드', '제조사 품번', '도면/산출 품번', '품명', '수량', '단위', '사용 위치', '확인 상태', '근거']];
    bom.forEach(function (b) {
      bomRows.push([b.no, b.kind, b.code, b.mfr, b.srcPns.join(', '), b.name, b.qty, 'EA', b.positions.join(', '), b.check, b.basis.join(' / ')]);
    });
    var iss = [['구분', '품번', '위치', '사유', '후보', '처리']];
    result.issues.forEach(function (i) {
      iss.push([i.kind, i.pn, i.where.join(', '), i.reason, (i.candidates || []).map(function (c) { return c.label; }).join(' / '), i.resolved ? '처리됨' : '미해결']);
    });
    var circ = [['커넥터 위치', '극 번호', '전선 규격', '전선 종류', '터미널', '와이어 실', '상태', '근거·메모']];
    result.circuits.forEach(function (c) {
      circ.push([c.pos, c.pole, c.spec, c.wire, c.term || '', c.seal || '', c.state === 'ok' ? '산출' : c.state === 'pending' ? '보류' : '확인 필요', c.note || '']);
    });
    return { 'BOM': info.concat([[]], bomRows), '확인 대상': iss, '회로별 산출 근거': circ };
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(aoa) { return '\ufeff' + aoa.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }

  var api = {
    MAP_FIELDS: MAP_FIELDS, SPEC_FIELDS: SPEC_FIELDS, KIND_ORDER: KIND_ORDER, REASON: REASON,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, mergeSettings: mergeSettings,
    normalizePn: normalizePn, splitMulti: splitMulti, parseSpec: parseSpec, parseRange: parseRange,
    guessMapping: guessMapping, detectHeaderRow: detectHeaderRow, checkMapping: checkMapping,
    buildMapTable: buildMapTable, buildSpecTable: buildSpecTable,
    lookupPart: lookupPart, specLookup: specLookup, compute: compute, aggregateBom: aggregateBom,
    parsePaste: parsePaste, bomSheets: bomSheets, toCsv: toCsv, fmtSpec: fmtSpec
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BomLogic = api;
})(typeof window !== 'undefined' ? window : this);
