/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - AI coding extension compatible development workflow (workbench.ai-development)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. AI Development)
 *--------------------------------------------------------------------------------------------*/

import { Artifact } from './authority.js';
import { getProjectEntry, PROJECT_SQLITE_FILE_NAME } from './projectDirectory.js';

/**
 * The Workbench is a VS Code family Workbench, so VS Code family Extensions (an AI coding extension
 * included) work on the same Project Working Directory the App Editor edits. No AI specific Game Authoring
 * Protocol exists: the AI operates the existing Repository / Code / Definition, the App Editor is the
 * Human Authoring / Inspection / Debug surface.
 *
 * ```text
 * Workbench
 * ├─ App Editor
 * ├─ Code Editor
 * ├─ Git
 * └─ AI Coding Extension
 *
 * AI -> Repository / Working Directory -> Debug Viewer -> Human Review
 * ```
 *
 * This module only encodes that composition and the flow; it holds no state, performs no I/O and adds no
 * operation channel, command or API for the AI.
 */

// #region Workbench composition

export const enum WorkbenchSurface {
	AppEditor = 'appEditor',
	CodeEditor = 'codeEditor',
	Git = 'git',
	AiCodingExtension = 'aiCodingExtension',
}

/** Who provides a Workbench surface: the App Editor contribution or the existing Code OSS Workbench / Extension Host. */
export const enum SurfaceProvider {
	AppEditor = 'appEditor',
	CodeOSS = 'codeOSS',
	Extension = 'extension',
}

export interface IWorkbenchSurfaceEntry {
	readonly surface: WorkbenchSurface;
	readonly provider: SurfaceProvider;
}

export const workbenchComposition: readonly IWorkbenchSurfaceEntry[] = Object.freeze([
	{ surface: WorkbenchSurface.AppEditor, provider: SurfaceProvider.AppEditor },
	{ surface: WorkbenchSurface.CodeEditor, provider: SurfaceProvider.CodeOSS },
	{ surface: WorkbenchSurface.Git, provider: SurfaceProvider.CodeOSS },
	{ surface: WorkbenchSurface.AiCodingExtension, provider: SurfaceProvider.Extension },
].map(entry => Object.freeze(entry)));

// #endregion

// #region AI operation targets

/** What the AI operates through the Repository / Working Directory (`Code`, `Registry`, `Binding`, `Assets Reference`, `Build Definition`). */
export const enum AiOperationTarget {
	Code = 'code',
	Registry = 'registry',
	Binding = 'binding',
	AssetsReference = 'assetsReference',
	BuildDefinition = 'buildDefinition',
}

export interface IAiOperationTargetEntry {
	readonly target: AiOperationTarget;
	/** Persistent Authoring artifact the target lives in (`Build Definition` = Build Configuration; its storage is a Build implementation matter). */
	readonly artifact: Artifact | undefined;
	/** Working Directory relative paths the AI edits as ordinary repository content. */
	readonly paths: readonly string[];
}

export const aiOperationTargets: readonly IAiOperationTargetEntry[] = Object.freeze([
	{ target: AiOperationTarget.Code, artifact: Artifact.Code, paths: Object.freeze(['functions', 'scripts']) },
	{ target: AiOperationTarget.Registry, artifact: Artifact.ProjectSqlite, paths: Object.freeze([PROJECT_SQLITE_FILE_NAME]) },
	{ target: AiOperationTarget.Binding, artifact: Artifact.ProjectSqlite, paths: Object.freeze([PROJECT_SQLITE_FILE_NAME]) },
	{ target: AiOperationTarget.AssetsReference, artifact: Artifact.Assets, paths: Object.freeze(['assets']) },
	{ target: AiOperationTarget.BuildDefinition, artifact: undefined, paths: Object.freeze([]) },
].map(entry => Object.freeze(entry)));

/** Every path the AI targets lie in the canonical Working Directory layout: no separate AI workspace exists. */
export function isAiOperationPathInProject(path: string): boolean {
	return getProjectEntry(path) !== undefined;
}

// #endregion

// #region Flow and Non-Goals

export const enum AiDevelopmentStage {
	Ai = 'ai',
	WorkingDirectory = 'workingDirectory',
	DebugViewer = 'debugViewer',
	HumanReview = 'humanReview',
}

/** `AI -> Repository / Working Directory -> Debug Viewer -> Human Review`. */
export const aiDevelopmentFlow: readonly AiDevelopmentStage[] = Object.freeze([
	AiDevelopmentStage.Ai,
	AiDevelopmentStage.WorkingDirectory,
	AiDevelopmentStage.DebugViewer,
	AiDevelopmentStage.HumanReview,
]);

/** `AI専用のGame Authoring Protocolは必須としない`: the AI needs no operation channel beyond the Working Directory. */
export const requiresAiSpecificAuthoringProtocol = false;

export function isAiDevelopmentTransitionAllowed(from: AiDevelopmentStage, to: AiDevelopmentStage): boolean {
	const index = aiDevelopmentFlow.indexOf(from);
	return index >= 0 && aiDevelopmentFlow[index + 1] === to;
}

// #endregion
