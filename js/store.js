/* 브라우저 저장소 — localStorage 를 쓰되, 막혀 있거나 가득 차면 메모리로만 동작합니다 */
(function (root) {
  'use strict';
  var KEY = 'data09-16.state';
  var KEY_MAPPING = 'data09-16.mappings'; // 열 매핑은 데이터를 지워도 남겨 다음 파일에 재사용
  var memory = {};
  var ok = true;
  function get(k) {
    try { var v = root.localStorage.getItem(k); return v == null && memory[k] != null ? memory[k] : v; }
    catch (e) { ok = false; return memory[k] == null ? null : memory[k]; }
  }
  function set(k, v) {
    memory[k] = v;
    try { root.localStorage.setItem(k, v); return true; } catch (e) { ok = false; return false; }
  }
  function del(k) {
    delete memory[k];
    try { root.localStorage.removeItem(k); } catch (e) { ok = false; }
  }
  function parse(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }
  root.BomStore = {
    load: function () { return parse(get(KEY), null); },
    save: function (state) { return set(KEY, JSON.stringify(state)); },
    clear: function () { del(KEY); },
    loadMappings: function () { return parse(get(KEY_MAPPING), {}); },
    saveMappings: function (m) { set(KEY_MAPPING, JSON.stringify(m)); },
    clearMappings: function () { del(KEY_MAPPING); },
    available: function () { get(KEY); return ok; }
  };
})(window);
