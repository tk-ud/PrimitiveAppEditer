/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - runtime state (runtime.state)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (23. Load / Runtime, 24. Runtime State)
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
import { loadFunctionExecutionPlan } from '../../common/functionDependency.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { createRuntimeState, loadRuntimeState, resolveBindingHandles, resolvePlanHandles, resolveRuntimeHandle, RuntimeStateError } from '../../common/runtimeState.js';
import { readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000d1';
const D = '00000000-0000-4000-8000-0000000000d3';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');
const address = { table_uuid: PLAYER, row_uuid: ROW, column_uuid: FATIGUE };

function binding(uuid: string, index: number, inputs: Record<string, unknown> = { x: { source: 'time' } }): IFunctionBindingEntryInput {
	return {
		uuid, index, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
		inputs: inputs as never, target: { address, merge: { kind: 'overwrite' } },
	};
}
const stateInput = { x: { source: 'state', address } };
const stateBinding = (uuid: string, index: number) => binding(uuid, index, stateInput);

suite('Primitive App Editor - load and handle resolution on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-runtime-state-'));
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
		const fn = createFunctionRegistryEntry({
			uuid: FN, index: 0, name: 'identity', executor: 'math.identity',
			input: [{ name: 'x', kind: 'double' }], constructor: [], parameters: [], output: { kind: 'double' },
		}, undefined, now);
		const insert = getFunctionRegistryInsert(fn, catalog);
		await storage.database.run(insert.sql, insert.params);
		const bindings = new FunctionBindingService(storage.database, catalog, { now });
		await bindings.insert(stateBinding(A, 5));
		await bindings.insert(binding(D, 1));
		return { storage, bindings, raw: new RawDataService(storage.database) };
	}

	test('Load copies Raw Data into entities; handles read and write memory only', async () => {
		const { storage, raw } = await open();
		await raw.insert(PLAYER, { uuid: ROW, fatigue: 0.5 });
		const plan = await loadFunctionExecutionPlan(storage.database);
		const state = await loadRuntimeState(storage.database, plan);
		assert.deepStrictEqual([...state.entities.keys()], [ROW]);
		assert.strictEqual(state.entities.get(ROW)!.table_uuid, PLAYER);
		assert.deepStrictEqual([...state.functions.keys()].sort(), [A, D]);
		assert.deepStrictEqual(state.functions.get(A), { instance: undefined, output: undefined });

		const tables = await readTableRegistry(storage.database);
		const handle = resolveRuntimeHandle(state, tables, address);
		assert.strictEqual(handle.get(), 0.5);
		handle.set(0.9);
		assert.strictEqual(state.entities.get(ROW)!.properties.get(FATIGUE), 0.9);
		// Runtime Function Output != SQLite Write; Frame State != Persistent Data
		state.functions.get(A)!.output = 1;
		assert.strictEqual((await raw.select(PLAYER))[0].values[FATIGUE], 0.5);
	});

	test('Runtime Loop does not query SQLite: handles keep working after the database is closed', async () => {
		const { storage, raw } = await open();
		await raw.insert(PLAYER, { uuid: ROW, fatigue: 1 });
		const plan = await loadFunctionExecutionPlan(storage.database);
		const state = await loadRuntimeState(storage.database, plan);
		const tables = await readTableRegistry(storage.database);
		const handles = resolvePlanHandles(state, tables, plan);
		await storage.close();
		const a = handles.get(A)!;
		assert.strictEqual(a.inputs.x.get(), 1);
		a.target.set(a.inputs.x.get() as number + 1);
		assert.strictEqual(a.target.get(), 2);
		assert.deepStrictEqual(Object.keys(a.inputs), ['x']);
		assert.deepStrictEqual(Object.keys(handles.get(D)!.inputs), []);
	});

	test('Registry Resolve and Runtime Object Resolve reject unknown tables, columns, rows and table mismatches', async () => {
		const { storage, raw } = await open();
		await raw.insert(PLAYER, { uuid: ROW, fatigue: 0 });
		const state = await loadRuntimeState(storage.database);
		const tables = await readTableRegistry(storage.database);
		assert.throws(() => resolveRuntimeHandle(state, tables, { ...address, table_uuid: E1 }), /no table/);
		assert.throws(() => resolveRuntimeHandle(state, tables, { ...address, column_uuid: E1 }), /no column/);
		assert.throws(() => resolveRuntimeHandle(state, tables, { ...address, row_uuid: E1 }), /no entity/);
		assert.throws(() => resolveRuntimeHandle(createRuntimeState(), tables, address), /Missing Runtime Object/);
		assert.throws(() => resolveRuntimeHandle(state, tables, { ...address, row_uuid: 'x' }), RuntimeStateError);
		const [{ binding: dangling }] = await loadFunctionExecutionPlan(storage.database);
		assert.throws(() => resolveBindingHandles(state, tables, { ...dangling, target: { ...dangling.target, address: { ...address, row_uuid: E2 } } }), /binding .* target: no entity|no entity/);
	});
});
