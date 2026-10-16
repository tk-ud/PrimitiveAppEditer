/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - renderer_registry / renderer_binding (renderer.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (27. Renderer, 28. renderer_registry / Binding)
 *  Dispatch contract: docs/primitive-app-editor/Resolver.md (9 insert, 10 delete, 11 update, 12 upsert, 13 select)
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { createFunctionBindingAddress, FunctionBindingError, IFunctionBindingAddress, resolveFunctionBindingAddressDisplay, IFunctionBindingAddressDisplay } from './functionBinding.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	IProjectSqliteDatabase,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	ProjectSqliteValue,
	quoteIdentifier,
	REGISTRY_SCHEMA,
} from './projectSqlite.js';
import { ensureRegistryIdentity, getRegistryDisplayText, IRegistryIdentity, isRegistryUuid, normalizeRegistryUuid, RegistryIdentityError } from './registryIdentity.js';
import { compareTableRegistryOrder, isTimestampValue, ITableRegistryEntry, readTableRegistry } from './tableRegistry.js';

/**
 * `renderer_registry` = the Registry entry of one Renderer Definition: Machine Identity / human
 * naming, the `executor` and the `inputs` (`{name, kind}`) the Renderer accepts. The Renderer
 * itself is Code (`Renderer = Projection of Runtime State`); the Registry holds the definition
 * only and is never an application authority for Runtime State.
 *
 * `renderer_binding` = one concrete Renderer Binding (concrete Data, not a Registry Definition):
 * which Renderer Definition (`renderer.uuid` -> `renderer_registry.uuid`) and, per Renderer input
 * name, either a Persistent Address (`{table_uuid, row_uuid, column_uuid}`, UUIDs only) or an
 * `asset_uuid`. Input names come from the Renderer Definition (`inputs[].name`) and are not
 * hard-coded here; `kind` is `text` in the specification and its vocabulary is not invented.
 * `asset_uuid` is a logical reference to the Asset model (asset.registry bundle), kept as UUID.
 */

// #region renderer_registry

/** One `inputs` element. */
export interface IRendererRegistryInput {
	readonly name: string;
	readonly kind: string;
}

/** One `renderer_registry` entry. */
export interface IRendererRegistryEntry extends IRegistryIdentity {
	readonly index: number;
	readonly executor: string;
	readonly inputs: readonly IRendererRegistryInput[];
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** An INSERT / Seed input: the UUID is generated and `created_at` stamped when missing. */
export interface IRendererRegistryEntryInput {
	readonly uuid?: string;
	readonly index: number;
	readonly name: string;
	readonly label?: string;
	readonly executor: string;
	readonly inputs?: readonly IRendererRegistryInput[];
	readonly created_at?: string;
}

export class RendererRegistryError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor renderer_registry: ${message}`);
		this.name = 'RendererRegistryError';
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string, where: string): string {
	if (typeof value !== 'string' || value === '') {
		throw new RendererRegistryError(`${where}: ${field} must be non-empty text`);
	}
	return value;
}

/**
 * Builds a validated `renderer_registry` entry: a missing UUID is generated and a supplied one
 * kept, `index` is an int, `executor` is non-empty text, `inputs` is a list of `{name, kind}` with
 * unique non-empty names and `created_at` is a timestamp.
 */
export function createRendererRegistryEntry(
	input: IRendererRegistryEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IRendererRegistryEntry {
	let identity: IRegistryIdentity;
	try {
		identity = ensureRegistryIdentity(input, generateUuid);
	} catch (error) {
		throw error instanceof RegistryIdentityError ? new RendererRegistryError(error.message) : error;
	}
	const where = `renderer '${identity.name}'`;
	if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) {
		throw new RendererRegistryError(`${where}: index must be an int`);
	}
	const executor = requireText(input.executor, 'executor', where);
	if (input.inputs !== undefined && !Array.isArray(input.inputs)) {
		throw new RendererRegistryError(`${where}: inputs must be a list`);
	}
	const names = new Set<string>();
	const inputs = (input.inputs ?? []).map(item => {
		if (!isPlainRecord(item)) {
			throw new RendererRegistryError(`${where}: every inputs element must be an object`);
		}
		const name = requireText(item.name, 'inputs name', where);
		const kind = requireText(item.kind, `inputs '${name}' kind`, where);
		if (names.has(name)) {
			throw new RendererRegistryError(`${where}: duplicate inputs name '${name}'`);
		}
		names.add(name);
		return Object.freeze({ name, kind });
	});
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new RendererRegistryError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze({
		uuid: identity.uuid,
		index: input.index,
		name: identity.name,
		...(identity.label === undefined || identity.label === '' ? {} : { label: identity.label }),
		executor,
		inputs: Object.freeze(inputs),
		created_at: new Date(createdAt).toISOString(),
	});
}

/** Validates a set of entries of one `renderer_registry`: renderer UUIDs are unique. */
export function validateRendererRegistry(entries: readonly IRendererRegistryEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		const uuid = normalizeRegistryUuid(entry.uuid);
		if (uuids.has(uuid)) {
			throw new RendererRegistryError(`duplicate renderer uuid for '${entry.name}'`);
		}
		uuids.add(uuid);
	}
}

// #endregion

// #region renderer_registry storage

/** `registry.renderer_registry`: the Registry schema table holding `renderer_registry` entries. */
export const rendererRegistryTable = Object.freeze({ schema: REGISTRY_SCHEMA, table: 'renderer_registry' } as const);

export const rendererRegistryPhysicalTable = corePhysicalTableNameResolver.resolve(rendererRegistryTable.schema, rendererRegistryTable.table);

const registryColumns = ['uuid', 'index', 'name', 'label', 'executor', 'inputs', 'created_at'] as const;

/** Stored form: scalars as columns, `inputs` as JSON, an absent label as `''`. */
export function encodeRendererRegistryRow(entry: IRendererRegistryEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		index: entry.index,
		name: entry.name,
		label: entry.label ?? '',
		executor: entry.executor,
		inputs: JSON.stringify(entry.inputs.map(item => ({ name: item.name, kind: item.kind }))),
		created_at: entry.created_at,
	});
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeRendererRegistryRow(row: ProjectSqliteRow): IRendererRegistryEntry {
	const missingUuid = (): string => { throw new RendererRegistryError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	let inputs: unknown;
	try {
		inputs = JSON.parse(String(row.inputs));
	} catch {
		throw new RendererRegistryError(`stored renderer '${uuid}': inputs is not JSON`);
	}
	return createRendererRegistryEntry({
		uuid,
		index: row.index as number,
		name: row.name as string,
		label: typeof row.label === 'string' ? row.label : undefined,
		executor: row.executor as string,
		inputs: inputs as IRendererRegistryInput[],
		created_at: row.created_at as string,
	}, missingUuid);
}

/** `INSERT` statement and parameters writing `entry` into `registry.renderer_registry`. */
export function getRendererRegistryInsert(entry: IRendererRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeRendererRegistryRow(entry);
	return Object.freeze({
		sql: `INSERT INTO ${quoteIdentifier(rendererRegistryPhysicalTable)} (${registryColumns.map(quoteIdentifier).join(', ')}) VALUES (${registryColumns.map(() => '?').join(', ')})`,
		params: Object.freeze(registryColumns.map(column => row[column] as string | number)),
	});
}

/** Reads every `renderer_registry` entry from `project.sqlite` in Registry order (by `index`, then UUID). Each stored row is validated; UUIDs must be unique. */
export async function readRendererRegistry(database: IProjectSqliteStatements): Promise<readonly IRendererRegistryEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${registryColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(rendererRegistryPhysicalTable)}`);
	const entries = rows.map(decodeRendererRegistryRow).sort(compareTableRegistryOrder);
	validateRendererRegistry(entries);
	return Object.freeze(entries);
}

// #endregion

// #region renderer_binding

/** One binding value: a Persistent Address, or an `asset_uuid`. */
export type IRendererBindingValue =
	| { readonly address: IFunctionBindingAddress }
	| { readonly asset_uuid: string };

/** One `renderer_binding` entry. */
export interface IRendererBindingEntry {
	readonly uuid: string;
	readonly renderer: { readonly uuid: string };
	/** Keyed by `renderer_registry.inputs[].name`. */
	readonly bindings: Readonly<Record<string, IRendererBindingValue>>;
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** An INSERT / UPSERT input: the UUID is generated and `created_at` stamped when missing. */
export interface IRendererBindingEntryInput {
	readonly uuid?: string;
	readonly renderer: { readonly uuid: string };
	readonly bindings?: Readonly<Record<string, unknown>>;
	readonly created_at?: string;
}

export class RendererBindingError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor renderer_binding: ${message}`);
		this.name = 'RendererBindingError';
	}
}

function requireUuid(value: unknown, field: string, where: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new RendererBindingError(`${where}: ${field} must be a UUID`);
	}
	return normalizeRegistryUuid(value);
}

function createBindingValue(raw: unknown, where: string): IRendererBindingValue {
	if (!isPlainRecord(raw)) {
		throw new RendererBindingError(`${where}: must be an object with an address or an asset_uuid`);
	}
	const keys = Object.keys(raw);
	if (keys.length !== 1 || (keys[0] !== 'address' && keys[0] !== 'asset_uuid')) {
		throw new RendererBindingError(`${where}: must have exactly one of address | asset_uuid`);
	}
	if (keys[0] === 'asset_uuid') {
		return Object.freeze({ asset_uuid: requireUuid(raw.asset_uuid, 'asset_uuid', where) });
	}
	try {
		return Object.freeze({ address: createFunctionBindingAddress(raw.address, where) });
	} catch (error) {
		throw error instanceof FunctionBindingError ? new RendererBindingError(error.message.replace(/^Primitive App Editor function_binding: /, '')) : error;
	}
}

/**
 * Builds a validated `renderer_binding` entry: a missing UUID is generated and a supplied one kept,
 * `renderer.uuid` is a UUID and every `bindings` member is exactly a UUID-only Persistent Address or
 * an `asset_uuid`. Whether the Renderer / its inputs / the addressed Table and Column exist is
 * {@link validateRendererBindingAgainstRegistry} (Registry Resolve).
 */
export function createRendererBindingEntry(
	input: IRendererBindingEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IRendererBindingEntry {
	const uuid = input.uuid === undefined || input.uuid === '' ? generateUuid() : input.uuid;
	if (!isRegistryUuid(uuid)) {
		throw new RendererBindingError(`'${uuid}' is not a UUID`);
	}
	const where = `binding '${uuid.toLowerCase()}'`;
	if (!isPlainRecord(input.renderer)) {
		throw new RendererBindingError(`${where}: renderer must be an object with a uuid`);
	}
	const rendererUuid = requireUuid(input.renderer.uuid, 'renderer uuid', where);
	if (input.bindings !== undefined && !isPlainRecord(input.bindings)) {
		throw new RendererBindingError(`${where}: bindings must be an object keyed by renderer input name`);
	}
	const bindings: Record<string, IRendererBindingValue> = {};
	for (const [name, value] of Object.entries(input.bindings ?? {})) {
		if (name === '') {
			throw new RendererBindingError(`${where}: bindings name must be non-empty text`);
		}
		bindings[name] = createBindingValue(value, `${where} bindings '${name}'`);
	}
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new RendererBindingError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze({
		uuid: uuid.toLowerCase(),
		renderer: Object.freeze({ uuid: rendererUuid }),
		bindings: Object.freeze(bindings),
		created_at: new Date(createdAt).toISOString(),
	});
}

/** Validates a set of entries of one `renderer_binding`: binding UUIDs are unique. */
export function validateRendererBindings(entries: readonly IRendererBindingEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		if (uuids.has(entry.uuid)) {
			throw new RendererBindingError(`duplicate binding uuid '${entry.uuid}'`);
		}
		uuids.add(entry.uuid);
	}
}

/**
 * `Registry Resolve` of one binding: the Renderer Definition exists in `renderer_registry`, every
 * `bindings` name is an `inputs[].name` of that Definition, and every Persistent Address names a
 * table of `table_registry` and a column of that table. Nothing is guessed or completed.
 */
export function validateRendererBindingAgainstRegistry(
	entry: IRendererBindingEntry,
	renderers: readonly IRendererRegistryEntry[],
	tables: readonly ITableRegistryEntry[],
): IRendererRegistryEntry {
	const where = `binding '${entry.uuid}'`;
	const definition = renderers.find(candidate => candidate.uuid === entry.renderer.uuid);
	if (!definition) {
		throw new RendererBindingError(`${where}: renderer_registry has no renderer '${entry.renderer.uuid}' (Missing Definition)`);
	}
	const inputNames = new Set(definition.inputs.map(item => item.name));
	for (const [name, value] of Object.entries(entry.bindings)) {
		if (!inputNames.has(name)) {
			throw new RendererBindingError(`${where}: renderer '${definition.name}' has no input '${name}'`);
		}
		if (hasKey(value, { address: true })) {
			const table = tables.find(candidate => candidate.uuid === value.address.table_uuid);
			if (!table) {
				throw new RendererBindingError(`${where}: bindings '${name}' address table '${value.address.table_uuid}' is not in table_registry (Missing Definition)`);
			}
			if (!table.columns.some(column => column.uuid === value.address.column_uuid)) {
				throw new RendererBindingError(`${where}: bindings '${name}' address column '${value.address.column_uuid}' is not a column of table '${table.name}' (Missing Definition)`);
			}
		}
	}
	return definition;
}

// #endregion

// #region renderer_binding storage

/** `binding.renderer_binding`: the Editor built-in table holding concrete Renderer Binding rows. */
export const rendererBindingTable = Object.freeze({ schema: 'binding', table: 'renderer_binding' } as const);

export const rendererBindingPhysicalTable = corePhysicalTableNameResolver.resolve(rendererBindingTable.schema, rendererBindingTable.table);

const bindingColumns = ['uuid', 'renderer_uuid', 'bindings', 'created_at'] as const;

/** Stored form: scalars as columns, `bindings` as JSON (UUID addresses / asset_uuid only). */
export function encodeRendererBindingRow(entry: IRendererBindingEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		renderer_uuid: entry.renderer.uuid,
		bindings: JSON.stringify(entry.bindings),
		created_at: entry.created_at,
	});
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeRendererBindingRow(row: ProjectSqliteRow): IRendererBindingEntry {
	const missingUuid = (): string => { throw new RendererBindingError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	let bindings: unknown;
	try {
		bindings = JSON.parse(String(row.bindings));
	} catch {
		throw new RendererBindingError(`stored binding '${uuid}': bindings is not JSON`);
	}
	return createRendererBindingEntry({
		uuid,
		renderer: { uuid: row.renderer_uuid as string },
		bindings: bindings as Record<string, unknown>,
		created_at: row.created_at as string,
	}, missingUuid);
}

function compareBindingOrder(a: IRendererBindingEntry, b: IRendererBindingEntry): number {
	return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

/** Reads every binding from `project.sqlite` in deterministic order (by `created_at`, then UUID). Each stored row is validated; UUIDs must be unique. */
export async function readRendererBindings(database: IProjectSqliteStatements): Promise<readonly IRendererBindingEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${bindingColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(rendererBindingPhysicalTable)}`);
	const entries = rows.map(decodeRendererBindingRow).sort(compareBindingOrder);
	validateRendererBindings(entries);
	return Object.freeze(entries);
}

// #endregion

// #region Renderer Binding Service

/** `select` request. `where` keys are `uuid` and `renderer_uuid`. */
export interface IRendererBindingSelect {
	readonly where?: Readonly<Partial<Record<'uuid' | 'renderer_uuid', string>>>;
	readonly limit?: number;
	/** Result Mapping: resolve the Renderer and every Persistent Address to `name / label` for display. */
	readonly resolveDisplay?: boolean;
}

/** Editor Human Display of one binding (`bindings` keyed by input name; asset values are not resolved here). */
export interface IRendererBindingDisplay {
	readonly renderer: string | undefined;
	readonly bindings: Readonly<Record<string, IFunctionBindingAddressDisplay | undefined>>;
}

export interface IRendererBindingRow {
	readonly binding: IRendererBindingEntry;
	readonly display?: IRendererBindingDisplay;
}

export interface IRendererBindingMutationResult {
	readonly uuid: string;
	readonly binding: IRendererBindingEntry;
}

export interface IRendererBindingUpsertResult extends IRendererBindingMutationResult {
	readonly operation: 'insert' | 'update';
}

/** `update` payload: the concrete `bindings` of an existing binding. The binding `uuid` and `renderer.uuid` (its Definition) are not changed here. */
export interface IRendererBindingUpdate {
	readonly bindings?: Readonly<Record<string, unknown>>;
}

export interface IRendererBindingServiceOptions {
	readonly generateUuid?: () => string;
	readonly now?: () => Date;
}

/**
 * Renderer Binding persistence as generic Resolver dispatches (`insert` / `update` / `upsert` /
 * `delete` / `select`). Each one runs in one transaction and starts with Registry Resolve: the
 * Renderer Definition comes from `renderer_registry` and every Persistent Address from
 * `table_registry`, so no Renderer / input / Table name is hard-coded here. Registry Definitions
 * are never changed here.
 */
export class RendererBindingService {

	private readonly generateUuid: () => string;
	private readonly now: () => Date;

	constructor(
		private readonly database: Pick<IProjectSqliteDatabase, 'transaction'>,
		options: IRendererBindingServiceOptions = {},
	) {
		this.generateUuid = options.generateUuid ?? generateRandomUuid;
		this.now = options.now ?? (() => new Date());
	}

	/** `insert(request)`: Registry Resolve -> Payload Map -> INSERT. The binding uuid is generated when missing. */
	insert(input: IRendererBindingEntryInput): Promise<IRendererBindingMutationResult> {
		return this.run(async (statements, context) => {
			const binding = createRendererBindingEntry(input, this.generateUuid, this.now);
			validateRendererBindingAgainstRegistry(binding, context.renderers, context.tables);
			if (await this.find(statements, binding.uuid)) {
				throw new RendererBindingError(`binding '${binding.uuid}' already exists`);
			}
			await this.insertRow(statements, binding);
			return { uuid: binding.uuid, binding };
		});
	}

	/** `update(request)`: Target UUID Resolve -> Registry Resolve -> Kind Validate -> UPDATE. `uuid`, `renderer.uuid` and `created_at` are not changed. */
	update(uuid: string, values: IRendererBindingUpdate): Promise<IRendererBindingMutationResult> {
		return this.run(async (statements, context) => {
			const bindingUuid = requireUuid(uuid, 'update target uuid', 'update');
			const keys = Object.keys(values);
			if (keys.length === 0) {
				throw new RendererBindingError('update requires at least one value');
			}
			for (const key of keys) {
				if (key !== 'bindings') {
					throw new RendererBindingError(`update cannot change '${key}'`);
				}
			}
			const existing = await this.require(statements, bindingUuid);
			const binding = createRendererBindingEntry({
				uuid: existing.uuid,
				renderer: existing.renderer,
				bindings: values.bindings ?? existing.bindings,
				created_at: existing.created_at,
			}, this.generateUuid, this.now);
			validateRendererBindingAgainstRegistry(binding, context.renderers, context.tables);
			await this.updateRow(statements, binding);
			return { uuid: bindingUuid, binding };
		});
	}

	/**
	 * `upsert(request)`: the Conflict Identity is the binding `uuid` (PRIMARY KEY, the only unique
	 * identity of `renderer_binding`). It is never guessed: a request without it is rejected. An
	 * existing binding keeps its `created_at` and its Definition (`renderer.uuid`).
	 */
	upsert(input: IRendererBindingEntryInput): Promise<IRendererBindingUpsertResult> {
		return this.run(async (statements, context) => {
			if (input.uuid === undefined || input.uuid === '') {
				throw new RendererBindingError(`upsert requires the Conflict Identity 'uuid'`);
			}
			const requested = createRendererBindingEntry(input, this.generateUuid, this.now);
			const existing = await this.find(statements, requested.uuid);
			if (!existing) {
				validateRendererBindingAgainstRegistry(requested, context.renderers, context.tables);
				await this.insertRow(statements, requested);
				return { operation: 'insert' as const, uuid: requested.uuid, binding: requested };
			}
			if (existing.renderer.uuid !== requested.renderer.uuid) {
				throw new RendererBindingError(`binding '${requested.uuid}': upsert cannot change the renderer (${existing.renderer.uuid} -> ${requested.renderer.uuid})`);
			}
			const binding = Object.freeze({ ...requested, created_at: existing.created_at });
			validateRendererBindingAgainstRegistry(binding, context.renderers, context.tables);
			await this.updateRow(statements, binding);
			return { operation: 'update' as const, uuid: binding.uuid, binding };
		});
	}

	/** `delete(request)`: Target Resolve -> DELETE of one binding. The Renderer Definition and the addressed Raw Data are untouched. */
	delete(uuid: string): Promise<IRendererBindingEntry> {
		return this.run(async statements => {
			const bindingUuid = requireUuid(uuid, 'delete target uuid', 'delete');
			const existing = await this.require(statements, bindingUuid);
			await statements.run(`DELETE FROM ${quoteIdentifier(rendererBindingPhysicalTable)} WHERE "uuid" = ?`, [bindingUuid]);
			return existing;
		});
	}

	/** `select(request)`: Query Map -> SELECT -> Result Mapping (UUID -> name / label when `resolveDisplay`). */
	select(request: IRendererBindingSelect = {}): Promise<readonly IRendererBindingRow[]> {
		return this.run(async (statements, context) => {
			const conditions: string[] = [];
			const params: ProjectSqliteValue[] = [];
			for (const [key, value] of Object.entries(request.where ?? {})) {
				if (key !== 'uuid' && key !== 'renderer_uuid') {
					throw new RendererBindingError(`select cannot filter on '${key}'`);
				}
				conditions.push(`${quoteIdentifier(key)} = ?`);
				params.push(requireUuid(value, `where '${key}'`, 'select'));
			}
			if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) {
				throw new RendererBindingError('select limit must be a non-negative int');
			}
			let sql = `SELECT ${bindingColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(rendererBindingPhysicalTable)}`;
			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(' AND ')}`;
			}
			sql += ' ORDER BY "created_at", "uuid"';
			if (request.limit !== undefined) {
				sql += ` LIMIT ${request.limit}`;
			}
			const rows = await statements.all(sql, params);
			return Object.freeze(rows.map(row => {
				const binding = decodeRendererBindingRow(row);
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
			const renderers = await readRendererRegistry(statements);
			const tables = await readTableRegistry(statements);
			return work(statements, { renderers, tables });
		});
	}

	private display(binding: IRendererBindingEntry, context: IRegistryContext): IRendererBindingDisplay {
		const definition = context.renderers.find(candidate => candidate.uuid === binding.renderer.uuid);
		return Object.freeze({
			renderer: definition ? getRegistryDisplayText(definition) : undefined,
			bindings: Object.freeze(Object.fromEntries(Object.entries(binding.bindings)
				.filter(([, value]) => hasKey(value, { address: true }))
				.map(([name, value]) => [name, resolveFunctionBindingAddressDisplay((value as { address: IFunctionBindingAddress }).address, context.tables)]))),
		});
	}

	private async insertRow(statements: IProjectSqliteStatements, binding: IRendererBindingEntry): Promise<void> {
		const row = encodeRendererBindingRow(binding);
		await statements.run(
			`INSERT INTO ${quoteIdentifier(rendererBindingPhysicalTable)} (${bindingColumns.map(quoteIdentifier).join(', ')}) VALUES (${bindingColumns.map(() => '?').join(', ')})`,
			bindingColumns.map(column => row[column]));
	}

	private async updateRow(statements: IProjectSqliteStatements, binding: IRendererBindingEntry): Promise<void> {
		const row = encodeRendererBindingRow(binding);
		const assignable = bindingColumns.filter(column => column !== 'uuid' && column !== 'created_at');
		await statements.run(
			`UPDATE ${quoteIdentifier(rendererBindingPhysicalTable)} SET ${assignable.map(column => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE "uuid" = ?`,
			[...assignable.map(column => row[column]), binding.uuid]);
	}

	private async find(statements: IProjectSqliteStatements, uuid: string): Promise<IRendererBindingEntry | undefined> {
		const row = await statements.get(`SELECT ${bindingColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(rendererBindingPhysicalTable)} WHERE "uuid" = ?`, [uuid]);
		return row ? decodeRendererBindingRow(row) : undefined;
	}

	private async require(statements: IProjectSqliteStatements, uuid: string): Promise<IRendererBindingEntry> {
		const binding = await this.find(statements, uuid);
		if (!binding) {
			throw new RendererBindingError(`binding '${uuid}' does not exist`);
		}
		return binding;
	}

	// #endregion
}

interface IRegistryContext {
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly tables: readonly ITableRegistryEntry[];
}

// #endregion
