/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Deploy Template Registry, Selection, Docker Scaffold and Deploy Validation (build.deploy-projection)
 *  Specification SSOT: docs/primitive-app-editor/Deploy Configuration.md
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BuildValidationError, IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE } from '../../common/buildValidation.js';
import { createFunctionBindingEntry } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry } from '../../common/functionRegistry.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { createRendererBindingEntry, createRendererRegistryEntry } from '../../common/rendererRegistry.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';
import {
	BUILTIN_DEPLOY_TEMPLATE_DOCUMENT, BUILTIN_DEPLOY_TEMPLATE_ID, chooseScaffoldFileName, createDeployScaffold, createDeploySelection, createDeployTemplateRegistry,
	DeployTemplateOrigin, DeployValidationError, parseDeployTemplate, projectDeployScaffold, serializeDeployTemplate, validateDeploy,
} from '../../common/deployProjection.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW1 = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const BIND = '00000000-0000-4000-8000-0000000000d1';
const RENDERER = '00000000-0000-4000-8000-0000000000e1';
const RBIND = '00000000-0000-4000-8000-0000000000e2';
const NOW = '2026-10-18T00:00:00.000Z';

function authoring(tableName = 'player'): IBuildAuthoringData {
	const column = { uuid: FATIGUE, index: 0, name: 'fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true };
	const player = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: tableName, columns: [column], created_at: NOW });
	const address = { table_uuid: PLAYER, row_uuid: ROW1, column_uuid: FATIGUE };
	const now = () => new Date(NOW);
	return {
		tables: [player],
		relations: [],
		functions: [createFunctionRegistryEntry({ uuid: FN, ...toFunctionRegistryEntryInput(linearDefinition, 0) }, undefined, now)],
		bindings: [createFunctionBindingEntry({
			uuid: BIND, index: 0, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
			inputs: { x: { source: 'state', address } }, target: { address, merge: { kind: 'overwrite' } },
		}, undefined, now)],
		dependencies: [],
		renderers: [createRendererRegistryEntry({ uuid: RENDERER, index: 0, name: 'gauge', executor: 'Gauge', inputs: [{ name: 'value', kind: 'double' }] }, undefined, now)],
		rendererBindings: [createRendererBindingEntry({ uuid: RBIND, renderer: { uuid: RENDERER }, bindings: { value: { address } } }, undefined, now)],
		assets: [],
		rawData: [{ table_uuid: PLAYER, rows: [{ uuid: ROW1, values: { [FATIGUE]: 1 } }] }],
		workingDirectoryPaths: ['functions/linear.ts'],
		executorCatalog: createFunctionPrimitiveExecutorCatalog(),
		resolveExecutorProgram: executor => executor === 'Linear' ? 'functions/linear.ts' : undefined,
	};
}

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build_target: POSTGRESQL_WEB_APPLICATION_OUTPUT,
		runtime_storage_target: POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
		seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [] } },
		include: { assets: [], functions: ['functions/linear.ts'], scripts: [], config: [] },
		output_path: 'build/out',
		...overrides,
	};
}

const DOC = BUILTIN_DEPLOY_TEMPLATE_DOCUMENT;

function withDeploy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return configuration({ deploy: { template_id: BUILTIN_DEPLOY_TEMPLATE_ID, host: 'linux' }, ...overrides });
}

function rejects(run: () => unknown, pattern: RegExp): void {
	assert.throws(run, error => (error instanceof DeployValidationError || error instanceof BuildValidationError) && pattern.test(error.message));
}

suite('Primitive App Editor - Deploy Template Registry, Selection, Docker Scaffold and Deploy Validation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the built-in Template is Valid and round-trips byte for byte', () => {
		const template = parseDeployTemplate(DOC);
		assert.strictEqual(template.id, 'docker-compose-default');
		assert.strictEqual(template.services.database.image, 'postgres:16.4');
		assert.strictEqual(serializeDeployTemplate(template), DOC);
		assert.strictEqual(serializeDeployTemplate(parseDeployTemplate(serializeDeployTemplate(template))), DOC);
	});

	test('Template schema rejects unknown keys at every level, including the retired parameters', () => {
		for (const [from, to] of [
			['  provider: docker_compose', '  provider: docker_compose\n  parameters: []'],
			['  services:', '  extra: 1\n  services:'],
			['      host_port: 8080', '      host_port: 8080\n      env: x'],
			['    compose: true', '    compose: true\n    other: true'],
		]) {
			rejects(() => parseDeployTemplate(DOC.replace(from, to)), /unknown key/);
		}
		rejects(() => parseDeployTemplate(`other: 1\n${DOC}`), /unknown key/);
	});

	test('Template schema rejects bad types, enums, ports, image tags and names', () => {
		const bad: [string, string, RegExp][] = [
			['provider: docker_compose', 'provider: podman', /provider/],
			['supported_hosts: [linux, windows_wsl2, macos]', 'supported_hosts: [linux, linux]', /more than once/],
			['supported_hosts: [linux, windows_wsl2, macos]', 'supported_hosts: [beos]', /not one of/],
			['internal_port: 8080', 'internal_port: 70000', /internal_port/],
			['host_port: 3000', 'host_port: 8080', /different host_port/],
			['internal_port: 3000', 'internal_port: 8080', /different internal_port/],
			['"postgres:16.4"', '"postgres:latest"', /latest/],
			['"postgres:16.4"', '"postgres"', /image/],
			['data_volume: application-db', 'data_volume: Bad_Volume', /data_volume/],
			['password_env: DB_PASSWORD', 'password_env: db-password', /password_env/],
			['id: docker-compose-default', 'id: Docker', /id/],
			['    compose: true', '    compose: false', /compose/],
			['    compose: true', '    compose: true\n    installer_assistance: true', /prerequisites_check/],
			['dockerfile: generated\n      internal_port: 8080', 'dockerfile: custom\n      internal_port: 8080', /generated/],
		];
		for (const [from, to, pattern] of bad) {
			assert.ok(DOC.includes(from), from);
			rejects(() => parseDeployTemplate(DOC.replace(from, to)), pattern);
		}
		rejects(() => parseDeployTemplate(DOC.replace('    database:\n', '    database_x:\n')), /unknown key|missing/);
		rejects(() => parseDeployTemplate(DOC.replace('  id: docker-compose-default\n', '')), /id.*missing/);
	});

	test('Template document boundary rejects multiple documents, anchors, aliases, merge keys and tags', () => {
		rejects(() => parseDeployTemplate(`${DOC}---\n${DOC}`), /multiple/);
		rejects(() => parseDeployTemplate(DOC.replace('label: "Docker Compose (default)"', 'label: &a x')), /anchor/);
		rejects(() => parseDeployTemplate(DOC.replace('label: "Docker Compose (default)"', 'label: *a')), /alias/);
		rejects(() => parseDeployTemplate(DOC.replace('label: "Docker Compose (default)"', 'label: !!str x')), /tag/);
		rejects(() => parseDeployTemplate(DOC.replace('    api:\n', '    <<: x\n    api:\n')), /merge/);
		assert.ok(parseDeployTemplate(`---\n# comment\n${DOC}`), 'a single leading marker and comments are allowed');
		assert.ok(parseDeployTemplate(DOC.replace('label: "Docker Compose (default)"', 'label: "A & B * C"')), 'quoted text is not an anchor');
	});

	test('the Registry lists the built-in Template and marks invalid user Templates Invalid, never shadowing', () => {
		const userDoc = DOC.replace('id: docker-compose-default', 'id: my-compose').replace('host_port: 8080', 'host_port: 9090');
		const registry = createDeployTemplateRegistry([
			{ source: 'a.yaml', text: userDoc },
			{ source: 'shadow.yaml', text: DOC },
			{ source: 'dup.yaml', text: userDoc },
			{ source: 'broken.yaml', text: 'deploy_template: 1' },
		]);
		assert.deepStrictEqual(registry.entries.map(entry => [entry.id, entry.origin, entry.valid]), [
			['docker-compose-default', DeployTemplateOrigin.Builtin, true],
			['my-compose', DeployTemplateOrigin.User, true],
			['docker-compose-default', DeployTemplateOrigin.User, false],
			['my-compose', DeployTemplateOrigin.User, false],
			['broken.yaml', DeployTemplateOrigin.User, false],
		]);
		assert.deepStrictEqual(registry.selectable().map(template => template.id), ['docker-compose-default', 'my-compose']);
		assert.strictEqual(registry.resolve('docker-compose-default')!.origin, DeployTemplateOrigin.Builtin);
		assert.strictEqual(registry.resolve('nope'), undefined);
	});

	test('Selection holds only template_id and host', () => {
		assert.deepStrictEqual({ ...createDeploySelection({ template_id: 'docker-compose-default', host: 'macos' }) }, { template_id: 'docker-compose-default', host: 'macos' });
		rejects(() => createDeploySelection({ template_id: 'docker-compose-default', host: 'linux', parameters: { host_port: 1 } }), /parameters/);
		rejects(() => createDeploySelection({ template_id: 'docker-compose-default', host: 'beos' }), /host/);
		rejects(() => createDeploySelection({ template_id: 'Bad', host: 'linux' }), /template_id/);
		rejects(() => createDeploySelection({ host: 'linux' }), /template_id/);
	});

	test('Deploy Validation: unresolved / Invalid Template, unsupported host / Build Target, missing Output files', () => {
		const registry = createDeployTemplateRegistry([{ source: 'broken.yaml', text: DOC.replace('id: docker-compose-default', 'id: broken').replace('internal_port: 3000', 'internal_port: 8080') }]);
		const files = ['application.definition.json', '001_init_postgresql.sql', 'api/PrimitiveApplication.Api.csproj', 'ui/package.json'];
		const select = (template_id: string, host = 'linux') => createDeploySelection({ template_id, host });
		assert.strictEqual(validateDeploy(registry, select('docker-compose-default'), POSTGRESQL_WEB_APPLICATION_OUTPUT, files).id, 'docker-compose-default');
		rejects(() => validateDeploy(registry, select('missing'), POSTGRESQL_WEB_APPLICATION_OUTPUT, files), /unresolved/);
		rejects(() => validateDeploy(registry, select('broken'), POSTGRESQL_WEB_APPLICATION_OUTPUT, files), /Invalid/);
		rejects(() => validateDeploy(registry, select('docker-compose-default'), 'Other Target', files), /build_target/);
		const linuxOnly = createDeployTemplateRegistry([{ source: 'l.yaml', text: DOC.replace('id: docker-compose-default', 'id: linux-only').replace('[linux, windows_wsl2, macos]', '[linux]') }]);
		rejects(() => validateDeploy(linuxOnly, select('linux-only', 'macos'), POSTGRESQL_WEB_APPLICATION_OUTPUT, files), /host 'macos'/);
		for (const missing of files) {
			rejects(() => validateDeploy(registry, select('docker-compose-default'), POSTGRESQL_WEB_APPLICATION_OUTPUT, files.filter(file => file !== missing)), new RegExp(missing.replace(/\./g, '\\.')));
		}
	});

	test('file naming never overwrites: sequence before the extension, .yml / .yaml collide, exhaustion stops', () => {
		const names = (...existing: string[]) => new Set(existing);
		assert.strictEqual(chooseScaffoldFileName('compose.yml', names()), 'compose.yml');
		assert.strictEqual(chooseScaffoldFileName('compose.yml', names('compose.yml')), 'compose-001.yml');
		assert.strictEqual(chooseScaffoldFileName('compose.yml', names('compose.yaml')), 'compose-001.yml');
		assert.strictEqual(chooseScaffoldFileName('compose.yml', names('compose.yml', 'compose-001.yaml', 'compose-002.yml')), 'compose-003.yml');
		assert.strictEqual(chooseScaffoldFileName('.env.example', names('.env.example')), '.env-001.example');
		assert.strictEqual(chooseScaffoldFileName('api/Dockerfile', names('api/Dockerfile')), 'api/Dockerfile-001');
		const all = ['compose.yml', ...Array.from({ length: 999 }, (_, index) => `compose-${String(index + 1).padStart(3, '0')}.yml`)];
		rejects(() => chooseScaffoldFileName('compose.yml', new Set(all)), /no unused file name/);
	});

	test('Scaffold is deterministic, references adopted names and carries no secret', () => {
		const result = projectDeployScaffold(authoring(), withDeploy(), createDeployTemplateRegistry());
		const again = projectDeployScaffold(authoring(), withDeploy(), createDeployTemplateRegistry());
		assert.deepStrictEqual(result.scaffold, again.scaffold);
		assert.deepStrictEqual(result.scaffold.files.map(file => file.path), ['.env.example', 'api/Dockerfile', 'compose.yml', 'ui/Dockerfile']);
		const byPath = new Map(result.scaffold.files.map(file => [file.path, file.content]));
		const compose = byPath.get('compose.yml')!;
		assert.ok(compose.includes('image: "postgres:16.4"'));
		assert.ok(compose.includes('dockerfile: api/Dockerfile'));
		assert.ok(compose.includes('dockerfile: Dockerfile'));
		assert.ok(compose.includes('./001_init_postgresql.sql:/docker-entrypoint-initdb.d/001_init_postgresql.sql:ro'));
		assert.ok(compose.includes('./002_seed_data.sql:/docker-entrypoint-initdb.d/002_seed_data.sql:ro'));
		assert.ok(compose.includes('"8080:8080"') && compose.includes('"3000:3000"'));
		assert.ok(compose.includes('NEXT_PUBLIC_API_BASE: "http://localhost:8080"'));
		assert.ok(compose.includes('API_BASE_URL: "http://api:8080"'));
		assert.ok(compose.includes('${DB_PASSWORD:?'));
		assert.ok(!/POSTGRES_PASSWORD: "[^$]/.test(compose), 'the password is a variable reference only');
		assert.strictEqual(byPath.get('.env.example')!.split('\n').filter(line => line.startsWith('DB_PASSWORD=')).join(), 'DB_PASSWORD=<set-a-database-password>');
		assert.ok(byPath.get('api/Dockerfile')!.includes('dotnet publish api/PrimitiveApplication.Api.csproj'));
		assert.ok(byPath.get('api/Dockerfile')!.includes('COPY application.definition.json'));
		assert.ok(byPath.get('ui/Dockerfile')!.includes('npm run build'));
	});

	test('Scaffold omits the seed mount when the Output has no Seed file', () => {
		const template = parseDeployTemplate(DOC);
		const scaffold = createDeployScaffold(template, createDeploySelection({ template_id: template.id, host: 'linux' }), ['application.definition.json', '001_init_postgresql.sql'], []);
		const compose = scaffold.files.find(file => file.path === 'compose.yml')!.content;
		assert.ok(compose.includes('001_init_postgresql.sql') && !compose.includes('002_seed_data.sql'));
	});

	test('existing files are kept: sequenced names are adopted and cross-referenced', () => {
		const { scaffold } = projectDeployScaffold(authoring(), withDeploy(), createDeployTemplateRegistry(), ['compose.yaml', '.env.example', 'api/Dockerfile', 'ui/Dockerfile', 'ui/Dockerfile-001']);
		assert.deepStrictEqual(scaffold.files.map(file => [file.requested, file.path]).sort(), [
			['.env.example', '.env-001.example'],
			['api/Dockerfile', 'api/Dockerfile-001'],
			['compose.yml', 'compose-001.yml'],
			['ui/Dockerfile', 'ui/Dockerfile-002'],
		]);
		const byPath = new Map(scaffold.files.map(file => [file.path, file.content]));
		const compose = byPath.get('compose-001.yml')!;
		assert.ok(compose.includes('dockerfile: api/Dockerfile-001') && compose.includes('dockerfile: Dockerfile-002'));
		assert.ok(compose.includes('.env-001.example'));
		assert.ok(byPath.get('.env-001.example')!.includes('docker compose -f compose-001.yml up -d'));
	});

	test('Template values come from the Template only: a user Template with other ports/volume/image', () => {
		const text = DOC.replace('id: docker-compose-default', 'id: alt').replace('host_port: 8080', 'host_port: 9080').replace('internal_port: 8080', 'internal_port: 5000')
			.replace('"postgres:16.4"', '"postgres:15.7"').replace('application-db', 'alt-db').replace('DB_PASSWORD', 'ALT_PW');
		const registry = createDeployTemplateRegistry([{ source: 'alt.yaml', text }]);
		const { scaffold } = projectDeployScaffold(authoring(), configuration({ deploy: { template_id: 'alt', host: 'linux' } }), registry);
		const compose = scaffold.files.find(file => file.path === 'compose.yml')!.content;
		for (const expected of ['"9080:5000"', 'postgres:15.7', 'alt-db:/var/lib/postgresql/data', '${ALT_PW:?', 'http://api:5000', 'NEXT_PUBLIC_API_BASE: "http://localhost:9080"']) {
			assert.ok(compose.includes(expected), expected);
		}
		assert.ok(scaffold.files.find(file => file.path === 'api/Dockerfile')!.content.includes('ASPNETCORE_URLS=http://+:5000'));
	});

	test('projectDeployScaffold requires a valid deploy Selection and a valid Build Configuration, and leaves Authoring Data untouched', () => {
		const registry = createDeployTemplateRegistry();
		const data = authoring();
		const snapshot = JSON.stringify(data);
		rejects(() => projectDeployScaffold(data, configuration(), registry), /deploy/);
		rejects(() => projectDeployScaffold(data, withDeploy({ deploy: { template_id: 'missing', host: 'linux' } }), registry), /unresolved/);
		rejects(() => projectDeployScaffold(data, withDeploy({ output_path: 'elsewhere' }), registry), /output_path/);
		assert.throws(() => projectDeployScaffold(data, withDeploy({ output_path: 'elsewhere' }), registry), BuildValidationError);
		projectDeployScaffold(data, withDeploy(), registry);
		assert.strictEqual(JSON.stringify(data), snapshot);
	});

	test('createDeployScaffold is a pure function of its inputs', () => {
		const template = parseDeployTemplate(DOC);
		const selection = createDeploySelection({ template_id: template.id, host: 'linux' });
		const files = ['application.definition.json', '001_init_postgresql.sql'];
		assert.deepStrictEqual(createDeployScaffold(template, selection, files, []), createDeployScaffold(template, selection, files, []));
	});
});
