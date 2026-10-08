/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - SQLite physical table projection (registry.physical-expansion)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (9. Physical Table Expansion)
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
import { IProjectSqliteStatements, listPhysicalTables, LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RegistryExpansionError, RegistryExpansionStage } from '../../common/registryPhysicalExpansion.js';
import { IRegistryExpansionResult, RegistryService, RegistryServiceError } from '../../common/registryService.js';
import { createTableRegistryEntry, getTableRegistryInsert, ITableRegistryColumnInput, ITableRegistryEntry, readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const BATTLE = '00000000-0000-4000-8000-0000000000a2';
const ENEMY = '00000000-0000-4000-8000-0000000000a3';
const HP = '00000000-0000-4000-8000-0000000000c1';
const SPEED = '00000000-0000-4000-8000-0000000000c2';
const ROW = '00000000-0000-4000-8000-00000000d001';
const CREATED = '2026-01-01T00:00:00.000Z';

function column(uuid: string, index: number, name: string, kind: TableColumnKind, not_null = false): ITableRegistryColumnInput {
	return { uuid, index, name, kind, not_null, writable: true, searchable: false };
}

function entry(uuid: string, index: number, name: string, columns: ITableRegistryColumnInput[], schema = LogicalNamespace.Items): ITableRegistryEntry {
	return createTableRegistryEntry({ uuid, index, schema, name, columns, created_at: CREATED });
}

const player = entry(PLAYER, 0, 'player', [column(HP, 0, 'hp', TableColumnKind.Int, true), column(SPEED, 1, 'speed', TableColumnKind.Double)]);
const battle = entry(BATTLE, 1, 'battle', [column(HP, 0, 'damage', TableColumnKind.Int)], LogicalNamespace.Logs);

/** Seeds table_registry rows only (Registry written without its projection, e.g. a Seed / imported project.sqlite). */
async function seedRegistry(statements: IProjectSqliteStatements, entries: readonly ITableRegistryEntry[]): Promise<void> {
	for (const e of entries) {
		const insert = getTableRegistryInsert(e);
		await statements.run(insert.sql, insert.params);
	}
}

suite('Primitive App Editor - Physical Table Expansion on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-physical-expansion-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Opens the project; `Registry Load` reads table_registry and expands it into the Physical Schema. */
	async function open(): Promise<{ storage: ProjectSqliteStorage; loaded: readonly ITableRegistryEntry[]; expansion: IRegistryExpansionResult | undefined }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		let loaded: readonly ITableRegistryEntry[] = [];
		let expansion: IRegistryExpansionResult | undefined;
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: async () => {
				loaded = await readTableRegistry(storage.database);
				expansion = await new RegistryService(storage.database).expand();
			},
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		return { storage, loaded, expansion };
	}

	async function physicalColumns(statements: IProjectSqliteStatements, table: string): Promise<string[]> {
		const rows = await statements.all(`SELECT "name", "type", "notnull", "pk" FROM pragma_table_info(?) ORDER BY "cid"`, [table]);
		return rows.map(row => `${row.name} ${row.type}${row.pk ? ' PK' : ''}${row.notnull ? ' NOT NULL' : ''}`);
	}

	test('Registry expands into missing physical tables; Raw Data CRUD on them; the next expansion keeps tables and rows', async () => {
		const first = await open();
		assert.deepStrictEqual(first.expansion!.created, [], 'empty Registry expands to nothing');
		const db = first.storage.database;
		await db.transaction(statements => seedRegistry(statements, [battle, player]));
		const before = await listPhysicalTables(db);

		const expanded = await new RegistryService(db).expand();
		assert.deepStrictEqual(expanded.created, ['items__player', 'logs__battle'], 'Registry order');
		assert.deepStrictEqual(expanded.schema.tables.map(t => t.registryUuid), [PLAYER, BATTLE]);
		assert.deepStrictEqual([...await listPhysicalTables(db)].sort(), [...before, 'items__player', 'logs__battle'].sort());
		assert.deepStrictEqual(await physicalColumns(db, 'items__player'), ['uuid TEXT PK NOT NULL', 'hp INTEGER NOT NULL', 'speed REAL']);
		assert.deepStrictEqual(await physicalColumns(db, 'logs__battle'), ['uuid TEXT PK NOT NULL', 'damage INTEGER']);

		// Physical Schema -> CRUD -> Raw Data
		await db.run(`INSERT INTO "items__player" ("uuid", "hp", "speed") VALUES (?, ?, ?)`, [ROW, 50, 4.0]);
		await db.run(`UPDATE "items__player" SET "speed" = ? WHERE "uuid" = ?`, [1.5, ROW]);
		await assert.rejects(db.run(`INSERT INTO "items__player" ("uuid", "speed") VALUES (?, ?)`, ['00000000-0000-4000-8000-00000000d002', 1]), 'NOT NULL from the Registry');
		await assert.rejects(db.run(`INSERT INTO "items__player" ("uuid", "hp") VALUES (?, ?)`, [ROW, 1]), 'row identity is the PRIMARY KEY');

		await first.storage.close();
		const reopened = await open();
		assert.deepStrictEqual(reopened.loaded, [player, battle]);
		assert.deepStrictEqual(reopened.expansion!.created, [], 'already projected tables are kept');
		assert.deepStrictEqual(await reopened.storage.database.all(`SELECT "uuid", "hp", "speed" FROM "items__player"`), [{ uuid: ROW, hp: 50, speed: 1.5 }]);
	});

	test('the expansion matches what Registry Service mutations project', async () => {
		const { storage } = await open();
		const db = storage.database;
		const service = new RegistryService(db);
		await service.create(player);
		await service.alter({ ...player, columns: [column(HP, 0, 'hp', TableColumnKind.Int, true), column(SPEED, 1, 'speed', TableColumnKind.Text), column(ENEMY, 2, 'note', TableColumnKind.Text)] });
		const expanded = await service.expand();
		assert.deepStrictEqual(expanded.created, []);
		assert.deepStrictEqual(expanded.schema.tables[0].columns.map(c => `${c.name} ${c.type}`), ['uuid TEXT', 'hp INTEGER', 'speed TEXT', 'note TEXT']);
	});

	test('Physical Schema is not the Authority: a mismatching table rejects the expansion with ROLLBACK and the Registry is unchanged', async () => {
		const { storage } = await open();
		const db = storage.database;
		await db.transaction(statements => seedRegistry(statements, [player, battle]));
		// Out-of-band physical table for logs__battle with a column the Registry does not define.
		await db.exec(`CREATE TABLE "logs__battle" ("uuid" TEXT PRIMARY KEY NOT NULL, "damage" INTEGER, "extra" TEXT)`);
		const tables = await listPhysicalTables(db);

		await assert.rejects(new RegistryService(db).expand(), (error: Error) => error instanceof RegistryServiceError && /'extra' that is not in the Registry/.test(error.message));
		assert.deepStrictEqual(await listPhysicalTables(db), tables, 'items__player created in the same transaction was rolled back');
		assert.deepStrictEqual(await readTableRegistry(db), [player, battle], 'never reverse-generated into the Registry');
		assert.deepStrictEqual(await physicalColumns(db, 'logs__battle'), ['uuid TEXT PK NOT NULL', 'damage INTEGER', 'extra TEXT'], 'never silently rebuilt');

		// A non-table object occupying the physical name is rejected as well.
		await db.exec(`DROP TABLE "logs__battle"`);
		await db.exec(`CREATE VIEW "logs__battle" AS SELECT 1 AS "uuid"`);
		await assert.rejects(new RegistryService(db).expand(), /used by a view/);
		assert.ok(!(await listPhysicalTables(db)).includes('items__player'));
	});

	test('an invalid stored Registry is rejected at Schema / Column Validate before any DDL', async () => {
		const { storage } = await open();
		const db = storage.database;
		const enemy = entry(ENEMY, 2, 'enemy', [column(HP, 0, 'hp', TableColumnKind.Int)]);
		// Column Validate: a stored column named like the row identity column.
		const bad = { ...enemy, columns: [{ ...enemy.columns[0], name: 'uuid' }] };
		await db.transaction(statements => seedRegistry(statements, [player, bad]));
		const tables = await listPhysicalTables(db);
		await assert.rejects(new RegistryService(db).expand(), (error: Error) => error instanceof RegistryExpansionError && error.stage === RegistryExpansionStage.ColumnValidate);
		assert.deepStrictEqual(await listPhysicalTables(db), tables);
	});
});
