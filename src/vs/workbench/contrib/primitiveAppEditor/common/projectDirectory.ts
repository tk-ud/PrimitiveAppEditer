/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Project working directory lifecycle (foundation.project-directory)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md
 *  (3. Project Working Directory, 3. Open)
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { Artifact, AuthorityConcern, AuthoritySource, isAuthorityFor } from './authority.js';

/**
 * `Project = Working Directory`. This module owns the directory layout of a project and
 * the `Open` lifecycle that turns a selected Working Directory into `Editor Ready`.
 *
 * The physical `project.sqlite` storage and the steps after `Create` / `Open` (Editor DDL Scan,
 * Schema Version Resolve, Migration Apply, Registry Load, Function Scan, Asset Scan) are owned
 * by their own services; this lifecycle orders them, passes them the scanned Working Directory,
 * and reports `Editor Ready` only after all of them completed.
 */

// #region 3. Project Working Directory

export const PROJECT_SQLITE_FILE_NAME = 'project.sqlite';

/** Role of a Working Directory entry: `Structured Data`, `Program`, `Binary Asset`, `Output`, or configuration. */
export const enum ProjectEntryRole {
	StructuredData = 'structuredData',
	Program = 'program',
	BinaryAsset = 'binaryAsset',
	Config = 'config',
	Output = 'output',
}

export const enum ProjectEntryKind {
	File = 'file',
	Directory = 'directory',
}

export interface IProjectEntry {
	/** Path relative to the Working Directory, `/` separated. */
	readonly path: string;
	readonly kind: ProjectEntryKind;
	readonly role: ProjectEntryRole;
	/** Authority artifact stored at this path; `undefined` for derived output (`build/`). */
	readonly artifact: Artifact | undefined;
}

export const enum AssetCategory {
	Image = 'image',
	Audio = 'audio',
	Font = 'font',
	Shader = 'shader',
	Other = 'other',
}

export const assetCategories: readonly AssetCategory[] = Object.freeze([
	AssetCategory.Image,
	AssetCategory.Audio,
	AssetCategory.Font,
	AssetCategory.Shader,
	AssetCategory.Other,
]);

/** The canonical `<Project>/` layout, in specification order. */
export const projectLayout: readonly IProjectEntry[] = Object.freeze([
	{ path: PROJECT_SQLITE_FILE_NAME, kind: ProjectEntryKind.File, role: ProjectEntryRole.StructuredData, artifact: Artifact.ProjectSqlite },
	{ path: 'functions', kind: ProjectEntryKind.Directory, role: ProjectEntryRole.Program, artifact: Artifact.Functions },
	{ path: 'assets', kind: ProjectEntryKind.Directory, role: ProjectEntryRole.BinaryAsset, artifact: Artifact.Assets },
	...assetCategories.map(category => ({ path: `assets/${category}`, kind: ProjectEntryKind.Directory, role: ProjectEntryRole.BinaryAsset, artifact: Artifact.Assets })),
	{ path: 'scripts', kind: ProjectEntryKind.Directory, role: ProjectEntryRole.Program, artifact: Artifact.Scripts },
	{ path: 'config', kind: ProjectEntryKind.Directory, role: ProjectEntryRole.Config, artifact: Artifact.Config },
	{ path: 'build', kind: ProjectEntryKind.Directory, role: ProjectEntryRole.Output, artifact: undefined },
].map(entry => Object.freeze(entry)));

export const projectDirectories: readonly IProjectEntry[] = Object.freeze(projectLayout.filter(entry => entry.kind === ProjectEntryKind.Directory));

export function getProjectEntry(path: string): IProjectEntry | undefined {
	return projectLayout.find(entry => entry.path === path);
}

/** Resolved locations of the layout entries inside one Working Directory. */
export interface IProjectPaths {
	readonly root: URI;
	readonly sqlite: URI;
	readonly functions: URI;
	readonly assets: URI;
	readonly assetCategories: Readonly<Record<AssetCategory, URI>>;
	readonly scripts: URI;
	readonly config: URI;
	readonly build: URI;
}

export function resolveProjectPaths(root: URI): IProjectPaths {
	const assets = joinPath(root, 'assets');
	return Object.freeze({
		root,
		sqlite: joinPath(root, PROJECT_SQLITE_FILE_NAME),
		functions: joinPath(root, 'functions'),
		assets,
		assetCategories: Object.freeze({
			[AssetCategory.Image]: joinPath(assets, AssetCategory.Image),
			[AssetCategory.Audio]: joinPath(assets, AssetCategory.Audio),
			[AssetCategory.Font]: joinPath(assets, AssetCategory.Font),
			[AssetCategory.Shader]: joinPath(assets, AssetCategory.Shader),
			[AssetCategory.Other]: joinPath(assets, AssetCategory.Other),
		}),
		scripts: joinPath(root, 'scripts'),
		config: joinPath(root, 'config'),
		build: joinPath(root, 'build'),
	});
}

// #endregion

// #region 3. Open

export const enum ProjectOpenPhase {
	WorkingDirectorySelect = 'workingDirectorySelect',
	DirectoryScan = 'directoryScan',
	Create = 'create',
	Open = 'open',
	EditorDdlScan = 'editorDdlScan',
	SchemaVersionResolve = 'schemaVersionResolve',
	MigrationApply = 'migrationApply',
	RegistryLoad = 'registryLoad',
	FunctionScan = 'functionScan',
	AssetScan = 'assetScan',
	EditorReady = 'editorReady',
}

export const enum ProjectOpenMode {
	/** `project.sqlite` did not exist: the project was created. */
	Create = 'create',
	/** `project.sqlite` existed: the project was opened. */
	Open = 'open',
}

export interface IProjectEntryScan {
	readonly entry: IProjectEntry;
	readonly resource: URI;
	readonly exists: boolean;
}

export interface IProjectDirectoryScan {
	readonly paths: IProjectPaths;
	readonly rootExists: boolean;
	readonly sqliteExists: boolean;
	readonly entries: readonly IProjectEntryScan[];
	/** Layout entries that are missing (or have the wrong kind) in the Working Directory. */
	readonly missing: readonly IProjectEntry[];
}

export class ProjectDirectoryError extends Error {
	constructor(message: string, readonly resource: URI) {
		super(message);
		this.name = 'ProjectDirectoryError';
	}
}

/** `Directory Scan`: inspects the Working Directory against the canonical layout. Performs no writes. */
export async function scanProjectDirectory(fileService: IFileService, root: URI): Promise<IProjectDirectoryScan> {
	const paths = resolveProjectPaths(root);
	const rootStat = await statOrUndefined(fileService, root);
	if (rootStat && !rootStat.isDirectory) {
		throw new ProjectDirectoryError(`Primitive App Editor working directory is not a directory: ${root.toString()}`, root);
	}

	const entries: IProjectEntryScan[] = [];
	for (const entry of projectLayout) {
		const resource = joinPath(root, ...entry.path.split('/'));
		const stat = rootStat ? await statOrUndefined(fileService, resource) : undefined;
		if (stat && stat.isDirectory !== (entry.kind === ProjectEntryKind.Directory)) {
			throw new ProjectDirectoryError(`Primitive App Editor project entry '${entry.path}' must be a ${entry.kind}: ${resource.toString()}`, resource);
		}
		entries.push(Object.freeze({ entry, resource, exists: !!stat }));
	}

	return Object.freeze({
		paths,
		rootExists: !!rootStat,
		sqliteExists: entries.some(scan => scan.entry.path === PROJECT_SQLITE_FILE_NAME && scan.exists),
		entries: Object.freeze(entries),
		missing: Object.freeze(entries.filter(scan => !scan.exists).map(scan => scan.entry)),
	});
}

/**
 * Creates the missing layout directories. Existing entries are never overwritten or deleted,
 * and `project.sqlite` is never created here: it is created by the storage step.
 */
export async function ensureProjectDirectories(fileService: IFileService, scan: IProjectDirectoryScan): Promise<readonly IProjectEntry[]> {
	const created: IProjectEntry[] = [];
	if (!scan.rootExists) {
		await fileService.createFolder(scan.paths.root);
	}
	for (const entryScan of scan.entries) {
		if (!entryScan.exists && entryScan.entry.kind === ProjectEntryKind.Directory) {
			await fileService.createFolder(entryScan.resource);
			created.push(entryScan.entry);
		}
	}
	return Object.freeze(created);
}

/** Context handed to every step after `Directory Scan`. */
export interface IProjectOpenContext {
	readonly mode: ProjectOpenMode;
	readonly paths: IProjectPaths;
	readonly scan: IProjectDirectoryScan;
}

/**
 * Services owning each `Open` step. `createStorage` / `openStorage` own `project.sqlite`;
 * the remaining steps own Editor DDL, schema versions, migrations, Registry, Function and
 * Asset discovery. Every step required by the open mode must be supplied: an open with a
 * missing step is incomplete and never reaches `Editor Ready`.
 */
export interface IProjectOpenSteps {
	createStorage?(context: IProjectOpenContext): Promise<void>;
	openStorage?(context: IProjectOpenContext): Promise<void>;
	editorDdlScan?(context: IProjectOpenContext): Promise<void>;
	schemaVersionResolve?(context: IProjectOpenContext): Promise<void>;
	migrationApply?(context: IProjectOpenContext): Promise<void>;
	registryLoad?(context: IProjectOpenContext): Promise<void>;
	functionScan?(context: IProjectOpenContext): Promise<void>;
	assetScan?(context: IProjectOpenContext): Promise<void>;
}

type ProjectOpenStep = (context: IProjectOpenContext) => Promise<void>;

/**
 * Phases between `Directory Scan` and `Editor Ready` that must complete for `mode`, in
 * specification order.
 */
export function getRequiredOpenPhases(mode: ProjectOpenMode): readonly ProjectOpenPhase[] {
	return Object.freeze([
		mode === ProjectOpenMode.Create ? ProjectOpenPhase.Create : ProjectOpenPhase.Open,
		ProjectOpenPhase.EditorDdlScan,
		ProjectOpenPhase.SchemaVersionResolve,
		ProjectOpenPhase.MigrationApply,
		ProjectOpenPhase.RegistryLoad,
		ProjectOpenPhase.FunctionScan,
		ProjectOpenPhase.AssetScan,
	]);
}

function getOpenStep(steps: IProjectOpenSteps, phase: ProjectOpenPhase): ProjectOpenStep | undefined {
	switch (phase) {
		case ProjectOpenPhase.Create: return steps.createStorage?.bind(steps);
		case ProjectOpenPhase.Open: return steps.openStorage?.bind(steps);
		case ProjectOpenPhase.EditorDdlScan: return steps.editorDdlScan?.bind(steps);
		case ProjectOpenPhase.SchemaVersionResolve: return steps.schemaVersionResolve?.bind(steps);
		case ProjectOpenPhase.MigrationApply: return steps.migrationApply?.bind(steps);
		case ProjectOpenPhase.RegistryLoad: return steps.registryLoad?.bind(steps);
		case ProjectOpenPhase.FunctionScan: return steps.functionScan?.bind(steps);
		case ProjectOpenPhase.AssetScan: return steps.assetScan?.bind(steps);
		default: return undefined;
	}
}

export const enum ProjectOpenStatus {
	/** Every required phase completed; the last phase is `editorReady`. */
	Ready = 'ready',
	/** A required step was not supplied; no step ran and `editorReady` was not reached. */
	Incomplete = 'incomplete',
}

interface IProjectOpenResultBase {
	readonly mode: ProjectOpenMode;
	readonly paths: IProjectPaths;
	readonly scan: IProjectDirectoryScan;
	/** Layout directories created during this open. */
	readonly createdDirectories: readonly IProjectEntry[];
	/** Phases in the order they completed. */
	readonly phases: readonly ProjectOpenPhase[];
}

export interface IProjectOpenReadyResult extends IProjectOpenResultBase {
	readonly status: ProjectOpenStatus.Ready;
}

export interface IProjectOpenIncompleteResult extends IProjectOpenResultBase {
	readonly status: ProjectOpenStatus.Incomplete;
	/** Required phases whose owning step was not supplied. */
	readonly missingPhases: readonly ProjectOpenPhase[];
}

export type IProjectOpenResult = IProjectOpenReadyResult | IProjectOpenIncompleteResult;

/**
 * `Open`: Working Directory Select -> Directory Scan -> (Create | Open) -> Editor DDL Scan ->
 * Schema Version Resolve -> Migration Apply -> Registry Load -> (Function Scan || Asset Scan)
 * -> Editor Ready.
 *
 * `Editor Ready` is reached only when every required phase actually completed. When a required
 * step is not supplied the open is `incomplete`: it stops after `Directory Scan` without writing
 * to the Working Directory or running any step. A failing step rejects the whole open.
 */
export async function openProjectDirectory(fileService: IFileService, root: URI, steps: IProjectOpenSteps = {}): Promise<IProjectOpenResult> {
	if (!isAuthorityFor(AuthorityConcern.ProjectStorage, AuthoritySource.WorkingDirectory)) {
		throw new Error('Working Directory is not the Project Storage authority');
	}

	const phases: ProjectOpenPhase[] = [ProjectOpenPhase.WorkingDirectorySelect];

	const scan = await scanProjectDirectory(fileService, root);
	phases.push(ProjectOpenPhase.DirectoryScan);

	const mode = scan.sqliteExists ? ProjectOpenMode.Open : ProjectOpenMode.Create;
	const requiredPhases = getRequiredOpenPhases(mode);
	const missingPhases = requiredPhases.filter(phase => !getOpenStep(steps, phase));
	if (missingPhases.length) {
		return Object.freeze({
			status: ProjectOpenStatus.Incomplete,
			mode,
			paths: scan.paths,
			scan,
			createdDirectories: Object.freeze([]),
			phases: Object.freeze(phases),
			missingPhases: Object.freeze(missingPhases),
		});
	}

	const createdDirectories = await ensureProjectDirectories(fileService, scan);
	const context: IProjectOpenContext = Object.freeze({ mode, paths: scan.paths, scan });

	const run = async (phase: ProjectOpenPhase) => {
		await getOpenStep(steps, phase)!(context);
		phases.push(phase);
	};

	const [storage, editorDdlScan, schemaVersionResolve, migrationApply, registryLoad, functionScan, assetScan] = requiredPhases;
	await run(storage);
	await run(editorDdlScan);
	await run(schemaVersionResolve);
	await run(migrationApply);
	await run(registryLoad);
	await Promise.all([run(functionScan), run(assetScan)]);
	phases.push(ProjectOpenPhase.EditorReady);

	return Object.freeze({
		status: ProjectOpenStatus.Ready,
		mode,
		paths: scan.paths,
		scan,
		createdDirectories,
		phases: Object.freeze(phases),
	});
}

async function statOrUndefined(fileService: IFileService, resource: URI) {
	try {
		return await fileService.stat(resource);
	} catch {
		return undefined;
	}
}

// #endregion
