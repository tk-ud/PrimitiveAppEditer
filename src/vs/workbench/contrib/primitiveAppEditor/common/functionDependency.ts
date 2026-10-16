/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_dependency (binding.dependency)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (20. Function Dependency)
 *  Boundary: docs/primitive-app-editor/Function Graph.md (3, 4, 8, 9, 13), Resolver.md (9 insert, 10 delete)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import {
	FunctionBindingSource,
	IFunctionBindingEntry,
	readFunctionBindings,
} from './functionBinding.js';
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
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { isTimestampValue } from './tableRegistry.js';

/**
 * `function_dependency` = one Edge of the Function Graph: the output of `source_binding` feeds the
 * input `target_input.name` of `target_binding` (`source: function_output`). Node = `function_binding`.
 *
 * The persistent definition is only the Edge; the Dependency Graph, the Execution Plan and its order
 * are derived from `function_binding` + `function_dependency` and never stored. A cycle is rejected
 * when the graph is built (Load / Build reject).
 *
 * Order: dependency is the primary order; for independent nodes `index` (then UUID) gives a
 * deterministic order.
 */

// #region function_dependency

export interface IFunctionDependencyEntry {
	readonly uuid: string;
	readonly source_binding: { readonly uuid: string };
	readonly target_binding: { readonly uuid: string };
	readonly target_input: { readonly name: string };
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** An INSERT input: the UUID is generated and `created_at` stamped when missing. */
export interface IFunctionDependencyEntryInput {
	readonly uuid?: string;
	readonly source_binding: { readonly uuid: string };
	readonly target_binding: { readonly uuid: string };
	readonly target_input: { readonly name: string };
	readonly created_at?: string;
}

export class FunctionDependencyError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor function_dependency: ${message}`);
		this.name = 'FunctionDependencyError';
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string, where: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new FunctionDependencyError(`${where}: ${field} must be a UUID`);
	}
	return normalizeRegistryUuid(value);
}

function requireBindingRef(value: unknown, field: string, where: string): { readonly uuid: string } {
	if (!isPlainRecord(value)) {
		throw new FunctionDependencyError(`${where}: ${field} must be an object with a uuid`);
	}
	return Object.freeze({ uuid: requireUuid(value.uuid, `${field} uuid`, where) });
}

/**
 * Builds a validated `function_dependency` entry: a missing UUID is generated and a supplied one
 * kept, both bindings are UUIDs, a binding cannot depend on itself and `target_input.name` is
 * non-empty text. Whether the bindings / input exist is checked against `function_binding`
 * ({@link validateFunctionDependencyAgainstBindings}).
 */
export function createFunctionDependencyEntry(
	input: IFunctionDependencyEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IFunctionDependencyEntry {
	const uuid = input.uuid === undefined || input.uuid === '' ? generateUuid() : input.uuid;
	if (!isRegistryUuid(uuid)) {
		throw new FunctionDependencyError(`'${uuid}' is not a UUID`);
	}
	const where = `dependency '${uuid.toLowerCase()}'`;
	const source = requireBindingRef(input.source_binding, 'source_binding', where);
	const target = requireBindingRef(input.target_binding, 'target_binding', where);
	if (source.uuid === target.uuid) {
		throw new FunctionDependencyError(`${where}: binding '${source.uuid}' cannot depend on itself (cycle)`);
	}
	if (!isPlainRecord(input.target_input) || typeof input.target_input.name !== 'string' || input.target_input.name === '') {
		throw new FunctionDependencyError(`${where}: target_input.name must be non-empty text`);
	}
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new FunctionDependencyError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze({
		uuid: uuid.toLowerCase(),
		source_binding: source,
		target_binding: target,
		target_input: Object.freeze({ name: input.target_input.name }),
		created_at: new Date(createdAt).toISOString(),
	});
}

/** Validates a set of dependency entries: UUIDs are unique and one input of a binding has one producer. */
export function validateFunctionDependencies(entries: readonly IFunctionDependencyEntry[]): void {
	const uuids = new Set<string>();
	const inputs = new Set<string>();
	for (const entry of entries) {
		if (uuids.has(entry.uuid)) {
			throw new FunctionDependencyError(`duplicate dependency uuid '${entry.uuid}'`);
		}
		uuids.add(entry.uuid);
		const key = `${entry.target_binding.uuid}\u0000${entry.target_input.name}`;
		if (inputs.has(key)) {
			throw new FunctionDependencyError(`input '${entry.target_input.name}' of binding '${entry.target_binding.uuid}' already has a dependency`);
		}
		inputs.add(key);
	}
}

// #endregion

// #region Dependency Graph / Validate / Execution Plan

/** One node of the Execution Plan: a binding and the bindings whose output it consumes. */
export interface IFunctionExecutionPlanStep {
	readonly binding: IFunctionBindingEntry;
	readonly depends_on: readonly string[];
}

/**
 * Edge check of one dependency against the bindings: both bindings exist, and the input named by
 * `target_input` of the target binding is bound `source: function_output` to the source binding.
 */
export function validateFunctionDependencyAgainstBindings(entry: IFunctionDependencyEntry, bindings: readonly IFunctionBindingEntry[]): void {
	const where = `dependency '${entry.uuid}'`;
	if (!bindings.some(binding => binding.uuid === entry.source_binding.uuid)) {
		throw new FunctionDependencyError(`${where}: function_binding has no source binding '${entry.source_binding.uuid}' (Missing Definition)`);
	}
	const target = bindings.find(binding => binding.uuid === entry.target_binding.uuid);
	if (!target) {
		throw new FunctionDependencyError(`${where}: function_binding has no target binding '${entry.target_binding.uuid}' (Missing Definition)`);
	}
	const argument = Object.prototype.hasOwnProperty.call(target.inputs, entry.target_input.name) ? target.inputs[entry.target_input.name] : undefined;
	if (!argument) {
		throw new FunctionDependencyError(`${where}: binding '${target.uuid}' has no input '${entry.target_input.name}'`);
	}
	if (argument.source !== FunctionBindingSource.FunctionOutput || argument.function_binding_uuid !== entry.source_binding.uuid) {
		throw new FunctionDependencyError(`${where}: input '${entry.target_input.name}' of binding '${target.uuid}' is not 'function_output' of binding '${entry.source_binding.uuid}'`);
	}
}

/**
 * Function Binding + Function Dependency -> Dependency Graph -> Validate -> Execution Plan.
 *
 * Validate: every dependency matches its bindings, every `function_output` input has its dependency
 * (the Edge is the persistent definition), and the graph has no cycle (a cycle rejects Load / Build).
 * Order: a producer always precedes its consumers; among independent nodes the next one is the
 * lowest `index` (then UUID). The plan is derived and never stored. `allowUndeclared` skips the
 * 'every `function_output` input has its dependency' check (used while Edges are still being added).
 */
export function buildFunctionExecutionPlan(
	bindings: readonly IFunctionBindingEntry[],
	dependencies: readonly IFunctionDependencyEntry[],
	options: { readonly allowUndeclared?: boolean } = {},
): readonly IFunctionExecutionPlanStep[] {
	validateFunctionDependencies(dependencies);
	const byUuid = new Map<string, IFunctionBindingEntry>();
	for (const binding of bindings) {
		if (byUuid.has(binding.uuid)) {
			throw new FunctionDependencyError(`duplicate binding uuid '${binding.uuid}'`);
		}
		byUuid.set(binding.uuid, binding);
	}
	for (const dependency of dependencies) {
		validateFunctionDependencyAgainstBindings(dependency, bindings);
	}
	const declared = new Set(dependencies.map(dependency => `${dependency.target_binding.uuid}\u0000${dependency.target_input.name}`));
	for (const binding of options.allowUndeclared ? [] : bindings) {
		for (const [name, argument] of Object.entries(binding.inputs)) {
			if (argument.source === FunctionBindingSource.FunctionOutput && !declared.has(`${binding.uuid}\u0000${name}`)) {
				throw new FunctionDependencyError(`binding '${binding.uuid}': input '${name}' is 'function_output' without a function_dependency`);
			}
		}
	}

	const producers = new Map<string, Set<string>>();
	const consumers = new Map<string, Set<string>>();
	for (const binding of bindings) {
		producers.set(binding.uuid, new Set());
		consumers.set(binding.uuid, new Set());
	}
	for (const dependency of dependencies) {
		producers.get(dependency.target_binding.uuid)!.add(dependency.source_binding.uuid);
		consumers.get(dependency.source_binding.uuid)!.add(dependency.target_binding.uuid);
	}

	const remaining = new Map([...producers].map(([uuid, set]) => [uuid, set.size]));
	const compare = (a: IFunctionBindingEntry, b: IFunctionBindingEntry) => a.index - b.index || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
	const ready = bindings.filter(binding => remaining.get(binding.uuid) === 0).sort(compare);
	const plan: IFunctionExecutionPlanStep[] = [];
	while (ready.length > 0) {
		const binding = ready.shift()!;
		plan.push(Object.freeze({ binding, depends_on: Object.freeze([...producers.get(binding.uuid)!].sort()) }));
		for (const consumer of consumers.get(binding.uuid)!) {
			const left = remaining.get(consumer)! - 1;
			remaining.set(consumer, left);
			if (left === 0) {
				ready.push(byUuid.get(consumer)!);
			}
		}
		ready.sort(compare);
	}
	if (plan.length !== bindings.length) {
		const cyclic = bindings.filter(binding => remaining.get(binding.uuid)! > 0).map(binding => binding.uuid).sort();
		throw new FunctionDependencyError(`cycle detected among bindings ${cyclic.map(uuid => `'${uuid}'`).join(', ')} (Load / Build reject)`);
	}
	return Object.freeze(plan);
}

// #endregion

// #region Storage (project.sqlite)

/** `binding.function_dependency`: the Editor built-in table holding the Edges of the Function Graph. */
export const functionDependencyTable = Object.freeze({ schema: 'binding', table: 'function_dependency' } as const);

export const functionDependencyPhysicalTable = corePhysicalTableNameResolver.resolve(functionDependencyTable.schema, functionDependencyTable.table);

const storedColumns = ['uuid', 'source_binding_uuid', 'target_binding_uuid', 'target_input_name', 'created_at'] as const;

export function encodeFunctionDependencyRow(entry: IFunctionDependencyEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		source_binding_uuid: entry.source_binding.uuid,
		target_binding_uuid: entry.target_binding.uuid,
		target_input_name: entry.target_input.name,
		created_at: entry.created_at,
	});
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeFunctionDependencyRow(row: ProjectSqliteRow): IFunctionDependencyEntry {
	const missingUuid = (): string => { throw new FunctionDependencyError('stored entry has no uuid'); };
	return createFunctionDependencyEntry({
		uuid: typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid(),
		source_binding: { uuid: row.source_binding_uuid as string },
		target_binding: { uuid: row.target_binding_uuid as string },
		target_input: { name: row.target_input_name as string },
		created_at: row.created_at as string,
	}, missingUuid);
}

function compareDependencyOrder(a: IFunctionDependencyEntry, b: IFunctionDependencyEntry): number {
	return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

/** Reads every dependency from `project.sqlite` in deterministic order (by UUID). Each stored row is validated. */
export async function readFunctionDependencies(database: IProjectSqliteStatements): Promise<readonly IFunctionDependencyEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionDependencyPhysicalTable)}`);
	const entries = rows.map(decodeFunctionDependencyRow).sort(compareDependencyOrder);
	validateFunctionDependencies(entries);
	return Object.freeze(entries);
}

/**
 * Load / Build: `function_binding` + `function_dependency` -> Dependency Graph -> Validate ->
 * Execution Plan. Rejects a dangling or inconsistent dependency and a cycle.
 */
export async function loadFunctionExecutionPlan(database: IProjectSqliteStatements): Promise<readonly IFunctionExecutionPlanStep[]> {
	const bindings = await readFunctionBindings(database);
	const dependencies = await readFunctionDependencies(database);
	return buildFunctionExecutionPlan(bindings, dependencies);
}

// #endregion

// #region Function Dependency Service

/** `select` request. `where` keys are `uuid`, `source_binding_uuid` and `target_binding_uuid`. */
export interface IFunctionDependencySelect {
	readonly where?: Readonly<Partial<Record<'uuid' | 'source_binding_uuid' | 'target_binding_uuid', string>>>;
	readonly limit?: number;
}

export interface IFunctionDependencyMutationResult {
	readonly uuid: string;
	readonly dependency: IFunctionDependencyEntry;
}

export interface IFunctionDependencyServiceOptions {
	readonly generateUuid?: () => string;
	readonly now?: () => Date;
}

/**
 * Graph Edge persistence as generic Resolver dispatches (`insert` / `delete` / `select`). Edge Add =
 * INSERT `function_dependency`, Edge Delete = DELETE `function_dependency`. Each runs in one
 * transaction; an Edge that would not match its bindings or would close a cycle is rejected before
 * anything is written. Bindings themselves are never changed here.
 */
export class FunctionDependencyService {

	private readonly generateUuid: () => string;
	private readonly now: () => Date;

	constructor(
		private readonly database: Pick<IProjectSqliteDatabase, 'transaction'>,
		options: IFunctionDependencyServiceOptions = {},
	) {
		this.generateUuid = options.generateUuid ?? generateRandomUuid;
		this.now = options.now ?? (() => new Date());
	}

	/** `insert(request)`: Binding Resolve -> Validate (incl. cycle) -> INSERT. The uuid is generated when missing. */
	insert(input: IFunctionDependencyEntryInput): Promise<IFunctionDependencyMutationResult> {
		return this.run(async statements => {
			const dependency = createFunctionDependencyEntry(input, this.generateUuid, this.now);
			const bindings = await readFunctionBindings(statements);
			const existing = await readFunctionDependencies(statements);
			if (existing.some(candidate => candidate.uuid === dependency.uuid)) {
				throw new FunctionDependencyError(`dependency '${dependency.uuid}' already exists`);
			}
			// Validates the Edge against its bindings, the one-producer-per-input rule and the absence of a cycle.
			buildFunctionExecutionPlan(bindings, [...existing, dependency], { allowUndeclared: true });
			await statements.run(
				`INSERT INTO ${quoteIdentifier(functionDependencyPhysicalTable)} (${storedColumns.map(quoteIdentifier).join(', ')}) VALUES (${storedColumns.map(() => '?').join(', ')})`,
				storedColumns.map(column => encodeFunctionDependencyRow(dependency)[column]));
			return { uuid: dependency.uuid, dependency };
		});
	}

	/** `delete(request)`: Target Resolve -> DELETE of one Edge. Bindings are untouched. */
	delete(uuid: string): Promise<IFunctionDependencyEntry> {
		return this.run(async statements => {
			const dependencyUuid = requireUuid(uuid, 'delete target uuid', 'delete');
			const row = await statements.get(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionDependencyPhysicalTable)} WHERE "uuid" = ?`, [dependencyUuid]);
			if (!row) {
				throw new FunctionDependencyError(`dependency '${dependencyUuid}' does not exist`);
			}
			await statements.run(`DELETE FROM ${quoteIdentifier(functionDependencyPhysicalTable)} WHERE "uuid" = ?`, [dependencyUuid]);
			return decodeFunctionDependencyRow(row);
		});
	}

	/** `select(request)`: Query Map -> SELECT. */
	select(request: IFunctionDependencySelect = {}): Promise<readonly IFunctionDependencyEntry[]> {
		return this.run(async statements => {
			const conditions: string[] = [];
			const params: ProjectSqliteValue[] = [];
			for (const [key, value] of Object.entries(request.where ?? {})) {
				if (key !== 'uuid' && key !== 'source_binding_uuid' && key !== 'target_binding_uuid') {
					throw new FunctionDependencyError(`select cannot filter on '${key}'`);
				}
				conditions.push(`${quoteIdentifier(key)} = ?`);
				params.push(requireUuid(value, `where '${key}'`, 'select'));
			}
			if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) {
				throw new FunctionDependencyError('select limit must be a non-negative int');
			}
			let sql = `SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(functionDependencyPhysicalTable)}`;
			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(' AND ')}`;
			}
			sql += ' ORDER BY "uuid"';
			if (request.limit !== undefined) {
				sql += ` LIMIT ${request.limit}`;
			}
			const rows = await statements.all(sql, params);
			return Object.freeze(rows.map(decodeFunctionDependencyRow));
		});
	}

	private run<T>(work: (statements: IProjectSqliteStatements) => Promise<T>): Promise<T> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		return this.database.transaction(work);
	}
}

// #endregion
