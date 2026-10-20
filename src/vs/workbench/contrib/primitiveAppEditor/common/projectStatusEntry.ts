/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Project Open state as Status Bar entry content (workbench.integration)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (3. Workbench Placement: Status Bar = Project / Runtime / Build Status)
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ProjectOpenStatus } from './projectDirectory.js';
import { IProjectOpenSessionState, ProjectOpenState } from './projectOpenSession.js';

/** Status Bar entry id of the Project Open state (stable GUI identifier: `div[id="status.primitiveAppEditor.project"]`). */
export const PROJECT_STATUS_ENTRY_ID = 'status.primitiveAppEditor.project';

export interface IProjectStatusEntry {
	readonly name: string;
	readonly text: string;
	readonly ariaLabel: string;
	readonly tooltip: string;
	readonly kind?: 'warning' | 'error';
}

export function toProjectStatusEntry(state: IProjectOpenSessionState): IProjectStatusEntry {
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
