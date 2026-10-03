/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Authority and boundary contracts (foundation.authority)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md
 *  (1. Authority, 33. Runtime Authority, 34. Boundary Rules, 35. Non-Goals, 38. Core Definition)
 *--------------------------------------------------------------------------------------------*/

/**
 * Machine-readable form of the Primitive App Editor authority model. Every later
 * Primitive App Editor service (project directory, SQLite storage, Registry
 * service, Function binding, Runtime, Renderer, Build) consults these contracts
 * instead of re-deciding which element owns which concern.
 *
 * This module only encodes the specification; it holds no state and performs no I/O.
 */

// #region 1. Authority

/** Elements whose responsibility is fixed by `1. Authority`. */
export const enum AuthorityElement {
	Code = 'code',
	Registry = 'registry',
	PhysicalTable = 'physicalTable',
	RawData = 'rawData',
	ProjectDirectory = 'projectDirectory',
	SQLite = 'sqlite',
	RuntimeMemory = 'runtimeMemory',
	Renderer = 'renderer',
	Editor = 'editor',
	Build = 'build',
}

export interface IAuthorityElementResponsibility {
	readonly element: AuthorityElement;
	readonly responsibility: string;
}

export const authorityElements: readonly IAuthorityElementResponsibility[] = Object.freeze([
	{ element: AuthorityElement.Code, responsibility: 'Abstract processing implementation' },
	{ element: AuthorityElement.Registry, responsibility: 'Abstract Schema / Relation / Function / Renderer definition' },
	{ element: AuthorityElement.PhysicalTable, responsibility: 'Registry expansion result' },
	{ element: AuthorityElement.RawData, responsibility: 'Application specific concrete data' },
	{ element: AuthorityElement.ProjectDirectory, responsibility: 'Authoring storage unit' },
	{ element: AuthorityElement.SQLite, responsibility: 'Persistent storage of Registry / Raw Data / Binding' },
	{ element: AuthorityElement.RuntimeMemory, responsibility: 'Running state' },
	{ element: AuthorityElement.Renderer, responsibility: 'Projection of Runtime State' },
	{ element: AuthorityElement.Editor, responsibility: 'Registry / Raw Data / Binding / Asset authoring' },
	{ element: AuthorityElement.Build, responsibility: 'Application output' },
].map(entry => Object.freeze(entry)));

/** Lifecycle class of an artifact (`Definition` / `Persistent Authoring` / `Transient Runtime`). */
export const enum ArtifactLifecycle {
	Definition = 'definition',
	PersistentAuthoring = 'persistentAuthoring',
	TransientRuntime = 'transientRuntime',
}

export const enum Artifact {
	// Definition
	Code = 'code',
	Registry = 'registry',
	Relation = 'relation',
	FunctionDefinition = 'functionDefinition',
	RendererDefinition = 'rendererDefinition',
	// Persistent Authoring
	ProjectSqlite = 'project.sqlite',
	RawData = 'rawData',
	FunctionBinding = 'functionBinding',
	RendererBinding = 'rendererBinding',
	Assets = 'assets',
	Functions = 'functions',
	Scripts = 'scripts',
	Config = 'config',
	// Transient Runtime
	RuntimeState = 'runtimeState',
	FunctionInstance = 'functionInstance',
	FunctionOutput = 'functionOutput',
	Input = 'input',
	Timer = 'timer',
	Progress = 'progress',
	EventState = 'eventState',
	FrameState = 'frameState',
}

export const artifactLifecycles: Readonly<Record<ArtifactLifecycle, readonly Artifact[]>> = Object.freeze({
	[ArtifactLifecycle.Definition]: Object.freeze([
		Artifact.Code,
		Artifact.Registry,
		Artifact.Relation,
		Artifact.FunctionDefinition,
		Artifact.RendererDefinition,
	]),
	[ArtifactLifecycle.PersistentAuthoring]: Object.freeze([
		Artifact.ProjectSqlite,
		Artifact.RawData,
		Artifact.FunctionBinding,
		Artifact.RendererBinding,
		Artifact.Assets,
		Artifact.Functions,
		Artifact.Scripts,
		Artifact.Config,
	]),
	[ArtifactLifecycle.TransientRuntime]: Object.freeze([
		Artifact.RuntimeState,
		Artifact.FunctionInstance,
		Artifact.FunctionOutput,
		Artifact.Input,
		Artifact.Timer,
		Artifact.Progress,
		Artifact.EventState,
		Artifact.FrameState,
	]),
});

const lifecycleByArtifact = new Map<Artifact, ArtifactLifecycle>(
	(Object.keys(artifactLifecycles) as ArtifactLifecycle[]).flatMap(lifecycle =>
		artifactLifecycles[lifecycle].map(artifact => [artifact, lifecycle] as const))
);

export function getArtifactLifecycle(artifact: Artifact): ArtifactLifecycle {
	const lifecycle = lifecycleByArtifact.get(artifact);
	if (lifecycle === undefined) {
		throw new Error(`Unknown Primitive App Editor artifact: ${artifact}`);
	}
	return lifecycle;
}

/**
 * Transient Runtime artifacts (Runtime State, Function Output, Frame State, ...) live in
 * Runtime Memory only; they are never persisted to the authoring storage implicitly.
 */
export function isPersistedArtifact(artifact: Artifact): boolean {
	return getArtifactLifecycle(artifact) !== ArtifactLifecycle.TransientRuntime;
}

/** Abstraction level: `Registry = Abstract`, `Physical Table Schema = Registry Projection`, `Row = Concrete`. */
export const enum AbstractionLevel {
	Abstract = 'abstract',
	Projection = 'projection',
	Concrete = 'concrete',
}

export const enum SchemaLayer {
	Registry = 'registry',
	PhysicalTableSchema = 'physicalTableSchema',
	Row = 'row',
}

export const schemaAbstraction: Readonly<Record<SchemaLayer, AbstractionLevel>> = Object.freeze({
	[SchemaLayer.Registry]: AbstractionLevel.Abstract,
	[SchemaLayer.PhysicalTableSchema]: AbstractionLevel.Projection,
	[SchemaLayer.Row]: AbstractionLevel.Concrete,
});

// #endregion

// #region 33. Runtime Authority

export const enum AuthorityConcern {
	ApplicationDefinition = 'applicationDefinition',
	PhysicalSchema = 'physicalSchema',
	FunctionSemantics = 'functionSemantics',
	Relation = 'relation',
	AddressIdentity = 'addressIdentity',
	HumanDisplay = 'humanDisplay',
	Execution = 'execution',
	TargetMerge = 'targetMerge',
	Projection = 'projection',
	ProjectStorage = 'projectStorage',
	Output = 'output',
}

export const enum AuthoritySource {
	Registry = 'registry',
	RawData = 'rawData',
	Binding = 'binding',
	FunctionDefinition = 'functionDefinition',
	CodePrimitive = 'codePrimitive',
	RelationRegistry = 'relation_registry',
	Uuid = 'uuid',
	NameLabel = 'name/label',
	RuntimeExecutionPlan = 'runtimeExecutionPlan',
	RuntimeMemory = 'runtimeMemory',
	FunctionBindingMergePolicy = 'functionBindingMergePolicy',
	RendererBinding = 'rendererBinding',
	WorkingDirectory = 'workingDirectory',
	ProjectSqlite = 'project.sqlite',
	Build = 'build',
}

/** `33. Runtime Authority`: the only sources allowed to decide each concern. */
export const runtimeAuthority: Readonly<Record<AuthorityConcern, readonly AuthoritySource[]>> = Object.freeze({
	[AuthorityConcern.ApplicationDefinition]: Object.freeze([AuthoritySource.Registry, AuthoritySource.RawData, AuthoritySource.Binding]),
	[AuthorityConcern.PhysicalSchema]: Object.freeze([AuthoritySource.Registry]),
	[AuthorityConcern.FunctionSemantics]: Object.freeze([AuthoritySource.FunctionDefinition, AuthoritySource.CodePrimitive]),
	[AuthorityConcern.Relation]: Object.freeze([AuthoritySource.RelationRegistry]),
	[AuthorityConcern.AddressIdentity]: Object.freeze([AuthoritySource.Uuid]),
	[AuthorityConcern.HumanDisplay]: Object.freeze([AuthoritySource.NameLabel]),
	[AuthorityConcern.Execution]: Object.freeze([AuthoritySource.RuntimeExecutionPlan, AuthoritySource.RuntimeMemory]),
	[AuthorityConcern.TargetMerge]: Object.freeze([AuthoritySource.FunctionBindingMergePolicy]),
	[AuthorityConcern.Projection]: Object.freeze([AuthoritySource.RendererBinding]),
	[AuthorityConcern.ProjectStorage]: Object.freeze([AuthoritySource.WorkingDirectory, AuthoritySource.ProjectSqlite]),
	[AuthorityConcern.Output]: Object.freeze([AuthoritySource.Build]),
});

export function getAuthority(concern: AuthorityConcern): readonly AuthoritySource[] {
	const sources = runtimeAuthority[concern];
	if (!sources) {
		throw new Error(`Unknown Primitive App Editor authority concern: ${concern}`);
	}
	return sources;
}

export function isAuthorityFor(concern: AuthorityConcern, source: AuthoritySource): boolean {
	return getAuthority(concern).includes(source);
}

// #endregion

// #region 34. Boundary Rules

export const enum BoundaryNode {
	Registry = 'registry',
	PhysicalSchema = 'physicalSchema',
	RegistryReverseGeneration = 'registryReverseGeneration',
	RegistryMutation = 'registryMutation',
	AppEditorRegistryService = 'appEditorRegistryService',
	SQLiteDdl = 'sqliteDdl',
	SQLiteTriggerDdl = 'sqliteTriggerDdl',
	Relation = 'relation',
	LogicalJoin = 'logicalJoin',
	PhysicalForeignKey = 'physicalForeignKey',
	Enum = 'enum',
	TextWithMetadata = 'textWithMetadata',
	Uuid = 'uuid',
	MachineResolve = 'machineResolve',
	PrimaryHumanDisplay = 'primaryHumanDisplay',
	Function = 'function',
	Value = 'value',
	Binding = 'binding',
	SourceTargetMerge = 'sourceTargetMerge',
	ExecutionPlan = 'executionPlan',
	Order = 'order',
	Renderer = 'renderer',
	Projection = 'projection',
	Runtime = 'runtime',
	Memory = 'memory',
	RuntimeLoop = 'runtimeLoop',
	SQLitePerFrameQuery = 'sqlitePerFrameQuery',
}

export interface IBoundaryFlow {
	readonly from: BoundaryNode;
	readonly to: BoundaryNode;
}

/** Flows written as `A -> B` in `34. Boundary Rules`. */
export const allowedBoundaryFlows: readonly IBoundaryFlow[] = Object.freeze([
	{ from: BoundaryNode.Registry, to: BoundaryNode.PhysicalSchema },
	{ from: BoundaryNode.RegistryMutation, to: BoundaryNode.AppEditorRegistryService },
	{ from: BoundaryNode.AppEditorRegistryService, to: BoundaryNode.SQLiteDdl },
	{ from: BoundaryNode.Relation, to: BoundaryNode.LogicalJoin },
	{ from: BoundaryNode.Enum, to: BoundaryNode.TextWithMetadata },
	{ from: BoundaryNode.Uuid, to: BoundaryNode.MachineResolve },
	{ from: BoundaryNode.Function, to: BoundaryNode.Value },
	{ from: BoundaryNode.Binding, to: BoundaryNode.SourceTargetMerge },
	{ from: BoundaryNode.ExecutionPlan, to: BoundaryNode.Order },
	{ from: BoundaryNode.Renderer, to: BoundaryNode.Projection },
	{ from: BoundaryNode.Runtime, to: BoundaryNode.Memory },
].map(flow => Object.freeze(flow)));

/** Flows written as `A -X-> B` in `34. Boundary Rules`. */
export const forbiddenBoundaryFlows: readonly IBoundaryFlow[] = Object.freeze([
	{ from: BoundaryNode.PhysicalSchema, to: BoundaryNode.RegistryReverseGeneration },
	{ from: BoundaryNode.RegistryMutation, to: BoundaryNode.SQLiteTriggerDdl },
	{ from: BoundaryNode.Relation, to: BoundaryNode.PhysicalForeignKey },
	{ from: BoundaryNode.Enum, to: BoundaryNode.PhysicalForeignKey },
	{ from: BoundaryNode.Uuid, to: BoundaryNode.PrimaryHumanDisplay },
	{ from: BoundaryNode.RuntimeLoop, to: BoundaryNode.SQLitePerFrameQuery },
].map(flow => Object.freeze(flow)));

export const enum BoundaryVerdict {
	Allowed = 'allowed',
	Forbidden = 'forbidden',
	/** The flow is not regulated by `34. Boundary Rules`. */
	Unregulated = 'unregulated',
}

function flowKey(from: BoundaryNode, to: BoundaryNode): string {
	return `${from}->${to}`;
}

const allowedFlowKeys = new Set(allowedBoundaryFlows.map(flow => flowKey(flow.from, flow.to)));
const forbiddenFlowKeys = new Set(forbiddenBoundaryFlows.map(flow => flowKey(flow.from, flow.to)));

export function checkBoundaryFlow(from: BoundaryNode, to: BoundaryNode): BoundaryVerdict {
	const key = flowKey(from, to);
	if (forbiddenFlowKeys.has(key)) {
		return BoundaryVerdict.Forbidden;
	}
	if (allowedFlowKeys.has(key)) {
		return BoundaryVerdict.Allowed;
	}
	return BoundaryVerdict.Unregulated;
}

export class AuthorityBoundaryError extends Error {
	constructor(readonly from: BoundaryNode, readonly to: BoundaryNode) {
		super(`Primitive App Editor boundary violation: ${from} -X-> ${to}`);
		this.name = 'AuthorityBoundaryError';
	}
}

/** Throws {@link AuthorityBoundaryError} when `from -> to` is a forbidden flow. */
export function assertBoundaryFlow(from: BoundaryNode, to: BoundaryNode): void {
	if (checkBoundaryFlow(from, to) === BoundaryVerdict.Forbidden) {
		throw new AuthorityBoundaryError(from, to);
	}
}

// #endregion

// #region 35. Non-Goals

export const enum NonGoal {
	EditorPublication = 'editorPublication',
	EditorSaaS = 'editorSaaS',
	PerApplicationEngine = 'perApplicationEngine',
	GameLogicHardcodedInEditor = 'gameLogicHardcodedInEditor',
	GimmickSpecificFunction = 'gimmickSpecificFunction',
	RegistryReverseGenerationFromPhysicalSchema = 'registryReverseGenerationFromPhysicalSchema',
	PhysicalForeignKeyAsRelationAuthority = 'physicalForeignKeyAsRelationAuthority',
	UuidAsPrimaryEditorDisplay = 'uuidAsPrimaryEditorDisplay',
	HardcodedFunctionExecutionOrder = 'hardcodedFunctionExecutionOrder',
	RuntimeLoopSQLiteQuery = 'runtimeLoopSQLiteQuery',
	IncrementalFunctionOutputPersistence = 'incrementalFunctionOutputPersistence',
	PerFrameRuntimeStatePersistence = 'perFrameRuntimeStatePersistence',
}

export const nonGoals: Readonly<Record<NonGoal, string>> = Object.freeze({
	[NonGoal.EditorPublication]: 'Publishing the Editor',
	[NonGoal.EditorSaaS]: 'Turning the Editor into a SaaS',
	[NonGoal.PerApplicationEngine]: 'Implementing a dedicated engine per application',
	[NonGoal.GameLogicHardcodedInEditor]: 'Hard-coding game logic in the Editor',
	[NonGoal.GimmickSpecificFunction]: 'Making Functions gimmick specific',
	[NonGoal.RegistryReverseGenerationFromPhysicalSchema]: 'Reverse-generating Registry from Physical Schema',
	[NonGoal.PhysicalForeignKeyAsRelationAuthority]: 'Making physical FKs the Relation authority',
	[NonGoal.UuidAsPrimaryEditorDisplay]: 'Showing UUIDs as the primary Editor display',
	[NonGoal.HardcodedFunctionExecutionOrder]: 'Hard-coding Function execution order in C#',
	[NonGoal.RuntimeLoopSQLiteQuery]: 'Sequential SQLite reads from the Runtime Loop',
	[NonGoal.IncrementalFunctionOutputPersistence]: 'Sequential persistence of Function Output',
	[NonGoal.PerFrameRuntimeStatePersistence]: 'Persisting Runtime State every frame',
});

/** Non-Goals that are the negative side of a forbidden boundary flow. */
export const nonGoalBoundaryFlows: Readonly<Partial<Record<NonGoal, IBoundaryFlow>>> = Object.freeze({
	[NonGoal.RegistryReverseGenerationFromPhysicalSchema]: Object.freeze({ from: BoundaryNode.PhysicalSchema, to: BoundaryNode.RegistryReverseGeneration }),
	[NonGoal.PhysicalForeignKeyAsRelationAuthority]: Object.freeze({ from: BoundaryNode.Relation, to: BoundaryNode.PhysicalForeignKey }),
	[NonGoal.UuidAsPrimaryEditorDisplay]: Object.freeze({ from: BoundaryNode.Uuid, to: BoundaryNode.PrimaryHumanDisplay }),
	[NonGoal.RuntimeLoopSQLiteQuery]: Object.freeze({ from: BoundaryNode.RuntimeLoop, to: BoundaryNode.SQLitePerFrameQuery }),
});

/** Non-Goals that are the negative side of the Transient Runtime lifecycle (never implicitly persisted). */
export const nonGoalTransientArtifacts: Readonly<Partial<Record<NonGoal, Artifact>>> = Object.freeze({
	[NonGoal.IncrementalFunctionOutputPersistence]: Artifact.FunctionOutput,
	[NonGoal.PerFrameRuntimeStatePersistence]: Artifact.RuntimeState,
});

// #endregion

// #region 38. Core Definition

export const enum Composition {
	Overwrite = 'overwrite',
	Overlay = 'overlay',
}

export const compositions: readonly Composition[] = Object.freeze([Composition.Overwrite, Composition.Overlay]);

export function isComposition(value: string): value is Composition {
	return (compositions as readonly string[]).includes(value);
}

export interface ICoreDefinition {
	readonly project: 'Working Directory';
	readonly storage: readonly ['SQLite', 'Filesystem'];
	readonly schema: 'Registry';
	readonly schemaExpansion: 'App Editor Registry Service';
	readonly concreteData: 'Physical Table Row';
	readonly relation: 'Logical Registry';
	readonly identity: 'UUID';
	readonly display: 'Human-readable name / label';
	readonly behavior: readonly ['Function Primitive', 'Binding'];
	readonly execution: readonly ['Dependency Graph', 'Execution Plan', 'Memory'];
	readonly composition: readonly Composition[];
	readonly projection: 'Renderer';
	readonly output: 'Build';
	readonly multiplayer: 'Future';
}

export const coreDefinition: ICoreDefinition = Object.freeze({
	project: 'Working Directory',
	storage: Object.freeze(['SQLite', 'Filesystem'] as const),
	schema: 'Registry',
	schemaExpansion: 'App Editor Registry Service',
	concreteData: 'Physical Table Row',
	relation: 'Logical Registry',
	identity: 'UUID',
	display: 'Human-readable name / label',
	behavior: Object.freeze(['Function Primitive', 'Binding'] as const),
	execution: Object.freeze(['Dependency Graph', 'Execution Plan', 'Memory'] as const),
	composition: compositions,
	projection: 'Renderer',
	output: 'Build',
	multiplayer: 'Future',
});

// #endregion
