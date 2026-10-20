/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Workbench service (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure), Editor UI.md (3, 9, 10, 14)
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
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

	/** Tree / List Select: Shared Selection Context + optional Editor Area / Bottom Panel Open. */
	activate(node: ISideBarNode): Promise<void>;

	/** Opens (or reuses) the Editor Area tab, text editor or Bottom Panel view of a request. `label` names a new tab. */
	open(request: SideBarOpen, label?: string): Promise<void>;
}
