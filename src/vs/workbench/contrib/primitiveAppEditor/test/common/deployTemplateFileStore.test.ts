/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor-wide Deploy Template file store tests (build.deploy-template-registrar)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { BUILTIN_DEPLOY_TEMPLATE_ID } from '../../common/deployProjection.js';
import { DeployTemplateFileStore } from '../../common/deployTemplateFileStore.js';
import { DeployTemplateService, templateBody } from '../../common/deployTemplateService.js';

suite('Primitive App Editor - Deploy Template file store', () => {

	const disposables = new DisposableStore();
	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	const directory = URI.from({ scheme: 'pae-test', path: '/global/primitive-app-editor/deploy-templates' });

	function create(): { fileService: FileService; store: DeployTemplateFileStore } {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('pae-test', disposables.add(new InMemoryFileSystemProvider())));
		return { fileService, store: new DeployTemplateFileStore(fileService, directory) };
	}

	test('a missing directory lists no documents; write creates `<id>.yml` and leaves no temporary file', async () => {
		const { fileService, store } = create();
		assert.deepStrictEqual(await store.list(), []);
		await store.write('mine', 'deploy_template:\n  id: mine\n');
		assert.deepStrictEqual(await store.list(), [{ source: 'mine', text: 'deploy_template:\n  id: mine\n' }]);
		await store.write('mine', 'second\n');
		assert.deepStrictEqual((await store.list()).map(document => document.text), ['second\n'], 'a write replaces the document');
		const names = (await fileService.resolve(directory)).children?.map(child => child.name);
		assert.deepStrictEqual(names, ['mine.yml']);
	});

	test('delete removes the document; deleting a missing one is not an error; unsafe names are refused', async () => {
		const { fileService, store } = create();
		await store.write('a', 'a\n');
		await fileService.writeFile(joinPath(directory, 'legacy.yaml'), VSBuffer.fromString('legacy\n'));
		assert.deepStrictEqual((await store.list()).map(document => document.source), ['a', 'legacy']);
		await store.delete('a');
		await store.delete('legacy');
		await store.delete('missing');
		assert.deepStrictEqual(await store.list(), []);
		await assert.rejects(() => store.write('../escape', 'x'), /not a valid Template storage name/);
		await assert.rejects(() => store.delete('a/b'), /not a valid Template storage name/);
	});

	test('the Service persists Editor-wide: a new Service over the same directory sees the Templates', async () => {
		const { store } = create();
		const service = new DeployTemplateService(store);
		await service.load();
		const builtin = service.registry.resolve(BUILTIN_DEPLOY_TEMPLATE_ID)!.template!;
		await service.duplicate(BUILTIN_DEPLOY_TEMPLATE_ID, 'persisted');
		await service.update('persisted', { ...templateBody(builtin), id: 'persisted', label: 'Persisted' });

		const other = new DeployTemplateService(store);
		await other.load();
		assert.deepStrictEqual(other.registry.entries.map(entry => [entry.id, entry.origin, entry.valid]), [[BUILTIN_DEPLOY_TEMPLATE_ID, 'builtin', true], ['persisted', 'user', true]]);
		assert.strictEqual(other.registry.resolve('persisted')?.template?.label, 'Persisted');
		await other.delete('persisted');
		await service.load();
		assert.strictEqual(service.registry.resolve('persisted'), undefined);
	});
});
