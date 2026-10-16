/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Asset model and directory scan (asset.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (29. Asset)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AssetKind, createAsset, createAssetScanStep, discoverAssets, IAsset, resolveAssets, scanAssets, validateAssetRegistry } from '../../common/assetRegistry.js';
import { openProjectDirectory, ProjectOpenPhase, ProjectOpenStatus } from '../../common/projectDirectory.js';

const A = '00000000-0000-4000-8000-0000000000a1';

suite('Primitive App Editor - Asset (29. Asset)', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.from({ scheme: 'mem', path: '/project' });
	const assets = joinPath(root, 'assets');

	function createFileService(): FileService {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('mem', disposables.add(new InMemoryFileSystemProvider())));
		return fileService;
	}

	async function seed(fileService: FileService): Promise<void> {
		await fileService.writeFile(joinPath(assets, 'image', 'hero.png'), VSBuffer.fromString('abc'));
		await fileService.writeFile(joinPath(assets, 'image', 'ui', 'btn.png'), VSBuffer.fromString(''));
		await fileService.writeFile(joinPath(assets, 'audio', 'bgm.ogg'), VSBuffer.fromString(''));
		await fileService.writeFile(joinPath(assets, 'shader', 'a.glsl'), VSBuffer.fromString(''));
	}

	test('createAsset validates the 29 model', () => {
		const asset = createAsset({ uuid: A.toUpperCase(), index: 0, name: 'hero', label: 'Hero', kind: AssetKind.Sprite, source: 'assets/image/hero.png', metadata: { w: 1 } });
		assert.deepStrictEqual({ ...asset }, { uuid: A, index: 0, name: 'hero', label: 'Hero', kind: 'sprite', source: 'assets/image/hero.png', metadata: { w: 1 } });
		assert.match(createAsset({ index: 0, name: 'x', kind: AssetKind.Other, source: 's' }).uuid, /^[0-9a-f-]{36}$/);
		assert.throws(() => createAsset({ index: 0.5, name: 'x', kind: AssetKind.Other, source: 's' }), /index must be an int/);
		assert.throws(() => createAsset({ index: 0, name: 'x', kind: 'video' as AssetKind, source: 's' }), /kind/);
		assert.throws(() => createAsset({ index: 0, name: 'x', kind: AssetKind.Other, source: '' }), /source/);
		assert.throws(() => createAsset({ index: 0, name: 'x', kind: AssetKind.Other, source: 's', metadata: [] as never }), /metadata/);
		assert.throws(() => createAsset({ index: 0, name: ' ', kind: AssetKind.Other, source: 's' }), /name/);
	});

	test('validateAssetRegistry rejects duplicate uuid and source', () => {
		const a = createAsset({ uuid: A, index: 0, name: 'a', kind: AssetKind.Image, source: 'assets/image/a.png' });
		const b = createAsset({ index: 1, name: 'b', kind: AssetKind.Image, source: 'assets/image/b.png' });
		validateAssetRegistry([a, b]);
		assert.throws(() => validateAssetRegistry([a, createAsset({ uuid: A, index: 1, name: 'b', kind: AssetKind.Image, source: 'x' })]), /duplicate asset uuid/);
		assert.throws(() => validateAssetRegistry([a, createAsset({ index: 1, name: 'b', kind: AssetKind.Image, source: a.source })]), /duplicate asset source/);
	});

	test('Directory Scan lists assets/<category>/ recursively in source order, read-only', async () => {
		const fileService = createFileService();
		await seed(fileService);
		const found = await discoverAssets(fileService, assets);
		assert.deepStrictEqual(found.map(file => file.source), ['assets/audio/bgm.ogg', 'assets/image/hero.png', 'assets/image/ui/btn.png', 'assets/shader/a.glsl']);
		assert.strictEqual(found.find(file => file.path === 'hero.png')?.size, 3);
		assert.strictEqual(await fileService.exists(joinPath(assets, 'font')), false);
	});

	test('missing assets/ discovers nothing; a file as a category and non-NotFound failures reject', async () => {
		const fileService = createFileService();
		assert.deepStrictEqual(await discoverAssets(fileService, assets), []);
		assert.strictEqual(await fileService.exists(assets), false);
		await fileService.writeFile(joinPath(assets, 'font'), VSBuffer.fromString(''));
		await assert.rejects(() => discoverAssets(fileService, assets), /not a directory/);

		const denied = Object.create(fileService) as IFileService;
		denied.resolve = async () => { throw new FileOperationError('denied', FileOperationResult.FILE_PERMISSION_DENIED); };
		await assert.rejects(() => discoverAssets(denied, assets), /denied/);
	});

	test('Asset Resolve: kind follows the category, index follows source order, metadata from the file', async () => {
		const fileService = createFileService();
		await seed(fileService);
		const resolved = await scanAssets(fileService, assets);
		assert.deepStrictEqual(resolved.map(asset => [asset.index, asset.name, asset.kind, asset.source]), [
			[0, 'bgm.ogg', 'audio', 'assets/audio/bgm.ogg'],
			[1, 'hero.png', 'image', 'assets/image/hero.png'],
			[2, 'ui/btn.png', 'image', 'assets/image/ui/btn.png'],
			[3, 'a.glsl', 'shader', 'assets/shader/a.glsl'],
		]);
		assert.deepStrictEqual({ ...resolved[1].metadata }, { extension: 'png', size: 3 });
	});

	test('rescan keeps Machine Identity by source, adds new files, drops removed ones', async () => {
		const fileService = createFileService();
		await seed(fileService);
		const first = await scanAssets(fileService, assets);
		const hero = first.find(asset => asset.name === 'hero.png')!;
		const known: IAsset[] = [createAsset({ ...hero, name: 'hero', label: 'Hero', kind: AssetKind.Sprite }), createAsset({ index: 9, name: 'gone', kind: AssetKind.Other, source: 'assets/other/gone.bin' })];
		const second = resolveAssets(await discoverAssets(fileService, assets), known);
		const again = second.find(asset => asset.source === hero.source)!;
		assert.deepStrictEqual([again.uuid, again.name, again.label, again.kind], [hero.uuid, 'hero', 'Hero', 'sprite']);
		assert.strictEqual(second.length, first.length);
		assert.ok(!second.some(asset => asset.name === 'gone'));
		assert.throws(() => resolveAssets([], [known[0], known[0]]), /duplicate asset uuid/);
	});

	test('assetScan open step plugs into Open: Ready, and a failing scan rejects before Editor Ready', async () => {
		const noop = async () => { };
		const stepsFor = (fileService: IFileService, onScanned?: (assets: readonly IAsset[]) => void) => ({
			createStorage: noop, openStorage: noop, editorDdlScan: noop, schemaVersionResolve: noop, migrationApply: noop, registryLoad: noop, functionScan: noop,
			assetScan: createAssetScanStep(fileService, async () => [], onScanned),
		});

		const okFs = createFileService();
		await seed(okFs);
		let scanned: readonly IAsset[] = [];
		const ready = await openProjectDirectory(okFs, root, stepsFor(okFs, assets => { scanned = assets; }));
		assert.strictEqual(ready.status, ProjectOpenStatus.Ready);
		assert.ok(ready.phases.includes(ProjectOpenPhase.AssetScan));
		assert.strictEqual(scanned.length, 4);

		const badFs = createFileService();
		await badFs.createFolder(root);
		const deniedFs = Object.create(badFs) as IFileService;
		deniedFs.resolve = (async (resource: URI, options?: never) => {
			if (resource.path.includes('/assets/')) {
				throw new FileOperationError('denied', FileOperationResult.FILE_PERMISSION_DENIED);
			}
			return badFs.resolve(resource, options);
		}) as IFileService['resolve'];
		await assert.rejects(() => openProjectDirectory(deniedFs, root, stepsFor(deniedFs)), /denied/);
	});
});
