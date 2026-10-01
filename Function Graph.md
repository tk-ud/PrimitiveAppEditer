# Function Graph

## 1. Scope

Function Graphは、`function_binding`と`function_dependency`を可視化し、主にFunction Binding間のDependency構造を編集するEditor Front UIとする。

```text
function_registry
  = Function Definition

function_binding
  = Function Instance / Parameter / Target Binding

function_dependency
  = Function間Dependency

Function Graph
  = Binding / Dependency Structural Authoring UI
```

Function Graph自体はApplication LogicのAuthorityではない。

```text
Registry / Binding / Dependency
  = Persistent Authority

Function Graph
  = Presentation / Selection / Dependency Mutation Interface
```

---

## 2. Placement

Function GraphはWorkbenchのEditor Areaへ配置する。

```text
Primary Side Bar
  -> Function / Binding Selection

Editor Area
  -> Function Graph

Registry Driven Inspector
  -> Selected Function Bindingの詳細編集

Bottom Panel
  -> Function Output / Runtime State / Diagnostics
```

Function Graphを独立したInspectorとして実装しない。

---

## 3. Graph Model

Function GraphはDBに保存されたFunction BindingとFunction Dependencyから構成する。

```text
function_binding
       +
function_dependency
       |
       v
Function Graph
```

Graph上の基本対応は以下とする。

```text
Node
  = function_binding

Edge
  = function_dependency / function_output

Target
  = UUID Address

Merge
  = overwrite | overlay
```

Function DefinitionそのものをNodeごとに複製しない。

```text
function_registry
      |
      v
function_binding
      |
      v
Graph Node
```

---

## 4. Persistent Definition

Functionの定義、Parameter Schema、Binding、DependencyはDB側で保持する。

```text
Function Definition
Parameter Definition
Input Definition
Output Definition
Binding
Dependency
Source / Target
Execution Configuration
  = Registry / SQLite
```

例：

```text
y = ax + b

input:
  x: double

parameters:
  a: double
  b: double

output:
  double
```

Function Graphはこれらの意味論を再定義しない。

---

## 5. Front Dynamic Processing

Function Graph上の動的処理はFront側で行う。

```text
DB Load
   |
   +--> function_registry
   +--> function_binding
   +--> function_dependency
   |
   v
TypeScript
   |
   +--> Graph Model
   +--> Node Presentation
   +--> Edge Presentation
   +--> Selection
   +--> Interaction
   +--> Dynamic Dispatch
   |
   v
Function Graph
```

```text
TypeScript
  = Graph Interaction / Dynamic Processing

TypeScript
  != Function Definition Authority
```

Graph操作に必要なFunction Definition、Parameter、Binding、DependencyはDBから解決する。

---

## 6. Node

Nodeは既存の`function_binding`を表現する。

```text
Function Registry
      |
      v
Function Binding
      |
      v
Graph Node
```

Nodeは少なくとも、Functionを人間が識別できる情報とBinding状態を表示する。

```text
Node
├─ Function name / label
├─ Input
├─ Parameter
├─ Output
└─ Binding State
```

UUIDは内部Identityとして使用し、Primary UIでは`name / label`を優先する。

```text
Storage / Resolve
  = UUID

Primary UI
  = name / label
```

Function Graph上のNode追加操作は、新しい`function_binding`を生成する操作として固定しない。

```text
Node Add
  = Existing BindingをGraphへ表示 / 構造へ参加
```

Function Bindingそのものの作成はRegistry Driven InspectorのBinding Sectionを基本操作とする。

```text
Registry Driven Inspector
  -> Function Select
  -> Save
  -> INSERT function_binding
```

---

## 7. Parameter Editing Boundary

FunctionのParameter SchemaはRegistry側の定義を使用する。

Bindingされた具体Parameter値は`function_binding`側で保持する。

```text
function_registry
  -> Parameter Schema

function_binding
  -> Concrete Parameter Value
```

例：

```text
Linear

Registry:
  a: double
  b: double

Binding:
  a = 0.1
  b = 2.0
```

ParameterやTarget等の詳細値はFunction Graph自身で編集せず、Graph Node Selectionから共有Selection Contextを通してRegistry Driven Inspector / Registry-driven Componentへ渡す。

```text
Graph Node Select
       |
       v
Shared Selection Context
       |
       v
Registry Driven Inspector
       |
       v
Registry-driven Component
       |
       v
Edit / Save
       |
       v
UPDATE function_binding
```

```text
Function Graph
  = Structure / Dependency

Inspector / Component
  = Binding Detail / Parameter UPDATE
```

---

## 8. Edge

EdgeはFunction間のDependencyを表現する。

```text
Function Binding A
       |
       | function_output
       v
Function Binding B
```

Persistent Definitionは`function_dependency`へ保存する。

```text
Graph Edge Create
  -> INSERT function_dependency

Graph Edge Delete
  -> DELETE function_dependency
```

Edgeの方向はExecution Dependencyを表す。

Graph上の描画状態をRuntime Authorityとして使用しない。

---

## 9. Graph Mutation

Function GraphのPersistent Mutationは主にDependency操作へ対応する。

```text
Read Node / Edge
  -> SELECT

Edge Add
  -> INSERT function_dependency

Edge Delete
  -> DELETE function_dependency
```

Bindingの作成・削除・詳細値更新はRegistry Driven Inspector / Componentの責務を基本とする。

```text
Function Binding INSERT / DELETE
  -> Registry Driven Inspector

Function Binding UPDATE
  -> Registry-driven Component
```

Graph操作はDB Definitionへ明示的に保存する。

```text
Graph Interaction
      |
      v
Mutation Request
      |
      v
Resolve / Dispatch
      |
      v
SQLite
```

---

## 10. Selection and Function Binding Boundary

選択中のTargetをAuthoring ContextとしたFunction Bindingの作成・削除はFunction Graphの主責務としない。

```text
Target Selection
        |
        v
Registry Driven Inspector
        |
        v
Function Select / Initial Binding Definition
        |
        v
Save
        |
        v
INSERT function_binding
```

SelectionはFunction Bindingのowner / subjectを定義しない。保存は現行の`function_binding`に定義されたfieldとUUID Addressのみを使用し、`target.address`をAsset / EntityとFunction Bindingの所有関係として拡張解釈しない。

既存Function Bindingの詳細編集は、Function Binding SelectionからRegistry-driven Componentへ渡し、`UPDATE function_binding`として保存する。Binding SectionまたはFunction GraphにUPDATE責務を持たせない。

Function Graphは主に、作成されたFunction Binding間の構成とDependencyを編集する。

```text
Registry Driven Inspector
  = Binding INSERT / DELETE / Selection

Registry-driven Component
  = Binding Detail UPDATE

Function Graph
  = Function Binding <-> Function Binding
```

同一のBinding DefinitionをInspectorとGraphで別々に保持しない。

---

## 11. Selection

Function Graph上のNode選択はWorkbenchのSelection Contextへ接続する。

```text
Graph Node Select
       |
       v
function_binding.uuid
       |
       v
Shared Selection Context
       |
       v
Registry Driven Inspector
```

Inspectorは選択されたBindingをRegistryから解決し、詳細値を表示する。

Graph専用の第二Inspectorを作らない。

---

## 12. Runtime / Preview Boundary

Function GraphはAuthoring Surfaceであり、Runtime Execution Authorityではない。

```text
Function Graph
  = Authoring

Registry / Binding / Dependency
  = Persistent Definition

Execution Plan
  = Runtime Resolve

Runtime Memory
  = Execution Authority
```

Editor上でPreviewまたは動的表示を行う場合、その処理はFront側で行ってよい。

ただしPreview結果をFunction Definitionとして保存しない。

```text
Persistent Definition
      |
      v
TypeScript Dynamic Processing
      |
      v
Preview / Graph Feedback

Preview / Graph Feedback
  != Persistent Authority
```

---

## 13. Save Model

Function GraphはDependencyに対する明示的なMutationをPersistent Definitionへ反映する。

```text
Select
  -> Edit Structure
  -> Save / Delete
```

操作種別は以下を基本とする。

```text
Read Graph
  = SELECT

Create Edge
  = INSERT function_dependency

Remove Edge
  = DELETE function_dependency
```

Binding詳細値の保存はGraphではなく対応Componentから`UPDATE function_binding`として行う。

UI状態だけを変更してDB Definitionとの不整合を残さない。

---

## 14. Boundary

```text
function_registry
  = Function Definition Authority

function_binding
  = Concrete Function Composition

function_dependency
  = Execution Dependency Definition

SQLite
  = Persistent Storage

TypeScript
  = Function Graph Dynamic Processing

Function Graph
  = Dependency / Structural Authoring UI

Registry Driven Inspector
  = Selected Binding Detail / Binding INSERT DELETE

Registry-driven Component
  = Binding Detail UPDATE

Runtime
  = Execution
```

禁止：

```text
Function Graph
  -X-> Function Semanticsを独自定義

TypeScript
  -X-> Registry DefinitionをHardcode

Graph Node
  -X-> function_registryを複製してAuthority化

Graph Edge
  -X-> function_dependencyとは別のDependency Authorityを保持

Function Graph
  -X-> Target固有のBinding専用Inspectorを重複実装

Function Graph
  -X-> Parameter / Target詳細編集を独自実装

Preview State
  -X-> Persistent Definitionとして扱う
```
