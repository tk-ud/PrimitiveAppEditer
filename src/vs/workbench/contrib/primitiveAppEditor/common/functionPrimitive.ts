/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function primitive contract and initial catalog (function.primitive)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (15. Function Definition Contract, 16. Linear, 17. Function Catalog)
 *--------------------------------------------------------------------------------------------*/

import {
	createFunctionExecutorCatalog,
	IFunctionExecutorCatalog,
	IFunctionRegistryArgument,
	IFunctionRegistryEntryInput,
	IFunctionRegistryInput,
	IFunctionRegistryOutput,
} from './functionRegistry.js';

/**
 * `Function Primitive = Code`. Each primitive carries the Function Definition Contract fields
 * (name, formula, constructor, signature, input, parameters, output, implementation). The
 * Registry (`function_registry`) holds only the registrable part of it; `formula`, `signature`
 * and `implementation` live in Code and are never completed from, or into, the Registry.
 */

// #region Contract

/** One Function Definition Contract record of a primitive implemented in Code. */
export interface IFunctionPrimitiveDefinition {
	readonly name: string;
	/** Registry `executor`: the Code class that runs the primitive. */
	readonly executor: string;
	readonly formula: string;
	readonly signature: string;
	readonly input: readonly IFunctionRegistryInput[];
	readonly constructor: readonly IFunctionRegistryArgument[];
	readonly parameters: readonly IFunctionRegistryArgument[];
	readonly output: IFunctionRegistryOutput;
}

export class FunctionPrimitiveError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor function primitive: ${message}`);
		this.name = 'FunctionPrimitiveError';
	}
}

/**
 * The Registry input of a primitive definition. Only executor / input / constructor / parameters /
 * output are taken over; formula / signature / implementation stay in Code.
 */
export function toFunctionRegistryEntryInput(definition: IFunctionPrimitiveDefinition, index: number): IFunctionRegistryEntryInput {
	return {
		index,
		name: definition.name,
		executor: definition.executor,
		input: definition.input,
		constructor: definition.constructor,
		parameters: definition.parameters,
		output: definition.output,
	};
}

// #endregion

// #region Linear

/**
 * Linear: `y = ax + b`; with `subtract_b` the runtime formula is `y = ax - b`.
 * `Linear(subtractB)`, `Evaluate(a, x, b) -> double`.
 */
export class Linear {

	private readonly _subtractB: boolean;

	constructor(subtractB: boolean) {
		this._subtractB = subtractB;
	}

	evaluate(a: number, x: number, b: number): number {
		return a * x + (this._subtractB ? -b : b);
	}
}

export const linearDefinition: IFunctionPrimitiveDefinition = Object.freeze({
	name: 'linear',
	executor: 'Linear',
	formula: 'y = ax + b',
	signature: 'Linear(subtractB); Evaluate(a, x, b) -> double',
	input: Object.freeze([Object.freeze({ name: 'x', kind: 'double' })]),
	constructor: Object.freeze([Object.freeze({ name: 'subtract_b', kind: 'bool', default: false })]),
	parameters: Object.freeze([
		Object.freeze({ name: 'a', kind: 'double', default: 1 }),
		Object.freeze({ name: 'b', kind: 'double', default: 0 }),
	]),
	output: Object.freeze({ kind: 'double' }),
});

/** Evaluates a Linear with the Registry-shaped arguments; absent values take the Registry defaults. */
export function evaluateLinear(values: { readonly subtract_b?: boolean; readonly a?: number; readonly x: number; readonly b?: number }): number {
	const subtractB = values.subtract_b ?? false;
	if (typeof subtractB !== 'boolean') {
		throw new FunctionPrimitiveError('linear: subtract_b must be a bool');
	}
	return new Linear(subtractB).evaluate(values.a ?? 1, values.x, values.b ?? 0);
}

// #endregion

// #region Catalog

/** Function Catalog categories and primitive names (the catalog list ends with an open `...`). */
export const functionCatalog: Readonly<Record<string, readonly string[]>> = Object.freeze({
	Math: Object.freeze(['Linear', 'Sin', 'Exp', 'Logistic', 'Noise']),
	State: Object.freeze(['Set', 'Add', 'Clamp', 'Toggle', 'Compare']),
	Input: Object.freeze(['Key', 'Axis', 'Pointer', 'Action']),
	Spatial: Object.freeze(['Move', 'Rotate', 'Scale', 'Distance']),
	Event: Object.freeze(['Trigger', 'Gate', 'Delay', 'Repeat']),
	Story: Object.freeze(['Dialogue', 'Choice', 'Branch', 'Flag']),
	Data: Object.freeze(['Query', 'Filter', 'Aggregate', 'Snapshot']),
});

/**
 * Primitives whose Function Definition Contract is specified and implemented in Code. Catalog
 * names without an entry here have no definition yet and are not completed.
 */
export const implementedFunctionPrimitives: readonly IFunctionPrimitiveDefinition[] = Object.freeze([linearDefinition]);

/** The `executor` names that exist in Code, for `function_registry` validation. */
export function createFunctionPrimitiveExecutorCatalog(): IFunctionExecutorCatalog {
	return createFunctionExecutorCatalog(implementedFunctionPrimitives.map(definition => definition.executor));
}

// #endregion
