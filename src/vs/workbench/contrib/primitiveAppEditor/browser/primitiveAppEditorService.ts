/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Workbench service (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure), Editor UI.md (3, 9, 10, 14)
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAsset } from '../common/assetRegistry.js';
import { IDynamicResolveContext } from '../common/dynamicResolve.js';
import { editorDdlResources } from '../common/editorDdlResources.js';
import { EnumRegistryIndex } from '../common/enumRegistry.js';
import { FunctionBindingService, IFunctionBindingEntry, readFunctionBindings } from '../common/functionBinding.js';
import { FunctionDependencyService } from '../common/functionDependency.js';
import { createFunctionPrimitiveExecutorCatalog } from '../common/functionPrimitive.js';
import { IFunctionExecutorCatalog } from '../common/functionRegistry.js';
import { IPrimitiveAppEditorService } from '../common/primitiveAppEditorService.js';
import { IProjectOpenSessionState, loadRegistrySnapshot, ProjectOpenSession, ProjectOpenState } from '../common/projectOpenSession.js';
import { IProjectSqliteDatabaseFactoryService } from '../common/projectSqliteService.js';
import { RawDataService } from '../common/rawData.js';
import { RegistryService } from '../common/registryService.js';
import { readRendererBindings, RendererBindingService } from '../common/rendererRegistry.js';
import { IResolverServices } from '../common/resolver.js';
import { BottomPanelOutput, bottomPanelViewId, BottomPanelView, BottomPanelSeverity, EditorTabKind, ISideBarContext, ISideBarNode, SideBarOpen, WorkbenchViewsModel } from '../common/workbenchViews.js';
import { PrimitiveAppEditorInput } from './primitiveAppEditorEditorInput.js';

export class PrimitiveAppEditorService extends Disposable implements IPrimitiveAppEditorService {

	declare readonly _serviceBrand: undefined;

	readonly session: ProjectOpenSession;
	readonly views = new WorkbenchViewsModel();
	readonly output = new BottomPanelOutput();
	readonly executorCatalog: IFunctionExecutorCatalog = createFunctionPrimitiveExecutorCatalog();

	private readonly _onDidChangeProject = this._register(new Emitter<void>());
	readonly onDidChangeProject: Event<void> = this._onDidChangeProject.event;

	private functionBindings: readonly IFunctionBindingEntry[] = [];
	private generation = 0;

	constructor(
		@IFileService fileService: IFileService,
		@IProjectSqliteDatabaseFactoryService databaseFactory: IProjectSqliteDatabaseFactoryService,
		@IEditorService private readonly editorService: IEditorService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		this.session = new ProjectOpenSession(fileService, databaseFactory, editorDdlResources, this.executorCatalog);
		this._register(this.session.onDidChangeState(state => this.onDidChangeState(state)));
		this._register({ dispose: () => { void this.session.close(); } });
	}

	private onDidChangeState(state: IProjectOpenSessionState): void {
		const generation = ++this.generation;
		this.output.clear();
		this.functionBindings = [];
		switch (state.state) {
			case ProjectOpenState.Opening:
				this.output.append(BottomPanelView.Console, localize('primitiveAppEditor.console.opening', "Opening project: {0}", state.root ? basename(state.root) : ''));
				break;
			case ProjectOpenState.Ready:
				this.output.append(BottomPanelView.Console, localize('primitiveAppEditor.console.ready', "Project ready: {0}", state.root ? basename(state.root) : ''));
				void this.loadFunctionBindings(generation);
				break;
			case ProjectOpenState.Incomplete:
				this.output.append(BottomPanelView.Diagnostics, localize('primitiveAppEditor.diagnostics.incomplete', "Project open is incomplete: required open steps are missing."), BottomPanelSeverity.Warning);
				break;
			case ProjectOpenState.Failed:
				this.output.append(BottomPanelView.Diagnostics, state.error?.message ?? localize('primitiveAppEditor.diagnostics.failed', "Project failed to open."), BottomPanelSeverity.Error);
				break;
		}
		this._onDidChangeProject.fire();
	}

	private async loadFunctionBindings(generation: number): Promise<void> {
		const database = this.session.database;
		if (!database) {
			return;
		}
		try {
			const bindings = await database.transaction(statements => readFunctionBindings(statements));
			if (generation === this.generation) {
				this.functionBindings = bindings;
				this._onDidChangeProject.fire();
			}
		} catch (error) {
			if (generation === this.generation) {
				this.output.append(BottomPanelView.Diagnostics, error instanceof Error ? error.message : String(error), BottomPanelSeverity.Error);
			}
		}
	}

	getSideBarContext(): ISideBarContext {
		const state = this.session.state;
		const ready = state.state === ProjectOpenState.Ready;
		return {
			registry: ready ? state.registry : undefined,
			functionBindings: ready ? this.functionBindings : [],
			assets: ready ? state.assets ?? [] : [],
			programs: ready ? state.functionScan?.programs ?? [] : [],
			rootName: state.root ? basename(state.root) : '',
		};
	}

	getResolverServices(): IResolverServices | undefined {
		const database = this.session.database;
		if (!database || this.session.state.state !== ProjectOpenState.Ready) {
			return undefined;
		}
		return {
			database,
			registry: new RegistryService(database),
			rawData: new RawDataService(database),
			functionBinding: new FunctionBindingService(database, this.executorCatalog),
			functionDependency: new FunctionDependencyService(database),
			rendererBinding: new RendererBindingService(database),
		};
	}

	async loadResolveContext(): Promise<IDynamicResolveContext> {
		const database = this.session.database;
		if (!database) {
			throw new Error(localize('primitiveAppEditor.noProject', "No project is open."));
		}
		const snapshot = await loadRegistrySnapshot({ database }, this.executorCatalog);
		const functionBindings = await database.transaction(statements => readFunctionBindings(statements));
		const rendererBindings = await database.transaction(statements => readRendererBindings(statements));
		const assets: readonly IAsset[] = this.session.state.assets ?? [];
		return {
			tables: snapshot.tables,
			enums: new EnumRegistryIndex(snapshot.enums),
			enumEntries: snapshot.enums,
			relations: snapshot.relations,
			functions: snapshot.functions,
			renderers: snapshot.renderers,
			assets,
			functionBindings,
			rendererBindings,
		};
	}

	async activate(node: ISideBarNode): Promise<void> {
		const activation = this.views.activate(node);
		await this.present(activation, node.label);
	}

	async open(request: SideBarOpen, label?: string): Promise<void> {
		await this.present(this.views.open(request), label);
	}

	private async present(activation: ReturnType<WorkbenchViewsModel['open']>, label: string | undefined): Promise<void> {
		switch (activation.kind) {
			case 'tab':
				// The Function Graph and Debug Viewer are one tab per project: their tab keeps its kind title.
				await this.editorService.openEditor(new PrimitiveAppEditorInput(activation.tab.target, activation.tab.uuid, activation.tabKind === EditorTabKind.FunctionGraph || activation.tabKind === EditorTabKind.DebugViewer ? undefined : label), { pinned: true });
				break;
			case 'file': {
				const root = this.session.state.root;
				if (root) {
					await this.editorService.openEditor({ resource: joinPath(root, activation.path) });
				}
				break;
			}
			case 'panel':
				await this.viewsService.openView(bottomPanelViewId(activation.view), true);
				break;
		}
	}
}
