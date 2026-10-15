/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function primitive contract and initial catalog (function.primitive)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (15. Function Definition Contract, 16. Linear, 17. Function Catalog)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFunctionRegistryEntry, getFunctionRegistryInsert, validateFunctionRegistryExecutors } from '../../common/functionRegistry.js';
import {
	createFunctionPrimitiveExecutorCatalog,
	evaluateLinear,
	functionCatalog,
	FunctionPrimitiveError,
	implementedFunctionPrimitives,
	Linear,
	linearDefinition,
	toFunctionRegistryEntryInput,
} from '../../common/functionPrimitive.js';

suite('Primitive App Editor - function primitive', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Linear: y = ax + b, and y = ax - b with subtract_b', () => {
		assert.strictEqual(new Linear(false).evaluate(2, 3, 4), 10);
		assert.strictEqual(new Linear(true).evaluate(2, 3, 4), 2);
		assert.strictEqual(new Linear(true).evaluate(1, 0, 0), 0 + -0);
	});

	test('Linear registry definition matches the specification and applies defaults', () => {
		assert.deepStrictEqual(linearDefinition.input, [{ name: 'x', kind: 'double' }]);
		assert.deepStrictEqual(linearDefinition.constructor, [{ name: 'subtract_b', kind: 'bool', default: false }]);
		assert.deepStrictEqual(linearDefinition.parameters, [{ name: 'a', kind: 'double', default: 1 }, { name: 'b', kind: 'double', default: 0 }]);
		assert.deepStrictEqual(linearDefinition.output, { kind: 'double' });
		assert.strictEqual(evaluateLinear({ x: 5 }), 5);
		assert.strictEqual(evaluateLinear({ x: 5, a: 2, b: 1, subtract_b: true }), 9);
		assert.throws(() => evaluateLinear({ x: 1, subtract_b: 1 as unknown as boolean }), FunctionPrimitiveError);
	});

	test('the Linear definition registers as a function_registry entry and its executor exists in Code', () => {
		const entry = createFunctionRegistryEntry(toFunctionRegistryEntryInput(linearDefinition, 0));
		assert.deepStrictEqual([entry.name, entry.executor], ['linear', 'Linear']);
		assert.deepStrictEqual(entry.constructor, linearDefinition.constructor);
		const catalog = createFunctionPrimitiveExecutorCatalog();
		validateFunctionRegistryExecutors([entry], catalog);
		assert.ok(getFunctionRegistryInsert(entry, catalog).sql.length > 0);
	});

	test('executors outside the implemented primitives are rejected and the catalog is not completed', () => {
		const catalog = createFunctionPrimitiveExecutorCatalog();
		assert.ok(catalog.has('Linear'));
		assert.ok(!catalog.has('Sin'));
		assert.deepStrictEqual(implementedFunctionPrimitives.map(d => d.executor), ['Linear']);
		const sin = createFunctionRegistryEntry({ index: 1, name: 'sin', executor: 'Sin', constructor: [], output: { kind: 'double' } });
		assert.throws(() => validateFunctionRegistryExecutors([sin], catalog), /does not exist in Code/);
	});

	test('Function Catalog lists the specified categories and primitives', () => {
		assert.deepStrictEqual(Object.keys(functionCatalog), ['Math', 'State', 'Input', 'Spatial', 'Event', 'Story', 'Data']);
		assert.deepStrictEqual(functionCatalog.Math, ['Linear', 'Sin', 'Exp', 'Logistic', 'Noise']);
		assert.deepStrictEqual(functionCatalog.Data, ['Query', 'Filter', 'Aggregate', 'Snapshot']);
	});
});
