# Deploy Configuration

> **状態:** 採用（roadmap登録済み。Bundle配分は§8、決定事項は§9）  
> **Authority:** Deploy Configuration仕様SSOT（Deploy Template / Selection / Docker Projection / Deploy Validation / Deploy E2E）  
> **対象:** MVP `build.deploy-projection` / `build.deploy` / `completion.end-to-end`、MVP E2E後の拡張 `build.deploy-setup-script` / `build.deploy-template-registrar`  
> **目的:** ユーザーが展開環境を選択し、Definitionから生成された環境構築成果物によって、Editorに依存せずApplicationを起動・検証できること。

## 1. Purpose / Scope

Primitive App EditorでAuthoringしたApplicationについて、展開先環境を選択し、その選択を基にDocker Compose構成および必要なセットアップ手順を導出する。Deployの**Schema / UI / Generator / Validation / E2E契約**をこの資料で一体として扱う。

```text
Authoring Data + Build Configuration
                  |
                  v
         Application Output
                  +
       Deploy Template Definition
                  +
        Deploy Selection / Values
                  |
                  v
             Validate
                  |
                  v
         Deploy Projection
                  |
            +-----+------+-----------------+
            |            |                 |
            v            v                 v
       Dockerfile   compose.yaml   Setup script
            |            |                 |
            +------------+-----------------+
                         |
                         v
          Independent Application Package
                         |
                         v
                 User-run Setup
                         |
                         v
                 E2E / Operation
```

### Scope

- **対象:** 現行Build TargetであるPostgreSQL Web Application Output（ASP.NET Core API + Next.js UI / PostgreSQL）を、Docker Composeによって展開可能にするための定義と導出物。
- **MVPの検証に必要な範囲:** 定義を選択してDockerfile / Compose構成を生成し、実際に起動してE2E検証すること。
- **MVP E2E後の拡張（現行roadmapで実装）:** Docker未導入環境の検出、プラットフォーム別の導入支援、セットアップ用 `.sh` / `.bat` の生成（§6）、利用者定義Deploy Templateのレジストラ登録（§3.3 / §4）。
- **対象外:** Editorが利用者のOSを遠隔管理すること、Editor内にApplication固有の運用ロジックをハードコードすること、Docker Desktopのライセンスや利用条件を回避すること。

MVPへの採否と各Bundleへの配分は§8 / §9で確定し、roadmap.yamlへ登録済みである。

## 2. Existing Authority / Boundary

| 対象 | Authority / 責務 |
|---|---|
| Application Schema | 既存RegistryがAuthority。Deploy DefinitionはTable/Column/Relationの意味を再定義しない |
| Application Data | 既存Raw Data。Seed選択は§31 Build Configurationに従う |
| Project Authoring | Working Directory + `project.sqlite` |
| Build Configuration | Build / Export Selection。Application SchemaやRaw Dataへ設定を書き戻さない |
| Deploy Template Definition | **提案:** 配布・実行環境を導出するための独立した宣言的Definition。Application Registryとは論理的に分離 |
| Generated Dockerfile / Compose / Script | Derived Output。Authoring Authorityを持たない |
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
```

## 3. Definition Schema

### 3.1 Deploy Template Definition Schema

組込みTemplate・利用者定義Templateに共通の確定Schema。Validation（§7.1）、Projection（§5）、Template Registrarが導出するUI Control（§4）はすべてこのSchemaのみを根拠とする。

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
    ui:
      dockerfile: generated
      internal_port: 3000
    database:
      image: "postgres:<pinned tag>"
      data_volume: application-db
  parameters:
    - key: api_port
      type: port
      required: true
      default: 8080
      description: Host port published for the API
    - key: db_password
      type: secret_reference
      required: true
      description: Environment variable in .env holding the PostgreSQL password
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
| `services.database` | 必須 | mapping |
| `services.database.image` | 必須 | string。`<name>:<tag>` または `<name>@sha256:<64 hex>`。tag省略・`latest`はreject |
| `services.database.data_volume` | 必須 | string。`^[a-z0-9][a-z0-9_.-]{0,62}$` |
| `deploy_template.parameters` | 任意 | list of mapping。省略時は空list |
| `parameters[].key` | 必須 | string。`^[a-z][a-z0-9_]{0,62}$`。Template内で一意 |
| `parameters[].type` | 必須 | enum: `string` / `int` / `bool` / `port` / `path` / `secret_reference` |
| `parameters[].required` | 必須 | bool |
| `parameters[].default` | 任意 | `type`に適合する値。`secret_reference`では指定不可 |
| `parameters[].description` | 必須 | string。1〜512文字 |
| `deploy_template.capabilities` | 必須 | mapping |
| `capabilities.compose` | 必須 | bool。値は`true`のみ |
| `capabilities.prerequisites_check` / `installer_assistance` / `setup_script` | 任意 | bool。省略時は`false`。`installer_assistance: true`は`prerequisites_check: true`を要する |

Parameter値の型規則：

| type | 値 |
|---|---|
| `string` | string。改行なし |
| `int` | 整数 |
| `bool` | `true` / `false` |
| `port` | int。1〜65535 |
| `path` | Application Output相対path。絶対path・`..`成分・空文字はreject |
| `secret_reference` | `.env`の変数名 `^[A-Z][A-Z0-9_]{0,62}$`。値そのものはTemplate / Selection / 生成物に書かない |

#### 未知Key / 文書形式の境界

- 上表に無いkeyは、root・`deploy_template`・`services`・各service・`parameters[]`・`capabilities`の**すべての階層でValidation reject**とする（無視・保持しない）。
- 型不一致、enum外の値、必須keyの欠落は同様にrejectし、該当Pathを診断に含める。
- ファイルはUTF-8のYAML 1.2単一文書とする。複数文書、anchor / alias / merge key（`&` / `*` / `<<`）、明示tagはreject。commentは許容するが、Deploy Template Serviceの書き出し時には保持しない。
- 書き出しは上表のkey順・2 space indent・省略可能keyは値が既定と異なる場合のみ出力し、同じDefinitionから同じbyte列を生成する。
- `origin`（builtin / user）はファイルに保存しない導出値である（§3.3）。

`provider`, `services`, `parameters`は**Deploy用Definition**であり、ApplicationのTable/Column/Functionの定義ではない。対象OSやDocker構成はテンプレートごとの対応可否を宣言し、非対応な組み合わせは選択不能またはValidation rejectとする。

### 3.2 選択値とTemplateの分離

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
    parameters:
      api_port: 8080
      ui_port: 3000
      database_volume: "application-db"
```

- **Template:** 環境の構造、受入可能な値、生成規則。
- **Selection:** 利用者が選択したTemplate IDと入力値。固定のApplication Registry定義とは別。
- **Validation:** 必須項目・型・ポートの同一ホスト上での競合・Path・Build Targetとの整合を確認。
- **Projection:** 同じDefinition + 同じSelection + 同じApplication Outputから、決定的なファイル群を生成。

**決定（§9）:** MVPのDeploy TemplateはEditorに同梱する組込みDefinition（`docker-compose-default`）とし、Selectionは§31 Build Configurationの`deploy`拡張として保持する。利用者定義Templateは§3.3の契約でMVP E2E後に実装する（`build.deploy-template-registrar`）。既存の`table_registry`へDeploy metadataを混在させない。

### 3.3 利用者定義Template

`build.deploy-template-registrar`が実装する契約。§3.1と同じDefinition Schemaを用い、組込みTemplateと同じValidation / Projectionを通す。

```yaml
user_deploy_template:
  storage: "<Working Directory>/config/deploy/templates/<template_id>.yaml"
  format: §3.1 Deploy Template Definition Schemaに従うYAML文書（未知Key / 文書形式の境界も§3.1）
  authority: Working Directory（Authoring Persistent / config/）。project.sqlite・Registryには保存しない
  id:
    pattern: "^[a-z][a-z0-9-]{0,62}$"
    rule:
      - ファイル名（拡張子除く）とidが一致する
      - 組込みTemplateのidは予約済み。同じidの利用者定義Templateはreject（上書き・shadowingしない）
      - 利用者定義Template間でも一意
  origin: builtin | user           # 保存しない導出値。組込み同梱 = builtin、config/deploy/templates/ 由来 = user。builtinは読取専用
```

- **優先関係:** 同一idの共存を許さないため、名前解決に優先順位は存在しない。Selectionの`template_id`は組込み / 利用者定義を問わず完全一致で1件に解決し、0件は「Template未解決」としてBuild Validation reject。組込みTemplateを変更したい場合は「複製」により新しいidの利用者定義Templateを作成する。
- **Validation（§7.1に追加）:**
  - §3.1のKey定義・型規則・未知Key / 文書形式の境界をすべて満たす（組込みTemplateにも同じ検証を適用する）。
  - Parameterの`key`は`compose.yaml` / `.env.example`の変数名へ決定的に写像できる（大文字化した`key`を変数名とし、写像後の重複はreject）。
  - 不正なTemplateは一覧に`Invalid`として表示し、Selectionに選べない。既存SelectionがInvalid化したTemplateを参照する場合はBuild Validationで明示し、Buildしない。
- **編集とSelection:** Templateの編集・削除はSelectionを自動書換しない。参照中Templateの削除は確認を要し、削除後のSelectionは「Template未解決」となる。
- **Mutation経路:** 作成・編集・複製・削除はApp Editor側のDeploy Template Service経由で行い、Validationを通過した内容のみ一時ファイル + renameで原子的に書き込む。UIから直接ファイルを書き換えない。外部エディタでの手編集は再読込時に同じValidationを通す。

## 4. UI / Registrar Integration

Deploy Templateをレジストラの操作体系で登録・選択する。個別の固定フォームを増やさず、Definitionから入力コントロールを導出する。MVP（`build.deploy`）は組込みTemplateの選択とParameter入力をBuild / Export Configuration Surfaceで扱い、利用者定義Templateの登録・編集はMVP E2E後の`build.deploy-template-registrar`で扱う（§4 Template Registrar）。

```text
Primary Side Bar / Build
  -> Templateを発見 / 選択 / Editor Areaを開く

Editor Area / Build / Export Configuration
  -> Deploy Environmentの選択
  -> Definitionから生成した入力Control
  -> Parameter Validation
  -> Build / Exportの明示操作

Secondary Side Bar / Inspector
  -> 選択中Template / Parameterの補足情報

Bottom Panel
  -> Build Log / Validation / Diagnostics
```

### UI操作フロー

1. ユーザーが既存のBuild Targetを選ぶ。
2. そのTargetに互換なDeploy Templateを一覧表示する。
3. ユーザーがホスト環境とTemplateを選択する。
4. Definitionから必要なUI（select / checkbox / port入力 / path入力等）を導出し、未指定値を明示する。
5. 入力値をValidateして、生成対象ファイルと適用される設定を表示する。
6. ユーザーが確認してBuild / Exportする。
7. 結果は`build/`配下に出力し、生成LogをBottom Panelへ表示する。

UI Placementは`Editor UI.md` §3 / §9 / §10 / §13 / §15に従う。

### Template Registrar

`build.deploy-template-registrar`が実装する利用者定義TemplateのUI責務。保存・ID・Validation・優先関係は§3.3に従う。

```text
Primary Side Bar / Build
  -> Deploy Template一覧（builtin / user / Invalidを区別）
  -> 新規作成 / 組込みTemplateから複製 / 削除 / Editor Areaで開く

Editor Area / Deploy Template Editor
  -> §3.1 Schemaから導出したControl（provider / supported_hosts /
     compatible_build_targets / services / parameters / capabilities）
  -> builtinは読取専用表示
  -> 保存はValidation通過時のみ（Deploy Template Service経由）

Editor Area / Build / Export Configuration
  -> 互換かつValidなTemplate（builtin + user）からDeploy Environmentを選択

Secondary Side Bar / Inspector
  -> 選択中Template / Parameterの補足情報、参照中Selection

Bottom Panel
  -> Template Validation結果 / Diagnostics
```

- Primary Side BarはDiscovery / Navigation / Selectionに留め、Template編集はEditor Areaで行う（`Editor UI.md` §9 / §10 / §13）。
- Template RegistrarはApplication Registry（`table_registry`等）のUIを流用・拡張して保存先にしない。操作体系（一覧・選択・Inspector・Validation表示）のみを揃える。

## 5. Docker Projection

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
├─ compose.yaml                   # Generated
├─ .env.example                   # Generated; contains no real secrets
└─ setup.sh / setup.bat           # Optional generated wrapper
```

Dockerfile / Compose / setup scriptは**Deploy Definitionからの生成物**であり、手編集した内容をSchema Authorityとして扱わない。生成ファイルが既存のC# / Next.jsアプリケーションと同じビルド成果物を参照し、再生成時には同じ入力から同じ設定を導出する。

### Composeの最小サービス境界

| Service | 役割 | 制約 |
|---|---|---|
| PostgreSQL | Runtime Storage | 永続Volume、初期DDL・選択されたSeedの適用。`project.sqlite`をコピーしない |
| ASP.NET Core API | Query / CRUD / Function Runtime | PostgreSQLへ接続。Editor内部モジュールに依存しない |
| Next.js UI | Renderer | APIの公開アドレスは選択設定から解決。Editor APIを直接呼ばない |

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
                 docker compose up
```

- **Dockerアカウントは原則として必須にしない。** 利用条件、匿名イメージ取得制限、Docker Desktopのライセンス、ホストの管理者権限等は別の前提として明示する。
- Linux Docker EngineとWindows/macOS Docker Desktopの導入手順は同一視しない。WindowsのWSL2/仮想化/再起動の有無を検出・案内できることが望ましい。
- 自動インストール、権限昇格、再起動、ネットワーク変更は、ユーザーの明示的な同意なしに実行しない。
- **MVPの必須条件としない:** Docker未インストール時の完全自動復旧。MVPでは、事前にDockerが利用できるE2E環境を前提にComposeを検証可能とする。本節はMVP E2E後に`build.deploy-setup-script`で実装する。

### Setup Script Contract

- `setup.sh`（Linux / macOS、POSIX sh）と`setup.bat`（Windows）を、§5のDocker Projectionと同じDeploy Selectionから決定的に生成し、Application Output直下に置く。選択されたTemplateの`capabilities.setup_script`が`false`の場合は生成しない。
- 処理順: OS / Architecture判定 → `docker` / `docker compose`の有無とEngine稼働確認 → 不足時は前提とOS別導入手順を表示 → 同意が得られた場合のみ案内に沿った導入を実行（`capabilities.installer_assistance: true`のときのみ）→ 再確認 → `docker compose up`。
- 権限昇格（`sudo` / UAC）、パッケージ導入、再起動、ネットワーク設定変更は、それぞれ実行直前に内容を表示して対話的な明示同意を得た場合にのみ行う。非対話実行（stdinがTTYでない等）では同意なしとみなし、前提不足なら非0で終了する。
- 既存Volume・コンテナ・`.env`を削除・上書きしない。`.env`が無い場合は`.env.example`の存在を案内して終了し、機密値を生成・埋め込みしない。
- 終了コード: 0 = 起動成功、非0 = 前提不足 / 同意拒否 / 起動失敗（原因をメッセージで区別）。
- 検証: 生成物の決定性、Docker有り環境（Linux）での起動、Docker無し・非対話環境で同意なしに変更を行わず非0終了することをテストする。

## 7. Build Validation / E2E

### 7.1 Build / Deploy Validation

- Build TargetとDeploy Templateの対応関係が成立している。
- Required Parameterがあり、型と許容値が妥当。
- ポート、相対Path、Volume設定が安全かつ矛盾しない。
- 必須のAPI / UI / SQLファイルがApplication Outputに存在する。
- 出力は`<Project>/build/`配下に限定され、Authoring Dataへ書き戻さない。
- 生成されるDockerfile・Compose・Setup Script間でサービス名・接続先・変数名が整合する。
- テンプレート未対応OSまたはBuild Targetを黙って推測しない。

### 7.2 E2E

現行`completion.end-to-end`と接続する。E2Eでは生成したApplication OutputをEditorから独立した環境で起動する。

1. Build Validation成功 → Application Output生成。
2. 同一入力からDockerfile / Composeが生成される。
3. サポート済みのE2Eホストで`docker compose config`が成功する。
4. `docker compose build` / `docker compose up`が成功する。
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
  -> 組込みDeploy Template Definition（§3.1）
  -> Build ConfigurationのDeploy Selection（§3.2）
  -> Docker Projection: Dockerfile / compose.yaml / .env.example（§5）
  -> Build / Deploy Validation（§7.1）
  -> UI非依存。Generator / Validationの単体検証と docker compose config による検証

build.deploy (not started)
  -> Deployable artifact layout / Build & Export surface
  -> Deploy Environment選択・Definition由来の入力Control・Validation表示（§4）
  -> depends_on build.deploy-projection, workbench.views

completion.end-to-end (not started)
  -> Authoring -> Build -> Deploy -> Runtime -> Rendererを実環境で検証（§7.2）

Deploy Extensions（Completionより後のsection。completion.end-to-endの依存に含めない）
build.deploy-setup-script (not started)
  -> setup.sh / setup.bat生成、Docker Prerequisites検出と導入案内（§6）
  -> depends_on build.deploy

build.deploy-template-registrar (not started)
  -> 利用者定義Templateの登録・編集・複製・削除・選択・Validation（§3.3 / §4 Template Registrar）
  -> depends_on build.deploy, build.deploy-projection, workbench.views
```

各Bundleのstatus / evidence / remainingはroadmap.yamlのみで管理し、Tool First（`roadmap.next` / `roadmap.complete`）に従って更新する。本資料はBundleの進捗を持たない。

## 9. Decisions

| # | 論点 | 決定 |
|---|---|---|
| 1 | Deploy Templateの保存先と形式 | MVPはEditorに同梱する組込みDefinition `docker-compose-default`。Selection（`template_id` / `host` / `parameters`）は§31 Build Configurationの`deploy`拡張として保持し、Registry / Raw Dataへ書き込まない。利用者定義Templateは`config/deploy/templates/<template_id>.yaml`（§3.3）。組込みidは予約され、shadowingしない |
| 2 | レジストラへのDeploy Template登録の統合 | MVP E2E後に`build.deploy-template-registrar`で実装（§4 Template Registrar）。Application Registryとは保存先を共有せず、操作体系のみ揃える |
| 3 | `build.deploy`系のMVP境界 | Dockerfile / Compose生成とDeploy Validationを完了条件に含める（`build.deploy-projection`）。UI Surfaceは`build.deploy` |
| 4 | `completion.end-to-end`の最小ホスト環境 | Docker Engine + Compose Pluginが事前に利用可能なLinux（`host: linux`）。Windows WSL2 / macOSは対応宣言のみでE2E必須にしない |
| 5 | Setup Script / Docker自動導入支援 | MVP E2E後に`build.deploy-setup-script`で実装（§6 Setup Script Contract）。roadmapではCompletionより後の`Deploy Extensions` sectionに置き、`completion.end-to-end`の依存に含めない |

具体的なImage / Dependency Version、Parameterの既定値は、§5の制約（再現性・機密値非埋め込み）を満たす範囲で`build.deploy-projection`の実装時に決定し、evidenceへ記録する。
