/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { parse } from 'yaml';
import { blockedMessage, conflictMessage, noCandidateMessage, roadmapNext } from '../next';
import { nextPromptTemplate } from '../promptTemplate';
import { RoadmapError } from '../roadmap';
import { realRoadmapPath, realRoadmapWithToolingReset, repositoryRoot, roadmapYaml, writeFixture } from './fixture';

function selectedId(roadmap: string): string | undefined {
	const result = roadmapNext(writeFixture(roadmap));
	return 'id' in result ? result.id : undefined;
}

describe('roadmap.next', () => {

	test('selects the first executable bundle in section order, then bundle order', () => {
		assert.deepStrictEqual({
			firstNotStarted: selectedId(roadmapYaml([
				{ name: 'A', bundle: [{ id: 'a.done', status: 'implemented' }, { id: 'a.next' }, { id: 'a.later' }] },
				{ name: 'B', bundle: [{ id: 'b.first' }] },
			])),
			partialRemainsSelectable: selectedId(roadmapYaml([
				{ name: 'A', bundle: [{ id: 'a.done', status: 'implemented' }, { id: 'a.partial', status: 'partial', remaining: ['x'] }] },
			])),
			laterSectionWhenEarlierBlocked: selectedId(roadmapYaml([
				{ name: 'A', bundle: [{ id: 'a.blocked', depends_on: ['b.first'] }] },
				{ name: 'B', bundle: [{ id: 'b.first' }] },
			])),
		}, {
			firstNotStarted: 'a.next',
			partialRemainsSelectable: 'a.partial',
			laterSectionWhenEarlierBlocked: 'b.first',
		});
	});

	test('requires all depends_on bundles to be implemented', () => {
		assert.deepStrictEqual([
			selectedId(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', status: 'partial', remaining: ['x'] }, { id: 'b', depends_on: ['a'] }] }])),
			selectedId(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', status: 'implemented' }, { id: 'c' }, { id: 'b', depends_on: ['a', 'c'] }] }])),
			selectedId(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', status: 'implemented' }, { id: 'c', status: 'implemented' }, { id: 'b', depends_on: ['a', 'c'] }] }])),
		], ['a', 'c', 'b']);
	});

	test('reports no candidate and blocked', () => {
		assert.deepStrictEqual([
			roadmapNext(writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', status: 'implemented' }] }]))),
			roadmapNext(writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', status: 'implemented' }, { id: 'b', depends_on: ['c'] }, { id: 'c', depends_on: ['b'] }] }]))),
		], [
			{ status: 'completed', message: noCandidateMessage },
			{ status: 'blocked', message: blockedMessage },
		]);
	});

	test('extracts referenced sections only and separates implementation from boundary', () => {
		const result = roadmapNext(writeFixture(roadmapYaml([{
			name: 'A', bundle: [{
				id: 'a',
				status: 'partial',
				evidence: ['did x'],
				remaining: ['do y'],
				reference: [
					{ source: './spec.md', role: 'boundary', sections: ['Tool First'] },
					{ source: './spec.md', role: 'implementation', sections: ['§2 Runtime / Load', '§1 Rule'] },
				],
			}],
		}])));
		assert.ok('prompt' in result);
		assert.deepStrictEqual(result.specifications, [
			{ source: './spec.md', role: 'boundary', sections: ['Tool First'], content: '## Tool First\ntool first body with {{ source }} kept verbatim' },
			{ source: './spec.md', role: 'implementation', sections: ['§2 Runtime / Load', '§1 Rule'], content: '### Load\nruntime load\n\n### Rule\nauthority rule' },
		]);
		const prompt = result.prompt;
		assert.deepStrictEqual(prompt.slice(0, prompt.indexOf('## Execution Rules')), [
			'Implement the following roadmap bundle.',
			'',
			'## Bundle',
			'id: a',
			'title: Title of a',
			'status: partial',
			'',
			'## Dependencies',
			'[]',
			'',
			'## Current Evidence',
			'- did x',
			'',
			'## Remaining Work',
			'- do y',
			'',
			'## Implementation Specification',
			'### ./spec.md',
			'### Load\nruntime load\n\n### Rule\nauthority rule',
			'',
			'',
			'## Boundary Constraints',
			'### ./spec.md',
			'## Tool First\ntool first body with {{ source }} kept verbatim',
			'',
			'',
			'',
		].join('\n'));
		assert.strictEqual(prompt.includes('runtime intro'), false);
		assert.strictEqual(prompt.includes('scan body'), false);
	});

	test('blocks on a reference conflict and fails on unresolvable references', () => {
		const conflict = roadmapNext(writeFixture(roadmapYaml([{
			name: 'A', bundle: [{
				id: 'a', reference: [
					{ source: './spec.md', role: 'implementation', sections: ['§1 Authority'] },
					{ source: './spec.md', role: 'boundary', sections: ['§1 Authority'] },
				],
			}],
		}])));
		assert.deepStrictEqual(conflict, { status: 'blocked', message: conflictMessage, id: 'a', conflicts: [{ source: './spec.md', section: '§1 Authority', heading: '1. Authority' }] });
		assert.throws(() => roadmapNext(writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', reference: [{ source: './spec.md', role: 'implementation', sections: ['§1 Missing'] }] }] }]))), RoadmapError);
		assert.throws(() => roadmapNext(writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a', depends_on: ['unknown'] }] }]))), RoadmapError);
	});

	test('prompt template is identical to the Agent tool.md specification', () => {
		const specification = fs.readFileSync(path.join(repositoryRoot, 'docs', 'primitive-app-editor', 'Agent tool.md'), 'utf8');
		const toolBlock = [...specification.matchAll(/```yaml\n(?<body>[\s\S]*?)```/g)].map(match => parse(match.groups!.body)).find(block => block?.tool);
		const renderPrompt = toolBlock.tool.commands.next.sequence.find((step: { id: string }) => step.id === 'render_prompt');
		assert.strictEqual(nextPromptTemplate, renderPrompt.template);
	});

	test('extracts the real tooling.roadmap-agent specification', () => {
		// Mirror the repository layout so './Agent tool.md' and '../../README.md' resolve as in the real roadmap,
		// with tooling.roadmap-agent reset to "not started" so it is selected regardless of its current progress.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-mcp-real-'));
		const docs = path.join(root, 'docs', 'primitive-app-editor');
		fs.mkdirSync(docs, { recursive: true });
		fs.copyFileSync(path.join(repositoryRoot, 'README.md'), path.join(root, 'README.md'));
		fs.copyFileSync(path.join(path.dirname(realRoadmapPath), 'Agent tool.md'), path.join(docs, 'Agent tool.md'));
		const roadmap = realRoadmapWithToolingReset();
		fs.writeFileSync(path.join(docs, 'roadmap.yaml'), roadmap);

		const result = roadmapNext(path.join(docs, 'roadmap.yaml'));
		assert.ok('specifications' in result);
		assert.deepStrictEqual({
			id: result.id,
			specifications: result.specifications.map(specification => [specification.source, specification.role, specification.content.split('\n')[0]]),
			templateSyntaxInContentKeptVerbatim: result.prompt.includes('{{#each implementation_specifications}}'),
		}, {
			id: 'tooling.roadmap-agent',
			specifications: [
				['./Agent tool.md', 'implementation', '## roadmap Tool'],
				['../../README.md', 'boundary', '## Tool First'],
			],
			templateSyntaxInContentKeptVerbatim: true,
		});
	});
});
