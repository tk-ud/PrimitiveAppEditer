/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { roadmapYaml, writeFixture } from './fixture';

describe('stdio MCP server', () => {

	test('exposes roadmap.next and roadmap.complete over stdio', async () => {
		const roadmapPath = writeFixture(roadmapYaml([{ name: 'A', bundle: [{ id: 'a' }, { id: 'b', depends_on: ['a'] }] }]));
		const client = new Client({ name: 'roadmap-mcp-test', version: '1.0.0' });
		await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'stdio.js'), '--roadmap', roadmapPath] }));
		try {
			const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0].text;
			const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
			const next = JSON.parse(text(await client.callTool({ name: 'roadmap.next', arguments: {} })));
			const rejected = await client.callTool({ name: 'roadmap.complete', arguments: { id: 'a', status: 'implemented', evidence: ['e'], remaining: [], extra: true } });
			const invalid = await client.callTool({ name: 'roadmap.complete', arguments: { id: 'a', status: 'implemented', evidence: [], remaining: [] } });
			const complete = JSON.parse(text(await client.callTool({ name: 'roadmap.complete', arguments: { id: 'a', status: 'implemented', evidence: ['e'], remaining: [] } })));
			const afterComplete = JSON.parse(text(await client.callTool({ name: 'roadmap.next', arguments: {} })));
			assert.deepStrictEqual({
				tools,
				nextId: next.id,
				rejected: rejected.isError,
				invalid: [invalid.isError, JSON.parse(text(invalid))],
				complete,
				afterCompleteId: afterComplete.id,
			}, {
				tools: ['roadmap.complete', 'roadmap.next'],
				nextId: 'a',
				rejected: true,
				invalid: [true, { error: 'validation_failed', violations: [{ rule: 'evidence_not_empty', message: 'evidence must contain at least one non-empty item' }] }],
				complete: { id: 'a', status: 'implemented', next_action: 'restart', message: 'Bundle \'a\' recorded as implemented. Call roadmap.next again (next executable bundle: \'b\').' },
				afterCompleteId: 'b',
			});
		} finally {
			await client.close();
		}
	});
});
