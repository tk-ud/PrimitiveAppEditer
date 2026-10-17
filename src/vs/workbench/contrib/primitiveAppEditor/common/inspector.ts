/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Registry Driven Inspector (editor.inspector)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Inspector, 23. Runtime Addressing / Editor)
 *  Boundary: Editor UI.md (4, 5, 7, 8, 11, 12 implementation; 6, 15 boundary)
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { functionGraphTabUuid } from './functionGraph.js';
import { assertBoundaryFlow, BoundaryNode, compositions } from './authority.js';
import {
	DataEditorSelection, DataEditorTabs, DataEditorTarget, IDataEditorTab,
} from './dataEditor.js';
import {
	createDynamicUpdateAction, DynamicResolver, DynamicSurface, dispatchDynamicAction, IDynamicBinding,
	IDynamicInspector, IDynamicProperty, IDynamicResolveContext,
} from './dynamicResolve.js';
import { IEditorControl, validateEditorValue } from './editorControls.js';
import {
	functionBindingExecutionKinds, functionBindingSources, IFunctionBindingAddress, IFunctionBindingArgument,
	IFunctionBindingEntry, isFunctionBindingExecutionKind, isFunctionBindingSource, resolveFunctionBindingAddressDisplay,
} from './functionBinding.js';
import { getRegistryDisplayText, normalizeRegistryUuid } from './registryIdentity.js';
import { IAppEditorApi } from './resolver.js';
import { compareTableRegistryOrder } from './tableRegistry.js';

/**
 * Registry Driven Inspector (Editor UI 4). There is exactly one Inspector concept: it resolves the
 * Shared Selection Context (UUID) through {@link DynamicResolver} and presents
 *
 * ```text
 * Header (name / label + Context Actions)
 * Properties Section   (Registry-driven Components, compact scalar editing)
 * Binding Section      (SELECT candidate -> Save = INSERT, Existing -> Delete = DELETE)
 * Navigation / Open    (Editor Area tab of the detailed editor)
 * ```
 *
 * Authority stays with the Resolver / Registry: this model is Derived, holds no Table / Function /
 * Renderer name, never persists UI state and reads UUIDs only as identity (labels are display). Every
 * Mutation is a request for a generic Resolver Primitive (`update` / `insert` / `delete`), always
 * followed by a reload of the Registry / Binding snapshot so the view cannot diverge from the DB. With
 * no valid Selection the Inspector is neutral and has no Mutation Target; the target is always taken
 * from the Selection resolved at call time, never from stale UI state.
 *
 * Actions are Icon Buttons ({@link IInspectorAction}) carrying a Tooltip / Accessible Label; the
 * Semantics belong to the bound {@link InspectorCommand}, not to the icon.
 */

export class InspectorError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor inspector: ${message}`);
		this.name = 'InspectorError';
	}
}

// #region View model

/** Commands an Inspector Icon Button is bound to (Editor UI 8). */
export const enum InspectorCommand {
	Add = 'add',
	Save = 'save',
	Delete = 'delete',
	Open = 'open',
}

/** Icon Button: stable icon + human readable Tooltip / Accessible Label; the Command is the Semantics. */
export interface IInspectorAction {
	readonly command: InspectorCommand;
	/** Codicon id. */
	readonly icon: string;
	/** Tooltip and Accessible Label. */
	readonly tooltip: string;
	/** Destructive Actions are distinguished from Select / Save by the presentation. */
	readonly destructive: boolean;
}

const icons: Readonly<Record<InspectorCommand, string>> = Object.freeze({
	[InspectorCommand.Add]: 'add',
	[InspectorCommand.Save]: 'save',
	[InspectorCommand.Delete]: 'trash',
	[InspectorCommand.Open]: 'go-to-file',
});

function action(command: InspectorCommand, tooltip: string): IInspectorAction {
	return Object.freeze({ command, icon: icons[command], tooltip, destructive: command === InspectorCommand.Delete });
}

export interface IInspectorPropertyComponent {
	readonly control: IEditorControl;
	/** Save Icon Button; absent for a read-only column. */
	readonly save?: IInspectorAction;
}

export interface IInspectorBindingEntry {
	readonly binding: IDynamicBinding;
	readonly remove: IInspectorAction;
}

/** A selectable candidate displayed by name / label. */
export interface IInspectorCandidate {
	readonly uuid: string;
	readonly label: string;
}

/** Candidates of the Binding Section, all derived from the Registry / Persistent Model. */
export interface IInspectorBindingCandidates {
	readonly functions: readonly IInspectorCandidate[];
	readonly renderers: readonly IInspectorCandidate[];
	readonly assets: readonly IInspectorCandidate[];
	/** Row Selection only: the columns of the Selected Row's table (Persistent Address `column_uuid`). */
	readonly columns: readonly (IInspectorCandidate & { readonly writable: boolean })[];
	readonly executionKinds: readonly string[];
	readonly sources: readonly string[];
	readonly merges: readonly string[];
}

/** Compact Source / Target / Runtime settings of a Selected Function Binding (UPDATE function_binding). */
export interface IInspectorFunctionBindingComponent {
	readonly execution: { readonly kind: string; readonly options: readonly string[] };
	readonly inputs: readonly IInspectorArgument[];
	readonly parameters: readonly IInspectorArgument[];
	/** `Table > Column` of the write target; never a UUID. */
	readonly target: string | undefined;
	readonly merge: { readonly kind: string; readonly options: readonly string[] };
	readonly save: IInspectorAction;
}

export interface IInspectorArgument {
	readonly name: string;
	readonly source: string;
	readonly options: readonly string[];
}

export interface IInspectorViewContent {
	readonly inspector: IDynamicInspector;
	readonly header: { readonly label: string; readonly actions: readonly IInspectorAction[] };
	readonly properties?: {
		readonly surface: DynamicSurface | string;
		readonly components: readonly IInspectorPropertyComponent[];
		readonly definition: readonly IDynamicProperty[];
		readonly functionBinding?: IInspectorFunctionBindingComponent;
	};
	readonly binding?: {
		readonly surface: DynamicSurface | string;
		readonly entries: readonly IInspectorBindingEntry[];
		readonly candidates: IInspectorBindingCandidates;
		readonly add: IInspectorAction;
	};
	readonly navigation?: {
		readonly surface: DynamicSurface | string;
		/** Only Open Actions that have an Editor Area target. */
		readonly open: readonly { readonly action: IInspectorAction; readonly target: DataEditorTarget; readonly uuid: string }[];
	};
}

/** No Selection: neutral state, no Mutation Target. */
export interface IInspectorEmptyView {
	readonly empty: true;
}

export type IInspectorView = IInspectorViewContent | IInspectorEmptyView;

export function isInspectorEmpty(view: IInspectorView): view is IInspectorEmptyView {
	return hasKey(view, { empty: true });
}

// #endregion

// #region Authoring requests

/** Initial Binding Definition of a new `function_binding` (only fields of the Function Binding model). */
export interface IFunctionBindingInitial {
	/** Function Definition UUID; defaults to the Selected Function. */
	readonly functionUuid?: string;
	/** Write target column of the Selected Row. Required unless `target` is given. */
	readonly columnUuid?: string;
	/** Explicit Persistent Address (used when the Selection is not a Row). */
	readonly target?: IFunctionBindingAddress;
	readonly execution?: string;
	readonly merge?: string;
	readonly inputs?: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly parameters?: Readonly<Record<string, IFunctionBindingArgument>>;
	readonly constructor_?: Readonly<Record<string, unknown>>;
}

/** One value of a new `renderer_binding`: a column of the Selected Row, an explicit Address or an Asset. */
export type IRendererBindingInitialValue =
	| { readonly column_uuid: string }
	| { readonly address: IFunctionBindingAddress }
	| { readonly asset_uuid: string };

export interface IRendererBindingInitial {
	/** Renderer Definition UUID; defaults to the Selected Renderer. */
	readonly rendererUuid?: string;
	/** Keyed by `renderer_registry.inputs[].name`. */
	readonly bindings?: Readonly<Record<string, IRendererBindingInitialValue>>;
}

/** Patch of the compact Function Binding component. */
export interface IFunctionBindingComponentPatch {
	readonly execution?: string;
	readonly inputs?: Readonly<Record<string, string>>;
	readonly parameters?: Readonly<Record<string, string>>;
	readonly merge?: string;
}

// #endregion

type InspectorApi = Pick<IAppEditorApi, 'select' | 'insert' | 'update' | 'delete'>;

/** Registry-driven Inspector of the Shared Selection Context. */
export class RegistryDrivenInspector {

	private current: IInspectorView = Object.freeze({ empty: true });
	private context: IDynamicResolveContext | undefined;
	private generation = 0;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly api: InspectorApi,
		private readonly loadContext: () => Promise<IDynamicResolveContext>,
		private readonly selection: DataEditorSelection,
		private readonly tabs: DataEditorTabs,
		private readonly resolver: DynamicResolver = new DynamicResolver(),
	) {
		this.unsubscribe = selection.onDidChange(() => { void this.refresh().catch(() => { }); });
	}

	dispose(): void {
		this.unsubscribe();
	}

	get view(): IInspectorView {
		return this.current;
	}

	/**
	 * Re-read the Registry / Binding snapshot and resolve the current Selection. A Selection that no
	 * longer resolves (stale, missing, ambiguous) is rejected, and the view returns to the neutral state.
	 */
	async refresh(): Promise<IInspectorView> {
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		const generation = ++this.generation;
		const selected = this.selection.selection;
		if (selected === undefined) {
			this.context = undefined;
			this.current = Object.freeze({ empty: true });
			return this.current;
		}
		try {
			const context = await this.loadContext();
			const resolved = await this.resolver.resolve(selected, context, this.api);
			if (generation !== this.generation) {
				return this.current;
			}
			this.context = context;
			this.current = hasKey(resolved, { empty: true }) ? Object.freeze({ empty: true }) : this.present(resolved, context);
		} catch (error) {
			if (generation === this.generation) {
				this.context = undefined;
				this.current = Object.freeze({ empty: true });
			}
			throw error;
		}
		return this.current;
	}

	// #region Presentation

	private present(inspector: IDynamicInspector, context: IDynamicResolveContext): IInspectorViewContent {
		const isBinding = inspector.kind === 'function_binding' || inspector.kind === 'renderer_binding';
		const properties = inspector.properties && Object.freeze({
			surface: inspector.properties.surface,
			components: Object.freeze(inspector.properties.components.map((control): IInspectorPropertyComponent => Object.freeze({
				control,
				...(control.readOnly ? {} : { save: action(InspectorCommand.Save, `Save ${control.label}`) }),
			}))),
			definition: inspector.properties.definition,
			...(inspector.kind === 'function_binding' ? this.functionBindingComponent(inspector, context) : {}),
		});
		const binding = inspector.binding && Object.freeze({
			surface: inspector.binding.surface,
			entries: Object.freeze(inspector.binding.entries.map((entry): IInspectorBindingEntry => Object.freeze({
				binding: entry,
				remove: action(InspectorCommand.Delete, entry.remove.label),
			}))),
			candidates: this.candidates(inspector, context),
			add: action(InspectorCommand.Add, 'Add Binding'),
		});
		const navigation = inspector.navigation && Object.freeze({
			surface: inspector.navigation.surface,
			open: Object.freeze(inspector.navigation.actions.flatMap(candidate => {
				const target = openTarget(inspector);
				return target ? [Object.freeze({ action: action(InspectorCommand.Open, candidate.label), target: target.target, uuid: target.uuid })] : [];
			})),
		});
		return Object.freeze({
			inspector,
			header: Object.freeze({
				label: inspector.label,
				actions: Object.freeze(isBinding ? [action(InspectorCommand.Delete, `Delete ${inspector.label}`)] : []),
			}),
			...(properties ? { properties } : {}),
			...(binding ? { binding } : {}),
			...(navigation ? { navigation } : {}),
		});
	}

	private candidates(inspector: IDynamicInspector, context: IDynamicResolveContext): IInspectorBindingCandidates {
		const named = (entries: readonly { readonly uuid: string; readonly name: string; readonly label?: string }[]) => Object.freeze(entries.map((entry): IInspectorCandidate => Object.freeze({ uuid: entry.uuid, label: getRegistryDisplayText(entry) })));
		const table = inspector.address && context.tables.find(candidate => candidate.uuid === inspector.address!.tableUuid);
		return Object.freeze({
			functions: named(context.functions),
			renderers: named(context.renderers),
			assets: named(context.assets),
			columns: Object.freeze(table ? [...table.columns].sort(compareTableRegistryOrder).map(column => Object.freeze({ uuid: column.uuid, label: getRegistryDisplayText(column), writable: column.writable })) : []),
			executionKinds: functionBindingExecutionKinds,
			sources: functionBindingSources,
			merges: compositions,
		});
	}

	private functionBindingComponent(inspector: IDynamicInspector, context: IDynamicResolveContext): { readonly functionBinding: IInspectorFunctionBindingComponent } | {} {
		const entry = context.functionBindings.find(candidate => candidate.uuid === inspector.uuid);
		if (!entry) {
			return {};
		}
		const argument = ([name, value]: [string, IFunctionBindingArgument]): IInspectorArgument => Object.freeze({ name, source: String(value.source), options: functionBindingSources });
		const target = resolveFunctionBindingAddressDisplay(entry.target.address, context.tables);
		return {
			functionBinding: Object.freeze({
				execution: Object.freeze({ kind: entry.execution.kind, options: functionBindingExecutionKinds }),
				inputs: Object.freeze(Object.entries(entry.inputs).map(argument)),
				parameters: Object.freeze(Object.entries(entry.parameters).map(argument)),
				target: target ? `${target.table} > ${target.column}` : undefined,
				merge: Object.freeze({ kind: entry.target.merge.kind, options: compositions }),
				save: action(InspectorCommand.Save, 'Save Function Binding'),
			}),
		};
	}

	// #endregion

	// #region Mutation (always against the Selection resolved now)

	/** Re-resolve and return the content the Mutation targets. No Selection: no Mutation Target. */
	private async target(): Promise<{ readonly content: IInspectorViewContent; readonly context: IDynamicResolveContext }> {
		const view = await this.refresh();
		if (isInspectorEmpty(view) || !this.context) {
			throw new InspectorError('there is no Selection: no Mutation Target');
		}
		return { content: view, context: this.context };
	}

	/** Properties Section Save: the generic `update` of one column of the Selected Row. */
	async saveProperty(columnUuid: string, value: unknown): Promise<void> {
		const { content, context } = await this.target();
		const inspector = content.inspector;
		if (!inspector.address) {
			throw new InspectorError(`'${inspector.label}' is not a Raw Data Row: its properties have no Mutation Target`);
		}
		const control = inspector.properties?.components.find(candidate => candidate.columnUuid === columnUuid.toLowerCase());
		if (!control) {
			throw new InspectorError(`'${inspector.label}' has no property component '${columnUuid}'`);
		}
		if (control.readOnly) {
			throw new InspectorError(`property '${control.label}' is not writable`);
		}
		const column = context.tables.find(candidate => candidate.uuid === inspector.address!.tableUuid)?.columns.find(candidate => candidate.uuid === control.columnUuid);
		const message = column ? validateEditorValue(column, value, context.enums) : `column '${control.label}' is not in the Registry`;
		if (message !== undefined) {
			throw new InspectorError(`property '${control.label}': ${message}`);
		}
		await dispatchDynamicAction(this.api as IAppEditorApi, createDynamicUpdateAction(inspector, control.columnUuid, value));
		await this.refresh();
	}

	/** Binding Section Save: INSERT `function_binding` from the Initial Binding Definition. Only Function Binding model fields are written. */
	async insertFunctionBinding(initial: IFunctionBindingInitial): Promise<string> {
		const { content, context } = await this.target();
		const inspector = content.inspector;
		if (!content.binding) {
			throw new InspectorError(`'${inspector.label}' has no Binding Section`);
		}
		const functionUuid = initial.functionUuid ?? (inspector.kind === 'function' ? inspector.uuid : undefined);
		if (functionUuid === undefined) {
			throw new InspectorError('select the Function of the Binding (the Selection does not imply one)');
		}
		const definition = context.functions.find(candidate => candidate.uuid === normalizeRegistryUuid(functionUuid));
		if (!definition) {
			throw new InspectorError(`Function '${functionUuid}' is not in the Registry`);
		}
		let address = initial.target;
		if (address === undefined && initial.columnUuid !== undefined && inspector.address) {
			const table = context.tables.find(candidate => candidate.uuid === inspector.address!.tableUuid);
			if (!table?.columns.some(column => column.uuid === initial.columnUuid!.toLowerCase())) {
				throw new InspectorError(`column '${initial.columnUuid}' is not a column of the Selected Row's table`);
			}
			address = { table_uuid: inspector.address.tableUuid, row_uuid: inspector.address.rowUuid, column_uuid: initial.columnUuid.toLowerCase() };
		}
		if (address === undefined) {
			throw new InspectorError('the write target is not defined: select a Row column or give a Persistent Address (a Selection is not an owner)');
		}
		const execution = initial.execution ?? 'tick';
		if (!isFunctionBindingExecutionKind(execution)) {
			throw new InspectorError(`execution.kind must be one of ${functionBindingExecutionKinds.join(' | ')}`);
		}
		const parameters = initial.parameters ?? Object.fromEntries(definition.parameters.filter(parameter => parameter.default !== undefined).map(parameter => [parameter.name, { source: 'constant', value: parameter.default }]));
		const nextIndex = context.functionBindings.reduce((max, binding) => Math.max(max, binding.index), -1) + 1;
		const inserted = await this.api.insert({
			target: { kind: 'function_binding' },
			payload: {
				index: nextIndex,
				function: { uuid: definition.uuid },
				constructor: initial.constructor_ ?? {},
				execution: { kind: execution },
				inputs: initial.inputs ?? {},
				parameters,
				target: { address, merge: { kind: initial.merge ?? 'overwrite' } },
			},
		});
		await this.refresh();
		return (inserted.result as { readonly uuid: string }).uuid;
	}

	/** Binding Section Save: INSERT `renderer_binding` (Renderer / Asset Binding uses the same Interaction Model). */
	async insertRendererBinding(initial: IRendererBindingInitial): Promise<string> {
		const { content, context } = await this.target();
		const inspector = content.inspector;
		if (!content.binding) {
			throw new InspectorError(`'${inspector.label}' has no Binding Section`);
		}
		const rendererUuid = initial.rendererUuid ?? (inspector.kind === 'renderer' ? inspector.uuid : undefined);
		if (rendererUuid === undefined) {
			throw new InspectorError('select the Renderer of the Binding (the Selection does not imply one)');
		}
		const bindings: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(initial.bindings ?? {})) {
			if (hasKey(value, { column_uuid: true })) {
				if (!inspector.address) {
					throw new InspectorError(`binding '${name}': a column can only be chosen on a Row Selection`);
				}
				const table = context.tables.find(candidate => candidate.uuid === inspector.address!.tableUuid);
				if (!table?.columns.some(column => column.uuid === value.column_uuid.toLowerCase())) {
					throw new InspectorError(`binding '${name}': column '${value.column_uuid}' is not a column of the Selected Row's table`);
				}
				bindings[name] = { address: { table_uuid: inspector.address.tableUuid, row_uuid: inspector.address.rowUuid, column_uuid: value.column_uuid.toLowerCase() } };
			} else {
				bindings[name] = value;
			}
		}
		const inserted = await this.api.insert({ target: { kind: 'renderer_binding' }, payload: { renderer: { uuid: rendererUuid }, bindings } });
		await this.refresh();
		return (inserted.result as { readonly uuid: string }).uuid;
	}

	/** Binding Section Delete: DELETE of one Binding that composes the Selection (a Binding the Selection does not show is not deleted). */
	async deleteBinding(bindingUuid: string): Promise<void> {
		const { content } = await this.target();
		const entry = content.binding?.entries.find(candidate => candidate.binding.uuid === bindingUuid.toLowerCase());
		if (!entry) {
			throw new InspectorError(`Binding '${bindingUuid}' is not in the Binding Section of the Selection`);
		}
		await dispatchDynamicAction(this.api as IAppEditorApi, entry.binding.remove);
		await this.refresh();
	}

	/** Context Action Delete of a Selected Binding; the Selection then becomes empty (the deleted UUID is stale). */
	async deleteSelectedBinding(): Promise<void> {
		const { content } = await this.target();
		const inspector = content.inspector;
		if (inspector.kind !== 'function_binding' && inspector.kind !== 'renderer_binding') {
			throw new InspectorError(`'${inspector.label}' is not a Binding`);
		}
		await this.api.delete({ target: { kind: inspector.kind, uuid: inspector.uuid } });
		this.selection.select(undefined);
		await this.refresh();
	}

	/**
	 * Compact component of the Selected Function Binding: `UPDATE function_binding` of execution.kind,
	 * argument `source` and merge. The Persistence timing / policy is not decided here; constant values,
	 * addresses and producers are edited by the dedicated Registry-driven Component.
	 */
	async saveFunctionBinding(patch: IFunctionBindingComponentPatch): Promise<void> {
		const { content, context } = await this.target();
		const inspector = content.inspector;
		const entry: IFunctionBindingEntry | undefined = inspector.kind === 'function_binding' ? context.functionBindings.find(candidate => candidate.uuid === inspector.uuid) : undefined;
		if (!entry) {
			throw new InspectorError(`'${inspector.label}' is not a Function Binding`);
		}
		const payload: Record<string, unknown> = {};
		if (patch.execution !== undefined) {
			if (!isFunctionBindingExecutionKind(patch.execution)) {
				throw new InspectorError(`execution.kind must be one of ${functionBindingExecutionKinds.join(' | ')}`);
			}
			payload.execution = { kind: patch.execution };
		}
		for (const group of ['inputs', 'parameters'] as const) {
			const changes = patch[group];
			if (changes === undefined) {
				continue;
			}
			const merged: Record<string, IFunctionBindingArgument> = { ...entry[group] };
			for (const [name, source] of Object.entries(changes)) {
				if (!Object.prototype.hasOwnProperty.call(merged, name)) {
					throw new InspectorError(`Function Binding has no ${group.slice(0, -1)} '${name}'`);
				}
				if (!isFunctionBindingSource(source)) {
					throw new InspectorError(`source must be one of ${functionBindingSources.join(' | ')}`);
				}
				if (merged[name].source !== source) {
					// Only `source` is changed here: a source's own member (value / address / producer) is Component detail.
					merged[name] = { source };
				}
			}
			payload[group] = merged;
		}
		if (patch.merge !== undefined) {
			payload.target = { address: entry.target.address, merge: { kind: patch.merge } };
		}
		if (Object.keys(payload).length === 0) {
			throw new InspectorError('nothing to save');
		}
		await this.api.update({ target: { kind: 'function_binding', uuid: entry.uuid }, payload });
		await this.refresh();
	}

	// #endregion

	// #region Navigation

	/** Open Action: open (or reuse) the Editor Area tab of the Selection's detailed editor. Does not change the Selection. */
	async open(): Promise<{ readonly tab: IDataEditorTab; readonly reused: boolean }> {
		const { content } = await this.target();
		const open = content.navigation?.open[0];
		if (!open) {
			throw new InspectorError(`'${content.inspector.label}' has no Editor Area target`);
		}
		return this.tabs.open(open.target, open.uuid);
	}

	// #endregion
}

/** Editor Area target of a resolved Selection, if the detailed editor exists. No target is guessed. */
function openTarget(inspector: IDynamicInspector): { readonly target: DataEditorTarget; readonly uuid: string } | undefined {
	switch (inspector.kind) {
		case 'row': return inspector.address ? { target: DataEditorTarget.DataGrid, uuid: inspector.address.tableUuid } : undefined;
		case 'table': return { target: DataEditorTarget.PhysicalTable, uuid: inspector.uuid };
		case 'relation': return { target: DataEditorTarget.RelationGraph, uuid: inspector.uuid };
		case 'function_binding': return { target: DataEditorTarget.FunctionGraph, uuid: functionGraphTabUuid };
		default: return undefined;
	}
}
