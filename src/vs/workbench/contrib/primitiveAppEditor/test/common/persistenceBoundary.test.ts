/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Persistence boundary (foundation.project-directory)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (32. Persistence Boundary)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Artifact, artifactLifecycles, ArtifactLifecycle } from '../../common/authority.js';
import {
	assertPersistence,
	authoringPersistentPaths,
	checkPersistence,
	createSaveEvent,
	getAuthoringPersistentEntries,
	isAuthoringPersistentPath,
	isRuntimeTransientArtifact,
	logsSaveDataTable,
	PersistenceBoundaryError,
	persistenceRule,
	PersistenceTarget,
	PersistenceTrigger,
	PersistenceVerdict,
	registryCurrentTable,
	registryCurrentUpsertConflictTarget,
	runtimeTransientArtifacts,
	upsertSaveDataCurrent,
} from '../../common/persistenceBoundary.js';

suite('Primitive App Editor - Persistence Boundary (32. Persistence Boundary)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Authoring Persistent is the Working Directory without build/', () => {
		assert.deepStrictEqual(authoringPersistentPaths, ['project.sqlite', 'functions', 'assets', 'scripts', 'config']);
		assert.ok(isAuthoringPersistentPath('assets/image/hero.png'));
		assert.ok(isAuthoringPersistentPath('functions/linear.ts'));
		assert.ok(!isAuthoringPersistentPath('build/app.js'));
		assert.deepStrictEqual(getAuthoringPersistentEntries().map(entry => entry.artifact), [
			Artifact.ProjectSqlite, Artifact.Functions, Artifact.Assets, Artifact.Scripts, Artifact.Config,
		]);
	});

	test('Runtime Transient matches the Transient Runtime lifecycle', () => {
		assert.deepStrictEqual(runtimeTransientArtifacts, artifactLifecycles[ArtifactLifecycle.TransientRuntime]);
		assert.ok(runtimeTransientArtifacts.every(isRuntimeTransientArtifact));
		assert.ok(!isRuntimeTransientArtifact(Artifact.ProjectSqlite));
	});

	test('Rule: Authoring Save, Runtime State = Memory, explicit only, every frame prohibited', () => {
		assert.deepStrictEqual(persistenceRule.authoringSave, [PersistenceTarget.WorkingDirectory, PersistenceTarget.SQLite]);
		assert.strictEqual(persistenceRule.runtimeState, PersistenceTarget.Memory);

		assert.strictEqual(checkPersistence(Artifact.RuntimeState, PersistenceTrigger.Explicit).verdict, PersistenceVerdict.Allowed);
		assert.strictEqual(checkPersistence(Artifact.RuntimeState, PersistenceTrigger.Automatic).verdict, PersistenceVerdict.Forbidden);
		assert.strictEqual(checkPersistence(Artifact.FrameState, PersistenceTrigger.EveryFrame).verdict, PersistenceVerdict.Forbidden);
		assert.strictEqual(checkPersistence(Artifact.RawData, PersistenceTrigger.EveryFrame).verdict, PersistenceVerdict.Forbidden);
		assert.strictEqual(checkPersistence(Artifact.RawData, PersistenceTrigger.Explicit).verdict, PersistenceVerdict.Allowed);

		assertPersistence(Artifact.FunctionOutput, PersistenceTrigger.Explicit);
		let thrown: unknown;
		try {
			assertPersistence(Artifact.FunctionOutput, PersistenceTrigger.EveryFrame);
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown instanceof PersistenceBoundaryError);
	});

	test('registry.current / logs.savedata contract', () => {
		assert.strictEqual(`${registryCurrentTable.schema}.${registryCurrentTable.table}`, 'registry.current');
		assert.deepStrictEqual(registryCurrentTable.columns.map(column => column.name), ['uuid', 'saveId', 'key', 'data']);
		assert.strictEqual(registryCurrentTable.columns.find(column => column.name === 'saveId')?.references, 'logs.savedata.uuid');
		assert.deepStrictEqual(registryCurrentTable.unique, ['key']);
		assert.deepStrictEqual(registryCurrentUpsertConflictTarget, ['key']);

		assert.strictEqual(`${logsSaveDataTable.schema}.${logsSaveDataTable.table}`, 'logs.savedata');
		assert.deepStrictEqual(logsSaveDataTable.columns.map(column => column.name), ['uuid', 'timestamptz']);
	});

	test('UPSERT on key keeps uuid and moves saveId to the latest Save Event', () => {
		let counter = 0;
		const generateUuid = () => `uuid-${++counter}`;
		const saveA = createSaveEvent('save-a', new Date(Date.UTC(2026, 0, 1)));
		const saveB = createSaveEvent('save-b', new Date(Date.UTC(2026, 0, 2)));
		assert.strictEqual(saveA.timestamptz, '2026-01-01T00:00:00.000Z');

		const before = upsertSaveDataCurrent(undefined, saveA, { key: 'player.hp', data: { value: 100 } }, generateUuid);
		assert.deepStrictEqual(before, { uuid: 'uuid-1', saveId: 'save-a', key: 'player.hp', data: { value: 100 } });

		const after = upsertSaveDataCurrent(before, saveB, { key: 'player.hp', data: { value: 80 } }, generateUuid);
		assert.deepStrictEqual(after, { uuid: 'uuid-1', saveId: 'save-b', key: 'player.hp', data: { value: 80 } });
		assert.strictEqual(counter, 1);

		assert.throws(() => upsertSaveDataCurrent(before, saveB, { key: 'slot1.player.hp', data: 1 }, generateUuid));
		assert.throws(() => upsertSaveDataCurrent(undefined, saveB, { key: '', data: 1 }, generateUuid));
	});
});
