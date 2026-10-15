/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Raw Data CRUD over projected physical tables (data.raw)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (12. Raw Data)
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
import { RawDataError, RawDataService } from '../../common/rawData.js';
import { generateLogicalJoinQuery, queryLogicalJoin, resolveRelation, createRelationRegistryEntry, RelationType } from '../../common/relationRegistry.js';
import { RegistryService } from '../../common/registryService.js';
import { readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const ENEMY = '00000000-0000-4000-8000-0000000000a1';
const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const ELEMENT = '00000000-0000-4000-8000-0000000000e1';
const HP = '00000000-0000-4000-8000-0000000000c1';
const SPEED = '00000000-0000-4000-8000-0000000000c2';
const ELEM_COL = '00000000-0000-4000-8000-0000000000c3';
const FLAGS = '00000000-0000-4000-8000-0000000000c4';
const ALIVE = '00000000-0000-4000-8000-0000000000c5';
const P_NAME = '00000000-0000-4000-8000-0000000000c6';
const P_ENEMY = '00000000-0000-4000-8000-0000000000c7';
const R1 = '00000000-0000-4000-8000-0000000000b1';
const R2 = '00000000-0000-4000-8000-0000000000b2';
const R3 = '00000000-0000-4000-8000-0000000000b3';
const MISSING = '00000000-0000-4000-8000-0000000000f9';

const col = (uuid: string, index: number, name: string, kind: TableColumnKind, extra: object = {}) => ({ uuid, index, name, kind, not_null: false, writable: true, searchable: true, ...extra });

suite('Primitive App Editor - Raw Data on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-raw-data-'));
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
		const registry = new RegistryService(storage.database);
		await registry.createEnum({ uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water' }] });
		await registry.create({
			uuid: ENEMY, index: 0, schema: LogicalNamespace.Items, name: 'enemy', columns: [
				col(HP, 0, 'hp', TableColumnKind.Int, { not_null: true }),
				col(SPEED, 1, 'speed', TableColumnKind.Double),
				col(ELEM_COL, 2, 'element', TableColumnKind.Enum, { enum: ELEMENT }),
				col(FLAGS, 3, 'flags', TableColumnKind.Json),
				col(ALIVE, 4, 'alive', TableColumnKind.Bool),
			],
		});
		await registry.create({ uuid: PLAYER, index: 1, schema: LogicalNamespace.Items, name: 'player', columns: [col(P_NAME, 0, 'name', TableColumnKind.Text), col(P_ENEMY, 1, 'enemy', TableColumnKind.Uuid)] });
		return { storage, raw: new RawDataService(storage.database) };
	}

	test('insert / update / select / delete / truncate dispatch from the Registry onto the projected table', async () => {
		const { storage, raw } = await open();
		const inserted = await raw.insert(ENEMY, { uuid: R1, hp: 50, speed: 1.2, element: 'fire', flags: { boss: false }, alive: true });
		assert.strictEqual(inserted.uuid, R1);
		assert.deepStrictEqual(inserted.row.values, { [HP]: 50, [SPEED]: 1.2, [ELEM_COL]: 'fire', [FLAGS]: { boss: false }, [ALIVE]: true });
		// physical storage: bool 0/1, json text, enum text
		assert.deepStrictEqual(await storage.database.get(`SELECT "alive", "flags", "element" FROM items__enemy`), { alive: 1, flags: '{"boss":false}', element: 'fire' });

		const generated = await raw.insert(ENEMY, { [HP]: 10 });
		assert.ok(/^[0-9a-f-]{36}$/.test(generated.uuid));
		assert.strictEqual(generated.row.values[SPEED], null);
		await raw.insert(ENEMY, { uuid: R2, hp: 70, element: 'water' });

		const updated = await raw.update(ENEMY, R1, { hp: 45, [ELEM_COL]: 'water', speed: null });
		assert.deepStrictEqual([updated.row.values[HP], updated.row.values[ELEM_COL], updated.row.values[SPEED], updated.row.values[ALIVE]], [45, 'water', null, true]);

		const strong = await raw.select(ENEMY, { where: { element: 'water' }, orderBy: ['hp'], resolveLabels: true });
		assert.deepStrictEqual(strong.map(row => row.uuid), [R1, R2]);
		assert.deepStrictEqual(strong[0].labels, { [ELEM_COL]: 'water' });
		assert.strictEqual((await raw.select(ENEMY, { where: { uuid: R2 } })).length, 1);
		assert.strictEqual((await raw.select(ENEMY, { where: { speed: null }, limit: 2 })).length, 2);
		assert.strictEqual((await raw.select(ENEMY, { resolveLabels: true })).find(r => r.values[ELEM_COL] === null)?.labels?.[ELEM_COL], undefined);

		const removed = await raw.delete(ENEMY, R2);
		assert.strictEqual(removed.uuid, R2);
		assert.strictEqual((await raw.select(ENEMY)).length, 2);
		assert.strictEqual(await raw.truncate(ENEMY), 2);
		assert.deepStrictEqual(await raw.select(ENEMY), []);
		// truncate = Data Removal != Registry Drop
		assert.strictEqual((await readTableRegistry(storage.database)).length, 2);
		assert.ok(await storage.database.get(`SELECT 1 FROM sqlite_master WHERE name = 'items__enemy'`));
	});

	test('upsert resolves the Conflict Identity (Row uuid) and never guesses it', async () => {
		const { raw } = await open();
		const first = await raw.upsert(ENEMY, { uuid: R1, hp: 5, element: 'fire' });
		assert.strictEqual(first.operation, 'insert');
		const second = await raw.upsert(ENEMY, { uuid: R1, hp: 6 });
		assert.strictEqual(second.operation, 'update');
		assert.deepStrictEqual([second.row.values[HP], second.row.values[ELEM_COL]], [6, 'fire']);
		assert.strictEqual((await raw.select(ENEMY)).length, 1);
		await assert.rejects(raw.upsert(ENEMY, { hp: 7 }), /requires the Conflict Identity 'uuid'/);
		await assert.rejects(raw.upsert(ENEMY, { uuid: R2, speed: 1 }), /not_null/);
		assert.strictEqual((await raw.select(ENEMY)).length, 1);
	});

	test('Registry Validate rejects invalid requests with nothing written', async () => {
		const { storage, raw } = await open();
		await raw.insert(ENEMY, { uuid: R1, hp: 1 });
		const reject = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: Error) => error instanceof RawDataError && pattern.test(error.message));
		await reject(raw.insert(MISSING, { hp: 1 }), /Missing Definition/);
		await reject(raw.insert(ENEMY, { uuid: R1, hp: 2 }), /already has a row/);
		await reject(raw.insert(ENEMY, { speed: 1 }), /hp' is not_null/);
		await reject(raw.insert(ENEMY, { hp: 1, unknown: 1 }), /no column 'unknown'/);
		await reject(raw.insert(ENEMY, { hp: 1.5 }), /not a value of kind 'int'/);
		await reject(raw.insert(ENEMY, { hp: 1, element: 'earth' }), /kind 'enum'/);
		await reject(raw.insert(ENEMY, { hp: 1, alive: 1 }), /kind 'bool'/);
		await reject(raw.insert(ENEMY, { hp: 1, hp2: 1, [HP]: 2 }), /no column 'hp2'|more than once/);
		await reject(raw.insert(ENEMY, { hp: 1, [HP]: 2 }), /more than once/);
		await reject(raw.insert(ENEMY, { uuid: 'nope', hp: 1 }), /must be a UUID/);
		await reject(raw.update(ENEMY, R1, { hp: null }), /not a value of kind 'int' not_null/);
		await reject(raw.update(ENEMY, R1, {}), /at least one column/);
		await reject(raw.update(ENEMY, R1, { uuid: R3, hp: 2 }), /cannot change the row identity/);
		await reject(raw.update(ENEMY, R2, { hp: 2 }), /has no row/);
		await reject(raw.delete(ENEMY, R2), /has no row/);
		await reject(raw.select(ENEMY, { limit: -1 }), /limit/);
		await reject(raw.select(ENEMY, { where: { nope: 1 } }), /no column 'nope'/);
		assert.deepStrictEqual((await raw.select(ENEMY)).map(row => [row.uuid, row.values[HP]]), [[R1, 1]]);
		assert.deepStrictEqual(await storage.database.all(`SELECT count(*) AS n FROM items__enemy`), [{ n: 1 }]);
	});

	test('a table missing its projection is rejected, and Raw Data follows Registry migrations by UUID', async () => {
		const { storage, raw } = await open();
		await raw.insert(ENEMY, { uuid: R1, hp: 3 });
		await storage.database.exec(`DROP TABLE items__player`);
		await assert.rejects(raw.select(PLAYER), /not projected/);
		await storage.database.exec(`CREATE TABLE items__player (uuid TEXT PRIMARY KEY NOT NULL, name TEXT, enemy TEXT)`);

		// Registry rename of a column keeps the Raw Data addressable by column UUID.
		const registry = new RegistryService(storage.database);
		const enemy = (await readTableRegistry(storage.database)).find(table => table.uuid === ENEMY)!;
		await registry.alter({ ...enemy, columns: enemy.columns.map(column => column.uuid === HP ? { ...column, name: 'health' } : column) });
		assert.deepStrictEqual((await raw.select(ENEMY))[0].values[HP], 3);
		await raw.update(ENEMY, R1, { health: 4 });
		assert.deepStrictEqual((await raw.select(ENEMY, { where: { [HP]: 4 } })).map(row => row.uuid), [R1]);
	});

	test('Raw Data rows join through the Logical JOIN without a physical FK', async () => {
		const { storage, raw } = await open();
		await raw.insert(ENEMY, { uuid: R1, hp: 9 });
		await raw.insert(PLAYER, { uuid: R2, name: 'alice', enemy: R1 });
		await raw.insert(PLAYER, { uuid: R3, name: 'bob' });
		const tables = await readTableRegistry(storage.database);
		const relation = createRelationRegistryEntry({ index: 0, main_table: PLAYER, relations: [{ join_table: ENEMY, main_column: { column_uuid: P_ENEMY }, join_column: { column_uuid: HP }, relation_type: RelationType.Left }] });
		// uuid-kind column joined to the enemy hp column is only a shape check; the query resolves on Registry physical names.
		const rows = await queryLogicalJoin(storage.database, generateLogicalJoinQuery(resolveRelation(relation, tables)));
		assert.deepStrictEqual(rows.map(row => row[0]?.uuid).sort(), [R2, R3]);
		assert.deepStrictEqual(await storage.database.all(`SELECT * FROM pragma_foreign_key_list('items__player')`), []);
	});
});
