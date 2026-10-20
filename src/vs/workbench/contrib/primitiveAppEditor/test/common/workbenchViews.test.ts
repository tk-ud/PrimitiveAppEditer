/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Activity Bar, Side Bar, Editor Tabs and Bottom Panel (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure / Editor Tabs / Side Bar / Bottom Panel)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AssetKind, createAsset } from '../../common/assetRegistry.js';
import { DataEditorTarget } from '../../common/dataEditor.js';
import { debugViewerTabUuid } from '../../common/debugViewer.js';
import { createEnumRegistryEntry } from '../../common/enumRegistry.js';
import { createFunctionBindingEntry } from '../../common/functionBinding.js';
import { functionGraphTabUuid } from '../../common/functionGraph.js';
import { createFunctionRegistryEntry } from '../../common/functionRegistry.js';
import { IRegistrySnapshot } from '../../common/projectOpenSession.js';
import { createRendererRegistryEntry } from '../../common/rendererRegistry.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import {
	activityBarContainerId, ActivityBarItem, activityBarItems, activityBarViewId, bottomPanelViews, BottomPanelOutput, BottomPanelSeverity,
	BottomPanelView, createSideBarTree, editorTabKindOf, editorTabKinds, EditorTabKind, ISideBarContext, ISideBarNode, WorkbenchViewsModel,
} from '../../common/workbenchViews.js';

const ENEMY = '00000000-0000-4000-8000-0000000000a1';
const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const HP = '00000000-0000-4000-8000-0000000000c1';
const NAME = '00000000-0000-4000-8000-0000000000c2';
const FN = '00000000-0000-4000-8000-0000000000f1';
const SPRITE = '00000000-0000-4000-8000-0000000000b1';
const ELEMENT = '00000000-0000-4000-8000-0000000000e1';
const BINDING = '00000000-0000-4000-8000-0000000000d1';
const ROW = '00000000-0000-4000-8000-0000000000b2';
const IMG = '00000000-0000-4000-8000-0000000000a9';
const now = () => new Date('2026-10-15T00:00:00Z');
const col = (uuid: string, index: number, name: string, kind: TableColumnKind) => ({ uuid, index, name, kind, not_null: false, writable: true, searchable: true });

function context(ready = true): ISideBarContext {
	const registry: IRegistrySnapshot = {
		tables: [
			createTableRegistryEntry({ uuid: PLAYER, index: 1, schema: LogicalNamespace.Items, name: 'player', columns: [col(NAME, 0, 'name', TableColumnKind.Text)] }, undefined, now),
			createTableRegistryEntry({ uuid: ENEMY, index: 0, schema: LogicalNamespace.Items, name: 'enemy', label: 'Enemy', columns: [col(HP, 1, 'hp', TableColumnKind.Int), col(NAME, 0, 'name', TableColumnKind.Text)] }, undefined, now),
		],
		enums: [createEnumRegistryEntry({ uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire' }] }, undefined, now)],
		relations: [],
		functions: [createFunctionRegistryEntry({ uuid: FN, index: 0, name: 'damage', label: 'Damage', executor: 'math.damage', input: [], constructor: [], parameters: [], output: { kind: 'int' } }, undefined, now)],
		renderers: [createRendererRegistryEntry({ uuid: SPRITE, index: 0, name: 'sprite', label: 'Sprite', executor: 'renderer.sprite' }, undefined, now)],
		rendererBindings: [],
	};
	const binding = createFunctionBindingEntry({
		uuid: BINDING, index: 0, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
		target: { address: { table_uuid: ENEMY, row_uuid: ROW, column_uuid: HP }, merge: { kind: 'overlay' } },
	}, undefined, now);
	return {
		registry: ready ? registry : undefined,
		functionBindings: ready ? [binding] : [],
		assets: ready ? [createAsset({ uuid: IMG, index: 0, name: 'hero', kind: AssetKind.Image, source: 'assets/image/hero.png' }), createAsset({ index: 1, name: 'bgm', kind: AssetKind.Audio, source: 'assets/audio/bgm.ogg' })] : [],
		programs: ready ? [{ path: 'player.cs', resource: URI.file('/p/functions/player.cs') }, { path: 'ai/enemy.cs', resource: URI.file('/p/functions/ai/enemy.cs') }] : [],
		rootName: 'game',
	};
}

function flatten(nodes: readonly ISideBarNode[]): ISideBarNode[] {
	return nodes.flatMap(entry => [entry, ...flatten(entry.children)]);
}

suite('Primitive App Editor - workbench views', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Activity Bar, Editor Tabs and Bottom Panel match the specification structure', () => {
		assert.deepStrictEqual([...activityBarItems], ['explorer', 'registry', 'data', 'assets', 'functions', 'renderer', 'debug', 'build']);
		assert.deepStrictEqual([...editorTabKinds], ['code_editor', 'registry_editor', 'data_editor', 'function_graph', 'renderer_editor', 'asset_editor', 'debug_viewer']);
		assert.deepStrictEqual([...bottomPanelViews], ['console', 'build_log', 'runtime_state', 'event_log', 'function_output', 'diagnostics']);
		const ids = activityBarItems.flatMap(item => [activityBarContainerId(item), activityBarViewId(item)]);
		assert.strictEqual(new Set(ids).size, ids.length, 'container / view ids are unique and locale independent');
	});

	test('every Editor Area Target maps to one Editor Tab and Code Editor / Debug Viewer stay separate tabs', () => {
		assert.strictEqual(editorTabKindOf(DataEditorTarget.DataGrid), EditorTabKind.DataEditor);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.PhysicalTable), EditorTabKind.DataEditor);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.RelationGraph), EditorTabKind.RegistryEditor);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.RegistryEditor), EditorTabKind.RegistryEditor);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.FunctionGraph), EditorTabKind.FunctionGraph);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.RendererEditor), EditorTabKind.RendererEditor);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.AssetEditor), EditorTabKind.AssetEditor);
		assert.strictEqual(editorTabKindOf(DataEditorTarget.DebugViewer), EditorTabKind.DebugViewer);
		assert.notStrictEqual(EditorTabKind.CodeEditor, EditorTabKind.DebugViewer);
		assert.ok(![DataEditorTarget.DataGrid, DataEditorTarget.PhysicalTable, DataEditorTarget.RelationGraph, DataEditorTarget.RegistryEditor, DataEditorTarget.FunctionGraph, DataEditorTarget.RendererEditor, DataEditorTarget.AssetEditor, DataEditorTarget.DebugViewer].some(target => editorTabKindOf(target) === EditorTabKind.CodeEditor), 'the Code Editor is the Workbench text editor of a file');
	});

	test('without a Ready Project every Side Bar tree is empty', () => {
		for (const item of activityBarItems) {
			assert.deepStrictEqual(createSideBarTree(item, context(false)), []);
		}
	});

	test('Explorer lists the Working Directory Programs which open the Code Editor on the file', () => {
		const tree = createSideBarTree(ActivityBarItem.Explorer, context());
		assert.strictEqual(tree[0].label, 'game');
		const files = flatten(tree).filter(entry => entry.open?.kind === 'file');
		assert.deepStrictEqual(files.map(entry => [entry.label, entry.open]), [['enemy.cs', { kind: 'file', path: 'functions/ai/enemy.cs' }], ['player.cs', { kind: 'file', path: 'functions/player.cs' }]]);
		assert.ok(files.every(entry => entry.selection === undefined && entry.uuid === undefined), 'a file is not a Registry Item');
	});

	test('Registry lists Table / Column / Relation / Enum / Function / Renderer in Registry order with Item Identity', () => {
		const tree = createSideBarTree(ActivityBarItem.Registry, context());
		assert.deepStrictEqual(tree.map(entry => entry.label), ['Table', 'Column', 'Relation', 'Enum', 'Function', 'Renderer']);
		assert.deepStrictEqual(tree[0].children.map(entry => [entry.label, entry.uuid]), [['Enemy', ENEMY], ['player', PLAYER]]);
		const enemyColumns = tree[1].children[0].children;
		assert.deepStrictEqual(enemyColumns.map(entry => [entry.label, entry.description]), [['name', 'text'], ['hp', 'int']]);
		assert.ok(enemyColumns.every(entry => entry.selection?.uuid === ENEMY), 'a column selects its table (the Resolver has no column kind)');
		assert.ok(tree[0].children.every(entry => entry.open?.kind === 'tab' && entry.open.target === DataEditorTarget.RegistryEditor));
		assert.ok(flatten(tree).every(entry => !entry.label.match(/^[0-9a-f]{8}-/)), 'no label is a UUID');
	});

	test('Data lists Physical Table and Raw Data which open the Data Editor', () => {
		const tree = createSideBarTree(ActivityBarItem.Data, context());
		assert.deepStrictEqual(tree.map(entry => entry.label), ['Physical Table', 'Raw Data']);
		assert.deepStrictEqual(tree[1].children.map(entry => entry.uuid), [ENEMY, PLAYER]);
		assert.ok(tree[1].children.every(entry => entry.open?.kind === 'tab' && editorTabKindOf(entry.open.target) === EditorTabKind.DataEditor));
	});

	test('Assets shows the Asset Tree and opens the Asset Editor', () => {
		const tree = createSideBarTree(ActivityBarItem.Assets, context());
		const assets = tree[0].children;
		assert.deepStrictEqual(assets.map(entry => entry.label), ['assets']);
		assert.deepStrictEqual(assets[0].children.map(entry => entry.label), ['audio', 'image']);
		const leaves = flatten(assets).filter(entry => entry.uuid);
		assert.deepStrictEqual(leaves.map(entry => [entry.label, entry.description]), [['bgm', 'audio'], ['hero', 'image']]);
		assert.strictEqual(leaves[1].uuid, IMG);
		assert.ok(leaves.every(entry => entry.open?.kind === 'tab' && entry.open.target === DataEditorTarget.AssetEditor));
	});

	test('Functions open the single Function Graph for Function Registry, Function Binding and Dependency Graph', () => {
		const tree = createSideBarTree(ActivityBarItem.Functions, context());
		assert.deepStrictEqual(tree.map(entry => entry.label), ['Function Registry', 'Function Binding', 'Dependency Graph']);
		assert.deepStrictEqual(tree[1].children.map(entry => [entry.label, entry.uuid]), [['Damage', BINDING]]);
		for (const entry of [...tree[0].children, ...tree[1].children, tree[2]]) {
			assert.deepStrictEqual(entry.open, { kind: 'tab', target: DataEditorTarget.FunctionGraph, uuid: functionGraphTabUuid });
		}
		assert.strictEqual(tree[2].selection, undefined);
	});

	test('Renderer, Debug and Build placements', () => {
		const renderer = createSideBarTree(ActivityBarItem.Renderer, context());
		assert.deepStrictEqual(renderer[0].children.map(entry => [entry.label, entry.open]), [['Sprite', { kind: 'tab', target: DataEditorTarget.RendererEditor, uuid: SPRITE }]]);
		assert.deepStrictEqual(createSideBarTree(ActivityBarItem.Debug, context())[0].open, { kind: 'tab', target: DataEditorTarget.DebugViewer, uuid: debugViewerTabUuid });
		assert.deepStrictEqual(createSideBarTree(ActivityBarItem.Build, context())[0].open, { kind: 'panel', view: BottomPanelView.BuildLog });
	});

	test('Tree / List Select writes the Shared Selection Context and opens (or reuses) the Editor Area tab once', () => {
		const model = new WorkbenchViewsModel();
		const seen: (string | undefined)[] = [];
		const dispose = model.selection.onDidChange(selection => seen.push(selection?.uuid));
		const enemy = createSideBarTree(ActivityBarItem.Data, context())[1].children[0];

		const first = model.activate(enemy);
		const second = model.activate(enemy);
		assert.deepStrictEqual(seen, [ENEMY, ENEMY]);
		assert.deepStrictEqual(model.selection.selection, { uuid: ENEMY });
		assert.ok(first.kind === 'tab' && second.kind === 'tab');
		assert.strictEqual(first.reused, false);
		assert.strictEqual(second.reused, true);
		assert.strictEqual(first.tab, second.tab);
		assert.strictEqual(first.tabKind, EditorTabKind.DataEditor);
		assert.strictEqual(model.tabs.openTabs.length, 1);

		// Function Registry and Function Binding share the one Function Graph tab; the Debug Viewer is its own tab.
		const functions = createSideBarTree(ActivityBarItem.Functions, context());
		model.activate(functions[0].children[0]);
		model.activate(functions[1].children[0]);
		model.activate(createSideBarTree(ActivityBarItem.Debug, context())[0]);
		assert.deepStrictEqual(model.tabs.openTabs.map(tab => editorTabKindOf(tab.target)), [EditorTabKind.DataEditor, EditorTabKind.FunctionGraph, EditorTabKind.DebugViewer]);
		assert.deepStrictEqual(model.selection.selection, { uuid: BINDING });
		dispose();
	});

	test('a group node or a file node leaves the Selection unchanged and a selection-only entry opens nothing', () => {
		const model = new WorkbenchViewsModel();
		model.selection.select({ uuid: ENEMY });
		const registry = createSideBarTree(ActivityBarItem.Registry, context());
		assert.deepStrictEqual(model.activate(registry[0]), { kind: 'none' });
		const file = flatten(createSideBarTree(ActivityBarItem.Explorer, context())).find(entry => entry.open?.kind === 'file')!;
		assert.deepStrictEqual(model.activate(file), { kind: 'file', path: 'functions/ai/enemy.cs' });
		assert.deepStrictEqual(model.activate(createSideBarTree(ActivityBarItem.Build, context())[0]), { kind: 'panel', view: BottomPanelView.BuildLog });
		assert.deepStrictEqual(model.selection.selection, { uuid: ENEMY });
		assert.strictEqual(model.tabs.openTabs.length, 0);
	});

	test('Bottom Panel is transient, bounded, per-view read-only output', () => {
		const output = new BottomPanelOutput();
		const changed: BottomPanelView[] = [];
		const dispose = output.onDidChange(view => changed.push(view));
		output.append(BottomPanelView.Console, 'hello');
		output.append(BottomPanelView.Diagnostics, 'bad', BottomPanelSeverity.Error);
		assert.deepStrictEqual(output.get(BottomPanelView.Console).map(entry => [entry.text, entry.severity]), [['hello', 'info']]);
		assert.deepStrictEqual(output.get(BottomPanelView.BuildLog), []);
		assert.ok(Object.isFrozen(output.get(BottomPanelView.Console)[0]));

		for (let index = 0; index < BottomPanelOutput.maxEntries + 5; index++) {
			output.append(BottomPanelView.EventLog, `e${index}`);
		}
		const events = output.get(BottomPanelView.EventLog);
		assert.strictEqual(events.length, BottomPanelOutput.maxEntries);
		assert.strictEqual(events[0].text, 'e5');

		output.clear(BottomPanelView.Console);
		assert.deepStrictEqual(output.get(BottomPanelView.Console), []);
		assert.strictEqual(output.get(BottomPanelView.Diagnostics).length, 1);
		output.clear();
		assert.ok(bottomPanelViews.every(view => output.get(view).length === 0));
		assert.ok(changed.includes(BottomPanelView.Console));
		dispose();
	});
});
