/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Runtime State and persistent-address resolution (runtime.state)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (23. Load / Runtime, 24. Runtime State)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { FunctionBindingError, FunctionBindingSource, IFunctionBindingAddress, IFunctionBindingArgument, IFunctionBindingEntry } from './functionBinding.js';
import { IFunctionExecutionPlanStep } from './functionDependency.js';
import { IProjectSqliteDatabase } from './projectSqlite.js';
import { RawDataService } from './rawData.js';
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { ITableRegistryColumn, ITableRegistryEntry, readTableRegistry } from './tableRegistry.js';

/**
 * ```text
 * Project Data -> Load -> Runtime State -> Function -> Next Runtime State -> Renderer
 *
 * Persistent UUID Address -> Registry Resolve -> Runtime Object Resolve -> Memory Handle
 * ```
 *
 * `Runtime State = Memory`. Load is the only step that reads `project.sqlite`: it copies the Raw Data
 * Rows into `entities` (`row_uuid -> properties`, keyed by `column_uuid`). From then on the Runtime
 * Loop works on resolved Memory Handles only: a `RuntimeState` and its handles hold no database
 * reference, a Function Output is written to memory and never to SQLite, and Frame State is not
 * Persistent Data (persisting it is only ever an explicit Application save, see persistenceBoundary).
 */

export class RuntimeStateError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor runtime state: ${message}`);
		this.name = 'RuntimeStateError';
	}
}

// #region Runtime State

/** `entities.<row_uuid>`: one Raw Data Row in memory. */
export interface IRuntimeEntity {
	readonly table_uuid: string;
	/** Property values keyed by `column_uuid`. */
	readonly properties: Map<string, unknown>;
}

/** `functions.<binding_uuid>`: the Function Instance and the last Function Output of one binding. */
export interface IRuntimeFunction {
	instance: unknown;
	output: unknown;
}

/** The `runtime:` structure. Plain memory; nothing here is persisted unless an Application saves it explicitly. */
export interface IRuntimeState {
	time: number;
	progress: number;
	input: Record<string, unknown>;
	readonly entities: Map<string, IRuntimeEntity>;
	readonly functions: Map<string, IRuntimeFunction>;
	readonly events: unknown[];
	renderer: unknown;
}

export function createRuntimeState(): IRuntimeState {
	return {
		time: 0,
		progress: 0,
		input: {},
		entities: new Map(),
		functions: new Map(),
		events: [],
		renderer: undefined,
	};
}

function identity(value: unknown, where: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new RuntimeStateError(`${where} must be a UUID`);
	}
	return normalizeRegistryUuid(value);
}

/** Adds (or replaces) one entity. Its identity is the Row UUID. */
export function setRuntimeEntity(state: IRuntimeState, tableUuid: string, rowUuid: string, properties: Readonly<Record<string, unknown>>): IRuntimeEntity {
	const entity: IRuntimeEntity = {
		table_uuid: identity(tableUuid, 'entity table_uuid'),
		properties: new Map(Object.entries(properties)),
	};
	state.entities.set(identity(rowUuid, 'entity row_uuid'), entity);
	return entity;
}

/** Gives every binding of the Execution Plan its (empty) `functions.<binding_uuid>` slot. */
export function initializeRuntimeFunctions(state: IRuntimeState, plan: readonly IFunctionExecutionPlanStep[]): void {
	for (const step of plan) {
		if (!state.functions.has(step.binding.uuid)) {
			state.functions.set(step.binding.uuid, { instance: undefined, output: undefined });
		}
	}
}

// #endregion

// #region Load

/**
 * Load: Project Data -> Runtime State. Reads every Registry table's Raw Data once and keeps the Rows in
 * memory, keyed by Row UUID. This is the only point where Runtime State touches SQLite.
 */
export async function loadRuntimeState(database: Pick<IProjectSqliteDatabase, 'transaction'>, plan: readonly IFunctionExecutionPlanStep[] = []): Promise<IRuntimeState> {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	const tables = await database.transaction(statements => readTableRegistry(statements));
	const rawData = new RawDataService(database);
	const state = createRuntimeState();
	for (const table of tables) {
		for (const row of await rawData.select(table.uuid)) {
			if (state.entities.has(row.uuid)) {
				throw new RuntimeStateError(`row '${row.uuid}' of table '${table.uuid}' is already loaded from another table (Row identity must be unique)`);
			}
			setRuntimeEntity(state, table.uuid, row.uuid, row.values);
		}
	}
	initializeRuntimeFunctions(state, plan);
	return state;
}

// #endregion

// #region Persistent Address -> Memory Handle

/** A resolved Persistent Address: reads and writes one entity property in memory, never SQLite. */
export interface IRuntimeMemoryHandle {
	readonly address: IFunctionBindingAddress;
	readonly column: ITableRegistryColumn;
	get(): unknown;
	set(value: unknown): void;
}

/** Registry Resolve: the address' table and column must exist in the Registry (UUID = resolve only). */
function resolveRegistry(address: IFunctionBindingAddress, tables: readonly ITableRegistryEntry[], where: string): { readonly address: IFunctionBindingAddress; readonly column: ITableRegistryColumn } {
	const normalized: IFunctionBindingAddress = Object.freeze({
		table_uuid: identity(address.table_uuid, `${where} table_uuid`),
		row_uuid: identity(address.row_uuid, `${where} row_uuid`),
		column_uuid: identity(address.column_uuid, `${where} column_uuid`),
	});
	const table = tables.find(entry => entry.uuid === normalized.table_uuid);
	if (!table) {
		throw new RuntimeStateError(`${where}: table_registry has no table '${normalized.table_uuid}' (Missing Definition)`);
	}
	const column = table.columns.find(candidate => candidate.uuid === normalized.column_uuid);
	if (!column) {
		throw new RuntimeStateError(`${where}: table '${table.name}' has no column '${normalized.column_uuid}' (Missing Definition)`);
	}
	return { address: normalized, column };
}

/**
 * Persistent UUID Address -> Registry Resolve -> Runtime Object Resolve -> Memory Handle.
 * The Runtime Object is the loaded entity of `row_uuid`; it must belong to `table_uuid`. The handle
 * binds to the entity once, so the Runtime Loop does not resolve (or query) anything per access.
 */
export function resolveRuntimeHandle(state: IRuntimeState, tables: readonly ITableRegistryEntry[], address: IFunctionBindingAddress, where: string = 'address'): IRuntimeMemoryHandle {
	const { address: resolved, column } = resolveRegistry(address, tables, where);
	const entity = state.entities.get(resolved.row_uuid);
	if (!entity) {
		throw new RuntimeStateError(`${where}: runtime state has no entity '${resolved.row_uuid}' (Missing Runtime Object)`);
	}
	if (entity.table_uuid !== resolved.table_uuid) {
		throw new RuntimeStateError(`${where}: entity '${resolved.row_uuid}' belongs to table '${entity.table_uuid}', not '${resolved.table_uuid}'`);
	}
	return Object.freeze({
		address: resolved,
		column,
		get: () => entity.properties.get(resolved.column_uuid),
		set: (value: unknown) => { entity.properties.set(resolved.column_uuid, value); },
	});
}

/** The handles of one binding: `state` inputs / parameters and the `target`. */
export interface IRuntimeBindingHandles {
	readonly binding_uuid: string;
	readonly inputs: Readonly<Record<string, IRuntimeMemoryHandle>>;
	readonly parameters: Readonly<Record<string, IRuntimeMemoryHandle>>;
	readonly target: IRuntimeMemoryHandle;
}

function resolveArgumentHandles(
	state: IRuntimeState,
	tables: readonly ITableRegistryEntry[],
	args: Readonly<Record<string, IFunctionBindingArgument>>,
	where: string,
): Record<string, IRuntimeMemoryHandle> {
	const handles: Record<string, IRuntimeMemoryHandle> = {};
	for (const [name, argument] of Object.entries(args)) {
		if (argument.source !== FunctionBindingSource.State) {
			continue;
		}
		if (!argument.address) {
			throw new FunctionBindingError(`${where} '${name}': source 'state' requires an address`);
		}
		handles[name] = resolveRuntimeHandle(state, tables, argument.address, `${where} '${name}'`);
	}
	return handles;
}

/** Resolves every Persistent Address a binding reads (`source: state`) or writes (`target`) to a Memory Handle. */
export function resolveBindingHandles(state: IRuntimeState, tables: readonly ITableRegistryEntry[], binding: IFunctionBindingEntry): IRuntimeBindingHandles {
	const where = `binding '${binding.uuid}'`;
	return Object.freeze({
		binding_uuid: binding.uuid,
		inputs: Object.freeze(resolveArgumentHandles(state, tables, binding.inputs, `${where} input`)),
		parameters: Object.freeze(resolveArgumentHandles(state, tables, binding.parameters, `${where} parameter`)),
		target: resolveRuntimeHandle(state, tables, binding.target.address, `${where} target`),
	});
}

/** Resolves the handles of every binding of the Execution Plan, in plan order. */
export function resolvePlanHandles(state: IRuntimeState, tables: readonly ITableRegistryEntry[], plan: readonly IFunctionExecutionPlanStep[]): ReadonlyMap<string, IRuntimeBindingHandles> {
	const handles = new Map<string, IRuntimeBindingHandles>();
	for (const step of plan) {
		handles.set(step.binding.uuid, resolveBindingHandles(state, tables, step.binding));
	}
	return handles;
}

// #endregion
