/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - runtime execution loop (runtime.loop)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (22. Execute, 22. Loop)
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
import { EditorDdlMigrator } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { FunctionBindingService, IFunctionBindingEntryInput } from '../../common/functionBinding.js';
import { FunctionDependencyService } from '../../common/functionDependency.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { loadRuntimeExecutionPlan } from '../../common/runtimeExecutionPlan.js';
import { RuntimeLoop } from '../../common/runtimeLoop.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000d1';
const D = '00000000-0000-4000-8000-0000000000d3';

const catalog = createFunctionPrimitiveExecutorCatalog();
const now = () => new Date('2026-10-15T00:00:00Z');
const address = { table_uuid: PLAYER, row_uuid: ROW, column_uuid: FATIGUE };


function binding(uuid: string, index: number, inputs: Record<string, unknown> = { x: { source: 'state', address } }, extra: Record<string, unknown> = {}): IFunctionBindingEntryInput {
	return {
		uuid, index, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
		inputs: inputs as never, target: { address, merge: { kind: 'overwrite' } }, ...extra,
	};
}
const fromOutput = (uuid: string) => ({ x: { source: 'function_output', function_binding_uuid: uuid } });

suite('Primitive App Editor - runtime execution loop on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-runtime-loop-'));
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
			columns: [{ uuid: FATIGUE, index: 0, name: 'fatigue', label: 'Fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true }],
		});
		const fn = createFunctionRegistryEntry({ uuid: FN, ...toFunctionRegistryEntryInput(linearDefinition, 0) }, undefined, now);
		const insert = getFunctionRegistryInsert(fn, catalog);
		await storage.database.run(insert.sql, insert.params);
		const raw = new RawDataService(storage.database);
		await raw.insert(PLAYER, { uuid: ROW, fatigue: 2 });
		return {
			storage,
			bindings: new FunctionBindingService(storage.database, catalog, { now }),
			dependencies: new FunctionDependencyService(storage.database, { now }),
		};
	}

	const constants = (a: number, b: number) => ({ a: { source: 'constant', value: a }, b: { source: 'constant', value: b } });

	test('a frame resolves inputs, runs the plan in order, merges per Binding policy and commits the Next State in memory only', async () => {
		const { storage, bindings, dependencies } = await open();
		await bindings.insert(binding(A, 5, { x: { source: 'state', address } }, { constructor: { subtract_b: true }, parameters: constants(3, 1) }));
		await bindings.insert({ ...binding(D, 9, fromOutput(A)), target: { address, merge: { kind: 'overlay' } } });
		await dependencies.insert({ source_binding: { uuid: A }, target_binding: { uuid: D }, target_input: { name: 'x' } });

		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, catalog);
		const loop = new RuntimeLoop(state, plan);
		const fatigue = () => state.entities.get(ROW)!.properties.get(FATIGUE);

		// A reads the Current State (2): 3*2-1 = 5 overwrites; D = 5 overlays additively: 5 + 5
		const first = loop.step({ time: 1, progress: 0.5, input: { move: 1 }, events: ['hit'] });
		assert.deepStrictEqual(first.executed, [A, D]);
		assert.strictEqual(fatigue(), 10);
		assert.strictEqual(state.functions.get(A)!.output, 5);
		assert.strictEqual(state.functions.get(D)!.output, 5);
		assert.strictEqual(state.time, 1);
		assert.strictEqual(state.progress, 0.5);
		assert.deepStrictEqual(state.input, { move: 1 });
		assert.deepStrictEqual(state.events, ['hit']);

		// Next frame starts from the Next State: 3*10-1 = 29, then 29 + 29
		loop.step({ time: 2, progress: 1 });
		assert.strictEqual(fatigue(), 58);
		assert.deepStrictEqual(state.events, []);

		// Function Output != SQLite Write: Frame State is not Persistent Data
		const rows = await new RawDataService(storage.database).select(PLAYER);
		assert.strictEqual(rows.find(row => row.uuid === ROW)!.values[FATIGUE], 2);
	});

	test('time / progress / input sources and execution.kind triggers', async () => {
		const { storage, bindings } = await open();
		await bindings.insert(binding(A, 0, { x: { source: 'time' } }));
		await bindings.insert({ ...binding(D, 1, { x: { source: 'input' } }), execution: { kind: 'input' } });
		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, catalog);
		const loop = new RuntimeLoop(state, plan);
		const fatigue = () => state.entities.get(ROW)!.properties.get(FATIGUE);

		assert.deepStrictEqual(loop.step({ time: 4, progress: 0 }).executed, [A]);
		assert.strictEqual(fatigue(), 4);
		assert.deepStrictEqual(loop.step({ time: 5, progress: 0, input: { x: 7 } }).executed, [A, D]);
		assert.strictEqual(fatigue(), 7);
	});

	test('a rejected frame leaves the Runtime State unchanged', async () => {
		const { storage, bindings } = await open();
		await bindings.insert(binding(A, 0, { x: { source: 'time' } }));
		await bindings.insert(binding(D, 1, { x: { source: 'input' } }));
		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, catalog);
		const loop = new RuntimeLoop(state, plan);

		assert.throws(() => loop.step({ time: 9, progress: 1 }), /frame input has no value 'x'/);
		assert.throws(() => loop.step({ time: Number.NaN, progress: 1 }), /finite numbers/);
		assert.strictEqual(state.entities.get(ROW)!.properties.get(FATIGUE), 2);
		assert.strictEqual(state.time, 0);
		assert.strictEqual(state.functions.get(A)!.output, undefined);
	});
});
