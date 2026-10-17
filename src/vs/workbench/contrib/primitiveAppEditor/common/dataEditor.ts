/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Data Editor and Raw Data authoring (editor.data-ui)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (26. Editor)
 *  Boundary: App Editer.md (25. Editor UI), Editor UI.md (3, 9, 10, 15)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { DynamicSurface, IDynamicSelection } from './dynamicResolve.js';
import { dispatchEditorControl, EditorControlType, IEditorControlOption, IEditorRelationSource, saveEditorValue, validateEditorValue } from './editorControls.js';
import { EnumRegistryIndex, getEnumValueLabel } from './enumRegistry.js';
import { IFunctionBindingEntry, resolveFunctionBindingAddressDisplay } from './functionBinding.js';
import { IFunctionRegistryEntry } from './functionRegistry.js';
import { getRegistryDisplayText, normalizeRegistryUuid } from './registryIdentity.js';
import { IRelationRegistryEntry } from './relationRegistry.js';
import { IRendererBindingEntry, IRendererRegistryEntry } from './rendererRegistry.js';
import { IAppEditorApi } from './resolver.js';
import { compareTableRegistryOrder, ITableRegistryColumn, ITableRegistryEntry, TableColumnKind } from './tableRegistry.js';

/**
 * Data Editor (26. Editor): `Physical Table / Raw Data / Relation / Function Binding / Renderer Binding`.
 *
 * ```text
 * Data Editor / Side Bar / Editor Area
 *   = Discovery / List / Structural or Detailed View / Selection
 *
 * Registry Driven Inspector
 *   = Compact Property Editing / Binding Composition / Contextual Mutation
 * ```
 *
 * This module is the model of the Data Editor surfaces; it is Derived from the Registry / Binding
 * snapshot and Raw Data and keeps no authority of its own:
 *
 * - {@link createDataEditorNavigation}: Primary Side Bar Discovery / List / Selection. An entry only
 *   selects (and may open an Editor Area tab); it is not a second property editor.
 * - {@link DataGridModel}: Editor Area Data Grid of one Raw Data table. Columns, Kind Dispatch and cell
 *   display come from `table_registry` (no table specific UI model); cell edit, row insert and row
 *   delete are the generic `update` / `insert` / `delete` Primitives.
 * - {@link DataEditorSelection}: the Shared Selection Context. Side Bar and Editor Area selection
 *   write the same {@link IDynamicSelection}, which the single Registry Driven Inspector resolves.
 * - {@link DataEditorTabs}: one Editor Area tab per Target; opening a Target again reuses its tab.
 *
 * Function Binding / Renderer Binding are listed for Discovery and selection only; composing them is
 * the Inspector's Binding section, so no competing Binding Editing Surface exists here. Selection is a
 * UUID, never a display label.
 */

export class DataEditorError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor data editor: ${message}`);
		this.name = 'DataEditorError';
	}
}

// #region Navigation (Primary Side Bar)

/** Data Editor sections (26. Editor). */
export const enum DataEditorSection {
	PhysicalTable = 'physical_table',
	RawData = 'raw_data',
	Relation = 'relation',
	FunctionBinding = 'function_binding',
	RendererBinding = 'renderer_binding',
}

export const dataEditorSections: readonly DataEditorSection[] = Object.freeze([
	DataEditorSection.PhysicalTable, DataEditorSection.RawData, DataEditorSection.Relation,
	DataEditorSection.FunctionBinding, DataEditorSection.RendererBinding,
]);

/** The Registry / Binding snapshot the Data Editor lists. Read-only. */
export interface IDataEditorContext {
	readonly tables: readonly ITableRegistryEntry[];
	readonly relations: readonly IRelationRegistryEntry[];
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly functionBindings: readonly IFunctionBindingEntry[];
	readonly rendererBindings: readonly IRendererBindingEntry[];
}

/** What opening an entry shows in the Editor Area. */
export const enum DataEditorTarget {
	/** Data Grid of the table's Raw Data. */
	DataGrid = 'data_grid',
	/** Structural view of the table's projected Physical Table (columns by Kind). */
	PhysicalTable = 'physical_table',
	/** Structural view of a relation graph. */
	RelationGraph = 'relation_graph',
}

export interface IDataEditorEntry {
	readonly section: DataEditorSection;
	/** Persistent Identity of the entry (table / relation / binding UUID). */
	readonly uuid: string;
	/** Human display text. Never the UUID. */
	readonly label: string;
	/** Secondary text, e.g. the Function a binding runs. */
	readonly description?: string;
	/** Selecting the entry sets this on the Shared Selection Context. */
	readonly selection: IDynamicSelection;
	/** The Editor Area content the entry opens, if any (optional Editor Area Open). */
	readonly open?: { readonly surface: DynamicSurface; readonly target: DataEditorTarget; readonly uuid: string };
}

export interface IDataEditorNavigation {
	readonly section: DataEditorSection;
	readonly label: string;
	readonly entries: readonly IDataEditorEntry[];
}

const sectionLabels: Readonly<Record<DataEditorSection, string>> = Object.freeze({
	[DataEditorSection.PhysicalTable]: 'Physical Table',
	[DataEditorSection.RawData]: 'Raw Data',
	[DataEditorSection.Relation]: 'Relation',
	[DataEditorSection.FunctionBinding]: 'Function Binding',
	[DataEditorSection.RendererBinding]: 'Renderer Binding',
});

function byIndex<T extends { readonly index: number }>(entries: readonly T[]): T[] {
	return [...entries].sort((a, b) => a.index - b.index);
}

/**
 * Primary Side Bar content: Discovery / List / Selection of the Data Editor sections, in Registry
 * order. Entries carry the Selection and the optional Editor Area Open; they hold no editable value.
 */
export function createDataEditorNavigation(context: IDataEditorContext): readonly IDataEditorNavigation[] {
	const tableLabel = (uuid: string): string => {
		const table = context.tables.find(candidate => candidate.uuid === uuid);
		return table ? getRegistryDisplayText(table) : 'Missing table';
	};

	const tables = byIndex(context.tables);
	const physical = tables.map((table): IDataEditorEntry => Object.freeze({
		section: DataEditorSection.PhysicalTable,
		uuid: table.uuid,
		label: getRegistryDisplayText(table),
		description: `${table.columns.length} columns`,
		selection: Object.freeze({ uuid: table.uuid }),
		open: Object.freeze({ surface: DynamicSurface.EditorArea, target: DataEditorTarget.PhysicalTable, uuid: table.uuid }),
	}));
	const raw = tables.map((table): IDataEditorEntry => Object.freeze({
		section: DataEditorSection.RawData,
		uuid: table.uuid,
		label: getRegistryDisplayText(table),
		selection: Object.freeze({ uuid: table.uuid }),
		open: Object.freeze({ surface: DynamicSurface.EditorArea, target: DataEditorTarget.DataGrid, uuid: table.uuid }),
	}));
	const relations = byIndex(context.relations).map((relation): IDataEditorEntry => Object.freeze({
		section: DataEditorSection.Relation,
		uuid: relation.uuid,
		label: tableLabel(relation.main_table),
		description: relation.relations.map(join => tableLabel(join.join_table)).join(', '),
		selection: Object.freeze({ uuid: relation.uuid }),
		open: Object.freeze({ surface: DynamicSurface.EditorArea, target: DataEditorTarget.RelationGraph, uuid: relation.uuid }),
	}));
	const functionBindings = byIndex(context.functionBindings).map((binding): IDataEditorEntry => {
		const fn = context.functions.find(candidate => candidate.uuid === binding.function.uuid);
		const target = resolveFunctionBindingAddressDisplay(binding.target.address, context.tables);
		return Object.freeze({
			section: DataEditorSection.FunctionBinding,
			uuid: binding.uuid,
			label: fn ? getRegistryDisplayText(fn) : 'Missing function',
			...(target ? { description: `${target.table} / ${target.column}` } : {}),
			selection: Object.freeze({ uuid: binding.uuid }),
		});
	});
	const rendererBindings = context.rendererBindings.map((binding): IDataEditorEntry => {
		const renderer = context.renderers.find(candidate => candidate.uuid === binding.renderer.uuid);
		return Object.freeze({
			section: DataEditorSection.RendererBinding,
			uuid: binding.uuid,
			label: renderer ? getRegistryDisplayText(renderer) : 'Missing renderer',
			selection: Object.freeze({ uuid: binding.uuid }),
		});
	});

	const sections: Readonly<Record<DataEditorSection, readonly IDataEditorEntry[]>> = {
		[DataEditorSection.PhysicalTable]: physical,
		[DataEditorSection.RawData]: raw,
		[DataEditorSection.Relation]: relations,
		[DataEditorSection.FunctionBinding]: functionBindings,
		[DataEditorSection.RendererBinding]: rendererBindings,
	};
	return Object.freeze(dataEditorSections.map(section => Object.freeze({ section, label: sectionLabels[section], entries: Object.freeze(sections[section]) })));
}

// #endregion

// #region Shared Selection Context and Editor Area tabs

/**
 * Shared Selection Context: Side Bar Selection and Editor Area Selection write the same value, which
 * the Registry Driven Inspector resolves. Only the UUID address is held (never a label).
 */
export class DataEditorSelection {

	private current: IDynamicSelection | undefined;
	private readonly listeners = new Set<(selection: IDynamicSelection | undefined) => void>();

	get selection(): IDynamicSelection | undefined {
		return this.current;
	}

	select(selection: IDynamicSelection | undefined): void {
		this.current = selection;
		for (const listener of [...this.listeners]) {
			listener(selection);
		}
	}

	onDidChange(listener: (selection: IDynamicSelection | undefined) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
}

/** One Editor Area tab. */
export interface IDataEditorTab {
	readonly id: number;
	readonly target: DataEditorTarget;
	readonly uuid: string;
}

/** Editor Area tabs: the tab of a Target is reused, so opening it again never adds a duplicate. */
export class DataEditorTabs {

	private nextId = 1;
	private readonly tabs = new Map<string, IDataEditorTab>();

	/** The existing tab of the Target, or a new one. `reused` tells which. */
	open(target: DataEditorTarget, uuid: string): { readonly tab: IDataEditorTab; readonly reused: boolean } {
		const key = `${target}:${normalizeRegistryUuid(uuid)}`;
		const existing = this.tabs.get(key);
		if (existing) {
			return { tab: existing, reused: true };
		}
		const tab = Object.freeze({ id: this.nextId++, target, uuid: normalizeRegistryUuid(uuid) });
		this.tabs.set(key, tab);
		return { tab, reused: false };
	}

	close(tab: IDataEditorTab): void {
		this.tabs.delete(`${tab.target}:${tab.uuid}`);
	}

	get openTabs(): readonly IDataEditorTab[] {
		return [...this.tabs.values()];
	}
}

/** Open the Editor Area content of an entry (reusing its tab) and set the Shared Selection Context. */
export function selectDataEditorEntry(entry: IDataEditorEntry, selection: DataEditorSelection, tabs: DataEditorTabs): { readonly tab?: IDataEditorTab; readonly reused?: boolean } {
	selection.select(entry.selection);
	return entry.open ? tabs.open(entry.open.target, entry.open.uuid) : {};
}

// #endregion

// #region Data Grid (Editor Area)

/** One Grid column, derived from one Registry column. */
export interface IDataGridColumn {
	readonly columnUuid: string;
	/** Human header text (label, else name). Never the UUID. */
	readonly header: string;
	readonly kind: TableColumnKind;
	/** Kind Dispatch of the cell Editor Component. */
	readonly control: EditorControlType;
	readonly required: boolean;
	readonly readOnly: boolean;
}

export interface IDataGridCell {
	readonly columnUuid: string;
	/** Stored value (`null` = absent). */
	readonly value: unknown;
	/** Human text for `enum` (label) and `uuid` (related row label) cells. */
	readonly displayValue?: string;
}

export interface IDataGridRow {
	readonly uuid: string;
	readonly cells: readonly IDataGridCell[];
}

interface ISelectedRow {
	readonly uuid: string;
	readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Data Grid of one Raw Data table. {@link load} reads the rows through the generic `select`; the Grid
 * keeps the snapshot only for presentation. Authoring is dispatched to the Resolver Primitives and the
 * caller reloads, so the Registry stays the Definition Authority and Raw Data the value authority.
 */
export class DataGridModel {

	private currentRows: readonly IDataGridRow[] = Object.freeze([]);
	private options = new Map<string, readonly IEditorControlOption[]>();

	constructor(
		private readonly api: Pick<IAppEditorApi, 'select' | 'insert' | 'update' | 'delete'>,
		readonly table: ITableRegistryEntry,
		private readonly enums: EnumRegistryIndex,
		private readonly relations?: IEditorRelationSource,
	) { }

	get columns(): readonly IDataGridColumn[] {
		return Object.freeze([...this.table.columns].sort(compareTableRegistryOrder).map((column): IDataGridColumn => Object.freeze({
			columnUuid: column.uuid,
			header: getRegistryDisplayText(column),
			kind: column.kind,
			control: dispatchEditorControl(column.kind),
			required: column.not_null,
			readOnly: !column.writable,
		})));
	}

	get rows(): readonly IDataGridRow[] {
		return this.currentRows;
	}

	/** Read Raw Data (Registry order, Row identity tiebreak) and resolve `enum` / `uuid` cells to human text. */
	async load(): Promise<readonly IDataGridRow[]> {
		assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
		const selected = await this.api.select({ target: { kind: 'raw', uuid: this.table.uuid }, payload: {} });
		const rows = selected.result as readonly ISelectedRow[];
		const columns = [...this.table.columns].sort(compareTableRegistryOrder);

		this.options = new Map();
		for (const column of columns) {
			if (column.kind === TableColumnKind.Uuid) {
				const options = await this.relations?.options(column);
				if (options) {
					this.options.set(column.uuid, options);
				}
			}
		}

		this.currentRows = Object.freeze(rows.map((row): IDataGridRow => Object.freeze({
			uuid: row.uuid,
			cells: Object.freeze(columns.map((column): IDataGridCell => this.cell(column, row.values[column.uuid]))),
		})));
		return this.currentRows;
	}

	private cell(column: ITableRegistryColumn, raw: unknown): IDataGridCell {
		const value = raw === undefined ? null : raw;
		let displayValue: string | undefined;
		if (column.kind === TableColumnKind.Enum && typeof value === 'string') {
			const entry = this.enums.resolveColumn(column);
			displayValue = getEnumValueLabel(entry, value);
		} else if (column.kind === TableColumnKind.Uuid && typeof value === 'string') {
			displayValue = this.options.get(column.uuid)?.find(option => option.value === normalizeRegistryUuid(value))?.label;
		}
		return Object.freeze({ columnUuid: column.uuid, value, ...(displayValue === undefined ? {} : { displayValue }) });
	}

	/** Select a Row in the Grid: the same Shared Selection Context the Side Bar writes. */
	selectRow(rowUuid: string, selection: DataEditorSelection): void {
		if (!this.currentRows.some(row => row.uuid === normalizeRegistryUuid(rowUuid))) {
			throw new DataEditorError(`row '${rowUuid}' is not in the loaded Raw Data of '${getRegistryDisplayText(this.table)}'`);
		}
		selection.select(Object.freeze({ uuid: normalizeRegistryUuid(rowUuid), table_uuid: this.table.uuid }));
	}

	/** A Registry column by UUID (Machine Identity) or name, as accepted by the Raw Data payload. */
	private column(columnKey: string): ITableRegistryColumn {
		const lower = columnKey.toLowerCase();
		const column = this.table.columns.find(candidate => candidate.uuid === lower || candidate.name === columnKey);
		if (!column) {
			throw new DataEditorError(`table '${getRegistryDisplayText(this.table)}' has no column '${columnKey}' in the Registry`);
		}
		return column;
	}

	/** Inline Message for an edit, the same Kind Validate the Resolver runs on Save; `undefined` when valid. */
	validateCell(columnKey: string, value: unknown): string | undefined {
		return validateEditorValue(this.column(columnKey), value, this.enums);
	}

	/** Edit a cell: the generic `update(request)`, then reload. */
	async editCell(rowUuid: string, columnUuid: string, value: unknown): Promise<void> {
		await saveEditorValue(this.api, { tableUuid: this.table.uuid, rowUuid }, this.column(columnUuid), value, this.enums);
		await this.load();
	}

	/** Insert a Row: the generic `insert(request)` (Row identity generated by the Resolver when omitted), then reload. */
	async insertRow(values: Readonly<Record<string, unknown>>, rowUuid?: string): Promise<string> {
		for (const [columnUuid, value] of Object.entries(values)) {
			const column = this.column(columnUuid);
			if (!column.writable) {
				throw new DataEditorError(`column '${getRegistryDisplayText(column)}' is not writable`);
			}
			const message = this.validateCell(columnUuid, value);
			if (message !== undefined) {
				throw new DataEditorError(`column '${getRegistryDisplayText(this.column(columnUuid))}': ${message}`);
			}
		}
		const inserted = await this.api.insert({
			target: { kind: 'raw', uuid: this.table.uuid },
			...(rowUuid === undefined ? {} : { address: { row_uuid: rowUuid } }),
			payload: values,
		});
		await this.load();
		return (inserted.result as { readonly uuid: string }).uuid;
	}

	/** Delete a Row: the generic `delete(request)`, then reload. Registry Definition is untouched. */
	async deleteRow(rowUuid: string): Promise<void> {
		await this.api.delete({ target: { kind: 'raw', uuid: this.table.uuid }, address: { row_uuid: rowUuid } });
		await this.load();
	}
}

// #endregion
