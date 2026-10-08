/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - App Editor Registry Service mutation pipeline (registry.service)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (5. Registry DDL, 6. Registry Service)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import {
	ColumnRegistryChangeKind,
	diffTableRegistryEntry,
	generateRegistryDdl,
	getRegistryPhysicalColumnType,
	migrateRegistryPhysicalValue,
	RegistryDdlStep,
	RegistryDdlStepKind,
	RegistryServiceError,
	resolveRegistryPhysicalTable,
	TableRegistryChangeKind,
	validateRegistryProjection,
} from '../../common/registryService.js';
import { createTableRegistryEntry, ITableRegistryColumnInput, TableColumnKind, tableColumnKinds } from '../../common/tableRegistry.js';

const T = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const C3 = '00000000-0000-4000-8000-0000000000c3';
const CREATED = '2026-01-01T00:00:00.000Z';

function column(uuid: string, index: number, name: string, kind: TableColumnKind, not_null = false, extra: Partial<ITableRegistryColumnInput> = {}): ITableRegistryColumnInput {
	return { uuid, index, name, kind, not_null, writable: true, searchable: false, ...extra };
}

function table(name: string, columns: ITableRegistryColumnInput[], schema = LogicalNamespace.Items) {
	return createTableRegistryEntry({ uuid: T, index: 0, schema, name, columns, created_at: CREATED });
}

function sqlOf(steps: readonly RegistryDdlStep[]): string[] {
	return steps.map(step => step.kind === RegistryDdlStepKind.Statement ? step.sql : `REBUILD ${step.physicalTable}: ${step.createSql}`);
}

suite('Primitive App Editor - Registry Service', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('physical naming: <schema>__<name>, row identity uuid, declared type per kind', () => {
		assert.strictEqual(resolveRegistryPhysicalTable({ schema: LogicalNamespace.Items, name: 'player' }), 'items__player');
		assert.strictEqual(resolveRegistryPhysicalTable({ schema: LogicalNamespace.Logs, name: 'battle_log' }), 'logs__battle_log');
		assert.throws(() => resolveRegistryPhysicalTable({ schema: LogicalNamespace.Items, name: 'Player Name' }), RegistryServiceError);
		assert.deepStrictEqual(tableColumnKinds.map(getRegistryPhysicalColumnType), ['TEXT', 'TEXT', 'INTEGER', 'REAL', 'INTEGER', 'TEXT', 'TEXT', 'TEXT', 'TEXT']);
	});

	test('Table INSERT -> CREATE TABLE, DELETE -> DROP TABLE; never a trigger or a foreign key', () => {
		const player = table('player', [column(C2, 1, 'speed', TableColumnKind.Double), column(C1, 0, 'hp', TableColumnKind.Int, true)]);
		const create = diffTableRegistryEntry(undefined, player);
		assert.strictEqual(create.kind, TableRegistryChangeKind.Create);
		assert.deepStrictEqual(sqlOf(generateRegistryDdl(create)), ['CREATE TABLE "items__player" ("uuid" TEXT PRIMARY KEY NOT NULL, "hp" INTEGER NOT NULL, "speed" REAL)']);
		const drop = diffTableRegistryEntry(player, undefined);
		assert.strictEqual(drop.kind, TableRegistryChangeKind.Drop);
		assert.deepStrictEqual(sqlOf(generateRegistryDdl(drop)), ['DROP TABLE "items__player"']);
		for (const sql of [...sqlOf(generateRegistryDdl(create)), ...sqlOf(generateRegistryDdl(drop))]) {
			assert.doesNotMatch(sql, /TRIGGER|REFERENCES|FOREIGN/i);
		}
	});

	test('OLD / NEW diff pairs columns by uuid and classifies ADD / RENAME / DELETE / KIND / NOT NULL / metadata', () => {
		const before = table('player', [
			column(C1, 0, 'fatigue', TableColumnKind.Double),
			column(C2, 1, 'hp', TableColumnKind.Int),
			column(C3, 2, 'note', TableColumnKind.Text),
		]);
		const after = table('player', [
			column(C1, 0, 'tiredness', TableColumnKind.Double, false, { label: 'Tiredness' }),
			column(C2, 1, 'hp', TableColumnKind.Double, true),
			column('00000000-0000-4000-8000-0000000000c4', 2, 'note', TableColumnKind.Text),
		]);
		const diff = diffTableRegistryEntry(before, after);
		assert.strictEqual(diff.kind, TableRegistryChangeKind.Alter);
		const changes = diff.kind === TableRegistryChangeKind.Alter ? Object.fromEntries(diff.columns.map(change => [change.uuid.slice(-2), change.changes])) : {};
		assert.deepStrictEqual(changes, {
			c1: [ColumnRegistryChangeKind.Rename, ColumnRegistryChangeKind.Metadata],
			c2: [ColumnRegistryChangeKind.KindChange, ColumnRegistryChangeKind.NotNullChange],
			c3: [ColumnRegistryChangeKind.Delete],
			c4: [ColumnRegistryChangeKind.Add],
		});
		assert.throws(() => diffTableRegistryEntry(before, createTableRegistryEntry({ index: 0, schema: 'items', name: 'player', columns: [] })), RegistryServiceError);
	});

	test('Table UPDATE -> ALTER / Migration: rename table, DROP / RENAME / ADD COLUMN, rebuild only for kind / not_null changes', () => {
		const before = table('player', [
			column(C1, 0, 'a', TableColumnKind.Int),
			column(C2, 1, 'b', TableColumnKind.Int),
			column(C3, 2, 'gone', TableColumnKind.Text),
		]);
		// Swapped names, a dropped column, a nullable added column and a moved schema: no rebuild.
		const renamed = table('hero', [
			column(C1, 0, 'b', TableColumnKind.Int, false, { searchable: true }),
			column(C2, 1, 'a', TableColumnKind.Int),
			column('00000000-0000-4000-8000-0000000000c4', 2, 'extra', TableColumnKind.Json),
		], LogicalNamespace.Logs);
		assert.deepStrictEqual(sqlOf(generateRegistryDdl(diffTableRegistryEntry(before, renamed))), [
			'ALTER TABLE "items__player" RENAME TO "logs__hero"',
			'ALTER TABLE "logs__hero" DROP COLUMN "gone"',
			'ALTER TABLE "logs__hero" RENAME COLUMN "a" TO "a__pae_migration"',
			'ALTER TABLE "logs__hero" RENAME COLUMN "b" TO "b__pae_migration"',
			'ALTER TABLE "logs__hero" RENAME COLUMN "a__pae_migration" TO "b"',
			'ALTER TABLE "logs__hero" RENAME COLUMN "b__pae_migration" TO "a"',
			'ALTER TABLE "logs__hero" ADD COLUMN "extra" TEXT',
		]);

		// Metadata only (label / index / writable / searchable): Registry mutation, no DDL.
		const relabeled = createTableRegistryEntry({ ...before, label: 'Player', index: 3, columns: before.columns.map(c => ({ ...c, writable: false })) });
		assert.deepStrictEqual(generateRegistryDdl(diffTableRegistryEntry(before, relabeled)), []);

		// KIND CHANGE / NOT NULL CHANGE / added NOT NULL column -> one rebuild with the NEW definition.
		const migrated = table('player', [
			column(C1, 0, 'a', TableColumnKind.Text),
			column(C2, 1, 'b', TableColumnKind.Int, true),
			column(C3, 2, 'gone', TableColumnKind.Text),
			column('00000000-0000-4000-8000-0000000000c4', 3, 'level', TableColumnKind.Int, true),
		]);
		const steps = generateRegistryDdl(diffTableRegistryEntry(before, migrated));
		assert.deepStrictEqual(sqlOf(steps), [
			'ALTER TABLE "items__player" ADD COLUMN "level" INTEGER',
			'REBUILD items__player: CREATE TABLE "items__player__pae_migration" ("uuid" TEXT PRIMARY KEY NOT NULL, "a" TEXT, "b" INTEGER NOT NULL, "gone" TEXT, "level" INTEGER NOT NULL)',
		]);
		const rebuild = steps[1];
		assert.ok(rebuild.kind === RegistryDdlStepKind.Rebuild);
		assert.deepStrictEqual(rebuild.columns.map(c => [c.name, c.from?.kind, c.to.kind]), [
			['a', TableColumnKind.Int, TableColumnKind.Text],
			['b', TableColumnKind.Int, TableColumnKind.Int],
			['gone', TableColumnKind.Text, TableColumnKind.Text],
			['level', undefined, TableColumnKind.Int],
		]);
	});

	test('Type / Constraint migration of stored values: keep, convert number -> text, reject invalid existing data', () => {
		const invalidValue = migrateRegistryPhysicalValue({ kind: TableColumnKind.Text }, { kind: TableColumnKind.Int, not_null: false }, 'abc');
		assert.strictEqual(typeof invalidValue, 'symbol');
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Int }, { kind: TableColumnKind.Double, not_null: false }, 5), 5);
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Double }, { kind: TableColumnKind.Int, not_null: false }, 4), 4);
		assert.strictEqual(typeof migrateRegistryPhysicalValue({ kind: TableColumnKind.Double }, { kind: TableColumnKind.Int, not_null: false }, 4.5), 'symbol');
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Int }, { kind: TableColumnKind.Text, not_null: false }, 7), '7');
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Json }, { kind: TableColumnKind.Text, not_null: false }, '"abc"'), 'abc');
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Text }, { kind: TableColumnKind.Json, not_null: false }, 'abc'), '"abc"');
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Bool }, { kind: TableColumnKind.Json, not_null: false }, 1), 'true');
		assert.strictEqual(typeof migrateRegistryPhysicalValue({ kind: TableColumnKind.Bool }, { kind: TableColumnKind.Int, not_null: false }, 1), 'symbol');
		assert.strictEqual(migrateRegistryPhysicalValue({ kind: TableColumnKind.Int }, { kind: TableColumnKind.Int, not_null: false }, null), null);
		assert.strictEqual(typeof migrateRegistryPhysicalValue({ kind: TableColumnKind.Int }, { kind: TableColumnKind.Int, not_null: true }, null), 'symbol');
		assert.strictEqual(typeof migrateRegistryPhysicalValue(undefined, { kind: TableColumnKind.Int, not_null: true }, null), 'symbol');
		// A stored value that is not a value of its OLD kind is invalid existing data too.
		assert.strictEqual(typeof migrateRegistryPhysicalValue({ kind: TableColumnKind.Int }, { kind: TableColumnKind.Text, not_null: false }, 'x'), 'symbol');
	});

	test('Registry Validate: unique physical table / column names, valid column names, reserved row identity', () => {
		const ok = table('player', [column(C1, 0, 'hp', TableColumnKind.Int)]);
		validateRegistryProjection([ok]);
		const other = createTableRegistryEntry({ index: 1, schema: 'items', name: 'player', columns: [] });
		assert.throws(() => validateRegistryProjection([ok, other]), /same physical table 'items__player'/);
		validateRegistryProjection([ok, createTableRegistryEntry({ index: 1, schema: 'logs', name: 'player', columns: [] })]);
		assert.throws(() => validateRegistryProjection([table('player', [column(C1, 0, 'hp', TableColumnKind.Int), column(C2, 1, 'hp', TableColumnKind.Text)])]), /two columns/);
		assert.throws(() => validateRegistryProjection([table('player', [column(C1, 0, 'Max HP', TableColumnKind.Int)])]), /column name must match/);
		assert.throws(() => validateRegistryProjection([table('player', [column(C1, 0, 'uuid', TableColumnKind.Uuid)])]), /row identity/);
		assert.throws(() => validateRegistryProjection([ok, ok]), /duplicate table uuid/);
	});
});
