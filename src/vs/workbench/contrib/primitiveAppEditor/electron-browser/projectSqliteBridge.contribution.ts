/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite bridge registration, Electron renderer (workbench.project-bridge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Working Directory Integration)
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IProjectSqliteDatabaseFactoryService } from '../common/projectSqliteService.js';
import { PROJECT_SQLITE_BRIDGE_CHANNEL, ProjectSqliteBridgeDatabaseFactory } from '../common/projectSqliteBridge.js';
import { IProjectSqliteDatabase, ProjectSqliteOpenMode } from '../common/projectSqlite.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * Replaces the `Unavailable` default of the Project Open wiring (registered later, so it wins):
 * the sandboxed renderer reaches the Node-side ProjectSqlite adapter through the shared process.
 */
class SharedProcessProjectSqliteDatabaseFactory implements IProjectSqliteDatabaseFactoryService {

	declare readonly _serviceBrand: undefined;

	private readonly bridge: ProjectSqliteBridgeDatabaseFactory;

	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		this.bridge = new ProjectSqliteBridgeDatabaseFactory(sharedProcessService.getChannel(PROJECT_SQLITE_BRIDGE_CHANNEL));
	}

	open(resource: URI, mode: ProjectSqliteOpenMode): Promise<IProjectSqliteDatabase> {
		return this.bridge.open(resource, mode);
	}
}

registerSingleton(IProjectSqliteDatabaseFactoryService, SharedProcessProjectSqliteDatabaseFactory, InstantiationType.Delayed);
