/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultRoadmapPath } from './roadmap';
import { createRoadmapServer } from './server';

/**
 * Usage: node out/stdio.js [--roadmap <path/to/roadmap.yaml>]
 * Defaults to docs/primitive-app-editor/roadmap.yaml of this repository.
 */
function roadmapPathFromArgs(args: readonly string[]): string {
	const index = args.indexOf('--roadmap');
	return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : defaultRoadmapPath();
}

const transport = new StdioServerTransport();
(async () => {
	const server = createRoadmapServer(roadmapPathFromArgs(process.argv.slice(2)));
	await server.connect(transport);
})().catch(err => {
	transport.close();
	console.error('Error occurred while connecting to server:', err);
	process.exit(1);
});
