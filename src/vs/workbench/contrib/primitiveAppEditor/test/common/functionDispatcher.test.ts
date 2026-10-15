/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function dispatcher (function.dispatcher)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (18. Function Dispatcher)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dispatchFunction, UnknownFunctionException } from '../../common/functionDispatcher.js';
import { implementedFunctionPrimitives } from '../../common/functionPrimitive.js';

suite('Primitive App Editor - function dispatcher', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('linear dispatches to the Linear primitive with Registry defaults', () => {
		assert.strictEqual(dispatchFunction('linear', { x: 5 }), 5);
		assert.strictEqual(dispatchFunction('linear', { a: 2, x: 3, b: 4 }), 10);
		assert.strictEqual(dispatchFunction('linear', { subtract_b: true, a: 2, x: 3, b: 4 }), 2);
	});

	test('every implemented primitive is dispatchable by its registry name', () => {
		for (const definition of implementedFunctionPrimitives) {
			assert.doesNotThrow(() => dispatchFunction(definition.name, { x: 1 }));
		}
	});

	test('unknown or not-yet-implemented function names throw UnknownFunctionException', () => {
		for (const name of ['sin', 'exp', 'nope', '']) {
			assert.throws(() => dispatchFunction(name, { x: 1 }), (e: unknown) => e instanceof UnknownFunctionException && e.functionName === name);
		}
	});

	test('invalid arguments are rejected rather than coerced', () => {
		assert.throws(() => dispatchFunction('linear', {}), /x must be a number/);
		assert.throws(() => dispatchFunction('linear', { x: '1' }), /x must be a number/);
	});
});
