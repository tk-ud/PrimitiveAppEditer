/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Registry-driven generic editor controls (editor.registry-ui)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (25. Editor UI, Kind Dispatch)
 *  Editing regulation: docs/primitive-app-editor/Editor UI.md (6. Component Editing Regulation, 16. Explanation / Help)
 *  Boundary: Editor UI.md (1, 2, 4, 15), Resolver.md (11. update, 17. Boundary)
 *--------------------------------------------------------------------------------------------*/

import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import { EnumRegistryIndex, getEnumSelectOptions, getEnumValueLabel, isEnumColumnValue } from './enumRegistry.js';
import { getRegistryDisplayText, isRegistryUuid, normalizeRegistryUuid } from './registryIdentity.js';
import { IRelationRegistryEntry } from './relationRegistry.js';
import { IAppEditorApi, IResolverOperationRequest } from './resolver.js';
import { compareTableRegistryOrder, isTableColumnValue, ITableRegistryColumn, ITableRegistryEntry, TableColumnKind } from './tableRegistry.js';

/**
 * Registry-driven generic editor controls.
 *
 * ```text
 * table_registry.columns -> Kind Dispatch -> Editor Component (control model)
 *                                         -> Edit Value -> Save -> update(request)
 * ```
 *
 * The control model is derived only from the Registry column (`kind`, `not_null`, `writable`, `enum`)
 * and the Raw Data value; there is no table / entity specific UI model and no Application field. The
 * model carries what a presentation layer needs (control, human label, value, options, explanation,
 * inline message) and holds no persistent state: the Registry is the Definition Authority, Raw Data
 * the value authority, and the Editor UI only selects, presents and requests mutation. Save is one
 * generic `update(request)`, so a value the Registry cannot validate is rejected by the Resolver, not
 * by this UI. UUIDs are resolved to name / label for display and never offered as a Human-facing
 * control.
 */

// #region Kind Dispatch

/** Editor Component a `kind` dispatches to. */
export const enum EditorControlType {
	TextField = 'text_field',
	NumberField = 'number_field',
	Checkbox = 'checkbox',
	DatePicker = 'datepicker',
	DateTimePicker = 'datetime_picker',
	Select = 'select',
	JsonEditor = 'json_editor',
	/** `uuid`: relation / select with the human label resolved. */
	RelationSelect = 'relation/select',
}

const kindDispatch: ReadonlyMap<TableColumnKind, EditorControlType> = new Map([
	[TableColumnKind.Text, EditorControlType.TextField],
	[TableColumnKind.Int, EditorControlType.NumberField],
	[TableColumnKind.Double, EditorControlType.NumberField],
	[TableColumnKind.Bool, EditorControlType.Checkbox],
	[TableColumnKind.Date, EditorControlType.DatePicker],
	[TableColumnKind.Timestamp, EditorControlType.DateTimePicker],
	[TableColumnKind.Enum, EditorControlType.Select],
	[TableColumnKind.Json, EditorControlType.JsonEditor],
	[TableColumnKind.Uuid, EditorControlType.RelationSelect],
]);

export class EditorControlError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor editor controls: ${message}`);
		this.name = 'EditorControlError';
	}
}

/** Kind Dispatch: the Editor Component of a `kind`. */
export function dispatchEditorControl(kind: TableColumnKind): EditorControlType {
	const control = kindDispatch.get(kind);
	if (!control) {
		throw new EditorControlError(`no editor component for kind '${String(kind)}'`);
	}
	return control;
}

// #endregion

// #region Control model

/** A select option: `value` is stored (enum value / row UUID), `label` is shown. */
export interface IEditorControlOption {
	readonly value: string;
	readonly label: string;
}

/** Explanation path of a Field (Editor UI 16): Tooltip, Popover and Inline Message. */
export interface IEditorControlExplanation {
	/** Short Field explanation (Tooltip). */
	readonly tooltip: string;
	/** Detailed explanation: Persistent impact, Setting Semantics, cautions (Popover / Popper). */
	readonly details: readonly string[];
	/** Validation Error / Invalid State, shown next to the control (Inline Message). Absent when valid. */
	readonly message?: string;
}

/** One generic Editor Component, derived from one Registry column. */
export interface IEditorControl {
	readonly columnUuid: string;
	readonly kind: TableColumnKind;
	readonly control: EditorControlType;
	/** Human display text (label, else name). Never the UUID. */
	readonly label: string;
	readonly required: boolean;
	/** `columns[].writable` is false: the component presents the value and offers no Save. */
	readonly readOnly: boolean;
	/** Stored value (`null` = absent). */
	readonly value: unknown;
	/** Human-facing text of the value: the option label for `enum` / `uuid`, else undefined (the presentation formats the value). */
	readonly displayValue?: string;
	/** `number_field`: integers only. */
	readonly integer?: boolean;
	/** `select` / `relation/select` options. */
	readonly options?: readonly IEditorControlOption[];
	readonly explanation: IEditorControlExplanation;
}

/** Resolves a `uuid` column to the rows it can select (`relation/select`). */
export interface IEditorRelationSource {
	/** Row options of the table a `uuid` column relates to, with labels already resolved. Absent: the column has no relation. */
	options(column: ITableRegistryColumn): Promise<readonly IEditorControlOption[] | undefined>;
}

function describeKind(column: ITableRegistryColumn): string {
	return column.kind === TableColumnKind.Enum ? 'enum (select)' : column.kind;
}

function explain(column: ITableRegistryColumn, label: string, message: string | undefined): IEditorControlExplanation {
	const flags = [column.not_null ? 'required' : undefined, column.writable ? undefined : 'read-only'].filter(Boolean).join(', ');
	return Object.freeze({
		tooltip: `${label}: ${describeKind(column)}${flags ? ` (${flags})` : ''}`,
		details: Object.freeze([
			`Kind '${column.kind}' is defined by the Registry; this control is derived from it.`,
			column.writable
				? 'Save updates the Raw Data value only; the Registry Definition is not changed.'
				: 'This column is not writable in the Registry; the value cannot be changed here.',
			column.not_null ? 'The value is required and cannot be cleared.' : 'The value may be cleared (absent).',
		]),
		...(message === undefined ? {} : { message }),
	});
}

/**
 * Edit Value validation, the same check the Resolver runs on Save (Kind Validate): the Semantic Type
 * of `kind` and, for `enum`, membership in the referenced `enum_registry` entry. Returns the Inline
 * Message, or `undefined` when valid.
 */
export function validateEditorValue(column: ITableRegistryColumn, value: unknown, enums: EnumRegistryIndex): string | undefined {
	const normalized = column.kind === TableColumnKind.Uuid && typeof value === 'string' && isRegistryUuid(value) ? normalizeRegistryUuid(value) : value;
	const valid = column.kind === TableColumnKind.Enum
		? isEnumColumnValue(enums, column, normalized)
		: isTableColumnValue(column, normalized);
	if (valid) {
		return undefined;
	}
	if ((value === null || value === undefined) && column.not_null) {
		return 'A value is required.';
	}
	return `Not a valid ${column.kind} value.`;
}

/** Kind Dispatch of one column against its current Raw Data value. */
export async function createEditorControl(column: ITableRegistryColumn, value: unknown, enums: EnumRegistryIndex, relations?: IEditorRelationSource): Promise<IEditorControl> {
	const control = dispatchEditorControl(column.kind);
	const label = getRegistryDisplayText(column);
	const stored = value === undefined ? null : value;
	const message = stored === null && !column.not_null ? undefined : validateEditorValue(column, stored, enums);

	let options: readonly IEditorControlOption[] | undefined;
	let displayValue: string | undefined;
	if (column.kind === TableColumnKind.Enum) {
		const entry = enums.resolveColumn(column);
		options = getEnumSelectOptions(entry);
		displayValue = typeof stored === 'string' ? getEnumValueLabel(entry, stored) : undefined;
	} else if (column.kind === TableColumnKind.Uuid) {
		options = await relations?.options(column);
		displayValue = typeof stored === 'string' ? options?.find(option => option.value === normalizeRegistryUuid(stored))?.label : undefined;
	}

	return Object.freeze({
		columnUuid: column.uuid,
		kind: column.kind,
		control,
		label,
		required: column.not_null,
		readOnly: !column.writable,
		value: stored,
		...(displayValue === undefined ? {} : { displayValue }),
		...(control === EditorControlType.NumberField ? { integer: column.kind === TableColumnKind.Int } : {}),
		...(options === undefined ? {} : { options }),
		explanation: explain(column, label, message),
	});
}

/**
 * Editor Components of one Raw Data row, in Registry column order. The Registry is the only source of
 * which components exist; with no selected row (`values` undefined) there is no Mutation Target and no
 * component (Empty Selection).
 */
export async function createEditorControls(
	table: Pick<ITableRegistryEntry, 'columns'>,
	values: Readonly<Record<string, unknown>> | undefined,
	enums: EnumRegistryIndex,
	relations?: IEditorRelationSource,
): Promise<readonly IEditorControl[]> {
	if (values === undefined) {
		return Object.freeze([]);
	}
	const columns = [...table.columns].sort(compareTableRegistryOrder);
	return Object.freeze(await Promise.all(columns.map(column => createEditorControl(column, values[column.uuid], enums, relations))));
}

// #endregion

// #region relation / select

/**
 * The table a `uuid` column selects from, derived from `relation_registry`: the other side of a join
 * that references the column. Absent when the Registry defines no relation for it (never guessed).
 */
export function resolveRelationTargetTable(column: Pick<ITableRegistryColumn, 'uuid'>, mainTable: Pick<ITableRegistryEntry, 'uuid'>, relations: readonly IRelationRegistryEntry[]): string | undefined {
	const targets = new Set<string>();
	for (const relation of relations) {
		for (const join of relation.relations) {
			if (relation.main_table === mainTable.uuid && join.main_column.column_uuid === column.uuid) {
				targets.add(join.join_table);
			} else if (join.join_table === mainTable.uuid && join.join_column.column_uuid === column.uuid) {
				targets.add(relation.main_table);
			}
		}
	}
	return targets.size === 1 ? [...targets][0] : undefined;
}

/**
 * Human label of a related Raw Data row: its first non-empty `text` column in Registry order, else the
 * table display text with the row position. The UUID is never the label.
 */
export function resolveRowLabel(table: Pick<ITableRegistryEntry, 'name' | 'label' | 'columns'>, values: Readonly<Record<string, unknown>>, position: number): string {
	for (const column of [...table.columns].sort(compareTableRegistryOrder)) {
		const value = values[column.uuid];
		if (column.kind === TableColumnKind.Text && typeof value === 'string' && value !== '') {
			return value;
		}
	}
	return `${getRegistryDisplayText(table)} #${position + 1}`;
}

/** {@link IEditorRelationSource} over the registry and the generic `select` primitive. */
export function createRelationSource(api: Pick<IAppEditorApi, 'select'>, mainTable: Pick<ITableRegistryEntry, 'uuid'>, tables: readonly ITableRegistryEntry[], relations: readonly IRelationRegistryEntry[]): IEditorRelationSource {
	return {
		async options(column) {
			const targetUuid = resolveRelationTargetTable(column, mainTable, relations);
			const target = targetUuid === undefined ? undefined : tables.find(table => table.uuid === targetUuid);
			if (!target) {
				return undefined;
			}
			const selected = await api.select({ target: { kind: 'raw', uuid: target.uuid }, payload: {} });
			const rows = selected.result as readonly { readonly uuid: string; readonly values: Readonly<Record<string, unknown>> }[];
			return Object.freeze(rows.map((row, position) => Object.freeze({ value: row.uuid, label: resolveRowLabel(target, row.values, position) })));
		},
	};
}

// #endregion

// #region Save -> update

/** Component Save: the one generic `update(request)` for one column of one Raw Data row. */
export function createEditorUpdateRequest(address: { readonly tableUuid: string; readonly rowUuid: string }, column: Pick<ITableRegistryColumn, 'uuid'>, value: unknown): IResolverOperationRequest {
	return {
		target: { kind: 'raw', uuid: address.tableUuid },
		address: { table_uuid: address.tableUuid, row_uuid: address.rowUuid, column_uuid: column.uuid },
		payload: { [column.uuid]: value === undefined ? null : value },
	};
}

/**
 * Save an edited value: reject a non-writable column or an invalid value before dispatch (Inline
 * Message in the thrown error), then request `update`. The Registry Definition is never altered and
 * the component keeps no value of its own: the caller re-reads Raw Data after Save.
 */
export async function saveEditorValue(
	api: Pick<IAppEditorApi, 'update'>,
	address: { readonly tableUuid: string; readonly rowUuid: string },
	column: ITableRegistryColumn,
	value: unknown,
	enums: EnumRegistryIndex,
): Promise<unknown> {
	assertBoundaryFlow(BoundaryNode.Registry, BoundaryNode.PhysicalSchema);
	if (!column.writable) {
		throw new EditorControlError(`column '${getRegistryDisplayText(column)}' is not writable`);
	}
	const message = validateEditorValue(column, value, enums);
	if (message !== undefined) {
		throw new EditorControlError(`column '${getRegistryDisplayText(column)}': ${message}`);
	}
	return (await api.update(createEditorUpdateRequest(address, column, value))).result;
}

// #endregion
