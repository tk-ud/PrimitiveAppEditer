# Deploy Configuration

> **状態:** 採用（roadmap登録済み。Bundle配分は§8、決定事項は§9）  
> **Authority:** Deploy Configuration仕様SSOT（Deploy Template / Selection / Docker Projection / Deploy Validation / Deploy E2E）  
> **対象:** MVP `build.deploy-projection` / `build.deploy` / `completion.end-to-end`、MVP E2E後の拡張 `build.deploy-setup-script` / `build.deploy-template-registrar`  
> **目的:** ユーザーが登録済みの展開環境Templateを選択し、Scaffoldされた環境構築ファイルによって、Editorに依存せずApplicationを起動・検証できること。

## 1. Purpose / Scope

Primitive App EditorでAuthoringしたApplicationについて、Editor共通のTemplate Registryに登録された展開環境Templateを選択し、そのTemplateからDocker Compose構成および必要なセットアップ手順をScaffoldする。Deployの**Schema / UI / Generator / Validation / E2E契約**をこの資料で一体として扱う。

```text
Authoring Data + Build Configuration
                  |
                  v
         Application Output
                  +
  Deploy Template (Editor共通Template Registry)
                  +
           Deploy Selection (Template ID)
                  |
                  v
             Validate
                  |
                  v
      Deploy Scaffold (既存ファイルは上書きしない)
                  |
            +-----+------+-----------------+
            |            |                 |
            v            v                 v
       Dockerfile   compose*.yml   Setup script
            |            |                 |
            +------------+-----------------+
                         |
                         v
          Independent Application Package
                         |
                         v
        User-run (CLIでYAMLを明示指定して起動)
                         |
                         v
                 E2E / Operation
```

### Scope

- **対象:** 現行Build TargetであるPostgreSQL Web Application Output（ASP.NET Core API + Next.js UI / PostgreSQL）を、Docker Composeによって展開可能にするための定義と導出物。
- **MVPの検証に必要な範囲:** 登録済みTemplateを選択してDockerfile / Compose構成をScaffoldし、利用者がCLIで明示的に起動してE2E検証すること。
- **MVP E2E後の拡張（現行roadmapで実装）:** Docker未導入環境の検出、プラットフォーム別の導入支援、セットアップ用 `.sh` / `.bat` の生成（§6）、Editor共通Template Registryへの利用者定義Deploy Templateの登録・編集UI（§3.3 / §4）。
- **対象外:** Editorが利用者のOSを遠隔管理すること、Editor内にApplication固有の運用ロジックをハードコードすること、Docker Desktopのライセンスや利用条件を回避すること。

MVPへの採否と各Bundleへの配分は§8 / §9で確定し、roadmap.yamlへ登録済みである。

## 2. Existing Authority / Boundary

| 対象 | Authority / 責務 |
|---|---|
| Application Schema | 既存RegistryがAuthority。Deploy DefinitionはTable/Column/Relationの意味を再定義しない |
| Application Data | 既存Raw Data。Seed選択は§31 Build Configurationに従う |
| Project Authoring | Working Directory + `project.sqlite` |
| Build Configuration | Build / Export Selection。Application SchemaやRaw Dataへ設定を書き戻さない |
| Deploy Template Definition | **Editor共通Template Registry**がAuthority。プロジェクト横断で利用でき、Application Registry（`table_registry` / `project.sqlite`）およびプロジェクト固有`config/`とはAuthority・データ領域を分離する（§3.3） |
| Generated Dockerfile / Compose / Script | Scaffold済みDerived Output。Authoring Authorityを持たない。生成後は利用者が直接編集してよく、再生成で上書きされない |
| Execution Environment | 利用者のOS / Docker Engine / Docker Desktop。EditorのAuthority外 |
| Application Runtime | 生成されたC# API / Next.js UI / PostgreSQL。Editorを起動せずに稼働する |

**既存仕様との整合:** `App Editer.md` §31の`Build Configuration / Build Target Filter / Application Output / Deploy`、§39の`App Editor API / Application Language Boundary`、`Editor UI.md` §13の`Build / Export Configuration`を維持する。

```text
Deploy Template / Deploy Selection
  -X-> table_registry / column_registryを再定義
  -X-> Registry / Raw Data / Bindingへ書き戻し
  -X-> project.sqliteをProduction Runtime Storageとして配布

Generated Application
  -X-> Code OSS Workbench / Editor内部TypeScriptへの実行時依存

Editor
  -X-> Deploy先Docker EngineのRuntime Authority
  -X-> 生成ファイルの自動実行（起動は利用者がCLIで明示する）
```

## 3. Definition Schema

### 3.1 Deploy Template Definition Schema

組込みTemplate・利用者定義Templateに共通の確定Schema。Validation（§7.1）、Scaffold（§5）、Template Registrarが導出するUI Control（§4）はすべてこのSchemaのみを根拠とする。Templateは環境定義・固定値・初期設定をすべて自身で宣言し、Selectionからの値上書きを受けない（§3.2）。

```yaml
deploy_template:
  id: docker-compose-default
  label: Docker Compose (default)
  description: ASP.NET Core API + Next.js UI + PostgreSQL
  provider: docker_compose
  supported_hosts: [linux, windows_wsl2, macos]
  compatible_build_targets: ["PostgreSQL Web Application Output"]
  services:
    api:
      dockerfile: generated
      internal_port: 8080
      host_port: 8080
    ui:
      dockerfile: generated
      internal_port: 3000
      host_port: 3000
    database:
      image: "postgres:<pinned tag>"
      data_volume: application-db
      password_env: DB_PASSWORD
  capabilities:
    compose: true
    prerequisites_check: false
    installer_assistance: false
    setup_script: false
```

#### Key定義

| Path | 必須 | 型 / 許容値 |
|---|---|---|
| `deploy_template` | 必須 | mapping。文書rootの唯一のkey |
| `deploy_template.id` | 必須 | string。`^[a-z][a-z0-9-]{0,62}$` |
| `deploy_template.label` | 必須 | string。1〜128文字、改行なし |
| `deploy_template.description` | 任意 | string。省略時は空 |
| `deploy_template.provider` | 必須 | enum: `docker_compose` |
| `deploy_template.supported_hosts` | 必須 | list of enum `linux` / `windows_wsl2` / `macos`。1件以上、重複不可 |
| `deploy_template.compatible_build_targets` | 必須 | list of string。1件以上、重複不可。各値は既存Build Target識別子（§31 Build Configuration `build_target`）と完全一致 |
| `deploy_template.services` | 必須 | mapping。key は `api` / `ui` / `database` の3つすべて必須 |
| `services.api` / `services.ui` | 必須 | mapping |
| `services.api.dockerfile` / `services.ui.dockerfile` | 必須 | enum: `generated` |
| `services.api.internal_port` / `services.ui.internal_port` | 必須 | int。1〜65535。api と ui で異なる値 |
| `services.api.host_port` / `services.ui.host_port` | 必須 | int。1〜65535。api と ui で異なる値 |
| `services.database` | 必須 | mapping |
| `services.database.image` | 必須 | string。`<name>:<tag>` または `<name>@sha256:<64 hex>`。tag省略・`latest`はreject |
| `services.database.data_volume` | 必須 | string。`^[a-z0-9][a-z0-9_.-]{0,62}$` |
| `services.database.password_env` | 必須 | `.env`の変数名 `^[A-Z][A-Z0-9_]{0,62}$`。値そのものはTemplate / Selection / 生成物に書かない。`.env.example`にはプレースホルダーのみを出力する |
| `deploy_template.capabilities` | 必須 | mapping |
| `capabilities.compose` | 必須 | bool。値は`true`のみ |
| `capabilities.prerequisites_check` / `installer_assistance` / `setup_script` | 任意 | bool。省略時は`false`。`installer_assistance: true`は`prerequisites_check: true`を要する |

**旧契約の廃止:** 旧Schemaの`deploy_template.parameters[]`（ユーザー入力パラメータ宣言）と、`Selection.parameters`による上書きは廃止する。`parameters`は未知Keyとしてreject対象である。Template内の固定値（`host_port` / `data_volume` / `password_env`等）を変えたい場合は、Templateの複製・編集（§3.3 / §4）、または生成後のファイルの直接編集で行う。

#### 未知Key / 文書形式の境界

- 上表に無いkeyは、root・`deploy_template`・`services`・各service・`capabilities`の**すべての階層でValidation reject**とする（無視・保持しない）。
- 型不一致、enum外の値、必須keyの欠落は同様にrejectし、該当Pathを診断に含める。
- ファイルはUTF-8のYAML 1.2単一文書とする。複数文書、anchor / alias / merge key（`&` / `*` / `<<`）、明示tagはreject。commentは許容するが、Deploy Template Serviceの書き出し時には保持しない。
- 書き出しは上表のkey順・2 space indent・省略可能keyは値が既定と異なる場合のみ出力し、同じDefinitionから同じbyte列を生成する。
- `origin`（builtin / user）はTemplate本体に保存しない導出値である（§3.3）。

`provider`, `services`は**Deploy用Definition**であり、ApplicationのTable/Column/Functionの定義ではない。対象OSやDocker構成はテンプレートごとの対応可否を宣言し、非対応な組み合わせは選択不能またはValidation rejectとする。

### 3.2 Selection

```yaml
# Proposal: optional extension to §31 Build Configuration; do not replace the existing minimum contract.
build_configuration:
  build_target: "PostgreSQL Web Application Output"
  runtime_storage_target: "ASP.NET Core API + Next.js UI / PostgreSQL"
  output_path: "build/application"
  # Existing seed_data/include fields remain unchanged.
  deploy:
    template_id: "docker-compose-default"
    host: linux
```

- **Template:** 環境の構造・固定値・初期設定・生成規則。Editor共通Template Registryが保持する（§3.3）。
- **Selection:** 利用者が選択したTemplate IDと対象`host`のみ。詳細環境値の入力・上書き（`parameters`、汎用`target`マッピング機構）は持たない。詳細値は**Scaffold後に利用者が生成ファイルを直接編集**する。
- **Validation:** `template_id`がRegistryに存在する（存在しないIDはreject）、Templateが§3.1に適合する、Build Target / `host`がTemplateの宣言と整合する、必須のApplication Outputが存在する。必要な必須情報の検証は、Template自身の整合性検証（§3.3）と生成物のValidation（§7.1）で行う。
- **Scaffold:** 同じTemplate + 同じSelection + 同じApplication Outputから、決定的な内容のファイル群を生成する。出力先に既存ファイルがある場合のファイル名は§5の規則に従い、**既存ファイルを上書きしない**。

**決定（§9）:** MVPのDeploy TemplateはEditor共通Template Registryに登録された組込みDefinition（`docker-compose-default`）を選択し、Selectionは§31 Build Configurationの`deploy`拡張（`template_id` / `host`）として保持する。利用者定義Templateの登録・編集UIは§3.3の契約でMVP E2E後に実装する（`build.deploy-template-registrar`）。既存の`table_registry`へDeploy metadataを混在させない。

### 3.3 Editor共通Template Registry

Deploy Templateは**プロジェクト横断で利用できるEditor共通のTemplate Registry**がAuthorityである。

```yaml
editor_deploy_template_registry:
  scope: Editor共通（プロジェクト横断）
  authority: Editor Template Registry
  separation:
    - Application Registry（table_registry / column_registry等）と保存先・Authority・データ領域を共有しない
    - project.sqlite・プロジェクト固有のconfig/deploy/templates/ をEditor共通Templateの保存先としない
    - 構造・共通処理機構（検証・原子的書き込み等）の再利用は許容する
  persistence: 物理永続化方式（ディスク形式・配置）はEditor側の既存レジストリ規約と整合する方法で build.deploy-projection / build.deploy-template-registrar が具体化し、evidenceへ記録する
  entry: §3.1 Deploy Template Definition Schemaに従う1 Template
  id:
    pattern: "^[a-z][a-z0-9-]{0,62}$"
    rule:
      - Registry内で一意
      - 組込みTemplateのidは予約済み。同じidの利用者定義Templateはreject（上書き・shadowingしない）
  origin: builtin | user           # 保存しない導出値。Editor同梱 = builtin（読取専用）、利用者登録 = user
```

- **Scaffoldに使える選択肢:** Editor共通Template Registryに登録され、かつValidなTemplateのみ。Registry外のファイル・プロジェクト内ファイルをTemplateとして直接参照しない。
- **名前解決:** 同一idの共存を許さないため優先順位は存在しない。Selectionの`template_id`は完全一致で1件に解決し、0件は「Template未解決」としてBuild Validation reject。組込みTemplateを変更したい場合は「複製」により新しいidの利用者定義Templateを作成する。
- **Template自身の整合性検証（§7.1に追加）:**
  - §3.1のKey定義・型規則・未知Key / 文書形式の境界をすべて満たす（組込みTemplateにも同じ検証を適用する）。
  - ポートの重複なし（`api.host_port` ≠ `ui.host_port`）、`password_env`が`.env.example`の変数名として有効。
  - 不正なTemplateは一覧に`Invalid`として表示し、Selectionに選べない。既存SelectionがInvalid化したTemplateを参照する場合はBuild Validationで明示し、Scaffoldしない。
- **Selectionの保持主体と寿命:** 現在のDeploy Selection（`template_id` / `host`）の保持主体は、App EditorのProject Bridge Service（Projectに紐づくセッション状態）であり、Build / Export Configuration Surface（Editor Areaタブ・Model）ではない。保持期間は**開いているProjectの寿命**（Project切替・Close時に未選択へリセット、同一Projectの再Ready・Surfaceの再描画・Tabの閉じ直しでは保持）。Surface Modelは描画ごとの生成時にServiceのSelectionを初期値として復元し、利用者の選択変更はServiceへ書き戻す。永続化は§31 Build Configurationの`deploy`拡張の保存契約に従い、本節はセッション中の保持のみを規定する。
- **「参照中」判定の取得元:** 「参照中Selection」（Inspectorの`Referenced by Selection`、参照中Templateの削除確認）は、上記ServiceのSelectionを唯一の取得元として判定する。Surface Modelの状態を判定に使わない。これによりSurface描画状態と判定が乖離しない。
- **編集とSelection:** Templateの編集・削除はSelectionを自動書換しない。参照中Templateの削除は確認を要し、削除後のSelectionは「Template未解決」となる。既にScaffold済みのファイルはTemplateの編集・削除の影響を受けない。
- **Mutation経路:** 作成・編集・複製・削除はApp Editor側のDeploy Template Service経由で行い、Validationを通過した内容のみ原子的に書き込む。UIから直接保存先を書き換えない。
- **Bundle境界:** `build.deploy-projection`はこのRegistryからの**読取**（Template解決・Validation）と選択後のScaffoldを担当する。登録・編集・複製・削除のUI/Serviceは`build.deploy-template-registrar`が担当する。

## 4. UI / Registrar Integration

Editor共通Template Registryに登録されたTemplateをレジストラの操作体系で選択する。個別の固定フォームを増やさず、詳細環境値の入力UIは設けない。MVP（`build.deploy`）は組込みTemplateの選択とScaffold操作をBuild / Export Configuration Surfaceで扱い、利用者定義Templateの登録・編集はMVP E2E後の`build.deploy-template-registrar`で扱う（§4 Template Registrar）。

```text
Primary Side Bar / Build
  -> Templateを発見 / 選択 / Editor Areaを開く

Editor Area / Build / Export Configuration
  -> Deploy Environment（Template）の選択
  -> 生成されるファイル名（採用名）と内容の確認
  -> Template / 生成物のValidation
  -> Build / Export / Scaffoldの明示操作

Secondary Side Bar / Inspector
  -> 選択中Templateの補足情報

Bottom Panel
  -> Build Log / Validation / Diagnostics
```

### UI操作フロー

1. ユーザーが既存のBuild Targetを選ぶ。
2. そのTargetに互換でValidなDeploy Templateを一覧表示する。
3. ユーザーがホスト環境とTemplateを選択する。
4. Templateが宣言する環境定義・固定値と、Scaffold時に採用されるファイル名（既存ファイルとの衝突回避後、§5）を表示する。パラメータ入力Controlは設けない。
5. Validateして、生成対象ファイルを表示する。
6. ユーザーが確認してBuild / Export / Scaffoldする。
7. 結果はApplication Output配下に出力し、生成LogをBottom Panelへ表示する。起動コマンド（例：`docker compose -f compose-001.yml up -d`）を案内するが、Editorは実行しない。

UI Placementは`Editor UI.md` §3 / §9 / §10 / §13 / §15に従う。

### Template Registrar

`build.deploy-template-registrar`が実装するEditor共通Template Registryの登録・編集UIの責務。保存・ID・Validation・優先関係は§3.3に従う。

```text
Primary Side Bar / Build
  -> Deploy Template一覧（builtin / user / Invalidを区別）
  -> 新規作成 / 組込みTemplateから複製 / 削除 / Editor Areaで開く

Editor Area / Deploy Template Editor
  -> §3.1 Schemaから導出したControl（provider / supported_hosts /
     compatible_build_targets / services / capabilities）
  -> builtinは読取専用表示
  -> 保存はValidation通過時のみ（Deploy Template Service経由）

Editor Area / Build / Export Configuration
  -> 互換かつValidなTemplate（builtin + user）からDeploy Environmentを選択

Secondary Side Bar / Inspector
  -> 選択中Templateの補足情報、参照中Selection

Bottom Panel
  -> Template Validation結果 / Diagnostics
```

- Primary Side BarはDiscovery / Navigation / Selectionに留め、Template編集はEditor Areaで行う（`Editor UI.md` §9 / §10 / §13）。
- Template RegistrarはApplication Registry（`table_registry`等）のUIを流用・拡張して保存先にしない。操作体系（一覧・選択・Inspector・Validation表示）と共通処理機構のみを揃える。

## 5. Docker Projection / Scaffold

```text
<Application Output>/
├─ application.definition.json
├─ 001_init_postgresql.sql
├─ 002_seed_data.sql              # Seed選択時のみ
├─ api/
│  ├─ ...                         # Generated ASP.NET Core application
│  └─ Dockerfile                  # Generated
├─ ui/
│  ├─ ...                         # Generated Next.js application
│  └─ Dockerfile                  # Generated
├─ compose.yml                    # Scaffold（既存なら compose-001.yml 等）
├─ .env.example                   # Scaffold; contains no real secrets
└─ setup.sh / setup.bat           # Optional scaffold wrapper
```

Dockerfile / Compose / setup scriptは**Deploy TemplateからScaffoldされる生成物**であり、生成後の編集内容をSchema Authorityとして扱わない。生成ファイルが既存のC# / Next.jsアプリケーションと同じビルド成果物を参照し、同じTemplate・Selection・Application Outputからは同じ内容を導出する。

### Scaffold規則（ファイル名・上書き禁止）

- Scaffoldは**既存ファイルを上書きしない**。生成後にユーザーが編集した内容を、再生成で消さない。
- 出力先に同名ファイルが存在する場合、拡張子の前に3桁連番を付けた**未使用のファイル名**で出力する（例：`compose.yml` → `compose-001.yml` → `compose-002.yml`）。連番は001から最初の未使用値を採用する。Compose YAMLの既定名は`compose.yml`、`.yaml`拡張子の既存ファイルも同名衝突として扱う。
- 同一Scaffold内で互いに参照するファイル（Compose YAMLの`dockerfile`参照、`.env.example`、Setup Script）は、**実際に採用したファイル名**を参照する。採用名はScaffold前にUI/Logへ提示する（§4）。
- 連番の上限を使い切った場合はScaffoldを中止して診断する。既存ファイルの削除・退避・上書きで回避しない。
- Editorは生成ファイルを**自動実行しない**。起動は利用者がCLIで対象YAMLを明示指定して行う（例：`docker compose -f compose-001.yml up -d`）。Setup Scriptは利用者が明示実行する成果物であり、CLIによる直接起動を妨げない。

### Composeの最小サービス境界

| Service | 役割 | 制約 |
|---|---|---|
| PostgreSQL | Runtime Storage | 永続Volume、初期DDL・選択されたSeedの適用。`project.sqlite`をコピーしない |
| ASP.NET Core API | Query / CRUD / Function Runtime | PostgreSQLへ接続。Editor内部モジュールに依存しない |
| Next.js UI | Renderer | APIの公開アドレスはTemplateの`services.api.host_port`から解決。Editor APIを直接呼ばない |

- 機密値（DBパスワード、秘密鍵など）はテンプレートの定数やGit管理ファイルへ書き込まない。`.env.example`には値の説明・プレースホルダーのみを入れる。
- Image/Dependency Versionは明示または固定化して再現性を確保する。バージョンの具体値は既存生成Applicationと互換性を確認して決定する。
- DB初期化の多重実行・再デプロイ時のデータ保全は、Validation・E2Eで確認する。既存のVolumeを無条件に削除しない。

## 6. Setup Script / Docker Prerequisites

```text
User executes generated setup script
          |
          v
OS / Architecture / Permission Check
          |
          v
Docker Engine and Compose Plugin available?
    | yes                   | no
    v                       v
Continue             Explain prerequisites
                     Request explicit consent
                     Guide/install via supported host method
                     Recheck after restart if needed
          |                       |
          +-----------------------+
                         |
                         v
                 docker compose -f <採用したYAML> up -d
```

- **Dockerアカウントは原則として必須にしない。** 利用条件、匿名イメージ取得制限、Docker Desktopのライセンス、ホストの管理者権限等は別の前提として明示する。
- Linux Docker EngineとWindows/macOS Docker Desktopの導入手順は同一視しない。WindowsのWSL2/仮想化/再起動の有無を検出・案内できることが望ましい。
- 自動インストール、権限昇格、再起動、ネットワーク変更は、ユーザーの明示的な同意なしに実行しない。
- **MVPの必須条件としない:** Docker未インストール時の完全自動復旧。MVPでは、事前にDockerが利用できるE2E環境を前提にComposeを検証可能とする。本節はMVP E2E後に`build.deploy-setup-script`で実装する。

### Setup Script Contract

- `setup.sh`（Linux / macOS、POSIX sh）と`setup.bat`（Windows）を、§5のScaffoldと同じTemplate・Selectionから決定的に生成し、Application Output直下に置く。既存ファイルは上書きせず§5の連番規則に従い、Setup Scriptは実際に採用したCompose YAML名を参照する。Setup Scriptは存在してもユーザーが明示実行する成果物で、自動実行しない。選択されたTemplateの`capabilities.setup_script`が`false`の場合は生成しない。
- 処理順: OS / Architecture判定 → `docker` / `docker compose`の有無とEngine稼働確認 → 不足時は前提とOS別導入手順を表示 → 同意が得られた場合のみ案内に沿った導入を実行（`capabilities.installer_assistance: true`のときのみ）→ 再確認 → `docker compose -f <採用したYAML> up -d`。
- 権限昇格（`sudo` / UAC）、パッケージ導入、再起動、ネットワーク設定変更は、それぞれ実行直前に内容を表示して対話的な明示同意を得た場合にのみ行う。非対話実行（stdinがTTYでない等）では同意なしとみなし、前提不足なら非0で終了する。
- 既存Volume・コンテナ・`.env`を削除・上書きしない。`.env`が無い場合は`.env.example`の存在を案内して終了し、機密値を生成・埋め込みしない。
- 終了コード: 0 = 起動成功、非0 = 前提不足 / 同意拒否 / 起動失敗（原因をメッセージで区別）。
- 検証: 生成物の決定性、Docker有り環境（Linux）での起動、Docker無し・非対話環境で同意なしに変更を行わず非0終了することをテストする。

## 7. Build Validation / E2E

### 7.1 Build / Deploy Validation

- Selectionの`template_id`がEditor共通Template Registryに存在し、Validである（存在しないIDはreject）。
- Build Target・`host`とDeploy Templateの対応関係が成立している。
- Template自身の整合性（§3.3）：必須keyの充足、型と許容値、ポート・Volume・`password_env`が安全かつ矛盾しない。
- Scaffoldが既存ファイルを上書きせず、採用ファイル名が一意に決まる（§5）。
- 必須のAPI / UI / SQLファイルがApplication Outputに存在する。
- 出力は`<Project>/build/`配下に限定され、Authoring Dataへ書き戻さない。
- 生成されるDockerfile・Compose・Setup Script間でサービス名・接続先・変数名が整合する。
- テンプレート未対応OSまたはBuild Targetを黙って推測しない。

### 7.2 E2E

現行`completion.end-to-end`と接続する。E2Eでは生成したApplication OutputをEditorから独立した環境で起動する。

1. Build Validation成功 → Application Output生成。
2. 同一入力からDockerfile / Composeが生成される。既存ファイルがある場合は上書きされず、連番名で出力される。
3. サポート済みのE2Eホストで、採用したYAMLを明示指定した`docker compose -f <YAML> config`が成功する。
4. 利用者（E2Eでは手順）が`docker compose -f <YAML> build` / `up -d`を明示実行して成功する。Editorは自動実行しない。
5. PostgreSQLのDDL適用、必要時のSeed投入を確認する。
6. APIヘルス・CRUD・バリデーション・DB接続を確認する。
7. Next.js UIがAPIの結果を表示できることを確認する。
8. Editorを停止してもApplicationが単独で稼働することを確認する。
9. 停止・再起動後も指定の永続化データが保持されることを確認する。

**検証環境を作ることと、全利用者向けの自動環境構築機能を提供することは異なる責務である。** 同じDefinition / Compose生成器を両者で再利用するが、MVPのE2E完了を理由にDocker自動導入まで暗黙に要求しない。

## 8. Bundle / Change Boundary

```text
build.web-program (implemented)
  -> C# API / Next.js UI生成

build.postgresql (implemented)
  -> PostgreSQL DDL / Seed生成

build.deploy-projection (not started)
  -> Editor共通Template Registryからの読取・Template解決・Validation（§3.1 / §3.3）。組込みTemplate `docker-compose-default` を含む
  -> Build ConfigurationのDeploy Selection（`template_id` / `host`、§3.2）
  -> 選択式Docker Scaffold: Dockerfile / compose.yml / .env.example。既存ファイルは上書きせず連番名で出力（§5）
  -> Build / Deploy Validation（§7.1）
  -> UI非依存。Generator / Validationの単体検証と docker compose config による検証

build.deploy (not started)
  -> Deployable artifact layout / Build & Export surface
  -> Deploy Environment（Template）選択・採用ファイル名の表示・Validation表示・Scaffold操作（§4）。パラメータ入力Controlは持たない
  -> depends_on build.deploy-projection, workbench.views

completion.end-to-end (not started)
  -> Authoring -> Build -> Deploy -> Runtime -> Rendererを実環境で検証（§7.2）

Deploy Extensions（Completionより後のsection。completion.end-to-endの依存に含めない）
build.deploy-setup-script (not started)
  -> setup.sh / setup.bat生成、Docker Prerequisites検出と導入案内（§6）
  -> depends_on build.deploy

build.deploy-template-registrar (not started)
  -> Editor共通Template Registryへの利用者定義Templateの登録・編集・複製・削除・Validation UI/Service（§3.3 / §4 Template Registrar）。読取・選択・Scaffoldは build.deploy-projection / build.deploy
  -> depends_on build.deploy, build.deploy-projection, workbench.views
```

各Bundleのstatus / evidence / remainingはroadmap.yamlのみで管理し、Tool First（`roadmap.next` / `roadmap.complete`）に従って更新する。本資料はBundleの進捗を持たない。

## 9. Decisions

| # | 論点 | 決定 |
|---|---|---|
| 1 | Deploy TemplateのAuthority・保存先 | **Editor共通Template Registry**（プロジェクト横断）がAuthority。MVPは組込みDefinition `docker-compose-default` をそこから選択する。Application Registry・`project.sqlite`・プロジェクト固有`config/deploy/templates/`には保存しない。物理永続化方式はEditor側の既存レジストリ規約と整合させて実装時に具体化する（§3.3）。組込みidは予約され、shadowingしない（Issue #88） |
| 1a | Selectionの内容 | `template_id` / `host`のみ（§31 Build Configurationの`deploy`拡張）。`parameters`による上書き・汎用`target`マッピングは設けず、詳細値はScaffold後に利用者がファイルを直接編集する。存在しないTemplate IDはreject（Issue #88） |
| 1b | Scaffold | 既存ファイルを上書きしない。同名は連番（`compose-001.yml`）の未使用名で出力し、関連ファイルは採用名を参照。Editorは生成ファイルを自動実行せず、利用者がCLIでYAMLを明示指定して起動する（Issue #88） |
| 2 | レジストラへのDeploy Template登録の統合 | MVP E2E後に`build.deploy-template-registrar`で実装（§4 Template Registrar）。Editor共通Template Registryの登録・編集UI/Serviceを担当し、Application Registryとは保存先を共有せず、操作体系・共通処理機構のみ揃える |
| 3 | `build.deploy`系のMVP境界 | Dockerfile / Compose生成とDeploy Validationを完了条件に含める（`build.deploy-projection`）。UI Surfaceは`build.deploy` |
| 4 | `completion.end-to-end`の最小ホスト環境 | Docker Engine + Compose Pluginが事前に利用可能なLinux（`host: linux`）。Windows WSL2 / macOSは対応宣言のみでE2E必須にしない |
| 5 | Setup Script / Docker自動導入支援 | MVP E2E後に`build.deploy-setup-script`で実装（§6 Setup Script Contract）。roadmapではCompletionより後の`Deploy Extensions` sectionに置き、`completion.end-to-end`の依存に含めない |

具体的なImage / Dependency Version、Templateの固定値（ポート・Volume名等）は、§5の制約（再現性・機密値非埋め込み）を満たす範囲で`build.deploy-projection`の実装時に決定し、evidenceへ記録する。
