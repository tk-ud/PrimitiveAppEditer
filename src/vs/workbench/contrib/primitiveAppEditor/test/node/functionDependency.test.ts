/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_dependency (binding.dependency)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (20. Function Dependency)
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
import { FunctionDependencyError, FunctionDependencyService, loadFunctionExecutionPlan, readFunctionDependencies } from '../../common/functionDependency.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RegistryService } from '../../common/registryService.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000d1';
const B = '00000000-0000-4000-8000-0000000000d2';
const D = '00000000-0000-4000-8000-0000000000d3';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');
const address = { table_uuid: PLAYER, row_uuid: ROW, column_uuid: FATIGUE };
const out = (uuid: string) => ({ source: 'function_output', function_binding_uuid: uuid });

function binding(uuid: string, index: number, inputs: Record<string, unknown> = { x: { source: 'time' } }): IFunctionBindingEntryInput {
	return {
		uuid, index, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
		inputs: inputs as never, target: { address, merge: { kind: 'overwrite' } },
	};
}
const dep = (uuid: string, source: string, target: string, name = 'x') => ({ uuid, source_binding: { uuid: source }, target_binding: { uuid: target }, target_input: { name } });

suite('Primitive App Editor - function_dependency on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-function-dependency-'));
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
		await bindings.insert(binding(A, 5));
		await bindings.insert(binding(B, 0, { x: out(A) }));
		await bindings.insert(binding(D, 1));
		return { storage, bindings, service: new FunctionDependencyService(storage.database, { now }) };
	}

	test('insert / select / delete an Edge; Load builds the Execution Plan from DB definitions', async () => {
		const { storage, service } = await open();
		const inserted = await service.insert(dep(E1, A, B));
		assert.strictEqual(inserted.uuid, E1);
		assert.deepStrictEqual(await service.select({ where: { target_binding_uuid: B } }), [inserted.dependency]);
		assert.deepStrictEqual(await service.select({ where: { source_binding_uuid: B } }), []);
		assert.deepStrictEqual(await readFunctionDependencies(storage.database), [inserted.dependency]);
		assert.deepStrictEqual((await loadFunctionExecutionPlan(storage.database)).map(step => step.binding.uuid), [D, A, B]);

		const deleted = await service.delete(E1);
		assert.strictEqual(deleted.uuid, E1);
		await assert.rejects(service.delete(E1), /does not exist/);
		assert.deepStrictEqual(await service.select(), []);
		// Bindings are untouched, but B's function_output input now lacks its Edge: Load / Build reject.
		await assert.rejects(loadFunctionExecutionPlan(storage.database), /without a function_dependency/);
	});

	test('insert rejects mismatching, duplicate and cyclic Edges before anything is written', async () => {
		const { storage, bindings, service } = await open();
		await assert.rejects(service.insert(dep(E1, D, B)), /is not 'function_output' of binding/);
		await assert.rejects(service.insert(dep(E1, A, '00000000-0000-4000-8000-0000000000ff')), /no target binding/);
		await service.insert(dep(E1, A, B));
		await assert.rejects(service.insert(dep(E1, A, B, 'y')), /already exists/);
		await assert.rejects(service.insert(dep(E2, A, B)), /already has a dependency/);

		await bindings.update(A, { inputs: { x: out(B) } });
		await assert.rejects(service.insert(dep(E2, B, A)), /cycle detected/);
		assert.deepStrictEqual((await service.select()).map(entry => entry.uuid), [E1]);
		await assert.rejects(loadFunctionExecutionPlan(storage.database), /without a function_dependency/);
		await assert.rejects(service.select({ where: { name: 'x' } as never }), FunctionDependencyError);
	});

	test('Edges persist across a reopened database handle', async () => {
		const { storage, service } = await open();
		await service.insert(dep(E1, A, B));
		const row = await storage.database.get(`SELECT * FROM binding__function_dependency`);
		assert.deepStrictEqual(row, { uuid: E1, source_binding_uuid: A, target_binding_uuid: B, target_input_name: 'x', created_at: '2026-10-15T00:00:00.000Z' });
	});
});
