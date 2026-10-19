/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Project Open wiring for the Workbench (workbench.integration)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (3. Open, 39. Working Directory Integration)
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorDdlResource, EditorDdlMigrator } from './editorDdl.js';
import { EnumRegistryIndex, IEnumRegistryEntry, readEnumRegistry, validateTableEnumReferences } from './enumRegistry.js';
import { IFunctionRegistryEntry, IFunctionExecutorCatalog, readFunctionRegistry } from './functionRegistry.js';
import { createFunctionScanStep, IFunctionScanResult } from './functionProgramScan.js';
import { createAssetScanStep, IAsset } from './assetRegistry.js';
import { IProjectOpenResult, IProjectOpenSteps, IProjectOpenContext, openProjectDirectory, ProjectOpenStatus } from './projectDirectory.js';
import { IProjectSqliteDatabaseFactory, ProjectSqliteStorage } from './projectSqlite.js';
import { IRelationRegistryEntry, readRelationRegistry, validateRelationReferences } from './relationRegistry.js';
import { IRendererBindingEntry, IRendererRegistryEntry, readRendererBindings, readRendererRegistry, validateRendererBindingAgainstRegistry } from './rendererRegistry.js';
import { validateRegistryProjection } from './registryService.js';
import { ITableRegistryEntry, readTableRegistry } from './tableRegistry.js';

/**
 * `Open Folder -> Project Directory Resolve -> App Editor Initialize -> SQLite / Registry /
 * Asset / Function Load`. The Workbench folder is the Project (`Folder = Project`): this module
 * wires the Open steps owned by earlier bundles into one {@link openProjectDirectory} run and
 * exposes the outcome as an observable {@link ProjectOpenState}. It owns no authority: the
 * Registry stays the Schema Authority, the Working Directory the Project Authority.
 */

/** Registry contents loaded by `Registry Load`. */
export interface IRegistrySnapshot {
	readonly tables: readonly ITableRegistryEntry[];
	readonly enums: readonly IEnumRegistryEntry[];
	readonly relations: readonly IRelationRegistryEntry[];
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly rendererBindings: readonly IRendererBindingEntry[];
}

/** Project Open state shown by the Workbench (Status Bar = Project / Runtime / Build Status). */
export const enum ProjectOpenState {
	/** No folder is open as a Project. */
	None = 'none',
	Opening = 'opening',
	/** `Editor Ready` was reached. */
	Ready = 'ready',
	/** A required Open step was not supplied; no step ran. */
	Incomplete = 'incomplete',
	/** A step rejected the open. */
	Failed = 'failed',
}

export interface IProjectOpenSessionState {
	readonly state: ProjectOpenState;
	readonly root: URI | undefined;
	readonly result: IProjectOpenResult | undefined;
	readonly error: Error | undefined;
	readonly registry: IRegistrySnapshot | undefined;
	readonly functionScan: IFunctionScanResult | undefined;
	readonly assets: readonly IAsset[] | undefined;
}

const noneState: IProjectOpenSessionState = Object.freeze({ state: ProjectOpenState.None, root: undefined, result: undefined, error: undefined, registry: undefined, functionScan: undefined, assets: undefined });

/** `Registry Load` -> Registry cross-validation, in the order the Registries depend on each other. */
export async function loadRegistrySnapshot(storage: Pick<ProjectSqliteStorage, 'database'>, catalog: IFunctionExecutorCatalog): Promise<IRegistrySnapshot> {
	const database = storage.database;
	const tables = await readTableRegistry(database);
	const enums = await readEnumRegistry(database);
	const relations = await readRelationRegistry(database);
	const functions = await readFunctionRegistry(database, catalog);
	const renderers = await readRendererRegistry(database);
	const rendererBindings = await readRendererBindings(database);

	validateRegistryProjection(tables);
	validateTableEnumReferences(tables, new EnumRegistryIndex(enums));
	validateRelationReferences(relations, tables);
	for (const binding of rendererBindings) {
		validateRendererBindingAgainstRegistry(binding, renderers, tables);
	}
	return Object.freeze({ tables, enums, relations, functions, renderers, rendererBindings });
}

/**
 * One Project Open session of the Workbench. {@link open} runs the full Open lifecycle for a
 * folder and replaces the previous Project; {@link close} releases `project.sqlite`.
 */
export class ProjectOpenSession {

	private _state: IProjectOpenSessionState = noneState;
	private storage: ProjectSqliteStorage | undefined;
	private listeners: ((state: IProjectOpenSessionState) => void)[] = [];

	constructor(
		private readonly fileService: IFileService,
		private readonly databaseFactory: IProjectSqliteDatabaseFactory,
		private readonly ddlResources: readonly IEditorDdlResource[],
		private readonly executorCatalog: IFunctionExecutorCatalog,
	) { }

	get state(): IProjectOpenSessionState { return this._state; }

	/** The open `project.sqlite` of a Ready Project; consumers (views, services) use it, never reopen it. */
	get database() {
		return this.storage?.database;
	}

	onDidChangeState(listener: (state: IProjectOpenSessionState) => void): { dispose(): void } {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners = this.listeners.filter(candidate => candidate !== listener); } };
	}

	async open(root: URI): Promise<IProjectOpenSessionState> {
		await this.close();
		this.update({ ...noneState, state: ProjectOpenState.Opening, root });

		const storage = new ProjectSqliteStorage(this.databaseFactory);
		const migrator = new EditorDdlMigrator(storage, this.ddlResources);
		let registry: IRegistrySnapshot | undefined;
		let functionScan: IFunctionScanResult | undefined;
		let assets: readonly IAsset[] | undefined;

		const steps: IProjectOpenSteps = {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: async (_context: IProjectOpenContext) => { registry = await loadRegistrySnapshot(storage, this.executorCatalog); },
			functionScan: createFunctionScanStep(this.fileService, this.executorCatalog, async () => registry!.functions, result => { functionScan = result; }),
			assetScan: createAssetScanStep(this.fileService, async () => [], found => { assets = found; }),
		};

		try {
			const result = await openProjectDirectory(this.fileService, root, steps);
			if (result.status === ProjectOpenStatus.Ready) {
				this.storage = storage;
				return this.update({ state: ProjectOpenState.Ready, root, result, error: undefined, registry, functionScan, assets });
			}
			await storage.close();
			return this.update({ ...noneState, state: ProjectOpenState.Incomplete, root, result });
		} catch (error) {
			await storage.close();
			return this.update({ ...noneState, state: ProjectOpenState.Failed, root, error: error instanceof Error ? error : new Error(String(error)) });
		}
	}

	async close(): Promise<void> {
		const storage = this.storage;
		this.storage = undefined;
		await storage?.close();
		if (this._state.state !== ProjectOpenState.None) {
			this.update(noneState);
		}
	}

	private update(state: IProjectOpenSessionState): IProjectOpenSessionState {
		this._state = Object.freeze(state);
		for (const listener of this.listeners) {
			listener(this._state);
		}
		return this._state;
	}
}
