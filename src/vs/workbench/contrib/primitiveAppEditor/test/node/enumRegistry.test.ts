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
	getEnumRegistryInsert,
	getEnumSelectOptions,
	IEnumRegistryEntry,
	IEnumRegistryEntryInput,
	isEnumColumnValue,
	readEnumRegistry,
	validateTableEnumReferences,
} from '../../common/enumRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { IProjectSqliteStatements, LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RegistryMigrationRejectedError, RegistryService, RegistryServiceError } from '../../common/registryService.js';
import { ITableRegistryColumnInput, ITableRegistryEntry, ITableRegistryEntryInput, readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const ELEMENT = '00000000-0000-4000-8000-0000000000e1';
const RANK = '00000000-0000-4000-8000-0000000000e2';
const MISSING = '00000000-0000-4000-8000-0000000000e9';
const ENEMY = '00000000-0000-4000-8000-0000000000a1';
const ELEMENT_COLUMN = '00000000-0000-4000-8000-0000000000c1';
const ROW_A = '00000000-0000-4000-8000-0000000000b1';
const ROW_B = '00000000-0000-4000-8000-0000000000b2';

const elementEnum: IEnumRegistryEntryInput = { uuid: ELEMENT, index: 0, name: 'element', label: 'Element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'Water' }] };
const rankEnum: IEnumRegistryEntryInput = { uuid: RANK, index: 1, name: 'rank', values: [{ value: 's' }, { value: 'a' }] };

/** `enemy` with one `element` column; `text` until it is migrated to an enum. */
function enemyWith(column: Partial<ITableRegistryColumnInput>): ITableRegistryEntryInput & { uuid: string } {
	return {
		uuid: ENEMY, index: 0, schema: LogicalNamespace.Items, name: 'enemy', columns: [
			{ uuid: ELEMENT_COLUMN, index: 0, name: 'element', kind: TableColumnKind.Text, enum: null, not_null: false, writable: true, searchable: true, ...column },
		],
	};
}

async function enemyRows(statements: IProjectSqliteStatements) {
	return statements.all(`SELECT "uuid", "element", typeof("element") AS "type" FROM "items__enemy" ORDER BY "uuid"`);
}

async function elementColumnType(statements: IProjectSqliteStatements) {
	return (await statements.get(`SELECT "type" FROM pragma_table_info('items__enemy') WHERE "name" = 'element'`))?.type;
}

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

	test('enum_registry mutations through the Registry Service are loaded in Registry order with the same identity on the next Open', async () => {
		const first = await open();
		assert.deepStrictEqual(first.enums, []);
		const service = new RegistryService(first.storage.database);
		const rank = (await service.createEnum(rankEnum)).entry!;
		const element = (await service.createEnum({ ...elementEnum, group_tags: ['battle'] })).entry!;
		const relabeled = (await service.alterEnum({ ...rankEnum, uuid: RANK, label: 'Rank', values: [...rankEnum.values, { value: 'b' }] })).entry!;
		assert.strictEqual(relabeled.created_at, rank.created_at);
		await assert.rejects(service.createEnum({ ...rankEnum, name: 'again' }), (error: Error) => error instanceof RegistryServiceError && /duplicate enum uuid/.test(error.message));
		await assert.rejects(service.alterEnum({ ...rankEnum, uuid: MISSING }), /enum_registry has no entry/);
		await assert.rejects(service.dropEnum(MISSING), /enum_registry has no entry/);
		await first.storage.close();

		const second = await open();
		assert.deepStrictEqual(second.enums, [element, relabeled]);
		assert.deepStrictEqual(getEnumSelectOptions(second.enums[1]).map(option => option.value), ['s', 'a', 'b']);

		// An enum no table_registry column references is deleted.
		const dropped = await new RegistryService(second.storage.database).dropEnum(RANK);
		assert.deepStrictEqual([dropped.entry, dropped.before], [undefined, relabeled]);
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

		await service.createEnum(elementEnum);
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

	test('KIND CHANGE text -> enum rejects stored values that are not enum values and rolls back Registry and Physical Schema', async () => {
		const { storage } = await open();
		const service = new RegistryService(storage.database);
		await service.createEnum(elementEnum);
		await service.create(enemyWith({}));
		await storage.database.run(`INSERT INTO "items__enemy" ("uuid", "element") VALUES (?, 'fire'), (?, 'earth')`, [ROW_A, ROW_B]);
		const registryBefore = await readTableRegistry(storage.database);

		await assert.rejects(service.alter(enemyWith({ kind: TableColumnKind.Enum, enum: ELEMENT })),
			(error: Error) => error instanceof RegistryMigrationRejectedError && /row '00000000-0000-4000-8000-0000000000b2' column 'element': "earth" \(text\) is not a value of kind 'enum'/.test(error.message));
		assert.deepStrictEqual(await readTableRegistry(storage.database), registryBefore);
		assert.deepStrictEqual(await enemyRows(storage.database), [{ uuid: ROW_A, element: 'fire', type: 'text' }, { uuid: ROW_B, element: 'earth', type: 'text' }]);
		assert.strictEqual(await storage.database.get(`SELECT "name" FROM sqlite_master WHERE "name" LIKE '%pae_migration%'`), undefined);

		// After the data is fixed the same migration succeeds; NULL stays valid for a nullable column.
		await storage.database.run(`UPDATE "items__enemy" SET "element" = NULL WHERE "uuid" = ?`, [ROW_B]);
		const migrated = await service.alter(enemyWith({ kind: TableColumnKind.Enum, enum: ELEMENT }));
		assert.deepStrictEqual(migrated.entry!.columns.map(column => [column.kind, column.enum]), [[TableColumnKind.Enum, ELEMENT]]);
		assert.strictEqual(await elementColumnType(storage.database), 'TEXT');
		assert.deepStrictEqual(await enemyRows(storage.database), [{ uuid: ROW_A, element: 'fire', type: 'text' }, { uuid: ROW_B, element: null, type: 'null' }]);
	});

	test('changing columns[].enum to another enum_registry entry rejects stored values that are not values of the NEW entry', async () => {
		const { storage } = await open();
		const service = new RegistryService(storage.database);
		await service.createEnum(elementEnum);
		await service.createEnum(rankEnum);
		await service.createEnum({ uuid: MISSING, index: 2, name: 'element2', values: [{ value: 'fire' }, { value: 'earth' }] });
		await service.create(enemyWith({ kind: TableColumnKind.Enum, enum: ELEMENT }));
		await storage.database.run(`INSERT INTO "items__enemy" ("uuid", "element") VALUES (?, 'fire')`, [ROW_A]);
		const registryBefore = await readTableRegistry(storage.database);

		// Metadata-only change (no DDL): validated against rank = s | a.
		await assert.rejects(service.alter(enemyWith({ kind: TableColumnKind.Enum, enum: RANK })),
			(error: Error) => error instanceof RegistryMigrationRejectedError && /"fire" \(enum\) is not a value of kind 'enum' \(enum_registry '00000000-0000-4000-8000-0000000000e2'\)/.test(error.message));
		assert.deepStrictEqual(await readTableRegistry(storage.database), registryBefore);
		// Same change combined with NOT NULL (Constraint migration rebuild) is validated too.
		await assert.rejects(service.alter(enemyWith({ kind: TableColumnKind.Enum, enum: RANK, not_null: true })), RegistryMigrationRejectedError);
		assert.deepStrictEqual(await readTableRegistry(storage.database), registryBefore);
		assert.deepStrictEqual(await enemyRows(storage.database), [{ uuid: ROW_A, element: 'fire', type: 'text' }]);

		// An entry that has every stored value is accepted.
		const moved = await service.alter(enemyWith({ kind: TableColumnKind.Enum, enum: MISSING }));
		assert.strictEqual(moved.entry!.columns[0].enum, MISSING);
	});

	test('enum_registry UPDATE removing a value that stored Raw Data uses is rejected with ROLLBACK', async () => {
		const { storage } = await open();
		const service = new RegistryService(storage.database);
		const element = (await service.createEnum(elementEnum)).entry!;
		await service.create(enemyWith({ kind: TableColumnKind.Enum, enum: ELEMENT }));
		await storage.database.run(`INSERT INTO "items__enemy" ("uuid", "element") VALUES (?, 'fire')`, [ROW_A]);

		await assert.rejects(service.alterEnum({ ...elementEnum, uuid: ELEMENT, values: [{ value: 'water' }] }),
			(error: Error) => error instanceof RegistryMigrationRejectedError && /"fire" \(enum\) is not a value of kind 'enum'/.test(error.message));
		assert.deepStrictEqual(await readEnumRegistry(storage.database), [element]);

		// Removing an unused value succeeds.
		const altered = await service.alterEnum({ ...elementEnum, uuid: ELEMENT, values: [{ value: 'fire', label: 'Fire' }] });
		assert.deepStrictEqual(altered.entry!.values, [{ value: 'fire', label: 'Fire' }]);
		assert.deepStrictEqual(await readEnumRegistry(storage.database), [altered.entry]);
	});

	test('enum_registry DELETE is rejected while a table_registry column references it and succeeds once unreferenced', async () => {
		const { storage } = await open();
		const service = new RegistryService(storage.database);
		const element = (await service.createEnum(elementEnum)).entry!;
		const rank = (await service.createEnum(rankEnum)).entry!;
		await service.create(enemyWith({ kind: TableColumnKind.Enum, enum: ELEMENT }));

		await assert.rejects(service.dropEnum(ELEMENT),
			(error: Error) => error instanceof RegistryServiceError && /enum 'element' is referenced by table 'enemy' column 'element' and cannot be deleted/.test(error.message));
		assert.deepStrictEqual(await readEnumRegistry(storage.database), [element, rank]);

		// A failure after the enum_registry DELETE statement rolls it back together with the mutation.
		const failing = new RegistryService({
			transaction: work => storage.database.transaction(async statements => {
				await work(statements);
				throw new Error('commit failure');
			}),
		});
		await assert.rejects(failing.dropEnum(RANK), /commit failure/);
		assert.deepStrictEqual(await readEnumRegistry(storage.database), [element, rank]);

		await service.dropEnum(RANK);
		await service.drop(ENEMY);
		await service.dropEnum(ELEMENT);
		assert.deepStrictEqual(await readEnumRegistry(storage.database), []);
	});
});
