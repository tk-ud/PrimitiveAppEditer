/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, test } from 'node:test';
import { CompleteValidationError, roadmapComplete } from '../complete';
import { roadmapNext } from '../next';
import { loadRoadmap } from '../roadmap';
import { realRoadmapWithToolingReset, roadmapYaml, writeFixture } from './fixture';

const fixture = () => roadmapYaml([
	{ name: 'A', bundle: [{ id: 'a.done', status: 'implemented', evidence: ['old evidence'] }, { id: 'a.work', depends_on: ['a.done'] }] },
	{ name: 'B', bundle: [{ id: 'b.blocked', depends_on: ['a.work'] }, { id: 'b.partial', status: 'partial', evidence: ['e1'], remaining: ['r1', 'r2'] }] },
]);

function violations(roadmapPath: string, input: object): string[] {
	const before = fs.readFileSync(roadmapPath, 'utf8');
	try {
		roadmapComplete(roadmapPath, input);
	} catch (error) {
		assert.ok(error instanceof CompleteValidationError, String(error));
		assert.strictEqual(fs.readFileSync(roadmapPath, 'utf8'), before, 'roadmap must not change when validation fails');
		return error.violations.map(violation => violation.rule);
	}
	return [];
}

/**
 * Return the lines that differ between two texts (line-level, same length prefix/suffix stripped).
 */
function changedRegion(before: string, after: string): { removed: string[]; added: string[] } {
	const a = before.split('\n');
	const b = after.split('\n');
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	return { removed: a.slice(start, endA), added: b.slice(start, endB) };
}

describe('roadmap.complete', () => {

	test('validates bundle, status, dependencies, evidence and remaining', () => {
		const roadmapPath = writeFixture(fixture());
		assert.deepStrictEqual({
			unknownBundle: violations(roadmapPath, { id: 'nope', status: 'partial', evidence: ['e'], remaining: ['r'] }),
			alreadyImplemented: violations(roadmapPath, { id: 'a.done', status: 'implemented', evidence: ['e'], remaining: [] }),
			dependencyNotImplemented: violations(roadmapPath, { id: 'b.blocked', status: 'partial', evidence: ['e'], remaining: ['r'] }),
			emptyEvidence: violations(roadmapPath, { id: 'a.work', status: 'implemented', evidence: [], remaining: [] }),
			blankEvidence: violations(roadmapPath, { id: 'a.work', status: 'implemented', evidence: [' '], remaining: [] }),
			implementedWithRemaining: violations(roadmapPath, { id: 'a.work', status: 'implemented', evidence: ['e'], remaining: ['r'] }),
			partialWithoutRemaining: violations(roadmapPath, { id: 'a.work', status: 'partial', evidence: ['e'], remaining: [] }),
			notStartedIsNotAnInputStatus: violations(roadmapPath, { id: 'a.work', status: 'not started', evidence: ['e'], remaining: [] }),
			additionalPropertiesRejected: violations(roadmapPath, { id: 'a.work', status: 'implemented', evidence: ['e'], remaining: [], depends_on: [] }),
			missingField: violations(roadmapPath, { id: 'a.work', status: 'implemented', evidence: ['e'] }),
		}, {
			unknownBundle: ['bundle_exists'],
			// status_transition allows implemented -> implemented; current_status_is_not_implemented rejects it.
			alreadyImplemented: ['current_status_is_not_implemented'],
			dependencyNotImplemented: ['dependencies_are_implemented'],
			emptyEvidence: ['evidence_not_empty'],
			blankEvidence: ['evidence_not_empty'],
			implementedWithRemaining: ['implemented_requires_empty_remaining'],
			partialWithoutRemaining: ['partial_requires_non_empty_remaining'],
			notStartedIsNotAnInputStatus: ['input_schema'],
			additionalPropertiesRejected: ['input_schema'],
			missingField: ['input_schema'],
		});
	});

	test('not started -> partial -> partial -> implemented updates only the target bundle', () => {
		const roadmapPath = writeFixture(fixture());
		const original = fs.readFileSync(roadmapPath, 'utf8');

		const first = roadmapComplete(roadmapPath, { id: 'a.work', status: 'partial', evidence: ['src/x.ts', 'npm test: "ok"'], remaining: ['finish y'] });
		const afterFirst = fs.readFileSync(roadmapPath, 'utf8');
		const second = roadmapComplete(roadmapPath, { id: 'a.work', status: 'partial', evidence: ['src/x.ts'], remaining: ['finish z'] });
		const third = roadmapComplete(roadmapPath, { id: 'a.work', status: 'implemented', evidence: ['src/x.ts', 'src/y.ts'], remaining: [] });
		const final = fs.readFileSync(roadmapPath, 'utf8');

		assert.deepStrictEqual([first.next_action, second.next_action, third.next_action], ['restart', 'restart', 'restart']);
		assert.deepStrictEqual(changedRegion(original, afterFirst), {
			removed: [
				'        status: "not started"',
				'        evidence: []',
				'        remaining: []',
			],
			added: [
				'        status: "partial"',
				'        evidence:',
				'          - "src/x.ts"',
				'          - "npm test: \\"ok\\""',
				'        remaining:',
				'          - "finish y"',
			],
		});
		assert.deepStrictEqual(changedRegion(original, final), {
			removed: [
				'        status: "not started"',
				'        evidence: []',
			],
			added: [
				'        status: "implemented"',
				'        evidence:',
				'          - "src/x.ts"',
				'          - "src/y.ts"',
			],
		});
		const roadmap = loadRoadmap(roadmapPath);
		assert.deepStrictEqual(roadmap.bundles.find(bundle => bundle.id === 'a.work'), {
			id: 'a.work', title: 'Title of a.work', reference: [{ source: './spec.md', role: 'implementation', sections: ['§1 Authority'] }],
			depends_on: ['a.done'], status: 'implemented', evidence: ['src/x.ts', 'src/y.ts'], remaining: [],
		});
		// a.work is now implemented, so roadmap.next moves on and the bundle can never be completed again.
		const next = roadmapNext(roadmapPath);
		assert.strictEqual('id' in next ? next.id : next.status, 'b.blocked');
		assert.deepStrictEqual(violations(roadmapPath, { id: 'a.work', status: 'implemented', evidence: ['e'], remaining: [] }), ['current_status_is_not_implemented']);
	});

	test('partial -> implemented replaces block lists and preserves surrounding text', () => {
		const roadmapPath = writeFixture(fixture());
		const original = fs.readFileSync(roadmapPath, 'utf8');
		roadmapComplete(roadmapPath, { id: 'b.partial', status: 'implemented', evidence: ['done'], remaining: [] });
		assert.deepStrictEqual(changedRegion(original, fs.readFileSync(roadmapPath, 'utf8')), {
			removed: [
				'        status: "partial"',
				'        evidence:',
				'          - "e1"',
				'        remaining:',
				'          - "r1"',
				'          - "r2"',
			],
			added: [
				'        status: "implemented"',
				'        evidence:',
				'          - "done"',
				'        remaining: []',
			],
		});
		assert.ok(fs.readFileSync(roadmapPath, 'utf8').endsWith('  excluded_from_current_loop: []   # trailing comment\n'));
		assert.deepStrictEqual(fs.readdirSync(path.dirname(roadmapPath)).sort(), ['roadmap.yaml', 'spec.md'], 'no temporary file is left behind');
	});

	test('reports next_action completed and blocked', () => {
		const completed = writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a' }] }]));
		const blocked = writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a' }, { id: 'b', depends_on: ['c'] }, { id: 'c', depends_on: ['b'] }] }]));
		assert.deepStrictEqual([
			roadmapComplete(completed, { id: 'a', status: 'implemented', evidence: ['e'], remaining: [] }).next_action,
			roadmapComplete(blocked, { id: 'a', status: 'implemented', evidence: ['e'], remaining: [] }).next_action,
		], ['completed', 'blocked']);
	});

	test('does not reformat, reorder or compress unrelated content of the real roadmap', () => {
		const original = realRoadmapWithToolingReset();
		const roadmapPath = writeFixture(original);
		const result = roadmapComplete(roadmapPath, { id: 'tooling.roadmap-agent', status: 'implemented', evidence: ['tools/primitive-app-editor/roadmap-mcp'], remaining: [] });
		assert.deepStrictEqual({ result, changed: changedRegion(original, fs.readFileSync(roadmapPath, 'utf8')) }, {
			result: {
				id: 'tooling.roadmap-agent', status: 'implemented', next_action: 'restart',
				message: 'Bundle \'tooling.roadmap-agent\' recorded as implemented. Call roadmap.next again (next executable bundle: \'repository.ci-baseline\').',
			},
			changed: {
				removed: ['        status: "not started"', '        evidence: []'],
				added: ['        status: "implemented"', '        evidence:', '          - "tools/primitive-app-editor/roadmap-mcp"'],
			},
		});
	});
});
