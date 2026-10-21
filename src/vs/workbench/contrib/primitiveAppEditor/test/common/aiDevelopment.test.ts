/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - AI Development (workbench.ai-development)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. AI Development)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AiDevelopmentStage, aiDevelopmentFlow, AiOperationTarget, aiOperationTargets, isAiDevelopmentTransitionAllowed,
	isAiOperationPathInProject, requiresAiSpecificAuthoringProtocol, SurfaceProvider, WorkbenchSurface, workbenchComposition,
} from '../../common/aiDevelopment.js';

suite('Primitive App Editor - AI Development (39. AI Development)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Workbench composition is App Editor, Code Editor, Git and AI Coding Extension', () => {
		assert.deepStrictEqual(workbenchComposition.map(entry => entry.surface), [
			WorkbenchSurface.AppEditor, WorkbenchSurface.CodeEditor, WorkbenchSurface.Git, WorkbenchSurface.AiCodingExtension,
		]);
		const provider = (surface: WorkbenchSurface) => workbenchComposition.find(entry => entry.surface === surface)?.provider;
		assert.strictEqual(provider(WorkbenchSurface.AppEditor), SurfaceProvider.AppEditor);
		assert.strictEqual(provider(WorkbenchSurface.CodeEditor), SurfaceProvider.CodeOSS);
		assert.strictEqual(provider(WorkbenchSurface.Git), SurfaceProvider.CodeOSS);
		assert.strictEqual(provider(WorkbenchSurface.AiCodingExtension), SurfaceProvider.Extension);
	});

	test('AI targets are Code, Registry, Binding, Assets Reference and Build Definition inside the Working Directory layout', () => {
		assert.deepStrictEqual(aiOperationTargets.map(entry => entry.target), [
			AiOperationTarget.Code, AiOperationTarget.Registry, AiOperationTarget.Binding,
			AiOperationTarget.AssetsReference, AiOperationTarget.BuildDefinition,
		]);
		for (const entry of aiOperationTargets) {
			for (const path of entry.paths) {
				assert.ok(isAiOperationPathInProject(path), path);
			}
		}
		assert.strictEqual(isAiOperationPathInProject('ai-workspace'), false);
	});

	test('flow is AI -> Working Directory -> Debug Viewer -> Human Review, in order only', () => {
		assert.deepStrictEqual(aiDevelopmentFlow, [
			AiDevelopmentStage.Ai, AiDevelopmentStage.WorkingDirectory, AiDevelopmentStage.DebugViewer, AiDevelopmentStage.HumanReview,
		]);
		assert.ok(isAiDevelopmentTransitionAllowed(AiDevelopmentStage.Ai, AiDevelopmentStage.WorkingDirectory));
		assert.ok(isAiDevelopmentTransitionAllowed(AiDevelopmentStage.DebugViewer, AiDevelopmentStage.HumanReview));
		assert.strictEqual(isAiDevelopmentTransitionAllowed(AiDevelopmentStage.Ai, AiDevelopmentStage.HumanReview), false);
		assert.strictEqual(isAiDevelopmentTransitionAllowed(AiDevelopmentStage.HumanReview, AiDevelopmentStage.Ai), false);
	});

	test('no AI specific Game Authoring Protocol is required', () => {
		assert.strictEqual(requiresAiSpecificAuthoringProtocol, false);
	});
});
