/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - target merge (binding.merge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (21. Target Merge)
 *--------------------------------------------------------------------------------------------*/

import { Composition } from './authority.js';
import { IFunctionExecutionPlanStep } from './functionDependency.js';

/**
 * Several Function outputs may write the same Target. `Merge Policy = Binding` (`target.merge.kind`),
 * `Merge Semantics = Type Dispatcher` (by value kind), `Function = Value Producer`.
 *
 * - overwrite: each output replaces the Target value; the Execution Plan order is deterministic.
 * - overlay: Base State + Output A + Output B -> Normalize -> Type Merge -> Final State.
 * The policy is selected per Binding; bindings writing one Target may differ and apply in Execution Plan order.
 *
 * Merge Dispatch: double -> additive, vector -> additive, quaternion -> compose, bool -> overwrite, text -> overwrite.
 */

// #region Merge Dispatch

export const enum TargetMergeValueKind {
	Double = 'double',
	Vector = 'vector',
	Quaternion = 'quaternion',
	Bool = 'bool',
	Text = 'text',
}

export const targetMergeValueKinds: readonly TargetMergeValueKind[] = Object.freeze([
	TargetMergeValueKind.Double,
	TargetMergeValueKind.Vector,
	TargetMergeValueKind.Quaternion,
	TargetMergeValueKind.Bool,
	TargetMergeValueKind.Text,
]);

export function isTargetMergeValueKind(value: unknown): value is TargetMergeValueKind {
	return (targetMergeValueKinds as readonly unknown[]).includes(value);
}

/** Type Merge semantics a value kind dispatches to under `overlay`. */
export const enum TargetMergeSemantics {
	Additive = 'additive',
	Compose = 'compose',
	Overwrite = 'overwrite',
}

const mergeDispatch: Readonly<Record<TargetMergeValueKind, TargetMergeSemantics>> = Object.freeze({
	[TargetMergeValueKind.Double]: TargetMergeSemantics.Additive,
	[TargetMergeValueKind.Vector]: TargetMergeSemantics.Additive,
	[TargetMergeValueKind.Quaternion]: TargetMergeSemantics.Compose,
	[TargetMergeValueKind.Bool]: TargetMergeSemantics.Overwrite,
	[TargetMergeValueKind.Text]: TargetMergeSemantics.Overwrite,
});

export function dispatchTargetMerge(kind: TargetMergeValueKind): TargetMergeSemantics {
	return mergeDispatch[kind];
}

export class TargetMergeError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor target merge: ${message}`);
		this.name = 'TargetMergeError';
	}
}

export type TargetMergeValue = number | boolean | string | readonly number[];

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown, length?: number): value is readonly number[] {
	return Array.isArray(value) && (length === undefined || value.length === length) && value.every(isFiniteNumber);
}

/** Normalize: validates the value against its kind; a quaternion is normalized to unit length. */
export function normalizeTargetMergeValue(kind: TargetMergeValueKind, value: unknown, where: string): TargetMergeValue {
	switch (kind) {
		case TargetMergeValueKind.Double:
			if (!isFiniteNumber(value)) {
				throw new TargetMergeError(`${where}: double must be a finite number`);
			}
			return value;
		case TargetMergeValueKind.Vector:
			if (!isNumberArray(value) || value.length === 0) {
				throw new TargetMergeError(`${where}: vector must be a non-empty array of finite numbers`);
			}
			return Object.freeze([...value]);
		case TargetMergeValueKind.Quaternion: {
			if (!isNumberArray(value, 4)) {
				throw new TargetMergeError(`${where}: quaternion must be [x, y, z, w] of finite numbers`);
			}
			const length = Math.hypot(value[0], value[1], value[2], value[3]);
			if (length === 0) {
				throw new TargetMergeError(`${where}: quaternion must not be zero`);
			}
			return Object.freeze(value.map(component => component / length));
		}
		case TargetMergeValueKind.Bool:
			if (typeof value !== 'boolean') {
				throw new TargetMergeError(`${where}: bool must be a boolean`);
			}
			return value;
		case TargetMergeValueKind.Text:
			if (typeof value !== 'string') {
				throw new TargetMergeError(`${where}: text must be a string`);
			}
			return value;
		default:
			throw new TargetMergeError(`${where}: unknown value kind '${String(kind)}'`);
	}
}

/** Hamilton product `a * b` of two [x, y, z, w] quaternions. */
function composeQuaternion(a: readonly number[], b: readonly number[]): readonly number[] {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

/**
 * Type Merge of one normalized overlay value into the running state:
 * double / vector `state + overlay`, quaternion `state * overlay` (compose), bool / text `overlay` replaces.
 */
function mergeOverlayValue(kind: TargetMergeValueKind, state: TargetMergeValue, overlay: TargetMergeValue, where: string): TargetMergeValue {
	switch (dispatchTargetMerge(kind)) {
		case TargetMergeSemantics.Additive:
			if (typeof state === 'number') {
				return state + (overlay as number);
			}
			if ((state as readonly number[]).length !== (overlay as readonly number[]).length) {
				throw new TargetMergeError(`${where}: vector length ${(overlay as readonly number[]).length} does not match ${(state as readonly number[]).length}`);
			}
			return Object.freeze((state as readonly number[]).map((component, i) => component + (overlay as readonly number[])[i]));
		case TargetMergeSemantics.Compose:
			return composeQuaternion(state as readonly number[], overlay as readonly number[]);
		default:
			return overlay;
	}
}

export interface ITargetMergeOutput {
	/** `target.merge.kind` of the binding that produced the value. */
	readonly merge: Composition | string;
	readonly value: unknown;
}

/**
 * Merges the outputs written to one Target. The Merge Policy is per Binding: each output is applied in
 * the given (Execution Plan) order to the running state starting at the Base State, with its own policy:
 * `overwrite` replaces the state, `overlay` normalizes and applies the Type Merge of the value kind.
 * No output leaves the Base State. Non-finite results (an additive overflow) are rejected.
 */
export function mergeTargetOutputs(
	kind: TargetMergeValueKind,
	base: unknown,
	outputs: readonly ITargetMergeOutput[],
	where = 'target',
): TargetMergeValue {
	let state = normalizeTargetMergeValue(kind, base, `${where} base`);
	outputs.forEach((output, i) => {
		if (output.merge !== Composition.Overwrite && output.merge !== Composition.Overlay) {
			throw new TargetMergeError(`${where} output[${i}]: merge.kind must be one of overwrite | overlay`);
		}
		const value = normalizeTargetMergeValue(kind, output.value, `${where} output[${i}]`);
		state = output.merge === Composition.Overwrite ? value : mergeOverlayValue(kind, state, value, `${where} output[${i}]`);
		normalizeTargetMergeValue(kind, state, `${where} output[${i}] result`);
	});
	return state;
}

/** Applies one policy to all `outputs` (already in Execution Plan order). */
export function mergeTargetValues(
	merge: Composition | string,
	kind: TargetMergeValueKind,
	base: unknown,
	outputs: readonly unknown[],
	where = 'target',
): TargetMergeValue {
	if (merge !== Composition.Overwrite && merge !== Composition.Overlay) {
		throw new TargetMergeError(`${where}: merge.kind must be one of overwrite | overlay`);
	}
	return mergeTargetOutputs(kind, base, outputs.map(value => ({ merge, value })), where);
}

// #endregion

// #region Execution Plan integration

export interface ITargetMergeInput {
	/** Value kind of the Target column. */
	readonly kind: TargetMergeValueKind;
	/** Base State of the Target. */
	readonly base: unknown;
}

export interface ITargetMergeResult {
	readonly target: { readonly table_uuid: string; readonly row_uuid: string; readonly column_uuid: string };
	readonly value: TargetMergeValue;
	/** `function_binding.uuid` of the contributing outputs, in Execution Plan order. */
	readonly bindings: readonly string[];
	/** `target.merge.kind` of each contributing binding (aligned with `bindings`). */
	readonly merges: readonly Composition[];
}

export function targetMergeKey(address: { readonly table_uuid: string; readonly row_uuid: string; readonly column_uuid: string }): string {
	return `${address.table_uuid}/${address.row_uuid}/${address.column_uuid}`;
}

/**
 * Groups the outputs of an Execution Plan by Target and applies the Target's Merge Policy.
 * Each binding applies its own `merge.kind` to its output, in Execution Plan order.
 * `outputs` is keyed by `function_binding.uuid`; a missing output means the binding did not run and contributes nothing.
 * `targets` is keyed by {@link targetMergeKey}. Results are in first-writer Execution Plan order.
 */
export function mergeExecutionPlanOutputs(
	plan: readonly IFunctionExecutionPlanStep[],
	outputs: ReadonlyMap<string, unknown>,
	targets: ReadonlyMap<string, ITargetMergeInput>,
): readonly ITargetMergeResult[] {
	const groups = new Map<string, { address: ITargetMergeResult['target']; bindings: string[]; merges: Composition[]; values: unknown[] }>();
	for (const { binding } of plan) {
		const address = binding.target.address;
		const key = targetMergeKey(address);
		let group = groups.get(key);
		if (!group) {
			group = { address, bindings: [], merges: [], values: [] };
			groups.set(key, group);
		}
		if (outputs.has(binding.uuid)) {
			group.bindings.push(binding.uuid);
			group.merges.push(binding.target.merge.kind);
			group.values.push(outputs.get(binding.uuid));
		}
	}
	const results: ITargetMergeResult[] = [];
	for (const [key, group] of groups) {
		const input = targets.get(key);
		if (!input) {
			throw new TargetMergeError(`target ${key}: no value kind / base state supplied`);
		}
		results.push(Object.freeze({
			target: group.address,
			value: mergeTargetOutputs(input.kind, input.base, group.values.map((value, i) => ({ merge: group.merges[i], value })), `target ${key}`),
			bindings: Object.freeze(group.bindings),
			merges: Object.freeze(group.merges),
		}));
	}
	return Object.freeze(results);
}

// #endregion
