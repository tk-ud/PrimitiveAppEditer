/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, test } from 'node:test';
import { resolveSections, SectionResolutionError } from '../markdown';
import { loadRoadmap } from '../roadmap';
import { realRoadmapPath, specificationMarkdown } from './fixture';

describe('read_markdown_sections', () => {

	test('resolves every roadmap reference form', () => {
		const resolved = resolveSections(specificationMarkdown, [
			'§1 Authority',
			'§1 Rule',
			'§2 Runtime / Load',
			'§3 Function / Program Scan',
			'Tool First',
		]);
		assert.deepStrictEqual(resolved.map(section => section.content), [
			'## 1. Authority\nauthority body\n\n### Rule\nauthority rule',
			'### Rule\nauthority rule',
			'### Load\nruntime load',
			'## 3. Function / Program Scan\nscan body\n\n```yaml\n## 4. Not A Heading\n```',
			'## Tool First\ntool first body with {{ source }} kept verbatim',
		]);
	});

	test('rejects references that do not resolve to exactly one heading', () => {
		const markdown = '## 1. A\n### Same\n### Same\n## 2. B\n';
		const failures = ['§1 Same', '§2 Missing', '§9 A', '§4 Not A Heading', 'Nope'].map(reference => {
			try {
				resolveSections(reference === '§4 Not A Heading' ? specificationMarkdown : markdown, [reference]);
				return `${reference}: resolved`;
			} catch (error) {
				assert.ok(error instanceof SectionResolutionError);
				return error.message;
			}
		});
		assert.deepStrictEqual(failures, [
			'§1 Same: ambiguous: matches headings at lines 2, 3',
			'§2 Missing: section 2 is \'2. B\', which is neither \'Missing\' nor contains a nested heading \'Missing\'',
			'§9 A: no numbered heading \'9.\'',
			'§4 Not A Heading: no numbered heading \'4.\'',
			'Nope: no heading \'Nope\'',
		]);
	});

	test('resolves the section notation used by the real roadmap', () => {
		const roadmap = loadRoadmap(realRoadmapPath);
		const unresolved = new Set<string>();
		let resolvedCount = 0;
		for (const bundle of roadmap.bundles) {
			for (const reference of bundle.reference) {
				const markdown = fs.readFileSync(path.resolve(path.dirname(realRoadmapPath), reference.source), 'utf8');
				for (const section of reference.sections) {
					try {
						resolveSections(markdown, [section]);
						resolvedCount++;
					} catch {
						unresolved.add(`${reference.source} ${section}`);
					}
				}
			}
		}
		const sample = (source: string, sections: string[]) => resolveSections(fs.readFileSync(path.resolve(path.dirname(realRoadmapPath), source), 'utf8'), sections).map(section => section.heading.text);
		assert.deepStrictEqual({
			appEditer: sample('./App Editer.md', ['§1 Authority', '§3 Open', '§22 Function Runtime / Load', '§23 Runtime Addressing / Editor', '§30 Function / Program Scan', '§39 Boundary', '§31 Build']),
			readme: sample('../../README.md', ['Tool First']),
			agentTool: sample('./Agent tool.md', ['roadmap Tool']),
			// Only Editor UI.md references (used by later bundles) currently disagree with the
			// numbering of Editor UI.md; they must fail instead of being guessed.
			unresolvedOutsideEditorUi: [...unresolved].filter(item => !item.startsWith('./Editor UI.md')),
			someResolved: resolvedCount > 150,
		}, {
			appEditer: ['1. Authority', 'Open', 'Load', 'Editor', '30. Function / Program Scan', 'Boundary', '31. Build'],
			readme: ['Tool First'],
			agentTool: ['roadmap Tool'],
			unresolvedOutsideEditorUi: [],
			someResolved: true,
		});
	});
});
