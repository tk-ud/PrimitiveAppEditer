/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - table_registry contract (registry.table)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (8. table_registry, 8. kind, 8. Semantic Type)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	IProjectSqliteStatements,
	isLogicalNamespace,
	LogicalNamespace,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	quoteIdentifier,
	REGISTRY_SCHEMA,
} from './projectSqlite.js';
import { ensureRegistryIdentity, IRegistryIdentity, isRegistryUuid, normalizeRegistryUuid, RegistryIdentityError } from './registryIdentity.js';

/**
 * `table_registry` = the Registry entry of one application table: its logical namespace
 * (`schema: items | logs`), its Machine Identity / human naming and its `columns` (stored as one
 * JSON value). The Registry is the authority; the application Physical Schema is a projection
 * generated from it by the Registry Service and is never reverse-generated into it.
 *
 * This module owns the contract (entry / column / `kind` / Semantic Type), its validation, and its
 * storage in `project.sqlite` (`registry.table_registry`, created by the Editor built-in DDL),
 * including the read used by `Registry Load`. Registry mutation (OLD / NEW diff, DDL generate) is
 * owned by the App Editor Registry Service; the existence of a referenced `enum_registry` entry is
 * validated by enum_registry.
 */

// #region kind

/** `columns[].kind`. */
export const enum TableColumnKind {
	Uuid = 'uuid',
	Text = 'text',
	Int = 'int',
	Double = 'double',
	Bool = 'bool',
	Date = 'date',
	Timestamp = 'timestamp',
	Enum = 'enum',
	Json = 'json',
}

/** Every `kind`, in specification order. */
export const tableColumnKinds: readonly TableColumnKind[] = Object.freeze([
	TableColumnKind.Uuid,
	TableColumnKind.Text,
	TableColumnKind.Int,
	TableColumnKind.Double,
	TableColumnKind.Bool,
	TableColumnKind.Date,
	TableColumnKind.Timestamp,
	TableColumnKind.Enum,
	TableColumnKind.Json,
]);

export function isTableColumnKind(value: unknown): value is TableColumnKind {
	return typeof value === 'string' && (tableColumnKinds as readonly string[]).includes(value);
}

// #endregion

// #region Semantic Type

/** The semantic value type a `kind` stands for. */
export const enum TableColumnSemanticType {
	/** identity / relation value */
	IdentityOrRelation = 'identity / relation value',
	String = 'string',
	Integer = 'integer',
	FloatingPoint = 'floating point',
	Boolean = 'boolean',
	DateValue = 'date value',
	TimestampValue = 'timestamp value',
	/** text value + enum_registry metadata */
	EnumText = 'text value + enum_registry metadata',
	Structured = 'structured value',
}

export interface ITableColumnSemantic {
	readonly kind: TableColumnKind;
	readonly semanticType: TableColumnSemanticType;
	/** `enum`: the value is text and the column carries `enum_registry` metadata (`columns[].enum`). */
	readonly enumMetadata: boolean;
}

const semantics: ReadonlyMap<TableColumnKind, ITableColumnSemantic> = new Map(([
	[TableColumnKind.Uuid, TableColumnSemanticType.IdentityOrRelation],
	[TableColumnKind.Text, TableColumnSemanticType.String],
	[TableColumnKind.Int, TableColumnSemanticType.Integer],
	[TableColumnKind.Double, TableColumnSemanticType.FloatingPoint],
	[TableColumnKind.Bool, TableColumnSemanticType.Boolean],
	[TableColumnKind.Date, TableColumnSemanticType.DateValue],
	[TableColumnKind.Timestamp, TableColumnSemanticType.TimestampValue],
	[TableColumnKind.Enum, TableColumnSemanticType.EnumText],
	[TableColumnKind.Json, TableColumnSemanticType.Structured],
] as const).map(([kind, semanticType]) => [kind, Object.freeze({ kind, semanticType, enumMetadata: kind === TableColumnKind.Enum })]));

export function getTableColumnSemantic(kind: TableColumnKind): ITableColumnSemantic {
	const semantic = semantics.get(kind);
	if (!semantic) {
		throw new TableRegistryError(`unknown kind '${kind}'`);
	}
	return semantic;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** `date value`: a calendar date `YYYY-MM-DD`. */
export function isDateValue(value: unknown): value is string {
	const match = typeof value === 'string' ? datePattern.exec(value) : null;
	if (!match) {
		return false;
	}
	const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	return date.toISOString().slice(0, 10) === value;
}

/** `timestamp value`: an ISO 8601 date-time with an explicit zone (`Z` or `+hh:mm` / `-hh:mm`). */
export function isTimestampValue(value: unknown): value is string {
	return typeof value === 'string' && timestampPattern.test(value) && isDateValue(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}

function isStructuredValue(value: unknown): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return true;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every(isStructuredValue);
	}
	if (typeof value === 'object') {
		const prototype = Object.getPrototypeOf(value);
		return (prototype === Object.prototype || prototype === null) && Object.values(value as object).every(isStructuredValue);
	}
	return false;
}

/**
 * Whether `value` is a value of the Semantic Type of `kind`. `null` is the absent value and is
 * accepted only for a column that is not `not_null`. For `enum` the value is text; whether it is
 * one of the referenced `enum_registry` values is enum_registry Input Validation.
 */
export function isTableColumnValue(column: Pick<ITableRegistryColumn, 'kind' | 'not_null'>, value: unknown): boolean {
	if (value === null || value === undefined) {
		return !column.not_null;
	}
	switch (column.kind) {
		case TableColumnKind.Uuid: return isRegistryUuid(value);
		case TableColumnKind.Text: return typeof value === 'string';
		case TableColumnKind.Int: return typeof value === 'number' && Number.isSafeInteger(value);
		case TableColumnKind.Double: return typeof value === 'number' && Number.isFinite(value);
		case TableColumnKind.Bool: return typeof value === 'boolean';
		case TableColumnKind.Date: return isDateValue(value);
		case TableColumnKind.Timestamp: return isTimestampValue(value);
		case TableColumnKind.Enum: return typeof value === 'string';
		case TableColumnKind.Json: return isStructuredValue(value);
		default: return false;
	}
}

// #endregion

// #region table_registry

/** One `table_registry.columns` element. */
export interface ITableRegistryColumn extends IRegistryIdentity {
	readonly index: number;
	readonly kind: TableColumnKind;
	readonly not_null: boolean;
	readonly writable: boolean;
	readonly searchable: boolean;
	/** `enum_registry.uuid | null`: set exactly when `kind` is `enum`. */
	readonly enum: string | null;
}

/** One `table_registry` entry. */
export interface ITableRegistryEntry extends IRegistryIdentity {
	readonly index: number;
	readonly schema: LogicalNamespace;
	readonly columns: readonly ITableRegistryColumn[];
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** A column INSERT / Seed input: the UUID is generated when missing (7. Generate). */
export interface ITableRegistryColumnInput {
	readonly uuid?: string;
	readonly index: number;
	readonly name: string;
	readonly label?: string;
	readonly kind: TableColumnKind | string;
	readonly not_null: boolean;
	readonly writable: boolean;
	readonly searchable: boolean;
	readonly enum?: string | null;
}

/** A table INSERT / Seed input: the UUID is generated and `created_at` stamped when missing. */
export interface ITableRegistryEntryInput {
	readonly uuid?: string;
	readonly index: number;
	readonly schema: LogicalNamespace | string;
	readonly name: string;
	readonly label?: string;
	readonly columns: readonly ITableRegistryColumnInput[];
	readonly created_at?: string;
}

export class TableRegistryError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor table_registry: ${message}`);
		this.name = 'TableRegistryError';
	}
}

function identityOf(input: { readonly uuid?: string; readonly name: string; readonly label?: string }, generateUuid: () => string, where: string): IRegistryIdentity {
	try {
		return ensureRegistryIdentity(input, generateUuid);
	} catch (error) {
		throw error instanceof RegistryIdentityError ? new TableRegistryError(`${where}: ${error.message}`) : error;
	}
}

function validateIndex(index: unknown, where: string): number {
	if (typeof index !== 'number' || !Number.isSafeInteger(index)) {
		throw new TableRegistryError(`${where}: index must be an int`);
	}
	return index;
}

function validateFlag(value: unknown, field: string, where: string): boolean {
	if (typeof value !== 'boolean') {
		throw new TableRegistryError(`${where}: ${field} must be a bool`);
	}
	return value;
}

function validateCreatedAt(value: unknown, where: string): string {
	if (!isTimestampValue(value)) {
		throw new TableRegistryError(`${where}: created_at must be a timestamp`);
	}
	return new Date(value).toISOString();
}

function withLabel<T extends object>(base: T, label: string | undefined): T & { label?: string } {
	return label === undefined ? base : { ...base, label };
}

function createColumn(input: ITableRegistryColumnInput, generateUuid: () => string, table: string): ITableRegistryColumn {
	const identity = identityOf(input, generateUuid, `table '${table}' column`);
	const where = `table '${table}' column '${identity.name}'`;
	if (!isTableColumnKind(input.kind)) {
		throw new TableRegistryError(`${where}: unknown kind '${String(input.kind)}' (expected ${tableColumnKinds.join(' | ')})`);
	}
	const enumRef = input.enum ?? null;
	if (getTableColumnSemantic(input.kind).enumMetadata) {
		if (enumRef === null) {
			throw new TableRegistryError(`${where}: kind 'enum' requires an enum_registry.uuid`);
		}
		if (!isRegistryUuid(enumRef)) {
			throw new TableRegistryError(`${where}: enum '${enumRef}' is not an enum_registry.uuid`);
		}
	} else if (enumRef !== null) {
		throw new TableRegistryError(`${where}: enum is only set for kind 'enum', got kind '${input.kind}'`);
	}
	return Object.freeze(withLabel({
		uuid: identity.uuid,
		index: validateIndex(input.index, where),
		name: identity.name,
		kind: input.kind,
		not_null: validateFlag(input.not_null, 'not_null', where),
		writable: validateFlag(input.writable, 'writable', where),
		searchable: validateFlag(input.searchable, 'searchable', where),
		enum: enumRef === null ? null : normalizeRegistryUuid(enumRef),
	}, identity.label));
}

/**
 * Builds a validated `table_registry` entry: missing table / column UUIDs are generated and
 * supplied ones kept (7. Generate), `schema` is `items | logs`, every column has a known `kind`,
 * `enum` is an `enum_registry.uuid` exactly for `kind: enum`, and column UUIDs are unique within
 * the table. Name uniqueness is not part of this contract.
 */
export function createTableRegistryEntry(
	input: ITableRegistryEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): ITableRegistryEntry {
	const identity = identityOf(input, generateUuid, 'table');
	const where = `table '${identity.name}'`;
	if (typeof input.schema !== 'string' || !isLogicalNamespace(input.schema)) {
		throw new TableRegistryError(`${where}: schema must be items | logs, got '${String(input.schema)}'`);
	}
	if (!Array.isArray(input.columns)) {
		throw new TableRegistryError(`${where}: columns must be a list`);
	}
	const columnUuids = new Set<string>();
	const columns = input.columns.map(columnInput => {
		const column = createColumn(columnInput, generateUuid, identity.name);
		if (columnUuids.has(column.uuid)) {
			throw new TableRegistryError(`${where}: duplicate column uuid for '${column.name}'`);
		}
		columnUuids.add(column.uuid);
		return column;
	});
	return Object.freeze(withLabel({
		uuid: identity.uuid,
		index: validateIndex(input.index, where),
		schema: input.schema,
		name: identity.name,
		columns: Object.freeze(columns),
		created_at: validateCreatedAt(input.created_at ?? now().toISOString(), where),
	}, identity.label));
}

/** Validates a set of entries of one `table_registry`: table UUIDs are unique. */
export function validateTableRegistry(entries: readonly ITableRegistryEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		const uuid = normalizeRegistryUuid(entry.uuid);
		if (uuids.has(uuid)) {
			throw new TableRegistryError(`duplicate table uuid for '${entry.name}'`);
		}
		uuids.add(uuid);
	}
}

/** `table_registry` order: by `index`, then by Machine Identity for a stable order. */
export function compareTableRegistryOrder(a: { readonly index: number; readonly uuid: string }, b: { readonly index: number; readonly uuid: string }): number {
	return a.index - b.index || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
}

// #endregion

// #region Storage (project.sqlite)

/** `registry.table_registry`: the Registry schema table holding `table_registry` entries. */
export const tableRegistryTable = Object.freeze({ schema: REGISTRY_SCHEMA, table: 'table_registry' } as const);

export const tableRegistryPhysicalTable = corePhysicalTableNameResolver.resolve(tableRegistryTable.schema, tableRegistryTable.table);

const storedColumns = ['uuid', 'index', 'schema', 'name', 'label', 'columns', 'created_at'] as const;

/**
 * Stored form of one entry: scalar fields as columns, `columns` as one JSON value
 * (`columns: json`), an absent label as `''` and `created_at` as an ISO 8601 UTC string.
 */
export function encodeTableRegistryRow(entry: ITableRegistryEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		index: entry.index,
		schema: entry.schema,
		name: entry.name,
		label: entry.label ?? '',
		columns: JSON.stringify(entry.columns.map(column => ({
			uuid: column.uuid,
			index: column.index,
			name: column.name,
			label: column.label ?? '',
			kind: column.kind,
			not_null: column.not_null,
			writable: column.writable,
			searchable: column.searchable,
			enum: column.enum,
		}))),
		created_at: entry.created_at,
	});
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeTableRegistryRow(row: ProjectSqliteRow): ITableRegistryEntry {
	const missingUuid = (): string => { throw new TableRegistryError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	let columns: unknown;
	try {
		columns = JSON.parse(String(row.columns));
	} catch {
		throw new TableRegistryError(`stored table '${uuid}': columns is not JSON`);
	}
	if (!Array.isArray(columns) || !columns.every(column => typeof column === 'object' && column !== null && !Array.isArray(column))) {
		throw new TableRegistryError(`stored table '${uuid}': columns must be a JSON list of column objects`);
	}
	for (const column of columns as Record<string, unknown>[]) {
		if (typeof column.uuid !== 'string' || !column.uuid) {
			throw new TableRegistryError(`stored table '${uuid}': stored column has no uuid`);
		}
	}
	return createTableRegistryEntry({
		uuid,
		index: row.index as number,
		schema: row.schema as string,
		name: row.name as string,
		label: typeof row.label === 'string' ? row.label : undefined,
		columns: columns as ITableRegistryColumnInput[],
		created_at: row.created_at as string,
	}, missingUuid);
}

/** `INSERT` statement and parameters writing `entry` into `registry.table_registry`. */
export function getTableRegistryInsert(entry: ITableRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeTableRegistryRow(entry);
	return Object.freeze({
		sql: `INSERT INTO ${quoteIdentifier(tableRegistryPhysicalTable)} (${storedColumns.map(quoteIdentifier).join(', ')}) VALUES (${storedColumns.map(() => '?').join(', ')})`,
		params: Object.freeze(storedColumns.map(column => row[column] as string | number)),
	});
}

/** `UPDATE` statement and parameters replacing the stored entry with Machine Identity `entry.uuid`. */
export function getTableRegistryUpdate(entry: ITableRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeTableRegistryRow(entry);
	const assigned = storedColumns.filter(column => column !== 'uuid');
	return Object.freeze({
		sql: `UPDATE ${quoteIdentifier(tableRegistryPhysicalTable)} SET ${assigned.map(column => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE "uuid" = ?`,
		params: Object.freeze([...assigned.map(column => row[column] as string | number), entry.uuid]),
	});
}

/** `DELETE` statement and parameters removing the stored entry with Machine Identity `uuid`. */
export function getTableRegistryDelete(uuid: string): { readonly sql: string; readonly params: readonly string[] } {
	return Object.freeze({
		sql: `DELETE FROM ${quoteIdentifier(tableRegistryPhysicalTable)} WHERE "uuid" = ?`,
		params: Object.freeze([normalizeRegistryUuid(uuid)]),
	});
}

/**
 * Reads every `table_registry` entry from `project.sqlite` in Registry order for `Registry Load`.
 * Each stored row is validated against the contract and table UUIDs must be unique.
 */
export async function readTableRegistry(database: IProjectSqliteStatements): Promise<readonly ITableRegistryEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(tableRegistryPhysicalTable)}`);
	const entries = rows.map(decodeTableRegistryRow).sort(compareTableRegistryOrder);
	validateTableRegistry(entries);
	return Object.freeze(entries);
}

// #endregion
