/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Workbench service (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure), Editor UI.md (3, 9, 10, 14)
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IAsset } from '../common/assetRegistry.js';
import { createExecutorProgramResolver, IBuildExportPlanFile, listDeployTemplates } from '../common/buildExportConfiguration.js';
import { writeBuildExport } from '../common/buildExportWriter.js';
import { IBuildAuthoringData, IBuildRawDataTable, normalizeWorkingDirectoryPath } from '../common/buildValidation.js';
import { createDeployTemplateRegistry, IDeployTemplateRegistry } from '../common/deployProjection.js';
import { IDynamicResolveContext } from '../common/dynamicResolve.js';
import { editorDdlResources } from '../common/editorDdlResources.js';
import { EnumRegistryIndex } from '../common/enumRegistry.js';
import { FunctionBindingService, IFunctionBindingEntry, readFunctionBindings } from '../common/functionBinding.js';
import { FunctionDependencyService, readFunctionDependencies } from '../common/functionDependency.js';
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

	private readonly deployTemplateRegistry = createDeployTemplateRegistry();
	private functionBindings: readonly IFunctionBindingEntry[] = [];
	private generation = 0;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IProjectSqliteDatabaseFactoryService databaseFactory: IProjectSqliteDatabaseFactoryService,
		@IEditorService private readonly editorService: IEditorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this.session = new ProjectOpenSession(fileService, databaseFactory, editorDdlResources, this.executorCatalog);
		this._register(this.session.onDidChangeState(state => this.onDidChangeState(state)));
		this._register({ dispose: () => { void this.session.close(); } });
	}

	private onDidChangeState(state: IProjectOpenSessionState): void {
		const generation = ++this.generation;
		// Project switch / Close: drop the previous Project's Selection and Editor Area tabs (no stale state is shown).
		if (this.views.applyProjectState(state.state === ProjectOpenState.Ready, state.root?.toString())) {
			this.closeProjectEditors();
		}
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

	/** Closes every open Editor Area tab of the App Editor; they hold the previous Project's content. */
	private closeProjectEditors(): void {
		for (const group of this.editorGroupsService.groups) {
			const editors = group.editors.filter(editor => editor instanceof PrimitiveAppEditorInput);
			if (editors.length > 0) {
				void group.closeEditors(editors, { preserveFocus: true });
			}
		}
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
			deployTemplates: ready ? listDeployTemplates(this.deployTemplateRegistry) : [],
		};
	}

	getDeployTemplateRegistry(): IDeployTemplateRegistry {
		return this.deployTemplateRegistry;
	}

	async loadBuildAuthoringData(): Promise<IBuildAuthoringData> {
		const services = this.getResolverServices();
		const root = this.session.state.root;
		if (!services || !root) {
			throw new Error(localize('primitiveAppEditor.noProject', "No project is open."));
		}
		const context = await this.loadResolveContext();
		const dependencies = await services.database.transaction(statements => readFunctionDependencies(statements));
		const rawData: IBuildRawDataTable[] = [];
		for (const table of context.tables) {
			const rows = await services.rawData.select(table.uuid);
			if (rows.length > 0) {
				rawData.push({ table_uuid: table.uuid, rows: rows.map(row => ({ uuid: row.uuid, values: row.values })) });
			}
		}
		const workingDirectoryPaths: string[] = [];
		for (const directory of ['functions', 'scripts', 'config']) {
			workingDirectoryPaths.push(...await this.listFiles(joinPath(root, directory), directory));
		}
		return {
			tables: context.tables,
			relations: context.relations,
			functions: context.functions,
			bindings: context.functionBindings,
			dependencies,
			renderers: context.renderers,
			rendererBindings: context.rendererBindings,
			assets: context.assets,
			rawData,
			workingDirectoryPaths,
			executorCatalog: this.executorCatalog,
			resolveExecutorProgram: createExecutorProgramResolver(this.session.state.functionScan?.programs ?? []),
		};
	}

	async listOutputFiles(outputPath: string): Promise<readonly string[]> {
		const root = this.session.state.root;
		const path = normalizeWorkingDirectoryPath(outputPath);
		if (!root || path === undefined) {
			return [];
		}
		return this.listFiles(joinPath(root, path), '');
	}

	/** Files under `directory` (recursively), relative paths prefixed by `prefix`; a missing directory has none. */
	private async listFiles(directory: URI, prefix: string): Promise<string[]> {
		let stat;
		try {
			stat = await this.fileService.resolve(directory);
		} catch (error) {
			if (toFileOperationResult(error as Error) === FileOperationResult.FILE_NOT_FOUND) {
				return [];
			}
			throw error;
		}
		const files: string[] = [];
		for (const child of stat.children ?? []) {
			const path = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.isDirectory) {
				files.push(...await this.listFiles(child.resource, path));
			} else if (child.isFile) {
				files.push(path);
			}
		}
		return files.sort();
	}

	async exportBuild(plan: readonly IBuildExportPlanFile[]): Promise<void> {
		const root = this.session.state.root;
		if (!root) {
			throw new Error(localize('primitiveAppEditor.noProject', "No project is open."));
		}
		await writeBuildExport(plan, {
			exists: path => this.fileService.exists(joinPath(root, path)),
			write: async (path, content) => { await this.fileService.writeFile(joinPath(root, path), VSBuffer.fromString(content)); },
		}, (text, severity) => this.output.append(BottomPanelView.BuildLog, text, severity));
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
				// The Function Graph, Debug Viewer and Build / Export Configuration are one tab per project: their tab keeps its kind title.
				await this.editorService.openEditor(new PrimitiveAppEditorInput(activation.tab.target, activation.tab.uuid, activation.tabKind === EditorTabKind.FunctionGraph || activation.tabKind === EditorTabKind.DebugViewer || activation.tabKind === EditorTabKind.BuildExport ? undefined : label), { pinned: true });
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
