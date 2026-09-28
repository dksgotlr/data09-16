/* 하네스 BOM 산출 — 화면 (1단계). 로직은 js/logic.js(BomLogic) */
(function () {
  'use strict';
  var L = window.BomLogic, S = window.BomSample, Store = window.BomStore;
  var main = document.getElementById('main');

  // ── 상태 ──────────────────────────────────────────────────────
  function emptyParts() {
    return { header: { drawingNo: '', drawingName: '', rev: '', customer: '', bomType: '신규' }, connectors: [], circuits: [] };
  }
  function emptyState() {
    return { masters: { map: null, spec: null }, parts: emptyParts(), settings: L.mergeSettings(null), choices: {}, sample: {} };
  }
  var state = (function () {
    var s = Store.load(), d = emptyState();
    if (!s) return d;
    d.masters = s.masters || d.masters;
    d.parts = s.parts || d.parts;
    d.parts.header = Object.assign(emptyParts().header, d.parts.header || {});
    d.settings = L.mergeSettings(s.settings);
    d.choices = s.choices || {};
    d.sample = s.sample || {};
    return d;
  })();
  var pending = null;         // 열 매핑 중인 파일(저장 안 함)
  var ui = { onlyOpen: false, preview: {} };

  function save() {
    var ok = Store.save(state);
    document.getElementById('storageBanner').hidden = ok && Store.available();
    document.getElementById('sampleBanner').hidden = !(state.sample.map || state.sample.spec || state.sample.parts);
  }

  // ── 도우미 ────────────────────────────────────────────────────
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  var toastTimer;
  function toast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function openDialog(title, content, buttons) {
    var d = document.getElementById('dialog');
    document.getElementById('dialogTitle').textContent = title;
    var c = document.getElementById('dialogContent'); c.innerHTML = ''; append(c, content);
    var a = document.getElementById('dialogActions'); a.innerHTML = '';
    (buttons || [{ label: '닫기', value: 'close' }]).forEach(function (b) {
      a.appendChild(h('button', { class: 'btn' + (b.primary ? ' btn-primary' : ''), value: b.value, text: b.label }));
    });
    return new Promise(function (resolve) {
      d.addEventListener('close', function once() { d.removeEventListener('close', once); resolve(d.returnValue); });
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    });
  }
  function confirmBox(title, text, okLabel) {
    return openDialog(title, h('p', { text: text }), [{ label: '취소', value: 'cancel' }, { label: okLabel || '확인', value: 'ok', primary: true }])
      .then(function (v) { return v === 'ok'; });
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function badge(text, kind) { return h('span', { class: 'badge b-' + kind, text: text }); }
  function tableWrap(head, rows, cls) {
    return h('div', { class: 'table-wrap' }, h('table', { class: cls || '' },
      h('thead', null, h('tr', null, head.map(function (x) { return typeof x === 'string' ? h('th', { text: x }) : x; }))),
      h('tbody', null, rows)));
  }
  function statusBadge(check) {
    return badge(check, check === '확인 필요' ? 'bad' : check === '자동' ? 'ok' : check === '표기 차이 매칭' ? 'warn' : 'info');
  }

  // ── 파일 읽기 ─────────────────────────────────────────────────
  function readWorkbook(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('파일을 읽지 못했습니다')); };
      fr.onload = function () {
        try {
          var buf = new Uint8Array(fr.result), wb;
          if (/\.csv$|\.txt$/i.test(file.name)) {
            var text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
            catch (e) { text = new TextDecoder('euc-kr').decode(buf); }
            wb = XLSX.read(text.replace(/^\ufeff/, ''), { type: 'string', raw: true });
          } else wb = XLSX.read(buf, { type: 'array' });
          var sheets = {};
          wb.SheetNames.forEach(function (n) { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); });
          resolve({ names: wb.SheetNames, sheets: sheets });
        } catch (e) { reject(new Error('엑셀·CSV 형식으로 읽지 못했습니다: ' + e.message)); }
      };
      fr.readAsArrayBuffer(file);
    });
  }
  function fieldsOf(kind) { return kind === 'map' ? L.MAP_FIELDS : L.SPEC_FIELDS; }
  function startPending(kind, fileName, wb) {
    var first = wb.names.filter(function (n) { return wb.sheets[n].length; })[0] || wb.names[0];
    pending = { kind: kind, fileName: fileName, names: wb.names, sheets: wb.sheets, sheet: first };
    guessPending();
  }
  function guessPending() {
    var aoa = pending.sheets[pending.sheet] || [];
    var f = fieldsOf(pending.kind);
    pending.headerRow = L.detectHeaderRow(aoa, f);
    pending.mapping = L.guessMapping(aoa[pending.headerRow] || [], f, Store.loadMappings()[pending.kind]);
  }
  function buildPending() {
    var aoa = pending.sheets[pending.sheet] || [];
    return pending.kind === 'map'
      ? L.buildMapTable(aoa, pending.headerRow, pending.mapping)
      : L.buildSpecTable(aoa, pending.headerRow, pending.mapping, state.settings.multiSep);
  }
  function confirmPending() {
    var f = fieldsOf(pending.kind);
    var miss = L.checkMapping(pending.mapping, f);
    if (miss.length) { toast('필수 항목을 연결해 주세요: ' + miss.join(', '), true); return; }
    var t = buildPending();
    if (!t.rows.length) { toast('불러올 행이 없습니다. 머리행 위치와 열 연결을 확인해 주세요.', true); return; }
    var headers = (pending.sheets[pending.sheet] || [])[pending.headerRow] || [];
    var names = {};
    Object.keys(pending.mapping).forEach(function (k) { names[k] = String(headers[pending.mapping[k]] || ''); });
    state.masters[pending.kind] = {
      fileName: pending.fileName, sheet: pending.sheet, headerRow: pending.headerRow, names: names,
      rows: t.rows, skipped: t.skipped, noRange: t.noRange || 0, badRange: t.badRange || [], at: today()
    };
    state.sample[pending.kind] = false;
    var all = Store.loadMappings(); all[pending.kind] = names; Store.saveMappings(all);
    var n = t.rows.length;
    pending = null;
    save(); render();
    toast(n + '행을 불러왔습니다. 열 연결은 다음 파일에도 다시 씁니다.');
  }

  // ── 예시 데이터 ───────────────────────────────────────────────
  function loadSample() {
    function build(kind, aoa) {
      var f = fieldsOf(kind), hr = L.detectHeaderRow(aoa, f), mp = L.guessMapping(aoa[hr], f);
      var t = kind === 'map' ? L.buildMapTable(aoa, hr, mp) : L.buildSpecTable(aoa, hr, mp, state.settings.multiSep);
      var names = {}; Object.keys(mp).forEach(function (k) { names[k] = String(aoa[hr][mp[k]]); });
      return { fileName: kind === 'map' ? '예시데이터_부품매핑마스터.xlsx' : '예시데이터_ApplicationSpec.xlsx', sheet: kind === 'map' ? '매핑마스터' : 'ApplicationSpec', headerRow: hr, names: names, rows: t.rows, skipped: t.skipped, noRange: t.noRange || 0, badRange: t.badRange || [], at: today() };
    }
    state.masters.map = build('map', S.mapAoa);
    state.masters.spec = build('spec', S.specAoa);
    state.parts = S.build();
    state.choices = {};
    state.sample = { map: true, spec: true, parts: true };
    pending = null;
    save();
  }
  function askLoadSample() {
    var has = state.masters.map || state.masters.spec || state.parts.connectors.length;
    (has ? confirmBox('예시 데이터 불러오기', '지금 불러온 마스터와 부품 LIST 를 예시 데이터로 바꿉니다. 계속할까요?', '바꾸기') : Promise.resolve(true))
      .then(function (ok) {
        if (!ok) return;
        loadSample();
        toast('예시 데이터를 불러왔습니다. 3. 검증·산출에서 확인 대상을 처리해 보세요.');
        if (location.hash === '#/masters') render(); else location.hash = '#/masters';
      });
  }

  // ── 1. 마스터 데이터 ──────────────────────────────────────────
  function renderMasters() {
    var wrap = [];
    wrap.push(h('div', { class: 'page-head' },
      h('h1', { text: '1. 마스터 데이터' }),
      h('button', { type: 'button', class: 'btn', onclick: askLoadSample, text: '예시 데이터 불러오기' })));
    wrap.push(h('p', { class: 'lead', text: '부품 매핑 마스터와 Application Spec 엑셀을 올리고, 실제 열 이름을 표준 항목에 연결합니다. 파일은 이 브라우저 안에서만 읽습니다.' }));
    if (!state.masters.map && !state.masters.spec && !pending) {
      wrap.push(h('div', { class: 'notice info' },
        h('p', null, '처음 쓰신다면 「예시 데이터 불러오기」로 흐름을 먼저 보실 수 있습니다. 가상의 품번 14행·Application Spec 7행·커넥터 5개 도면이 들어갑니다.'),
        h('p', { class: 'small' }, '예시 파일: ',
          h('a', { href: 'samples/예시데이터_부품매핑마스터.xlsx', text: '부품매핑마스터.xlsx' }), ' · ',
          h('a', { href: 'samples/예시데이터_ApplicationSpec.xlsx', text: 'ApplicationSpec.xlsx' }), ' · ',
          h('a', { href: 'samples/예시데이터_부품LIST_커넥터.csv', text: '부품LIST_커넥터.csv' }), ' · ',
          h('a', { href: 'samples/예시데이터_부품LIST_회로.csv', text: '부품LIST_회로.csv' }))));
    }
    wrap.push(h('div', { class: 'grid-2' }, masterCard('map'), masterCard('spec')));
    if (state.masters.map && state.masters.spec) {
      wrap.push(h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '#/parts', text: '다음: 2. 부품 LIST' })));
    }
    return wrap;
  }

  function masterCard(kind) {
    var m = state.masters[kind];
    var title = kind === 'map' ? '부품 매핑 마스터' : 'Application Spec';
    var desc = kind === 'map'
      ? '고객사 품번 – 제조사 품번 – 사내 자재 코드 대응표'
      : '커넥터 품번별 적용 터미널·와이어 실·전선 규격 범위(방수전이 있으면 함께)';
    var card = h('section', { class: 'card', 'aria-label': title });
    append(card, h('h2', null, title, ' ', m ? badge(state.sample[kind] ? '예시 데이터' : '불러옴', state.sample[kind] ? 'warn' : 'ok') : badge('아직 없음', 'bad')));
    append(card, h('p', { class: 'muted small', text: desc }));
    if (m) {
      var f = fieldsOf(kind);
      append(card, h('p', { class: 'small' }, h('b', { text: m.fileName }), ' · 시트 ' + m.sheet + ' · 머리행 ' + (m.headerRow + 1) + '행 · ',
        h('b', { text: m.rows.length + '행' }), ' 불러옴' + (m.skipped ? ' · 건너뛴 행 ' + m.skipped : '') + ' · ' + m.at));
      if (m.badRange && m.badRange.length) append(card, h('div', { class: 'notice warn small', text: '전선 규격을 숫자로 읽지 못해 건너뛴 행: ' + m.badRange.join(', ') + '행' }));
      if (m.noRange) append(card, h('div', { class: 'notice warn small', text: '전선 규격 범위가 비어 있는 행 ' + m.noRange + '개는 모든 규격에 적용되는 것으로 봅니다.' }));
      append(card, h('ul', { class: 'small' }, f.filter(function (x) { return m.names[x.key]; }).map(function (x) {
        return h('li', null, x.label + ' ← ', h('code', { text: m.names[x.key] }));
      })));
      var acts = h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-small', text: ui.preview[kind] ? '표 닫기' : '표 보기', onclick: function () { ui.preview[kind] = !ui.preview[kind]; render(); } }),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', text: '지우기', onclick: function () {
          confirmBox(title + ' 지우기', '불러온 ' + title + ' 를 지웁니다. 열 연결 설정은 남습니다.', '지우기').then(function (ok) {
            if (!ok) return; state.masters[kind] = null; state.sample[kind] = false; save(); render();
          });
        } }));
      append(card, acts);
      if (ui.preview[kind]) append(card, masterPreview(kind, m.rows.slice(0, 50), m.rows.length));
    }
    var input = h('input', { type: 'file', accept: '.xlsx,.xls,.xlsm,.csv', 'aria-label': title + ' 파일 선택', onchange: function (e) {
      var file = e.target.files[0]; if (!file) return;
      readWorkbook(file).then(function (wb) { startPending(kind, file.name, wb); render(); })
        .catch(function (err) { toast(err.message, true); });
    } });
    append(card, h('label', { class: 'field', style: 'margin-top:12px' }, m ? '다른 파일 불러오기' : '엑셀·CSV 파일 선택', input));
    if (pending && pending.kind === kind) append(card, mappingPanel());
    return card;
  }

  function masterPreview(kind, rows, total) {
    var head, body;
    if (kind === 'map') {
      head = ['행', '고객사 품번', '제조사 품번', '사내 자재 코드', '품명', '구분', '고객사'];
      body = rows.map(function (r) { return h('tr', null, h('td', { class: 'num', text: r.row }), h('td', { class: 'pn', text: r.cust }), h('td', { class: 'pn', text: r.mfr }), h('td', { class: 'pn', text: r.code }), h('td', { text: r.name }), h('td', { text: r.kind }), h('td', { text: r.customer })); });
    } else {
      head = ['행', '커넥터 품번', '규격 하한', '규격 상한', '터미널', '와이어 실', '방수전', '전선 종류'];
      body = rows.map(function (r) { return h('tr', null, h('td', { class: 'num', text: r.row }), h('td', { class: 'pn', text: r.conn.join(', ') }), h('td', { class: 'num', text: L.fmtSpec(r.min) }), h('td', { class: 'num', text: L.fmtSpec(r.max) }), h('td', { class: 'pn', text: r.term.join(', ') }), h('td', { class: 'pn', text: r.seal.join(', ') }), h('td', { class: 'pn', text: r.plug.join(', ') }), h('td', { text: r.wire })); });
    }
    return h('div', null, tableWrap(head, body), total > rows.length ? h('p', { class: 'small muted', text: '앞 ' + rows.length + '행만 보입니다(전체 ' + total + '행).' }) : null);
  }

  function mappingPanel() {
    var p = pending, f = fieldsOf(p.kind);
    var aoa = p.sheets[p.sheet] || [];
    var headers = aoa[p.headerRow] || [];
    var box = h('div', { class: 'notice info', style: 'margin-top:12px' });
    append(box, h('h3', { text: '열 연결 — ' + p.fileName }));
    append(box, h('p', { class: 'small', text: '파일의 실제 열 이름을 표준 항목에 연결합니다. 붉은 * 는 꼭 있어야 하는 항목입니다. 한 번 연결하면 이 브라우저에 저장되어 같은 양식 파일은 자동으로 연결됩니다.' }));
    var top = h('div', { class: 'form-grid' });
    if (p.names.length > 1) {
      append(top, h('label', { class: 'field' }, '시트', h('select', { onchange: function (e) { p.sheet = e.target.value; guessPending(); render(); } },
        p.names.map(function (n) { return h('option', { value: n, selected: n === p.sheet, text: n + ' (' + p.sheets[n].length + '행)' }); }))));
    }
    append(top, h('label', { class: 'field' }, h('span', null, '머리행(열 이름이 있는 행) 번호'),
      h('input', { type: 'number', min: 1, max: Math.max(aoa.length, 1), value: p.headerRow + 1, onchange: function (e) {
        var v = parseInt(e.target.value, 10) - 1; if (isNaN(v) || v < 0) v = 0;
        p.headerRow = Math.min(v, Math.max(aoa.length - 1, 0));
        p.mapping = L.guessMapping(aoa[p.headerRow] || [], f, Store.loadMappings()[p.kind]); render();
      } })));
    append(box, top);
    f.forEach(function (fd) {
      var sel = h('select', { 'aria-label': fd.label, 'data-field': fd.key, onchange: function (e) {
        if (e.target.value === '') delete p.mapping[fd.key]; else p.mapping[fd.key] = parseInt(e.target.value, 10);
        render();
      } }, h('option', { value: '', text: '(연결 안 함)' }),
        headers.map(function (hd, i) { return h('option', { value: String(i), selected: p.mapping[fd.key] === i, text: colName(i) + '열 · ' + (String(hd).trim() || '(이름 없음)') }); }));
      append(box, h('div', { class: 'map-row' }, h('span', null, fd.label, fd.need ? h('span', { class: 'req', text: ' *' }) : null), sel));
    });
    if (p.kind === 'spec' && p.mapping.min === undefined && p.mapping.max === undefined && p.mapping.range === undefined) {
      append(box, h('p', { class: 'small', style: 'margin-top:8px' }, badge('주의', 'warn'), ' 전선 규격 하한·상한(또는 범위 한 칸)이 연결되지 않으면 모든 규격에 같은 터미널이 적용됩니다.'));
    }
    var t = buildPending();
    append(box, h('h3', { style: 'margin-top:12px', text: '미리보기 — ' + t.rows.length + '행' + (t.skipped ? ' (건너뛸 행 ' + t.skipped + ')' : '') }));
    append(box, masterPreview(p.kind, t.rows.slice(0, 5), t.rows.length));
    append(box, h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: '이 연결로 불러오기', onclick: confirmPending }),
      h('button', { type: 'button', class: 'btn', text: '취소', onclick: function () { pending = null; render(); } })));
    return box;
  }

  // ── 2. 부품 LIST ─────────────────────────────────────────────
  var CONN_COLS = [{ k: 'pos', l: '커넥터 위치(기호)', ph: 'CN1' }, { k: 'pn', l: '커넥터 품번', ph: '도면에 적힌 품번' }, { k: 'poles', l: '극수', ph: '2' }];
  var CIRC_COLS = [{ k: 'pos', l: '커넥터 위치', ph: 'CN1' }, { k: 'pole', l: '극 번호', ph: '1' }, { k: 'spec', l: '전선 규격', ph: '0.5' }, { k: 'wire', l: '전선 종류(선택)', ph: '' }];

  function editTable(list, cols, label) {
    var rows = list.map(function (row, i) {
      return h('tr', null, cols.map(function (c) {
        return h('td', null, h('input', { type: 'text', value: row[c.k] || '', placeholder: c.ph, 'aria-label': label + ' ' + (i + 1) + '행 ' + c.l, oninput: function (e) { row[c.k] = e.target.value; save(); } }));
      }), h('td', { class: 'del' }, h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': (i + 1) + '행 삭제', text: '삭제', onclick: function () { list.splice(i, 1); save(); render(); } })));
    });
    return tableWrap(cols.map(function (c) { return c.l; }).concat(['']), rows, 'edit');
  }
  function pasteBox(list, cols, words, label) {
    var ta = h('textarea', { 'aria-label': label + ' 붙여넣기', placeholder: cols.map(function (c) { return c.l; }).join('\t') });
    function applyPaste(replace) {
      var rows = L.parsePaste(ta.value, cols.map(function (c) { return c.k; }), words);
      if (!rows.length) { toast('붙여넣은 내용에서 행을 찾지 못했습니다.', true); return; }
      if (replace) list.length = 0;
      rows.forEach(function (r) { list.push(r); });
      state.sample.parts = replace ? false : state.sample.parts;
      save(); render(); toast(rows.length + '행을 넣었습니다.');
    }
    return h('details', null, h('summary', { text: '엑셀에서 복사해 붙여넣기' }),
      h('p', { class: 'small muted', text: '엑셀에서 「' + cols.map(function (c) { return c.l; }).join(' · ') + '」 순서의 열을 복사해 붙여 넣습니다. 첫 줄이 열 이름이면 건너뜁니다.' }),
      ta, h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', text: '아래에 덧붙이기', onclick: function () { applyPaste(false); } }),
        h('button', { type: 'button', class: 'btn', text: '표를 이것으로 바꾸기', onclick: function () { applyPaste(true); } })));
  }
  function renderParts() {
    var P = state.parts, hd = P.header;
    function hf(key, label, hint) {
      return h('label', { class: 'field' }, label, hint ? h('span', { class: 'hint', text: hint }) : null,
        h('input', { type: 'text', value: hd[key] || '', oninput: function (e) { hd[key] = e.target.value; save(); } }));
    }
    var out = [];
    out.push(h('div', { class: 'page-head' }, h('h1', { text: '2. 부품 LIST' }),
      h('button', { type: 'button', class: 'btn btn-danger btn-small', text: '부품 LIST 비우기', onclick: function () {
        confirmBox('부품 LIST 비우기', '도면 정보·커넥터·회로 입력과 담당자 선택을 모두 지웁니다.', '비우기').then(function (ok) {
          if (!ok) return; state.parts = emptyParts(); state.choices = {}; state.sample.parts = false; save(); render();
        });
      } })));
    out.push(h('p', { class: 'lead', text: '도면에서 읽은 커넥터와 회로(극마다 들어가는 전선 규격)를 입력합니다. 도면 PDF 자동 읽기는 2단계에서 붙입니다.' }));
    out.push(h('section', { class: 'card' }, h('h2', { text: '도면 정보' }), h('div', { class: 'form-grid' },
      hf('drawingNo', '도면 번호'), hf('drawingName', '도면명'), hf('rev', 'REV'),
      hf('customer', '고객사', '매핑 마스터에 고객사 열을 연결한 경우 그 고객사 행만 찾습니다'),
      h('label', { class: 'field' }, 'BOM 구분', h('select', { onchange: function (e) { hd.bomType = e.target.value; save(); } },
        ['신규', '설변'].map(function (v) { return h('option', { value: v, selected: hd.bomType === v, text: v }); }))))));
    out.push(h('section', { class: 'card' }, h('h2', { text: '커넥터 (' + P.connectors.length + ')' }),
      h('p', { class: 'small muted', text: '커넥터 품번은 도면에 적힌 그대로(고객사 품번 또는 제조사 품번) 입력합니다.' }),
      editTable(P.connectors, CONN_COLS, '커넥터'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', text: '행 추가', onclick: function () { P.connectors.push({ pos: '', pn: '', poles: '' }); save(); render(); } })),
      pasteBox(P.connectors, CONN_COLS, ['커넥터품번', '극수', '위치'], '커넥터')));
    out.push(h('section', { class: 'card' }, h('h2', { text: '회로 — 극별 전선 (' + P.circuits.length + ')' }),
      h('p', { class: 'small muted', text: '한 행이 커넥터 한 극에 꽂히는 전선 한 가닥입니다. 행 하나마다 터미널 1개·실 1개로 셉니다(가정 — 사내 규칙 확인 필요). 전선 규격은 숫자(예: 0.5, 0.85sq)로 적습니다.' }),
      editTable(P.circuits, CIRC_COLS, '회로'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', text: '행 추가', onclick: function () { P.circuits.push({ pos: '', pole: '', spec: '', wire: '' }); save(); render(); } })),
      pasteBox(P.circuits, CIRC_COLS, ['전선규격', '극번호', '커넥터위치'], '회로')));
    out.push(h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '#/check', text: '다음: 3. 검증·산출' })));
    return out;
  }

  // ── 3. 검증·산출 ─────────────────────────────────────────────
  function computeNow() {
    return L.compute({
      mapRows: state.masters.map ? state.masters.map.rows : [], specRows: state.masters.spec ? state.masters.spec.rows : [],
      header: state.parts.header, connectors: state.parts.connectors, circuits: state.parts.circuits,
      settings: state.settings, choices: state.choices
    });
  }
  function missingInputs() {
    var miss = [];
    if (!state.masters.map) miss.push(h('li', null, h('a', { href: '#/masters', text: '부품 매핑 마스터' }), '를 불러와 주세요.'));
    if (!state.masters.spec) miss.push(h('li', null, h('a', { href: '#/masters', text: 'Application Spec' }), '을 불러와 주세요.'));
    if (!state.parts.connectors.length) miss.push(h('li', null, h('a', { href: '#/parts', text: '부품 LIST' }), '에 커넥터를 입력해 주세요.'));
    return miss.length ? h('div', { class: 'notice warn' }, h('p', null, '먼저 필요한 것:'), h('ul', null, miss),
      h('button', { type: 'button', class: 'btn', text: '예시 데이터 불러오기', onclick: askLoadSample })) : null;
  }
  function issueCard(iss, idx) {
    var card = h('div', { class: 'card issue' + (iss.resolved ? ' done' : ''), 'data-issue': iss.key });
    append(card, h('div', { class: 'issue-head' },
      iss.resolved ? badge('처리됨', 'ok') : badge('미해결', 'bad'), badge(iss.kind, 'info'),
      h('h3', { text: iss.reason })));
    append(card, h('div', { class: 'issue-meta' },
      iss.pn ? h('span', null, '품번 ', h('code', { text: iss.pn }), ' · ') : null,
      '위치 ' + iss.where.join(', ') + (iss.qty ? ' · 수량 ' + iss.qty : '')));
    var name = 'pick' + idx;
    var ch = iss.choice || {};
    if (!iss.candidates.length && !iss.manual) {
      append(card, h('p', { class: 'small' }, '부품 LIST 를 고치면 다시 확인합니다. ', h('a', { href: '#/parts', text: '부품 LIST 로 가기' })));
      return card;
    }
    iss.candidates.forEach(function (c) {
      append(card, h('label', { class: 'cand' }, h('input', { type: 'radio', name: name, value: c.id, checked: ch.pick === c.id }),
        h('span', null, h('span', { class: 'pn', text: c.label }), c.rows ? h('span', { class: 'small muted', text: ' (근거 ' + (iss.code.indexOf('map') === 0 ? '매핑' : 'App Spec') + ' ' + c.rows.join('·') + '행)' }) : null)));
    });
    var mf = null, man = ch.manual || {};
    if (iss.manual) {
      append(card, h('label', { class: 'cand' }, h('input', { type: 'radio', name: name, value: '__manual', checked: !!ch.manual }), h('span', { text: '직접 입력' })));
      if (iss.manual === 'code') mf = [['code', '사내 자재 코드 (필수)'], ['mfr', '제조사 품번'], ['name', '품명']];
      else if (iss.manual === 'termseal') mf = [['term', '터미널 품번 (필수)'], ['seal', '와이어 실 품번 (비우면 실 없음)']];
      else mf = [['plug', '방수전 품번 (필수)']];
      append(card, h('div', { class: 'manual' }, mf.map(function (x) {
        return h('label', { class: 'field' }, x[1], h('input', { type: 'text', 'data-m': x[0], value: man[x[0]] || '', oninput: function () {
          var r = card.querySelector('input[value="__manual"]'); if (r) r.checked = true;
        } }));
      })));
    }
    append(card, h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-small', text: '적용', onclick: function () {
        var sel = card.querySelector('input[name="' + name + '"]:checked');
        if (!sel) { toast('후보를 고르거나 직접 입력을 선택해 주세요.', true); return; }
        if (sel.value === '__manual') {
          var m = {};
          card.querySelectorAll('input[data-m]').forEach(function (i) { m[i.getAttribute('data-m')] = i.value.trim(); });
          var need = iss.manual === 'code' ? 'code' : iss.manual === 'termseal' ? 'term' : 'plug';
          if (!m[need]) { toast('필수 칸을 채워 주세요.', true); return; }
          state.choices[iss.key] = { manual: m };
        } else state.choices[iss.key] = { pick: sel.value };
        save(); render(); toast('적용했습니다. 결과를 다시 계산했습니다.');
      } }),
      iss.choice ? h('button', { type: 'button', class: 'btn btn-small', text: '선택 취소', onclick: function () { delete state.choices[iss.key]; save(); render(); } }) : null));
    return card;
  }
  function renderCheck() {
    var out = [h('div', { class: 'page-head' }, h('h1', { text: '3. 검증·산출' }))];
    out.push(h('p', { class: 'lead', text: '매핑 마스터로 품번을 교차 확인하고, Application Spec 으로 터미널·실을 산출합니다. 자동으로 정할 수 없는 항목은 확인 대상으로 남기고 담당자가 고릅니다.' }));
    var miss = missingInputs(); if (miss) { out.push(miss); return out; }
    var r = computeNow();
    var normalized = r.lines.filter(function (l) { return l.status === 'normalized'; }).length;
    var pendingC = r.circuits.filter(function (c) { return c.state === 'pending'; }).length;
    out.push(h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('b', { text: state.parts.connectors.length }), h('span', { text: '커넥터' })),
      h('div', { class: 'tile' }, h('b', { text: state.parts.circuits.length }), h('span', { text: '회로(극)' })),
      h('div', { class: 'tile ' + (r.open ? 'bad' : 'good'), id: 'openCount' }, h('b', { text: r.open + ' / ' + r.issues.length }), h('span', { text: '확인 대상 미해결 / 전체' })),
      h('div', { class: 'tile' }, h('b', { text: normalized }), h('span', { text: '표기 차이로 매칭됨' })),
      h('div', { class: 'tile' }, h('b', { text: pendingC }), h('span', { text: '산출 보류 회로(커넥터 미확정)' }))));
    if (state.settings.plug) out.push(h('p', { class: 'small muted', text: '방수전 산출이 켜져 있습니다(설정). 빈 극 수 = 극수 − 입력한 회로 수.' }));
    out.push(h('h2', { text: '확인 대상' }));
    if (!r.issues.length) out.push(h('div', { class: 'notice good', text: '확인 대상이 없습니다. 모든 품번이 자동으로 정해졌습니다.' }));
    else {
      out.push(h('div', { class: 'filter-bar' }, h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: ui.onlyOpen, onchange: function (e) { ui.onlyOpen = e.target.checked; render(); } }), h('span', { text: '미해결만 보기' }))));
      r.issues.forEach(function (iss, i) { if (!ui.onlyOpen || !iss.resolved) out.push(issueCard(iss, i)); });
    }
    out.push(h('h2', { style: 'margin-top:24px', text: '커넥터별 산출 결과' }));
    out.push(tableWrap(['위치', '구분', '도면/산출 품번', '제조사 품번', '사내 자재 코드', '품명', '수량', '상태', '근거'],
      r.lines.map(function (l) {
        var check = !l.ok ? '확인 필요' : l.status === 'manual' ? '직접 입력' : l.status === 'chosen' ? '담당자 선택' : l.status === 'normalized' ? '표기 차이 매칭' : '자동';
        return h('tr', null, h('td', { text: l.pos }), h('td', { text: l.kind }), h('td', { class: 'pn', text: l.srcPn }), h('td', { class: 'pn', text: l.mfr }),
          h('td', { class: 'pn', text: l.code }), h('td', { text: l.name }), h('td', { class: 'num', text: l.qty }), h('td', null, statusBadge(check)), h('td', { class: 'basis', text: l.basis }));
      })));
    out.push(h('h2', { text: '회로별 산출' }));
    out.push(tableWrap(['위치', '극', '전선 규격', '전선 종류', '터미널', '와이어 실', '상태', '근거·메모'],
      r.circuits.map(function (c) {
        return h('tr', null, h('td', { text: c.pos }), h('td', { text: c.pole }), h('td', { text: c.spec }), h('td', { text: c.wire }),
          h('td', { class: 'pn', text: c.term || '' }), h('td', { class: 'pn', text: c.state === 'ok' ? (c.seal || '없음') : '' }),
          h('td', null, c.state === 'ok' ? badge('산출', 'ok') : c.state === 'pending' ? badge('보류', 'warn') : badge('확인 필요', 'bad')),
          h('td', { class: 'basis', text: c.note || '' }));
      })));
    out.push(h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '#/bom', text: '다음: 4. BOM' })));
    return out;
  }

  // ── 4. BOM ───────────────────────────────────────────────────
  function fileSafe(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_'); }
  function exportName(ext) {
    var hd = state.parts.header;
    var sample = state.sample.map || state.sample.spec || state.sample.parts;
    return (sample ? '예시데이터_' : '') + 'BOM_' + fileSafe(hd.bomType || '신규') + '_' + fileSafe(hd.drawingNo || '도면번호없음') +
      (hd.rev ? '_REV' + fileSafe(hd.rev) : '') + '_' + today().replace(/-/g, '') + '.' + ext;
  }
  function doExport(kind) {
    var r = computeNow(), bom = L.aggregateBom(r.lines, state.settings);
    var hd = Object.assign({}, state.parts.header, { date: today() });
    var go = function () {
      var sheets = L.bomSheets(r, bom, hd);
      if (kind === 'csv') {
        var blob = new Blob([L.toCsv(sheets['BOM'])], { type: 'text/csv;charset=utf-8' });
        var a = h('a', { href: URL.createObjectURL(blob), download: exportName('csv') });
        document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } else {
        var wb = XLSX.utils.book_new();
        Object.keys(sheets).forEach(function (n) {
          var ws = XLSX.utils.aoa_to_sheet(sheets[n]);
          if (n === 'BOM') ws['!cols'] = [6, 8, 14, 14, 16, 26, 7, 6, 18, 12, 40].map(function (w) { return { wch: w }; });
          XLSX.utils.book_append_sheet(wb, ws, n);
        });
        XLSX.writeFile(wb, exportName('xlsx'));
      }
      toast('내보냈습니다: ' + exportName(kind));
    };
    if (r.open) {
      confirmBox('확인 대상이 남아 있습니다', '미해결 ' + r.open + '건이 「확인 필요」로 표시된 채 내보내집니다. 그래도 내보낼까요?', '내보내기')
        .then(function (ok) { if (ok) go(); });
    } else go();
  }
  function renderBom() {
    var out = [h('div', { class: 'page-head' }, h('h1', { text: '4. BOM' }))];
    var miss = missingInputs(); if (miss) { out.push(miss); return out; }
    var r = computeNow(), bom = L.aggregateBom(r.lines, state.settings), hd = state.parts.header;
    out.push(h('p', { class: 'lead', text: '같은 사내 자재 코드끼리 수량을 합친 BOM 입니다. 각 행의 근거 열에 어느 마스터 행에서 왔는지 남깁니다.' }));
    out.push(h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('b', { text: hd.bomType || '신규' }), h('span', { text: 'BOM 구분' })),
      h('div', { class: 'tile' }, h('b', { text: hd.drawingNo || '-' }), h('span', { text: '도면 번호' + (hd.rev ? ' · REV ' + hd.rev : '') })),
      h('div', { class: 'tile' }, h('b', { text: bom.length }), h('span', { text: 'BOM 행' })),
      h('div', { class: 'tile ' + (r.open ? 'bad' : 'good') }, h('b', { text: r.open }), h('span', { text: '미해결 확인 대상' }))));
    if (r.open) out.push(h('div', { class: 'notice bad' }, '확인 대상 ' + r.open + '건이 남아 있어 사내 코드가 비어 있는 행이 있습니다. ', h('a', { href: '#/check', text: '3. 검증·산출에서 처리하기' })));
    else out.push(h('div', { class: 'notice good', text: '확인 대상을 모두 처리했습니다.' }));
    if (state.settings.margin) out.push(h('p', { class: 'small muted', text: '여유율 ' + state.settings.margin + '% 를 터미널·실·방수전 수량에 더하고 올림했습니다(설정).' }));
    out.push(tableWrap(['번호', '구분', '사내 자재 코드', '제조사 품번', '도면/산출 품번', '품명', h('th', { class: 'num', text: '수량' }), '사용 위치', '확인 상태', '근거'],
      bom.map(function (b) {
        return h('tr', null, h('td', { class: 'num', text: b.no }), h('td', { text: b.kind }), h('td', { class: 'pn', text: b.code }), h('td', { class: 'pn', text: b.mfr }),
          h('td', { class: 'pn', text: b.srcPns.join(', ') }), h('td', { text: b.name }), h('td', { class: 'num', text: b.qty }),
          h('td', { text: b.positions.join(', ') }), h('td', null, statusBadge(b.check)), h('td', { class: 'basis', text: b.basis.join(' / ') }));
      }), 'bom'));
    out.push(h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'BOM 엑셀 내보내기', onclick: function () { doExport('xlsx'); } }),
      h('button', { type: 'button', class: 'btn', text: 'BOM CSV 내보내기', onclick: function () { doExport('csv'); } })));
    out.push(h('p', { class: 'small muted', text: '엑셀에는 BOM · 확인 대상 · 회로별 산출 근거 3개 시트가 들어갑니다. 열 순서는 실제 BOM 양식을 받으면 그에 맞춥니다.' }));
    return out;
  }

  // ── 설정 ─────────────────────────────────────────────────────
  function renderSettings() {
    var st = state.settings;
    function upd(fn) { return function (e) { fn(e.target); state.settings = L.mergeSettings(st); st = state.settings; save(); toast('저장했습니다.'); }; }
    var seps = [[',', '쉼표(,)'], [';', '세미콜론(;)'], ['\n', '줄바꿈'], ['/', '슬래시(/)']];
    var out = [h('div', { class: 'page-head' }, h('h1', { text: '설정' }))];
    out.push(h('p', { class: 'lead', text: '산출 규칙은 사내 기준이 확인되기 전까지 사용자가 정합니다. 값은 이 브라우저에 저장됩니다.' }));
    out.push(h('section', { class: 'card' }, h('h2', { text: '산출 규칙' }), h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, '종속 자재 여유율(%)', h('span', { class: 'hint', text: '터미널·실·방수전 수량에 더하고 올림. 커넥터는 제외' }),
        h('input', { type: 'number', min: 0, step: 1, value: st.margin, 'aria-label': '여유율', onchange: upd(function (t) { st.margin = Number(t.value) || 0; }) })),
      h('label', { class: 'field' }, '전선 규격이 범위 경계값일 때', h('select', { 'aria-label': '경계값 처리', onchange: upd(function (t) { st.boundary = t.value; }) },
        h('option', { value: 'include', selected: st.boundary === 'include', text: '범위에 포함(자동 산출)' }),
        h('option', { value: 'review', selected: st.boundary === 'review', text: '확인 대상으로 표시' }))),
      h('label', { class: 'field' }, '전선 규격 단위 표시', h('input', { type: 'text', value: st.unit, onchange: upd(function (t) { st.unit = t.value.trim() || 'sq'; }) }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.plug, 'aria-label': '방수전 산출', onchange: upd(function (t) { st.plug = t.checked; }) }),
        h('span', null, h('b', { text: '빈 극에 방수전 넣기' }), h('br'), h('span', { class: 'small muted', text: '빈 극 수(극수 − 회로 수)만큼 Application Spec 의 방수전을 넣습니다. 방수전이 적힌 행이 없는 커넥터는 비방수로 보고 넣지 않습니다. 기준 확인 전이라 기본은 꺼 둡니다.' })))));
    out.push(h('section', { class: 'card' }, h('h2', { text: '품번 비교 방식' }),
      h('p', { class: 'small muted', text: '먼저 적힌 그대로 비교하고, 없으면 아래 규칙으로 정리해 다시 비교합니다. 정리해서 맞은 경우는 「표기 차이로 매칭됨」으로 표시합니다.' }),
      [['space', '공백 무시'], ['hyphen', '하이픈(-) 무시'], ['upper', '대소문자 무시'], ['dot', '점(.)·밑줄(_)·슬래시(/) 무시']].map(function (x) {
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.norm[x[0]], onchange: upd(function (t) { st.norm[x[0]] = t.checked; }) }), h('span', { text: x[1] }));
      }),
      h('h3', { style: 'margin-top:12px', text: 'Application Spec 한 칸에 여러 품번이 있을 때 나누는 기호' }),
      seps.map(function (x) {
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.multiSep.indexOf(x[0]) >= 0, onchange: upd(function (t) {
          st.multiSep = st.multiSep.split('').filter(function (c) { return c !== x[0]; }).join('') + (t.checked ? x[0] : '');
        }) }), h('span', { text: x[1] }));
      }),
      h('p', { class: 'small muted', text: '나누는 기호를 바꾸면 Application Spec 파일을 다시 불러와야 반영됩니다.' })));
    out.push(h('section', { class: 'card' }, h('h2', { text: '데이터' }),
      h('p', { class: 'small muted', text: '마스터·부품 LIST·담당자 선택은 이 브라우저(localStorage)에만 저장됩니다. 결과 보관은 BOM 엑셀로 합니다.' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', text: '저장된 열 연결 지우기', onclick: function () { Store.clearMappings(); toast('열 연결 설정을 지웠습니다.'); } }),
        h('button', { type: 'button', class: 'btn btn-danger', text: '모든 데이터 지우기', onclick: function () {
          confirmBox('모든 데이터 지우기', '마스터 2종, 부품 LIST, 담당자 선택, 설정을 모두 지웁니다.', '지우기').then(function (ok) {
            if (!ok) return; Store.clear(); state = emptyState(); pending = null; save(); location.hash = '#/masters'; render(); toast('모두 지웠습니다.');
          });
        } }))));
    return out;
  }

  // ── 라우팅 ───────────────────────────────────────────────────
  var ROUTES = { masters: renderMasters, parts: renderParts, check: renderCheck, bom: renderBom, settings: renderSettings };
  function render() {
    var name = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'masters';
    if (!ROUTES[name]) name = 'masters';
    var y = window.scrollY;
    var prev = main.getAttribute('data-route');
    main.innerHTML = '';
    append(main, ROUTES[name]());
    document.querySelectorAll('#nav a').forEach(function (a) {
      if (a.getAttribute('data-route') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    main.setAttribute('data-route', '#/' + name);
    if (prev === '#/' + name) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  if (!location.hash) history.replaceState(null, '', '#/masters');
  save();
  render();
})();
