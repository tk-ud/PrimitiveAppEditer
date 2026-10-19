/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Workbench integration (workbench.integration)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (3. Open, 39. Working Directory Integration)
 *  docs/primitive-app-editor/Editor UI.md (3. Workbench Placement: Status Bar = Project / Runtime / Build Status)
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { editorDdlResources } from '../common/editorDdlResources.js';
import { createFunctionPrimitiveExecutorCatalog } from '../common/functionPrimitive.js';
import { ProjectOpenStatus } from '../common/projectDirectory.js';
import { IProjectOpenSessionState, ProjectOpenSession, ProjectOpenState } from '../common/projectOpenSession.js';
import { IProjectSqliteDatabaseFactoryService, UnavailableProjectSqliteDatabaseFactory } from '../common/projectSqliteService.js';

registerSingleton(IProjectSqliteDatabaseFactoryService, UnavailableProjectSqliteDatabaseFactory, InstantiationType.Delayed);

/** Status Bar entry id of the Project Open state (stable GUI identifier: `div[id="status.primitiveAppEditor.project"]`). */
export const PROJECT_STATUS_ENTRY_ID = 'status.primitiveAppEditor.project';

/**
 * `Open Folder -> Project Directory Resolve -> App Editor Initialize -> SQLite / Registry /
 * Asset / Function Load`: opens the Workbench folder (`Folder = Project`) and shows the Project
 * Open state in the Status Bar. A workspace that is not a single local folder is not a Project.
 */
export class ProjectOpenContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.primitiveAppEditorProjectOpen';

	readonly session: ProjectOpenSession;
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IFileService fileService: IFileService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IProjectSqliteDatabaseFactoryService databaseFactory: IProjectSqliteDatabaseFactoryService,
	) {
		super();
		this.session = new ProjectOpenSession(fileService, databaseFactory, editorDdlResources, createFunctionPrimitiveExecutorCatalog());
		this._register(this.session.onDidChangeState(state => this.updateStatus(state)));
		this._register({ dispose: () => { void this.session.close(); } });
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.openWorkspaceFolder()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.openWorkspaceFolder()));
		this.openWorkspaceFolder();
	}

	private openWorkspaceFolder(): void {
		const folders = this.contextService.getWorkspace().folders;
		if (this.contextService.getWorkbenchState() !== WorkbenchState.FOLDER || folders.length !== 1) {
			void this.session.close();
			return;
		}
		if (this.session.state.root?.toString() === folders[0].uri.toString() && this.session.state.state !== ProjectOpenState.None) {
			return;
		}
		void this.session.open(folders[0].uri);
	}

	private updateStatus(state: IProjectOpenSessionState): void {
		if (state.state === ProjectOpenState.None) {
			this.statusEntry.clear();
			return;
		}
		const entry = this.toEntry(state);
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, PROJECT_STATUS_ENTRY_ID, StatusbarAlignment.LEFT, 100);
		}
	}

	private toEntry(state: IProjectOpenSessionState): IStatusbarEntry {
		const name = localize('primitiveAppEditor.status.name', "Primitive App Editor Project");
		switch (state.state) {
			case ProjectOpenState.Opening:
				return { name, text: '$(sync~spin) ' + localize('primitiveAppEditor.status.opening', "Project: Opening"), ariaLabel: localize('primitiveAppEditor.status.opening.aria', "Primitive App Editor project is opening"), tooltip: localize('primitiveAppEditor.status.opening.tooltip', "Loading project.sqlite, Registry, Functions and Assets from the working directory.") };
			case ProjectOpenState.Ready:
				return { name, text: '$(database) ' + localize('primitiveAppEditor.status.ready', "Project: Ready"), ariaLabel: localize('primitiveAppEditor.status.ready.aria', "Primitive App Editor project is ready"), tooltip: localize('primitiveAppEditor.status.ready.tooltip', "Editor Ready: project.sqlite, Registry, Functions and Assets are loaded from the working directory.") };
			case ProjectOpenState.Incomplete:
				return { name, text: '$(warning) ' + localize('primitiveAppEditor.status.incomplete', "Project: Incomplete"), ariaLabel: localize('primitiveAppEditor.status.incomplete.aria', "Primitive App Editor project open is incomplete"), kind: 'warning', tooltip: localize('primitiveAppEditor.status.incomplete.tooltip', "Required open steps are missing: {0}", state.result?.status === ProjectOpenStatus.Incomplete ? state.result.missingPhases.join(', ') : '') };
			default:
				return { name, text: '$(error) ' + localize('primitiveAppEditor.status.failed', "Project: Failed"), ariaLabel: localize('primitiveAppEditor.status.failed.aria', "Primitive App Editor project failed to open"), kind: 'error', tooltip: state.error?.message ?? '' };
		}
	}
}

registerWorkbenchContribution2(ProjectOpenContribution.ID, ProjectOpenContribution, WorkbenchPhase.AfterRestored);
