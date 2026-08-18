# Function Graph

## 1. Scope

Function Graphは、`function_binding`と`function_dependency`を可視化し、Function Binding間のDependencyを編集するEditor Front UIとする。

```text
function_registry
  = Function Definition

function_binding
  = Function Instance / Parameter / Target Binding

function_dependency
  = Function間Dependency

Function Graph
  = Binding Visualization / Dependency Authoring UI
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

Function Graph上にNodeを表示すること自体を、新規`function_binding`生成のAuthorityとしない。

```text
Function Binding Create / Assignment
  = Registry Driven Inspector

Graph Node
  = Existing Function Binding Presentation
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

Function GraphはParameterを表示してよいが、詳細値編集の主責務を持たない。

```text
Graph Node Select
   |
   v
Shared Selection Context
   |
   v
Registry Driven Inspector / Registry-driven Component
   |
   v
Edit Parameter
   |
   v
Save
   |
   v
UPDATE function_binding
```

```text
Function Graph
  = Parameter Presentation / Selection

Registry Driven Inspector / Component
  = Parameter Editing / UPDATE
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

Function Graphが直接Persistent Mutationを担当する対象はFunction Dependencyとする。

```text
Edge Add
  -> INSERT function_dependency

Edge Delete
  -> DELETE function_dependency
```

Function Bindingの生成・削除・詳細値変更はRegistry Driven Inspector / Registry-driven Componentの責務とする。

```text
Function Binding Add
  -> Registry Driven Inspector
  -> INSERT function_binding

Function Binding Delete
  -> Registry Driven Inspector
  -> DELETE function_binding

Function Parameter Save
  -> Registry-driven Component
  -> UPDATE function_binding
```

Graph上のMutationはDB Definitionへ明示的に保存する。

```text
Graph Interaction
      |
      v
Dependency Mutation Request
      |
      v
Resolve / Dispatch
      |
      v
SQLite
```

---

## 10. Asset / Entity Binding Boundary

Asset / EntityにFunctionを割り当てる操作はFunction Graphの責務としない。

```text
Asset / Entity Selection
        |
        v
Registry Driven Inspector
        |
        v
Function Selection
        |
        v
Save
        |
        v
INSERT Function Binding
```

Function Graphは、作成済みFunction Binding間の構成とDependencyを表示・編集する。

```text
Registry Driven Inspector
  = Asset / Entity <-> Function Binding

Function Graph
  = Function Binding <-> Function Binding Dependency
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

Function GraphはDependencyの明示的MutationをPersistent Definitionへ反映する。

```text
Read Graph
  = SELECT

Create Edge
  = INSERT function_dependency

Remove Edge
  = DELETE function_dependency
```

Bindingの作成・削除・Parameter UPDATEはInspector / Component側のSave Modelに従う。

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
  = Binding Visualization / Dependency Authoring UI

Registry Driven Inspector
  = Binding Create / Delete / Selected Binding Detail / Asset Function Assignment

Registry-driven Component
  = Detailed Binding Value / Parameter UPDATE

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

Graph Node
  -X-> 表示操作だけでfunction_bindingを暗黙生成

Graph Edge
  -X-> function_dependencyとは別のDependency Authorityを保持

Function Graph
  -X-> Asset / Entity Binding専用Inspectorを重複実装

Function Graph
  -X-> Parameter詳細編集の第二Authorityになる

Preview State
  -X-> Persistent Definitionとして扱う
```
