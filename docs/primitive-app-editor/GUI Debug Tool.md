# GUI Debug Tool

Roadmap Driven GUI Debug Tool仕様の詳細SSOT。

```yaml
authority:
  scope: "Roadmap Driven GUI Debug Tool specification (Detail SSOT)"
  implemented_by: "tooling.gui-debugger (./roadmap.yaml)"
  concretizes:
    - "./App Editer.md §39 Development Tooling (Architecture / Authority / Boundary)"
    - "./Editor UI.md §19 UI Marker Regulation (UI Marker規約)"
    - "../../README.md GUI Debug (開発Policy)"
  rules:
    - "本資料はApp Editer.mdのArchitecture / Authority / Boundaryを再定義せず、GUI Debug Toolについて具体化する"
    - "UI Markerの規約はEditor UI.md §19 UI Marker Regulationが定義し、本資料はその解決方法とGUI Mapでの利用を定義する"
    - "roadmap.yamlの進捗Authority (status / evidence / remaining) はroadmap Agent Tool (Agent tool.md) のroadmap.completeのみが更新する"
    - "roadmap.yamlのdiagnostics.gui_debugの書込契約は本資料のみが定義する"
    - "roadmap.yamlは本ToolのBundle / Dependency / Progressを定義し、Tool挙動を再定義しない"
```

---

## 1. Scope

Primitive App Editorの開発工程で行っていた手動GUIデバッグを、Python製GUI Debug Toolによる自動GUI操作・期待結果検証へ置き換える。

```text
GUI Debug Tool
  = Primitive App Editor開発用Tool
  = Roadmap Driven GUI Verification

GUI Debug Tool
  != App Editor Product Feature
  != Debug Viewer (editor.debug-viewer)
  != Application / Authoring Authority
```

対象：

```text
Roadmap読込 (status read-only)
Checkpoint選択
GUI Map YAML読込
起動中のPrimitive App Editor GUIへの接続
UI Marker検索
GUI自動操作
期待結果検証
Error / Marker Not Found検出
Log / Screenshot保存
roadmap.yamlへの診断追記
```

対象外：

```text
Primitive App Editor本体機能の実装
Code OSS本体の機能変更
Runtime Inspection (Debug Viewer)
AI連携 / roadmap Agent Toolの実行
Bundle進捗 (status / evidence / remaining) の更新
既存CLIテスト基盤 (mocha unit / smoke / component fixtures) の置換
```

`editor.debug-viewer`はApplicationのRuntime Inspectionを提供するProduct機能であり、本Toolとは別責務とする。

```text
Debug Viewer
  = Product / Editor Area Surface
  = Runtime Memory -> Human Inspection

GUI Debug Tool
  = Development Tool / 外部Process
  = Workbench GUI -> Automated Verification
```

---

## 2. Authority

```text
roadmap.yaml / section[].bundle[]
  = Bundle実装状態Authority
  = 更新者: roadmap.complete (Agent tool.md)
  = GUI Debug Tool: read-only

roadmap.yaml / diagnostics.gui_debug
  = GUI Debug診断記録
  = 更新者: GUI Debug Toolのみ (§12 Roadmap Diagnostics)

GUI Map YAML
  = Checkpoint定義 / GUI操作手順 / 期待結果 / 報告定義
  = 作成者: 開発Agent (GPT / Claude)

UI Marker
  = GUI操作対象の識別子
  = 規約: Editor UI.md §19 UI Marker Regulation

Run Artifact (Log / Screenshot / Result)
  = Derived / Transient Output
  != Authority
```

GUI Debug ToolはWorkbench GUIの外部観測者・操作者であり、Registry / Raw Data / Binding / project.sqlite / Runtime MemoryのAuthorityを持たない。

```text
GUI Debug Tool
  -> UI Marker経由のGUI操作
  -X-> project.sqlite直接読込 / 変更
  -X-> Registry / Raw Data / Binding直接変更
  -X-> Runtime Memory直接変更
  -X-> roadmap status / evidence / remaining変更
```

---

## 3. Debug Flow

```text
roadmap.yaml
    |
    v
Checkpoint (GUI Map YAMLの実行条件をBundle statusで評価)
    |
    v
GUI Map YAML
    |
    v
Python GUI Debug Tool
    |
    v
Primitive App Editor GUI (起動中のCode OSS Workbench)
    |
    v
GUI操作 / 期待結果検証
    |
    v
Error / Marker Not Found
    |
    v
GUI Mapの報告定義 + 実測Error (Merge)
    |
    v
roadmap.yaml diagnostics.gui_debugへ診断追記
```

roadmap.yamlは入力 (Bundle status) と出力 (diagnostics) の両方に現れるが、読込領域と書込領域は分離する。

```text
read
  = section[].bundle[].id / status

write
  = diagnostics.gui_debug.records only
```

---

## 4. Development Process

```yaml
process:
  - step: 1
    name: "Roadmap点検"
    owner: "Development Agent (GPT / Claude)"
    action: "roadmap.yamlを読み込み、Bundleの実装状態と既存実装を点検する"
  - step: 2
    name: "Checkpoint設計"
    owner: "Development Agent (GPT / Claude)"
    action: "CheckpointごとのUI操作・期待結果・実行条件を設計する"
  - step: 3
    name: "UI Marker監査"
    owner: "Development Agent (GPT / Claude)"
    action: "既存UI Markerを監査し、不足をEditor UI.md §19に従って追加する"
  - step: 4
    name: "GUI Map作成"
    owner: "Development Agent (GPT / Claude)"
    action: "GUI Map YAMLを作成する (§9 GUI Map YAML)"
  - step: 5
    name: "Tool構築"
    owner: "Development Agent (GPT / Claude)"
    action: "GUI Mapを読み込むPython GUI Debug Toolを構築する (§10 GUI Debug Tool Application)"
  - step: 6
    name: "実行 / 診断追記"
    owner: "Python GUI Debug Tool"
    action: "Error / 検索不能を検出したら、GUI Mapの報告定義と実測ErrorをMergeしてroadmap.yamlへ追記する (§12 Roadmap Diagnostics)"
```

1〜5は開発Agentの開発作業であり、Tool First (README.md) に従う。6はGUI Debug Tool自身の実行時責務であり、AIおよびroadmap Agent Toolを介さない。

```text
Development Agent
  = Tool / GUI Map / UI Markerの開発

GUI Debug Tool
  = GUI Mapの実行 / 検証 / 診断記録

Human Developer
  = Toolの起動 / Checkpoint選択 / 実行操作 / 診断の判断
```

---

## 5. Runtime Environment

```yaml
runtime:
  language: "Python 3"
  gui_framework:
    candidate: "PySide6"
    status: "候補 (実装時に採否を確定する)"
  automation:
    candidate: "Python Playwright (sync API)"
    status: "候補 (§6 Electron Connectionの検証後に確定する)"
  launch:
    from: "Code OSS統合ターミナル"
    role: "起動手段のみ"
  operation:
    surface: "GUI Debug Toolの独立GUIウィンドウ"
  target:
    application: "起動中のPrimitive App Editor (Code OSS Workbench)"
  runtime_dependencies:
    prohibited:
      - "AI / LLM API"
      - "roadmap Agent Tool (roadmap-mcp)"
      - "Code OSS / Primitive App Editorのsource import"
```

CLIは起動手段であり、デバッグ操作UIではない。

```text
CLI
  = Launch (roadmap path / GUI Map directory / connection endpoint等の起動設定)

CLI
  != Run / Step / Pause / Stop / Retry操作
  != Checkpoint選択
```

起動後のCheckpoint選択、実行操作、結果確認はGUIウィンドウで行う。

---

## 6. Electron Connection

### Connection Model

GUI Debug Toolは起動済みのPrimitive App Editor (Electron / Code OSS) のWorkbench RendererへChrome DevTools Protocol (CDP) で接続する。

```text
Primitive App Editor (Electron)
  launched with --remote-debugging-port=<port>
        |
        v
CDP endpoint (127.0.0.1:<port>)
        |
        v
Python Playwright chromium.connect_over_cdp
        |
        v
Workbench Page (vscode-file://.../workbench.html)
        |
        v
UI Marker Resolve / GUI Operation
```

```yaml
connection:
  primary: "CDP attach (Python Playwright chromium.connect_over_cdp)"
  endpoint:
    host: "127.0.0.1"
    port: "起動設定で指定"
  page_selection:
    - "接続したBrowser Contextのpageからworkbench.htmlを表示するWorkbench Windowを選択する"
    - "複数Windowが存在する場合は起動設定 / GUIで対象Windowを明示選択する"
  code_oss_modification: "不要とする (CDP portは起動引数で有効化する)"
  rejected_alternatives:
    - candidate: "Playwright _electron.launch (test/automationと同方式)"
      reason: "新規Electron Processを起動する方式であり、起動中のPrimitive App Editorを操作対象とする要件と異なる。Python Playwrightで同APIが提供されるかは未確認"
    - candidate: "画像認識 / 固定座標操作"
      reason: "Editor UI.md §19 UI Marker Regulationにより原則禁止"
```

### Confirmed Facts

```text
- Code OSS自身がRendererのCDP portを使用する
    src/vs/code/node/cli.ts: --prof-startup時に --remote-debugging-port=<port> を付与
- 開発用launch設定がCDP port 9222でWorkbenchへattachする
    .vscode/launch.json: "Attach to VS Code" (type chrome, port 9222)
    Run Unit Tests系設定: --remote-debugging-port=9222
- 既存smoke automationはNode Playwright _electron.launchで新規起動する
    test/automation/src/playwrightElectron.ts (--enable-smoke-test-driver)
- Code OSS Workbench PartはDOM idを持つ
    src/vs/workbench/services/layout/browser/layoutService.ts: workbench.parts.*
```

### Unverified

以下は実装時に検証し、検証前に実装済みの事実として扱わない。

```text
- scripts/code.sh (dev launch) に --remote-debugging-port を渡した起動で
  Python Playwright connect_over_cdpがWorkbench pageを取得できること
- connect_over_cdp接続中のclick / type / screenshotがWorkbench操作として安定すること
- Code OSS統合ターミナルから起動したTool Processが、同一Instanceを操作する場合の
  focus / keyboard入力の競合有無
- Webview (iframe) を使うSurfaceのframe探索可否
- 接続断 / Window reload時の再接続挙動
- CDP portをlocalhost以外へ公開しない運用の確認
```

CDP接続が要件を満たせない場合、代替接続方式の採否はOwner判断とし、Code OSS本体の改変で解決しない。

---

## 7. Checkpoint

CheckpointはGUI上で検証可能な機能単位であり、1つ以上のBundleに関連付ける。

```yaml
checkpoint:
  id: "cp.<area>.<name>"
  bundles:
    - "<roadmap bundle id>"
  condition:
    require:
      - bundle: "<roadmap bundle id>"
        status:
          - "implemented"
  regression: true
```

### Applicability

検査対象はRoadmap上のBundle実装状態を基準に決定する。

```text
Run Start
    |
    v
roadmap.yaml read (section[].bundle[].status)
    |
    v
condition.require評価
    |
    +--> 全条件成立 -> runnable
    |
    +--> 不成立 -> not_applicable (理由: bundle / 現status)
```

```text
not_applicable
  != failure
  -> diagnosticsを記録しない
```

未実装機能を不具合として誤検出しない。

```text
- conditionのstatus既定値は implemented とする
- partialを許可する場合はGUI Map作成者がcondition.require[].statusへ明示し、
  そのCheckpointのstepはpartial時点で存在する機能のみを検証する
- condition.requireに存在しないBundle idを指定したGUI Mapは読込Errorとする
- 実行時のBundle statusは診断記録へsnapshotとして保存する
```

### Regression

実装済みBundleのCheckpointは回帰検証に再利用する。

```text
Regression Run
  = regression: true かつ runnable な全Checkpointを順に実行
```

### Implementation Dependency / Execution Condition

```text
roadmap depends_on
  = Bundle実装順序 (roadmap.next選択)
  = roadmap.yamlのみが定義

Checkpoint condition
  = GUI検証の実行可否
  = GUI Map YAMLが定義
```

Checkpoint conditionをroadmap.nextの選択入力にしない。depends_onをCheckpoint conditionから推定・変更しない。

---

## 8. UI Marker Resolution

UI Markerの規約はEditor UI.md §19 UI Marker Regulationが定義する。本Sectionは解決方法を定義する。

### Locator Kind

```yaml
locator:
  - kind: "part"
    meaning: "Code OSS Workbench Part DOM id (workbench.parts.*)"
    priority: 1
  - kind: "view"
    meaning: "Code OSS View Container / View / Panel由来のDOM id (例: workbench.view.explorer)"
    priority: 1
  - kind: "status"
    meaning: "Status Bar item id (例: status.problems)"
    priority: 1
  - kind: "marker"
    meaning: "Primitive App Editor UI Marker (data-pae-marker)"
    priority: 2
  - kind: "role"
    meaning: "ARIA role + Accessible Name (locale固定時のみ)"
    priority: 3
  - kind: "css"
    meaning: "既存Code OSS構造class等のCSS selector"
    priority: 4
    requires: "justification (他Locatorで識別できない理由)"
```

```text
既存識別子 (part / view / status)
  > Primitive App Editor UI Marker (marker)
  > role + accessible name
  > css (justification必須 / Marker監査対象)
```

### Scope / Item

```text
within
  = 親Locator内に検索範囲を限定する

item.text
  = List / Tree / Grid内の項目を表示name / labelで特定する
```

List / Tree内の項目はMarkerでItem種別を特定し、表示されたname / labelで項目を特定する。UUIDやDOM位置indexで項目を特定しない。

### Resolution Result

```text
1件
  -> resolved

0件 (timeout経過)
  -> marker_not_found

2件以上 (unique要求時)
  -> marker_ambiguous
```

### Prohibited

```text
画像認識
固定座標 / Window相対座標
DOM位置index依存 (nth-child等)
locale未固定のLocalized Text単独
UUID / Raw Data値をMarker値として使用
```

---

## 9. GUI Map YAML

GUI Map YAMLは1 Checkpointを1ファイルで定義する。

```text
tools/primitive-app-editor/gui-debugger/maps/<checkpoint-id>.yaml
```

### Schema

```yaml
gui_map:
  version: 1

  checkpoint:
    id: "cp.<area>.<name>"              # Checkpoint ID
    title: "<人間向け名称>"
    bundles:                            # 関連Bundle
      - "<bundle id>"
    condition:                          # 実行条件
      require:
        - bundle: "<bundle id>"
          status: ["implemented"]
    regression: true

  preconditions:                        # 実行前提 (不成立はprecondition_failed)
    window: "<対象Window識別>"
    locale: "<固定locale (role locatorを使う場合必須)>"
    workspace: "<想定Working Directory / fixture>"
    markers:                            # 実行前に存在すべきMarker
      - "<marker alias>"

  markers:                              # UIマーカー定義 (alias -> locator)
    <alias>:
      kind: "part | view | status | marker | role | css"
      value: "<identifier>"
      within: "<parent alias>"
      justification: "<css時必須>"

  inputs:                               # 入力値
    <name>: "<value>"

  steps:                                # 操作順序
    - id: "s01"
      title: "<操作説明>"
      action: "<action>"
      target: "<marker alias>"
      item:
        text: "<表示name / label>"
      value: "{{ inputs.<name> }}"
      timeout_ms: 5000
      continue_on_error: false          # true の場合のみFailed後に次stepへ継続可能
      expect:                           # 期待結果
        - "<expectation>": "<marker alias>"
      report:                           # Error時の報告定義 (step単位)
        summary: "<症状>"
        category: "<分類>"
        suspected_bundles:
          - "<bundle id>"

  report:                               # Error時の報告定義 (Checkpoint既定)
    destination: "roadmap.diagnostics"  # 報告先
    summary: "<症状>"
    category: "<分類>"
    suspected_bundles:
      - "<bundle id>"
```

### Action

```text
click / double_click / context_click
hover
focus
type        (value)
press       (key chord)
select      (option)
command     (Command Palette経由のCommand実行)
wait        (expectが成立するまで待機)
screenshot  (明示的証跡取得)
```

### Expectation

```text
visible / hidden / absent
enabled / disabled / focused
text_equals / text_contains
attribute
count
```

### Report Definition

```text
step.report
  = Checkpoint report を上書きではなくfield単位で補完する

destination
  = roadmap.diagnostics (唯一の永続報告先)
  + Run Artifact (常に保存)
```

### Validation

GUI Map読込時に以下を検証し、不正なGUI Mapは実行しない。

```text
- checkpoint.idがファイル名と一致し、全GUI Map間で一意
- bundles / condition.require[].bundleがroadmap.yamlに存在
- step.target / within / preconditions.markersが定義済みalias
- css locatorにjustificationが存在
- role locator使用時にpreconditions.localeが存在
- 固定座標 / 画像指定のfieldが存在しない
- report.destinationが roadmap.diagnostics
```

---

## 10. GUI Debug Tool Application

### Functions

```text
Roadmap / GUI Map読込
Checkpoint一覧表示・選択 (runnable / not_applicable / invalid)
Run / Step / Pause / Stop / Retry
Regression Run
UIマーカー検索
GUI自動操作
期待結果検証
Error表示 (報告定義 + 実測Error)
Log / Screenshot保存
診断結果記録 (roadmap.yaml diagnostics.gui_debug)
```

### Window Layout

```text
GUI Debug Tool Window
├─ Toolbar
│  ├─ Connect / Disconnect
│  ├─ Run / Step / Pause / Stop / Retry
│  └─ Regression Run
├─ Checkpoint List
│  └─ id / title / bundles / applicability
├─ Step List
│  └─ id / title / state
├─ Detail
│  ├─ Error (report definition + measured)
│  └─ Screenshot Preview
├─ Log
└─ Status
   └─ connection / roadmap path / GUI Map directory / diagnostics write state
```

### Execution Control

```text
Idle
  --Run-->      Running
  --Step-->     Running (1 step) -> Paused

Running
  --Pause-->    Paused
  --Stop-->     Stopped
  --step error-> Failed (Paused at failed step)

Paused
  --Run-->      Running
  --Step-->     Running (1 step) -> Paused
  --Stop-->     Stopped

Failed
  --Retry-->    失敗stepをMarker再解決から再実行
  --Run-->      次stepから継続 (GUI Mapが continue_on_error を許可する場合のみ)
  --Stop-->     Stopped
```

```text
Regression Run
  = Checkpoint単位で実行し、Failedでも次Checkpointへ進む
```

Tool UIはCheckpointの実行可否・結果・診断を表示するのみとし、Bundle statusを表示上でも変更しない。

---

## 11. Execution Result

```yaml
result:
  passed:
    diagnostics: false
  not_applicable:
    meaning: "condition不成立 (未実装 / partial)"
    diagnostics: false
  precondition_failed:
    meaning: "Window / workspace / locale / 前提Marker不成立"
    diagnostics: false
  connection_error:
    meaning: "CDP接続不可 / 接続断"
    diagnostics: false
  stopped:
    meaning: "利用者による中断 (failure未発生)"
    diagnostics: false
  marker_not_found:
    meaning: "Locatorが0件 (timeout経過)"
    diagnostics: true
  marker_ambiguous:
    meaning: "unique要求のLocatorが2件以上"
    diagnostics: true
  expectation_failed:
    meaning: "期待結果不一致"
    diagnostics: true
  operation_error:
    meaning: "操作実行時Error (detached / not interactable等)"
    diagnostics: true
```

```text
Checkpoint終了時 (passed / failed / stopped)
  -> step最終結果を確定
  -> diagnostics: true の結果のみroadmapへ記録

Retryで成功したstep
  -> Run Artifactのみに失敗履歴を残し、roadmapへ記録しない

failure後のStop
  -> 観測済みfailureを記録する
```

環境要因 (connection_error / precondition_failed) はTool上とRun Artifactに表示・保存し、Bundle診断として記録しない。

---

## 12. Roadmap Diagnostics

### Location

```yaml
diagnostics:
  gui_debug:
    writer: "Python GUI Debug Tool (tooling.gui-debugger)"
    contract: "./GUI Debug Tool.md §12 Roadmap Diagnostics"
    records: []
```

`diagnostics`はroadmap.yamlのtop-level keyとし、`roadmap` / `section` / `future`の外側に置く。

### Record

GUI Mapの報告定義と実測Errorをfield名前空間を分けてMergeする。

```yaml
- id: "gd-<UTC timestamp>-<checkpoint id>-<step id>"
  fingerprint: "<checkpoint id>|<step id>|<result kind>|<marker alias>"
  state: "open"
  checkpoint: "<checkpoint id>"
  bundles:
    - "<bundle id>"
  roadmap_status:                 # 実行時Bundle status snapshot
    <bundle id>: "<status>"
  step: "<step id>"
  kind: "marker_not_found | marker_ambiguous | expectation_failed | operation_error"
  report:                         # GUI Map報告定義 (step.report + Checkpoint report)
    summary: "<症状>"
    category: "<分類>"
    suspected_bundles:
      - "<bundle id>"
  measured:                       # 実測Error
    marker: "<alias>"
    locator: "<kind>:<value>"
    expected: "<期待結果>"
    actual: "<実測値>"
    error: "<Error message>"
    target:
      repository_commit: "<git HEAD>"
      gui_map_digest: "<GUI Map SHA-1>"
      tool_version: "<tool version>"
  artifacts:
    run: "<run id>"
    log: "<Run Artifact相対path>"
    screenshot: "<Run Artifact相対path>"
  first_seen: "<UTC ISO 8601>"
  last_seen: "<UTC ISO 8601>"
  occurrences: 1
```

```text
report
  = 設計時の報告定義 (GUI Map)

measured
  = 実行時の実測Error

Merge
  = report / measured を同一recordへ併記
  = 片方で他方を上書きしない
```

### Write Rule

```text
GUI Debug Tool may write
  = diagnostics.gui_debug.records

GUI Debug Tool must not write
  = roadmap
  = section (status / evidence / remaining / depends_on / reference / title / 拡張key)
  = future
  = diagnostics.gui_debug.writer / contract
```

```text
新規fingerprint / 既存recordがopen以外
  -> recordを末尾へ追加

同一fingerprintのopen recordが存在
  -> last_seen / occurrences / artifactsのみ更新

record削除 / state変更 (open以外)
  -> GUI Debug Toolは行わない
  -> 人間 / Auditorのdesign_changeで行う
```

### Write Protocol

```text
1. roadmap.yamlをtextとして読込、YAML解析
2. diagnostics.gui_debug.records範囲のみをtext置換で編集
   (document全体の再serializeを行わない / 文字列はJSON quoted)
3. 編集後textを再解析し、diagnostics.gui_debug.records以外が
   編集前と完全一致することを検証
4. section構造がroadmap Agent Toolの読込規則 (Agent tool.md read_yaml) を満たすことを検証
5. 同一directoryのtemp fileへ書込
6. rename直前にroadmap.yamlを再読込し、手順1のtextと一致しなければ中止して1から再試行
7. rename
8. 再試行上限超過時はRun Artifactのpending-diagnosticsへ保存し、GUIへ表示
```

### roadmap Agent Toolとの関係

```text
roadmap.next
  = diagnosticsを選択入力にしない

roadmap.complete
  = diagnosticsを変更せず保持する
  = 実行中のroadmap.yaml変更を検出した場合は書込を拒否する

GUI Debug Tool
  = roadmap.completeを呼ばない
  = statusを変更しない
```

診断recordはBundleのreopen / status変更を自動で行わない。診断を受けた修正・reopenの判断は人間 / Ownerが既存のroadmap運用で行う。

GUI Debug Toolはroadmap.yamlをcommit / pushしない。Version管理への反映は人間の判断とする。

---

## 13. Run Artifacts

```text
.build/primitive-app-editor/gui-debug/runs/<run id>/
├─ run.jsonl              (操作 / Marker解決 / 結果のLog)
├─ result.yaml            (Checkpoint / step結果)
├─ screenshots/
│  └─ <checkpoint id>/<step id>.png
└─ pending-diagnostics.yaml (roadmap書込失敗時のみ)
```

```text
Run Artifact
  = Derived / Transient
  = repository管理対象外 (.build/)
  != Authority
```

Screenshotはfailure時に必ず保存し、`screenshot` actionでも保存する。Screenshotは証跡であり、UI Marker解決に使用しない。

---

## 14. Boundary

```text
GUI Debug Tool
  -> roadmap.yaml section[].bundle[].status : read
  -> roadmap.yaml diagnostics.gui_debug.records : write
  -> GUI Map YAML : read
  -> Primitive App Editor Workbench GUI : UI Marker経由で操作
  -> Run Artifact : write

GUI Debug Tool
  -X-> roadmap status / evidence / remaining / depends_on変更
  -X-> roadmap Agent Tool / AIの実行時利用
  -X-> project.sqlite / Working Directoryの直接変更
  -X-> Code OSS本体の改変
  -X-> Debug Viewer (editor.debug-viewer) の代替
  -X-> 既存CLIテスト基盤の置換
```

GUI操作でAuthoring Dataを保存するCheckpointは、`preconditions.workspace`で指定した検証用Working Directoryに対してのみ実行する。利用者の作業中Projectを検証対象として推測しない。

UI Markerの追加はPrimitive App Editor所有のUI code (`src/vs/workbench/contrib/primitiveAppEditor/**`) で行い、Code OSS本体のUIへ追加しない。

---

## 15. Implementation Bundle

```yaml
bundle: "tooling.gui-debugger"
location:
  tool: "tools/primitive-app-editor/gui-debugger/"
  gui_maps: "tools/primitive-app-editor/gui-debugger/maps/"
  isolation:
    - "src/vs (Code OSS / Primitive App Editor product code) をimportしない"
    - "tools/primitive-app-editor/roadmap-mcpをimportしない"
deliverables:
  - "Python GUI Debug Tool (§5 / §6 / §10)"
  - "GUI Map YAML loader / validator (§9)"
  - "Checkpoint applicability評価 (§7)"
  - "UI Marker resolver (§8)"
  - "Execution result / diagnostics merge (§11 / §12)"
  - "roadmap.yaml diagnostics write protocol (§12)"
  - "Run Artifact出力 (§13)"
  - "実装時点でrunnableなCheckpointのGUI Map"
  - "UI Marker監査結果と、不足MarkerのPrimitive App Editor所有UI codeへの追加 (Editor UI.md §19)"
verification:
  - "GUI非依存部分 (GUI Map validation / applicability / diagnostics merge / write protocol) の自動test"
  - "diagnostics追記後もroadmap.nextの選択結果が不変であること"
  - "diagnostics追記後もroadmap.completeが成功し、diagnosticsが保持されること"
  - "§6 Unverified項目の検証結果"
  - "起動中のPrimitive App Editorに対するCheckpoint実行結果"
audit_input:
  source: "./roadmap.yaml section[GUI Debug Tooling].bundle[tooling.gui-debugger].audit"
  rule: "auditのgap項目を実装時の点検対象とし、confirmed / to_verifyの区別を維持する"
```

### Dependency

```text
tooling.roadmap-agent
  = roadmap.yaml形式 / Tool First前提

workbench.integration
  = Primitive App Editor GUIがWorkbenchへ統合され、
    起動中GUIとしてCheckpoint検証が可能になる最初のBundle
```

---

## 16. Open Issues

```text
- PySide6 / Python Playwrightの採否、Python version、依存管理方式
- §6 Unverifiedの全項目
- Python fileに対するbuild/hygiene (indentation / copyright filter) の適用範囲
- CIでGUI Debug Toolのtestを実行するか (GUI非依存部分のみか)
- 検証用Working Directory fixtureの作成・選択方法
- 後続UI BundleでのUI Marker付与責務 (後続Bundleのreference追加はOwner判断)
- diagnostics recordの肥大化時の整理方針
- roadmap.complete / GUI Debug Tool間のrename直前比較以降の同時書込 (TOCTOU) 対策
```
