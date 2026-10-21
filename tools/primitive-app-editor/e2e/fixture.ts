/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Deploy E2E fixture (completion.end-to-end)
 *  Authoring Data -> Build Validation -> Application Output -> Deploy Scaffold, using the shipped projections.
 *--------------------------------------------------------------------------------------------*/

import { IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/buildValidation.js';
import { BUILTIN_DEPLOY_TEMPLATE_ID, createDeployTemplateRegistry, projectDeployScaffold } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/deployProjection.js';
import { createFunctionBindingEntry } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/functionPrimitive.js';
import { createFunctionRegistryEntry } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/functionRegistry.js';
import { LogicalNamespace } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/projectSqlite.js';
import { createRendererBindingEntry, createRendererRegistryEntry } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/rendererRegistry.js';
import { createTableRegistryEntry, TableColumnKind } from '../../../src/vs/workbench/contrib/primitiveAppEditor/common/tableRegistry.js';

export const PLAYER = '00000000-0000-4000-8000-0000000000a1';
export const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
export const NAME = '00000000-0000-4000-8000-0000000000c2';
const ROW1 = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const BIND = '00000000-0000-4000-8000-0000000000d1';
const RENDERER = '00000000-0000-4000-8000-0000000000e1';
const RBIND = '00000000-0000-4000-8000-0000000000e2';
const NOW = '2026-10-18T00:00:00.000Z';

function authoring(): IBuildAuthoringData {
	const fatigue = { uuid: FATIGUE, index: 0, name: 'fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true };
	const name = { uuid: NAME, index: 1, name: 'label', kind: TableColumnKind.Text, not_null: true, writable: true, searchable: true };
	const player = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [fatigue, name], created_at: NOW });
	const address = { table_uuid: PLAYER, row_uuid: ROW1, column_uuid: FATIGUE };
	const now = () => new Date(NOW);
	return {
		tables: [player],
		relations: [],
		functions: [createFunctionRegistryEntry({ uuid: FN, ...toFunctionRegistryEntryInput(linearDefinition, 0) }, undefined, now)],
		bindings: [createFunctionBindingEntry({
			uuid: BIND, index: 0, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
			inputs: { x: { source: 'state', address } }, target: { address, merge: { kind: 'overwrite' } },
		}, undefined, now)],
		dependencies: [],
		renderers: [createRendererRegistryEntry({ uuid: RENDERER, index: 0, name: 'gauge', executor: 'Gauge', inputs: [{ name: 'value', kind: 'double' }] }, undefined, now)],
		rendererBindings: [createRendererBindingEntry({ uuid: RBIND, renderer: { uuid: RENDERER }, bindings: { value: { address } } }, undefined, now)],
		assets: [],
		rawData: [{ table_uuid: PLAYER, rows: [{ uuid: ROW1, values: { [FATIGUE]: 4242.5, [NAME]: 'seed-player' } }] }],
		workingDirectoryPaths: ['functions/linear.ts'],
		executorCatalog: createFunctionPrimitiveExecutorCatalog(),
		resolveExecutorProgram: executor => executor === 'Linear' ? 'functions/linear.ts' : undefined,
	};
}

/** Returns every file (Application Output + Deploy Scaffold) the Build / Export would write, path -> content. */
export function buildDeployFiles(existingFiles: readonly string[] = []): { files: Record<string, string>; compose: string } {
	const configuration = {
		build_target: POSTGRESQL_WEB_APPLICATION_OUTPUT,
		runtime_storage_target: POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
		seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [] } },
		include: { assets: [], functions: ['functions/linear.ts'], scripts: [], config: [] },
		output_path: 'build/out',
		deploy: { template_id: BUILTIN_DEPLOY_TEMPLATE_ID, host: 'linux' },
	};
	const { result, scaffold } = projectDeployScaffold(authoring(), configuration, createDeployTemplateRegistry(), existingFiles);
	const files: Record<string, string> = {};
	for (const file of [...result.webProgram.files, ...result.postgresql.files, ...scaffold.files]) {
		files[file.path] = file.content;
	}
	const compose = scaffold.files.find(file => file.requested === 'compose.yml')!.path;
	return { files, compose };
}
