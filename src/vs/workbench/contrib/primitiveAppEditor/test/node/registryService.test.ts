/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - App Editor Registry Service mutation pipeline (registry.service)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (5. Registry DDL, 6. Registry Service)
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
import {
	IRegistryDependencyCleanup,
	RegistryMigrationRejectedError,
	RegistryService,
	RegistryServiceError,
	validateRegistryPhysicalSchema,
} from '../../common/registryService.js';
import { ITableRegistryColumnInput, ITableRegistryEntry, readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const HP = '00000000-0000-4000-8000-0000000000c1';
const SPEED = '00000000-0000-4000-8000-0000000000c2';
const NOTE = '00000000-0000-4000-8000-0000000000c3';

function column(uuid: string | undefined, index: number, name: string, kind: TableColumnKind, not_null = false): ITableRegistryColumnInput {
	return { ...(uuid ? { uuid } : {}), index, name, kind, not_null, writable: true, searchable: false };
}

suite('Primitive App Editor - Registry Service on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-registry-service-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Opens the project through the lifecycle; `Registry Load` reads table_registry. */
	async function open(): Promise<{ storage: ProjectSqliteStorage; loaded: readonly ITableRegistryEntry[] }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		let loaded: readonly ITableRegistryEntry[] = [];
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

	async function physicalColumns(statements: IProjectSqliteStatements, table: string): Promise<string[]> {
		const rows = await statements.all(`SELECT "name", "type", "notnull" FROM pragma_table_info(?) ORDER BY "cid"`, [table]);
		return rows.map(row => `${row.name} ${row.type}${row.notnull ? ' NOT NULL' : ''}`);
	}

	test('INSERT creates the physical table; UPDATE renames / adds / drops columns keeping Raw Data; DELETE drops it; Registry reloads unchanged', async () => {
		const { storage } = await open();
		const db = storage.database;
		const service = new RegistryService(db);

		const created = await service.create({ index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [column(HP, 0, 'hp', TableColumnKind.Int, true), column(SPEED, 1, 'fatigue', TableColumnKind.Double)] });
		const player = created.entry!;
		assert.ok(/^[0-9a-f-]{36}$/.test(player.uuid), 'UUID Complete generates the table uuid');
		assert.deepStrictEqual(await physicalColumns(db, 'items__player'), ['uuid TEXT NOT NULL', 'hp INTEGER NOT NULL', 'fatigue REAL']);
		await db.run(`INSERT INTO "items__player" ("uuid", "hp", "fatigue") VALUES (?, ?, ?)`, ['00000000-0000-4000-8000-00000000d001', 50, 0.5]);

		// fatigue -> tiredness (same uuid = rename), add a nullable note, then drop it again.
		const altered = await service.alter({ ...player, columns: [column(HP, 0, 'hp', TableColumnKind.Int, true), column(SPEED, 1, 'tiredness', TableColumnKind.Double), column(undefined, 2, 'note', TableColumnKind.Text)] });
		assert.deepStrictEqual(await physicalColumns(db, 'items__player'), ['uuid TEXT NOT NULL', 'hp INTEGER NOT NULL', 'tiredness REAL', 'note TEXT']);
		assert.deepStrictEqual(await db.all(`SELECT "hp", "tiredness", "note" FROM "items__player"`), [{ hp: 50, tiredness: 0.5, note: null }]);
		assert.strictEqual(altered.entry!.created_at, player.created_at, 'UPDATE keeps created_at');
		await service.alter({ ...altered.entry!, columns: altered.entry!.columns.filter(c => c.name !== 'note') });
		assert.deepStrictEqual(await physicalColumns(db, 'items__player'), ['uuid TEXT NOT NULL', 'hp INTEGER NOT NULL', 'tiredness REAL']);

		// Table rename / schema move -> ALTER TABLE RENAME, Raw Data kept.
		const moved = (await service.alter({ ...altered.entry!, schema: LogicalNamespace.Logs, name: 'hero', columns: altered.entry!.columns.filter(c => c.name !== 'note') })).entry!;
		assert.ok(!(await listPhysicalTables(db)).includes('items__player'));
		assert.deepStrictEqual(await db.all(`SELECT "hp", "tiredness" FROM "logs__hero"`), [{ hp: 50, tiredness: 0.5 }]);

		await storage.close();
		const reopened = await open();
		assert.deepStrictEqual(reopened.loaded, [moved]);
		await validateRegistryPhysicalSchema(reopened.storage.database, reopened.loaded);

		const dropped = await new RegistryService(reopened.storage.database).drop(moved.uuid);
		assert.strictEqual(dropped.entry, undefined);
		assert.deepStrictEqual(await readTableRegistry(reopened.storage.database), []);
		assert.ok(!(await listPhysicalTables(reopened.storage.database)).includes('logs__hero'));
	});

	test('KIND CHANGE / NOT NULL CHANGE migrate existing rows or reject invalid existing data with ROLLBACK', async () => {
		const { storage } = await open();
		const db = storage.database;
		const service = new RegistryService(db);
		const player = (await service.create({ index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [column(HP, 0, 'hp', TableColumnKind.Int), column(NOTE, 1, 'note', TableColumnKind.Text)] })).entry!;
		await db.run(`INSERT INTO "items__player" ("uuid", "hp", "note") VALUES ('00000000-0000-4000-8000-00000000d001', 50, 'x'), ('00000000-0000-4000-8000-00000000d002', NULL, NULL)`);
		const snapshot = async () => ({
			registry: await readTableRegistry(db),
			columns: await physicalColumns(db, 'items__player'),
			rows: await db.all(`SELECT * FROM "items__player" ORDER BY "uuid"`),
			tables: await listPhysicalTables(db),
		});
		const before = await snapshot();

		// int -> double: Type migration keeps the values.
		const asDouble = (await service.alter({ ...player, columns: [column(HP, 0, 'hp', TableColumnKind.Double), column(NOTE, 1, 'note', TableColumnKind.Text)] })).entry!;
		assert.deepStrictEqual(await physicalColumns(db, 'items__player'), ['uuid TEXT NOT NULL', 'hp REAL', 'note TEXT']);
		assert.deepStrictEqual((await db.all(`SELECT "hp", "note" FROM "items__player" ORDER BY "uuid"`)), [{ hp: 50, note: 'x' }, { hp: null, note: null }]);

		// Invalid existing data -> migration reject -> ROLLBACK of Registry and DDL.
		const afterDouble = await snapshot();
		await assert.rejects(service.alter({ ...asDouble, columns: [column(HP, 0, 'hp', TableColumnKind.Double, true), column(NOTE, 1, 'note', TableColumnKind.Text)] }), RegistryMigrationRejectedError);
		await assert.rejects(service.alter({ ...asDouble, columns: [column(HP, 0, 'hp', TableColumnKind.Double), column(NOTE, 1, 'note', TableColumnKind.Uuid)] }), RegistryMigrationRejectedError);
		await assert.rejects(service.alter({ ...asDouble, columns: [...asDouble.columns, column(undefined, 2, 'level', TableColumnKind.Int, true)] }), RegistryMigrationRejectedError);
		assert.deepStrictEqual(await snapshot(), afterDouble);

		// NOT NULL CHANGE succeeds once the existing data is valid.
		await db.run(`UPDATE "items__player" SET "hp" = 1 WHERE "hp" IS NULL`);
		await service.alter({ ...asDouble, columns: [column(HP, 0, 'hp', TableColumnKind.Double, true), column(NOTE, 1, 'note', TableColumnKind.Text)] });
		assert.deepStrictEqual(await physicalColumns(db, 'items__player'), ['uuid TEXT NOT NULL', 'hp REAL NOT NULL', 'note TEXT']);
		await assert.rejects(db.run(`INSERT INTO "items__player" ("uuid") VALUES ('00000000-0000-4000-8000-00000000d003')`), /NOT NULL/);
		assert.notDeepStrictEqual(await snapshot(), before);
	});

	test('Registry Validate rejects before any write; missing definitions and occupied physical names are rejected', async () => {
		const { storage } = await open();
		const db = storage.database;
		const service = new RegistryService(db);
		const tables = await listPhysicalTables(db);
		await assert.rejects(service.create({ index: 0, schema: LogicalNamespace.Logs, name: 'savedata', columns: [] }), /already used/);
		await assert.rejects(service.create({ index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [column(undefined, 0, 'uuid', TableColumnKind.Uuid)] }), /row identity/);
		await assert.rejects(service.create({ index: 0, schema: 'raw', name: 'player', columns: [] }), RegistryServiceError);
		await assert.rejects(service.alter({ uuid: HP, index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [] }), /has no entry/);
		await assert.rejects(service.drop(HP), /has no entry/);
		const player = (await service.create({ index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [] })).entry!;
		await assert.rejects(service.create({ index: 1, schema: LogicalNamespace.Items, name: 'player', columns: [] }), /same physical table/);
		await assert.rejects(service.create({ ...player, name: 'enemy' }), /duplicate table uuid/);
		assert.deepStrictEqual(await readTableRegistry(db), [player]);
		assert.deepStrictEqual(await listPhysicalTables(db), [...tables, 'items__player'].sort());
	});

	test('Physical Schema Validate failure and dependency cleanup failure roll back; DELETE runs Logical dependency cleanup', async () => {
		const { storage } = await open();
		const db = storage.database;
		const cleaned: string[] = [];
		let failCleanup = true;
		const cleanup: IRegistryDependencyCleanup = {
			async cleanupDroppedTable(_statements, dropped) {
				if (failCleanup) {
					throw new Error('cleanup failed');
				}
				cleaned.push(dropped.name);
			},
		};
		const service = new RegistryService(db, { dependencyCleanup: [cleanup] });
		const player = (await service.create({ index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [column(HP, 0, 'hp', TableColumnKind.Int)] })).entry!;

		await assert.rejects(service.drop(player.uuid), /cleanup failed/);
		assert.deepStrictEqual(await readTableRegistry(db), [player]);
		assert.ok((await listPhysicalTables(db)).includes('items__player'));

		// A trigger on a Registry-projected table fails Physical Schema Validate (DB Triggerは使用しない).
		await db.exec(`CREATE TRIGGER "player_audit" AFTER INSERT ON "items__player" BEGIN SELECT 1; END`);
		await assert.rejects(service.alter({ ...player, label: 'Player' }), /DB triggers are not used/);
		assert.deepStrictEqual(await readTableRegistry(db), [player]);
		await db.exec(`DROP TRIGGER "player_audit"`);

		// A physical schema edited outside the Registry Service is reported, not reverse-generated.
		await db.exec(`ALTER TABLE "items__player" ADD COLUMN "manual" TEXT`);
		await assert.rejects(service.alter({ ...player, label: 'Player' }), /not in the Registry/);
		assert.deepStrictEqual(await readTableRegistry(db), [player]);
		await db.exec(`ALTER TABLE "items__player" DROP COLUMN "manual"`);

		failCleanup = false;
		await service.drop(player.uuid);
		assert.deepStrictEqual(cleaned, ['player']);
		assert.deepStrictEqual(await readTableRegistry(db), []);
	});
});
