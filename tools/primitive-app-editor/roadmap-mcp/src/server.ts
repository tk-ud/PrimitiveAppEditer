/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { CompleteValidationError, completeInputSchema, roadmapComplete } from './complete';
import { roadmapNext } from './next';
import { RoadmapError } from './roadmap';

/**
 * Create the roadmap MCP server exposing `roadmap.next` and `roadmap.complete`
 * for the given roadmap.yaml.
 */
export function createRoadmapServer(roadmapPath: string): McpServer {
	const server = new McpServer({
		name: 'Primitive App Editor roadmap',
		version: '1.0.0',
		title: 'roadmap Agent Tool (roadmap.next / roadmap.complete) as specified by docs/primitive-app-editor/Agent tool.md',
	});

	server.registerTool(
		'roadmap.next',
		{
			description: 'Resolve the next executable roadmap bundle and construct the implementation prompt for the agent.',
			inputSchema: z.object({}).strict(),
		},
		async () => run(() => roadmapNext(roadmapPath))
	);

	server.registerTool(
		'roadmap.complete',
		{
			description: 'Validate and persist progress (status / evidence / remaining) for one roadmap bundle. This is the only allowed roadmap mutation.',
			inputSchema: completeInputSchema,
		},
		async input => run(() => roadmapComplete(roadmapPath, input))
	);

	return server;
}

function run(action: () => object): CallToolResult {
	try {
		return { content: [{ type: 'text', text: JSON.stringify(action(), undefined, '\t') }] };
	} catch (error) {
		if (error instanceof CompleteValidationError) {
			return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'validation_failed', violations: error.violations }, undefined, '\t') }] };
		}
		if (error instanceof RoadmapError) {
			return { isError: true, content: [{ type: 'text', text: error.message }] };
		}
		throw error;
	}
}
