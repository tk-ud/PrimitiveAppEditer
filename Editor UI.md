# Editor UI Regulation

## 1. Scope

This document defines the interaction and editing rules of the App Editor UI.

```text
App Editer.md
  = Architecture / Authority / Boundary

Editor UI.md
  = Interaction / Editing Regulation
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

## 3. Inspector Role

The Inspector is the primary binding authoring surface.

```text
Selection
   |
   v
Binding Inspector
   |
   +--> Select Binding Candidate
   +--> Save Binding
   +--> Delete Binding
   +--> Open Corresponding Component
```

The Inspector does not own application semantics.

```text
Inspector
  = Binding / Selection / Navigation

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

---

## 4. Binding CRUD Regulation

Binding creation and removal are represented as explicit persistence operations.

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

Binding Inspector responsibility is primarily:

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

---

## 5. Component Editing Regulation

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

Component-specific values must not be duplicated as hardcoded table-specific forms when Registry-driven dispatch can represent them.

---

## 6. Icon Button Regulation

Inspector actions use icon buttons by default.

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

---

## 7. Function Binding and Function Graph Boundary

Assigning a function to an application object is an Inspector operation.

```text
Asset / Entity Select
        |
        v
Binding Inspector
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

Detailed Function Binding values are edited by the corresponding component.

```text
Function Binding
  -> constructor
  -> execution
  -> input
  -> parameter
  -> target
  -> merge
```

Function Graph is reserved for relationships between Function Bindings.

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

---

## 8. Renderer and Asset Binding

Renderer and Asset assignment follow the same binding interaction model.

```text
Target Select
   |
   v
Binding Inspector
   |
   v
Renderer / Asset Select
   |
   v
Save
```

Detailed renderer-specific values are edited by the corresponding component rather than by expanding the Inspector into a renderer-specific hardcoded form.

---

## 9. UI Responsibility Boundary

```text
Tree / List / Canvas / Graph
  = Selection and Structural Visualization

Binding Inspector
  = Composition Editing

Component
  = Detailed Value Editing

Runtime Viewer
  = Inspection / Preview
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

## 10. Non-Goals

```text
Inspector as a universal hardcoded form

Table-specific UI model proliferation

Graph editor required for simple binding assignment

UUID as primary human-facing UI

Implicit application semantics encoded only in icon choice
```

---

## 11. Core Definition

```text
Primary Interaction
  = Select -> Save or Delete

Binding Inspector
  = Select / INSERT / DELETE

Component
  = Select / UPDATE

Inspector Action Control
  = Icon Button by default

Detailed Editing
  = Registry-driven Component

Function Assignment
  = Inspector

Function Dependency
  = Function Graph
```
