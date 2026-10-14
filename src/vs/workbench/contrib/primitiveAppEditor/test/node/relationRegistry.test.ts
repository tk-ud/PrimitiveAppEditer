/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - relation_registry and logical join resolution (registry.relation)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (10. relation_registry, 10. Resolve, 10. Validate)
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
import { IProjectSqliteStatements, LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import {
	generateLogicalJoinQuery,
	getRelationRegistryInsert,
	createRelationRegistryEntry,
	IRelationRegistryEntry,
	IRelationRegistryEntryInput,
	queryLogicalJoin,
	readRelationRegistry,
	RelationRegistryError,
	RelationType,
	resolveRelation,
	validateRelationReferences,
} from '../../common/relationRegistry.js';
import { RegistryService, RegistryServiceError } from '../../common/registryService.js';
import { ITableRegistryEntry, ITableRegistryEntryInput, readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const GUILD = '00000000-0000-4000-8000-0000000000a2';
const ITEM = '00000000-0000-4000-8000-0000000000a3';
const PLAYER_NAME = '00000000-0000-4000-8000-0000000000c1';
const PLAYER_GUILD = '00000000-0000-4000-8000-0000000000c2';
const GUILD_ID = '00000000-0000-4000-8000-0000000000c3';
const GUILD_NAME = '00000000-0000-4000-8000-0000000000c4';
const ITEM_OWNER = '00000000-0000-4000-8000-0000000000c5';
const PLAYER_GUILDS = '00000000-0000-4000-8000-0000000000f1';
const ITEM_OWNERS = '00000000-0000-4000-8000-0000000000f2';
const MISSING = '00000000-0000-4000-8000-0000000000f9';

const ROW_ALICE = '00000000-0000-4000-8000-0000000000b1';
const ROW_BOB = '00000000-0000-4000-8000-0000000000b2';
const ROW_RED = '00000000-0000-4000-8000-0000000000b3';
const ROW_BLUE = '00000000-0000-4000-8000-0000000000b4';
const RED_ID = '00000000-0000-4000-8000-0000000000d1';
const BLUE_ID = '00000000-0000-4000-8000-0000000000d2';
const NONE_ID = '00000000-0000-4000-8000-0000000000d3';

function textColumn(uuid: string, index: number, name: string, kind = TableColumnKind.Text) {
	return { uuid, index, name, kind, not_null: false, writable: true, searchable: true };
}

const playerTable: ITableRegistryEntryInput = { uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [textColumn(PLAYER_NAME, 0, 'name'), textColumn(PLAYER_GUILD, 1, 'guild', TableColumnKind.Uuid)] };
const guildTable: ITableRegistryEntryInput = { uuid: GUILD, index: 1, schema: LogicalNamespace.Items, name: 'guild', columns: [textColumn(GUILD_ID, 0, 'id', TableColumnKind.Uuid), textColumn(GUILD_NAME, 1, 'name')] };
const itemTable: ITableRegistryEntryInput = { uuid: ITEM, index: 2, schema: LogicalNamespace.Items, name: 'item', columns: [textColumn(ITEM_OWNER, 0, 'owner', TableColumnKind.Uuid)] };

function playerGuilds(relationType: RelationType): IRelationRegistryEntryInput {
	return { uuid: PLAYER_GUILDS, index: 0, main_table: PLAYER, relations: [{ join_table: GUILD, main_column: { column_uuid: PLAYER_GUILD }, join_column: { column_uuid: GUILD_ID }, relation_type: relationType }] };
}

suite('Primitive App Editor - relation_registry on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-relation-registry-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Opens the project through the lifecycle; `Registry Load` reads table_registry and relation_registry and validates the relations. */
	async function open(): Promise<{ storage: ProjectSqliteStorage; tables: readonly ITableRegistryEntry[]; relations: readonly IRelationRegistryEntry[] }> {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		let tables: readonly ITableRegistryEntry[] = [];
		let relations: readonly IRelationRegistryEntry[] = [];
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: async () => {
				tables = await readTableRegistry(storage.database);
				relations = await readRelationRegistry(storage.database);
				validateRelationReferences(relations, tables);
			},
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		return { storage, tables, relations };
	}

	async function seedRows(statements: IProjectSqliteStatements): Promise<void> {
		await statements.run(`INSERT INTO "items__guild" ("uuid", "id", "name") VALUES (?, ?, 'red'), (?, ?, 'blue')`, [ROW_RED, RED_ID, ROW_BLUE, BLUE_ID]);
		await statements.run(`INSERT INTO "items__player" ("uuid", "name", "guild") VALUES (?, 'alice', ?), (?, 'bob', ?)`, [ROW_ALICE, RED_ID, ROW_BOB, NONE_ID]);
	}

	/** Logical JOIN result as `[player row uuid, guild name]` pairs (sorted); `-` for an unmatched side. */
	async function joined(statements: IProjectSqliteStatements, relation: IRelationRegistryEntry): Promise<string[][]> {
		const query = generateLogicalJoinQuery(resolveRelation(relation, await readTableRegistry(statements)));
		const rows = await queryLogicalJoin(statements, query);
		return rows.map(row => [row[0]?.uuid ?? '-', String(row[1]?.values[GUILD_NAME] ?? '-')]).sort((a, b) => a.join().localeCompare(b.join()));
	}

	test('relation_registry mutations through the Registry Service are validated, loaded in Registry order and resolved into Logical JOINs', async () => {
		const first = await open();
		assert.deepStrictEqual(first.relations, []);
		const service = new RegistryService(first.storage.database);
		await service.create(playerTable);
		await service.create(guildTable);
		await service.create(itemTable);
		await seedRows(first.storage.database);

		// Validate: every reference must exist in table_registry; a rejected mutation writes nothing.
		const left = playerGuilds(RelationType.Left);
		const reject = (input: IRelationRegistryEntryInput, message: RegExp) => assert.rejects(service.createRelation(input), (error: Error) => error instanceof RegistryServiceError && message.test(error.message));
		await reject({ ...left, main_table: MISSING }, /main_table '.*' does not exist in table_registry/);
		await reject({ ...left, relations: [{ ...left.relations[0], join_table: MISSING }] }, /join_table '.*' does not exist in table_registry/);
		await reject({ ...left, relations: [{ ...left.relations[0], main_column: { column_uuid: ITEM_OWNER } }] }, /main_column '.*' does not exist in main_table 'player'/);
		await reject({ ...left, relations: [{ ...left.relations[0], join_column: { column_uuid: MISSING } }] }, /join_column '.*' does not exist in join_table 'guild'/);
		await reject({ ...left, relations: [{ ...left.relations[0], relation_type: 'outer' }] }, /relation_type must be inner \| left \| right \| full/);
		assert.deepStrictEqual(await readRelationRegistry(first.storage.database), []);

		const itemOwners = (await service.createRelation({ uuid: ITEM_OWNERS, index: 1, main_table: ITEM, relations: [{ join_table: PLAYER, main_column: { column_uuid: ITEM_OWNER }, join_column: { column_uuid: PLAYER_NAME }, relation_type: RelationType.Inner }] })).entry!;
		const created = (await service.createRelation(left)).entry!;
		await assert.rejects(service.createRelation(left), /duplicate relation uuid/);
		await assert.rejects(service.alterRelation({ ...left, uuid: MISSING }), /relation_registry has no entry/);

		// SQLite FK = none: neither relation_registry nor the joined tables carry a physical foreign key.
		for (const table of ['registry__relation_registry', 'items__player', 'items__guild', 'items__item']) {
			assert.deepStrictEqual(await first.storage.database.all(`SELECT * FROM pragma_foreign_key_list(?)`, [table]), [], table);
		}

		// relation_type decides the Logical JOIN: left keeps unmatched main rows.
		assert.deepStrictEqual(await joined(first.storage.database, created), [[ROW_ALICE, 'red'], [ROW_BOB, '-']]);
		const altered = (await service.alterRelation({ ...playerGuilds(RelationType.Full), uuid: PLAYER_GUILDS })).entry!;
		assert.strictEqual(altered.created_at, created.created_at, 'UPDATE keeps created_at');
		await first.storage.close();

		// Registry Load on the next Open: same identities, Registry order, references validated.
		const second = await open();
		assert.deepStrictEqual(second.relations, [altered, itemOwners]);
		const db = second.storage.database;
		assert.deepStrictEqual(await joined(db, altered), [['-', 'blue'], [ROW_ALICE, 'red'], [ROW_BOB, '-']]);
		const typed = async (relationType: RelationType) => joined(db, (await new RegistryService(db).alterRelation({ ...playerGuilds(relationType), uuid: PLAYER_GUILDS })).entry!);
		assert.deepStrictEqual(await typed(RelationType.Inner), [[ROW_ALICE, 'red']]);
		assert.deepStrictEqual(await typed(RelationType.Right), [['-', 'blue'], [ROW_ALICE, 'red']]);

		// A table rename keeps the Relation (references are UUIDs); the Logical JOIN follows the new physical name.
		const service2 = new RegistryService(db);
		await service2.alter({ ...guildTable, uuid: GUILD, name: 'clan', created_at: undefined });
		assert.deepStrictEqual(await joined(db, (await readRelationRegistry(db))[0]), [['-', 'blue'], [ROW_ALICE, 'red']]);

		await service2.dropRelation(ITEM_OWNERS);
		await assert.rejects(service2.dropRelation(ITEM_OWNERS), /relation_registry has no entry/);
		assert.deepStrictEqual((await readRelationRegistry(db)).map(entry => entry.uuid), [PLAYER_GUILDS]);
	});

	test('a table UPDATE deleting a referenced column is rejected; a table DELETE runs Logical dependency cleanup in the same transaction', async () => {
		const { storage } = await open();
		const db = storage.database;
		const service = new RegistryService(db);
		await service.create(playerTable);
		await service.create(guildTable);
		await service.create(itemTable);
		await service.createRelation(playerGuilds(RelationType.Left));
		await service.createRelation({ uuid: ITEM_OWNERS, index: 1, main_table: ITEM, relations: [{ join_table: PLAYER, main_column: { column_uuid: ITEM_OWNER }, join_column: { column_uuid: PLAYER_NAME }, relation_type: RelationType.Inner }, { join_table: GUILD, main_column: { column_uuid: ITEM_OWNER }, join_column: { column_uuid: GUILD_ID }, relation_type: RelationType.Left }] });
		const relationsBefore = await readRelationRegistry(db);
		const tablesBefore = await readTableRegistry(db);

		await assert.rejects(service.alter({ ...guildTable, uuid: GUILD, columns: guildTable.columns.filter(column => column.uuid !== GUILD_ID) }),
			(error: Error) => error instanceof RegistryServiceError && /join_column '.*' does not exist in join_table 'guild'/.test(error.message));
		assert.deepStrictEqual(await readTableRegistry(db), tablesBefore);
		assert.deepStrictEqual(await readRelationRegistry(db), relationsBefore);

		// A failing commit rolls back the drop together with the relation_registry cleanup.
		const failing = new RegistryService({
			transaction: work => db.transaction(async statements => {
				await work(statements);
				throw new Error('commit failure');
			}),
		});
		await assert.rejects(failing.drop(GUILD), /commit failure/);
		assert.deepStrictEqual(await readRelationRegistry(db), relationsBefore);

		// DROP guild: the relation whose main_table is guild would be deleted; joins on guild are removed.
		await service.drop(GUILD);
		const [playerRelation, itemRelation] = await readRelationRegistry(db);
		assert.deepStrictEqual(playerRelation.relations, []);
		assert.deepStrictEqual(itemRelation.relations.map(relation => relation.join_table), [PLAYER]);
		// DROP player: relations whose main_table is player are deleted.
		await service.drop(PLAYER);
		const remaining = await readRelationRegistry(db);
		assert.deepStrictEqual(remaining.map(entry => entry.uuid), [ITEM_OWNERS]);
		assert.deepStrictEqual(remaining[0].relations, []);
		validateRelationReferences(remaining, await readTableRegistry(db));
	});

	test('Registry Load rejects a stored relation whose reference does not resolve', async () => {
		const { storage } = await open();
		const service = new RegistryService(storage.database);
		await service.create(playerTable);
		const dangling = createRelationRegistryEntry(playerGuilds(RelationType.Left));
		const insert = getRelationRegistryInsert(dangling);
		await storage.database.run(insert.sql, insert.params);
		await storage.close();
		await assert.rejects(open(), (error: Error) => error instanceof RelationRegistryError && /join_table '.*' does not exist in table_registry/.test(error.message));
	});
});
