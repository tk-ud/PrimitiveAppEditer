/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Workbench service (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure), Editor UI.md (3, 9, 10, 14)
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IBuildExportPlanFile, IDeploySelection } from './buildExportConfiguration.js';
import { IBuildAuthoringData } from './buildValidation.js';
import { DeployHost, IDeployTemplateRegistry } from './deployProjection.js';
import { DeployTemplateService } from './deployTemplateService.js';
import { IDynamicResolveContext } from './dynamicResolve.js';
import { IFunctionExecutorCatalog } from './functionRegistry.js';
import { ProjectOpenSession } from './projectOpenSession.js';
import { IResolverServices } from './resolver.js';
import { BottomPanelOutput, ISideBarContext, ISideBarNode, SideBarOpen, WorkbenchViewsModel } from './workbenchViews.js';

/**
 * The one Workbench-side owner of the Project Open session, the Shared Selection Context, the Editor
 * Area tabs and the Bottom Panel output. Views, Editors and the Inspector read the project through it and
 * never open `project.sqlite` themselves.
 */
export const IPrimitiveAppEditorService = createDecorator<IPrimitiveAppEditorService>('primitiveAppEditorService');

export interface IPrimitiveAppEditorService {
	readonly _serviceBrand: undefined;

	readonly session: ProjectOpenSession;
	readonly views: WorkbenchViewsModel;
	readonly output: BottomPanelOutput;
	readonly executorCatalog: IFunctionExecutorCatalog;

	/** Fires when the Project Open state or the Function Bindings the Side Bar lists change. */
	readonly onDidChangeProject: Event<void>;

	/** The snapshot the Primary Side Bar lists (empty until a Project is Ready). */
	getSideBarContext(): ISideBarContext;

	/** The services of the generic Resolver of the Ready Project; `undefined` without a Ready Project. */
	getResolverServices(): IResolverServices | undefined;

	/** Re-reads the Registry / Binding snapshot the Registry Driven Inspector resolves. */
	loadResolveContext(): Promise<IDynamicResolveContext>;

	/** The Authoring Data the Build reads (Registry / Raw Data / Binding / Working Directory), read-only. */
	loadBuildAuthoringData(): Promise<IBuildAuthoringData>;

	/** The Editor-wide Deploy Template Registry as of now (built-in + user Templates; replaced on every Mutation). */
	getDeployTemplateRegistry(): IDeployTemplateRegistry;

	/** The Deploy Template Service: the only Mutation path of the Editor-wide Template Registry. */
	readonly deployTemplates: DeployTemplateService;

	/** Fires when the Editor-wide Deploy Template Registry changed (create / edit / duplicate / delete / load). */
	readonly onDidChangeDeployTemplates: Event<void>;

	/** The Template id the Build / Export Configuration Selection currently references (for the delete confirmation and the Inspector). */
	setBuildDeploySelection(templateId: string | undefined, host?: DeployHost): void;
	getBuildDeploySelection(): string | undefined;
	/** The full Selection (`template_id` / `host`) held for the open Project's lifetime; the Surface Model restores from it. */
	getBuildDeploySelectionState(): IDeploySelection;

	/**
	 * Saves the Deploy Template Editor draft through the Deploy Template Service: a new Template for the `new`
	 * tab, else the user Template of `tabUuid`. Validation failures are reported to the Bottom Panel Diagnostics
	 * and rethrown; nothing is written then.
	 */
	saveDeployTemplate(tabUuid: string, body: unknown): Promise<void>;

	/** Asks for a new id and duplicates the Template (built-in or user). Resolves `false` when cancelled. */
	duplicateDeployTemplate(templateId: string): Promise<boolean>;

	/** Asks for confirmation and deletes the user Template. Resolves `false` when cancelled. The Selection is not rewritten. */
	deleteDeployTemplate(templateId: string): Promise<boolean>;

	/** Files already present under `outputPath` (relative to it, `/` separated); empty when the directory does not exist. */
	listOutputFiles(outputPath: string): Promise<readonly string[]>;

	/**
	 * Writes the Build / Export plan under the Working Directory and logs to the Bottom Panel Build Log.
	 * Scaffold files are never overwritten (an existing file rejects); the Editor never executes a generated file.
	 */
	exportBuild(plan: readonly IBuildExportPlanFile[]): Promise<void>;

	/** Tree / List Select: Shared Selection Context + optional Editor Area / Bottom Panel Open. */
	activate(node: ISideBarNode): Promise<void>;

	/** Opens (or reuses) the Editor Area tab, text editor or Bottom Panel view of a request. `label` names a new tab. */
	open(request: SideBarOpen, label?: string): Promise<void>;
}
