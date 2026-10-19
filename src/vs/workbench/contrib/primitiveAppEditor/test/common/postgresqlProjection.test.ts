/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - PostgreSQL schema and seed projection (build.postgresql)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. PostgreSQL Web Application Output)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BuildValidationError, IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE } from '../../common/buildValidation.js';
import { createFunctionPrimitiveExecutorCatalog } from '../../common/functionPrimitive.js';
import {
	generatePostgresqlDdl,
	generatePostgresqlSeedDml,
	POSTGRESQL_INIT_FILE,
	POSTGRESQL_SEED_FILE,
	PostgresqlProjectionError,
	PostgresqlProjectionStage,
	projectPostgresqlApplicationOutput,
	projectPostgresqlSchema,
} from '../../common/postgresqlProjection.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { createTableRegistryEntry, ITableRegistryColumnInput, TableColumnKind } from '../../common/tableRegistry.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const LOG = '00000000-0000-4000-8000-0000000000a2';
const ROW1 = '00000000-0000-4000-8000-0000000000b1';
const ROW2 = '00000000-0000-4000-8000-0000000000b2';
const ROW3 = '00000000-0000-4000-8000-0000000000b3';
const OWNER = '00000000-0000-4000-8000-0000000000b9';
const NOW = '2026-10-18T00:00:00.000Z';
const col = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

function column(n: number, name: string, kind: TableColumnKind, extra: Partial<ITableRegistryColumnInput> = {}): ITableRegistryColumnInput {
	return { uuid: col(n), index: n, name, kind, not_null: false, writable: true, searchable: false, ...extra };
}

const playerColumns = [
	column(1, 'label', TableColumnKind.Text, { not_null: true, searchable: true }),
	column(2, 'level', TableColumnKind.Int),
	column(3, 'fatigue', TableColumnKind.Double),
	column(4, 'alive', TableColumnKind.Bool),
	column(5, 'born', TableColumnKind.Date),
	column(6, 'seen', TableColumnKind.Timestamp),
	column(7, 'owner', TableColumnKind.Uuid),
	column(8, 'extra', TableColumnKind.Json),
];

/** Independent reference: lowercase RFC 4648 Base32 (no padding) of table uuid + column uuid bytes. */
function expectedBase32(tableUuid: string, columnUuid: string): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
	const bits = (tableUuid + columnUuid).replace(/-/g, '').split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
	return (bits.match(/.{1,5}/g) ?? []).map(chunk => alphabet[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}

function tables() {
	return [
		createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', columns: playerColumns, created_at: NOW }),
		createTableRegistryEntry({ uuid: LOG, index: 1, schema: LogicalNamespace.Logs, name: 'event', columns: [column(9, 'note', TableColumnKind.Text)], created_at: NOW }),
	];
}

function authoring(): IBuildAuthoringData {
	return {
		tables: tables(),
		relations: [], functions: [], bindings: [], dependencies: [], renderers: [], rendererBindings: [], assets: [],
		rawData: [
			{ table_uuid: PLAYER, rows: [
				{ uuid: ROW2, values: { [col(1)]: `O'Brien`, [col(2)]: 3 } },
				{ uuid: ROW1, values: { [col(1)]: 'a', [col(3)]: 1.5, [col(4)]: true, [col(5)]: '2026-01-02', [col(6)]: NOW, [col(7)]: OWNER, [col(8)]: { k: [1, `x'y`] } } },
				{ uuid: ROW3, values: { [col(1)]: 'excluded' } },
			] },
			{ table_uuid: LOG, rows: [{ uuid: ROW1, values: { [col(9)]: 'not selected' } }] },
		],
		workingDirectoryPaths: [],
		executorCatalog: createFunctionPrimitiveExecutorCatalog(),
		resolveExecutorProgram: () => undefined,
	};
}

function configuration(seed: Record<string, unknown> = { include: true, raw_data: { tables: [PLAYER], exclude_rows: [ROW3] } }): Record<string, unknown> {
	return {
		build_target: POSTGRESQL_WEB_APPLICATION_OUTPUT,
		runtime_storage_target: POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
		seed_data: seed,
		include: { assets: [], functions: [], scripts: [], config: [] },
		output_path: 'build/out',
	};
}

function rejects(run: () => unknown, stage: PostgresqlProjectionStage, message: RegExp): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof PostgresqlProjectionError, `expected a PostgresqlProjectionError, got ${String(thrown)}`);
	assert.strictEqual(thrown.stage, stage);
	assert.match(thrown.message, message);
}

suite('Primitive App Editor - PostgreSQL schema and seed projection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('DDL: Logical Namespace -> PostgreSQL schema, Kind Dispatch types, primary key and searchable index, no foreign key', () => {
		const schema = projectPostgresqlSchema(tables());
		assert.deepStrictEqual(schema.schemas, ['items', 'logs']);
		const ddl = generatePostgresqlDdl(schema);
		assert.ok(ddl.startsWith('CREATE SCHEMA IF NOT EXISTS "items";\n\nCREATE SCHEMA IF NOT EXISTS "logs";'));
		assert.ok(ddl.includes(`CREATE TABLE "items"."player" (
	"uuid" UUID NOT NULL,
	"label" TEXT NOT NULL,
	"level" BIGINT,
	"fatigue" DOUBLE PRECISION,
	"alive" BOOLEAN,
	"born" DATE,
	"seen" TIMESTAMPTZ,
	"owner" UUID,
	"extra" JSONB
);`));
		assert.ok(ddl.includes('CREATE TABLE "logs"."event" ('));
		assert.ok(ddl.includes(`ALTER TABLE "items"."player" ADD CONSTRAINT "pk_${PLAYER.replace(/-/g, '')}" PRIMARY KEY ("uuid");`));
		assert.ok(ddl.includes(`CREATE INDEX "idx_${expectedBase32(PLAYER, col(1))}" ON "items"."player" ("label");`));
		assert.ok(!/FOREIGN KEY|REFERENCES|TRIGGER|CREATE TYPE/i.test(ddl));
		assert.strictEqual(generatePostgresqlDdl(projectPostgresqlSchema(tables())), ddl);
	});

	test('DDL: Registry Resolve rejects what the SQLite Physical Table Expansion rejects, and over-long names', () => {
		const reserved = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'bad', columns: [column(1, 'uuid', TableColumnKind.Text)], created_at: NOW });
		rejects(() => projectPostgresqlSchema([reserved]), PostgresqlProjectionStage.RegistryResolve, /row identity column/);
		const long = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'a'.repeat(64), columns: [], created_at: NOW });
		rejects(() => projectPostgresqlSchema([long]), PostgresqlProjectionStage.TableColumnResolve, /exceeds 63 bytes/);
	});

	test('DDL: constraint / index names are Machine Identity based, so `a_b.c` and `a.b_c` do not clash (Issue #76)', () => {
		const a = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'a_b', columns: [column(1, 'c', TableColumnKind.Text, { searchable: true })], created_at: NOW });
		const b = createTableRegistryEntry({ uuid: LOG, index: 1, schema: LogicalNamespace.Items, name: 'a', columns: [column(2, 'b_c', TableColumnKind.Text, { searchable: true })], created_at: NOW });
		const long = createTableRegistryEntry({ uuid: OWNER, index: 2, schema: LogicalNamespace.Items, name: 'a'.repeat(60), columns: [column(3, 'b'.repeat(60), TableColumnKind.Text, { searchable: true })], created_at: NOW });
		const ddl = generatePostgresqlDdl(projectPostgresqlSchema([a, b, long]));
		const names = [...ddl.matchAll(/(?:CONSTRAINT|INDEX) "([^"]+)"/g)].map(match => match[1]);
		assert.strictEqual(names.length, 6);
		assert.strictEqual(new Set(names).size, 6);
		assert.ok(names.every(name => new TextEncoder().encode(name).length <= 63));
		assert.strictEqual(generatePostgresqlDdl(projectPostgresqlSchema([b, long, a])), ddl);
	});

	test('DDL: columns whose uuids share a 26 hex digit prefix get distinct, order-independent index names (Issue #82)', () => {
		const t = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const c1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
		const c2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
		const table = (columns: ITableRegistryColumnInput[]) => createTableRegistryEntry({ uuid: t, index: 0, schema: LogicalNamespace.Items, name: 'x', columns, created_at: NOW });
		const a = { uuid: c1, index: 1, name: 'a', kind: TableColumnKind.Text, not_null: false, writable: true, searchable: true };
		const b = { uuid: c2, index: 2, name: 'b', kind: TableColumnKind.Text, not_null: false, writable: true, searchable: true };
		const ddl = generatePostgresqlDdl(projectPostgresqlSchema([table([a, b])]));
		const names = [...ddl.matchAll(/INDEX "([^"]+)"/g)].map(match => match[1]);
		assert.deepStrictEqual(names.slice().sort(), [`idx_${expectedBase32(t, c1)}`, `idx_${expectedBase32(t, c2)}`].sort());
		assert.strictEqual(new Set(names).size, 2);
		assert.ok(names.every(name => name.length === 56));
		const reversed = generatePostgresqlDdl(projectPostgresqlSchema([table([b, a])]));
		const byColumn = (text: string, column: string) => new RegExp(`INDEX "([^"]+)" ON "items"."x" \\("${column}"\\)`).exec(text)![1];
		assert.strictEqual(byColumn(reversed, 'a'), byColumn(ddl, 'a'));
		assert.strictEqual(byColumn(reversed, 'b'), byColumn(ddl, 'b'));
	});

	test('DDL: a generated relation name clashing with a table in the same schema is rejected', () => {
		const clash = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: `pk_${PLAYER.replace(/-/g, '')}`, columns: [], created_at: NOW });
		rejects(() => generatePostgresqlDdl(projectPostgresqlSchema([clash])), PostgresqlProjectionStage.TableColumnResolve, /same PostgreSQL relation/);
	});

	test('Seed: only the Build Target Filter selection becomes DML; values are resolved per kind and rows ordered by identity', () => {
		const { result } = projectPostgresqlApplicationOutput(authoring(), configuration());
		assert.deepStrictEqual(result.files.map(f => f.path), [POSTGRESQL_INIT_FILE, POSTGRESQL_SEED_FILE]);
		const seed = result.files[1].content;
		assert.strictEqual(seed, `INSERT INTO "items"."player" ("uuid", "label", "level", "fatigue", "alive", "born", "seen", "owner", "extra") VALUES
	('${ROW1}', 'a', NULL, 1.5, TRUE, '2026-01-02', '${NOW}', '${OWNER}', '{"k":[1,"x''y"]}'::jsonb),
	('${ROW2}', 'O''Brien', 3, NULL, NULL, NULL, NULL, NULL, NULL);
`);
		assert.ok(!seed.includes('excluded') && !seed.includes('not selected'));
		assert.ok(result.files[0].content.includes('CREATE TABLE "logs"."event"'));
	});

	test('Seed: unselected Raw Data is not in the Seed; no seed file without selected rows; Registry is projected whole', () => {
		const none = projectPostgresqlApplicationOutput(authoring(), configuration({ include: false, raw_data: { tables: [], exclude_rows: [] } }));
		assert.deepStrictEqual(none.result.files.map(f => f.path), [POSTGRESQL_INIT_FILE]);
		assert.strictEqual(none.result.schema.tables.length, 2);
	});

	test('Seed: Value Resolve rejects unknown tables / columns, kind and not_null violations, duplicate or invalid identities', () => {
		const schema = projectPostgresqlSchema(tables());
		const entries = tables();
		const seed = (rows: { uuid: string; values: Record<string, unknown> }[], table = PLAYER) => () => generatePostgresqlSeedDml(schema, entries, [{ table_uuid: table, rows }]);
		const stage = PostgresqlProjectionStage.ValueRelationResolve;
		rejects(seed([], '00000000-0000-4000-8000-0000000000ff'), stage, /not in table_registry/);
		rejects(seed([{ uuid: ROW1, values: { [col(1)]: 'a', [col(99)]: 1 } }]), stage, /not a column/);
		rejects(seed([{ uuid: ROW1, values: { [col(1)]: 'a', [col(2)]: 1.5 } }]), stage, /not a value of kind 'int'/);
		rejects(seed([{ uuid: ROW1, values: {} }]), stage, /column 'label'.*not_null/);
		rejects(seed([{ uuid: ROW1, values: { [col(1)]: 'a' } }, { uuid: ROW1, values: { [col(1)]: 'b' } }]), stage, /unique UUID/);
		rejects(seed([{ uuid: 'x', values: { [col(1)]: 'a' } }]), stage, /unique UUID/);
		rejects(seed([{ uuid: ROW1, values: { [col(1)]: 'a\0' } }]), stage, /NUL/);
		rejects(() => generatePostgresqlSeedDml(schema, entries, [{ table_uuid: PLAYER, rows: [] }, { table_uuid: PLAYER, rows: [] }]), stage, /twice/);
	});

	test('Build Validation still gates the Projection and nothing in Authoring Data is modified', () => {
		const data = authoring();
		const before = JSON.stringify(data);
		assert.throws(() => projectPostgresqlApplicationOutput(data, { ...configuration(), runtime_storage_target: 'Other' }), BuildValidationError);
		assert.throws(() => projectPostgresqlApplicationOutput(data, { ...configuration(), build_target: 'Other' }), BuildValidationError);
		projectPostgresqlApplicationOutput(data, configuration());
		assert.strictEqual(JSON.stringify(data), before);
	});
});
