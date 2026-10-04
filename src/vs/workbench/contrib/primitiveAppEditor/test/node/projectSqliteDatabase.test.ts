/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite authoring storage (foundation.sqlite)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (4. SQLite, 32. Persistence Boundary)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { createSaveEvent } from '../../common/persistenceBoundary.js';
import { IProjectOpenSteps, openProjectDirectory, ProjectOpenMode, ProjectOpenPhase, ProjectOpenStatus } from '../../common/projectDirectory.js';
import {
	getSaveEvent,
	insertSaveEvent,
	listPhysicalTables,
	listSaveDataCurrent,
	loadSaveDataCurrent,
	ProjectSqliteError,
	ProjectSqliteOpenMode,
	ProjectSqliteStorage,
	upsertSaveDataCurrentRow,
} from '../../common/projectSqlite.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

suite('Primitive App Editor - project.sqlite on disk', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;
	const storages: ProjectSqliteStorage[] = [];
	const factory = new ProjectSqliteDatabaseFactory();

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-sqlite-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function openSteps(storage: ProjectSqliteStorage): IProjectOpenSteps {
		const done = async () => { };
		return {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: done,
			schemaVersionResolve: done,
			migrationApply: done,
			registryLoad: done,
			functionScan: done,
			assetScan: done,
		};
	}

	function newStorage(): ProjectSqliteStorage {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		return storage;
	}

	test('project Open lifecycle: Create creates project.sqlite, the next open is Open', async () => {
		const created = newStorage();
		const first = await openProjectDirectory(fileService, root, openSteps(created));
		assert.strictEqual(first.status, ProjectOpenStatus.Ready);
		assert.strictEqual(first.mode, ProjectOpenMode.Create);
		assert.strictEqual(first.phases[2], ProjectOpenPhase.Create);
		assert.ok((await fs.stat(join(root.fsPath, 'project.sqlite'))).isFile());
		assert.deepStrictEqual(await listPhysicalTables(created.database), ['logs__savedata', 'registry__current']);
		// Static / Initial data is never duplicated into registry.current automatically.
		assert.deepStrictEqual(await listSaveDataCurrent(created.database), []);
		await created.close();

		const reopened = newStorage();
		const second = await openProjectDirectory(fileService, root, openSteps(reopened));
		assert.strictEqual(second.status, ProjectOpenStatus.Ready);
		assert.strictEqual(second.mode, ProjectOpenMode.Open);
		assert.strictEqual(second.phases[2], ProjectOpenPhase.Open);
		assert.deepStrictEqual(await listPhysicalTables(reopened.database), ['logs__savedata', 'registry__current']);
	});

	test('registry.current UPSERT on key keeps uuid and moves saveId (player.hp Save-A -> Save-B), persisted across reopen', async () => {
		const storage = newStorage();
		await openProjectDirectory(fileService, root, openSteps(storage));
		const db = storage.database;

		const saveA = createSaveEvent(generateUuid(), new Date('2026-01-01T00:00:00Z'));
		const before = await db.transaction(async tx => {
			await insertSaveEvent(tx, saveA);
			return upsertSaveDataCurrentRow(tx, saveA, { key: 'player.hp', data: { value: 100 } });
		});
		assert.strictEqual(before.saveId, saveA.uuid);

		const saveB = createSaveEvent(generateUuid(), new Date('2026-01-02T00:00:00Z'));
		const after = await db.transaction(async tx => {
			await insertSaveEvent(tx, saveB);
			return upsertSaveDataCurrentRow(tx, saveB, { key: 'player.hp', data: { value: 80 } });
		});
		assert.deepStrictEqual(after, { uuid: before.uuid, key: 'player.hp', saveId: saveB.uuid, data: { value: 80 } });

		await storage.close();
		const reopened = newStorage();
		await openProjectDirectory(fileService, root, openSteps(reopened));
		const rows = await listSaveDataCurrent(reopened.database);
		assert.deepStrictEqual(rows, [{ uuid: before.uuid, key: 'player.hp', saveId: saveB.uuid, data: { value: 80 } }]);
		// logs.savedata holds Save Events only (no payload), one per save.
		assert.deepStrictEqual(await reopened.database.all('SELECT * FROM "logs__savedata" ORDER BY "timestamptz"'), [
			{ uuid: saveA.uuid, timestamptz: '2026-01-01T00:00:00.000Z' },
			{ uuid: saveB.uuid, timestamptz: '2026-01-02T00:00:00.000Z' },
		]);
		assert.deepStrictEqual(await getSaveEvent(reopened.database, saveB.uuid), saveB);
	});

	test('key is UNIQUE and the only conflict target; saveId must name a Save Event', async () => {
		const storage = newStorage();
		await openProjectDirectory(fileService, root, openSteps(storage));
		const db = storage.database;
		const save = createSaveEvent(generateUuid(), new Date());

		await assert.rejects(upsertSaveDataCurrentRow(db, save, { key: 'slot1.player.hp', data: 1 }), ProjectSqliteError);

		await insertSaveEvent(db, save);
		await upsertSaveDataCurrentRow(db, save, { key: 'slot1.player.hp', data: 1 });
		await upsertSaveDataCurrentRow(db, save, { key: 'slot2.player.hp', data: { tableId: 't', columnId: 'c', value: 42 } });
		await assert.rejects(db.run('INSERT INTO "registry__current" ("uuid", "saveId", "key", "data") VALUES (?, ?, ?, ?)', [generateUuid(), save.uuid, 'slot1.player.hp', '2']), /UNIQUE/);
		await assert.rejects(db.run('INSERT INTO "registry__current" ("uuid", "saveId", "key", "data") VALUES (?, ?, ?, ?)', [generateUuid(), save.uuid, 'bad', '{not json']), /CHECK/);
		assert.deepStrictEqual((await listSaveDataCurrent(db)).map(row => [row.key, row.data]), [
			['slot1.player.hp', 1],
			['slot2.player.hp', { tableId: 't', columnId: 'c', value: 42 }],
		]);
		assert.strictEqual(await loadSaveDataCurrent(db, 'missing'), undefined);
	});

	test('a failing save rolls back the Save Event and the current mutation', async () => {
		const storage = newStorage();
		await openProjectDirectory(fileService, root, openSteps(storage));
		const db = storage.database;
		const save = createSaveEvent(generateUuid(), new Date());

		await assert.rejects(db.transaction(async tx => {
			await insertSaveEvent(tx, save);
			await upsertSaveDataCurrentRow(tx, save, { key: 'player.position', data: [1, 2] });
			throw new Error('application save failed');
		}), /application save failed/);

		assert.strictEqual(await getSaveEvent(db, save.uuid), undefined);
		assert.strictEqual(await loadSaveDataCurrent(db, 'player.position'), undefined);
	});

	test('Create refuses an existing file; Open refuses a missing file or a non-SQLite file', async () => {
		const sqlite = URI.file(join(tempRoot, 'project.sqlite'));
		await assert.rejects(factory.open(sqlite, ProjectSqliteOpenMode.Open), ProjectSqliteError);
		await fs.writeFile(sqlite.fsPath, 'this is not a sqlite database, just plain text padding the header out');
		await assert.rejects(factory.open(sqlite, ProjectSqliteOpenMode.Create), ProjectSqliteError);
		await assert.rejects(factory.open(sqlite, ProjectSqliteOpenMode.Open), /not a SQLite database/);
		await assert.rejects(factory.open(URI.from({ scheme: 'pae-test', path: '/project.sqlite' }), ProjectSqliteOpenMode.Create), ProjectSqliteError);
	});

	test('closed database rejects further statements', async () => {
		const database = await factory.open(URI.file(join(tempRoot, 'project.sqlite')), ProjectSqliteOpenMode.Create);
		await database.close();
		await assert.rejects(database.exec('SELECT 1'), ProjectSqliteError);
	});
});
