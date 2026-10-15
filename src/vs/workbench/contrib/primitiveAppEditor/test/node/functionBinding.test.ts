/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_binding (binding.function)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (19. Function Binding, 23. Persistent Address)
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
import { FunctionBindingError, FunctionBindingService, IFunctionBindingEntryInput, readFunctionBindings } from '../../common/functionBinding.js';
import { createFunctionExecutorCatalog, createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RegistryService } from '../../common/registryService.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const SPEED = '00000000-0000-4000-8000-0000000000c2';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const B1 = '00000000-0000-4000-8000-0000000000d1';
const B2 = '00000000-0000-4000-8000-0000000000d2';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const catalog = createFunctionExecutorCatalog(['math.accumulate']);
const now = () => new Date('2026-10-15T00:00:00Z');
const address = (column: string) => ({ table_uuid: PLAYER, row_uuid: ROW, column_uuid: column });

function binding(extra: Record<string, unknown> = {}): IFunctionBindingEntryInput {
	return {
		uuid: B1,
		index: 0,
		function: { uuid: FN },
		constructor: { subtract_b: true },
		execution: { kind: 'tick' },
		inputs: { x: { source: 'state', address: address(FATIGUE) } },
		parameters: { a: { source: 'constant', value: 0.1 }, b: { source: 'state', address: address(SPEED) } },
		target: { address: address(FATIGUE), merge: { kind: 'overlay' } },
		...extra,
	} as IFunctionBindingEntryInput;
}

suite('Primitive App Editor - function_binding on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-function-binding-'));
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
		const column = (uuid: string, index: number, name: string, label?: string) => ({ uuid, index, name, label, kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true });
		await new RegistryService(storage.database).create({
			uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', label: 'Player',
			columns: [column(FATIGUE, 0, 'fatigue', 'Fatigue'), column(SPEED, 1, 'speed')],
		});
		const fn = createFunctionRegistryEntry({
			uuid: FN, index: 0, name: 'accumulate', executor: 'math.accumulate',
			input: [{ name: 'x', kind: 'double' }],
			constructor: [{ name: 'subtract_b', kind: 'bool' }],
			parameters: [{ name: 'a', kind: 'double' }, { name: 'b', kind: 'double', default: 0 }],
			output: { kind: 'double' },
		}, undefined, now);
		const insert = getFunctionRegistryInsert(fn, catalog);
		await storage.database.run(insert.sql, insert.params);
		return { storage, service: new FunctionBindingService(storage.database, catalog, { now }) };
	}

	test('insert persists UUID-only addresses and select reads them back; display text is resolved from table_registry, never stored', async () => {
		const { storage, service } = await open();
		const inserted = await service.insert(binding());
		assert.strictEqual(inserted.uuid, B1);

		const stored = await storage.database.get(`SELECT "target", "inputs" FROM binding__function_binding`);
		assert.deepStrictEqual(JSON.parse(String(stored?.target)), { address: address(FATIGUE), merge: { kind: 'overlay' } });
		assert.ok(!/Player|Fatigue/.test(JSON.stringify(stored)), 'no display text is stored');

		const [row] = await service.select({ where: { function_uuid: FN }, resolveDisplay: true });
		assert.deepStrictEqual(row.binding, inserted.binding);
		assert.strictEqual(row.display?.function, 'accumulate');
		assert.strictEqual(row.display?.target?.text, 'Player\n└─ Fatigue');
		assert.deepStrictEqual(row.display?.inputs.x, { table: 'Player', column: 'Fatigue', text: 'Player\n└─ Fatigue' });
		assert.deepStrictEqual(Object.keys(row.display?.parameters ?? {}), ['b']);

	});

	test('bindings persist across Open and are read in index order', async () => {
		const { storage, service } = await open();
		await service.insert(binding({ uuid: B2, index: 1 }));
		await service.insert(binding({ uuid: B1, index: 0 }));
		assert.deepStrictEqual((await readFunctionBindings(storage.database)).map(entry => entry.uuid), [B1, B2]);
	});

	test('Registry Resolve rejects unknown functions, unbound inputs, unknown members and unknown addresses', async () => {
		const { service } = await open();
		await assert.rejects(service.insert(binding({ function: { uuid: MISSING } })), /no function .*Missing Definition/);
		await assert.rejects(service.insert(binding({ inputs: {} })), /input 'x' .* is not bound/);
		await assert.rejects(service.insert(binding({ inputs: { x: { source: 'time' }, y: { source: 'time' } } })), /has no input 'y'/);
		await assert.rejects(service.insert(binding({ constructor: {} })), /constructor 'subtract_b' .* has no default/);
		await assert.rejects(service.insert(binding({ parameters: { b: { source: 'constant', value: 1 } } })), /parameters 'a' .* has no default/);
		await assert.rejects(service.insert(binding({ parameters: { a: { source: 'time' }, z: { source: 'time' } } })), /no parameters 'z'/);
		await assert.rejects(service.insert(binding({ target: { address: { ...address(FATIGUE), table_uuid: MISSING }, merge: { kind: 'overlay' } } })), /table .* is not in table_registry/);
		await assert.rejects(service.insert(binding({ target: { address: address(MISSING), merge: { kind: 'overlay' } } })), /is not a column of table 'player'/);
		assert.deepStrictEqual(await service.select(), []);
	});

	test('insert rejects a duplicate uuid; update changes concrete values only; upsert resolves the uuid Conflict Identity', async () => {
		const { service } = await open();
		await service.insert(binding());
		await assert.rejects(service.insert(binding()), /already exists/);

		const updated = await service.update(B1, { parameters: { a: { source: 'constant', value: 0.5 } }, execution: { kind: 'event' }, index: 3 });
		assert.strictEqual(updated.binding.parameters.a.value, 0.5);
		assert.strictEqual(updated.binding.execution.kind, 'event');
		assert.strictEqual(updated.binding.created_at, '2026-10-15T00:00:00.000Z');
		assert.deepStrictEqual(updated.binding.inputs, (await service.select())[0].binding.inputs);
		await assert.rejects(service.update(B1, { function: { uuid: FN } } as never), /cannot change 'function'/);
		await assert.rejects(service.update(B1, {}), /at least one value/);
		await assert.rejects(service.update(B2, { index: 1 }), /does not exist/);
		await assert.rejects(service.update(B1, { parameters: {} }), /parameters 'a'/);

		const again = await service.upsert(binding({ index: 9 }));
		assert.strictEqual(again.operation, 'update');
		assert.strictEqual(again.binding.index, 9);
		const created = await service.upsert(binding({ uuid: B2 }));
		assert.strictEqual(created.operation, 'insert');
		await assert.rejects(service.upsert(binding({ uuid: undefined })), /Conflict Identity/);
		assert.strictEqual((await service.select()).length, 2);
	});

	test('select filters by uuid / execution kind and delete removes only the binding', async () => {
		const { storage, service } = await open();
		await service.insert(binding());
		await service.insert(binding({ uuid: B2, index: 1, execution: { kind: 'input' } }));
		assert.deepStrictEqual((await service.select({ where: { execution_kind: 'input' } })).map(row => row.binding.uuid), [B2]);
		assert.deepStrictEqual((await service.select({ where: { uuid: B1 }, limit: 1 })).map(row => row.binding.uuid), [B1]);
		await assert.rejects(service.select({ where: { name: 'x' } as never }), FunctionBindingError);

		const deleted = await service.delete(B1);
		assert.strictEqual(deleted.uuid, B1);
		await assert.rejects(service.delete(B1), /does not exist/);
		assert.deepStrictEqual((await service.select()).map(row => row.binding.uuid), [B2]);
		assert.strictEqual((await storage.database.get(`SELECT COUNT(*) AS n FROM registry__function_registry`))?.n, 1);
	});

	test('a Function Definition that no longer exists in Code rejects every dispatch (Registry = Authority)', async () => {
		const { storage } = await open();
		const strict = new FunctionBindingService(storage.database, createFunctionExecutorCatalog([]), { now });
		await assert.rejects(strict.insert(binding()), /executor 'math.accumulate' does not exist in Code/);
	});
});
