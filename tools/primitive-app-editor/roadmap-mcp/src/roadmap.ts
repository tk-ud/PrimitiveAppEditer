/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';

export type BundleStatus = 'not started' | 'partial' | 'implemented';
export type ReferenceRole = 'implementation' | 'boundary';

export interface IBundleReference {
	readonly source: string;
	readonly role: ReferenceRole;
	readonly sections: readonly string[];
}

export interface IBundle {
	readonly id: string;
	readonly title: string;
	readonly reference: readonly IBundleReference[];
	readonly depends_on: readonly string[];
	readonly status: BundleStatus;
	readonly evidence: readonly string[];
	readonly remaining: readonly string[];
}

/**
 * A loaded roadmap: the raw YAML text, its parsed JS value, and the executable
 * bundles flattened in "section order" then "bundle order".
 */
export interface IRoadmap {
	readonly path: string;
	readonly text: string;
	readonly data: Record<string, unknown>;
	readonly bundles: readonly IBundle[];
}

export class RoadmapError extends Error {
	constructor(message: string, readonly details: readonly string[] = []) {
		super(details.length ? `${message}\n- ${details.join('\n- ')}` : message);
	}
}

const statusValues: readonly BundleStatus[] = ['not started', 'partial', 'implemented'];
const roleValues: readonly ReferenceRole[] = ['implementation', 'boundary'];

/**
 * Default roadmap location: docs/primitive-app-editor/roadmap.yaml in the repository
 * that contains this tool (tools/primitive-app-editor/roadmap-mcp/out/*.js).
 */
export function defaultRoadmapPath(): string {
	return path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'primitive-app-editor', 'roadmap.yaml');
}

/**
 * read_yaml: load and structurally validate roadmap.yaml.
 */
export function loadRoadmap(roadmapPath: string): IRoadmap {
	const text = fs.readFileSync(roadmapPath, 'utf8');
	return parseRoadmap(roadmapPath, text);
}

export function parseRoadmap(roadmapPath: string, text: string): IRoadmap {
	const document = parseDocument(text);
	if (document.errors.length) {
		throw new RoadmapError(`Failed to parse ${roadmapPath}`, document.errors.map(e => e.message));
	}
	const data = document.toJS();
	if (!isRecord(data) || !Array.isArray(data.section)) {
		throw new RoadmapError(`Invalid roadmap ${roadmapPath}: top-level 'section' list is missing`);
	}

	const problems: string[] = [];
	const bundles: IBundle[] = [];
	data.section.forEach((section: unknown, sectionIndex: number) => {
		if (!isRecord(section) || !Array.isArray(section.bundle)) {
			problems.push(`section[${sectionIndex}] has no 'bundle' list`);
			return;
		}
		section.bundle.forEach((bundle: unknown, bundleIndex: number) => {
			const where = `section[${sectionIndex}].bundle[${bundleIndex}]`;
			const parsed = toBundle(bundle, where, problems);
			if (parsed) {
				bundles.push(parsed);
			}
		});
	});

	const ids = new Set<string>();
	for (const bundle of bundles) {
		if (ids.has(bundle.id)) {
			problems.push(`duplicate bundle id '${bundle.id}'`);
		}
		ids.add(bundle.id);
	}
	for (const bundle of bundles) {
		for (const dependency of bundle.depends_on) {
			if (!ids.has(dependency)) {
				problems.push(`bundle '${bundle.id}' depends_on unknown bundle '${dependency}'`);
			}
		}
	}

	if (problems.length) {
		throw new RoadmapError(`Invalid roadmap ${roadmapPath}`, problems);
	}
	return { path: roadmapPath, text, data, bundles };
}

function toBundle(value: unknown, where: string, problems: string[]): IBundle | undefined {
	if (!isRecord(value)) {
		problems.push(`${where} is not a mapping`);
		return undefined;
	}
	const before = problems.length;
	const id = value.id;
	const title = value.title;
	const status = value.status;
	if (typeof id !== 'string' || !id) {
		problems.push(`${where}.id must be a non-empty string`);
	}
	if (typeof title !== 'string') {
		problems.push(`${where}.title must be a string`);
	}
	if (typeof status !== 'string' || !statusValues.includes(status as BundleStatus)) {
		problems.push(`${where}.status must be one of ${statusValues.map(s => `'${s}'`).join(', ')}`);
	}
	for (const key of ['depends_on', 'evidence', 'remaining'] as const) {
		if (!isStringArray(value[key])) {
			problems.push(`${where}.${key} must be a list of strings`);
		}
	}
	const reference: IBundleReference[] = [];
	if (!Array.isArray(value.reference)) {
		problems.push(`${where}.reference must be a list`);
	} else {
		value.reference.forEach((item: unknown, index: number) => {
			const at = `${where}.reference[${index}]`;
			if (!isRecord(item) || typeof item.source !== 'string' || !roleValues.includes(item.role as ReferenceRole) || !isStringArray(item.sections)) {
				problems.push(`${at} must have string 'source', role 'implementation' | 'boundary' and a 'sections' list of strings`);
				return;
			}
			reference.push({ source: item.source, role: item.role as ReferenceRole, sections: item.sections });
		});
	}
	if (problems.length !== before) {
		return undefined;
	}
	return {
		id: id as string,
		title: title as string,
		reference,
		depends_on: value.depends_on as string[],
		status: status as BundleStatus,
		evidence: value.evidence as string[],
		remaining: value.remaining as string[],
	};
}

export type SelectionResult =
	| { readonly kind: 'selected'; readonly bundle: IBundle }
	| { readonly kind: 'completed' }
	| { readonly kind: 'blocked' };

/**
 * collect_candidates -> resolve_dependencies -> select_first (section order, bundle order).
 */
export function selectBundle(roadmap: IRoadmap): SelectionResult {
	const candidates = roadmap.bundles.filter(bundle => bundle.status !== 'implemented');
	if (!candidates.length) {
		return { kind: 'completed' };
	}
	const executable = candidates.filter(bundle => dependenciesImplemented(roadmap, bundle));
	if (!executable.length) {
		return { kind: 'blocked' };
	}
	return { kind: 'selected', bundle: executable[0] };
}

export function findBundle(roadmap: IRoadmap, id: string): IBundle | undefined {
	return roadmap.bundles.find(bundle => bundle.id === id);
}

export function dependenciesImplemented(roadmap: IRoadmap, bundle: IBundle): boolean {
	return bundle.depends_on.every(dependency => findBundle(roadmap, dependency)?.status === 'implemented');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}
