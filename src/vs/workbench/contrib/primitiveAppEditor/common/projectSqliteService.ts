/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite factory service (workbench.integration)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (4. SQLite, 39. Boundary)
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IProjectSqliteDatabase, IProjectSqliteDatabaseFactory, ProjectSqliteError, ProjectSqliteOpenMode } from './projectSqlite.js';

/**
 * The Workbench-side access to `project.sqlite`. The SQLite adapter runs in Node (`node/`); a
 * Workbench that has no Node-side adapter registers {@link UnavailableProjectSqliteDatabaseFactory},
 * so a Project Open ends in a visible `failed` state instead of reaching `Editor Ready`.
 */
export const IProjectSqliteDatabaseFactoryService = createDecorator<IProjectSqliteDatabaseFactoryService>('primitiveAppEditorProjectSqliteDatabaseFactory');

export interface IProjectSqliteDatabaseFactoryService extends IProjectSqliteDatabaseFactory {
	readonly _serviceBrand: undefined;
}

export class UnavailableProjectSqliteDatabaseFactory implements IProjectSqliteDatabaseFactoryService {

	declare readonly _serviceBrand: undefined;

	open(resource: URI, _mode: ProjectSqliteOpenMode): Promise<IProjectSqliteDatabase> {
		return Promise.reject(new ProjectSqliteError('No project.sqlite adapter is available in this Workbench', resource));
	}
}
