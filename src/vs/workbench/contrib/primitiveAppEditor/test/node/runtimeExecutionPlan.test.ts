/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - runtime execution plan (runtime.execution-plan)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (22. Function Runtime / Load)
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
import { FunctionBindingService, IFunctionBindingEntryInput, readFunctionBindings } from '../../common/functionBinding.js';
import { buildFunctionExecutionPlan, FunctionDependencyService, readFunctionDependencies } from '../../common/functionDependency.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { buildRuntimeExecutionPlan, loadRuntimeExecutionPlan } from '../../common/runtimeExecutionPlan.js';
import { createRuntimeState } from '../../common/runtimeState.js';
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

suite('Primitive App Editor - validated execution plan on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-execution-plan-'));
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

	test('Load builds a resolved plan: dependency first, index for independent nodes, instances in memory', async () => {
		const { storage, bindings, dependencies } = await open();
		await bindings.insert(binding(A, 5, { x: { source: 'state', address } }, { constructor: { subtract_b: true } }));
		await bindings.insert(binding(D, 9, fromOutput(A)));
		await bindings.insert(binding(E1, 1));
		await dependencies.insert({ source_binding: { uuid: A }, target_binding: { uuid: D }, target_input: { name: 'x' } });

		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, catalog);
		assert.deepStrictEqual(plan.map(step => step.binding.uuid), [E1, A, D]);
		assert.deepStrictEqual(plan.map(step => step.depends_on), [[], [], [A]]);
		assert.strictEqual(plan[1].definition.uuid, FN);

		// Constructor Bind: binding value overrides the Registry default; unbound parameters use defaults
		const instance = plan[1].instance;
		assert.deepStrictEqual(instance.constructor_values, { subtract_b: true });
		assert.deepStrictEqual(instance.parameter_defaults, { a: 1, b: 0 });
		assert.strictEqual(plan[0].instance.constructor_values.subtract_b, false);
		// Function Instance -> Memory, runs through the Function Dispatcher
		assert.strictEqual(state.functions.get(A)!.instance, instance);
		assert.strictEqual(instance.invoke({ x: 2, a: 3, b: 1 }), 5);
		assert.strictEqual(plan[0].instance.invoke({ x: 2, a: 3, b: 1 }), 7);
		// Runtime Address Resolve: handles are bound to memory
		assert.strictEqual(plan[1].handles.inputs.x.get(), 2);
		plan[1].handles.target.set(8);
		assert.strictEqual(state.entities.get(ROW)!.properties.get(FATIGUE), 8);
	});

	test('a cycle, a missing executor and a missing runtime object reject Load / Build without touching state', async () => {
		const { storage, bindings } = await open();
		await bindings.insert(binding(A, 0));
		await bindings.insert(binding(D, 1));
		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, catalog);
		const loaded = await storage.database.transaction(async statements => ({
			functions: [plan[0].definition],
			bindings: await readFunctionBindings(statements),
			dependencies: await readFunctionDependencies(statements),
			tables: await readTableRegistry(statements),
		}));
		const sources = { ...loaded, catalog };

		const [a, d] = loaded.bindings;
		const cyclic = [{ ...a, inputs: fromOutput(d.uuid) }, { ...d, inputs: fromOutput(a.uuid) }] as never;
		const edges = [
			{ uuid: E1, source_binding: { uuid: d.uuid }, target_binding: { uuid: a.uuid }, target_input: { name: 'x' }, created_at: now().toISOString() },
			{ uuid: E2, source_binding: { uuid: a.uuid }, target_binding: { uuid: d.uuid }, target_input: { name: 'x' }, created_at: now().toISOString() },
		];
		assert.throws(() => buildFunctionExecutionPlan(cyclic, edges), /cycle/);
		const fresh = createRuntimeState();
		assert.throws(() => buildRuntimeExecutionPlan(fresh, { ...sources, bindings: cyclic, dependencies: edges }), /cycle/);
		assert.strictEqual(fresh.functions.size, 0);

		assert.throws(() => buildRuntimeExecutionPlan(state, { ...sources, catalog: createFunctionExecutorCatalog(['other']) }), /executor 'Linear' does not exist in Code/);
		// Runtime Object Resolve: no loaded entity for the address -> reject, no instance is registered
		const empty = createRuntimeState();
		assert.throws(() => buildRuntimeExecutionPlan(empty, sources), /Missing Runtime Object/);
		assert.strictEqual(empty.functions.size, 0);
	});

	test('a binding to an unregistered function rejects Load', async () => {
		const { storage, bindings } = await open();
		await bindings.insert(binding(A, 0));
		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, catalog);
		const sources = { functions: [], bindings: [plan[0].binding], dependencies: [], tables: await storage.database.transaction(readTableRegistry), catalog };
		assert.throws(() => buildRuntimeExecutionPlan(state, sources), /Missing Definition/);
	});
});
