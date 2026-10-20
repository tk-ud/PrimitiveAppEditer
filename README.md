# Primitive App Editor

```yaml
project:
  name: Primitive App Editor
  type: Production Environment
  purpose:
    - Application Production
    - Game Production
  model: Registry Driven
  workbench: Code OSS
```

## Overview

Primitive App Editorの目的と全体像。

```yaml
Primitive App Editor:
  role: Application / Gameを構築するProduction Environment

  provides:
    - Registry
    - Data
    - Function
    - Renderer
    - Asset
    - Runtime
    - Debug
    - Build

  principle:
    - Application固有Editorを増殖させない
    - RegistryからUI / Operationを解決する
    - Code OSSをWorkbenchとして利用する
```

## Architecture

システム全体の構成とAuthority。

```yaml
Code OSS:
  role: Workbench
  provides:
    - File Editing
    - Editor Tabs
    - Side Bar
    - Panel
    - Extension Host

Primitive App Editor:
  Registry:
    role: Schema Authority

  SQLite:
    role: Structured Authoring Storage

  Function:
    role: Processing / Composition

  Renderer:
    role: Projection

  Runtime:
    role: Execution

  Build:
    role: Derived Output
```

詳細: `docs/primitive-app-editor/App Editer.md`

## Documentation

設計資料の解像度と役割。

```yaml
abstract:
  docs/primitive-app-editor/App Editer.md:
    purpose: 全体把握
    defines:
      - Architecture
      - Authority
      - Boundary

concrete:
  docs/primitive-app-editor/Editor UI.md:
    purpose: Editor UIの個別把握
    defines:
      - Placement
      - Interaction
      - Editing Responsibility

  docs/primitive-app-editor/Function Graph.md:
    purpose: Function Graphの個別把握
    defines:
      - Node / Edge
      - Dependency
      - Graph Operation

  docs/primitive-app-editor/Resolver.md:
    purpose: Resolverの個別把握
    defines:
      - Request Resolution
      - Operation Dispatch

implementation:
  docs/primitive-app-editor/roadmap.yaml:
    purpose: 実装管理
    defines:
      - Bundle
      - Dependency
      - Progress
      - Specification Reference

  docs/primitive-app-editor/Agent tool.md:
    purpose: 実装AgentへのSpecification供給
    authority: roadmap Agent Tool仕様SSOT
    defines:
      - Bundle Selection
      - Specification Extraction
      - Evidence Update

  docs/primitive-app-editor/GUI Debug Tool.md:
    purpose: Roadmap Driven GUI Debug Toolの個別把握
    authority: GUI Debug Tool仕様SSOT
    defines:
      - Checkpoint
      - UI Marker Resolution
      - GUI Map YAML
      - Roadmap Diagnostics

  docs/primitive-app-editor/Deploy Configuration.md:
    purpose: Deploy構成の個別把握
    authority: Deploy Configuration仕様SSOT
    defines:
      - Deploy Template / Selection
      - Docker Projection
      - Deploy Validation
      - Deploy E2E
```

## Development Model

監査と実装の責務分離。

```yaml
Auditor:
  context: Global
  reads:
    - Abstract Specification
    - Concrete Specifications
    - Roadmap
  responsibility:
    - 全体整合監査
    - Authority監査
    - Boundary監査
    - Bundle Scope監査

Implementation Agent:
  context: Local
  reads:
    - Toolから供給されたTarget Specificationのみ
  responsibility:
    - Selected Bundleの実装
    - Boundaryの遵守
    - Evidenceの生成
```

## Progress Management

進捗の管理先。

```yaml
progress:
  authority: docs/primitive-app-editor/roadmap.yaml
  rule:
    - 進捗(status / evidence / remaining)はroadmap.yamlのみで管理する
    - READMEは進捗Statusを持たない
    - 重複する進捗表示は削除する
```

## Operational Hooks

開発Agentの運用を補助する`.claude/hooks/`のフック。Code OSS本体・roadmap.yaml・Toolは変更しない。

```yaml
operational_hooks:
  require_pr_subscription:
    file: .claude/hooks/require-pr-subscription.py
    purpose: PR作成後にsubscribe_pr_activityを呼ばずに終了しない
    rule:
      - 対応するtool_resultが成功したcreate_pull_requestのみpending扱いにする
      - 失敗したcreate_pull_requestはpending扱いにしない
      - stdinのJSON解析に失敗した場合は何も出力せず正常終了する(フェイルオープン)
    verification:
      - 合成トランスクリプトで成功/失敗/購読済み/不正入力の各ケースの出力を確認し、結果をevidenceに記録する
```

## Specification Model

実装Agentへ供給するSpecificationのscope分類。

```yaml
reference:
  implementation:
    meaning: 対象Bundle自身が実装する仕様

  boundary:
    meaning: 実装対象ではないが違反してはいけない制約
```

## Implementation Flow

Bundle単位で実装を進めるAgent loop。

```yaml
flow:
  - roadmap.read
  - bundle.select
  - specification.extract
  - agent.implement
  - evidence.collect
  - roadmap.update
  - next
```

```text
roadmap
   ↓
Target Bundle
   ↓
Agent Tool
   ↓
Target Specification
   ↓
Implementation
   ↓
Evidence
   ↓
roadmap update
   ↺
```

## Tool First

実装Agentは原則としてroadmap Agent Tool経由で実装loopを進める。

```yaml
policy:
  implementation_agent:
    bundle_selection: roadmap.next
    specification_extraction: roadmap.next
    progress_update: roadmap.complete
  prohibited:
    - roadmap.yamlの直接編集によるstatus / evidence / remaining更新
    - Toolが供給しないSpecificationからの要件推定

authority:
  development_policy: README.md (Tool First)
  tool_specification: docs/primitive-app-editor/Agent tool.md
  tool_implementation_progress: docs/primitive-app-editor/roadmap.yaml (tooling.roadmap-agent)

bootstrap:
  bundle: tooling.roadmap-agent
  rule:
    - 全後続Bundleはdepends_onによりtooling.roadmap-agentのimplemented後に選択可能となる
    - tooling.roadmap-agent自身はTool未実装のため、Agent tool.mdのroadmap.next sequenceに従い手動でSpecificationを取得する
    - 完了更新は実装したroadmap.completeで行い、Tool検証のEvidenceとする
```

## GUI Debug

Roadmap Driven GUI Debug Toolによる開発時GUI検証の責務分離。

```yaml
GUI Debug Tool:
  role: 手動GUIデバッグを置き換える開発用GUI自動検証Tool
  runtime: Python独立GUI Application (Code OSS統合ターミナルから起動)
  reads:
    - roadmap.yaml Bundle status (read-only)
    - GUI Map YAML
  writes:
    - roadmap.yaml diagnostics.gui_debug
  depends_at_runtime:
    prohibited:
      - AI
      - roadmap Agent Tool

development:
  tool / GUI Map / UI Marker: Development Agent (GPT / Claude), Tool Firstに従う
  execution / diagnostics: GUI Debug Tool

separation:
  progress_update: roadmap.complete (status / evidence / remaining)
  diagnostics_append: GUI Debug Tool (diagnostics.gui_debug)

authority:
  tool_specification: docs/primitive-app-editor/GUI Debug Tool.md
  ui_marker_regulation: docs/primitive-app-editor/Editor UI.md (§19 UI Marker Regulation)
  tool_implementation_progress: docs/primitive-app-editor/roadmap.yaml (tooling.gui-debugger)
  development_verification_cycle: README.md (GUI Verification Cycle)
```

## GUI Verification Cycle

開発ロードマップとGUI検証の責務分離 (Owner決定)。開発Bundleの完了とGUI検証の完了を分離し、GUI検証結果と人間の品質テスト結果はOwner判断を経て開発ロードマップへ還元する。

```yaml
cycle:
  - step: 1
    phase: ui_map_design
    action: UI Map (GUI Map) を設計で作る。Checkpoint / 操作 / 期待結果 / UI識別契約 (検証仕様) を定義する
  - step: 2
    phase: roadmap_design
    action: UI Mapに対応した開発ロードマップを作る (Bundle / 依存 / 検証条件)
  - step: 3
    phase: development
    action: ロードマップの実装を完了させる (Tool First。roadmap.next / roadmap.complete、単体・統合・契約テスト / CI / evidence)
  - step: 4
    phase: gui_verification
    action: UI Mapを用いたGUI Debug Toolで自動検証する (Regression Run)。結果はroadmap.yaml diagnostics.gui_debugへ記録する (GUI Debug Toolのみが書込)
  - step: 5
    phase: owner_triage
    action: GUIデバッグで検出された不具合を分析し、Owner判断のdesign_changeで修正Bundleをroadmapに追記する
  - step: 6
    phase: human_quality_test
    action: 人間が品質テストする (UX・実利用の品質確認)
  - step: 7
    phase: owner_triage
    action: 品質テストで発見した不具合を分析し、Owner判断のdesign_changeで修正Bundleをroadmapに追記する
  loop: 5 / 7で修正Bundleを追加した場合は3の実装工程へ戻り、必要な自動GUI検証 (4) と人間の品質テスト (6) を繰り返す。不具合がない場合は次の工程へ進む
```

```text
ui_map_design (UI Map設計)
    |
    v
roadmap_design (UI Mapに対応した開発ロードマップ)
    |
    v
development (roadmap.next / roadmap.complete)  <---------+
    |                                                      |
    v                                                      |
gui_verification (GUI Debug Tool / UI Map) -> diagnostics.gui_debug
    |                                                      |
    v                                                      |
owner_triage (5) -- design_change: 修正Bundle追加 ---------+
    |                                                      |
    v                                                      |
human_quality_test (6)                                     |
    |                                                      |
    v                                                      |
owner_triage (7) -- design_change: 修正Bundle追加 ---------+
```

```yaml
ui_map_and_marker:
  ui_map: 設計工程 (step 1) で、roadmap作成 (step 2) より前に作る検証仕様。実装完了後に初めて設計しない
  ui_marker: 実装時に当該Surfaceを実装するBundleがPAE-owned UI codeへ付与する識別子 (Editor UI.md §19)。UI Mapの識別契約を満たす
  execution: GUI Debug Toolの実行は実装後 (step 4)。UI Mapの設計 / MarkerをBundleのimplemented条件にGUI実機結果として混ぜない
```

```yaml
completion:
  bundle_implemented:
    authority: roadmap.complete (Agent tool.md)
    requires:
      - Bundle referenceが定義する契約の実装
      - 単体テスト / 統合テスト / 契約テスト
      - CI
      - evidence
    excludes:
      - GUI Debug ToolによるCheckpoint実行 / Checkpoint結果
      - 起動中Workbenchに対するGUI実機確認 (目視確認を含む)

  gui_verification:
    unit: Checkpoint (GUI Map YAML, GUI Debug Tool.md §7 / §9)
    record: roadmap.yaml diagnostics.gui_debug
    does_not_update:
      - Bundle status / evidence / remaining
      - depends_on

rules:
  - GUI検証の未実施 / 未作成Checkpoint / not_applicableは、Bundleをpartialに留める理由にしない
  - GUI実機での観測を要する確認がBundleの契約に含まれる場合、同じ契約を自動テスト (単体 / 統合 / 契約テスト) で検証してevidenceへ記録し、GUI上の観測は設計工程で作成したUI MapのCheckpointへ委ねる
  - 開発Agentはremainingに含まれるGUI実機確認を前項で扱い、進捗はroadmap.completeで記録する (開発Agentはroadmap.yamlを直接編集しない)
  - GUI実機確認を完了条件として含む既存remainingの文言修正は、Owner判断の設計変更PR (design_change) でのみ行い、status / evidence / depends_onは変更しない
  - 進捗更新 (実装結果の記録) と設計定義変更 (design_change PRによるremainingの契約・検証条件文言の修正 / Bundle追加) は区別する。前者はroadmap.completeのみ、後者はdesign_change PRのみが行い、適用境界はAgent tool.md rulesを正とする
  - depends_onは実装上の依存関係のみを表し、GUI MapのCheckpoint conditionを依存条件に流用しない
  - 既存roadmap / UI Map未作成の移行時も、過去のimplementedを偽装・巻き戻さない。UI Mapは設計工程で追加し、既存status / evidence / depends_onは変更しない
  - GUI Debug Toolはtooling.gui-debugger implemented後に実行でき、Bundle完了を待つ実行条件はCheckpoint condition (GUI Map) のみが定義する
  - GUI検証 / 品質テスト結果からの修正Bundle追加 / 既存Bundleのreopenは、Owner判断を必須とする。GUI Debug Tool / 開発Agentは自動で追加・reopenしない (進捗更新=roadmap.complete、設計定義変更=design_change PRの境界に従う)
  - 未実施 / not_applicable / precondition_failed / connection_errorを検証成功として記録しない
  - 対応するGUI Mapが存在しないCheckpointは未作成として扱い、検証済みとして扱わない

authority:
  development_policy: README.md (GUI Verification Cycle)
  gui_verification_specification: docs/primitive-app-editor/GUI Debug Tool.md
  progress: docs/primitive-app-editor/roadmap.yaml (section[].bundle[])
  gui_diagnostics: docs/primitive-app-editor/roadmap.yaml (diagnostics.gui_debug)
```

## Repository / Upstream

Code OSSとPrimitive App Editor固有実装の系譜管理。

```yaml
upstream:
  project: Code OSS
  role: Workbench Baseline

repository:
  baseline:
    source: Code OSS
    revision: 2be8d96dfdb

  modifications:
    authority: Primitive App Editor
    implementation: roadmap driven
```
