/*
 * 고객사별 학습(규칙) · 도면 표 추출 · 커넥터 부자재 — 순수 로직 모듈 (화면·저장소·pdf.js 와 무관)
 * 2026-09-29 저녁 수강생 답 반영(기획서 v0.3 12장).
 *
 *  1) 고객사 프로필 — 「고객사별로 학습시켜 쓰고 싶다」를 기계학습이 아니라 「예시로 배우는 규칙」으로 구현합니다.
 *     담당자가 도면 위 글자를 눌러 「제조사 품번 예」「고객사 품번 예」「고객사 알아보기 글자」「품번 아님」으로 알려 주면
 *     품번 모양(정규식)·표제란 글자·제외 목록이 고객사별로 쌓이고, 같은 고객사 도면을 올리면 저절로 적용됩니다.
 *  2) 도면 표(부품표) 추출 — 벡터 PDF 의 표 영역에서 머리글·열 위치를 찾아 행마다 품번·수량을 뽑습니다.
 *  3) 커넥터 → 부자재 — 사내 DB 처럼 커넥터 품번으로 관련 부자재(터미널·실·리테이너 등)를 찾아 자재 목록에 펼칩니다.
 *
 * 브라우저에서는 window.DrawLearn, Node(테스트)에서는 module.exports 로 씁니다.
 */
(function (root) {
  'use strict';
  var isNode = typeof module !== 'undefined' && module.exports;
  var B = isNode ? require('./logic.js') : root.BomLogic;
  var DL = isNode ? require('./drawing-logic.js') : root.DrawLogic;
  var str = DL.str, round2 = DL.round2;
  var NORM_ALL = { space: true, hyphen: true, upper: true, dot: true };
  function keyText(s) { return str(s).toUpperCase().replace(/[\s 　]+/g, ''); }

  // ── 1) 고객사 프로필 ─────────────────────────────────────────
  var ROLE_TEXT = { mfr: '제조사 품번 예', cust: '고객사 품번 예', keyword: '고객사 알아보기 글자', notpn: '품번 아님' };
  function newProfile(name, id) {
    return {
      id: id || ('p' + Date.now().toString(36)), name: str(name), keywords: [], layout: 'label',
      examples: { mfr: [], cust: [] }, patterns: [], strict: false, xref: [], table: { roles: {} }, exclude: '', at: ''
    };
  }
  // 저장된 값·가져온 파일을 안전한 모양으로 맞춤
  function normalizeProfile(p) {
    var d = newProfile('', p && p.id);
    if (!p || typeof p !== 'object') return d;
    d.name = str(p.name);
    d.keywords = (Array.isArray(p.keywords) ? p.keywords : []).map(str).filter(Boolean);
    d.layout = p.layout === 'table' ? 'table' : 'label';
    var ex = p.examples || {};
    d.examples = { mfr: (ex.mfr || []).map(str).filter(Boolean), cust: (ex.cust || []).map(str).filter(Boolean) };
    d.patterns = (Array.isArray(p.patterns) ? p.patterns : []).filter(function (x) { return x && x.re && validRe(x.re); })
      .map(function (x) { return { re: String(x.re), type: x.type === 'cust' ? 'cust' : 'mfr', auto: !!x.auto }; });
    d.strict = !!p.strict;
    d.xref = (Array.isArray(p.xref) ? p.xref : []).filter(function (x) { return x && str(x.cust); })
      .map(function (x) { return { cust: str(x.cust), mfr: str(x.mfr), code: str(x.code), name: str(x.name) }; });
    d.table = { roles: {} };
    var roles = (p.table && p.table.roles) || {};
    Object.keys(roles).forEach(function (k) { if (TABLE_ROLES[roles[k]]) d.table.roles[keyText(k)] = roles[k]; });
    d.exclude = String(p.exclude || '');
    d.at = str(p.at);
    return d;
  }
  function validRe(re) { try { new RegExp(re, 'i'); return true; } catch (e) { return false; } }

  // 글자 한 개의 종류: 영문 A · 숫자 9 · 그 밖의 글자는 그대로(하이픈·점 등)
  function charClass(c) { return /[A-Za-z]/.test(c) ? 'A' : /[0-9]/.test(c) ? '9' : c; }
  // 「CA-1001」 → [{c:'A',n:2},{c:'-',n:1},{c:'9',n:4}]
  function shapeRuns(s) {
    var out = [];
    String(s).trim().split('').forEach(function (ch) {
      var c = /\s/.test(ch) ? ' ' : charClass(ch), last = out[out.length - 1];
      if (last && last.c === c) last.n++; else out.push({ c: c, n: 1 });
    });
    return out;
  }
  function escRe(c) { return c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  // 예시 품번 여러 개 → 품번 모양 정규식. 모양(영문·숫자·기호 순서)이 같은 예시끼리 묶어 길이 범위를 넓힙니다.
  //  CA-1001, CL-20015 → ^[A-Z]{2}-[0-9]{4,5}$ / MX-8P-040 → ^[A-Z]{2}-[0-9][A-Z]-[0-9]{3}$
  // 영문 자리는 어떤 영문이든 받습니다(예시 하나로 CA 만 받게 하면 같은 고객사의 CL-… 을 놓침). 더 좁히려면 식을 직접 고칩니다.
  function inferPatterns(examples) {
    var groups = {}, order = [];
    (examples || []).map(str).filter(Boolean).forEach(function (ex) {
      var runs = shapeRuns(ex), sig = runs.map(function (r) { return r.c; }).join('\u0001');
      if (!groups[sig]) { groups[sig] = runs.map(function (r) { return { c: r.c, min: r.n, max: r.n }; }); order.push(sig); }
      else runs.forEach(function (r, i) { var g = groups[sig][i]; g.min = Math.min(g.min, r.n); g.max = Math.max(g.max, r.n); });
    });
    return order.map(function (sig) {
      return '^' + groups[sig].map(function (g) {
        var q = g.min === g.max ? (g.min === 1 ? '' : '{' + g.min + '}') : '{' + g.min + ',' + g.max + '}';
        if (g.c === 'A') return '[A-Z]' + q;
        if (g.c === '9') return '[0-9]' + q;
        if (g.c === ' ') return '\\s' + (q || '') ;
        return escRe(g.c) + q;
      }).join('') + '$';
    });
  }
  // 예시가 바뀔 때 자동으로 만든 식만 다시 만들고, 담당자가 직접 적은 식은 그대로 둡니다
  function rebuildPatterns(p) {
    var manual = (p.patterns || []).filter(function (x) { return !x.auto; });
    var auto = [];
    ['mfr', 'cust'].forEach(function (t) {
      inferPatterns(p.examples[t]).forEach(function (re) { auto.push({ re: re, type: t, auto: true }); });
    });
    p.patterns = manual.concat(auto);
    return p;
  }
  // 도면 위 글자를 눌러 알려 준 것 한 개를 프로필에 넣음. role: mfr | cust | keyword | notpn
  function learnExample(p, text, role) {
    var t = str(text);
    if (!t || !ROLE_TEXT[role]) return p;
    function addTo(list) { if (list.map(keyText).indexOf(keyText(t)) < 0) list.push(t); }
    if (role === 'mfr' || role === 'cust') {
      addTo(p.examples[role]);
      var other = role === 'mfr' ? 'cust' : 'mfr';
      p.examples[other] = p.examples[other].filter(function (x) { return keyText(x) !== keyText(t); });
      rebuildPatterns(p);
    } else if (role === 'keyword') addTo(p.keywords);
    else if (role === 'notpn') {
      var ex = DL.excludeList(p.exclude);
      if (ex.map(keyText).indexOf(keyText(t)) < 0) ex.push(t);
      p.exclude = ex.join('\n');
    }
    return p;
  }
  function forgetExample(p, text, role) {
    var k = keyText(text);
    if (role === 'mfr' || role === 'cust') { p.examples[role] = p.examples[role].filter(function (x) { return keyText(x) !== k; }); rebuildPatterns(p); }
    else if (role === 'keyword') p.keywords = p.keywords.filter(function (x) { return keyText(x) !== k; });
    else if (role === 'notpn') p.exclude = DL.excludeList(p.exclude).filter(function (x) { return keyText(x) !== k; }).join('\n');
    return p;
  }
  // 제조사 품번 모양과 고객사 품번 모양이 똑같은 식 — 이 모양의 글자는 모양만으로 구분이 안 됨(마스터·대조표로 정함)
  function patternConflicts(p) {
    var by = { mfr: {}, cust: {} };
    (p.patterns || []).forEach(function (x) { by[x.type === 'cust' ? 'cust' : 'mfr'][x.re] = 1; });
    return Object.keys(by.mfr).filter(function (re) { return by.cust[re]; });
  }
  // 도면 글자 전체에서 어느 고객사 도면인지 알아봄 — 프로필의 「알아보기 글자」가 가장 많이 나온 프로필
  // texts: 글자 조각 문자열 목록. 결과: { profile, hits, tie } | null
  function detectProfile(texts, profiles) {
    var all = keyText((texts || []).join(' ')), best = null, bestN = 0, tie = false;
    (profiles || []).forEach(function (p) {
      var n = (p.keywords || []).filter(function (k) { var kk = keyText(k); return kk && all.indexOf(kk) >= 0; }).length;
      if (n > bestN) { best = p; bestN = n; tie = false; } else if (n && n === bestN) tie = true;
    });
    return best ? { profile: best, hits: bestN, tie: tie } : null;
  }

  // ── 고객사 대조표(고객사 품번 → 제조사 품번) ─────────────────
  var XREF_FIELDS = [
    { key: 'cust', label: '고객사 품번', need: true, syn: ['고객사품번', '고객품번', '고객사p/n', 'customerp/n', 'customerpart', 'custpn', 'custp/n'] },
    { key: 'mfr', label: '제조사 품번', need: true, syn: ['제조사품번', '메이커품번', '제조사p/n', 'makerp/n', 'mfrpn', 'mfrp/n', 'makerpart', '실제품번'] },
    { key: 'code', label: '사내 자재 코드', need: false, syn: ['사내자재코드', '사내코드', '자재코드', 'itemcode'] },
    { key: 'name', label: '품명', need: false, syn: ['품명', '자재명', 'description', 'desc'] }
  ];
  // 엑셀·CSV 표(aoa) → [{cust,mfr,code,name}]. 머리행·열은 이름으로 찾고, 못 찾으면 앞 두 열을 고객사·제조사로 봅니다.
  function parseXref(aoa) {
    aoa = aoa || [];
    var hr = B.detectHeaderRow(aoa, XREF_FIELDS), mp = B.guessMapping(aoa[hr] || [], XREF_FIELDS);
    var start = hr + 1;
    if (mp.cust === undefined || mp.mfr === undefined) { mp = { cust: 0, mfr: 1, code: 2, name: 3 }; start = hr + (looksHeader(aoa[hr]) ? 1 : 0); }
    var out = [];
    for (var i = start; i < aoa.length; i++) {
      var r = aoa[i] || [], o = { cust: str(r[mp.cust]), mfr: str(r[mp.mfr]), code: mp.code === undefined ? '' : str(r[mp.code]), name: mp.name === undefined ? '' : str(r[mp.name]) };
      if (o.cust && (o.mfr || o.code)) out.push(o);
    }
    return out;
  }
  function looksHeader(row) { return (row || []).some(function (c) { return /[가-힣]|p\/?n|part|품번/i.test(str(c)) && !/\d{3}/.test(str(c)); }); }
  // 대조표 합치기 — 같은 고객사 품번은 새 값으로 바꿈
  function mergeXref(list, add, norm) {
    var idx = {}, out = [];
    (list || []).concat(add || []).forEach(function (x) {
      var k = B.normalizePn(x.cust, norm || NORM_ALL);
      if (idx[k] != null) out[idx[k]] = x; else { idx[k] = out.length; out.push(x); }
    });
    return out;
  }

  // ── 2) 도면 표(부품표) 추출 ─────────────────────────────────
  var TABLE_ROLES = { item: '번호', cust: '고객사 품번', mfr: '제조사 품번', pn: '품번(구분 모름)', desc: '품명', qty: '수량', skip: '쓰지 않음' };
  // 머리글 → 역할 짐작(긴 낱말부터). 저장된 역할(roles: {머리글: 역할})이 있으면 그것이 먼저
  var ROLE_SYN = [
    ['cust', ['CUSTOMERP/N', 'CUSTOMERPARTNO', 'CUSTOMERPN', 'CUSTP/N', 'CUSTPN', 'OEMP/N', '고객사품번', '고객품번']],
    ['mfr', ['MANUFACTURERP/N', 'MAKERP/N', 'MAKERPN', 'MFRP/N', 'MFRPN', 'VENDORP/N', 'SUPPLIERP/N', '제조사품번', '메이커품번']],
    ['desc', ['DESCRIPTION', 'PARTNAME', 'DESC', 'NAME', '품명', '명칭', '자재명']],
    ['qty', ["Q'TY", 'QTY', 'QUANTITY', '수량', '소요량']],
    ['item', ['ITEMNO', 'ITEM', 'NO.', 'NO', '번호', '순번']],
    ['pn', ['PARTNUMBER', 'PARTNO', 'P/N', 'PN', '품번']]
  ];
  function guessRole(text, saved) {
    var k = keyText(text);
    if (!k) return 'skip';
    if (saved && saved[k] && TABLE_ROLES[saved[k]]) return saved[k];
    for (var i = 0; i < ROLE_SYN.length; i++) {
      var syn = ROLE_SYN[i][1];
      for (var j = 0; j < syn.length; j++) {
        var s = syn[j];
        if (k === s || (s.length >= 3 && k.indexOf(s) >= 0)) return ROLE_SYN[i][0];
      }
    }
    return 'skip';
  }
  function guessRoles(headerTexts, saved) {
    var used = {};
    return headerTexts.map(function (t) {
      var r = guessRole(t, saved);
      if (r !== 'skip' && r !== 'pn' && used[r]) r = 'skip';   // 같은 역할 두 열이면 뒤 열은 쓰지 않음(사람이 고침)
      used[r] = 1;
      return r;
    });
  }
  function inside(it, rg) {
    var cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    return cx >= rg.x && cx <= rg.x + rg.w && cy >= rg.y && cy <= rg.y + rg.h;
  }
  // 글자 조각 → 줄(같은 높이끼리)
  function toLines(cells) {
    var sorted = cells.slice().sort(function (a, b) { return (a.y + a.h / 2) - (b.y + b.h / 2); }), lines = [];
    sorted.forEach(function (c) {
      var cy = c.y + c.h / 2, last = lines[lines.length - 1];
      if (last && Math.abs(cy - last.cy) <= Math.max(last.h, c.h) * 0.5) { last.cells.push(c); last.h = Math.max(last.h, c.h); }
      else lines.push({ cy: cy, h: c.h, cells: [c] });
    });
    lines.forEach(function (l) { l.cells.sort(function (a, b) { return a.x - b.x; }); l.y = Math.min.apply(null, l.cells.map(function (c) { return c.y; })); });
    return lines;
  }
  // 표 영역 안의 글자로 표를 읽음.
  // items: PDF 글자 조각 [{page,str,x,y,w,h}], opts: { page, region{x,y,w,h}(없으면 쪽 전체), headerHints[](머리글 글자), saved(roles) }
  // 결과: { page, region, header:[{text,x,y,w,h}], cols:[{left,right}], rows:[{ y, cells:[{text,x,y,w,h}|null] }] } | null
  function parseTable(items, opts) {
    opts = opts || {};
    var page = opts.page || 1, rg = opts.region || null;
    var mine = (items || []).filter(function (it) { return (it.page || 1) === page && str(it.str) && !it.vert && (!rg || inside(it, rg)); });
    if (!mine.length) return null;
    var cells = DL.mergeTextItems(mine, { maxGap: 0.35 }).map(function (s) { return { text: str(s.str), x: s.x, y: s.y, w: s.w, h: s.h }; }).filter(function (c) { return c.text; });
    var lines = toLines(cells);
    // 머리행: 역할을 가장 많이 짐작할 수 있는 줄(같으면 위쪽). 머리글 힌트가 있으면 힌트와 맞는 수를 먼저 봅니다
    var hints = (opts.headerHints || []).map(keyText).filter(Boolean), best = -1, bestScore = 0;
    lines.forEach(function (l, i) {
      if (l.cells.length < 2) return;
      var roles = guessRoles(l.cells.map(function (c) { return c.text; }), opts.saved);
      var sc = roles.filter(function (r) { return r !== 'skip'; }).length;
      if (hints.length) sc += 10 * l.cells.filter(function (c) { return hints.indexOf(keyText(c.text)) >= 0; }).length;
      if (sc > bestScore) { bestScore = sc; best = i; }
    });
    if (best < 0) return null;
    var head = lines[best], header = head.cells;
    // 열 경계: 이웃한 머리글 사이의 가운데
    var cols = header.map(function (c, i) {
      var left = i === 0 ? -Infinity : (header[i - 1].x + header[i - 1].w + c.x) / 2;
      var right = i === header.length - 1 ? Infinity : (c.x + c.w + header[i + 1].x) / 2;
      return { left: left, right: right };
    });
    var rows = [], prevBottom = head.y + head.h, rowGap = null;
    for (var i = best + 1; i < lines.length; i++) {
      var l = lines[i];
      var gap = l.y - prevBottom;
      // 영역을 주지 않았으면 줄 사이가 갑자기 크게 벌어지는 곳(표 끝)에서 멈춤
      if (!rg && rowGap != null && gap > Math.max(rowGap * 3, l.h * 2.5)) break;
      if (!rg && rowGap == null && gap > l.h * 4) break;
      var span = { left: header[0].x - l.h * 2, right: header[header.length - 1].x + header[header.length - 1].w + l.h * 8 };
      var cellsIn = l.cells.filter(function (c) { return c.x + c.w >= span.left && c.x <= span.right; });
      if (!cellsIn.length) continue;
      var row = header.map(function () { return null; });
      cellsIn.forEach(function (c) {
        var cx = c.x + c.w / 2, k = 0;
        for (var j = 0; j < cols.length; j++) if (cx >= cols[j].left && cx < cols[j].right) { k = j; break; }
        if (row[k]) { row[k] = { text: row[k].text + ' ' + c.text, x: row[k].x, y: Math.min(row[k].y, c.y), w: c.x + c.w - row[k].x, h: Math.max(row[k].h, c.h) }; }
        else row[k] = c;
      });
      rows.push({ y: l.y, cells: row });
      if (rowGap == null || gap < rowGap) rowGap = Math.max(gap, 0.5);
      prevBottom = l.y + l.h;
    }
    var all = [head].concat(rows.map(function (r) { return { y: r.y, h: Math.max.apply(null, r.cells.filter(Boolean).map(function (c) { return c.h; })), cells: r.cells.filter(Boolean) }; }));
    var xs = [], ys = [];
    all.forEach(function (l) { l.cells.forEach(function (c) { xs.push(c.x, c.x + c.w); ys.push(c.y, c.y + c.h); }); });
    var box = { x: round2(Math.min.apply(null, xs)), y: round2(Math.min.apply(null, ys)) };
    box.w = round2(Math.max.apply(null, xs) - box.x); box.h = round2(Math.max.apply(null, ys) - box.y);
    return {
      page: page, region: rg || box, found: box,
      header: header.map(function (c) { return { text: c.text, x: round2(c.x), y: round2(c.y), w: round2(c.w), h: round2(c.h) }; }),
      cols: cols, rows: rows
    };
  }
  // 표 → 도면 표시(marks). roles: 열마다 역할(item·cust·mfr·pn·desc·qty·skip)
  // 한 행에 제조사 품번이 있으면 그것을 표시 품번(pnType mfr)으로, 없으면 고객사 품번(pnType cust), 둘 다 없으면 품번 열(구분 모름)
  function tableMarks(table, roles) {
    if (!table) return [];
    function col(role) { return roles.indexOf(role); }
    var ci = col('cust'), mi = col('mfr'), pi = col('pn'), qi = col('qty'), di = col('desc'), ii = col('item');
    var out = [];
    table.rows.forEach(function (row) {
      function cell(i) { return i >= 0 ? row.cells[i] : null; }
      var m = cell(mi), c = cell(ci), p = cell(pi), use = null, type = '';
      if (m && m.text && !/^[-–—\s]*$/.test(m.text)) { use = m; type = 'mfr'; }
      else if (c && c.text && !/^[-–—\s]*$/.test(c.text)) { use = c; type = 'cust'; }
      else if (p && p.text) { use = p; type = ''; }
      if (!use) return;
      out.push({
        page: table.page, x: round2(use.x), y: round2(use.y), w: round2(use.w), h: round2(use.h), pn: use.text, src: 'table', pnType: type,
        custPn: c && c.text && !/^[-–—\s]*$/.test(c.text) ? c.text : '', mfrPn: m && m.text && !/^[-–—\s]*$/.test(m.text) ? m.text : '',
        qty: cell(qi) ? cell(qi).text : '', desc: cell(di) ? cell(di).text : '', item: cell(ii) ? cell(ii).text : ''
      });
    });
    return out;
  }
  // 프로필에 역할 저장(머리글 글자 → 역할). 다음 도면은 같은 머리글이면 저절로 같은 역할
  function saveRoles(p, header, roles) {
    header.forEach(function (h, i) { var k = keyText(h.text || h); if (k) p.table.roles[k] = roles[i]; });
    return p;
  }
  function headerHints(p) { return Object.keys((p && p.table && p.table.roles) || {}); }

  // ── 3) 커넥터 → 부자재 마스터 ────────────────────────────────
  // 사내 DB 에서 커넥터를 검색하면 관련 부자재가 함께 나오는 것을 흉내 낸 표(한 행 = 커넥터 하나의 부자재 하나)
  var SUB_FIELDS = [
    { key: 'conn', label: '커넥터 품번(제조사 품번 또는 사내 코드)', need: true, syn: ['커넥터품번', '커넥터', '상위품번', '모품번', 'connector', 'parentpart'] },
    { key: 'kind', label: '부자재 구분', need: false, syn: ['부자재구분', '부자재종류', '구분', '종류', 'type', 'category'] },
    { key: 'pn', label: '부자재 품번', need: true, syn: ['부자재품번', '부자재', '하위품번', '자품번', 'subpart', 'childpart'] },
    { key: 'code', label: '부자재 사내 코드', need: false, syn: ['부자재사내코드', '사내자재코드', '사내코드', '자재코드', 'itemcode'] },
    { key: 'qty', label: '커넥터 1개당 수량', need: false, syn: ['커넥터1개당수량', '개당수량', '소요량', '수량', 'qty'] },
    { key: 'name', label: '품명', need: false, syn: ['품명', '자재명', 'description', 'desc'] }
  ];
  function buildSubTable(aoa, headerRow, mapping) {
    var rows = [], skipped = 0;
    function cell(r, k) { return mapping[k] === undefined ? '' : str(r[mapping[k]]); }
    for (var i = headerRow + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var o = { row: i + 1, conn: cell(r, 'conn'), kind: cell(r, 'kind'), pn: cell(r, 'pn'), code: cell(r, 'code'), qty: cell(r, 'qty'), name: cell(r, 'name') };
      if (!o.conn || !(o.pn || o.code)) { if (r.some(function (c) { return str(c) !== ''; })) skipped++; continue; }
      rows.push(o);
    }
    return { rows: rows, skipped: skipped };
  }
  function perQty(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 1; }
  // 판별된 자재 한 개(제조사 품번·사내 코드·도면 표기 품번)로 부자재 찾기
  function subsFor(r, subRows, norm) {
    var keys = {};
    [r.mfr, r.code, r.pn].forEach(function (v) { if (str(v)) keys[B.normalizePn(v, norm || NORM_ALL)] = 1; });
    return (subRows || []).filter(function (s) { return keys[B.normalizePn(s.conn, norm || NORM_ALL)]; });
  }
  // 부자재를 펼친 자재 목록(BOM) — 도면 자재(품번별 합계) 아래에 그 커넥터의 부자재를 커넥터 수량 × 1개당 수량으로.
  // opts: { mapRows, norm, off: {품번 열쇠: true}(펼치지 않을 커넥터) }
  // 결과 lines: [{ level:'main'|'sub', parent, kind, pn, code, mfr, name, qty, status, note }]
  function expandBom(result, subRows, opts) {
    opts = opts || {};
    var norm = opts.norm, lines = [], off = opts.off || {};
    var groups = DL.groupByPart(result.rows);
    var byKey = {};
    result.rows.forEach(function (r) { if (r.pn && !byKey[r.key]) byKey[r.key] = r; });
    groups.forEach(function (g) {
      var r = byKey[DL.choiceKey(g.pn, norm)] || {};
      lines.push({ level: 'main', parent: '', kind: g.kind, pn: g.pn, code: g.code, mfr: g.mfr, name: g.name, qty: g.qty, status: DL.STATUS[g.status].long, note: '' });
      var subs = subsFor(r, subRows, norm);
      if (!subs.length) return;
      if (off[r.key]) { lines[lines.length - 1].note = '부자재 ' + subs.length + '종 — 펼치지 않음'; return; }
      lines[lines.length - 1].note = '부자재 ' + subs.length + '종 펼침';
      subs.forEach(function (s) {
        var code = s.code, status = '부자재(사내 DB)';
        if (!code && opts.mapRows) {
          var lk = B.lookupPart(s.pn, opts.mapRows, { order: ['mfr', 'code', 'cust'], norm: norm });
          if (lk.status !== 'none' && !lk.issue) code = lk.candidates[0].code;
          else status = lk.status === 'none' ? '부자재 — 사내 마스터에 없음' : '부자재 — 사내 코드 확인 필요';
        }
        lines.push({ level: 'sub', parent: g.pn, kind: s.kind, pn: s.pn, code: code, mfr: s.pn, name: s.name, qty: round2(g.qty * perQty(s.qty)), status: status, note: '1개당 ' + perQty(s.qty) });
      });
    });
    return lines;
  }
  function bomSheet(lines) {
    var aoa = [['구분', '상위 커넥터', '자재 종류', '품번', '사내 자재 코드', '품명', '수량', '신규 여부·출처', '비고']];
    lines.forEach(function (l) {
      aoa.push([l.level === 'main' ? '도면 자재' : '└ 부자재', l.parent, l.kind, l.pn, l.code, l.name, l.qty, l.status, l.note]);
    });
    return aoa;
  }

  var api = {
    ROLE_TEXT: ROLE_TEXT, TABLE_ROLES: TABLE_ROLES, XREF_FIELDS: XREF_FIELDS, SUB_FIELDS: SUB_FIELDS,
    keyText: keyText, newProfile: newProfile, normalizeProfile: normalizeProfile, shapeRuns: shapeRuns,
    inferPatterns: inferPatterns, rebuildPatterns: rebuildPatterns, patternConflicts: patternConflicts, learnExample: learnExample, forgetExample: forgetExample,
    detectProfile: detectProfile, parseXref: parseXref, mergeXref: mergeXref, validRe: validRe,
    guessRole: guessRole, guessRoles: guessRoles, parseTable: parseTable, tableMarks: tableMarks, saveRoles: saveRoles, headerHints: headerHints,
    buildSubTable: buildSubTable, subsFor: subsFor, expandBom: expandBom, bomSheet: bomSheet
  };
  if (isNode) module.exports = api;
  else root.DrawLearn = api;
})(typeof window !== 'undefined' ? window : this);
