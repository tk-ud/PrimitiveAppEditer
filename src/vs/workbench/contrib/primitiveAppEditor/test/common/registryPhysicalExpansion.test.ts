/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - SQLite physical table projection (registry.physical-expansion)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (9. Physical Table Expansion)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import {
	dispatchRegistryKind,
	expandRegistryPhysicalSchema,
	generateRegistryCreateTable,
	projectRegistryPhysicalTable,
	registryKindProjections,
	RegistryExpansionError,
	RegistryExpansionStage,
	RegistryServiceError,
	validateRegistryTableColumns,
	validateRegistryTableSchema,
} from '../../common/registryPhysicalExpansion.js';
import { createTableRegistryEntry, ITableRegistryColumnInput, ITableRegistryEntry, TableColumnKind, tableColumnKinds } from '../../common/tableRegistry.js';

const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const C3 = '00000000-0000-4000-8000-0000000000c3';
const CREATED = '2026-01-01T00:00:00.000Z';

function column(uuid: string, index: number, name: string, kind: TableColumnKind, not_null = false): ITableRegistryColumnInput {
	return { uuid, index, name, kind, not_null, writable: true, searchable: false, ...(kind === TableColumnKind.Enum ? { enum: '00000000-0000-4000-8000-0000000000e1' } : {}) };
}

function table(uuid: string, index: number, name: string, columns: ITableRegistryColumnInput[], schema = LogicalNamespace.Items): ITableRegistryEntry {
	return createTableRegistryEntry({ uuid, index, schema, name, columns, created_at: CREATED });
}

function stageOf(fn: () => unknown): RegistryExpansionStage | undefined {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof RegistryExpansionError, String(error));
		assert.ok(error instanceof RegistryServiceError);
		return error.stage;
	}
	return undefined;
}

suite('Primitive App Editor - Physical Table Expansion', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Kind Dispatch covers every table_registry kind and rejects anything else', () => {
		assert.deepStrictEqual(Object.keys(registryKindProjections).sort(), [...tableColumnKinds].sort());
		assert.deepStrictEqual(tableColumnKinds.map(kind => dispatchRegistryKind(kind).type), ['TEXT', 'TEXT', 'INTEGER', 'REAL', 'INTEGER', 'TEXT', 'TEXT', 'TEXT', 'TEXT']);
		assert.strictEqual(stageOf(() => dispatchRegistryKind('float' as TableColumnKind)), RegistryExpansionStage.KindDispatch);
	});

	test('Registry expands into the Physical Schema: <schema>__<name>, row identity first, columns in Registry order', () => {
		const player = table(T1, 1, 'player', [column(C2, 1, 'speed', TableColumnKind.Double), column(C1, 0, 'hp', TableColumnKind.Int, true), column(C3, 2, 'alive', TableColumnKind.Bool)]);
		const battle = table(T2, 0, 'battle', [column(C1, 0, 'state', TableColumnKind.Enum, true)], LogicalNamespace.Logs);
		const schema = expandRegistryPhysicalSchema([player, battle]);

		assert.deepStrictEqual(schema.tables.map(t => t.name), ['logs__battle', 'items__player'], 'Registry order (index)');
		assert.deepStrictEqual(schema.tables.map(t => t.registryUuid), [T2, T1]);
		const physicalPlayer = schema.tables[1];
		assert.deepStrictEqual(physicalPlayer.columns.map(c => [c.name, c.type, c.notNull, c.primaryKey, c.registryUuid]), [
			['uuid', 'TEXT', true, true, undefined],
			['hp', 'INTEGER', true, false, C1],
			['speed', 'REAL', false, false, C2],
			['alive', 'INTEGER', false, false, C3],
		]);
		assert.strictEqual(generateRegistryCreateTable(physicalPlayer), 'CREATE TABLE "items__player" ("uuid" TEXT PRIMARY KEY NOT NULL, "hp" INTEGER NOT NULL, "speed" REAL, "alive" INTEGER)');
		assert.strictEqual(generateRegistryCreateTable(physicalPlayer, 'items__player__tmp'), 'CREATE TABLE "items__player__tmp" ("uuid" TEXT PRIMARY KEY NOT NULL, "hp" INTEGER NOT NULL, "speed" REAL, "alive" INTEGER)');
		assert.ok(!/TRIGGER|REFERENCES|FOREIGN/i.test(schema.tables.map(t => generateRegistryCreateTable(t)).join(';')), 'only DDL: no trigger, no physical FK');
		assert.ok(Object.isFrozen(schema) && Object.isFrozen(schema.tables) && Object.isFrozen(physicalPlayer.columns));

		// The projection is read-only: the Registry entries are not touched.
		assert.deepStrictEqual(player, table(T1, 1, 'player', [column(C2, 1, 'speed', TableColumnKind.Double), column(C1, 0, 'hp', TableColumnKind.Int, true), column(C3, 2, 'alive', TableColumnKind.Bool)]));
		assert.deepStrictEqual(expandRegistryPhysicalSchema([]).tables, []);
	});

	test('Schema Validate rejects an invalid namespace, an unresolvable name, a duplicate uuid or physical table', () => {
		assert.strictEqual(validateRegistryTableSchema({ schema: LogicalNamespace.Logs, name: 'battle_log' }), 'logs__battle_log');
		assert.strictEqual(stageOf(() => validateRegistryTableSchema({ schema: 'main' as LogicalNamespace, name: 'player' })), RegistryExpansionStage.SchemaValidate);
		assert.strictEqual(stageOf(() => validateRegistryTableSchema({ schema: LogicalNamespace.Items, name: 'Player Name' })), RegistryExpansionStage.SchemaValidate);
		const player = table(T1, 0, 'player', [column(C1, 0, 'hp', TableColumnKind.Int)]);
		assert.strictEqual(stageOf(() => expandRegistryPhysicalSchema([player, table(T2, 1, 'player', [])])), RegistryExpansionStage.SchemaValidate);
		assert.strictEqual(stageOf(() => expandRegistryPhysicalSchema([player, player])), RegistryExpansionStage.SchemaValidate);
		assert.strictEqual(stageOf(() => expandRegistryPhysicalSchema([player, table(T2, 1, 'player', [], LogicalNamespace.Logs)])), undefined, 'same name in another namespace is another physical table');
	});

	test('Column Validate rejects invalid, duplicate and row identity column names before Kind Dispatch', () => {
		const columns = (...names: string[]) => names.map((name, index) => ({ uuid: `00000000-0000-4000-8000-0000000000${(0xc1 + index).toString(16)}`, index, name, kind: TableColumnKind.Text, not_null: false, writable: true, searchable: false, enum: null }));
		validateRegistryTableColumns({ name: 'player', columns: columns('hp', 'max_hp') });
		assert.strictEqual(stageOf(() => validateRegistryTableColumns({ name: 'player', columns: columns('Max HP') })), RegistryExpansionStage.ColumnValidate);
		assert.strictEqual(stageOf(() => validateRegistryTableColumns({ name: 'player', columns: columns('uuid') })), RegistryExpansionStage.ColumnValidate);
		assert.strictEqual(stageOf(() => validateRegistryTableColumns({ name: 'player', columns: columns('hp', 'hp') })), RegistryExpansionStage.ColumnValidate);
		assert.strictEqual(stageOf(() => projectRegistryPhysicalTable(table(T1, 0, 'player', [column(C1, 0, 'uuid', TableColumnKind.Uuid)]))), RegistryExpansionStage.ColumnValidate);
	});
});
