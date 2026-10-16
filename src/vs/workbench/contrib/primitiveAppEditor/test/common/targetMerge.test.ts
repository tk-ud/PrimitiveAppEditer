/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - target merge (binding.merge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (21. Target Merge)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFunctionBindingEntry, IFunctionBindingEntry } from '../../common/functionBinding.js';
import { buildFunctionExecutionPlan } from '../../common/functionDependency.js';
import {
	dispatchTargetMerge,
	mergeExecutionPlanOutputs,
	mergeTargetValues,
	normalizeTargetMergeValue,
	targetMergeKey,
	TargetMergeSemantics,
	TargetMergeValueKind,
} from '../../common/targetMerge.js';

const T = '00000000-0000-4000-8000-0000000000a2';
const R = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const F = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000d1';
const B = '00000000-0000-4000-8000-0000000000d2';
const D = '00000000-0000-4000-8000-0000000000d3';
const now = () => new Date('2026-10-15T00:00:00Z');
const addr = { table_uuid: T, row_uuid: R, column_uuid: C };

function binding(uuid: string, index: number, merge: string, column = C): IFunctionBindingEntry {
	return createFunctionBindingEntry({
		uuid, index, function: { uuid: F }, constructor: {}, execution: { kind: 'tick' },
		inputs: { x: { source: 'time' } }, target: { address: { ...addr, column_uuid: column }, merge: { kind: merge } },
	}, undefined, now);
}

const close = (actual: readonly number[], expected: readonly number[]) => {
	assert.strictEqual(actual.length, expected.length);
	actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `[${i}] ${value} != ${expected[i]}`));
};

suite('Primitive App Editor - target merge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('merge dispatch by value kind', () => {
		assert.strictEqual(dispatchTargetMerge(TargetMergeValueKind.Double), TargetMergeSemantics.Additive);
		assert.strictEqual(dispatchTargetMerge(TargetMergeValueKind.Vector), TargetMergeSemantics.Additive);
		assert.strictEqual(dispatchTargetMerge(TargetMergeValueKind.Quaternion), TargetMergeSemantics.Compose);
		assert.strictEqual(dispatchTargetMerge(TargetMergeValueKind.Bool), TargetMergeSemantics.Overwrite);
		assert.strictEqual(dispatchTargetMerge(TargetMergeValueKind.Text), TargetMergeSemantics.Overwrite);
	});

	test('overwrite: last output in execution order replaces the value; no output keeps the base', () => {
		assert.strictEqual(mergeTargetValues('overwrite', TargetMergeValueKind.Double, 10, [1, 2, 3]), 3);
		assert.strictEqual(mergeTargetValues('overwrite', TargetMergeValueKind.Double, 10, []), 10);
		assert.deepStrictEqual(mergeTargetValues('overwrite', TargetMergeValueKind.Vector, [0, 0], [[1, 2], [3, 4]]), [3, 4]);
	});

	test('overlay: final = base + sum of overlays (double / vector)', () => {
		assert.strictEqual(mergeTargetValues('overlay', TargetMergeValueKind.Double, 10, [1, 2, 3]), 16);
		assert.strictEqual(mergeTargetValues('overlay', TargetMergeValueKind.Double, 10, []), 10);
		assert.deepStrictEqual(mergeTargetValues('overlay', TargetMergeValueKind.Vector, [1, 1, 1], [[1, 2, 3], [0, 0, 1]]), [2, 3, 5]);
		assert.throws(() => mergeTargetValues('overlay', TargetMergeValueKind.Vector, [1, 1], [[1, 2, 3]]), /vector length 3 does not match 2/);
	});

	test('overlay: quaternion composes, bool / text overwrite', () => {
		const identity = [0, 0, 0, 1];
		const zQuarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // 90 degrees about z
		close(mergeTargetValues('overlay', TargetMergeValueKind.Quaternion, identity, [zQuarter]) as number[], zQuarter);
		// two 90 degree turns = 180 degrees about z
		close(mergeTargetValues('overlay', TargetMergeValueKind.Quaternion, identity, [zQuarter, zQuarter]) as number[], [0, 0, 1, 0]);
		// outputs are normalized before composing
		close(mergeTargetValues('overlay', TargetMergeValueKind.Quaternion, identity, [[0, 0, 2, 2]]) as number[], zQuarter);
		assert.strictEqual(mergeTargetValues('overlay', TargetMergeValueKind.Bool, false, [true, false, true]), true);
		assert.strictEqual(mergeTargetValues('overlay', TargetMergeValueKind.Text, 'a', ['b', 'c']), 'c');
	});

	test('normalize rejects values that do not match their kind', () => {
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Double, '1', 'x'), /double must be a finite number/);
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Double, Infinity, 'x'), /finite/);
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Vector, [], 'x'), /non-empty/);
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Quaternion, [0, 0, 0, 0], 'x'), /must not be zero/);
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Quaternion, [1, 2, 3], 'x'), /\[x, y, z, w\]/);
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Bool, 1, 'x'), /boolean/);
		assert.throws(() => normalizeTargetMergeValue(TargetMergeValueKind.Text, 1, 'x'), /string/);
		assert.throws(() => mergeTargetValues('blend', TargetMergeValueKind.Double, 0, []), /overwrite \| overlay/);
		assert.throws(() => mergeTargetValues('overlay', TargetMergeValueKind.Double, 0, [Number.MAX_VALUE, Number.MAX_VALUE]), /finite/);
	});

	test('execution plan outputs merge per Target using the binding merge.kind', () => {
		// Same Target C written by A and D (overlay); B alone overwrites C2. Plan order: A(0), B(1), D(2).
		const bindings = [binding(D, 2, 'overlay'), binding(A, 0, 'overlay'), binding(B, 1, 'overwrite', C2)];
		const plan = buildFunctionExecutionPlan(bindings, []);
		const outputs = new Map<string, unknown>([[A, 2], [B, 7], [D, 3]]);
		const key = targetMergeKey(addr);
		const key2 = targetMergeKey({ ...addr, column_uuid: C2 });
		const results = mergeExecutionPlanOutputs(plan, outputs, new Map([
			[key, { kind: TargetMergeValueKind.Double, base: 10 }],
			[key2, { kind: TargetMergeValueKind.Double, base: 100 }],
		]));
		assert.deepStrictEqual(results.map(result => [result.merge, result.value, result.bindings]), [
			['overlay', 15, [A, D]],
			['overwrite', 7, [B]],
		]);
		// a binding that did not run contributes nothing
		const partial = mergeExecutionPlanOutputs(plan, new Map([[D, 3]]), new Map([
			[key, { kind: TargetMergeValueKind.Double, base: 10 }],
			[key2, { kind: TargetMergeValueKind.Double, base: 100 }],
		]));
		assert.deepStrictEqual(partial.map(result => result.value), [13, 100]);
	});

	test('execution plan: Target must have one merge policy and a supplied kind', () => {
		const mixed = buildFunctionExecutionPlan([binding(A, 0, 'overlay'), binding(B, 1, 'overwrite')], []);
		const targets = new Map([[targetMergeKey(addr), { kind: TargetMergeValueKind.Double, base: 0 }]]);
		assert.throws(() => mergeExecutionPlanOutputs(mixed, new Map(), targets), /selects 'overwrite' but/);
		const single = buildFunctionExecutionPlan([binding(A, 0, 'overlay')], []);
		assert.throws(() => mergeExecutionPlanOutputs(single, new Map(), new Map()), /no value kind \/ base state supplied/);
	});
});
