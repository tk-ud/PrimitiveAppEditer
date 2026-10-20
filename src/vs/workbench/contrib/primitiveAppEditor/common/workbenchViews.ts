/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Activity Bar, Side Bar, Editor Tabs and Bottom Panel (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure / Editor Tabs / Side Bar / Bottom Panel)
 *  Editor UI.md (3. Workbench Placement, 9. Primary Side Bar, 10. Editor Area, 14. Debug Viewer and Bottom Panel)
 *  Function Graph.md (2. Placement)
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IAsset } from './assetRegistry.js';
import {
	createDataEditorNavigation, DataEditorSection, DataEditorSelection, DataEditorTabs, DataEditorTarget, IDataEditorContext,
	IDataEditorEntry, IDataEditorTab,
} from './dataEditor.js';
import { DynamicSurface, IDynamicSelection } from './dynamicResolve.js';
import { debugViewerTabUuid } from './debugViewer.js';
import { functionGraphTabUuid } from './functionGraph.js';
import { getRegistryDisplayText } from './registryIdentity.js';
import { IFunctionBindingEntry } from './functionBinding.js';
import { IFunctionProgram } from './functionProgramScan.js';
import { IRegistrySnapshot } from './projectOpenSession.js';
import { compareTableRegistryOrder } from './tableRegistry.js';

/**
 * Workbench placement of the App Editor surfaces. The App Editor does not re-implement a Desktop
 * Layout: it fills the existing Code OSS parts.
 *
 * ```text
 * Activity Bar         = Top-level Navigation        ({@link ActivityBarItem})
 * Primary Side Bar     = Tree / List Navigation      ({@link createSideBarTree})
 * Editor Area          = Editor Tabs                 ({@link EditorTabKind}, {@link WorkbenchViewsModel.open})
 * Secondary Side Bar   = Registry Driven Inspector   (reads {@link WorkbenchViewsModel.selection})
 * Bottom Panel         = transient Diagnostic / Execution Output ({@link BottomPanelOutput})
 * ```
 *
 * This module is the model of that placement and is Derived: every Side Bar entry reads the Registry /
 * Binding snapshot and holds no authority. An entry only selects (the Shared Selection Context the
 * Inspector resolves) and optionally opens an Editor Area tab (reusing the tab of the same Target); the
 * Side Bar never edits a property. The Bottom Panel only shows output, never a Persistent Authoring Control.
 */

/**
 * True while a Project is Ready. The Registry Driven Inspector (Secondary Side Bar) is shown only then, so a
 * Workbench without a Project keeps an empty Secondary Side Bar.
 */
export const projectReadyContextKey = new RawContextKey<boolean>('primitiveAppEditor.projectReady', false);

// #region Activity Bar

/** Activity Bar items (39. Structure). */
export const enum ActivityBarItem {
	Explorer = 'explorer',
	Registry = 'registry',
	Data = 'data',
	Assets = 'assets',
	Functions = 'functions',
	Renderer = 'renderer',
	Debug = 'debug',
	Build = 'build',
}

export const activityBarItems: readonly ActivityBarItem[] = Object.freeze([
	ActivityBarItem.Explorer, ActivityBarItem.Registry, ActivityBarItem.Data, ActivityBarItem.Assets,
	ActivityBarItem.Functions, ActivityBarItem.Renderer, ActivityBarItem.Debug, ActivityBarItem.Build,
]);

/** View Container (Activity Bar entry) and View (Primary Side Bar) ids: stable GUI identifiers (Editor UI 19). */
export function activityBarContainerId(item: ActivityBarItem): string {
	return `workbench.view.primitiveAppEditor.${item}`;
}

export function activityBarViewId(item: ActivityBarItem): string {
	return `primitiveAppEditor.view.${item}`;
}

export function activityBarTitle(item: ActivityBarItem): string {
	switch (item) {
		case ActivityBarItem.Explorer: return localize('primitiveAppEditor.activity.explorer', "App Explorer");
		case ActivityBarItem.Registry: return localize('primitiveAppEditor.activity.registry', "Registry");
		case ActivityBarItem.Data: return localize('primitiveAppEditor.activity.data', "Data");
		case ActivityBarItem.Assets: return localize('primitiveAppEditor.activity.assets', "Assets");
		case ActivityBarItem.Functions: return localize('primitiveAppEditor.activity.functions', "Functions");
		case ActivityBarItem.Renderer: return localize('primitiveAppEditor.activity.renderer', "Renderer");
		case ActivityBarItem.Debug: return localize('primitiveAppEditor.activity.debug', "App Debug");
		case ActivityBarItem.Build: return localize('primitiveAppEditor.activity.build', "Build");
	}
}

/** Codicon id of an Activity Bar item. */
export function activityBarIcon(item: ActivityBarItem): string {
	switch (item) {
		case ActivityBarItem.Explorer: return 'folder-library';
		case ActivityBarItem.Registry: return 'symbol-structure';
		case ActivityBarItem.Data: return 'database';
		case ActivityBarItem.Assets: return 'file-media';
		case ActivityBarItem.Functions: return 'symbol-function';
		case ActivityBarItem.Renderer: return 'symbol-color';
		case ActivityBarItem.Debug: return 'debug-alt';
		case ActivityBarItem.Build: return 'package';
	}
}

// #endregion

// #region Editor Tabs

/** Editor Tabs (39. Editor Tabs). Code Editor and Debug Viewer are separate tabs. */
export const enum EditorTabKind {
	CodeEditor = 'code_editor',
	RegistryEditor = 'registry_editor',
	DataEditor = 'data_editor',
	FunctionGraph = 'function_graph',
	RendererEditor = 'renderer_editor',
	AssetEditor = 'asset_editor',
	DebugViewer = 'debug_viewer',
}

export const editorTabKinds: readonly EditorTabKind[] = Object.freeze([
	EditorTabKind.CodeEditor, EditorTabKind.RegistryEditor, EditorTabKind.DataEditor, EditorTabKind.FunctionGraph,
	EditorTabKind.RendererEditor, EditorTabKind.AssetEditor, EditorTabKind.DebugViewer,
]);

/**
 * The Editor Tab kind that presents an Editor Area Target. The Code Editor edits the Working Directory
 * Program / Script (the Workbench text editor of a file), so it has no {@link DataEditorTarget}.
 */
export function editorTabKindOf(target: DataEditorTarget): EditorTabKind {
	switch (target) {
		case DataEditorTarget.DataGrid:
		case DataEditorTarget.PhysicalTable:
			return EditorTabKind.DataEditor;
		case DataEditorTarget.RelationGraph:
		case DataEditorTarget.RegistryEditor:
			return EditorTabKind.RegistryEditor;
		case DataEditorTarget.FunctionGraph: return EditorTabKind.FunctionGraph;
		case DataEditorTarget.DebugViewer: return EditorTabKind.DebugViewer;
		case DataEditorTarget.RendererEditor: return EditorTabKind.RendererEditor;
		case DataEditorTarget.AssetEditor: return EditorTabKind.AssetEditor;
	}
}

// #endregion

// #region Bottom Panel

/** Bottom Panel views (39. Bottom Panel). */
export const enum BottomPanelView {
	Console = 'console',
	BuildLog = 'build_log',
	RuntimeState = 'runtime_state',
	EventLog = 'event_log',
	FunctionOutput = 'function_output',
	Diagnostics = 'diagnostics',
}

export const bottomPanelViews: readonly BottomPanelView[] = Object.freeze([
	BottomPanelView.Console, BottomPanelView.BuildLog, BottomPanelView.RuntimeState,
	BottomPanelView.EventLog, BottomPanelView.FunctionOutput, BottomPanelView.Diagnostics,
]);

export function bottomPanelContainerId(): string {
	return 'workbench.panel.primitiveAppEditor';
}

export function bottomPanelViewId(view: BottomPanelView): string {
	return `primitiveAppEditor.panel.${view}`;
}

export function bottomPanelTitle(view: BottomPanelView): string {
	switch (view) {
		case BottomPanelView.Console: return localize('primitiveAppEditor.panel.console', "Console");
		case BottomPanelView.BuildLog: return localize('primitiveAppEditor.panel.buildLog', "Build Log");
		case BottomPanelView.RuntimeState: return localize('primitiveAppEditor.panel.runtimeState', "Runtime State");
		case BottomPanelView.EventLog: return localize('primitiveAppEditor.panel.eventLog', "Event Log");
		case BottomPanelView.FunctionOutput: return localize('primitiveAppEditor.panel.functionOutput', "Function Output");
		case BottomPanelView.Diagnostics: return localize('primitiveAppEditor.panel.diagnostics', "Diagnostics");
	}
}

export const enum BottomPanelSeverity {
	Info = 'info',
	Warning = 'warning',
	Error = 'error',
}

/** One Bottom Panel line: read-only text, so the Panel carries output only and no authoring control. */
export interface IBottomPanelEntry {
	readonly id: number;
	readonly severity: BottomPanelSeverity;
	readonly text: string;
}

/**
 * Transient Diagnostic / Execution Output of the Bottom Panel views. Output is bounded per view and is
 * dropped with the Project ({@link clear}); nothing is persisted and nothing here is editable.
 */
export class BottomPanelOutput {

	static readonly maxEntries = 1000;

	private nextId = 1;
	private readonly entries = new Map<BottomPanelView, IBottomPanelEntry[]>(bottomPanelViews.map(view => [view, []]));
	private readonly listeners = new Set<(view: BottomPanelView) => void>();

	append(view: BottomPanelView, text: string, severity: BottomPanelSeverity = BottomPanelSeverity.Info): IBottomPanelEntry {
		const entry = Object.freeze({ id: this.nextId++, severity, text });
		const list = this.entries.get(view)!;
		list.push(entry);
		if (list.length > BottomPanelOutput.maxEntries) {
			list.splice(0, list.length - BottomPanelOutput.maxEntries);
		}
		this.fire(view);
		return entry;
	}

	get(view: BottomPanelView): readonly IBottomPanelEntry[] {
		return [...this.entries.get(view)!];
	}

	/** Drops the transient output of one view, or of every view. */
	clear(view?: BottomPanelView): void {
		for (const candidate of view ? [view] : bottomPanelViews) {
			this.entries.get(candidate)!.length = 0;
			this.fire(candidate);
		}
	}

	onDidChange(listener: (view: BottomPanelView) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private fire(view: BottomPanelView): void {
		for (const listener of [...this.listeners]) {
			listener(view);
		}
	}
}

// #endregion

// #region Primary Side Bar

/** What activating a Side Bar node opens in the Editor Area (optional; Selection is separate). */
export type SideBarOpen =
	/** The tab of a Target of the App Editor (reused when it exists). */
	| { readonly kind: 'tab'; readonly target: DataEditorTarget; readonly uuid: string }
	/** The Code Editor (Workbench text editor) of a Working Directory file, relative path `/` separated. */
	| { readonly kind: 'file'; readonly path: string }
	/** A Bottom Panel view (Build Log etc.): reveals output, edits nothing. */
	| { readonly kind: 'panel'; readonly view: BottomPanelView };

/**
 * One Side Bar Tree / List node. `uuid` is the Item Identity (`data-pae-item`) of a node that represents a
 * Registry / Raw Data / Binding Item; group nodes and path nodes have none. `id` is unique within the
 * view and is never shown.
 */
export interface ISideBarNode {
	readonly id: string;
	/** Display text, never a UUID. */
	readonly label: string;
	readonly description?: string;
	readonly uuid?: string;
	/** Selecting the node writes this to the Shared Selection Context. Absent: not selectable (group). */
	readonly selection?: IDynamicSelection;
	readonly open?: SideBarOpen;
	readonly children: readonly ISideBarNode[];
}

/** The snapshot the Side Bar lists. Read-only. */
export interface ISideBarContext {
	readonly registry: IRegistrySnapshot | undefined;
	readonly functionBindings: readonly IFunctionBindingEntry[];
	readonly assets: readonly IAsset[];
	readonly programs: readonly IFunctionProgram[];
	/** Name of the Working Directory (the opened folder). */
	readonly rootName: string;
}

function node(id: string, label: string, extra: Partial<Omit<ISideBarNode, 'id' | 'label' | 'children'>> = {}, children: readonly ISideBarNode[] = []): ISideBarNode {
	return Object.freeze({ id, label, ...extra, children: Object.freeze([...children]) });
}

function group(id: string, label: string, children: readonly ISideBarNode[]): ISideBarNode {
	return node(id, label, {}, children);
}

function tab(target: DataEditorTarget, uuid: string): SideBarOpen {
	return Object.freeze({ kind: 'tab', target, uuid });
}

function byIndex<T extends { readonly index: number }>(entries: readonly T[]): T[] {
	return [...entries].sort((a, b) => a.index - b.index);
}

function dataContext(context: ISideBarContext): IDataEditorContext {
	const registry = context.registry;
	return {
		tables: registry?.tables ?? [],
		relations: registry?.relations ?? [],
		functions: registry?.functions ?? [],
		renderers: registry?.renderers ?? [],
		functionBindings: context.functionBindings,
		rendererBindings: registry?.rendererBindings ?? [],
	};
}

function dataEntryNode(entry: IDataEditorEntry): ISideBarNode {
	return node(`${entry.section}:${entry.uuid}`, entry.label, {
		uuid: entry.uuid,
		selection: entry.selection,
		...(entry.description !== undefined ? { description: entry.description } : {}),
		...(entry.open ? { open: tab(entry.open.target, entry.open.uuid) } : {}),
	});
}

/** Nested path tree of a list of `/` separated paths; leaves are built by `leaf`. */
function pathTree<T>(items: readonly T[], pathOf: (item: T) => string, leaf: (item: T, name: string, id: string) => ISideBarNode, idPrefix: string): ISideBarNode[] {
	interface IFolder { readonly name: string; readonly folders: Map<string, IFolder>; readonly leaves: ISideBarNode[] }
	const root: IFolder = { name: '', folders: new Map(), leaves: [] };
	for (const item of items) {
		const segments = pathOf(item).split('/').filter(segment => segment.length > 0);
		const name = segments.pop() ?? pathOf(item);
		let folder = root;
		for (const segment of segments) {
			let next = folder.folders.get(segment);
			if (!next) {
				next = { name: segment, folders: new Map(), leaves: [] };
				folder.folders.set(segment, next);
			}
			folder = next;
		}
		folder.leaves.push(leaf(item, name, `${idPrefix}:${pathOf(item)}`));
	}
	const build = (folder: IFolder, path: string): ISideBarNode[] => [
		...[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => group(`${idPrefix}-folder:${path}${child.name}`, child.name, build(child, `${path}${child.name}/`))),
		...folder.leaves,
	];
	return build(root, '');
}

/**
 * Tree of one Activity Bar item (39. Side Bar). Each section lists the Registry / Binding snapshot in its
 * Registry order; without a Ready Project every tree is empty.
 *
 * ```text
 * Explorer   Working Directory (Program / Script files -> Code Editor)
 * Registry   Table / Column / Relation / Enum / Function / Renderer (-> Registry Editor)
 * Data       Physical Table / Raw Data (+ Relation / Binding Discovery) (-> Data Editor)
 * Assets     Asset Tree (-> Asset Editor)
 * Functions  Function Registry / Function Binding / Dependency Graph (-> Function Graph)
 * Renderer   Renderer Registry / Renderer Binding (-> Renderer Editor)
 * Debug      Debug Viewer
 * Build      Build Log
 * ```
 */
export function createSideBarTree(item: ActivityBarItem, context: ISideBarContext): readonly ISideBarNode[] {
	const registry = context.registry;
	if (!registry) {
		return Object.freeze([]);
	}
	const data = dataContext(context);
	const tables = [...registry.tables].sort(compareTableRegistryOrder);
	switch (item) {
		case ActivityBarItem.Explorer:
			return Object.freeze([node('explorer:working-directory', context.rootName, {}, [
				...pathTree(context.programs, program => program.path, (program, name, id) => node(id, name, { open: Object.freeze({ kind: 'file', path: `functions/${program.path}` }) }), 'program'),
			])]);
		case ActivityBarItem.Registry:
			return Object.freeze([
				group('registry:table', localize('primitiveAppEditor.sideBar.table', "Table"), tables.map(table => node(`table:${table.uuid}`, getRegistryDisplayText(table), {
					uuid: table.uuid, selection: Object.freeze({ uuid: table.uuid }), open: tab(DataEditorTarget.RegistryEditor, table.uuid),
				}))),
				group('registry:column', localize('primitiveAppEditor.sideBar.column', "Column"), tables.map(table => node(`column-table:${table.uuid}`, getRegistryDisplayText(table), {
					uuid: table.uuid, selection: Object.freeze({ uuid: table.uuid }),
				}, [...table.columns].sort((a, b) => a.index - b.index).map(column => node(`column:${column.uuid}`, getRegistryDisplayText(column), {
					uuid: column.uuid, description: column.kind, selection: Object.freeze({ uuid: table.uuid }), open: tab(DataEditorTarget.RegistryEditor, table.uuid),
				}))))),
				group('registry:relation', localize('primitiveAppEditor.sideBar.relation', "Relation"), dataEntryChildren(data, DataEditorSection.Relation)),
				group('registry:enum', localize('primitiveAppEditor.sideBar.enum', "Enum"), byIndex(registry.enums).map(entry => node(`enum:${entry.uuid}`, getRegistryDisplayText(entry), {
					uuid: entry.uuid, selection: Object.freeze({ uuid: entry.uuid }), open: tab(DataEditorTarget.RegistryEditor, entry.uuid),
				}))),
				group('registry:function', localize('primitiveAppEditor.sideBar.function', "Function"), byIndex(registry.functions).map(entry => node(`function:${entry.uuid}`, getRegistryDisplayText(entry), {
					uuid: entry.uuid, selection: Object.freeze({ uuid: entry.uuid }), open: tab(DataEditorTarget.RegistryEditor, entry.uuid),
				}))),
				group('registry:renderer', localize('primitiveAppEditor.sideBar.renderer', "Renderer"), byIndex(registry.renderers).map(entry => node(`renderer:${entry.uuid}`, getRegistryDisplayText(entry), {
					uuid: entry.uuid, selection: Object.freeze({ uuid: entry.uuid }), open: tab(DataEditorTarget.RegistryEditor, entry.uuid),
				}))),
			]);
		case ActivityBarItem.Data:
			return Object.freeze([
				group('data:physical-table', localize('primitiveAppEditor.sideBar.physicalTable', "Physical Table"), dataEntryChildren(data, DataEditorSection.PhysicalTable)),
				group('data:raw-data', localize('primitiveAppEditor.sideBar.rawData', "Raw Data"), dataEntryChildren(data, DataEditorSection.RawData)),
			]);
		case ActivityBarItem.Assets:
			return Object.freeze([group('assets:tree', localize('primitiveAppEditor.sideBar.assetTree', "Asset Tree"), pathTree(context.assets, asset => asset.source, (asset, name, id) => node(id, getRegistryDisplayText(asset) || name, {
				uuid: asset.uuid, description: asset.kind, selection: Object.freeze({ uuid: asset.uuid }), open: tab(DataEditorTarget.AssetEditor, asset.uuid),
			}), 'asset'))]);
		case ActivityBarItem.Functions:
			return Object.freeze([
				group('functions:registry', localize('primitiveAppEditor.sideBar.functionRegistry', "Function Registry"), byIndex(registry.functions).map(entry => node(`function-registry:${entry.uuid}`, getRegistryDisplayText(entry), {
					uuid: entry.uuid, selection: Object.freeze({ uuid: entry.uuid }), open: tab(DataEditorTarget.FunctionGraph, functionGraphTabUuid),
				}))),
				group('functions:binding', localize('primitiveAppEditor.sideBar.functionBinding', "Function Binding"), createDataEditorNavigation(data)
					.filter(section => section.section === DataEditorSection.FunctionBinding)
					.flatMap(section => section.entries)
					.map(entry => dataEntryNode({ ...entry, open: Object.freeze({ surface: DynamicSurface.EditorArea, target: DataEditorTarget.FunctionGraph, uuid: functionGraphTabUuid }) }))),
				node('functions:dependency-graph', localize('primitiveAppEditor.sideBar.dependencyGraph', "Dependency Graph"), { open: tab(DataEditorTarget.FunctionGraph, functionGraphTabUuid) }),
			]);
		case ActivityBarItem.Renderer:
			return Object.freeze([
				group('renderer:registry', localize('primitiveAppEditor.sideBar.rendererRegistry', "Renderer Registry"), byIndex(registry.renderers).map(entry => node(`renderer-registry:${entry.uuid}`, getRegistryDisplayText(entry), {
					uuid: entry.uuid, selection: Object.freeze({ uuid: entry.uuid }), open: tab(DataEditorTarget.RendererEditor, entry.uuid),
				}))),
				group('renderer:binding', localize('primitiveAppEditor.sideBar.rendererBinding', "Renderer Binding"), dataEntryChildren(data, DataEditorSection.RendererBinding)),
			]);
		case ActivityBarItem.Debug:
			return Object.freeze([node('debug:viewer', localize('primitiveAppEditor.sideBar.debugViewer', "Debug Viewer"), { open: tab(DataEditorTarget.DebugViewer, debugViewerTabUuid) })]);
		case ActivityBarItem.Build:
			return Object.freeze([node('build:log', localize('primitiveAppEditor.sideBar.buildLog', "Build Log"), { open: Object.freeze({ kind: 'panel', view: BottomPanelView.BuildLog }) })]);
	}
}

function dataEntryChildren(data: IDataEditorContext, section: DataEditorSection): ISideBarNode[] {
	return createDataEditorNavigation(data).filter(navigation => navigation.section === section).flatMap(navigation => navigation.entries).map(dataEntryNode);
}

// #endregion

// #region Activation (Selection + optional Editor Area Open)

/** The result of activating a Side Bar node: what the Workbench opens (nothing for a selection-only node). */
export type SideBarActivation =
	| { readonly kind: 'none' }
	| { readonly kind: 'tab'; readonly tab: IDataEditorTab; readonly tabKind: EditorTabKind; readonly reused: boolean }
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'panel'; readonly view: BottomPanelView };

/**
 * The Shared Selection Context and Editor Area tabs of the Workbench. Side Bar Selection, Editor Area
 * Selection and Debug Viewer Selection all write {@link selection}, which the single Registry Driven
 * Inspector (Secondary Side Bar) resolves; the Editor tab of a Target is reused, never duplicated.
 */
export class WorkbenchViewsModel {

	readonly selection = new DataEditorSelection();
	readonly tabs = new DataEditorTabs();

	/** Tree / List Select -> Registry Driven Inspector Update + Optional Editor Area Open. */
	activate(target: ISideBarNode): SideBarActivation {
		if (target.selection) {
			this.selection.select(target.selection);
		}
		return target.open ? this.open(target.open) : { kind: 'none' };
	}

	/** Opens (or reuses) the Editor Area content of an open request. */
	open(request: SideBarOpen): SideBarActivation {
		switch (request.kind) {
			case 'file': return Object.freeze({ kind: 'file', path: request.path });
			case 'panel': return Object.freeze({ kind: 'panel', view: request.view });
			case 'tab': {
				const opened = this.tabs.open(request.target, request.uuid);
				return Object.freeze({ kind: 'tab', tab: opened.tab, tabKind: editorTabKindOf(request.target), reused: opened.reused });
			}
		}
	}
}

// #endregion
