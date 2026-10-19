# Deploy Configuration

> **状態:** 採用（roadmap登録済み。Bundle配分は§8、決定事項は§9）  
> **Authority:** Deploy Configuration仕様SSOT（Deploy Template / Selection / Docker Projection / Deploy Validation / Deploy E2E）  
> **対象:** `build.deploy-projection` / `build.deploy` / `completion.end-to-end`（Setup Scriptはroadmap `future`）  
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
- **追加のUX構想:** Docker未導入環境の検出、プラットフォーム別の導入支援、セットアップ用 `.sh` / `.bat` の生成。
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

### 3.1 概念的な構成

```yaml
# Field names are provisional; schema illustration, not a migration instruction.
deploy_template:
  id: text                         # Template identifier; not Application table UUID
  label: text
  provider: docker_compose         # MVP candidate
  supported_hosts: [linux, windows_wsl2, macos]
  compatible_build_targets: ["PostgreSQL Web Application Output"]
  services:
    api:                           # ASP.NET Core
      dockerfile: generated
      internal_port: int
    ui:                            # Next.js
      dockerfile: generated
      internal_port: int
    database:                      # PostgreSQL
      image: validated_image_ref
      data_volume: text
  parameters:
    - key: text
      type: string | int | bool | port | path | secret_reference
      required: bool
      default: optional
      description: text
  capabilities:
    compose: true
    prerequisites_check: bool
    installer_assistance: bool
    setup_script: bool
```

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

**MVP決定（§9）:** Deploy TemplateはEditorに同梱する組込みDefinition（`docker-compose-default`）のみとし、Selectionは§31 Build Configurationの`deploy`拡張として保持する。利用者定義Templateの物理保存場所・ファイル形式・ID仕様・既存レジストラとの接続方式は現行loop対象外とする。既存の`table_registry`へDeploy metadataを混在させない。

## 4. UI / Registrar Integration

Deploy Templateをレジストラの操作体系で登録・選択できる構想とする。個別の固定フォームを増やさず、Definitionから入力コントロールを導出する。MVP（`build.deploy`）は組込みTemplateの選択とParameter入力をBuild / Export Configuration Surfaceで扱い、利用者定義Templateのレジストラ登録は現行loop対象外とする（§9）。

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

UI Placementは`Editor UI.md` §3 / §9 / §10 / §13 / §15に従う。レジストラの技術的な実装方法はOwner決定事項とする。

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
- **MVPの必須条件としない:** Docker未インストール時の完全自動復旧。MVPでは、事前にDockerが利用できるE2E環境を前提にComposeを検証可能とする。

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

future.excluded_from_current_loop: build.deploy-setup-script（追加UX）
  -> setup.sh / setup.bat生成、Docker Prerequisites検出と導入案内（§6）
  -> 現行MVP loopのBundleとして登録しない（roadmap.nextに選択させない）
  -> 再開条件: completion.end-to-end implemented後、Ownerが独立Bundle
     （depends_on build.deploy）としてsectionへ登録する
```

各Bundleのstatus / evidence / remainingはroadmap.yamlのみで管理し、Tool First（`roadmap.next` / `roadmap.complete`）に従って更新する。本資料はBundleの進捗を持たない。

## 9. Decisions

| # | 論点 | 決定 |
|---|---|---|
| 1 | Deploy Templateの保存先と形式 | MVPはEditorに同梱する組込みDefinition `docker-compose-default`のみ。Selection（`template_id` / `host` / `parameters`）は§31 Build Configurationの`deploy`拡張として保持し、Registry / Raw Dataへ書き込まない。利用者定義Templateの保存先・形式は現行loop対象外 |
| 2 | レジストラへのDeploy Template登録の統合 | 現行loop対象外（roadmap `future`）。MVPのUIは組込みTemplateの選択とParameter入力のみ |
| 3 | `build.deploy`系のMVP境界 | Dockerfile / Compose生成とDeploy Validationを完了条件に含める（`build.deploy-projection`）。UI Surfaceは`build.deploy` |
| 4 | `completion.end-to-end`の最小ホスト環境 | Docker Engine + Compose Pluginが事前に利用可能なLinux（`host: linux`）。Windows WSL2 / macOSは対応宣言のみでE2E必須にしない |
| 5 | Setup Script / Docker自動導入支援 | 現行MVP loopから外し、roadmap `future.excluded_from_current_loop`に将来の独立Bundle `build.deploy-setup-script`として記録する。`completion.end-to-end`の依存に含めない。再開は`completion.end-to-end` implemented後にOwnerがsectionへ登録する |

具体的なImage / Dependency Version、Template IDの細則、Parameterの既定値は、§5の制約（再現性・機密値非埋め込み）を満たす範囲で`build.deploy-projection`の実装時に決定し、evidenceへ記録する。
