/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Debug Viewer (editor.debug-viewer)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Debug Viewer)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AssetKind, createAsset } from '../../common/assetRegistry.js';
import { EditorDdlMigrator } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { FunctionBindingService } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { createRendererRegistryEntry, getRendererRegistryInsert, RendererBindingService } from '../../common/rendererRegistry.js';
import { createRendererExecutorCatalog, IRendererImplementation, loadRendererRuntime, RendererRuntimeError } from '../../common/rendererRuntime.js';
import { loadRuntimeExecutionPlan } from '../../common/runtimeExecutionPlan.js';
import { RuntimeLoop } from '../../common/runtimeLoop.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';
import { DebugViewer, debugViewerTabUuid, openDebugViewerTab, projectRuntimeState } from '../../common/debugViewer.js';
import { DataEditorSelection, DataEditorTabs, DataEditorTarget } from '../../common/dataEditor.js';
import { IDynamicResolveContext } from '../../common/dynamicResolve.js';
import { isInspectorEmpty, IInspectorViewContent, RegistryDrivenInspector } from '../../common/inspector.js';
import { EnumRegistryIndex, readEnumRegistry } from '../../common/enumRegistry.js';
import { readFunctionBindings } from '../../common/functionBinding.js';
import { readFunctionRegistry } from '../../common/functionRegistry.js';
import { FunctionDependencyService } from '../../common/functionDependency.js';
import { readRelationRegistry } from '../../common/relationRegistry.js';
import { readRendererBindings, readRendererRegistry } from '../../common/rendererRegistry.js';
import { IResolverServices, Resolver } from '../../common/resolver.js';
import { readTableRegistry } from '../../common/tableRegistry.js';


const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const X = '00000000-0000-4000-8000-0000000000c1';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const FB = '00000000-0000-4000-8000-0000000000f2';
const SPRITE = '00000000-0000-4000-8000-0000000000e1';
const RB = '00000000-0000-4000-8000-0000000000e2';
const ASSET = '00000000-0000-4000-8000-0000000000a5';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const now = () => new Date('2026-10-15T00:00:00Z');
const address = { table_uuid: PLAYER, row_uuid: ROW, column_uuid: X };
const functionCatalog = createFunctionPrimitiveExecutorCatalog();
const asset = createAsset({ uuid: ASSET, index: 0, name: 'hero', kind: AssetKind.Image, source: 'assets/image/hero.png' });

const spriteRenderer: IRendererImplementation = {
	executor: 'renderer.sprite',
	project: inputs => ({
		x: (inputs.position_x as { value: unknown }).value,
		image: (inputs.image as { asset: { source: string } }).asset.source,
	}),
};

suite('Primitive App Editor - Debug Viewer on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-debug-viewer-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	async function open() {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: done,
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		await new RegistryService(storage.database).create({
			uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', label: 'Player',
			columns: [{ uuid: X, index: 0, name: 'x', label: 'X', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true }],
		});
		const fn = createFunctionRegistryEntry({ uuid: FN, ...toFunctionRegistryEntryInput(linearDefinition, 0) }, undefined, now);
		const insert = getFunctionRegistryInsert(fn, functionCatalog);
		await storage.database.run(insert.sql, insert.params);
		await new RawDataService(storage.database).insert(PLAYER, { uuid: ROW, x: 1 });
		await new FunctionBindingService(storage.database, functionCatalog, { now }).insert({
			uuid: FB, index: 0, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
			inputs: { x: { source: 'state', address } } as never,
			parameters: { a: { source: 'constant', value: 1 }, b: { source: 'constant', value: 1 } } as never,
			target: { address, merge: { kind: 'overwrite' } },
		});
		const renderer = createRendererRegistryEntry({
			uuid: SPRITE, index: 0, name: 'sprite', executor: 'renderer.sprite',
			inputs: [{ name: 'position_x', kind: 'double' }, { name: 'image', kind: 'asset' }],
		}, undefined, now);
		const rendererInsert = getRendererRegistryInsert(renderer);
		await storage.database.run(rendererInsert.sql, rendererInsert.params);
		const bindings = new RendererBindingService(storage.database, { now });
		await bindings.insert({ uuid: RB, renderer: { uuid: SPRITE }, bindings: { position_x: { address }, image: { asset_uuid: ASSET } } });
		return { storage, bindings };
	}

	test('Debug Viewer inspects Runtime Memory, selects Entities into the Inspector, manipulates and previews without touching SQLite', async () => {
		const { storage } = await open();
		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, functionCatalog);
		const loop = new RuntimeLoop(state, plan);
		const rendering = await loadRendererRuntime(storage.database, state, [asset], createRendererExecutorCatalog([spriteRenderer]));
		const tables = await readTableRegistry(storage.database);
		const enumEntries = await readEnumRegistry(storage.database);
		const enums = new EnumRegistryIndex(enumEntries);
		const selection = new DataEditorSelection();
		const tabs = new DataEditorTabs();
		const resolver = new Resolver({
			database: storage.database,
			registry: new RegistryService(storage.database),
			rawData: new RawDataService(storage.database),
			functionBinding: new FunctionBindingService(storage.database, functionCatalog, { now }),
			functionDependency: new FunctionDependencyService(storage.database, { now }),
			rendererBinding: new RendererBindingService(storage.database, { now }),
		} as IResolverServices);
		const loadContext = async (): Promise<IDynamicResolveContext> => ({
			tables: await readTableRegistry(storage.database), enums, enumEntries,
			relations: await readRelationRegistry(storage.database), functions: await readFunctionRegistry(storage.database, functionCatalog),
			renderers: await readRendererRegistry(storage.database), assets: [asset],
			functionBindings: await readFunctionBindings(storage.database), rendererBindings: await readRendererBindings(storage.database),
		});
		const inspector = new RegistryDrivenInspector(resolver, loadContext, selection, tabs);
		const viewer = new DebugViewer({ state, tables, enums, loop, rendering }, selection);

		// Editor Area Surface: one reused tab
		const first = openDebugViewerTab(tabs);
		assert.deepStrictEqual([first.tab.target, first.tab.uuid, first.reused, openDebugViewerTab(tabs).reused], [DataEditorTarget.DebugViewer, debugViewerTabUuid, false, true]);

		// Application Canvas + Runtime State Projection (labels for display, UUIDs as identity)
		assert.deepStrictEqual(viewer.canvas().items.map(i => [i.binding_uuid, i.output, i.entities]), [[RB, { x: 1, image: 'assets/image/hero.png' }, [ROW]]]);
		const view = viewer.runtimeState();
		assert.deepStrictEqual([view.entities[0].row_uuid, view.entities[0].label, view.entities[0].table, view.entities[0].properties.map(p => [p.label, p.value])], [ROW, 'Player', 'Player', [['X', 1]]]);
		assert.deepStrictEqual(projectRuntimeState(state, tables), view);

		// Entity Selection updates the Shared Selection Context and the same Inspector resolves it
		assert.throws(() => viewer.selectEntity(MISSING), /Missing Runtime Object/);
		assert.ok(isInspectorEmpty(inspector.view));
		viewer.selectEntity(ROW);
		assert.deepStrictEqual(selection.selection, { uuid: ROW, table_uuid: PLAYER });
		const row = await inspector.refresh();
		assert.ok(!isInspectorEmpty(row));
		assert.strictEqual((row as IInspectorViewContent).header.label, 'Player #1');
		viewer.clearSelection();
		viewer.selectCanvasItem(RB);
		assert.strictEqual(selection.selection!.uuid, ROW);
		assert.throws(() => viewer.selectCanvasItem(MISSING), /no renderer binding/);

		// Direct Manipulation: Memory Handle write with validation; SQLite untouched
		viewer.manipulate(address, 10);
		assert.strictEqual(viewer.canvas().items[0].output && (viewer.canvas().items[0].output as { x: number }).x, 10);
		assert.throws(() => viewer.manipulate(address, 'abc'), /not a valid double/i);
		assert.throws(() => viewer.manipulate({ ...address, row_uuid: MISSING }, 1), /Missing Runtime Object/);
		assert.throws(() => viewer.manipulate({ ...address, column_uuid: MISSING }, 1), /Missing Definition/);

		// Preview steps the Runtime Loop (linear a*x+b, a=b=1) and the Canvas follows the Next State
		viewer.preview({ time: 1, progress: 0 });
		assert.strictEqual((viewer.canvas().items[0].output as { x: number }).x, 11);
		assert.strictEqual(viewer.runtimeState().time, 1);
		assert.throws(() => new DebugViewer({ state, tables, enums }, selection).preview({ time: 2, progress: 0 }), /no Runtime Loop/);
		const rows = await new RawDataService(storage.database).select(PLAYER);
		assert.strictEqual(rows.find(r => r.uuid === ROW)!.values[X], 1, 'Frame State is not Persistent Data');

		// Camera
		const viewport = { width: 200, height: 100 };
		assert.deepStrictEqual(viewer.camera.worldToScreen({ x: 0, y: 0 }, viewport), { x: 100, y: 50 });
		viewer.camera.zoomBy(2);
		viewer.camera.pan(20, 0);
		assert.deepStrictEqual(viewer.camera.state, { x: 10, y: 0, zoom: 2 });
		const screen = viewer.camera.worldToScreen({ x: 15, y: 5 }, viewport);
		assert.deepStrictEqual(viewer.camera.screenToWorld(screen, viewport), { x: 15, y: 5 });
		assert.throws(() => viewer.camera.zoomBy(0), /positive/);
		assert.throws(() => viewer.camera.pan(NaN, 0), /finite/);
		assert.deepStrictEqual(viewer.camera.reset(), { x: 0, y: 0, zoom: 1 });
		inspector.dispose();
	});
});
