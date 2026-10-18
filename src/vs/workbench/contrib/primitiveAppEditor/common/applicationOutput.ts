/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Generic Application Output projection (build.application-output)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. Application Output)
 *--------------------------------------------------------------------------------------------*/

import { IAsset } from './assetRegistry.js';
import {
	BuildValidationError,
	BuildValidationStage,
	IBuildAuthoringData,
	IBuildConfiguration,
	IBuildRawDataTable,
	ISelectedAuthoringView,
	validateBuild,
} from './buildValidation.js';
import { IFunctionBindingEntry } from './functionBinding.js';
import { IFunctionDependencyEntry } from './functionDependency.js';
import { IFunctionRegistryEntry } from './functionRegistry.js';
import { IRelationRegistryEntry } from './relationRegistry.js';
import { IRendererBindingEntry, IRendererRegistryEntry } from './rendererRegistry.js';
import { ITableRegistryEntry } from './tableRegistry.js';

/**
 * `Build` projects Authoring Data into the Application execution form:
 *
 * ```text
 * Selected Authoring View -> Application Definition (Schema / Data / Binding)
 *                         -> Application Program    (Runtime / Renderer)
 *                         => Application Output
 * ```
 *
 * The Authoring Authority is not the Build package format, and the Editor is excluded: the Output
 * is derived only from the Selected Authoring View, so no Editor content can enter it. The
 * serialization and layout of the Output belong to the Build implementation of each `build_target`
 * (see {@link ApplicationOutputProjection}); this module defines only the target-independent model.
 */

/** `Application Definition`: Schema / Data / Binding. */
export interface IApplicationDefinition {
	readonly schema: {
		readonly tables: readonly ITableRegistryEntry[];
		readonly relations: readonly IRelationRegistryEntry[];
		readonly functions: readonly IFunctionRegistryEntry[];
		readonly renderers: readonly IRendererRegistryEntry[];
	};
	/** Seed Raw Data selected by the Build Target Filter. */
	readonly data: {
		readonly seed: readonly IBuildRawDataTable[];
	};
	readonly binding: {
		readonly functions: readonly IFunctionBindingEntry[];
		readonly dependencies: readonly IFunctionDependencyEntry[];
		readonly renderers: readonly IRendererBindingEntry[];
	};
}

/** `Application Program`: the Runtime / Renderer content selected by `include.*`. */
export interface IApplicationProgram {
	/** Working Directory relative paths, sorted. */
	readonly functions: readonly string[];
	readonly scripts: readonly string[];
	readonly config: readonly string[];
	readonly assets: readonly IAsset[];
}

/** The target-independent Application Output. */
export interface IApplicationOutput {
	readonly build_target: string;
	readonly runtime_storage_target: string;
	/** Working Directory relative path under `build/`. */
	readonly output_path: string;
	readonly definition: IApplicationDefinition;
	readonly program: IApplicationProgram;
}

/** A `build_target`'s Application Output Projection: serializes / lays out the Output. Supplied by the Build implementation. */
export type ApplicationOutputProjection<T> = (output: IApplicationOutput) => T;

function sorted(paths: readonly string[]): readonly string[] {
	return Object.freeze([...paths].sort());
}

/** `Selected Authoring View -> Application Output`. Pure and deterministic; the View is not modified. */
export function createApplicationOutput(view: ISelectedAuthoringView, configuration: IBuildConfiguration): IApplicationOutput {
	return Object.freeze({
		build_target: configuration.build_target,
		runtime_storage_target: configuration.runtime_storage_target,
		output_path: configuration.output_path,
		definition: Object.freeze({
			schema: Object.freeze({ tables: view.tables, relations: view.relations, functions: view.functions, renderers: view.renderers }),
			data: Object.freeze({ seed: view.rawData }),
			binding: Object.freeze({ functions: view.bindings, dependencies: view.dependencies, renderers: view.rendererBindings }),
		}),
		program: Object.freeze({
			functions: sorted(view.functionPaths),
			scripts: sorted(view.scriptPaths),
			config: sorted(view.configPaths),
			assets: view.assets,
		}),
	});
}

/**
 * `Authoring Data + Build Configuration -> Build Validation -> Build Target Filter -> Application
 * Output`, then the Projection the `build_target` provides. A `build_target` without a Projection
 * is rejected before anything is produced; nothing is written to Authoring Data.
 */
export function projectApplicationOutput<T>(
	authoring: IBuildAuthoringData,
	input: unknown,
	projections: ReadonlyMap<string, ApplicationOutputProjection<T>>,
): { readonly output: IApplicationOutput; readonly result: T } {
	const { configuration, view } = validateBuild(authoring, input);
	const projection = projections.get(configuration.build_target);
	if (!projection) {
		throw new BuildValidationError(BuildValidationStage.BuildConfiguration, `build_target '${configuration.build_target}' has no Application Output Projection`);
	}
	const output = createApplicationOutput(view, configuration);
	return Object.freeze({ output, result: projection(output) });
}
