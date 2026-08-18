# Editor UI Regulation

## 1. Scope

この資料はApp Editor UIの操作、配置、編集規約を定義する。

```text
App Editer.md
  = Architecture / Authority / Boundary

Editor UI.md
  = Interaction / Placement / Editing Regulation
```

UIは第二のApplication Authorityにならない。

```text
Registry / Raw Data / Binding
  = Authoring Authority

Editor UI
  = Selection / Presentation / Mutation Interface
```

---

## 2. Core Interaction Model

主要なAuthoring Flowは選択と明示的な保存を基本とする。

```text
Select
  -> Inspect
  -> Save or Delete
```

既存値の編集は以下を基本とする。

```text
Select
  -> Component
  -> Edit
  -> Save
```

Primary UI Actionは小さく、明示的で、決定的な操作を基本とする。

---

## 3. Workbench Placement

App Editorは独自Desktop Layoutを再実装せず、VS Code / Code - OSS既存Workbench領域を利用する。

```text
Main Window
├─ Activity Bar
├─ Primary Side Bar
├─ Editor Area
├─ Secondary Side Bar
├─ Bottom Panel
└─ Status Bar
```

標準配置：

```text
Activity Bar
  = App EditorのTop-level Navigation

Primary Side Bar
  = Tree / List / Registry / Data / Asset / Function Navigation

Editor Area
  = Code Editor / Data Grid / Function Graph / Renderer Editor /
    Asset Editor / Component Editor / Debug Viewer

Secondary Side Bar
  = Registry Driven Inspector

Bottom Panel
  = Console / Build Log / Runtime State / Event Log /
    Function Output / Diagnostics

Status Bar
  = Project / Runtime / Build Status
```

各Surfaceは責務に応じて配置する。

```text
Navigate / Select
  -> Primary Side Bar

Inspect / Compose
  -> Secondary Side Bar

Edit Structure / Detailed Content
  -> Editor Area

Observe Logs / Diagnostics
  -> Bottom Panel
```

Registry Driven Inspectorは画面幅が許す場合、Active Editor Areaの右側に表示し、Workbench標準のresize / collapse挙動を利用する。

App Editor固有挙動が不要な場合は、既存Workbenchの一般的なInteraction Conventionを再利用する。

---

## 4. Registry Driven Inspector

Inspector概念は1つだけとする。

```text
Registry Driven Inspector
  = Inspector
```

`Binding Inspector`を別Surfaceまたは第二Inspector実装として作らない。

Binding AuthoringはRegistry Driven Inspectorの責務の一部とする。

```text
Selection
    |
    v
UUID Resolve
    |
    v
Registry Resolve
    |
    v
Kind / Selection Dispatch
    |
    v
Registry Driven Inspector
    |
    +--> Properties Section
    +--> Binding Section
    +--> Navigation / Open Action
```

Inspectorは選択対象の主要Composition Surfaceとする。

```text
Inspector
  = Selection / Binding / Property Presentation / Navigation

Registry
  = Definition Authority

Binding
  = Concrete Composition Data
```

InspectorはUUID Identityを人間が読める`name / label`へ解決して表示する。

```text
Storage
  = UUID

Primary UI
  = name / label
```

UUIDをPrimary Human-facing Controlとして扱わない。

### Empty Selection

有効なSelectionが存在しない場合、Inspectorはempty / neutral stateを表示し、stale UI stateからMutation Targetを推測しない。

```text
No Selection
  -> No Mutation Target
```

---

## 5. Binding Section

Bindingの作成と削除はRegistry Driven Inspector内のBinding Sectionで行う。

基本操作：

```text
Select Candidate
   |
   v
Save
   |
   v
INSERT Binding
```

```text
Existing Binding
   |
   v
Delete
   |
   v
DELETE Binding
```

Binding Authoringの主要責務：

```text
SELECT
INSERT
DELETE
```

例：

```text
Function Binding
Renderer Binding
```

利用可能なBinding Kindは`App Editer.md`で定義済みのPersistent Modelから決定する。Raw DataはPhysical Table Rowとして編集し、Relationは`relation_registry`のLogical Definitionとして編集する。それらを未定義のBinding Kindとして扱わない。

Binding Controlを別Panel、別Tab、別Inspectorとして重複実装しない。

---

## 6. Component Editing Regulation

詳細値は選択されたDefinition / Binding Kindに対応するComponentで編集する。

```text
Existing Binding / Data
        |
        v
Registry Resolve
        |
        v
Kind Dispatch
        |
        v
Editor Component
        |
        v
Edit Value
        |
        v
Save
        |
        v
UPDATE
```

Componentの主要責務：

```text
SELECT
UPDATE
```

例：

```text
text
  -> text field

number
  -> number field

bool
  -> checkbox

enum
  -> select

json
  -> json editor

relation / uuid
  -> resolved select
```

小さなscalar propertyはRegistry-driven ComponentとしてInspector内で直接編集してよい。

詳細、構造、Graph、Grid、Code、Canvas等、広いSurfaceを必要とする編集はEditor Areaへ開く。

```text
Inspector
  = Compact Property / Binding Editing

Editor Area
  = Detailed / Structural Component Editing
```

Registry-driven dispatchで表現可能な値をTable固有Hardcoded Formとして重複実装しない。

---

## 7. Inspector Layout

Registry Driven Inspectorは一般的な縦型Inspector Layoutを使用する。

```text
Inspector
├─ Header
│  ├─ Selection Label
│  └─ Context Actions
├─ Property Sections
├─ Binding Sections
└─ Open / Navigation Actions
```

内容量が多いSectionはcollapse可能としてよい。

Headerには選択対象の`name / label`を表示し、Machine UUIDをPrimary Header Valueとしない。

通常のProperty Editingで固定幅の広いPanelを要求する横方向Layoutを避ける。

---

## 8. Icon Button Regulation

Inspector Actionは原則Icon Buttonを使用する。

代表的なAction：

```text
Select / Add
Save
Delete
Open / Navigate
```

安定したIconで意味を表せる操作ではText Buttonを標準としない。

各Icon ButtonはTooltipまたは同等のAccessible Labelで人間が読める意味を提供する。

```text
Icon
  +
Tooltip / Accessible Label
```

Icon自体をAction SemanticsのAuthorityとせず、ControlへBindingされたCommandをSemanticsとする。

Context Actionは無関係なGlobal Toolbarへ集約せず、操作対象のSection / Item付近へ配置する。

Destructive ActionはWorkbench / Component既存Conventionを用いて、通常のSelect / Save Actionと視覚的・空間的に区別する。

---

## 9. Primary Side Bar Regulation

Primary Side BarはDiscovery / Navigation / Selectionに使用する。

想定View：

```text
Explorer
Registry
Data
Assets
Functions
Renderer
Debug
Build
```

Tree / List EntryはRegistry Driven Inspector用Selection Contextを設定し、必要に応じて対応するEditor Area Contentを開く。

```text
Tree / List Select
       |
       +--> Registry Driven Inspector Update
       |
       +--> Optional Editor Area Open
```

Side Barを第二の詳細Property Editorにしない。

---

## 10. Editor Area Regulation

Editor Areaは、横幅、Persistent Tab、Direct Manipulation、Structural Visualizationを必要とするContentに使用する。

```text
Code Editor
Data Grid
Function Graph
Renderer Editor
Asset Editor
Component Editor
Debug Viewer
```

詳細Contentを開く際、同じTargetの対応Editor Tabが存在する場合は可能な範囲で再利用し、理由なくDuplicate Tabを増殖させない。

Editor Area内部のSelectionもSide Bar Selectionと同じRegistry Driven Inspectorを更新する。

```text
Side Bar Selection
        \
         +--> Shared Selection Context --> Registry Driven Inspector
        /
Editor Selection
```

---

## 11. Function Binding and Function Graph Boundary

新規Function Bindingの作成は、Registry Driven InspectorのBinding Sectionから行う。SelectionはAuthoring Contextであり、Asset / EntityがFunction Bindingを所有することを意味しない。

```text
Target Select
        |
        v
Registry Driven Inspector
        |
        v
Binding Section
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

保存できるのは`App Editer.md §19 Function Binding`に存在するfieldとUUID Addressのみとする。`target.address`はFunction Outputの書込先であり、Asset / EntityとFunction Bindingのowner / subject relationshipとして解釈しない。Selectionから新しい所有関係を推測せず、現行Schemaで表現できない割当は保存しない。

Binding Sectionの主要Mutationは`INSERT / DELETE`とする。既存Function Bindingのconstructor / execution / input / parameter / target / merge等の詳細値は対応するRegistry-driven Componentで編集する。

```text
Function Binding Selection
        |
        v
Registry Resolve
        |
        v
Registry-driven Component
        |
        v
Edit -> Save
        |
        v
UPDATE function_binding
```

Function GraphはEditor Areaに配置し、Function Binding間のRelationship / Dependency構造を扱う。

```text
Node
  = Function Binding

Edge
  = Function Dependency / function_output
```

Graph Edgeの作成・削除はDependency Persistenceへ対応する。

```text
Create Edge
  -> Function Dependency INSERT

Delete Edge
  -> Function Dependency DELETE
```

Function Bindingの作成・選択・詳細編集にFunction Graphを必須としない。

Graph Node / Edge Selectionも同じRegistry Driven Inspectorを更新し、Graph固有Inspectorを作らない。

---

## 12. Renderer and Asset Binding

Renderer / Asset Assignmentも同じInspector Binding Interaction Modelを使用する。

```text
Target Select
   |
   v
Registry Driven Inspector
   |
   v
Renderer / Asset Binding Section
   |
   v
Select
   |
   v
Save
```

Renderer固有の詳細値はInspectorをRenderer専用Hardcoded Formへ拡張せず、対応Componentで編集する。

広いSurfaceを必要とするRenderer / Asset EditingはEditor Areaへ配置する。

---

## 13. Debug Viewer and Bottom Panel

Debug ViewerはEditor Area Surfaceとする。

```text
Debug Viewer
  = Application Canvas / Preview / Direct Inspection
```

Debug ViewerでEntityを選択した場合もShared Selection Contextを更新し、同じRegistry Driven Inspectorへ接続する。

Bottom PanelはTransient Diagnostic / Execution Output専用とする。

```text
Bottom Panel
├─ Console
├─ Build Log
├─ Runtime State
├─ Event Log
├─ Function Output
└─ Diagnostics
```

Runtime情報が表示されるという理由だけでPersistent Authoring ControlをBottom Panelへ移さない。

---

## 14. UI Responsibility Boundary

```text
Tree / List
  = Discovery / Navigation / Selection

Registry Driven Inspector
  = Selection Inspection / Composition / Compact Property Editing

Editor Component
  = Detailed Value Editing

Graph / Grid / Canvas / Code
  = Structural / Space-intensive Editing

Runtime Viewer
  = Inspection / Preview

Bottom Panel
  = Logs / Diagnostics / Transient Runtime Output
```

UIは既存Authority Modelを維持する。

```text
UI
  -X-> Registryを再定義

UI
  -X-> Runtime Authority化

UI
  -X-> Display LabelからPersistent Identityを推測
```

---

## 15. General Workbench Rules

App Editor固有でない挙動は、独自Interaction Modelを発明せず、VS Code / Code - OSS Workbenchおよび採用UI Component Libraryの一般則を使用する。

対象例：

```text
Resize
Collapse / Expand
Focus
Keyboard Navigation
Tab Activation
Tooltip
Accessible Label
Scroll
Selection Highlight
Context Menu
```

`App Editer.md`または本資料にApp Editor固有規約が定義されている場合のみ、その規約を優先する。

---

## 16. Non-Goals

```text
複数の競合するInspector実装

Registry Driven Inspectorとは別SurfaceとしてのBinding Inspector

Universal Hardcoded FormとしてのInspector

Table固有UI Modelの増殖

詳細Property EditorとしてのSide Bar

Persistent Authoring UIとしてのBottom Panel

単純Binding Assignmentに必須となるGraph Editor

Primary Human-facing UIとしてのUUID

Icon Choiceだけに埋め込まれた暗黙Application Semantics

App Editor固有要件なしでの標準Workbench挙動の再実装
```

---

## 17. Core Definition

```text
Primary Interaction
  = Select -> Save or Delete

Inspector
  = Registry Driven Inspector

Binding Authoring
  = Registry Driven Inspector / Binding Section
  = Select / INSERT / DELETE

Component
  = Select / UPDATE

Inspector Action Control
  = Icon Button by default

Primary Side Bar
  = Discovery / Navigation / Selection

Secondary Side Bar
  = Registry Driven Inspector

Editor Area
  = Detailed / Structural Editing

Bottom Panel
  = Logs / Diagnostics / Runtime Output

Detailed Editing
  = Registry-driven Component

Function Binding Authoring
  = Registry Driven Inspector / Registry-driven Component

Function Dependency
  = Function Graph

Shared Selection Context
  = Side Bar / Editor Area / Debug Viewer -> same Inspector
```
