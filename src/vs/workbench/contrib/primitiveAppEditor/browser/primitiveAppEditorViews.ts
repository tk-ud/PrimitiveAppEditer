/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Primary Side Bar, Secondary Side Bar and Bottom Panel views (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (3, 9, 14, 19), App Editer.md (39)
 *--------------------------------------------------------------------------------------------*/

import './media/primitiveAppEditor.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IPrimitiveAppEditorService } from '../common/primitiveAppEditorService.js';
import { ProjectOpenState } from '../common/projectOpenSession.js';
import { createDeployTemplateInspectorView } from '../common/buildExportConfiguration.js';
import { RegistryDrivenInspector, isInspectorEmpty } from '../common/inspector.js';
import { DataEditorSelection } from '../common/dataEditor.js';
import { ActivityBarItem, BottomPanelView, createSideBarTree, DeployTemplateAction, GenerationGuard, ISideBarNode } from '../common/workbenchViews.js';
import { Resolver } from '../common/resolver.js';

abstract class PrimitiveAppEditorViewPane extends ViewPane {

	protected readonly viewDisposables = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IPrimitiveAppEditorService protected readonly appEditor: IPrimitiveAppEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected emptyText(): string {
		switch (this.appEditor.session.state.state) {
			case ProjectOpenState.Opening: return localize('primitiveAppEditor.view.opening', "Opening the project...");
			case ProjectOpenState.Incomplete: return localize('primitiveAppEditor.view.incomplete', "The project open is incomplete.");
			case ProjectOpenState.Failed: return localize('primitiveAppEditor.view.failed', "The project failed to open.");
			default: return localize('primitiveAppEditor.view.noProject', "Open a folder to use it as a project.");
		}
	}
}

/** Primary Side Bar: Discovery / Navigation / Selection of one Activity Bar item. Never a property editor. */
export class PrimitiveAppEditorSideBarView extends PrimitiveAppEditorViewPane {

	private container: HTMLElement | undefined;
	private selectedUuid: string | undefined;

	constructor(
		private readonly item: ActivityBarItem,
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IPrimitiveAppEditorService appEditor: IPrimitiveAppEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, appEditor);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = append(parent, $('.pae-tree', { role: 'tree', 'data-pae-marker': 'sidebar.tree' }));
		this.refresh();
		this._register(this.appEditor.onDidChangeProject(() => this.refresh()));
		this._register({ dispose: this.appEditor.views.selection.onDidChange(selection => { this.selectedUuid = selection?.uuid; this.refresh(); }) });
	}

	private refresh(): void {
		if (!this.container) {
			return;
		}
		clearNode(this.container);
		const tree = createSideBarTree(this.item, this.appEditor.getSideBarContext());
		if (tree.length === 0) {
			append(this.container, $('.pae-empty', undefined, this.emptyText()));
			return;
		}
		this.renderNodes(this.container, tree);
	}

	private renderNodes(parent: HTMLElement, nodes: readonly ISideBarNode[]): void {
		const list = append(parent, $('ul', { role: 'group' }));
		for (const node of nodes) {
			const row = append(list, $('li', { role: 'none' }));
			const isGroup = node.children.length > 0 || (!node.selection && !node.open);
			const attributes: Record<string, string> = {
				role: 'treeitem',
				type: 'button',
				'data-pae-marker': isGroup ? 'sidebar.group' : 'sidebar.node',
			};
			if (node.uuid) {
				attributes['data-pae-item'] = node.uuid;
			}
			if (isGroup) {
				row.classList.add('pae-group');
				attributes['aria-expanded'] = 'true';
			}
			const selected = !!node.uuid && node.uuid === this.selectedUuid;
			if (selected) {
				attributes['aria-selected'] = 'true';
			}
			const button = append(row, $(`button.pae-node${selected ? '.selected' : ''}`, attributes));
			append(button, $('span.pae-label', undefined, node.label));
			if (node.description) {
				append(button, $('span.pae-description', undefined, node.description));
			}
			if (!isGroup) {
				button.addEventListener('click', () => { void this.appEditor.activate(node); });
			}
			if (node.deployTemplateId !== undefined && node.deployTemplateActions && node.deployTemplateActions.length > 0) {
				const templateId = node.deployTemplateId;
				const actions = append(row, $('span.pae-actions', { 'data-pae-marker': 'sidebar.deploy-template.actions' }));
				for (const action of node.deployTemplateActions) {
					const label = action === DeployTemplateAction.Duplicate ? localize('primitiveAppEditor.sideBar.duplicate', "Duplicate") : localize('primitiveAppEditor.sideBar.delete', "Delete");
					const actionButton = append(actions, $('button.pae-action', { type: 'button', 'data-pae-marker': `sidebar.deploy-template.${action}`, 'data-pae-item': templateId, title: label }, label));
					actionButton.addEventListener('click', () => {
						const done = action === DeployTemplateAction.Duplicate ? this.appEditor.duplicateDeployTemplate(templateId) : this.appEditor.deleteDeployTemplate(templateId);
						done.catch(() => { /* reported to the Bottom Panel Diagnostics */ });
					});
				}
			}
			if (node.children.length > 0) {
				this.renderNodes(append(row, $('.pae-children')), node.children);
			}
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.container) {
			this.container.style.height = `${height}px`;
			this.container.style.overflow = 'auto';
		}
	}
}

/** Bottom Panel: transient Diagnostic / Execution Output of one view. Read-only; no authoring control. */
export class PrimitiveAppEditorPanelView extends PrimitiveAppEditorViewPane {

	private container: HTMLElement | undefined;

	constructor(
		private readonly view: BottomPanelView,
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IPrimitiveAppEditorService appEditor: IPrimitiveAppEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, appEditor);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = append(parent, $('.pae-output', { role: 'log', 'aria-live': 'polite', 'data-pae-marker': `panel.${this.view}` }));
		this.refresh();
		this._register({ dispose: this.appEditor.output.onDidChange(view => { if (view === this.view) { this.refresh(); } }) });
	}

	private refresh(): void {
		if (!this.container) {
			return;
		}
		clearNode(this.container);
		const entries = this.appEditor.output.get(this.view);
		if (entries.length === 0) {
			append(this.container, $('.pae-empty', undefined, localize('primitiveAppEditor.panel.empty', "No output.")));
			return;
		}
		const list = append(this.container, $('ul'));
		for (const entry of entries) {
			append(list, $(`li.${entry.severity}`, { 'data-pae-marker': 'panel.entry' }, entry.text));
		}
		this.container.scrollTop = this.container.scrollHeight;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.container) {
			this.container.style.height = `${height}px`;
			this.container.style.overflow = 'auto';
		}
	}
}

/**
 * Secondary Side Bar: the Registry Driven Inspector of the Shared Selection Context. This view presents the
 * resolved Inspector (header, properties, bindings) and its Open navigation; every Selection source (Side
 * Bar, Editor Area, Debug Viewer) writes the same context.
 */
export class PrimitiveAppEditorInspectorView extends PrimitiveAppEditorViewPane {

	private container: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IPrimitiveAppEditorService appEditor: IPrimitiveAppEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, appEditor);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = append(parent, $('.pae-inspector', { 'data-pae-marker': 'inspector.root' }));
		this.refresh();
		this._register(this.appEditor.onDidChangeProject(() => this.refresh()));
		this._register({ dispose: this.appEditor.views.selection.onDidChange(() => this.refresh()) });
		this._register({ dispose: this.appEditor.views.deployTemplateSelection.onDidChange(() => this.refresh()) });
		this._register(this.appEditor.onDidChangeDeployTemplates(() => this.refresh()));
	}

	private readonly renderGuard = new GenerationGuard();

	private refresh(): void {
		// Only the render of the current Selection may touch the DOM; a late result of an older one is discarded.
		const generation = this.renderGuard.begin();
		void this.renderInspector(generation).catch(error => {
			if (this.renderGuard.isCurrent(generation)) {
				this.renderMessage(error instanceof Error ? error.message : String(error), true);
			}
		});
	}

	private renderMessage(text: string, error = false): void {
		if (!this.container) {
			return;
		}
		clearNode(this.container);
		append(this.container, $(`.pae-empty${error ? '.pae-error' : ''}`, undefined, text));
	}

	private async renderInspector(generation: number): Promise<void> {
		const container = this.container;
		const templateId = this.appEditor.views.deployTemplateSelection.selection;
		const templateView = templateId !== undefined ? createDeployTemplateInspectorView(this.appEditor.getDeployTemplateRegistry(), templateId, templateId === this.appEditor.getBuildDeploySelection()) : undefined;
		if (container && templateView) {
			clearNode(container);
			append(container, $('h3', { 'data-pae-marker': 'inspector.header' }, templateView.header));
			if (templateView.diagnostic) {
				append(container, $('.pae-error', undefined, templateView.diagnostic));
			}
			const list = append(container, $('dl', { 'data-pae-marker': 'inspector.deploy-template' }));
			for (const [label, value] of templateView.rows) {
				append(list, $('dt', undefined, label));
				append(list, $('dd', undefined, value));
			}
			return;
		}
		const selection = this.appEditor.views.selection.selection;
		const services = this.appEditor.getResolverServices();
		if (!container) {
			return;
		}
		if (!services || !selection) {
			this.renderMessage(services ? localize('primitiveAppEditor.inspector.empty', "Select an item to inspect it.") : this.emptyText());
			return;
		}
		// The Inspector resolves the Shared Selection Context; it is fed a private copy so the resolved view stays a read of the current selection.
		const shared = new DataEditorSelection();
		shared.select(selection);
		const inspector = new RegistryDrivenInspector(new Resolver(services), () => this.appEditor.loadResolveContext(), shared, this.appEditor.views.tabs);
		const view = await inspector.refresh().finally(() => inspector.dispose());
		if (!this.renderGuard.isCurrent(generation)) {
			return;
		}
		clearNode(container);
		if (isInspectorEmpty(view)) {
			this.renderMessage(localize('primitiveAppEditor.inspector.empty', "Select an item to inspect it."));
			return;
		}
		append(container, $('h3', { 'data-pae-marker': 'inspector.header' }, view.header.label));
		const components = view.properties?.components ?? [];
		if (components.length > 0) {
			const list = append(container, $('dl', { 'data-pae-marker': 'inspector.properties' }));
			for (const component of components) {
				append(list, $('dt', undefined, component.control.label));
				append(list, $('dd', undefined, component.control.displayValue ?? (component.control.value === null || component.control.value === undefined ? '' : String(component.control.value))));
			}
		}
		const entries = view.binding?.entries ?? [];
		if (entries.length > 0) {
			append(container, $('h3', undefined, localize('primitiveAppEditor.inspector.bindings', "Bindings")));
			const list = append(container, $('ul', { 'data-pae-marker': 'inspector.bindings' }));
			for (const entry of entries) {
				append(list, $('li', undefined, entry.binding.label));
			}
		}
		for (const open of view.navigation?.open ?? []) {
			const button = append(container, $('button', { type: 'button', title: open.action.tooltip, 'aria-label': open.action.tooltip, 'data-pae-marker': 'inspector.open' }, open.action.tooltip));
			button.addEventListener('click', () => { void this.appEditor.open({ kind: 'tab', target: open.target, uuid: open.uuid }, view.header.label); });
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.container) {
			this.container.style.height = `${height}px`;
			this.container.style.overflow = 'auto';
		}
	}
}
