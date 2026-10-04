/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor built-in DDL and migrations (foundation.editor-ddl)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (5. Editor DDL, 5. Built-in DDL)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	compareEditorSchemaVersion,
	computeEditorDdlChecksum,
	EditorDdlError,
	editorSchemaVersionPhysicalTable,
	IAppliedEditorDdlMigration,
	IEditorDdlMigration,
	scanEditorDdlResources,
} from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';

function applied(migration: IEditorDdlMigration): IAppliedEditorDdlMigration {
	return { version: migration.version, name: migration.name, checksum: migration.checksum, appliedAt: '2026-01-01T00:00:00.000Z' };
}

suite('Primitive App Editor - Editor DDL (5. Editor DDL)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('built-in resources scan into contiguous versions and own the Runtime Save Data tables', () => {
		const migrations = scanEditorDdlResources(editorDdlResources);
		assert.deepStrictEqual(migrations.map(m => [m.version, m.name]), [[1, '001_savedata.sql']]);
		assert.ok(/CREATE TABLE "logs__savedata"/.test(migrations[0].sql));
		assert.ok(/CREATE TABLE "registry__current"/.test(migrations[0].sql));
		assert.strictEqual(migrations[0].checksum, computeEditorDdlChecksum(migrations[0].sql));
		assert.strictEqual(editorSchemaVersionPhysicalTable, 'editor__schema_version');
	});

	test('DDL Resource Scan orders by version and validates names / contiguity / content', () => {
		const ddl = 'CREATE TABLE "x" ("a" TEXT)';
		assert.deepStrictEqual(scanEditorDdlResources([
			{ name: '002_registry.sql', sql: ddl },
			{ name: '001_project.sql', sql: ddl },
		]).map(m => m.version), [1, 2]);

		assert.throws(() => scanEditorDdlResources([{ name: '1_project.sql', sql: ddl }]), EditorDdlError);
		assert.throws(() => scanEditorDdlResources([{ name: '001_Project.sql', sql: ddl }]), EditorDdlError);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.txt', sql: ddl }]), EditorDdlError);
		assert.throws(() => scanEditorDdlResources([{ name: '002_registry.sql', sql: ddl }]), /contiguous/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_a.sql', sql: ddl }, { name: '001_b.sql', sql: ddl }]), /contiguous/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: '  \n' }]), /empty/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: `BEGIN; ${ddl}; COMMIT;` }]), /transaction control/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: `${ddl};\nend transaction;` }]), /transaction control/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: `SAVEPOINT s; ${ddl}; RELEASE s;` }]), /transaction control/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: `${ddl}; ROLLBACK` }]), /transaction control/);
		// DB Trigger restriction is a Registry DDL contract (registry.service), not a Built-in DDL rule:
		// a trigger body's BEGIN / END is not transaction control.
		assert.strictEqual(scanEditorDdlResources([{ name: '001_project.sql', sql: `${ddl}; CREATE TEMP TRIGGER t AFTER INSERT ON "x" BEGIN SELECT CASE WHEN 1 THEN 'begin' END; SELECT 2; END; CREATE TABLE "y" ("a" TEXT);` }]).length, 1);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: `CREATE TRIGGER t AFTER INSERT ON "x" BEGIN SELECT 1; END; COMMIT;` }]), /transaction control/);
		assert.throws(() => scanEditorDdlResources([{ name: '001_project.sql', sql: `ATTACH DATABASE 'a' AS items` }]), /schema feature/);
	});

	test('Schema Version Compare: unapplied = resources after the applied prefix', () => {
		const migrations = scanEditorDdlResources([
			{ name: '001_project.sql', sql: 'CREATE TABLE "a" ("x" TEXT)' },
			{ name: '002_registry.sql', sql: 'CREATE TABLE "b" ("x" TEXT)' },
		]);
		const fresh = compareEditorSchemaVersion(migrations, []);
		assert.deepStrictEqual([fresh.current, fresh.target, fresh.unapplied.map(m => m.name)], [0, 2, ['001_project.sql', '002_registry.sql']]);

		const partial = compareEditorSchemaVersion(migrations, [applied(migrations[0])]);
		assert.deepStrictEqual([partial.current, partial.target, partial.unapplied.map(m => m.name)], [1, 2, ['002_registry.sql']]);

		const current = compareEditorSchemaVersion(migrations, migrations.map(applied));
		assert.deepStrictEqual([current.current, current.unapplied], [2, []]);
	});

	test('Schema Version Compare rejects a newer database, a modified applied resource, and gaps', () => {
		const migrations = scanEditorDdlResources([{ name: '001_project.sql', sql: 'CREATE TABLE "a" ("x" TEXT)' }]);
		assert.throws(() => compareEditorSchemaVersion(migrations, [
			applied(migrations[0]),
			{ version: 2, name: '002_registry.sql', checksum: 'x', appliedAt: '' },
		]), /newer than this Editor/);
		assert.throws(() => compareEditorSchemaVersion(migrations, [{ ...applied(migrations[0]), checksum: 'changed' }]), /does not match/);
		assert.throws(() => compareEditorSchemaVersion(migrations, [{ ...applied(migrations[0]), name: '001_other.sql' }]), /does not match/);
		assert.throws(() => compareEditorSchemaVersion(migrations, [{ ...applied(migrations[0]), version: 2 }]), /not contiguous/);
	});
});
