/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { isMap, isScalar, isSeq, parseDocument, YAMLMap } from 'yaml';
import { z } from 'zod/v4';
import { BundleStatus, dependenciesImplemented, findBundle, IBundle, IRoadmap, isRecord, loadRoadmap, parseRoadmap, RoadmapError, selectBundle } from './roadmap';

/**
 * roadmap.complete input (additional_properties: false).
 */
export const completeInputSchema = z.object({
	id: z.string().describe('Bundle id defined in roadmap.yaml'),
	status: z.enum(['partial', 'implemented']),
	evidence: z.array(z.string()).describe('Concrete implementation and verification evidence. Prefer files, tests, commands, behavior, or commit references.'),
	remaining: z.array(z.string()).describe('Explicit unfinished work. Must be empty when status is implemented.'),
}).strict();

export type CompleteInput = z.infer<typeof completeInputSchema>;

export interface ICompleteOutput {
	readonly id: string;
	readonly status: 'partial' | 'implemented';
	readonly next_action: 'restart' | 'completed' | 'blocked';
	readonly message: string;
}

export interface IViolation {
	readonly rule: string;
	readonly message: string;
}

export class CompleteValidationError extends Error {
	constructor(readonly violations: readonly IViolation[]) {
		super(`roadmap.complete validation failed:\n- ${violations.map(v => `${v.rule}: ${v.message}`).join('\n- ')}`);
	}
}

const statusTransition: Readonly<Record<BundleStatus, readonly BundleStatus[]>> = {
	'not started': ['partial', 'implemented'],
	'partial': ['partial', 'implemented'],
	'implemented': ['implemented'],
};

/**
 * roadmap.complete: validate and persist progress for one roadmap bundle.
 */
export function roadmapComplete(roadmapPath: string, rawInput: unknown): ICompleteOutput {
	const parsedInput = completeInputSchema.safeParse(rawInput);
	if (!parsedInput.success) {
		throw new CompleteValidationError(parsedInput.error.issues.map(issue => ({ rule: 'input_schema', message: `${issue.path.join('.') || '(input)'}: ${issue.message}` })));
	}
	const input = parsedInput.data;

	// load_roadmap / resolve_bundle / validate
	const roadmap = loadRoadmap(roadmapPath);
	const bundle = findBundle(roadmap, input.id);
	if (!bundle) {
		throw new CompleteValidationError([{ rule: 'bundle_exists', message: `bundle '${input.id}' is not defined in roadmap.yaml` }]);
	}
	const violations = validate(roadmap, bundle, input);
	if (violations.length) {
		throw new CompleteValidationError(violations);
	}

	// update_status / update_evidence / update_remaining
	const updatedText = updateBundleText(roadmap, input);
	const updated = verifyUpdate(roadmap, updatedText, input);

	// save
	atomicWrite(roadmap.path, roadmap.text, updatedText);

	const selection = selectBundle(updated);
	const nextAction = selection.kind === 'selected' ? 'restart' : selection.kind;
	return {
		id: input.id,
		status: input.status,
		next_action: nextAction,
		message: nextAction === 'restart'
			? `Bundle '${input.id}' recorded as ${input.status}. Call roadmap.next again (next executable bundle: '${(selection as { bundle: IBundle }).bundle.id}').`
			: nextAction === 'completed'
				? `Bundle '${input.id}' recorded as ${input.status}. All executable roadmap bundles are implemented.`
				: `Bundle '${input.id}' recorded as ${input.status}. Unimplemented roadmap bundles exist, but none currently satisfy their dependencies.`,
	};
}

function validate(roadmap: IRoadmap, bundle: IBundle, input: CompleteInput): IViolation[] {
	const violations: IViolation[] = [];
	if (bundle.status === 'implemented') {
		violations.push({ rule: 'current_status_is_not_implemented', message: `bundle '${bundle.id}' is already implemented` });
	}
	// depends_on_unchanged: the input cannot carry depends_on (strict input schema) and the
	// written roadmap is re-verified so that depends_on (and every other field) is unchanged.
	if (!dependenciesImplemented(roadmap, bundle)) {
		const pending = bundle.depends_on.filter(dependency => findBundle(roadmap, dependency)?.status !== 'implemented');
		violations.push({ rule: 'dependencies_are_implemented', message: `depends_on bundles are not implemented: ${pending.join(', ')}` });
	}
	if (!input.evidence.length || input.evidence.some(item => !item.trim())) {
		violations.push({ rule: 'evidence_not_empty', message: 'evidence must contain at least one non-empty item' });
	}
	if (input.status === 'implemented' && input.remaining.length) {
		violations.push({ rule: 'implemented_requires_empty_remaining', message: 'remaining must be empty when status is implemented' });
	}
	if (input.status === 'partial' && (!input.remaining.length || input.remaining.some(item => !item.trim()))) {
		violations.push({ rule: 'partial_requires_non_empty_remaining', message: 'remaining must contain at least one non-empty item when status is partial' });
	}
	if (!statusTransition[bundle.status].includes(input.status)) {
		violations.push({ rule: 'status_transition', message: `transition '${bundle.status}' -> '${input.status}' is not allowed` });
	}
	return violations;
}

/**
 * Replace only the text of the selected bundle's status / evidence / remaining values,
 * keeping every other byte of roadmap.yaml as is (no re-serialization of the document).
 */
function updateBundleText(roadmap: IRoadmap, input: CompleteInput): string {
	const document = parseDocument(roadmap.text);
	const bundleNode = findBundleNode(document.get('section'), input.id);
	const values: Record<'status' | 'evidence' | 'remaining', string | readonly string[]> = {
		status: input.status,
		evidence: input.evidence,
		remaining: input.remaining,
	};

	const edits = (Object.keys(values) as (keyof typeof values)[]).map(key => {
		const pair = bundleNode.items.find(item => isScalar(item.key) && item.key.value === key);
		if (!pair || !isScalar(pair.key) || !pair.key.range || !pair.value || !(isScalar(pair.value) || isSeq(pair.value)) || !(pair.value as { range?: unknown }).range) {
			throw new RoadmapError(`Bundle '${input.id}' has no editable '${key}' entry`);
		}
		const start = pair.key.range[0];
		const end = (pair.value as { range: [number, number, number] }).range[1];
		const lineStart = roadmap.text.lastIndexOf('\n', start - 1) + 1;
		const indent = ' '.repeat(start - lineStart);
		const keepNewline = roadmap.text.slice(start, end).endsWith('\n');
		return { start, end, text: renderEntry(key, values[key], indent) + (keepNewline ? '\n' : '') };
	}).sort((a, b) => b.start - a.start);

	let text = roadmap.text;
	for (const edit of edits) {
		text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
	}
	return text;
}

function findBundleNode(sections: unknown, id: string): YAMLMap {
	if (isSeq(sections)) {
		for (const section of sections.items) {
			const bundles = isMap(section) ? section.get('bundle') : undefined;
			if (isSeq(bundles)) {
				for (const bundle of bundles.items) {
					if (isMap(bundle) && bundle.get('id') === id) {
						return bundle;
					}
				}
			}
		}
	}
	throw new RoadmapError(`Bundle '${id}' was not found in the roadmap document`);
}

function renderEntry(key: string, value: string | readonly string[], indent: string): string {
	if (typeof value === 'string') {
		return `${key}: ${JSON.stringify(value)}`;
	}
	if (!value.length) {
		return `${key}: []`;
	}
	return [`${key}:`, ...value.map(item => `${indent}  - ${JSON.stringify(item)}`)].join('\n');
}

/**
 * Re-parse the updated text and require it to equal the original roadmap with only the
 * selected bundle's status / evidence / remaining replaced.
 */
function verifyUpdate(roadmap: IRoadmap, updatedText: string, input: CompleteInput): IRoadmap {
	const updated = parseRoadmap(roadmap.path, updatedText);
	const expected = structuredClone(roadmap.data);
	const sections = expected.section as Record<string, unknown>[];
	for (const section of sections) {
		for (const bundle of section.bundle as Record<string, unknown>[]) {
			if (isRecord(bundle) && bundle.id === input.id) {
				bundle.status = input.status;
				bundle.evidence = [...input.evidence];
				bundle.remaining = [...input.remaining];
			}
		}
	}
	if (!isDeepStrictEqual(updated.data, expected)) {
		throw new RoadmapError(`Refusing to write roadmap: the update would change content other than bundle '${input.id}' status / evidence / remaining`);
	}
	return updated;
}

/**
 * atomic_write_yaml: write to a temporary file in the same directory and rename it over
 * roadmap.yaml. Fails if roadmap.yaml changed since it was read.
 */
function atomicWrite(target: string, expectedCurrent: string, text: string): void {
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
	const handle = fs.openSync(temporary, 'wx');
	try {
		fs.writeFileSync(handle, text, 'utf8');
		fs.fsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
	try {
		if (fs.readFileSync(target, 'utf8') !== expectedCurrent) {
			throw new RoadmapError(`Refusing to write roadmap: ${target} changed while roadmap.complete was running`);
		}
		const mode = fs.statSync(target).mode;
		fs.chmodSync(temporary, mode);
		fs.renameSync(temporary, target);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}
