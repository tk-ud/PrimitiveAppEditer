# Resolver

## 1. Scope

Resolverは、入力RequestをRegistry / Binding定義に照らして解決し、対応する既存Service / Storage Operationへdispatchするための共通配線層とする。

```text
Request
  ↓
Operation Resolve
  ↓
Registry / Binding Read
  ↓
Target / Kind / Address Resolve
  ↓
Dispatch
```

Resolver自体はApplication固有の意味論をAuthorityとして保持しない。

```text
Registry / Binding / UI Definition
  = Authority

Resolver
  = Derived Dispatch / Mapping
```

---

## 2. Core Operations

Resolverの基本Operationは以下の8種類とする。

```text
Schema Operation
├─ create
├─ alter
├─ truncate
└─ drop

Data / Binding Operation
├─ insert
├─ delete
├─ update
└─ select
```

OperationごとにApplication固有関数を増殖させない。

```text
create(request)
alter(request)
truncate(request)
drop(request)
insert(request)
delete(request)
update(request)
select(request)
```

各Operationは入力Requestから対象を解決し、Registry / Binding定義を参照してdispatchする。

---

## 3. Request Model

Requestは少なくともOperationとTargetを識別できる入力を持つ。

概念例：

```yaml
request:
  operation: "create | alter | truncate | drop | insert | delete | update | select"

  target:
    kind: text
    uuid: uuid | null

  address:
    table_uuid: uuid | null
    row_uuid: uuid | null
    column_uuid: uuid | null

  payload: any
```

Requestの具体Schemaは実装側で拡張可能とする。

Resolverはdisplay labelをPersistent Identityとして使用しない。

```text
Persistent Identity
  = UUID

Human Display
  = name / label
```

---

## 4. Dispatch Flow

共通Flow：

```text
Input Request
     ↓
Operation Resolve
     ↓
Target Resolve
     ↓
Registry / Binding Read
     ↓
Validation
     ↓
Request Mapping
     ↓
Service / Storage Dispatch
     ↓
Result
```

ResolverはRegistry / Bindingに存在しない意味論を補完しない。

```text
Missing Definition
  -> reject / error

Ambiguous Target
  -> reject / error
```

---

## 5. create

`create`は新規定義または新規物理構造の生成要求をdispatchする。

```text
create(request)
   ↓
Target Kind Resolve
   ↓
Registry Definition Resolve
   ↓
Registry Service
   ↓
Create
```

Schema AuthorityをSQLite DDLへ直接移さない。

```text
create
  -> Registry Service
  -> Registry Mutation
  -> Physical Projection
```

例：

```text
Create Table
Create Registry Definition
Create Physical Projection
```

---

## 6. alter

`alter`は既存Registry Definitionの構造変更要求をdispatchする。

主な対象例：

```text
Column Add
Column Rename
Column Kind Change
Constraint Change
Table Rename
```

Flow：

```text
alter(request)
   ↓
Target Registry Resolve
   ↓
Change Definition Resolve
   ↓
Registry Service
   ↓
ALTER / Migration Projection
```

RegistryでColumnを追加した場合、Physical Schemaへの反映はRegistry Service経由で行う。

```text
Registry Column Add
      ↓
Registry Service
      ↓
ALTER Physical Table
```

Physical SchemaからRegistry Definitionを逆生成しない。

---

## 7. truncate

`truncate`は対象Data集合の全Row削除要求をdispatchする。

```text
truncate(request)
   ↓
Target Table Resolve
   ↓
Registry Validate
   ↓
Storage Operation
```

Registry Definition自体を削除しない。

```text
truncate
  = Data Removal

truncate
  != Registry Drop
```

---

## 8. drop

`drop`はRegistry上の定義削除要求をdispatchする。

```text
drop(request)
   ↓
Target Registry Resolve
   ↓
Dependency Validate
   ↓
Registry Service
   ↓
Definition Removal
   ↓
Physical Projection Removal
```

Physical Objectだけを先に削除してRegistry Authorityを残す操作を標準Flowとしない。

---

## 9. insert

`insert`は新しいData / Binding Instanceの保存要求をdispatchする。

```text
insert(request)
   ↓
Target Kind Resolve
   ↓
Registry / Binding Definition Resolve
   ↓
Payload Map
   ↓
INSERT
```

主な対象例：

```text
Raw Data Row
Function Binding
Function Dependency
Renderer Binding
Relation Definition
```

UI上のBinding Saveは基本的に`insert`へ対応する。

```text
Select Candidate
  ↓
Save
  ↓
insert(request)
```

---

## 10. delete

`delete`は既存Data / Binding Instanceの削除要求をdispatchする。

```text
delete(request)
   ↓
Target Resolve
   ↓
Registry / Binding Validate
   ↓
DELETE
```

主な対象例：

```text
Raw Data Row
Function Binding
Function Dependency
Renderer Binding
Relation Definition
```

UI上のBinding Deleteは基本的に`delete`へ対応する。

---

## 11. update

`update`は既存Data / Bindingの具体値変更要求をdispatchする。

```text
update(request)
   ↓
Target UUID / Address Resolve
   ↓
Registry / Binding Resolve
   ↓
Kind Validate
   ↓
Payload Map
   ↓
UPDATE
```

例：

```text
Function Parameter Change
Renderer Binding Value Change
Raw Data Value Change
Relation Metadata Change
```

Application固有Update関数を増殖させない。

```text
update_enemy_hp()
update_player_speed()
update_renderer_scale()
```

のような個別Resolverを標準設計としない。

```text
update(request)
```

がRegistry / Bindingから対象を解決してdispatchする。

---

## 12. select

`select`はRegistry / Binding / Raw Dataの読取要求をdispatchする。

```text
select(request)
   ↓
Target / Address Resolve
   ↓
Registry / Binding Resolve
   ↓
Query Map
   ↓
SELECT
   ↓
Result Mapping
```

Primary UIへ返す表示値は必要に応じてUUIDから`name / label`へ解決する。

```text
Storage
  = UUID

UI Result
  = Human-readable name / label
```

---

## 13. Registry Resolve

ResolverはOperation実行前に対象定義をRegistry / Bindingから解決する。

```text
request.target
      ↓
UUID / Kind Resolve
      ↓
Registry / Binding Read
      ↓
Concrete Operation Mapping
```

Resolver内にTable名・Application Entity名・Function名を固定実装しない。

```text
Hardcoded Application Mapping
  -X-> Resolver Authority
```

---

## 14. Service Dispatch

ResolverはStorage / Schema操作そのもののAuthorityではない。

```text
Resolver
  = Dispatch

Registry Service
  = Registry Mutation / Schema Projection

Storage Operation
  = Raw Data / Binding Persistence
```

Schema系Operation：

```text
create / alter / drop
  -> Registry Service
```

Data / Binding系Operation：

```text
insert / delete / update / select
  -> Registry Resolve
  -> Storage / Binding Operation
```

`truncate`はData削除OperationとしてStorage側へdispatchする。

---

## 15. Dynamic Generation

Resolver Mappingは手書きのApplication固有実装をAuthorityとせず、Structured Definitionから導出可能とする。

```text
Registry / Binding / UI Definition
        ↓
Structured Definition / YAML
        ↓
Script
        ↓
Resolver / Mapping
```

生成物はDerivedであり、Registry / Binding / UI Definitionの意味論を再定義しない。

---

## 16. Boundary

```text
Registry
  = Schema / Definition Authority

Binding
  = Concrete Composition Data

UI Definition
  = UI Placement / Interaction Definition

Resolver
  = Request Dispatch / Derived Mapping

Registry Service
  = Registry Mutation / Schema Projection

SQLite
  = Persistent Storage
```

禁止：

```text
Resolver
  -X-> Application固有SemanticsをAuthority化

Resolver
  -X-> Registry DefinitionをHardcode

Resolver
  -X-> Display LabelをPersistent Identityとして使用

Physical Schema
  -X-> Registry Authorityを逆生成

Generated Resolver
  -X-> Registry / Binding / UI Definitionを再定義
```
