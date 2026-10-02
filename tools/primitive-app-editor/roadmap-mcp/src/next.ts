/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { resolveSections, SectionResolutionError } from './markdown';
import { nextPromptTemplate } from './promptTemplate';
import { BundleStatus, IBundle, IBundleReference, IRoadmap, loadRoadmap, ReferenceRole, RoadmapError, selectBundle } from './roadmap';

export interface ISpecification {
	readonly source: string;
	readonly role: ReferenceRole;
	readonly sections: readonly string[];
	readonly content: string;
}

export interface INextBundle {
	readonly id: string;
	readonly title: string;
	readonly status: Exclude<BundleStatus, 'implemented'>;
	readonly depends_on: readonly string[];
	readonly reference: readonly IBundleReference[];
}

export interface IReferenceConflict {
	readonly source: string;
	readonly section: string;
	readonly heading: string;
}

export type NextOutput =
	| { readonly id: string; readonly prompt: string; readonly bundle: INextBundle; readonly specifications: readonly ISpecification[] }
	| { readonly status: 'completed'; readonly message: string }
	| { readonly status: 'blocked'; readonly message: string; readonly id?: string; readonly conflicts?: readonly IReferenceConflict[] };

export const noCandidateMessage = 'All executable roadmap bundles are implemented.';
export const blockedMessage = 'Unimplemented roadmap bundles exist, but none currently satisfy their dependencies.';
export const conflictMessage = 'Referenced specifications conflict; implementation was not started.';

/**
 * roadmap.next: resolve the next executable bundle and construct the implementation prompt.
 */
export function roadmapNext(roadmapPath: string): NextOutput {
	return nextFromRoadmap(loadRoadmap(roadmapPath));
}

export function nextFromRoadmap(roadmap: IRoadmap): NextOutput {
	// collect_candidates / resolve_dependencies / select_bundle
	const selection = selectBundle(roadmap);
	if (selection.kind === 'completed') {
		return { status: 'completed', message: noCandidateMessage };
	}
	if (selection.kind === 'blocked') {
		return { status: 'blocked', message: blockedMessage };
	}
	const bundle = selection.bundle;

	// specifications (preserve_order, preserve_source, preserve_role)
	const { specifications, conflicts } = readSpecifications(roadmap, bundle);

	// validate_specification_set
	if (conflicts.length) {
		return { status: 'blocked', message: conflictMessage, id: bundle.id, conflicts };
	}

	// implementation_specifications / boundary_constraints
	const implementationSpecifications = specifications.filter(specification => specification.role === 'implementation');
	const boundaryConstraints = specifications.filter(specification => specification.role === 'boundary');

	// render_prompt
	const prompt = renderTemplate(nextPromptTemplate, {
		bundle: { id: bundle.id, title: bundle.title, status: bundle.status, depends_on: bundle.depends_on, evidence: bundle.evidence, remaining: bundle.remaining },
		implementation_specifications: implementationSpecifications,
		boundary_constraints: boundaryConstraints,
	});

	return {
		id: bundle.id,
		prompt,
		bundle: {
			id: bundle.id,
			title: bundle.title,
			status: bundle.status as INextBundle['status'],
			depends_on: bundle.depends_on,
			reference: bundle.reference,
		},
		specifications,
	};
}

interface IResolvedReference {
	readonly key: string;
	readonly role: ReferenceRole;
	readonly source: string;
	readonly section: string;
	readonly heading: string;
}

function readSpecifications(roadmap: IRoadmap, bundle: IBundle): { specifications: ISpecification[]; conflicts: IReferenceConflict[] } {
	const roadmapDirectory = path.dirname(roadmap.path);
	const problems: string[] = [];
	const resolved: IResolvedReference[] = [];

	const specifications = bundle.reference.map(reference => {
		const file = path.resolve(roadmapDirectory, reference.source);
		let markdown: string;
		try {
			markdown = fs.readFileSync(file, 'utf8');
		} catch {
			problems.push(`${reference.source}: specification file not found (${file})`);
			return undefined;
		}
		const contents: string[] = [];
		for (const section of reference.sections) {
			try {
				const [result] = resolveSections(markdown, [section]);
				contents.push(result.content);
				resolved.push({ key: `${file}#${result.heading.line}`, role: reference.role, source: reference.source, section, heading: result.heading.text });
			} catch (error) {
				if (error instanceof SectionResolutionError) {
					problems.push(`${reference.source} ${error.message}`);
				} else {
					throw error;
				}
			}
		}
		return { source: reference.source, role: reference.role, sections: reference.sections, content: contents.join('\n\n') };
	});

	if (problems.length) {
		throw new RoadmapError(`Bundle '${bundle.id}' references specification sections that cannot be resolved deterministically`, problems);
	}

	return { specifications: specifications as ISpecification[], conflicts: detectReferenceConflicts(resolved) };
}

/**
 * detect_reference_conflict: the same resolved heading of the same source file is
 * referenced both as an implementation and as a boundary of the selected bundle.
 */
function detectReferenceConflicts(resolved: readonly IResolvedReference[]): IReferenceConflict[] {
	const conflicts: IReferenceConflict[] = [];
	const seen = new Set<string>();
	for (const item of resolved) {
		if (seen.has(item.key)) {
			continue;
		}
		const same = resolved.filter(other => other.key === item.key);
		if (same.some(other => other.role === 'implementation') && same.some(other => other.role === 'boundary')) {
			seen.add(item.key);
			conflicts.push({ source: item.source, section: item.section, heading: item.heading });
		}
	}
	return conflicts;
}

type TemplateValue = string | readonly string[] | readonly object[] | object;
type TemplateRecord = object;

const templatePattern = /\{\{#each (?<list>[\w.]+)\}\}\n(?<body>[\s\S]*?)\{\{\/each\}\}\n|\{\{ (?<name>[\w.]+) \}\}/g;
const placeholderPattern = /\{\{ (?<name>[\w.]+) \}\}/g;

/**
 * Render the `render_prompt` template in a single pass, so substituted values (which may
 * themselves contain `{{ ... }}`, e.g. the Agent tool specification) are never re-interpreted.
 * Supports `{{ path }}` placeholders and standalone-line `{{#each list}} ... {{/each}}` blocks.
 * A list of strings renders as one `- item` line per entry, or `[]` when empty.
 * Unknown placeholders are errors.
 */
export function renderTemplate(template: string, context: TemplateRecord): string {
	return template.replace(templatePattern, (_match, list: string | undefined, body: string | undefined, name: string | undefined) => {
		if (list === undefined || body === undefined) {
			return format(lookup(context, name!), name!);
		}
		const items = lookup(context, list);
		if (!Array.isArray(items)) {
			throw new RoadmapError(`Template list '${list}' is not defined`);
		}
		return (items as readonly TemplateRecord[]).map(item => body.replace(placeholderPattern, (_m, key: string) => format(lookup(item, key), key))).join('');
	});
}

function lookup(context: TemplateRecord, name: string): TemplateValue | undefined {
	let value: TemplateValue | undefined = context;
	for (const part of name.split('.')) {
		value = value !== undefined && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, TemplateValue>)[part] : undefined;
	}
	return value;
}

function format(value: TemplateValue | undefined, name: string): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
		return value.length ? value.map(item => `- ${item}`).join('\n') : '[]';
	}
	throw new RoadmapError(`Template placeholder '${name}' cannot be rendered`);
}
