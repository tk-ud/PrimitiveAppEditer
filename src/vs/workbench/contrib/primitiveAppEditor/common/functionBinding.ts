/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_binding (binding.function)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (19. Function Binding, 23. Runtime Addressing / Persistent Address)
 *  Dispatch contract: docs/primitive-app-editor/Resolver.md (3 Request Model, 9 insert, 10 delete, 11 update, 12 upsert, 13 select, 14 Registry Resolve)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode, Composition, isComposition } from './authority.js';
import {
	IFunctionExecutorCatalog,
	IFunctionRegistryEntry,
	readFunctionRegistry,
} from './functionRegistry.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	IProjectSqliteDatabase,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	ProjectSqliteValue,
	quoteIdentifier,
} from './projectSqlite.js';
import { getRegistryDisplayText, isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { compareTableRegistryOrder, isTimestampValue, ITableRegistryEntry, readTableRegistry } from './tableRegistry.js';

/**
 * `function_binding` = one concrete Function Binding (a concrete Data row, not a Registry
 * Definition): which Function Definition (`function.uuid` -> `function_registry.uuid`) runs, with
 * which `constructor` values, `execution.kind`, `inputs` / `parameters` (each by `source`) and which
 * `target` Persistent Address it writes to, with the `target.merge.kind` selecting the merge policy.
 *
 * `Persistent Address` = `{ table_uuid, row_uuid, column_uuid }`: UUIDs only (`UUID = resolve only`).
 * Human Display (`Player` then `Fatigue` as a tree) is derived from `table_registry` name / label when shown
 * ({@link resolveFunctionBindingAddressDisplay}) and is never stored.
 *
 * Merge semantics (overwrite / overlay), Function Dependency, Execution Plan and Runtime
 * resolution belong to later bundles: here `merge.kind` is only validated as a known Composition
 * and `source: function_output` only carries the producer binding UUID.
 */

// #region function_binding

/** `Source`. */
export const enum FunctionBindingSource {
	Constant = 'constant',
	State = 'state',
	Input = 'input',
	Time = 'time',
	Progress = 'progress',
	Event = 'event',
	FunctionOutput = 'function_output',
}

export const functionBindingSources: readonly FunctionBindingSource[] = Object.freeze([
	FunctionBindingSource.Constant,
	FunctionBindingSource.State,
	FunctionBindingSource.Input,
	FunctionBindingSource.Time,
	FunctionBindingSource.Progress,
	FunctionBindingSource.Event,
	FunctionBindingSource.FunctionOutput,
]);

export function isFunctionBindingSource(value: unknown): value is FunctionBindingSource {
	return (functionBindingSources as readonly unknown[]).includes(value);
}

/** `execution.kind`: `tick | event | input`. */
export const enum FunctionBindingExecutionKind {
	Tick = 'tick',
	Event = 'event',
	Input = 'input',
}

export const functionBindingExecutionKinds: readonly FunctionBindingExecutionKind[] = Object.freeze([
	FunctionBindingExecutionKind.Tick,
	FunctionBindingExecutionKind.Event,
	FunctionBindingExecutionKind.Input,
]);

export function isFunctionBindingExecutionKind(value: unknown): value is FunctionBindingExecutionKind {
	return (functionBindingExecutionKinds as readonly unknown[]).includes(value);
}

/** `Persistent Address`. */
export interface IFunctionBindingAddress {
	readonly table_uuid: string;
	readonly row_uuid: string;
	readonly column_uuid: string;
}

/** One `inputs` / `parameters` element: `source` plus the member that source needs. */
export interface IFunctionBindingArgument {
	readonly source: FunctionBindingSource | string;
	/** `source: constant`. Any JSON value. */
	readonly value?: unknown;
	/** `source: state`. */
	readonly address?: IFunctionBindingAddress;
	/** `source: function_output`: `function_binding.uuid` of the producing binding. */
	readonly function_binding_uuid?: string;
}

export interface IFunctionBindingTarget {
	readonly address: IFunctionBindingAddress;
	readonly merge: { readonly kind: Composition };
}

/** One `function_binding` entry. */
export interface IFunctionBindingEntry {
	readonly uuid: string;
	readonly index: number;
	readonly function: { readonly uuid: string };
	/** `constructor` values keyed by `function_registry.constructor[].name`. */
	readonly constructor: Readonly<Record<string, unknown>>;
	readonly execution: { readonly kind: FunctionBindingExecutionKind };
	readonly inputs: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly parameters: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly target: IFunctionBindingTarget;
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** An INSERT / UPSERT input: the UUID is generated and `created_at` stamped when missing. */
export interface IFunctionBindingEntryInput {
	readonly uuid?: string;
	readonly index: number;
	readonly function: { readonly uuid: string };
	/** Required by type: an object type inherits `Object.prototype.constructor`, so an optional `constructor` cannot be omitted. */
	readonly constructor: Readonly<Record<string, unknown>>;
	readonly execution: { readonly kind: FunctionBindingExecutionKind | string };
	readonly inputs?: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly parameters?: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly target: { readonly address: IFunctionBindingAddress; readonly merge: { readonly kind: Composition | string } };
	readonly created_at?: string;
}

export class FunctionBindingError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor function_binding: ${message}`);
		this.name = 'FunctionBindingError';
	}
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string, where: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new FunctionBindingError(`${where}: ${field} must be a UUID`);
	}
	return normalizeRegistryUuid(value);
}

/** `Persistent Address`: three UUIDs, normalized to the stored lower-case form. Nothing else is accepted. */
export function createFunctionBindingAddress(address: unknown, where: string): IFunctionBindingAddress {
	if (!isPlainRecord(address)) {
		throw new FunctionBindingError(`${where}: address must be an object`);
	}
	for (const key of Object.keys(address)) {
		if (key !== 'table_uuid' && key !== 'row_uuid' && key !== 'column_uuid') {
			throw new FunctionBindingError(`${where}: address has unknown member '${key}'`);
		}
	}
	return Object.freeze({
		table_uuid: requireUuid(address.table_uuid, 'address table_uuid', where),
		row_uuid: requireUuid(address.row_uuid, 'address row_uuid', where),
		column_uuid: requireUuid(address.column_uuid, 'address column_uuid', where),
	});
}

function createArgument(raw: unknown, where: string): IFunctionBindingArgument {
	if (!isPlainRecord(raw)) {
		throw new FunctionBindingError(`${where}: must be an object with a source`);
	}
	const source = raw.source;
	if (!isFunctionBindingSource(source)) {
		throw new FunctionBindingError(`${where}: source '${String(source)}' is not one of ${functionBindingSources.join(' | ')}`);
	}
	const allowed = new Set<string>(['source']);
	let argument: IFunctionBindingArgument;
	switch (source) {
		case FunctionBindingSource.Constant: {
			allowed.add('value');
			if (raw.value === undefined) {
				throw new FunctionBindingError(`${where}: source constant requires a value`);
			}
			if (!isJsonValue(raw.value)) {
				throw new FunctionBindingError(`${where}: constant value must be a JSON value`);
			}
			argument = { source, value: raw.value };
			break;
		}
		case FunctionBindingSource.State: {
			allowed.add('address');
			argument = { source, address: createFunctionBindingAddress(raw.address, where) };
			break;
		}
		case FunctionBindingSource.FunctionOutput: {
			allowed.add('function_binding_uuid');
			argument = { source, function_binding_uuid: requireUuid(raw.function_binding_uuid, 'function_binding_uuid', where) };
			break;
		}
		default:
			argument = { source };
	}
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			throw new FunctionBindingError(`${where}: source ${source} does not take '${key}'`);
		}
	}
	return Object.freeze(argument);
}

function createArguments(raw: unknown, field: 'inputs' | 'parameters', where: string): Readonly<Record<string, IFunctionBindingArgument>> {
	if (raw === undefined) {
		return Object.freeze({});
	}
	if (!isPlainRecord(raw)) {
		throw new FunctionBindingError(`${where}: ${field} must be an object keyed by name`);
	}
	const result: Record<string, IFunctionBindingArgument> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (name === '') {
			throw new FunctionBindingError(`${where}: ${field} name must be non-empty text`);
		}
		result[name] = createArgument(value, `${where} ${field} '${name}'`);
	}
	return Object.freeze(result);
}

/**
 * Builds a validated `function_binding` entry: a missing UUID is generated and a supplied one kept
 * (7. Generate), `index` is an int, `function.uuid` is a UUID, `execution.kind` is `tick | event |
 * input`, every `inputs` / `parameters` element has a known `source` with exactly the member that
 * source needs, and `target` has a Persistent Address and a known `merge.kind`. Whether the
 * referenced Function / Table / Column exist is {@link FunctionBindingService} (Registry Resolve).
 */
export function createFunctionBindingEntry(
	input: IFunctionBindingEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IFunctionBindingEntry {
	const uuid = input.uuid === undefined || input.uuid === '' ? generateUuid() : input.uuid;
	if (!isRegistryUuid(uuid)) {
		throw new FunctionBindingError(`'${uuid}' is not a UUID`);
	}
	const where = `binding '${uuid.toLowerCase()}'`;
	if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) {
		throw new FunctionBindingError(`${where}: index must be an int`);
	}
	if (!isPlainRecord(input.function)) {
		throw new FunctionBindingError(`${where}: function must be an object with a uuid`);
	}
	const functionUuid = requireUuid(input.function.uuid, 'function uuid', where);

	const rawConstructor: unknown = Object.prototype.hasOwnProperty.call(input, 'constructor') ? input.constructor : undefined;
	if (!isPlainRecord(rawConstructor)) {
		throw new FunctionBindingError(`${where}: constructor must be an object`);
	}
	const constructorValues: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(rawConstructor)) {
		if (value === undefined || !isJsonValue(value)) {
			throw new FunctionBindingError(`${where}: constructor '${name}' must be a JSON value`);
		}
		constructorValues[name] = value;
	}

	if (!isPlainRecord(input.execution) || !isFunctionBindingExecutionKind(input.execution.kind)) {
		throw new FunctionBindingError(`${where}: execution.kind must be one of ${functionBindingExecutionKinds.join(' | ')}`);
	}
	if (!isPlainRecord(input.target)) {
		throw new FunctionBindingError(`${where}: target must be an object with an address and merge`);
	}
	const target = input.target as Record<string, unknown>;
	const merge = target.merge;
	if (!isPlainRecord(merge) || typeof merge.kind !== 'string' || !isComposition(merge.kind)) {
		throw new FunctionBindingError(`${where}: target merge.kind must be one of overwrite | overlay`);
	}
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new FunctionBindingError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze({
		uuid: uuid.toLowerCase(),
		index: input.index,
		function: Object.freeze({ uuid: functionUuid }),
		constructor: Object.freeze(constructorValues),
		execution: Object.freeze({ kind: input.execution.kind }),
		inputs: createArguments(input.inputs, 'inputs', where),
		parameters: createArguments(input.parameters, 'parameters', where),
		target: Object.freeze({
			address: createFunctionBindingAddress(target.address, `${where} target`),
			merge: Object.freeze({ kind: merge.kind }),
		}),
		created_at: new Date(createdAt).toISOString(),
	});
}

/** Validates a set of entries of one `function_binding`: binding UUIDs are unique. */
export function validateFunctionBindings(entries: readonly IFunctionBindingEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		if (uuids.has(entry.uuid)) {
			throw new FunctionBindingError(`duplicate binding uuid '${entry.uuid}'`);
		}
		uuids.add(entry.uuid);
	}
}

// #endregion

// #region Registry Resolve (Function Definition / Persistent Address)

function* addressesOf(entry: IFunctionBindingEntry): Iterable<[string, IFunctionBindingAddress]> {
	for (const field of ['inputs', 'parameters'] as const) {
		for (const [name, argument] of Object.entries(entry[field])) {
			if (argument.address) {
				yield [`${field} '${name}'`, argument.address];
			}
		}
	}
	yield ['target', entry.target.address];
}

/**
 * `Registry Resolve` of one binding: the Function Definition exists in `function_registry`, every
 * `inputs` / `constructor` / `parameters` member is a name of that Definition, every Definition
 * input and every Definition argument without a `default` is bound, and every Persistent Address
 * names a table of `table_registry` and a column of that table. Nothing is guessed or completed.
 */
export function validateFunctionBindingAgainstRegistry(
	entry: IFunctionBindingEntry,
	functions: readonly IFunctionRegistryEntry[],
	tables: readonly ITableRegistryEntry[],
): IFunctionRegistryEntry {
	const where = `binding '${entry.uuid}'`;
	const definition = functions.find(candidate => candidate.uuid === entry.function.uuid);
	if (!definition) {
		throw new FunctionBindingError(`${where}: function_registry has no function '${entry.function.uuid}' (Missing Definition)`);
	}

	const inputNames = new Set(definition.input.map(item => item.name));
	for (const name of Object.keys(entry.inputs)) {
		if (!inputNames.has(name)) {
			throw new FunctionBindingError(`${where}: function '${definition.name}' has no input '${name}'`);
		}
	}
	for (const name of inputNames) {
		if (!Object.prototype.hasOwnProperty.call(entry.inputs, name)) {
			throw new FunctionBindingError(`${where}: input '${name}' of function '${definition.name}' is not bound`);
		}
	}

	for (const [field, declared, given] of [
		['constructor', definition.constructor, entry.constructor],
		['parameters', definition.parameters, entry.parameters],
	] as const) {
		const names = new Set(declared.map(item => item.name));
		for (const name of Object.keys(given)) {
			if (!names.has(name)) {
				throw new FunctionBindingError(`${where}: function '${definition.name}' has no ${field} '${name}'`);
			}
		}
		for (const item of declared) {
			if (item.default === undefined && !Object.prototype.hasOwnProperty.call(given, item.name)) {
				throw new FunctionBindingError(`${where}: ${field} '${item.name}' of function '${definition.name}' has no default and is not bound`);
			}
		}
	}

	for (const [field, address] of addressesOf(entry)) {
		const table = tables.find(candidate => candidate.uuid === address.table_uuid);
		if (!table) {
			throw new FunctionBindingError(`${where}: ${field} address table '${address.table_uuid}' is not in table_registry (Missing Definition)`);
		}
		if (!table.columns.some(column => column.uuid === address.column_uuid)) {
			throw new FunctionBindingError(`${where}: ${field} address column '${address.column_uuid}' is not a column of table '${table.name}' (Missing Definition)`);
		}
	}
	return definition;
}

/** Editor Human Display of a Persistent Address. UUIDs are resolved to name / label; storage keeps UUIDs. */
export interface IFunctionBindingAddressDisplay {
	readonly table: string;
	readonly column: string;
	/** `Player`, a newline, then the column prefixed with a tree branch. */
	readonly text: string;
}

/** `UUID = resolve only, name / label = display`: the address is resolved through `table_registry`, never stored as text. */
export function resolveFunctionBindingAddressDisplay(address: IFunctionBindingAddress, tables: readonly ITableRegistryEntry[]): IFunctionBindingAddressDisplay | undefined {
	const table = tables.find(candidate => candidate.uuid === address.table_uuid);
	const column = table?.columns.find(candidate => candidate.uuid === address.column_uuid);
	if (!table || !column) {
		return undefined;
	}
	const tableText = getRegistryDisplayText(table);
	const columnText = getRegistryDisplayText(column);
	return Object.freeze({ table: tableText, column: columnText, text: `${tableText}\n\u2514\u2500 ${columnText}` });
}

// #endregion

// #region Storage (project.sqlite)

/** `binding.function_binding`: the Editor built-in table holding concrete Function Binding rows. */
export const functionBindingTable = Object.freeze({ schema: 'binding', table: 'function_binding' } as const);

export const functionBindingPhysicalTable = corePhysicalTableNameResolver.resolve(functionBindingTable.schema, functionBindingTable.table);

const storedColumns = ['uuid', 'index', 'function_uuid', 'constructor', 'execution_kind', 'inputs', 'parameters', 'target', 'created_at'] as const;

/** Stored form: scalars as columns, `constructor` / `inputs` / `parameters` / `target` as JSON (UUID addresses only). */
export function encodeFunctionBindingRow(entry: IFunctionBindingEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		index: entry.index,
		function_uuid: entry.function.uuid,
		constructor: JSON.stringify(entry.constructor),
		execution_kind: entry.execution.kind,
		inputs: JSON.stringify(entry.inputs),
		parameters: JSON.stringify(entry.parameters),
		target: JSON.stringify(entry.target),
		created_at: entry.created_at,
	});
}

function parseJson(row: ProjectSqliteRow, field: 'constructor' | 'inputs' | 'parameters' | 'target', uuid: string): unknown {
	try {
		return JSON.parse(String(row[field]));
	} catch {
		throw new FunctionBindingError(`stored binding '${uuid}': ${field} is not JSON`);
	}
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeFunctionBindingRow(row: ProjectSqliteRow): IFunctionBindingEntry {
	const missingUuid = (): string => { throw new FunctionBindingError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	const stored = {
		uuid,
		index: row.index as number,
		function: { uuid: row.function_uuid as string },
		constructor: parseJson(row, 'constructor', uuid) as Record<string, unknown>,
		execution: { kind: row.execution_kind as string },
		inputs: parseJson(row, 'inputs', uuid) as Record<string, IFunctionBindingArgument>,
		parameters: parseJson(row, 'parameters', uuid) as Record<string, IFunctionBindingArgument>,
		target: parseJson(row, 'target', uuid) as IFunctionBindingEntryInput['target'],
		created_at: row.created_at as string,
	};
	return createFunctionBindingEntry(stored, missingUuid);
}

function compareBindingOrder(a: IFunctionBindingEntry, b: IFunctionBindingEntry): number {
	return compareTableRegistryOrder(a, b);
}

/** Reads every binding from `project.sqlite` in deterministic order (by `index`, then UUID). Each stored row is validated; UUIDs must be unique. */
export async function readFunctionBindings(database: IProjectSqliteStatements): Promise<readonly IFunctionBindingEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionBindingPhysicalTable)}`);
	const entries = rows.map(decodeFunctionBindingRow).sort(compareBindingOrder);
	validateFunctionBindings(entries);
	return Object.freeze(entries);
}

// #endregion

// #region Function Binding Service

/** `select` request. `where` keys are `uuid`, `function_uuid` and `execution_kind`. */
export interface IFunctionBindingSelect {
	readonly where?: Readonly<Partial<Record<'uuid' | 'function_uuid' | 'execution_kind', string>>>;
	readonly limit?: number;
	/** Result Mapping: resolve every Persistent Address to its `table_registry` name / label for display. */
	readonly resolveDisplay?: boolean;
}

/** Editor Human Display of the addresses of one binding (`inputs` / `parameters` keyed by name). */
export interface IFunctionBindingDisplay {
	readonly function: string | undefined;
	readonly inputs: Readonly<Record<string, IFunctionBindingAddressDisplay | undefined>>;
	readonly parameters: Readonly<Record<string, IFunctionBindingAddressDisplay | undefined>>;
	readonly target: IFunctionBindingAddressDisplay | undefined;
}

export interface IFunctionBindingRow {
	readonly binding: IFunctionBindingEntry;
	readonly display?: IFunctionBindingDisplay;
}

export interface IFunctionBindingMutationResult {
	readonly uuid: string;
	readonly binding: IFunctionBindingEntry;
}

export interface IFunctionBindingUpsertResult extends IFunctionBindingMutationResult {
	readonly operation: 'insert' | 'update';
}

/** `update` payload: the concrete values of an existing binding. The binding `uuid` and `function.uuid` (its Definition) are not changed here. */
export interface IFunctionBindingUpdate {
	readonly index?: number;
	/**
	 * Typed `object`: an optional member named `constructor` is otherwise satisfied by the inherited `Object.prototype.constructor`
	 * (a function). Only an own plain-object `constructor` is accepted at runtime.
	 */
	readonly constructor?: object;
	readonly execution?: { readonly kind: FunctionBindingExecutionKind | string };
	readonly inputs?: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly parameters?: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly target?: IFunctionBindingEntryInput['target'];
}

export interface IFunctionBindingServiceOptions {
	readonly generateUuid?: () => string;
	readonly now?: () => Date;
}

/**
 * Function Binding persistence as generic Resolver dispatches (`insert` / `update` / `upsert` /
 * `delete` / `select`). Each one runs in one transaction and starts with Registry Resolve: the
 * Function Definition comes from `function_registry` and every Persistent Address from
 * `table_registry`, so no Function / Table / Column name is hard-coded here and a binding that
 * names an unknown Definition is rejected before anything is written. Registry Definitions are never
 * changed here.
 */
export class FunctionBindingService {

	private readonly generateUuid: () => string;
	private readonly now: () => Date;

	constructor(
		private readonly database: Pick<IProjectSqliteDatabase, 'transaction'>,
		private readonly executors: IFunctionExecutorCatalog,
		options: IFunctionBindingServiceOptions = {},
	) {
		this.generateUuid = options.generateUuid ?? generateRandomUuid;
		this.now = options.now ?? (() => new Date());
	}

	/** `insert(request)`: Registry Resolve -> Payload Map -> INSERT. The binding uuid is generated when missing. */
	insert(input: IFunctionBindingEntryInput): Promise<IFunctionBindingMutationResult> {
		return this.run(async (statements, context) => {
			const binding = createFunctionBindingEntry(input, this.generateUuid, this.now);
			validateFunctionBindingAgainstRegistry(binding, context.functions, context.tables);
			if (await this.find(statements, binding.uuid)) {
				throw new FunctionBindingError(`binding '${binding.uuid}' already exists`);
			}
			await this.insertRow(statements, binding);
			return { uuid: binding.uuid, binding };
		});
	}

	/** `update(request)`: Target UUID Resolve -> Registry Resolve -> Kind Validate -> UPDATE. `uuid`, `function.uuid` and `created_at` are not changed. */
	update(uuid: string, values: IFunctionBindingUpdate): Promise<IFunctionBindingMutationResult> {
		return this.run(async (statements, context) => {
			const bindingUuid = requireUuid(uuid, 'update target uuid', 'update');
			const existing = await this.require(statements, bindingUuid);
			const binding = this.applyUpdate(existing, values);
			validateFunctionBindingAgainstRegistry(binding, context.functions, context.tables);
			await this.updateRow(statements, binding);
			return { uuid: bindingUuid, binding };
		});
	}

	/**
	 * `upsert(request)`: the Conflict Identity is the binding `uuid` (PRIMARY KEY, the only unique
	 * identity of `function_binding`). It is never guessed: a request without it is rejected. An
	 * existing binding keeps its `created_at` and its Definition (`function.uuid`).
	 */
	upsert(input: IFunctionBindingEntryInput): Promise<IFunctionBindingUpsertResult> {
		return this.run(async (statements, context) => {
			if (input.uuid === undefined || input.uuid === '') {
				throw new FunctionBindingError(`upsert requires the Conflict Identity 'uuid'`);
			}
			const requested = createFunctionBindingEntry(input, this.generateUuid, this.now);
			const existing = await this.find(statements, requested.uuid);
			if (!existing) {
				validateFunctionBindingAgainstRegistry(requested, context.functions, context.tables);
				await this.insertRow(statements, requested);
				return { operation: 'insert' as const, uuid: requested.uuid, binding: requested };
			}
			if (existing.function.uuid !== requested.function.uuid) {
				throw new FunctionBindingError(`binding '${requested.uuid}': upsert cannot change the function (${existing.function.uuid} -> ${requested.function.uuid})`);
			}
			const binding = Object.freeze({ ...requested, created_at: existing.created_at });
			validateFunctionBindingAgainstRegistry(binding, context.functions, context.tables);
			await this.updateRow(statements, binding);
			return { operation: 'update' as const, uuid: binding.uuid, binding };
		});
	}

	/** `delete(request)`: Target Resolve -> DELETE of one binding. The Function Definition and the addressed Raw Data are untouched. */
	delete(uuid: string): Promise<IFunctionBindingEntry> {
		return this.run(async statements => {
			const bindingUuid = requireUuid(uuid, 'delete target uuid', 'delete');
			const existing = await this.require(statements, bindingUuid);
			await statements.run(`DELETE FROM ${quoteIdentifier(functionBindingPhysicalTable)} WHERE "uuid" = ?`, [bindingUuid]);
			return existing;
		});
	}

	/** `select(request)`: Query Map -> SELECT -> Result Mapping (UUID -> name / label when `resolveDisplay`). */
	select(request: IFunctionBindingSelect = {}): Promise<readonly IFunctionBindingRow[]> {
		return this.run(async (statements, context) => {
			const conditions: string[] = [];
			const params: ProjectSqliteValue[] = [];
			for (const [key, value] of Object.entries(request.where ?? {})) {
				if (key === 'uuid' || key === 'function_uuid') {
					conditions.push(`${quoteIdentifier(key)} = ?`);
					params.push(requireUuid(value, `where '${key}'`, 'select'));
				} else if (key === 'execution_kind') {
					if (!isFunctionBindingExecutionKind(value)) {
						throw new FunctionBindingError(`select where 'execution_kind' must be one of ${functionBindingExecutionKinds.join(' | ')}`);
					}
					conditions.push(`${quoteIdentifier(key)} = ?`);
					params.push(value);
				} else {
					throw new FunctionBindingError(`select cannot filter on '${key}'`);
				}
			}
			if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) {
				throw new FunctionBindingError('select limit must be a non-negative int');
			}
			let sql = `SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionBindingPhysicalTable)}`;
			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(' AND ')}`;
			}
			sql += ' ORDER BY "index", "uuid"';
			if (request.limit !== undefined) {
				sql += ` LIMIT ${request.limit}`;
			}
			const rows = await statements.all(sql, params);
			return Object.freeze(rows.map(row => {
				const binding = decodeFunctionBindingRow(row);
				return Object.freeze(request.resolveDisplay ? { binding, display: this.display(binding, context) } : { binding });
			}));
		});
	}

	// #region Storage Operation

	/** One Storage Operation in one transaction; Registry Resolve first (Registry = Authority). */
	private run<T>(work: (statements: IProjectSqliteStatements, context: IRegistryContext) => Promise<T>): Promise<T> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		return this.database.transaction(async statements => {
			const functions = await readFunctionRegistry(statements, this.executors);
			const tables = await readTableRegistry(statements);
			return work(statements, { functions, tables });
		});
	}

	private applyUpdate(existing: IFunctionBindingEntry, values: IFunctionBindingUpdate): IFunctionBindingEntry {
		const keys = Object.keys(values);
		if (keys.length === 0) {
			throw new FunctionBindingError('update requires at least one value');
		}
		for (const key of keys) {
			if (!['index', 'constructor', 'execution', 'inputs', 'parameters', 'target'].includes(key)) {
				throw new FunctionBindingError(`update cannot change '${key}'`);
			}
		}
		return createFunctionBindingEntry({
			uuid: existing.uuid,
			index: values.index ?? existing.index,
			function: existing.function,
			constructor: Object.prototype.hasOwnProperty.call(values, 'constructor') ? values.constructor as Record<string, unknown> : existing.constructor,
			execution: values.execution ?? existing.execution,
			inputs: values.inputs ?? existing.inputs,
			parameters: values.parameters ?? existing.parameters,
			target: values.target ?? existing.target,
			created_at: existing.created_at,
		}, this.generateUuid, this.now);
	}

	private display(binding: IFunctionBindingEntry, context: IRegistryContext): IFunctionBindingDisplay {
		const resolve = (record: Readonly<Record<string, IFunctionBindingArgument>>) => Object.freeze(Object.fromEntries(
			Object.entries(record).filter(([, argument]) => argument.address).map(([name, argument]) => [name, resolveFunctionBindingAddressDisplay(argument.address!, context.tables)])));
		const definition = context.functions.find(candidate => candidate.uuid === binding.function.uuid);
		return Object.freeze({
			function: definition ? getRegistryDisplayText(definition) : undefined,
			inputs: resolve(binding.inputs),
			parameters: resolve(binding.parameters),
			target: resolveFunctionBindingAddressDisplay(binding.target.address, context.tables),
		});
	}

	private async insertRow(statements: IProjectSqliteStatements, binding: IFunctionBindingEntry): Promise<void> {
		const row = encodeFunctionBindingRow(binding);
		await statements.run(
			`INSERT INTO ${quoteIdentifier(functionBindingPhysicalTable)} (${storedColumns.map(quoteIdentifier).join(', ')}) VALUES (${storedColumns.map(() => '?').join(', ')})`,
			storedColumns.map(column => row[column]));
	}

	private async updateRow(statements: IProjectSqliteStatements, binding: IFunctionBindingEntry): Promise<void> {
		const row = encodeFunctionBindingRow(binding);
		const assignable = storedColumns.filter(column => column !== 'uuid' && column !== 'created_at');
		await statements.run(
			`UPDATE ${quoteIdentifier(functionBindingPhysicalTable)} SET ${assignable.map(column => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE "uuid" = ?`,
			[...assignable.map(column => row[column]), binding.uuid]);
	}

	private async find(statements: IProjectSqliteStatements, uuid: string): Promise<IFunctionBindingEntry | undefined> {
		const row = await statements.get(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionBindingPhysicalTable)} WHERE "uuid" = ?`, [uuid]);
		return row ? decodeFunctionBindingRow(row) : undefined;
	}

	private async require(statements: IProjectSqliteStatements, uuid: string): Promise<IFunctionBindingEntry> {
		const binding = await this.find(statements, uuid);
		if (!binding) {
			throw new FunctionBindingError(`binding '${uuid}' does not exist`);
		}
		return binding;
	}

	// #endregion
}

interface IRegistryContext {
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly tables: readonly ITableRegistryEntry[];
}

// #endregion
