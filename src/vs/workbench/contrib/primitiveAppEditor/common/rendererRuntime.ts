/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Runtime state projection through renderer (renderer.runtime)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (27. Renderer)
 *  Boundary: App Editer.md (29. Asset, 37. Core Flow)
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { IAsset } from './assetRegistry.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { IProjectSqliteDatabase } from './projectSqlite.js';
import {
	IRendererBindingEntry,
	IRendererRegistryEntry,
	readRendererBindings,
	readRendererRegistry,
	validateRendererBindingAgainstRegistry,
	validateRendererBindings,
	validateRendererRegistry,
} from './rendererRegistry.js';
import { IRuntimeMemoryHandle, IRuntimeState, resolveRuntimeHandle } from './runtimeState.js';
import { ITableRegistryEntry, readTableRegistry } from './tableRegistry.js';

/**
 * ```text
 * Runtime State (Next State) -> Renderer -> Projection
 *
 * Renderer Binding (Persistent Address | asset_uuid) -> Registry Resolve -> Memory Handle | Asset
 * ```
 *
 * `Renderer = Projection of Runtime State`. The Renderer body is Code: the Registry
 * (`renderer_registry.executor`) only names it, and an executor that does not exist in Code is
 * rejected at Load. Binding resolution (Registry Resolve, Runtime Object Resolve, Asset Resolve)
 * happens once when the renderer runtime is built; a Projection then reads Memory Handles and
 * resolved Assets only. It never queries SQLite, never writes Runtime State and never executes a
 * Function (`Function != Renderer`): rendering consumes the Next State the Runtime Loop committed.
 */

export class RendererRuntimeError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor renderer runtime: ${message}`);
		this.name = 'RendererRuntimeError';
	}
}

// #region Renderer implementation (Code)

/** One bound Renderer input as handed to the Renderer: its `kind` and either the current state value or the resolved Asset. */
export type IRendererProjectionInput =
	| { readonly kind: string; readonly value: unknown }
	| { readonly kind: string; readonly asset: IAsset };

/** A Renderer implemented in Code. `project` must be a pure read of its inputs. */
export interface IRendererImplementation {
	readonly executor: string;
	project(inputs: Readonly<Record<string, IRendererProjectionInput>>): unknown;
}

/** The Renderer executors that exist in Code. The Registry never adds to it. */
export interface IRendererExecutorCatalog {
	get(executor: string): IRendererImplementation | undefined;
}

export function createRendererExecutorCatalog(implementations: Iterable<IRendererImplementation>): IRendererExecutorCatalog {
	const known = new Map<string, IRendererImplementation>();
	for (const implementation of implementations) {
		if (known.has(implementation.executor)) {
			throw new RendererRuntimeError(`duplicate renderer executor '${implementation.executor}'`);
		}
		known.set(implementation.executor, implementation);
	}
	return Object.freeze({ get: (executor: string) => known.get(executor) });
}

// #endregion

// #region Build

export interface IRendererRuntimeSources {
	readonly renderers: readonly IRendererRegistryEntry[];
	readonly bindings: readonly IRendererBindingEntry[];
	readonly tables: readonly ITableRegistryEntry[];
	/** The Asset Registry (`asset.registry`); Assets are resolved by `asset_uuid`. */
	readonly assets: readonly IAsset[];
	readonly catalog: IRendererExecutorCatalog;
}

/** One fully resolved Renderer Binding. */
export interface IRendererRuntimeBinding {
	readonly binding: IRendererBindingEntry;
	readonly definition: IRendererRegistryEntry;
	readonly implementation: IRendererImplementation;
	/** Renderer input name -> Memory Handle (Persistent Address bindings). */
	readonly handles: Readonly<Record<string, IRuntimeMemoryHandle>>;
	/** Renderer input name -> resolved Asset (`asset_uuid` bindings). */
	readonly assets: Readonly<Record<string, IAsset>>;
}

/** The Projection of one Renderer Binding for one Runtime State. */
export interface IRendererProjection {
	readonly binding_uuid: string;
	readonly renderer_uuid: string;
	readonly executor: string;
	readonly output: unknown;
}

function setOwn<T>(target: Record<string, T>, name: string, value: T): void {
	// defineProperty keeps any accepted input name (e.g. `__proto__`) as an own data property.
	Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Registry Resolve -> Executor Resolve -> Runtime Object Resolve / Asset Resolve for every Renderer
 * Binding. Rejects instead of completing: a dangling Definition / Address / Asset, an executor missing
 * in Code or a missing Runtime Object rejects, so a returned runtime has nothing left to look up.
 */
export class RendererRuntime {

	static build(state: IRuntimeState, sources: IRendererRuntimeSources): RendererRuntime {
		validateRendererRegistry(sources.renderers);
		validateRendererBindings(sources.bindings);
		const assets = new Map(sources.assets.map(asset => [asset.uuid, asset]));
		const bindings = sources.bindings.map((binding): IRendererRuntimeBinding => {
			const definition = validateRendererBindingAgainstRegistry(binding, sources.renderers, sources.tables);
			const implementation = sources.catalog.get(definition.executor);
			if (!implementation) {
				throw new RendererRuntimeError(`renderer '${definition.name}': executor '${definition.executor}' does not exist in Code`);
			}
			const handles: Record<string, IRuntimeMemoryHandle> = {};
			const resolvedAssets: Record<string, IAsset> = {};
			for (const [name, value] of Object.entries(binding.bindings)) {
				const where = `binding '${binding.uuid}' bindings '${name}'`;
				if (hasKey(value, { address: true })) {
					setOwn(handles, name, resolveRuntimeHandle(state, sources.tables, value.address, where));
				} else {
					const asset = assets.get(value.asset_uuid);
					if (!asset) {
						throw new RendererRuntimeError(`${where}: asset_registry has no asset '${value.asset_uuid}' (Missing Definition)`);
					}
					setOwn(resolvedAssets, name, asset);
				}
			}
			return Object.freeze({ binding, definition, implementation, handles: Object.freeze(handles), assets: Object.freeze(resolvedAssets) });
		});
		return new RendererRuntime(Object.freeze(bindings));
	}

	private constructor(readonly bindings: readonly IRendererRuntimeBinding[]) { }

	/** Runtime State (Next State) -> Renderer -> Projection, for every Renderer Binding in Registry order. Read-only. */
	project(): readonly IRendererProjection[] {
		assertBoundaryFlow(BoundaryNode.Renderer, BoundaryNode.Projection);
		return Object.freeze(this.bindings.map(item => {
			const inputs: Record<string, IRendererProjectionInput> = {};
			const kindOf = (name: string) => item.definition.inputs.find(input => input.name === name)!.kind;
			for (const [name, handle] of Object.entries(item.handles)) {
				setOwn(inputs, name, Object.freeze({ kind: kindOf(name), value: handle.get() }));
			}
			for (const [name, asset] of Object.entries(item.assets)) {
				setOwn(inputs, name, Object.freeze({ kind: kindOf(name), asset }));
			}
			return Object.freeze({
				binding_uuid: item.binding.uuid,
				renderer_uuid: item.definition.uuid,
				executor: item.definition.executor,
				output: item.implementation.project(Object.freeze(inputs)),
			});
		}));
	}
}

// #endregion

// #region Load

/**
 * Reads the Renderer Registry, Renderer Bindings and Table Registry once from `project.sqlite`
 * (Renderer Binding in `37. Core Flow`) and builds the {@link RendererRuntime} on a loaded Runtime State.
 * The Asset Registry is supplied by the caller (Assets are scanned from `<Project>/assets/`).
 */
export async function loadRendererRuntime(
	database: Pick<IProjectSqliteDatabase, 'transaction'>,
	state: IRuntimeState,
	assets: readonly IAsset[],
	catalog: IRendererExecutorCatalog,
): Promise<RendererRuntime> {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	const sources = await database.transaction(async statements => ({
		renderers: await readRendererRegistry(statements),
		bindings: await readRendererBindings(statements),
		tables: await readTableRegistry(statements),
	}));
	return RendererRuntime.build(state, { ...sources, assets, catalog });
}

// #endregion
