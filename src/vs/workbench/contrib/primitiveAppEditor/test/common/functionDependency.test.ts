/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - function_dependency (binding.dependency)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (20. Function Dependency)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFunctionBindingEntry, IFunctionBindingEntry } from '../../common/functionBinding.js';
import {
	buildFunctionExecutionPlan,
	createFunctionDependencyEntry,
	decodeFunctionDependencyRow,
	encodeFunctionDependencyRow,
	functionDependencyPhysicalTable,
	validateFunctionDependencies,
} from '../../common/functionDependency.js';

const T = '00000000-0000-4000-8000-0000000000a2';
const R = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const F = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000d1';
const B = '00000000-0000-4000-8000-0000000000d2';
const D = '00000000-0000-4000-8000-0000000000d3';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';
const now = () => new Date('2026-10-15T00:00:00Z');
const addr = { table_uuid: T, row_uuid: R, column_uuid: C };

function binding(uuid: string, index: number, inputs: Record<string, unknown> = { x: { source: 'time' } }): IFunctionBindingEntry {
	return createFunctionBindingEntry({
		uuid, index, function: { uuid: F }, constructor: {}, execution: { kind: 'tick' },
		inputs: inputs as never, target: { address: addr, merge: { kind: 'overwrite' } },
	}, undefined, now);
}
const out = (uuid: string) => ({ source: 'function_output', function_binding_uuid: uuid });
function edge(uuid: string, source: string, target: string, name = 'x') {
	return createFunctionDependencyEntry({ uuid, source_binding: { uuid: source }, target_binding: { uuid: target }, target_input: { name } }, undefined, now);
}

suite('Primitive App Editor - function_dependency model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('entry validation and row round-trip', () => {
		const entry = edge(E1.toUpperCase(), A, B);
		assert.strictEqual(entry.uuid, E1);
		assert.strictEqual(entry.created_at, '2026-10-15T00:00:00.000Z');
		assert.deepStrictEqual(decodeFunctionDependencyRow(encodeFunctionDependencyRow(entry)), entry);
		assert.strictEqual(functionDependencyPhysicalTable, 'binding__function_dependency');
		assert.strictEqual(createFunctionDependencyEntry({ source_binding: { uuid: A }, target_binding: { uuid: B }, target_input: { name: 'x' } }, () => E2, now).uuid, E2);
		assert.throws(() => edge(E1, A, A), /cannot depend on itself/);
		assert.throws(() => edge(E1, 'nope', B), /source_binding uuid must be a UUID/);
		assert.throws(() => edge(E1, A, B, ''), /target_input.name/);
		assert.throws(() => createFunctionDependencyEntry({ uuid: E1, source_binding: { uuid: A }, target_binding: { uuid: B }, target_input: { name: 'x' }, created_at: 'x' }), /created_at/);
	});

	test('uuids are unique and one input has one producer', () => {
		assert.throws(() => validateFunctionDependencies([edge(E1, A, B), edge(E1, D, B, 'y')]), /duplicate dependency/);
		assert.throws(() => validateFunctionDependencies([edge(E1, A, B), edge(E2, D, B)]), /already has a dependency/);
		validateFunctionDependencies([edge(E1, A, B), edge(E2, D, B, 'y')]);
	});

	test('plan: dependency is the primary order, index orders independent nodes', () => {
		// A(index 5) -> B(index 0); D(index 1) independent.
		const bindings = [binding(A, 5), binding(B, 0, { x: out(A) }), binding(D, 1)];
		const plan = buildFunctionExecutionPlan(bindings, [edge(E1, A, B)]);
		assert.deepStrictEqual(plan.map(step => step.binding.uuid), [D, A, B]);
		assert.deepStrictEqual(plan.map(step => step.depends_on), [[], [], [A]]);
		assert.deepStrictEqual(buildFunctionExecutionPlan(bindings, [edge(E1, A, B)]).map(step => step.binding.uuid), [D, A, B], 'deterministic');
		assert.deepStrictEqual(buildFunctionExecutionPlan([binding(D, 1), binding(A, 0)], []).map(step => step.binding.uuid), [A, D]);
	});

	test('cycle is rejected (Load / Build reject)', () => {
		const bindings = [binding(A, 0, { x: out(B) }), binding(B, 1, { x: out(A) })];
		assert.throws(() => buildFunctionExecutionPlan(bindings, [edge(E1, A, B), edge(E2, B, A)]), /cycle detected among bindings .*Load \/ Build reject/);
	});

	test('edges must match their bindings', () => {
		const bindings = [binding(A, 0), binding(B, 1, { x: out(A) })];
		assert.throws(() => buildFunctionExecutionPlan(bindings, [edge(E1, D, B)]), /no source binding/);
		assert.throws(() => buildFunctionExecutionPlan(bindings, [edge(E1, A, D)]), /no target binding/);
		assert.throws(() => buildFunctionExecutionPlan(bindings, [edge(E1, A, B, 'y')]), /has no input 'y'/);
		assert.throws(() => buildFunctionExecutionPlan([binding(A, 0), binding(B, 1)], [edge(E1, A, B)]), /is not 'function_output' of binding/);
		assert.throws(() => buildFunctionExecutionPlan([binding(A, 0), binding(D, 1), binding(B, 2, { x: out(D) })], [edge(E1, A, B)]), /is not 'function_output' of binding/);
		assert.throws(() => buildFunctionExecutionPlan(bindings, []), /'function_output' without a function_dependency/);
	});
});
