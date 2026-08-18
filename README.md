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

詳細: `App Editer.md`

## Documentation

設計資料の解像度と役割。

```yaml
abstract:
  App Editer.md:
    purpose: 全体把握
    defines:
      - Architecture
      - Authority
      - Boundary

concrete:
  Editor UI.md:
    purpose: Editor UIの個別把握
    defines:
      - Placement
      - Interaction
      - Editing Responsibility

  Function Graph.md:
    purpose: Function Graphの個別把握
    defines:
      - Node / Edge
      - Dependency
      - Graph Operation

  Resolver.md:
    purpose: Resolverの個別把握
    defines:
      - Request Resolution
      - Operation Dispatch

implementation:
  roadmap.yaml:
    purpose: 実装管理
    defines:
      - Bundle
      - Dependency
      - Progress
      - Specification Reference

  Agent tool.md:
    purpose: 実装AgentへのSpecification供給
    defines:
      - Bundle Selection
      - Specification Extraction
      - Evidence Update
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

## Repository / Upstream

Code OSSとPrimitive App Editor固有実装の系譜管理。

```yaml
upstream:
  project: Code OSS
  role: Workbench Baseline

repository:
  baseline:
    source: Code OSS
    revision: <upstream commit>

  modifications:
    authority: Primitive App Editor
    implementation: roadmap driven
```

## Status

現在の開発段階。

```yaml
status:
  architecture: Defined
  concrete_specifications: Defined
  roadmap: Defined
  agent_loop: Defined
  code_oss_baseline: Pending
  implementation: Pending
```
