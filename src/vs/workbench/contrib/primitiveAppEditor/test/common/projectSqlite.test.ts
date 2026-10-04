/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite authoring storage (foundation.sqlite)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (4. SQLite, 4. Logical Namespace)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuthorityBoundaryError } from '../../common/authority.js';
import { logsSaveDataTable, registryCurrentTable } from '../../common/persistenceBoundary.js';
import { IProjectOpenContext, ProjectOpenMode, resolveProjectPaths } from '../../common/projectDirectory.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	createSaveDataTableDdl,
	IProjectSqliteDatabase,
	IProjectSqliteDatabaseFactory,
	IProjectSqliteStatements,
	isLogicalNamespace,
	LogicalNamespace,
	logicalNamespaces,
	logsSaveDataPhysicalTable,
	ProjectSqliteAccessor,
	ProjectSqliteContent,
	projectSqliteContents,
	ProjectSqliteError,
	ProjectSqliteNameError,
	ProjectSqliteOpenMode,
	projectSqliteRole,
	ProjectSqliteStorage,
	registryCurrentPhysicalTable,
} from '../../common/projectSqlite.js';

class RecordingDatabase implements IProjectSqliteDatabase {
	readonly executed: string[] = [];
	closed = false;
	constructor(readonly resource: URI, private readonly failOn?: string) { }
	async exec(sql: string): Promise<void> {
		if (this.failOn && sql.includes(this.failOn)) {
			throw new Error('exec failed');
		}
		this.executed.push(sql);
	}
	async run() { return { changes: 0 }; }
	async get() { return undefined; }
	async all() { return []; }
	transaction<T>(work: (statements: IProjectSqliteStatements) => Promise<T>): Promise<T> { return work(this); }
	async close() { this.closed = true; }
}

class RecordingFactory implements IProjectSqliteDatabaseFactory {
	readonly opened: { resource: URI; mode: ProjectSqliteOpenMode; database: RecordingDatabase }[] = [];
	constructor(private readonly failOn?: string) { }
	async open(resource: URI, mode: ProjectSqliteOpenMode): Promise<IProjectSqliteDatabase> {
		const database = new RecordingDatabase(resource, this.failOn);
		this.opened.push({ resource, mode, database });
		return database;
	}
}

function openContext(mode: ProjectOpenMode): IProjectOpenContext {
	const paths = resolveProjectPaths(URI.file('/work/game'));
	return { mode, paths, scan: { paths, rootExists: true, sqliteExists: mode === ProjectOpenMode.Open, entries: [], missing: [] } };
}

suite('Primitive App Editor - project.sqlite (4. SQLite)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('content areas follow the specification order', () => {
		assert.deepStrictEqual(projectSqliteContents, [
			ProjectSqliteContent.EditorInternalSchema,
			ProjectSqliteContent.Registry,
			ProjectSqliteContent.PhysicalTables,
			ProjectSqliteContent.RawData,
			ProjectSqliteContent.FunctionBinding,
			ProjectSqliteContent.FunctionDependency,
			ProjectSqliteContent.RendererBinding,
			ProjectSqliteContent.ProjectMetadata,
		]);
	});

	test('SQLite = Authoring Storage, != Runtime Loop Storage', () => {
		assert.strictEqual(projectSqliteRole.authoringStorage, true);
		assert.strictEqual(projectSqliteRole.runtimeLoopStorage, false);
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		assertProjectSqliteAccess(ProjectSqliteAccessor.ExplicitSave);
		assert.throws(() => assertProjectSqliteAccess(ProjectSqliteAccessor.RuntimeLoop), AuthorityBoundaryError);
	});

	test('logical namespace is items | logs and never a SQLite schema', () => {
		assert.deepStrictEqual(logicalNamespaces, [LogicalNamespace.Items, LogicalNamespace.Logs]);
		assert.ok(isLogicalNamespace('items'));
		assert.ok(isLogicalNamespace('logs'));
		assert.ok(!isLogicalNamespace('main'));
		assert.strictEqual(corePhysicalTableNameResolver.resolve('items', 'enemy'), 'items__enemy');
		assert.strictEqual(registryCurrentPhysicalTable, 'registry__current');
		assert.strictEqual(logsSaveDataPhysicalTable, 'logs__savedata');
		assert.ok(!registryCurrentPhysicalTable.includes('.'));
	});

	test('physical table names reject ambiguous or unsafe identifiers', () => {
		for (const [schema, table] of [['items', 'a__b'], ['Items', 'x'], ['items', 'x"; DROP'], ['main.items', 'x'], ['', 'x'], ['items', '_x']]) {
			assert.throws(() => corePhysicalTableNameResolver.resolve(schema, table), ProjectSqliteNameError);
		}
	});

	test('Runtime Save Data DDL: uuid primary key, UNIQUE key, JSON data, no physical foreign key', () => {
		const current = createSaveDataTableDdl(registryCurrentTable);
		assert.strictEqual(current, 'CREATE TABLE IF NOT EXISTS "registry__current" ("uuid" TEXT NOT NULL PRIMARY KEY, "saveId" TEXT NOT NULL, "key" TEXT NOT NULL UNIQUE, "data" TEXT NOT NULL CHECK (json_valid("data")))');
		assert.ok(!/REFERENCES|FOREIGN KEY/i.test(current));
		assert.strictEqual(createSaveDataTableDdl(logsSaveDataTable), 'CREATE TABLE IF NOT EXISTS "logs__savedata" ("uuid" TEXT NOT NULL PRIMARY KEY, "timestamptz" TEXT NOT NULL)');
	});
});

suite('Primitive App Editor - project.sqlite Create / Open steps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Create opens project.sqlite in create mode and creates the Save Data tables', async () => {
		const factory = new RecordingFactory();
		const storage = new ProjectSqliteStorage(factory);
		await storage.createStorage(openContext(ProjectOpenMode.Create));
		assert.strictEqual(factory.opened.length, 1);
		assert.strictEqual(factory.opened[0].mode, ProjectSqliteOpenMode.Create);
		assert.strictEqual(factory.opened[0].resource.path, '/work/game/project.sqlite');
		assert.deepStrictEqual(factory.opened[0].database.executed, [createSaveDataTableDdl(logsSaveDataTable), createSaveDataTableDdl(registryCurrentTable)]);
		assert.strictEqual(storage.database, factory.opened[0].database);
		await storage.close();
		assert.ok(factory.opened[0].database.closed);
		assert.throws(() => storage.database, ProjectSqliteError);
	});

	test('Open opens project.sqlite in open mode', async () => {
		const factory = new RecordingFactory();
		const storage = new ProjectSqliteStorage(factory);
		await storage.openStorage(openContext(ProjectOpenMode.Open));
		assert.strictEqual(factory.opened[0].mode, ProjectSqliteOpenMode.Open);
		assert.ok(storage.isOpen);
		await assert.rejects(storage.openStorage(openContext(ProjectOpenMode.Open)), ProjectSqliteError);
		await storage.close();
	});

	test('storage step must match the open mode', async () => {
		const storage = new ProjectSqliteStorage(new RecordingFactory());
		assert.throws(() => storage.createStorage(openContext(ProjectOpenMode.Open)), ProjectSqliteError);
		assert.throws(() => storage.openStorage(openContext(ProjectOpenMode.Create)), ProjectSqliteError);
		assert.ok(!storage.isOpen);
	});

	test('a failing storage DDL closes the database and leaves the storage closed', async () => {
		const factory = new RecordingFactory('registry__current');
		const storage = new ProjectSqliteStorage(factory);
		await assert.rejects(storage.createStorage(openContext(ProjectOpenMode.Create)), /exec failed/);
		assert.ok(factory.opened[0].database.closed);
		assert.ok(!storage.isOpen);
	});
});
