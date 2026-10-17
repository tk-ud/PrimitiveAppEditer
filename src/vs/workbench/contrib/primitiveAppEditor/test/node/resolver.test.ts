/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - generic Resolver primitives over project.sqlite (resolver.operation)
 *  Specification SSOT: docs/primitive-app-editor/Resolver.md
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
import { FunctionBindingService, IFunctionBindingEntryInput, readFunctionBindings } from '../../common/functionBinding.js';
import { FunctionDependencyService, readFunctionDependencies } from '../../common/functionDependency.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { readRendererBindings, RendererBindingService, createRendererRegistryEntry, getRendererRegistryInsert } from '../../common/rendererRegistry.js';
import { createResolverPorts, defaultResolverMappingDefinition, generateResolverMapping, parseResolverMappingDefinition, Resolver, ResolverError, IResolverServices } from '../../common/resolver.js';
import { readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const ENEMY = '00000000-0000-4000-8000-0000000000a1';
const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const ELEMENT = '00000000-0000-4000-8000-0000000000e1';
const HP = '00000000-0000-4000-8000-0000000000c1';
const SPEED = '00000000-0000-4000-8000-0000000000c2';
const ELEM_COL = '00000000-0000-4000-8000-0000000000c3';
const NAME = '00000000-0000-4000-8000-0000000000c6';
const LEVEL = '00000000-0000-4000-8000-0000000000c7';
const R1 = '00000000-0000-4000-8000-0000000000b1';
const R2 = '00000000-0000-4000-8000-0000000000b2';
const FN = '00000000-0000-4000-8000-0000000000f1';
const SPRITE = '00000000-0000-4000-8000-0000000000f2';
const B1 = '00000000-0000-4000-8000-0000000000d1';
const B2 = '00000000-0000-4000-8000-0000000000d2';
const D1 = '00000000-0000-4000-8000-0000000000d3';
const RB1 = '00000000-0000-4000-8000-0000000000d4';
const REL = '00000000-0000-4000-8000-0000000000d5';
const NEW_COL = '00000000-0000-4000-8000-0000000000c9';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');
const col = (uuid: string, index: number, name: string, kind: TableColumnKind, extra: object = {}) => ({ uuid, index, name, kind, not_null: false, writable: true, searchable: true, ...extra });
const address = (column: string) => ({ table_uuid: ENEMY, row_uuid: R1, column_uuid: column });
const fnBinding = (uuid: string, index: number, inputs: Record<string, unknown> = { x: { source: 'time' } }): IFunctionBindingEntryInput => ({
	uuid, index, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' }, inputs: inputs as never, target: { address: address(HP), merge: { kind: 'overwrite' } },
});

suite('Primitive App Editor - generic Resolver primitives on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-resolver-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** An opened project with an EMPTY Registry: every definition below is created through the Resolver itself. */
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
		const services: IResolverServices = {
			database: storage.database,
			registry: new RegistryService(storage.database),
			rawData: new RawDataService(storage.database),
			functionBinding: new FunctionBindingService(storage.database, catalog, { now }),
			functionDependency: new FunctionDependencyService(storage.database, { now }),
			rendererBinding: new RendererBindingService(storage.database, { now }),
		};
		return { storage, services, resolver: new Resolver(services) };
	}

	async function seedDefinitions(resolver: Resolver) {
		await resolver.create({ target: { kind: 'enum' }, payload: { uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water' }] } });
		await resolver.create({
			target: { kind: 'table', uuid: ENEMY },
			payload: {
				index: 0, schema: LogicalNamespace.Items, name: 'enemy', label: 'Enemy', columns: [
					col(HP, 0, 'hp', TableColumnKind.Int, { not_null: true }),
					col(SPEED, 1, 'speed', TableColumnKind.Double),
					col(ELEM_COL, 2, 'element', TableColumnKind.Enum, { enum: ELEMENT }),
				],
			},
		});
		await resolver.create({ target: { kind: 'table' }, payload: { uuid: PLAYER, index: 1, schema: LogicalNamespace.Items, name: 'player', columns: [col(NAME, 0, 'name', TableColumnKind.Text), col(LEVEL, 1, 'level', TableColumnKind.Int)] } });
	}

	test('the nine Primitives dispatch Registry Definition operations to the Registry Service and project the Physical Schema', async () => {
		const { storage, resolver } = await open();
		await seedDefinitions(resolver);
		// create -> Registry Service -> Registry Mutation -> Physical Projection
		assert.deepStrictEqual((await readTableRegistry(storage.database)).map(table => table.name), ['enemy', 'player']);
		assert.ok(await storage.database.get(`SELECT 1 FROM sqlite_master WHERE name = 'items__enemy'`));

		// alter: Table Rename + Column Add / Rename / Kind-free Constraint Change + Column Drop, each through the Registry Service
		await resolver.alter({ target: { kind: 'table', uuid: ENEMY }, payload: { name: 'monster', label: 'Monster' } });
		await resolver.create({ target: { kind: 'column', uuid: NEW_COL }, address: { table_uuid: ENEMY }, payload: col(NEW_COL, 3, 'defense', TableColumnKind.Int) });
		await resolver.alter({ target: { kind: 'column', uuid: SPEED }, address: { table_uuid: ENEMY }, payload: { name: 'velocity' } });
		await resolver.alter({ target: { kind: 'column' }, address: { table_uuid: ENEMY, column_uuid: NEW_COL }, payload: { not_null: false, searchable: false } });
		const columns = (await storage.database.all(`PRAGMA table_info("items__monster")`)).map(info => info.name);
		assert.deepStrictEqual(columns, ['uuid', 'hp', 'velocity', 'element', 'defense']);
		await resolver.drop({ target: { kind: 'column', uuid: NEW_COL }, address: { table_uuid: ENEMY } });
		assert.ok(!(await storage.database.all(`PRAGMA table_info("items__monster")`)).some(info => info.name === 'defense'));

		// select of Registry Definitions
		const table = await resolver.select({ target: { kind: 'table', uuid: ENEMY } });
		assert.deepStrictEqual((table.result as { name: string }[]).map(entry => entry.name), ['monster']);
		assert.strictEqual(((await resolver.select({ target: { kind: 'table' } })).result as unknown[]).length, 2);
		assert.deepStrictEqual(((await resolver.select({ target: { kind: 'column' }, address: { table_uuid: ENEMY } })).result as { name: string }[]).map(c => c.name), ['hp', 'velocity', 'element']);
		assert.strictEqual(((await resolver.select({ target: { kind: 'enum', uuid: ELEMENT } })).result as { name: string }[])[0].name, 'element');

		// relation Registry Definition (Logical JOIN, no physical FK) through the Registry Service
		await resolver.create({ target: { kind: 'relation', uuid: REL }, payload: { index: 0, main_table: PLAYER, relations: [{ join_table: ENEMY, main_column: { column_uuid: LEVEL }, join_column: { column_uuid: HP }, relation_type: 'left' }] } });
		await resolver.alter({ target: { kind: 'relation', uuid: REL }, payload: { index: 3 } });
		assert.strictEqual(((await resolver.select({ target: { kind: 'relation', uuid: REL } })).result as { index: number }[])[0].index, 3);
		// the Registry Service cleans the Logical dependency of a dropped table
		await resolver.drop({ target: { kind: 'relation', uuid: REL } });
		assert.deepStrictEqual((await resolver.select({ target: { kind: 'relation' } })).result, []);

		// drop table -> Registry Service -> Definition Removal -> Physical Projection Removal
		await resolver.drop({ target: { kind: 'table', uuid: ENEMY } });
		assert.deepStrictEqual((await readTableRegistry(storage.database)).map(entry => entry.name), ['player']);
		assert.ok(!(await storage.database.get(`SELECT 1 FROM sqlite_master WHERE name = 'items__monster'`)));
		// no table references the enum any more, so the Registry Service drops it
		await resolver.drop({ target: { kind: 'enum', uuid: ELEMENT } });
		assert.deepStrictEqual((await resolver.select({ target: { kind: 'enum' } })).result, []);
	});

	test('insert / update / upsert / select / delete / truncate dispatch Raw Data from the Registry; truncate is not drop', async () => {
		const { storage, resolver } = await open();
		await seedDefinitions(resolver);

		const inserted = await resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 50, speed: 1.2, element: 'fire' } });
		assert.strictEqual((inserted.result as { uuid: string }).uuid, R1);
		await resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, payload: { uuid: R2, hp: 70, element: 'water' } });

		const updated = await resolver.update({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 45 } });
		assert.strictEqual((updated.result as { row: { values: Record<string, unknown> } }).row.values[HP], 45);

		// upsert: Conflict Identity = Row identity from the address; never guessed
		const again = await resolver.upsert({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 40 } });
		assert.strictEqual((again.result as { operation: string }).operation, 'update');
		const created = await resolver.upsert({ target: { kind: 'raw', uuid: ENEMY }, payload: { uuid: '00000000-0000-4000-8000-0000000000b3', hp: 1 } });
		assert.strictEqual((created.result as { operation: string }).operation, 'insert');
		await assert.rejects(resolver.upsert({ target: { kind: 'raw', uuid: ENEMY }, payload: { hp: 2 } }), /Conflict Identity/);

		const selected = await resolver.select({ target: { kind: 'raw', uuid: ENEMY }, payload: { where: { element: 'fire' }, resolveLabels: true } });
		const rows = selected.result as { uuid: string; labels: Record<string, string> }[];
		assert.deepStrictEqual(rows.map(row => row.uuid), [R1]);
		assert.deepStrictEqual(rows[0].labels, { [ELEM_COL]: 'Fire' });
		assert.strictEqual(((await resolver.select({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R2 } })).result as unknown[]).length, 1);

		await resolver.delete({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R2 } });
		assert.strictEqual(((await resolver.select({ target: { kind: 'raw', uuid: ENEMY } })).result as unknown[]).length, 2);
		const truncated = await resolver.truncate({ target: { kind: 'raw', uuid: ENEMY } });
		assert.strictEqual(truncated.result, 2);
		assert.strictEqual((await readTableRegistry(storage.database)).length, 2, 'truncate != Registry Drop');
		assert.ok(await storage.database.get(`SELECT 1 FROM sqlite_master WHERE name = 'items__enemy'`));
	});

	test('Function / Dependency / Renderer Binding Instances dispatch through the same Primitives', async () => {
		const { storage, resolver } = await open();
		await seedDefinitions(resolver);
		const fn = createFunctionRegistryEntry({ uuid: FN, index: 0, name: 'identity', executor: 'math.identity', input: [{ name: 'x', kind: 'double' }], constructor: [], parameters: [], output: { kind: 'double' } }, undefined, now);
		await storage.database.run(getFunctionRegistryInsert(fn, catalog).sql, getFunctionRegistryInsert(fn, catalog).params);
		const sprite = createRendererRegistryEntry({ uuid: SPRITE, index: 0, name: 'sprite', label: 'Sprite', executor: 'renderer.sprite', inputs: [{ name: 'position_x', kind: 'double' }] }, undefined, now);
		await storage.database.run(getRendererRegistryInsert(sprite).sql, getRendererRegistryInsert(sprite).params);

		// insert (UI Binding Save) with the uuid given by target
		await resolver.insert({ target: { kind: 'function_binding', uuid: B1 }, payload: fnBinding(B1, 0) });
		await resolver.insert({ target: { kind: 'function_binding' }, payload: fnBinding(B2, 1, { x: { source: 'function_output', function_binding_uuid: B1 } }) });
		assert.deepStrictEqual((await readFunctionBindings(storage.database)).map(entry => entry.uuid), [B1, B2]);
		await assert.rejects(resolver.insert({ target: { kind: 'function_binding', uuid: B2 }, payload: fnBinding(B1, 0) }), /Ambiguous Target/);

		await resolver.insert({ target: { kind: 'function_dependency' }, payload: { uuid: D1, source_binding: { uuid: B1 }, target_binding: { uuid: B2 }, target_input: { name: 'x' } } });
		assert.strictEqual((await readFunctionDependencies(storage.database)).length, 1);

		// update (Function Parameter / Value Change) and upsert
		const updated = await resolver.update({ target: { kind: 'function_binding', uuid: B1 }, payload: { index: 5 } });
		assert.strictEqual((updated.result as { binding: { index: number } }).binding.index, 5);
		const upserted = await resolver.upsert({ target: { kind: 'function_binding', uuid: B1 }, payload: fnBinding(B1, 2) });
		assert.strictEqual((upserted.result as { operation: string }).operation, 'update');

		await resolver.insert({ target: { kind: 'renderer_binding', uuid: RB1 }, payload: { renderer: { uuid: SPRITE }, bindings: { position_x: { address: address(HP) } } } });
		const display = await resolver.select({ target: { kind: 'renderer_binding', uuid: RB1 }, payload: { resolveDisplay: true } });
		assert.strictEqual((display.result as { display: { renderer: string } }[])[0].display.renderer, 'Sprite');
		await resolver.update({ target: { kind: 'renderer_binding', uuid: RB1 }, payload: { bindings: { position_x: { address: address(SPEED) } } } });
		assert.strictEqual((await readRendererBindings(storage.database)).length, 1);

		// select with Result Mapping (UUID -> name / label)
		const bound = await resolver.select({ target: { kind: 'function_binding' }, payload: { resolveDisplay: true, where: { function_uuid: FN } } });
		assert.strictEqual((bound.result as { display: { function: string } }[])[0].display.function, 'identity');

		// delete (UI Binding Delete): Edge first (it would otherwise reference a deleted binding), then bindings
		await resolver.delete({ target: { kind: 'function_dependency', uuid: D1 } });
		await resolver.delete({ target: { kind: 'function_binding', uuid: B2 } });
		await resolver.delete({ target: { kind: 'renderer_binding', uuid: RB1 } });
		assert.deepStrictEqual((await readFunctionBindings(storage.database)).map(entry => entry.uuid), [B1]);
		assert.strictEqual((await readFunctionDependencies(storage.database)).length, 0);
		assert.strictEqual((await readRendererBindings(storage.database)).length, 0);
	});

	test('Registry Definition operations are never Raw Data / Binding operations (and vice versa)', async () => {
		const { storage, resolver } = await open();
		await seedDefinitions(resolver);
		const before = JSON.stringify(await readTableRegistry(storage.database));
		const reject = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: Error) => error instanceof ResolverError && pattern.test(error.message));
		await reject(resolver.insert({ target: { kind: 'table' }, payload: { index: 5, schema: 'items', name: 'x', columns: [] } }), /not a Registry Definition operation/);
		await reject(resolver.update({ target: { kind: 'table', uuid: ENEMY }, payload: { name: 'x' } }), /not a Registry Definition operation/);
		await reject(resolver.delete({ target: { kind: 'table', uuid: ENEMY } }), /not a Registry Definition operation/);
		await reject(resolver.truncate({ target: { kind: 'table', uuid: ENEMY } }), /not a Registry Definition operation/);
		await reject(resolver.upsert({ target: { kind: 'enum', uuid: ELEMENT }, payload: {} }), /not a Registry Definition operation/);
		await reject(resolver.create({ target: { kind: 'raw', uuid: ENEMY }, payload: { hp: 1 } }), /Raw Data \/ Binding/);
		await reject(resolver.alter({ target: { kind: 'function_binding', uuid: B1 }, payload: {} }), /Raw Data \/ Binding/);
		await reject(resolver.drop({ target: { kind: 'raw', uuid: ENEMY } }), /Raw Data \/ Binding/);
		await reject(resolver.update({ target: { kind: 'function_dependency', uuid: D1 }, payload: {} }), /not an operation of kind/);
		assert.strictEqual(JSON.stringify(await readTableRegistry(storage.database)), before);
	});

	test('Missing Definition / Ambiguous Target / non-UUID identities are rejected, nothing is completed or guessed', async () => {
		const { storage, resolver } = await open();
		await seedDefinitions(resolver);
		const reject = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: Error) => pattern.test(error.message));
		await reject(resolver.resolve({ operation: 'merge', target: { kind: 'table' } }), /operation must be one of/);
		await reject(resolver.select({ target: { kind: 'enemy' } }), /not defined by the Mapping/);
		await reject(resolver.select({ target: {} }), /requires a kind or a uuid/);
		await reject(resolver.select({ target: { kind: 'table', uuid: 'enemy' } }), /must be a UUID/);
		await reject(resolver.select({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: 'Enemy 1' } }), /must be a UUID/);
		await reject(resolver.select({ target: { kind: 'table', uuid: MISSING } }), /Missing Definition/);
		await reject(resolver.alter({ target: { kind: 'table', uuid: MISSING }, payload: { name: 'x' } }), /Missing Definition/);
		await reject(resolver.alter({ target: { kind: 'table', uuid: ENEMY }, payload: {} }), /at least one change/);
		await reject(resolver.drop({ target: { kind: 'table', uuid: MISSING } }), /no table_registry entry|Missing|does not exist|has no/);
		await reject(resolver.insert({ target: { kind: 'raw', uuid: MISSING }, payload: { hp: 1 } }), /Missing Definition/);
		await reject(resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, address: { table_uuid: PLAYER }, payload: { hp: 1 } }), /Ambiguous Target/);
		await reject(resolver.update({ target: { kind: 'raw', uuid: ENEMY }, payload: { hp: 1 } }), /address.row_uuid must be a UUID/);
		await reject(resolver.update({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 1 } }), /has no row/);
		await reject(resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, payload: 'hp' }), /payload must be an object/);
		await reject(resolver.alter({ target: { kind: 'column', uuid: MISSING }, address: { table_uuid: ENEMY }, payload: { name: 'x' } }), /Missing Definition/);
		await reject(resolver.alter({ target: { kind: 'column', uuid: HP }, address: { table_uuid: ENEMY, column_uuid: SPEED }, payload: { name: 'x' } }), /Ambiguous Target/);
		await reject(resolver.create({ target: { kind: 'column' }, payload: col(NEW_COL, 9, 'x', TableColumnKind.Int) }), /address.table_uuid must be a UUID/);

		// Kind from the UUID alone: a table uuid is both the Registry Definition and the Raw Data target for select -> ambiguous; an enum uuid is unique
		await reject(resolver.select({ target: { uuid: ENEMY } }), /ambiguous for 'select': table, raw/);
		assert.strictEqual(((await resolver.select({ target: { uuid: ELEMENT } })).result as { name: string }[])[0].name, 'element');
		assert.strictEqual((await resolver.alter({ target: { uuid: ELEMENT }, payload: { label: 'Element' } })).kind, 'enum');
		await reject(resolver.drop({ target: { uuid: ELEMENT } }), /referenced by table 'enemy'/);
		await resolver.drop({ target: { kind: 'table', uuid: ENEMY } });
		assert.strictEqual((await resolver.drop({ target: { uuid: ELEMENT } })).kind, 'enum', 'unreferenced enum');
		await reject(resolver.drop({ target: { uuid: MISSING } }), /Missing Definition/);
		assert.strictEqual((await readTableRegistry(storage.database)).length, 1);
	});

	test('a failed dispatch writes nothing (one Service transaction)', async () => {
		const { storage, resolver } = await open();
		await seedDefinitions(resolver);
		await resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 1 } });
		await assert.rejects(resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 2 } }), /already has a row/);
		await assert.rejects(resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, payload: { hp: 'x' } }), /kind 'int'/);
		assert.deepStrictEqual(await storage.database.all(`SELECT hp FROM items__enemy`), [{ hp: 1 }]);
		// Registry Mutation rejected by the Registry Service (existing data invalid for the NEW definition) leaves Registry and Physical Schema untouched
		await assert.rejects(resolver.alter({ target: { kind: 'column', uuid: HP }, address: { table_uuid: ENEMY }, payload: { kind: 'bool' } }), /migration|not a value|bool/i);
		assert.strictEqual((await readTableRegistry(storage.database)).find(table => table.uuid === ENEMY)!.columns.find(column => column.uuid === HP)!.kind, 'int');
		assert.deepStrictEqual(await storage.database.all(`SELECT hp FROM items__enemy`), [{ hp: 1 }]);
	});

	test('Dynamic Generation: the Mapping is derived from a Structured Definition and cannot redefine semantics', async () => {
		const { services } = await open();
		const ports = createResolverPorts(services);
		const reject = (definition: unknown, pattern: RegExp) => assert.throws(() => generateResolverMapping(parseResolverMappingDefinition(definition), ports), pattern);

		// the default definition is plain data that round-trips through JSON (YAML-equivalent)
		const roundTripped = parseResolverMappingDefinition(JSON.parse(JSON.stringify(defaultResolverMappingDefinition)));
		assert.deepStrictEqual([...generateResolverMapping(roundTripped, ports).keys()], defaultResolverMappingDefinition.kinds.map(entry => entry.kind));

		// a derived, narrower Mapping removes dispatch: Raw Data becomes read-only
		const readOnly = new Resolver(services, { definition: { kinds: [{ kind: 'raw', authority: 'data', port: 'raw', operations: ['select'] }] } });
		await assert.rejects(readOnly.insert({ target: { kind: 'raw', uuid: ENEMY }, payload: {} }), /not an operation of kind 'raw'/);
		await assert.rejects(readOnly.create({ target: { kind: 'table' }, payload: {} }), /not defined by the Mapping/);

		reject({ kinds: [{ kind: 'a', authority: 'registry', port: 'table', operations: ['insert'] }] }, /belongs to the Raw Data \/ Binding side/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'raw', operations: ['create'] }] }, /belongs to the Registry Service side/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'raw', operations: ['drop'] }] }, /belongs to the Registry Service side/);
		reject({ kinds: [{ kind: 'a', authority: 'registry', port: 'table', operations: ['truncate'] }] }, /belongs to the Raw Data/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'function_dependency', operations: ['update'] }] }, /does not implement 'update'/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'nope', operations: ['select'] }] }, /no port 'nope'/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'raw', operations: ['merge'] }] }, /not a Resolver Operation/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'raw', operations: ['select', 'select'] }] }, /more than once/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'raw', operations: ['select'] }, { kind: 'a', authority: 'data', port: 'raw', operations: ['select'] }] }, /defined more than once/);
		reject({ kinds: [{ kind: 'a', authority: 'other', port: 'raw', operations: ['select'] }] }, /authority must be/);
		reject({ kinds: 'x' }, /`kinds` array/);
		reject({ kinds: [{ kind: 'a', authority: 'data', port: 'toString', operations: ['select'] }] }, /no port 'toString'/);
	});

	test('the default Mapping names only generic Core kinds; Application tables exist only as Registry data', async () => {
		const { resolver } = await open();
		assert.deepStrictEqual([...resolver.mapping.keys()], ['table', 'column', 'enum', 'relation', 'raw', 'function_binding', 'function_dependency', 'renderer_binding']);
		// a fresh project resolves nothing Application-specific: the Registry is empty until a request creates a definition
		assert.deepStrictEqual((await resolver.select({ target: { kind: 'table' } })).result, []);
		await assert.rejects(resolver.select({ target: { kind: 'raw', uuid: ENEMY } }), /Missing Definition/);
	});
});
