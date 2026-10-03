/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NextOutput } from '../next';

export type SelectedNextOutput = Extract<NextOutput, { readonly prompt: string }>;

/** True when roadmap.next selected a bundle (as opposed to a completed / blocked result). */
export function isSelected(result: NextOutput): result is SelectedNextOutput {
	return Object.hasOwn(result, 'prompt');
}

/** Repository root (tools/primitive-app-editor/roadmap-mcp/out/test -> repo). */
export const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
export const realRoadmapPath = path.join(repositoryRoot, 'docs', 'primitive-app-editor', 'roadmap.yaml');

export const specificationMarkdown = [
	'# Spec',
	'',
	'## 1. Authority',
	'authority body',
	'',
	'### Rule',
	'authority rule',
	'',
	'## 2. Runtime',
	'runtime intro',
	'',
	'### Load',
	'runtime load',
	'',
	'## 3. Function / Program Scan',
	'scan body',
	'',
	'```yaml',
	'## 4. Not A Heading',
	'```',
	'',
	'## Tool First',
	'tool first body with {{ source }} kept verbatim',
	'',
].join('\n');

/**
 * Write a roadmap fixture plus `spec.md` into a fresh temporary directory and return the roadmap path.
 */
export function writeFixture(roadmap: string, markdown: string = specificationMarkdown): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-mcp-'));
	fs.writeFileSync(path.join(directory, 'spec.md'), markdown);
	const roadmapPath = path.join(directory, 'roadmap.yaml');
	fs.writeFileSync(roadmapPath, roadmap);
	return roadmapPath;
}

export interface IFixtureBundle {
	id: string;
	status?: string;
	depends_on?: string[];
	evidence?: string[];
	remaining?: string[];
	reference?: { source: string; role: string; sections: string[] }[];
}

/**
 * Build roadmap.yaml text in the same layout as docs/primitive-app-editor/roadmap.yaml.
 */
export function roadmapYaml(sections: { name: string; bundle: IFixtureBundle[] }[]): string {
	const list = (indent: string, items: string[] | undefined) => items?.length ? '\n' + items.map(item => `${indent}- ${JSON.stringify(item)}`).join('\n') : ' []';
	const lines = [
		'roadmap:',
		'  name: "Fixture"',
		'  # comment that must survive roadmap.complete',
		'  status_values:',
		'    - "not started"',
		'    - "partial"',
		'    - "implemented"',
		'',
		'section:',
	];
	for (const section of sections) {
		lines.push(`  - name: ${JSON.stringify(section.name)}`, '    bundle:');
		for (const bundle of section.bundle) {
			const reference = bundle.reference ?? [{ source: './spec.md', role: 'implementation', sections: ['§1 Authority'] }];
			lines.push(
				`      - id: ${JSON.stringify(bundle.id)}`,
				`        title: ${JSON.stringify(`Title of ${bundle.id}`)}`,
				'        reference:',
				...reference.flatMap(item => [
					`          - source: ${JSON.stringify(item.source)}`,
					`            role: ${JSON.stringify(item.role)}`,
					`            sections:${list('              ', item.sections)}`,
				]),
				`        depends_on:${list('          ', bundle.depends_on)}`,
				`        status: ${JSON.stringify(bundle.status ?? 'not started')}`,
				`        evidence:${list('          ', bundle.evidence)}`,
				`        remaining:${list('          ', bundle.remaining)}`,
				'',
			);
		}
	}
	lines.push('future:', '  excluded_from_current_loop: []   # trailing comment', '');
	return lines.join('\n');
}

/**
 * Real roadmap.yaml text with tooling.roadmap-agent reset to "not started" with empty evidence /
 * remaining, so tests do not depend on the bundle's current recorded progress.
 */
export function realRoadmapWithToolingReset(): string {
	const text = fs.readFileSync(realRoadmapPath, 'utf8');
	const reset = text.replace(
		/(id: "tooling\.roadmap-agent"[\s\S]*?\n {8}status: )"[^"]*"\n {8}evidence:(?: \[\]|(?:\n {10}- [^\n]*)+)\n {8}remaining:(?: \[\]|(?:\n {10}- [^\n]*)+)/,
		'$1"not started"\n        evidence: []\n        remaining: []'
	);
	if (!reset.includes('status: "not started"\n        evidence: []\n        remaining: []\n\n  - name: "Repository Baseline"')) {
		throw new Error('Could not reset tooling.roadmap-agent in the real roadmap');
	}
	return reset;
}
