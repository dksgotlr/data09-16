/* 하네스 BOM 산출 — 「2. 도면 자재 판별」 화면 (기획서 v0.2 1차 목표)
 * 도면(PDF·이미지) 불러오기 → PDF 글자에서 품번 후보·좌표 추출 / 이미지는 도면 위를 눌러 위치 표시
 * → 통합 자재 마스터와 대조해 기존·매핑 필요·신규 표시 → 표와 도면 상호 이동 → 엑셀·PNG 내보내기.
 * 순수 로직은 js/drawing-logic.js(DrawLogic). 도면 파일은 이 브라우저 메모리에만 두고 저장하지 않습니다.
 */
(function (root) {
  'use strict';
  var DL = root.DrawLogic, DS = root.DrawSample, LR = root.DrawLearn;
  var ui = {
    doc: null, img: null, docFor: '',   // 불러온 도면(pdf.js 문서 또는 이미지)과 그 파일 이름
    page: 1, zoom: 1, fit: true, mode: 'select', sel: null, filter: 'all',
    cache: {}, scroll: { x: 0, y: 0 }, pendingScroll: null, loading: '', queueText: '',
    items: null,       // PDF 글자 조각(메모리에만) — 규칙 가르치기·표 읽기·고객사 알아보기에 씀
    tableDraft: null,  // 표 영역을 새로 지정해 읽은 표(열 역할 확정 전)
    profileOpen: false
  };
  var ctx = null;

  // ── pdf.js 불러오기 ───────────────────────────────────────────
  // 로컬 파일(file://)로 열면 브라우저가 Worker 를 막으므로 worker 스크립트를 일반 스크립트로 먼저 읽어
  // 메인 스레드에서 돌립니다(data09-01 과 같은 방식). 웹 주소에서는 별도 Worker 로 돕니다.
  var pdfjsPromise = null;
  function loadPdfJs() {
    if (pdfjsPromise) return pdfjsPromise;
    function load(src) {
      return new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = src; el.onload = resolve;
        el.onerror = function () { reject(new Error('PDF 라이브러리(' + src + ')를 불러오지 못했습니다.')); };
        document.head.appendChild(el);
      });
    }
    pdfjsPromise = load('vendor/pdfjs/pdf.min.js')
      .then(function () { return location.protocol === 'file:' ? load('vendor/pdfjs/pdf.worker.min.js') : null; })
      .then(function () {
        var lib = root.pdfjsLib;
        if (!lib) throw new Error('PDF 라이브러리를 불러오지 못했습니다.');
        lib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
        return lib;
      });
    pdfjsPromise.catch(function () { pdfjsPromise = null; });
    return pdfjsPromise;
  }
  function openPdfData(bytes) {
    return loadPdfJs().then(function (lib) {
      return lib.getDocument({ data: bytes, cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, isEvalSupported: false }).promise;
    });
  }
  // 쪽 크기(pt, 회전 반영)와 글자 조각(왼쪽 위 기준 상자)
  function pdfPagesAndItems(doc) {
    var lib = root.pdfjsLib, pages = [], items = [], n = doc.numPages, chain = Promise.resolve();
    for (var i = 1; i <= n; i++) (function (pno) {
      chain = chain.then(function () { return doc.getPage(pno); }).then(function (page) {
        var vp = page.getViewport({ scale: 1 });
        pages.push({ w: Math.round(vp.width * 100) / 100, h: Math.round(vp.height * 100) / 100 });
        return page.getTextContent().then(function (tc) {
          tc.items.forEach(function (it) {
            if (!it.str || !it.str.trim()) return;
            var tx = lib.Util.transform(vp.transform, it.transform);
            var len = Math.hypot(tx[0], tx[1]) || 1, ux = tx[0] / len, uy = tx[1] / len;
            var w = it.width, e = tx[4], f = tx[5];
            // 글자 상자 네 꼭짓점: 바탕선 시작점, 진행 방향으로 폭만큼, 위쪽으로 글자 높이만큼
            var xs = [e, e + ux * w, e + tx[2], e + ux * w + tx[2]], ys = [f, f + uy * w, f + tx[3], f + uy * w + tx[3]];
            var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
            var vert = Math.abs(tx[1]) > Math.abs(tx[0]);
            items.push({ page: pno, str: it.str, x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0, vert: vert });
          });
        });
      });
    })(i);
    return chain.then(function () { return { pages: pages, items: items }; });
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── 상태 도우미 ───────────────────────────────────────────────
  function S() { return ctx.state(); }
  function D() { return S().drawing; }
  function mapRows() { var m = S().masters.map; return m ? m.rows : []; }
  function newId() { var d = D(); d.nextId = (d.nextId || 1) + 1; return 'm' + (d.nextId - 1); }
  function profiles() { return S().profiles || (S().profiles = []); }
  function activeProfile() { var id = D().profileId; return id ? profiles().filter(function (p) { return p.id === id; })[0] || null : null; }
  function subRows() { var m = S().masters.sub; return m ? m.rows : []; }
  function classify() {
    var st = S();
    return DL.classifyMarks({ marks: D().marks, mapRows: mapRows(), customer: D().info.customer, norm: st.settings.norm, settings: st.drawSettings, choices: st.drawChoices, profile: activeProfile() });
  }
  function resetView(mode) { ui.page = 1; ui.fit = true; ui.sel = null; ui.cache = {}; ui.scroll = { x: 0, y: 0 }; ui.mode = mode || 'select'; }
  // PDF 글자에서 표시 뽑기. 고객사 규칙이 「부품표형」이면 도면 표에서, 아니면 도면 글자(라벨)에서 뽑습니다.
  // 결과: 뽑은 개수(표를 못 찾으면 -1)
  function extractInto(items, keepManual) {
    var st = S(), d = D(), prof = activeProfile();
    var manual = keepManual ? d.marks.filter(function (m) { return m.src === 'manual'; }) : [];
    var cands;
    if (prof && prof.layout === 'table') {
      var t = findTable(items, prof);
      if (!t) { d.marks = manual; d.table = null; return -1; }
      var roles = LR.guessRoles(t.header.map(function (x) { return x.text; }), prof.table.roles);
      d.table = { page: t.page, region: t.region, header: t.header.map(function (x) { return x.text; }), roles: roles, auto: !d.table || !d.table.fixed, fixed: !!(d.table && d.table.fixed) };
      cands = LR.tableMarks(t, roles);
    } else {
      d.table = null;
      cands = DL.extractCandidates(items, { settings: st.drawSettings, index: DL.buildMasterIndex(mapRows(), st.settings.norm), norm: st.settings.norm, profile: prof });
    }
    d.marks = manual.concat(cands.map(function (c) {
      return { id: newId(), page: c.page, x: c.x, y: c.y, w: c.w, h: c.h, pn: c.pn, src: c.src || 'pdf', kind: '', pnType: c.pnType || '', custPn: c.custPn || '', qty: c.qty || '', desc: c.desc || '' };
    }));
    return cands.length;
  }
  // 도면 표 찾기 — 지정한 영역이 있으면 그 영역, 없으면 쪽마다 머리글(고객사 규칙에 저장된 머리글 우선)을 찾아봄
  function findTable(items, prof) {
    var d = D(), hints = LR.headerHints(prof), saved = prof ? prof.table.roles : null;
    if (d.table && d.table.fixed && d.table.region) return LR.parseTable(items, { page: d.table.page, region: d.table.region, headerHints: hints, saved: saved });
    for (var p = 1; p <= (d.pages.length || 1); p++) {
      var t = LR.parseTable(items, { page: p, headerHints: hints, saved: saved });
      if (!t || !t.rows.length) continue;
      var roles = LR.guessRoles(t.header.map(function (x) { return x.text; }), saved);
      if (roles.some(function (r) { return r === 'cust' || r === 'mfr' || r === 'pn'; })) return t;
    }
    return null;
  }

  // ── 도면 불러오기 ─────────────────────────────────────────────
  function loadPdf(bytes, fileName, opts) {
    opts = opts || {};
    ui.loading = 'PDF 를 읽는 중입니다…'; ctx.render();
    var docRef;
    return openPdfData(bytes).then(function (doc) { docRef = doc; return pdfPagesAndItems(doc); }).then(function (r) {
      var d = D(), same = d.fileName === fileName && d.type === 'pdf' && d.marks.length;
      ui.doc = docRef; ui.img = null; ui.docFor = fileName; ui.loading = ''; ui.items = r.items; ui.tableDraft = null;
      if (opts.keep && same) { ui.cache = {}; ctx.render(); return; }
      d.fileName = fileName; d.type = 'pdf'; d.unit = 'pt'; d.pages = r.pages; d.queue = []; d.table = null;
      // 표제란 글자로 어느 고객사 도면인지 알아보고 그 고객사 규칙을 저절로 적용
      var det = LR.detectProfile(r.items.map(function (it) { return it.str; }), profiles()), msg = '';
      if (det) {
        d.profileId = det.profile.id; d.profileAuto = true; d.info.customer = det.profile.name;
        msg = '「' + det.profile.name + '」 규칙을 적용했습니다(표제란 글자로 알아봄' + (det.tie ? ' — 다른 규칙과 같은 수로 맞아 확인이 필요합니다' : '') + '). ';
      } else if (d.profileAuto) { d.profileId = ''; d.profileAuto = false; }
      var n = extractInto(r.items, false);
      resetView(n > 0 ? 'select' : n < 0 ? 'table' : 'mark');
      ctx.save(); ctx.render();
      if (opts.quiet) return;
      if (n < 0) ctx.toast(msg + '도면에서 부품표를 찾지 못했습니다. 「표 영역 지정」으로 표를 끌어 감싸 주세요.', true);
      else if (n) ctx.toast(msg + (d.table ? '도면 부품표에서 품번 ' + n + '개를 읽어 표시했습니다.' : 'PDF 글자에서 품번 후보 ' + n + '개를 찾아 도면 위에 표시했습니다.'));
      else ctx.toast(msg + '이 PDF 에서 글자를 찾지 못했습니다. 스캔본이면 「위치 표시」로 도면 위를 눌러 표시해 주세요.', true);
    }).catch(function (e) { ui.loading = ''; ctx.render(); ctx.toast('PDF 를 열지 못했습니다: ' + e.message, true); });
  }
  function loadImage(dataUrl, fileName, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('이미지를 읽지 못했습니다')); };
      img.src = dataUrl;
    }).then(function (img) {
      var d = D(), same = d.fileName === fileName && d.type === 'image';
      ui.img = img; ui.doc = null; ui.docFor = fileName; ui.loading = ''; ui.items = null; ui.tableDraft = null;
      if (opts.keep && same) { ui.cache = {}; ctx.render(); return; }
      d.fileName = fileName; d.type = 'image'; d.unit = 'px'; d.pages = [{ w: img.naturalWidth, h: img.naturalHeight }];
      d.marks = []; d.queue = opts.queue || []; d.table = null;
      if (d.profileAuto) { d.profileId = ''; d.profileAuto = false; }   // 이미지는 글자가 없어 고객사를 알아볼 수 없음 — 규칙은 직접 고름
      resetView('mark');
      ctx.save(); ctx.render();
      if (!opts.quiet) ctx.toast('이미지 도면을 불러왔습니다. 「위치 표시」 상태에서 자재 위치를 누르거나 끌어 표시해 주세요.');
    }).catch(function (e) { ui.loading = ''; ctx.render(); ctx.toast(e.message, true); });
  }
  function onFile(file) {
    if (!file) return;
    var d = D(), isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    var keep = d.fileName === file.name && d.marks.length > 0;
    var go = function (keepIt) {
      var fr = new FileReader();
      fr.onerror = function () { ctx.toast('파일을 읽지 못했습니다', true); };
      fr.onload = function () {
        D().sample = false;
        if (isPdf) loadPdf(new Uint8Array(fr.result), file.name, { keep: keepIt });
        else loadImage(fr.result, file.name, { keep: keepIt });
      };
      if (isPdf) fr.readAsArrayBuffer(file); else fr.readAsDataURL(file);
    };
    if (!keep) { go(false); return; }
    ctx.openDialog('같은 이름의 도면', ctx.h('p', { text: '「' + file.name + '」 에 표시 ' + d.marks.length + '개가 저장돼 있습니다. 저장된 표시를 그대로 쓸까요, 처음부터 다시 추출할까요?' }),
      [{ label: '취소', value: 'cancel' }, { label: '다시 추출', value: 'fresh' }, { label: '저장된 표시 쓰기', value: 'keep', primary: true }])
      .then(function (v) { if (v === 'keep') go(true); else if (v === 'fresh') go(false); });
  }

  // ── 예시 ─────────────────────────────────────────────────────
  function sampleMaster() {
    var L = ctx.L, aoa = DS.drawMapAoa, hr = L.detectHeaderRow(aoa, L.MAP_FIELDS), mp = L.guessMapping(aoa[hr], L.MAP_FIELDS);
    var t = L.buildMapTable(aoa, hr, mp), names = {};
    Object.keys(mp).forEach(function (k) { names[k] = String(aoa[hr][mp[k]]); });
    return { fileName: '예시데이터_통합자재마스터.xlsx', sheet: '통합자재마스터', headerRow: hr, names: names, rows: t.rows, skipped: t.skipped, noRange: 0, badRange: [], at: ctx.today() };
  }
  function sampleSub() {
    var L = ctx.L, aoa = DS.subAoa, hr = L.detectHeaderRow(aoa, LR.SUB_FIELDS), mp = L.guessMapping(aoa[hr], LR.SUB_FIELDS);
    var t = LR.buildSubTable(aoa, hr, mp), names = {};
    Object.keys(mp).forEach(function (k) { names[k] = String(aoa[hr][mp[k]]); });
    return { fileName: '예시데이터_커넥터부자재마스터.xlsx', sheet: '커넥터부자재', headerRow: hr, names: names, rows: t.rows, skipped: t.skipped, noRange: 0, badRange: [], at: ctx.today() };
  }
  // 예시 고객사 규칙 2개(A 라벨형 · B 부품표형)를 넣음 — 같은 id 는 예시 값으로 바꾸고 담당자가 만든 규칙은 그대로
  function putSampleProfiles() {
    var list = profiles();
    DS.profiles.forEach(function (sp) {
      var p = LR.normalizeProfile(JSON.parse(JSON.stringify(sp))); p.sample = true;
      var i = list.map(function (x) { return x.id; }).indexOf(p.id);
      if (i >= 0) list[i] = p; else list.push(p);
    });
  }
  // kind: 'pdf'(라벨형 A) · 'scan'(A 를 스캔 이미지로) · 'table'(부품표형 B)
  function askSample(kind) {
    var st = S();
    var hasReal = (st.masters.map && !st.sample.map) || (D().fileName && !D().sample);
    (hasReal ? ctx.confirmBox('예시 도면 불러오기', '지금 불러온 부품 매핑 마스터와 도면 표시를 예시 데이터로 바꿉니다. 계속할까요?', '바꾸기') : Promise.resolve(true))
      .then(function (ok) { if (ok) loadSample(kind, false); });
  }
  // quiet: 새로고침 뒤 예시 도면 그림만 다시 불러옴(저장된 표시·처리·마스터는 그대로)
  function loadSample(kind, quiet) {
    if (kind === true) kind = 'scan'; else if (kind === false) kind = 'pdf';
    var st = S(), d = D(), isB = kind === 'table';
    if (!quiet) {
      st.masters.map = sampleMaster(); st.sample.map = true;
      if (!st.masters.sub || st.sample.sub) { st.masters.sub = sampleSub(); st.sample.sub = true; }
      putSampleProfiles();
      st.drawChoices = {};
      d.info = isB ? { drawingNo: DS.drawingNoB, customer: DS.customerB } : { drawingNo: DS.drawingNo, customer: DS.customer };
    }
    d.sample = kind;
    var bytes = b64ToBytes(isB ? root.DrawSamplePdfB : root.DrawSamplePdf);
    if (kind !== 'scan') return loadPdf(bytes, isB ? '예시도면_부품표형_가상.pdf' : '예시도면_하네스_가상.pdf', { quiet: quiet, keep: quiet });
    // 스캔본 가정: 같은 PDF 를 그림으로 바꿔 글자 레이어 없이 불러오고, 읽어 둔 품번 목록을 배치 대기열에 넣습니다
    ui.loading = '예시 도면을 스캔 이미지로 바꾸는 중입니다…'; ctx.render();
    return openPdfData(bytes).then(function (doc) { return doc.getPage(1); }).then(function (page) {
      var vp = page.getViewport({ scale: 2 }), cv = document.createElement('canvas');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      return page.render({ canvasContext: g, viewport: vp }).promise.then(function () { return cv.toDataURL('image/png'); });
    }).then(function (url) {
      return loadImage(url, '예시도면_스캔_가상.png', { queue: quiet ? D().queue : DS.scanList.slice(), keep: quiet, quiet: quiet });
    }).then(function () {
      var dd = D();
      dd.sample = 'scan';
      // 스캔본은 표제란 글자를 읽을 수 없어 고객사 규칙을 직접 고른 것으로 둡니다
      if (!quiet) { dd.profileId = 'sample-a'; dd.profileAuto = false; }
      ctx.save(); ctx.render();
      if (!quiet) ctx.toast('스캔 이미지 예시입니다. 배치 대기열의 품번을 도면 위 해당 위치를 눌러 차례로 표시해 보세요.');
    }).catch(function (e) { ui.loading = ''; ctx.render(); ctx.toast(e.message, true); });
  }

  // ── 도면 그리기 ──────────────────────────────────────────────
  var MAX_PX = 16e6;
  function renderScale(pg, z) {
    var dpr = Math.min(root.devicePixelRatio || 1, 2), s = z * dpr;
    var area = pg.w * pg.h * s * s;
    if (area > MAX_PX) s = Math.sqrt(MAX_PX / (pg.w * pg.h));
    return s;
  }
  // 쪽 한 장을 그린 canvas (배율 z 에서 화면 크기 pg.w*z)
  function pageCanvas(pno, z) {
    var key = pno + '@' + z.toFixed(4);
    if (ui.cache[key]) return ui.cache[key];
    var keys = Object.keys(ui.cache);
    if (keys.length > 6) keys.forEach(function (k) { delete ui.cache[k]; });
    var pg = D().pages[pno - 1], s = renderScale(pg, z);
    var p = rasterize(pno, s).then(function (cv) {
      cv.style.width = (pg.w * z) + 'px'; cv.style.height = (pg.h * z) + 'px';
      cv.className = 'dv-canvas';
      return cv;
    });
    ui.cache[key] = p;
    p.catch(function () { delete ui.cache[key]; });
    return p;
  }
  // 배율 s(도면 단위 1 = s 픽셀)로 쪽 그림을 canvas 에
  function rasterize(pno, s) {
    var pg = D().pages[pno - 1], cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(pg.w * s)); cv.height = Math.max(1, Math.round(pg.h * s));
    var g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    if (ui.doc) {
      return ui.doc.getPage(pno).then(function (page) {
        return page.render({ canvasContext: g, viewport: page.getViewport({ scale: s }) }).promise;
      }).then(function () { return cv; });
    }
    if (ui.img) { g.drawImage(ui.img, 0, 0, cv.width, cv.height); return Promise.resolve(cv); }
    return Promise.reject(new Error('도면이 없습니다'));
  }

  function paint() {
    var box = document.getElementById('dv-viewer'), stage = document.getElementById('dv-stage');
    var d = D();
    if (!box || !stage || !d.pages || !d.pages.length) return;
    if (ui.page > d.pages.length) ui.page = 1;
    var pg = d.pages[ui.page - 1];
    if (ui.fit) ui.zoom = Math.max(0.05, (box.clientWidth - 2) / pg.w);
    var z = ui.zoom;
    stage.style.width = pg.w * z + 'px'; stage.style.height = pg.h * z + 'px';
    // 대시보드 뷰어: 도면이 틀보다 낮으면 빈 회색 칸이 남지 않게 틀 높이를 도면에 맞춤
    if (ui.dash) { box.style.height = ''; var maxH = box.clientHeight; if (pg.h * z + 2 < maxH) box.style.height = Math.ceil(pg.h * z + 2) + 'px'; }
    var zl = document.getElementById('dv-zoom'); if (zl) zl.textContent = Math.round(z * 100) + '%';
    drawMarks(stage, z);
    var holder = stage.querySelector('.dv-holder');
    if (ui.doc || ui.img) {
      pageCanvas(ui.page, z).then(function (cv) {
        if (!document.body.contains(holder)) return;
        holder.innerHTML = ''; holder.appendChild(cv);
      }).catch(function (e) { holder.textContent = '도면을 그리지 못했습니다: ' + e.message; });
    }
    if (ui.pendingScroll) { var id = ui.pendingScroll; ui.pendingScroll = null; scrollToMark(id, false); }
    else { box.scrollLeft = ui.scroll.x; box.scrollTop = ui.scroll.y; }
  }
  var lastRows = [];
  // 대시보드의 작은 뷰어는 늘 「선택」으로 봅니다(표시 추가·규칙 가르치기는 「도면 자재 판별」 화면에서)
  function curMode() { return ui.dash ? 'select' : ui.mode; }
  function tagLabel(r) { return r.no + ' ' + (r.status === 'customer' && !r.code ? '고객사·매핑 없음' : DL.STATUS[r.status].label); }
  function drawMarks(stage, z) {
    var layer = stage.querySelector('.dv-marks');
    layer.innerHTML = '';
    var d = D();
    // 도면 표 영역(부품표형)
    if (d.table && d.table.region && d.table.page === ui.page && isFinite(d.table.region.w)) {
      var rg = d.table.region, tb = document.createElement('div');
      tb.className = 'tbl-region';
      tb.style.left = rg.x * z - 4 + 'px'; tb.style.top = rg.y * z - 4 + 'px'; tb.style.width = rg.w * z + 8 + 'px'; tb.style.height = rg.h * z + 8 + 'px';
      tb.appendChild(h0('span', 'tbl-tag', '도면 부품표'));
      layer.appendChild(tb);
    }
    if (curMode() === 'learn') { drawTokens(layer, z); return; }
    lastRows.forEach(function (r) {
      if (r.page !== ui.page) return;
      var el = document.createElement('div');
      el.className = 'mk st-' + r.status + (r.status === 'customer' && !r.code ? ' unmapped' : '') + (r.id === ui.sel ? ' sel' : '') + (ui.filter !== 'all' && ui.filter !== r.status ? ' dim' : '');
      el.setAttribute('data-id', r.id);
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', curMode() === 'select' ? '0' : '-1');
      el.setAttribute('aria-label', r.no + '번 ' + (r.pn || '품번 없음') + ' ' + DL.STATUS[r.status].long);
      el.title = r.no + '. ' + (r.pn || '(품번 없음)') + ' — ' + DL.statusText(r) + (r.code ? ' · ' + r.code : '');
      var pad = 2;
      el.style.left = (r.x * z - pad) + 'px'; el.style.top = (r.y * z - pad) + 'px';
      el.style.width = (r.w * z + pad * 2) + 'px'; el.style.height = (r.h * z + pad * 2) + 'px';
      var tag = document.createElement('span');
      tag.className = 'mk-tag'; tag.textContent = tagLabel(r);
      el.appendChild(tag);
      el.addEventListener('click', function (e) { if (curMode() !== 'select') return; e.stopPropagation(); selectFromDrawing(r.id); });
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFromDrawing(r.id); } });
      layer.appendChild(el);
    });
  }
  function h0(tag, cls, text) { var e = document.createElement(tag); e.className = cls; e.textContent = text; return e; }
  // ── 규칙 가르치기(도면 글자 누르기) ──────────────────────────
  var tokCache = { key: '', list: [] };
  function pdfTokens() {
    if (!ui.items) return [];
    if (tokCache.key !== ui.docFor) {
      var list = [];
      DL.mergeTextItems(ui.items).forEach(function (seg) { DL.tokenize(seg).forEach(function (t) { if (/[A-Z0-9]/i.test(t.str)) list.push(t); }); });
      tokCache = { key: ui.docFor, list: list };
    }
    return tokCache.list;
  }
  function tokenRole(t, prof) {
    if (!prof) return '';
    var k = LR.keyText(t.str);
    if (prof.keywords.some(function (x) { var kk = LR.keyText(x); return kk.indexOf(k) >= 0 && k.length >= 3; })) return 'keyword';
    if (DL.isExcluded(t.str, DL.excludeList(prof.exclude))) return 'notpn';
    return DL.patternType(t.str, DL.compileProfile(prof, S().settings.norm));
  }
  function drawTokens(layer, z) {
    var prof = activeProfile();
    pdfTokens().forEach(function (t) {
      if (t.page !== ui.page) return;
      var role = tokenRole(t, prof);
      var el = h0('button', 'tk' + (role ? ' tk-' + role : ''), '');
      el.type = 'button';
      el.title = t.str + (role ? ' — ' + LR.ROLE_TEXT[role === 'mfr' || role === 'cust' ? role : role] : '');
      el.setAttribute('aria-label', t.str + ' 가르치기');
      el.style.left = (t.x * z - 1) + 'px'; el.style.top = (t.y * z - 1) + 'px';
      el.style.width = (t.w * z + 2) + 'px'; el.style.height = (t.h * z + 2) + 'px';
      el.addEventListener('click', function (e) { e.stopPropagation(); teach(t.str); });
      layer.appendChild(el);
    });
  }
  // 누른 글자를 고객사 규칙에 가르침 — 규칙이 없으면 먼저 만듦
  function ensureProfile() {
    var p = activeProfile();
    if (p) return Promise.resolve(p);
    var h = ctx.h, name = h('input', { type: 'text', value: D().info.customer || '', 'aria-label': '고객사 이름' });
    return ctx.openDialog('고객사 규칙 만들기', h('div', null,
      h('p', { class: 'small', text: '이 도면에 쓸 고객사 규칙이 아직 없습니다. 고객사 이름을 적으면 규칙을 새로 만들고, 앞으로 누르는 글자를 이 규칙에 쌓습니다. 이름은 마스터의 고객사 열과 같게 적어 주세요.' }),
      h('label', { class: 'field' }, '고객사 이름', name)), [{ label: '취소', value: 'cancel' }, { label: '만들기', value: 'ok', primary: true }])
      .then(function (v) {
        if (v !== 'ok' || !name.value.trim()) return null;
        var np = LR.newProfile(name.value.trim()); np.at = ctx.today();
        if (D().type === 'pdf' && D().table) np.layout = 'table';
        profiles().push(np);
        var d = D(); d.profileId = np.id; d.profileAuto = false; d.info.customer = np.name;
        ctx.save();
        return np;
      });
  }
  function teach(text) {
    ensureProfile().then(function (p) {
      if (!p) return;
      var h = ctx.h, cur = tokenRole({ str: text }, p);
      ctx.openDialog('「' + text + '」 가르치기 — ' + p.name, h('div', null,
        h('p', { class: 'small', text: '이 글자가 무엇인지 알려 주시면 같은 모양의 글자를 이 고객사 도면에서 같게 봅니다. 품번은 모양(영문·숫자·기호 순서)으로 규칙을 만듭니다.' }),
        cur ? h('p', { class: 'small' }, '지금: ', h('b', { text: LR.ROLE_TEXT[cur] })) : null),
        [{ label: '취소', value: 'cancel' }, { label: '품번 아님', value: 'notpn' }, { label: '고객사 알아보기 글자', value: 'keyword' },
          { label: '고객사 품번 예', value: 'cust' }, { label: '제조사 품번 예', value: 'mfr', primary: true }])
        .then(function (role) {
          if (!LR.ROLE_TEXT[role]) return;
          LR.learnExample(p, text, role); p.at = ctx.today();
          if (role === 'keyword') { D().profileAuto = true; }
          relearn('「' + text + '」 을(를) ' + LR.ROLE_TEXT[role] + '(으)로 가르쳤습니다.' + conflictNote(p));
        });
    });
  }
  // 규칙이 바뀌면 PDF 글자에서 다시 뽑음(직접 표시한 것은 그대로)
  function relearn(msg) {
    var d = D();
    if (d.type === 'pdf' && ui.items) {
      var n = extractInto(ui.items, true);
      ctx.save(); saveScroll(); ctx.render();
      ctx.toast(msg + (n >= 0 ? ' 다시 뽑은 표시 ' + n + '개.' : ' 부품표를 찾지 못했습니다 — 「표 영역 지정」으로 표를 감싸 주세요.'), n < 0);
    } else { ctx.save(); saveScroll(); ctx.render(); if (msg) ctx.toast(msg); }
  }
  function conflictNote(p) {
    return LR.patternConflicts(p).length ? ' 다만 제조사 품번과 고객사 품번의 모양이 같아 모양만으로는 구분할 수 없습니다(그 모양은 마스터·대조표로 정합니다).' : '';
  }
  // ── 도면 표 영역 지정 → 열 연결 ─────────────────────────────
  function tableFromRegion(box) {
    if (!ui.items) { ctx.toast('글자가 있는 PDF 에서만 표를 읽을 수 있습니다.', true); return; }
    var prof = activeProfile();
    var t = LR.parseTable(ui.items, { page: ui.page, region: box, headerHints: LR.headerHints(prof), saved: prof ? prof.table.roles : null });
    if (!t || !t.rows.length) { ctx.toast('그 영역에서 머리글과 행을 찾지 못했습니다. 머리글 줄까지 넉넉히 감싸 주세요.', true); return; }
    ui.tableDraft = { table: t, roles: LR.guessRoles(t.header.map(function (x) { return x.text; }), prof ? prof.table.roles : null) };
    ui.mode = 'select'; saveScroll(); ctx.render();
    var card = document.getElementById('dv-tablecard'); if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function applyTableDraft(saveToProfile) {
    var dr = ui.tableDraft, d = D(), prof = activeProfile();
    if (!dr) return;
    if (!dr.roles.some(function (r) { return r === 'cust' || r === 'mfr' || r === 'pn'; })) { ctx.toast('품번 열(고객사 품번·제조사 품번·품번 중 하나)을 하나 이상 골라 주세요.', true); return; }
    var marks = LR.tableMarks(dr.table, dr.roles);
    d.marks = d.marks.filter(function (m) { return m.src !== 'table' && m.src !== 'pdf'; }).concat(marks.map(function (c) {
      return { id: newId(), page: c.page, x: c.x, y: c.y, w: c.w, h: c.h, pn: c.pn, src: 'table', kind: '', pnType: c.pnType, custPn: c.custPn, qty: c.qty, desc: c.desc };
    }));
    d.table = { page: dr.table.page, region: dr.table.region, header: dr.table.header.map(function (x) { return x.text; }), roles: dr.roles.slice(), fixed: true };
    if (saveToProfile && prof) { LR.saveRoles(prof, dr.table.header, dr.roles); prof.layout = 'table'; prof.at = ctx.today(); }
    ui.tableDraft = null; ui.sel = null;
    ctx.save(); saveScroll(); ctx.render();
    ctx.toast('도면 부품표에서 품번 ' + marks.length + '개를 뽑았습니다' + (saveToProfile && prof ? '. 열 연결을 「' + prof.name + '」 규칙에 저장했습니다.' : '.'));
  }
  function applySel() {
    document.querySelectorAll('.mk.sel, tr.dv-row.sel').forEach(function (el) { el.classList.remove('sel'); });
    if (!ui.sel) return;
    document.querySelectorAll('[data-id="' + ui.sel + '"]').forEach(function (el) { el.classList.add('sel'); });
  }
  function flash(el) { if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  function scrollToMark(id, smooth) {
    var r = lastRows.filter(function (x) { return x.id === id; })[0];
    var box = document.getElementById('dv-viewer');
    if (!r || !box) return;
    var z = ui.zoom;
    var left = r.x * z + r.w * z / 2 - box.clientWidth / 2, top = r.y * z + r.h * z / 2 - box.clientHeight / 2;
    if (box.scrollTo) box.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    else { box.scrollLeft = Math.max(0, left); box.scrollTop = Math.max(0, top); }
    var rect = box.getBoundingClientRect();
    if (rect.bottom < 60 || rect.top > root.innerHeight - 60) box.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    flash(document.querySelector('.mk[data-id="' + id + '"]'));
  }
  // 표 → 도면
  function selectFromTable(id) {
    var r = lastRows.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    ui.sel = id;
    if (r.page !== ui.page) { saveScroll(); ui.page = r.page; ui.pendingScroll = id; ctx.render(); return; }
    applySel(); scrollToMark(id, true);
  }
  // 도면 → 표
  function selectFromDrawing(id) {
    ui.sel = id;
    if (ui.dash) { ui.pendingScroll = id; ui.filter = 'all'; root.location.hash = '#/drawing'; return; }
    if (ui.filter !== 'all') {
      var r = lastRows.filter(function (x) { return x.id === id; })[0];
      if (r && r.status !== ui.filter) { ui.filter = 'all'; saveScroll(); ctx.render(); }
    }
    applySel();
    var row = document.querySelector('tr.dv-row[data-id="' + id + '"]');
    if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); flash(row); }
  }
  function saveScroll() {
    var box = document.getElementById('dv-viewer');
    if (box) ui.scroll = { x: box.scrollLeft, y: box.scrollTop };
  }

  // 위치 표시(누르기 = 기본 크기 상자, 끌기 = 끈 만큼의 상자)
  function bindMarking(stage) {
    var start = null, temp = null;
    function pt(e) {
      var r = stage.getBoundingClientRect();
      return { x: (e.clientX - r.left) / ui.zoom, y: (e.clientY - r.top) / ui.zoom, px: e.clientX, py: e.clientY };
    }
    stage.addEventListener('pointerdown', function (e) {
      if ((curMode() !== 'mark' && curMode() !== 'table') || e.button > 0) return;
      e.preventDefault();
      start = pt(e);
      try { stage.setPointerCapture(e.pointerId); } catch (x) { /* 무시 */ }
      temp = document.createElement('div'); temp.className = 'mk-temp';
      stage.querySelector('.dv-marks').appendChild(temp);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!start || !temp) return;
      var p = pt(e), z = ui.zoom;
      temp.style.left = Math.min(start.x, p.x) * z + 'px'; temp.style.top = Math.min(start.y, p.y) * z + 'px';
      temp.style.width = Math.abs(p.x - start.x) * z + 'px'; temp.style.height = Math.abs(p.y - start.y) * z + 'px';
    });
    function end(e) {
      if (!start) return;
      var p = pt(e), s = start; start = null;
      if (temp && temp.parentNode) temp.parentNode.removeChild(temp);
      temp = null;
      if (e.type === 'pointercancel') return;
      var pg = D().pages[ui.page - 1], box;
      if (ui.mode === 'table') {
        if (Math.abs(p.px - s.px) < 12 || Math.abs(p.py - s.py) < 12) { ctx.toast('표 전체(머리글 줄 포함)를 끌어서 감싸 주세요.', true); return; }
        tableFromRegion({ x: Math.max(0, Math.min(s.x, p.x)), y: Math.max(0, Math.min(s.y, p.y)), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
        return;
      }
      if (Math.abs(p.px - s.px) < 6 && Math.abs(p.py - s.py) < 6) box = DL.defaultBox(pg.w, pg.h, s.x, s.y);
      else box = { x: Math.max(0, Math.min(s.x, p.x)), y: Math.max(0, Math.min(s.y, p.y)), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      addMark(box);
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }
  function addMark(box) {
    var d = D();
    var pn = d.queue && d.queue.length ? d.queue.shift() : '';
    var m = { id: newId(), page: ui.page, x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h), pn: pn, src: 'manual', kind: '' };
    d.marks.push(m);
    ui.sel = m.id;
    saveScroll();
    ctx.save(); ctx.render();
    var row = document.querySelector('tr.dv-row[data-id="' + m.id + '"]');
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      if (!pn) { var inp = row.querySelector('input.dv-pn'); if (inp) inp.focus(); }
    }
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  // ── 처리(행 동작) ────────────────────────────────────────────
  function setChoice(key, choice) {
    var st = S();
    if (choice) st.drawChoices[key] = choice; else delete st.drawChoices[key];
    saveScroll(); ctx.save(); ctx.render();
  }
  function manualCode(r) {
    var h = ctx.h;
    var code = h('input', { type: 'text', 'aria-label': '사내 자재 코드' }), mfr = h('input', { type: 'text', value: r.mfr || '', 'aria-label': '제조사 품번' }), name = h('input', { type: 'text', value: r.name || '', 'aria-label': '품명' });
    var prof = activeProfile(), toXref = r.isCust && prof ? h('input', { type: 'checkbox', checked: true }) : null;
    ctx.openDialog('사내 자재 코드 직접 입력 — ' + r.pn, h('div', null,
      h('p', { class: 'small', text: '같은 품번이 도면 여러 곳에 있으면 모두 같은 코드로 바뀝니다. 마스터 엑셀에도 이 매핑을 추가해 두시면 다음 도면부터 자동으로 맞춰집니다.' }),
      h('div', { class: 'manual' }, h('label', { class: 'field' }, '사내 자재 코드 *', code), h('label', { class: 'field' }, '제조사 품번', mfr), h('label', { class: 'field' }, '품명', name)),
      toXref ? h('label', { class: 'check' }, toXref, h('span', { text: '「' + prof.name + '」 고객사 대조표에도 넣기(고객사 품번 ' + r.pn + ' → 제조사 품번). 다음 도면부터 저절로 매핑됩니다' })) : null),
      [{ label: '취소', value: 'cancel' }, { label: '저장', value: 'ok', primary: true }]).then(function (v) {
      if (v !== 'ok') return;
      if (!code.value.trim()) { ctx.toast('사내 자재 코드를 입력해 주세요.', true); return; }
      if (toXref && toXref.checked) {
        prof.xref = LR.mergeXref(prof.xref, [{ cust: r.pn, mfr: mfr.value.trim(), code: code.value.trim(), name: name.value.trim() }], S().settings.norm);
        prof.at = ctx.today();
      }
      setChoice(r.key, { code: code.value.trim(), mfr: mfr.value.trim(), name: name.value.trim() });
    });
    setTimeout(function () { code.focus(); }, 30);
  }
  function excludePn(r) {
    var st = S(), d = D();
    var list = DL.excludeList(st.drawSettings.exclude);
    list.push(r.pn);
    st.drawSettings.exclude = list.join('\n');
    var before = d.marks.length;
    d.marks = d.marks.filter(function (m) { return DL.choiceKey(m.pn, st.settings.norm) !== r.key; });
    if (ui.sel === r.id) ui.sel = null;
    saveScroll(); ctx.save(); ctx.render();
    ctx.toast('「' + r.pn + '」 을 제외 목록에 넣고 표시 ' + (before - d.marks.length) + '개를 지웠습니다. 제외 목록은 「품번 후보 규칙」에서 고칠 수 있습니다.');
  }
  function removeMark(r) {
    var d = D();
    d.marks = d.marks.filter(function (m) { return m.id !== r.id; });
    if (ui.sel === r.id) ui.sel = null;
    saveScroll(); ctx.save(); ctx.render();
  }
  function onAction(r, v) {
    if (!v) return;
    if (v.indexOf('pick:') === 0) setChoice(r.key, { pick: v.slice(5) });
    else if (v === 'new') setChoice(r.key, { isNew: true });
    else if (v === 'manual') manualCode(r);
    else if (v === 'undo') setChoice(r.key, null);
    else if (v === 'exclude') excludePn(r);
    else if (v === 'delete') removeMark(r);
    else if (v.indexOf('teach:') === 0) {
      var role = v.slice(6);
      ensureProfile().then(function (p) {
        if (!p) return;
        LR.learnExample(p, r.pn, role); p.at = ctx.today();
        relearn('「' + r.pn + '」 을(를) 「' + p.name + '」 규칙의 ' + LR.ROLE_TEXT[role] + '(으)로 가르쳤습니다.' + conflictNote(p));
      });
    }
  }
  function actionSelect(r) {
    var h = ctx.h, opts = [h('option', { value: '', text: '처리 선택' })];
    if (r.status === 'mapping' || r.status === 'customer' || (r.status === 'existing' && r.confirmed)) {
      (r.candidates || []).forEach(function (c) {
        opts.push(h('option', { value: 'pick:' + c.id, disabled: !c.code, text: '후보: ' + (c.code || '(사내 코드 없음)') + ' · ' + (c.mfr || '-') + (c.customer ? ' [' + c.customer + ']' : '') + (c.why ? ' (' + c.why + ')' : '') }));
      });
    }
    if (r.pn && !(r.status === 'new' && r.confirmed)) opts.push(h('option', { value: 'new', text: '신규 자재로 확정' }));
    if (r.pn) opts.push(h('option', { value: 'manual', text: '사내 코드 직접 입력…' }));
    if (r.confirmed) opts.push(h('option', { value: 'undo', text: '처리 되돌리기' }));
    if (r.pn) opts.push(h('option', { value: 'exclude', text: '품번 아님 — 제외 목록에 넣기' }));
    if (r.pn) {
      opts.push(h('option', { value: 'teach:cust', text: '고객사 규칙에 가르치기: 고객사 품번 예' }));
      opts.push(h('option', { value: 'teach:mfr', text: '고객사 규칙에 가르치기: 제조사 품번 예' }));
    }
    opts.push(h('option', { value: 'delete', text: '이 표시 지우기' }));
    return h('select', { class: 'dv-act', 'aria-label': r.no + '번 처리', onchange: function (e) { onAction(r, e.target.value); } }, opts);
  }

  // ── 내보내기 ─────────────────────────────────────────────────
  function baseName() {
    var d = D(), n = d.info.drawingNo || String(d.fileName || '도면').replace(/\.[^.]+$/, '');
    return (d.sample ? '예시데이터_' : '') + n.replace(/[\\/:*?"<>|\s]+/g, '_');
  }
  function exportInfo(res) {
    var d = D();
    var p = activeProfile();
    return { fileName: d.fileName, drawingNo: d.info.drawingNo, customer: d.info.customer, unit: d.unit, pages: d.pages.length, date: ctx.today(), total: res.total,
      profile: p ? p.name + (d.profileAuto ? '(표제란 글자로 자동 적용)' : '(직접 고름)') + (d.table ? ' · 부품표형' : '') : '' };
  }
  function warnOpen(res) {
    var open = res.open;
    return open ? ctx.confirmBox('손볼 항목이 남았습니다', '확인 필요·품번 미입력·매핑 없는 고객사 품번·확정 전 신규가 ' + open + '개 남아 있습니다. 그대로 내보낼까요? (「확인 필요」 시트에 따로 모아 둡니다)', '내보내기') : Promise.resolve(true);
  }
  function bomLines(res) { return subRows().length ? LR.expandBom(res, subRows(), { mapRows: mapRows(), norm: S().settings.norm, off: S().drawSubOff }) : null; }
  function exportXlsx() {
    var res = classify();
    if (!res.total) { ctx.toast('내보낼 표시가 없습니다.', true); return; }
    warnOpen(res).then(function (ok) {
      if (!ok) return;
      var sheets = DL.drawingSheets(res, exportInfo(res)), wb = XLSX.utils.book_new();
      var lines = bomLines(res);
      if (lines) sheets['부자재 포함 자재 목록'] = LR.bomSheet(lines);
      Object.keys(sheets).forEach(function (name) {
        var ws = XLSX.utils.aoa_to_sheet(sheets[name]);
        var widths = sheets[name][0].map(function (_, ci) {
          var m = 6; sheets[name].forEach(function (row) { var v = row[ci] == null ? '' : String(row[ci]); m = Math.max(m, Math.min(60, v.length * 1.6)); });
          return { wch: Math.round(m) };
        });
        ws['!cols'] = widths;
        XLSX.utils.book_append_sheet(wb, ws, name);
      });
      XLSX.writeFile(wb, baseName() + '_자재판별_' + ctx.today() + '.xlsx');
      ctx.toast('엑셀을 내보냈습니다(자재 판별 · 품번별 요약 · 확인 필요 · 도면 정보' + (lines ? ' · 부자재 포함 자재 목록' : '') + ').');
    });
  }
  function exportCsv() {
    var res = classify();
    if (!res.total) { ctx.toast('내보낼 표시가 없습니다.', true); return; }
    var sheets = DL.drawingSheets(res, exportInfo(res));
    download(new Blob([ctx.L.toCsv(sheets['자재 판별'])], { type: 'text/csv;charset=utf-8' }), baseName() + '_자재판별_' + ctx.today() + '.csv');
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  var PNG_COLORS = { existing: '#1b7f3b', customer: '#b07800', mapping: '#6a3d9a', 'new': '#c62828', empty: '#6b7280' };
  var TAG_BG = { existing: '#1b7f3b', customer: '#f2c14e', mapping: '#6a3d9a', 'new': '#c62828', empty: '#6b7280' };
  var TAG_FG = { existing: '#ffffff', customer: '#2b2000', mapping: '#ffffff', 'new': '#ffffff', empty: '#ffffff' };
  // 표시된 도면 PNG — 쪽 그림 + 상자(선 모양·라벨 병행) + 아래쪽 범례 띠
  function pagePng(pno, res) {
    var d = D(), pg = d.pages[pno - 1];
    var s = d.type === 'image' ? Math.min(1, Math.sqrt(MAX_PX / (pg.w * pg.h))) : Math.min(2.5, Math.sqrt(MAX_PX / (pg.w * pg.h)));
    return rasterize(pno, s).then(function (base) {
      var k = Math.max(1, base.width / 1400);
      var band = Math.round(46 * k), out = document.createElement('canvas');
      out.width = base.width; out.height = base.height + band;
      var g = out.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
      g.drawImage(base, 0, 0);
      var font = '"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif';
      res.rows.forEach(function (r) {
        if (r.page !== pno) return;
        var x = r.x * s - 2 * k, y = r.y * s - 2 * k, w = r.w * s + 4 * k, hh = r.h * s + 4 * k, c = PNG_COLORS[r.status];
        g.save();
        if (r.status === 'new') {
          g.save(); g.beginPath(); g.rect(x, y, w, hh); g.clip();
          g.strokeStyle = 'rgba(198,40,40,.35)'; g.lineWidth = 1.2 * k;
          for (var t = -hh; t < w; t += 6 * k) { g.beginPath(); g.moveTo(x + t, y + hh); g.lineTo(x + t + hh, y); g.stroke(); }
          g.restore();
        } else if (r.status === 'customer') { g.fillStyle = 'rgba(240,180,0,.22)'; g.fillRect(x, y, w, hh); }
        else if (r.status === 'mapping') { g.fillStyle = 'rgba(106,61,154,.12)'; g.fillRect(x, y, w, hh); }
        else if (r.status === 'existing') { g.fillStyle = 'rgba(27,127,59,.10)'; g.fillRect(x, y, w, hh); }
        g.strokeStyle = c; g.lineWidth = (r.status === 'new' ? 2.2 : r.status === 'customer' ? 3 : 2) * k;
        g.setLineDash(r.status === 'mapping' || (r.status === 'customer' && !r.code) ? [6 * k, 4 * k] : r.status === 'empty' ? [2 * k, 3 * k] : []);
        g.strokeRect(x, y, w, hh);
        if (r.status === 'new') { g.lineWidth = 1 * k; g.strokeRect(x - 3 * k, y - 3 * k, w + 6 * k, hh + 6 * k); }
        g.setLineDash([]);
        var label = tagLabel(r);
        g.font = 'bold ' + Math.round(11 * k) + 'px ' + font;
        var tw = g.measureText(label).width + 8 * k, th = 15 * k, ty = y - th - (r.status === 'new' ? 3 * k : 0);
        if (ty < 0) ty = y + hh + 2 * k;
        g.fillStyle = TAG_BG[r.status]; g.fillRect(x, ty, tw, th);
        g.fillStyle = TAG_FG[r.status]; g.textBaseline = 'middle'; g.fillText(label, x + 4 * k, ty + th / 2 + 0.5 * k);
        g.restore();
      });
      // 범례 띠
      var by = base.height;
      g.fillStyle = '#f4f6f8'; g.fillRect(0, by, out.width, band);
      g.strokeStyle = '#d5dbe2'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, by + 0.5); g.lineTo(out.width, by + 0.5); g.stroke();
      g.font = Math.round(13 * k) + 'px ' + font; g.textBaseline = 'middle';
      var lx = 12 * k, ly = by + band / 2;
      DL.STATUS_ORDER.forEach(function (st) {
        g.strokeStyle = PNG_COLORS[st]; g.lineWidth = (st === 'customer' ? 3 : 2) * k;
        g.setLineDash(st === 'mapping' ? [6 * k, 4 * k] : st === 'empty' ? [2 * k, 3 * k] : []);
        g.strokeRect(lx, ly - 8 * k, 26 * k, 16 * k); g.setLineDash([]);
        if (st === 'new') { g.lineWidth = 1 * k; g.strokeRect(lx - 3 * k, ly - 11 * k, 32 * k, 22 * k); }
        g.fillStyle = '#1b2430';
        var txt = DL.STATUS[st].long + ' ' + res.rows.filter(function (r) { return r.page === pno && r.status === st; }).length;
        g.fillText(txt, lx + 34 * k, ly);
        lx += 34 * k + g.measureText(txt).width + 22 * k;
      });
      g.fillStyle = '#56616f';
      var info = (d.info.drawingNo || d.fileName) + ' · ' + pno + '/' + d.pages.length + '쪽 · ' + ctx.today();
      g.fillText(info, Math.max(lx, out.width - g.measureText(info).width - 12 * k), ly);
      return new Promise(function (resolve) { out.toBlob(resolve, 'image/png'); });
    });
  }
  function exportPng(all) {
    if (!ui.doc && !ui.img) { ctx.toast('도면 파일을 다시 올린 뒤 PNG 를 내보낼 수 있습니다.', true); return; }
    var res = classify(), d = D();
    var pages = all ? d.pages.map(function (_, i) { return i + 1; }) : [ui.page];
    ctx.toast('PNG 를 만드는 중입니다…');
    var chain = Promise.resolve();
    pages.forEach(function (p) {
      chain = chain.then(function () { return pagePng(p, res); }).then(function (blob) {
        download(blob, baseName() + '_자재표시_' + p + '쪽.png');
        return new Promise(function (r) { setTimeout(r, 400); });
      });
    });
    chain.then(function () { ctx.toast('표시된 도면 PNG ' + pages.length + '장을 내보냈습니다.'); })
      .catch(function (e) { ctx.toast('PNG 를 만들지 못했습니다: ' + e.message, true); });
  }

  // ── AI 반자동(스캔·이미지 도면) ───────────────────────────────
  var AI_PROMPT = [
    '첨부한 와이어링 하네스 도면 이미지에서 부품 품번(커넥터·클립·그로멧·튜브·테이프 등)으로 보이는 글자를 모두 찾아줘.',
    '규칙:',
    '1) 한 줄에 품번 하나만, 다른 설명 없이 적어줘.',
    '2) 같은 품번이 도면 여러 곳에 있으면 나온 횟수만큼 적어줘.',
    '3) 도면 번호·치수·전선 규격(예: 0.5SQ)·위치 기호(예: CN1)는 빼줘.',
    '4) 읽기 어려운 글자는 추측해서 채우지 말고 품번 끝에 [?] 를 붙여줘.',
    '5) 왼쪽 위에서 오른쪽 아래 순서로 적어줘.'
  ].join('\n');
  function showPrompt() {
    var h = ctx.h, ta = h('textarea', { readonly: true, rows: 9, 'aria-label': 'AI 요청 문장' });
    ta.value = AI_PROMPT;
    ctx.openDialog('AI 에 품번 읽기 요청하기(반자동)', h('div', null,
      h('p', { class: 'small', text: 'ChatGPT 같은 AI 에 도면 이미지와 함께 아래 문장을 붙여 넣고, 받은 품번 목록을 「배치 대기열」 칸에 붙여 넣어 주세요. 그다음 도면 위 해당 위치를 차례로 누르면 품번이 들어갑니다.' }),
      h('div', { class: 'notice warn small', text: '고객사 도면을 외부 AI 에 올려도 되는지 먼저 회사 기준을 확인해 주세요. 허용되지 않으면 품번을 직접 입력해 주세요.' }),
      ta), [{ label: '닫기', value: 'close' }, { label: '문장 복사', value: 'copy', primary: true }]).then(function (v) {
      if (v !== 'copy') return;
      var done = function () { ctx.toast('요청 문장을 복사했습니다.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(AI_PROMPT).then(done, function () { ctx.toast('복사하지 못했습니다. 글을 직접 선택해 복사해 주세요.', true); });
      else ctx.toast('복사하지 못했습니다. 글을 직접 선택해 복사해 주세요.', true);
    });
  }

  // ── 화면 ─────────────────────────────────────────────────────
  function statusShape(st) { return ctx.h('span', { class: 'lg lg-' + st, 'aria-hidden': 'true' }); }
  function render(c) {
    ctx = c;
    var h = ctx.h, st = S(), d = D();
    if (ui.dash) { ui.dash = false; ui.fit = true; if (!ui.pendingScroll) ui.scroll = { x: 0, y: 0 }; }
    reloadSample();
    var res = classify();
    lastRows = res.rows;
    var out = [];
    out.push(h('div', { class: 'page-head' },
      h('h1', { text: '2. 도면 자재 판별' }),
      h('div', { class: 'actions', style: 'margin-top:0' },
        h('button', { type: 'button', class: 'btn', onclick: function () { askSample('pdf'); }, text: '예시 A: 라벨형 PDF' }),
        h('button', { type: 'button', class: 'btn', onclick: function () { askSample('table'); }, text: '예시 B: 부품표형 PDF' }),
        h('button', { type: 'button', class: 'btn', onclick: function () { askSample('scan'); }, text: '예시 A: 스캔 이미지로' }))));
    out.push(h('p', { class: 'lead', text: '도면 위에 자재 위치를 기존(제조사 품번)·고객사 품번·확인 필요·신규로 표시하고, 같은 내용을 엑셀 목록으로 따로 뽑습니다. 고객사마다 도면 그리는 방식이 달라, 고객사별 규칙(품번 모양·표제란 글자·대조표·부품표 열)을 가르쳐 두면 같은 고객사 도면에 저절로 적용됩니다.' }));
    if (!st.masters.map) {
      out.push(h('div', { class: 'notice warn' }, '부품 매핑 마스터(통합 자재 마스터)가 아직 없어 모든 품번이 「신규」로 보입니다. ',
        h('a', { href: '#/masters', text: '1. 마스터 데이터' }), '에서 먼저 불러와 주세요.'));
    }
    out.push(fileCard());
    if (ui.loading) out.push(h('div', { class: 'notice info', role: 'status', text: ui.loading }));
    if (!d.fileName) {
      out.push(h('div', { class: 'notice info' },
        h('p', null, '처음 쓰신다면 예시로 흐름을 먼저 보실 수 있습니다. 모두 가상 자료입니다.'),
        h('ul', { class: 'small' },
          h('li', null, h('b', { text: '예시 A: 라벨형 PDF' }), ' — 부품 그림 옆에 품번을 적는 고객사(예시고객사A). 품번이 15곳에 적힌 도면 1쪽'),
          h('li', null, h('b', { text: '예시 B: 부품표형 PDF' }), ' — 품번을 도면의 부품표(ITEM · CUSTOMER P/N · MAKER P/N · DESCRIPTION · Q\'TY)에 모아 적는 고객사(예시고객사B)'),
          h('li', null, h('b', { text: '예시 A: 스캔 이미지로' }), ' — 글자 레이어가 없는 스캔본을 가정해 도면 위를 눌러 표시하는 흐름')),
        h('p', { class: 'small' }, '두 예시 모두 고객사 규칙 2개(A·B)와 커넥터 부자재 마스터가 함께 들어가, 표제란 글자로 고객사를 알아보고 규칙을 저절로 적용하는 모습을 볼 수 있습니다.'),
        h('p', { class: 'small' }, '예시 파일: ', h('a', { href: 'samples/예시도면_하네스_가상.pdf', text: '예시도면_하네스_가상.pdf' }), ' · ',
          h('a', { href: 'samples/예시도면_부품표형_가상.pdf', text: '예시도면_부품표형_가상.pdf' }), ' · ',
          h('a', { href: 'samples/예시데이터_통합자재마스터.xlsx', text: '통합자재마스터.xlsx' }), ' · ',
          h('a', { href: 'samples/예시데이터_커넥터부자재마스터.xlsx', text: '커넥터부자재마스터.xlsx' }), ' · ',
          h('a', { href: 'samples/예시데이터_고객사대조표_B.xlsx', text: '고객사대조표_B.xlsx' }), ' · ',
          h('a', { href: 'samples/예시데이터_고객사규칙.json', text: '고객사규칙.json' }))));
      out.push(profilesCard());
      out.push(rulesCard());
      return out;
    }
    out.push(summaryTiles(res));
    if (ui.tableDraft || D().table) out.push(tableCard());
    out.push(h('div', { class: 'draw-layout' }, viewerPanel(), tablePanel(res)));
    var bc = bomCard(res); if (bc) out.push(bc);
    out.push(exportCard(res));
    out.push(profilesCard());
    out.push(rulesCard());
    setTimeout(paint, 0);
    return out;
  }
  // 새로고침 뒤: 예시는 저장된 표시를 유지한 채 도면만 다시 그림
  function reloadSample() {
    var d = D();
    if (d.sample && !ui.doc && !ui.img && !ui.loading && !ui.autoTried && root.DrawSamplePdf) {
      ui.autoTried = true;
      setTimeout(function () { loadSample(d.sample === true ? 'pdf' : d.sample, true); }, 0);
    }
  }
  function fileCard() {
    var h = ctx.h, d = D(), st = S();
    var custs = {};
    (st.masters.map ? st.masters.map.rows : []).forEach(function (r) { if (r.customer) custs[r.customer] = 1; });
    var card = h('section', { class: 'card', 'aria-label': '도면' });
    card.appendChild(h('h2', { text: '도면' }));
    var upd = function (k) { return function (e) { d.info[k] = e.target.value.trim(); saveScroll(); ctx.save(); ctx.render(); }; };
    card.appendChild(h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, '도면 파일(PDF·PNG·JPG)', h('span', { class: 'hint', text: 'PDF 는 글자에서 품번을 자동으로 찾고, 이미지는 도면 위를 눌러 표시합니다' }),
        h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif,application/pdf,image/*', 'aria-label': '도면 파일 선택', onchange: function (e) { onFile(e.target.files[0]); e.target.value = ''; } })),
      h('label', { class: 'field' }, '도면 번호', h('span', { class: 'hint', text: '내보낼 파일 이름에 씁니다' }), h('input', { type: 'text', value: d.info.drawingNo, onchange: upd('drawingNo') })),
      h('label', { class: 'field' }, '고객사', h('span', { class: 'hint', text: '마스터의 고객사 열과 같게 적으면 이 고객사 품번으로 대조합니다' }),
        h('input', { type: 'text', value: d.info.customer, list: 'dv-custs', onchange: upd('customer') }),
        h('datalist', { id: 'dv-custs' }, Object.keys(custs).map(function (c) { return h('option', { value: c }); }))),
      h('label', { class: 'field' }, '고객사 규칙', h('span', { class: 'hint', text: 'PDF 는 표제란 글자로 저절로 고릅니다. 스캔·이미지는 직접 골라 주세요' }),
        h('select', { 'aria-label': '고객사 규칙', onchange: function (e) { chooseProfile(e.target.value); } },
          h('option', { value: '', text: '(규칙 없음 — 기본 품번 후보 규칙)' }),
          profiles().map(function (p) { return h('option', { value: p.id, selected: p.id === d.profileId, text: p.name + ' · ' + (p.layout === 'table' ? '부품표형' : '라벨형') }); })))));
    var ap = activeProfile();
    if (ap) card.appendChild(h('p', { class: 'small' }, ctx.badge(d.profileAuto ? '고객사 규칙 자동 적용' : '고객사 규칙 직접 고름', d.profileAuto ? 'ok' : 'info'), ' ',
      h('b', { text: ap.name }), ' · ' + (ap.layout === 'table' ? '부품표형' : '라벨형') + ' · 품번 모양 ' + ap.patterns.length + '개 · 대조표 ' + ap.xref.length + '행' + (ap.keywords.length ? ' · 알아보기 글자 「' + ap.keywords.join('」 「') + '」' : '')));
    if (d.fileName) {
      var loaded = ui.docFor === d.fileName && (ui.doc || ui.img);
      card.appendChild(h('p', { class: 'small' }, h('b', { text: d.fileName }), ' · ', d.type === 'pdf' ? 'PDF ' + d.pages.length + '쪽 (좌표 단위 pt)' : '이미지 ' + d.pages[0].w + '×' + d.pages[0].h + 'px',
        ' · 표시 ', h('b', { text: d.marks.length + '개' }), d.sample ? ' · ' : '', d.sample ? ctx.badge('예시 데이터', 'warn') : null));
      if (!loaded && !ui.loading) card.appendChild(h('div', { class: 'notice warn small', text: '도면 파일은 이 브라우저에 저장하지 않습니다. 같은 파일을 위에서 다시 올려 주시면 저장된 표시 ' + d.marks.length + '개와 판별 결과를 그대로 이어서 볼 수 있습니다.' }));
      var acts = h('div', { class: 'actions' });
      if (d.type === 'pdf' && ui.doc) acts.appendChild(h('button', { type: 'button', class: 'btn btn-small', text: 'PDF 글자에서 다시 찾기', onclick: reextract }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-small btn-danger', text: '도면·표시 지우기', onclick: function () {
        ctx.confirmBox('도면·표시 지우기', '불러온 도면과 표시 ' + d.marks.length + '개를 지웁니다. 담당자 처리(후보 선택·신규 확정)와 규칙은 남습니다.', '지우기').then(function (ok) {
          if (!ok) return;
          S().drawing = ctx.emptyDrawing(); ui.doc = null; ui.img = null; ui.docFor = ''; resetView();
          ctx.save(); ctx.render();
        });
      } }));
      card.appendChild(acts);
    }
    return card;
  }
  function chooseProfile(id) {
    var d = D(), p = profiles().filter(function (x) { return x.id === id; })[0];
    d.profileId = p ? p.id : ''; d.profileAuto = false;
    if (p) d.info.customer = p.name;
    if (d.table) d.table.fixed = false;
    relearn(p ? '「' + p.name + '」 규칙을 적용했습니다.' : '고객사 규칙을 끄고 기본 규칙으로 봅니다.');
  }
  function reextract() {
    if (!ui.doc) return;
    var manual = D().marks.filter(function (m) { return m.src !== 'pdf'; }).length;
    pdfPagesAndItems(ui.doc).then(function (r) {
      ui.items = r.items;
      var n = extractInto(r.items, true);
      ui.sel = null; saveScroll(); ctx.save(); ctx.render();
      if (n < 0) ctx.toast('부품표를 찾지 못했습니다. 「표 영역 지정」으로 표를 끌어 감싸 주세요.', true);
      else ctx.toast('품번 후보 ' + n + '개를 다시 찾았습니다' + (manual ? '(직접 표시한 ' + manual + '개는 그대로 둠).' : '.'));
    });
  }
  function summaryTiles(res) {
    var h = ctx.h;
    return h('div', { class: 'tiles dv-tiles' }, DL.STATUS_ORDER.map(function (s) {
      var on = ui.filter === s;
      return h('button', { type: 'button', class: 'tile dv-tile t-' + s + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
        onclick: function () { ui.filter = on ? 'all' : s; saveScroll(); ctx.render(); } },
        h('b', null, statusShape(s), String(res.count[s])), h('span', { text: DL.STATUS[s].long + (on ? ' — 이것만 보는 중' : '') }));
    }));
  }
  function viewerPanel() {
    var h = ctx.h, d = D(), n = d.pages.length;
    var bar = h('div', { class: 'dv-bar' },
      h('div', { class: 'dv-group', role: 'group', 'aria-label': '쪽' },
        h('button', { type: 'button', class: 'btn btn-small', disabled: ui.page <= 1, text: '이전 쪽', onclick: function () { ui.page--; ui.scroll = { x: 0, y: 0 }; ctx.render(); } }),
        h('span', { class: 'small', text: ui.page + ' / ' + n + '쪽' }),
        h('button', { type: 'button', class: 'btn btn-small', disabled: ui.page >= n, text: '다음 쪽', onclick: function () { ui.page++; ui.scroll = { x: 0, y: 0 }; ctx.render(); } })),
      h('div', { class: 'dv-group', role: 'group', 'aria-label': '확대' },
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '축소', text: '−', onclick: function () { zoomBy(1 / 1.25); } }),
        h('span', { id: 'dv-zoom', class: 'small dv-zoom', text: Math.round(ui.zoom * 100) + '%' }),
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '확대', text: '+', onclick: function () { zoomBy(1.25); } }),
        h('button', { type: 'button', class: 'btn btn-small', text: '폭 맞춤', onclick: function () { ui.fit = true; ui.scroll = { x: 0, y: 0 }; ctx.render(); } })),
      h('div', { class: 'dv-group seg', role: 'group', 'aria-label': '누르면' },
        h('button', { type: 'button', class: 'btn btn-small' + (ui.mode === 'select' ? ' on' : ''), 'aria-pressed': ui.mode === 'select' ? 'true' : 'false', text: '선택', onclick: function () { ui.mode = 'select'; saveScroll(); ctx.render(); } }),
        h('button', { type: 'button', class: 'btn btn-small' + (ui.mode === 'mark' ? ' on' : ''), 'aria-pressed': ui.mode === 'mark' ? 'true' : 'false', text: '위치 표시', onclick: function () { ui.mode = 'mark'; saveScroll(); ctx.render(); } }),
        ui.items ? h('button', { type: 'button', class: 'btn btn-small' + (ui.mode === 'learn' ? ' on' : ''), 'aria-pressed': ui.mode === 'learn' ? 'true' : 'false', text: '규칙 가르치기', onclick: function () { ui.mode = 'learn'; saveScroll(); ctx.render(); } }) : null,
        ui.items ? h('button', { type: 'button', class: 'btn btn-small' + (ui.mode === 'table' ? ' on' : ''), 'aria-pressed': ui.mode === 'table' ? 'true' : 'false', text: '표 영역 지정', onclick: function () { ui.mode = 'table'; saveScroll(); ctx.render(); } }) : null));
    var panel = h('section', { class: 'card dv-view', 'aria-label': '도면 보기' }, bar);
    var HINT = {
      mark: '위치 표시: 도면을 한 번 누르면 기본 크기 상자, 끌면 끈 만큼의 상자가 생깁니다. 품번은 배치 대기열에서 차례로 들어가고, 대기열이 비었으면 표에서 입력합니다.',
      learn: '규칙 가르치기: 도면의 글자(파란 점선)를 누르고 「제조사 품번 예」「고객사 품번 예」「고객사 알아보기 글자」「품번 아님」 중 하나를 골라 주세요. 같은 모양의 글자는 이 고객사 도면에서 같게 봅니다. 초록=제조사 품번 모양, 노랑=고객사 품번 모양, 파랑 실선=알아보기 글자, 회색=품번 아님.',
      table: '표 영역 지정: 도면의 부품표를 머리글 줄까지 끌어서 감싸 주세요. 머리글과 열 위치를 읽어 아래 「도면 부품표 열 연결」에 보여 드립니다.',
      select: '선택: 도면의 표시를 누르면 표의 그 행으로 갑니다. 새 위치를 표시하려면 「위치 표시」를 눌러 주세요.'
    };
    panel.appendChild(h('p', { class: 'small muted dv-hint', text: HINT[ui.mode] || HINT.select }));
    if (ui.mode === 'mark' || d.type === 'image') panel.appendChild(queueBox());
    var stage = h('div', { id: 'dv-stage', class: 'dv-stage' + (ui.mode === 'mark' || ui.mode === 'table' ? ' marking' : '') + (ui.mode === 'learn' ? ' learning' : '') },
      h('div', { class: 'dv-holder' }, (ui.doc || ui.img) ? h('span', { class: 'small muted dv-wait', text: '도면을 그리는 중…' }) : h('span', { class: 'small muted dv-wait', text: '도면 파일을 다시 올리면 여기에 그림이 나옵니다. 표시 위치는 저장돼 있습니다.' })),
      h('div', { class: 'dv-marks' }));
    bindMarking(stage);
    var viewer = h('div', { id: 'dv-viewer', class: 'dv-viewer', tabindex: '0', 'aria-label': '도면 — 가로·세로로 스크롤할 수 있습니다' }, stage);
    viewer.addEventListener('scroll', function () { ui.scroll = { x: viewer.scrollLeft, y: viewer.scrollTop }; });
    panel.appendChild(viewer);
    panel.appendChild(h('div', { class: 'dv-legend small' }, DL.STATUS_ORDER.map(function (s) {
      return h('span', null, statusShape(s), DL.STATUS[s].long);
    })));
    return panel;
  }
  function zoomBy(f) {
    var box = document.getElementById('dv-viewer');
    var cx = box ? (box.scrollLeft + box.clientWidth / 2) / ui.zoom : 0, cy = box ? (box.scrollTop + box.clientHeight / 2) / ui.zoom : 0;
    ui.fit = false;
    ui.zoom = Math.min(8, Math.max(0.05, ui.zoom * f));
    if (box) ui.scroll = { x: Math.max(0, cx * ui.zoom - box.clientWidth / 2), y: Math.max(0, cy * ui.zoom - box.clientHeight / 2) };
    ctx.render();
  }
  function queueBox() {
    var h = ctx.h, d = D(), q = d.queue || [];
    var ta = h('textarea', { rows: 3, placeholder: '예) CA-1001\nCL-2001', 'aria-label': '배치할 품번 목록', oninput: function (e) { ui.queueText = e.target.value; } });
    ta.value = ui.queueText;
    return h('div', { class: 'dv-queue' },
      h('div', { class: 'dv-queue-head' },
        h('b', { text: '배치 대기열' }),
        q.length ? h('span', { class: 'small' }, '다음에 누를 위치의 품번: ', h('code', { text: q[0] }), ' · 남은 ' + q.length + '개') : h('span', { class: 'small muted', text: '비어 있음 — 누른 위치는 품번 없이 표시되고 표에서 입력합니다' })),
      h('details', { open: !q.length }, h('summary', { class: 'small', text: '품번 목록 넣기 · AI 요청 문장' }),
        ta,
        h('div', { class: 'actions', style: 'margin-top:6px' },
          h('button', { type: 'button', class: 'btn btn-small btn-primary', text: '대기열에 넣기', onclick: function () {
            var list = DL.parsePnList(ui.queueText);
            if (!list.length) { ctx.toast('한 줄에 품번 하나씩 붙여 넣어 주세요.', true); return; }
            d.queue = q.concat(list); ui.queueText = ''; ui.mode = 'mark'; saveScroll(); ctx.save(); ctx.render();
            ctx.toast(list.length + '개를 대기열에 넣었습니다. 도면 위 해당 위치를 차례로 눌러 주세요.');
          } }),
          q.length ? h('button', { type: 'button', class: 'btn btn-small', text: '맨 앞 건너뛰기', onclick: function () { d.queue = q.slice(1); saveScroll(); ctx.save(); ctx.render(); } }) : null,
          q.length ? h('button', { type: 'button', class: 'btn btn-small', text: '대기열 비우기', onclick: function () { d.queue = []; saveScroll(); ctx.save(); ctx.render(); } }) : null,
          h('button', { type: 'button', class: 'btn btn-small', text: 'AI 요청 문장', onclick: showPrompt }))));
  }
  function tablePanel(res) {
    var h = ctx.h;
    var rows = res.rows.filter(function (r) { return ui.filter === 'all' || r.status === ui.filter; });
    var body = rows.map(function (r) {
      var tr = h('tr', { class: 'dv-row' + (r.id === ui.sel ? ' sel' : ''), 'data-id': r.id, onclick: function (e) {
        if (/^(INPUT|SELECT|TEXTAREA|BUTTON|OPTION|A)$/.test(e.target.tagName)) return;
        selectFromTable(r.id);
      } },
        h('td', { class: 'num' }, h('button', { type: 'button', class: 'dv-no', 'aria-label': r.no + '번 도면에서 보기', onclick: function () { selectFromTable(r.id); } }, statusShape(r.status), String(r.no)),
          h('div', { class: 'small muted', text: r.page + '쪽' })),
        h('td', null, h('input', { type: 'text', class: 'dv-pn pn', value: r.pn, 'aria-label': r.no + '번 도면 표기 품번', placeholder: '품번 입력', onfocus: function () { if (ui.sel !== r.id) { ui.sel = r.id; applySel(); scrollToMarkIfSamePage(r); } }, onchange: function (e) {
          var m = D().marks.filter(function (x) { return x.id === r.id; })[0]; if (!m) return;
          m.pn = e.target.value.trim(); saveScroll(); ctx.save(); ctx.render();
        } }), h('div', { class: 'small muted', text: srcText(r) })),
        h('td', null, h('input', { type: 'text', class: 'dv-kind', value: r.kindManual ? r.kind : '', placeholder: r.kind ? r.kind + (r.kindGuess ? '(추정)' : '') : '종류', 'aria-label': r.no + '번 자재 종류', onchange: function (e) {
          var m = D().marks.filter(function (x) { return x.id === r.id; })[0]; if (!m) return;
          m.kind = e.target.value.trim(); saveScroll(); ctx.save(); ctx.render();
        } })),
        h('td', { class: 'dv-judge' }, h('div', { class: 'dv-judge-top' }, ctx.badge(DL.STATUS[r.status].long + (r.status === 'customer' ? (r.code ? '·매핑됨' : '·매핑 없음') : '') + (r.confirmed ? '(확정)' : ''), BADGE[r.status]),
          r.code ? h('span', { class: 'pn dv-code', text: r.code }) : null),
          r.mfr || r.name ? h('div', { class: 'small muted', text: (r.isCust && r.mfr ? '제조사 품번 ' : '') + [r.mfr, r.name].filter(Boolean).join(' · ') }) : null,
          h('div', { class: 'small dv-detail', text: r.detail }),
          subLine(r)),
        h('td', null, actionSelect(r)));
      return tr;
    });
    var panel = h('section', { class: 'card dv-list', 'aria-label': '자재 판별 표' });
    panel.appendChild(h('div', { class: 'dv-list-head' }, h('h2', { text: '자재 판별 표' }),
      h('span', { class: 'small muted', text: ui.filter === 'all' ? '전체 ' + res.total + '개' : DL.STATUS[ui.filter].long + '만 ' + rows.length + '개 (위 칸을 다시 누르면 전체)' })));
    if (!res.total) panel.appendChild(h('p', { class: 'small muted', text: '아직 표시가 없습니다. PDF 는 「PDF 글자에서 다시 찾기」, 이미지는 「위치 표시」로 도면 위를 눌러 주세요.' }));
    else panel.appendChild(h('div', { class: 'table-wrap dv-table' }, h('table', { class: 'edit' },
      h('thead', null, h('tr', null, ['번호', '도면 표기 품번', '자재 종류', '판별 · 사내 자재 코드', '처리'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, body))));
    return panel;
  }
  var BADGE = { existing: 'ok', customer: 'warn', mapping: 'check', 'new': 'bad', empty: 'info' };
  function srcText(r) {
    var t = r.src === 'pdf' ? 'PDF 글자' : r.src === 'table' ? '도면 부품표' : '직접 표시';
    var k = DL.pnTypeText(r);
    if (k) t += ' · ' + k;
    if (r.src === 'table' && r.custPn && r.custPn !== r.pn) t += ' (고객사 품번 ' + r.custPn + ')';
    if (r.src === 'table' && r.qty !== '') t += ' · 수량 ' + r.qty;
    return t;
  }
  // 커넥터 → 부자재(사내 DB 흉내). 켜 두면 「부자재 포함 자재 목록」에 펼칩니다
  function subLine(r) {
    var subs = r.pn ? LR.subsFor(r, subRows(), S().settings.norm) : [];
    if (!subs.length) return null;
    var h = ctx.h, off = !!S().drawSubOff[r.key];
    return h('div', { class: 'dv-subs small' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !off, onchange: function (e) {
        if (e.target.checked) delete S().drawSubOff[r.key]; else S().drawSubOff[r.key] = true;
        saveScroll(); ctx.save(); ctx.render();
      } }), h('span', { text: '부자재 ' + subs.length + '종 자재 목록에 펼치기' })),
      h('div', { class: 'muted', text: subs.map(function (x) { return (x.kind ? x.kind + ' ' : '') + x.pn + ' ×' + (x.qty || 1); }).join(' · ') }));
  }
  function bomCard(res) {
    var lines = bomLines(res);
    if (!lines) return null;
    var h = ctx.h, nSub = lines.filter(function (l) { return l.level === 'sub'; }).length;
    return h('details', { class: 'card dv-bom' },
      h('summary', null, h('b', { text: '부자재 포함 자재 목록' }), h('span', { class: 'small muted', text: ' — 도면 자재 ' + (lines.length - nSub) + '종 + 커넥터 부자재 ' + nSub + '줄(커넥터 부자재 마스터 기준). 엑셀에 같은 시트가 들어갑니다' })),
      h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', null,
        h('thead', null, h('tr', null, ['구분', '자재 종류', '품번', '사내 자재 코드', '수량', '신규 여부·출처', '비고'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, lines.map(function (l) {
          return h('tr', { class: l.level === 'sub' ? 'dv-subrow' : '' }, h('td', { text: l.level === 'main' ? '도면 자재' : '└ 부자재(' + l.parent + ')' }), h('td', { text: l.kind }),
            h('td', { class: 'pn', text: l.pn }), h('td', { class: 'pn', text: l.code }), h('td', { class: 'num', text: String(l.qty) }), h('td', { text: l.status }), h('td', { class: 'small', text: l.note }));
        })))));
  }
  // 도면 부품표 열 연결(표 영역을 새로 지정했거나 고객사 규칙으로 저절로 읽은 표)
  function tableCard() {
    var h = ctx.h, d = D(), dr = ui.tableDraft, prof = activeProfile();
    var card = h('section', { class: 'card', id: 'dv-tablecard', 'aria-label': '도면 부품표 열 연결' });
    card.appendChild(h('h2', { text: '도면 부품표 열 연결' }));
    if (!dr) {
      var t = d.table;
      card.appendChild(h('p', { class: 'small' }, (t.page ? t.page + '쪽 부품표 · ' : '') + '열 ', t.header.map(function (x, i) {
        return h('span', { class: 'dv-colchip' }, h('code', { text: x }), ' → ' + LR.TABLE_ROLES[t.roles[i]]);
      })));
      card.appendChild(h('div', { class: 'actions' },
        ui.items ? h('button', { type: 'button', class: 'btn btn-small', text: '열 연결 고치기', onclick: function () {
          var tt = t.fixed && t.region ? LR.parseTable(ui.items, { page: t.page, region: t.region, saved: prof ? prof.table.roles : null }) : findTable(ui.items, prof);
          if (!tt) { ctx.toast('표를 다시 읽지 못했습니다. 「표 영역 지정」으로 감싸 주세요.', true); return; }
          ui.tableDraft = { table: tt, roles: t.roles.length === tt.header.length ? t.roles.slice() : LR.guessRoles(tt.header.map(function (x) { return x.text; }), prof ? prof.table.roles : null) };
          saveScroll(); ctx.render();
        } }) : h('span', { class: 'small muted', text: '고치려면 도면 PDF 를 다시 올려 주세요.' }),
        ui.items ? h('button', { type: 'button', class: 'btn btn-small', text: '표 영역 다시 지정', onclick: function () { ui.mode = 'table'; saveScroll(); ctx.render(); } }) : null));
      return card;
    }
    card.appendChild(h('p', { class: 'small', text: '도면 표의 머리글마다 무슨 열인지 골라 주세요. 한 행에 제조사 품번이 있으면 그것으로(초록 판별), 없으면 고객사 품번으로(노랑 판별) 도면 위에 표시합니다. 수량 열은 자재 목록의 수량이 됩니다.' }));
    var grid = h('div', { class: 'dv-colmap' });
    dr.table.header.forEach(function (x, i) {
      grid.appendChild(h('label', { class: 'field' }, h('code', { text: x.text }),
        h('select', { 'aria-label': x.text + ' 열 역할', onchange: function (e) { dr.roles[i] = e.target.value; saveScroll(); ctx.render(); } },
          Object.keys(LR.TABLE_ROLES).map(function (k) { return h('option', { value: k, selected: dr.roles[i] === k, text: LR.TABLE_ROLES[k] }); }))));
    });
    card.appendChild(grid);
    var prev = LR.tableMarks(dr.table, dr.roles);
    card.appendChild(h('p', { class: 'small', text: '미리보기 — 표 ' + dr.table.rows.length + '행 중 품번이 있는 ' + prev.length + '행' }));
    card.appendChild(h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, dr.table.header.map(function (x, i) { return h('th', { text: x.text + ' (' + LR.TABLE_ROLES[dr.roles[i]] + ')' }); }))),
      h('tbody', null, dr.table.rows.slice(0, 8).map(function (row) { return h('tr', null, row.cells.map(function (c) { return h('td', { class: 'pn', text: c ? c.text : '' }); })); })))));
    var save = prof ? h('input', { type: 'checkbox', checked: true }) : null;
    if (save) card.appendChild(h('label', { class: 'check' }, save, h('span', { text: '「' + prof.name + '」 규칙에 이 열 연결을 저장(다음 도면은 같은 머리글이면 저절로 연결)' })));
    else card.appendChild(h('p', { class: 'small muted', text: '고객사 규칙을 고르면 이 열 연결을 규칙에 저장해 다음 도면에 다시 씁니다.' }));
    card.appendChild(h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: '이 열 연결로 품번 뽑기', onclick: function () { applyTableDraft(save && save.checked); } }),
      h('button', { type: 'button', class: 'btn', text: '취소', onclick: function () { ui.tableDraft = null; saveScroll(); ctx.render(); } })));
    return card;
  }
  function scrollToMarkIfSamePage(r) { if (r.page === ui.page) scrollToMark(r.id, true); }
  function exportCard(res) {
    var h = ctx.h;
    return h('section', { class: 'card', 'aria-label': '내보내기' },
      h('h2', { text: '내보내기 — 산출물 2가지' }),
      h('div', { class: 'grid-2' },
        h('div', null, h('h3', { text: '산출물 1 · 표시된 도면 이미지' }),
          h('p', { class: 'small muted', text: '도면 위에 기존·제조사 품번(초록 실선)·고객사 품번(노랑 굵은 실선, 매핑 없으면 노랑 점선)·확인 필요(보라 점선)·신규(빨강 겹선·빗금)·미입력(회색 점) 상자와 번호 라벨, 아래에 범례를 넣은 PNG 입니다.' }),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn btn-primary', text: '이 쪽 PNG', onclick: function () { exportPng(false); } }),
            D().pages.length > 1 ? h('button', { type: 'button', class: 'btn', text: '모든 쪽 PNG', onclick: function () { exportPng(true); } }) : null)),
        h('div', null, h('h3', { text: '산출물 2 · 자재 판별 데이터' }),
          h('p', { class: 'small muted', text: '자재 종류 | 도면 표기 품번 | 매핑된 사내 자재 코드 | 신규 여부 순서에 판별 근거·쪽·좌표를 붙인 목록입니다. 엑셀에는 품번별 요약·확인 필요·도면 정보 시트가 함께 들어갑니다.' }),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn btn-primary', text: '엑셀 내보내기', onclick: exportXlsx }),
            h('button', { type: 'button', class: 'btn', text: 'CSV', onclick: exportCsv })))),
      res.open ? h('p', { class: 'small', style: 'margin-top:10px' }, ctx.badge('손볼 항목 ' + res.open + '개', 'warn'), ' 확인 필요·품번 미입력·매핑 없는 고객사 품번·확정 전 신규가 남아 있어도 내보낼 수 있고, 엑셀 「확인 필요」 시트에 따로 모입니다.') : null);
  }
  // ── 고객사별 학습 규칙 카드 ─────────────────────────────────
  function readAoa(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('파일을 읽지 못했습니다')); };
      fr.onload = function () {
        try {
          var buf = new Uint8Array(fr.result), wb;
          if (/\.(csv|txt)$/i.test(file.name)) {
            var text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('euc-kr').decode(buf); }
            wb = XLSX.read(text.replace(/^\ufeff/, ''), { type: 'string', raw: true });
          } else wb = XLSX.read(buf, { type: 'array' });
          var name = wb.SheetNames.filter(function (n) { return wb.Sheets[n]['!ref']; })[0] || wb.SheetNames[0];
          resolve(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }));
        } catch (e) { reject(new Error('엑셀·CSV 형식으로 읽지 못했습니다: ' + e.message)); }
      };
      fr.readAsArrayBuffer(file);
    });
  }
  function editProfile() {
    var id = ui.editId || D().profileId;
    return profiles().filter(function (p) { return p.id === id; })[0] || profiles()[0] || null;
  }
  function saveProfile(msg, reextractToo) {
    var p = editProfile(); if (p) p.at = ctx.today();
    if (reextractToo && p && p.id === D().profileId) relearn(msg || '규칙을 고쳤습니다.');
    else { ctx.save(); saveScroll(); ctx.render(); if (msg) ctx.toast(msg); }
  }
  function exportProfiles() {
    var list = profiles();
    if (!list.length) { ctx.toast('내보낼 고객사 규칙이 없습니다.', true); return; }
    download(new Blob([JSON.stringify({ tool: 'data09-16', kind: 'customer-profiles', at: ctx.today(), profiles: list }, null, 2)], { type: 'application/json' }), '고객사규칙_' + ctx.today() + '.json');
  }
  function importProfiles(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var j = JSON.parse(String(fr.result)), arr = Array.isArray(j) ? j : j.profiles;
        if (!Array.isArray(arr) || !arr.length) throw new Error('규칙 목록이 없습니다');
        var list = profiles(), n = 0;
        arr.forEach(function (raw) {
          var p = LR.normalizeProfile(raw);
          if (!p.name) return;
          var i = list.map(function (x) { return x.id; }).indexOf(p.id);
          if (i >= 0) list[i] = p; else list.push(p);
          n++;
        });
        ctx.save(); saveScroll(); ctx.render(); ctx.toast('고객사 규칙 ' + n + '개를 가져왔습니다(같은 id 는 바꿈).');
      } catch (e) { ctx.toast('규칙 파일을 읽지 못했습니다: ' + e.message, true); }
    };
    fr.readAsText(file);
  }
  function lines(v) { return String(v || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function profilesCard() {
    var h = ctx.h, list = profiles(), p = editProfile(), d = D();
    var card = h('details', { class: 'card dv-prof', open: ui.profileOpen || null, ontoggle: function (e) { ui.profileOpen = e.target.open; } });
    card.appendChild(h('summary', null, h('b', { text: '고객사별 학습 규칙' }), h('span', { class: 'small muted', text: ' — ' + list.length + '개 · 고객사마다 다른 도면 방식(라벨형·부품표형), 품번 모양, 고객사 대조표, 부품표 열' })));
    card.appendChild(h('div', { class: 'notice info small' },
      h('p', null, h('b', { text: '이것은 AI 학습(기계학습)이 아니라 「예시로 배우는 규칙」입니다. ' }), '담당자가 도면 글자를 눌러 「제조사 품번 예」「고객사 품번 예」「고객사 알아보기 글자」「품번 아님」을 알려 주면, 그 예시로 품번 모양 규칙(정규식)과 표제란 글자·제외 목록을 고객사별로 쌓습니다. 같은 고객사 도면을 올리면 표제란 글자로 알아보고 그 규칙을 저절로 적용합니다. 규칙은 모두 눈으로 보고 고칠 수 있습니다.'),
      h('p', null, '실제 AI 학습(도면을 보고 품번 위치를 스스로 찾는 모델)은 2단계입니다. 고객사별로 품번 위치·종류를 표시한 정답 도면이 수십 장 이상 필요하고, 도면을 학습 환경에 올려도 되는지 보안 확인이 먼저입니다.')));
    var head = h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-small btn-primary', text: '새 고객사 규칙', onclick: function () {
        var np = LR.newProfile(d.info.customer || '새 고객사'); np.at = ctx.today(); list.push(np); ui.editId = np.id; ui.profileOpen = true;
        ctx.save(); saveScroll(); ctx.render();
      } }),
      h('button', { type: 'button', class: 'btn btn-small', text: '규칙 내보내기(JSON)', onclick: exportProfiles }),
      h('label', { class: 'btn btn-small file-btn' }, '규칙 가져오기(JSON)', h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', onchange: function (e) { if (e.target.files[0]) importProfiles(e.target.files[0]); e.target.value = ''; } })));
    card.appendChild(head);
    if (!list.length) { card.appendChild(h('p', { class: 'small muted', text: '아직 규칙이 없습니다. 도면을 올린 뒤 「규칙 가르치기」로 글자를 누르거나 「새 고객사 규칙」을 눌러 주세요. 팀원에게는 「규칙 내보내기」 파일로 나눠 쓸 수 있습니다.' })); return card; }
    card.appendChild(h('div', { class: 'dv-proflist' }, list.map(function (x) {
      return h('button', { type: 'button', class: 'btn btn-small' + (p && x.id === p.id ? ' on' : ''), 'aria-pressed': p && x.id === p.id ? 'true' : 'false',
        text: x.name + (x.id === d.profileId ? ' (이 도면에 적용 중)' : '') + (x.sample ? ' · 예시' : ''), onclick: function () { ui.editId = x.id; saveScroll(); ctx.render(); } });
    })));
    if (!p) return card;
    var reX = p.id === d.profileId;
    function upd(fn, msg) { return function (e) { fn(e.target); saveProfile(msg, reX); }; }
    var body = h('div', { class: 'dv-profedit' });
    body.appendChild(h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, '고객사 이름', h('span', { class: 'hint', text: '마스터의 고객사 열과 같게 적으면 이 고객사 품번으로 대조합니다' }), h('input', { type: 'text', value: p.name, onchange: upd(function (t) { p.name = t.value.trim() || p.name; if (reX) d.info.customer = p.name; }) })),
      h('label', { class: 'field' }, '도면 방식', h('span', { class: 'hint', text: '라벨형: 부품 그림 옆에 품번 / 부품표형: 도면의 표에 품번을 모음' }),
        h('select', { onchange: upd(function (t) { p.layout = t.value; if (reX) d.table = null; }, '도면 방식을 바꿨습니다.') },
          h('option', { value: 'label', selected: p.layout === 'label', text: '라벨형 — 부품 그림 위·옆에 품번' }),
          h('option', { value: 'table', selected: p.layout === 'table', text: '부품표형 — 도면 표에 품번' }))),
      h('label', { class: 'field' }, '고객사 알아보기 글자(표제란)', h('span', { class: 'hint', text: '한 줄에 하나. 도면에 이 글자가 있으면 이 규칙을 저절로 적용합니다(예: CUSTOMER: SAMPLE-A)' }),
        h('textarea', { rows: 2, value: p.keywords.join('\n'), onchange: upd(function (t) { p.keywords = lines(t.value); }) }))));
    body.appendChild(h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, '제조사 품번 예', h('span', { class: 'hint', text: '한 줄에 하나. 이 예시로 제조사 품번 모양을 만듭니다(초록 판별)' }),
        h('textarea', { rows: 3, value: p.examples.mfr.join('\n'), onchange: upd(function (t) { p.examples.mfr = lines(t.value); LR.rebuildPatterns(p); }, '제조사 품번 예를 고쳤습니다.') })),
      h('label', { class: 'field' }, '고객사 품번 예', h('span', { class: 'hint', text: '한 줄에 하나. 이 예시로 고객사 품번 모양을 만듭니다(노랑 판별)' }),
        h('textarea', { rows: 3, value: p.examples.cust.join('\n'), onchange: upd(function (t) { p.examples.cust = lines(t.value); LR.rebuildPatterns(p); }, '고객사 품번 예를 고쳤습니다.') }))));
    // 품번 모양 규칙
    var reIn = h('input', { type: 'text', placeholder: '^[A-Z]{2}-[0-9]{4}$', 'aria-label': '직접 적는 품번 모양(정규식)' }), reType = h('select', { 'aria-label': '품번 종류' }, h('option', { value: 'cust', text: '고객사 품번' }), h('option', { value: 'mfr', text: '제조사 품번' }));
    body.appendChild(h('div', { class: 'field' }, h('b', { class: 'small', text: '품번 모양 규칙 ' + p.patterns.length + '개' }),
      p.patterns.length ? h('ul', { class: 'small dv-pats' }, p.patterns.map(function (x, i) {
        return h('li', null, ctx.badge(x.type === 'cust' ? '고객사 품번' : '제조사 품번', x.type === 'cust' ? 'warn' : 'ok'), ' ', h('code', { text: x.re }), x.auto ? h('span', { class: 'muted', text: ' (예시로 만듦)' }) : ' ',
          h('button', { type: 'button', class: 'btn btn-small', text: '지우기', 'aria-label': x.re + ' 지우기', onclick: function () {
            if (x.auto) p.examples[x.type] = p.examples[x.type].filter(function (ex) { return LR.inferPatterns([ex])[0] !== x.re; });
            p.patterns.splice(i, 1); if (x.auto) LR.rebuildPatterns(p); saveProfile('품번 모양을 지웠습니다.', reX);
          } }));
      })) : h('p', { class: 'small muted', text: '아직 없습니다. 위에 예시를 적거나 도면에서 「규칙 가르치기」로 눌러 주세요.' }),
      LR.patternConflicts(p).length ? h('p', { class: 'small notice warn', text: '제조사 품번과 고객사 품번에 같은 모양(' + LR.patternConflicts(p).join(', ') + ')이 있습니다. 이 모양의 글자는 모양만으로 구분하지 않고 마스터·대조표로 정합니다.' }) : null,
      h('div', { class: 'dv-inline' }, reType, reIn, h('button', { type: 'button', class: 'btn btn-small', text: '직접 추가', onclick: function () {
        var v = reIn.value.trim();
        if (!v || !LR.validRe(v)) { ctx.toast('정규식을 확인해 주세요(예: ^[A-Z]{2}-[0-9]{4}$).', true); return; }
        p.patterns.push({ re: v, type: reType.value, auto: false }); saveProfile('품번 모양을 추가했습니다.', reX);
      } }))));
    body.appendChild(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.strict, onchange: upd(function (t) { p.strict = t.checked; }, t0('strict')) }),
      h('span', { text: '학습한 품번 모양에 맞는 글자만 후보로 봄(마스터·대조표에 있는 품번은 예외). 도면 번호·회로 번호 같은 잡음이 빠집니다' })));
    // 고객사 대조표
    var xrefTa = h('textarea', { rows: 3, placeholder: '고객사 품번[탭]제조사 품번[탭]사내 코드(선택)\nCB-2210\tMX-2P-001', 'aria-label': '대조표 붙여넣기' });
    body.appendChild(h('div', { class: 'field' }, h('b', { class: 'small', text: '고객사 대조표(고객사 품번 → 제조사 품번) ' + p.xref.length + '행' }),
      h('span', { class: 'hint', text: '도면에 고객사 품번만 적힌 경우 이 표로 제조사 품번을 찾아 사내 코드에 맞춥니다. 통합 자재 마스터의 고객사 품번 열로 충분하면 비워 두셔도 됩니다' }),
      p.xref.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['고객사 품번', '제조사 품번', '사내 코드', '품명'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, p.xref.slice(0, 12).map(function (x) { return h('tr', null, h('td', { class: 'pn', text: x.cust }), h('td', { class: 'pn', text: x.mfr }), h('td', { class: 'pn', text: x.code }), h('td', { text: x.name })); })))) : null,
      p.xref.length > 12 ? h('p', { class: 'small muted', text: '앞 12행만 보입니다.' }) : null,
      h('div', { class: 'actions' },
        h('label', { class: 'btn btn-small file-btn' }, '대조표 파일(엑셀·CSV)', h('input', { type: 'file', accept: '.xlsx,.xls,.csv', class: 'sr-only', onchange: function (e) {
          var f = e.target.files[0]; e.target.value = ''; if (!f) return;
          readAoa(f).then(function (aoa) {
            var add = LR.parseXref(aoa);
            if (!add.length) { ctx.toast('대조표에서 행을 찾지 못했습니다. 고객사 품번·제조사 품번 열이 있는지 확인해 주세요.', true); return; }
            p.xref = LR.mergeXref(p.xref, add, S().settings.norm); saveProfile('대조표 ' + add.length + '행을 넣었습니다.', reX);
          }).catch(function (err) { ctx.toast(err.message, true); });
        } })),
        p.xref.length ? h('button', { type: 'button', class: 'btn btn-small btn-danger', text: '대조표 비우기', onclick: function () { p.xref = []; saveProfile('대조표를 비웠습니다.', reX); } }) : null),
      h('details', null, h('summary', { class: 'small', text: '엑셀에서 복사해 붙여넣기' }), xrefTa,
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-small', text: '대조표에 넣기', onclick: function () {
          var aoa = xrefTa.value.split(/\r?\n/).filter(function (l) { return l.trim(); }).map(function (l) { return l.split(/\t|,/); });
          var add = LR.parseXref(aoa);
          if (!add.length) { ctx.toast('한 줄에 「고객사 품번 [탭] 제조사 품번」으로 붙여 넣어 주세요.', true); return; }
          p.xref = LR.mergeXref(p.xref, add, S().settings.norm); saveProfile('대조표 ' + add.length + '행을 넣었습니다.', reX);
        } })))));
    var roleKeys = Object.keys(p.table.roles);
    body.appendChild(h('div', { class: 'field' }, h('b', { class: 'small', text: '부품표 열 연결 ' + roleKeys.length + '개' }),
      roleKeys.length ? h('p', { class: 'small' }, roleKeys.map(function (k) { return h('span', { class: 'dv-colchip' }, h('code', { text: k }), ' → ' + LR.TABLE_ROLES[p.table.roles[k]]); }),
        h('button', { type: 'button', class: 'btn btn-small', text: '지우기', onclick: function () { p.table.roles = {}; saveProfile('부품표 열 연결을 지웠습니다.', false); } }))
        : h('p', { class: 'small muted', text: '부품표형 도면에서 「표 영역 지정」 → 열 연결을 저장하면 여기에 쌓입니다.' })));
    body.appendChild(h('label', { class: 'field' }, '이 고객사 제외 목록', h('span', { class: 'hint', text: '한 줄에 하나, * 는 아무 글자. 이 고객사 도면에서만 품번 후보에서 뺍니다' }),
      h('textarea', { rows: 2, value: p.exclude, onchange: upd(function (t) { p.exclude = t.value; }) })));
    body.appendChild(h('div', { class: 'actions' },
      p.id !== d.profileId ? h('button', { type: 'button', class: 'btn btn-small btn-primary', text: '이 도면에 적용', onclick: function () { chooseProfile(p.id); } }) : null,
      h('button', { type: 'button', class: 'btn btn-small btn-danger', text: '이 규칙 지우기', onclick: function () {
        ctx.confirmBox('고객사 규칙 지우기', '「' + p.name + '」 규칙(예시·품번 모양·대조표·열 연결)을 지웁니다. 필요하면 먼저 「규칙 내보내기」로 보관해 주세요.', '지우기').then(function (ok) {
          if (!ok) return;
          var i = list.indexOf(p); if (i >= 0) list.splice(i, 1);
          if (d.profileId === p.id) { d.profileId = ''; d.profileAuto = false; }
          ui.editId = null; relearn('규칙을 지웠습니다.');
        });
      } })));
    card.appendChild(body);
    return card;
  }
  function t0(k) { return k === 'strict' ? '후보 범위를 바꿨습니다.' : ''; }
  function rulesCard() {
    var h = ctx.h, st = S(), ds = st.drawSettings;
    function upd(fn) { return function (e) { fn(e.target); st.drawSettings = DL.mergeDrawSettings(ds); saveScroll(); ctx.save(); ctx.render(); }; }
    return h('details', { class: 'card dv-rules' },
      h('summary', null, h('b', { text: '품번 후보 규칙' }), h('span', { class: 'small muted', text: ' — PDF 글자 중 어떤 것을 품번 후보로 볼지, 비슷한 품번을 어디까지 찾을지' })),
      h('div', { class: 'form-grid', style: 'margin-top:12px' },
        h('label', { class: 'field' }, '최소 글자 수', h('span', { class: 'hint', text: '공백·하이픈을 뺀 길이. CN1 같은 위치 기호를 거릅니다' }), h('input', { type: 'number', min: 1, max: 20, value: ds.minLen, onchange: upd(function (t) { ds.minLen = t.value; }) })),
        h('label', { class: 'field' }, '비슷한 품번 찾기(글자 차이)', h('span', { class: 'hint', text: '마스터에 없을 때 이 글자 수 이하로 다른 품번을 후보로 보여 줍니다. 0 이면 안 찾음' }), h('input', { type: 'number', min: 0, max: 3, value: ds.fuzzy, onchange: upd(function (t) { ds.fuzzy = t.value; }) }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ds.needMix, onchange: upd(function (t) { ds.needMix = t.checked; }) }), h('span', { text: '영문과 숫자가 함께 있어야 후보로 봄(마스터에 있는 품번은 예외)' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ds.wireFilter, onchange: upd(function (t) { ds.wireFilter = t.checked; }) }), h('span', { text: '0.5SQ · 0.85mm2 · 20AWG 같은 전선 규격은 후보에서 뺌' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ds.confusable, onchange: upd(function (t) { ds.confusable = t.checked; }) }), h('span', { text: 'O↔0 · I·L↔1 · S↔5 · B↔8 · Z↔2 처럼 헷갈리는 글자만 다른 품번을 비슷한 품번으로 보여 줌' })),
      h('label', { class: 'field', style: 'margin-top:8px' }, '마스터·대조표에 없는 고객사 품번', h('span', { class: 'hint', text: '고객사 규칙의 고객사 품번 모양이나 도면 표의 고객사 품번 열로 온 품번이 어디에도 없을 때' }),
        h('select', { onchange: upd(function (t) { ds.unmappedCust = t.value; }) },
          h('option', { value: 'customer', selected: ds.unmappedCust !== 'new', text: '노랑 — 고객사 품번(매핑 없음): 제조사 품번을 찾아 입력' }),
          h('option', { value: 'new', selected: ds.unmappedCust === 'new', text: '빨강 — 신규 자재로 봄' }))),
      h('label', { class: 'field', style: 'margin-top:8px' }, '제외 목록', h('span', { class: 'hint', text: '한 줄에 하나. * 는 아무 글자(예: HN-24-*). 도면 번호처럼 품번이 아닌 글자를 넣어 두면 다음부터 후보에서 빠집니다' }),
        h('textarea', { rows: 3, value: ds.exclude, onchange: upd(function (t) { ds.exclude = t.value; }) })),
      h('p', { class: 'small muted', style: 'margin-top:8px', text: '최소 글자 수·영문숫자·전선 규격·제외 목록을 바꾸면 「PDF 글자에서 다시 찾기」를 눌러야 반영됩니다. 비슷한 품번·헷갈리는 글자 설정은 바로 반영됩니다.' }));
  }

  // ── 대시보드(2026-09-30 디자인 시안) — 도면 올리기 · 작은 뷰어 · 판별 요약 · 분석 기록 ──
  // 도면 읽기·판별·내보내기는 위 함수를 그대로 씁니다. 대시보드 뷰어는 「선택」만(표시를 누르면 판별 화면의 그 행으로)
  var ICON = {
    upload: 'M7 18.5h-.5A4.5 4.5 0 0 1 6 9.55 6 6 0 0 1 17.6 8.1 4.2 4.2 0 0 1 17.5 18.5H17M12 12v8M8.8 15.2 12 12l3.2 3.2',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    zoomIn: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5l4.5 4.5M10.5 7.8v5.4M7.8 10.5h5.4',
    zoomOut: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5l4.5 4.5M7.8 10.5h5.4',
    fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
    open: 'M14 4h6v6M20 4l-8 8M18 14v6H4V6h6'
  };
  function icon(name, cls) {
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    p.setAttribute('d', ICON[name]); svg.appendChild(p);
    return svg;
  }
  function dashEnter(c) { ctx = c; if (!ui.dash) { ui.dash = true; ui.fit = true; ui.scroll = { x: 0, y: 0 }; } reloadSample(); }
  function dashUpload(c) {
    dashEnter(c);
    var h = ctx.h;
    var input = h('input', { type: 'file', class: 'sr-only', accept: '.pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif,application/pdf,image/*', 'aria-label': '도면 파일 선택(PDF·이미지)', onchange: function (e) { onFile(e.target.files[0]); e.target.value = ''; } });
    var zone = h('label', { class: 'dash-drop' },
      h('span', { class: 'dash-drop-ic' }, icon('upload'), icon('file')),
      h('span', { class: 'dash-drop-text', text: '여기에 도면 PDF·이미지 파일을 끌어다 놓거나 클릭하여 업로드하세요.' }),
      h('span', { class: 'dash-drop-hint small', text: '글자가 살아 있는 PDF 는 품번을 자동으로 찾습니다 · 파일은 이 브라우저 안에서만 읽습니다' }),
      input);
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'dragend'].forEach(function (t) { zone.addEventListener(t, function () { zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.classList.remove('over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    return zone;
  }
  function dashViewer(c) {
    dashEnter(c);
    var h = ctx.h, d = D();
    lastRows = classify().rows;
    if (!d.fileName) {
      return h('div', { class: 'dash-empty' },
        h('p', { class: 'small muted', text: ui.loading || '아직 올린 도면이 없습니다. 예시 도면(가상 자료)으로 먼저 보실 수 있습니다.' }),
        h('div', { class: 'actions', style: 'margin-top:0' },
          h('button', { type: 'button', class: 'btn btn-small', onclick: function () { askSample('pdf'); }, text: '예시 A: 라벨형 PDF' }),
          h('button', { type: 'button', class: 'btn btn-small', onclick: function () { askSample('table'); }, text: '예시 B: 부품표형 PDF' })));
    }
    var n = d.pages.length || 1;
    function tool(name, label, fn, extra) {
      return h('button', Object.assign({ type: 'button', class: 'dash-tool', 'aria-label': label, title: label, onclick: fn }, extra || {}), icon(name));
    }
    var tools = h('div', { class: 'dash-tools', role: 'group', 'aria-label': '도면 보기 도구' },
      tool('zoomIn', '확대', function () { zoomBy(1.25); }),
      tool('zoomOut', '축소', function () { zoomBy(1 / 1.25); }),
      tool('fit', '폭 맞춤', function () { ui.fit = true; ui.scroll = { x: 0, y: 0 }; ctx.render(); }),
      tool('open', '도면 자재 판별 화면에서 크게 보기', function () { root.location.hash = '#/drawing'; }));
    var stage = h('div', { id: 'dv-stage', class: 'dv-stage' },
      h('div', { class: 'dv-holder' }, (ui.doc || ui.img) ? h('span', { class: 'small muted dv-wait', text: '도면을 그리는 중…' }) : h('span', { class: 'small muted dv-wait', text: ui.loading || '도면 파일은 저장하지 않습니다. 같은 파일을 위에 다시 올리면 그림이 나옵니다. 표시 위치는 저장돼 있습니다.' })),
      h('div', { class: 'dv-marks' }));
    var viewer = h('div', { id: 'dv-viewer', class: 'dv-viewer dash-viewer', tabindex: '0', 'aria-label': '도면 미리보기 — 끌거나 스크롤해 움직입니다' }, stage);
    viewer.addEventListener('scroll', function () { ui.scroll = { x: viewer.scrollLeft, y: viewer.scrollTop }; });
    // 마우스로 끌어 움직이기(터치는 브라우저 기본 스크롤)
    var drag = null;
    viewer.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button > 0 || (e.target.closest && e.target.closest('.mk'))) return;
      drag = { x: e.clientX, y: e.clientY, l: viewer.scrollLeft, t: viewer.scrollTop };
      viewer.classList.add('panning');
      try { viewer.setPointerCapture(e.pointerId); } catch (x) { /* 무시 */ }
    });
    viewer.addEventListener('pointermove', function (e) { if (!drag) return; viewer.scrollLeft = drag.l - (e.clientX - drag.x); viewer.scrollTop = drag.t - (e.clientY - drag.y); });
    function stop() { drag = null; viewer.classList.remove('panning'); }
    viewer.addEventListener('pointerup', stop); viewer.addEventListener('pointercancel', stop);
    var wrap = h('div', { class: 'dash-view' }, tools,
      h('div', { class: 'dash-view-main' }, viewer, h('span', { class: 'dash-file', title: d.fileName, text: d.fileName })));
    var foot = h('div', { class: 'dash-view-foot small' },
      n > 1 ? h('span', { class: 'dv-group' },
        h('button', { type: 'button', class: 'btn btn-small', disabled: ui.page <= 1, text: '이전 쪽', onclick: function () { ui.page--; ui.scroll = { x: 0, y: 0 }; ctx.render(); } }),
        h('span', { text: ui.page + ' / ' + n + '쪽' }),
        h('button', { type: 'button', class: 'btn btn-small', disabled: ui.page >= n, text: '다음 쪽', onclick: function () { ui.page++; ui.scroll = { x: 0, y: 0 }; ctx.render(); } })) : null,
      h('span', { id: 'dv-zoom', class: 'muted', text: Math.round(ui.zoom * 100) + '%' }),
      h('span', { class: 'muted', text: '표시를 누르면 판별 표의 그 행으로 갑니다' }));
    setTimeout(paint, 0);
    return [wrap, foot, h('div', { class: 'dv-legend small' }, DL.STATUS_ORDER.map(function (s) { return h('span', null, statusShape(s), DL.STATUS[s].long); }))];
  }
  function dashResult(c) { dashEnter(c); return classify(); }
  function historyEntry(c) {
    if (!ctx) ctx = c;
    var d = D();
    if (!d.fileName || !d.marks.length) return null;
    var res = classify(), p = activeProfile();
    return { fileName: d.fileName, drawingNo: d.info.drawingNo || '', customer: d.info.customer || '', profile: p ? p.name : '', sample: !!d.sample,
      type: d.type, pages: d.pages.length, total: res.total, open: res.open, count: res.count };
  }
  function dashExport(c) { if (!ctx) ctx = c; exportXlsx(); }

  root.BomViews = root.BomViews || {};
  root.BomViews.drawing = render;
  root.BomViews.dashUpload = dashUpload;
  root.BomViews.dashViewer = dashViewer;
  root.BomViews.dashResult = dashResult;
  root.BomViews.historyEntry = historyEntry;
  root.BomViews.dashExport = dashExport;
  root.BomViews.statusShape = function (c, st) { if (!ctx) ctx = c; return statusShape(st); };
})(window);
