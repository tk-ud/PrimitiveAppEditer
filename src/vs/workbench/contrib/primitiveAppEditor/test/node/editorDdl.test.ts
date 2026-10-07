/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor built-in DDL and migrations (foundation.editor-ddl)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (5. Built-in DDL)
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
import { EditorDdlError, EditorDdlMigrator, editorSchemaVersionPhysicalTable, IEditorDdlResource, readAppliedEditorDdlMigrations } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { createSaveEvent } from '../../common/persistenceBoundary.js';
import { IProjectOpenContext, IProjectOpenResult, openProjectDirectory, ProjectOpenMode, ProjectOpenPhase, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { insertSaveEvent, listPhysicalTables, loadSaveDataCurrent, ProjectSqliteStorage, upsertSaveDataCurrentRow } from '../../common/projectSqlite.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

suite('Primitive App Editor - Editor DDL migrations on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-ddl-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	const now = () => new Date('2026-10-04T00:00:00Z');

	async function open(resources: readonly IEditorDdlResource[]): Promise<{ storage: ProjectSqliteStorage; migrator: EditorDdlMigrator; result: IProjectOpenResult }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, resources, now);
		const done = async () => { };
		try {
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
			return { storage, migrator, result };
		} catch (error) {
			await storage.close();
			throw error;
		}
	}

	test('Create applies every built-in migration in the open lifecycle; the next Open applies none', async () => {
		const first = await open(editorDdlResources);
		assert.strictEqual(first.result.status, ProjectOpenStatus.Ready);
		assert.strictEqual(first.result.mode, ProjectOpenMode.Create);
		assert.deepStrictEqual(first.result.phases.slice(2, 6), [ProjectOpenPhase.Create, ProjectOpenPhase.EditorDdlScan, ProjectOpenPhase.SchemaVersionResolve, ProjectOpenPhase.MigrationApply]);
		assert.deepStrictEqual([first.migrator.resolved?.current, first.migrator.resolved?.target], [0, 1]);
		assert.deepStrictEqual(first.migrator.applied?.map(m => m.name), ['001_savedata.sql']);
		assert.deepStrictEqual(await listPhysicalTables(first.storage.database), ['editor__schema_version', 'logs__savedata', 'registry__current']);
		assert.deepStrictEqual(await readAppliedEditorDdlMigrations(first.storage.database), first.migrator.applied);
		assert.strictEqual(first.migrator.applied?.[0].appliedAt, '2026-10-04T00:00:00.000Z');

		// The Runtime Save Data tables created by the built-in DDL are usable by foundation.sqlite.
		const save = createSaveEvent(generateUuid(), now());
		await insertSaveEvent(first.storage.database, save);
		await upsertSaveDataCurrentRow(first.storage.database, save, { key: 'player.hp', data: 100 });
		await first.storage.close();

		const second = await open(editorDdlResources);
		assert.strictEqual(second.result.status, ProjectOpenStatus.Ready);
		assert.strictEqual(second.result.mode, ProjectOpenMode.Open);
		assert.deepStrictEqual([second.migrator.resolved?.current, second.migrator.resolved?.target], [1, 1]);
		assert.deepStrictEqual(second.migrator.applied, []);
		assert.strictEqual((await loadSaveDataCurrent(second.storage.database, 'player.hp'))?.data, 100);
	});

	test('a new resource is applied as the only Unapplied Migration on the next Open', async () => {
		await (await open(editorDdlResources)).storage.close();

		const next = [...editorDdlResources, { name: '002_project.sql', sql: 'CREATE TABLE "editor__project" ("uuid" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);' }];
		const reopened = await open(next);
		assert.deepStrictEqual([reopened.migrator.resolved?.current, reopened.migrator.resolved?.target], [1, 2]);
		assert.deepStrictEqual(reopened.migrator.applied?.map(m => m.version), [2]);
		assert.deepStrictEqual((await readAppliedEditorDdlMigrations(reopened.storage.database)).map(m => m.name), ['001_savedata.sql', '002_project.sql']);
		assert.ok((await listPhysicalTables(reopened.storage.database)).includes('editor__project'));
	});

	test('a failing migration rolls back the whole SQLite transaction and the open never reaches Editor Ready', async () => {
		const broken = [...editorDdlResources, { name: '002_broken.sql', sql: 'CREATE TABLE "editor__ok" ("a" TEXT); CREATE TABLE "logs__savedata" ("a" TEXT);' }];
		await assert.rejects(open(broken), (error: Error) => error instanceof EditorDdlError && /002_broken\.sql/.test(error.message));

		// Nothing of 001 / 002 nor the version table was committed; a corrected Editor migrates from version 0.
		const recovered = await open(editorDdlResources);
		assert.strictEqual(recovered.result.mode, ProjectOpenMode.Open);
		assert.strictEqual(recovered.result.status, ProjectOpenStatus.Ready);
		assert.deepStrictEqual(recovered.migrator.resolved?.current, 0);
		assert.deepStrictEqual(await listPhysicalTables(recovered.storage.database), ['editor__schema_version', 'logs__savedata', 'registry__current']);
	});

	test('Open rejects a project.sqlite migrated by a newer Editor or with a modified applied resource', async () => {
		const newer = [...editorDdlResources, { name: '002_project.sql', sql: 'CREATE TABLE "editor__project" ("uuid" TEXT NOT NULL PRIMARY KEY);' }];
		await (await open(newer)).storage.close();

		await assert.rejects(open(editorDdlResources), /newer than this Editor/);
		await assert.rejects(open([editorDdlResources[0], { name: '002_project.sql', sql: 'CREATE TABLE "editor__project" ("id" TEXT);' }]), /does not match/);

		const current = await open(newer);
		assert.deepStrictEqual(current.migrator.applied, []);
		assert.strictEqual((await current.storage.database.get(`SELECT COUNT(*) AS n FROM "${editorSchemaVersionPhysicalTable}"`))?.n, 2);
	});

	test('steps require the previous step', async () => {
		const migrator = new EditorDdlMigrator({ get database(): never { throw new Error('not open'); } }, editorDdlResources);
		const context = {} as IProjectOpenContext;
		await assert.rejects(migrator.schemaVersionResolve(context), /requires Editor DDL Scan/);
		await migrator.editorDdlScan(context);
		await assert.rejects(migrator.migrationApply(context), /requires Schema Version Resolve/);
	});
});
