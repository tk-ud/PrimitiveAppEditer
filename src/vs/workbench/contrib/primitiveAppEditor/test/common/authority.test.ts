/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Authority and boundary contracts (foundation.authority)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AbstractionLevel,
	allowedBoundaryFlows,
	Artifact,
	ArtifactLifecycle,
	artifactLifecycles,
	assertBoundaryFlow,
	AuthorityBoundaryError,
	AuthorityConcern,
	AuthorityElement,
	authorityElements,
	AuthoritySource,
	BoundaryNode,
	BoundaryVerdict,
	checkBoundaryFlow,
	Composition,
	coreDefinition,
	forbiddenBoundaryFlows,
	getArtifactLifecycle,
	getAuthority,
	isAuthorityFor,
	isComposition,
	isPersistedArtifact,
	NonGoal,
	nonGoalBoundaryFlows,
	nonGoals,
	nonGoalTransientArtifacts,
	runtimeAuthority,
	schemaAbstraction,
	SchemaLayer,
} from '../../common/authority.js';

suite('Primitive App Editor - Authority (1. Authority)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every Authority element has exactly one responsibility', () => {
		assert.deepStrictEqual(authorityElements.map(entry => entry.element), [
			AuthorityElement.Code,
			AuthorityElement.Registry,
			AuthorityElement.PhysicalTable,
			AuthorityElement.RawData,
			AuthorityElement.ProjectDirectory,
			AuthorityElement.SQLite,
			AuthorityElement.RuntimeMemory,
			AuthorityElement.Renderer,
			AuthorityElement.Editor,
			AuthorityElement.Build,
		]);
		assert.strictEqual(authorityElements.find(entry => entry.element === AuthorityElement.Renderer)?.responsibility, 'Projection of Runtime State');
		assert.strictEqual(authorityElements.find(entry => entry.element === AuthorityElement.PhysicalTable)?.responsibility, 'Registry expansion result');
	});

	test('artifacts belong to exactly one lifecycle', () => {
		const all = Object.values(artifactLifecycles).flat();
		assert.strictEqual(new Set(all).size, all.length);
		assert.strictEqual(all.length, 21);
		assert.strictEqual(getArtifactLifecycle(Artifact.Registry), ArtifactLifecycle.Definition);
		assert.strictEqual(getArtifactLifecycle(Artifact.Relation), ArtifactLifecycle.Definition);
		assert.strictEqual(getArtifactLifecycle(Artifact.ProjectSqlite), ArtifactLifecycle.PersistentAuthoring);
		assert.strictEqual(getArtifactLifecycle(Artifact.FunctionBinding), ArtifactLifecycle.PersistentAuthoring);
		assert.strictEqual(getArtifactLifecycle(Artifact.FrameState), ArtifactLifecycle.TransientRuntime);
		assert.throws(() => getArtifactLifecycle('unknown' as Artifact));
	});

	test('transient runtime artifacts are never persisted', () => {
		for (const artifact of artifactLifecycles[ArtifactLifecycle.TransientRuntime]) {
			assert.strictEqual(isPersistedArtifact(artifact), false, artifact);
		}
		for (const artifact of [...artifactLifecycles[ArtifactLifecycle.Definition], ...artifactLifecycles[ArtifactLifecycle.PersistentAuthoring]]) {
			assert.strictEqual(isPersistedArtifact(artifact), true, artifact);
		}
	});

	test('Registry is abstract, Physical Table Schema is its projection, Row is concrete', () => {
		assert.strictEqual(schemaAbstraction[SchemaLayer.Registry], AbstractionLevel.Abstract);
		assert.strictEqual(schemaAbstraction[SchemaLayer.PhysicalTableSchema], AbstractionLevel.Projection);
		assert.strictEqual(schemaAbstraction[SchemaLayer.Row], AbstractionLevel.Concrete);
	});

	test('contracts are immutable', () => {
		assert.ok(Object.isFrozen(authorityElements));
		assert.ok(Object.isFrozen(artifactLifecycles));
		assert.ok(Object.isFrozen(artifactLifecycles[ArtifactLifecycle.Definition]));
		assert.ok(Object.isFrozen(runtimeAuthority));
		assert.ok(Object.isFrozen(allowedBoundaryFlows[0]));
		assert.ok(Object.isFrozen(coreDefinition));
	});
});

suite('Primitive App Editor - Authority (33. Runtime Authority)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('each concern has its specified authority sources', () => {
		assert.deepStrictEqual(runtimeAuthority, {
			[AuthorityConcern.ApplicationDefinition]: [AuthoritySource.Registry, AuthoritySource.RawData, AuthoritySource.Binding],
			[AuthorityConcern.PhysicalSchema]: [AuthoritySource.Registry],
			[AuthorityConcern.FunctionSemantics]: [AuthoritySource.FunctionDefinition, AuthoritySource.CodePrimitive],
			[AuthorityConcern.Relation]: [AuthoritySource.RelationRegistry],
			[AuthorityConcern.AddressIdentity]: [AuthoritySource.Uuid],
			[AuthorityConcern.HumanDisplay]: [AuthoritySource.NameLabel],
			[AuthorityConcern.Execution]: [AuthoritySource.RuntimeExecutionPlan, AuthoritySource.RuntimeMemory],
			[AuthorityConcern.TargetMerge]: [AuthoritySource.FunctionBindingMergePolicy],
			[AuthorityConcern.Projection]: [AuthoritySource.RendererBinding],
			[AuthorityConcern.ProjectStorage]: [AuthoritySource.WorkingDirectory, AuthoritySource.ProjectSqlite],
			[AuthorityConcern.Output]: [AuthoritySource.Build],
		});
	});

	test('non-authorities are rejected', () => {
		assert.strictEqual(isAuthorityFor(AuthorityConcern.PhysicalSchema, AuthoritySource.Registry), true);
		assert.strictEqual(isAuthorityFor(AuthorityConcern.Relation, AuthoritySource.RelationRegistry), true);
		assert.strictEqual(isAuthorityFor(AuthorityConcern.AddressIdentity, AuthoritySource.NameLabel), false);
		assert.strictEqual(isAuthorityFor(AuthorityConcern.HumanDisplay, AuthoritySource.Uuid), false);
		assert.strictEqual(isAuthorityFor(AuthorityConcern.ApplicationDefinition, AuthoritySource.Build), false);
		assert.strictEqual(isAuthorityFor(AuthorityConcern.ProjectStorage, AuthoritySource.Build), false);
		assert.throws(() => getAuthority('unknown' as AuthorityConcern));
	});
});

suite('Primitive App Editor - Authority (34. Boundary Rules)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('specified flows are allowed', () => {
		const allowed: [BoundaryNode, BoundaryNode][] = [
			[BoundaryNode.Registry, BoundaryNode.PhysicalSchema],
			[BoundaryNode.RegistryMutation, BoundaryNode.AppEditorRegistryService],
			[BoundaryNode.AppEditorRegistryService, BoundaryNode.SQLiteDdl],
			[BoundaryNode.Relation, BoundaryNode.LogicalJoin],
			[BoundaryNode.Enum, BoundaryNode.TextWithMetadata],
			[BoundaryNode.Uuid, BoundaryNode.MachineResolve],
			[BoundaryNode.Function, BoundaryNode.Value],
			[BoundaryNode.Binding, BoundaryNode.SourceTargetMerge],
			[BoundaryNode.ExecutionPlan, BoundaryNode.Order],
			[BoundaryNode.Renderer, BoundaryNode.Projection],
			[BoundaryNode.Runtime, BoundaryNode.Memory],
		];
		assert.deepStrictEqual(allowedBoundaryFlows.map(flow => [flow.from, flow.to]), allowed);
		for (const [from, to] of allowed) {
			assert.strictEqual(checkBoundaryFlow(from, to), BoundaryVerdict.Allowed);
			assertBoundaryFlow(from, to);
		}
	});

	test('specified flows are forbidden and assertBoundaryFlow throws', () => {
		const forbidden: [BoundaryNode, BoundaryNode][] = [
			[BoundaryNode.PhysicalSchema, BoundaryNode.RegistryReverseGeneration],
			[BoundaryNode.RegistryMutation, BoundaryNode.SQLiteTriggerDdl],
			[BoundaryNode.Relation, BoundaryNode.PhysicalForeignKey],
			[BoundaryNode.Enum, BoundaryNode.PhysicalForeignKey],
			[BoundaryNode.Uuid, BoundaryNode.PrimaryHumanDisplay],
			[BoundaryNode.RuntimeLoop, BoundaryNode.SQLitePerFrameQuery],
		];
		assert.deepStrictEqual(forbiddenBoundaryFlows.map(flow => [flow.from, flow.to]), forbidden);
		for (const [from, to] of forbidden) {
			assert.strictEqual(checkBoundaryFlow(from, to), BoundaryVerdict.Forbidden);
			let thrown: unknown;
			try {
				assertBoundaryFlow(from, to);
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof AuthorityBoundaryError);
			assert.strictEqual(thrown.from, from);
			assert.strictEqual(thrown.to, to);
		}
	});

	test('allowed and forbidden flows never overlap', () => {
		const allowed = new Set(allowedBoundaryFlows.map(flow => `${flow.from}->${flow.to}`));
		for (const flow of forbiddenBoundaryFlows) {
			assert.ok(!allowed.has(`${flow.from}->${flow.to}`));
		}
	});

	test('unregulated flows are reported as such', () => {
		assert.strictEqual(checkBoundaryFlow(BoundaryNode.PhysicalSchema, BoundaryNode.Registry), BoundaryVerdict.Unregulated);
		assertBoundaryFlow(BoundaryNode.PhysicalSchema, BoundaryNode.Registry);
	});
});

suite('Primitive App Editor - Authority (35. Non-Goals)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('all twelve Non-Goals are enumerated', () => {
		assert.strictEqual(Object.keys(nonGoals).length, 12);
	});

	test('boundary Non-Goals map to forbidden flows', () => {
		for (const flow of Object.values(nonGoalBoundaryFlows)) {
			assert.strictEqual(checkBoundaryFlow(flow!.from, flow!.to), BoundaryVerdict.Forbidden);
		}
		assert.deepStrictEqual(Object.keys(nonGoalBoundaryFlows).sort(), [
			NonGoal.PhysicalForeignKeyAsRelationAuthority,
			NonGoal.RegistryReverseGenerationFromPhysicalSchema,
			NonGoal.RuntimeLoopSQLiteQuery,
			NonGoal.UuidAsPrimaryEditorDisplay,
		].sort());
	});

	test('persistence Non-Goals map to transient artifacts', () => {
		for (const artifact of Object.values(nonGoalTransientArtifacts)) {
			assert.strictEqual(isPersistedArtifact(artifact!), false);
		}
	});
});

suite('Primitive App Editor - Authority (38. Core Definition)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('core definition matches the specification', () => {
		assert.deepStrictEqual(coreDefinition, {
			project: 'Working Directory',
			storage: ['SQLite', 'Filesystem'],
			schema: 'Registry',
			schemaExpansion: 'App Editor Registry Service',
			concreteData: 'Physical Table Row',
			relation: 'Logical Registry',
			identity: 'UUID',
			display: 'Human-readable name / label',
			behavior: ['Function Primitive', 'Binding'],
			execution: ['Dependency Graph', 'Execution Plan', 'Memory'],
			composition: [Composition.Overwrite, Composition.Overlay],
			projection: 'Renderer',
			output: 'Build',
			multiplayer: 'Future',
		});
	});

	test('composition is overwrite | overlay', () => {
		assert.strictEqual(isComposition('overwrite'), true);
		assert.strictEqual(isComposition('overlay'), true);
		assert.strictEqual(isComposition('append'), false);
	});
});
