/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Dynamic Resolve: Selection -> Component / Action (resolver.dynamic)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (Dynamic Resolve)
 *  Boundary: App Editer.md (Kind Dispatch, Inspector), Resolver.md (14, 16, 17), Editor UI.md (3, 4, 15)
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { createEditorControls, createEditorUpdateRequest, createRelationSource, IEditorControl } from './editorControls.js';
import { EnumRegistryIndex, IEnumRegistryEntry } from './enumRegistry.js';
import { IFunctionBindingAddress, IFunctionBindingEntry, resolveFunctionBindingAddressDisplay } from './functionBinding.js';
import { IFunctionRegistryEntry } from './functionRegistry.js';
import { IAsset } from './assetRegistry.js';
import { getRegistryDisplayText, isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { IRelationRegistryEntry } from './relationRegistry.js';
import { IRendererBindingEntry, IRendererRegistryEntry } from './rendererRegistry.js';
import { IRawDataRow } from './rawData.js';
import { IAppEditorApi, IResolverOperationRequest, IResolverRequest, ResolverOperation } from './resolver.js';
import { ITableRegistryEntry, TableColumnKind } from './tableRegistry.js';

/**
 * Dynamic Resolve.
 *
 * ```text
 * Selection -> UUID Resolve -> Registry / Binding Resolve -> Kind / Surface Resolve -> Component / Action Resolve
 * ```
 *
 * The resolver is Derived: every Selection Kind, its Surface placement and its Actions come from a
 * Structured Definition ({@link IDynamicResolveDefinition}); the resolver holds no Table / Entity /
 * Function name and no Application field. The Definition only picks a Source (the Registry / Binding
 * collection that owns the UUID) and a Surface from the Editor UI regulation vocabulary; it cannot add
 * semantics. Kind Dispatch of a Raw Data row is the generic `editor.registry-ui` component model, and
 * every Mutation is a request for one of the nine Resolver Primitives. Nothing here is persisted:
 * placement / interaction is Editor Implementation Responsibility, not a Project Persistent Authority.
 * Empty / stale / ambiguous Selections are rejected or neutral, never completed by guessing.
 */

// #region Contract

export class DynamicResolveError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor dynamic resolve: ${message}`);
		this.name = 'DynamicResolveError';
	}
}

/** Workbench Surfaces (Editor UI 3. Workbench Placement). */
export const enum DynamicSurface {
	PrimarySideBar = 'primary_side_bar',
	EditorArea = 'editor_area',
	SecondarySideBar = 'secondary_side_bar',
	BottomPanel = 'bottom_panel',
}

export const dynamicSurfaces: readonly DynamicSurface[] = Object.freeze([
	DynamicSurface.PrimarySideBar, DynamicSurface.EditorArea, DynamicSurface.SecondarySideBar, DynamicSurface.BottomPanel,
]);

/** Registry Driven Inspector sections (Editor UI 4). */
export const enum InspectorSection {
	Properties = 'properties',
	Binding = 'binding',
	Navigation = 'navigation',
}

export const inspectorSections: readonly InspectorSection[] = Object.freeze([InspectorSection.Properties, InspectorSection.Binding, InspectorSection.Navigation]);

/** Persistent Address of a Selection: UUIDs only, a display label is never an identity. */
export interface IDynamicSelection {
	/** Definition / Binding UUID, or the Row UUID when `table_uuid` is given. */
	readonly uuid: string;
	/** Raw Data Row selection: the `table_registry` UUID owning `uuid`. */
	readonly table_uuid?: string;
}

/** The Registry / Binding snapshot the resolver reads (Registry Resolve). Read-only, never mutated. */
export interface IDynamicResolveContext {
	readonly tables: readonly ITableRegistryEntry[];
	readonly enums: EnumRegistryIndex;
	readonly enumEntries: readonly IEnumRegistryEntry[];
	readonly relations: readonly IRelationRegistryEntry[];
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly assets: readonly IAsset[];
	readonly functionBindings: readonly IFunctionBindingEntry[];
	readonly rendererBindings: readonly IRendererBindingEntry[];
}

// #endregion

// #region Structured Definition -> Resolver (16. Dynamic Generation)

/** A Registry / Binding collection that can own a Selection UUID. */
export const enum DynamicSource {
	Table = 'table',
	Enum = 'enum',
	Relation = 'relation',
	Function = 'function',
	Renderer = 'renderer',
	Asset = 'asset',
	FunctionBinding = 'function_binding',
	RendererBinding = 'renderer_binding',
	/** Raw Data Row of a `table_registry` table: the one Kind whose Properties are Registry-driven editor components. */
	RawRow = 'raw_row',
}

export const dynamicSources: readonly DynamicSource[] = Object.freeze([
	DynamicSource.Table, DynamicSource.Enum, DynamicSource.Relation, DynamicSource.Function, DynamicSource.Renderer,
	DynamicSource.Asset, DynamicSource.FunctionBinding, DynamicSource.RendererBinding, DynamicSource.RawRow,
]);

export interface IDynamicSelectionDefinition {
	/** Selection Kind name, e.g. `row`, `function`. */
	readonly kind: string;
	readonly source: DynamicSource | string;
	/** Surface of each Inspector section. A section not listed is not presented. */
	readonly sections: Readonly<Record<string, DynamicSurface | string>>;
	/** Surface the `open` Navigation Action targets (the detailed editor); absent: no Open Action. */
	readonly open?: DynamicSurface | string;
}

/** Structured Definition (YAML / JSON) the resolver is generated from. */
export interface IDynamicResolveDefinition {
	readonly selections: readonly IDynamicSelectionDefinition[];
}

/** Editor UI regulation defaults: Inspect / Compose in the Secondary Side Bar, detailed editing in the Editor Area. */
export const defaultDynamicResolveDefinition: IDynamicResolveDefinition = Object.freeze({
	selections: Object.freeze<IDynamicSelectionDefinition[]>([
		{ kind: 'row', source: DynamicSource.RawRow, sections: { properties: DynamicSurface.SecondarySideBar, binding: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'table', source: DynamicSource.Table, sections: { properties: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'enum', source: DynamicSource.Enum, sections: { properties: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'relation', source: DynamicSource.Relation, sections: { properties: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'function', source: DynamicSource.Function, sections: { properties: DynamicSurface.SecondarySideBar, binding: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'renderer', source: DynamicSource.Renderer, sections: { properties: DynamicSurface.SecondarySideBar, binding: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'asset', source: DynamicSource.Asset, sections: { properties: DynamicSurface.SecondarySideBar, binding: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'function_binding', source: DynamicSource.FunctionBinding, sections: { properties: DynamicSurface.SecondarySideBar, binding: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
		{ kind: 'renderer_binding', source: DynamicSource.RendererBinding, sections: { properties: DynamicSurface.SecondarySideBar, binding: DynamicSurface.SecondarySideBar, navigation: DynamicSurface.SecondarySideBar }, open: DynamicSurface.EditorArea },
	]),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates an untrusted Structured Definition (e.g. parsed YAML). Throws {@link DynamicResolveError}; the result is the definition itself. */
export function parseDynamicResolveDefinition(input: unknown): IDynamicResolveDefinition {
	if (!isPlainRecord(input) || !Array.isArray(input.selections)) {
		throw new DynamicResolveError('definition must be an object with a `selections` array');
	}
	const seenKinds = new Set<string>();
	const seenSources = new Set<string>();
	const selections = input.selections.map((entry: unknown, position): IDynamicSelectionDefinition => {
		const where = `definition selections[${position}]`;
		if (!isPlainRecord(entry)) {
			throw new DynamicResolveError(`${where} must be an object`);
		}
		const { kind, source, sections, open } = entry;
		if (typeof kind !== 'string' || kind.length === 0) {
			throw new DynamicResolveError(`${where}: kind must be a non-empty string`);
		}
		if (seenKinds.has(kind)) {
			throw new DynamicResolveError(`${where}: kind '${kind}' is defined more than once (Ambiguous Target)`);
		}
		seenKinds.add(kind);
		if (typeof source !== 'string' || !(dynamicSources as readonly string[]).includes(source)) {
			throw new DynamicResolveError(`${where} '${kind}': source must be one of ${dynamicSources.join(' | ')}`);
		}
		if (seenSources.has(source)) {
			throw new DynamicResolveError(`${where} '${kind}': source '${source}' is already used by another kind (Ambiguous Target)`);
		}
		seenSources.add(source);
		if (!isPlainRecord(sections)) {
			throw new DynamicResolveError(`${where} '${kind}': sections must be an object`);
		}
		for (const [section, surface] of Object.entries(sections)) {
			if (!(inspectorSections as readonly string[]).includes(section)) {
				throw new DynamicResolveError(`${where} '${kind}': '${section}' is not an Inspector section (${inspectorSections.join(' | ')})`);
			}
			if (typeof surface !== 'string' || !(dynamicSurfaces as readonly string[]).includes(surface)) {
				throw new DynamicResolveError(`${where} '${kind}' section '${section}': surface must be one of ${dynamicSurfaces.join(' | ')}`);
			}
		}
		if (open !== undefined && (typeof open !== 'string' || !(dynamicSurfaces as readonly string[]).includes(open))) {
			throw new DynamicResolveError(`${where} '${kind}': open must be one of ${dynamicSurfaces.join(' | ')}`);
		}
		return { kind, source, sections: sections as Readonly<Record<string, string>>, ...(open === undefined ? {} : { open: open as string }) };
	});
	return Object.freeze({ selections: Object.freeze(selections) });
}

// #endregion

// #region Resolution

/** A Registry / Binding entry located by UUID, with the Human Display of it. */
interface ILocated {
	readonly label: string;
	/** Binding Resolve: Bindings that compose the located entry. */
	readonly bindings: readonly IDynamicBinding[];
	/** Definition properties presented read-only (Registry is the Definition Authority; the Inspector does not edit it). */
	readonly properties: readonly IDynamicProperty[];
}

/** A Definition property shown in the Inspector. */
export interface IDynamicProperty {
	readonly label: string;
	/** Human-facing text. Never a UUID. */
	readonly value: string;
}

/** One Binding that composes the selection, shown by name / label. */
export interface IDynamicBinding {
	/** `function_binding` / `renderer_binding`. */
	readonly kind: string;
	readonly uuid: string;
	readonly label: string;
	/** Delete / Remove Action: a request for the generic `delete` Primitive. */
	readonly remove: IDynamicAction;
}

export const enum DynamicActionType {
	/** Navigation: open the detailed editor on a Surface. */
	Open = 'open',
	/** Mutation: a request for one Resolver Primitive. */
	Mutate = 'mutate',
}

export interface IDynamicAction {
	readonly type: DynamicActionType;
	readonly label: string;
	/** `open`: where the detailed editor is placed. */
	readonly surface?: DynamicSurface | string;
	/** `mutate`: the Primitive request; Mutation is always dispatched to the Resolver. */
	readonly request?: IResolverRequest;
}

export interface IDynamicInspector {
	/** Selection Kind name from the Structured Definition. */
	readonly kind: string;
	readonly uuid: string;
	/** Human-facing name / label. Never the UUID. */
	readonly label: string;
	/** Properties section: Registry-driven editor components for a Row, read-only Definition properties otherwise. */
	readonly properties?: { readonly surface: DynamicSurface | string; readonly components: readonly IEditorControl[]; readonly definition: readonly IDynamicProperty[] };
	/** Binding section. */
	readonly binding?: { readonly surface: DynamicSurface | string; readonly entries: readonly IDynamicBinding[] };
	/** Navigation / Open Action. */
	readonly navigation?: { readonly surface: DynamicSurface | string; readonly actions: readonly IDynamicAction[] };
	/** Row Selection only: the Address a component Save targets. */
	readonly address?: { readonly tableUuid: string; readonly rowUuid: string };
}

/** Empty Selection: neutral state, no Mutation Target. */
export interface IDynamicEmpty {
	readonly empty: true;
}

// #endregion

// #region Resolver

type Locator = (context: IDynamicResolveContext, uuid: string) => ILocated | undefined;

function sameUuid(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** What a Binding must reference to belong to a Selection: a definition UUID, or one Row of one Table. */
type BindingMatch =
	| { readonly definitionUuid: string }
	| { readonly tableUuid: string; readonly rowUuid: string };

function functionBindingAddresses(entry: IFunctionBindingEntry): readonly IFunctionBindingAddress[] {
	const arguments_ = [...Object.values(entry.inputs), ...Object.values(entry.parameters)];
	return [entry.target.address, ...arguments_.flatMap(argument => argument.address ? [argument.address] : [])];
}

function rendererBindingAddresses(entry: IRendererBindingEntry): readonly IFunctionBindingAddress[] {
	return Object.values(entry.bindings).flatMap(value => hasKey(value, { address: true }) ? [value.address] : []);
}

function addressesRow(addresses: readonly IFunctionBindingAddress[], match: { readonly tableUuid: string; readonly rowUuid: string }): boolean {
	return addresses.some(address => sameUuid(address.table_uuid, match.tableUuid) && sameUuid(address.row_uuid, match.rowUuid));
}

function functionBindingMatches(entry: IFunctionBindingEntry, match: BindingMatch): boolean {
	return hasKey(match, { definitionUuid: true }) ? sameUuid(entry.function.uuid, match.definitionUuid) : addressesRow(functionBindingAddresses(entry), match);
}

function rendererBindingMatches(entry: IRendererBindingEntry, match: BindingMatch): boolean {
	if (hasKey(match, { definitionUuid: true })) {
		return sameUuid(entry.renderer.uuid, match.definitionUuid)
			|| Object.values(entry.bindings).some(value => hasKey(value, { asset_uuid: true }) && sameUuid(value.asset_uuid, match.definitionUuid));
	}
	return addressesRow(rendererBindingAddresses(entry), match);
}

function removeAction(kind: string, uuid: string, label: string): IDynamicAction {
	return Object.freeze({ type: DynamicActionType.Mutate, label: `Remove ${label}`, request: Object.freeze({ operation: ResolverOperation.Delete, target: Object.freeze({ kind, uuid }) }) });
}

/** Binding Resolve: Bindings that reference the Selection (a definition UUID, or exactly one Row), displayed by the Registry name / label. */
function resolveBindings(context: IDynamicResolveContext, match: BindingMatch): readonly IDynamicBinding[] {
	const bindings: IDynamicBinding[] = [];
	for (const entry of context.functionBindings) {
		if (functionBindingMatches(entry, match)) {
			const label = functionBindingLabel(context, entry);
			bindings.push(Object.freeze({ kind: 'function_binding', uuid: entry.uuid, label, remove: removeAction('function_binding', entry.uuid, label) }));
		}
	}
	for (const entry of context.rendererBindings) {
		if (rendererBindingMatches(entry, match)) {
			const label = rendererBindingLabel(context, entry);
			bindings.push(Object.freeze({ kind: 'renderer_binding', uuid: entry.uuid, label, remove: removeAction('renderer_binding', entry.uuid, label) }));
		}
	}
	return Object.freeze(bindings);
}

function functionBindingLabel(context: IDynamicResolveContext, entry: IFunctionBindingEntry): string {
	const definition = context.functions.find(candidate => sameUuid(candidate.uuid, entry.function.uuid));
	const target = resolveFunctionBindingAddressDisplay(entry.target.address, context.tables);
	const name = definition ? getRegistryDisplayText(definition) : undefined;
	if (name === undefined) {
		throw new DynamicResolveError(`function_binding '${entry.uuid}' references a Function missing from the Registry (Missing Definition)`);
	}
	return target ? `${name} → ${target.table} > ${target.column}` : name;
}

function rendererBindingLabel(context: IDynamicResolveContext, entry: IRendererBindingEntry): string {
	const definition = context.renderers.find(candidate => sameUuid(candidate.uuid, entry.renderer.uuid));
	if (!definition) {
		throw new DynamicResolveError(`renderer_binding '${entry.uuid}' references a Renderer missing from the Registry (Missing Definition)`);
	}
	return getRegistryDisplayText(definition);
}

const locators: Readonly<Record<string, Locator>> = Object.freeze({
	[DynamicSource.Table]: (context, uuid) => {
		const table = context.tables.find(candidate => sameUuid(candidate.uuid, uuid));
		return table && Object.freeze({
			label: getRegistryDisplayText(table),
			bindings: Object.freeze([]),
			properties: Object.freeze([{ label: 'Columns', value: table.columns.map(getRegistryDisplayText).join(', ') }]),
		});
	},
	[DynamicSource.Enum]: (context, uuid) => {
		const entry = context.enumEntries.find(candidate => sameUuid(candidate.uuid, uuid));
		return entry && Object.freeze({
			label: getRegistryDisplayText(entry),
			bindings: Object.freeze([]),
			properties: Object.freeze([{ label: 'Values', value: entry.values.map(value => value.label ?? value.value).join(', ') }]),
		});
	},
	[DynamicSource.Relation]: (context, uuid) => {
		const entry = context.relations.find(candidate => sameUuid(candidate.uuid, uuid));
		const main = entry && context.tables.find(candidate => sameUuid(candidate.uuid, entry.main_table));
		return entry && Object.freeze({
			label: main ? getRegistryDisplayText(main) : 'Relation',
			bindings: Object.freeze([]),
			properties: Object.freeze([{
				label: 'Joins', value: entry.relations.map(join => {
					const table = context.tables.find(candidate => sameUuid(candidate.uuid, join.join_table));
					return table ? getRegistryDisplayText(table) : 'Missing table';
				}).join(', '),
			}]),
		});
	},
	[DynamicSource.Function]: (context, uuid) => {
		const entry = context.functions.find(candidate => sameUuid(candidate.uuid, uuid));
		return entry && Object.freeze({
			label: getRegistryDisplayText(entry),
			bindings: resolveBindings(context, { definitionUuid: entry.uuid }),
			properties: Object.freeze([{ label: 'Executor', value: entry.executor }, { label: 'Output', value: entry.output.kind }]),
		});
	},
	[DynamicSource.Renderer]: (context, uuid) => {
		const entry = context.renderers.find(candidate => sameUuid(candidate.uuid, uuid));
		return entry && Object.freeze({
			label: getRegistryDisplayText(entry),
			bindings: resolveBindings(context, { definitionUuid: entry.uuid }),
			properties: Object.freeze([{ label: 'Executor', value: entry.executor }, { label: 'Inputs', value: entry.inputs.map(input => input.name).join(', ') }]),
		});
	},
	[DynamicSource.Asset]: (context, uuid) => {
		const entry = context.assets.find(candidate => sameUuid(candidate.uuid, uuid));
		return entry && Object.freeze({
			label: getRegistryDisplayText(entry),
			bindings: resolveBindings(context, { definitionUuid: entry.uuid }),
			properties: Object.freeze([{ label: 'Kind', value: entry.kind }, { label: 'Source', value: entry.source }]),
		});
	},
	[DynamicSource.FunctionBinding]: (context, uuid) => {
		const entry = context.functionBindings.find(candidate => sameUuid(candidate.uuid, uuid));
		return entry && Object.freeze({ label: functionBindingLabel(context, entry), bindings: Object.freeze([]), properties: Object.freeze([]) });
	},
	[DynamicSource.RendererBinding]: (context, uuid) => {
		const entry = context.rendererBindings.find(candidate => sameUuid(candidate.uuid, uuid));
		return entry && Object.freeze({ label: rendererBindingLabel(context, entry), bindings: Object.freeze([]), properties: Object.freeze([]) });
	},
});

/**
 * Dynamic Resolver generated from a Structured Definition. It reads the Registry / Binding snapshot and
 * Raw Data through the generic `select` Primitive, and returns a Derived Inspector model; it never
 * writes. Mutation is expressed as Primitive requests ({@link IDynamicAction}) executed by {@link dispatchDynamicAction}.
 */
export class DynamicResolver {

	private readonly byKind = new Map<string, IDynamicSelectionDefinition>();
	private readonly bySource = new Map<string, IDynamicSelectionDefinition>();

	constructor(definition: IDynamicResolveDefinition = defaultDynamicResolveDefinition) {
		for (const entry of parseDynamicResolveDefinition(definition).selections) {
			this.byKind.set(entry.kind, entry);
			this.bySource.set(entry.source, entry);
		}
	}

	/** The Selection Kinds the generated resolver knows. */
	get kinds(): readonly string[] {
		return [...this.byKind.keys()];
	}

	/**
	 * Selection -> UUID Resolve -> Registry / Binding Resolve -> Kind / Surface Resolve -> Component / Action Resolve.
	 * No Selection is the neutral state. A UUID that resolves to no definition (stale) or to more than one
	 * (ambiguous) is rejected, never guessed.
	 */
	async resolve(
		selection: IDynamicSelection | undefined,
		context: IDynamicResolveContext,
		api: Pick<IAppEditorApi, 'select'>,
	): Promise<IDynamicInspector | IDynamicEmpty> {
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		if (selection === undefined) {
			return Object.freeze({ empty: true });
		}

		// UUID Resolve: the Persistent Identity only.
		const uuid = requireSelectionUuid(selection.uuid, 'selection.uuid');
		if (selection.table_uuid !== undefined) {
			return this.resolveRow(requireSelectionUuid(selection.table_uuid, 'selection.table_uuid'), uuid, context, api);
		}

		// Registry / Binding Resolve: exactly one Source may own the UUID.
		const matches: { readonly definition: IDynamicSelectionDefinition; readonly located: ILocated }[] = [];
		for (const definition of this.byKind.values()) {
			const locate = locators[definition.source];
			const located = locate?.(context, uuid);
			if (located) {
				matches.push({ definition, located });
			}
		}
		if (matches.length === 0) {
			throw new DynamicResolveError(`selection '${uuid}' does not resolve to any Registry / Binding definition (Missing Definition)`);
		}
		if (matches.length > 1) {
			throw new DynamicResolveError(`selection '${uuid}' is ambiguous: ${matches.map(match => match.definition.kind).join(', ')} (Ambiguous Target)`);
		}
		const { definition, located } = matches[0];

		// Kind / Surface Resolve + Component / Action Resolve.
		return this.inspector(definition, uuid, located.label, {
			components: [],
			definition: located.properties,
			bindings: located.bindings,
		});
	}

	private async resolveRow(tableUuid: string, rowUuid: string, context: IDynamicResolveContext, api: Pick<IAppEditorApi, 'select'>): Promise<IDynamicInspector> {
		const definition = this.bySource.get(DynamicSource.RawRow);
		if (!definition) {
			throw new DynamicResolveError('the definition has no raw_row Selection Kind (Missing Definition)');
		}
		const table = context.tables.find(candidate => sameUuid(candidate.uuid, tableUuid));
		if (!table) {
			throw new DynamicResolveError(`selection table '${tableUuid}' does not resolve to a table_registry entry (Missing Definition)`);
		}
		const selected = await api.select({ target: { kind: 'raw', uuid: table.uuid }, address: { table_uuid: table.uuid, row_uuid: rowUuid }, payload: { resolveLabels: true } });
		const rows = selected.result as readonly IRawDataRow[];
		const row = rows.find(candidate => sameUuid(candidate.uuid, rowUuid));
		if (!row) {
			throw new DynamicResolveError(`selection row '${rowUuid}' no longer exists in table '${getRegistryDisplayText(table)}' (stale Selection)`);
		}
		const components = await createEditorControls(table, row.values, context.enums, createRelationSource(api, table, context.tables, context.relations));
		const rowLabel = components.find(component => component.kind === TableColumnKind.Text && typeof component.value === 'string' && component.value !== '')?.value;
		const label = typeof rowLabel === 'string' ? rowLabel : `${getRegistryDisplayText(table)} #${rows.indexOf(row) + 1}`;
		return this.inspector(definition, rowUuid, label, {
			components,
			definition: [],
			bindings: resolveBindings(context, { tableUuid: table.uuid, rowUuid }),
			address: { tableUuid: table.uuid, rowUuid },
		});
	}

	private inspector(
		definition: IDynamicSelectionDefinition,
		uuid: string,
		label: string,
		parts: { readonly components: readonly IEditorControl[]; readonly definition: readonly IDynamicProperty[]; readonly bindings: readonly IDynamicBinding[]; readonly address?: { readonly tableUuid: string; readonly rowUuid: string } },
	): IDynamicInspector {
		const sections = definition.sections;
		const open = definition.open;
		return Object.freeze({
			kind: definition.kind,
			uuid,
			label,
			...(sections[InspectorSection.Properties] ? { properties: Object.freeze({ surface: sections[InspectorSection.Properties], components: parts.components, definition: parts.definition }) } : {}),
			...(sections[InspectorSection.Binding] ? { binding: Object.freeze({ surface: sections[InspectorSection.Binding], entries: parts.bindings }) } : {}),
			...(sections[InspectorSection.Navigation] ? {
				navigation: Object.freeze({
					surface: sections[InspectorSection.Navigation],
					actions: Object.freeze(open === undefined ? [] : [Object.freeze({ type: DynamicActionType.Open, label: `Open ${label}`, surface: open })]),
				}),
			} : {}),
			...(parts.address ? { address: Object.freeze(parts.address) } : {}),
		});
	}
}

function requireSelectionUuid(value: unknown, field: string): string {
	if (typeof value !== 'string' || !isRegistryUuid(value)) {
		throw new DynamicResolveError(`${field} must be a UUID (a display label is not a Persistent Identity)`);
	}
	return normalizeRegistryUuid(value);
}

// #endregion

// #region Action dispatch

/**
 * Component Save as an Action: the generic `update` request of one column of the Selected Row. A
 * Selection without a Row address has no Mutation Target.
 */
export function createDynamicUpdateAction(inspector: IDynamicInspector, columnUuid: string, value: unknown): IDynamicAction {
	if (!inspector.address) {
		throw new DynamicResolveError('the Selection is not a Raw Data Row: there is no Mutation Target');
	}
	const request: IResolverOperationRequest = createEditorUpdateRequest(inspector.address, { uuid: columnUuid }, value);
	return Object.freeze({ type: DynamicActionType.Mutate, label: 'Save', request: Object.freeze({ ...request, operation: ResolverOperation.Update }) });
}

/**
 * Component / Action Resolve: a Mutation Action is executed only by dispatching its request to the
 * Resolver Primitive named by `operation`. Navigation Actions carry no request and are handled by the Workbench.
 */
export function dispatchDynamicAction(api: IAppEditorApi, action: IDynamicAction): Promise<unknown> {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	if (action.type !== DynamicActionType.Mutate || !action.request) {
		throw new DynamicResolveError(`action '${action.label}' is not a Mutation`);
	}
	const { operation, ...request } = action.request;
	switch (operation) {
		case ResolverOperation.Create: return api.create(request).then(result => result.result);
		case ResolverOperation.Alter: return api.alter(request).then(result => result.result);
		case ResolverOperation.Truncate: return api.truncate(request).then(result => result.result);
		case ResolverOperation.Drop: return api.drop(request).then(result => result.result);
		case ResolverOperation.Insert: return api.insert(request).then(result => result.result);
		case ResolverOperation.Delete: return api.delete(request).then(result => result.result);
		case ResolverOperation.Update: return api.update(request).then(result => result.result);
		case ResolverOperation.Upsert: return api.upsert(request).then(result => result.result);
		case ResolverOperation.Select: return api.select(request).then(result => result.result);
		default: throw new DynamicResolveError(`action '${action.label}': '${String(operation)}' is not a Resolver Operation`);
	}
}

// #endregion
