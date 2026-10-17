/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function Graph authoring (editor.function-graph)
 *  Specification SSOT: docs/primitive-app-editor/Function Graph.md, App Editer.md (39. Function Graph)
 *  Boundary: App Editer.md (20, 21), Editor UI.md (2, 10, 11), Function Graph.md (2, 4, 7, 10, 12, 14)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { DataEditorSelection, DataEditorTabs, DataEditorTarget, IDataEditorTab } from './dataEditor.js';
import { FunctionBindingSource, IFunctionBindingEntry, IFunctionBindingRow, resolveFunctionBindingAddressDisplay } from './functionBinding.js';
import { buildFunctionExecutionPlan, IFunctionDependencyEntry } from './functionDependency.js';
import { IFunctionRegistryEntry } from './functionRegistry.js';
import { getRegistryDisplayText, normalizeRegistryUuid } from './registryIdentity.js';
import { IAppEditorApi } from './resolver.js';
import { ITableRegistryEntry } from './tableRegistry.js';

/**
 * Function Graph (editor.function-graph): `function_binding` + `function_dependency` -> Graph.
 *
 * ```text
 * Node = function_binding   Edge = function_dependency / function_output
 * Target = UUID Address     Merge = overwrite | overlay
 * ```
 *
 * This is the Editor Area Dependency / Structural Authoring model. It is Derived from the Registry,
 * Binding and Dependency snapshot and keeps no authority of its own:
 *
 * - {@link buildFunctionGraph}: pure projection of the snapshot into Nodes / Edges (Node
 *   Presentation / Edge Presentation). Function Definitions are looked up, never copied per Node.
 * - {@link FunctionGraphModel}: Read = `select`; Edge Add = `insert` `function_dependency`; Edge
 *   Delete = `delete` `function_dependency`, each dispatched to the generic Resolver and followed by a
 *   reload, so UI state never diverges from the DB Definition.
 * - Node / Edge selection writes the Shared Selection Context (the `function_binding.uuid`) which the
 *   single Registry Driven Inspector resolves; there is no Graph Inspector.
 *
 * Binding INSERT / DELETE (Inspector) and Binding detail UPDATE (Registry-driven Component, including
 * making an input `function_output`) are deliberately not offered here. An Edge can only persist what
 * the target binding's input already declares; the Graph reports the declared-but-unpersisted inputs
 * as {@link IFunctionGraph.pendingEdges}.
 */

export class FunctionGraphError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor function graph: ${message}`);
		this.name = 'FunctionGraphError';
	}
}

// #region Graph projection

/** Snapshot the Graph is built from. Read-only. */
export interface IFunctionGraphContext {
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly bindings: readonly IFunctionBindingEntry[];
	readonly dependencies: readonly IFunctionDependencyEntry[];
	readonly tables: readonly ITableRegistryEntry[];
}

export interface IFunctionGraphPort {
	readonly name: string;
	readonly kind?: string;
	/** `source` of the binding argument that feeds the port (inputs / parameters). */
	readonly source?: string;
	/** Producer Node (`source: function_output`), by Binding UUID. */
	readonly producer?: string;
	/** Edge that persists `producer`, if any. */
	readonly edge?: string;
}

/** One Node = one `function_binding`. */
export interface IFunctionGraphNode {
	/** `function_binding.uuid` (internal Identity; the Primary UI shows `label`). */
	readonly uuid: string;
	readonly index: number;
	/** Function name / label from `function_registry`. Never the UUID. */
	readonly label: string;
	readonly inputs: readonly IFunctionGraphPort[];
	readonly parameters: readonly IFunctionGraphPort[];
	readonly output: { readonly kind?: string };
	/** Binding State: execution kind, Target and Merge as declared by the binding. */
	readonly state: {
		readonly execution: string;
		readonly target?: string;
		readonly merge: string;
	};
	/** The Function Definition was not found in `function_registry`. */
	readonly missingDefinition: boolean;
}

/** One Edge = one `function_dependency`; direction is Execution Dependency (source runs first). */
export interface IFunctionGraphEdge {
	readonly uuid: string;
	readonly source: string;
	readonly target: string;
	readonly input: string;
	readonly label: string;
}

/** An input declared `function_output` of `source` that has no persisted Edge yet. */
export interface IFunctionGraphPendingEdge {
	readonly source: string;
	readonly target: string;
	readonly input: string;
}

export interface IFunctionGraph {
	readonly nodes: readonly IFunctionGraphNode[];
	readonly edges: readonly IFunctionGraphEdge[];
	readonly pendingEdges: readonly IFunctionGraphPendingEdge[];
	/** Derived Execution order (dependency first, then index) for display only; `undefined` with `diagnostics` when invalid. */
	readonly order?: readonly string[];
	/** Validate failures (cycle, dangling Edge, ...) from the same builder Load / Build uses. */
	readonly diagnostics: readonly string[];
}

function byIndexThenUuid(a: { readonly index: number; readonly uuid: string }, b: { readonly index: number; readonly uuid: string }): number {
	return a.index - b.index || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
}

/**
 * Function Binding + Function Dependency -> Graph. Node text comes from the Registry (name / label),
 * ports from the Function Definition, state from the binding. Execution order and diagnostics reuse
 * {@link buildFunctionExecutionPlan}, so a cycle is reported exactly as Load / Build rejects it.
 */
export function buildFunctionGraph(context: IFunctionGraphContext): IFunctionGraph {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	const edgeByInput = new Map(context.dependencies.map(edge => [`${edge.target_binding.uuid}\u0000${edge.target_input.name}`, edge]));
	const nodeLabels = new Map<string, string>();

	const nodes = [...context.bindings].sort(byIndexThenUuid).map((binding): IFunctionGraphNode => {
		const fn = context.functions.find(candidate => candidate.uuid === binding.function.uuid);
		const label = fn ? getRegistryDisplayText(fn) : 'Missing function';
		nodeLabels.set(binding.uuid, label);
		const port = (name: string, kind: string | undefined, argument: IFunctionBindingEntry['inputs'][string] | undefined, isInput: boolean): IFunctionGraphPort => {
			const producer = argument?.source === FunctionBindingSource.FunctionOutput ? argument.function_binding_uuid : undefined;
			const edge = isInput ? edgeByInput.get(`${binding.uuid}\u0000${name}`) : undefined;
			return Object.freeze({
				name,
				...(kind === undefined ? {} : { kind }),
				...(argument ? { source: argument.source } : {}),
				...(producer === undefined ? {} : { producer }),
				...(edge ? { edge: edge.uuid } : {}),
			});
		};
		const target = resolveFunctionBindingAddressDisplay(binding.target.address, context.tables);
		return Object.freeze({
			uuid: binding.uuid,
			index: binding.index,
			label,
			inputs: Object.freeze((fn?.input ?? []).map(input => port(input.name, input.kind, own(binding.inputs, input.name), true))),
			parameters: Object.freeze((fn?.parameters ?? []).map(parameter => port(parameter.name, parameter.kind, own(binding.parameters, parameter.name), false))),
			output: Object.freeze(fn ? { kind: fn.output.kind } : {}),
			state: Object.freeze({
				execution: binding.execution.kind,
				...(target ? { target: `${target.table} / ${target.column}` } : {}),
				merge: binding.target.merge.kind,
			}),
			missingDefinition: !fn,
		});
	});

	const edges = [...context.dependencies].sort((a, b) => a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0).map((edge): IFunctionGraphEdge => Object.freeze({
		uuid: edge.uuid,
		source: edge.source_binding.uuid,
		target: edge.target_binding.uuid,
		input: edge.target_input.name,
		label: `${nodeLabels.get(edge.source_binding.uuid) ?? 'Missing binding'} → ${nodeLabels.get(edge.target_binding.uuid) ?? 'Missing binding'}.${edge.target_input.name}`,
	}));

	const pendingEdges: IFunctionGraphPendingEdge[] = [];
	for (const binding of [...context.bindings].sort(byIndexThenUuid)) {
		for (const [input, argument] of Object.entries(binding.inputs)) {
			if (argument.source === FunctionBindingSource.FunctionOutput && argument.function_binding_uuid !== undefined && !edgeByInput.has(`${binding.uuid}\u0000${input}`)) {
				pendingEdges.push(Object.freeze({ source: argument.function_binding_uuid, target: binding.uuid, input }));
			}
		}
	}

	let order: readonly string[] | undefined;
	const diagnostics: string[] = [];
	try {
		order = Object.freeze(buildFunctionExecutionPlan(context.bindings, context.dependencies, { allowUndeclared: true }).map(step => step.binding.uuid));
	} catch (error) {
		diagnostics.push(error instanceof Error ? error.message : String(error));
	}
	return Object.freeze({
		nodes: Object.freeze(nodes),
		edges: Object.freeze(edges),
		pendingEdges: Object.freeze(pendingEdges),
		...(order ? { order } : {}),
		diagnostics: Object.freeze(diagnostics),
	});
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// #endregion

// #region Editor Area placement

/** The Function Graph is one Editor Area Target per project; this fixed Identity keys its tab. */
export const functionGraphTabUuid = '00000000-0000-0000-0000-000000000000';

/** Open (or reuse) the Function Graph tab in the Editor Area: opening it again never adds a duplicate. */
export function openFunctionGraphTab(tabs: DataEditorTabs): { readonly tab: IDataEditorTab; readonly reused: boolean } {
	return tabs.open(DataEditorTarget.FunctionGraph, functionGraphTabUuid);
}

// #endregion

// #region Graph authoring (Dependency Mutation only)

type FunctionGraphApi = Pick<IAppEditorApi, 'select' | 'insert' | 'delete'>;

/**
 * Editor Area Function Graph. {@link load} reads bindings and dependencies through the generic
 * `select`; Registry Functions and Tables are supplied by the caller from the Registry. Mutations are
 * the generic `insert` / `delete` of `function_dependency` followed by a reload.
 */
export class FunctionGraphModel {

	private current: IFunctionGraph = buildFunctionGraph({ functions: [], bindings: [], dependencies: [], tables: [] });
	private selectedEdge: string | undefined;

	constructor(
		private readonly api: FunctionGraphApi,
		private readonly registry: () => Pick<IFunctionGraphContext, 'functions' | 'tables'> | Promise<Pick<IFunctionGraphContext, 'functions' | 'tables'>>,
	) { }

	get graph(): IFunctionGraph {
		return this.current;
	}

	/** Presentation-only: the Edge last selected in the Graph. Never persisted. */
	get selectedEdgeUuid(): string | undefined {
		return this.selectedEdge;
	}

	/** Read Graph = SELECT `function_binding` + `function_dependency`, then project. */
	async load(): Promise<IFunctionGraph> {
		const [bindings, dependencies, registry] = await Promise.all([
			this.api.select({ target: { kind: 'function_binding' }, payload: {} }),
			this.api.select({ target: { kind: 'function_dependency' }, payload: {} }),
			this.registry(),
		]);
		this.current = buildFunctionGraph({
			functions: registry.functions,
			tables: registry.tables,
			bindings: (bindings.result as readonly IFunctionBindingRow[]).map(row => row.binding),
			dependencies: dependencies.result as readonly IFunctionDependencyEntry[],
		});
		if (this.selectedEdge && !this.current.edges.some(edge => edge.uuid === this.selectedEdge)) {
			this.selectedEdge = undefined;
		}
		return this.current;
	}

	/** Node Select: `function_binding.uuid` -> Shared Selection Context -> the single Registry Driven Inspector. */
	selectNode(bindingUuid: string, selection: DataEditorSelection): void {
		const uuid = normalizeRegistryUuid(bindingUuid);
		if (!this.current.nodes.some(node => node.uuid === uuid)) {
			throw new FunctionGraphError(`binding '${bindingUuid}' is not a Node of the loaded Function Graph`);
		}
		this.selectedEdge = undefined;
		selection.select(Object.freeze({ uuid }));
	}

	/**
	 * Edge Select: the Edge is highlighted in the Graph and the Shared Selection Context gets its
	 * consuming binding, whose input the Registry-driven Component edits. No Edge Inspector exists.
	 */
	selectEdge(edgeUuid: string, selection: DataEditorSelection): void {
		const uuid = normalizeRegistryUuid(edgeUuid);
		const edge = this.current.edges.find(candidate => candidate.uuid === uuid);
		if (!edge) {
			throw new FunctionGraphError(`edge '${edgeUuid}' is not in the loaded Function Graph`);
		}
		this.selectedEdge = uuid;
		selection.select(Object.freeze({ uuid: edge.target }));
	}

	/**
	 * Edge Add = INSERT `function_dependency`. The Graph does not edit the binding, so the target's
	 * input must already be declared `function_output` of the source (see `pendingEdges`); anything else
	 * is rejected here with the reason instead of writing UI-only state.
	 */
	async addEdge(sourceBinding: string, targetBinding: string, input: string, edgeUuid?: string): Promise<string> {
		const source = normalizeRegistryUuid(sourceBinding);
		const target = normalizeRegistryUuid(targetBinding);
		const sourceNode = this.current.nodes.find(node => node.uuid === source);
		const targetNode = this.current.nodes.find(node => node.uuid === target);
		if (!sourceNode || !targetNode) {
			throw new FunctionGraphError(`both bindings must be Nodes of the loaded Function Graph`);
		}
		if (source === target) {
			throw new FunctionGraphError(`binding '${targetNode.label}' cannot depend on itself`);
		}
		const port = targetNode.inputs.find(candidate => candidate.name === input);
		if (!port) {
			throw new FunctionGraphError(`'${targetNode.label}' has no input '${input}'`);
		}
		if (port.edge !== undefined) {
			throw new FunctionGraphError(`input '${input}' of '${targetNode.label}' already has an Edge`);
		}
		if (port.source !== FunctionBindingSource.FunctionOutput || port.producer !== source) {
			throw new FunctionGraphError(`input '${input}' of '${targetNode.label}' is not declared as function_output of '${sourceNode.label}'; set it on the binding in the Inspector first`);
		}
		const inserted = await this.api.insert({
			target: { kind: 'function_dependency', ...(edgeUuid === undefined ? {} : { uuid: edgeUuid }) },
			payload: { source_binding: { uuid: source }, target_binding: { uuid: target }, target_input: { name: input } },
		});
		await this.load();
		return (inserted.result as { readonly uuid: string }).uuid;
	}

	/** Edge Delete = DELETE `function_dependency`. Bindings are untouched. */
	async removeEdge(edgeUuid: string): Promise<void> {
		const uuid = normalizeRegistryUuid(edgeUuid);
		if (!this.current.edges.some(edge => edge.uuid === uuid)) {
			throw new FunctionGraphError(`edge '${edgeUuid}' is not in the loaded Function Graph`);
		}
		await this.api.delete({ target: { kind: 'function_dependency', uuid } });
		await this.load();
	}
}

// #endregion
