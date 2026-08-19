## 1. Authority

```text
Code
  = 抽象処理実装

Registry
  = 抽象Schema / Relation / Function / Renderer定義

Physical Table
  = Registry展開結果

Raw Data
  = Application固有の具象Data

Project Directory
  = Authoring保存単位

SQLite
  = Registry / Raw Data / BindingのPersistent Storage

Runtime Memory
  = 実行中State

Renderer
  = Runtime StateのProjection

Editor
  = Registry / Raw Data / Binding / Asset Authoring

Build
  = Application出力
```

```text
Definition
├─ Code
├─ Registry
├─ Relation
├─ Function Definition
└─ Renderer Definition

Persistent Authoring
├─ project.sqlite
├─ Raw Data
├─ Function Binding
├─ Renderer Binding
├─ Assets
├─ Functions
├─ Scripts
└─ Config

Transient Runtime
├─ Runtime State
├─ Function Instance
├─ Function Output
├─ Input
├─ Timer
├─ Progress
├─ Event State
└─ Frame State
```

```text
Registry
  = Abstract

Physical Table Schema
  = Registry Projection

Row
  = Concrete
```

---

## 2. Overall Structure

```text
Project Working Directory
          |
          v
     Private Editor
          |
          +-----------------------+
          |                       |
          v                       v
      Registry                 Raw Data
          |                       ^
          | expand                |
          v                       |
   Physical Tables --------------+
          |
          +-----------------------+
          |                       |
          v                       v
 Function Binding         Renderer Binding
          |                       |
          +-----------+-----------+
                      |
                      v
                    Build
                      |
                      v
              Application Output
                      |
                      v
                 Runtime Load
                      |
                      v
               In-Memory State
                      |
              +-------+-------+
              |               |
              v               v
       Function Runtime    Renderer
              |               |
              +-------+-------+
                      |
                      v
                 Application
```

```text
Game
  = Application type

Editor
  != Distribution

Runtime
  != Editor
```

---

## 3. Project Working Directory

```text
<Project>/
├─ project.sqlite
├─ functions/
├─ assets/
│  ├─ image/
│  ├─ audio/
│  ├─ font/
│  ├─ shader/
│  └─ other/
├─ scripts/
├─ config/
└─ build/
```

```text
Project
  = Working Directory

Structured Data
  = project.sqlite

Program
  = functions/
  = scripts/

Binary Asset
  = assets/

Output
  = build/
```

### Open

```text
Working Directory Select
        |
        v
Directory Scan
        |
        v
project.sqlite exists?
   |            |
  no           yes
   |            |
   v            v
Create        Open
   \            /
    +----------+
         |
         v
Editor DDL Scan
         |
         v
Schema Version Resolve
         |
         v
Migration Apply
         |
         v
Registry Load
         |
         +----------------+
         |                |
         v                v
Function Scan         Asset Scan
         |                |
         +--------+-------+
                  |
                  v
             Editor Ready
```

---

## 4. SQLite

```text
project.sqlite
├─ Editor Internal Schema
├─ Registry
├─ Physical Tables
├─ Raw Data
├─ Function Binding
├─ Function Dependency
├─ Renderer Binding
└─ Project Metadata
```

```text
SQLite
  = Authoring Storage

SQLite
  != Runtime Loop Storage
```

### Logical Namespace

SQLite Schema機能には依存しない。

```yaml
table_registry:
  schema: "items | logs"
```

```text
items
  = existence space

logs
  = time-series space

schema
  = logical namespace
  != SQLite schema
```

Physical Table名はRegistry Serviceでresolveする。

---

## 5. Editor DDL

```text
Editor Built-in DDL
  = Editor固定Schema

Registry DDL
  = Application Physical Schema
```

### Built-in DDL

```text
Editor
  |
  v
DDL Resource Scan
  |
  v
Schema Version Compare
  |
  v
Unapplied Migration
  |
  v
SQLite Transaction
  |
  v
Apply
```

例：

```text
ddl/
├─ 001_project.sql
├─ 002_registry.sql
├─ 003_function.sql
├─ 004_renderer.sql
└─ ...
```

### Registry DDL

```text
Registry Mutation
      |
      v
App Editor Registry Service
      |
      +--> UUID Complete
      |
      +--> OLD / NEW Diff
      |
      +--> Validate
      |
      +--> DDL Generate
      |
      v
SQLite Physical Schema
```

DB Triggerは使用しない。

---

## 6. Registry Service

```text
Authority
  = Registry

Mutation Executor
  = App Editor Registry Service

Physical Schema
  = Registry Projection
```

### Table

```text
INSERT
  -> CREATE TABLE

UPDATE
  -> OLD / NEW diff
  -> ALTER / Migration

DELETE
  -> DROP TABLE
  -> Logical dependency cleanup
```

### Column

```text
ADD
  -> ADD COLUMN

RENAME
  -> RENAME COLUMN

DELETE
  -> DROP COLUMN

KIND CHANGE
  -> Type migration

NOT NULL CHANGE
  -> Constraint migration
```

### Transaction

```text
BEGIN

Registry Validate
      |
      v
Registry Mutation
      |
      v
DDL Migration
      |
      v
Physical Schema Validate
      |
      v
COMMIT
```

```text
Failure
  -> ROLLBACK

Invalid existing data
  -> migration reject

Physical Schema
  -> Registryへ逆生成しない
```

---

## 7. UUID Identity

```text
UUID
  = Machine Identity

name
  = Human Identifier

label
  = Human Display
```

```text
Storage
  = UUID

Editor Display
  = name / label

Runtime
  = UUID -> Memory Address resolve
```

UUIDはEditor上で原則表示しない。

### Generate

```text
Registry INSERT
      |
      v
UUID missing?
  |       |
 yes      no
  |       |
  v       v
Generate  Keep
```

SeedでUUID手入力を要求しない。

### Rename

```text
Before

column:
  uuid: A
  name: fatigue

After

column:
  uuid: A
  name: tiredness
```

```text
uuid same
  -> rename

uuid different
  -> delete + add
```

---

## 8. table_registry

```yaml
table_registry:
  uuid: uuid
  index: int
  schema: "items | logs"
  name: text
  label: text

  columns:
    json:
      - uuid: uuid
        index: int
        name: text
        label: text
        kind: text
        not_null: bool
        writable: bool
        searchable: bool
        enum: enum_registry.uuid | null

  created_at: timestamp
```

### kind

```text
uuid
text
int
double
bool
date
timestamp
enum
json
```

### Semantic Type

```text
uuid
  -> identity / relation value

text
  -> string

int
  -> integer

double
  -> floating point

bool
  -> boolean

date
  -> date value

timestamp
  -> timestamp value

enum
  -> text value + enum_registry metadata

json
  -> structured value
```

---

## 9. Physical Table Expansion

```text
table_registry
      |
      v
Registry Service
      |
      v
Schema Validate
      |
      v
Column Validate
      |
      v
Kind Dispatch
      |
      v
DDL Generate
      |
      v
Physical Table
      |
      v
Raw Data
```

```text
Registry
   |
   | expand
   v
Physical Schema
   |
   | CRUD
   v
Raw Data
```

```text
Physical Schema
  != Authority

Registry
  = Authority
```

---

## 10. relation_registry

Relationは論理Relation。

Physical FKは生成しない。

```yaml
relation_registry:
  uuid: uuid
  index: int

  main_table: table_registry.uuid

  relations:
    json:
      - join_table: table_registry.uuid

        main_column:
          column_uuid: uuid

        join_column:
          column_uuid: uuid

        relation_type: "inner | left | right | full"

  created_at: timestamp
```

### Resolve

```text
relation_registry
        |
        v
UUID Resolve
        |
        v
Table / Column Resolve
        |
        v
App Editor Query Resolver
        |
        v
Logical JOIN
```

### Validate

```text
main_table exists
join_table exists
main_column exists
join_column exists
relation_type valid
```

```text
SQLite FK
  = none
```

---

## 11. enum_registry

```yaml
enum_registry:
  uuid: uuid
  index: int
  name: text
  label: text
  values:
    - value: text
      label: text
  group_tags: text[]
  created_at: timestamp
```

### Physical

```text
Registry kind
  = enum

Physical Value
  = text

Physical FK
  = none
```

### Usage

```text
enum_registry
├─ Editor Select
├─ Display Label
├─ Input Validation
└─ Registry Metadata
```

---

## 12. Raw Data

Raw DataはPhysical TableのRow。

```yaml
player:
  uuid: ...
  size: 1.0
  speed: 4.0
  fatigue: 0.0
  recovery: 0.0

enemy:
  uuid: ...
  hp: 50
  speed: 1.2
  size: 0.8

map:
  uuid: ...
  width: 100
  height: 20
```

```text
Registry
  = Abstract

Physical Table
  = Schema Projection

Raw Row
  = Concrete Application Data
```

---

## 13. Function

```text
Function Primitive
  = Code

Function Definition
  = Registry

Function Binding
  = Concrete Definition

Function Instance
  = Runtime Memory

Function Output
  = Runtime Memory
```

```text
Function Code
      |
      v
Function Registry
      |
      v
Function Binding
      |
      v
Build / Runtime Load
      |
      v
Execution Plan
      |
      v
Function Instance
```

Function実行値はSQLiteへ逐次保存しない。

---

## 14. function_registry

```yaml
function_registry:
  uuid: uuid
  index: int

  name: text
  label: text
  executor: text

  input:
    json:
      - name: text
        kind: text

  constructor:
    json:
      - name: text
        kind: text
        default: any

  parameters:
    json:
      - name: text
        kind: text
        default: any

  output:
    json:
      kind: text

  created_at: timestamp
```

---

## 15. Function Definition Contract

```yaml
function:
  name:
  formula:
  constructor:
  signature:
  input:
  parameters:
  output:
  implementation:
```

```text
Runtime
  -> 未定義Formulaを補完しない

Registry
  -> Codeに存在しないexecutorを許可しない
```

---

## 16. Linear

### Formula

```text
y = ax + b
```

### Constructor

```text
subtract_b: bool
```

### Runtime Formula

```text
subtract_b == false
  y = ax + b

subtract_b == true
  y = ax - b
```

### Signature

```text
Linear(subtractB)

Evaluate(a, x, b) -> double
```

### C#

```csharp
public sealed class Linear
{
    private readonly bool _subtractB;

    public Linear(bool subtractB)
    {
        _subtractB = subtractB;
    }

    public double Evaluate(double a, double x, double b)
    {
        return a * x + (_subtractB ? -b : b);
    }
}
```

### Registry

```yaml
linear:
  executor: "Linear"

  input:
    - name: x
      kind: double

  constructor:
    - name: subtract_b
      kind: bool
      default: false

  parameters:
    - name: a
      kind: double
      default: 1

    - name: b
      kind: double
      default: 0

  output:
    kind: double
```

---

## 17. Function Catalog

```text
数学系
  Linear / Sin / Exp / Logistic / Noise

State系
  Set / Add / Clamp / Toggle / Compare

Input系
  Key / Axis / Pointer / Action

Spatial系
  Move / Rotate / Scale / Distance

Event系
  Trigger / Gate / Delay / Repeat

Story系
  Dialogue / Choice / Branch / Flag

Data系
  Query / Filter / Aggregate / Snapshot
...  
```

各Primitive：

```text
Formula
Constructor
Signature
Input
Parameters
Output
Implementation
```

---

## 18. Function Dispatcher

Execution OrderはDispatcherへ持たせない。

```csharp
object Dispatch(string functionName, FunctionArguments args)
{
    return functionName switch
    {
        "linear" => ExecuteLinear(args),
        "sin"    => ExecuteSin(args),
        "exp"    => ExecuteExp(args),
        _        => throw new UnknownFunctionException(functionName)
    };
}
```

```text
Dispatcher
├─ Function Name Resolve
├─ Primitive Select
├─ Argument Dispatch
└─ Output Return
```

```text
Dispatcher
  != Execution Planner
```

---

## 19. Function Binding

Function Bindingは具象Data。

```yaml
function_binding:
  uuid: uuid
  index: int

  function:
    uuid: function_registry.uuid

  constructor:
    subtract_b: true

  execution:
    kind: "tick | event | input"

  inputs:
    x:
      source: state
      address:
        table_uuid: uuid
        row_uuid: uuid
        column_uuid: uuid

  parameters:
    a:
      source: constant
      value: 0.1

    b:
      source: state
      address:
        table_uuid: uuid
        row_uuid: uuid
        column_uuid: uuid

  target:
    address:
      table_uuid: uuid
      row_uuid: uuid
      column_uuid: uuid

    merge:
      kind: overlay
```

### Source

```text
constant
state
input
time
progress
event
function_output
```

### Human Display

Storage：

```yaml
address:
  table_uuid: ...
  row_uuid: ...
  column_uuid: ...
```

Editor：

```text
Player
└─ Fatigue
```

```text
UUID
  = resolve only

name / label
  = display
```

---

## 20. Function Dependency

```yaml
function_dependency:
  uuid: uuid

  source_binding:
    uuid: function_binding.uuid

  target_binding:
    uuid: function_binding.uuid

  target_input:
    name: text
```

### Chain

```text
Source
  |
  v
Function A
  |
  | function_output
  v
Function B
  |
  v
Target
```

```yaml
inputs:
  x:
    source: function_output
    function_binding_uuid: uuid
```

### Plan

```text
Function Binding
       +
Function Dependency
       |
       v
Dependency Graph
       |
       v
Validate
       |
       v
Execution Plan
       |
       v
Runtime Memory
```

```text
cycle detected
  -> Load / Build reject
```

### Order

```text
dependency
  = primary order

index
  = deterministic order for independent nodes
```

---

## 21. Target Merge

同一Targetへの複数Function出力はBindingで選択。

```yaml
target:
  address:
    table_uuid: uuid
    row_uuid: uuid
    column_uuid: uuid

  merge:
    kind: "overwrite | overlay"
```

### overwrite

```text
Output
  |
  v
Target Value Replace
```

```text
Execution Order
  -> deterministic
```

### overlay

```text
Base State
    |
    +----------------+
    |                |
    v                v
Output A          Output B
    |                |
    +--------+-------+
             |
             v
         Normalize
             |
             v
        Type Merge
             |
             v
        Final State
```

Numeric:

```text
final
  = base + Σ normalized_overlay
```

### Merge Dispatch

```text
double
  -> additive

vector
  -> additive

quaternion
  -> compose

bool
  -> overwrite

text
  -> overwrite
```

```text
Merge Policy
  = Binding

Merge Semantics
  = Type Dispatcher

Function
  = Value Producer
```

---

## 22. Function Runtime

### Load

```text
Function Registry
       +
Function Binding
       +
Dependency
       |
       v
Validate
       |
       v
Executor Resolve
       |
       v
Constructor Bind
       |
       v
Runtime Address Resolve
       |
       v
Execution Plan
       |
       v
Function Instance
       |
       v
Memory
```

### Execute

```text
Input / Time / Progress / Event
              |
              v
         Resolve Input
              |
              v
          Dispatcher
              |
              v
            Value
              |
              v
         Target Buffer
              |
              v
         Merge Policy
              |
              v
          Next State
```

### Loop

```text
Input Capture
      |
      v
Current State
      |
      v
Execution Plan
      |
      v
Function Execute
      |
      v
Target Merge
      |
      v
Next State
      |
      v
Renderer
```

---

## 23. Runtime Addressing

### Persistent Address

```yaml
address:
  table_uuid: uuid
  row_uuid: uuid
  column_uuid: uuid
```

### Load

```text
Persistent UUID Address
          |
          v
Registry Resolve
          |
          v
Runtime Object Resolve
          |
          v
Memory Handle
```

### Runtime

```text
Runtime Loop
  -> resolved memory handle

Runtime Loop
  != SQLite lookup
```

### Editor

```text
Stored:
  1f...
  84...
  c2...

Displayed:
  Player > Fatigue
```

---

## 24. Runtime State

```yaml
runtime:
  time:
  progress:
  input:

  entities:
    row_uuid:
      properties:

  functions:
    binding_uuid:
      instance:
      output:

  events:

  renderer:
```

```text
Project Data
    |
    | Load
    v
Runtime State
    |
    | Function
    v
Next Runtime State
    |
    v
Renderer
```

```text
Runtime Loop
  != SQLite Query

Runtime Function Output
  != SQLite Write

Frame State
  != Persistent Data
```

---

## 25. Editor UI

UIはRegistryから生成する。

```text
table_registry.columns
        |
        v
Kind Dispatch
        |
        v
Editor Component
```

### Kind Dispatch

```text
text
  -> text_field

int
  -> number_field

double
  -> number_field

bool
  -> checkbox

date
  -> datepicker

timestamp
  -> datetime_picker

enum
  -> select

json
  -> json_editor

uuid
  -> relation/select
```

```text
UUID Value
  -> human label resolve
```

table専用UI modelは原則作らない。

---

## 26. Editor

```text
Registry Editor
├─ Table
├─ Column
├─ Relation
├─ Enum
├─ Function
└─ Renderer

Data Editor
├─ Physical Table
├─ Raw Data
├─ Relation
├─ Function Binding
└─ Renderer Binding

Application Editor
├─ Entity
├─ Map
├─ Asset
├─ Input
├─ Function Graph
├─ Preview
└─ Build
```

Data Editor / Side Bar / Editor Areaは、Raw Data・Relation・Function Binding・Renderer Bindingのdiscovery / list / selectionと、Grid・Graph等の広いSurfaceを必要とするstructural / detailed viewを提供する。選択されたTargetに対するcompact property editing、binding composition、contextual mutationは単一のRegistry Driven Inspectorで行う。

```text
Data Editor / Side Bar / Editor Area
  = Discovery / List / Structural or Detailed View / Selection

Registry Driven Inspector
  = Compact Property Editing / Binding Composition / Contextual Mutation

Graph / Grid / Detailed Value
  = Editor Area when a wide surface is required
```

Data Editorの下にFunction Binding / Renderer Bindingが記載されることは、Inspectorと競合するBinding Editing Surfaceを意味しない。Inspector概念はRegistry Driven Inspectorの1つだけとする。

```text
Editor
  = Generic Authoring

Application Logic
  = Registry + Binding + Raw Data + Code Primitive

Game固有Logic
  != Editor Hardcode
```

---

## 27. Renderer

Renderer本体はCode側。

```text
Runtime State
      |
      v
Renderer
      |
      v
Projection
```

```text
Renderer Types

2D
RPG
Card
Visual Novel
UI
Audio
Particle
...
```

```text
Function
  != Renderer固有概念

Renderer
  != Function固有概念
```

---

## 28. renderer_registry

```yaml
renderer_registry:
  uuid: uuid
  index: int
  name: text
  label: text
  executor: text

  inputs:
    json:
      - name: text
        kind: text

  created_at: timestamp
```

### Binding

```yaml
renderer_binding:
  uuid: uuid

  renderer:
    uuid: renderer_registry.uuid

  bindings:
    position_x:
      address:
        table_uuid: uuid
        row_uuid: uuid
        column_uuid: uuid

    position_y:
      address:
        table_uuid: uuid
        row_uuid: uuid
        column_uuid: uuid

    scale:
      address:
        table_uuid: uuid
        row_uuid: uuid
        column_uuid: uuid

    visible:
      address:
        table_uuid: uuid
        row_uuid: uuid
        column_uuid: uuid

    asset:
      asset_uuid: uuid
```

---

## 29. Asset

```yaml
asset:
  uuid: uuid
  index: int
  name: text
  label: text
  kind: "image | sprite | audio | font | shader | other"
  source: text
  metadata: json
```

```text
<Project>/assets/
       |
       v
Directory Scan
       |
       v
Asset Resolve
       |
       v
Asset Registry
```

```text
Asset
  +
Renderer Binding
  +
Runtime State
  |
  v
Projection
```

---

## 30. Function / Program Scan

```text
<Project>/functions/
        |
        v
Directory Scan
        |
        v
Program Discovery
        |
        v
Executor Resolve
        |
        v
function_registry Validate
```

```text
Registry executor
  -> Code Primitive

Missing executor
  -> Build / Load reject
```

---

## 31. Build

```text
Working Directory
├─ project.sqlite
│  ├─ Registry
│  ├─ Physical Raw Data
│  ├─ Function Binding
│  ├─ Function Dependency
│  └─ Renderer Binding
├─ Functions
├─ Assets
├─ Scripts
└─ Config
        |
        v
      Build
        |
        v
Application Output
```

### Build Validation

```text
Registry Validate
        |
        v
Physical Schema Validate
        |
        v
Relation Validate
        |
        v
Function Executor Validate
        |
        v
Dependency Validate
        |
        v
Runtime Address Validate
        |
        v
Renderer Validate
        |
        v
Asset Validate
        |
        v
Build
```

### Application Output

BuildはAuthoring DataをApplication実行形式へProjectionする。

```text
Authoring

Project Working Directory
        |
        v
project.sqlite
├─ Registry
├─ Raw Data
├─ Relation
├─ Function Binding
├─ Function Dependency
└─ Renderer Binding
        |
        v
Build
        |
        +-----------------------------+
        |                             |
        v                             v
Application Definition         Application Program
        |                             |
        v                             v
Schema / Data / Binding        Runtime / Renderer
        |                             |
        +--------------+--------------+
                       |
                       v
              Application Output
```

```text
Authoring Authority
  != Build Package Format
```

EditorはBuild Outputへ含めない。

```text
Editor
  = excluded
```

Build Outputのserializationおよび配置形式はBuild実装の責務。

### PostgreSQL Web Application Output

PostgreSQLをRuntime Storageとして使用するApplicationでは、
`project.sqlite` 内のRegistry / Raw Data / Bindingを直接Runtime Storageとして使用しない。

Build時にRegistryからPostgreSQL Physical Schemaを生成する。

```text
【Editor / Authoring】

<Project>/
├─ project.sqlite
│  ├─ Registry
│  ├─ Raw Data
│  ├─ Relation
│  ├─ Function Binding
│  ├─ Function Dependency
│  └─ Renderer Binding
├─ functions/
├─ assets/
├─ scripts/
└─ config/
        |
        v

【Build】

App Editor Build / Registry Service
        |
        +----------------------------------+
        |                                  |
        v                                  v
PostgreSQL Projection              Application Projection
        |                                  |
        +---------------+                  +----------------+
        |               |                  |                |
        v               v                  v                v
DDL Generate       DML Generate        C# API          Next.js UI
        |               |                  |                |
        v               v                  +--------+-------+
001_init_          002_seed_                       |
postgresql.sql     data.sql                        v
                                             Application
                                                Output
```

### PostgreSQL DDL

```text
Registry
   |
   v
Registry Resolve
   |
   v
Logical Namespace Resolve
   |
   v
Table / Column Resolve
   |
   v
Kind Dispatch
   |
   v
PostgreSQL DDL Generate
   |
   v
001_init_postgresql.sql
```

DDL Output：

```text
CREATE TABLE
ALTER / Constraint
Index
Required Runtime Schema
```

Physical SchemaはRegistryのProjectionでありAuthorityではない。

```text
Registry
  = Authority

PostgreSQL Physical Schema
  = Build Projection
```

PostgreSQL Physical SchemaからRegistryを逆生成しない。

### PostgreSQL Seed Data

Application初期Dataとして必要なRaw DataはDMLへProjectionする。

```text
Raw Data
   |
   v
Build Target Filter
   |
   v
Value / Relation Resolve
   |
   v
PostgreSQL DML Generate
   |
   v
002_seed_data.sql
```

対象例：

```text
Enum
Master Data
Initial Configuration
Initial Application Data
```

Editor / Preview専用DataはApplication Seedへ含めない。

### Web Application Program

```text
Registry
+
Relation
+
Function Binding
+
Renderer Binding
+
Code Primitive
        |
        v
Application Projection
        |
        +------------------+
        |                  |
        v                  v
ASP.NET Core API       Next.js UI
        |                  |
        +--------+---------+
                 |
                 v
          Application Output
```

C# APIはPostgreSQLへ接続するRuntimeとして動作する。

```text
HTTP Request
      |
      v
Application Runtime
      |
      +----------------------+
      |                      |
      v                      v
Query / CRUD           Function Runtime
      |                      |
      +-----------+----------+
                  |
                  v
             PostgreSQL
                  |
                  v
               Result
                  |
                  v
              Renderer
                  |
                  v
              Next.js UI
```

### Deploy

```text
Application Output
├─ 001_init_postgresql.sql
├─ 002_seed_data.sql
├─ C# API
├─ Next.js UI
├─ Functions
├─ Assets
└─ Config
        |
        v
Deploy
        |
        +------------------------------+
        |                              |
        v                              v
PostgreSQL                       Application Host
        ^                              |
        |                              |
DDL / DML Apply                  C# API + Next.js
        |                              |
        +--------------+---------------+
                       |
                       v
                  Application
```

```text
project.sqlite
  = Authoring Storage

PostgreSQL
  = Deployed Application Runtime Storage
```

```text
project.sqlite
  -X-> Production Database Copy

Registry
  -> PostgreSQL Schema Projection

Required Raw Data
  -> PostgreSQL Seed Projection
```

BuildはAuthoring Authorityを変更しない。

```text
Authoring Authority
  = Working Directory
  + project.sqlite

Build Output
  = Derived Artifact
```


---

## 32. Persistence Boundary

### Authoring Persistent

```text
Working Directory
├─ project.sqlite
├─ functions/
├─ assets/
├─ scripts/
└─ config/
```

### Runtime Transient

```text
Runtime State
Function Instance
Function Output
Input
Timer
Progress
Event State
Frame State
```

### Rule

```text
Authoring Save
  = Working Directory + SQLite

Runtime State
  = Memory

Runtime State Persistence
  = explicit only

Every Frame Persistence
  = prohibited
```

### Runtime Save Data

`Runtime State Persistence = explicit only`に対応する汎用Persistent Modelを以下とする。これはApplication固有のSave Systemや新しいSnapshot Architectureではなく、既存Architecture上でApplication-definedなSave DataのcurrentとSave Eventを保持するCore Primitiveである。

`registry.current`の`registry`は抽象的な概念名ではなく、既存Registry系と同じ物理Schema名である。`registry.current`はそのRegistry schema配下のSave Data current tableとする。

```yaml
registry.current:
  uuid: uuid
  saveId: logs.savedata.uuid
  key: text
  data: json

  unique:
    - key

logs.savedata:
  uuid: uuid
  timestamptz: timestamptz
```

```text
registry.current
  = Save Dataのcurrent
  = current state store

registry.current basic mutation
  = UPSERT

registry.current mutation history
  -> logs系へ保存

logs.savedata
  = Save Event
```

`registry.current`はSave実行ごとのimmutable Snapshot rowsを蓄積するHistory Storeではない。currentのmutation historyはcurrentとは分離してlogs系へ保存する。履歴保存の責務は維持するが、このPRでは`logs.diff`、`logs.current`、`logs.history`等の具体table名やcolumn構造をCanonical Definitionとして固定しない。`logs.savedata`もSave PayloadのHistory Storeではなく、Save Eventだけを表す。

```text
registry.current
  != SaveごとのSnapshot History Store

registry.current mutation history
  -> logs系

logs.savedata
  = Save Event
  != Save Payload History Store
```

### Save Identity

```text
logs.savedata.uuid
  = Save Identity

registry.current.saveId
  -> logs.savedata.uuid
  = このcurrentが最後に更新されたSave Event Identity
  != current identity

registry.current.uuid
  = current recordのMachine Identity
  != Save Identity
  != UPSERT conflict target identity単体

registry.current.key
  = Application-defined current identity
  = stable UPSERT target

Current Identity
  = key

UNIQUE
  = key

UPSERT conflict target
  = key

(saveId, key)
  != UPSERT conflict target
```

`logs.savedata.saveId`のような第二のSave Identityは追加しない。`registry.current.saveId`とSave Eventのrelationは、1 Save Eventごとのimmutable Snapshot rowsを永久保存する規則を意味しない。

`uuid`はrow自体のMachine Identityであり、`key`は同一Save Data currentをUPSERT時に安定して識別するApplication-defined identityである。Save Eventが変わっても、同じ`key`のcurrentは同じrowとしてUPSERTし、`saveId`を最後に更新したSave Event Identityへ更新する。

```text
Before
  uuid   = X
  key    = player.hp
  saveId = Save-A
  data   = 100

After next Save
  uuid   = X
  key    = player.hp
  saveId = Save-B
  data   = 80
```

`key`の意味、命名、scopeはApplication Responsibilityであり、Coreで固定しない。Applicationは例えば`player.hp`、`player.position`、`slot1.player.hp`、`slot2.player.hp`、`aggregate.monthly_sales`等を使用できる。Save Slot等のscopeを分離する場合もApplicationが`key`へ含める。これらは用途例でありCanonical SchemaやCore-defined key taxonomyではない。

### Application Responsibility

```text
What to Save
  = Application Responsibility

What to Load
  = Application Responsibility

When to Save
  = Application Responsibility

When to Load
  = Application Responsibility

Save Scope
  = Application Responsibility

Save Payload Semantics
  = Application Responsibility

Snapshot target / granularity / timing / semantics
  = Application Responsibility
```

App Editor Coreは何を保存またはLoadすべきかを規定せず、`registry.current`という汎用Save Data current Primitiveを提供する。ApplicationがRuntime State、値、集計値、Derived Value、Snapshot、またはその他のApplication-defined payloadを明示的なSave対象とすることをCoreから禁止しない。ただし`registry.current`自体をSnapshot History Storeとして再定義せず、CoreをSnapshot Policy Authorityにしない。

```text
Editor
  = Save / Load Binding Authoring Surface
  != What-to-Save Authority
  != Save Scope Authority
  != Save Policy Authority
  != Snapshot Policy Authority
```

EditorはApplicationが定義するSave / Load OperationをAuthoringできるが、Application-specific lifecycleをCore仕様として強制しない。

### Save Payload

`registry.current.data`はApplication-defined JSON Payloadであり、CoreはApplication固有のSave SchemaやAddress Schemaを固定しない。必要であれば既存Registry等のUUID Machine IdentityをJSONから参照できる。

```json
{
  "tableId": "...",
  "columnId": "...",
  "value": 42
}
```

上記は固定Save Schemaではない。単純なpayloadなら次の形でもよい。

```json
{
  "value": 42
}
```

```text
registry.current.data
  = Application-defined JSON Payload

tableId / columnId / rowId / bindingId / tableName / functionId
  = registry.currentの必須物理columnではない
  = 必要なApplicationがdata json内で利用できる任意情報
```

Save Data Store自身に既存Registry Addressing Systemを再実装しない。

### Static / Initial Data Boundary

```text
Static / Initial Application Data
  = existing Application Data Authority

Automatic Static Data Duplication
  = prohibited

Explicit Save Target
  = Application Responsibility
```

App Editor Coreは既存のitems / raw / static rowを`registry.current`へ自動複製しない。ただしこれはStatic Dataの保存禁止やSave対象のRuntime State限定を意味しない。Applicationが選択した値をApplication-definedなSave Dataとして明示的に保存できる。

### Save / Load Operation

Persistenceは既存仕様どおりexplicit onlyとする。Save / Loadの対象、timing、payload semantics、および具体的なOperation sequenceはApplication / Runtime implementationが決定する。

```text
Application-defined value / state / payload
              ↓
         explicit Save
              ↓
registry.current UPSERT + Save Event
              ↓
         explicit Load
              ↓
Application-defined load target
```

Automatic Persistence PolicyおよびEvery Frame Persistenceは導入しない。

### Transaction / Integrity

Saveに必要なStorage Operationは、Storage側のtransactional integrityを利用できる。途中失敗時にtransaction rollback可能な構造を妨げない。

```text
Storage Operations
  -> transaction available

Failure
  -> ROLLBACK available
```

これはCanonical Save AlgorithmやSave Snapshot transaction protocolを定義するものではない。`registry.current`の基本mutationはUPSERTであり、`logs.savedata`と`registry.current`の具体的なOperation sequenceはApplication / Runtime implementationに従う。Application-level checksum modelは要求しない。

---

## 33. Runtime Authority

```text
Application Definition Authority
  = Registry
  + Raw Data
  + Binding

Physical Schema Authority
  = Registry

Function Semantics Authority
  = Function Definition
  + Code Primitive

Relation Authority
  = relation_registry

Address Identity Authority
  = UUID

Human Display Authority
  = name / label

Execution Authority
  = Runtime Execution Plan
  + Runtime Memory

Target Merge Authority
  = Function Binding Merge Policy

Projection Authority
  = Renderer Binding

Project Storage Authority
  = Working Directory
  + project.sqlite

Output Authority
  = Build
```

---

## 34. Boundary Rules

```text
Registry
  -> Physical Schema

Physical Schema
  -X-> Registry reverse generation
```

```text
Registry Mutation
  -> App Editor Registry Service
  -> SQLite DDL

Registry Mutation
  -X-> SQLite Trigger DDL
```

```text
Relation
  -> Logical JOIN

Relation
  -X-> Physical FK
```

```text
enum
  -> text + metadata

enum
  -X-> Physical FK
```

```text
UUID
  -> Machine Resolve

UUID
  -X-> Primary Human Display
```

```text
Function
  -> Value

Binding
  -> Source / Target / Merge

Execution Plan
  -> Order

Renderer
  -> Projection
```

```text
Runtime
  -> Memory

Runtime Loop
  -X-> SQLite per-frame query
```

---

## 35. Non-Goals

```text
Editor公開
Editor SaaS化

Applicationごとの専用Engine実装
Game LogicのEditorハードコード
FunctionのGimmick専用化

Physical SchemaからRegistry逆生成
Physical FKによるRelation Authority化

UUIDのEditor主表示

Function execution orderのC#ハードコード

Runtime LoopからSQLite逐次参照
Function Outputの逐次永続化
Runtime Stateの毎Frame永続化
```

---

## 36. Future

```text
Multiplayer
├─ Function Server
├─ Server Authority
├─ Network State Sync
├─ Tick Synchronization
├─ Prediction
├─ Reconciliation
└─ Rollback
```

```text
Multiplayer
  = Current Core Scope外
```

---

## 37. Core Flow

```text
Working Directory
      |
      v
Editor
      |
      +--------------------+
      |                    |
      v                    v
Registry              Files / Assets
      |
      v
App Editor Registry Service
      |
      v
SQLite Physical Schema
      |
      v
Raw Data
      |
      +-------------------------+
      |                         |
      v                         v
Function Binding        Renderer Binding
      |
      v
Dependency Graph
      |
      v
Build
      |
      v
Runtime Load
      |
      +--------------------+
      |                    |
      v                    v
UUID Resolve         Asset Resolve
      |
      v
Execution Plan
      |
      v
In-Memory State
      |
      v
Function Runtime
      |
      v
Target Merge
      |
      v
Next State
      |
      v
Renderer
      |
      v
Application
```

---

## 38. Core Definition

```text
Project
  = Working Directory

Storage
  = SQLite + Filesystem

Schema
  = Registry

Schema Expansion
  = App Editor Registry Service

Concrete Data
  = Physical Table Row

Relation
  = Logical Registry

Identity
  = UUID

Display
  = Human-readable name / label

Behavior
  = Function Primitive + Binding

Execution
  = Dependency Graph -> Execution Plan -> Memory

Composition
  = overwrite | overlay

Projection
  = Renderer

Output
  = Build

Multiplayer
  = Future
```

## 39. UI

Editor UIはVS Code系Workbenchをforkして構成する。

```text
UI Base
  = VS Code / Code - OSS Fork

App Editor
  = Built-in Editor Extension / Custom View

Editor UI
  != 独自Desktop Workbench再実装
```

### Structure

```text
Main Window
├─ Activity Bar
├─ Side Bar
├─ Editor Tabs
├─ Inspector
├─ Bottom Panel
└─ Status Bar
```

```text
Activity Bar
├─ Explorer
├─ Registry
├─ Data
├─ Assets
├─ Functions
├─ Renderer
├─ Debug
└─ Build
```

### Editor Tabs

```text
Editor Tabs
├─ Code Editor
├─ Registry Editor
├─ Data Editor
├─ Function Graph
├─ Renderer Editor
├─ Asset Editor
└─ Debug Viewer
```

```text
Code Editor
  = Working DirectoryのProgram / Script編集

Debug Viewer
  = Runtime / Canvas / Preview表示
```

例：

```text
[ Player.cs ]
[ Enemy Data ]
[ Function Graph ]
[ Map ]
[ Debug Viewer ]
```

Code EditorとDebug Viewerは別Tabとして扱う。

```text
Code Edit
    |
    v
Debug Viewer
    |
    v
Runtime Check
    |
    v
Registry / Data / Code Edit
```

### Side Bar

```text
Explorer
└─ Working Directory

Registry
├─ Table
├─ Column
├─ Relation
├─ Enum
├─ Function
└─ Renderer

Data
├─ Physical Table
└─ Raw Data

Assets
└─ Asset Tree

Functions
├─ Function Registry
├─ Function Binding
└─ Dependency Graph
```

### Inspector

Selection Contextから生成する。

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
Kind Dispatch
    |
    v
Inspector
```

```text
Selected Row
Selected Entity
Selected Function
Selected Renderer
Selected Asset
        |
        v
Registry Driven Inspector
```

表示：

```text
Enemy_001

HP        [ 50        ]
Speed     [ 1.2       ]
Visible   [ checked   ]
Type      [ Goblin  v ]
Asset     [ goblin    ]
```

保存：

```text
table_uuid
row_uuid
column_uuid
```

表示：

```text
Enemy > HP
Enemy > Speed
Enemy > Type
```

UUIDはPrimary UIへ表示しない。

### Debug Viewer

```text
Debug Viewer
├─ Application Canvas
├─ Runtime State Projection
├─ Entity Selection
├─ Direct Manipulation
├─ Camera
└─ Preview
```

```text
Runtime Memory
      |
      v
Debug Viewer
      |
      v
Human Inspection
```

Debug ViewerはAuthoring DataのAuthorityではない。

```text
Debug Viewer
  -> selection / input / preview

Registry / Raw Data / Binding
  = Authority
```

### Bottom Panel

```text
Bottom Panel
├─ Console
├─ Build Log
├─ Runtime State
├─ Event Log
├─ Function Output
└─ Diagnostics
```

### Function Graph

```text
Function Binding
       +
Function Dependency
       |
       v
Function Graph
```

```text
Node
  = Function Binding

Edge
  = Dependency / function_output

Target
  = UUID Address

Merge
  = overwrite | overlay
```

### Working Directory Integration

```text
VS Code Workspace
       |
       v
Project Working Directory
       |
       +--> project.sqlite
       +--> functions/
       +--> assets/
       +--> scripts/
       +--> config/
       +--> build/
```

```text
Open Folder
    |
    v
Project Directory Resolve
    |
    v
App Editor Initialize
    |
    v
SQLite / Registry / Asset / Function Load
```

専用Project Container Fileを必須としない。

```text
Folder
  = Project
```

### AI Development

VS Code系Extensionを利用可能なWorkbenchとする。

```text
Workbench
├─ App Editor
├─ Code Editor
├─ Git
└─ AI Coding Extension
```

```text
AI
  |
  v
Repository / Working Directory
  |
  +--> Code
  +--> Registry
  +--> Binding
  +--> Assets Reference
  +--> Build Definition
  |
  v
Debug Viewer
  |
  v
Human Review
```

AI専用のGame Authoring Protocolは必須としない。

```text
AI
  = Existing Repository / Code / Definitionを操作

App Editor
  = Human Authoring / Inspection / Debug
```

### Purpose

```text
Editor
  = Private Production Tool

Editor Output
  = Application / Game

Distribution Target
  = Build Artifact

Editor Distribution
  = Current Scope外
```

```text
Goal
  != General-purpose Game Engine販売

Goal
  = Application / Game Production Environment
```

### Boundary

```text
VS Code Fork
  = Workbench / File Editing / Tab / Panel / Extension Host

App Editor
  = Registry / Data / Function / Renderer / Debug / Build

Code OSS / App Editor
  = Node / TypeScript

Generated Application
  = C#

SQLite
  = Structured Authoring Storage
```

```text
Workbench UI
  != Application Authority

Registry
  = Schema Authority

Working Directory
  = Project Authority

Runtime Memory
  = Execution Authority

Build
  = Output
```

#### App Editor API / Application Language Boundary

App EditorはNode / TypeScript側で汎用APIを提供する。Resolver PrimitiveはApplication固有Functionではなく、App Editor API境界から利用可能な再利用可能Operationとする。

```text
App Editor API
  = Node / TypeScript
  = Generic API Provider

App Editor API
├─ create
├─ alter
├─ truncate
├─ drop
├─ insert
├─ delete
├─ update
├─ upsert
└─ select

Resolver Primitive
  = App Editor側のGeneric API
  != Application-specific Function
```

生成Application固有のFunctionとsemanticsはApplication側の責務とする。専用処理が必要な場合もApp Editor Coreに専用Resolverや専用Primitiveを追加することを前提とせず、Application側がC#で専用Functionを実装して必要なApp Editor APIを利用する。

```text
Generated Application
  = C#

Application-specific Function / Semantics
  = Application Responsibility

Application Function
       ↓
App Editor API
       ↓
Resolver Primitive
```

例えばApplication側の専用Functionは`upsert`、`update`、`insert`、`select`などを組み合わせて利用できる。具体的なFunction名やApplication semanticsはCore Specificationとして固定しない。

```text
App Editor
  = Generic API / Primitive Provider
  != Application Logic Authority

Application
  = Application-specific Function / Semantics Authority
  != Editor Internal Implementation Authority

C#
  = Application-side Logic Implementation Language
  != App Editor Backend Authority

Node API
  != Application-specific Semantics Authority
```

App Editorと生成Applicationの互換性境界は公開API Contractとする。Application側はEditor内部実装に直接依存せず、App Editor API Contractを利用する。Editor内部実装を変更する場合も、このContractを維持する限りApplicationへの影響を最小化できる構造とする。

```text
Editor Internal Implementation
          ↓
App Editor API Contract
          ↓
Generated Application

Editor Compatibility
  = App Editor API Contract Stability
```

App EditorはCode OSSをWorkbenchとして利用する既存Architectureを維持し、API ProviderはCode OSSと親和性のあるNode / TypeScript側に置く。C#は生成Application側のLogic実装言語であり、App Editor BackendのAuthorityではない。

```text
Code OSS / App Editor
  = Node / TypeScript
  = API Provider

Generated Application
  = C#
  = API Consumer
```

Node側APIとC# Application間のTransport / Invocation方式は実装選択とし、HTTP、IPC、RPC、Process Bridge、Socketその他のいずれかをCanonical Architectureとして固定しない。

```text
API Provider
  = App Editor / Node

API Consumer
  = Application / C#

API Transport / Invocation
  = Implementation Choice
```

## Dynamic Resolve

Resolverは固定のApplication固有実装をAuthorityとしない。

Registry / Binding / UI Definitionから、必要な解決規則を動的に導出する。

Resolverは導出物であり、Registry / Binding / UI Definitionが持つ意味論を重複して定義しない。

```text
Registry / Binding / UI Definition
        ↓
Dynamic Resolve
        ↓
Selection / Component / Action Mapping
```

### Resolve Principle

UIの配置先と機能を先に定義し、Resolverはその定義とRegistry / Bindingから導出する。

```text
Selection
   ↓
UUID Resolve
   ↓
Registry / Binding Resolve
   ↓
UI Definition Resolve
   ↓
Component / Action Resolve
```

```text
Resolver
  = Derived Mapping

Resolver
  != Application Authority
```

Resolverの具体的な生成方法は実装責務とする。

例：

```text
Registry / Binding / UI Definition
        ↓
Structured Definition
        ↓
Script
        ↓
Resolver / Mapping
```

Application固有のResolverを手書きで増殖させない。

### Boundary

```text
Registry / Binding / UI Definition
  = Authority

Resolver / Mapping
  = Derived

Generated Resolver
  -X-> Registry / Binding / UI Definition の意味論を再定義
```
