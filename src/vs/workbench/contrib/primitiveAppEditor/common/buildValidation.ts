/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Build Configuration, Build Target Filter and Build Validation (build.validation)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. Build Configuration, Build Target Filter, Build Validation)
 *--------------------------------------------------------------------------------------------*/

import { IAsset, validateAssetRegistry } from './assetRegistry.js';
import { IFunctionBindingEntry, validateFunctionBindingAgainstRegistry, validateFunctionBindings } from './functionBinding.js';
import { buildFunctionExecutionPlan, IFunctionDependencyEntry, validateFunctionDependencies } from './functionDependency.js';
import { IFunctionExecutorCatalog, IFunctionRegistryEntry } from './functionRegistry.js';
import { resolveFunctionExecutors } from './functionProgramScan.js';
import { isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { validateRegistryProjection } from './registryService.js';
import { IRelationRegistryEntry, validateRelationReferences, validateRelationRegistry } from './relationRegistry.js';
import {
	IRendererBindingEntry,
	IRendererRegistryEntry,
	validateRendererBindingAgainstRegistry,
	validateRendererBindings,
	validateRendererRegistry,
} from './rendererRegistry.js';
import { ITableRegistryEntry, validateTableRegistry } from './tableRegistry.js';

/**
 * `Authoring Data + Build Configuration -> Build Target Filter -> Selected Authoring View ->
 * Application Output Projection`.
 *
 * Build Configuration is a Build / Export Selection. It is neither Application Authority nor
 * Authoring Authority: nothing here writes Registry / Raw Data / Binding, and the Build
 * Configuration is never stored in them. Where it is stored and serialized is the Build
 * implementation's responsibility, so this module only validates and applies an in-memory value.
 */

// #region Build Configuration

/** `build_target`s the current SSOT defines, each with the `runtime_storage_target`s it supports. */
export const POSTGRESQL_WEB_APPLICATION_OUTPUT = 'PostgreSQL Web Application Output';
export const POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE = 'ASP.NET Core API + Next.js UI / PostgreSQL';

/** `build_target` -> the `runtime_storage_target`s it supports. A pair outside this table is rejected. */
export const buildTargetRuntimeStorageTargets: ReadonlyMap<string, readonly string[]> = new Map([
	[POSTGRESQL_WEB_APPLICATION_OUTPUT, Object.freeze([POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE])],
]);

/** The Build directory every `output_path` lives under. */
export const BUILD_OUTPUT_DIRECTORY = 'build';

/** The minimum Build Configuration contract. Field names / serialization may be extended by the Build implementation. */
export interface IBuildConfiguration {
	readonly build_target: string;
	readonly runtime_storage_target: string;
	readonly seed_data: {
		readonly include: boolean;
		readonly raw_data: {
			/** `table_registry.uuid`: only the Raw Data of these tables enters the Seed. */
			readonly tables: readonly string[];
			/** Row UUIDs removed from the included tables. */
			readonly exclude_rows: readonly string[];
		};
	};
	readonly include: {
		/** `asset.uuid`. */
		readonly assets: readonly string[];
		/** Working Directory relative paths. */
		readonly functions: readonly string[];
		readonly scripts: readonly string[];
		readonly config: readonly string[];
	};
	/** Working Directory relative path under `build/`. */
	readonly output_path: string;
}

export class BuildValidationError extends Error {
	constructor(readonly stage: BuildValidationStage, message: string) {
		super(`Primitive App Editor build (${stage}): ${message}`);
		this.name = 'BuildValidationError';
	}
}

/** The Build Validation pipeline, in order. */
export const enum BuildValidationStage {
	BuildConfiguration = 'Build Configuration Validate',
	Registry = 'Registry Validate',
	PhysicalSchema = 'Physical Schema Validate',
	Relation = 'Relation Validate',
	FunctionExecutor = 'Function Executor Validate',
	Dependency = 'Dependency Validate',
	RuntimeAddress = 'Runtime Address Validate',
	Renderer = 'Renderer Validate',
	Asset = 'Asset Validate',
}

export const buildValidationStages: readonly BuildValidationStage[] = Object.freeze([
	BuildValidationStage.BuildConfiguration,
	BuildValidationStage.Registry,
	BuildValidationStage.PhysicalSchema,
	BuildValidationStage.Relation,
	BuildValidationStage.FunctionExecutor,
	BuildValidationStage.Dependency,
	BuildValidationStage.RuntimeAddress,
	BuildValidationStage.Renderer,
	BuildValidationStage.Asset,
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function fail(stage: BuildValidationStage, message: string): never {
	throw new BuildValidationError(stage, message);
}

function requireText(stage: BuildValidationStage, value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		fail(stage, `${field} must be non-empty text`);
	}
	return value;
}

function requireList(stage: BuildValidationStage, value: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		fail(stage, `${field} must be a list`);
	}
	return value;
}

/** Normalizes a Working Directory relative path; undefined when it is absolute, empty or escapes the Working Directory. */
export function normalizeWorkingDirectoryPath(path: string): string | undefined {
	if (path.length === 0 || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
		return undefined;
	}
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length === 0) {
				return undefined;
			}
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length === 0 ? undefined : segments.join('/');
}

function requireUuidList(value: unknown, field: string): readonly string[] {
	const list = requireList(BuildValidationStage.BuildConfiguration, value, field);
	const seen = new Set<string>();
	return Object.freeze(list.map(item => {
		if (!isRegistryUuid(item)) {
			fail(BuildValidationStage.BuildConfiguration, `${field} must contain UUIDs, got ${JSON.stringify(item)}`);
		}
		const uuid = normalizeRegistryUuid(item);
		if (seen.has(uuid)) {
			fail(BuildValidationStage.BuildConfiguration, `${field} lists '${uuid}' more than once`);
		}
		seen.add(uuid);
		return uuid;
	}));
}

function requirePathList(value: unknown, field: string): readonly string[] {
	const list = requireList(BuildValidationStage.BuildConfiguration, value, field);
	const seen = new Set<string>();
	return Object.freeze(list.map(item => {
		const path = typeof item === 'string' ? normalizeWorkingDirectoryPath(item) : undefined;
		if (path === undefined) {
			fail(BuildValidationStage.BuildConfiguration, `${field} must contain Working Directory relative paths, got ${JSON.stringify(item)}`);
		}
		if (seen.has(path)) {
			fail(BuildValidationStage.BuildConfiguration, `${field} lists '${path}' more than once`);
		}
		seen.add(path);
		return path;
	}));
}

/**
 * Contract part of `Build Configuration Validate`: the shape of {@link IBuildConfiguration}, UUID
 * and path syntax, `output_path` under `build/` and the `build_target` / `runtime_storage_target`
 * pairing. Returns the normalized Configuration (UUIDs lower-cased, paths normalized); the input is
 * not modified. Existence of the listed Tables / Rows / Assets / Paths needs Authoring Data and is
 * checked by {@link validateBuild}.
 */
export function createBuildConfiguration(input: unknown): IBuildConfiguration {
	const stage = BuildValidationStage.BuildConfiguration;
	if (!isPlainRecord(input)) {
		fail(stage, 'build_configuration must be an object');
	}
	const buildTarget = requireText(stage, input.build_target, 'build_target');
	const runtimeStorageTarget = requireText(stage, input.runtime_storage_target, 'runtime_storage_target');
	const supported = buildTargetRuntimeStorageTargets.get(buildTarget);
	if (!supported) {
		fail(stage, `build_target '${buildTarget}' is not provided by the Build implementation`);
	}
	if (!supported.includes(runtimeStorageTarget)) {
		fail(stage, `build_target '${buildTarget}' does not support runtime_storage_target '${runtimeStorageTarget}'`);
	}

	const seedData = input.seed_data;
	if (!isPlainRecord(seedData)) {
		fail(stage, 'seed_data must be an object');
	}
	if (typeof seedData.include !== 'boolean') {
		fail(stage, 'seed_data.include must be bool');
	}
	if (!isPlainRecord(seedData.raw_data)) {
		fail(stage, 'seed_data.raw_data must be an object');
	}
	const tables = requireUuidList(seedData.raw_data.tables, 'seed_data.raw_data.tables');
	const excludeRows = requireUuidList(seedData.raw_data.exclude_rows, 'seed_data.raw_data.exclude_rows');

	if (!isPlainRecord(input.include)) {
		fail(stage, 'include must be an object');
	}
	const assets = requireUuidList(input.include.assets, 'include.assets');
	const functions = requirePathList(input.include.functions, 'include.functions');
	const scripts = requirePathList(input.include.scripts, 'include.scripts');
	const config = requirePathList(input.include.config, 'include.config');

	const outputPath = typeof input.output_path === 'string' ? normalizeWorkingDirectoryPath(input.output_path) : undefined;
	if (outputPath === undefined) {
		fail(stage, `output_path must be a Working Directory relative path, got ${JSON.stringify(input.output_path)}`);
	}
	if (outputPath !== BUILD_OUTPUT_DIRECTORY && !outputPath.startsWith(`${BUILD_OUTPUT_DIRECTORY}/`)) {
		fail(stage, `output_path '${outputPath}' is outside '${BUILD_OUTPUT_DIRECTORY}/'`);
	}

	return Object.freeze({
		build_target: buildTarget,
		runtime_storage_target: runtimeStorageTarget,
		seed_data: Object.freeze({
			include: seedData.include,
			raw_data: Object.freeze({ tables, exclude_rows: excludeRows }),
		}),
		include: Object.freeze({ assets, functions, scripts, config }),
		output_path: outputPath,
	});
}

// #endregion

// #region Authoring Data / Build Target Filter

/** One Raw Data row as the Build sees it: the Row identity and its values. */
export interface IBuildRawDataRow {
	readonly uuid: string;
	readonly values: Readonly<Record<string, unknown>>;
}

/** The Raw Data of one Physical Table (`table_registry.uuid`). */
export interface IBuildRawDataTable {
	readonly table_uuid: string;
	readonly rows: readonly IBuildRawDataRow[];
}

/** Resolves the Program (a Working Directory relative path) that implements a Registry `executor`; undefined when there is none. */
export type BuildExecutorProgramResolver = (executor: string) => string | undefined;

/**
 * The Authoring Data the Build reads. Everything is supplied by the caller (read from the Registry /
 * Raw Data / Binding / Working Directory) and is never modified.
 */
export interface IBuildAuthoringData {
	readonly tables: readonly ITableRegistryEntry[];
	readonly relations: readonly IRelationRegistryEntry[];
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly bindings: readonly IFunctionBindingEntry[];
	readonly dependencies: readonly IFunctionDependencyEntry[];
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly rendererBindings: readonly IRendererBindingEntry[];
	readonly assets: readonly IAsset[];
	readonly rawData: readonly IBuildRawDataTable[];
	/** Every file of the Working Directory (relative, `/` separated): the existence check of `include.functions / scripts / config`. */
	readonly workingDirectoryPaths: readonly string[];
	/** Code Primitive executors (`Registry executor -> Code Primitive`). */
	readonly executorCatalog: IFunctionExecutorCatalog;
	/** Executor -> Program path; the Build implementation decides where an executor's Program lives. */
	readonly resolveExecutorProgram: BuildExecutorProgramResolver;
}

/** `Selected Authoring View`: what the Application Output Projection is given. */
export interface ISelectedAuthoringView {
	/** Registry and every binding pass through whole (not filter targets). */
	readonly tables: readonly ITableRegistryEntry[];
	readonly relations: readonly IRelationRegistryEntry[];
	readonly functions: readonly IFunctionRegistryEntry[];
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly bindings: readonly IFunctionBindingEntry[];
	readonly dependencies: readonly IFunctionDependencyEntry[];
	readonly rendererBindings: readonly IRendererBindingEntry[];
	/** Seed Raw Data: `seed_data.include && tables && !exclude_rows` only. */
	readonly rawData: readonly IBuildRawDataTable[];
	/** `include.assets` only. */
	readonly assets: readonly IAsset[];
	readonly functionPaths: readonly string[];
	readonly scriptPaths: readonly string[];
	readonly configPaths: readonly string[];
}

/**
 * `Build Target Filter`: deterministic and read-only. Registry and Function / Renderer Binding pass
 * whole; Raw Data is selected by `seed_data`; assets / functions / scripts / config are selected by
 * `include.*`. Whether a row is Editor / Preview data is never inferred: a row is out of the Seed
 * only because the Configuration does not select it.
 */
export function applyBuildTargetFilter(authoring: IBuildAuthoringData, configuration: IBuildConfiguration): ISelectedAuthoringView {
	const seedTables = new Set(configuration.seed_data.raw_data.tables);
	const excludedRows = new Set(configuration.seed_data.raw_data.exclude_rows);
	const includedAssets = new Set(configuration.include.assets);

	const rawData = configuration.seed_data.include
		? authoring.rawData
			.filter(table => seedTables.has(normalizeRegistryUuid(table.table_uuid)))
			.map(table => Object.freeze({ table_uuid: table.table_uuid, rows: Object.freeze(table.rows.filter(row => !excludedRows.has(normalizeRegistryUuid(row.uuid)))) }))
		: [];

	return Object.freeze({
		tables: authoring.tables,
		relations: authoring.relations,
		functions: authoring.functions,
		renderers: authoring.renderers,
		bindings: authoring.bindings,
		dependencies: authoring.dependencies,
		rendererBindings: authoring.rendererBindings,
		rawData: Object.freeze(rawData),
		assets: Object.freeze(authoring.assets.filter(asset => includedAssets.has(normalizeRegistryUuid(asset.uuid)))),
		functionPaths: configuration.include.functions,
		scriptPaths: configuration.include.scripts,
		configPaths: configuration.include.config,
	});
}

// #endregion

// #region Build Validation

function wrap<T>(stage: BuildValidationStage, run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof BuildValidationError) {
			throw error;
		}
		throw new BuildValidationError(stage, error instanceof Error ? error.message : String(error));
	}
}

/** The Persistent Addresses a binding refers to, in a stable order. */
function* bindingAddresses(authoring: IBuildAuthoringData): Iterable<{ readonly where: string; readonly table_uuid: string; readonly row_uuid: string }> {
	for (const binding of authoring.bindings) {
		for (const [field, args] of [['inputs', binding.inputs], ['parameters', binding.parameters]] as const) {
			for (const [name, argument] of Object.entries(args)) {
				if (argument.address) {
					yield { where: `function binding '${binding.uuid}' ${field} '${name}'`, ...argument.address };
				}
			}
		}
		yield { where: `function binding '${binding.uuid}' target`, ...binding.target.address };
	}
	for (const binding of authoring.rendererBindings) {
		for (const [name, value] of Object.entries(binding.bindings)) {
			if ('address' in value) {
				yield { where: `renderer binding '${binding.uuid}' bindings '${name}'`, ...value.address };
			}
		}
	}
}

function validateBuildConfigurationAgainst(authoring: IBuildAuthoringData, configuration: IBuildConfiguration): void {
	const stage = BuildValidationStage.BuildConfiguration;
	const tables = new Map(authoring.tables.map(table => [normalizeRegistryUuid(table.uuid), table]));
	for (const uuid of configuration.seed_data.raw_data.tables) {
		if (!tables.has(uuid)) {
			fail(stage, `seed_data.raw_data.tables: table '${uuid}' is not in table_registry`);
		}
	}
	const rowsByUuid = new Set<string>();
	for (const table of authoring.rawData) {
		for (const row of table.rows) {
			rowsByUuid.add(normalizeRegistryUuid(row.uuid));
		}
	}
	for (const uuid of configuration.seed_data.raw_data.exclude_rows) {
		if (!rowsByUuid.has(uuid)) {
			fail(stage, `seed_data.raw_data.exclude_rows: row '${uuid}' does not exist in Raw Data`);
		}
	}
	const assets = new Set(authoring.assets.map(asset => normalizeRegistryUuid(asset.uuid)));
	for (const uuid of configuration.include.assets) {
		if (!assets.has(uuid)) {
			fail(stage, `include.assets: asset '${uuid}' is not in the Asset Registry`);
		}
	}
	const paths = new Set(authoring.workingDirectoryPaths);
	for (const [field, list] of [['functions', configuration.include.functions], ['scripts', configuration.include.scripts], ['config', configuration.include.config]] as const) {
		for (const path of list) {
			if (!paths.has(path)) {
				fail(stage, `include.${field}: '${path}' does not exist in the Working Directory`);
			}
		}
	}
}

/**
 * `Build Configuration Validate -> Registry Validate -> Physical Schema Validate -> Relation Validate
 * -> Function Executor Validate -> Dependency Validate -> Runtime Address Validate -> Renderer
 * Validate -> Asset Validate -> Build`. The first failing stage rejects with a
 * {@link BuildValidationError} naming it; nothing is written. A passing run returns the normalized
 * Configuration and the Selected Authoring View the Build projects.
 */
export function validateBuild(authoring: IBuildAuthoringData, input: unknown): { readonly configuration: IBuildConfiguration; readonly view: ISelectedAuthoringView } {
	const configuration = createBuildConfiguration(input);
	wrap(BuildValidationStage.BuildConfiguration, () => validateBuildConfigurationAgainst(authoring, configuration));
	const view = applyBuildTargetFilter(authoring, configuration);

	wrap(BuildValidationStage.Registry, () => {
		validateTableRegistry(authoring.tables);
		validateRelationRegistry(authoring.relations);
		validateRendererRegistry(authoring.renderers);
		validateAssetRegistry(authoring.assets);
	});

	wrap(BuildValidationStage.PhysicalSchema, () => validateRegistryProjection(authoring.tables));

	wrap(BuildValidationStage.Relation, () => validateRelationReferences(authoring.relations, authoring.tables));

	wrap(BuildValidationStage.FunctionExecutor, () => {
		// Registry executor -> Code Primitive: a missing executor rejects.
		resolveFunctionExecutors(authoring.functions, authoring.executorCatalog);
		const included = new Set(configuration.include.functions);
		const required = new Set<string>();
		validateFunctionBindings(authoring.bindings);
		for (const binding of authoring.bindings) {
			const definition = authoring.functions.find(candidate => candidate.uuid === binding.function.uuid);
			if (!definition) {
				throw new BuildValidationError(BuildValidationStage.FunctionExecutor, `binding '${binding.uuid}': function_registry has no function '${binding.function.uuid}' (Missing Definition)`);
			}
			required.add(definition.executor);
		}
		for (const executor of [...required].sort()) {
			const program = authoring.resolveExecutorProgram(executor);
			if (program === undefined) {
				throw new BuildValidationError(BuildValidationStage.FunctionExecutor, `executor '${executor}' has no Program`);
			}
			const path = normalizeWorkingDirectoryPath(program);
			if (path === undefined || !included.has(path)) {
				throw new BuildValidationError(BuildValidationStage.FunctionExecutor, `Program '${program}' of executor '${executor}' is not in include.functions`);
			}
		}
	});

	wrap(BuildValidationStage.Dependency, () => {
		for (const binding of authoring.bindings) {
			validateFunctionBindingAgainstRegistry(binding, authoring.functions, authoring.tables);
		}
		validateFunctionDependencies(authoring.dependencies);
		buildFunctionExecutionPlan(authoring.bindings, authoring.dependencies);
	});

	wrap(BuildValidationStage.RuntimeAddress, () => {
		const authored = new Map<string, Set<string>>();
		for (const table of authoring.rawData) {
			authored.set(normalizeRegistryUuid(table.table_uuid), new Set(table.rows.map(row => normalizeRegistryUuid(row.uuid))));
		}
		const selected = new Map<string, Set<string>>();
		for (const table of view.rawData) {
			selected.set(normalizeRegistryUuid(table.table_uuid), new Set(table.rows.map(row => normalizeRegistryUuid(row.uuid))));
		}
		for (const address of bindingAddresses(authoring)) {
			const table = normalizeRegistryUuid(address.table_uuid);
			const row = normalizeRegistryUuid(address.row_uuid);
			// Only a Row that exists in Raw Data and is removed by the Filter is an error; a Row that
			// never existed is not the Filter's doing.
			if (authored.get(table)?.has(row) && !selected.get(table)?.has(row)) {
				throw new BuildValidationError(BuildValidationStage.RuntimeAddress, `${address.where}: row '${address.row_uuid}' of table '${address.table_uuid}' is excluded by the Build Target Filter`);
			}
		}
	});

	wrap(BuildValidationStage.Renderer, () => {
		validateRendererBindings(authoring.rendererBindings);
		for (const binding of authoring.rendererBindings) {
			validateRendererBindingAgainstRegistry(binding, authoring.renderers, authoring.tables);
		}
	});

	wrap(BuildValidationStage.Asset, () => {
		const known = new Set(authoring.assets.map(asset => normalizeRegistryUuid(asset.uuid)));
		const included = new Set(view.assets.map(asset => normalizeRegistryUuid(asset.uuid)));
		for (const binding of authoring.rendererBindings) {
			for (const [name, value] of Object.entries(binding.bindings)) {
				if (!('asset_uuid' in value)) {
					continue;
				}
				const uuid = normalizeRegistryUuid(value.asset_uuid);
				if (!known.has(uuid)) {
					throw new BuildValidationError(BuildValidationStage.Asset, `renderer binding '${binding.uuid}' bindings '${name}': asset '${uuid}' is not in the Asset Registry`);
				}
				if (!included.has(uuid)) {
					throw new BuildValidationError(BuildValidationStage.Asset, `renderer binding '${binding.uuid}' bindings '${name}': asset '${uuid}' is not in include.assets`);
				}
			}
		}
	});

	return Object.freeze({ configuration, view });
}

// #endregion
