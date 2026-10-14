/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - enum_registry (registry.enum)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (11. enum_registry, 11. Physical, 11. Usage)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BoundaryNode, BoundaryVerdict, checkBoundaryFlow } from '../../common/authority.js';
import {
	createEnumRegistryEntry,
	decodeEnumRegistryRow,
	encodeEnumRegistryRow,
	EnumRegistryError,
	EnumRegistryIndex,
	enumPhysicalProjection,
	enumRegistryPhysicalTable,
	getEnumRegistryDelete,
	getEnumRegistryInsert,
	getEnumRegistryUpdate,
	getEnumSelectOptions,
	getEnumValueLabel,
	IEnumRegistryEntryInput,
	isEnumColumnValue,
	isEnumValue,
	validateEnumRegistry,
	validateTableEnumReferences,
} from '../../common/enumRegistry.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { generateRegistryColumnDefinition, getRegistryPhysicalColumnType } from '../../common/registryPhysicalExpansion.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';

const E = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';

const now = () => new Date('2026-10-14T00:00:00Z');

function element(overrides: Partial<IEnumRegistryEntryInput> = {}): IEnumRegistryEntryInput {
	return {
		uuid: E, index: 0, name: 'element', label: 'Element', values: [
			{ value: 'fire', label: 'Fire' },
			{ value: 'water', label: 'Water' },
			{ value: 'none' },
		], group_tags: ['battle'], ...overrides,
	};
}

function enemy(enumUuid: string) {
	return createTableRegistryEntry({
		index: 0, schema: LogicalNamespace.Items, name: 'enemy', columns: [
			{ index: 0, name: 'element', kind: TableColumnKind.Enum, enum: enumUuid, not_null: true, writable: true, searchable: true },
			{ index: 1, name: 'hp', kind: TableColumnKind.Int, not_null: true, writable: true, searchable: false },
		],
	});
}

suite('Primitive App Editor - enum_registry (11. enum_registry)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('entry: generate vs keep uuid, ordered values, group_tags, created_at', () => {
		const kept = createEnumRegistryEntry(element(), () => assert.fail('uuid must be kept'), now);
		assert.deepStrictEqual(kept, {
			uuid: E, index: 0, name: 'element', label: 'Element',
			values: [{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'Water' }, { value: 'none' }],
			group_tags: ['battle'], created_at: '2026-10-14T00:00:00.000Z',
		});
		assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.values) && Object.isFrozen(kept.group_tags));

		const generated = createEnumRegistryEntry({ index: 1, name: 'rank', values: [], created_at: '2026-10-14T09:00:00+09:00' }, () => E2, now);
		assert.deepStrictEqual([generated.uuid, generated.group_tags, generated.created_at, generated.label], [E2, [], '2026-10-14T00:00:00.000Z', undefined]);
	});

	test('entry validation rejects invalid index, values, group_tags and created_at', () => {
		const rejects = (input: IEnumRegistryEntryInput, pattern: RegExp) => assert.throws(() => createEnumRegistryEntry(input, () => E2, now), (error: Error) => error instanceof EnumRegistryError && pattern.test(error.message));
		rejects(element({ index: 1.5 }), /index must be an int/);
		rejects(element({ values: [{ value: 'fire' }, { value: 'fire', label: 'Again' }] }), /duplicate value 'fire'/);
		rejects(element({ values: [{ value: '' }] }), /non-empty text value/);
		rejects(element({ values: [{ value: 1 as unknown as string }] }), /non-empty text value/);
		rejects(element({ values: [{ value: 'a', label: 2 as unknown as string }] }), /label of value 'a'/);
		rejects(element({ values: 'fire' as unknown as [] }), /values must be a list/);
		rejects(element({ group_tags: [1 as unknown as string] }), /group_tags must be a list of text/);
		rejects(element({ created_at: '2026-10-14' }), /created_at must be a timestamp/);
		rejects(element({ uuid: 'not-a-uuid' }), /uuid/);
		assert.throws(() => validateEnumRegistry([createEnumRegistryEntry(element()), createEnumRegistryEntry(element({ name: 'other' }))]), /duplicate enum uuid/);
	});

	test('Physical: kind enum is stored as text without a physical FK', () => {
		assert.deepStrictEqual(enumPhysicalProjection, { kind: TableColumnKind.Enum, physicalValue: 'text', physicalForeignKey: false });
		assert.strictEqual(getRegistryPhysicalColumnType(TableColumnKind.Enum), 'TEXT');
		const definition = generateRegistryColumnDefinition(enemy(E).columns[0]);
		assert.strictEqual(definition, '"element" TEXT NOT NULL');
		assert.ok(!/REFERENCES|FOREIGN/i.test(definition));
		assert.strictEqual(checkBoundaryFlow(BoundaryNode.Enum, BoundaryNode.TextWithMetadata), BoundaryVerdict.Allowed);
		assert.strictEqual(checkBoundaryFlow(BoundaryNode.Enum, BoundaryNode.PhysicalForeignKey), BoundaryVerdict.Forbidden);
	});

	test('Usage: Editor Select, Display Label and Input Validation', () => {
		const entry = createEnumRegistryEntry(element(), undefined, now);
		assert.deepStrictEqual(getEnumSelectOptions(entry), [{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'Water' }, { value: 'none', label: 'none' }]);
		assert.deepStrictEqual(['fire', 'none', 'earth'].map(value => getEnumValueLabel(entry, value)), ['Fire', 'none', undefined]);
		assert.deepStrictEqual(['fire', 'Fire', 'earth', 1, null].map(value => isEnumValue(entry, value)), [true, false, false, false, false]);

		const index = new EnumRegistryIndex([entry]);
		const [required] = enemy(E).columns;
		assert.deepStrictEqual(['water', 'Water', 'earth', 3, null].map(value => isEnumColumnValue(index, required, value)), [true, false, false, false, false]);
		const optional = { ...required, not_null: false };
		assert.deepStrictEqual([null, undefined, 'fire', 'earth'].map(value => isEnumColumnValue(index, optional, value)), [true, true, true, false]);
	});

	test('Registry Metadata: columns[].enum resolves by uuid; missing references and non-enum columns are rejected', () => {
		const entry = createEnumRegistryEntry(element(), undefined, now);
		const index = new EnumRegistryIndex([entry]);
		const table = enemy(E);
		assert.strictEqual(index.resolveColumn(table.columns[0]), entry);
		assert.strictEqual(index.get(E.toUpperCase()), entry);
		assert.strictEqual(index.display(E), 'Element');
		assert.strictEqual(index.display(E2), undefined);
		assert.throws(() => index.resolveColumn(table.columns[1]), /not of kind 'enum'/);

		validateTableEnumReferences([table], [entry]);
		validateTableEnumReferences([table], index);
		assert.throws(() => validateTableEnumReferences([enemy(E2)], index), (error: Error) => error instanceof EnumRegistryError && /table 'enemy': column 'element' references missing enum_registry entry/.test(error.message));
		assert.throws(() => new EnumRegistryIndex([entry, entry]), /duplicate enum uuid/);
	});

	test('stored form round-trips and statements target registry__enum_registry', () => {
		const entry = createEnumRegistryEntry(element(), undefined, now);
		const row = encodeEnumRegistryRow(entry);
		assert.deepStrictEqual(row, {
			uuid: E, index: 0, name: 'element', label: 'Element',
			values: JSON.stringify([{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'Water' }, { value: 'none', label: '' }]),
			group_tags: '["battle"]', created_at: '2026-10-14T00:00:00.000Z',
		});
		assert.deepStrictEqual(decodeEnumRegistryRow(row), entry);
		assert.strictEqual(enumRegistryPhysicalTable, 'registry__enum_registry');
		const insert = getEnumRegistryInsert(entry);
		assert.strictEqual(insert.sql, 'INSERT INTO "registry__enum_registry" ("uuid", "index", "name", "label", "values", "group_tags", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?)');
		assert.deepStrictEqual(insert.params, [E, 0, 'element', 'Element', row.values, '["battle"]', '2026-10-14T00:00:00.000Z']);
		assert.deepStrictEqual(getEnumRegistryUpdate(entry).params.at(-1), E);
		assert.deepStrictEqual(getEnumRegistryDelete(E.toUpperCase()), { sql: 'DELETE FROM "registry__enum_registry" WHERE "uuid" = ?', params: [E] });

		assert.throws(() => decodeEnumRegistryRow({ ...row, uuid: null }), /no uuid/);
		assert.throws(() => decodeEnumRegistryRow({ ...row, values: '{' }), /values is not JSON/);
		assert.throws(() => decodeEnumRegistryRow({ ...row, group_tags: '{}' }), /group_tags must be a JSON list/);
	});
});
