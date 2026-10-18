/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - PostgreSQL schema and seed projection (build.postgresql)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. PostgreSQL Web Application Output)
 *--------------------------------------------------------------------------------------------*/

import { ApplicationOutputProjection, IApplicationOutput, projectApplicationOutput } from './applicationOutput.js';
import { IBuildAuthoringData, IBuildRawDataTable, POSTGRESQL_WEB_APPLICATION_OUTPUT } from './buildValidation.js';
import { expandRegistryPhysicalSchema, RegistryServiceError } from './registryPhysicalExpansion.js';
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { quoteIdentifier } from './projectSqlite.js';
import { compareTableRegistryOrder, isTableColumnValue, ITableRegistryColumn, ITableRegistryEntry, TableColumnKind } from './tableRegistry.js';

/**
 * `Registry -> Registry Resolve -> Logical Namespace Resolve -> Table / Column Resolve -> Kind
 * Dispatch -> PostgreSQL DDL Generate -> 001_init_postgresql.sql` and
 * `Raw Data -> Build Target Filter -> Value / Relation Resolve -> PostgreSQL DML Generate ->
 * 002_seed_data.sql`.
 *
 * The PostgreSQL Physical Schema is a Build Projection of the Registry (`Registry = Authority`).
 * It is never read back into the Registry, and project.sqlite is never used as Runtime Storage.
 * Relation / enum references are Logical (no physical foreign key), so the DDL has no `FOREIGN KEY`.
 */

// #region Errors

export const enum PostgresqlProjectionStage {
	RegistryResolve = 'Registry Resolve',
	LogicalNamespaceResolve = 'Logical Namespace Resolve',
	TableColumnResolve = 'Table / Column Resolve',
	KindDispatch = 'Kind Dispatch',
	ValueRelationResolve = 'Value / Relation Resolve',
}

export class PostgresqlProjectionError extends Error {
	constructor(readonly stage: PostgresqlProjectionStage, message: string) {
		super(`Primitive App Editor PostgreSQL projection (${stage}): ${message}`);
		this.name = 'PostgresqlProjectionError';
	}
}

// #endregion

// #region Kind Dispatch

/** Kind Dispatch table: every `table_registry` kind (8. kind) to its PostgreSQL column type. */
export const postgresqlKindTypes: Readonly<Record<TableColumnKind, string>> = Object.freeze({
	[TableColumnKind.Uuid]: 'UUID',
	[TableColumnKind.Text]: 'TEXT',
	[TableColumnKind.Int]: 'BIGINT',
	[TableColumnKind.Double]: 'DOUBLE PRECISION',
	[TableColumnKind.Bool]: 'BOOLEAN',
	[TableColumnKind.Date]: 'DATE',
	[TableColumnKind.Timestamp]: 'TIMESTAMPTZ',
	[TableColumnKind.Enum]: 'TEXT',
	[TableColumnKind.Json]: 'JSONB',
} satisfies Record<TableColumnKind, string>);

function dispatchPostgresqlKind(kind: TableColumnKind): string {
	const type = postgresqlKindTypes[kind];
	if (type === undefined) {
		throw new PostgresqlProjectionError(PostgresqlProjectionStage.KindDispatch, `unknown kind '${String(kind)}'`);
	}
	return type;
}

// #endregion

// #region PostgreSQL Physical Schema

/** PostgreSQL truncates identifiers longer than this many bytes, which would silently merge names. */
const MAX_IDENTIFIER_BYTES = 63;

/** Row identity column of every Physical Table. */
const ROW_IDENTITY = 'uuid';

export interface IPostgresqlColumn {
	readonly name: string;
	readonly type: string;
	readonly kind: TableColumnKind;
	readonly notNull: boolean;
	readonly searchable: boolean;
	/** `table_registry` column uuid; `undefined` for the row identity column. */
	readonly registryUuid: string | undefined;
}

export interface IPostgresqlTable {
	/** `table_registry` entry uuid. */
	readonly registryUuid: string;
	/** PostgreSQL schema = the Logical Namespace (`items | logs`). */
	readonly schema: string;
	readonly name: string;
	/** Row identity column first, then the Registry columns in Registry order. */
	readonly columns: readonly IPostgresqlColumn[];
}

export interface IPostgresqlSchema {
	readonly schemas: readonly string[];
	readonly tables: readonly IPostgresqlTable[];
}

function checkIdentifier(stage: PostgresqlProjectionStage, identifier: string, what: string): void {
	if (new TextEncoder().encode(identifier).length > MAX_IDENTIFIER_BYTES) {
		throw new PostgresqlProjectionError(stage, `${what} '${identifier}' exceeds ${MAX_IDENTIFIER_BYTES} bytes`);
	}
}

/**
 * `Registry Resolve -> Logical Namespace Resolve -> Table / Column Resolve -> Kind Dispatch`.
 * Only reads the Registry. The SQLite Physical Table Expansion validates the Registry (namespace,
 * names, row identity column) so both Physical Schemas reject exactly the same Registries.
 */
export function projectPostgresqlSchema(entries: readonly ITableRegistryEntry[]): IPostgresqlSchema {
	try {
		expandRegistryPhysicalSchema(entries);
	} catch (error) {
		throw error instanceof RegistryServiceError ? new PostgresqlProjectionError(PostgresqlProjectionStage.RegistryResolve, error.message.replace(/^Primitive App Editor Registry Service: /, '')) : error;
	}
	const owners = new Map<string, string>();
	const tables = [...entries].sort(compareTableRegistryOrder).map(entry => {
		checkIdentifier(PostgresqlProjectionStage.LogicalNamespaceResolve, entry.schema, 'schema');
		checkIdentifier(PostgresqlProjectionStage.TableColumnResolve, entry.name, 'table');
		const key = `${entry.schema}.${entry.name}`;
		if (owners.has(key)) {
			throw new PostgresqlProjectionError(PostgresqlProjectionStage.TableColumnResolve, `tables '${owners.get(key)}' and '${entry.name}' resolve to the same PostgreSQL table '${key}'`);
		}
		owners.set(key, entry.name);
		const columns: IPostgresqlColumn[] = [{ name: ROW_IDENTITY, type: 'UUID', kind: TableColumnKind.Uuid, notNull: true, searchable: false, registryUuid: undefined }];
		for (const column of [...entry.columns].sort(compareTableRegistryOrder)) {
			checkIdentifier(PostgresqlProjectionStage.TableColumnResolve, column.name, 'column');
			columns.push({ name: column.name, type: dispatchPostgresqlKind(column.kind), kind: column.kind, notNull: column.not_null, searchable: column.searchable, registryUuid: column.uuid });
		}
		return Object.freeze({ registryUuid: entry.uuid, schema: entry.schema, name: entry.name, columns: Object.freeze(columns.map(column => Object.freeze(column))) });
	});
	const schemas = [...new Set(tables.map(table => table.schema))].sort();
	return Object.freeze({ schemas: Object.freeze(schemas), tables: Object.freeze(tables) });
}

// #endregion

// #region DDL Generate

function qualifiedName(table: Pick<IPostgresqlTable, 'schema' | 'name'>): string {
	return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

/**
 * DDL Generate: `Required Runtime Schema` (`CREATE SCHEMA`), `CREATE TABLE`, `ALTER / Constraint`
 * (row identity primary key) and `Index` (searchable columns). No physical foreign key, trigger or
 * enum type: Relation and Enum stay Registry-level Logical references.
 */
export function generatePostgresqlDdl(schema: IPostgresqlSchema): string {
	const statements: string[] = [];
	for (const name of schema.schemas) {
		statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(name)};`);
	}
	for (const table of schema.tables) {
		const columns = table.columns.map(column => `\t${quoteIdentifier(column.name)} ${column.type}${column.notNull ? ' NOT NULL' : ''}`);
		statements.push(`CREATE TABLE ${qualifiedName(table)} (\n${columns.join(',\n')}\n);`);
	}
	for (const table of schema.tables) {
		const constraint = `pk_${table.schema}_${table.name}`;
		checkIdentifier(PostgresqlProjectionStage.TableColumnResolve, constraint, 'constraint');
		statements.push(`ALTER TABLE ${qualifiedName(table)} ADD CONSTRAINT ${quoteIdentifier(constraint)} PRIMARY KEY (${quoteIdentifier(ROW_IDENTITY)});`);
	}
	for (const table of schema.tables) {
		for (const column of table.columns.filter(column => column.searchable)) {
			const index = `idx_${table.schema}_${table.name}_${column.name}`;
			checkIdentifier(PostgresqlProjectionStage.TableColumnResolve, index, 'index');
			statements.push(`CREATE INDEX ${quoteIdentifier(index)} ON ${qualifiedName(table)} (${quoteIdentifier(column.name)});`);
		}
	}
	return `${statements.join('\n\n')}\n`;
}

// #endregion

// #region DML Generate

function textLiteral(value: string): string {
	if (value.includes('\0')) {
		throw new PostgresqlProjectionError(PostgresqlProjectionStage.ValueRelationResolve, 'a text value contains NUL, which PostgreSQL cannot store');
	}
	return `'${value.replace(/'/g, `''`)}'`;
}

/** Value Resolve: the PostgreSQL literal of a Raw Data value of `column` (already a valid value of its kind). */
function valueLiteral(kind: TableColumnKind, value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	switch (kind) {
		case TableColumnKind.Int:
		case TableColumnKind.Double:
			return String(value);
		case TableColumnKind.Bool:
			return value ? 'TRUE' : 'FALSE';
		case TableColumnKind.Json:
			return `${textLiteral(JSON.stringify(value))}::jsonb`;
		default:
			return textLiteral(String(value));
	}
}

function resolveSeedRows(table: IPostgresqlTable, entry: ITableRegistryEntry, data: IBuildRawDataTable): string[] {
	const columns = new Map(entry.columns.map((column: ITableRegistryColumn) => [normalizeRegistryUuid(column.uuid), column]));
	const seen = new Set<string>();
	return [...data.rows].sort((a, b) => a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0).map(row => {
		const where = `table '${entry.name}' row '${row.uuid}'`;
		if (!isRegistryUuid(row.uuid) || seen.has(normalizeRegistryUuid(row.uuid))) {
			throw new PostgresqlProjectionError(PostgresqlProjectionStage.ValueRelationResolve, `${where}: the Row identity must be a unique UUID`);
		}
		seen.add(normalizeRegistryUuid(row.uuid));
		const given = new Map<string, unknown>();
		for (const [key, value] of Object.entries(row.values)) {
			const column = columns.get(normalizeRegistryUuid(key));
			if (!column) {
				throw new PostgresqlProjectionError(PostgresqlProjectionStage.ValueRelationResolve, `${where}: value key '${key}' is not a column of the table`);
			}
			given.set(column.uuid, value);
		}
		const literals = table.columns.map(column => {
			if (column.registryUuid === undefined) {
				return textLiteral(normalizeRegistryUuid(row.uuid));
			}
			const value = given.get(column.registryUuid) ?? null;
			if (!isTableColumnValue({ kind: column.kind, not_null: column.notNull }, value)) {
				throw new PostgresqlProjectionError(PostgresqlProjectionStage.ValueRelationResolve, `${where} column '${column.name}': ${JSON.stringify(value)} is not a value of kind '${column.kind}'${column.notNull ? ' not_null' : ''}`);
			}
			return valueLiteral(column.kind, value);
		});
		return `(${literals.join(', ')})`;
	});
}

/**
 * Value / Relation Resolve + DML Generate: one `INSERT` per selected Physical Table, rows ordered by
 * Row identity. Relation values are plain UUID values (Logical references, no physical foreign key),
 * so no insertion order between tables is required. A table with no selected row emits nothing.
 */
export function generatePostgresqlSeedDml(schema: IPostgresqlSchema, entries: readonly ITableRegistryEntry[], seed: readonly IBuildRawDataTable[]): string {
	const tables = new Map(schema.tables.map(table => [normalizeRegistryUuid(table.registryUuid), table]));
	const registry = new Map(entries.map(entry => [normalizeRegistryUuid(entry.uuid), entry]));
	const statements: string[] = [];
	const seeded = new Set<string>();
	const order = new Map(schema.tables.map((table, index) => [normalizeRegistryUuid(table.registryUuid), index]));
	const position = (data: IBuildRawDataTable) => order.get(normalizeRegistryUuid(data.table_uuid)) ?? Number.MAX_SAFE_INTEGER;
	for (const data of [...seed].sort((a, b) => position(a) - position(b))) {
		const key = normalizeRegistryUuid(data.table_uuid);
		const table = tables.get(key);
		const entry = registry.get(key);
		if (!table || !entry) {
			throw new PostgresqlProjectionError(PostgresqlProjectionStage.ValueRelationResolve, `Raw Data table '${data.table_uuid}' is not in table_registry`);
		}
		if (seeded.has(key)) {
			throw new PostgresqlProjectionError(PostgresqlProjectionStage.ValueRelationResolve, `Raw Data table '${data.table_uuid}' appears twice in the Seed`);
		}
		seeded.add(key);
		const rows = resolveSeedRows(table, entry, data);
		if (rows.length > 0) {
			statements.push(`INSERT INTO ${qualifiedName(table)} (${table.columns.map(column => quoteIdentifier(column.name)).join(', ')}) VALUES\n${rows.map(row => `\t${row}`).join(',\n')};`);
		}
	}
	return statements.length === 0 ? '' : `${statements.join('\n\n')}\n`;
}

// #endregion

// #region Application Output Projection

export const POSTGRESQL_INIT_FILE = '001_init_postgresql.sql';
export const POSTGRESQL_SEED_FILE = '002_seed_data.sql';

/** One generated file, named relative to the PostgreSQL projection (the artifact layout is `build.deploy`'s). */
export interface IPostgresqlProjectionFile {
	readonly path: string;
	readonly content: string;
}

/** The PostgreSQL Projection of an Application Output. */
export interface IPostgresqlProjection {
	readonly schema: IPostgresqlSchema;
	/** `001_init_postgresql.sql` (DDL) then `002_seed_data.sql` (DML). The seed file is omitted when no Raw Data is selected. */
	readonly files: readonly IPostgresqlProjectionFile[];
}

/** `build_target` 'PostgreSQL Web Application Output': the Application Output -> PostgreSQL Projection. */
export const postgresqlApplicationOutputProjection: ApplicationOutputProjection<IPostgresqlProjection> = (output: IApplicationOutput) => {
	const entries = output.definition.schema.tables;
	const schema = projectPostgresqlSchema(entries);
	const files: IPostgresqlProjectionFile[] = [Object.freeze({ path: POSTGRESQL_INIT_FILE, content: generatePostgresqlDdl(schema) })];
	const seed = generatePostgresqlSeedDml(schema, entries, output.definition.data.seed);
	if (seed.length > 0) {
		files.push(Object.freeze({ path: POSTGRESQL_SEED_FILE, content: seed }));
	}
	return Object.freeze({ schema, files: Object.freeze(files) });
};

/** The Application Output Projections of `build.postgresql`, keyed by `build_target`. */
export const postgresqlApplicationOutputProjections: ReadonlyMap<string, ApplicationOutputProjection<IPostgresqlProjection>> = new Map([
	[POSTGRESQL_WEB_APPLICATION_OUTPUT, postgresqlApplicationOutputProjection],
]);

/** `Authoring Data + Build Configuration -> Build Validation -> Build Target Filter -> Application Output -> PostgreSQL Projection`. */
export function projectPostgresqlApplicationOutput(authoring: IBuildAuthoringData, input: unknown): { readonly output: IApplicationOutput; readonly result: IPostgresqlProjection } {
	return projectApplicationOutput(authoring, input, postgresqlApplicationOutputProjections);
}

// #endregion
