/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - UUID identity and human naming (registry.identity)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (7. UUID Identity)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isUUID } from '../../../../../base/common/uuid.js';
import {
	diffRegistryIdentities,
	ensureRegistryIdentity,
	getRegistryDisplayText,
	prepareRegistryInsert,
	RegistryIdentityChangeKind,
	RegistryIdentityError,
	RegistryIdentityIndex,
	renameRegistryIdentity,
} from '../../common/registryIdentity.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function sequence(...uuids: string[]): () => string {
	let i = 0;
	return () => uuids[i++];
}

suite('Primitive App Editor - Registry Identity (7. UUID Identity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Generate: UUID missing -> Generate, present -> Keep', () => {
		const generated = ensureRegistryIdentity({ name: 'fatigue' });
		assert.ok(isUUID(generated.uuid));
		assert.strictEqual(generated.name, 'fatigue');
		assert.strictEqual(generated.label, undefined);

		assert.deepStrictEqual(ensureRegistryIdentity({ name: 'fatigue', uuid: '' }, sequence(B)), { uuid: B, name: 'fatigue' });

		let called = false;
		const kept = ensureRegistryIdentity({ uuid: A.toUpperCase(), name: 'fatigue', label: 'Fatigue' }, () => { called = true; return B; });
		assert.deepStrictEqual(kept, { uuid: A, name: 'fatigue', label: 'Fatigue' });
		assert.ok(!called, 'a supplied UUID is kept, not regenerated');
	});

	test('Generate: identity validation', () => {
		assert.throws(() => ensureRegistryIdentity({ uuid: 'A', name: 'fatigue' }), RegistryIdentityError);
		assert.throws(() => ensureRegistryIdentity({ name: '' }), RegistryIdentityError);
		assert.throws(() => ensureRegistryIdentity({ name: ' fatigue' }), RegistryIdentityError);
		assert.throws(() => ensureRegistryIdentity({ name: 'fatigue' }, () => 'not-a-uuid'), RegistryIdentityError);
		assert.strictEqual(ensureRegistryIdentity({ name: 'fatigue', label: '' }, sequence(A)).label, undefined);
	});

	test('Seed does not require UUID hand entry; uuid and name are unique per scope', () => {
		const rows = prepareRegistryInsert([
			{ name: 'hp', kind: 'int' },
			{ uuid: B, name: 'fatigue', label: 'Fatigue', kind: 'float' },
		], [], sequence(A));
		assert.deepStrictEqual(rows, [
			{ uuid: A, name: 'hp', kind: 'int' },
			{ uuid: B, name: 'fatigue', label: 'Fatigue', kind: 'float' },
		]);

		assert.throws(() => prepareRegistryInsert([{ uuid: A, name: 'x' }, { uuid: A, name: 'y' }]), /duplicate uuid/);
		assert.throws(() => prepareRegistryInsert([{ name: 'x' }, { name: 'x' }]), /duplicate name/);
		assert.throws(() => prepareRegistryInsert([{ name: 'hp' }], [{ uuid: A, name: 'hp' }]), /duplicate name/);
		assert.throws(() => prepareRegistryInsert([{ uuid: A, name: 'mp' }], [{ uuid: A, name: 'hp' }]), /duplicate uuid/);
	});

	test('Rename: uuid same -> rename', () => {
		const before = { uuid: A, name: 'fatigue' };
		const after = renameRegistryIdentity(before, 'tiredness');
		assert.deepStrictEqual(after, { uuid: A, name: 'tiredness' });
		assert.deepStrictEqual(diffRegistryIdentities([before], [after]), [
			{ kind: RegistryIdentityChangeKind.Rename, uuid: A, before, after },
		]);
		assert.throws(() => renameRegistryIdentity(before, ''), RegistryIdentityError);
	});

	test('Rename: uuid different -> delete + add, even with the same name', () => {
		const before = { uuid: A, name: 'fatigue' };
		const after = { uuid: B, name: 'fatigue' };
		assert.deepStrictEqual(diffRegistryIdentities([before], [after]), [
			{ kind: RegistryIdentityChangeKind.Delete, uuid: A, before },
			{ kind: RegistryIdentityChangeKind.Add, uuid: B, after },
		]);
	});

	test('Diff pairs by Machine Identity only (keep / relabel / swap names)', () => {
		const before = [{ uuid: A, name: 'x' }, { uuid: B, name: 'y', label: 'Y' }, { uuid: C, name: 'z' }];
		const after = [{ uuid: B, name: 'y', label: 'Why' }, { uuid: A, name: 'x' }, { uuid: C.toUpperCase(), name: 'z' }];
		assert.deepStrictEqual(diffRegistryIdentities(before, after).map(change => [change.kind, change.uuid]), [
			[RegistryIdentityChangeKind.Keep, A],
			[RegistryIdentityChangeKind.Relabel, B],
			[RegistryIdentityChangeKind.Keep, C],
		]);

		const swapped = diffRegistryIdentities([{ uuid: A, name: 'x' }, { uuid: B, name: 'y' }], [{ uuid: A, name: 'y' }, { uuid: B, name: 'x' }]);
		assert.deepStrictEqual(swapped.map(change => change.kind), [RegistryIdentityChangeKind.Rename, RegistryIdentityChangeKind.Rename]);

		assert.throws(() => diffRegistryIdentities([{ uuid: A, name: 'x' }, { uuid: A, name: 'y' }], []), /duplicate uuid in before/);
	});

	test('Editor Display = name / label, Storage = UUID', () => {
		assert.strictEqual(getRegistryDisplayText({ name: 'fatigue' }), 'fatigue');
		assert.strictEqual(getRegistryDisplayText({ name: 'fatigue', label: 'Fatigue' }), 'Fatigue');

		const before = new RegistryIdentityIndex([{ uuid: A, name: 'fatigue', label: 'Fatigue' }, { uuid: B, name: 'hp' }]);
		const stored = before.resolveName('fatigue');
		assert.strictEqual(stored, A);
		assert.strictEqual(before.resolveName('missing'), undefined);
		assert.strictEqual(before.display(B), 'hp');
		assert.strictEqual(before.display('not-a-uuid'), undefined);

		// a rename does not rewrite the stored reference; it is displayed by the new name
		const after = new RegistryIdentityIndex([renameRegistryIdentity({ uuid: A, name: 'fatigue' }, 'tiredness'), { uuid: B, name: 'hp' }]);
		assert.strictEqual(after.display(stored!), 'tiredness');
		assert.strictEqual(after.resolveName('fatigue'), undefined);

		assert.throws(() => new RegistryIdentityIndex([{ uuid: A, name: 'x' }, { uuid: B, name: 'x' }]), /duplicate name/);
		assert.throws(() => new RegistryIdentityIndex([{ uuid: A, name: 'x' }, { uuid: A, name: 'y' }]), /duplicate uuid/);
	});
});
