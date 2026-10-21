/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor Area surfaces (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (10. Editor Area, 14. Debug Viewer), Function Graph.md (2)
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { BuildExportConfigurationModel, IBuildChecklistItem, BuildItemState } from '../common/buildExportConfiguration.js';
import { DataEditorTarget, DataGridModel } from '../common/dataEditor.js';
import { DeployHost } from '../common/deployProjection.js';
import { DebugViewer } from '../common/debugViewer.js';
import { IDynamicResolveContext } from '../common/dynamicResolve.js';
import { FunctionGraphModel } from '../common/functionGraph.js';
import { IPrimitiveAppEditorService } from '../common/primitiveAppEditorService.js';
import { getRegistryDisplayText } from '../common/registryIdentity.js';
import { Resolver } from '../common/resolver.js';
import { loadRuntimeState } from '../common/runtimeState.js';
import { BottomPanelSeverity, BottomPanelView } from '../common/workbenchViews.js';
import { PrimitiveAppEditorInput } from './primitiveAppEditorEditorInput.js';

type Rows = readonly (readonly [string, string])[];

function definition(parent: HTMLElement, title: string, rows: Rows): void {
	append(parent, $('h2', undefined, title));
	const list = append(parent, $('dl', { 'data-pae-marker': 'editor.definition' }));
	for (const [key, value] of rows) {
		append(list, $('dt', undefined, key));
		append(list, $('dd', undefined, value));
	}
}

function tableLabel(context: IDynamicResolveContext, uuid: string): string {
	const table = context.tables.find(candidate => candidate.uuid === uuid);
	return table ? getRegistryDisplayText(table) : localize('primitiveAppEditor.missingTable', "Missing table");
}

/** Registry / Renderer / Asset / Relation / Physical Table definitions: structural, read-only views of the Registry. */
function renderDefinition(parent: HTMLElement, input: PrimitiveAppEditorInput, context: IDynamicResolveContext): void {
	const uuid = input.uuid;
	const table = context.tables.find(candidate => candidate.uuid === uuid);
	if (table) {
		definition(parent, getRegistryDisplayText(table), [
			[localize('primitiveAppEditor.schema', "Schema"), table.schema],
			...[...table.columns].sort((a, b) => a.index - b.index).map((column): readonly [string, string] => [getRegistryDisplayText(column), `${column.kind}${column.not_null ? ' · not null' : ''}${column.writable ? '' : ' · read only'}`]),
		]);
		return;
	}
	const enumEntry = context.enumEntries.find(candidate => candidate.uuid === uuid);
	if (enumEntry) {
		definition(parent, getRegistryDisplayText(enumEntry), enumEntry.values.map((value): readonly [string, string] => [value.value, value.label ?? '']));
		return;
	}
	const fn = context.functions.find(candidate => candidate.uuid === uuid);
	if (fn) {
		definition(parent, getRegistryDisplayText(fn), [
			[localize('primitiveAppEditor.executor', "Executor"), fn.executor],
			...fn.input.map((entry): readonly [string, string] => [localize('primitiveAppEditor.inputs', "Input") + ' ' + entry.name, entry.kind]),
			[localize('primitiveAppEditor.output', "Output"), fn.output.kind],
		]);
		return;
	}
	const renderer = context.renderers.find(candidate => candidate.uuid === uuid);
	if (renderer) {
		definition(parent, getRegistryDisplayText(renderer), [
			[localize('primitiveAppEditor.executor', "Executor"), renderer.executor],
			...renderer.inputs.map((entry): readonly [string, string] => [localize('primitiveAppEditor.inputs', "Input") + ' ' + entry.name, entry.kind]),
		]);
		return;
	}
	const asset = context.assets.find(candidate => candidate.uuid === uuid);
	if (asset) {
		definition(parent, getRegistryDisplayText(asset), [[localize('primitiveAppEditor.kind', "Kind"), asset.kind], [localize('primitiveAppEditor.source', "Source"), asset.source]]);
		return;
	}
	const relation = context.relations.find(candidate => candidate.uuid === uuid);
	if (relation) {
		definition(parent, tableLabel(context, relation.main_table), relation.relations.map((join): readonly [string, string] => [tableLabel(context, join.join_table), join.relation_type]));
		return;
	}
	append(parent, $('.pae-error', undefined, localize('primitiveAppEditor.missingDefinition', "The definition no longer exists in the Registry.")));
}

async function renderDataGrid(parent: HTMLElement, input: PrimitiveAppEditorInput, appEditor: IPrimitiveAppEditorService, context: IDynamicResolveContext): Promise<void> {
	const services = appEditor.getResolverServices();
	const table = context.tables.find(candidate => candidate.uuid === input.uuid);
	if (!services || !table) {
		append(parent, $('.pae-error', undefined, localize('primitiveAppEditor.missingDefinition', "The definition no longer exists in the Registry.")));
		return;
	}
	const model = new DataGridModel(new Resolver(services), table, context.enums);
	const rows = await model.load();
	append(parent, $('h2', undefined, getRegistryDisplayText(table)));
	const grid = append(parent, $('table', { role: 'grid', 'data-pae-marker': 'editor.grid' }));
	const head = append(append(grid, $('thead')), $('tr'));
	for (const column of model.columns) {
		append(head, $('th', undefined, column.header));
	}
	const body = append(grid, $('tbody'));
	let selectedRow: HTMLElement | undefined;
	for (const row of rows) {
		const tr = append(body, $('tr', { 'data-pae-marker': 'editor.grid.row', 'data-pae-item': row.uuid }));
		for (const cell of row.cells) {
			append(tr, $('td', undefined, cell.displayValue ?? (cell.value === null || cell.value === undefined ? '' : String(cell.value))));
		}
		tr.addEventListener('click', () => {
			model.selectRow(row.uuid, appEditor.views.selection);
			selectedRow?.classList.remove('selected');
			selectedRow = tr;
			tr.classList.add('selected');
		});
	}
}

async function renderFunctionGraph(parent: HTMLElement, appEditor: IPrimitiveAppEditorService, context: IDynamicResolveContext): Promise<void> {
	const services = appEditor.getResolverServices();
	if (!services) {
		return;
	}
	const model = new FunctionGraphModel(new Resolver(services), () => ({ functions: context.functions, tables: context.tables }));
	const graph = await model.load();
	append(parent, $('h2', undefined, localize('primitiveAppEditor.functionGraph', "Function Graph")));
	const nodes = append(parent, $('ul', { 'data-pae-marker': 'editor.graph.nodes' }));
	for (const node of graph.nodes) {
		const item = append(nodes, $('li', { tabIndex: 0, 'data-pae-marker': 'editor.graph.node', 'data-pae-item': node.uuid }, `${node.label} · ${node.state.execution}${node.state.target ? ` → ${node.state.target}` : ''}`));
		item.addEventListener('click', () => model.selectNode(node.uuid, appEditor.views.selection));
	}
	if (graph.edges.length > 0) {
		append(parent, $('h3', undefined, localize('primitiveAppEditor.dependencies', "Dependencies")));
		const edges = append(parent, $('ul', { 'data-pae-marker': 'editor.graph.edges' }));
		for (const edge of graph.edges) {
			append(edges, $('li', { 'data-pae-marker': 'editor.graph.edge', 'data-pae-item': edge.uuid }, edge.label));
		}
	}
	for (const diagnostic of graph.diagnostics) {
		append(parent, $('.pae-error', undefined, diagnostic));
	}
}

async function renderDebugViewer(parent: HTMLElement, appEditor: IPrimitiveAppEditorService, context: IDynamicResolveContext): Promise<void> {
	const database = appEditor.session.database;
	if (!database) {
		return;
	}
	const state = await loadRuntimeState(database);
	const viewer = new DebugViewer({ state, tables: context.tables, enums: context.enums }, appEditor.views.selection);
	const view = viewer.runtimeState();
	append(parent, $('h2', undefined, localize('primitiveAppEditor.debugViewer', "Debug Viewer")));
	const list = append(parent, $('ul', { 'data-pae-marker': 'editor.debug.entities' }));
	for (const entity of view.entities) {
		const item = append(list, $('li', { tabIndex: 0, 'data-pae-marker': 'editor.debug.entity', 'data-pae-item': entity.row_uuid }, `${entity.table} · ${entity.label}`));
		item.addEventListener('click', () => viewer.selectEntity(entity.row_uuid));
	}
}

// #region Build / Export Configuration

function checklist(parent: HTMLElement, marker: string, title: string, items: readonly IBuildChecklistItem[], onToggle: (id: string, included: boolean) => void, onChange: () => void): void {
	append(parent, $('h3', undefined, title));
	if (items.length === 0) {
		append(parent, $('.pae-empty', undefined, localize('primitiveAppEditor.build.none', "None")));
		return;
	}
	const list = append(parent, $('ul', { 'data-pae-marker': marker }));
	for (const item of items) {
		const row = append(list, $('li', { 'data-pae-marker': `${marker}.item`, 'data-pae-item': item.id }));
		const label = append(row, $('label'));
		const box = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
		box.checked = item.state === BuildItemState.Included;
		append(label, $('span', undefined, ` ${item.label} `));
		const badge = append(label, $('span.pae-badge', { title: item.state === BuildItemState.Excluded ? localize('primitiveAppEditor.build.excludedHint', "Not exported to the Production Application. Select it to include it.") : '' }, item.state));
		badge.setAttribute('data-pae-state', item.state);
		box.addEventListener('change', () => { onToggle(item.id, box.checked); onChange(); });
	}
}

/**
 * Build / Export Configuration (Editor UI 13): Configure / Validate / Build / Export in the Editor Area.
 * Controls are explicit (checkbox, select); the Deploy Template declares every environment value, so the
 * Surface shows them read-only and has no parameter Control. Results go to the Bottom Panel Build Log.
 */
async function renderBuildExport(parent: HTMLElement, appEditor: IPrimitiveAppEditorService): Promise<void> {
	const authoring = await appEditor.loadBuildAuthoringData();
	const model = new BuildExportConfigurationModel(authoring, appEditor.getDeployTemplateRegistry());
	const root = append(parent, $('div', { 'data-pae-marker': 'build.export.configuration' }));
	let generation = 0;

	const render = () => {
		const current = ++generation;
		clearContents(root);
		append(root, $('h2', undefined, localize('primitiveAppEditor.build.title', "Build / Export Configuration")));
		append(root, $('p', undefined, `${model.buildTarget} · ${model.runtimeStorageTarget}`));

		const seed = model.seed();
		const seedBox = append(append(root, $('label')), $('input', { type: 'checkbox', 'data-pae-marker': 'build.export.seed' })) as HTMLInputElement;
		seedBox.checked = seed.include;
		append(seedBox.parentElement!, $('span', undefined, ` ${localize('primitiveAppEditor.build.seed', "Include Seed Data")}`));
		seedBox.addEventListener('change', () => { model.setSeedInclude(seedBox.checked); render(); });
		checklist(root, 'build.export.raw-data', localize('primitiveAppEditor.build.rawData', "Raw Data tables"), seed.tables, (id, included) => model.setSeedTable(id, included), render);
		for (const table of seed.tables.filter(candidate => candidate.state === BuildItemState.Included)) {
			checklist(root, 'build.export.rows', table.label, table.rows, (id, included) => model.setRowExcluded(id, !included), render);
		}
		checklist(root, 'build.export.assets', localize('primitiveAppEditor.build.assets', "Assets"), model.assetItems(), (id, included) => model.setAsset(id, included), render);
		checklist(root, 'build.export.functions', localize('primitiveAppEditor.build.functions', "Functions"), model.functionItems(), (id, included) => model.setFunction(id, included), render);
		checklist(root, 'build.export.scripts', localize('primitiveAppEditor.build.scripts', "Scripts"), model.scriptItems(), (id, included) => model.setScript(id, included), render);
		checklist(root, 'build.export.config', localize('primitiveAppEditor.build.config', "Config"), model.configItems(), (id, included) => model.setConfig(id, included), render);

		append(root, $('h3', undefined, localize('primitiveAppEditor.build.outputPath', "Output Path")));
		const output = append(root, $('input', { type: 'text', value: model.outputPath, 'data-pae-marker': 'build.export.output-path' })) as HTMLInputElement;
		output.addEventListener('change', () => { model.outputPath = output.value; render(); });

		append(root, $('h3', undefined, localize('primitiveAppEditor.build.deploy', "Deploy Environment")));
		const host = append(root, $('select', { 'data-pae-marker': 'build.export.host' })) as HTMLSelectElement;
		for (const value of [DeployHost.Linux, DeployHost.WindowsWsl2, DeployHost.MacOs]) {
			const option = append(host, $('option', { value }, value)) as HTMLOptionElement;
			option.selected = value === model.host;
		}
		host.addEventListener('change', () => { model.selectHost(host.value as DeployHost); render(); });
		const choices = model.templateChoices();
		const select = append(root, $('select', { 'data-pae-marker': 'build.export.template' })) as HTMLSelectElement;
		append(select, $('option', { value: '' }, localize('primitiveAppEditor.build.noTemplate', "(no Deploy Template)")));
		for (const choice of choices) {
			const option = append(select, $('option', { value: choice.id }, `${choice.label} · ${choice.origin}`)) as HTMLOptionElement;
			option.selected = choice.selected;
		}
		select.addEventListener('change', () => { model.selectTemplate(select.value || undefined); render(); });
		const template = model.selectedTemplate();
		if (template) {
			definition(root, template.label, [
				[localize('primitiveAppEditor.build.templateDescription', "Description"), template.description],
				[localize('primitiveAppEditor.build.templateApi', "API port"), `${template.services.api.host_port} → ${template.services.api.internal_port}`],
				[localize('primitiveAppEditor.build.templateUi', "UI port"), `${template.services.ui.host_port} → ${template.services.ui.internal_port}`],
				[localize('primitiveAppEditor.build.templateDatabase', "Database"), `${template.services.database.image} · ${template.services.database.data_volume}`],
			]);
		}

		void appEditor.listOutputFiles(model.outputPath).then(existing => {
			if (current !== generation) {
				return;
			}
			const preview = model.preview(existing);
			const status = append(root, $('div', { 'data-pae-marker': 'build.export.validation', 'data-pae-state': preview.valid ? 'valid' : 'invalid' }));
			append(status, $('h3', undefined, localize('primitiveAppEditor.build.validation', "Validation")));
			if (preview.valid) {
				append(status, $('p', undefined, localize('primitiveAppEditor.build.valid', "Valid.")));
				const files = append(status, $('ul', { 'data-pae-marker': 'build.export.files' }));
				for (const file of preview.scaffoldFiles) {
					append(files, $('li', { 'data-pae-marker': 'build.export.file', 'data-pae-item': file.path }, file.path === file.requested ? file.path : `${file.path} (${file.requested})`));
				}
				if (preview.startCommand) {
					append(status, $('p', undefined, localize('primitiveAppEditor.build.startCommand', "To start (run it yourself; the Editor does not execute it):")));
					append(status, $('code', { 'data-pae-marker': 'build.export.start-command' }, preview.startCommand));
				}
			} else {
				for (const diagnostic of preview.report.diagnostics) {
					append(status, $('.pae-error', undefined, diagnostic));
				}
			}
			const button = append(root, $('button', { 'data-pae-marker': 'build.export.action' }, localize('primitiveAppEditor.build.action', "Build / Export / Scaffold"))) as HTMLButtonElement;
			button.disabled = !preview.valid;
			button.addEventListener('click', () => {
				button.disabled = true;
				appEditor.exportBuild(preview.plan).then(() => render(), error => {
					appEditor.output.append(BottomPanelView.Diagnostics, error instanceof Error ? error.message : String(error), BottomPanelSeverity.Error);
					button.disabled = false;
				});
			});
		}, error => {
			if (current === generation) {
				append(root, $('.pae-error', undefined, error instanceof Error ? error.message : String(error)));
			}
		});
	};
	render();
}

function clearContents(element: HTMLElement): void {
	while (element.firstChild) {
		element.removeChild(element.firstChild);
	}
}

// #endregion

/** Renders the surface of one Editor Area tab from the Ready Project's Registry / Raw Data. */
export async function renderEditorSurface(parent: HTMLElement, input: PrimitiveAppEditorInput, appEditor: IPrimitiveAppEditorService): Promise<void> {
	if (!appEditor.getResolverServices()) {
		append(parent, $('.pae-empty', undefined, localize('primitiveAppEditor.editor.noProject', "Open a folder to use it as a project.")));
		return;
	}
	const context = await appEditor.loadResolveContext();
	switch (input.target) {
		case DataEditorTarget.DataGrid: return renderDataGrid(parent, input, appEditor, context);
		case DataEditorTarget.FunctionGraph: return renderFunctionGraph(parent, appEditor, context);
		case DataEditorTarget.DebugViewer: return renderDebugViewer(parent, appEditor, context);
		case DataEditorTarget.BuildExport: return renderBuildExport(parent, appEditor);
		default: return renderDefinition(parent, input, context);
	}
}
