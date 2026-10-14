/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - enum_registry (registry.enum)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (11. enum_registry, 11. Physical, 11. Usage)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { assertBoundaryFlow, BoundaryNode } from './authority.js';
import {
	assertProjectSqliteAccess,
	corePhysicalTableNameResolver,
	IProjectSqliteStatements,
	ProjectSqliteAccessor,
	ProjectSqliteRow,
	quoteIdentifier,
	REGISTRY_SCHEMA,
} from './projectSqlite.js';
import { ensureRegistryIdentity, getRegistryDisplayText, IRegistryIdentity, normalizeRegistryUuid, RegistryIdentityError } from './registryIdentity.js';
import {
	compareTableRegistryOrder,
	isTableColumnValue,
	isTimestampValue,
	ITableRegistryColumn,
	ITableRegistryEntry,
	TableColumnKind,
} from './tableRegistry.js';

/**
 * `enum_registry` = the Registry entry of one enumeration: its Machine Identity / human naming,
 * its ordered `values` (`value` = stored text, `label` = display) and its `group_tags`.
 *
 * Physical: a column of Registry `kind: enum` stores its value as plain `text`
 * (`Enum -> Text With Metadata`); the column carries `columns[].enum = enum_registry.uuid` as
 * Registry metadata only. No physical foreign key is generated (`Enum -X-> Physical FK`).
 *
 * Usage: Editor Select ({@link getEnumSelectOptions}), Display Label ({@link getEnumValueLabel}),
 * Input Validation ({@link isEnumColumnValue}) and Registry Metadata ({@link EnumRegistryIndex},
 * {@link validateTableEnumReferences}).
 *
 * Mutation: `enum_registry` INSERT / UPDATE / DELETE is executed by the App Editor Registry Service
 * (`RegistryService.createEnum / alterEnum / dropEnum`), which validates table_registry references
 * and existing Raw Data in the same transaction. The statements below are its storage primitives.
 */

// #region Physical

export interface IEnumPhysicalProjection {
	readonly kind: TableColumnKind.Enum;
	/** `Physical Value = text`. */
	readonly physicalValue: 'text';
	/** `Physical FK = none`. */
	readonly physicalForeignKey: false;
}

export const enumPhysicalProjection: IEnumPhysicalProjection = Object.freeze({
	kind: TableColumnKind.Enum,
	physicalValue: 'text',
	physicalForeignKey: false,
});

// #endregion

// #region enum_registry

/** One `enum_registry.values` element. */
export interface IEnumRegistryValue {
	readonly value: string;
	readonly label?: string;
}

/** One `enum_registry` entry. */
export interface IEnumRegistryEntry extends IRegistryIdentity {
	readonly index: number;
	readonly values: readonly IEnumRegistryValue[];
	readonly group_tags: readonly string[];
	/** `timestamp`, stored as an ISO 8601 UTC string. */
	readonly created_at: string;
}

/** An INSERT / Seed input: the UUID is generated and `created_at` stamped when missing. */
export interface IEnumRegistryEntryInput {
	readonly uuid?: string;
	readonly index: number;
	readonly name: string;
	readonly label?: string;
	readonly values: readonly IEnumRegistryValue[];
	readonly group_tags?: readonly string[];
	readonly created_at?: string;
}

export class EnumRegistryError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor enum_registry: ${message}`);
		this.name = 'EnumRegistryError';
	}
}

function withLabel<T extends object>(base: T, label: string | undefined): T & { label?: string } {
	return label === undefined || label === '' ? base : { ...base, label };
}

function createValue(input: IEnumRegistryValue, where: string): IEnumRegistryValue {
	if (typeof input !== 'object' || input === null || typeof input.value !== 'string' || input.value === '') {
		throw new EnumRegistryError(`${where}: every value must have a non-empty text value`);
	}
	if (input.label !== undefined && typeof input.label !== 'string') {
		throw new EnumRegistryError(`${where}: label of value '${input.value}' must be text`);
	}
	return Object.freeze(withLabel({ value: input.value }, input.label));
}

/**
 * Builds a validated `enum_registry` entry: a missing UUID is generated and a supplied one kept
 * (7. Generate), `index` is an int, `values` are text with optional label and unique by `value`
 * (Input Validation and Editor Select need one meaning per stored text), `group_tags` is a list of
 * text and `created_at` a timestamp. Name uniqueness is not part of this contract.
 */
export function createEnumRegistryEntry(
	input: IEnumRegistryEntryInput,
	generateUuid: () => string = generateRandomUuid,
	now: () => Date = () => new Date(),
): IEnumRegistryEntry {
	let identity: IRegistryIdentity;
	try {
		identity = ensureRegistryIdentity(input, generateUuid);
	} catch (error) {
		throw error instanceof RegistryIdentityError ? new EnumRegistryError(error.message) : error;
	}
	const where = `enum '${identity.name}'`;
	if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) {
		throw new EnumRegistryError(`${where}: index must be an int`);
	}
	if (!Array.isArray(input.values)) {
		throw new EnumRegistryError(`${where}: values must be a list`);
	}
	const seen = new Set<string>();
	const values = input.values.map(valueInput => {
		const value = createValue(valueInput, where);
		if (seen.has(value.value)) {
			throw new EnumRegistryError(`${where}: duplicate value '${value.value}'`);
		}
		seen.add(value.value);
		return value;
	});
	const groupTags = input.group_tags ?? [];
	if (!Array.isArray(groupTags) || !groupTags.every(tag => typeof tag === 'string')) {
		throw new EnumRegistryError(`${where}: group_tags must be a list of text`);
	}
	const createdAt = input.created_at ?? now().toISOString();
	if (!isTimestampValue(createdAt)) {
		throw new EnumRegistryError(`${where}: created_at must be a timestamp`);
	}
	return Object.freeze(withLabel({
		uuid: identity.uuid,
		index: input.index,
		name: identity.name,
		values: Object.freeze(values),
		group_tags: Object.freeze([...groupTags]),
		created_at: new Date(createdAt).toISOString(),
	}, identity.label));
}

/** Validates a set of entries of one `enum_registry`: enum UUIDs are unique. */
export function validateEnumRegistry(entries: readonly IEnumRegistryEntry[]): void {
	const uuids = new Set<string>();
	for (const entry of entries) {
		const uuid = normalizeRegistryUuid(entry.uuid);
		if (uuids.has(uuid)) {
			throw new EnumRegistryError(`duplicate enum uuid for '${entry.name}'`);
		}
		uuids.add(uuid);
	}
}

// #endregion

// #region Usage

/** Editor Select option: `value` is stored, `label` is shown. */
export interface IEnumSelectOption {
	readonly value: string;
	readonly label: string;
}

/** Editor Select: the options of `entry` in Registry value order. */
export function getEnumSelectOptions(entry: IEnumRegistryEntry): readonly IEnumSelectOption[] {
	return Object.freeze(entry.values.map(value => Object.freeze({ value: value.value, label: value.label ?? value.value })));
}

/** Display Label: the label of a stored value (the value itself when it has no label); `undefined` when not a value of `entry`. */
export function getEnumValueLabel(entry: IEnumRegistryEntry, value: string): string | undefined {
	const found = entry.values.find(candidate => candidate.value === value);
	return found ? found.label ?? found.value : undefined;
}

/** Whether `value` is one of the values of `entry`. */
export function isEnumValue(entry: Pick<IEnumRegistryEntry, 'values'>, value: unknown): value is string {
	return typeof value === 'string' && entry.values.some(candidate => candidate.value === value);
}

/**
 * Registry Metadata: `enum_registry` entries by Machine Identity, used to resolve
 * `columns[].enum` of a `kind: enum` column.
 */
export class EnumRegistryIndex {

	private readonly byUuid = new Map<string, IEnumRegistryEntry>();

	constructor(entries: readonly IEnumRegistryEntry[]) {
		validateEnumRegistry(entries);
		for (const entry of entries) {
			this.byUuid.set(normalizeRegistryUuid(entry.uuid), entry);
		}
	}

	get(uuid: string): IEnumRegistryEntry | undefined {
		return this.byUuid.get(uuid.toLowerCase());
	}

	/** The entry a `kind: enum` column references; throws when the column is not enum or the entry does not exist. */
	resolveColumn(column: Pick<ITableRegistryColumn, 'name' | 'kind' | 'enum'>): IEnumRegistryEntry {
		if (column.kind !== TableColumnKind.Enum || column.enum === null) {
			throw new EnumRegistryError(`column '${column.name}' is not of kind 'enum'`);
		}
		const entry = this.get(column.enum);
		if (!entry) {
			throw new EnumRegistryError(`column '${column.name}' references missing enum_registry entry '${column.enum}'`);
		}
		return entry;
	}

	/** Display text of an enum (label, else name, never UUID). */
	display(uuid: string): string | undefined {
		const entry = this.get(uuid);
		return entry ? getRegistryDisplayText(entry) : undefined;
	}
}

/**
 * Input Validation of a value for a `kind: enum` column: the value must satisfy the column's
 * Semantic Type (text; `null` only when not `not_null`) and, when present, be one of the values of
 * the referenced `enum_registry` entry.
 */
export function isEnumColumnValue(index: EnumRegistryIndex, column: Pick<ITableRegistryColumn, 'name' | 'kind' | 'not_null' | 'enum'>, value: unknown): boolean {
	const entry = index.resolveColumn(column);
	if (!isTableColumnValue(column, value)) {
		return false;
	}
	return value === null || value === undefined || isEnumValue(entry, value);
}

/** Registry Metadata validation: every `kind: enum` column of `tables` references an existing `enum_registry` entry. */
export function validateTableEnumReferences(tables: readonly Pick<ITableRegistryEntry, 'name' | 'columns'>[], enums: EnumRegistryIndex | readonly IEnumRegistryEntry[]): void {
	assertBoundaryFlow(BoundaryNode.Enum, BoundaryNode.TextWithMetadata);
	const index = enums instanceof EnumRegistryIndex ? enums : new EnumRegistryIndex(enums);
	for (const table of tables) {
		for (const column of table.columns) {
			if (column.kind === TableColumnKind.Enum) {
				try {
					index.resolveColumn(column);
				} catch (error) {
					throw error instanceof EnumRegistryError ? new EnumRegistryError(`table '${table.name}': ${error.message.replace(/^Primitive App Editor enum_registry: /, '')}`) : error;
				}
			}
		}
	}
}

// #endregion

// #region Storage (project.sqlite)

/** `registry.enum_registry`: the Registry schema table holding `enum_registry` entries. */
export const enumRegistryTable = Object.freeze({ schema: REGISTRY_SCHEMA, table: 'enum_registry' } as const);

export const enumRegistryPhysicalTable = corePhysicalTableNameResolver.resolve(enumRegistryTable.schema, enumRegistryTable.table);

const storedColumns = ['uuid', 'index', 'name', 'label', 'values', 'group_tags', 'created_at'] as const;

/** Stored form: scalars as columns, `values` / `group_tags` as JSON lists, an absent label as `''`. */
export function encodeEnumRegistryRow(entry: IEnumRegistryEntry): ProjectSqliteRow {
	return Object.freeze({
		uuid: entry.uuid,
		index: entry.index,
		name: entry.name,
		label: entry.label ?? '',
		values: JSON.stringify(entry.values.map(value => ({ value: value.value, label: value.label ?? '' }))),
		group_tags: JSON.stringify(entry.group_tags),
		created_at: entry.created_at,
	});
}

function parseList(row: ProjectSqliteRow, field: 'values' | 'group_tags', uuid: string): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(row[field]));
	} catch {
		throw new EnumRegistryError(`stored enum '${uuid}': ${field} is not JSON`);
	}
	if (!Array.isArray(parsed)) {
		throw new EnumRegistryError(`stored enum '${uuid}': ${field} must be a JSON list`);
	}
	return parsed;
}

/** Reads a stored row back into a validated entry. Stored UUIDs are kept, never generated. */
export function decodeEnumRegistryRow(row: ProjectSqliteRow): IEnumRegistryEntry {
	const missingUuid = (): string => { throw new EnumRegistryError('stored entry has no uuid'); };
	const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : missingUuid();
	return createEnumRegistryEntry({
		uuid,
		index: row.index as number,
		name: row.name as string,
		label: typeof row.label === 'string' ? row.label : undefined,
		values: parseList(row, 'values', uuid) as IEnumRegistryValue[],
		group_tags: parseList(row, 'group_tags', uuid) as string[],
		created_at: row.created_at as string,
	}, missingUuid);
}

/** `INSERT` statement and parameters writing `entry` into `registry.enum_registry`. */
export function getEnumRegistryInsert(entry: IEnumRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeEnumRegistryRow(entry);
	return Object.freeze({
		sql: `INSERT INTO ${quoteIdentifier(enumRegistryPhysicalTable)} (${storedColumns.map(quoteIdentifier).join(', ')}) VALUES (${storedColumns.map(() => '?').join(', ')})`,
		params: Object.freeze(storedColumns.map(column => row[column] as string | number)),
	});
}

/** `UPDATE` statement and parameters replacing the stored entry with Machine Identity `entry.uuid`. */
export function getEnumRegistryUpdate(entry: IEnumRegistryEntry): { readonly sql: string; readonly params: readonly (string | number)[] } {
	const row = encodeEnumRegistryRow(entry);
	const assigned = storedColumns.filter(column => column !== 'uuid');
	return Object.freeze({
		sql: `UPDATE ${quoteIdentifier(enumRegistryPhysicalTable)} SET ${assigned.map(column => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE "uuid" = ?`,
		params: Object.freeze([...assigned.map(column => row[column] as string | number), entry.uuid]),
	});
}

/**
 * `DELETE` statement and parameters removing the stored entry with Machine Identity `uuid`. Use
 * `RegistryService.dropEnum`, which rejects the delete while a table_registry column references it.
 */
export function getEnumRegistryDelete(uuid: string): { readonly sql: string; readonly params: readonly string[] } {
	return Object.freeze({
		sql: `DELETE FROM ${quoteIdentifier(enumRegistryPhysicalTable)} WHERE "uuid" = ?`,
		params: Object.freeze([normalizeRegistryUuid(uuid)]),
	});
}

/**
 * Reads every `enum_registry` entry from `project.sqlite` in Registry order (by `index`, then
 * UUID) for `Registry Load`. Each stored row is validated and enum UUIDs must be unique.
 */
export async function readEnumRegistry(database: IProjectSqliteStatements): Promise<readonly IEnumRegistryEntry[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
	const rows = await database.all(`SELECT ${storedColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(enumRegistryPhysicalTable)}`);
	const entries = rows.map(decodeEnumRegistryRow).sort(compareTableRegistryOrder);
	validateEnumRegistry(entries);
	return Object.freeze(entries);
}

// #endregion
