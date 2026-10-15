/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function dispatcher (function.dispatcher)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (18. Function Dispatcher)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dispatch, UnknownFunctionException } from '../../common/functionDispatcher.js';
import { FunctionPrimitiveError } from '../../common/functionPrimitive.js';

suite('Primitive App Editor - function dispatcher', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('linear is resolved, its arguments dispatched and its output returned', () => {
		assert.strictEqual(dispatch('linear', { x: 3, a: 2, b: 4 }), 10);
		assert.strictEqual(dispatch('linear', { x: 3, a: 2, b: 4, subtract_b: true }), 2);
		assert.strictEqual(dispatch('linear', { x: 5 }), 5);
	});

	test('primitive argument errors propagate unchanged', () => {
		assert.throws(() => dispatch('linear', { x: 1, subtract_b: 1 }), FunctionPrimitiveError);
	});

	test('unknown and not-yet-implemented functions throw UnknownFunctionException', () => {
		for (const name of ['sin', 'exp', 'Linear', 'constructor', '']) {
			let thrown: unknown;
			try {
				dispatch(name, { x: 1 });
			} catch (e) {
				thrown = e;
			}
			assert.ok(thrown instanceof UnknownFunctionException, name);
			assert.strictEqual((thrown as UnknownFunctionException).functionName, name);
		}
	});
});
