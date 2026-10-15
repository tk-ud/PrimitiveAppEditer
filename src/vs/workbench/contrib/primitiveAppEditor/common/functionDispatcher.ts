/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function dispatcher (function.dispatcher)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (18. Function Dispatcher)
 *--------------------------------------------------------------------------------------------*/

import { evaluateLinear } from './functionPrimitive.js';

/**
 * Dispatcher = Function Name Resolve -> Primitive Select -> Argument Dispatch -> Output Return.
 * `Dispatcher != Execution Planner`: it holds no Execution Order, no scheduling and no state; it
 * runs exactly the one primitive named by the call.
 */

/** Registry-shaped arguments (constructor / input / parameters values keyed by their Registry names). */
export type FunctionArguments = Readonly<Record<string, unknown>>;

export class UnknownFunctionException extends Error {
	readonly functionName: string;

	constructor(functionName: string) {
		super(`Primitive App Editor function dispatcher: unknown function '${functionName}'`);
		this.name = 'UnknownFunctionException';
		this.functionName = functionName;
	}
}

type FunctionExecutor = (args: FunctionArguments) => unknown;

/**
 * Primitive Select table: function name -> executor. Only primitives implemented in Code
 * (`implementedFunctionPrimitives`) are listed; `sin` / `exp` have no definition yet and resolve
 * to UnknownFunctionException instead of being completed.
 */
const executors: ReadonlyMap<string, FunctionExecutor> = new Map<string, FunctionExecutor>([
	['linear', executeLinear],
]);

function executeLinear(args: FunctionArguments): number {
	// Argument Dispatch: the values are forwarded as the Registry-shaped arguments of Linear.
	return evaluateLinear(args as Parameters<typeof evaluateLinear>[0]);
}

export function dispatch(functionName: string, args: FunctionArguments): unknown {
	const executor = executors.get(functionName);
	if (!executor) {
		throw new UnknownFunctionException(functionName);
	}
	return executor(args);
}
