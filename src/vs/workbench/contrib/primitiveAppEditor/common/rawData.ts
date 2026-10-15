/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Raw Data CRUD over projected physical tables (data.raw)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (12. Raw Data, 9. Physical Table Expansion)
 *  Dispatch contract: docs/primitive-app-editor/Resolver.md (7 truncate, 9 insert, 10 delete, 11 update, 12 upsert, 13 select, 15 Service Dispatch)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { EnumRegistryIndex, getEnumValueLabel, isEnumColumnValue, readEnumRegistry } from './enumRegistry.js';
import {
	assertProjectSqliteAccess,
	IProjectSqliteDatabase,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	ProjectSqliteValue,
	quoteIdentifier,
} from './projectSqlite.js';
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { resolveRegistryPhysicalTable, ROW_IDENTITY_COLUMN, RegistryServiceError } from './registryPhysicalExpansion.js';
import { decodeRegistryPhysicalValue, encodeRegistryPhysicalValue, invalidRegistryPhysicalValue } from './registryService.js';
import { isTableColumnValue, ITableRegistryColumn, ITableRegistryEntry, readTableRegistry, TableColumnKind } from './tableRegistry.js';

/**
 * Raw Data = the Rows of a Physical Table (12. Raw Data).
 *
 * ```text
 * Registry            = Abstract (Authority)
 * Physical Table      = Schema Projection
 * Raw Row             = Concrete Application Data
 * ```
 *
 * Every operation is one generic Resolver dispatch (no per-application `update_enemy_hp()`): it resolves
 * the target table and its columns from `table_registry` (Registry Resolve), validates the payload
 * against the Registry (Kind Validate; `enum` values against `enum_registry`), maps it onto the
 * Physical Table (Payload Map) and runs one Storage Operation in one transaction. Registry
 * Definition is never changed here (`create / alter / drop` belong to the Registry Service) and
 * `truncate` never drops the table. The Physical Schema is not an Authority: it is only the
 * storage the Registry resolved.
 */

// #region Contract

export class RawDataError extends RegistryServiceError {
	constructor(message: string) {
		super(`Raw Data: ${message}`);
		this.name = 'RawDataError';
	}
}

/** Column values keyed by `table_registry` column UUID (Machine Identity) or column name; `uuid` is the Row identity. */
export type RawDataValues = Readonly<Record<string, unknown>>;

/** A Raw Data row: Row identity plus semantic values keyed by column UUID. */
export interface IRawDataRow {
	readonly uuid: string;
	readonly values: Readonly<Record<string, unknown>>;
	/** `select` with `resolveLabels`: human-readable label of an `enum` value, keyed by column UUID. */
	readonly labels?: Readonly<Record<string, string>>;
}

export interface IRawDataSelect {
	/** Equality conditions keyed by column UUID / name or `uuid` (Row identity); `null` matches NULL. */
	readonly where?: RawDataValues;
	/** Registry columns (UUID / name) or `uuid`, ascending; the Row identity is the final tiebreaker. */
	readonly orderBy?: readonly string[];
	readonly limit?: number;
	/** Result Mapping: resolve `enum` values to their `enum_registry` label for display. */
	readonly resolveLabels?: boolean;
}

export interface IRawDataMutationResult {
	readonly uuid: string;
	readonly row: IRawDataRow;
}

export interface IRawDataUpsertResult extends IRawDataMutationResult {
	/** `insert` when no Row had the Conflict Identity, otherwise `update`. */
	readonly operation: 'insert' | 'update';
}

export interface IRawDataServiceOptions {
	readonly generateUuid?: () => string;
}

// #endregion

// #region Registry Resolve / Payload Map

interface IResolvedTarget {
	readonly table: ITableRegistryEntry;
	readonly physical: string;
	readonly enums: EnumRegistryIndex;
}

function resolveColumn(target: IResolvedTarget, key: string): ITableRegistryColumn {
	const lower = key.toLowerCase();
	const matches = target.table.columns.filter(column => column.uuid === lower || column.name === key);
	if (matches.length !== 1) {
		throw new RawDataError(matches.length === 0
			? `table '${target.physical}' has no column '${key}' in the Registry`
			: `column '${key}' of table '${target.physical}' is ambiguous`);
	}
	return matches[0];
}

/** Kind Validate -> physical value. `enum` is validated against `enum_registry`. */
function mapValue(target: IResolvedTarget, column: ITableRegistryColumn, value: unknown): ProjectSqliteValue {
	const normalized = column.kind === TableColumnKind.Uuid && typeof value === 'string' && isRegistryUuid(value) ? normalizeRegistryUuid(value) : value;
	const valid = column.kind === TableColumnKind.Enum
		? isEnumColumnValue(target.enums, column, normalized)
		: isTableColumnValue(column, normalized);
	if (!valid) {
		throw new RawDataError(`table '${target.physical}' column '${column.name}': ${JSON.stringify(value) ?? 'undefined'} is not a value of kind '${column.kind}'${column.not_null ? ' not_null' : ''}`);
	}
	return encodeRegistryPhysicalValue(column.kind, normalized);
}

function physicalIdentity(value: unknown, where: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new RawDataError(`${where} must be a UUID`);
	}
	return normalizeRegistryUuid(value);
}

interface IMappedPayload {
	readonly uuid: string | undefined;
	readonly columns: ReadonlyMap<ITableRegistryColumn, ProjectSqliteValue>;
}

function mapPayload(target: IResolvedTarget, values: RawDataValues): IMappedPayload {
	let uuid: string | undefined;
	const columns = new Map<ITableRegistryColumn, ProjectSqliteValue>();
	for (const [key, value] of Object.entries(values)) {
		if (key === ROW_IDENTITY_COLUMN) {
			uuid = physicalIdentity(value, `table '${target.physical}' row identity '${ROW_IDENTITY_COLUMN}'`);
			continue;
		}
		const column = resolveColumn(target, key);
		if (columns.has(column)) {
			throw new RawDataError(`table '${target.physical}' column '${column.name}' is given more than once`);
		}
		columns.set(column, mapValue(target, column, value));
	}
	return { uuid, columns };
}

function mapRow(target: IResolvedTarget, row: ProjectSqliteRow, resolveLabels = false): IRawDataRow {
	const values: Record<string, unknown> = {};
	const labels: Record<string, string> = {};
	for (const column of target.table.columns) {
		const stored = row[column.name] ?? null;
		const decoded = decodeRegistryPhysicalValue(column.kind, stored);
		if (decoded === invalidRegistryPhysicalValue) {
			throw new RawDataError(`table '${target.physical}' row '${String(row[ROW_IDENTITY_COLUMN])}' column '${column.name}': stored ${JSON.stringify(stored)} is not a value of kind '${column.kind}'`);
		}
		values[column.uuid] = decoded;
		if (resolveLabels && column.kind === TableColumnKind.Enum && typeof decoded === 'string') {
			const label = getEnumValueLabel(target.enums.resolveColumn(column), decoded);
			if (label !== undefined) {
				labels[column.uuid] = label;
			}
		}
	}
	return Object.freeze({
		uuid: String(row[ROW_IDENTITY_COLUMN]),
		values: Object.freeze(values),
		...(resolveLabels ? { labels: Object.freeze(labels) } : {}),
	});
}

// #endregion

// #region Raw Data Service

export class RawDataService {

	private readonly generateUuid: () => string;

	constructor(private readonly database: Pick<IProjectSqliteDatabase, 'transaction'>, options: IRawDataServiceOptions = {}) {
		this.generateUuid = options.generateUuid ?? generateRandomUuid;
	}

	/** `insert(request)`: Target Kind Resolve -> Registry Resolve -> Payload Map -> INSERT. The Row uuid is generated when missing. */
	insert(tableUuid: string, values: RawDataValues): Promise<IRawDataMutationResult> {
		return this.run(tableUuid, async (statements, target) => {
			const payload = mapPayload(target, values);
			const uuid = payload.uuid ?? this.generateUuid();
			if (await this.findRow(statements, target, uuid)) {
				throw new RawDataError(`table '${target.physical}' already has a row '${uuid}'`);
			}
			this.assertRequiredColumns(target, payload);
			await this.insertRow(statements, target, uuid, payload);
			return { uuid, row: await this.readRow(statements, target, uuid) };
		});
	}

	/** `update(request)`: Target UUID Resolve -> Registry Resolve -> Kind Validate -> Payload Map -> UPDATE. Row identity is never changed. */
	update(tableUuid: string, uuid: string, values: RawDataValues): Promise<IRawDataMutationResult> {
		return this.run(tableUuid, async (statements, target) => {
			const rowUuid = physicalIdentity(uuid, 'update target uuid');
			const payload = mapPayload(target, values);
			if (payload.uuid !== undefined && payload.uuid !== rowUuid) {
				throw new RawDataError(`update cannot change the row identity '${rowUuid}'`);
			}
			if (payload.columns.size === 0) {
				throw new RawDataError('update requires at least one column value');
			}
			await this.requireRow(statements, target, rowUuid);
			await this.updateRow(statements, target, rowUuid, payload);
			return { uuid: rowUuid, row: await this.readRow(statements, target, rowUuid) };
		});
	}

	/**
	 * `upsert(request)`: the Conflict Identity is resolved from the Registry projection, which defines
	 * exactly one unique identity for Raw Data: the Row identity `uuid` (PRIMARY KEY). It is never guessed:
	 * a request without it is rejected.
	 */
	upsert(tableUuid: string, values: RawDataValues): Promise<IRawDataUpsertResult> {
		return this.run(tableUuid, async (statements, target) => {
			const payload = mapPayload(target, values);
			if (payload.uuid === undefined) {
				throw new RawDataError(`upsert on table '${target.physical}' requires the Conflict Identity '${ROW_IDENTITY_COLUMN}'`);
			}
			const uuid = payload.uuid;
			if (await this.findRow(statements, target, uuid)) {
				if (payload.columns.size > 0) {
					await this.updateRow(statements, target, uuid, payload);
				}
				return { operation: 'update' as const, uuid, row: await this.readRow(statements, target, uuid) };
			}
			this.assertRequiredColumns(target, payload);
			await this.insertRow(statements, target, uuid, payload);
			return { operation: 'insert' as const, uuid, row: await this.readRow(statements, target, uuid) };
		});
	}

	/** `delete(request)`: Target Resolve -> Registry Validate -> DELETE of one Row. */
	delete(tableUuid: string, uuid: string): Promise<IRawDataRow> {
		return this.run(tableUuid, async (statements, target) => {
			const rowUuid = physicalIdentity(uuid, 'delete target uuid');
			const row = await this.readRow(statements, target, rowUuid);
			await statements.run(`DELETE FROM ${quoteIdentifier(target.physical)} WHERE ${quoteIdentifier(ROW_IDENTITY_COLUMN)} = ?`, [rowUuid]);
			return row;
		});
	}

	/** `truncate(request)`: Data Removal of every Row; the Registry Definition and the Physical Table remain. */
	truncate(tableUuid: string): Promise<number> {
		return this.run(tableUuid, async (statements, target) => {
			const result = await statements.run(`DELETE FROM ${quoteIdentifier(target.physical)}`);
			return result.changes;
		});
	}

	/** `select(request)`: Target Resolve -> Registry Resolve -> Query Map -> SELECT -> Result Mapping. */
	select(tableUuid: string, request: IRawDataSelect = {}): Promise<readonly IRawDataRow[]> {
		return this.run(tableUuid, async (statements, target) => {
			const conditions: string[] = [];
			const params: ProjectSqliteValue[] = [];
			for (const [key, value] of Object.entries(request.where ?? {})) {
				if (key === ROW_IDENTITY_COLUMN) {
					conditions.push(`${quoteIdentifier(ROW_IDENTITY_COLUMN)} = ?`);
					params.push(physicalIdentity(value, `where '${ROW_IDENTITY_COLUMN}'`));
					continue;
				}
				const column = resolveColumn(target, key);
				if (value === null) {
					conditions.push(`${quoteIdentifier(column.name)} IS NULL`);
				} else {
					conditions.push(`${quoteIdentifier(column.name)} = ?`);
					params.push(mapValue(target, { ...column, not_null: true }, value));
				}
			}
			const order = (request.orderBy ?? []).map(key => key === ROW_IDENTITY_COLUMN ? quoteIdentifier(ROW_IDENTITY_COLUMN) : quoteIdentifier(resolveColumn(target, key).name));
			order.push(quoteIdentifier(ROW_IDENTITY_COLUMN));
			let sql = `SELECT * FROM ${quoteIdentifier(target.physical)}`;
			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(' AND ')}`;
			}
			sql += ` ORDER BY ${order.join(', ')}`;
			if (request.limit !== undefined) {
				if (!Number.isSafeInteger(request.limit) || request.limit < 0) {
					throw new RawDataError('select limit must be a non-negative int');
				}
				sql += ` LIMIT ${request.limit}`;
			}
			const rows = await statements.all(sql, params);
			return Object.freeze(rows.map(row => mapRow(target, row, request.resolveLabels)));
		});
	}

	// #region Storage Operation

	/** One Storage Operation in one transaction; Registry Resolve first (Registry = Authority). */
	private run<T>(tableUuid: string, work: (statements: IProjectSqliteStatements, target: IResolvedTarget) => Promise<T>): Promise<T> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		return this.database.transaction(async statements => {
			const uuid = physicalIdentity(tableUuid, 'target table uuid');
			const tables = await readTableRegistry(statements);
			const table = tables.find(entry => entry.uuid === uuid);
			if (!table) {
				throw new RawDataError(`table_registry has no table '${tableUuid}' (Missing Definition)`);
			}
			const physical = resolveRegistryPhysicalTable(table);
			const exists = await statements.get(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`, [physical]);
			if (!exists) {
				throw new RawDataError(`table '${physical}' is not projected onto project.sqlite; expand the Registry first`);
			}
			const enums = new EnumRegistryIndex(await readEnumRegistry(statements));
			return work(statements, { table, physical, enums });
		});
	}

	private assertRequiredColumns(target: IResolvedTarget, payload: IMappedPayload): void {
		for (const column of target.table.columns) {
			const value = [...payload.columns].find(([given]) => given === column)?.[1];
			if (column.not_null && (value === undefined || value === null)) {
				throw new RawDataError(`table '${target.physical}' column '${column.name}' is not_null and requires a value`);
			}
		}
	}

	private async insertRow(statements: IProjectSqliteStatements, target: IResolvedTarget, uuid: string, payload: IMappedPayload): Promise<void> {
		const names = [ROW_IDENTITY_COLUMN, ...[...payload.columns.keys()].map(column => column.name)];
		const params: ProjectSqliteValue[] = [uuid, ...payload.columns.values()];
		await statements.run(
			`INSERT INTO ${quoteIdentifier(target.physical)} (${names.map(quoteIdentifier).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
			params);
	}

	private async updateRow(statements: IProjectSqliteStatements, target: IResolvedTarget, uuid: string, payload: IMappedPayload): Promise<void> {
		const assignments = [...payload.columns.keys()].map(column => `${quoteIdentifier(column.name)} = ?`);
		await statements.run(
			`UPDATE ${quoteIdentifier(target.physical)} SET ${assignments.join(', ')} WHERE ${quoteIdentifier(ROW_IDENTITY_COLUMN)} = ?`,
			[...payload.columns.values(), uuid]);
	}

	private findRow(statements: IProjectSqliteStatements, target: IResolvedTarget, uuid: string): Promise<ProjectSqliteRow | undefined> {
		return statements.get(`SELECT * FROM ${quoteIdentifier(target.physical)} WHERE ${quoteIdentifier(ROW_IDENTITY_COLUMN)} = ?`, [uuid]);
	}

	private async requireRow(statements: IProjectSqliteStatements, target: IResolvedTarget, uuid: string): Promise<ProjectSqliteRow> {
		const row = await this.findRow(statements, target, uuid);
		if (!row) {
			throw new RawDataError(`table '${target.physical}' has no row '${uuid}'`);
		}
		return row;
	}

	private async readRow(statements: IProjectSqliteStatements, target: IResolvedTarget, uuid: string): Promise<IRawDataRow> {
		return mapRow(target, await this.requireRow(statements, target, uuid));
	}

	// #endregion
}

// #endregion
