/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - App Editor Registry Service mutation pipeline (registry.service)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (5. Registry DDL, 6. Registry Service)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import {
	assertProjectSqliteAccess,
	IProjectSqliteDatabase,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteValue,
	quoteIdentifier,
} from './projectSqlite.js';
import { diffRegistryIdentities, RegistryIdentityChangeKind } from './registryIdentity.js';
import {
	expandRegistryPhysicalSchema,
	generateRegistryColumnDefinition,
	generateRegistryCreateTable,
	IRegistryPhysicalSchema,
	IRegistryPhysicalTable,
	projectRegistryPhysicalTable,
	resolveRegistryPhysicalTable,
	ROW_IDENTITY_COLUMN,
	RegistryServiceError,
} from './registryPhysicalExpansion.js';
import {
	compareTableRegistryOrder,
	createTableRegistryEntry,
	getTableRegistryDelete,
	getTableRegistryInsert,
	getTableRegistryUpdate,
	isTableColumnValue,
	ITableRegistryColumn,
	ITableRegistryEntry,
	ITableRegistryEntryInput,
	readTableRegistry,
	TableColumnKind,
	TableRegistryError,
} from './tableRegistry.js';

export { getRegistryPhysicalColumnType, resolveRegistryPhysicalTable, ROW_IDENTITY_COLUMN, RegistryServiceError } from './registryPhysicalExpansion.js';

/**
 * App Editor Registry Service = the Mutation Executor of the Registry (Authority). Every Registry
 * mutation runs one pipeline in one SQLite transaction:
 *
 * ```text
 * BEGIN -> UUID Complete -> OLD / NEW Diff -> Registry Validate -> Registry Mutation
 *       -> DDL Generate / DDL Migration -> Physical Schema Validate -> COMMIT
 * Failure -> ROLLBACK
 * ```
 *
 * The SQLite Physical Schema is a Registry Projection: it is generated from the Registry, compared
 * against it, and never reverse-generated into it. No DB trigger is generated or tolerated.
 *
 * Physical naming (4. Logical Namespace: the Registry Service resolves physical table names): a table is
 * `<schema>__<name>` and a column is its `name`, so a Registry rename is a physical rename while
 * Registry pairing stays by UUID (7. Rename). Every physical table carries the Raw Data row identity
 * column `uuid`. Naming, Kind Dispatch and CREATE TABLE DDL are the Physical Table Expansion
 * (registryPhysicalExpansion.ts); `expand` projects the whole Registry onto project.sqlite.
 */

// #region Errors

/** `Invalid existing data -> migration reject`. */
export class RegistryMigrationRejectedError extends RegistryServiceError {
	constructor(message: string) {
		super(`migration rejected: ${message}`);
		this.name = 'RegistryMigrationRejectedError';
	}
}

// #endregion

// #region Mutation

export const enum RegistryMutationKind {
	Insert = 'insert',
	Update = 'update',
	Delete = 'delete',
}

/** A `table_registry` mutation. `Update` carries the complete NEW entry, paired with OLD by UUID. */
export type TableRegistryMutation =
	| { readonly kind: RegistryMutationKind.Insert; readonly entry: ITableRegistryEntryInput }
	| { readonly kind: RegistryMutationKind.Update; readonly entry: ITableRegistryEntryInput & { readonly uuid: string } }
	| { readonly kind: RegistryMutationKind.Delete; readonly uuid: string };

// #endregion

// #region Physical naming

function createTableSql(physicalTable: string, entry: ITableRegistryEntry): string {
	return generateRegistryCreateTable(projectRegistryPhysicalTable(entry), physicalTable);
}

// #endregion

// #region Physical value (Type migration)

/** Physical (SQLite) value of a semantic value of `kind`: `bool` as 0 / 1, `json` as JSON text. */
export function encodeRegistryPhysicalValue(kind: TableColumnKind, value: unknown): ProjectSqliteValue {
	if (value === null || value === undefined) {
		return null;
	}
	switch (kind) {
		case TableColumnKind.Bool: return value ? 1 : 0;
		case TableColumnKind.Json: return JSON.stringify(value);
		default: return value as string | number;
	}
}

/** Result of a value that is not migratable (`Invalid existing data -> migration reject`). */
export const invalidRegistryPhysicalValue: unique symbol = Symbol('invalidRegistryPhysicalValue');

/** Semantic value of a stored physical value of `kind`, or `invalidRegistryPhysicalValue` when it is not one. */
function decodePhysicalValue(kind: TableColumnKind, value: ProjectSqliteValue): unknown {
	if (value === null) {
		return null;
	}
	let decoded: unknown = value;
	if (kind === TableColumnKind.Bool) {
		decoded = value === 1 ? true : value === 0 ? false : invalidRegistryPhysicalValue;
	} else if (kind === TableColumnKind.Json) {
		try {
			decoded = typeof value === 'string' ? JSON.parse(value) : invalidRegistryPhysicalValue;
		} catch {
			decoded = invalidRegistryPhysicalValue;
		}
	}
	return decoded !== invalidRegistryPhysicalValue && isTableColumnValue({ kind, not_null: false }, decoded) ? decoded : invalidRegistryPhysicalValue;
}

/**
 * Type / Constraint migration of one stored value from column `from` to column `to`. The stored
 * value must be a value of `from`; it is kept when it is a value of `to`, a number becomes text
 * for a `text` / `enum` target, and anything else (or `NULL` for a `not_null` target) rejects the
 * migration.
 */
export function migrateRegistryPhysicalValue(
	from: Pick<ITableRegistryColumn, 'kind'> | undefined,
	to: Pick<ITableRegistryColumn, 'kind' | 'not_null'>,
	value: ProjectSqliteValue,
): ProjectSqliteValue | typeof invalidRegistryPhysicalValue {
	const decoded = from ? decodePhysicalValue(from.kind, value) : value;
	if (decoded === invalidRegistryPhysicalValue) {
		return invalidRegistryPhysicalValue;
	}
	let migrated = decoded;
	if (typeof migrated === 'number' && (to.kind === TableColumnKind.Text || to.kind === TableColumnKind.Enum)) {
		migrated = String(migrated);
	}
	return isTableColumnValue(to, migrated) ? encodeRegistryPhysicalValue(to.kind, migrated) : invalidRegistryPhysicalValue;
}

// #endregion

// #region OLD / NEW Diff

export const enum TableRegistryChangeKind {
	Create = 'create',
	Alter = 'alter',
	Drop = 'drop',
}

export const enum ColumnRegistryChangeKind {
	Add = 'add',
	Rename = 'rename',
	Delete = 'delete',
	KindChange = 'kindChange',
	NotNullChange = 'notNullChange',
	/** label / index / writable / searchable / enum only: Registry mutation without DDL. */
	Metadata = 'metadata',
}

export interface IColumnRegistryChange {
	readonly uuid: string;
	readonly changes: readonly ColumnRegistryChangeKind[];
	readonly before?: ITableRegistryColumn;
	readonly after?: ITableRegistryColumn;
}

export type TableRegistryDiff =
	| { readonly kind: TableRegistryChangeKind.Create; readonly after: ITableRegistryEntry }
	| { readonly kind: TableRegistryChangeKind.Alter; readonly before: ITableRegistryEntry; readonly after: ITableRegistryEntry; readonly columns: readonly IColumnRegistryChange[] }
	| { readonly kind: TableRegistryChangeKind.Drop; readonly before: ITableRegistryEntry };

function sameColumnMetadata(a: ITableRegistryColumn, b: ITableRegistryColumn): boolean {
	return a.index === b.index && (a.label ?? '') === (b.label ?? '') && a.writable === b.writable && a.searchable === b.searchable && a.enum === b.enum;
}

/** OLD / NEW diff of one `table_registry` entry; entries and columns are paired by UUID only. */
export function diffTableRegistryEntry(before: ITableRegistryEntry | undefined, after: ITableRegistryEntry | undefined): TableRegistryDiff {
	if (!before && !after) {
		throw new RegistryServiceError('diff requires an OLD or a NEW entry');
	}
	if (!before) {
		return Object.freeze({ kind: TableRegistryChangeKind.Create, after: after! });
	}
	if (!after) {
		return Object.freeze({ kind: TableRegistryChangeKind.Drop, before });
	}
	if (before.uuid !== after.uuid) {
		throw new RegistryServiceError(`diff pairs entries by uuid: '${before.uuid}' != '${after.uuid}'`);
	}
	const beforeColumns = new Map(before.columns.map(column => [column.uuid, column]));
	const afterColumns = new Map(after.columns.map(column => [column.uuid, column]));
	const columns: IColumnRegistryChange[] = [];
	for (const change of diffRegistryIdentities(before.columns, after.columns)) {
		const old = beforeColumns.get(change.uuid);
		const next = afterColumns.get(change.uuid);
		if (change.kind === RegistryIdentityChangeKind.Add) {
			columns.push(Object.freeze({ uuid: change.uuid, changes: Object.freeze([ColumnRegistryChangeKind.Add]), after: next }));
			continue;
		}
		if (change.kind === RegistryIdentityChangeKind.Delete) {
			columns.push(Object.freeze({ uuid: change.uuid, changes: Object.freeze([ColumnRegistryChangeKind.Delete]), before: old }));
			continue;
		}
		const changes: ColumnRegistryChangeKind[] = [];
		if (old!.name !== next!.name) {
			changes.push(ColumnRegistryChangeKind.Rename);
		}
		if (old!.kind !== next!.kind) {
			changes.push(ColumnRegistryChangeKind.KindChange);
		}
		if (old!.not_null !== next!.not_null) {
			changes.push(ColumnRegistryChangeKind.NotNullChange);
		}
		if (!sameColumnMetadata(old!, next!)) {
			changes.push(ColumnRegistryChangeKind.Metadata);
		}
		if (changes.length) {
			columns.push(Object.freeze({ uuid: change.uuid, changes: Object.freeze(changes), before: old, after: next }));
		}
	}
	return Object.freeze({ kind: TableRegistryChangeKind.Alter, before, after, columns: Object.freeze(columns) });
}

// #endregion

// #region DDL Generate

export const enum RegistryDdlStepKind {
	Statement = 'statement',
	/** Type / Constraint migration: rebuild the table with the NEW definition and migrate every row. */
	Rebuild = 'rebuild',
}

export interface IRegistryRebuildColumn {
	readonly name: string;
	/** OLD column whose stored value is migrated; `undefined` for a column added by this mutation. */
	readonly from: ITableRegistryColumn | undefined;
	readonly to: ITableRegistryColumn;
}

export type RegistryDdlStep =
	| { readonly kind: RegistryDdlStepKind.Statement; readonly sql: string }
	| { readonly kind: RegistryDdlStepKind.Rebuild; readonly physicalTable: string; readonly createSql: string; readonly columns: readonly IRegistryRebuildColumn[] };

function statement(sql: string): RegistryDdlStep {
	return Object.freeze({ kind: RegistryDdlStepKind.Statement, sql });
}

/** Temporary names cannot collide with Registry names: those never contain `__`. */
const temporarySuffix = '__pae_migration';

/**
 * DDL Generate: the DDL migration that projects `diff` onto the Physical Schema.
 *
 * ```text
 * Table  INSERT -> CREATE TABLE | UPDATE -> ALTER / Migration | DELETE -> DROP TABLE
 * Column ADD -> ADD COLUMN | RENAME -> RENAME COLUMN | DELETE -> DROP COLUMN
 *        KIND CHANGE -> Type migration | NOT NULL CHANGE -> Constraint migration
 * ```
 *
 * A NOT NULL column added to a table goes through the Constraint migration so existing rows are
 * checked. Only DDL is generated: never a trigger, never a physical foreign key.
 */
export function generateRegistryDdl(diff: TableRegistryDiff): readonly RegistryDdlStep[] {
	assertBoundaryFlow(BoundaryNode.AppEditorRegistryService, BoundaryNode.SQLiteDdl);
	switch (diff.kind) {
		case TableRegistryChangeKind.Create:
			return Object.freeze([statement(createTableSql(resolveRegistryPhysicalTable(diff.after), diff.after))]);
		case TableRegistryChangeKind.Drop:
			return Object.freeze([statement(`DROP TABLE ${quoteIdentifier(resolveRegistryPhysicalTable(diff.before))}`)]);
	}

	const steps: RegistryDdlStep[] = [];
	const oldTable = resolveRegistryPhysicalTable(diff.before);
	const table = resolveRegistryPhysicalTable(diff.after);
	if (oldTable !== table) {
		steps.push(statement(`ALTER TABLE ${quoteIdentifier(oldTable)} RENAME TO ${quoteIdentifier(table)}`));
	}
	const quotedTable = quoteIdentifier(table);
	const has = (change: IColumnRegistryChange, kind: ColumnRegistryChangeKind) => change.changes.includes(kind);

	for (const change of diff.columns.filter(change => has(change, ColumnRegistryChangeKind.Delete))) {
		steps.push(statement(`ALTER TABLE ${quotedTable} DROP COLUMN ${quoteIdentifier(change.before!.name)}`));
	}
	// Two phases so swapped / chained names (a -> b, b -> a) never collide.
	const renamed = diff.columns.filter(change => has(change, ColumnRegistryChangeKind.Rename));
	for (const change of renamed) {
		steps.push(statement(`ALTER TABLE ${quotedTable} RENAME COLUMN ${quoteIdentifier(change.before!.name)} TO ${quoteIdentifier(change.before!.name + temporarySuffix)}`));
	}
	for (const change of renamed) {
		steps.push(statement(`ALTER TABLE ${quotedTable} RENAME COLUMN ${quoteIdentifier(change.before!.name + temporarySuffix)} TO ${quoteIdentifier(change.after!.name)}`));
	}
	const added = diff.columns.filter(change => has(change, ColumnRegistryChangeKind.Add));
	for (const change of added) {
		steps.push(statement(`ALTER TABLE ${quotedTable} ADD COLUMN ${generateRegistryColumnDefinition(change.after!, false)}`));
	}

	const migrated = diff.columns.filter(change =>
		has(change, ColumnRegistryChangeKind.KindChange) || has(change, ColumnRegistryChangeKind.NotNullChange) || (has(change, ColumnRegistryChangeKind.Add) && change.after!.not_null));
	if (migrated.length) {
		const before = new Map(diff.columns.map(change => [change.uuid, change.before]));
		const old = new Map(diff.before.columns.map(column => [column.uuid, column]));
		steps.push(Object.freeze({
			kind: RegistryDdlStepKind.Rebuild,
			physicalTable: table,
			createSql: createTableSql(table + temporarySuffix, diff.after),
			columns: Object.freeze([...diff.after.columns].sort(compareTableRegistryOrder).map(column => Object.freeze({
				name: column.name,
				from: before.has(column.uuid) ? before.get(column.uuid) : old.get(column.uuid),
				to: column,
			}))),
		}));
	}
	return Object.freeze(steps);
}

async function executeRebuild(statements: IProjectSqliteStatements, step: Extract<RegistryDdlStep, { kind: RegistryDdlStepKind.Rebuild }>): Promise<void> {
	const names = [ROW_IDENTITY_COLUMN, ...step.columns.map(column => column.name)];
	const quotedNames = names.map(quoteIdentifier).join(', ');
	const rows = await statements.all(`SELECT ${quotedNames} FROM ${quoteIdentifier(step.physicalTable)}`);
	const migratedRows = rows.map(row => [row[ROW_IDENTITY_COLUMN], ...step.columns.map(column => {
		const value = migrateRegistryPhysicalValue(column.from, column.to, row[column.name] ?? null);
		if (value === invalidRegistryPhysicalValue) {
			const from = column.from ? `${column.from.kind}${column.from.not_null ? ' not_null' : ''}` : 'added';
			throw new RegistryMigrationRejectedError(`table '${step.physicalTable}' row '${String(row[ROW_IDENTITY_COLUMN])}' column '${column.name}': ${JSON.stringify(row[column.name] ?? null)} (${from}) is not a value of kind '${column.to.kind}'${column.to.not_null ? ' not_null' : ''}`);
		}
		return value;
	})]);
	const temporary = quoteIdentifier(step.physicalTable + temporarySuffix);
	await statements.exec(step.createSql);
	for (const values of migratedRows) {
		await statements.run(`INSERT INTO ${temporary} (${quotedNames}) VALUES (${names.map(() => '?').join(', ')})`, values);
	}
	await statements.exec(`DROP TABLE ${quoteIdentifier(step.physicalTable)}`);
	await statements.exec(`ALTER TABLE ${temporary} RENAME TO ${quoteIdentifier(step.physicalTable)}`);
}

/** DDL Migration: applies the generated steps inside the caller's transaction. */
export async function applyRegistryDdl(statements: IProjectSqliteStatements, steps: readonly RegistryDdlStep[]): Promise<void> {
	for (const step of steps) {
		if (step.kind === RegistryDdlStepKind.Statement) {
			await statements.exec(step.sql);
		} else {
			await executeRebuild(statements, step);
		}
	}
}

// #endregion

// #region Physical Schema Validate

/** SQL tokens of a stored table definition: comments and whitespace dropped, identifiers unquoted. */
function tokenizeTableSql(sql: string): { readonly kind: 'word' | 'identifier' | 'literal' | 'symbol'; readonly text: string }[] {
	const tokens: { kind: 'word' | 'identifier' | 'literal' | 'symbol'; text: string }[] = [];
	let i = 0;
	const until = (end: string, from: number) => {
		const index = sql.indexOf(end, from);
		return index < 0 ? sql.length : index;
	};
	while (i < sql.length) {
		const char = sql[i];
		if (/\s/.test(char)) {
			i++;
		} else if (sql.startsWith('--', i)) {
			i = until('\n', i);
		} else if (sql.startsWith('/*', i)) {
			i = until('*/', i + 2) + 2;
		} else if (char === '"' || char === '`' || char === '\'') {
			let text = '';
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === char) {
					if (sql[j + 1] === char) {
						text += char;
						j += 2;
						continue;
					}
					break;
				}
				text += sql[j++];
			}
			tokens.push({ kind: char === '\'' ? 'literal' : 'identifier', text });
			i = j + 1;
		} else if (char === '[') {
			const end = until(']', i);
			tokens.push({ kind: 'identifier', text: sql.slice(i + 1, end) });
			i = end + 1;
		} else if (/[A-Za-z0-9_]/.test(char)) {
			let j = i;
			while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) {
				j++;
			}
			tokens.push({ kind: 'word', text: sql.slice(i, j) });
			i = j;
		} else {
			tokens.push({ kind: 'symbol', text: char });
			i++;
		}
	}
	return tokens;
}

/**
 * The stored definition of a projected physical table may only contain what the projection
 * generates (`CREATE TABLE <name> (<column> <TYPE> [PRIMARY KEY] [NOT NULL], ...)`), which is also
 * all that the Registry Service DDL Migration (ADD / RENAME / DROP COLUMN, RENAME TO, rebuild)
 * leaves in `sqlite_master.sql`. Anything else (GENERATED, CHECK, DEFAULT, COLLATE, UNIQUE,
 * REFERENCES, a table constraint, WITHOUT ROWID / STRICT, a virtual table) or an index other than
 * the row identity PRIMARY KEY index is structure the Registry does not project, so it is rejected.
 */
async function validateRegistryPhysicalTableStructure(statements: IProjectSqliteStatements, projected: IRegistryPhysicalTable): Promise<void> {
	const table = projected.name;
	const reject = (detail: string) => new RegistryServiceError(`physical table '${table}' ${detail}, which the Registry does not project`);
	const stored = await statements.get(`SELECT "sql" FROM sqlite_master WHERE "type" = 'table' AND "name" = ?`, [table]);
	const tokens = tokenizeTableSql(typeof stored?.sql === 'string' ? stored.sql : '');
	const word = (index: number, text: string) => tokens[index]?.kind === 'word' && tokens[index].text.toUpperCase() === text;
	const name = tokens[2];
	if (!word(0, 'CREATE') || !word(1, 'TABLE') || !name || (name.kind !== 'identifier' && name.kind !== 'word') || name.text.toLowerCase() !== table.toLowerCase() || tokens[3]?.text !== '(' || tokens[tokens.length - 1]?.text !== ')') {
		throw reject('is not defined by a plain CREATE TABLE (e.g. a virtual table, WITHOUT ROWID or STRICT)');
	}
	const expected = new Map(projected.columns.map(column => [column.name, column]));
	const body = tokens.slice(4, -1);
	const definitions: (typeof body)[] = [[]];
	for (const token of body) {
		if (token.kind === 'symbol' && token.text === ',') {
			definitions.push([]);
		} else {
			definitions[definitions.length - 1].push(token);
		}
	}
	for (const definition of definitions) {
		const [column, type, ...constraints] = definition;
		const label = column?.text ?? '';
		const columnSpec = column && (column.kind === 'identifier' || column.kind === 'word') ? expected.get(column.text) : undefined;
		if (!columnSpec) {
			throw reject(`has the definition '${definition.map(token => token.text).join(' ')}'`);
		}
		const clauses = constraints.map(token => token.kind === 'word' ? token.text.toUpperCase() : `\u0000${token.text}`).join(' ');
		const allowed = [columnSpec.primaryKey ? 'PRIMARY KEY' : undefined, columnSpec.notNull ? 'NOT NULL' : undefined].filter(clause => clause !== undefined);
		const orders = allowed.length === 2 ? [allowed.join(' '), [...allowed].reverse().join(' ')] : [allowed.join(' ')];
		if (type?.kind !== 'word' || type.text.toUpperCase() !== columnSpec.type || !orders.includes(clauses)) {
			throw reject(`column '${label}' has the definition '${definition.map(token => token.text).join(' ')}'`);
		}
	}
	const indexes = await statements.all(`SELECT "name", "origin" FROM pragma_index_list(?)`, [table]);
	const index = indexes.find(row => row.origin !== 'pk');
	if (index) {
		throw reject(`has the index '${String(index.name)}'`);
	}
}


/**
 * Physical Schema Validate: the physical table of every entry has exactly the row identity column
 * and the Registry columns with their declared type and NOT NULL and no structure / constraint the
 * projection does not generate (see {@link validateRegistryPhysicalTableStructure}), no trigger is
 * defined on a Registry-projected table, and no migration table is left. The Physical Schema is only
 * compared, never read back into the Registry.
 */
export async function validateRegistryPhysicalSchema(statements: IProjectSqliteStatements, entries: readonly ITableRegistryEntry[], dropped: readonly ITableRegistryEntry[] = []): Promise<void> {
	for (const entry of entries) {
		const projected = projectRegistryPhysicalTable(entry);
		const table = projected.name;
		// table_xinfo also lists hidden (GENERATED) columns that table_info omits.
		const actual = await statements.all(`SELECT "name", "type", "notnull", "pk", "hidden" FROM pragma_table_xinfo(?) ORDER BY "cid"`, [table]);
		if (!actual.length) {
			throw new RegistryServiceError(`physical table '${table}' of '${entry.name}' does not exist`);
		}
		const hidden = actual.find(row => Number(row.hidden) !== 0);
		if (hidden) {
			throw new RegistryServiceError(`physical table '${table}' column '${String(hidden.name)}' is a generated / hidden column, which the Registry does not project`);
		}
		const expected = new Map(projected.columns.map(column => [column.name, `${column.type} ${column.notNull ? 1 : 0} ${column.primaryKey ? 1 : 0}`]));
		const found = new Map(actual.map(row => [String(row.name), `${String(row.type).toUpperCase()} ${row.notnull} ${Number(row.pk) > 0 ? 1 : 0}`]));
		for (const [name, definition] of expected) {
			if (found.get(name) !== definition) {
				throw new RegistryServiceError(`physical table '${table}' column '${name}' is ${found.get(name) ?? 'missing'}, expected ${definition} (type notnull pk)`);
			}
		}
		for (const name of found.keys()) {
			if (!expected.has(name)) {
				throw new RegistryServiceError(`physical table '${table}' has column '${name}' that is not in the Registry`);
			}
		}
		await validateRegistryPhysicalTableStructure(statements, projected);
	}
	for (const entry of dropped) {
		const table = resolveRegistryPhysicalTable(entry);
		if (await statements.get(`SELECT "name" FROM sqlite_master WHERE "name" = ?`, [table])) {
			throw new RegistryServiceError(`physical table '${table}' of dropped '${entry.name}' still exists`);
		}
	}
	const tables = [...entries, ...dropped].map(resolveRegistryPhysicalTable);
	const triggers = await statements.all(`SELECT "name", "tbl_name" FROM sqlite_master WHERE "type" = 'trigger'`);
	const projected = triggers.filter(row => tables.includes(String(row.tbl_name)));
	if (projected.length) {
		throw new RegistryServiceError(`DB triggers are not used (found ${projected.map(row => `'${String(row.name)}' on '${String(row.tbl_name)}'`).join(', ')})`);
	}
	const leftovers = (await statements.all(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)).map(row => String(row.name)).filter(name => name.endsWith(temporarySuffix));
	if (leftovers.length) {
		throw new RegistryServiceError(`migration table '${leftovers[0]}' was left behind`);
	}
}

// #endregion

// #region Registry Validate

/**
 * Registry Validate of the NEW Registry = its Physical Table Expansion: `table_registry` contract
 * (unique table UUIDs), Schema Validate (items | logs, physical table names that resolve and are
 * unique), Column Validate (valid unique column names, never the row identity) and Kind Dispatch.
 */
export function validateRegistryProjection(entries: readonly ITableRegistryEntry[]): IRegistryPhysicalSchema {
	return expandRegistryPhysicalSchema(entries);
}

// #endregion

// #region Registry Service

/**
 * `DELETE -> Logical dependency cleanup`: a Registry that logically references a table (for
 * example relation_registry) removes its references to the dropped entry inside the same
 * transaction. Participants are supplied by the Registries that own those references.
 */
export interface IRegistryDependencyCleanup {
	cleanupDroppedTable(statements: IProjectSqliteStatements, dropped: ITableRegistryEntry): Promise<void>;
}

export interface IRegistryServiceOptions {
	readonly generateUuid?: () => string;
	readonly now?: () => Date;
	readonly dependencyCleanup?: readonly IRegistryDependencyCleanup[];
}

export interface IRegistryMutationResult {
	/** NEW entry; `undefined` for a Delete. */
	readonly entry: ITableRegistryEntry | undefined;
	readonly diff: TableRegistryDiff;
	readonly ddl: readonly RegistryDdlStep[];
}

export interface IRegistryExpansionResult {
	/** Physical Schema expanded from the whole Registry. */
	readonly schema: IRegistryPhysicalSchema;
	/** Physical tables created by this expansion (tables already projected are kept with their Raw Data). */
	readonly created: readonly string[];
}

export class RegistryService {

	private readonly generateUuid: () => string;
	private readonly now: () => Date;
	private readonly dependencyCleanup: readonly IRegistryDependencyCleanup[];

	constructor(private readonly database: Pick<IProjectSqliteDatabase, 'transaction'>, options: IRegistryServiceOptions = {}) {
		this.generateUuid = options.generateUuid ?? generateRandomUuid;
		this.now = options.now ?? (() => new Date());
		this.dependencyCleanup = options.dependencyCleanup ?? [];
	}

	/** Table INSERT -> CREATE TABLE. */
	create(entry: ITableRegistryEntryInput): Promise<IRegistryMutationResult> {
		return this.mutate({ kind: RegistryMutationKind.Insert, entry });
	}

	/** Table UPDATE -> OLD / NEW diff -> ALTER / Migration. */
	alter(entry: ITableRegistryEntryInput & { readonly uuid: string }): Promise<IRegistryMutationResult> {
		return this.mutate({ kind: RegistryMutationKind.Update, entry });
	}

	/** Table DELETE -> DROP TABLE -> Logical dependency cleanup. */
	drop(uuid: string): Promise<IRegistryMutationResult> {
		return this.mutate({ kind: RegistryMutationKind.Delete, uuid });
	}

	/**
	 * Physical Table Expansion of the whole Registry in one transaction:
	 *
	 * ```text
	 * table_registry -> Schema Validate -> Column Validate -> Kind Dispatch -> DDL Generate
	 *                -> Physical Table (CREATE TABLE when missing) -> Physical Schema Validate
	 * ```
	 *
	 * The Registry is the Authority: it is only read. A physical table that already exists keeps its
	 * Raw Data and must match the Registry; a mismatching one rejects the expansion (ROLLBACK) and is
	 * never read back into the Registry nor silently rebuilt.
	 */
	expand(): Promise<IRegistryExpansionResult> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		return this.database.transaction(async statements => {
			const registry = await readTableRegistry(statements);
			const schema = expandRegistryPhysicalSchema(registry);
			const created: string[] = [];
			for (const table of schema.tables) {
				const existing = await statements.get(`SELECT "type" FROM sqlite_master WHERE "name" = ?`, [table.name]);
				if (!existing) {
					await statements.exec(generateRegistryCreateTable(table));
					created.push(table.name);
				} else if (existing.type !== 'table') {
					throw new RegistryServiceError(`physical name '${table.name}' is used by a ${String(existing.type)} in project.sqlite`);
				}
			}
			await validateRegistryPhysicalSchema(statements, registry);
			return Object.freeze({ schema, created: Object.freeze(created) });
		});
	}

	/** Runs the whole pipeline in one transaction; any failure rolls back Registry and DDL together. */
	mutate(mutation: TableRegistryMutation): Promise<IRegistryMutationResult> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertBoundaryFlow(BoundaryNode.RegistryMutation, BoundaryNode.AppEditorRegistryService);
		return this.database.transaction(statements => this.execute(statements, mutation));
	}

	private async execute(statements: IProjectSqliteStatements, mutation: TableRegistryMutation): Promise<IRegistryMutationResult> {
		const registry = await readTableRegistry(statements);
		const find = (uuid: string) => {
			const normalized = uuid.toLowerCase();
			const existing = registry.find(entry => entry.uuid === normalized);
			if (!existing) {
				throw new RegistryServiceError(`table_registry has no entry '${uuid}'`);
			}
			return existing;
		};

		// UUID Complete
		let before: ITableRegistryEntry | undefined;
		let after: ITableRegistryEntry | undefined;
		try {
			switch (mutation.kind) {
				case RegistryMutationKind.Insert:
					after = createTableRegistryEntry(mutation.entry, this.generateUuid, this.now);
					break;
				case RegistryMutationKind.Update:
					if (!mutation.entry.uuid) {
						throw new RegistryServiceError('UPDATE requires the uuid of an existing entry');
					}
					before = find(mutation.entry.uuid);
					after = createTableRegistryEntry({ ...mutation.entry, created_at: mutation.entry.created_at ?? before.created_at }, this.generateUuid, this.now);
					break;
				case RegistryMutationKind.Delete:
					before = find(mutation.uuid);
					break;
			}
		} catch (error) {
			throw error instanceof TableRegistryError ? new RegistryServiceError(error.message) : error;
		}

		// OLD / NEW Diff
		const diff = diffTableRegistryEntry(before, after);

		// Registry Validate
		const next = before ? registry.filter(entry => entry.uuid !== before.uuid) : [...registry];
		if (after) {
			next.push(after);
		}
		try {
			validateRegistryProjection(next);
		} catch (error) {
			throw error instanceof TableRegistryError ? new RegistryServiceError(error.message) : error;
		}
		if (after) {
			const table = resolveRegistryPhysicalTable(after);
			if ((!before || resolveRegistryPhysicalTable(before) !== table) && await statements.get(`SELECT "name" FROM sqlite_master WHERE "name" = ?`, [table])) {
				throw new RegistryServiceError(`physical name '${table}' of '${after.name}' is already used in project.sqlite`);
			}
		}

		// Registry Mutation
		const write = !before ? getTableRegistryInsert(after!) : after ? getTableRegistryUpdate(after) : getTableRegistryDelete(before.uuid);
		await statements.run(write.sql, write.params);

		// DDL Generate / DDL Migration
		const ddl = generateRegistryDdl(diff);
		await applyRegistryDdl(statements, ddl);
		if (diff.kind === TableRegistryChangeKind.Drop) {
			for (const participant of this.dependencyCleanup) {
				await participant.cleanupDroppedTable(statements, diff.before);
			}
		}

		// Physical Schema Validate
		await validateRegistryPhysicalSchema(statements, after ? [after] : [], diff.kind === TableRegistryChangeKind.Drop ? [diff.before] : []);

		return Object.freeze({ entry: after, diff, ddl });
	}
}

// #endregion
