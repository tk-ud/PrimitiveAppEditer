/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - table_registry contract (registry.table)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (8. table_registry, 8. kind, 8. Semantic Type)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import {
	createTableRegistryEntry,
	decodeTableRegistryRow,
	encodeTableRegistryRow,
	getTableColumnSemantic,
	getTableRegistryInsert,
	ITableRegistryColumnInput,
	ITableRegistryEntryInput,
	isTableColumnKind,
	isTableColumnValue,
	TableColumnKind,
	tableColumnKinds,
	TableColumnSemanticType,
	TableRegistryError,
	tableRegistryPhysicalTable,
	validateTableRegistry,
} from '../../common/tableRegistry.js';

const T = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const E = '00000000-0000-4000-8000-0000000000e1';

function sequence(...uuids: string[]): () => string {
	let i = 0;
	return () => uuids[i++];
}

const now = () => new Date('2026-10-07T00:00:00Z');

function column(overrides: Partial<ITableRegistryColumnInput> = {}): ITableRegistryColumnInput {
	return { index: 0, name: 'hp', kind: TableColumnKind.Int, not_null: true, writable: true, searchable: false, ...overrides };
}

function table(overrides: Partial<ITableRegistryEntryInput> = {}): ITableRegistryEntryInput {
	return { index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [column()], ...overrides };
}

suite('Primitive App Editor - table_registry (8. table_registry)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('kind lists the nine specification kinds and maps each to its Semantic Type', () => {
		assert.deepStrictEqual(tableColumnKinds, ['uuid', 'text', 'int', 'double', 'bool', 'date', 'timestamp', 'enum', 'json']);
		assert.deepStrictEqual(tableColumnKinds.map(kind => getTableColumnSemantic(kind).semanticType), [
			TableColumnSemanticType.IdentityOrRelation,
			TableColumnSemanticType.String,
			TableColumnSemanticType.Integer,
			TableColumnSemanticType.FloatingPoint,
			TableColumnSemanticType.Boolean,
			TableColumnSemanticType.DateValue,
			TableColumnSemanticType.TimestampValue,
			TableColumnSemanticType.EnumText,
			TableColumnSemanticType.Structured,
		]);
		assert.deepStrictEqual(tableColumnKinds.filter(kind => getTableColumnSemantic(kind).enumMetadata), ['enum']);
		assert.ok(!isTableColumnKind('integer'));
		assert.ok(!isTableColumnKind('Text'));
	});

	test('Semantic Type value check per kind; null only for a nullable column', () => {
		const accepts = (kind: TableColumnKind, value: unknown) => isTableColumnValue({ kind, not_null: true }, value);
		assert.ok(accepts(TableColumnKind.Uuid, T) && !accepts(TableColumnKind.Uuid, 'player'));
		assert.ok(accepts(TableColumnKind.Text, '') && !accepts(TableColumnKind.Text, 1));
		assert.ok(accepts(TableColumnKind.Int, -3) && !accepts(TableColumnKind.Int, 1.5) && !accepts(TableColumnKind.Int, 2 ** 53));
		assert.ok(accepts(TableColumnKind.Double, 1.5) && accepts(TableColumnKind.Double, 2) && !accepts(TableColumnKind.Double, Number.NaN) && !accepts(TableColumnKind.Double, '1.5'));
		assert.ok(accepts(TableColumnKind.Bool, false) && !accepts(TableColumnKind.Bool, 0));
		assert.ok(accepts(TableColumnKind.Date, '2024-02-29') && !accepts(TableColumnKind.Date, '2023-02-29') && !accepts(TableColumnKind.Date, '2024-02-29T00:00:00Z'));
		assert.ok(accepts(TableColumnKind.Timestamp, '2026-10-07T12:34:56.789Z') && accepts(TableColumnKind.Timestamp, '2026-10-07T12:34+09:00'));
		assert.ok(!accepts(TableColumnKind.Timestamp, '2026-10-07T12:34:56') && !accepts(TableColumnKind.Timestamp, '2026-10-07'));
		assert.ok(accepts(TableColumnKind.Enum, 'fire') && !accepts(TableColumnKind.Enum, 1));
		assert.ok(accepts(TableColumnKind.Json, { a: [1, 'x', null, { b: true }] }) && accepts(TableColumnKind.Json, 3));
		assert.ok(!accepts(TableColumnKind.Json, { a: undefined }) && !accepts(TableColumnKind.Json, new Date()) && !accepts(TableColumnKind.Json, Number.POSITIVE_INFINITY));
		for (const kind of tableColumnKinds) {
			assert.ok(!isTableColumnValue({ kind, not_null: true }, null), kind);
			assert.ok(isTableColumnValue({ kind, not_null: false }, null), kind);
		}
	});

	test('INSERT generates missing table / column UUIDs, keeps supplied ones and stamps created_at', () => {
		const entry = createTableRegistryEntry(table({ label: 'Player', columns: [column({ uuid: C1.toUpperCase() }), column({ index: 1, name: 'element', kind: TableColumnKind.Enum, enum: E, not_null: false })] }), sequence(T, C2), now);
		assert.deepStrictEqual(entry, {
			uuid: T,
			index: 0,
			schema: 'items',
			name: 'player',
			label: 'Player',
			columns: [
				{ uuid: C1, index: 0, name: 'hp', kind: 'int', not_null: true, writable: true, searchable: false, enum: null },
				{ uuid: C2, index: 1, name: 'element', kind: 'enum', not_null: false, writable: true, searchable: false, enum: E },
			],
			created_at: '2026-10-07T00:00:00.000Z',
		});
		assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.columns) && Object.isFrozen(entry.columns[0]));
		assert.strictEqual(createTableRegistryEntry(table({ uuid: T, schema: 'logs', created_at: '2026-10-07T09:00:00+09:00' }), sequence(C1), now).created_at, '2026-10-07T00:00:00.000Z');
	});

	test('validation rejects an invalid schema / kind / enum reference / flag / index and duplicate column uuids', () => {
		const create = (input: ITableRegistryEntryInput) => createTableRegistryEntry(input, sequence(T, C1, C2), now);
		assert.throws(() => create(table({ schema: 'raw' })), /schema must be items \| logs/);
		assert.throws(() => create(table({ name: '' })), TableRegistryError);
		assert.throws(() => create(table({ uuid: 'player' })), /not a UUID/);
		assert.throws(() => create(table({ index: 1.5 })), /index must be an int/);
		assert.throws(() => create(table({ created_at: 'yesterday' })), /created_at must be a timestamp/);
		assert.throws(() => create(table({ columns: [column({ kind: 'string' })] })), /unknown kind 'string'/);
		assert.throws(() => create(table({ columns: [column({ kind: TableColumnKind.Enum })] })), /requires an enum_registry\.uuid/);
		assert.throws(() => create(table({ columns: [column({ kind: TableColumnKind.Enum, enum: 'element' })] })), /not an enum_registry\.uuid/);
		assert.throws(() => create(table({ columns: [column({ enum: E })] })), /only set for kind 'enum'/);
		assert.throws(() => create(table({ columns: [column({ not_null: 1 as unknown as boolean })] })), /not_null must be a bool/);
		assert.throws(() => create(table({ columns: [column({ index: Number.NaN })] })), /index must be an int/);
		assert.throws(() => create(table({ columns: [column({ uuid: C1 }), column({ uuid: C1, name: 'mp' })] })), /duplicate column uuid/);
		// Name uniqueness is not part of the contract (7. UUID Identity).
		assert.strictEqual(create(table({ columns: [column({ uuid: C1 }), column({ uuid: C2 })] })).columns.length, 2);
		assert.strictEqual(create(table({ columns: [] })).columns.length, 0);
	});

	test('table uuids are unique within table_registry', () => {
		const a = createTableRegistryEntry(table({ uuid: T }), sequence(C1), now);
		const b = createTableRegistryEntry(table({ uuid: T, name: 'enemy' }), sequence(C2), now);
		assert.throws(() => validateTableRegistry([a, b]), /duplicate table uuid for 'enemy'/);
		validateTableRegistry([a]);
	});

	test('stored form keeps columns as one JSON value and round-trips without regenerating UUIDs', () => {
		const entry = createTableRegistryEntry(table({ columns: [column(), column({ index: 1, name: 'meta', kind: TableColumnKind.Json, label: 'Meta', not_null: false, searchable: true })] }), sequence(T, C1, C2), now);
		const row = encodeTableRegistryRow(entry);
		assert.deepStrictEqual(Object.keys(row), ['uuid', 'index', 'schema', 'name', 'label', 'columns', 'created_at']);
		assert.strictEqual(row.label, '');
		assert.deepStrictEqual(JSON.parse(String(row.columns))[1], { uuid: C2, index: 1, name: 'meta', label: 'Meta', kind: 'json', not_null: false, writable: true, searchable: true, enum: null });
		assert.deepStrictEqual(decodeTableRegistryRow(row), entry);

		const insert = getTableRegistryInsert(entry);
		assert.strictEqual(tableRegistryPhysicalTable, 'registry__table_registry');
		assert.strictEqual(insert.sql, 'INSERT INTO "registry__table_registry" ("uuid", "index", "schema", "name", "label", "columns", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?)');
		assert.deepStrictEqual(insert.params, [T, 0, 'items', 'player', '', row.columns, '2026-10-07T00:00:00.000Z']);
	});

	test('a stored row is validated against the contract and never gets a generated UUID', () => {
		const row = encodeTableRegistryRow(createTableRegistryEntry(table(), sequence(T, C1), now));
		assert.throws(() => decodeTableRegistryRow({ ...row, columns: '{' }), /columns is not JSON/);
		assert.throws(() => decodeTableRegistryRow({ ...row, columns: '{}' }), /JSON list of column objects/);
		assert.throws(() => decodeTableRegistryRow({ ...row, columns: JSON.stringify([{ index: 0, name: 'hp', kind: 'int', not_null: true, writable: true, searchable: false }]) }), /stored column has no uuid/);
		assert.throws(() => decodeTableRegistryRow({ ...row, uuid: null }), /stored entry has no uuid/);
		assert.throws(() => decodeTableRegistryRow({ ...row, schema: 'raw' }), /schema must be items \| logs/);
		assert.throws(() => decodeTableRegistryRow({ ...row, index: '0' }), /index must be an int/);
	});
});
