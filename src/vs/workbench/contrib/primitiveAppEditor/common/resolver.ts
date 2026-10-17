/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Generic Resolver primitives and App Editor API (resolver.operation)
 *  Specification SSOT: docs/primitive-app-editor/Resolver.md (1 - 17), docs/primitive-app-editor/App Editer.md (App Editor API / Application Language Boundary)
 *  Boundary: App Editer.md (6. Registry Service, 9. Physical Table Expansion, 12. Raw Data, 34. Boundary Rules)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { IEnumRegistryEntry, IEnumRegistryEntryInput, readEnumRegistry } from './enumRegistry.js';
import { FunctionBindingService, IFunctionBindingEntryInput, IFunctionBindingSelect, IFunctionBindingUpdate, readFunctionBindings } from './functionBinding.js';
import { FunctionDependencyService, IFunctionDependencyEntryInput, IFunctionDependencySelect, readFunctionDependencies } from './functionDependency.js';
import { assertProjectSqliteAccess, IProjectSqliteDatabase, IProjectSqliteStatements, ProjectSqliteAccessor } from './projectSqlite.js';
import { IRawDataSelect, RawDataService, RawDataValues } from './rawData.js';
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { IRelationRegistryEntry, IRelationRegistryEntryInput, readRelationRegistry } from './relationRegistry.js';
import { RegistryService } from './registryService.js';
import { IRendererBindingEntryInput, IRendererBindingSelect, IRendererBindingUpdate, readRendererBindings, RendererBindingService } from './rendererRegistry.js';
import { compareTableRegistryOrder, ITableRegistryColumnInput, ITableRegistryEntry, ITableRegistryEntryInput, readTableRegistry } from './tableRegistry.js';

/**
 * Resolver = Request Dispatch / Derived Mapping (17. Boundary).
 *
 * ```text
 * Input Request -> Operation Resolve -> Target Resolve -> Registry / Binding Read
 *               -> Validation -> Request Mapping -> Service / Storage Dispatch -> Result
 * ```
 *
 * The nine Primitives are generic: the Resolver holds no Table / Entity / Function name and no
 * Application field, Conflict Key or Conflict Policy. What a Target Kind accepts is a Structured
 * Definition ({@link IResolverMappingDefinition}) from which the dispatch Mapping is generated
 * (16. Dynamic Generation); the generated Mapping only selects an existing Service / Storage port, it
 * cannot add semantics or hand a Registry Definition operation to the Raw Data / Binding side.
 * Missing Definition and Ambiguous Target are rejected, never completed.
 */

// #region Contract

export class ResolverError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor Resolver: ${message}`);
		this.name = 'ResolverError';
	}
}

export const enum ResolverOperation {
	Create = 'create',
	Alter = 'alter',
	Truncate = 'truncate',
	Drop = 'drop',
	Insert = 'insert',
	Delete = 'delete',
	Update = 'update',
	Upsert = 'upsert',
	Select = 'select',
}

/** The 9 Core Operations (2. Core Operations). */
export const resolverOperations: readonly ResolverOperation[] = Object.freeze([
	ResolverOperation.Create, ResolverOperation.Alter, ResolverOperation.Truncate, ResolverOperation.Drop,
	ResolverOperation.Insert, ResolverOperation.Delete, ResolverOperation.Update, ResolverOperation.Upsert, ResolverOperation.Select,
]);

export function isResolverOperation(value: unknown): value is ResolverOperation {
	return (resolverOperations as readonly unknown[]).includes(value);
}

/** Schema / Registry Operation: dispatched to the Registry Service (15. Service Dispatch). `select` reads either side. */
const registryOperations: readonly ResolverOperation[] = Object.freeze([ResolverOperation.Create, ResolverOperation.Alter, ResolverOperation.Drop, ResolverOperation.Select]);
/** Data / Binding Operation: dispatched to a Storage / Binding Operation. `truncate` is Data Removal on the Storage side. */
const dataOperations: readonly ResolverOperation[] = Object.freeze([ResolverOperation.Truncate, ResolverOperation.Insert, ResolverOperation.Delete, ResolverOperation.Update, ResolverOperation.Upsert, ResolverOperation.Select]);

/** Persistent Address of a request (3. Request Model): UUIDs only, display labels are never an identity. */
export interface IResolverAddress {
	readonly table_uuid?: string | null;
	readonly row_uuid?: string | null;
	readonly column_uuid?: string | null;
}

export interface IResolverTarget {
	/** Target Kind, resolved by the Mapping (e.g. `table`, `raw`, `function_binding`). Omitted: resolved from `uuid`. */
	readonly kind?: string;
	readonly uuid?: string | null;
}

/** An operation-less request; the Primitive being called supplies the `operation`. */
export interface IResolverOperationRequest {
	readonly target: IResolverTarget;
	readonly address?: IResolverAddress;
	readonly payload?: unknown;
}

export interface IResolverRequest extends IResolverOperationRequest {
	readonly operation: ResolverOperation | string;
}

export interface IResolverResult {
	readonly operation: ResolverOperation;
	readonly kind: string;
	/** Result of the dispatched Service / Storage Operation. */
	readonly result: unknown;
}

/**
 * App Editor API Contract: the nine generic Primitives an Application (any language) composes. It is
 * the compatibility boundary; how it is transported is an implementation choice.
 */
export interface IAppEditorApi {
	create(request: IResolverOperationRequest): Promise<IResolverResult>;
	alter(request: IResolverOperationRequest): Promise<IResolverResult>;
	truncate(request: IResolverOperationRequest): Promise<IResolverResult>;
	drop(request: IResolverOperationRequest): Promise<IResolverResult>;
	insert(request: IResolverOperationRequest): Promise<IResolverResult>;
	delete(request: IResolverOperationRequest): Promise<IResolverResult>;
	update(request: IResolverOperationRequest): Promise<IResolverResult>;
	upsert(request: IResolverOperationRequest): Promise<IResolverResult>;
	select(request: IResolverOperationRequest): Promise<IResolverResult>;
}

// #endregion

// #region Structured Definition -> Mapping (16. Dynamic Generation)

export const enum ResolverAuthority {
	/** Registry Definition: Schema / Logical Definition Authority, mutated only by the Registry Service. */
	Registry = 'registry',
	/** Raw Data / Binding Instance: Storage / Binding persistence. */
	Data = 'data',
}

export interface IResolverKindDefinition {
	readonly kind: string;
	readonly authority: ResolverAuthority | string;
	/** Service / Storage port that executes the Operations of this Kind. */
	readonly port: string;
	readonly operations: readonly (ResolverOperation | string)[];
}

/** Structured Definition (YAML / JSON) a Resolver Mapping is derived from. */
export interface IResolverMappingDefinition {
	readonly kinds: readonly IResolverKindDefinition[];
}

/** Core Registry / Binding Kinds. Generic: no Application Entity, Table or Function is named. */
export const defaultResolverMappingDefinition: IResolverMappingDefinition = Object.freeze({
	kinds: Object.freeze([
		{ kind: 'table', authority: ResolverAuthority.Registry, port: 'table', operations: [ResolverOperation.Create, ResolverOperation.Alter, ResolverOperation.Drop, ResolverOperation.Select] },
		{ kind: 'column', authority: ResolverAuthority.Registry, port: 'column', operations: [ResolverOperation.Create, ResolverOperation.Alter, ResolverOperation.Drop, ResolverOperation.Select] },
		{ kind: 'enum', authority: ResolverAuthority.Registry, port: 'enum', operations: [ResolverOperation.Create, ResolverOperation.Alter, ResolverOperation.Drop, ResolverOperation.Select] },
		{ kind: 'relation', authority: ResolverAuthority.Registry, port: 'relation', operations: [ResolverOperation.Create, ResolverOperation.Alter, ResolverOperation.Drop, ResolverOperation.Select] },
		{ kind: 'raw', authority: ResolverAuthority.Data, port: 'raw', operations: [ResolverOperation.Truncate, ResolverOperation.Insert, ResolverOperation.Delete, ResolverOperation.Update, ResolverOperation.Upsert, ResolverOperation.Select] },
		{ kind: 'function_binding', authority: ResolverAuthority.Data, port: 'function_binding', operations: [ResolverOperation.Insert, ResolverOperation.Delete, ResolverOperation.Update, ResolverOperation.Upsert, ResolverOperation.Select] },
		{ kind: 'function_dependency', authority: ResolverAuthority.Data, port: 'function_dependency', operations: [ResolverOperation.Insert, ResolverOperation.Delete, ResolverOperation.Select] },
		{ kind: 'renderer_binding', authority: ResolverAuthority.Data, port: 'renderer_binding', operations: [ResolverOperation.Insert, ResolverOperation.Delete, ResolverOperation.Update, ResolverOperation.Upsert, ResolverOperation.Select] },
	] satisfies IResolverKindDefinition[]),
});

/** One Operation of a Target Kind after Request Mapping: `uuid` / `address` are already normalized UUIDs. */
export interface IResolverDispatch {
	readonly operation: ResolverOperation;
	readonly kind: string;
	readonly uuid: string | undefined;
	readonly address: { readonly table_uuid?: string; readonly row_uuid?: string; readonly column_uuid?: string };
	readonly payload: unknown;
}

/** Service / Storage port: the existing Authority that executes a Target Kind. The Resolver only dispatches to it. */
export interface IResolverPort {
	/** Registry / Binding Read: does a definition / instance with this UUID exist? Absent: the Kind cannot be resolved from a UUID alone. */
	locate?(statements: IProjectSqliteStatements, uuid: string): Promise<boolean>;
	readonly create?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly alter?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly truncate?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly drop?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly insert?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly delete?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly update?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly upsert?: (dispatch: IResolverDispatch) => Promise<unknown>;
	readonly select?: (dispatch: IResolverDispatch) => Promise<unknown>;
}

export interface IResolverMappingEntry {
	readonly kind: string;
	readonly authority: ResolverAuthority;
	readonly port: IResolverPort;
	readonly operations: ReadonlySet<ResolverOperation>;
}

/** Derived dispatch Mapping, by Target Kind. */
export type ResolverMapping = ReadonlyMap<string, IResolverMappingEntry>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an untrusted Structured Definition (e.g. parsed YAML). Throws {@link ResolverError}; the
 * result is the definition itself, unchanged.
 */
export function parseResolverMappingDefinition(input: unknown): IResolverMappingDefinition {
	if (!isPlainRecord(input) || !Array.isArray(input.kinds)) {
		throw new ResolverError('mapping definition must be an object with a `kinds` array');
	}
	const kinds = input.kinds.map((entry: unknown, position): IResolverKindDefinition => {
		const where = `mapping definition kinds[${position}]`;
		if (!isPlainRecord(entry)) {
			throw new ResolverError(`${where} must be an object`);
		}
		const { kind, authority, port, operations } = entry;
		if (typeof kind !== 'string' || kind.length === 0) {
			throw new ResolverError(`${where}: kind must be a non-empty string`);
		}
		if (authority !== ResolverAuthority.Registry && authority !== ResolverAuthority.Data) {
			throw new ResolverError(`${where} '${kind}': authority must be 'registry' or 'data'`);
		}
		if (typeof port !== 'string' || port.length === 0) {
			throw new ResolverError(`${where} '${kind}': port must be a non-empty string`);
		}
		if (!Array.isArray(operations) || operations.length === 0) {
			throw new ResolverError(`${where} '${kind}': operations must be a non-empty array`);
		}
		return { kind, authority, port, operations: operations as readonly string[] };
	});
	return Object.freeze({ kinds: Object.freeze(kinds) });
}

/**
 * Generates the dispatch Mapping from a Structured Definition (Registry / Binding -> Structured
 * Definition -> Mapping). The Mapping is Derived: it only picks an existing port and the Operations
 * that port already implements. A definition that
 *   - names an unknown port or Operation,
 *   - lists an Operation twice,
 *   - dispatches `create / alter / drop` to Raw Data / Binding or `truncate / insert / delete / update / upsert` to a Registry Definition, or
 *   - lists an Operation the port does not implement
 * is rejected, so a generated Mapping can neither redefine Registry / Binding semantics nor mutate a Registry Definition as Raw Data.
 */
export function generateResolverMapping(definition: IResolverMappingDefinition, ports: Readonly<Record<string, IResolverPort>>): ResolverMapping {
	const mapping = new Map<string, IResolverMappingEntry>();
	for (const entry of parseResolverMappingDefinition(definition).kinds) {
		if (mapping.has(entry.kind)) {
			throw new ResolverError(`mapping definition kind '${entry.kind}' is defined more than once (Ambiguous Target)`);
		}
		const port = Object.prototype.hasOwnProperty.call(ports, entry.port) ? ports[entry.port] : undefined;
		if (!port) {
			throw new ResolverError(`mapping definition kind '${entry.kind}': no port '${entry.port}' (Missing Definition)`);
		}
		const allowed = entry.authority === ResolverAuthority.Registry ? registryOperations : dataOperations;
		const operations = new Set<ResolverOperation>();
		for (const operation of entry.operations) {
			if (!isResolverOperation(operation)) {
				throw new ResolverError(`mapping definition kind '${entry.kind}': '${String(operation)}' is not a Resolver Operation`);
			}
			if (operations.has(operation)) {
				throw new ResolverError(`mapping definition kind '${entry.kind}': operation '${operation}' is listed more than once`);
			}
			if (!allowed.includes(operation)) {
				throw new ResolverError(`mapping definition kind '${entry.kind}' (${entry.authority}): operation '${operation}' belongs to the ${entry.authority === ResolverAuthority.Registry ? 'Raw Data / Binding' : 'Registry Service'} side`);
			}
			if (typeof port[operation] !== 'function') {
				throw new ResolverError(`mapping definition kind '${entry.kind}': port '${entry.port}' does not implement '${operation}'`);
			}
			operations.add(operation);
		}
		mapping.set(entry.kind, Object.freeze({ kind: entry.kind, authority: entry.authority as ResolverAuthority, port, operations }));
	}
	return mapping;
}

// #endregion

// #region Request validation

function requireUuid(value: unknown, field: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new ResolverError(`${field} must be a UUID (a display label is not a Persistent Identity)`);
	}
	return normalizeRegistryUuid(value);
}

function optionalUuid(value: unknown, field: string): string | undefined {
	return value === undefined || value === null ? undefined : requireUuid(value, field);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isPlainRecord(value)) {
		throw new ResolverError(`${field} must be an object`);
	}
	return value;
}

/** The same Persistent Identity given twice must agree, otherwise the Target is ambiguous. */
function agree(first: string | undefined, second: string | undefined, what: string): string | undefined {
	if (first !== undefined && second !== undefined && first !== second) {
		throw new ResolverError(`${what} is given twice with different UUIDs '${first}' and '${second}' (Ambiguous Target)`);
	}
	return first ?? second;
}

function withIdentity(payload: unknown, uuid: string | undefined, field: string): Record<string, unknown> {
	const record = { ...requireRecord(payload, field) };
	const given = record.uuid === undefined || record.uuid === null || record.uuid === '' ? undefined : requireUuid(record.uuid, `${field}.uuid`);
	const identity = agree(uuid, given, `${field} uuid`);
	if (identity !== undefined) {
		record.uuid = identity;
	}
	return record;
}

function requireIdentity(dispatch: IResolverDispatch, what: string): string {
	if (dispatch.uuid === undefined) {
		throw new ResolverError(`${dispatch.operation} on ${what} requires target.uuid`);
	}
	return dispatch.uuid;
}

// #endregion

// #region Ports (Service Dispatch)

export interface IResolverServices {
	/** Registry Resolve: read access to the Registry / Binding definitions. */
	readonly database: Pick<IProjectSqliteDatabase, 'transaction'>;
	/** Registry Definition Operations (`create / alter / drop`): Registry Mutation / Schema Projection. */
	readonly registry: RegistryService;
	/** Raw Data Storage Operation. */
	readonly rawData: RawDataService;
	readonly functionBinding: FunctionBindingService;
	readonly functionDependency: FunctionDependencyService;
	readonly rendererBinding: RendererBindingService;
}

function sortedByUuid<T extends { readonly uuid: string }>(entries: readonly T[], uuid: string | undefined, kind: string): readonly T[] {
	if (uuid === undefined) {
		return entries;
	}
	const found = entries.filter(entry => entry.uuid === uuid);
	if (found.length === 0) {
		throw new ResolverError(`${kind} '${uuid}' does not exist (Missing Definition)`);
	}
	return found;
}

async function readSingle<T extends { readonly uuid: string }>(entries: Promise<readonly T[]> | readonly T[], uuid: string, kind: string): Promise<T> {
	return sortedByUuid(await entries, uuid, kind)[0];
}

/**
 * Creates the ports over the existing Registry Service / Raw Data / Binding services. Every port maps
 * the request payload onto its Service and returns the Service result unchanged; none of them knows an
 * Application Table, Entity or Function.
 */
export function createResolverPorts(services: IResolverServices): Readonly<Record<string, IResolverPort>> {
	const read = <T>(work: (statements: IProjectSqliteStatements) => Promise<T>) => services.database.transaction(work);
	const has = <T extends { readonly uuid: string }>(reader: (statements: IProjectSqliteStatements) => Promise<readonly T[]>) =>
		(statements: IProjectSqliteStatements, uuid: string) => reader(statements).then(entries => entries.some(entry => entry.uuid === uuid));

	const table: IResolverPort = {
		locate: has(readTableRegistry),
		create: dispatch => services.registry.create(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as ITableRegistryEntryInput),
		alter: async dispatch => {
			const uuid = requireIdentity(dispatch, 'table');
			const existing = await read(statements => readSingle(readTableRegistry(statements), uuid, 'table'));
			const patch = requireRecord(dispatch.payload, 'payload');
			if (Object.keys(patch).length === 0) {
				throw new ResolverError('alter on table requires at least one change');
			}
			return services.registry.alter({ ...existing, ...patch, uuid } as unknown as ITableRegistryEntryInput & { readonly uuid: string });
		},
		drop: dispatch => services.registry.drop(requireIdentity(dispatch, 'table')),
		select: dispatch => read(async statements => sortedByUuid([...await readTableRegistry(statements)].sort(compareTableRegistryOrder), dispatch.uuid, 'table')),
	};

	/** Column Registry Definitions are part of their `table_registry` entry: they change through that entry's Registry Mutation. */
	const columnTable = async (dispatch: IResolverDispatch): Promise<ITableRegistryEntry> => {
		const tableUuid = requireUuid(dispatch.address.table_uuid, 'address.table_uuid');
		return read(statements => readSingle(readTableRegistry(statements), tableUuid, 'table'));
	};
	const column: IResolverPort = {
		create: async dispatch => {
			const existing = await columnTable(dispatch);
			const input = withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as ITableRegistryColumnInput;
			return services.registry.alter({ ...existing, columns: [...existing.columns, input] } as unknown as ITableRegistryEntryInput & { readonly uuid: string });
		},
		alter: async dispatch => {
			const existing = await columnTable(dispatch);
			const uuid = requireIdentity(dispatch, 'column');
			const current = existing.columns.find(candidate => candidate.uuid === uuid);
			if (!current) {
				throw new ResolverError(`table '${existing.name}' has no column '${uuid}' (Missing Definition)`);
			}
			const patch = requireRecord(dispatch.payload, 'payload');
			if (Object.keys(patch).length === 0) {
				throw new ResolverError('alter on column requires at least one change');
			}
			const columns = existing.columns.map(candidate => candidate === current ? { ...candidate, ...patch, uuid } : candidate);
			return services.registry.alter({ ...existing, columns } as unknown as ITableRegistryEntryInput & { readonly uuid: string });
		},
		drop: async dispatch => {
			const existing = await columnTable(dispatch);
			const uuid = requireIdentity(dispatch, 'column');
			if (!existing.columns.some(candidate => candidate.uuid === uuid)) {
				throw new ResolverError(`table '${existing.name}' has no column '${uuid}' (Missing Definition)`);
			}
			return services.registry.alter({ ...existing, columns: existing.columns.filter(candidate => candidate.uuid !== uuid) } as unknown as ITableRegistryEntryInput & { readonly uuid: string });
		},
		select: async dispatch => {
			const existing = await columnTable(dispatch);
			if (dispatch.uuid === undefined) {
				return existing.columns;
			}
			const found = existing.columns.find(candidate => candidate.uuid === dispatch.uuid);
			if (!found) {
				throw new ResolverError(`table '${existing.name}' has no column '${dispatch.uuid}' (Missing Definition)`);
			}
			return [found];
		},
	};

	const enumPort: IResolverPort = {
		locate: has(readEnumRegistry),
		create: dispatch => services.registry.createEnum(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IEnumRegistryEntryInput),
		alter: async dispatch => {
			const uuid = requireIdentity(dispatch, 'enum');
			const existing: IEnumRegistryEntry = await read(statements => readSingle(readEnumRegistry(statements), uuid, 'enum'));
			return services.registry.alterEnum({ ...existing, ...requireRecord(dispatch.payload, 'payload'), uuid } as unknown as IEnumRegistryEntryInput & { readonly uuid: string });
		},
		drop: dispatch => services.registry.dropEnum(requireIdentity(dispatch, 'enum')),
		select: dispatch => read(async statements => sortedByUuid(await readEnumRegistry(statements), dispatch.uuid, 'enum')),
	};

	const relation: IResolverPort = {
		locate: has(readRelationRegistry),
		create: dispatch => services.registry.createRelation(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IRelationRegistryEntryInput),
		alter: async dispatch => {
			const uuid = requireIdentity(dispatch, 'relation');
			const existing: IRelationRegistryEntry = await read(statements => readSingle(readRelationRegistry(statements), uuid, 'relation'));
			return services.registry.alterRelation({ ...existing, ...requireRecord(dispatch.payload, 'payload'), uuid } as unknown as IRelationRegistryEntryInput & { readonly uuid: string });
		},
		drop: dispatch => services.registry.dropRelation(requireIdentity(dispatch, 'relation')),
		select: dispatch => read(async statements => sortedByUuid(await readRelationRegistry(statements), dispatch.uuid, 'relation')),
	};

	/** Raw Data of a `table_registry` table: `target.uuid` (or `address.table_uuid`) is the table, `address.row_uuid` the Row. */
	const rawTable = (dispatch: IResolverDispatch): string => requireUuid(agree(dispatch.uuid, dispatch.address.table_uuid, 'table'), 'raw target.uuid (table_registry uuid)');
	const rawValues = (dispatch: IResolverDispatch): RawDataValues => {
		const values = { ...requireRecord(dispatch.payload, 'payload') };
		if (dispatch.address.row_uuid !== undefined) {
			const given = values.uuid === undefined ? undefined : requireUuid(values.uuid, 'payload.uuid');
			values.uuid = agree(dispatch.address.row_uuid, given, 'row uuid');
		}
		return values;
	};
	const rawRow = (dispatch: IResolverDispatch): string => requireUuid(dispatch.address.row_uuid, 'address.row_uuid');
	const raw: IResolverPort = {
		locate: has(readTableRegistry),
		truncate: dispatch => services.rawData.truncate(rawTable(dispatch)),
		insert: dispatch => services.rawData.insert(rawTable(dispatch), rawValues(dispatch)),
		delete: dispatch => services.rawData.delete(rawTable(dispatch), rawRow(dispatch)),
		update: dispatch => services.rawData.update(rawTable(dispatch), rawRow(dispatch), requireRecord(dispatch.payload, 'payload')),
		upsert: dispatch => services.rawData.upsert(rawTable(dispatch), rawValues(dispatch)),
		select: dispatch => {
			const request = dispatch.payload === undefined ? {} : requireRecord(dispatch.payload, 'payload');
			const where = dispatch.address.row_uuid === undefined ? request.where : { ...requireRecord(request.where ?? {}, 'payload.where'), uuid: dispatch.address.row_uuid };
			return services.rawData.select(rawTable(dispatch), { ...request, where } as IRawDataSelect);
		},
	};

	/** Binding Instances are addressed by their own UUID (`target.uuid`); the Definition they use is resolved by the Binding Service. */
	const selectRequest = (dispatch: IResolverDispatch): Record<string, unknown> => {
		const request = dispatch.payload === undefined ? {} : requireRecord(dispatch.payload, 'payload');
		if (dispatch.uuid === undefined) {
			return request;
		}
		const where = requireRecord(request.where ?? {}, 'payload.where');
		return { ...request, where: { ...where, uuid: agree(dispatch.uuid, optionalUuid(where.uuid, 'payload.where.uuid'), 'select uuid') } };
	};

	const functionBinding: IResolverPort = {
		locate: has(readFunctionBindings),
		insert: dispatch => services.functionBinding.insert(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IFunctionBindingEntryInput),
		update: dispatch => services.functionBinding.update(requireIdentity(dispatch, 'function_binding'), requireRecord(dispatch.payload, 'payload') as IFunctionBindingUpdate),
		upsert: dispatch => services.functionBinding.upsert(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IFunctionBindingEntryInput),
		delete: dispatch => services.functionBinding.delete(requireIdentity(dispatch, 'function_binding')),
		select: dispatch => services.functionBinding.select(selectRequest(dispatch) as IFunctionBindingSelect),
	};

	const functionDependency: IResolverPort = {
		locate: has(readFunctionDependencies),
		insert: dispatch => services.functionDependency.insert(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IFunctionDependencyEntryInput),
		delete: dispatch => services.functionDependency.delete(requireIdentity(dispatch, 'function_dependency')),
		select: dispatch => services.functionDependency.select(selectRequest(dispatch) as IFunctionDependencySelect),
	};

	const rendererBinding: IResolverPort = {
		locate: has(readRendererBindings),
		insert: dispatch => services.rendererBinding.insert(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IRendererBindingEntryInput),
		update: dispatch => services.rendererBinding.update(requireIdentity(dispatch, 'renderer_binding'), requireRecord(dispatch.payload, 'payload') as IRendererBindingUpdate),
		upsert: dispatch => services.rendererBinding.upsert(withIdentity(dispatch.payload, dispatch.uuid, 'payload') as unknown as IRendererBindingEntryInput),
		delete: dispatch => services.rendererBinding.delete(requireIdentity(dispatch, 'renderer_binding')),
		select: dispatch => services.rendererBinding.select(selectRequest(dispatch) as IRendererBindingSelect),
	};

	return Object.freeze({ table, column, enum: enumPort, relation, raw, function_binding: functionBinding, function_dependency: functionDependency, renderer_binding: rendererBinding });
}

// #endregion

// #region Resolver

export interface IResolverOptions {
	/** Structured Definition the Mapping is generated from. Defaults to {@link defaultResolverMappingDefinition}. */
	readonly definition?: IResolverMappingDefinition;
}

export class Resolver implements IAppEditorApi {

	readonly mapping: ResolverMapping;

	constructor(private readonly services: IResolverServices, options: IResolverOptions = {}) {
		this.mapping = generateResolverMapping(options.definition ?? defaultResolverMappingDefinition, createResolverPorts(services));
	}

	create(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Create }); }
	alter(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Alter }); }
	truncate(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Truncate }); }
	drop(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Drop }); }
	insert(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Insert }); }
	delete(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Delete }); }
	update(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Update }); }
	upsert(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Upsert }); }
	select(request: IResolverOperationRequest): Promise<IResolverResult> { return this.resolve({ ...request, operation: ResolverOperation.Select }); }

	/**
	 * Dispatch Flow (4): Operation Resolve -> Target Resolve -> Registry / Binding Read -> Validation ->
	 * Request Mapping -> Service / Storage Dispatch -> Result.
	 */
	async resolve(request: IResolverRequest): Promise<IResolverResult> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);

		// Operation Resolve
		if (!isPlainRecord(request) || !isResolverOperation(request.operation)) {
			throw new ResolverError(`operation must be one of ${resolverOperations.join(' | ')}`);
		}
		const operation = request.operation;
		const target = requireRecord(request.target, 'target') as IResolverTarget;

		// Request Mapping (identity): every address is a Persistent Identity (UUID).
		const address = request.address === undefined ? {} : requireRecord(request.address, 'address');
		const tableUuid = optionalUuid(address.table_uuid, 'address.table_uuid');
		const rowUuid = optionalUuid(address.row_uuid, 'address.row_uuid');
		const columnUuid = optionalUuid(address.column_uuid, 'address.column_uuid');
		const targetUuid = optionalUuid(target.uuid, 'target.uuid');

		// Target Resolve (Kind)
		const kind = await this.resolveKind(operation, target.kind, targetUuid);
		const entry = this.mapping.get(kind)!;
		if (!entry.operations.has(operation)) {
			throw new ResolverError(entry.authority === ResolverAuthority.Registry
				? `'${operation}' is not a Registry Definition operation of kind '${kind}' (use ${registryOperations.join(' / ')}; Raw Data / Binding operations act on the Raw Data kinds)`
				: `'${operation}' is not an operation of kind '${kind}' (${kind} is Raw Data / Binding: Registry Definition changes are create / alter / drop)`);
		}

		const uuid = kind === 'column' ? agree(targetUuid, columnUuid, 'column uuid') : targetUuid;
		const dispatch: IResolverDispatch = Object.freeze({
			operation,
			kind,
			uuid,
			address: Object.freeze({
				...(tableUuid !== undefined ? { table_uuid: tableUuid } : {}),
				...(rowUuid !== undefined ? { row_uuid: rowUuid } : {}),
				...(columnUuid !== undefined ? { column_uuid: columnUuid } : {}),
			}),
			payload: request.payload,
		});

		// Registry / Binding Read + Validation + Service / Storage Dispatch: the port's Service starts with Registry Resolve.
		const result = await entry.port[operation]!(dispatch);
		return Object.freeze({ operation, kind, result });
	}

	/** `request.target` -> UUID / Kind Resolve. A missing or unknown Kind is rejected; without a Kind the UUID must resolve to exactly one. */
	private async resolveKind(operation: ResolverOperation, kind: unknown, uuid: string | undefined): Promise<string> {
		if (kind !== undefined) {
			if (typeof kind !== 'string' || !this.mapping.has(kind)) {
				throw new ResolverError(`target kind '${String(kind)}' is not defined by the Mapping (Missing Definition)`);
			}
			return kind;
		}
		if (uuid === undefined) {
			throw new ResolverError('target requires a kind or a uuid');
		}
		const candidates = [...this.mapping.values()].filter(entry => entry.operations.has(operation) && entry.port.locate);
		const found = await this.services.database.transaction(async statements => {
			const matches: string[] = [];
			for (const candidate of candidates) {
				if (await candidate.port.locate!(statements, uuid)) {
					matches.push(candidate.kind);
				}
			}
			return matches;
		});
		if (found.length === 0) {
			throw new ResolverError(`target '${uuid}' does not resolve to any definition that supports '${operation}' (Missing Definition)`);
		}
		if (found.length > 1) {
			throw new ResolverError(`target '${uuid}' is ambiguous for '${operation}': ${found.join(', ')}; give target.kind (Ambiguous Target)`);
		}
		return found[0];
	}
}

// #endregion
