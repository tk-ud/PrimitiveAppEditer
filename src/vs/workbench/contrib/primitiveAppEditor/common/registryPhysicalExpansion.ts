/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - SQLite physical table projection (registry.physical-expansion)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (9. Physical Table Expansion)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { corePhysicalTableNameResolver, isLogicalNamespace, ProjectSqliteNameError, quoteIdentifier } from './projectSqlite.js';
import {
	compareTableRegistryOrder,
	isTableColumnKind,
	ITableRegistryColumn,
	ITableRegistryEntry,
	TableColumnKind,
	TableRegistryError,
	validateTableRegistry,
} from './tableRegistry.js';

/**
 * Physical Table Expansion: the Registry (Authority) is expanded into the SQLite Physical Schema,
 * whose rows are the Raw Data.
 *
 * ```text
 * table_registry -> Registry Service -> Schema Validate -> Column Validate -> Kind Dispatch
 *                -> DDL Generate -> Physical Table -> Raw Data
 * ```
 *
 * The expansion only reads the Registry: the Physical Schema is a projection (`!= Authority`) and
 * is never read back into the Registry. Executing the generated DDL on project.sqlite is the
 * Registry Service's job (`RegistryService.expand` / mutations).
 */

// #region Errors

export class RegistryServiceError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor Registry Service: ${message}`);
		this.name = 'RegistryServiceError';
	}
}

export const enum RegistryExpansionStage {
	SchemaValidate = 'schemaValidate',
	ColumnValidate = 'columnValidate',
	KindDispatch = 'kindDispatch',
}

/** A `table_registry` entry that cannot be expanded; `stage` is the pipeline stage that rejected it. */
export class RegistryExpansionError extends RegistryServiceError {
	constructor(readonly stage: RegistryExpansionStage, message: string) {
		super(`${stage}: ${message}`);
		this.name = 'RegistryExpansionError';
	}
}

// #endregion

// #region Schema Validate

/** Raw Data row identity column present in every physical table. */
export const ROW_IDENTITY_COLUMN = 'uuid';

/** Physical table name of a `table_registry` entry: `<schema>__<name>` (4. the Registry Service resolves physical table names). */
export function resolveRegistryPhysicalTable(entry: Pick<ITableRegistryEntry, 'schema' | 'name'>): string {
	try {
		return corePhysicalTableNameResolver.resolve(entry.schema, entry.name);
	} catch (error) {
		throw error instanceof ProjectSqliteNameError ? new RegistryServiceError(`table '${entry.name}': ${error.message}`) : error;
	}
}

/** Schema Validate: the logical namespace is `items | logs` and the physical table name resolves. */
export function validateRegistryTableSchema(entry: Pick<ITableRegistryEntry, 'schema' | 'name'>): string {
	if (!isLogicalNamespace(entry.schema)) {
		throw new RegistryExpansionError(RegistryExpansionStage.SchemaValidate, `table '${entry.name}' schema must be items | logs: '${entry.schema}'`);
	}
	try {
		return resolveRegistryPhysicalTable(entry);
	} catch (error) {
		throw error instanceof RegistryServiceError ? new RegistryExpansionError(RegistryExpansionStage.SchemaValidate, error.message.replace(/^Primitive App Editor Registry Service: /, '')) : error;
	}
}

// #endregion

// #region Column Validate

const columnNamePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Column Validate: physical column names are valid, unique and never the row identity column. */
export function validateRegistryTableColumns(entry: Pick<ITableRegistryEntry, 'name' | 'columns'>): void {
	const columns = new Set<string>();
	for (const column of entry.columns) {
		if (!columnNamePattern.test(column.name)) {
			throw new RegistryExpansionError(RegistryExpansionStage.ColumnValidate, `table '${entry.name}' column name must match ${columnNamePattern.source}: '${column.name}'`);
		}
		if (column.name === ROW_IDENTITY_COLUMN) {
			throw new RegistryExpansionError(RegistryExpansionStage.ColumnValidate, `table '${entry.name}' column '${column.name}' is the Raw Data row identity column`);
		}
		if (columns.has(column.name)) {
			throw new RegistryExpansionError(RegistryExpansionStage.ColumnValidate, `table '${entry.name}' has two columns resolving to physical column '${column.name}'`);
		}
		columns.add(column.name);
	}
}

// #endregion

// #region Kind Dispatch

/** Physical projection of a column `kind`. */
export interface IRegistryKindProjection {
	/** SQLite declared type. */
	readonly type: 'INTEGER' | 'REAL' | 'TEXT';
}

/** Kind Dispatch table: every `table_registry` kind (8. kind) to its physical column projection. */
export const registryKindProjections: Readonly<Record<TableColumnKind, IRegistryKindProjection>> = Object.freeze({
	[TableColumnKind.Uuid]: Object.freeze({ type: 'TEXT' }),
	[TableColumnKind.Text]: Object.freeze({ type: 'TEXT' }),
	[TableColumnKind.Int]: Object.freeze({ type: 'INTEGER' }),
	[TableColumnKind.Double]: Object.freeze({ type: 'REAL' }),
	[TableColumnKind.Bool]: Object.freeze({ type: 'INTEGER' }),
	[TableColumnKind.Date]: Object.freeze({ type: 'TEXT' }),
	[TableColumnKind.Timestamp]: Object.freeze({ type: 'TEXT' }),
	[TableColumnKind.Enum]: Object.freeze({ type: 'TEXT' }),
	[TableColumnKind.Json]: Object.freeze({ type: 'TEXT' }),
} satisfies Record<TableColumnKind, IRegistryKindProjection>);

/** Kind Dispatch of one column `kind`. */
export function dispatchRegistryKind(kind: TableColumnKind): IRegistryKindProjection {
	if (!isTableColumnKind(kind)) {
		throw new RegistryExpansionError(RegistryExpansionStage.KindDispatch, `unknown kind '${kind}'`);
	}
	return registryKindProjections[kind];
}

/** SQLite declared type of a column `kind`. */
export function getRegistryPhysicalColumnType(kind: TableColumnKind): string {
	return dispatchRegistryKind(kind).type;
}

// #endregion

// #region Physical Schema projection

export interface IRegistryPhysicalColumn {
	readonly name: string;
	readonly type: string;
	readonly notNull: boolean;
	readonly primaryKey: boolean;
	/** `table_registry` column uuid; `undefined` for the row identity column. */
	readonly registryUuid: string | undefined;
}

export interface IRegistryPhysicalTable {
	/** `table_registry` entry uuid. */
	readonly registryUuid: string;
	readonly name: string;
	/** Row identity column first, then the Registry columns in Registry order. */
	readonly columns: readonly IRegistryPhysicalColumn[];
}

export interface IRegistryPhysicalSchema {
	readonly tables: readonly IRegistryPhysicalTable[];
}

const rowIdentityColumn: IRegistryPhysicalColumn = Object.freeze({ name: ROW_IDENTITY_COLUMN, type: 'TEXT', notNull: true, primaryKey: true, registryUuid: undefined });

function projectColumn(column: Pick<ITableRegistryColumn, 'uuid' | 'name' | 'kind' | 'not_null'>, notNull = column.not_null): IRegistryPhysicalColumn {
	return Object.freeze({ name: column.name, type: dispatchRegistryKind(column.kind).type, notNull, primaryKey: false, registryUuid: column.uuid });
}

/** Expands one entry: Schema Validate -> Column Validate -> Kind Dispatch. */
export function projectRegistryPhysicalTable(entry: ITableRegistryEntry): IRegistryPhysicalTable {
	const name = validateRegistryTableSchema(entry);
	validateRegistryTableColumns(entry);
	const columns = [...entry.columns].sort(compareTableRegistryOrder).map(column => projectColumn(column));
	return Object.freeze({ registryUuid: entry.uuid, name, columns: Object.freeze([rowIdentityColumn, ...columns]) });
}

/**
 * Expands the whole Registry into its Physical Schema (Registry order). The Registry must satisfy
 * the `table_registry` contract and no two entries may resolve to the same physical table.
 */
export function expandRegistryPhysicalSchema(entries: readonly ITableRegistryEntry[]): IRegistryPhysicalSchema {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	try {
		validateTableRegistry(entries);
	} catch (error) {
		throw error instanceof TableRegistryError ? new RegistryExpansionError(RegistryExpansionStage.SchemaValidate, error.message) : error;
	}
	const owners = new Map<string, string>();
	const tables = [...entries].sort(compareTableRegistryOrder).map(entry => {
		const table = projectRegistryPhysicalTable(entry);
		if (owners.has(table.name)) {
			throw new RegistryExpansionError(RegistryExpansionStage.SchemaValidate, `tables '${owners.get(table.name)}' and '${entry.name}' resolve to the same physical table '${table.name}'`);
		}
		owners.set(table.name, entry.name);
		return table;
	});
	return Object.freeze({ tables: Object.freeze(tables) });
}

// #endregion

// #region DDL Generate

/** Physical column definition; `notNull` overrides the Registry constraint (e.g. ADD COLUMN before a Constraint migration). */
export function generateRegistryColumnDefinition(column: Pick<ITableRegistryColumn, 'uuid' | 'name' | 'kind' | 'not_null'>, notNull = column.not_null): string {
	return physicalColumnDefinition(projectColumn(column, notNull));
}

function physicalColumnDefinition(column: IRegistryPhysicalColumn): string {
	return `${quoteIdentifier(column.name)} ${column.type}${column.primaryKey ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}`;
}

/**
 * DDL Generate of a physical table: `CREATE TABLE` named `physicalName` (default: the projected
 * name). Only DDL: no trigger, no physical foreign key.
 */
export function generateRegistryCreateTable(table: IRegistryPhysicalTable, physicalName = table.name): string {
	assertBoundaryFlow(BoundaryNode.AppEditorRegistryService, BoundaryNode.SQLiteDdl);
	return `CREATE TABLE ${quoteIdentifier(physicalName)} (${table.columns.map(physicalColumnDefinition).join(', ')})`;
}

// #endregion
