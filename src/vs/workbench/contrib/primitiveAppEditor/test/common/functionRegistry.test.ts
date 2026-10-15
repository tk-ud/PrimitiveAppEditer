/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_registry (function.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (13. Function, 14. function_registry, 15. Function Definition Contract)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	createFunctionExecutorCatalog,
	createFunctionRegistryEntry,
	decodeFunctionRegistryRow,
	encodeFunctionRegistryRow,
	FunctionRegistryError,
	functionRegistryPhysicalTable,
	getFunctionRegistryInsert,
	IFunctionRegistryEntryInput,
	validateFunctionRegistry,
	validateFunctionRegistryExecutors,
} from '../../common/functionRegistry.js';

const F = '00000000-0000-4000-8000-0000000000f1';
const now = () => new Date('2026-10-15T00:00:00Z');

function throwsFunctionRegistryError(fn: () => unknown, pattern: RegExp): void {
	let thrown: unknown;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof FunctionRegistryError && pattern.test(thrown.message), `expected FunctionRegistryError ${pattern}, got ${String(thrown)}`);
}

const base: IFunctionRegistryEntryInput = {
	index: 0,
	name: 'damage',
	label: 'Damage',
	executor: 'math.damage',
	input: [{ name: 'attack', kind: 'int' }, { name: 'defense', kind: 'int' }],
	constructor: [{ name: 'seed', kind: 'int', default: 0 }],
	parameters: [{ name: 'rate', kind: 'double', default: 1.5 }, { name: 'tags', kind: 'json', default: { a: [1, null] } }, { name: 'free', kind: 'text' }],
	output: { kind: 'int' },
};

suite('Primitive App Editor - function_registry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('generates a missing uuid, keeps a supplied one, stamps created_at and keeps input / constructor / parameters / output', () => {
		let generated = 0;
		const entry = createFunctionRegistryEntry(base, () => `00000000-0000-4000-8000-00000000000${++generated}`, now);
		assert.strictEqual(entry.uuid, '00000000-0000-4000-8000-000000000001');
		assert.strictEqual(generated, 1);
		assert.strictEqual(entry.created_at, '2026-10-15T00:00:00.000Z');
		assert.deepStrictEqual([entry.name, entry.label, entry.executor], ['damage', 'Damage', 'math.damage']);
		assert.deepStrictEqual(entry.input, [{ name: 'attack', kind: 'int' }, { name: 'defense', kind: 'int' }]);
		assert.deepStrictEqual(entry.constructor, [{ name: 'seed', kind: 'int', default: 0 }]);
		assert.deepStrictEqual(entry.parameters, [{ name: 'rate', kind: 'double', default: 1.5 }, { name: 'tags', kind: 'json', default: { a: [1, null] } }, { name: 'free', kind: 'text' }]);
		assert.deepStrictEqual(entry.output, { kind: 'int' });
		assert.ok(!Object.keys(entry.parameters[2]).includes('default'), 'an absent default stays absent');

		const kept = createFunctionRegistryEntry({ ...base, uuid: F.toUpperCase() }, () => { throw new Error('must not generate'); }, now);
		assert.strictEqual(kept.uuid, F);
		const minimal = createFunctionRegistryEntry({ index: 1, name: 'noop', executor: 'core.noop', constructor: [], output: { kind: 'text' } }, () => F, now);
		assert.deepStrictEqual([minimal.input, minimal.constructor, minimal.parameters, minimal.label], [[], [], [], undefined]);
	});

	test('rejects a definition outside the function_registry contract', () => {
		const make = (patch: object) => () => createFunctionRegistryEntry({ ...base, ...patch } as IFunctionRegistryEntryInput, () => F, now);
		throwsFunctionRegistryError(make({ index: 1.5 }), /index must be an int/);
		throwsFunctionRegistryError(make({ executor: '' }), /executor must be non-empty text/);
		throwsFunctionRegistryError(make({ output: { kind: '' } }), /output kind must be non-empty text/);
		throwsFunctionRegistryError(make({ output: undefined }), /output must be an object/);
		throwsFunctionRegistryError(make({ input: [{ name: 'a', kind: 'int' }, { name: 'a', kind: 'int' }] }), /duplicate input name 'a'/);
		throwsFunctionRegistryError(make({ input: [{ name: 'a', kind: 'int', default: 1 }] }), /input has no default/);
		throwsFunctionRegistryError(make({ parameters: [{ name: 'a', kind: '' }] }), /kind must be non-empty text/);
		throwsFunctionRegistryError(make({ parameters: [{ name: 'a', kind: 'int', default: () => 1 }] }), /default must be a JSON value/);
		throwsFunctionRegistryError(make({ constructor: 'x' }), /constructor must be a list/);
		throwsFunctionRegistryError(make({ created_at: 'yesterday' }), /created_at must be a timestamp/);
		throwsFunctionRegistryError(make({ name: '' }), /name/);
	});

	test('duplicate function names are accepted; a duplicate function uuid is rejected', () => {
		const a = createFunctionRegistryEntry({ ...base, uuid: F }, undefined, now);
		const b = createFunctionRegistryEntry({ ...base, index: 1 }, undefined, now);
		validateFunctionRegistry([a, b]);
		throwsFunctionRegistryError(() => validateFunctionRegistry([a, createFunctionRegistryEntry({ ...base, uuid: F }, undefined, now)]), /duplicate function uuid/);
	});

	test('Registry -> an executor that does not exist in Code is not allowed', () => {
		const entry = createFunctionRegistryEntry(base, undefined, now);
		validateFunctionRegistryExecutors([entry], createFunctionExecutorCatalog(['math.damage', 'core.noop']));
		throwsFunctionRegistryError(() => validateFunctionRegistryExecutors([entry], createFunctionExecutorCatalog(['core.noop'])), /executor 'math\.damage' does not exist in Code/);
	});

	test('stored form round-trips with the same identity and insert SQL targets registry__function_registry', () => {
		const entry = createFunctionRegistryEntry({ ...base, uuid: F }, undefined, now);
		const row = encodeFunctionRegistryRow(entry);
		assert.strictEqual(row.output, '{"kind":"int"}');
		assert.deepStrictEqual(decodeFunctionRegistryRow(row), entry);
		const unlabeled = createFunctionRegistryEntry({ ...base, uuid: F, label: undefined }, undefined, now);
		assert.strictEqual(encodeFunctionRegistryRow(unlabeled).label, '');
		assert.deepStrictEqual(decodeFunctionRegistryRow(encodeFunctionRegistryRow(unlabeled)), unlabeled);

		const insert = getFunctionRegistryInsert(entry);
		assert.strictEqual(functionRegistryPhysicalTable, 'registry__function_registry');
		assert.ok(insert.sql.startsWith('INSERT INTO "registry__function_registry" ("uuid", "index", "name", "label", "executor", "input", "constructor", "parameters", "output", "created_at")'));
		assert.strictEqual(insert.params.length, 10);
	});

	test('stored rows violating the contract are rejected and never regenerated', () => {
		const row = encodeFunctionRegistryRow(createFunctionRegistryEntry({ ...base, uuid: F }, undefined, now));
		throwsFunctionRegistryError(() => decodeFunctionRegistryRow({ ...row, uuid: '' }), /no uuid/);
		throwsFunctionRegistryError(() => decodeFunctionRegistryRow({ ...row, input: '[' }), /input is not JSON/);
		throwsFunctionRegistryError(() => decodeFunctionRegistryRow({ ...row, output: '{}' }), /output kind must be non-empty text/);
		throwsFunctionRegistryError(() => decodeFunctionRegistryRow({ ...row, executor: '' }), /executor/);
	});
});
