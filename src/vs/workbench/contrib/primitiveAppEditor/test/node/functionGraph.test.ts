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
import { DynamicResolver } from '../../common/dynamicResolve.js';
import { EditorDdlMigrator } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { readEnumRegistry, EnumRegistryIndex } from '../../common/enumRegistry.js';
import { FunctionBindingService, readFunctionBindings } from '../../common/functionBinding.js';
import { FunctionDependencyService, loadFunctionExecutionPlan, readFunctionDependencies } from '../../common/functionDependency.js';
import { FunctionGraphModel, openFunctionGraphTab } from '../../common/functionGraph.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert, readFunctionRegistry } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { readRelationRegistry } from '../../common/relationRegistry.js';
import { RendererBindingService } from '../../common/rendererRegistry.js';
import { IResolverServices, Resolver } from '../../common/resolver.js';
import { readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000d1';
const B = '00000000-0000-4000-8000-0000000000d2';
const D = '00000000-0000-4000-8000-0000000000d3';
const E1 = '00000000-0000-4000-8000-0000000000e1';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');
const address = { table_uuid: PLAYER, row_uuid: ROW, column_uuid: FATIGUE };
const out = (uuid: string) => ({ source: 'function_output', function_binding_uuid: uuid });

suite('Primitive App Editor - Function Graph on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-function-graph-'));
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
				columns: [{ uuid: FATIGUE, index: 0, name: 'fatigue', label: 'Fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true }],
			},
		});
		const fn = createFunctionRegistryEntry({
			uuid: FN, index: 0, name: 'identity', label: 'Identity', executor: 'math.identity',
			input: [{ name: 'x', kind: 'double' }], constructor: [], parameters: [{ name: 'a', kind: 'double' }], output: { kind: 'double' },
		}, undefined, now);
		const insert = getFunctionRegistryInsert(fn, catalog);
		await storage.database.run(insert.sql, insert.params);
		const bind = (uuid: string, index: number, inputs: Record<string, unknown>) => resolver.insert({
			target: { kind: 'function_binding', uuid },
			payload: { index, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' }, inputs, parameters: { a: { source: 'constant', value: 1 } }, target: { address, merge: { kind: 'overwrite' } } },
		});
		await bind(A, 5, { x: { source: 'time' } });
		await bind(B, 0, { x: out(A) });
		await bind(D, 1, { x: { source: 'time' } });
		const graph = new FunctionGraphModel(resolver, async () => ({ functions: await readFunctionRegistry(storage.database, catalog), tables: await readTableRegistry(storage.database) }));
		return { storage, resolver, graph };
	}

	test('Graph projects Registry / Binding / Dependency, authors Edges through the Resolver and shares the Inspector selection', async () => {
		const { storage, resolver, graph } = await open();

		// Read Graph = SELECT; Nodes show Function name / label and Binding State, never UUIDs
		const loaded = await graph.load();
		assert.deepStrictEqual(loaded.nodes.map(node => node.uuid), [B, D, A]);
		const nodeB = loaded.nodes[0];
		assert.strictEqual(nodeB.label, 'Identity');
		assert.deepStrictEqual(nodeB.state, { execution: 'tick', target: 'Player / Fatigue', merge: 'overwrite' });
		assert.deepStrictEqual(nodeB.output, { kind: 'double' });
		assert.deepStrictEqual(nodeB.inputs, [{ name: 'x', kind: 'double', source: 'function_output', producer: A }]);
		assert.deepStrictEqual(nodeB.parameters, [{ name: 'a', kind: 'double', source: 'constant' }]);
		assert.deepStrictEqual(loaded.edges, []);
		assert.deepStrictEqual(loaded.pendingEdges, [{ source: A, target: B, input: 'x' }]);
		assert.deepStrictEqual(loaded.diagnostics, []);
		// Unsaved Dependency = editing state: not executable in the Graph, and Load / Build rejects the same input
		assert.strictEqual(loaded.executable, false);
		assert.strictEqual(loaded.order, undefined);
		await assert.rejects(loadFunctionExecutionPlan(storage.database), /input 'x' is 'function_output' without a function_dependency/);

		// Edge Add = INSERT function_dependency; graph reloaded from the DB
		const edge = await graph.addEdge(A, B, 'x', E1);
		assert.strictEqual(edge, E1);
		assert.deepStrictEqual((await readFunctionDependencies(storage.database)).map(entry => entry.uuid), [E1]);
		assert.deepStrictEqual(graph.graph.edges.map(candidate => [candidate.source, candidate.target, candidate.input, candidate.label]), [[A, B, 'x', 'Identity → Identity.x']]);
		assert.deepStrictEqual(graph.graph.pendingEdges, []);
		// Saved Dependency = executable state: Graph and Load / Build agree
		assert.strictEqual(graph.graph.executable, true);
		assert.deepStrictEqual(graph.graph.order, [D, A, B]);
		assert.deepStrictEqual((await loadFunctionExecutionPlan(storage.database)).map(step => step.binding.uuid), graph.graph.order);

		// Edges the binding does not declare are rejected; nothing is written and no UI state is kept
		await assert.rejects(graph.addEdge(A, D, 'x'), /not declared as function_output/);
		await assert.rejects(graph.addEdge(A, B, 'x'), /already has an Edge/);
		await assert.rejects(graph.addEdge(A, B, 'y'), /has no input 'y'/);
		await assert.rejects(graph.addEdge(A, A, 'x'), /cannot depend on itself/);
		await assert.rejects(graph.addEdge(A, '00000000-0000-4000-8000-0000000000ff', 'x'), /Nodes of the loaded/);
		assert.strictEqual((await readFunctionDependencies(storage.database)).length, 1);

		// Node / Edge selection writes the Shared Selection Context; the single Inspector resolves it
		const selection = new DataEditorSelection();
		graph.selectNode(B, selection);
		assert.deepStrictEqual(selection.selection, { uuid: B });
		graph.selectEdge(E1, selection);
		assert.strictEqual(graph.selectedEdgeUuid, E1);
		assert.deepStrictEqual(selection.selection, { uuid: B });
		assert.throws(() => graph.selectNode('00000000-0000-4000-8000-0000000000ff', selection), /not a Node/);
		const inspector = await new DynamicResolver().resolve(selection.selection, {
			tables: await readTableRegistry(storage.database), enums: new EnumRegistryIndex(await readEnumRegistry(storage.database)), enumEntries: await readEnumRegistry(storage.database),
			relations: await readRelationRegistry(storage.database), functions: await readFunctionRegistry(storage.database, catalog), renderers: [], assets: [],
			functionBindings: await readFunctionBindings(storage.database), rendererBindings: [],
		}, resolver);
		assert.ok(!(inspector as { empty?: boolean }).empty);
		assert.strictEqual((inspector as { uuid: string }).uuid, B);

		// Editor Area tab is reused
		const tabs = new DataEditorTabs();
		assert.strictEqual(openFunctionGraphTab(tabs).reused, false);
		assert.strictEqual(openFunctionGraphTab(tabs).reused, true);
		assert.strictEqual(tabs.openTabs.length, 1);
		assert.strictEqual(tabs.openTabs[0].target, DataEditorTarget.FunctionGraph);

		// Edge Delete = DELETE function_dependency; bindings are untouched, the pending Edge reappears
		await graph.removeEdge(E1);
		assert.deepStrictEqual(await readFunctionDependencies(storage.database), []);
		assert.strictEqual(graph.selectedEdgeUuid, undefined);
		assert.strictEqual((await readFunctionBindings(storage.database)).length, 3);
		assert.deepStrictEqual(graph.graph.pendingEdges, [{ source: A, target: B, input: 'x' }]);
		assert.strictEqual(graph.graph.executable, false);
		await assert.rejects(loadFunctionExecutionPlan(storage.database), /without a function_dependency/);
		await assert.rejects(graph.removeEdge(E1), /not in the loaded/);
	});

	test('Graph reports a cycle from the same Validate as Load / Build', async () => {
		const { resolver, graph } = await open();
		await resolver.update({ target: { kind: 'function_binding', uuid: A }, payload: { inputs: { x: out(B) } } });
		await graph.load();
		await graph.addEdge(A, B, 'x');
		await assert.rejects(graph.addEdge(B, A, 'x'), /cycle detected/);
		assert.deepStrictEqual(graph.graph.diagnostics, []);
	});
});
