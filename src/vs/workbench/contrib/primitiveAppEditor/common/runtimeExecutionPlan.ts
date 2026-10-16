/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Validated execution plan construction (runtime.execution-plan)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (22. Function Runtime / Load)
 *  Boundary: App Editer.md (20. Plan, 20. Order, 23. Load)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { dispatch as dispatchFunction, FunctionArguments } from './functionDispatcher.js';
import {
	IFunctionBindingEntry,
	readFunctionBindings,
	validateFunctionBindingAgainstRegistry,
	validateFunctionBindings,
} from './functionBinding.js';
import {
	buildFunctionExecutionPlan,
	IFunctionDependencyEntry,
	readFunctionDependencies,
} from './functionDependency.js';
import { IFunctionExecutorCatalog, IFunctionRegistryEntry, readFunctionRegistry } from './functionRegistry.js';
import { resolveFunctionExecutors } from './functionProgramScan.js';
import { IProjectSqliteDatabase } from './projectSqlite.js';
import {
	IRuntimeBindingHandles,
	IRuntimeState,
	loadRuntimeState,
	resolveBindingHandles,
} from './runtimeState.js';
import { ITableRegistryEntry, readTableRegistry } from './tableRegistry.js';

/**
 * ```text
 * Function Registry + Function Binding + Dependency
 *   -> Validate -> Executor Resolve -> Constructor Bind -> Runtime Address Resolve
 *   -> Execution Plan -> Function Instance -> Memory
 * ```
 *
 * Every stage rejects instead of completing: a dangling Definition / Address, a missing executor and
 * a cycle reject Load / Build, so a plan that is returned is fully resolved and the Runtime Loop has
 * nothing left to look up. The plan is derived and never stored; the Function Instances live in
 * `state.functions.<binding_uuid>.instance` (Memory), never in SQLite.
 */

/** `Function Instance`: a primitive with its constructor bound. Holds no scheduling and no database reference. */
export interface IRuntimeFunctionInstance {
	readonly function_uuid: string;
	readonly name: string;
	readonly executor: string;
	/** Constructor Bind: Registry `constructor[].default` overridden by the binding's `constructor` values. */
	readonly constructor_values: Readonly<Record<string, unknown>>;
	/** Registry `parameters[].default` values; the binding's resolved parameter values override them per call. */
	readonly parameter_defaults: Readonly<Record<string, unknown>>;
	/** Runs the primitive once through the Function Dispatcher with the bound constructor values. */
	invoke(args: FunctionArguments): unknown;
}

/** One fully resolved node of the Execution Plan. */
export interface IRuntimeExecutionPlanStep {
	readonly binding: IFunctionBindingEntry;
	readonly depends_on: readonly string[];
	readonly definition: IFunctionRegistryEntry;
	readonly instance: IRuntimeFunctionInstance;
	readonly handles: IRuntimeBindingHandles;
}

export interface IRuntimeExecutionPlanSources {
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly bindings: readonly IFunctionBindingEntry[];
	readonly dependencies: readonly IFunctionDependencyEntry[];
	readonly tables: readonly ITableRegistryEntry[];
	readonly catalog: IFunctionExecutorCatalog;
}

export interface IRuntimeExecutionPlanOptions {
	/** Function Dispatcher used by the instances; defaults to the Code dispatcher. */
	readonly dispatch?: (functionName: string, args: FunctionArguments) => unknown;
}

function defaultsOf(items: IFunctionRegistryEntry['constructor']): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const item of items) {
		if (item.default !== undefined) {
			values[item.name] = item.default;
		}
	}
	return values;
}

/** Constructor Bind: registers the instance of one binding with its constructor values fixed. */
function bindConstructor(binding: IFunctionBindingEntry, definition: IFunctionRegistryEntry, dispatch: NonNullable<IRuntimeExecutionPlanOptions['dispatch']>): IRuntimeFunctionInstance {
	const constructorValues = Object.freeze({ ...defaultsOf(definition.constructor), ...binding.constructor });
	const parameterDefaults = Object.freeze(defaultsOf(definition.parameters));
	return Object.freeze({
		function_uuid: definition.uuid,
		name: definition.name,
		executor: definition.executor,
		constructor_values: constructorValues,
		parameter_defaults: parameterDefaults,
		invoke: (args: FunctionArguments) => dispatch(definition.name, { ...constructorValues, ...parameterDefaults, ...args }),
	});
}

/**
 * Validate -> Executor Resolve -> Constructor Bind -> Runtime Address Resolve -> Execution Plan ->
 * Function Instance -> Memory. Pure memory work: `state` must already hold the Load result. Nothing is
 * written to `state` unless the whole plan is valid.
 */
export function buildRuntimeExecutionPlan(
	state: IRuntimeState,
	sources: IRuntimeExecutionPlanSources,
	options: IRuntimeExecutionPlanOptions = {},
): readonly IRuntimeExecutionPlanStep[] {
	const dispatch = options.dispatch ?? dispatchFunction;

	// Validate: Binding identity, Registry Resolve of every binding, then Executor Resolve.
	validateFunctionBindings(sources.bindings);
	const definitions = new Map<string, IFunctionRegistryEntry>();
	for (const binding of sources.bindings) {
		definitions.set(binding.uuid, validateFunctionBindingAgainstRegistry(binding, sources.functions, sources.tables));
	}
	resolveFunctionExecutors(sources.functions, sources.catalog);

	// Dependency Graph -> Validate (edges, cycle) -> Order (dependency, then index).
	const ordered = buildFunctionExecutionPlan(sources.bindings, sources.dependencies);

	// Constructor Bind + Runtime Address Resolve, all before any state mutation.
	const steps: IRuntimeExecutionPlanStep[] = ordered.map(step => {
		const definition = definitions.get(step.binding.uuid)!;
		return Object.freeze({
			binding: step.binding,
			depends_on: step.depends_on,
			definition,
			instance: bindConstructor(step.binding, definition, dispatch),
			handles: resolveBindingHandles(state, sources.tables, step.binding),
		});
	});

	// Function Instance -> Memory.
	for (const step of steps) {
		const slot = state.functions.get(step.binding.uuid);
		if (slot) {
			slot.instance = step.instance;
		} else {
			state.functions.set(step.binding.uuid, { instance: step.instance, output: undefined });
		}
	}
	return Object.freeze(steps);
}

export interface ILoadedRuntime {
	readonly state: IRuntimeState;
	readonly plan: readonly IRuntimeExecutionPlanStep[];
}

/**
 * Load: reads the Registry, Bindings, Dependencies and Raw Data once from `project.sqlite`, then
 * builds the validated Execution Plan into a fresh Runtime State. A rejection leaves nothing behind.
 */
export async function loadRuntimeExecutionPlan(
	database: Pick<IProjectSqliteDatabase, 'transaction'>,
	catalog: IFunctionExecutorCatalog,
	options: IRuntimeExecutionPlanOptions = {},
): Promise<ILoadedRuntime> {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	const sources = await database.transaction(async statements => ({
		functions: await readFunctionRegistry(statements, catalog),
		bindings: await readFunctionBindings(statements),
		dependencies: await readFunctionDependencies(statements),
		tables: await readTableRegistry(statements),
		catalog,
	}));
	const state = await loadRuntimeState(database);
	const plan = buildRuntimeExecutionPlan(state, sources, options);
	return Object.freeze({ state, plan });
}

