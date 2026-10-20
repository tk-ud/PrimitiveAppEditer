/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor Area pane (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (10. Editor Area Regulation)
 *--------------------------------------------------------------------------------------------*/

import './media/primitiveAppEditor.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IPrimitiveAppEditorService } from '../common/primitiveAppEditorService.js';
import { PrimitiveAppEditorInput } from './primitiveAppEditorEditorInput.js';
import { renderEditorSurface } from './primitiveAppEditorSurfaces.js';

/** The one Editor Area pane of every App Editor tab; the tab kind picks the surface. */
export class PrimitiveAppEditorPane extends EditorPane {

	static readonly ID = PrimitiveAppEditorInput.ID;

	private container: HTMLElement | undefined;
	private generation = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IPrimitiveAppEditorService private readonly appEditor: IPrimitiveAppEditorService,
	) {
		super(PrimitiveAppEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.pae-editor'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof PrimitiveAppEditorInput) || !this.container) {
			return;
		}
		const container = this.container;
		const generation = ++this.generation;
		container.setAttribute('data-pae-marker', `editor.${input.tabKind}`);
		clearNode(container);
		const body = $('div');
		try {
			await renderEditorSurface(body, input, this.appEditor);
		} catch (error) {
			append(body, $('.pae-error', undefined, error instanceof Error ? error.message : String(error)));
		}
		if (generation === this.generation && !token.isCancellationRequested) {
			container.appendChild(body);
		}
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.height = `${dimension.height}px`;
			this.container.style.width = `${dimension.width}px`;
		}
	}
}
