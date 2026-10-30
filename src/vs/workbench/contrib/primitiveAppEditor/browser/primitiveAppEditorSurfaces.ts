/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor Area surfaces (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (10. Editor Area, 14. Debug Viewer), Function Graph.md (2)
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { BuildExportConfigurationModel, checklistSurfaceNodes, IBuildSurfaceNode, targetSurfaceNodes } from '../common/buildExportConfiguration.js';
import { DataEditorTarget, DataGridModel } from '../common/dataEditor.js';
import { buildTargetRuntimeStorageTargets } from '../common/buildValidation.js';
import { DeployHost, DeployTemplateOrigin } from '../common/deployProjection.js';
import { DeployTemplateControlKind, DeployTemplateDraft, draftForNewTemplate, draftForTemplate, findDeployTemplateTabEntry, NEW_DEPLOY_TEMPLATE_TAB } from '../common/deployTemplateService.js';
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

/** Mounts the Surface node structure one to one; only the listeners named by `action` are attached. */
function mountSurfaceNodes(parent: HTMLElement, nodes: readonly IBuildSurfaceNode[], onAction: (node: IBuildSurfaceNode, value: string | boolean) => void): void {
	for (const node of nodes) {
		const element = append(parent, document.createElement(node.tag));
		for (const [name, value] of Object.entries(node.attrs ?? {})) {
			if (name === 'checked') {
				(element as HTMLInputElement).checked = value === true;
			} else if (name === 'selected') {
				(element as HTMLOptionElement).selected = value === true;
			} else if (name === 'class') {
				element.className = String(value);
			} else if (name !== 'title' || value) {
				element.setAttribute(name, String(value));
			}
		}
		if (node.text !== undefined) {
			element.textContent = node.text;
		}
		if (node.action?.kind === 'toggle') {
			element.addEventListener('change', () => onAction(node, (element as HTMLInputElement).checked));
		} else if (node.action?.kind === 'select-target') {
			element.addEventListener('change', () => onAction(node, (element as HTMLSelectElement).value));
		}
		mountSurfaceNodes(element, node.children ?? [], onAction);
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
		const targetSetters: Record<string, (target: string) => void> = {
			'build.export.build-target': target => model.selectBuildTarget(target),
			'build.export.runtime-storage-target': target => model.selectRuntimeStorageTarget(target),
		};
		const onTarget = (node: IBuildSurfaceNode, value: string | boolean) => { targetSetters[node.action!.marker](String(value)); render(); };
		mountSurfaceNodes(root, targetSurfaceNodes('build.export.build-target', localize('primitiveAppEditor.build.buildTarget', "Build Target"), model.buildTargetDisplay()), onTarget);
		mountSurfaceNodes(root, targetSurfaceNodes('build.export.runtime-storage-target', localize('primitiveAppEditor.build.runtimeStorageTarget', "Runtime / Storage Target"), model.runtimeStorageTargetDisplay()), onTarget);

		const seed = model.seed();
		const seedBox = append(append(root, $('label')), $('input', { type: 'checkbox', 'data-pae-marker': 'build.export.seed' })) as HTMLInputElement;
		seedBox.checked = seed.include;
		append(seedBox.parentElement!, $('span', undefined, ` ${localize('primitiveAppEditor.build.seed', "Include Seed Data")}`));
		seedBox.addEventListener('change', () => { model.setSeedInclude(seedBox.checked); render(); });
		const toggles: Record<string, (id: string, included: boolean) => void> = {
			'build.export.raw-data': (id, included) => model.setSeedTable(id, included),
			'build.export.rows': (id, included) => model.setRowExcluded(id, !included),
			'build.export.assets': (id, included) => model.setAsset(id, included),
			'build.export.functions': (id, included) => model.setFunction(id, included),
			'build.export.scripts': (id, included) => model.setScript(id, included),
			'build.export.config': (id, included) => model.setConfig(id, included),
		};
		for (const section of model.checklistSections()) {
			mountSurfaceNodes(root, checklistSurfaceNodes(section), (node, value) => { toggles[node.action!.marker](node.action!.kind === 'toggle' ? node.action!.id : '', value === true); render(); });
		}

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
		select.addEventListener('change', () => { model.selectTemplate(select.value || undefined); appEditor.setBuildDeploySelection(select.value || undefined); appEditor.views.selectDeployTemplate(select.value || undefined); render(); });
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
	const listener = appEditor.onDidChangeDeployTemplates(() => {
		if (!root.isConnected) {
			listener.dispose();
			return;
		}
		model.updateRegistry(appEditor.getDeployTemplateRegistry());
		render();
	});
}

/**
 * Deploy Template Editor (Editor Area): the Controls are derived from the Deploy Template Definition Schema
 * (there is no parameter input), a built-in Template is read-only, and Save is possible only when the draft
 * validates; the Mutation goes through the Deploy Template Service. Results go to the Bottom Panel Diagnostics.
 */
function renderDeployTemplateEditor(parent: HTMLElement, input: PrimitiveAppEditorInput, appEditor: IPrimitiveAppEditorService): void {
	const root = append(parent, $('div', { 'data-pae-marker': 'deploy-template.editor' }));
	const buildTargets = [...buildTargetRuntimeStorageTargets.keys()];
	const isNew = input.uuid === NEW_DEPLOY_TEMPLATE_TAB;
	const entry = isNew ? undefined : findDeployTemplateTabEntry(appEditor.getDeployTemplateRegistry(), input.uuid);

	if (!isNew && !entry) {
		append(root, $('.pae-empty', undefined, localize('primitiveAppEditor.deployTemplate.unresolved', "Template unresolved: it is not in the Editor Template Registry.")));
		return;
	}
	const origin = entry?.origin ?? DeployTemplateOrigin.User;
	const title = isNew ? localize('primitiveAppEditor.deployTemplate.newTitle', "New Deploy Template") : entry!.template?.label ?? entry!.id;
	append(root, $('h2', undefined, title));

	const actions = append(root, $('div', { 'data-pae-marker': 'deploy-template.actions' }));
	const button = (marker: string, text: string, onClick: () => void): HTMLButtonElement => {
		const element = append(actions, $('button', { type: 'button', 'data-pae-marker': marker }, text)) as HTMLButtonElement;
		element.addEventListener('click', onClick);
		return element;
	};
	const report = (error: unknown) => appEditor.output.append(BottomPanelView.Diagnostics, error instanceof Error ? error.message : String(error), BottomPanelSeverity.Error);

	if (entry && !entry.valid) {
		append(root, $('.pae-error', { 'data-pae-marker': 'deploy-template.invalid' }, entry.diagnostic ?? ''));
		if (origin === DeployTemplateOrigin.User) {
			button('deploy-template.delete', localize('primitiveAppEditor.deployTemplate.deleteAction', "Delete"), () => { appEditor.deleteDeployTemplate(entry.id).catch(report); });
		}
		return;
	}

	const draft: DeployTemplateDraft = entry?.template ? draftForTemplate(entry.template, origin, buildTargets) : draftForNewTemplate(buildTargets);
	if (draft.readOnly) {
		append(root, $('p', { 'data-pae-marker': 'deploy-template.readonly' }, localize('primitiveAppEditor.deployTemplate.readonly', "Built-in Template (read-only). Duplicate it to create an editable Template.")));
	}
	const save = draft.readOnly ? undefined : button('deploy-template.save', localize('primitiveAppEditor.deployTemplate.save', "Save"), () => {
		appEditor.saveDeployTemplate(input.uuid, draft.toBody()).then(() => validation(), () => validation());
	});
	if (entry) {
		button('deploy-template.duplicate', localize('primitiveAppEditor.deployTemplate.duplicateAction', "Duplicate"), () => { appEditor.duplicateDeployTemplate(entry.id).catch(report); });
		if (origin === DeployTemplateOrigin.User) {
			button('deploy-template.delete', localize('primitiveAppEditor.deployTemplate.deleteAction', "Delete"), () => { appEditor.deleteDeployTemplate(entry.id).catch(report); });
		}
	}

	const status = append(root, $('div', { 'data-pae-marker': 'deploy-template.validation' }));
	const validation = () => {
		clearContents(status);
		const result = draft.validate();
		status.setAttribute('data-pae-state', result.valid ? 'valid' : 'invalid');
		if (result.valid) {
			append(status, $('p', undefined, localize('primitiveAppEditor.deployTemplate.valid', "Valid.")));
		} else {
			append(status, $('.pae-error', { 'data-pae-item': result.path }, result.diagnostic));
		}
		if (save) {
			save.disabled = !result.valid;
		}
	};

	const fields = append(root, $('div', { 'data-pae-marker': 'deploy-template.fields' }));
	for (const control of draft.controls()) {
		const field = append(fields, $('div.pae-field', { 'data-pae-marker': 'deploy-template.field', 'data-pae-item': control.path }));
		append(field, $('label', undefined, control.label));
		const disabled = control.readonlyReason !== undefined;
		const apply = (value: string | number | boolean | readonly string[]) => {
			try {
				draft.set(control.path, value);
			} catch (error) {
				report(error);
			}
			validation();
		};
		switch (control.kind) {
			case DeployTemplateControlKind.Checkbox: {
				const box = append(field, $('input', { type: 'checkbox' })) as HTMLInputElement;
				box.checked = control.value === true;
				box.disabled = disabled;
				box.addEventListener('change', () => apply(box.checked));
				break;
			}
			case DeployTemplateControlKind.MultiSelect: {
				const selected = new Set(control.value as readonly string[]);
				for (const option of control.options ?? []) {
					const label = append(field, $('label'));
					const box = append(label, $('input', { type: 'checkbox' })) as HTMLInputElement;
					box.checked = selected.has(option);
					box.disabled = disabled;
					append(label, $('span', undefined, ` ${option}`));
					box.addEventListener('change', () => {
						if (box.checked) {
							selected.add(option);
						} else {
							selected.delete(option);
						}
						apply((control.options ?? []).filter(candidate => selected.has(candidate)));
					});
				}
				break;
			}
			default: {
				const text = append(field, $('input', { type: 'text', value: String(control.value) })) as HTMLInputElement;
				text.disabled = disabled;
				text.addEventListener('change', () => apply(text.value));
			}
		}
	}
	validation();
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
		case DataEditorTarget.DeployTemplateEditor: return renderDeployTemplateEditor(parent, input, appEditor);
		default: return renderDefinition(parent, input, context);
	}
}
