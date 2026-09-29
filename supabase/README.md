# Supabase DB 스크립트 — 하네스 BOM 산출 도구

이 폴더에는 하네스 BOM 산출 도구의 자료를 데이터베이스(Supabase)에 저장할 때 쓰는 SQL 스크립트가 들어 있습니다.
지금 도구는 이 스크립트 없이도 그대로 동작합니다.
앱을 DB 에 연결하는 일은 다음 단계에서 진행합니다.

## 왜 DB 가 필요한가

지금 도구는 마스터 엑셀 2종, 부품 LIST, 담당자 선택, 설정을 브라우저 저장소(localStorage)에만 둡니다.
이 방식에는 다음과 같은 한계가 있습니다.

- **팀이 같은 마스터를 함께 쓸 수 없습니다.** 부품 매핑 마스터와 Application Spec 을 사람마다 따로 올려야 하고, 누가 어느 판을 쓰는지 알 수 없습니다.
- **도면이 한 장만 남습니다.** 새 도면을 입력하면 이전 도면의 부품 LIST 와 담당자 선택이 사라집니다. 기획서 5장의 「설변 BOM 비교(기존 BOM 대비 추가·삭제·변경)」를 하려면 도면·Rev 별로 쌓아 두어야 합니다.
- **용량이 작습니다.** 마스터 엑셀이 수천 행이 되면 브라우저 저장소가 가득 차 저장이 멈출 수 있습니다(도구가 이미 이 경우를 경고합니다).
- **매칭 실패 이력이 남지 않습니다.** 기획서 8장 3단계의 「매칭 실패 이력을 모아 마스터 데이터 보완 목록 생성」을 하려면 내보낼 때마다 남은 확인 대상을 기록해야 합니다.

도면 PDF 원본은 DB 에 넣지 않습니다.
고객사 설계 기밀이므로 도면에서 읽은 값(커넥터·회로 표)만 저장합니다.

## 테이블

| 테이블 | 용도 | localStorage 대응 |
|---|---|---|
| `master_file` | 올린 마스터 엑셀 한 벌(종류 map/spec, 파일·시트 이름, 머리행, 열 이름, 건너뛴 행 수) | `data09-16.state` 의 `masters.map`·`masters.spec`, `sample.map`·`sample.spec` |
| `map_row` | 부품 매핑 마스터 한 행(고객사 품번, 제조사 품번, 사내 자재 코드, 품명, 구분, 고객사) | `masters.map.rows[]` |
| `spec_row` | Application Spec 한 행(커넥터·터미널·실·방수전 품번 목록, 전선 규격 하한·상한, 전선 종류) | `masters.spec.rows[]` |
| `column_mapping` | 표준 항목과 실제 열 이름의 연결(다음 파일에 재사용) | `data09-16.mappings` |
| `harness_bom` | 도면 머리 정보(도면번호, 도면명, Rev, 고객사, 신규/설변) | `parts.header`, `sample.parts` |
| `bom_connector` | 커넥터 표 한 줄(위치, 품번, 극수) | `parts.connectors[]` |
| `bom_circuit` | 회로 표 한 줄(위치, 극, 전선 규격, 전선 종류) | `parts.circuits[]` |
| `bom_choice` | 확인 대상에 대한 담당자 선택(후보 선택 또는 직접 입력) | `choices` |
| `app_settings` | 산출 설정(여유율, 경계값 처리, 방수전, 단위, 구분 기호, 품번 정규화) | `settings` |
| `bom_export_log` | BOM 내보내기 기록(도면번호, 줄 수, 남은 확인 대상 수와 사유별 건수) | 없음(새로 추가, 3단계용) |
| `drawing_file` | 도면 자재 판별에 올린 도면 한 건(파일 이름, PDF/이미지, 좌표 단위 pt/px, 쪽 크기, 도면번호, 고객사). 원본 파일은 넣지 않음 | `drawing` (2026-09-29 v0.2 추가) |
| `drawing_mark` | 도면 위 자재 표시 한 개(쪽, 좌표 x·y·w·h, 도면 표기 품번, 자재 종류, 추출 방식 pdf/manual/table, v0.3: 품번 종류·같은 행 고객사 품번·수량·품명) | `drawing.marks[]` |
| `drawing_choice` | 품번별 담당자 처리(후보 선택·사내 코드 직접 입력·신규 확정). 사용자·품번당 한 행 | `drawChoices` |
| `sub_row` | (v0.3) 커넥터 부자재 마스터 한 행(커넥터 품번 → 부자재 구분·품번·사내 코드·1개당 수량). `master_file.kind='sub'` 에만 붙음 | `masters.sub.rows[]` |
| `customer_profile` | (v0.3) 고객사별 학습 규칙(도면 방식·표제란 알아보기 글자·예시·품번 모양·대조표·부품표 열·제외 목록). 사용자·규칙 id 당 한 행 | `profiles[]` |

`app_settings` 에는 품번 후보 규칙(`draw` jsonb — 최소 글자 수, 영문+숫자, 전선 규격 거르기, 제외 목록, 비슷한 품번 기준)이 칼럼으로 붙었습니다(`drawSettings`). 재실행해도 안전합니다(`add column if not exists`).

지켜지는 규칙은 다음과 같습니다.

- 마스터 종류는 `map`·`spec` 두 가지이고, 매핑 행은 map 파일에만, Spec 행은 spec 파일에만 붙습니다.
- 매핑 행은 고객사 품번·제조사 품번·사내 코드 중 하나는 있어야 하고, Spec 행은 커넥터·터미널 품번이 있어야 합니다. 전선 규격 하한은 상한보다 클 수 없습니다.
- BOM 구분은 `신규`·`설변`, 경계값 처리는 `include`·`review`, 여유율은 0 이상만 받습니다.
- DB 에 저장하는 도면은 도면번호가 있어야 하며, 같은 사용자의 같은 도면번호·Rev 는 한 벌만 저장됩니다.
- 앱에서 upsert 할 때 지정할 `onConflict` 값: `map_row`·`spec_row` 는 `master_file_id,row_no`, `harness_bom` 은 `owner_id,drawing_no,rev`, `bom_choice` 는 `bom_id,issue_key`, `column_mapping` 은 `owner_id,kind`.
- 커넥터 표에서 같은 위치가 두 번 들어오는 것은 막지 않습니다. 도구가 확인 대상으로 알려 주는 항목이라 저장은 되어야 하기 때문입니다.

## 보안

- 모든 테이블에 행 수준 보안(RLS)이 켜져 있습니다.
- 각 행은 만든 사람(`owner_id`)만 보고 고칠 수 있습니다. `owner_id` 는 로그인한 사용자로 자동으로 채워집니다.
- 남의 도면·마스터에 행을 끼워 넣을 수 없습니다(자식 행을 넣을 때 부모 행의 주인도 확인합니다).
- 로그인하지 않은 방문자(anon)는 아무것도 보거나 쓸 수 없습니다.
- `bom_export_log` 는 기록용이라 본인도 수정·삭제할 수 없습니다(추가·조회만 가능).
- 함수는 `search_path` 를 고정했고, 실행 권한을 로그인 사용자에게만 줍니다.
- 팀이 마스터를 함께 쓰는 기능은 아직 넣지 않았습니다. 필요해지면 팀 구성원 표와 공유 정책을 추가합니다.

## 적용 방법

1. <https://supabase.com> 에 가입합니다.
2. 새 프로젝트(New project)를 만듭니다. 본인 계정의 본인 프로젝트에 적용합니다.
3. 왼쪽 메뉴에서 SQL Editor 를 엽니다.
4. `supabase/schema.sql` 파일 내용을 전부 복사해 붙여 넣습니다.
5. Run 을 눌러 실행합니다.

여러 번 실행해도 안전합니다. 이미 있는 테이블·정책은 건너뛰거나 새로 고쳐 만듭니다.

## 확인 방법

- Table Editor 에 위 표의 테이블 13개가 보이면 됩니다.
- Authentication → Policies 에서 13개 테이블 모두 RLS 가 켜져 있고 정책이 붙어 있는지 확인합니다.
- SQL Editor 에서 다음을 실행하면 정책 50개가 나와야 합니다.

  ```sql
  select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
  ```

## 앱 연결은 다음 단계입니다

이번에는 스크립트만 저장했습니다.
도구의 `js/store.js` 는 아직 localStorage 를 씁니다.
연결할 때는 본인 프로젝트의 URL 과 anon 키를 받아 로그인 기능과 함께 붙입니다.

## 로컬 검증 방법

운영 DB 에 올리기 전에 내 컴퓨터의 임시 PostgreSQL 에서 스크립트를 실제로 적용해 확인할 수 있습니다.

```sh
./scripts/sqltest/run.sh
```

- PostgreSQL 16·17 이 필요합니다(macOS: `brew install postgresql@17`).
- 임시 데이터베이스를 만들어 쓰고 끝나면 지우므로 기존 설치에 영향이 없습니다.
- 스키마를 두 번 적용해 재실행 안전성을 보고, 사용자 A·B·비로그인 세 역할로 RLS 격리·기록성 표·제약·함수 권한을 확인합니다.
- 마지막에 「SQL 검증 통과.」가 나오면 성공입니다.
- `scripts/sqltest/*.local.sql` 은 로컬 검증 전용입니다. Supabase SQL Editor 에서 실행하면 스스로 멈추도록 가드가 들어 있습니다.
