/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_binding (binding.function)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (19. Function Binding, 23. Persistent Address)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	createFunctionBindingAddress,
	createFunctionBindingEntry,
	decodeFunctionBindingRow,
	encodeFunctionBindingRow,
	functionBindingExecutionKinds,
	functionBindingPhysicalTable,
	functionBindingSources,
	FunctionBindingError,
	IFunctionBindingEntryInput,
	validateFunctionBindings,
} from '../../common/functionBinding.js';

const T = '00000000-0000-4000-8000-0000000000a2';
const R = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const F = '00000000-0000-4000-8000-0000000000f1';
const U = '00000000-0000-4000-8000-0000000000d1';
const addr = { table_uuid: T, row_uuid: R, column_uuid: C };
const now = () => new Date('2026-10-15T00:00:00Z');

function input(extra: Record<string, unknown> = {}): IFunctionBindingEntryInput {
	return {
		uuid: U, index: 0, function: { uuid: F }, constructor: { subtract_b: true }, execution: { kind: 'tick' },
		inputs: { x: { source: 'state', address: addr } },
		parameters: { a: { source: 'constant', value: 0.1 } },
		target: { address: addr, merge: { kind: 'overlay' } },
		...extra,
	} as IFunctionBindingEntryInput;
}

suite('Primitive App Editor - function_binding contract', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('vocabulary matches the specification', () => {
		assert.deepStrictEqual([...functionBindingSources], ['constant', 'state', 'input', 'time', 'progress', 'event', 'function_output']);
		assert.deepStrictEqual([...functionBindingExecutionKinds], ['tick', 'event', 'input']);
		assert.strictEqual(functionBindingPhysicalTable, 'binding__function_binding');
	});

	test('entry is built, UUIDs are normalized and the UUID is generated when missing', () => {
		const entry = createFunctionBindingEntry(input({ uuid: U.toUpperCase(), function: { uuid: F.toUpperCase() } }), undefined, now);
		assert.strictEqual(entry.uuid, U);
		assert.strictEqual(entry.function.uuid, F);
		assert.strictEqual(entry.created_at, '2026-10-15T00:00:00.000Z');
		assert.ok(Object.isFrozen(entry));
		assert.ok(/^[0-9a-f-]{36}$/.test(createFunctionBindingEntry(input({ uuid: undefined }), undefined, now).uuid));
	});

	test('stored form round-trips with the same identity', () => {
		const entry = createFunctionBindingEntry(input({
			inputs: { x: { source: 'function_output', function_binding_uuid: U }, t: { source: 'time' } },
		}), undefined, now);
		const row = encodeFunctionBindingRow(entry);
		assert.deepStrictEqual(decodeFunctionBindingRow(row), entry);
		assert.deepStrictEqual(JSON.parse(String(row.target)), { address: addr, merge: { kind: 'overlay' } });
	});

	test('Persistent Address is exactly three UUIDs', () => {
		assert.deepStrictEqual(createFunctionBindingAddress(addr, 'x'), addr);
		assert.throws(() => createFunctionBindingAddress({ ...addr, row_uuid: 'Player' }, 'x'), /row_uuid must be a UUID/);
		assert.throws(() => createFunctionBindingAddress({ table_uuid: T, column_uuid: C }, 'x'), /row_uuid must be a UUID/);
		assert.throws(() => createFunctionBindingAddress({ ...addr, label: 'Fatigue' }, 'x'), /unknown member 'label'/);
	});

	test('every source takes exactly the member it needs', () => {
		const bad = (inputs: IFunctionBindingEntryInput['inputs'], pattern: RegExp) => assert.throws(() => createFunctionBindingEntry(input({ inputs }), undefined, now), pattern);
		bad({ x: { source: 'nowhere' as never } }, /source 'nowhere' is not one of/);
		bad({ x: { source: 'constant' } }, /requires a value/);
		bad({ x: { source: 'constant', value: Number.NaN } }, /JSON value/);
		bad({ x: { source: 'state' } }, /address must be an object/);
		bad({ x: { source: 'state', address: addr, value: 1 } }, /does not take 'value'/);
		bad({ x: { source: 'function_output' } }, /function_binding_uuid must be a UUID/);
		bad({ x: { source: 'time', address: addr } }, /does not take 'address'/);
		bad({ x: 'time' as never }, /must be an object with a source/);
	});

	test('index, execution, merge and constructor are validated', () => {
		const bad = (extra: Record<string, unknown>, pattern: RegExp) => assert.throws(() => createFunctionBindingEntry(input(extra), undefined, now), (error: Error) => error instanceof FunctionBindingError && pattern.test(error.message));
		bad({ index: 1.5 }, /index must be an int/);
		bad({ function: { uuid: 'accumulate' } }, /function uuid must be a UUID/);
		bad({ execution: { kind: 'frame' } }, /execution.kind/);
		bad({ target: { address: addr, merge: { kind: 'blend' } } }, /merge.kind/);
		bad({ constructor: { subtract_b: undefined } }, /constructor 'subtract_b'/);
		bad({ created_at: 'yesterday' }, /created_at/);
		assert.throws(() => createFunctionBindingEntry({ ...input(), constructor: undefined } as never, undefined, now), /constructor must be an object/);
	});

	test('binding UUIDs are unique within a set', () => {
		const entry = createFunctionBindingEntry(input(), undefined, now);
		assert.throws(() => validateFunctionBindings([entry, entry]), /duplicate binding uuid/);
	});
});
