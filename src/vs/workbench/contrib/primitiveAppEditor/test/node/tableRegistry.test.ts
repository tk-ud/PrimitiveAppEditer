/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - table_registry contract (registry.table)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (8. table_registry, 8. kind, 8. Semantic Type)
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
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { createTableRegistryEntry, getTableRegistryInsert, ITableRegistryEntry, readTableRegistry, TableColumnKind, TableRegistryError, tableRegistryPhysicalTable } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const ENUM = '00000000-0000-4000-8000-0000000000e1';

suite('Primitive App Editor - table_registry on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-table-registry-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Opens the project through the lifecycle; `Registry Load` reads table_registry. */
	async function open(): Promise<{ storage: ProjectSqliteStorage; loaded: readonly ITableRegistryEntry[] | undefined }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		let loaded: readonly ITableRegistryEntry[] | undefined;
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: async () => { loaded = await readTableRegistry(storage.database); },
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		return { storage, loaded };
	}

	test('entries written to registry.table_registry are loaded in Registry order with the same identity on the next Open', async () => {
		const first = await open();
		assert.deepStrictEqual(first.loaded, []);
		const enemy = createTableRegistryEntry({
			index: 1, schema: LogicalNamespace.Items, name: 'enemy', columns: [
				{ index: 0, name: 'element', label: 'Element', kind: TableColumnKind.Enum, enum: ENUM, not_null: true, writable: true, searchable: true },
			],
		});
		const player = createTableRegistryEntry({
			index: 0, schema: LogicalNamespace.Items, name: 'player', label: 'Player', columns: [
				{ index: 0, name: 'hp', kind: TableColumnKind.Int, not_null: true, writable: true, searchable: false },
				{ index: 1, name: 'meta', kind: TableColumnKind.Json, not_null: false, writable: false, searchable: false },
			],
		});
		const battle = createTableRegistryEntry({ index: 0, schema: LogicalNamespace.Logs, name: 'battle', columns: [] });
		await first.storage.database.transaction(async tx => {
			for (const entry of [enemy, player]) {
				const insert = getTableRegistryInsert(entry);
				await tx.run(insert.sql, insert.params);
			}
		});
		const insert = getTableRegistryInsert(battle);
		await first.storage.database.run(insert.sql, insert.params);
		await first.storage.close();

		const second = await open();
		const byUuid = (a: ITableRegistryEntry, b: ITableRegistryEntry) => a.uuid < b.uuid ? -1 : 1;
		assert.deepStrictEqual(second.loaded, [player, battle].sort(byUuid).concat([enemy]));
	});

	test('the storage table rejects an invalid schema / columns value and a duplicate uuid', async () => {
		const { storage } = await open();
		const entry = createTableRegistryEntry({ index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [] });
		const insert = getTableRegistryInsert(entry);
		await storage.database.run(insert.sql, insert.params);
		await assert.rejects(storage.database.run(insert.sql, insert.params), /UNIQUE|PRIMARY KEY/);
		const other = createTableRegistryEntry({ index: 1, schema: LogicalNamespace.Items, name: 'enemy', columns: [] });
		const params = [...getTableRegistryInsert(other).params];
		await assert.rejects(storage.database.run(insert.sql, params.map((value, i) => i === 2 ? 'raw' : value)), /CHECK/);
		await assert.rejects(storage.database.run(insert.sql, params.map((value, i) => i === 5 ? '{}' : value)), /CHECK/);
		await assert.rejects(storage.database.run(insert.sql, params.map((value, i) => i === 5 ? '[' : value)), /CHECK|malformed JSON/);

		// A stored row violating the contract (enum kind without an enum_registry reference) fails Registry Load.
		await storage.database.run(`UPDATE "${tableRegistryPhysicalTable}" SET "columns" = ? WHERE "uuid" = ?`, [
			JSON.stringify([{ uuid: ENUM, index: 0, name: 'element', label: '', kind: 'enum', not_null: true, writable: true, searchable: false, enum: null }]),
			entry.uuid,
		]);
		await assert.rejects(readTableRegistry(storage.database), (error: Error) => error instanceof TableRegistryError && /requires an enum_registry\.uuid/.test(error.message));
	});
});
