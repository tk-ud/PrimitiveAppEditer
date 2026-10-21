/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Build / Export writer (build.deploy)
 *  Specification SSOT: docs/primitive-app-editor/Deploy Configuration.md (4. UI flow step 7, 5. Scaffold rules)
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IBuildExportPlanFile } from './buildExportConfiguration.js';
import { BUILD_OUTPUT_DIRECTORY, normalizeWorkingDirectoryPath } from './buildValidation.js';
import { BottomPanelSeverity } from './workbenchViews.js';

/**
 * The only file operations a Build / Export performs: an existence check and a write. The Editor never
 * executes a generated file, so no execution capability exists here. Paths are Working Directory relative.
 */
export interface IBuildExportFileSystem {
	exists(path: string): Promise<boolean>;
	write(path: string, content: string): Promise<void>;
}

/** Build Log sink (Bottom Panel Build Log). */
export type BuildExportLog = (text: string, severity?: BottomPanelSeverity) => void;

/**
 * Writes the Build / Export plan. Every path must be under `build/`; every Scaffold file must not exist
 * yet (an existing file is never overwritten). Both are checked for the whole plan before the first write,
 * so a rejected plan writes nothing. Derived Application Output files are regenerated.
 */
export async function writeBuildExport(plan: readonly IBuildExportPlanFile[], fileSystem: IBuildExportFileSystem, log: BuildExportLog): Promise<void> {
	const targets = plan.map(file => ({ file, path: normalizeWorkingDirectoryPath(file.path) }));
	for (const { file, path } of targets) {
		if (path === undefined || !path.startsWith(`${BUILD_OUTPUT_DIRECTORY}/`)) {
			const message = localize('primitiveAppEditor.build.outsideBuild', "Refused to write outside the build directory: {0}", file.path);
			log(message, BottomPanelSeverity.Error);
			throw new Error(message);
		}
	}
	for (const { file, path } of targets) {
		if (file.scaffold && await fileSystem.exists(path!)) {
			const message = localize('primitiveAppEditor.build.scaffoldExists', "Scaffold file already exists and is not overwritten: {0}", file.path);
			log(message, BottomPanelSeverity.Error);
			throw new Error(message);
		}
	}
	log(localize('primitiveAppEditor.build.start', "Build / Export: writing {0} files", plan.length));
	for (const { file, path } of targets) {
		await fileSystem.write(path!, file.content);
		log(file.scaffold ? localize('primitiveAppEditor.build.scaffolded', "Scaffold: {0}", file.path) : localize('primitiveAppEditor.build.wrote', "Output: {0}", file.path));
	}
	log(localize('primitiveAppEditor.build.done', "Build / Export finished. The Editor does not run the generated files."));
}
