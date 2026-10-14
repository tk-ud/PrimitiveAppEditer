/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - enum_registry (registry.enum)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (11. enum_registry, 11. Physical, 11. Usage)
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
import {
	createEnumRegistryEntry,
	EnumRegistryError,
	EnumRegistryIndex,
	enumRegistryPhysicalTable,
	getEnumRegistryDelete,
	getEnumRegistryInsert,
	getEnumRegistryUpdate,
	getEnumSelectOptions,
	IEnumRegistryEntry,
	isEnumColumnValue,
	readEnumRegistry,
	validateTableEnumReferences,
} from '../../common/enumRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RegistryService, RegistryServiceError } from '../../common/registryService.js';
import { ITableRegistryEntry, ITableRegistryEntryInput, readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const ELEMENT = '00000000-0000-4000-8000-0000000000e1';
const RANK = '00000000-0000-4000-8000-0000000000e2';
const MISSING = '00000000-0000-4000-8000-0000000000e9';
const ENEMY = '00000000-0000-4000-8000-0000000000a1';

function enemy(enumUuid: string): ITableRegistryEntryInput {
	return {
		uuid: ENEMY, index: 0, schema: LogicalNamespace.Items, name: 'enemy', columns: [
			{ index: 0, name: 'element', kind: TableColumnKind.Enum, enum: enumUuid, not_null: true, writable: true, searchable: true },
		],
	};
}

suite('Primitive App Editor - enum_registry on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-enum-registry-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Opens the project through the lifecycle; `Registry Load` reads enum_registry and table_registry and validates the enum metadata. */
	async function open(): Promise<{ storage: ProjectSqliteStorage; enums: readonly IEnumRegistryEntry[]; tables: readonly ITableRegistryEntry[] }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		let enums: readonly IEnumRegistryEntry[] = [];
		let tables: readonly ITableRegistryEntry[] = [];
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: async () => {
				enums = await readEnumRegistry(storage.database);
				tables = await readTableRegistry(storage.database);
				validateTableEnumReferences(tables, enums);
			},
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		return { storage, enums, tables };
	}

	test('entries written to registry.enum_registry are loaded in Registry order with the same identity on the next Open', async () => {
		const first = await open();
		assert.deepStrictEqual(first.enums, []);
		const rank = createEnumRegistryEntry({ uuid: RANK, index: 1, name: 'rank', values: [{ value: 's' }, { value: 'a' }] });
		const element = createEnumRegistryEntry({ uuid: ELEMENT, index: 0, name: 'element', label: 'Element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'Water' }], group_tags: ['battle'] });
		for (const entry of [rank, element]) {
			const insert = getEnumRegistryInsert(entry);
			await first.storage.database.run(insert.sql, insert.params);
		}
		const relabeled = createEnumRegistryEntry({ ...rank, label: 'Rank', values: [...rank.values, { value: 'b' }] });
		const update = getEnumRegistryUpdate(relabeled);
		await first.storage.database.run(update.sql, update.params);
		await first.storage.close();

		const second = await open();
		assert.deepStrictEqual(second.enums, [element, relabeled]);
		assert.deepStrictEqual(getEnumSelectOptions(second.enums[1]).map(option => option.value), ['s', 'a', 'b']);

		const remove = getEnumRegistryDelete(RANK);
		await second.storage.database.run(remove.sql, remove.params);
		assert.deepStrictEqual(await readEnumRegistry(second.storage.database), [element]);
	});

	test('storage constraints and stored contract violations are rejected', async () => {
		const { storage } = await open();
		const entry = createEnumRegistryEntry({ uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire' }] });
		const insert = getEnumRegistryInsert(entry);
		await storage.database.run(insert.sql, insert.params);
		await assert.rejects(storage.database.run(insert.sql, insert.params), /UNIQUE|PRIMARY KEY/);
		await assert.rejects(storage.database.run(`INSERT INTO "${enumRegistryPhysicalTable}" ("uuid", "index", "name", "label", "values", "group_tags", "created_at") VALUES (?, 0, 'x', '', '{}', '[]', '2026-10-14T00:00:00.000Z')`, [RANK]), /CHECK/);
		await assert.rejects(storage.database.run(`INSERT INTO "${enumRegistryPhysicalTable}" ("uuid", "index", "name", "label", "values", "group_tags", "created_at") VALUES (?, 0, 'x', '', '[]', 'tag', '2026-10-14T00:00:00.000Z')`, [RANK]), /CHECK/);

		await storage.database.run(`INSERT INTO "${enumRegistryPhysicalTable}" ("uuid", "index", "name", "label", "values", "group_tags", "created_at") VALUES (?, 0, 'dup', '', '[{"value":"a","label":""},{"value":"a","label":""}]', '[]', '2026-10-14T00:00:00.000Z')`, [RANK]);
		await assert.rejects(readEnumRegistry(storage.database), (error: Error) => error instanceof EnumRegistryError && /duplicate value 'a'/.test(error.message));
	});

	test('Registry Service: a kind enum column must reference an existing enum_registry entry; its Raw Data is plain text without a physical FK', async () => {
		const { storage } = await open();
		const service = new RegistryService(storage.database);

		// Missing enum_registry entry: Registry Validate rejects, nothing is written.
		await assert.rejects(service.create(enemy(MISSING)), (error: Error) => error instanceof RegistryServiceError && /references missing enum_registry entry/.test(error.message));
		assert.deepStrictEqual(await readTableRegistry(storage.database), []);
		assert.strictEqual(await storage.database.get(`SELECT "name" FROM sqlite_master WHERE "name" = 'items__enemy'`), undefined);

		const element = createEnumRegistryEntry({ uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'Water' }] });
		const insert = getEnumRegistryInsert(element);
		await storage.database.run(insert.sql, insert.params);
		const created = await service.create(enemy(ELEMENT));
		const column = created.entry!.columns[0];

		const info = await storage.database.all(`SELECT "type" FROM pragma_table_info('items__enemy') WHERE "name" = 'element'`);
		assert.deepStrictEqual(info, [{ type: 'TEXT' }]);
		assert.deepStrictEqual(await storage.database.all(`SELECT * FROM pragma_foreign_key_list('items__enemy')`), []);

		// Input Validation before Raw Data write; the stored value is the enum text.
		const index = new EnumRegistryIndex(await readEnumRegistry(storage.database));
		assert.deepStrictEqual(['fire', 'earth'].map(value => isEnumColumnValue(index, column, value)), [true, false]);
		await storage.database.run(`INSERT INTO "items__enemy" ("uuid", "element") VALUES (?, ?)`, ['00000000-0000-4000-8000-0000000000b1', 'fire']);
		assert.deepStrictEqual(await storage.database.all(`SELECT "element" FROM "items__enemy"`), [{ element: 'fire' }]);

		// ALTER to a missing enum is rejected and rolled back.
		await assert.rejects(service.alter(enemy(MISSING) as ITableRegistryEntryInput & { uuid: string }), /references missing enum_registry entry/);
		assert.strictEqual((await readTableRegistry(storage.database))[0].columns[0].enum, ELEMENT);
		await storage.close();

		// Registry Load on the next Open validates the metadata.
		const reopened = await open();
		assert.deepStrictEqual(reopened.tables.map(table => table.columns[0].enum), [ELEMENT]);
	});
});
