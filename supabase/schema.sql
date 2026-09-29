-- ============================================================================
-- data09-16 — 하네스 BOM 산출 도구 (부품 매핑 마스터 × Application Spec × 부품 LIST)
-- Supabase(PostgreSQL) 스키마 + RLS
--
--  무엇인가 : 지금 브라우저 localStorage 에만 두는 마스터 엑셀 2종·부품 LIST·
--             담당자 선택·설정·열 연결(매핑)을 DB 로 옮길 때 쓸 테이블과 보안 정책입니다.
--             BOM 내보내기 기록(bom_export_log)은 기획서 8장 3단계
--             「매칭 실패 이력을 모아 마스터 데이터 보완 목록 생성」을 위한 표입니다.
--  실행 위치 : 수강생 본인 Supabase 프로젝트의 SQL Editor 에서 실행
--  재실행    : 안전합니다 (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS 선행)
--
--  본인 프로젝트에 올리는 것을 전제로 하므로 테이블 이름에 접두사를 붙이지 않았습니다.
--  회사 공용 URL·키는 어디에도 들어 있지 않습니다.
--
--  테이블 (13개) — 2026-09-29 v0.2: 도면 자재 판별 3개(drawing_*) + app_settings.draw 칼럼 추가
--    master_file     — 올린 마스터 엑셀 한 벌 (kind: map=부품 매핑 마스터 / spec=Application Spec)
--    map_row         — 부품 매핑 마스터 한 행 (고객사 품번·제조사 품번·사내 자재 코드 …)
--    spec_row        — Application Spec 한 행 (커넥터·터미널·실·방수전·전선 규격 범위)
--    column_mapping  — 표준 항목 ↔ 실제 열 이름 연결 (다음 파일에 재사용)
--    harness_bom     — 도면 한 장의 머리 정보 (도면번호·Rev·고객사·신규/설변)
--    bom_connector   — 부품 LIST 의 커넥터 한 줄 (위치·품번·극수)
--    bom_circuit     — 부품 LIST 의 회로 한 줄 (위치·극·전선 규격·전선 종류)
--    bom_choice      — 확인 대상에 대한 담당자 선택 (후보 선택 또는 직접 입력)
--    app_settings    — 사용자별 산출 설정 (여유율·경계값 처리·방수전·단위·구분 기호·정규화)
--    bom_export_log  — BOM 내보내기 기록 — 기록성, 수정·삭제 불가
--    drawing_file    — 도면 자재 판별에 올린 도면 한 건 (파일 이름·PDF/이미지·쪽 크기·도면번호·고객사)
--    drawing_mark    — 도면 위 자재 표시 한 개 (쪽·좌표·도면 표기 품번·자재 종류·추출 방식)
--    drawing_choice  — 품번별 담당자 처리 (후보 선택·사내 코드 직접 입력·신규 확정)
--
--  도면 PDF·이미지 원본은 저장하지 않습니다(고객사 설계 기밀). 도면에서 읽은 값(품번·좌표)만 저장합니다.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

-- 마스터 엑셀 한 벌 (app.js state.masters.map / state.masters.spec)
create table if not exists public.master_file (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  kind        text not null check (kind in ('map', 'spec')),
  file_name   text not null check (length(btrim(file_name)) > 0),
  sheet       text not null default '',
  header_row  int not null default 0 check (header_row >= 0),
  col_names   jsonb not null default '{}'::jsonb,       -- names: 표준 항목 → 실제 열 이름
  skipped     int not null default 0 check (skipped >= 0),
  no_range    int not null default 0 check (no_range >= 0),
  bad_range   int[] not null default '{}',              -- 전선 규격 범위를 못 읽은 엑셀 행 번호
  is_sample   boolean not null default false,           -- state.sample.map / .spec
  loaded_at   date not null default current_date,       -- at
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists master_file_owner_idx on public.master_file (owner_id, kind, created_at desc);

-- 부품 매핑 마스터 행 (logic.js buildMapTable: { row, cust, mfr, code, name, kind, customer })
create table if not exists public.map_row (
  id              bigint generated always as identity primary key,
  owner_id        uuid not null default auth.uid(),
  master_file_id  bigint not null references public.master_file(id) on delete cascade,
  row_no          int not null check (row_no > 0),
  cust            text not null default '',   -- 고객사 품번
  mfr             text not null default '',   -- 제조사 품번
  code            text not null default '',   -- 사내 자재 코드
  name            text not null default '',   -- 품명
  kind            text not null default '',   -- 자재 구분 (커넥터·터미널·실·방수전 …)
  customer        text not null default '',   -- 고객사
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- 도구는 세 품번이 모두 빈 행을 건너뛴다
  constraint map_row_has_pn check (cust <> '' or mfr <> '' or code <> ''),
  -- ⚠ upsert 시 onConflict: 'master_file_id,row_no'
  constraint map_row_file_row_key unique (master_file_id, row_no)
);
create index if not exists map_row_mfr_idx  on public.map_row (master_file_id, mfr);
create index if not exists map_row_cust_idx on public.map_row (master_file_id, cust);

-- Application Spec 행 (logic.js buildSpecTable: { row, conn[], term[], seal[], plug[], min, max, wire, noRange })
create table if not exists public.spec_row (
  id              bigint generated always as identity primary key,
  owner_id        uuid not null default auth.uid(),
  master_file_id  bigint not null references public.master_file(id) on delete cascade,
  row_no          int not null check (row_no > 0),
  conn            text[] not null check (cardinality(conn) > 0),   -- 커넥터 품번(한 칸에 여럿 가능)
  term            text[] not null check (cardinality(term) > 0),   -- 터미널 품번
  seal            text[] not null default '{}',                    -- 와이어 실 품번
  plug            text[] not null default '{}',                    -- 방수전 품번
  min_sq          numeric check (min_sq is null or min_sq >= 0),   -- 적용 전선 규격 하한
  max_sq          numeric check (max_sq is null or max_sq >= 0),   -- 적용 전선 규격 상한
  wire            text not null default '',                        -- 전선 종류
  no_range        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint spec_row_range_order check (min_sq is null or max_sq is null or min_sq <= max_sq),
  constraint spec_row_no_range check (no_range = (min_sq is null and max_sq is null)),
  constraint spec_row_file_row_key unique (master_file_id, row_no)
);

-- 열 연결 설정 (localStorage 'data09-16.mappings' = { map: names, spec: names })
-- 데이터를 지워도 남겨 다음 파일에 재사용한다 — 사용자·종류당 한 행
create table if not exists public.column_mapping (
  owner_id    uuid not null default auth.uid(),
  kind        text not null check (kind in ('map', 'spec')),
  col_names   jsonb not null default '{}'::jsonb check (jsonb_typeof(col_names) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (owner_id, kind)
);

-- 도면 머리 정보 (state.parts.header). 지금 도구는 도면 하나만 기억하지만 DB 에서는 여러 장을 쌓는다.
-- DB 에 저장할 때는 도면번호가 있어야 한다(같은 도면·같은 Rev 는 한 벌).
create table if not exists public.harness_bom (
  id            bigint generated always as identity primary key,
  owner_id      uuid not null default auth.uid(),
  drawing_no    text not null check (length(btrim(drawing_no)) > 0),
  drawing_name  text not null default '',
  rev           text not null default '',
  customer      text not null default '',
  bom_type      text not null default '신규' check (bom_type in ('신규', '설변')),
  is_sample     boolean not null default false,               -- state.sample.parts
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- ⚠ upsert 시 onConflict: 'owner_id,drawing_no,rev'
  constraint harness_bom_drawing_key unique (owner_id, drawing_no, rev)
);

-- 커넥터 표 (state.parts.connectors: { pos, pn, poles }) — 입력한 그대로(문자열) 저장한다.
-- 같은 위치가 두 번 들어오는 것은 도구가 확인 대상(conn_dup_pos)으로 알려 주므로
-- 여기서 막지 않고 줄 번호(line_no)로 구분한다.
create table if not exists public.bom_connector (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  bom_id      bigint not null references public.harness_bom(id) on delete cascade,
  line_no     int not null check (line_no > 0),
  pos         text not null default '',   -- 커넥터 위치(기호) CN1 …
  pn          text not null default '',   -- 도면에 적힌 커넥터 품번
  poles       text not null default '',   -- 극수
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint bom_connector_line_key unique (bom_id, line_no)
);

-- 회로 표 (state.parts.circuits: { pos, pole, spec, wire })
create table if not exists public.bom_circuit (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  bom_id      bigint not null references public.harness_bom(id) on delete cascade,
  line_no     int not null check (line_no > 0),
  pos         text not null default '',
  pole        text not null default '',
  spec        text not null default '',   -- 전선 규격(입력 그대로 — '0.85', '0.85sq' …)
  wire        text not null default '',   -- 전선 종류
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint bom_circuit_line_key unique (bom_id, line_no)
);

-- 담당자 선택 (state.choices[issueKey] = { pick: 후보 id } | { manual: {...} })
create table if not exists public.bom_choice (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  bom_id      bigint not null references public.harness_bom(id) on delete cascade,
  issue_key   text not null check (length(issue_key) > 0),
  choice      jsonb not null check (jsonb_typeof(choice) = 'object' and (choice ? 'pick' or choice ? 'manual')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- ⚠ upsert 시 onConflict: 'bom_id,issue_key'
  constraint bom_choice_issue_key unique (bom_id, issue_key)
);

-- 산출 설정 (logic.js DEFAULT_SETTINGS) — 사용자당 한 행
create table if not exists public.app_settings (
  owner_id    uuid primary key default auth.uid(),
  margin      numeric not null default 0 check (margin >= 0),                    -- 종속 자재 여유율 %
  boundary    text not null default 'include' check (boundary in ('include', 'review')),
  plug        boolean not null default false,                                    -- 빈 극에 방수전 넣기
  unit        text not null default 'sq' check (length(btrim(unit)) > 0),
  multi_sep   text not null default $sep$,;
$sep$,                                                                          -- 쉼표·세미콜론·줄바꿈
  norm        jsonb not null default '{"space": true, "hyphen": true, "upper": true, "dot": false}'::jsonb
              check (jsonb_typeof(norm) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- BOM 내보내기 기록 — 기록성이라 UPDATE/DELETE 정책이 없다
create table if not exists public.bom_export_log (
  id             bigint generated always as identity primary key,
  owner_id       uuid not null default auth.uid(),
  bom_id         bigint references public.harness_bom(id) on delete set null,
  drawing_no     text not null default '',
  rev            text not null default '',
  bom_type       text not null check (bom_type in ('신규', '설변')),
  file_format    text not null check (file_format in ('xlsx', 'csv')),
  line_count     int not null default 0 check (line_count >= 0),
  open_issues    int not null default 0 check (open_issues >= 0),   -- 내보낼 때 남아 있던 확인 대상 수
  issue_codes    jsonb not null default '{}'::jsonb,                -- { map_none: 2, spec_out: 1, … }
  exported_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
create index if not exists bom_export_log_owner_idx on public.bom_export_log (owner_id, exported_at desc);

-- ── 도면 자재 판별 (기획서 v0.2 1차 목표, js/view-drawing.js) ──────────────
-- 올린 도면 한 건 (state.drawing: fileName, type, unit, pages, info, sample). 원본 파일은 넣지 않는다.
create table if not exists public.drawing_file (
  id            bigint generated always as identity primary key,
  owner_id      uuid not null default auth.uid(),
  file_name     text not null check (length(btrim(file_name)) > 0),
  file_type     text not null check (file_type in ('pdf', 'image')),
  unit          text not null check (unit in ('pt', 'px')),          -- 좌표 단위: PDF=pt, 이미지=px
  pages         jsonb not null default '[]'::jsonb check (jsonb_typeof(pages) = 'array'),   -- [{w,h}] 쪽 크기
  drawing_no    text not null default '',
  customer      text not null default '',                           -- 이 고객사 품번으로 대조
  is_sample     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint drawing_file_unit_ok check ((file_type = 'pdf' and unit = 'pt') or (file_type = 'image' and unit = 'px'))
);

-- 도면 위 자재 표시 (state.drawing.marks: { id, page, x, y, w, h, pn, src, kind }) — 좌표는 쪽 왼쪽 위 기준
create table if not exists public.drawing_mark (
  id           bigint generated always as identity primary key,
  owner_id     uuid not null default auth.uid(),
  drawing_id   bigint not null references public.drawing_file(id) on delete cascade,
  mark_key     text not null check (length(mark_key) > 0),   -- 도구 안의 표시 id(m1, m2 …)
  page         int not null default 1 check (page > 0),
  x            numeric not null check (x >= 0),
  y            numeric not null check (y >= 0),
  w            numeric not null check (w >= 0),
  h            numeric not null check (h >= 0),
  pn           text not null default '',                     -- 도면 표기 품번(빈 값 = 위치만 표시)
  kind         text not null default '',                     -- 담당자가 고친 자재 종류(빈 값 = 마스터·추정 값)
  src          text not null check (src in ('pdf', 'manual')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- ⚠ upsert 시 onConflict: 'drawing_id,mark_key'
  constraint drawing_mark_key unique (drawing_id, mark_key)
);

-- 품번별 담당자 처리 (state.drawChoices[정리한 품번] = { pick } | { code, mfr, name } | { isNew: true })
-- 도구는 같은 품번이면 도면이 달라도 같은 처리를 쓰므로 사용자·품번 단위로 한 행이다.
create table if not exists public.drawing_choice (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  pn_key      text not null check (length(pn_key) > 0),
  choice      jsonb not null check (jsonb_typeof(choice) = 'object' and (choice ? 'pick' or choice ? 'code' or choice ? 'isNew')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- ⚠ upsert 시 onConflict: 'owner_id,pn_key'
  constraint drawing_choice_key unique (owner_id, pn_key)
);

-- 품번 후보 규칙 (drawing-logic.js DEFAULT_DRAW_SETTINGS) — 기존 app_settings 에 칼럼으로 붙인다
alter table public.app_settings add column if not exists draw jsonb not null
  default '{"minLen": 4, "needMix": true, "wireFilter": true, "exclude": "", "fuzzy": 1, "confusable": true}'::jsonb;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_draw_object') then
    alter table public.app_settings add constraint app_settings_draw_object check (jsonb_typeof(draw) = 'object');
  end if;
end $c$;

-- ----------------------------------------------------------------------------
-- 2. 함수 — search_path 고정
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

do $trg$
declare t text;
begin
  foreach t in array array['master_file', 'map_row', 'spec_row', 'column_mapping', 'harness_bom',
                           'bom_connector', 'bom_circuit', 'bom_choice', 'app_settings',
                           'drawing_file', 'drawing_mark', 'drawing_choice']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
                   t || '_updated_at', t);
  end loop;
end;
$trg$;

-- ----------------------------------------------------------------------------
-- 3. RLS — 행은 만든 사람(owner_id)만 보고 고친다. 비로그인(anon)은 아무것도 못 한다.
-- ----------------------------------------------------------------------------

alter table public.master_file    enable row level security;
alter table public.map_row        enable row level security;
alter table public.spec_row       enable row level security;
alter table public.column_mapping enable row level security;
alter table public.harness_bom    enable row level security;
alter table public.bom_connector  enable row level security;
alter table public.bom_circuit    enable row level security;
alter table public.bom_choice     enable row level security;
alter table public.app_settings   enable row level security;
alter table public.bom_export_log enable row level security;
alter table public.drawing_file   enable row level security;
alter table public.drawing_mark   enable row level security;
alter table public.drawing_choice enable row level security;

-- 3-1. 부모 표 : 본인 행만 읽기·쓰기·수정·삭제
do $rls$
declare t text;
begin
  foreach t in array array['master_file', 'column_mapping', 'harness_bom', 'app_settings', 'drawing_file', 'drawing_choice']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid())',
                   t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid())',
                   t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
                   t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid())',
                   t || '_delete', t);
  end loop;
end;
$rls$;

-- 3-2. 자식 표 : 본인 행이면서, 붙는 부모 행도 본인 것이어야 한다(남의 도면·마스터에 끼워 넣기 방지).
--      마스터 행은 종류도 맞아야 한다(map_row 는 kind='map' 파일에만, spec_row 는 'spec' 에만).
do $rls$
declare
  r record;
begin
  for r in
    select * from (values
      ('map_row',       'exists (select 1 from public.master_file f where f.id = master_file_id and f.owner_id = auth.uid() and f.kind = ''map'')'),
      ('spec_row',      'exists (select 1 from public.master_file f where f.id = master_file_id and f.owner_id = auth.uid() and f.kind = ''spec'')'),
      ('bom_connector', 'exists (select 1 from public.harness_bom b where b.id = bom_id and b.owner_id = auth.uid())'),
      ('bom_circuit',   'exists (select 1 from public.harness_bom b where b.id = bom_id and b.owner_id = auth.uid())'),
      ('bom_choice',    'exists (select 1 from public.harness_bom b where b.id = bom_id and b.owner_id = auth.uid())'),
      ('drawing_mark',  'exists (select 1 from public.drawing_file d where d.id = drawing_id and d.owner_id = auth.uid())')
    ) as v(t, parent_ok)
  loop
    execute format('drop policy if exists %I on public.%I', r.t || '_select', r.t);
    execute format('drop policy if exists %I on public.%I', r.t || '_insert', r.t);
    execute format('drop policy if exists %I on public.%I', r.t || '_update', r.t);
    execute format('drop policy if exists %I on public.%I', r.t || '_delete', r.t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid())',
                   r.t || '_select', r.t);
    execute format('create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid() and %s)',
                   r.t || '_insert', r.t, r.parent_ok);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid() and %s)',
                   r.t || '_update', r.t, r.parent_ok);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid())',
                   r.t || '_delete', r.t);
  end loop;
end;
$rls$;

-- 3-3. 기록성 표 : 읽기·추가만. 수정·삭제 정책을 두지 않아 사후 조작을 막는다.
drop policy if exists bom_export_log_select on public.bom_export_log;
drop policy if exists bom_export_log_insert on public.bom_export_log;
create policy bom_export_log_select on public.bom_export_log for select to authenticated
  using (owner_id = auth.uid());
create policy bom_export_log_insert on public.bom_export_log for insert to authenticated
  with check (owner_id = auth.uid()
              and (bom_id is null
                   or exists (select 1 from public.harness_bom b
                               where b.id = bom_id and b.owner_id = auth.uid())));

-- ----------------------------------------------------------------------------
-- 4. 함수 실행 권한
--
--  GRANT 만으로는 제한되지 않는다. 권한이 두 겹으로 미리 붙는다.
--    ① PostgreSQL 이 함수 생성 시 PUBLIC 에 EXECUTE 기본 부여
--    ② Supabase 가 신규 함수마다 anon·authenticated·service_role 에 자동 부여
--  그래서 PUBLIC 과 anon 을 둘 다 끊고 authenticated 에만 다시 준다.
--  (이 스키마에는 RLS 정책 식에서 쓰는 함수가 없으므로 anon 예외도 없다)
-- ----------------------------------------------------------------------------

revoke all on function public.set_updated_at() from public, anon;
-- 트리거 전용 함수. 트리거 발화 시 호출자 EXECUTE 를 검사할 경우를 대비해 남긴다.
-- 직접 호출하면 "can only be called as trigger" 로 죽으므로 무해하다.
grant execute on function public.set_updated_at() to authenticated;

-- ----------------------------------------------------------------------------
-- 끝.
-- ----------------------------------------------------------------------------
