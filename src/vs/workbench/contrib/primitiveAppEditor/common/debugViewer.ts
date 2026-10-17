/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Debug Viewer and runtime inspection (editor.debug-viewer)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Debug Viewer)
 *  Boundary: App Editer.md (24. Runtime State); Editor UI.md (3, 14, 15)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { DataEditorSelection, DataEditorTabs, DataEditorTarget, IDataEditorTab } from './dataEditor.js';
import { EnumRegistryIndex } from './enumRegistry.js';
import { validateEditorValue } from './editorControls.js';
import { IFunctionBindingAddress } from './functionBinding.js';
import { getRegistryDisplayText, normalizeRegistryUuid } from './registryIdentity.js';
import { IRendererProjection, RendererRuntime } from './rendererRuntime.js';
import { IRuntimeFrameInput, IRuntimeFrameResult, RuntimeLoop } from './runtimeLoop.js';
import { IRuntimeState, resolveRuntimeHandle } from './runtimeState.js';
import { ITableRegistryEntry, TableColumnKind } from './tableRegistry.js';

/**
 * ```text
 * Runtime Memory -> Debug Viewer -> Human Inspection
 *
 * Debug Viewer
 * ├─ Application Canvas       (Renderer Projection of the Next State)
 * ├─ Runtime State Projection (read-only view of `runtime:`)
 * ├─ Entity Selection         (Shared Selection Context -> Registry Driven Inspector)
 * ├─ Direct Manipulation      (Memory Handle write, never SQLite)
 * ├─ Camera                   (view transform of the canvas)
 * └─ Preview                  (Runtime Loop stepping)
 * ```
 *
 * The Debug Viewer is an Editor Area Surface, never the Authority of Authoring Data
 * (`Debug Viewer -> selection / input / preview`; `Registry / Raw Data / Binding = Authority`).
 * It holds a Runtime State and Memory Handles only: it has no database reference, so a Direct
 * Manipulation or a Preview frame cannot become a SQLite write, and Frame State is not Persistent
 * Data. Selecting an Entity updates the Shared Selection Context by Row UUID identity; Display Labels
 * (Table / Column name, label) are derived from the Registry and are never read back as identity.
 */

export class DebugViewerError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor debug viewer: ${message}`);
		this.name = 'DebugViewerError';
	}
}

// #region Editor Area placement

/** The Debug Viewer is one Editor Area Target per project; this fixed Identity keys its tab. */
export const debugViewerTabUuid = '00000000-0000-0000-0000-000000000001';

/** Open (or reuse) the Debug Viewer tab in the Editor Area: opening it again never adds a duplicate. */
export function openDebugViewerTab(tabs: DataEditorTabs): { readonly tab: IDataEditorTab; readonly reused: boolean } {
	return tabs.open(DataEditorTarget.DebugViewer, debugViewerTabUuid);
}

// #endregion

// #region Camera

export interface ICameraPoint {
	readonly x: number;
	readonly y: number;
}

export interface ICameraState {
	/** World point shown at the viewport centre. */
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
}

export interface ICameraViewport {
	readonly width: number;
	readonly height: number;
}

const minZoom = 1 / 64;
const maxZoom = 64;

function finite(value: unknown, where: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new DebugViewerError(`${where} must be a finite number`);
	}
	return value;
}

/** View transform of the Application Canvas. Transient: it is not part of Runtime State or Authoring Data. */
export class DebugCamera {

	private current: ICameraState = Object.freeze({ x: 0, y: 0, zoom: 1 });

	get state(): ICameraState {
		return this.current;
	}

	pan(dx: number, dy: number): ICameraState {
		this.current = Object.freeze({ ...this.current, x: this.current.x + finite(dx, 'pan dx') / this.current.zoom, y: this.current.y + finite(dy, 'pan dy') / this.current.zoom });
		return this.current;
	}

	/** Multiplies the zoom by `factor`, clamped to the supported range. */
	zoomBy(factor: number): ICameraState {
		if (finite(factor, 'zoom factor') <= 0) {
			throw new DebugViewerError('zoom factor must be positive');
		}
		this.current = Object.freeze({ ...this.current, zoom: Math.min(maxZoom, Math.max(minZoom, this.current.zoom * factor)) });
		return this.current;
	}

	focus(point: ICameraPoint): ICameraState {
		this.current = Object.freeze({ ...this.current, x: finite(point.x, 'focus x'), y: finite(point.y, 'focus y') });
		return this.current;
	}

	reset(): ICameraState {
		this.current = Object.freeze({ x: 0, y: 0, zoom: 1 });
		return this.current;
	}

	worldToScreen(point: ICameraPoint, viewport: ICameraViewport): ICameraPoint {
		return Object.freeze({
			x: (point.x - this.current.x) * this.current.zoom + viewport.width / 2,
			y: (point.y - this.current.y) * this.current.zoom + viewport.height / 2,
		});
	}

	screenToWorld(point: ICameraPoint, viewport: ICameraViewport): ICameraPoint {
		return Object.freeze({
			x: (point.x - viewport.width / 2) / this.current.zoom + this.current.x,
			y: (point.y - viewport.height / 2) / this.current.zoom + this.current.y,
		});
	}
}

// #endregion

// #region Runtime State Projection

export interface IRuntimeStatePropertyView {
	readonly column_uuid: string;
	/** Column label / name (Display). */
	readonly label: string;
	readonly kind: TableColumnKind;
	readonly writable: boolean;
	readonly value: unknown;
}

export interface IRuntimeStateEntityView {
	/** Identity of the Entity. */
	readonly row_uuid: string;
	readonly table_uuid: string;
	/** Table label / name (Display). */
	readonly table: string;
	/** Primary Display: the first non-empty text property, else the table label. */
	readonly label: string;
	readonly properties: readonly IRuntimeStatePropertyView[];
}

/** Read-only snapshot of the `runtime:` structure for human inspection. */
export interface IRuntimeStateView {
	readonly time: number;
	readonly progress: number;
	readonly input: Readonly<Record<string, unknown>>;
	readonly entities: readonly IRuntimeStateEntityView[];
	readonly functions: readonly { readonly binding_uuid: string; readonly output: unknown }[];
	readonly events: readonly unknown[];
}

/** Runtime Memory -> Human Inspection. Pure read: neither the state nor the Registry is changed. */
export function projectRuntimeState(state: IRuntimeState, tables: readonly ITableRegistryEntry[]): IRuntimeStateView {
	const entities: IRuntimeStateEntityView[] = [];
	for (const [rowUuid, entity] of state.entities) {
		const table = tables.find(candidate => candidate.uuid === entity.table_uuid);
		if (!table) {
			throw new DebugViewerError(`table_registry has no table '${entity.table_uuid}' for entity '${rowUuid}' (Missing Definition)`);
		}
		const columns = [...table.columns].sort((a, b) => a.index - b.index);
		const properties = columns.map((column): IRuntimeStatePropertyView => Object.freeze({
			column_uuid: column.uuid,
			label: getRegistryDisplayText(column),
			kind: column.kind,
			writable: column.writable,
			value: entity.properties.get(column.uuid),
		}));
		const text = properties.find(property => property.kind === TableColumnKind.Text && typeof property.value === 'string' && property.value !== '');
		entities.push(Object.freeze({
			row_uuid: rowUuid,
			table_uuid: table.uuid,
			table: getRegistryDisplayText(table),
			label: text ? String(text.value) : getRegistryDisplayText(table),
			properties: Object.freeze(properties),
		}));
	}
	return Object.freeze({
		time: state.time,
		progress: state.progress,
		input: Object.freeze({ ...state.input }),
		entities: Object.freeze(entities),
		functions: Object.freeze([...state.functions].map(([binding_uuid, fn]) => Object.freeze({ binding_uuid, output: fn.output }))),
		events: Object.freeze([...state.events]),
	});
}

// #endregion

// #region Debug Viewer

export interface IDebugViewerSources {
	readonly state: IRuntimeState;
	readonly tables: readonly ITableRegistryEntry[];
	readonly enums: EnumRegistryIndex;
	/** Present when the Preview may step the Runtime Loop. */
	readonly loop?: RuntimeLoop;
	/** Present when the Application Canvas has Renderer Bindings to project. */
	readonly rendering?: RendererRuntime;
}

/** One Renderer Projection on the Application Canvas, with the Entities its Memory Handles read. */
export interface IDebugCanvasItem extends IRendererProjection {
	readonly entities: readonly string[];
}

export interface IDebugCanvas {
	readonly camera: ICameraState;
	readonly items: readonly IDebugCanvasItem[];
}

/** Debug Viewer over a Runtime State (Editor Area Surface). */
export class DebugViewer {

	readonly camera = new DebugCamera();

	constructor(
		private readonly sources: IDebugViewerSources,
		private readonly selection: DataEditorSelection,
	) { }

	// Application Canvas

	/** Renderer Projection of the current (Next) State; read-only. */
	canvas(): IDebugCanvas {
		assertBoundaryFlow(BoundaryNode.Runtime, BoundaryNode.Memory);
		const rendering = this.sources.rendering;
		const items = rendering ? rendering.project().map((projection, index): IDebugCanvasItem => Object.freeze({
			...projection,
			entities: Object.freeze([...new Set(Object.values(rendering.bindings[index].handles).map(handle => handle.address.row_uuid))]),
		})) : [];
		return Object.freeze({ camera: this.camera.state, items: Object.freeze(items) });
	}

	// Runtime State Projection

	runtimeState(): IRuntimeStateView {
		return projectRuntimeState(this.sources.state, this.sources.tables);
	}

	// Entity Selection

	/** Selects an Entity by Row UUID; the same Shared Selection Context feeds the Registry Driven Inspector. */
	selectEntity(rowUuid: string): void {
		const uuid = normalizeRegistryUuid(rowUuid);
		const entity = this.sources.state.entities.get(uuid);
		if (!entity) {
			throw new DebugViewerError(`runtime state has no entity '${rowUuid}' (Missing Runtime Object)`);
		}
		this.selection.select({ uuid, table_uuid: entity.table_uuid });
	}

	/** Selects the Entity a Canvas item projects (the Row of its first Memory Handle). */
	selectCanvasItem(bindingUuid: string): void {
		const item = this.canvas().items.find(candidate => candidate.binding_uuid === normalizeRegistryUuid(bindingUuid));
		if (!item) {
			throw new DebugViewerError(`canvas has no renderer binding '${bindingUuid}'`);
		}
		if (item.entities.length === 0) {
			throw new DebugViewerError(`renderer binding '${bindingUuid}' reads no entity`);
		}
		this.selectEntity(item.entities[0]);
	}

	/** Clears the Shared Selection Context. */
	clearSelection(): void {
		this.selection.select(undefined);
	}

	// Direct Manipulation

	/**
	 * Writes one entity property in Runtime Memory through its Memory Handle. The column must be writable
	 * and the value valid for its Kind; nothing reaches SQLite (Frame State != Persistent Data), and the
	 * next Preview frame may overwrite the value like any other Runtime State change.
	 */
	manipulate(address: IFunctionBindingAddress, value: unknown): void {
		const handle = resolveRuntimeHandle(this.sources.state, this.sources.tables, address, 'manipulate');
		if (!handle.column.writable) {
			throw new DebugViewerError(`column '${getRegistryDisplayText(handle.column)}' is not writable`);
		}
		const message = validateEditorValue(handle.column, value, this.sources.enums);
		if (message) {
			throw new DebugViewerError(`column '${getRegistryDisplayText(handle.column)}': ${message}`);
		}
		handle.set(value);
	}

	// Preview

	/** Steps the Runtime Loop by one frame (Input Capture -> Function Execute -> Next State). */
	preview(frame: IRuntimeFrameInput): IRuntimeFrameResult {
		if (!this.sources.loop) {
			throw new DebugViewerError('no Runtime Loop to preview');
		}
		return this.sources.loop.step(frame);
	}
}

// #endregion
