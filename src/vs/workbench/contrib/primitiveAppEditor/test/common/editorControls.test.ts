/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Registry-driven generic editor controls (editor.registry-ui)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (25. Editor UI, Kind Dispatch)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createEditorControl, createEditorControls, createEditorUpdateRequest, createRelationSource, dispatchEditorControl, EditorControlError, EditorControlType, resolveRelationTargetTable, resolveRowLabel, saveEditorValue, validateEditorValue } from '../../common/editorControls.js';
import { createEnumRegistryEntry, EnumRegistryIndex } from '../../common/enumRegistry.js';
import { createRelationRegistryEntry } from '../../common/relationRegistry.js';
import { IResolverOperationRequest } from '../../common/resolver.js';
import { createTableRegistryEntry, tableColumnKinds, TableColumnKind } from '../../common/tableRegistry.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ELEMENT = id(1);
const ENEMY = id(0xa1);
const PLAYER = id(0xa2);
const R1 = id(0xb1);
const P1 = id(0xb2);

const enums = new EnumRegistryIndex([createEnumRegistryEntry({ uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water' }] })]);
const col = (n: number, index: number, name: string, kind: TableColumnKind, extra: object = {}) => ({ uuid: id(n), index, name, kind, not_null: false, writable: true, searchable: true, ...extra });
const player = createTableRegistryEntry({ uuid: PLAYER, index: 1, schema: 'items', name: 'player', label: 'Player', columns: [col(0xc6, 0, 'name', TableColumnKind.Text), col(0xc8, 1, 'pid', TableColumnKind.Uuid)] });
const enemy = createTableRegistryEntry({
	uuid: ENEMY, index: 0, schema: 'items', name: 'enemy', columns: [
		col(0xd9, 9, 'meta', TableColumnKind.Json),
		col(0xc1, 0, 'hp', TableColumnKind.Int, { not_null: true }),
		col(0xc2, 1, 'speed', TableColumnKind.Double),
		col(0xc3, 2, 'alive', TableColumnKind.Bool),
		col(0xc4, 3, 'born', TableColumnKind.Date),
		col(0xc5, 4, 'seen', TableColumnKind.Timestamp),
		col(0xc7, 5, 'name', TableColumnKind.Text, { label: 'Name' }),
		col(0xc9, 6, 'element', TableColumnKind.Enum, { enum: ELEMENT }),
		col(0xca, 7, 'owner', TableColumnKind.Uuid, { label: 'Owner' }),
		col(0xcb, 8, 'locked', TableColumnKind.Bool, { writable: false }),
	],
});
const relation = createRelationRegistryEntry({ index: 0, main_table: ENEMY, relations: [{ join_table: PLAYER, main_column: { column_uuid: id(0xca) }, join_column: { column_uuid: id(0xc8) }, relation_type: 'left' }] });
const column = (n: number) => enemy.columns.find(candidate => candidate.uuid === id(n))!;

suite('Primitive App Editor - Registry-driven generic editor controls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Kind Dispatch maps every kind to one generic component', () => {
		assert.deepStrictEqual(tableColumnKinds.map(kind => dispatchEditorControl(kind)), [
			EditorControlType.RelationSelect, EditorControlType.TextField, EditorControlType.NumberField, EditorControlType.NumberField,
			EditorControlType.Checkbox, EditorControlType.DatePicker, EditorControlType.DateTimePicker, EditorControlType.Select, EditorControlType.JsonEditor,
		]);
		assert.throws(() => dispatchEditorControl('blob' as TableColumnKind), EditorControlError);
	});

	test('components are derived from the Registry in column order, with human labels and no UUID', async () => {
		const controls = await createEditorControls(enemy, { [id(0xc1)]: 5, [id(0xc9)]: 'fire', [id(0xc3)]: true }, enums);
		assert.deepStrictEqual(controls.map(control => control.label), ['hp', 'speed', 'alive', 'born', 'seen', 'Name', 'element', 'Owner', 'locked', 'meta']);
		assert.deepStrictEqual(controls.map(control => control.control), [
			EditorControlType.NumberField, EditorControlType.NumberField, EditorControlType.Checkbox, EditorControlType.DatePicker, EditorControlType.DateTimePicker,
			EditorControlType.TextField, EditorControlType.Select, EditorControlType.RelationSelect, EditorControlType.Checkbox, EditorControlType.JsonEditor,
		]);
		assert.strictEqual(controls[0].integer, true);
		assert.strictEqual(controls[1].integer, false);
		assert.strictEqual(controls[2].integer, undefined);
		assert.strictEqual(controls[6].displayValue, 'Fire');
		assert.deepStrictEqual(controls[6].options, [{ value: 'fire', label: 'Fire' }, { value: 'water', label: 'water' }]);
		assert.strictEqual(controls[8].readOnly, true);
		assert.ok(!JSON.stringify(controls.map(control => control.label)).includes('0000'));
	});

	test('every component carries a tooltip, details and an Inline Message only when invalid', async () => {
		const valid = await createEditorControl(column(0xc1), 5, enums);
		assert.strictEqual(valid.explanation.tooltip, 'hp: int (required)');
		assert.ok(valid.explanation.details.length >= 3);
		assert.strictEqual(valid.explanation.message, undefined);
		const missing = await createEditorControl(column(0xc1), undefined, enums);
		assert.strictEqual(missing.explanation.message, 'A value is required.');
		const invalid = await createEditorControl(column(0xc9), 'earth', enums);
		assert.strictEqual(invalid.explanation.message, 'Not a valid enum value.');
		assert.strictEqual((await createEditorControl(column(0xcb), true, enums)).explanation.tooltip, 'locked: bool (read-only)');
	});

	test('Empty Selection yields no component and no Mutation Target', async () => {
		assert.deepStrictEqual(await createEditorControls(enemy, undefined, enums), []);
	});

	test('validation matches the Registry (Kind Validate)', () => {
		assert.strictEqual(validateEditorValue(column(0xc1), 3, enums), undefined);
		assert.ok(validateEditorValue(column(0xc1), 3.5, enums));
		assert.ok(validateEditorValue(column(0xc4), '2026-02-30', enums));
		assert.strictEqual(validateEditorValue(column(0xc4), '2026-02-28', enums), undefined);
		assert.strictEqual(validateEditorValue(column(0xc9), 'water', enums), undefined);
		assert.strictEqual(validateEditorValue(column(0xc2), null, enums), undefined);
	});

	test('relation / select resolves the target table from relation_registry and labels rows without the UUID', async () => {
		assert.strictEqual(resolveRelationTargetTable(column(0xca), enemy, [relation]), PLAYER);
		assert.strictEqual(resolveRelationTargetTable(player.columns[1], player, [relation]), ENEMY);
		assert.strictEqual(resolveRelationTargetTable(column(0xc1), enemy, [relation]), undefined);
		assert.strictEqual(resolveRowLabel(player, { [id(0xc6)]: 'Alice' }, 0), 'Alice');
		assert.strictEqual(resolveRowLabel(player, { [id(0xc6)]: '' }, 1), 'Player #2');

		const requests: IResolverOperationRequest[] = [];
		const api = { select: async (request: IResolverOperationRequest) => { requests.push(request); return { operation: 'select' as const, kind: 'raw', result: [{ uuid: P1, values: { [id(0xc6)]: 'Alice' } }] }; } };
		const source = createRelationSource(api, enemy, [enemy, player], [relation]);
		const control = await createEditorControl(column(0xca), P1.toUpperCase(), enums, source);
		assert.deepStrictEqual(control.options, [{ value: P1, label: 'Alice' }]);
		assert.strictEqual(control.displayValue, 'Alice');
		assert.deepStrictEqual(requests.map(request => request.target), [{ kind: 'raw', uuid: PLAYER }]);
		assert.strictEqual((await createEditorControl(column(0xca), P1, enums)).options, undefined);
	});

	test('Save is one generic update request; invalid and non-writable values are not dispatched', async () => {
		const requests: IResolverOperationRequest[] = [];
		const api = { update: async (request: IResolverOperationRequest) => { requests.push(request); return { operation: 'update' as const, kind: 'raw', result: 'ok' }; } };
		const address = { tableUuid: ENEMY, rowUuid: R1 };
		assert.strictEqual(await saveEditorValue(api, address, column(0xc1), 9, enums), 'ok');
		assert.deepStrictEqual(requests, [{ target: { kind: 'raw', uuid: ENEMY }, address: { table_uuid: ENEMY, row_uuid: R1, column_uuid: id(0xc1) }, payload: { [id(0xc1)]: 9 } }]);
		assert.deepStrictEqual(createEditorUpdateRequest(address, column(0xc2), undefined).payload, { [id(0xc2)]: null });
		await assert.rejects(saveEditorValue(api, address, column(0xc1), 'x', enums), /Not a valid int value/);
		await assert.rejects(saveEditorValue(api, address, column(0xc1), null, enums), /A value is required/);
		await assert.rejects(saveEditorValue(api, address, column(0xcb), true, enums), /not writable/);
		assert.strictEqual(requests.length, 1);
	});
});
