/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function Graph authoring on project.sqlite (editor.function-graph)
 *  Specification SSOT: docs/primitive-app-editor/Function Graph.md
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
import { DataEditorSelection, DataEditorTabs, DataEditorTarget } from '../../common/dataEditor.js';
import { IDynamicResolveContext } from '../../common/dynamicResolve.js';
import { isInspectorEmpty, IInspectorViewContent, InspectorCommand, RegistryDrivenInspector } from '../../common/inspector.js';
import { EditorDdlMigrator } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { readEnumRegistry, EnumRegistryIndex } from '../../common/enumRegistry.js';
import { FunctionBindingService, readFunctionBindings } from '../../common/functionBinding.js';
import { FunctionDependencyService } from '../../common/functionDependency.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert, readFunctionRegistry } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { readRelationRegistry } from '../../common/relationRegistry.js';
import { createRendererRegistryEntry, getRendererRegistryInsert, readRendererBindings, readRendererRegistry, RendererBindingService } from '../../common/rendererRegistry.js';
import { IResolverServices, Resolver } from '../../common/resolver.js';
import { readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const NAME = '00000000-0000-4000-8000-0000000000c0';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const LOCKED = '00000000-0000-4000-8000-0000000000c2';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const REND = '00000000-0000-4000-8000-0000000000e2';
const BIND = '00000000-0000-4000-8000-0000000000d1';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');

suite('Primitive App Editor - Registry Driven Inspector on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-inspector-'));
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
		const services: IResolverServices = {
			database: storage.database,
			registry: new RegistryService(storage.database),
			rawData: new RawDataService(storage.database),
			functionBinding: new FunctionBindingService(storage.database, catalog, { now }),
			functionDependency: new FunctionDependencyService(storage.database, { now }),
			rendererBinding: new RendererBindingService(storage.database, { now }),
		};
		const resolver = new Resolver(services);
		await resolver.create({
			target: { kind: 'table' }, payload: {
				uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', label: 'Player',
				columns: [
					{ uuid: NAME, index: 0, name: 'name', kind: TableColumnKind.Text, not_null: false, writable: true, searchable: true },
					{ uuid: FATIGUE, index: 1, name: 'fatigue', label: 'Fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true },
					{ uuid: LOCKED, index: 2, name: 'locked', kind: TableColumnKind.Bool, not_null: false, writable: false, searchable: false },
				],
			},
		});
		await resolver.insert({ target: { kind: 'raw', uuid: PLAYER }, address: { row_uuid: ROW }, payload: { name: 'Alice', fatigue: 1.5 } });
		const fn = createFunctionRegistryEntry({
			uuid: FN, index: 0, name: 'identity', label: 'Identity', executor: 'math.identity',
			input: [{ name: 'x', kind: 'double' }], constructor: [], parameters: [{ name: 'a', kind: 'double', default: 1 }], output: { kind: 'double' },
		}, undefined, now);
		const insert = getFunctionRegistryInsert(fn, catalog);
		await storage.database.run(insert.sql, insert.params);
		const renderer = createRendererRegistryEntry({ uuid: REND, index: 0, name: 'sprite', label: 'Sprite', executor: 'canvas.sprite', inputs: [{ name: 'x', kind: 'double' }, { name: 'image', kind: 'asset' }] }, undefined, now);
		const rinsert = getRendererRegistryInsert(renderer);
		await storage.database.run(rinsert.sql, rinsert.params);
		const loadContext = async (): Promise<IDynamicResolveContext> => {
			const enumEntries = await readEnumRegistry(storage.database);
			return {
				tables: await readTableRegistry(storage.database), enums: new EnumRegistryIndex(enumEntries), enumEntries,
				relations: await readRelationRegistry(storage.database), functions: await readFunctionRegistry(storage.database, catalog),
				renderers: await readRendererRegistry(storage.database), assets: [],
				functionBindings: await readFunctionBindings(storage.database), rendererBindings: await readRendererBindings(storage.database),
			};
		};
		const selection = new DataEditorSelection();
		const tabs = new DataEditorTabs();
		const inspector = new RegistryDrivenInspector(resolver, loadContext, selection, tabs);
		return { storage, resolver, inspector, selection, tabs, loadContext };
	}

	const content = (view: unknown) => {
		assert.ok(!isInspectorEmpty(view as never));
		return view as IInspectorViewContent;
	};

	test('Inspector resolves the Selection, edits properties, authors Bindings through the Resolver and opens Editor Area tabs', async () => {
		const { storage, inspector, selection, tabs } = await open();

		// Empty Selection: neutral, no Mutation Target
		assert.ok(isInspectorEmpty(inspector.view));
		await assert.rejects(inspector.saveProperty(FATIGUE, 2), /no Selection/);
		await assert.rejects(inspector.deleteBinding(BIND), /no Selection/);
		await assert.rejects(inspector.open(), /no Selection/);

		// Row Selection -> Properties (Registry-driven Components), Header by label, Save is an Icon Button with a Tooltip
		selection.select({ uuid: ROW, table_uuid: PLAYER });
		const row = content(await inspector.refresh());
		assert.strictEqual(row.header.label, 'Alice');
		assert.deepStrictEqual(row.properties!.components.map(c => [c.control.label, c.control.value, c.save?.command, c.save?.icon, c.save?.tooltip]), [
			['name', 'Alice', InspectorCommand.Save, 'save', 'Save name'],
			['Fatigue', 1.5, InspectorCommand.Save, 'save', 'Save Fatigue'],
			['locked', null, undefined, undefined, undefined],
		]);
		assert.deepStrictEqual(row.binding!.candidates.functions, [{ uuid: FN, label: 'Identity' }]);
		assert.deepStrictEqual(row.binding!.candidates.columns.map(c => [c.label, c.writable]), [['name', true], ['Fatigue', true], ['locked', false]]);
		assert.strictEqual(row.binding!.add.tooltip, 'Add Binding');
		assert.strictEqual(row.navigation!.open[0].target, DataEditorTarget.DataGrid);
		assert.ok(!JSON.stringify(row.header).includes(ROW), 'UUID is not a Primary UI value');

		// Properties Save = update; invalid / read-only / unknown are rejected and Raw Data is unchanged
		await inspector.saveProperty(FATIGUE, 2.5);
		assert.strictEqual(content(inspector.view).properties!.components[1].control.value, 2.5);
		await assert.rejects(inspector.saveProperty(FATIGUE, 'abc'), /Fatigue/);
		await assert.rejects(inspector.saveProperty(LOCKED, true), /not writable/);
		await assert.rejects(inspector.saveProperty('00000000-0000-4000-8000-0000000000ff', 1), /no property component/);
		assert.strictEqual(content(await inspector.refresh()).properties!.components[1].control.value, 2.5);

		// Binding Section: INSERT function_binding; selection never implies ownership
		await assert.rejects(inspector.insertFunctionBinding({}), /select the Function/);
		await assert.rejects(inspector.insertFunctionBinding({ functionUuid: FN }), /write target is not defined/);
		await assert.rejects(inspector.insertFunctionBinding({ functionUuid: FN, columnUuid: '00000000-0000-4000-8000-0000000000ff' }), /not a column/);
		assert.strictEqual((await readFunctionBindings(storage.database)).length, 0);
		const bindingUuid = await inspector.insertFunctionBinding({ functionUuid: FN, columnUuid: FATIGUE, execution: 'event', inputs: { x: { source: 'time' } } });
		const stored = (await readFunctionBindings(storage.database))[0];
		assert.strictEqual(stored.uuid, bindingUuid);
		assert.deepStrictEqual([stored.execution.kind, stored.target, stored.parameters], ['event', { address: { table_uuid: PLAYER, row_uuid: ROW, column_uuid: FATIGUE }, merge: { kind: 'overwrite' } }, { a: { source: 'constant', value: 1 } }]);
		const withBinding = content(inspector.view);
		assert.deepStrictEqual(withBinding.binding!.entries.map(e => [e.binding.label, e.remove.command, e.remove.destructive, e.remove.tooltip]), [['Identity → Player > Fatigue', InspectorCommand.Delete, true, 'Remove Identity → Player > Fatigue']]);

		// Renderer binding: column -> Persistent Address of the Selected Row; asset only by explicit uuid
		await assert.rejects(inspector.insertRendererBinding({ bindings: {} }), /select the Renderer/);
		const rendererBindingUuid = await inspector.insertRendererBinding({ rendererUuid: REND, bindings: { x: { column_uuid: FATIGUE } } });
		assert.deepStrictEqual((await readRendererBindings(storage.database))[0].bindings, { x: { address: { table_uuid: PLAYER, row_uuid: ROW, column_uuid: FATIGUE } } });
		assert.strictEqual(content(inspector.view).binding!.entries.length, 2);

		// Selecting the Function Binding: compact Source / Execution component = UPDATE function_binding
		selection.select({ uuid: bindingUuid });
		const fb = content(await inspector.refresh());
		assert.strictEqual(fb.header.label, 'Identity → Player > Fatigue');
		assert.deepStrictEqual(fb.header.actions.map(a => [a.command, a.destructive]), [[InspectorCommand.Delete, true]]);
		assert.deepStrictEqual([fb.properties!.functionBinding!.execution.kind, fb.properties!.functionBinding!.target, fb.properties!.functionBinding!.inputs.map(i => [i.name, i.source])], ['event', 'Player > Fatigue', [['x', 'time']]]);
		assert.strictEqual(fb.navigation!.open[0].target, DataEditorTarget.FunctionGraph);
		await assert.rejects(inspector.saveFunctionBinding({ execution: 'every_frame' }), /execution.kind/);
		await assert.rejects(inspector.saveFunctionBinding({ inputs: { x: 'nonsense' } }), /source must be/);
		await assert.rejects(inspector.saveFunctionBinding({ inputs: { y: 'time' } }), /no input 'y'/);
		await assert.rejects(inspector.saveFunctionBinding({}), /nothing to save/);
		await inspector.saveFunctionBinding({ execution: 'tick', merge: 'overlay', inputs: { x: 'input' } });
		const updated = (await readFunctionBindings(storage.database))[0];
		assert.deepStrictEqual([updated.execution.kind, updated.target.merge.kind, updated.inputs.x.source], ['tick', 'overlay', 'input']);
		await assert.rejects(inspector.saveProperty(FATIGUE, 1), /not a Raw Data Row/);

		// Open Action reuses the Editor Area tab; Graph Node selection shares the same Inspector (no second one)
		assert.strictEqual((await inspector.open()).reused, false);
		assert.strictEqual((await inspector.open()).reused, true);
		assert.strictEqual(tabs.openTabs.length, 1);
		assert.strictEqual(tabs.openTabs[0].target, DataEditorTarget.FunctionGraph);

		// Delete = DELETE; a Binding not in the Selection's Binding Section is not deleted; Registry / Raw Data untouched
		selection.select({ uuid: ROW, table_uuid: PLAYER });
		await inspector.refresh();
		await assert.rejects(inspector.deleteBinding('00000000-0000-4000-8000-0000000000ff'), /not in the Binding Section/);
		await inspector.deleteBinding(rendererBindingUuid);
		assert.deepStrictEqual(await readRendererBindings(storage.database), []);
		assert.strictEqual((await readFunctionBindings(storage.database)).length, 1);
		selection.select({ uuid: bindingUuid });
		await inspector.refresh();
		await inspector.deleteSelectedBinding();
		assert.deepStrictEqual(await readFunctionBindings(storage.database), []);
		assert.strictEqual(selection.selection, undefined);
		assert.ok(isInspectorEmpty(inspector.view));
		assert.strictEqual((await readFunctionRegistry(storage.database, catalog)).length, 1);

		// A stale Selection is rejected and the view returns to neutral
		selection.select({ uuid: bindingUuid });
		await assert.rejects(inspector.refresh(), /Missing Definition/);
		assert.ok(isInspectorEmpty(inspector.view));
		await assert.rejects(inspector.deleteSelectedBinding(), /Missing Definition/);
		inspector.dispose();
	});
});
