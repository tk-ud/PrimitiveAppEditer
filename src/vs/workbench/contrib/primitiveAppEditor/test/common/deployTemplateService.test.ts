/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Deploy Template Service tests (build.deploy-template-registrar)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BUILTIN_DEPLOY_TEMPLATE_ID, DeployHost, DeployTemplateOrigin, DeployValidationError, serializeDeployTemplate } from '../../common/deployProjection.js';
import {
	DeployTemplateConfirmationRequired, DeployTemplateControlKind, DeployTemplateService, deployTemplateTabUuid, draftForNewTemplate, draftForTemplate,
	findDeployTemplateTabEntry, IDeployTemplateStore, InMemoryDeployTemplateStore, NEW_DEPLOY_TEMPLATE_TAB, templateBody
} from '../../common/deployTemplateService.js';
import { POSTGRESQL_WEB_APPLICATION_OUTPUT } from '../../common/buildValidation.js';

const TARGETS = [POSTGRESQL_WEB_APPLICATION_OUTPUT];

function body(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...templateBody(new DeployTemplateService().registry.resolve(BUILTIN_DEPLOY_TEMPLATE_ID)!.template!),
		id,
		label: `Template ${id}`,
		...extra,
	};
}

suite('Primitive App Editor - Deploy Template Service', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('create validates, writes the canonical document atomically and lists a user Template', async () => {
		const store = new InMemoryDeployTemplateStore();
		const service = new DeployTemplateService(store);
		const changes: number[] = [];
		service.onDidChange(() => changes.push(service.registry.entries.length));

		const created = await service.create(body('my-compose'));
		assert.strictEqual(created.id, 'my-compose');
		assert.deepStrictEqual(service.registry.entries.map(entry => [entry.id, entry.origin, entry.valid]), [[BUILTIN_DEPLOY_TEMPLATE_ID, 'builtin', true], ['my-compose', 'user', true]]);
		assert.deepStrictEqual(await store.list(), [{ source: 'my-compose', text: serializeDeployTemplate(created) }]);
		assert.deepStrictEqual(changes, [2]);
		assert.ok(service.registry.selectable().some(template => template.id === 'my-compose'));

		// A new Service over the same store sees the same Registry (Editor-wide persistence).
		const reloaded = new DeployTemplateService(store);
		await reloaded.load();
		assert.strictEqual(reloaded.registry.resolve('my-compose')?.valid, true);
	});

	test('invalid content is rejected with the Schema path and nothing is written', async () => {
		const store = new InMemoryDeployTemplateStore();
		const service = new DeployTemplateService(store);
		const cases: [Record<string, unknown>, string][] = [
			[body('Bad_Id'), 'deploy_template.id'],
			[{ ...body('a-b'), parameters: [] }, 'deploy_template.parameters'],
			[{ ...body('a-b'), services: { ...(body('a-b').services as object), ui: { dockerfile: 'generated', internal_port: 3000, host_port: 8080 } } }, 'deploy_template.services'],
			[{ ...body('a-b'), capabilities: { compose: true, installer_assistance: true } }, 'deploy_template.capabilities.installer_assistance'],
		];
		for (const [content, path] of cases) {
			await assert.rejects(() => service.create(content), (error: unknown) => error instanceof DeployValidationError && error.path === path, path);
		}
		assert.deepStrictEqual(await store.list(), []);
		assert.strictEqual(service.registry.entries.length, 1);
	});

	test('built-in ids are reserved and ids are unique; built-in Templates are read-only', async () => {
		const service = new DeployTemplateService();
		await assert.rejects(() => service.create(body(BUILTIN_DEPLOY_TEMPLATE_ID)), /already registered/);
		await service.create(body('mine'));
		await assert.rejects(() => service.create(body('mine')), /already registered/);
		await assert.rejects(() => service.update(BUILTIN_DEPLOY_TEMPLATE_ID, body(BUILTIN_DEPLOY_TEMPLATE_ID)), /built-in Template and is read-only/);
		await assert.rejects(() => service.delete(BUILTIN_DEPLOY_TEMPLATE_ID), /built-in Template and is read-only/);
		assert.strictEqual(service.registry.entries.length, 2);
	});

	test('update replaces the content, keeps the id and leaves the Registry unchanged on failure', async () => {
		const service = new DeployTemplateService();
		await service.create(body('mine'));
		const updated = await service.update('mine', body('mine', { label: 'Renamed' }));
		assert.strictEqual(updated.label, 'Renamed');
		assert.strictEqual(service.registry.resolve('mine')?.template?.label, 'Renamed');
		await assert.rejects(() => service.update('mine', body('other')), /cannot be changed/);
		await assert.rejects(() => service.update('mine', body('mine', { label: '' })), /label/);
		assert.strictEqual(service.registry.resolve('mine')?.template?.label, 'Renamed');
		await assert.rejects(() => service.update('absent', body('absent')), /not registered/);
	});

	test('duplicate copies a built-in or user Template under a new id', async () => {
		const service = new DeployTemplateService();
		const copy = await service.duplicate(BUILTIN_DEPLOY_TEMPLATE_ID, 'my-copy');
		assert.strictEqual(copy.label, 'Docker Compose (default) (copy)');
		assert.deepStrictEqual({ ...templateBody(copy), id: '', label: '' }, { ...templateBody(service.registry.resolve(BUILTIN_DEPLOY_TEMPLATE_ID)!.template!), id: '', label: '' });
		assert.strictEqual(service.registry.resolve('my-copy')?.origin, DeployTemplateOrigin.User);
		const second = await service.duplicate('my-copy', 'second', 'Second');
		assert.strictEqual(second.label, 'Second');
		await assert.rejects(() => service.duplicate('my-copy', BUILTIN_DEPLOY_TEMPLATE_ID), /already registered/);
		await assert.rejects(() => service.duplicate('my-copy', 'my-copy'), /already registered/);
		await assert.rejects(() => service.duplicate('absent', 'x'), /not a Valid Template/);
	});

	test('delete requires confirmation for a referenced Template and never rewrites the Selection', async () => {
		let referenced: string | undefined = 'mine';
		const store = new InMemoryDeployTemplateStore();
		const service = new DeployTemplateService(store, id => id === referenced);
		await service.create(body('mine'));
		await service.create(body('free'));
		await assert.rejects(() => service.delete('mine'), DeployTemplateConfirmationRequired);
		assert.ok(service.registry.resolve('mine'));
		await service.delete('free');
		assert.strictEqual(service.registry.resolve('free'), undefined);
		await service.delete('mine', { confirmed: true });
		assert.strictEqual(service.registry.resolve('mine'), undefined, 'Template unresolved');
		assert.strictEqual(referenced, 'mine', 'the Selection is not rewritten');
		assert.deepStrictEqual(await store.list(), []);
		referenced = undefined;
	});

	test('an Invalid stored document is listed, never selectable, and can be deleted', async () => {
		const store = new InMemoryDeployTemplateStore([{ source: 'broken', text: 'deploy_template:\n  id: broken\n  unknown: 1\n' }, { source: 'shadow', text: serializeDeployTemplate(new DeployTemplateService().registry.resolve(BUILTIN_DEPLOY_TEMPLATE_ID)!.template!) }]);
		const service = new DeployTemplateService(store);
		await service.load();
		assert.deepStrictEqual(service.registry.entries.map(entry => [entry.id, entry.valid]), [[BUILTIN_DEPLOY_TEMPLATE_ID, true], ['broken', false], [BUILTIN_DEPLOY_TEMPLATE_ID, false]]);
		assert.deepStrictEqual(service.registry.selectable().map(template => template.id), [BUILTIN_DEPLOY_TEMPLATE_ID]);
		await service.delete('broken');
		await service.delete(BUILTIN_DEPLOY_TEMPLATE_ID); // removes the shadowing user document, not the built-in one
		assert.deepStrictEqual(service.registry.entries.map(entry => [entry.id, entry.origin]), [[BUILTIN_DEPLOY_TEMPLATE_ID, 'builtin']]);
		assert.deepStrictEqual(await store.list(), []);
	});

	test('a failing store write leaves the Registry unchanged and does not block the next Mutation', async () => {
		let failNext = true;
		const inner = new InMemoryDeployTemplateStore();
		const store: IDeployTemplateStore = {
			list: () => inner.list(),
			write: async (source, text) => { if (failNext) { failNext = false; throw new Error('disk full'); } await inner.write(source, text); },
			delete: source => inner.delete(source),
		};
		const service = new DeployTemplateService(store);
		await assert.rejects(() => service.create(body('mine')), /disk full/);
		assert.strictEqual(service.registry.resolve('mine'), undefined);
		await service.create(body('mine'));
		assert.ok(service.registry.resolve('mine'));
	});

	test('concurrent Mutations are serialized (one wins an id)', async () => {
		const service = new DeployTemplateService();
		const results = await Promise.allSettled([service.create(body('same')), service.create(body('same'))]);
		assert.deepStrictEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
		assert.strictEqual(service.registry.entries.filter(entry => entry.id === 'same').length, 1);
	});

	test('tab uuid is a deterministic UUID that resolves back to the entry', async () => {
		const service = new DeployTemplateService();
		await service.create(body('a-b'));
		const uuid = deployTemplateTabUuid(DeployTemplateOrigin.User, 'a-b');
		assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.strictEqual(uuid, deployTemplateTabUuid(DeployTemplateOrigin.User, 'a-b'));
		assert.notStrictEqual(uuid, deployTemplateTabUuid(DeployTemplateOrigin.Builtin, 'a-b'));
		assert.notStrictEqual(uuid, deployTemplateTabUuid(DeployTemplateOrigin.User, 'a-c'));
		assert.strictEqual(findDeployTemplateTabEntry(service.registry, uuid)?.id, 'a-b');
		assert.strictEqual(findDeployTemplateTabEntry(service.registry, NEW_DEPLOY_TEMPLATE_TAB), undefined);
		await service.delete('a-b');
		assert.strictEqual(findDeployTemplateTabEntry(service.registry, uuid), undefined, 'Template unresolved after delete');
	});
});

suite('Primitive App Editor - Deploy Template Editor draft', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const builtin = () => new DeployTemplateService().registry.resolve(BUILTIN_DEPLOY_TEMPLATE_ID)!.template!;

	test('Controls are derived from the Schema only (no parameters Control)', () => {
		const controls = draftForTemplate(builtin(), DeployTemplateOrigin.User, TARGETS).controls();
		assert.deepStrictEqual(controls.map(control => control.path), [
			'id', 'label', 'description', 'provider', 'supported_hosts', 'compatible_build_targets',
			'services.api.dockerfile', 'services.api.internal_port', 'services.api.host_port',
			'services.ui.dockerfile', 'services.ui.internal_port', 'services.ui.host_port',
			'services.database.image', 'services.database.data_volume', 'services.database.password_env',
			'capabilities.compose', 'capabilities.prerequisites_check', 'capabilities.installer_assistance', 'capabilities.setup_script',
		]);
		const byPath = new Map(controls.map(control => [control.path, control]));
		assert.deepStrictEqual(byPath.get('supported_hosts')!.options, [DeployHost.Linux, DeployHost.WindowsWsl2, DeployHost.MacOs]);
		assert.deepStrictEqual(byPath.get('compatible_build_targets')!.options, TARGETS);
		assert.strictEqual(byPath.get('provider')!.kind, DeployTemplateControlKind.Fixed);
		assert.strictEqual(byPath.get('id')!.readonlyReason, 'id', 'the id of an existing Template is immutable');
	});

	test('a built-in Template is shown read-only and rejects every edit', () => {
		const draft = draftForTemplate(builtin(), DeployTemplateOrigin.Builtin, TARGETS);
		assert.ok(draft.readOnly);
		assert.ok(draft.controls().every(control => control.readonlyReason === 'built-in'));
		assert.throws(() => draft.set('label', 'x'), /read-only/);
	});

	test('editing validates; invalid drafts report the path and a valid one yields canonical text', () => {
		const draft = draftForTemplate(builtin(), DeployTemplateOrigin.User, TARGETS);
		draft.set('services.ui.host_port', 8080);
		const invalid = draft.validate();
		assert.ok(!invalid.valid && invalid.path === 'deploy_template.services');
		draft.set('services.ui.host_port', 3001);
		draft.set('capabilities.installer_assistance', true);
		let result = draft.validate();
		assert.ok(!result.valid && result.path === 'deploy_template.capabilities.installer_assistance');
		draft.set('capabilities.prerequisites_check', true);
		draft.set('supported_hosts', [DeployHost.Linux]);
		draft.set('description', '');
		result = draft.validate();
		assert.ok(result.valid);
		assert.ok(result.valid && result.text.includes('installer_assistance: true') && !result.text.includes('description'));
		draft.set('services.api.internal_port', 'abc');
		assert.ok(!draft.validate().valid, 'a non numeric port is rejected');
		assert.throws(() => draft.set('parameters', 'x'), /not a Deploy Template Schema path/);
		assert.throws(() => draft.set('provider', 'x'), /read-only \(fixed\)/);
		assert.throws(() => draft.set('id', 'other'), /read-only \(id\)/);
	});

	test('a new draft is incomplete until id and label are entered, then saves through the Service', async () => {
		const draft = draftForNewTemplate(TARGETS);
		assert.ok(!draft.validate().valid);
		draft.set('id', 'fresh');
		draft.set('label', 'Fresh');
		const result = draft.validate();
		assert.ok(result.valid);
		const service = new DeployTemplateService();
		await service.create(draft.toBody());
		assert.strictEqual(service.registry.resolve('fresh')?.template?.label, 'Fresh');
	});
});
