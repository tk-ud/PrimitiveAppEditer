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
    - "../../README.md GUI Verification Cycle (開発ロードマップとGUI検証の責務分離)"
  rules:
    - "本資料はApp Editer.mdのArchitecture / Authority / Boundaryを再定義せず、GUI Debug Toolについて具体化する"
    - "UI Markerの規約はEditor UI.md §19 UI Marker Regulationが定義し、本資料はその解決方法とGUI Mapでの利用を定義する"
    - "roadmap.yamlの進捗Authority (status / evidence / remaining) はroadmap Agent Tool (Agent tool.md) のroadmap.completeのみが更新する"
    - "進捗更新 (実装結果のstatus / evidence / remaining記録) はroadmap.completeのみが行う。Owner判断のdesign_change PRによる既存remainingの契約・検証条件文言の修正と修正Bundle追加は設計定義変更であり進捗更新ではない (status / evidence / depends_onは変更しない。Agent tool.md / README.md GUI Verification Cycle)"
    - "roadmap.yamlのdiagnostics.gui_debugの書込契約は本資料のみが定義する"
    - "roadmap.yamlは本ToolのBundle / Dependency / Progressを定義し、Tool挙動を再定義しない"
    - "GUI検証 (Checkpoint実行 / 結果) は開発Bundleのimplemented条件に含めない (README.md GUI Verification Cycle)"
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
  = 生成・観測情報更新: GUI Debug Tool
  = state / resolution.bundle_ids更新: Owner承認のdesign_change PR (§12 State)

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

### Development / GUI Verification Cycle

GUI検証は開発ロードマップの外側の循環として実行する (README.md GUI Verification Cycle, Owner確定の7段階)。

```text
1. ui_map_design        : UI Map (GUI Map) を設計で作る。roadmap作成より前
2. roadmap_design       : UI Mapに対応した開発ロードマップを作る
3. development          : roadmap.next / roadmap.completeによるBundle実装 (単体 / 統合 / 契約テスト + CI + evidence)
4. gui_verification     : 実装後、UI MapをGUI Debug Toolで自動検証。記録: diagnostics.gui_debug
5. owner_triage         : GUIデバッグ不具合を分析、Owner判断のdesign_changeで修正Bundle追記
6. human_quality_test   : 人間がUX・実利用の品質をテスト
7. owner_triage         : 品質テスト不具合を分析、Owner判断のdesign_changeで修正Bundle追記

5 / 7で修正Bundleを追加した場合は3へ戻り、4 / 6を必要に応じ繰り返す
```

```text
Checkpoint結果
  != Bundle implemented条件
  != roadmap.next 選択 / 停止条件
```

GUI Debug Toolはtooling.gui-debugger implemented後に実行でき、開発ロードマップ途中での実行も妨げない。その場合もCheckpoint結果はBundle進捗へ反映しない。

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
    action: "CheckpointごとのUI操作・期待結果・実行条件・UI識別契約を設計する (UI Map設計。対象Surfaceのroadmap作成より前に行う)"
  - step: 3
    name: "UI Marker監査"
    owner: "Development Agent (GPT / Claude)"
    action: "実装済みSurfaceの既存UI MarkerをUI Mapの識別契約に照らして監査し、不足をEditor UI.md §19に従って追加する (Markerの実装時付与はSurfaceを実装するBundleの責務)"
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

1〜5の完了条件は開発Bundle (tooling.gui-debugger) の検証 (§15 Implementation Bundle) で判定する。6の実行結果は開発Bundleのimplemented条件に含めず、gui_verification phase (§3 Development / GUI Verification Cycle) の記録とする。

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

```text
Checkpoint condition
  = Bundle implemented後にGUI検証を実行してよいかの判定
  != Bundle implementedの前提条件
  != depends_on

GUI実機での観測を要する確認
  = Checkpointの責務
  != 開発Bundleのremaining / 完了条件
```

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

target (data-pae-marker等)
  = 固定のUI要素 / Item種別を特定する

item
  = target内の候補から1項目を特定する
```

List / Tree / Grid / Select候補等の項目は、targetでItem種別を特定し、`item`で項目を特定する。

```yaml
item:
  identity: "<Item Identity値 | {{ inputs.<name> }} | {{ captures.<name> }}>"
  text: "<表示name / label>"
```

```text
item.identity
  = Editor UI.md §19 Item Identity (data-pae-item) の完全一致
  = 同名項目を含む全ての項目を一意に特定する

item.text
  = 表示name / label (whitespace正規化後の完全一致)
  = 一意解決を要求する場合、候補内で一意な場合のみ特定に使用できる
  = resolve: count (### Expectation) では一致件数を数える

item.identity + item.text
  = identityで特定し、textを表示値の追加照合に使用する
```

`item.identity`と`item.text`の少なくとも一方を指定する。DOM位置index、表示順序、固定座標で項目を特定しない。

### Item Identity

同名項目 (registry.identityはname重複を許容する) は表示name / labelでは識別できないため、Item Identityで識別する。

```text
Item Identity
  = UI項目要素のdata-pae-item属性
  = 項目が表すRegistry / Raw Data / Binding等のUUIDをそのまま反映した値
  = 表示しない (Primary UI / Tooltip / Accessible Labelに含めない)

UUID Identity Authority
  = Registry (App Editer.md §7 UUID Identity)

Item Identity
  = AuthorityのUUIDを読み取り専用で反映するのみ
  = UUIDを生成 / 変更 / 再定義しない
```

GUI MapはItem Identity値を次のいずれかで与える。

```text
inputs.<name>
  = preconditions.workspaceの検証用Working Directoryに既知のUUID
    (Seed / INSERTで指定したUUIDはKeepされる: App Editer.md §7 Generate)

captures.<name>
  = 実行中に取得したItem Identity
  = 先行stepのcaptureで取得する
```

Capture：

```yaml
capture:
  name: "<capture name>"
  mode: "item | new_item"
  target: "<marker alias>"
  item:                       # mode: item の場合
    text: "<表示name / label>"
```

```text
mode: item
  = step完了後、target + itemで一意に解決した項目のdata-pae-itemを取得

mode: new_item
  = step action実行前後でtarget内のdata-pae-item集合を比較し、
    新規に出現した項目がちょうど1件の場合にそのdata-pae-itemを取得
  = 0件 / 2件以上は expectation_failed
```

`new_item`により、UUIDが自動生成される新規項目 (同名を含む) をGUI Map作成時にUUIDを知らずに特定できる。

### Resolution Result

```text
1件
  -> resolved

0件 (timeout経過)
  -> marker_not_found

2件以上 (unique要求時)
  -> marker_ambiguous

item.textのみで候補が2件以上 (同名項目)
  -> marker_ambiguous
  -> 先頭 / 任意の1件を選択しない
```

### Prohibited

```text
画像認識
固定座標 / Window相対座標
DOM位置index依存 (nth-child等)
locale未固定のLocalized Text単独
UUID / Raw Data値をMarker値 (data-pae-marker) として使用
同名候補からの位置 / 順序による選択
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

  inputs:                               # 入力値 (文字列 / 整数)
    <name>: "<value>"

  steps:                                # 操作順序
    - id: "s01"
      title: "<操作説明>"
      action: "<action>"
      target: "<marker alias>"
      item:                             # §8 Scope / Item
        identity: "{{ captures.<name> }}"
        text: "<表示name / label>"
      value: "{{ inputs.<name> }}"
      timeout_ms: 5000
      continue_on_error: false          # true の場合のみFailed後に次stepへ継続可能
      capture:                          # §8 Item Identity
        name: "<capture name>"
        mode: "item | new_item"
        target: "<marker alias>"
      expect:                           # 期待結果 (### Expectation)
        - assert: "<expectation kind>"
          target: "<marker alias>"
          item: { identity: "...", text: "..." }
          # kind別field: source / op / name / value
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

各Expectationは1つのmappingとし、`assert` (種別)、`target` / `item` (操作対象)、種別ごとの比較値 / 比較方法fieldを持つ。

```yaml
expectation:
  common:
    assert: "<kind>"               # 必須
    target: "<marker alias>"       # 必須
    item:                          # 任意 (§8 Scope / Item)
      identity: "<...>"
      text: "<...>"

  kinds:
    visible:   { resolve: "unique", fields: [] }
    hidden:    { resolve: "unique", fields: [] }
    enabled:   { resolve: "unique", fields: [] }
    disabled:  { resolve: "unique", fields: [] }
    focused:   { resolve: "unique", fields: [] }
    absent:    { resolve: "count",  fields: [] }

    text_equals:
      resolve: "unique"
      fields:
        value:  { type: "string", required: true }
        source: { enum: ["text", "input_value"], default: "text" }
    text_contains:
      resolve: "unique"
      fields:
        value:  { type: "string", required: true }
        source: { enum: ["text", "input_value"], default: "text" }

    attribute:
      resolve: "unique"
      fields:
        name:  { type: "string", required: true }
        op:    { enum: ["equals", "contains", "present", "absent"], required: true }
        value: { type: "string", required_when: ["equals", "contains"], forbidden_when: ["present", "absent"] }

    count:
      resolve: "count"
      fields:
        op:    { enum: ["eq", "ne", "ge", "gt", "le", "lt"], required: true }
        value: { type: "integer", minimum: 0, required: true }
```

比較方法：

```text
resolve: unique
  = target (+ item) が1件に解決すること
  = 0件 -> marker_not_found / 2件以上 -> marker_ambiguous

resolve: count
  = 解決件数を数える (0件もerrorにしない)

visible / hidden
  = 1件に解決し、表示状態 / 非表示状態であること

absent
  = 解決件数が0件であること (marker_not_foundとしない)

enabled / disabled / focused
  = 1件に解決し、要素が該当状態であること

source: text
  = 要素の表示text

source: input_value
  = 入力要素 (text field / number field / select等) の現在値

text_equals
  = 実測値 == value

text_contains
  = valueが実測値の部分文字列

text比較の正規化
  = 実測値 / value とも前後空白除去 + 連続空白を1文字へ
  = 大文字小文字を区別する

attribute op
  = equals   : 属性値 == value
  = contains : valueが属性値の部分文字列
  = present  : 属性が存在
  = absent   : 属性が存在しない

count op
  = 解決件数 <op> value (整数比較)

value内の {{ inputs.<name> }} / {{ captures.<name> }}
  = 比較前に置換する
```

期待結果はstepのtimeout_ms内で成立するまで再評価し、timeout時点の最終観測値を`measured.actual`、比較式を`measured.expected`として記録する (§12 Roadmap Diagnostics)。

例 (未実装UIを想定した記述例であり、Marker値は実装時に確定する)：

```yaml
gui_map:
  version: 1
  checkpoint:
    id: "cp.registry.duplicate-name-table"
    title: "同名Tableを作成し、それぞれを識別して編集できる"
    bundles: ["workbench.views", "editor.inspector"]
    condition:
      require:
        - { bundle: "workbench.views", status: ["implemented"] }
        - { bundle: "editor.inspector", status: ["implemented"] }
    regression: true
  preconditions:
    workspace: "fixture:registry-enemy"
    markers: ["registry.tree"]
  markers:
    registry.tree:     { kind: "marker", value: "registry.tree" }
    registry.table:    { kind: "marker", value: "registry.tree.table", within: "registry.tree" }
    registry.add:      { kind: "marker", value: "registry.tree.add-table" }
    inspector.name:    { kind: "marker", value: "inspector.field.name" }
    inspector.header:  { kind: "marker", value: "inspector.header.label" }
  inputs:
    existing_enemy_uuid: "0b6c1f0e-1a2b-4c3d-8e9f-000000000001"
    table_name: "Enemy"
  steps:
    - id: "s01"
      title: "同名TableをRegistryへ追加する"
      action: "click"
      target: "registry.add"
      capture: { name: "new_enemy", mode: "new_item", target: "registry.table" }
      expect:
        - { assert: "count", target: "registry.table", item: { text: "{{ inputs.table_name }}" }, op: "eq", value: 2 }
    - id: "s02"
      title: "既存Enemyを選択する"
      action: "click"
      target: "registry.table"
      item: { identity: "{{ inputs.existing_enemy_uuid }}", text: "{{ inputs.table_name }}" }
      expect:
        - { assert: "text_equals", target: "inspector.header", value: "{{ inputs.table_name }}" }
        - { assert: "text_equals", target: "inspector.name", source: "input_value", value: "{{ inputs.table_name }}" }
        - { assert: "attribute", target: "registry.table", item: { identity: "{{ inputs.existing_enemy_uuid }}" }, name: "aria-selected", op: "equals", value: "true" }
        - { assert: "attribute", target: "registry.table", item: { identity: "{{ captures.new_enemy }}" }, name: "aria-selected", op: "equals", value: "false" }
      report:
        summary: "同名Tableのうち既存Enemyを選択できない"
        category: "selection"
        suspected_bundles: ["workbench.views", "editor.inspector"]
  report:
    destination: "roadmap.diagnostics"
    summary: "同名Registry項目の識別 / 選択に失敗"
    category: "registry"
    suspected_bundles: ["workbench.views"]
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
- step.target / within / preconditions.markers / expect[].target / capture.targetが定義済みalias
- expect[].assertが§9 Expectationの種別であり、種別ごとのrequired / forbidden fieldを満たす
- attribute.op present / absent でvalueが無く、equals / contains でvalueが存在
- count.valueが0以上の整数、text_* / attribute.valueが文字列
- resolve: count の種別 (count / absent) 以外でのみ一意解決を要求する
- item指定時はidentity / textの少なくとも一方が存在
- item.identityが UUID形式 / inputs参照 / captures参照 のいずれか
- {{ inputs.<name> }} がinputsに定義済み
- {{ captures.<name> }} が参照stepより前のstepのcaptureで定義済み、capture.nameが一意
- capture.mode: item でitemが存在し、new_item でitemが存在しない
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
state
  = GUI Debug Toolが生成するrecordは常に "open" (上記の例は生成時の初期record)
  = 語彙は open / planned / wontfix / resolved (### State)
  = open以外への変更はOwner承認のdesign_change PRのみ
```

Owner判断後にdesign_change PRが付与する任意field (GUI Debug Toolは生成しない。open recordは持たない):

```yaml
  state: "planned | wontfix | resolved"
  resolution:
    bundle_ids:                   # 対応する修正Bundle id (wontfixは空または省略)
      - "<bundle id>"
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

record削除 / state変更 / resolution.bundle_ids設定
  -> GUI Debug Toolは行わない
  -> Owner承認のdesign_change PRで行う (### State)
```

### State

状態管理は既存の`diagnostics.gui_debug.records`で行う。新しい状態管理機構・Bundleは追加しない。

```text
open      = GUI Debug Toolが不具合を検出・記録した
planned   = Ownerが修正を決定し、対応する修正Bundleを登録した
wontfix   = Ownerが修正不要と判断した
resolved  = 修正後の再検証によって解消を確認した
```

```text
遷移 (すべてOwner承認のdesign_change PRで更新)
  open -> planned   : 修正Bundleをroadmapへ追加し、resolution.bundle_idsへ記録
  open -> wontfix   : 修正不要の判断
  planned -> resolved : 修正Bundle実装 (roadmap.complete) 後の再検証で解消を確認
  上記以外の遷移は定義しない
```

```text
resolution.bundle_ids
  = 対応する修正Bundle idを記録する (roadmap.yaml section[].bundle[].idを参照)
  = planned / resolvedで必須。wontfixは空または省略可
  = 記録はBundleのstatus / evidence / remaining / depends_onを変更しない
```

```text
更新Authority
  GUI Debug Tool          : record生成 / 既存open recordのlast_seen / occurrences / artifacts更新のみ
  design_change PR (Owner承認) : 既存recordのstate / resolution.bundle_ids更新
  roadmap.complete        : Bundle実装進捗 (status / evidence / remaining) のみ。diagnosticsは保持する

再検証成功のみでは、既存recordを自動でresolvedへ変更しない
state遷移は、GUI Map YAMLの定義およびBundle statusを変更しない
```

再検証後に同一fingerprintが再発した場合、既存recordがopen以外であればrecordを末尾へ追加する (### Write Rule)。

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

### Owner Feedback

GUI検証結果は、Owner判断を経てのみ開発ロードマップへ還元する。

```text
diagnostics.gui_debug.records (state: open)
    |
    v
不具合分析 (人間 / Auditor / 開発Agentによる調査は可)
    |
    v
Owner判断: 修正方針の確定 / 修正しない判断
    |
    v
design_change (PR)
  = 修正作業をroadmap.yaml section[].bundle[]へBundleとして追加
  = depends_onは修正の実装依存のみ (Checkpoint conditionを流用しない)
  = 追加Bundleは status: "not started" / evidence: [] / remaining: [] で開始する
    |
    v
roadmap.next / roadmap.complete による実装 (README.md Tool First)
    |
    v
GUI検証の再実行 (Regression Run)
```

```text
GUI Debug Tool
  -X-> Bundle追加 / reopen / depends_on変更

開発Agent
  -X-> Owner判断なしのBundle追加 / reopen

既存recordの扱い
  = 削除しない (Owner Feedback後も保持)
  = state変更 / 対応Bundleの記録はOwner承認のdesign_changeで行う (### State)
  = 再検証で成功しても、GUI Debug Toolはrecordのstateを変更しない
```

既存のimplemented Bundleの不具合であっても、Owner判断なしにstatusを戻さない。修正は原則として追加Bundleで行い、既存Bundleのreopenを選ぶ場合もOwner判断のdesign_changeで行う。

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
  - "§6 Unverified項目のうち、stand-in (Chromium上のworkbench相当ページ) とCDP attachで自動testできる契約の検証結果"
  - "stand-inに対するTool動作検証の自動test (接続 / Marker解決 / Checkpoint実行 / Run Artifact出力 / diagnostics書込が機能すること)"
verification_excludes:
  - "起動中のPrimitive App Editor (scripts/code.sh起動のWorkbench) に対するGUI実機確認 (§6 Unverifiedのうち実機でのみ観測できる項目を含む)。Checkpoint (GUI Map) の責務とし、README.md GUI Verification Cycle step 4 で扱う"
  - "Checkpointがpassedであること (Product GUIの不具合はdiagnostics.gui_debugへ記録し、本Bundleの完了条件にしない)"
  - "§17 Checkpoint Coverageの未作成Checkpoint全件のGUI Map作成"
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
  = 実装依存: Project Open wiringとStatus Bar open state
    (status.primitiveAppEditor.project) をGUI Map / UI Marker監査の対象とする
```

```text
depends_on: workbench.integration
  = workbench.integrationの実装 (implemented) への依存
  != workbench.integrationのGUI実機確認への依存

workbench.integration
  -X-> depends_on: tooling.gui-debugger
  -X-> implemented条件: GUI Debug ToolによるCheckpoint結果
```

---

## 16. Open Issues

```text
- PySide6 / Python Playwrightの採否、Python version、依存管理方式
- §6 Unverifiedのうち実機 (scripts/code.sh起動のWorkbench) でのみ観測できる項目 (stand-in契約testで検証済みの項目は除く。Checkpoint (GUI Map) の責務として実行し、diagnostics.gui_debugへ記録する)
- Python fileに対するbuild/hygiene (indentation / copyright filter) の適用範囲
- CIでGUI Debug Toolのtestを実行するか (GUI非依存部分のみか)
- 検証用Working Directory fixtureの具体的な作成・選択方法 (定義の場所はGD-GAP-10により決定済み: Checkpoint (GUI Map) のprecondition。個別fixtureはUI Map設計工程で定める)
- 後続UI BundleでのUI Marker付与責務 (後続Bundleのreference追加はOwner判断)
- diagnostics recordの肥大化時の整理方針
- roadmap.complete / GUI Debug Tool間のrename直前比較以降の同時書込 (TOCTOU) 対策
```

### 解決済み: §15 verificationとGUI実機検証の分離 (設計変更, Issue #108 / Owner委任の自律判断)

```text
§15 verification
  = GUI非依存部分の自動test + stand-in (Chromium上のworkbench相当ページ) に対するCDP attach契約test
  != 起動中Primitive App Editor (scripts/code.sh起動のWorkbench) に対するGUI実機確認

GUI実機確認 (実機でのみ観測できる §6 Unverified項目を含む)
  = Checkpoint (GUI Map) の責務。README.md GUI Verification Cycle step 4 で実行し、結果は diagnostics.gui_debug へ記録する
  != 開発Bundle (tooling.gui-debugger) のimplemented条件
  (README.md bundle_implemented.excludes / 本書 §7 と整合)

audit gap
  GD-GAP-06 = roadmap.nextのaudit供給は本Bundleのimplemented条件にしない。必要になった時点で Agent tool.md の変更を design_change で別途行う
  GD-GAP-08 = Webview / iframe frame traversal はUI Map設計工程の識別契約で定義する (対象Bundle着手前)
  GD-GAP-10 = 検証用Working Directory fixtureはCheckpoint (GUI Map) のpreconditionとして定義する。Bundle条件にしない
```

### 解決済み: UI Map設計とUI Markerの工程順序 (設計変更, Issue #101 / Owner決定)

```text
UI Map (GUI Map)
  = 設計工程で、対応する開発ロードマップ作成より前に作る (README.md GUI Verification Cycle step 1 -> 2)
  = Checkpoint / 操作 / 期待結果 / UI識別契約 (検証仕様)
  != 実装完了後に初めて設計するもの
  != Bundleのimplemented条件

UI Marker (data-pae-marker / data-pae-item)
  = 実装時に当該Surfaceを実装するBundleがPAE-owned UI codeへ付与する (Editor UI.md §19)
  = UI Mapの識別契約を満たす。Bundleの契約テストで検証しevidenceへ記録する

GUI Debug Tool実行
  = 実装後 (step 4)。結果はdiagnostics.gui_debugのみ。Bundleの追加 / reopenを自動で行わない
```

### 解決済み: diagnostics recordのstate語彙と対応Bundle参照 (設計変更, Issue #101 / Owner決定)

```text
state語彙            = open / planned / wontfix / resolved (§12 State)
対応Bundle id        = resolution.bundle_ids (§12 Record / State)
state・resolution更新 = Owner承認のdesign_change PRのみ。GUI Debug Toolは生成と観測情報更新のみ
```

---

## 17. Checkpoint Coverage

開発Bundleの完了条件から分離したGUI実機確認を、GUI MapのCheckpoint責務として整理する。

```text
coverage
  = 必要なCheckpointの一覧 (設計上の受け皿)
  != 作成済みGUI Map
  != 検証済み
```

```yaml
gui_map_directory: "tools/primitive-app-editor/gui-debugger/maps/"
gui_map_directory_state: "未作成 (tooling.gui-debugger not started)"
```

現時点で作成済みのGUI Mapは存在しない。下表の全Checkpointは未作成であり、検証済みとして扱わない。

```yaml
checkpoints:
  - id: "cp.workbench.project-open"
    state: "not created"
    origin: "workbench.integration remaining (desktop Workbenchで Project: Ready に到達することの確認)"
    bundles: ["workbench.integration", "workbench.project-bridge"]
    condition_candidate:
      - { bundle: "workbench.integration", status: ["implemented"] }
      - { bundle: "workbench.project-bridge", status: ["implemented"] }
    observation: "検証用Working Directory fixtureを開いたWorkbenchのStatus Barが Ready を表示する"
    locator_candidate: "status: status.primitiveAppEditor.project (workbench.integration evidence)"
    to_verify:
      - "Status Bar表示文字列 / locale (§8 / GD-GAP-09)"
      - "検証用Working Directory fixtureと開き方 (GD-GAP-10)"
    created_by: "tooling.gui-debugger (実装時点でrunnableなCheckpointのGUI Map, §15)"

  - id: "cp.workbench.views (仮)"
    state: "not created"
    origin: "workbench.views (Activity Bar / Primary Side Bar / Editor Tabs / Bottom Panel のGUI配置)"
    bundles: ["workbench.views"]
    locator_candidate: "未定 (GD-GAP-01: view / marker識別子はworkbench.views実装時に確定)"
    created_by: "UI Map設計工程 (README.md GUI Verification Cycle step 1。未作成)"

  - id: "cp.registry.duplicate-name-table"
    state: "not created"
    origin: "§9 GUI Map YAMLの記述例 (未実装UI想定。Marker値は実装時に確定)"
    bundles: ["workbench.views", "editor.inspector"]
    created_by: "UI Map設計工程 (README.md GUI Verification Cycle step 1。未作成)"

  - id: "cp.editor.surfaces (仮)"
    state: "not created"
    origin: "editor.function-graph / editor.debug-viewer / renderer.runtime のWorkbench Surface"
    bundles: ["workbench.views", "editor.function-graph", "editor.debug-viewer"]
    locator_candidate: "未定 (GD-GAP-08: webview / iframe探索)"
    created_by: "UI Map設計工程 (README.md GUI Verification Cycle step 1。未作成)"

  - id: "cp.build.export-configuration (仮)"
    state: "not created"
    origin: "build.deploy / build.deploy-template-registrar のBuild / Export Configuration Surface"
    bundles: ["build.deploy", "build.deploy-template-registrar"]
    created_by: "UI Map設計工程 (README.md GUI Verification Cycle step 1。未作成)"

  - id: "cp.completion.authoring-flow (仮)"
    state: "not created"
    origin: "completion.end-to-end のうちEditor GUI操作によるAuthoring Flowの観測"
    bundles: ["completion.end-to-end"]
    created_by: "UI Map設計工程 (README.md GUI Verification Cycle step 1。未作成)"
```

`(仮)`のidは責務の受け皿を示す仮名であり、GUI Map作成時に§7 / §9に従って確定する。

### completion.end-to-endとの責務境界

```text
completion.end-to-end (開発Bundle)
  = Authoring -> Runtime -> Renderer -> Build -> Application Outputの自動E2E
  = Deploy Configuration.md §7.2 E2E (生成Applicationの独立環境起動 / API / DB / UI結果)
  = 実行経路: Service / API / CLI / Test Harness (GUI Debug Toolを使用しない)
  = 完了条件: 自動テスト + CI + evidence

GUI検証 (gui_verification)
  = Editor Workbench GUI上の操作 / 表示の検証
  = cp.completion.authoring-flow 等のCheckpoint
  = 結果: diagnostics.gui_debug
```

```text
completion.end-to-end
  -X-> implemented条件: GUI Debug ToolのCheckpoint結果
  -X-> depends_on: tooling.gui-debugger
```

### 解決済み: §16 Open Issues の更新とevidence内Issue参照の扱い (設計変更, Issue #110 / Owner委任の自律判断)

```text
§16 Open Issues
  = §6 Unverified全項目 → 実機でのみ観測できる項目に限定 (残りはstand-in契約testで検証済み)
  = 検証用Working Directory fixture → 定義場所はGD-GAP-10で決定済み、具体fixtureのみ未決

evidence内の「Issue #108」参照
  = evidenceは進捗記録であり設計変更PRでは変更しない (status / evidence / remaining不変の契約)
  = #108はクローズ後も履歴参照として許容する。解決内容は本書「解決済み: §15 verificationとGUI実機検証の分離」を正とする
  != roadmap.yaml tooling.gui-debugger evidenceの書換え
```
