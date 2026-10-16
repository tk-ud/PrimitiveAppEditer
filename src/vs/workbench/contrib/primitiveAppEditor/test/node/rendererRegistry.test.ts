/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - renderer_registry / renderer_binding (renderer.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (27. Renderer, 28. renderer_registry / Binding)
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
import { createRendererRegistryEntry, getRendererRegistryInsert, IRendererBindingEntryInput, readRendererBindings, readRendererRegistry, RendererBindingError, RendererBindingService } from '../../common/rendererRegistry.js';
import { RegistryService } from '../../common/registryService.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const POS_X = '00000000-0000-4000-8000-0000000000c1';
const POS_Y = '00000000-0000-4000-8000-0000000000c2';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const SPRITE = '00000000-0000-4000-8000-0000000000e1';
const R1 = '00000000-0000-4000-8000-0000000000d1';
const R2 = '00000000-0000-4000-8000-0000000000d2';
const ASSET = '00000000-0000-4000-8000-0000000000a5';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const now = () => new Date('2026-10-15T00:00:00Z');
const address = (column: string) => ({ table_uuid: PLAYER, row_uuid: ROW, column_uuid: column });

function binding(extra: Record<string, unknown> = {}): IRendererBindingEntryInput {
	return {
		uuid: R1,
		renderer: { uuid: SPRITE },
		bindings: { position_x: { address: address(POS_X) }, position_y: { address: address(POS_Y) }, asset: { asset_uuid: ASSET } },
		...extra,
	} as IRendererBindingEntryInput;
}

suite('Primitive App Editor - renderer_registry / renderer_binding on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-renderer-registry-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	async function open(rendererScan?: (storage: ProjectSqliteStorage) => Promise<void>) {
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
			registryLoad: async () => { await rendererScan?.(storage); },
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		return storage;
	}

	async function seed() {
		const storage = await open();
		const column = (uuid: string, index: number, name: string, label?: string) => ({ uuid, index, name, label, kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true });
		await new RegistryService(storage.database).create({
			uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', label: 'Player',
			columns: [column(POS_X, 0, 'x', 'X'), column(POS_Y, 1, 'y')],
		});
		const sprite = createRendererRegistryEntry({
			uuid: SPRITE, index: 0, name: 'sprite', label: 'Sprite', executor: 'renderer.sprite',
			inputs: [{ name: 'position_x', kind: 'double' }, { name: 'position_y', kind: 'double' }, { name: 'asset', kind: 'asset' }],
		}, undefined, now);
		const insert = getRendererRegistryInsert(sprite);
		await storage.database.run(insert.sql, insert.params);
		return { storage, service: new RendererBindingService(storage.database, { now }) };
	}

	test('renderer_registry entries persist, reload in Registry order and keep identity on the next Open', async () => {
		const storage = await open();
		for (const entry of [
			createRendererRegistryEntry({ uuid: R2, index: 1, name: 'ui', executor: 'renderer.ui' }, undefined, now),
			createRendererRegistryEntry({ uuid: SPRITE, index: 0, name: 'sprite', label: 'Sprite', executor: 'renderer.sprite', inputs: [{ name: 'scale', kind: 'double' }] }, undefined, now),
		]) {
			const insert = getRendererRegistryInsert(entry);
			await storage.database.run(insert.sql, insert.params);
		}
		await storage.close();
		let loaded: readonly unknown[] = [];
		await open(async reopened => { loaded = await readRendererRegistry(reopened.database); });
		assert.deepStrictEqual((loaded as { uuid: string; name: string; label?: string; inputs: unknown[] }[]).map(entry => [entry.uuid, entry.name, entry.label, entry.inputs.length]), [[SPRITE, 'sprite', 'Sprite', 1], [R2, 'ui', undefined, 0]]);
	});

	test('renderer_registry contract is validated', () => {
		const ok = { name: 'sprite', index: 0, executor: 'renderer.sprite' };
		assert.ok(createRendererRegistryEntry(ok).uuid, 'missing uuid is generated');
		assert.throws(() => createRendererRegistryEntry({ ...ok, index: 1.5 }), /index must be an int/);
		assert.throws(() => createRendererRegistryEntry({ ...ok, executor: '' }), /executor must be non-empty text/);
		assert.throws(() => createRendererRegistryEntry({ ...ok, inputs: [{ name: 'a', kind: 'x' }, { name: 'a', kind: 'y' }] }), /duplicate inputs name 'a'/);
		assert.throws(() => createRendererRegistryEntry({ ...ok, inputs: [{ name: 'a', kind: '' }] }), /kind must be non-empty text/);
		assert.throws(() => createRendererRegistryEntry({ ...ok, created_at: 'nope' }), /created_at must be a timestamp/);
	});

	test('insert persists UUID-only addresses / asset_uuid and select reads them back; display text is resolved from the Registry, never stored', async () => {
		const { storage, service } = await seed();
		const inserted = await service.insert(binding());
		assert.strictEqual(inserted.uuid, R1);

		const stored = await storage.database.get(`SELECT "bindings" FROM binding__renderer_binding`);
		assert.deepStrictEqual(JSON.parse(String(stored?.bindings)), { position_x: { address: address(POS_X) }, position_y: { address: address(POS_Y) }, asset: { asset_uuid: ASSET } });
		assert.ok(!/Player|Sprite/.test(JSON.stringify(stored)), 'no display text is stored');

		const [row] = await service.select({ where: { renderer_uuid: SPRITE }, resolveDisplay: true });
		assert.deepStrictEqual(row.binding, inserted.binding);
		assert.strictEqual(row.display?.renderer, 'Sprite');
		assert.deepStrictEqual(row.display?.bindings.position_x, { table: 'Player', column: 'X', text: 'Player\n\u2514\u2500 X' });
		assert.deepStrictEqual(Object.keys(row.display?.bindings ?? {}), ['position_x', 'position_y']);
		assert.deepStrictEqual((await readRendererBindings(storage.database)).map(entry => entry.uuid), [R1]);
	});

	test('Registry Resolve rejects unknown renderers, unknown inputs and unknown addresses; malformed members are rejected', async () => {
		const { service } = await seed();
		await assert.rejects(service.insert(binding({ renderer: { uuid: MISSING } })), /no renderer .*Missing Definition/);
		await assert.rejects(service.insert(binding({ bindings: { rotation: { asset_uuid: ASSET } } })), /has no input 'rotation'/);
		await assert.rejects(service.insert(binding({ bindings: { position_x: { address: { ...address(POS_X), table_uuid: MISSING } } } })), /table .* is not in table_registry/);
		await assert.rejects(service.insert(binding({ bindings: { position_x: { address: address(MISSING) } } })), /is not a column of table 'player'/);
		await assert.rejects(service.insert(binding({ bindings: { asset: { asset_uuid: 'not-a-uuid' } } })), /asset_uuid must be a UUID/);
		await assert.rejects(service.insert(binding({ bindings: { asset: { asset_uuid: ASSET, address: address(POS_X) } } })), /exactly one of address \| asset_uuid/);
		await assert.rejects(service.insert(binding({ bindings: { position_x: { address: { ...address(POS_X), extra: 1 } } } })), /unknown member 'extra'/);
		await assert.rejects(service.insert(binding({ renderer: { uuid: 'x' } })), /renderer uuid must be a UUID/);
		assert.deepStrictEqual(await service.select(), []);
	});

	test('insert rejects a duplicate uuid; update changes bindings only; upsert resolves the uuid Conflict Identity', async () => {
		const { service } = await seed();
		await service.insert(binding());
		await assert.rejects(service.insert(binding()), /already exists/);

		const updated = await service.update(R1, { bindings: { asset: { asset_uuid: MISSING } } });
		assert.deepStrictEqual(updated.binding.bindings, { asset: { asset_uuid: MISSING } });
		assert.strictEqual(updated.binding.created_at, '2026-10-15T00:00:00.000Z');
		await assert.rejects(service.update(R1, { renderer: { uuid: SPRITE } } as never), /cannot change 'renderer'/);
		await assert.rejects(service.update(R1, {}), /at least one value/);
		await assert.rejects(service.update(R2, { bindings: {} }), /does not exist/);
		await assert.rejects(service.update(R1, { bindings: { rotation: { asset_uuid: ASSET } } }), /has no input 'rotation'/);

		const again = await service.upsert(binding({ bindings: { position_x: { address: address(POS_X) } } }));
		assert.strictEqual(again.operation, 'update');
		assert.deepStrictEqual(Object.keys(again.binding.bindings), ['position_x']);
		const created = await service.upsert(binding({ uuid: R2 }));
		assert.strictEqual(created.operation, 'insert');
		await assert.rejects(service.upsert(binding({ uuid: undefined })), /Conflict Identity/);
		assert.strictEqual((await service.select()).length, 2);
	});

	test('select filters by uuid / renderer and delete removes only the binding', async () => {
		const { storage, service } = await seed();
		await service.insert(binding());
		await service.insert(binding({ uuid: R2 }));
		assert.deepStrictEqual((await service.select({ where: { uuid: R2 } })).map(row => row.binding.uuid), [R2]);
		assert.deepStrictEqual((await service.select({ limit: 1 })).length, 1);
		await assert.rejects(service.select({ where: { name: 'x' } as never }), RendererBindingError);

		const deleted = await service.delete(R1);
		assert.strictEqual(deleted.uuid, R1);
		await assert.rejects(service.delete(R1), /does not exist/);
		assert.deepStrictEqual((await service.select()).map(row => row.binding.uuid), [R2]);
		assert.strictEqual((await storage.database.get(`SELECT COUNT(*) AS n FROM registry__renderer_registry`))?.n, 1);
	});

	test('an input named __proto__ is kept as an own property through insert / update / upsert, the stored JSON and a reopen; an undefined __proto__ input is rejected like any unknown input', async () => {
		const storage = await open();
		const proto = createRendererRegistryEntry({
			uuid: SPRITE, index: 0, name: 'sprite', executor: 'renderer.sprite',
			inputs: [{ name: '__proto__', kind: 'asset' }, { name: 'asset', kind: 'asset' }],
		}, undefined, now);
		const registryInsert = getRendererRegistryInsert(proto);
		await storage.database.run(registryInsert.sql, registryInsert.params);
		const service = new RendererBindingService(storage.database, { now });
		const make = (uuid: string, asset: string) => ({ uuid, renderer: { uuid: SPRITE }, bindings: JSON.parse(`{"__proto__":{"asset_uuid":"${asset}"}}`) as Record<string, unknown> });
		const protoValue = (bindings: object) => Object.getOwnPropertyDescriptor(bindings, '__proto__')?.value;

		const inserted = await service.insert(make(R1, ASSET));
		assert.deepStrictEqual(Object.keys(inserted.binding.bindings), ['__proto__']);
		assert.deepStrictEqual(protoValue(inserted.binding.bindings), { asset_uuid: ASSET });
		const stored = await storage.database.get(`SELECT "bindings" FROM binding__renderer_binding WHERE "uuid" = ?`, [R1]);
		assert.strictEqual(stored?.bindings, `{"__proto__":{"asset_uuid":"${ASSET}"}}`);

		const updated = await service.update(R1, { bindings: JSON.parse(`{"__proto__":{"asset_uuid":"${MISSING}"},"asset":{"asset_uuid":"${ASSET}"}}`) });
		assert.deepStrictEqual(Object.keys(updated.binding.bindings), ['__proto__', 'asset']);
		assert.deepStrictEqual(protoValue(updated.binding.bindings), { asset_uuid: MISSING });

		const upserted = await service.upsert(make(R1, ASSET));
		assert.strictEqual(upserted.operation, 'update');
		const created = await service.upsert(make(R2, MISSING));
		assert.strictEqual(created.operation, 'insert');
		assert.deepStrictEqual(protoValue(created.binding.bindings), { asset_uuid: MISSING });

		await storage.close();
		let reloaded: readonly { uuid: string; bindings: object }[] = [];
		await open(async reopened => { reloaded = await readRendererBindings(reopened.database); });
		assert.deepStrictEqual(reloaded.map(entry => [entry.uuid, Object.keys(entry.bindings), protoValue(entry.bindings)]), [[R1, ['__proto__'], { asset_uuid: ASSET }], [R2, ['__proto__'], { asset_uuid: MISSING }]]);

		// A renderer that does not define __proto__ rejects it like any unknown input.
		const other = createRendererRegistryEntry({ uuid: R2, index: 1, name: 'ui', executor: 'renderer.ui', inputs: [{ name: 'asset', kind: 'asset' }] }, undefined, now);
		const reopened = await open();
		const otherInsert = getRendererRegistryInsert(other);
		await reopened.database.run(otherInsert.sql, otherInsert.params);
		await assert.rejects(new RendererBindingService(reopened.database, { now }).insert({ uuid: '00000000-0000-4000-8000-0000000000d3', renderer: { uuid: R2 }, bindings: JSON.parse(`{"__proto__":{"asset_uuid":"${ASSET}"}}`) }), /has no input '__proto__'/);
	});
});
