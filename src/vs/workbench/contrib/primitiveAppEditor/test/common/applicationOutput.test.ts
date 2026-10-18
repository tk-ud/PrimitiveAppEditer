/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Generic Application Output projection (build.application-output)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. Application Output)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AssetKind, createAsset } from '../../common/assetRegistry.js';
import { createApplicationOutput, projectApplicationOutput } from '../../common/applicationOutput.js';
import {
	applyBuildTargetFilter,
	BuildValidationError,
	BuildValidationStage,
	createBuildConfiguration,
	IBuildAuthoringData,
	POSTGRESQL_WEB_APPLICATION_OUTPUT,
	POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
} from '../../common/buildValidation.js';
import { createFunctionBindingEntry } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry } from '../../common/functionRegistry.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { createRendererBindingEntry, createRendererRegistryEntry } from '../../common/rendererRegistry.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const ENEMY = '00000000-0000-4000-8000-0000000000a2';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW1 = '00000000-0000-4000-8000-0000000000b1';
const ROW2 = '00000000-0000-4000-8000-0000000000b2';
const EROW = '00000000-0000-4000-8000-0000000000b3';
const FN = '00000000-0000-4000-8000-0000000000f1';
const BIND = '00000000-0000-4000-8000-0000000000d1';
const RENDERER = '00000000-0000-4000-8000-0000000000e1';
const RBIND = '00000000-0000-4000-8000-0000000000e2';
const ASSET = '00000000-0000-4000-8000-0000000000aa';
const ASSET2 = '00000000-0000-4000-8000-0000000000ab';
const NOW = '2026-10-18T00:00:00.000Z';

function authoring(): IBuildAuthoringData {
	const column = { uuid: FATIGUE, index: 0, name: 'fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true };
	const player = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: 'player', columns: [column], created_at: NOW });
	const enemy = createTableRegistryEntry({ uuid: ENEMY, index: 1, schema: LogicalNamespace.Items, name: 'enemy', columns: [column], created_at: NOW });
	const address = { table_uuid: PLAYER, row_uuid: ROW1, column_uuid: FATIGUE };
	const now = () => new Date(NOW);
	return {
		tables: [player, enemy],
		relations: [],
		functions: [createFunctionRegistryEntry({ uuid: FN, ...toFunctionRegistryEntryInput(linearDefinition, 0) }, undefined, now)],
		bindings: [createFunctionBindingEntry({
			uuid: BIND, index: 0, function: { uuid: FN }, constructor: {}, execution: { kind: 'tick' },
			inputs: { x: { source: 'state', address } }, target: { address, merge: { kind: 'overwrite' } },
		}, undefined, now)],
		dependencies: [],
		renderers: [createRendererRegistryEntry({ uuid: RENDERER, index: 0, name: 'sprite_renderer', executor: 'Sprite', inputs: [{ name: 'sprite', kind: 'asset' }] }, undefined, now)],
		rendererBindings: [createRendererBindingEntry({ uuid: RBIND, renderer: { uuid: RENDERER }, bindings: { sprite: { asset_uuid: ASSET } } }, undefined, now)],
		assets: [
			createAsset({ uuid: ASSET, index: 0, name: 'hero', label: 'Hero', kind: AssetKind.Sprite, source: 'assets/image/hero.png', metadata: {} }),
			createAsset({ uuid: ASSET2, index: 1, name: 'villain', label: 'Villain', kind: AssetKind.Sprite, source: 'assets/image/villain.png', metadata: {} }),
		],
		rawData: [
			{ table_uuid: PLAYER, rows: [{ uuid: ROW1, values: { [FATIGUE]: 1 } }, { uuid: ROW2, values: { [FATIGUE]: 2 } }] },
			{ table_uuid: ENEMY, rows: [{ uuid: EROW, values: { [FATIGUE]: 3 } }] },
		],
		workingDirectoryPaths: ['functions/linear.ts', 'scripts/start.ts', 'scripts/a.ts', 'config/app.json', 'assets/image/hero.png'],
		executorCatalog: createFunctionPrimitiveExecutorCatalog(),
		resolveExecutorProgram: executor => executor === 'Linear' ? 'functions/linear.ts' : undefined,
	};
}

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build_target: POSTGRESQL_WEB_APPLICATION_OUTPUT,
		runtime_storage_target: POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
		seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [ROW2] } },
		include: { assets: [ASSET], functions: ['functions/linear.ts'], scripts: ['scripts/start.ts', 'scripts/a.ts'], config: ['config/app.json'] },
		output_path: 'build/out',
		...overrides,
	};
}

suite('Primitive App Editor - Generic Application Output projection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Output splits Application Definition (Schema / Data / Binding) and Application Program (Runtime / Renderer)', () => {
		const data = authoring();
		const config = createBuildConfiguration(configuration());
		const output = createApplicationOutput(applyBuildTargetFilter(data, config), config);
		assert.deepStrictEqual([output.build_target, output.runtime_storage_target, output.output_path], [POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE, 'build/out']);
		assert.deepStrictEqual(output.definition.schema.tables.map(t => t.uuid), [PLAYER, ENEMY]);
		assert.deepStrictEqual(output.definition.data.seed.map(t => [t.table_uuid, t.rows.map(r => r.uuid)]), [[PLAYER, [ROW1]]]);
		assert.strictEqual(output.definition.binding.functions, data.bindings);
		assert.strictEqual(output.definition.binding.renderers, data.rendererBindings);
		assert.deepStrictEqual(output.program.scripts, ['scripts/a.ts', 'scripts/start.ts']);
		assert.deepStrictEqual(output.program.assets.map(a => a.uuid), [ASSET]);
		assert.deepStrictEqual(Object.keys(output).sort(), ['build_target', 'definition', 'output_path', 'program', 'runtime_storage_target']);
	});

	test('Output is deterministic and leaves Authoring Data untouched', () => {
		const data = authoring();
		const snapshot = JSON.stringify(data);
		const config = createBuildConfiguration(configuration());
		const first = createApplicationOutput(applyBuildTargetFilter(data, config), config);
		const second = createApplicationOutput(applyBuildTargetFilter(data, config), config);
		assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
		assert.strictEqual(JSON.stringify(data), snapshot);
	});

	test('seed_data.include false yields no Seed; unselected content is not in the Program', () => {
		const data = authoring();
		const config = createBuildConfiguration(configuration({ seed_data: { include: false, raw_data: { tables: [], exclude_rows: [] } }, include: { assets: [ASSET], functions: ['functions/linear.ts'], scripts: [], config: [] } }));
		const output = createApplicationOutput(applyBuildTargetFilter(data, config), config);
		assert.deepStrictEqual(output.definition.data.seed, []);
		assert.deepStrictEqual([output.program.scripts, output.program.config], [[], []]);
	});

	test('projectApplicationOutput validates, then runs the build_target Projection', () => {
		const projections = new Map([[POSTGRESQL_WEB_APPLICATION_OUTPUT, (o: { output_path: string }) => `wrote:${o.output_path}`]]);
		const { output, result } = projectApplicationOutput(authoring(), configuration(), projections);
		assert.strictEqual(result, 'wrote:build/out');
		assert.strictEqual(output.build_target, POSTGRESQL_WEB_APPLICATION_OUTPUT);
	});

	test('projectApplicationOutput rejects an invalid Build and a build_target without a Projection', () => {
		const projections = new Map<string, (o: unknown) => string>();
		assert.throws(() => projectApplicationOutput(authoring(), configuration(), projections), (e: unknown) => e instanceof BuildValidationError && e.stage === BuildValidationStage.BuildConfiguration && /no Application Output Projection/.test(e.message));
		let called = false;
		const registered = new Map([[POSTGRESQL_WEB_APPLICATION_OUTPUT, () => { called = true; return ''; }]]);
		assert.throws(() => projectApplicationOutput(authoring(), configuration({ output_path: 'dist' }), registered), (e: unknown) => e instanceof BuildValidationError && e.stage === BuildValidationStage.BuildConfiguration);
		assert.strictEqual(called, false);
	});
});
