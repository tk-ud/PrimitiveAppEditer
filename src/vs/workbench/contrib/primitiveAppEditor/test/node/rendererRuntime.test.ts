/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - runtime state projection through renderer (renderer.runtime)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (27. Renderer)
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
import { AssetKind, createAsset } from '../../common/assetRegistry.js';
import { EditorDdlMigrator } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { FunctionBindingService } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry, getFunctionRegistryInsert } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { createRendererRegistryEntry, getRendererRegistryInsert, RendererBindingService } from '../../common/rendererRegistry.js';
import { createRendererExecutorCatalog, IRendererImplementation, loadRendererRuntime, RendererRuntimeError } from '../../common/rendererRuntime.js';
import { loadRuntimeExecutionPlan } from '../../common/runtimeExecutionPlan.js';
import { RuntimeLoop } from '../../common/runtimeLoop.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const X = '00000000-0000-4000-8000-0000000000c1';
const ROW = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const FB = '00000000-0000-4000-8000-0000000000f2';
const SPRITE = '00000000-0000-4000-8000-0000000000e1';
const RB = '00000000-0000-4000-8000-0000000000e2';
const ASSET = '00000000-0000-4000-8000-0000000000a5';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const now = () => new Date('2026-10-15T00:00:00Z');
const address = { table_uuid: PLAYER, row_uuid: ROW, column_uuid: X };
const functionCatalog = createFunctionPrimitiveExecutorCatalog();
const asset = createAsset({ uuid: ASSET, index: 0, name: 'hero', kind: AssetKind.Image, source: 'assets/image/hero.png' });

const spriteRenderer: IRendererImplementation = {
	executor: 'renderer.sprite',
	project: inputs => ({
		x: (inputs.position_x as { value: unknown }).value,
		image: (inputs.image as { asset: { source: string } }).asset.source,
	}),
};

suite('Primitive App Editor - runtime state projection through renderer on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-renderer-runtime-'));
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
		await new RegistryService(storage.database).create({
			uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', label: 'Player',
			columns: [{ uuid: X, index: 0, name: 'x', label: 'X', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true }],
		});
		const fn = createFunctionRegistryEntry({ uuid: FN, ...toFunctionRegistryEntryInput(linearDefinition, 0) }, undefined, now);
		const insert = getFunctionRegistryInsert(fn, functionCatalog);
		await storage.database.run(insert.sql, insert.params);
		await new RawDataService(storage.database).insert(PLAYER, { uuid: ROW, x: 1 });
		await new FunctionBindingService(storage.database, functionCatalog, { now }).insert({
			uuid: FB, index: 0, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
			inputs: { x: { source: 'state', address } } as never,
			parameters: { a: { source: 'constant', value: 1 }, b: { source: 'constant', value: 1 } } as never,
			target: { address, merge: { kind: 'overwrite' } },
		});
		const renderer = createRendererRegistryEntry({
			uuid: SPRITE, index: 0, name: 'sprite', executor: 'renderer.sprite',
			inputs: [{ name: 'position_x', kind: 'double' }, { name: 'image', kind: 'asset' }],
		}, undefined, now);
		const rendererInsert = getRendererRegistryInsert(renderer);
		await storage.database.run(rendererInsert.sql, rendererInsert.params);
		const bindings = new RendererBindingService(storage.database, { now });
		await bindings.insert({ uuid: RB, renderer: { uuid: SPRITE }, bindings: { position_x: { address }, image: { asset_uuid: ASSET } } });
		return { storage, bindings };
	}

	test('Next State of the Runtime Loop is projected through the Renderer with resolved Assets, read-only', async () => {
		const { storage } = await open();
		const { state, plan } = await loadRuntimeExecutionPlan(storage.database, functionCatalog);
		const loop = new RuntimeLoop(state, plan);
		const rendering = await loadRendererRuntime(storage.database, state, [asset], createRendererExecutorCatalog([spriteRenderer]));

		// Load state: x = 1
		assert.deepStrictEqual(rendering.project().map(p => p.output), [{ x: 1, image: 'assets/image/hero.png' }]);

		// Linear a*x+b with a=b=1: 1 -> 2 -> 3; the projection follows the committed Next State
		loop.step({ time: 1, progress: 0 });
		loop.step({ time: 2, progress: 0 });
		const [projection] = rendering.project();
		assert.deepStrictEqual(projection, { binding_uuid: RB, renderer_uuid: SPRITE, executor: 'renderer.sprite', output: { x: 3, image: 'assets/image/hero.png' } });

		// Projecting is read-only: state unchanged, nothing written to SQLite
		rendering.project();
		assert.strictEqual(state.entities.get(ROW)!.properties.get(X), 3);
		const rows = await new RawDataService(storage.database).select(PLAYER);
		assert.strictEqual(rows.find(row => row.uuid === ROW)!.values[X], 1);
	});

	test('Load rejects instead of completing: missing executor in Code, missing Asset, missing Runtime Object', async () => {
		const { storage } = await open();
		const { state } = await loadRuntimeExecutionPlan(storage.database, functionCatalog);
		await assert.rejects(loadRendererRuntime(storage.database, state, [asset], createRendererExecutorCatalog([])), /executor 'renderer.sprite' does not exist in Code/);
		await assert.rejects(loadRendererRuntime(storage.database, state, [], createRendererExecutorCatalog([spriteRenderer])), (error: unknown) => error instanceof RendererRuntimeError && /no asset/.test(error.message));
		state.entities.delete(ROW);
		await assert.rejects(loadRendererRuntime(storage.database, state, [asset], createRendererExecutorCatalog([spriteRenderer])), /no entity/);
		assert.throws(() => createRendererExecutorCatalog([spriteRenderer, spriteRenderer]), /duplicate renderer executor/);
	});

	test('bound input names stay own properties (including __proto__) through projection', async () => {
		const { storage, bindings } = await open();
		const { state } = await loadRuntimeExecutionPlan(storage.database, functionCatalog);
		const protoRenderer = createRendererRegistryEntry({ uuid: MISSING, index: 1, name: 'proto', executor: 'renderer.proto', inputs: [{ name: '__proto__', kind: 'double' }] }, undefined, now);
		const insert = getRendererRegistryInsert(protoRenderer);
		await storage.database.run(insert.sql, insert.params);
		await bindings.insert({ renderer: { uuid: MISSING }, bindings: JSON.parse(`{"__proto__": {"address": ${JSON.stringify(address)}}}`) });
		const catalog = createRendererExecutorCatalog([spriteRenderer, { executor: 'renderer.proto', project: inputs => Object.keys(inputs) }]);
		const outputs = (await loadRendererRuntime(storage.database, state, [asset], catalog)).project().map(p => p.output);
		assert.deepStrictEqual(outputs, [{ x: 1, image: 'assets/image/hero.png' }, ['__proto__']]);
	});
});
