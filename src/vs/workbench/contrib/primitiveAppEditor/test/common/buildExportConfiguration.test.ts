/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Build / Export Configuration surface model (build.deploy)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (13), Deploy Configuration.md (4)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE } from '../../common/buildValidation.js';
import { createFunctionBindingEntry } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry } from '../../common/functionRegistry.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { createRendererBindingEntry, createRendererRegistryEntry } from '../../common/rendererRegistry.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';
import { BuildExportConfigurationModel, BuildItemState, createDeployTemplateInspectorView, createExecutorProgramResolver, IBuildExportPlanFile, listDeployTemplates } from '../../common/buildExportConfiguration.js';
import { BottomPanelOutput, BottomPanelSeverity, BottomPanelView, WorkbenchViewsModel } from '../../common/workbenchViews.js';
import { writeBuildExport, IBuildExportFileSystem } from '../../common/buildExportWriter.js';
import { BUILTIN_DEPLOY_TEMPLATE_DOCUMENT, BUILTIN_DEPLOY_TEMPLATE_ID, createDeployTemplateRegistry, DeployHost, DeployTemplateOrigin } from '../../common/deployProjection.js';

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

const DOC = BUILTIN_DEPLOY_TEMPLATE_DOCUMENT;

function model(userTemplates: { source: string; text: string }[] = []): BuildExportConfigurationModel {
	return new BuildExportConfigurationModel(authoring(), createDeployTemplateRegistry(userTemplates));
}

suite('Primitive App Editor - Build / Export Configuration surface model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults select everything the Authoring Data offers and expose Included / Excluded state', () => {
		const surface = model();
		const seed = surface.seed();
		assert.strictEqual(seed.include, true);
		assert.deepStrictEqual(seed.tables.map(table => [table.label, table.state, table.rows.map(row => row.state)]), [['player', BuildItemState.Included, [BuildItemState.Included]]]);
		assert.deepStrictEqual(surface.functionItems().map(item => [item.id, item.state]), [['functions/linear.ts', BuildItemState.Included]]);
		surface.setSeedTable(PLAYER, false);
		assert.strictEqual(surface.seed().tables[0].state, BuildItemState.Excluded);
		assert.strictEqual(surface.seed().tables[0].rows[0].state, BuildItemState.Excluded, 'rows of an unselected table are Excluded');
		surface.setSeedTable(PLAYER, true);
		surface.setRowExcluded(ROW1, true);
		assert.strictEqual(surface.seed().tables[0].rows[0].state, BuildItemState.Excluded);
		surface.setSeedInclude(false);
		assert.strictEqual(surface.seed().tables[0].state, BuildItemState.Excluded);
	});

	test('the Surface lists only Valid compatible Templates and Registry listing marks Invalid entries', () => {
		const surface = model([{ source: 'broken.yaml', text: 'deploy_template: 1' }, { source: 'mac.yaml', text: DOC.replace('id: docker-compose-default', 'id: linux-only').replace('[linux, windows_wsl2, macos]', '[linux]') }]);
		assert.deepStrictEqual(surface.templateChoices().map(choice => [choice.id, choice.origin, choice.selected]), [
			[BUILTIN_DEPLOY_TEMPLATE_ID, DeployTemplateOrigin.Builtin, false],
			['linux-only', DeployTemplateOrigin.User, false],
		]);
		surface.selectHost(DeployHost.MacOs);
		assert.deepStrictEqual(surface.templateChoices().map(choice => choice.id), [BUILTIN_DEPLOY_TEMPLATE_ID]);
		const listing = listDeployTemplates(createDeployTemplateRegistry([{ source: 'broken.yaml', text: 'deploy_template: 1' }]));
		assert.deepStrictEqual(listing.map(entry => [entry.id, entry.valid, entry.diagnostic !== undefined]), [[BUILTIN_DEPLOY_TEMPLATE_ID, true, false], ['broken.yaml', false, true]]);
	});

	test('without a Template the preview is not valid and nothing is planned', () => {
		const preview = model().preview();
		assert.strictEqual(preview.valid, false);
		assert.strictEqual(preview.plan.length, 0);
		assert.strictEqual(preview.startCommand, undefined);
	});

	test('a valid Selection previews the adopted Scaffold names, the plan under output_path and the start command', () => {
		const surface = model();
		surface.selectTemplate(BUILTIN_DEPLOY_TEMPLATE_ID);
		assert.deepStrictEqual(surface.configuration().deploy, { template_id: BUILTIN_DEPLOY_TEMPLATE_ID, host: 'linux' });
		const preview = surface.preview();
		assert.strictEqual(preview.valid, true, preview.report.diagnostics.join('\n'));
		assert.deepStrictEqual(preview.scaffoldFiles.map(file => file.path), ['.env.example', 'api/Dockerfile', 'compose.yml', 'ui/Dockerfile']);
		assert.strictEqual(preview.startCommand, 'docker compose -f compose.yml up -d');
		assert.ok(preview.plan.every(file => file.path.startsWith('build/output/')));
		assert.ok(preview.plan.some(file => !file.scaffold && file.path === 'build/output/001_init_postgresql.sql'));
		assert.deepStrictEqual(preview.plan.filter(file => file.scaffold).map(file => file.path), ['build/output/.env.example', 'build/output/api/Dockerfile', 'build/output/compose.yml', 'build/output/ui/Dockerfile']);
	});

	test('existing files are never overwritten: the sequence name is adopted and shown', () => {
		const surface = model();
		surface.selectTemplate(BUILTIN_DEPLOY_TEMPLATE_ID);
		const preview = surface.preview(['compose.yml', 'compose-001.yaml']);
		assert.strictEqual(preview.valid, true);
		assert.ok(preview.scaffoldFiles.some(file => file.path === 'compose-002.yml' && file.requested === 'compose.yml'));
		assert.strictEqual(preview.startCommand, 'docker compose -f compose-002.yml up -d');
		assert.ok(!preview.plan.some(file => file.scaffold && file.path === 'build/output/compose.yml'));
	});

	test('Validation reports the failing stage and rejects unknown Templates and output outside build/', () => {
		const surface = model();
		surface.selectTemplate('missing');
		let preview = surface.preview();
		assert.strictEqual(preview.valid, false);
		assert.match(preview.report.diagnostics[0], /unresolved/);
		surface.selectTemplate(BUILTIN_DEPLOY_TEMPLATE_ID);
		surface.outputPath = 'elsewhere';
		preview = surface.preview();
		assert.strictEqual(preview.valid, false);
		assert.match(preview.report.stage ?? '', /Build Configuration/);
		surface.outputPath = 'build/output';
		surface.setFunction('functions/linear.ts', false);
		preview = surface.preview();
		assert.strictEqual(preview.valid, false, 'a Binding references an executor whose Program is no longer included');
		assert.ok(preview.report.diagnostics.length > 0);
	});

	test('executor Programs resolve by file name under functions/', () => {
		const resolve = createExecutorProgramResolver([{ path: 'ai/enemy.cs' }, { path: 'linear.ts' }, { path: 'README' }]);
		assert.strictEqual(resolve('Linear'), 'functions/linear.ts');
		assert.strictEqual(resolve('Enemy'), 'functions/ai/enemy.cs');
		assert.strictEqual(resolve('README'), 'functions/README');
		assert.strictEqual(resolve('Missing'), undefined);
	});

	test('Inspector supplementary information of the selected Template; Invalid shows the diagnostic; unknown id has none', () => {
		const registry = createDeployTemplateRegistry([{ source: 'broken.yaml', text: 'deploy_template: 1' }]);
		const view = createDeployTemplateInspectorView(registry, BUILTIN_DEPLOY_TEMPLATE_ID)!;
		assert.strictEqual(view.header, 'Docker Compose (default)');
		assert.strictEqual(view.valid, true);
		assert.deepStrictEqual(view.rows.map(row => row[0]), ['Template ID', 'Description', 'Provider', 'Supported hosts', 'Compatible build targets', 'API port', 'UI port', 'Database']);
		assert.ok(view.rows.some(row => row[0] === 'Database' && row[1].startsWith('postgres:16.4')));
		const invalid = createDeployTemplateInspectorView(registry, 'broken.yaml')!;
		assert.strictEqual(invalid.valid, false);
		assert.ok(invalid.diagnostic);
		assert.strictEqual(invalid.rows.length, 0);
		assert.strictEqual(createDeployTemplateInspectorView(registry, 'nope'), undefined);
	});

	test('Template selection and Registry Selection are exclusive in the Shared Selection Context', () => {
		const views = new WorkbenchViewsModel();
		const registry = createDeployTemplateRegistry();
		const [template] = listDeployTemplates(registry);
		views.activate({ id: `build-template:${template.id}`, label: template.label, deployTemplateId: template.id, children: [] });
		assert.strictEqual(views.deployTemplateSelection.selection, BUILTIN_DEPLOY_TEMPLATE_ID);
		assert.strictEqual(views.selection.selection, undefined);
		views.selection.select({ uuid: PLAYER });
		assert.strictEqual(views.deployTemplateSelection.selection, undefined, 'a Registry Selection from any surface replaces the Template');
		views.selectDeployTemplate(BUILTIN_DEPLOY_TEMPLATE_ID);
		assert.strictEqual(views.selection.selection, undefined);
		views.selectDeployTemplate(undefined);
		assert.strictEqual(views.deployTemplateSelection.selection, undefined);
	});
});

class FakeFileSystem implements IBuildExportFileSystem {
	readonly files = new Map<string, string>();
	readonly writes: string[] = [];
	constructor(existing: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(existing)) {
			this.files.set(path, content);
		}
	}
	async exists(path: string): Promise<boolean> { return this.files.has(path); }
	async write(path: string, content: string): Promise<void> { this.files.set(path, content); this.writes.push(path); }
}

suite('Primitive App Editor - Build / Export writer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function plan(): IBuildExportPlanFile[] {
		const surface = model();
		surface.selectTemplate(BUILTIN_DEPLOY_TEMPLATE_ID);
		return [...surface.preview().plan];
	}

	test('writes the whole plan under build/ and logs to the Build Log; no execution capability is used', async () => {
		const fileSystem = new FakeFileSystem();
		const output = new BottomPanelOutput();
		const files = plan();
		await writeBuildExport(files, fileSystem, (text, severity) => output.append(BottomPanelView.BuildLog, text, severity));
		assert.deepStrictEqual(fileSystem.writes, files.map(file => file.path));
		assert.ok(fileSystem.writes.every(path => path.startsWith('build/')));
		const log = output.get(BottomPanelView.BuildLog).map(entry => entry.text);
		assert.strictEqual(log.length, files.length + 2);
		assert.ok(log.some(text => text.includes('compose.yml')));
		assert.ok(log[log.length - 1].includes('does not run'));
		assert.deepStrictEqual(Object.keys(fileSystem).sort(), ['files', 'writes'], 'the file system seam offers exists / write only');
	});

	test('a path outside build/ rejects the plan and writes nothing', async () => {
		const fileSystem = new FakeFileSystem();
		const output = new BottomPanelOutput();
		const files = [...plan(), { path: 'functions/evil.ts', content: 'x', scaffold: false }, { path: 'build/../escape.txt', content: 'x', scaffold: false }];
		await assert.rejects(() => writeBuildExport(files, fileSystem, (text, severity) => output.append(BottomPanelView.BuildLog, text, severity)), /outside the build directory/);
		assert.strictEqual(fileSystem.writes.length, 0);
		assert.strictEqual(output.get(BottomPanelView.BuildLog)[0].severity, BottomPanelSeverity.Error);
	});

	test('an existing Scaffold file rejects the plan before any write; Derived Output files are regenerated', async () => {
		const files = plan();
		const scaffold = files.find(file => file.scaffold)!;
		const derived = files.find(file => !file.scaffold)!;
		const rejected = new FakeFileSystem({ [scaffold.path]: 'user edited' });
		await assert.rejects(() => writeBuildExport(files, rejected, () => { }), /already exists/);
		assert.strictEqual(rejected.writes.length, 0);
		assert.strictEqual(rejected.files.get(scaffold.path), 'user edited');
		const regenerated = new FakeFileSystem({ [derived.path]: 'old' });
		await writeBuildExport(files, regenerated, () => { });
		assert.strictEqual(regenerated.files.get(derived.path), derived.content);
	});

	test('Raw Data row checklists share one kind-fixed Marker; table identity is the item, and no Marker repeats', () => {
		const surface = new BuildExportConfigurationModel(authoring(), createDeployTemplateRegistry([]));
		const sections = surface.checklistSections();
		const markers = sections.map(section => section.marker);
		assert.strictEqual(new Set(markers).size, markers.length, 'one Marker per checklist within the Surface');
		assert.ok(markers.every(marker => !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(marker)), 'Markers never contain a UUID');
		const rows = sections.find(section => section.marker === 'build.export.rows')!;
		assert.deepStrictEqual(rows.groups!.map(group => [group.id, group.items.map(item => item.id)]), [[PLAYER, [ROW1]]]);

		const twoTables = authoring();
		const second = '00000000-0000-4000-8000-0000000000a2';
		const copy = { ...twoTables, tables: [...twoTables.tables, createTableRegistryEntry({ uuid: second, index: 1, schema: LogicalNamespace.Items, name: 'enemy', columns: [], created_at: NOW })], rawData: [...twoTables.rawData, { table_uuid: second, rows: [] }] };
		const multi = new BuildExportConfigurationModel(copy, createDeployTemplateRegistry([])).checklistSections();
		assert.deepStrictEqual(multi.map(section => section.marker), markers, 'more tables do not add Markers');
		assert.deepStrictEqual(multi.find(section => section.marker === 'build.export.rows')!.groups!.map(group => group.id), [PLAYER, second]);
	});

	test('a single resolvable Target is shown read-only; two or more are selectable and reflected in the configuration', () => {
		const single = model();
		assert.deepStrictEqual(single.buildTargetDisplay(), { value: POSTGRESQL_WEB_APPLICATION_OUTPUT, choices: [POSTGRESQL_WEB_APPLICATION_OUTPUT], selectable: false });
		assert.strictEqual(single.runtimeStorageTargetDisplay().selectable, false);
		assert.strictEqual(single.runtimeStorageTargetDisplay().value, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE);

		const targets = new Map<string, readonly string[]>([[POSTGRESQL_WEB_APPLICATION_OUTPUT, [POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE, 'alt runtime']], ['Other Output', ['other runtime']]]);
		const multi = new BuildExportConfigurationModel(authoring(), createDeployTemplateRegistry([]), targets);
		assert.strictEqual(multi.buildTargetDisplay().selectable, true);
		assert.deepStrictEqual(multi.runtimeStorageTargetDisplay().choices, [POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE, 'alt runtime']);
		multi.selectRuntimeStorageTarget('alt runtime');
		assert.strictEqual(multi.configuration().runtime_storage_target, 'alt runtime');
		multi.selectBuildTarget('Other Output');
		assert.strictEqual(multi.configuration().build_target, 'Other Output');
		assert.strictEqual(multi.configuration().runtime_storage_target, 'other runtime');
		assert.throws(() => multi.selectBuildTarget('Unknown'));
		assert.throws(() => multi.selectRuntimeStorageTarget(POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE));
	});
});
