/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - relation_registry and logical join resolution (registry.relation)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (10. relation_registry, 10. Resolve, 10. Validate)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BoundaryNode, BoundaryVerdict, checkBoundaryFlow } from '../../common/authority.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import {
	createRelationRegistryEntry,
	decodeRelationRegistryRow,
	encodeRelationRegistryRow,
	generateLogicalJoinQuery,
	getRelationRegistryDelete,
	getRelationRegistryInsert,
	IRelationRegistryEntry,
	IRelationRegistryEntryInput,
	RelationRegistryError,
	RelationType,
	resolveRelation,
	validateRelationReferences,
} from '../../common/relationRegistry.js';
import { createTableRegistryEntry, ITableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const GUILD = '00000000-0000-4000-8000-0000000000a2';
const MISSING = '00000000-0000-4000-8000-0000000000a9';
const PLAYER_GUILD = '00000000-0000-4000-8000-0000000000c1';
const PLAYER_NAME = '00000000-0000-4000-8000-0000000000c2';
const GUILD_ID = '00000000-0000-4000-8000-0000000000c3';
const GUILD_NAME = '00000000-0000-4000-8000-0000000000c4';
const RELATION = '00000000-0000-4000-8000-0000000000f1';

function table(uuid: string, name: string, columns: [string, string, TableColumnKind][]): ITableRegistryEntry {
	return createTableRegistryEntry({
		uuid, index: 0, schema: LogicalNamespace.Items, name, created_at: '2026-10-14T00:00:00.000Z',
		columns: columns.map(([columnUuid, columnName, kind], index) => ({ uuid: columnUuid, index, name: columnName, kind, not_null: false, writable: true, searchable: true })),
	});
}

const player = table(PLAYER, 'player', [[PLAYER_NAME, 'name', TableColumnKind.Text], [PLAYER_GUILD, 'guild', TableColumnKind.Uuid]]);
const guild = table(GUILD, 'guild', [[GUILD_ID, 'id', TableColumnKind.Uuid], [GUILD_NAME, 'name', TableColumnKind.Text]]);

const playerGuild: IRelationRegistryEntryInput = {
	uuid: RELATION, index: 0, main_table: PLAYER, created_at: '2026-10-14T00:00:00.000Z',
	relations: [{ join_table: GUILD, main_column: { column_uuid: PLAYER_GUILD }, join_column: { column_uuid: GUILD_ID }, relation_type: RelationType.Left }],
};

suite('Primitive App Editor - relation_registry (10. relation_registry)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an entry keeps the specification shape; a missing UUID is generated and created_at stamped', () => {
		const entry = createRelationRegistryEntry(playerGuild);
		assert.deepStrictEqual(entry, {
			uuid: RELATION, index: 0, main_table: PLAYER, created_at: '2026-10-14T00:00:00.000Z',
			relations: [{ join_table: GUILD, main_column: { column_uuid: PLAYER_GUILD }, join_column: { column_uuid: GUILD_ID }, relation_type: 'left' }],
		});
		const generated = createRelationRegistryEntry({ ...playerGuild, uuid: undefined, created_at: undefined, main_table: PLAYER.toUpperCase() }, () => '00000000-0000-4000-8000-0000000000f2', () => new Date('2026-10-15T00:00:00Z'));
		assert.strictEqual(generated.uuid, '00000000-0000-4000-8000-0000000000f2');
		assert.strictEqual(generated.created_at, '2026-10-15T00:00:00.000Z');
		assert.strictEqual(generated.main_table, PLAYER, 'references are stored normalized');
	});

	test('relation_type must be inner | left | right | full and references must be UUIDs', () => {
		for (const relationType of [RelationType.Inner, RelationType.Left, RelationType.Right, RelationType.Full]) {
			assert.strictEqual(createRelationRegistryEntry({ ...playerGuild, relations: [{ ...playerGuild.relations[0], relation_type: relationType }] }).relations[0].relation_type, relationType);
		}
		assert.throws(() => createRelationRegistryEntry({ ...playerGuild, relations: [{ ...playerGuild.relations[0], relation_type: 'cross' }] }), /relation_type must be inner \| left \| right \| full/);
		assert.throws(() => createRelationRegistryEntry({ ...playerGuild, main_table: 'player' }), /main_table must be a uuid/);
		assert.throws(() => createRelationRegistryEntry({ ...playerGuild, relations: [{ ...playerGuild.relations[0], join_table: 'guild' }] }), /join_table must be a uuid/);
		assert.throws(() => createRelationRegistryEntry({ ...playerGuild, relations: [{ ...playerGuild.relations[0], main_column: { column_uuid: 'guild' } }] }), /main_column\.column_uuid must be a uuid/);
		assert.throws(() => createRelationRegistryEntry({ ...playerGuild, index: 0.5 }), /index must be an int/);
		assert.throws(() => createRelationRegistryEntry({ ...playerGuild, created_at: 'yesterday' }), RelationRegistryError);
	});

	test('Validate: main_table / join_table / main_column / join_column exist and relation_type is valid (UUID Resolve -> Table / Column Resolve)', () => {
		const entry = createRelationRegistryEntry(playerGuild);
		const resolved = resolveRelation(entry, [guild, player]);
		assert.strictEqual(resolved.mainTable, player);
		assert.strictEqual(resolved.joins[0].joinTable, guild);
		assert.strictEqual(resolved.joins[0].mainColumn.name, 'guild');
		assert.strictEqual(resolved.joins[0].joinColumn.name, 'id');
		assert.strictEqual(resolved.joins[0].relationType, RelationType.Left);

		const join = playerGuild.relations[0];
		const invalid = (input: Partial<IRelationRegistryEntryInput>) => createRelationRegistryEntry({ ...playerGuild, ...input });
		assert.throws(() => resolveRelation(invalid({ main_table: MISSING }), [player, guild]), /main_table '.*' does not exist/);
		assert.throws(() => resolveRelation(invalid({ relations: [{ ...join, join_table: MISSING }] }), [player, guild]), /join_table '.*' does not exist/);
		// main_column belongs to main_table, join_column to join_table: columns are resolved in their own table only.
		assert.throws(() => resolveRelation(invalid({ relations: [{ ...join, main_column: { column_uuid: GUILD_ID } }] }), [player, guild]), /main_column '.*' does not exist in main_table 'player'/);
		assert.throws(() => resolveRelation(invalid({ relations: [{ ...join, join_column: { column_uuid: PLAYER_GUILD } }] }), [player, guild]), /join_column '.*' does not exist in join_table 'guild'/);
		const forged: IRelationRegistryEntry = { ...entry, relations: [{ ...entry.relations[0], relation_type: 'cross' as RelationType }] };
		assert.throws(() => resolveRelation(forged, [player, guild]), /relation_type 'cross' is not/);

		assert.throws(() => validateRelationReferences([entry, entry], [player, guild]), /duplicate relation uuid/);
		validateRelationReferences([entry], [player, guild]);
	});

	test('App Editor Query Resolver: a Logical JOIN by relation_type on the physical tables, never a physical FK', () => {
		assert.strictEqual(checkBoundaryFlow(BoundaryNode.Relation, BoundaryNode.LogicalJoin), BoundaryVerdict.Allowed);
		assert.strictEqual(checkBoundaryFlow(BoundaryNode.Relation, BoundaryNode.PhysicalForeignKey), BoundaryVerdict.Forbidden);

		const entry = createRelationRegistryEntry({
			...playerGuild, relations: [
				playerGuild.relations[0],
				{ join_table: GUILD, main_column: { column_uuid: PLAYER_NAME }, join_column: { column_uuid: GUILD_NAME }, relation_type: RelationType.Full },
			],
		});
		const query = generateLogicalJoinQuery(resolveRelation(entry, [player, guild]));
		assert.strictEqual(query.sql,
			'SELECT "t0"."uuid" AS "c0", "t0"."name" AS "c1", "t0"."guild" AS "c2", "t1"."uuid" AS "c3", "t1"."id" AS "c4", "t1"."name" AS "c5", "t2"."uuid" AS "c6", "t2"."id" AS "c7", "t2"."name" AS "c8" ' +
			'FROM "items__player" AS "t0" LEFT JOIN "items__guild" AS "t1" ON "t0"."guild" = "t1"."id" FULL JOIN "items__guild" AS "t2" ON "t0"."name" = "t2"."name"');
		assert.deepStrictEqual(query.tables, [PLAYER, GUILD, GUILD]);
		assert.deepStrictEqual(query.columns.slice(0, 4), [
			{ alias: 'c0', source: 0, column: undefined },
			{ alias: 'c1', source: 0, column: PLAYER_NAME },
			{ alias: 'c2', source: 0, column: PLAYER_GUILD },
			{ alias: 'c3', source: 1, column: undefined },
		]);
		const inner = generateLogicalJoinQuery(resolveRelation(createRelationRegistryEntry({ ...playerGuild, relations: [{ ...playerGuild.relations[0], relation_type: RelationType.Inner }] }), [player, guild]));
		assert.ok(/ INNER JOIN "items__guild" AS "t1" /.test(inner.sql));
		const right = generateLogicalJoinQuery(resolveRelation(createRelationRegistryEntry({ ...playerGuild, relations: [{ ...playerGuild.relations[0], relation_type: RelationType.Right }] }), [player, guild]));
		assert.ok(/ RIGHT JOIN "items__guild" AS "t1" /.test(right.sql));
	});

	test('storage round-trips the entry with relations as one JSON list', () => {
		const entry = createRelationRegistryEntry(playerGuild);
		const row = encodeRelationRegistryRow(entry);
		assert.deepStrictEqual(JSON.parse(String(row.relations)), [{ join_table: GUILD, main_column: { column_uuid: PLAYER_GUILD }, join_column: { column_uuid: GUILD_ID }, relation_type: 'left' }]);
		assert.deepStrictEqual(decodeRelationRegistryRow(row), entry);
		assert.throws(() => decodeRelationRegistryRow({ ...row, relations: '{' }), /relations is not JSON/);
		assert.throws(() => decodeRelationRegistryRow({ ...row, relations: '{}' }), /relations must be a JSON list/);
		assert.throws(() => decodeRelationRegistryRow({ ...row, uuid: null }), /stored entry has no uuid/);
		assert.ok(/^INSERT INTO "registry__relation_registry" \("uuid", "index", "main_table", "relations", "created_at"\)/.test(getRelationRegistryInsert(entry).sql));
		assert.deepStrictEqual(getRelationRegistryDelete(RELATION.toUpperCase()).params, [RELATION]);
	});
});
