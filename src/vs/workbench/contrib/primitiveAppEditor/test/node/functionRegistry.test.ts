/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_registry (function.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (14. function_registry, 15. Function Definition Contract, 3. Open)
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
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, FunctionRegistryError, functionRegistryPhysicalTable, getFunctionRegistryInsert, IFunctionRegistryEntry, readFunctionRegistry } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const catalog = createFunctionExecutorCatalog(['math.damage', 'core.noop']);
const now = () => new Date('2026-10-15T00:00:00Z');

suite('Primitive App Editor - function_registry on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-function-registry-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Opens the project through the lifecycle; `Function Scan` reads function_registry against the executors in Code. */
	async function open(executors = catalog): Promise<{ storage: ProjectSqliteStorage; loaded: readonly IFunctionRegistryEntry[] | undefined }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		let loaded: readonly IFunctionRegistryEntry[] | undefined;
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: done,
			functionScan: async () => { loaded = await readFunctionRegistry(storage.database, executors); },
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		return { storage, loaded };
	}

	test('definitions written to registry.function_registry are loaded in Registry order with the same identity on the next Open', async () => {
		const first = await open();
		assert.deepStrictEqual(first.loaded, []);
		const noop = createFunctionRegistryEntry({ index: 1, name: 'noop', executor: 'core.noop', constructor: [], output: { kind: 'text' } }, undefined, now);
		const damage = createFunctionRegistryEntry({
			index: 0, name: 'damage', label: 'Damage', executor: 'math.damage',
			input: [{ name: 'attack', kind: 'int' }],
			constructor: [{ name: 'seed', kind: 'int', default: 0 }],
			parameters: [{ name: 'rate', kind: 'double', default: 1.5 }],
			output: { kind: 'int' },
		}, undefined, now);
		await first.storage.database.transaction(async tx => {
			for (const entry of [noop, damage]) {
				const insert = getFunctionRegistryInsert(entry);
				await tx.run(insert.sql, insert.params);
			}
		});
		await first.storage.close();

		const second = await open();
		assert.deepStrictEqual(second.loaded, [damage, noop]);
	});

	test('the storage table rejects invalid JSON shapes and a duplicate uuid; Function Scan rejects an executor missing in Code', async () => {
		const { storage } = await open();
		const entry = createFunctionRegistryEntry({ index: 0, name: 'damage', executor: 'math.damage', constructor: [], output: { kind: 'int' } }, undefined, now);
		const insert = getFunctionRegistryInsert(entry);
		await storage.database.run(insert.sql, insert.params);
		await assert.rejects(storage.database.run(insert.sql, insert.params), /UNIQUE|PRIMARY KEY/);
		const other = getFunctionRegistryInsert(createFunctionRegistryEntry({ index: 1, name: 'other', executor: 'core.noop', constructor: [], output: { kind: 'int' } }, undefined, now));
		const params = [...other.params];
		await assert.rejects(storage.database.run(insert.sql, params.map((value, i) => i === 5 ? '{}' : value)), /CHECK/);
		await assert.rejects(storage.database.run(insert.sql, params.map((value, i) => i === 8 ? '[]' : value)), /CHECK/);
		await assert.rejects(storage.database.run(insert.sql, params.map((value, i) => i === 7 ? '[' : value)), /CHECK|malformed JSON/);

		// Registry -> Codeに存在しないexecutorを許可しない.
		await storage.database.run(`UPDATE "${functionRegistryPhysicalTable}" SET "executor" = ? WHERE "uuid" = ?`, ['math.removed', entry.uuid]);
		await assert.rejects(readFunctionRegistry(storage.database, catalog), (error: Error) => error instanceof FunctionRegistryError && /executor 'math\.removed' does not exist in Code/.test(error.message));
		await storage.close();
		await assert.rejects(open(), /executor 'math\.removed' does not exist in Code/);
	});
});
