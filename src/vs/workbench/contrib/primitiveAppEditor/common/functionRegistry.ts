/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_registry (function.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (13. Function, 14. function_registry, 15. Function Definition Contract)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	quoteIdentifier,
	REGISTRY_SCHEMA,
} from './projectSqlite.js';
import { ensureRegistryIdentity, IRegistryIdentity, normalizeRegistryUuid, RegistryIdentityError } from './registryIdentity.js';
import { compareTableRegistryOrder, isTimestampValue } from './tableRegistry.js';

/**
 * `function_registry` = the Registry entry of one Function Definition: its Machine Identity /
 * human naming, the `executor` that runs it, and its `input` / `constructor` / `parameters` /
 * `output` signature (each stored as one JSON value).
 *
 * `Function Primitive = Code` and `Function Definition = Registry`: the Registry holds the
 * definition only. `Function Instance` and `Function Output` are Runtime Memory and are never
 * stored here (Function execution values are not saved to SQLite sequentially).
 *
 * Function Definition Contract: `Registry -> an executor that does not exist in Code is not allowed` is enforced by
 * {@link validateFunctionRegistryExecutors} / {@link readFunctionRegistry} against an
 * {@link IFunctionExecutorCatalog} (the executors that exist in Code). `Runtime ->
 * never completes an undefined Formula` is a Runtime rule: this module never derives or completes a
 * definition that is not in the Registry.
 *
 * Function Binding / Build / Execution Plan are owned by later bundles; `kind` of
 * `input` / `constructor` / `parameters` / `output` is `text` in the specification, so it is kept
 * as non-empty text here and its vocabulary is not invented.
 */

// #region function_registry

/** One `input` element. */
export interface IFunctionRegistryInput {
	readonly name: string;
	readonly kind: string;
}

/** One `constructor` / `parameters` element. `default` is any JSON value; absent = no default. */
export interface IFunctionRegistryArgument extends IFunctionRegistryInput {
	readonly default?: unknown;
}

/** `output`. */
export interface IFunctionRegistryOutput {
	readonly kind: string;
}

/** One `function_registry` entry. */
export interface IFunctionRegistryEntry extends IRegistryIdentity {
	readonly index: number;
	readonly executor: string;
	readonly input: readonly IFunctionRegistryInput[];
	readonly constructor: readonly IFunctionRegistryArgument[];
	readonly parameters: readonly IFunctionRegistryArgument[];
	readonly output: IFunctionRegistryOutput;
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** An INSERT / Seed input: the UUID is generated and `created_at` stamped when missing. */
export interface IFunctionRegistryEntryInput {
	readonly uuid?: string;
	readonly index: number;
	readonly name: string;
	readonly label?: string;
	readonly executor: string;
	readonly input?: readonly IFunctionRegistryInput[];
	/** Required by type: an object type inherits `Object.prototype.constructor`, so an optional `constructor` cannot be omitted. */
	readonly constructor: readonly IFunctionRegistryArgument[];
	readonly parameters?: readonly IFunctionRegistryArgument[];
	readonly output: IFunctionRegistryOutput;
	readonly created_at?: string;
}

export class FunctionRegistryError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor function_registry: ${message}`);
		this.name = 'FunctionRegistryError';
	}
}

function withLabel<T extends object>(base: T, label: string | undefined): T & { label?: string } {
	return label === undefined || label === '' ? base : { ...base, label };
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return true;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (typeof value === 'object') {
		const prototype = Object.getPrototypeOf(value);
		return (prototype === Object.prototype || prototype === null) && Object.values(value as object).every(isJsonValue);
	}
	return false;
}

function requireText(value: unknown, field: string, where: string): string {
	if (typeof value !== 'string' || value === '') {
		throw new FunctionRegistryError(`${where}: ${field} must be non-empty text`);
	}
	return value;
}

function createArguments(list: unknown, field: 'input' | 'constructor' | 'parameters', allowDefault: boolean, where: string): readonly IFunctionRegistryArgument[] {
	if (list === undefined) {
		return Object.freeze([]);
	}
	if (!Array.isArray(list)) {
		throw new FunctionRegistryError(`${where}: ${field} must be a list`);
	}
	const names = new Set<string>();
	return Object.freeze(list.map(item => {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			throw new FunctionRegistryError(`${where}: every ${field} element must be an object`);
		}
		const record = item as Record<string, unknown>;
		const name = requireText(record.name, `${field} name`, where);
		const at = `${where} ${field} '${name}'`;
		const kind = requireText(record.kind, 'kind', at);
		if (names.has(name)) {
			throw new FunctionRegistryError(`${where}: duplicate ${field} name '${name}'`);
		}
		names.add(name);
		if ('default' in record && record.default !== undefined) {
			if (!allowDefault) {
				throw new FunctionRegistryError(`${at}: input has no default`);
			}
			if (!isJsonValue(record.default)) {
				throw new FunctionRegistryError(`${at}: default must be a JSON value`);
			}
			return Object.freeze({ name, kind, default: record.default });
		}
		return Object.freeze({ name, kind });
	}));
}

/**
 * Builds a validated `function_registry` entry: a missing UUID is generated and a supplied one
 * kept (7. Generate), `index` is an int, `executor` is non-empty text, `input` /
 * `constructor` / `parameters` are lists of `{name, kind}` (`default` for `constructor` /
 * `parameters` only) with names unique within each list, `output.kind` is text and `created_at` a
 * timestamp. Function name uniqueness is not part of this contract. Whether `executor` exists in
 * Code is {@link validateFunctionRegistryExecutors}.
 */
export function createFunctionRegistryEntry(
	input: IFunctionRegistryEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IFunctionRegistryEntry {
	let identity: IRegistryIdentity;
	try {
		identity = ensureRegistryIdentity(input, generateUuid);
	} catch (error) {
		throw error instanceof RegistryIdentityError ? new FunctionRegistryError(error.message) : error;
	}
	const where = `function '${identity.name}'`;
	if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) {
		throw new FunctionRegistryError(`${where}: index must be an int`);
	}
	const executor = requireText(input.executor, 'executor', where);
	if (typeof input.output !== 'object' || input.output === null || Array.isArray(input.output)) {
		throw new FunctionRegistryError(`${where}: output must be an object with a kind`);
	}
	const output = Object.freeze({ kind: requireText(input.output.kind, 'output kind', where) });
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new FunctionRegistryError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze(withLabel({
		uuid: identity.uuid,
		index: input.index,
		name: identity.name,
		executor,
		input: createArguments(input.input, 'input', false, where) as readonly IFunctionRegistryInput[],
		constructor: createArguments(Object.prototype.hasOwnProperty.call(input, 'constructor') ? input.constructor : undefined, 'constructor', true, where),
		parameters: createArguments(input.parameters, 'parameters', true, where),
		output,
		created_at: new Date(createdAt).toISOString(),
	}, identity.label));
}

/** Validates a set of entries of one `function_registry`: function UUIDs are unique. */
export function validateFunctionRegistry(entries: readonly IFunctionRegistryEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		const uuid = normalizeRegistryUuid(entry.uuid);
		if (uuids.has(uuid)) {
			throw new FunctionRegistryError(`duplicate function uuid for '${entry.name}'`);
		}
		uuids.add(uuid);
	}
}

// #endregion

// #region Executor (Code)

/** The `executor` names that exist in Code (`Function Primitive = Code`). The Registry never adds to it. */
export interface IFunctionExecutorCatalog {
	has(executor: string): boolean;
}

/** An {@link IFunctionExecutorCatalog} over a fixed list of executor names. */
export function createFunctionExecutorCatalog(executors: Iterable<string>): IFunctionExecutorCatalog {
	const known = new Set(executors);
	return Object.freeze({ has: (executor: string) => known.has(executor) });
}

/** `Registry -> an executor that does not exist in Code is not allowed`: every entry's `executor` must exist in Code. */
export function validateFunctionRegistryExecutors(entries: readonly Pick<IFunctionRegistryEntry, 'name' | 'executor'>[], catalog: IFunctionExecutorCatalog): void {
	for (const entry of entries) {
		if (!catalog.has(entry.executor)) {
			throw new FunctionRegistryError(`function '${entry.name}': executor '${entry.executor}' does not exist in Code`);
		}
	}
}

// #endregion

// #region Storage (project.sqlite)

/** `registry.function_registry`: the Registry schema table holding `function_registry` entries. */
export const functionRegistryTable = Object.freeze({ schema: REGISTRY_SCHEMA, table: 'function_registry' } as const);

export const functionRegistryPhysicalTable = corePhysicalTableNameResolver.resolve(functionRegistryTable.schema, functionRegistryTable.table);

const storedColumns = ['uuid', 'index', 'name', 'label', 'executor', 'input', 'constructor', 'parameters', 'output', 'created_at'] as const;

/** Stored form: scalars as columns, `input` / `constructor` / `parameters` / `output` as JSON, an absent label as `''`. */
export function encodeFunctionRegistryRow(entry: IFunctionRegistryEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		index: entry.index,
		name: entry.name,
		label: entry.label ?? '',
		executor: entry.executor,
		input: JSON.stringify(entry.input.map(item => ({ name: item.name, kind: item.kind }))),
		constructor: JSON.stringify(entry.constructor.map(item => ({ ...item }))),
		parameters: JSON.stringify(entry.parameters.map(item => ({ ...item }))),
		output: JSON.stringify({ kind: entry.output.kind }),
		created_at: entry.created_at,
	});
}

function parseJson(row: ProjectSqliteRow, field: 'input' | 'constructor' | 'parameters' | 'output', uuid: string): unknown {
	try {
		return JSON.parse(String(row[field]));
	} catch {
		throw new FunctionRegistryError(`stored function '${uuid}': ${field} is not JSON`);
	}
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeFunctionRegistryRow(row: ProjectSqliteRow): IFunctionRegistryEntry {
	const missingUuid = (): string => { throw new FunctionRegistryError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	return createFunctionRegistryEntry({
		uuid,
		index: row.index as number,
		name: row.name as string,
		label: typeof row.label === 'string' ? row.label : undefined,
		executor: row.executor as string,
		input: parseJson(row, 'input', uuid) as IFunctionRegistryInput[],
		constructor: parseJson(row, 'constructor', uuid) as IFunctionRegistryArgument[],
		parameters: parseJson(row, 'parameters', uuid) as IFunctionRegistryArgument[],
		output: parseJson(row, 'output', uuid) as IFunctionRegistryOutput,
		created_at: row.created_at as string,
	}, missingUuid);
}

/** `INSERT` statement and parameters writing `entry` into `registry.function_registry`. */
export function getFunctionRegistryInsert(entry: IFunctionRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeFunctionRegistryRow(entry);
	return Object.freeze({
		sql: `INSERT INTO ${quoteIdentifier(functionRegistryPhysicalTable)} (${storedColumns.map(quoteIdentifier).join(', ')}) VALUES (${storedColumns.map(() => '?').join(', ')})`,
		params: Object.freeze(storedColumns.map(column => row[column] as string | number)),
	});
}

/**
 * Reads every `function_registry` entry from `project.sqlite` in Registry order (by `index`, then
 * UUID) for the `Registry Load` / `Function Scan` steps of Open. Each stored row is validated,
 * function UUIDs must be unique and every `executor` must exist in Code (`catalog`).
 */
export async function readFunctionRegistry(database: IProjectSqliteStatements, catalog: IFunctionExecutorCatalog): Promise<readonly IFunctionRegistryEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionRegistryPhysicalTable)}`);
	const entries = rows.map(decodeFunctionRegistryRow).sort(compareTableRegistryOrder);
	validateFunctionRegistry(entries);
	validateFunctionRegistryExecutors(entries, catalog);
	return Object.freeze(entries);
}

// #endregion
