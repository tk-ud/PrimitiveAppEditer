# Editor UI Regulation

## 1. Scope

This document defines the interaction, placement, and editing rules of the App Editor UI.

```text
App Editer.md
  = Architecture / Authority / Boundary

Editor UI.md
  = Interaction / Placement / Editing Regulation
```

The UI must not become a second application authority.

```text
Registry / Raw Data / Binding
  = Authoring Authority

Editor UI
  = Selection / Presentation / Mutation Interface
```

---

## 2. Core Interaction Model

The primary authoring flow is based on selection and explicit persistence.

```text
Select
  -> Inspect
  -> Save or Delete
```

For existing editable values:

```text
Select
  -> Component
  -> Edit
  -> Save
```

Primary UI actions should remain small, explicit, and deterministic.

---

## 3. Workbench Placement

The App Editor uses the existing VS Code / Code - OSS workbench regions rather than introducing a separate desktop layout model.

```text
Main Window
├─ Activity Bar
├─ Primary Side Bar
├─ Editor Area
├─ Secondary Side Bar
├─ Bottom Panel
└─ Status Bar
```

Default placement:

```text
Activity Bar
  = Top-level App Editor navigation

Primary Side Bar
  = Tree / List / Registry / Data / Asset / Function navigation

Editor Area
  = Code Editor / Data Grid / Function Graph / Renderer Editor /
    Asset Editor / Component Editor / Debug Viewer

Secondary Side Bar
  = Registry Driven Inspector

Bottom Panel
  = Console / Build Log / Runtime State / Event Log /
    Function Output / Diagnostics

Status Bar
  = Project / Runtime / Build status
```

The placement follows the responsibility of each surface.

```text
Navigate / Select
  -> Primary Side Bar

Inspect / Compose
  -> Secondary Side Bar

Edit structure or detailed content
  -> Editor Area

Observe logs and diagnostics
  -> Bottom Panel
```

The Registry Driven Inspector should remain visible beside the active Editor Area when space permits and should use the workbench's normal resize / collapse behavior.

The UI should reuse existing workbench interaction conventions where no App Editor-specific behavior is required.

---

## 4. Registry Driven Inspector

There is one Inspector concept.

```text
Registry Driven Inspector
  = Inspector
```

`Binding Inspector` is not a separate UI surface or second Inspector implementation.

Binding authoring is one responsibility of the Registry Driven Inspector.

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

The Inspector is the primary composition surface for the selected object.

```text
Inspector
  = Selection / Binding / Property Presentation / Navigation

Registry
  = Definition Authority

Binding
  = Concrete Composition Data
```

The Inspector must resolve UUID identities to human-readable names or labels for display.

```text
Storage
  = UUID

Primary UI
  = name / label
```

UUID values are not primary human-facing controls.

### Empty Selection

When there is no valid selection, the Inspector shows an empty or neutral state and must not infer a target from stale UI state.

```text
No Selection
  -> No Mutation Target
```

---

## 5. Binding Section

Binding creation and removal are performed inside the Registry Driven Inspector.

The Binding Section follows the basic interaction model:

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

Binding authoring responsibility is primarily:

```text
SELECT
INSERT
DELETE
```

Examples include:

```text
Function Binding
Renderer Binding
Relation Binding
Data Binding
```

The exact available binding kinds are determined by the Registry and existing application definition.

Binding controls must not duplicate the Registry Driven Inspector as a separate panel, tab, or inspector instance.

---

## 6. Component Editing Regulation

Detailed values are edited by the component corresponding to the selected definition or binding kind.

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

Component responsibility is primarily:

```text
SELECT
UPDATE
```

Examples:

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

Small scalar properties may be edited directly by Registry-driven components inside the Inspector.

Detailed, structural, graph, grid, code, canvas, or otherwise space-intensive editing opens in the Editor Area.

```text
Inspector
  = Compact property / binding editing

Editor Area
  = Detailed or structural component editing
```

Component-specific values must not be duplicated as hardcoded table-specific forms when Registry-driven dispatch can represent them.

---

## 7. Inspector Layout

The Registry Driven Inspector uses a conventional vertical inspector layout.

```text
Inspector
├─ Header
│  ├─ Selection Label
│  └─ Context Actions
├─ Property Sections
├─ Binding Sections
└─ Open / Navigation Actions
```

Sections may be collapsible when their content is non-trivial.

The selected object's human-readable name or label is shown in the header. Machine UUID is not the primary header value.

The Inspector should avoid horizontal layouts that require wide fixed panels for ordinary property editing.

---

## 8. Icon Button Regulation

Inspector actions use icon buttons by default.

Typical actions include:

```text
Select / Add
Save
Delete
Open / Navigate
```

Text buttons are not the default Inspector action control when a stable icon can represent the operation.

Each icon button must provide a human-readable meaning through tooltip or equivalent accessible labeling.

```text
Icon
  +
Tooltip / Accessible Label
```

The visual icon is not the semantic authority of the action; the command bound to the control is.

Context actions should be placed near the section or item they operate on rather than collected into an unrelated global toolbar.

Destructive actions must remain visually and spatially distinguishable from ordinary selection and save actions using the existing workbench / component conventions.

---

## 9. Primary Side Bar Regulation

The Primary Side Bar is used for discovery, navigation, and selection.

Expected views include:

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

Tree and list entries establish Selection Context for the Registry Driven Inspector and may open corresponding Editor Area content.

```text
Tree / List Select
       |
       +--> Registry Driven Inspector update
       |
       +--> Optional Editor Area open
```

The Side Bar must not become a second detailed property editor.

---

## 10. Editor Area Regulation

The Editor Area is used for content that benefits from width, persistent tabs, direct manipulation, or structural visualization.

```text
Code Editor
Data Grid
Function Graph
Renderer Editor
Asset Editor
Component Editor
Debug Viewer
```

Opening detailed content should reuse an existing matching editor tab when practical rather than creating duplicate tabs for the same target without reason.

Selection inside an Editor Area surface updates the same Registry Driven Inspector used by Side Bar selection.

```text
Side Bar Selection
        \
         +--> Shared Selection Context --> Registry Driven Inspector
        /
Editor Selection
```

---

## 11. Function Binding and Function Graph Boundary

Assigning a function to an application object is an Inspector operation performed through the Binding Section of the Registry Driven Inspector.

```text
Asset / Entity Select
        |
        v
Registry Driven Inspector
        |
        v
Function Binding Section
        |
        v
Function Select
        |
        v
Save
        |
        v
Function Binding INSERT
```

Detailed Function Binding values are edited by the corresponding Registry-driven component.

```text
Function Binding
  -> constructor
  -> execution
  -> input
  -> parameter
  -> target
  -> merge
```

Function Graph is an Editor Area surface reserved for relationships between Function Bindings.

```text
Node
  = Function Binding

Edge
  = Function Dependency / function_output
```

Graph edge creation and removal correspond to dependency persistence.

```text
Create Edge
  -> Function Dependency INSERT

Delete Edge
  -> Function Dependency DELETE
```

Function Graph should not be required for ordinary function assignment to an Asset or Entity.

Selecting a graph node or edge updates the same Registry Driven Inspector rather than opening a graph-specific Inspector implementation.

---

## 12. Renderer and Asset Binding

Renderer and Asset assignment follow the same Inspector binding interaction model.

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

Detailed renderer-specific values are edited by the corresponding component rather than by expanding the Inspector into a renderer-specific hardcoded form.

Space-intensive renderer or asset editing belongs in the Editor Area.

---

## 13. Debug Viewer and Bottom Panel

Debug Viewer is an Editor Area surface.

```text
Debug Viewer
  = Application Canvas / Preview / Direct Inspection
```

Selecting an entity in the Debug Viewer updates the shared Selection Context and therefore the same Registry Driven Inspector.

The Bottom Panel is reserved for transient diagnostic and execution output.

```text
Bottom Panel
├─ Console
├─ Build Log
├─ Runtime State
├─ Event Log
├─ Function Output
└─ Diagnostics
```

Persistent authoring controls should not be moved into the Bottom Panel merely because runtime information is displayed there.

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
  = Structural or Space-intensive Editing

Runtime Viewer
  = Inspection / Preview

Bottom Panel
  = Logs / Diagnostics / Transient Runtime Output
```

The UI must preserve the existing authority model.

```text
UI
  -X-> redefine Registry

UI
  -X-> become Runtime Authority

UI
  -X-> infer persistent identity from display label
```

---

## 15. General Workbench Rules

When a behavior is not App Editor-specific, use the normal conventions of the VS Code / Code - OSS workbench and the selected UI component library rather than inventing a parallel interaction model.

This applies to ordinary behavior such as:

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

App Editor-specific rules take precedence only where this document or `App Editer.md` defines a distinct contract.

---

## 16. Non-Goals

```text
Multiple competing Inspector implementations

Binding Inspector as a separate UI surface from Registry Driven Inspector

Inspector as a universal hardcoded form

Table-specific UI model proliferation

Side Bar as a detailed property editor

Bottom Panel as persistent authoring UI

Graph editor required for simple binding assignment

UUID as primary human-facing UI

Implicit application semantics encoded only in icon choice

Reimplementation of standard workbench behavior without an App Editor-specific need
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

Function Assignment
  = Registry Driven Inspector

Function Dependency
  = Function Graph

Shared Selection Context
  = Side Bar / Editor Area / Debug Viewer -> same Inspector
```
