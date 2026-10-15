/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function dispatcher (function.dispatcher)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (18. Function Dispatcher)
 *--------------------------------------------------------------------------------------------*/

import { evaluateLinear } from './functionPrimitive.js';

/**
 * Dispatcher: Function Name Resolve -> Primitive Select -> Argument Dispatch -> Output Return.
 * It holds no Execution Order and is not an Execution Planner.
 */

/** Registry-shaped arguments (constructor / parameter / input values by name) handed to a primitive. */
export type FunctionArguments = Readonly<Record<string, unknown>>;

export class UnknownFunctionException extends Error {
	constructor(readonly functionName: string) {
		super(`Primitive App Editor function dispatcher: unknown function '${functionName}'`);
		this.name = 'UnknownFunctionException';
	}
}

function requireNumber(functionName: string, args: FunctionArguments, name: string, required: boolean): number | undefined {
	const value = args[name];
	if (value === undefined && !required) {
		return undefined;
	}
	if (typeof value !== 'number') {
		throw new TypeError(`Primitive App Editor function dispatcher: ${functionName}: ${name} must be a number`);
	}
	return value;
}

function executeLinear(args: FunctionArguments): number {
	return evaluateLinear({
		subtract_b: args['subtract_b'] as boolean | undefined,
		a: requireNumber('linear', args, 'a', false),
		x: requireNumber('linear', args, 'x', true)!,
		b: requireNumber('linear', args, 'b', false),
	});
}

/** Dispatch table: function name -> primitive execution. Only primitives implemented in Code are listed. */
const executors: ReadonlyMap<string, (args: FunctionArguments) => unknown> = new Map([
	['linear', executeLinear],
]);

export function dispatchFunction(functionName: string, args: FunctionArguments): unknown {
	const execute = executors.get(functionName);
	if (!execute) {
		throw new UnknownFunctionException(functionName);
	}
	return execute(args);
}
