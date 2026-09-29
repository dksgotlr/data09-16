-- ============================================================================
-- 로컬 검증 전용 — data09-16 프로젝트별 검증 (운영 실행 금지, 가드 내장)
--
--  사용자 A·B·비로그인(anon) 세 역할로 번갈아 들어가
--  RLS 격리 · 기록성 표 · 제약 · 함수 권한을 실제로 확인한다.
-- ============================================================================
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

-- 보조 함수 — 이름이 _assert 로 시작해 공통 권한 검사에서 제외된다.
create or replace function public._assert_raises(p_sql text, p_state text, p_label text)
returns void language plpgsql set search_path = public as $fn$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  if v_state = p_state then raise notice '  OK   %', p_label;
  else raise exception 'FAIL  %  (기대 SQLSTATE %, 실제 %)', p_label, p_state, coalesce(v_state, '성공함');
  end if;
end;
$fn$;

create or replace function public._assert_rows(p_sql text, p_rows int, p_label text)
returns void language plpgsql set search_path = public as $fn$
declare v_n int;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  perform public._assert_eq(v_n, p_rows, p_label);
end;
$fn$;

insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@example.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b@example.com')
on conflict (id) do nothing;

-- ── 재실행 안전 ────────────────────────────────────────────────
do $t$ begin raise notice '[프로젝트] 재적용 · 정책 수'; end $t$;
do $t$ begin
  perform public._assert_eq(
    (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
    58, '두 번 적용해도 정책이 58개 그대로다(v0.3: sub_row·customer_profile 각 4개 추가)');
  perform public._assert_eq(
    (select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal),
    14, '두 번 적용해도 updated_at 트리거가 14개 그대로다');
  perform public._assert_eq(
    (select count(*)::int from pg_constraint where conname = 'app_settings_draw_object'),
    1, '두 번 적용해도 app_settings.draw CHECK 가 하나다');
  perform public._assert_eq(
    (select count(*)::int from pg_constraint where conrelid = 'public.master_file'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%kind%'),
    1, '두 번 적용해도 master_file 의 kind CHECK 가 하나다');
  perform public._assert_eq(
    (select column_default from information_schema.columns
      where table_name = 'app_settings' and column_name = 'multi_sep'),
    E''',;\n''::text', '구분 기호 기본값에 실제 줄바꿈이 들어 있다(글자 \n 이 아니다)');
end $t$;

-- ── 사용자 A ───────────────────────────────────────────────────
set role authenticated;
do $t$ begin perform set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false); end $t$;

do $t$ begin raise notice '[프로젝트] 사용자 A 입력 · 제약'; end $t$;
do $t$
declare v_map bigint; v_spec bigint; v_bom bigint; v_log bigint;
begin
  insert into public.master_file (kind, file_name, sheet, header_row, col_names, is_sample)
    values ('map', '예시데이터_부품매핑마스터.xlsx', '매핑마스터', 1, '{"cust":"고객사 P/N"}', true)
    returning id into v_map;
  insert into public.master_file (kind, file_name, sheet, header_row, is_sample)
    values ('spec', '예시데이터_ApplicationSpec.xlsx', 'ApplicationSpec', 1, true)
    returning id into v_spec;
  perform set_config('test.a_map', v_map::text, false);
  perform set_config('test.a_spec', v_spec::text, false);

  insert into public.map_row (master_file_id, row_no, cust, mfr, code, name, kind, customer) values
    (v_map, 3, 'CA-1001', 'MX-2P-001', 'RM-C0001', '2P 방수 커넥터 하우징', '커넥터', ''),
    (v_map, 8, '',        'TM-050-A',  'RM-T0001', '터미널 0.3~0.5sq',      '터미널', '');
  insert into public.spec_row (master_file_id, row_no, conn, term, seal, plug, min_sq, max_sq, no_range) values
    (v_spec, 3, '{MX-2P-001}', '{TM-050-A}', '{SL-050-R}', '{PL-2P-01}', 0.3, 0.5, false),
    (v_spec, 6, '{MX-4P-010}', '{TM-085-A,TM-085-B}', '{SL-085-R}', '{}', 0.75, 1.25, false);
  insert into public.column_mapping (kind, col_names) values ('map', '{"cust":"고객사 P/N","mfr":"제조사 P/N"}');
  insert into public.app_settings default values;

  insert into public.harness_bom (drawing_no, drawing_name, rev, bom_type, is_sample)
    values ('EX-HN-0001', '예시 도면', 'A', '신규', true) returning id into v_bom;
  perform set_config('test.a_bom', v_bom::text, false);
  insert into public.bom_connector (bom_id, line_no, pos, pn, poles) values
    (v_bom, 1, 'CN1', 'CA-1001', '2'), (v_bom, 2, 'CN1', 'CA-1001', '2');   -- 같은 위치 두 번도 저장은 된다
  insert into public.bom_circuit (bom_id, line_no, pos, pole, spec) values
    (v_bom, 1, 'CN1', '1', '0.5'), (v_bom, 2, 'CN1', '2', '0.85');
  insert into public.bom_choice (bom_id, issue_key, choice) values
    (v_bom, 'map|CA-1004', '{"pick":"MX-3P-030|RM-C0004"}');
  insert into public.bom_export_log (bom_id, drawing_no, rev, bom_type, file_format, line_count, open_issues, issue_codes)
    values (v_bom, 'EX-HN-0001', 'A', '신규', 'xlsx', 12, 2, '{"map_none":1,"spec_out":1}')
    returning id into v_log;
  perform set_config('test.a_log', v_log::text, false);

  perform public._assert_eq((select owner_id from public.harness_bom where id = v_bom),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'owner_id 가 auth.uid() 로 자동으로 채워진다');
  perform public._assert_eq((select multi_sep from public.app_settings), E',;\n', '설정 기본값이 도구 기본값과 같다');

  -- UNIQUE · upsert
  perform public._assert_raises(format(
    $q$insert into public.map_row (master_file_id, row_no, code) values (%s, 3, 'X')$q$, v_map),
    '23505', '같은 마스터의 같은 엑셀 행은 두 번 들어가지 않는다');
  perform public._assert_raises(
    $q$insert into public.harness_bom (drawing_no, rev) values ('EX-HN-0001', 'A')$q$,
    '23505', '같은 도면번호·Rev 는 한 벌만 저장된다');
  perform public._assert_raises(
    $q$insert into public.column_mapping (kind) values ('map')$q$,
    '23505', '열 연결은 종류(map/spec)당 한 행이다');
  insert into public.bom_choice (bom_id, issue_key, choice)
    values (v_bom, 'map|CA-1004', '{"manual":{"code":"RM-X"}}')
    on conflict (bom_id, issue_key) do update set choice = excluded.choice;
  perform public._assert((select choice ? 'manual' from public.bom_choice where issue_key = 'map|CA-1004'),
    'onConflict (bom_id, issue_key) upsert 가 갱신으로 동작한다');

  -- CHECK
  perform public._assert_raises(
    $q$insert into public.master_file (kind, file_name) values ('bom', 'x.xlsx')$q$,
    '23514', '마스터 종류는 map/spec 만 받는다');
  perform public._assert_raises(format(
    $q$insert into public.map_row (master_file_id, row_no) values (%s, 99)$q$, v_map),
    '23514', '세 품번이 모두 빈 매핑 행은 받지 않는다');
  perform public._assert_raises(format(
    $q$insert into public.spec_row (master_file_id, row_no, conn, term, min_sq, max_sq) values (%s, 9, '{A}', '{B}', 1.25, 0.5)$q$, v_spec),
    '23514', '전선 규격 하한이 상한보다 크면 막는다');
  perform public._assert_raises(format(
    $q$insert into public.spec_row (master_file_id, row_no, conn, term) values (%s, 10, '{}', '{B}')$q$, v_spec),
    '23514', '커넥터 품번이 빈 Spec 행은 받지 않는다');
  perform public._assert_raises(
    $q$insert into public.harness_bom (drawing_no, bom_type) values ('EX-2', '재작성')$q$,
    '23514', 'BOM 구분은 신규/설변만 받는다');
  perform public._assert_raises(
    $q$update public.app_settings set boundary = 'ignore'$q$,
    '23514', '경계값 처리는 include/review 만 받는다');
  perform public._assert_raises(
    $q$update public.app_settings set margin = -5$q$,
    '23514', '여유율은 0 이상이다');
  perform public._assert_raises(format(
    $q$insert into public.bom_choice (bom_id, issue_key, choice) values (%s, 'k2', '{"other":1}')$q$, v_bom),
    '23514', '담당자 선택은 pick 또는 manual 이어야 한다');

  -- 자식 표는 종류가 맞는 부모에만 붙는다
  perform public._assert_raises(format(
    $q$insert into public.map_row (master_file_id, row_no, code) values (%s, 50, 'X')$q$, v_spec),
    '42501', '매핑 행을 Application Spec 파일에 붙일 수 없다');

  update public.harness_bom set updated_at = '2000-01-01' where id = v_bom;
  perform public._assert((select updated_at > '2001-01-01' from public.harness_bom where id = v_bom),
    '수정하면 updated_at 트리거가 현재 시각으로 바꾼다');
end $t$;

do $t$ begin raise notice '[프로젝트] 도면 자재 판별 — drawing_file · drawing_mark · drawing_choice'; end $t$;
do $t$
declare v_dr bigint;
begin
  insert into public.drawing_file (file_name, file_type, unit, pages, drawing_no, customer)
    values ('예시도면_하네스_가상.pdf', 'pdf', 'pt', '[{"w":842,"h":595}]', 'HN-24-0001', '예시고객사A')
    returning id into v_dr;
  perform set_config('test.a_dr', v_dr::text, false);
  insert into public.drawing_mark (drawing_id, mark_key, page, x, y, w, h, pn, src) values
    (v_dr, 'm1', 1, 70, 285, 35.51, 9, 'CA-1001', 'pdf'),
    (v_dr, 'm2', 1, 327.06, 199.16, 117.88, 33.68, '', 'manual');       -- 위치만 표시(품번 빈 값)
  insert into public.drawing_choice (pn_key, choice) values ('CA1004', '{"pick":"MX-3P-031|RM-C0005"}');
  insert into public.drawing_choice (pn_key, choice) values ('CA1004', '{"isNew":true}')
    on conflict (owner_id, pn_key) do update set choice = excluded.choice;
  perform public._assert((select choice ? 'isNew' from public.drawing_choice where pn_key = 'CA1004'),
    'onConflict (owner_id, pn_key) upsert 가 갱신으로 동작한다');
  perform public._assert_eq((select (draw->>'minLen')::int from public.app_settings), 4, 'app_settings.draw 기본값이 도구 기본값과 같다');

  perform public._assert_raises(format(
    $q$insert into public.drawing_mark (drawing_id, mark_key, x, y, w, h, src) values (%s, 'm1', 0, 0, 1, 1, 'pdf')$q$, v_dr),
    '23505', '같은 도면의 같은 표시 id 는 두 번 들어가지 않는다');
  perform public._assert_raises(format(
    $q$insert into public.drawing_mark (drawing_id, mark_key, x, y, w, h, src) values (%s, 'm9', 0, 0, 1, 1, 'ocr')$q$, v_dr),
    '23514', '추출 방식은 pdf·manual 만');
  perform public._assert_raises(format(
    $q$insert into public.drawing_mark (drawing_id, mark_key, page, x, y, w, h, src) values (%s, 'm9', 0, 0, 0, 1, 1, 'pdf')$q$, v_dr),
    '23514', '쪽 번호는 1 이상');
  perform public._assert_raises(format(
    $q$insert into public.drawing_mark (drawing_id, mark_key, x, y, w, h, src) values (%s, 'm9', -1, 0, 1, 1, 'pdf')$q$, v_dr),
    '23514', '좌표는 0 이상');
  perform public._assert_raises(
    $q$insert into public.drawing_file (file_name, file_type, unit) values ('a.png', 'image', 'pt')$q$,
    '23514', '이미지 도면의 좌표 단위는 px');
  perform public._assert_raises(
    $q$insert into public.drawing_choice (pn_key, choice) values ('X1', '{"other":1}')$q$,
    '23514', '담당자 처리는 pick·code·isNew 중 하나');
  perform public._assert_raises(
    $q$update public.app_settings set draw = '[]'::jsonb$q$,
    '23514', 'app_settings.draw 는 객체만');
end $t$;

do $t$ begin raise notice '[프로젝트] v0.3 — 커넥터 부자재(sub_row) · 고객사 규칙(customer_profile) · 부품표 표시'; end $t$;
do $t$
declare v_sub bigint;
begin
  insert into public.master_file (kind, file_name) values ('sub', '예시데이터_커넥터부자재마스터.xlsx') returning id into v_sub;
  perform set_config('test.a_sub', v_sub::text, false);
  insert into public.sub_row (master_file_id, row_no, conn, sub_kind, pn, code, qty) values
    (v_sub, 3, 'MX-2P-001', '터미널', 'TM-050-A', 'RM-T0001', '2');
  insert into public.column_mapping (kind, col_names) values ('sub', '{"conn":"커넥터 품번"}');
  insert into public.customer_profile (profile_key, name, layout, keywords, patterns, xref, table_roles) values
    ('sample-b', '예시고객사B', 'table', array['CUSTOMER: SAMPLE-B'],
     '[{"re":"^[A-Z]{2}-[0-9]{4}$","type":"cust","auto":true}]', '[{"cust":"CB-2210","mfr":"MX-2P-001"}]', '{"MAKERP/N":"mfr"}');
  insert into public.customer_profile (profile_key, name) values ('sample-b', '예시고객사B 고침')
    on conflict (owner_id, profile_key) do update set name = excluded.name;
  perform public._assert_eq((select name from public.customer_profile where profile_key = 'sample-b'), '예시고객사B 고침',
    'onConflict (owner_id, profile_key) upsert 가 갱신으로 동작한다');
  insert into public.drawing_mark (drawing_id, mark_key, x, y, w, h, pn, src, pn_type, cust_pn, qty) values
    (current_setting('test.a_dr')::bigint, 't1', 552, 72, 38, 7.5, 'MX-8P-040', 'table', 'mfr', 'CB-2208', '1');

  perform public._assert_raises(format(
    $q$insert into public.sub_row (master_file_id, row_no, conn) values (%s, 4, 'MX-2P-001')$q$, v_sub),
    '23514', '부자재 행에는 부자재 품번이나 사내 코드가 있어야 한다');
  perform public._assert_raises(format(
    $q$insert into public.sub_row (master_file_id, row_no, conn, pn) values (%s, 5, 'MX-2P-001', 'X')$q$, current_setting('test.a_map')),
    '42501', '부자재 행은 kind=sub 마스터에만 붙는다');
  perform public._assert_raises(
    $q$insert into public.master_file (kind, file_name) values ('etc', 'x.xlsx')$q$,
    '23514', '마스터 종류는 map·spec·sub 만');
  perform public._assert_raises(
    $q$insert into public.customer_profile (profile_key, name, layout) values ('p9', 'X', 'grid')$q$,
    '23514', '도면 방식은 label·table 만');
  perform public._assert_raises(
    $q$insert into public.customer_profile (profile_key, name, xref) values ('p9', 'X', '{}')$q$,
    '23514', '대조표는 배열만');
  perform public._assert_raises(format(
    $q$insert into public.drawing_mark (drawing_id, mark_key, x, y, w, h, src, pn_type) values (%s, 't9', 0, 0, 1, 1, 'table', 'maker')$q$, current_setting('test.a_dr')),
    '23514', '품번 종류는 빈 값·mfr·cust 만');
end $t$;

do $t$ begin raise notice '[프로젝트] 기록성 표(bom_export_log)'; end $t$;
do $t$ begin
  perform public._assert_rows(
    'update public.bom_export_log set open_issues = 0 where id = ' || current_setting('test.a_log'),
    0, 'bom_export_log 는 본인도 UPDATE 할 수 없다(0행)');
  perform public._assert_rows(
    'delete from public.bom_export_log where id = ' || current_setting('test.a_log'),
    0, 'bom_export_log 는 본인도 DELETE 할 수 없다(0행)');
  perform public._assert_eq((select open_issues from public.bom_export_log
                              where id = current_setting('test.a_log')::bigint),
    2, 'bom_export_log 값이 그대로 남아 있다');
end $t$;

-- ── 사용자 B ───────────────────────────────────────────────────
do $t$ begin perform set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', false); end $t$;

do $t$ begin raise notice '[프로젝트] RLS — 사용자 B 는 A 의 자료에 손대지 못한다'; end $t$;
do $t$
declare
  t text;
  v_bom text := current_setting('test.a_bom');
  v_map text := current_setting('test.a_map');
begin
  foreach t in array array['master_file', 'map_row', 'spec_row', 'column_mapping', 'harness_bom',
                           'bom_connector', 'bom_circuit', 'bom_choice', 'app_settings', 'bom_export_log',
                           'drawing_file', 'drawing_mark', 'drawing_choice', 'sub_row', 'customer_profile']
  loop
    perform public._assert_rows(format('select 1 from public.%I', t), 0, 'B 에게 A 의 ' || t || ' 가 안 보인다');
  end loop;

  perform public._assert_rows('update public.harness_bom set drawing_no = $$탈취$$ where id = ' || v_bom,
    0, 'B 는 A 의 harness_bom 을 고칠 수 없다(0행)');
  perform public._assert_rows('delete from public.bom_circuit where bom_id = ' || v_bom,
    0, 'B 는 A 의 bom_circuit 을 지울 수 없다(0행)');
  perform public._assert_rows('delete from public.map_row where master_file_id = ' || v_map,
    0, 'B 는 A 의 map_row 를 지울 수 없다(0행)');
  perform public._assert_rows('update public.app_settings set margin = 50',
    0, 'B 는 A 의 app_settings 를 고칠 수 없다(0행)');

  perform public._assert_raises(
    $q$insert into public.harness_bom (owner_id, drawing_no) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '위장')$q$,
    '42501', 'B 는 owner_id 를 A 로 위장해 넣을 수 없다');
  perform public._assert_raises(format(
    $q$insert into public.bom_connector (bom_id, line_no, pos) values (%s, 9, 'CN9')$q$, v_bom),
    '42501', 'B 는 A 의 도면에 커넥터를 끼워 넣을 수 없다');
  perform public._assert_raises(format(
    $q$insert into public.bom_choice (bom_id, issue_key, choice) values (%s, 'x', '{"pick":"y"}')$q$, v_bom),
    '42501', 'B 는 A 의 도면에 담당자 선택을 끼워 넣을 수 없다');
  perform public._assert_raises(format(
    $q$insert into public.map_row (master_file_id, row_no, code) values (%s, 77, 'X')$q$, v_map),
    '42501', 'B 는 A 의 마스터에 행을 끼워 넣을 수 없다');
  perform public._assert_raises(format(
    $q$insert into public.drawing_mark (drawing_id, mark_key, x, y, w, h, src) values (%s, 'b1', 0, 0, 1, 1, 'manual')$q$,
    current_setting('test.a_dr')),
    '42501', 'B 는 A 의 도면에 자재 표시를 끼워 넣을 수 없다');
  perform public._assert_rows('update public.drawing_mark set pn = $$탈취$$ where drawing_id = ' || current_setting('test.a_dr'),
    0, 'B 는 A 의 drawing_mark 를 고칠 수 없다(0행)');
  perform public._assert_raises(format(
    $q$insert into public.sub_row (master_file_id, row_no, conn, pn) values (%s, 9, 'MX-9', 'X')$q$, current_setting('test.a_sub')),
    '42501', 'B 는 A 의 부자재 마스터에 행을 끼워 넣을 수 없다');
  perform public._assert_rows('update public.customer_profile set name = $$탈취$$', 0, 'B 는 A 의 고객사 규칙을 고칠 수 없다(0행)');
  -- B 도 같은 규칙 id 로 자기 규칙을 둘 수 있다(UNIQUE 는 사용자별)
  insert into public.customer_profile (profile_key, name) values ('sample-b', 'B 의 규칙');
  -- B 도 같은 품번 열쇠로 자기 처리를 둘 수 있다(UNIQUE 는 사용자별)
  insert into public.drawing_choice (pn_key, choice) values ('CA1004', '{"code":"RM-B"}');
  perform public._assert_raises(format(
    $q$insert into public.bom_export_log (bom_id, bom_type, file_format) values (%s, '신규', 'xlsx')$q$, v_bom),
    '42501', 'B 의 내보내기 기록이 A 의 도면을 가리킬 수 없다');

  -- B 도 같은 도면번호로 자기 것을 만들 수 있다(도면번호 UNIQUE 는 사용자별)
  insert into public.harness_bom (drawing_no, rev) values ('EX-HN-0001', 'A');
  perform public._assert_rows('select 1 from public.harness_bom', 1, 'B 는 자기 harness_bom 만 본다');
end $t$;

-- ── 비로그인(anon) ─────────────────────────────────────────────
reset role;
set role anon;
do $t$ begin perform set_config('request.jwt.claim.sub', '', false); end $t$;

do $t$ begin raise notice '[프로젝트] anon 차단'; end $t$;
do $t$
declare t text;
begin
  foreach t in array array['master_file', 'map_row', 'spec_row', 'column_mapping', 'harness_bom',
                           'bom_connector', 'bom_circuit', 'bom_choice', 'app_settings', 'bom_export_log',
                           'drawing_file', 'drawing_mark', 'drawing_choice', 'sub_row', 'customer_profile']
  loop
    perform public._assert_rows(format('select 1 from public.%I', t), 0, 'anon 에게 ' || t || ' 가 안 보인다');
  end loop;
  perform public._assert_raises($q$insert into public.harness_bom (drawing_no) values ('익명')$q$,
    '42501', 'anon 은 harness_bom 을 쓸 수 없다');
  perform public._assert_raises($q$insert into public.master_file (kind, file_name) values ('map', 'x')$q$,
    '42501', 'anon 은 master_file 을 쓸 수 없다');
  perform public._assert_raises($q$insert into public.bom_export_log (bom_type, file_format) values ('신규', 'csv')$q$,
    '42501', 'anon 은 bom_export_log 를 쓸 수 없다');
  perform public._assert_raises($q$insert into public.drawing_file (file_name, file_type, unit) values ('x.pdf', 'pdf', 'pt')$q$,
    '42501', 'anon 은 drawing_file 을 쓸 수 없다');
  perform public._assert_raises($q$select public.set_updated_at()$q$,
    '42501', 'anon 은 set_updated_at() 을 실행할 수 없다');
end $t$;

reset role;

-- ── 함수 ACL ───────────────────────────────────────────────────
do $t$ begin raise notice '[프로젝트] 함수 ACL (proacl)'; end $t$;
do $t$
declare v_bad text;
begin
  -- 이 스키마에는 anon 예외 함수가 없다(RLS 정책 식에서 함수를 쓰지 않음)
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         lateral aclexplode(p.proacl) a
   where n.nspname = 'public' and p.proname not like '\_assert%'
     and a.privilege_type = 'EXECUTE'
     and (a.grantee = 0 or a.grantee = 'anon'::regrole);
  perform public._assert(v_bad is null,
    'proacl 에 PUBLIC·anon EXECUTE 가 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
  perform public._assert(
    (select bool_and(proacl is not null) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname not like '\_assert%'),
    '모든 함수의 proacl 이 기본값(NULL=PUBLIC 실행)이 아니다');
  perform public._assert(
    (select bool_and(proconfig @> array['search_path=public'])
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname not like '\_assert%'),
    '모든 함수가 search_path = public 으로 고정돼 있다');
end $t$;

-- 정리
delete from public.bom_export_log;
delete from public.drawing_choice;
delete from public.customer_profile;
delete from public.drawing_file;
delete from public.app_settings;
delete from public.column_mapping;
delete from public.harness_bom;
delete from public.master_file;
delete from auth.users where email in ('a@example.com', 'b@example.com');

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
