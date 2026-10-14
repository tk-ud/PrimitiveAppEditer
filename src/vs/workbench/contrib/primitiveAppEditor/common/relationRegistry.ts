/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - relation_registry and logical join resolution (registry.relation)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (10. relation_registry, 10. Resolve, 10. Validate)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	ProjectSqliteValue,
	quoteIdentifier,
	REGISTRY_SCHEMA,
} from './projectSqlite.js';
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { resolveRegistryPhysicalTable, ROW_IDENTITY_COLUMN } from './registryPhysicalExpansion.js';
import { compareTableRegistryOrder, isTimestampValue, ITableRegistryColumn, ITableRegistryEntry } from './tableRegistry.js';

/**
 * `relation_registry` = the Relation Authority: a logical Relation from one `main_table` to the
 * `join_table`s of its `relations`, each joined on `main_column = join_column` with a
 * `relation_type`. Every reference is a Machine Identity (`table_registry.uuid` / column uuid).
 *
 * `SQLite FK = none`: no physical foreign key is generated (`Relation -X-> Physical FK`); the
 * Relation is resolved into a Logical JOIN by the App Editor Query Resolver (`Relation -> Logical JOIN`):
 *
 * ```text
 * relation_registry -> UUID Resolve -> Table / Column Resolve -> App Editor Query Resolver -> Logical JOIN
 * ```
 *
 * Mutation: `relation_registry` INSERT / UPDATE / DELETE is executed by the App Editor Registry
 * Service (`RegistryService.createRelation / alterRelation / dropRelation`), which validates the
 * references against table_registry in the same transaction; a dropped table is removed from
 * relation_registry by {@link relationRegistryDependencyCleanup} (Logical dependency cleanup).
 */

// #region relation_registry

/** `relation_type`. */
export const enum RelationType {
	Inner = 'inner',
	Left = 'left',
	Right = 'right',
	Full = 'full',
}

export const relationTypes: readonly RelationType[] = Object.freeze([RelationType.Inner, RelationType.Left, RelationType.Right, RelationType.Full]);

export function isRelationType(value: unknown): value is RelationType {
	return typeof value === 'string' && (relationTypes as readonly string[]).includes(value);
}

/** A column reference of a relation: `{ column_uuid }`. */
export interface IRelationColumnReference {
	readonly column_uuid: string;
}

/** One `relation_registry.relations` element. */
export interface IRelationRegistryJoin {
	/** `table_registry.uuid` joined to `main_table`. */
	readonly join_table: string;
	/** Column of `main_table`. */
	readonly main_column: IRelationColumnReference;
	/** Column of `join_table`. */
	readonly join_column: IRelationColumnReference;
	readonly relation_type: RelationType;
}

/** One `relation_registry` entry. */
export interface IRelationRegistryEntry {
	/** Machine Identity. */
	readonly uuid: string;
	readonly index: number;
	/** `table_registry.uuid`. */
	readonly main_table: string;
	readonly relations: readonly IRelationRegistryJoin[];
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** A join INSERT / Seed input; `relation_type` is validated. */
export interface IRelationRegistryJoinInput {
	readonly join_table: string;
	readonly main_column: IRelationColumnReference;
	readonly join_column: IRelationColumnReference;
	readonly relation_type: RelationType | string;
}

/** An INSERT / Seed input: the UUID is generated and `created_at` stamped when missing. */
export interface IRelationRegistryEntryInput {
	readonly uuid?: string;
	readonly index: number;
	readonly main_table: string;
	readonly relations: readonly IRelationRegistryJoinInput[];
	readonly created_at?: string;
}

export class RelationRegistryError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor relation_registry: ${message}`);
		this.name = 'RelationRegistryError';
	}
}

function uuidReference(value: unknown, field: string, where: string): string {
	if (!isRegistryUuid(value)) {
		throw new RelationRegistryError(`${where}: ${field} must be a uuid, got '${String(value)}'`);
	}
	return normalizeRegistryUuid(value);
}

function columnReference(value: unknown, field: string, where: string): IRelationColumnReference {
	if (typeof value !== 'object' || value === null) {
		throw new RelationRegistryError(`${where}: ${field} must be { column_uuid }`);
	}
	return Object.freeze({ column_uuid: uuidReference((value as Partial<IRelationColumnReference>).column_uuid, `${field}.column_uuid`, where) });
}

function createJoin(input: IRelationRegistryJoinInput, where: string): IRelationRegistryJoin {
	if (typeof input !== 'object' || input === null) {
		throw new RelationRegistryError(`${where}: every relation must be an object`);
	}
	if (!isRelationType(input.relation_type)) {
		throw new RelationRegistryError(`${where}: relation_type must be ${relationTypes.join(' | ')}, got '${String(input.relation_type)}'`);
	}
	return Object.freeze({
		join_table: uuidReference(input.join_table, 'join_table', where),
		main_column: columnReference(input.main_column, 'main_column', where),
		join_column: columnReference(input.join_column, 'join_column', where),
		relation_type: input.relation_type,
	});
}

/**
 * Builds a validated `relation_registry` entry: a missing UUID is generated and a supplied one kept
 * (7. Generate), `index` is an int, `main_table` / `join_table` / `column_uuid` are UUIDs,
 * `relation_type` is `inner | left | right | full` and `created_at` a timestamp. Whether the
 * referenced tables and columns exist is checked against table_registry by {@link resolveRelation}.
 */
export function createRelationRegistryEntry(
	input: IRelationRegistryEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IRelationRegistryEntry {
	const uuid = input.uuid === undefined || input.uuid === '' ? generateUuid() : input.uuid;
	if (!isRegistryUuid(uuid)) {
		throw new RelationRegistryError(`'${uuid}' is not a UUID`);
	}
	const where = `relation '${uuid.toLowerCase()}'`;
	if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) {
		throw new RelationRegistryError(`${where}: index must be an int`);
	}
	if (!Array.isArray(input.relations)) {
		throw new RelationRegistryError(`${where}: relations must be a list`);
	}
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new RelationRegistryError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze({
		uuid: normalizeRegistryUuid(uuid),
		index: input.index,
		main_table: uuidReference(input.main_table, 'main_table', where),
		relations: Object.freeze(input.relations.map((join, i) => createJoin(join, `${where} relations[${i}]`))),
		created_at: new Date(createdAt).toISOString(),
	});
}

/** Validates a set of entries of one `relation_registry`: relation UUIDs are unique. */
export function validateRelationRegistry(entries: readonly IRelationRegistryEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		const uuid = normalizeRegistryUuid(entry.uuid);
		if (uuids.has(uuid)) {
			throw new RelationRegistryError(`duplicate relation uuid '${uuid}'`);
		}
		uuids.add(uuid);
	}
}

// #endregion

// #region Resolve / Validate

/** One join resolved to its table_registry entry and columns. */
export interface IResolvedRelationJoin {
	readonly joinTable: ITableRegistryEntry;
	readonly mainColumn: ITableRegistryColumn;
	readonly joinColumn: ITableRegistryColumn;
	readonly relationType: RelationType;
}

/** A `relation_registry` entry resolved against table_registry (UUID Resolve -> Table / Column Resolve). */
export interface IResolvedRelation {
	readonly uuid: string;
	readonly mainTable: ITableRegistryEntry;
	readonly joins: readonly IResolvedRelationJoin[];
}

function findTable(tables: readonly ITableRegistryEntry[], uuid: string): ITableRegistryEntry | undefined {
	const normalized = uuid.toLowerCase();
	return tables.find(table => table.uuid === normalized);
}

function findColumn(table: ITableRegistryEntry, reference: IRelationColumnReference): ITableRegistryColumn | undefined {
	const normalized = reference.column_uuid.toLowerCase();
	return table.columns.find(column => column.uuid === normalized);
}

/**
 * UUID Resolve -> Table / Column Resolve of one entry, which is also its Validate:
 *
 * ```text
 * main_table exists, join_table exists, main_column exists (in main_table),
 * join_column exists (in join_table), relation_type valid
 * ```
 *
 * Tables and columns are resolved by Machine Identity only, never by name.
 */
export function resolveRelation(entry: IRelationRegistryEntry, tables: readonly ITableRegistryEntry[]): IResolvedRelation {
	const where = `relation '${entry.uuid}'`;
	const mainTable = findTable(tables, entry.main_table);
	if (!mainTable) {
		throw new RelationRegistryError(`${where}: main_table '${entry.main_table}' does not exist in table_registry`);
	}
	const joins = entry.relations.map((join, i) => {
		const at = `${where} relations[${i}]`;
		const joinTable = findTable(tables, join.join_table);
		if (!joinTable) {
			throw new RelationRegistryError(`${at}: join_table '${join.join_table}' does not exist in table_registry`);
		}
		const mainColumn = findColumn(mainTable, join.main_column);
		if (!mainColumn) {
			throw new RelationRegistryError(`${at}: main_column '${join.main_column.column_uuid}' does not exist in main_table '${mainTable.name}'`);
		}
		const joinColumn = findColumn(joinTable, join.join_column);
		if (!joinColumn) {
			throw new RelationRegistryError(`${at}: join_column '${join.join_column.column_uuid}' does not exist in join_table '${joinTable.name}'`);
		}
		if (!isRelationType(join.relation_type)) {
			throw new RelationRegistryError(`${at}: relation_type '${String(join.relation_type)}' is not ${relationTypes.join(' | ')}`);
		}
		return Object.freeze({ joinTable, mainColumn, joinColumn, relationType: join.relation_type });
	});
	return Object.freeze({ uuid: entry.uuid, mainTable, joins: Object.freeze(joins) });
}

/** Validate of a whole `relation_registry` against `tables`: unique UUIDs and every reference resolves. */
export function validateRelationReferences(entries: readonly IRelationRegistryEntry[], tables: readonly ITableRegistryEntry[]): void {
	validateRelationRegistry(entries);
	for (const entry of entries) {
		resolveRelation(entry, tables);
	}
}

// #endregion

// #region App Editor Query Resolver (Logical JOIN)

/** One selected column of a Logical JOIN. */
export interface ILogicalJoinColumn {
	/** Result column name in the generated SQL. */
	readonly alias: string;
	/** `0` = main_table, `i` = `relations[i - 1]`. */
	readonly source: number;
	/** Column uuid; `undefined` for the Raw Data row identity. */
	readonly column: string | undefined;
}

export interface ILogicalJoinQuery {
	readonly relation: string;
	/** `table_registry.uuid` per source (`0` = main_table). */
	readonly tables: readonly string[];
	readonly sql: string;
	readonly columns: readonly ILogicalJoinColumn[];
}

const joinOperator: Readonly<Record<RelationType, string>> = Object.freeze({
	[RelationType.Inner]: 'INNER JOIN',
	[RelationType.Left]: 'LEFT JOIN',
	[RelationType.Right]: 'RIGHT JOIN',
	[RelationType.Full]: 'FULL JOIN',
});

/**
 * App Editor Query Resolver: the Logical JOIN of a resolved Relation on the Registry Physical
 * Schema. Every source gets its own alias (`t0` = main_table, `t<i>` = `relations[i - 1]`) so the
 * same table may be joined more than once; the ON clause is `t0.main_column = t<i>.join_column`.
 * The JOIN exists only in the query: no physical foreign key is read or required.
 */
export function generateLogicalJoinQuery(relation: IResolvedRelation): ILogicalJoinQuery {
	assertBoundaryFlow(BoundaryNode.Relation, BoundaryNode.LogicalJoin);
	const sources = [relation.mainTable, ...relation.joins.map(join => join.joinTable)];
	const columns: ILogicalJoinColumn[] = [];
	const select: string[] = [];
	sources.forEach((table, source) => {
		const selected = [undefined, ...[...table.columns].sort(compareTableRegistryOrder)];
		for (const column of selected) {
			const alias = `c${columns.length}`;
			select.push(`${quoteIdentifier(`t${source}`)}.${quoteIdentifier(column ? column.name : ROW_IDENTITY_COLUMN)} AS ${quoteIdentifier(alias)}`);
			columns.push(Object.freeze({ alias, source, column: column?.uuid }));
		}
	});
	const from = [`${quoteIdentifier(resolveRegistryPhysicalTable(relation.mainTable))} AS "t0"`];
	relation.joins.forEach((join, i) => {
		const alias = quoteIdentifier(`t${i + 1}`);
		from.push(`${joinOperator[join.relationType]} ${quoteIdentifier(resolveRegistryPhysicalTable(join.joinTable))} AS ${alias} ON "t0".${quoteIdentifier(join.mainColumn.name)} = ${alias}.${quoteIdentifier(join.joinColumn.name)}`);
	});
	return Object.freeze({
		relation: relation.uuid,
		tables: Object.freeze(sources.map(table => table.uuid)),
		sql: `SELECT ${select.join(', ')} FROM ${from.join(' ')}`,
		columns: Object.freeze(columns),
	});
}

/** The Raw Data row of one source in a Logical JOIN row; `undefined` when an outer join matched none. */
export interface ILogicalJoinSourceRow {
	/** Raw Data row identity. */
	readonly uuid: string;
	/** Physical values by column uuid. */
	readonly values: Readonly<Record<string, ProjectSqliteValue>>;
}

export type LogicalJoinRow = readonly (ILogicalJoinSourceRow | undefined)[];

/** Executes a Logical JOIN; each result row holds one Raw Data row (or `undefined`) per source. */
export async function queryLogicalJoin(statements: IProjectSqliteStatements, query: ILogicalJoinQuery): Promise<readonly LogicalJoinRow[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await statements.all(query.sql);
	return Object.freeze(rows.map(row => Object.freeze(query.tables.map((_, source) => {
		const selected = query.columns.filter(column => column.source === source);
		const identity = row[selected.find(column => column.column === undefined)!.alias];
		if (identity === null || identity === undefined) {
			return undefined;
		}
		const values: Record<string, ProjectSqliteValue> = {};
		for (const column of selected) {
			if (column.column !== undefined) {
				values[column.column] = row[column.alias] ?? null;
			}
		}
		return Object.freeze({ uuid: String(identity), values: Object.freeze(values) });
	}))));
}

// #endregion

// #region Storage (project.sqlite)

/** `registry.relation_registry`: the Registry schema table holding `relation_registry` entries. */
export const relationRegistryTable = Object.freeze({ schema: REGISTRY_SCHEMA, table: 'relation_registry' } as const);

export const relationRegistryPhysicalTable = corePhysicalTableNameResolver.resolve(relationRegistryTable.schema, relationRegistryTable.table);

const storedColumns = ['uuid', 'index', 'main_table', 'relations', 'created_at'] as const;

/** Stored form: scalars as columns, `relations` as one JSON list in the specification shape. */
export function encodeRelationRegistryRow(entry: IRelationRegistryEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		index: entry.index,
		main_table: entry.main_table,
		relations: JSON.stringify(entry.relations),
		created_at: entry.created_at,
	});
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeRelationRegistryRow(row: ProjectSqliteRow): IRelationRegistryEntry {
	const missingUuid = (): string => { throw new RelationRegistryError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	let relations: unknown;
	try {
		relations = JSON.parse(String(row.relations));
	} catch {
		throw new RelationRegistryError(`stored relation '${uuid}': relations is not JSON`);
	}
	if (!Array.isArray(relations)) {
		throw new RelationRegistryError(`stored relation '${uuid}': relations must be a JSON list`);
	}
	return createRelationRegistryEntry({
		uuid,
		index: row.index as number,
		main_table: row.main_table as string,
		relations: relations as IRelationRegistryJoinInput[],
		created_at: row.created_at as string,
	}, missingUuid);
}

/** `INSERT` statement and parameters writing `entry` into `registry.relation_registry`. */
export function getRelationRegistryInsert(entry: IRelationRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeRelationRegistryRow(entry);
	return Object.freeze({
		sql: `INSERT INTO ${quoteIdentifier(relationRegistryPhysicalTable)} (${storedColumns.map(quoteIdentifier).join(', ')}) VALUES (${storedColumns.map(() => '?').join(', ')})`,
		params: Object.freeze(storedColumns.map(column => row[column] as string | number)),
	});
}

/** `UPDATE` statement and parameters replacing the stored entry with Machine Identity `entry.uuid`. */
export function getRelationRegistryUpdate(entry: IRelationRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeRelationRegistryRow(entry);
	const assigned = storedColumns.filter(column => column !== 'uuid');
	return Object.freeze({
		sql: `UPDATE ${quoteIdentifier(relationRegistryPhysicalTable)} SET ${assigned.map(column => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE "uuid" = ?`,
		params: Object.freeze([...assigned.map(column => row[column] as string | number), entry.uuid]),
	});
}

/** `DELETE` statement and parameters removing the stored entry with Machine Identity `uuid`. */
export function getRelationRegistryDelete(uuid: string): { readonly sql: string; readonly params: readonly string[] } {
	return Object.freeze({
		sql: `DELETE FROM ${quoteIdentifier(relationRegistryPhysicalTable)} WHERE "uuid" = ?`,
		params: Object.freeze([normalizeRegistryUuid(uuid)]),
	});
}

/**
 * Reads every `relation_registry` entry from `project.sqlite` in Registry order (by `index`, then
 * UUID) for `Registry Load`. Each stored row is validated and relation UUIDs must be unique; the
 * references are validated against table_registry by {@link validateRelationReferences}.
 */
export async function readRelationRegistry(database: IProjectSqliteStatements): Promise<readonly IRelationRegistryEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(relationRegistryPhysicalTable)}`);
	const entries = rows.map(decodeRelationRegistryRow).sort(compareTableRegistryOrder);
	validateRelationRegistry(entries);
	return Object.freeze(entries);
}

/**
 * `Table DELETE -> Logical dependency cleanup` for relation_registry, run by the Registry Service in
 * the transaction of the drop: an entry whose `main_table` is the dropped table is deleted, and the
 * joins whose `join_table` is the dropped table are removed from every other entry.
 */
export async function cleanupRelationRegistryForDroppedTable(statements: IProjectSqliteStatements, dropped: Pick<ITableRegistryEntry, 'uuid'>): Promise<void> {
	const table = dropped.uuid.toLowerCase();
	for (const entry of await readRelationRegistry(statements)) {
		if (entry.main_table === table) {
			const write = getRelationRegistryDelete(entry.uuid);
			await statements.run(write.sql, write.params);
		} else if (entry.relations.some(join => join.join_table === table)) {
			const write = getRelationRegistryUpdate(Object.freeze({ ...entry, relations: Object.freeze(entry.relations.filter(join => join.join_table !== table)) }));
			await statements.run(write.sql, write.params);
		}
	}
}

export const relationRegistryDependencyCleanup = Object.freeze({
	cleanupDroppedTable: cleanupRelationRegistryForDroppedTable,
});

// #endregion
