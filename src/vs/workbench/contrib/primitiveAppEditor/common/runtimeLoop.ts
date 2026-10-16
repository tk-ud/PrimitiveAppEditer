/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function runtime execution loop (runtime.loop)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (22. Execute, 22. Loop)
 *  Boundary: App Editer.md (24. Runtime State)
 *--------------------------------------------------------------------------------------------*/

import { Composition } from './authority.js';
import { FunctionBindingExecutionKind, FunctionBindingSource, IFunctionBindingArgument } from './functionBinding.js';
import { IRuntimeExecutionPlanStep } from './runtimeExecutionPlan.js';
import { IRuntimeState } from './runtimeState.js';
import { isTargetMergeValueKind, ITargetMergeInput, mergeExecutionPlanOutputs, targetMergeKey, targetMergeValueKinds } from './targetMerge.js';

/**
 * ```text
 * Input Capture -> Current State -> Execution Plan -> Function Execute -> Target Merge -> Next State
 *
 * Resolve Input -> Dispatcher -> Value -> Target Buffer -> Merge Policy -> Next State
 * ```
 *
 * One frame reads the Current State only: `state` sources are read before any write of the frame, so
 * the result does not depend on the order in which Targets are committed. Function Outputs are the
 * only values passed within a frame (`function_output`, in Execution Plan order). Values are
 * collected in a Target Buffer, merged by the Binding's Merge Policy and committed as the Next State
 * only after the whole frame succeeded; a rejection leaves the Runtime State unchanged.
 *
 * The loop works on Memory Handles of the Execution Plan: it never queries or writes SQLite, and
 * Frame State is not Persistent Data. Rendering is the consumer of the Next State, not part of the loop.
 */

export class RuntimeLoopError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor runtime loop: ${message}`);
		this.name = 'RuntimeLoopError';
	}
}

/** Input Capture of one frame: `Input / Time / Progress / Event`. */
export interface IRuntimeFrameInput {
	readonly time: number;
	readonly progress: number;
	readonly input?: Readonly<Record<string, unknown>>;
	readonly events?: readonly unknown[];
}

/** The outcome of one frame. The Next State itself lives in the Runtime State. */
export interface IRuntimeFrameResult {
	/** `function_binding.uuid` of the bindings executed this frame, in Execution Plan order. */
	readonly executed: readonly string[];
	/** The merged value written to each Target, keyed by `table_uuid/row_uuid/column_uuid`. */
	readonly targets: ReadonlyMap<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** `execution.kind`: `tick` runs every frame, `event` when the frame carries events, `input` when it carries input. */
function isTriggered(kind: string, frame: { readonly input: Readonly<Record<string, unknown>>; readonly events: readonly unknown[] }): boolean {
	switch (kind) {
		case FunctionBindingExecutionKind.Tick:
			return true;
		case FunctionBindingExecutionKind.Event:
			return frame.events.length > 0;
		case FunctionBindingExecutionKind.Input:
			return Object.keys(frame.input).length > 0;
		default:
			throw new RuntimeLoopError(`unknown execution.kind '${kind}'`);
	}
}

/** Resolve Input: one argument -> its value for this frame. */
function resolveArgument(
	argument: IFunctionBindingArgument,
	name: string,
	step: IRuntimeExecutionPlanStep,
	handles: IRuntimeExecutionPlanStep['handles']['inputs'],
	frame: { readonly time: number; readonly progress: number; readonly input: Readonly<Record<string, unknown>>; readonly events: readonly unknown[] },
	outputs: ReadonlyMap<string, unknown>,
	where: string,
): unknown {
	switch (argument.source) {
		case FunctionBindingSource.Constant:
			return argument.value;
		case FunctionBindingSource.State:
			return handles[name].get();
		case FunctionBindingSource.Input:
			if (!Object.prototype.hasOwnProperty.call(frame.input, name)) {
				throw new RuntimeLoopError(`${where}: frame input has no value '${name}'`);
			}
			return frame.input[name];
		case FunctionBindingSource.Time:
			return frame.time;
		case FunctionBindingSource.Progress:
			return frame.progress;
		case FunctionBindingSource.Event:
			return frame.events;
		case FunctionBindingSource.FunctionOutput: {
			const producer = argument.function_binding_uuid!;
			if (!outputs.has(producer)) {
				throw new RuntimeLoopError(`${where}: function_output of binding '${producer}' is not available in this frame (it did not execute before '${step.binding.uuid}')`);
			}
			return outputs.get(producer);
		}
		default:
			throw new RuntimeLoopError(`${where}: unknown source '${String(argument.source)}'`);
	}
}

/**
 * Executes one frame against `state`: Input Capture -> Function Execute (Execution Plan order) ->
 * Target Merge -> Next State. Atomic: any rejection leaves `state` untouched.
 */
export function executeRuntimeFrame(
	state: IRuntimeState,
	plan: readonly IRuntimeExecutionPlanStep[],
	frameInput: IRuntimeFrameInput,
): IRuntimeFrameResult {
	// Input Capture.
	if (!isFiniteNumber(frameInput.time) || !isFiniteNumber(frameInput.progress)) {
		throw new RuntimeLoopError('frame time and progress must be finite numbers');
	}
	const frame = Object.freeze({
		time: frameInput.time,
		progress: frameInput.progress,
		input: Object.freeze({ ...frameInput.input }),
		events: Object.freeze([...(frameInput.events ?? [])]),
	});

	// Function Execute: Resolve Input -> Dispatcher -> Value, in Execution Plan order.
	const outputs = new Map<string, unknown>();
	const executed: IRuntimeExecutionPlanStep[] = [];
	for (const step of plan) {
		if (!isTriggered(step.binding.execution.kind, frame)) {
			continue;
		}
		const where = `binding '${step.binding.uuid}'`;
		const args: Record<string, unknown> = {};
		for (const [name, argument] of Object.entries(step.binding.inputs)) {
			args[name] = resolveArgument(argument, name, step, step.handles.inputs, frame, outputs, `${where} input '${name}'`);
		}
		for (const [name, argument] of Object.entries(step.binding.parameters)) {
			args[name] = resolveArgument(argument, name, step, step.handles.parameters, frame, outputs, `${where} parameter '${name}'`);
		}
		outputs.set(step.binding.uuid, step.instance.invoke(args));
		executed.push(step);
	}

	// Target Buffer: Base State = the Target's value in the Current State, one value kind per Target.
	const targets = new Map<string, ITargetMergeInput>();
	for (const step of executed) {
		const key = targetMergeKey(step.binding.target.address);
		const kind = step.definition.output.kind;
		if (!isTargetMergeValueKind(kind)) {
			throw new RuntimeLoopError(`binding '${step.binding.uuid}': output kind '${kind}' has no Merge Dispatch (${targetMergeValueKinds.join(' | ')})`);
		}
		const existing = targets.get(key);
		if (existing && existing.kind !== kind) {
			throw new RuntimeLoopError(`target ${key}: bindings write different value kinds ('${existing.kind}' and '${kind}')`);
		}
		if (!existing) {
			// An all-overwrite Target does not depend on its Base State, so an unset one is not a failure.
			const overwriteOnly = executed.every(other => targetMergeKey(other.binding.target.address) !== key || other.binding.target.merge.kind === Composition.Overwrite);
			const base = step.handles.target.get();
			targets.set(key, { kind, base: overwriteOnly && base === undefined ? outputs.get(step.binding.uuid) : base });
		}
	}

	// Merge Policy -> Next State (computed in full before any write).
	const merged = mergeExecutionPlanOutputs(executed, outputs, targets);
	const handles = new Map(plan.map(step => [targetMergeKey(step.binding.target.address), step.handles.target]));

	// Commit: Next State.
	state.time = frame.time;
	state.progress = frame.progress;
	state.input = { ...frame.input };
	state.events.splice(0, state.events.length, ...frame.events);
	for (const step of executed) {
		state.functions.get(step.binding.uuid)!.output = outputs.get(step.binding.uuid);
	}
	const written = new Map<string, unknown>();
	for (const result of merged) {
		const key = targetMergeKey(result.target);
		handles.get(key)!.set(result.value);
		written.set(key, result.value);
	}
	return Object.freeze({ executed: Object.freeze(executed.map(step => step.binding.uuid)), targets: written });
}

/** Holds a loaded Runtime State and its Execution Plan and advances it frame by frame. */
export class RuntimeLoop {

	constructor(
		readonly state: IRuntimeState,
		readonly plan: readonly IRuntimeExecutionPlanStep[],
	) { }

	/** Input Capture -> Execution Plan -> Function Execute -> Target Merge -> Next State. */
	step(frame: IRuntimeFrameInput): IRuntimeFrameResult {
		return executeRuntimeFrame(this.state, this.plan, frame);
	}
}
