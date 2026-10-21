/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor Area tab input (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (10. Editor Area Regulation)
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { DataEditorTarget } from '../common/dataEditor.js';
import { EditorTabKind, editorTabKindOf } from '../common/workbenchViews.js';

export function editorTabTitle(kind: EditorTabKind): string {
	switch (kind) {
		case EditorTabKind.CodeEditor: return localize('primitiveAppEditor.tab.code', "Code Editor");
		case EditorTabKind.RegistryEditor: return localize('primitiveAppEditor.tab.registry', "Registry Editor");
		case EditorTabKind.DataEditor: return localize('primitiveAppEditor.tab.data', "Data Editor");
		case EditorTabKind.FunctionGraph: return localize('primitiveAppEditor.tab.functionGraph', "Function Graph");
		case EditorTabKind.RendererEditor: return localize('primitiveAppEditor.tab.renderer', "Renderer Editor");
		case EditorTabKind.AssetEditor: return localize('primitiveAppEditor.tab.asset', "Asset Editor");
		case EditorTabKind.DebugViewer: return localize('primitiveAppEditor.tab.debugViewer', "Debug Viewer");
		case EditorTabKind.BuildExport: return localize('primitiveAppEditor.tab.buildExport', "Build / Export Configuration");
	}
}

function editorTabIcon(kind: EditorTabKind): ThemeIcon {
	switch (kind) {
		case EditorTabKind.CodeEditor: return Codicon.code;
		case EditorTabKind.RegistryEditor: return Codicon.symbolStructure;
		case EditorTabKind.DataEditor: return Codicon.database;
		case EditorTabKind.FunctionGraph: return Codicon.symbolMethod;
		case EditorTabKind.RendererEditor: return Codicon.symbolColor;
		case EditorTabKind.AssetEditor: return Codicon.fileMedia;
		case EditorTabKind.DebugViewer: return Codicon.debugAlt;
		case EditorTabKind.BuildExport: return Codicon.package;
	}
}

/**
 * One Editor Area tab of an App Editor Target. The Target (`target` + `uuid`) is the tab identity, so the
 * Workbench reuses the tab that already shows it and never duplicates it (Editor UI 10).
 */
export class PrimitiveAppEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.primitiveAppEditor';
	static readonly SCHEME = 'primitive-app-editor';

	readonly resource: URI;

	constructor(
		readonly target: DataEditorTarget,
		readonly uuid: string,
		private readonly label: string | undefined,
	) {
		super();
		this.resource = URI.from({ scheme: PrimitiveAppEditorInput.SCHEME, path: `/${target}/${uuid}` });
	}

	get tabKind(): EditorTabKind {
		return editorTabKindOf(this.target);
	}

	override get typeId(): string { return PrimitiveAppEditorInput.ID; }

	override get editorId(): string | undefined { return PrimitiveAppEditorInput.ID; }

	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly; }

	override getName(): string {
		return this.label ? this.label : editorTabTitle(this.tabKind);
	}

	override getDescription(): string | undefined {
		return this.label ? editorTabTitle(this.tabKind) : undefined;
	}

	override getIcon(): ThemeIcon {
		return editorTabIcon(this.tabKind);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof PrimitiveAppEditorInput && other.target === this.target && other.uuid === this.uuid;
	}
}
