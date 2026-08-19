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

Resolverの基本Operationは以下の9種類とする。

```text
Schema / Registry Operation
├─ create
├─ alter
├─ truncate
└─ drop

Data / Binding Operation
├─ insert
├─ delete
├─ update
├─ upsert
└─ select
```

`truncate`は分類上Schema系Primitiveと並べるが、実処理はData集合の削除としてStorage側へdispatchする。

OperationごとにApplication固有関数を増殖させない。

```text
create(request)
alter(request)
truncate(request)
drop(request)
insert(request)
delete(request)
update(request)
upsert(request)
select(request)
```

各Operationは入力Requestから対象を解決し、Registry / Binding定義を参照してdispatchする。

---

## 3. Request Model

Requestは少なくともOperationとTargetを識別できる入力を持つ。

概念例：

```yaml
request:
  operation: "create | alter | truncate | drop | insert | delete | update | upsert | select"

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

`create`は新規Registry Definitionまたはそれに対応する新規物理構造の生成要求をdispatchする。

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

対象例：

```text
Table Registry Definition
Column Registry Definition
Relation Registry Definition
Physical Projection
```

---

## 6. alter

`alter`は既存Registry Definitionの構造・定義変更要求をdispatchする。

主な対象例：

```text
Column Add
Column Rename
Column Kind Change
Constraint Change
Table Rename
Relation Definition Change
Relation Metadata Change
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
Registry Mutation
   ↓
ALTER / Migration Projection when required
```

RegistryでColumnを追加した場合、Physical Schemaへの反映はRegistry Service経由で行う。

```text
Registry Column Add
      ↓
Registry Service
      ↓
ALTER Physical Table
```

Relationを含むLogical Registry DefinitionはRaw Data / BindingのUPDATEとして扱わない。

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
Physical Projection Removal when required
```

対象例：

```text
Table Registry Definition
Column Registry Definition
Relation Registry Definition
```

Physical Objectだけを先に削除してRegistry Authorityを残す操作を標準Flowとしない。

---

## 9. insert

`insert`は新しいRaw Data / Binding Instanceの保存要求をdispatchする。

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
```

Registry Definition自体の新規作成は`insert`ではなく`create`へdispatchする。

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

`delete`は既存Raw Data / Binding Instanceの削除要求をdispatchする。

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
```

Registry Definition自体の削除は`delete`ではなく`drop`へdispatchする。

UI上のBinding Deleteは基本的に`delete`へ対応する。

---

## 11. update

`update`は既存Raw Data / Bindingの具体値変更要求をdispatchする。

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
```

Registry Definition / Logical Registry Metadataの変更は`update`ではなく`alter`へdispatchする。

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

## 12. upsert

`upsert`はRegistry / Binding DefinitionからTargetとConflict Identityを解決し、既存Rowの有無に応じてINSERTまたはUPDATEを行う汎用Data / Binding Operationとする。

```text
upsert(request)
   ↓
Target Resolve
   ↓
Registry / Binding Resolve
   ↓
Conflict Identity Resolve
   ↓
Payload Map
   ↓
UPSERT
```

SQLiteでは、解決したConflict Identityを用いて対応するStorage Operationへdispatchできる。

```sql
INSERT ...
ON CONFLICT (...) DO UPDATE ...
```

Conflict IdentityはRegistry / Persistent Definitionから解決する。ResolverにApplication固有のConflict KeyやConflict PolicyをHardcodeしない。

```text
Conflict Identity
  = Registry / Persistent DefinitionからResolve

Resolver
  != Application-specific Conflict Policy Authority
```

Resolverは不足したConflict Identityを推測しない。Definitionが存在しない、または一意に解決できない場合は、既存の`Missing Definition` / `Ambiguous Target`と同様にreject / errorとする。

`registry.current`は汎用`upsert`を利用できる具体例の一つである。

```text
registry.current
  = Save Data current

key
  = stable current identity

UNIQUE(key)

basic mutation
  = UPSERT

registry.current
   ↓
key resolve
   ↓
upsert(request)
   ↓
ON CONFLICT(key)
   ↓
current update
```

```text
upsert
  != Save専用Operation
```

`upsert`はRaw Data / Bindingなど、Registry Definition上UPSERT可能なTargetにも再利用可能とする。Conflict Identityを既存Registry / Persistent Definitionから解決できる場合は、新しいApplication固有Request Schemaを追加しない。実装上追加情報が必要な場合もResolverの汎用Request Modelとして扱い、`registry.current`専用fieldを追加しない。

---

## 13. select

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

## 14. Registry Resolve

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

## 15. Service Dispatch

ResolverはStorage / Schema操作そのもののAuthorityではない。

```text
Resolver
  = Dispatch

Registry Service
  = Registry Mutation / Schema Projection

Storage Operation
  = Raw Data / Binding Persistence
```

Registry Definition系Operation：

```text
create / alter / drop
  -> Registry Service
```

Raw Data / Binding系Operation：

```text
insert / delete / update / upsert / select
  -> Registry Resolve
  -> Storage / Binding Operation
```

`select`はRegistry Definitionの読取にも使用できる。

`truncate`はData削除OperationとしてStorage側へdispatchする。

---

## 16. Dynamic Generation

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

## 17. Boundary

```text
Registry
  = Schema / Logical Definition Authority

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
  -X-> Application固有Conflict PolicyをAuthority化

Resolver
  -X-> 不足したConflict Identityを推測

Resolver
  -X-> Display LabelをPersistent Identityとして使用

Raw Data / Binding Operation
  -X-> Registry DefinitionをAuthorityとして変更

Physical Schema
  -X-> Registry Authorityを逆生成

Generated Resolver
  -X-> Registry / Binding / UI Definitionを再定義
```
