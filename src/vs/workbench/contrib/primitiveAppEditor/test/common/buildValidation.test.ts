/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Build Configuration, Build Target Filter and Build Validation (build.validation)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. Build Configuration, Build Target Filter, Build Validation)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AssetKind, createAsset } from '../../common/assetRegistry.js';
import {
	applyBuildTargetFilter,
	BuildValidationError,
	BuildValidationStage,
	buildValidationStages,
	createBuildConfiguration,
	IBuildAuthoringData,
	POSTGRESQL_WEB_APPLICATION_OUTPUT,
	POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
	validateBuild,
} from '../../common/buildValidation.js';
import { createFunctionBindingEntry } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry } from '../../common/functionRegistry.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { createRelationRegistryEntry, RelationType } from '../../common/relationRegistry.js';
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
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const NOW = '2026-10-18T00:00:00.000Z';

function authoring(overrides: Partial<IBuildAuthoringData> = {}, rendererBindings: Record<string, unknown> = { sprite: { asset_uuid: ASSET } }): IBuildAuthoringData {
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
		rendererBindings: [createRendererBindingEntry({ uuid: RBIND, renderer: { uuid: RENDERER }, bindings: rendererBindings }, undefined, now)],
		assets: [
			createAsset({ uuid: ASSET, index: 0, name: 'hero', label: 'Hero', kind: AssetKind.Sprite, source: 'assets/image/hero.png', metadata: {} }),
			createAsset({ uuid: ASSET2, index: 1, name: 'villain', label: 'Villain', kind: AssetKind.Sprite, source: 'assets/image/villain.png', metadata: {} }),
		],
		rawData: [
			{ table_uuid: PLAYER, rows: [{ uuid: ROW1, values: { [FATIGUE]: 1 } }, { uuid: ROW2, values: { [FATIGUE]: 2 } }] },
			{ table_uuid: ENEMY, rows: [{ uuid: EROW, values: { [FATIGUE]: 3 } }] },
		],
		workingDirectoryPaths: ['functions/linear.ts', 'scripts/start.ts', 'config/app.json', 'assets/image/hero.png'],
		executorCatalog: createFunctionPrimitiveExecutorCatalog(),
		resolveExecutorProgram: executor => executor === 'Linear' ? 'functions/linear.ts' : undefined,
		...overrides,
	};
}

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build_target: POSTGRESQL_WEB_APPLICATION_OUTPUT,
		runtime_storage_target: POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
		seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [ROW2] } },
		include: { assets: [ASSET], functions: ['functions/linear.ts'], scripts: ['scripts/start.ts'], config: ['config/app.json'] },
		output_path: 'build/out',
		...overrides,
	};
}

function rejects(stage: BuildValidationStage, run: () => unknown, message: RegExp): void {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof BuildValidationError, String(error));
		assert.strictEqual(error.stage, stage);
		assert.match(error.message, message);
		return true;
	});
}

suite('Primitive App Editor - Build Configuration / Target Filter / Validation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pipeline stage order follows the SSOT', () => {
		assert.deepStrictEqual(buildValidationStages, [
			'Build Configuration Validate', 'Registry Validate', 'Physical Schema Validate', 'Relation Validate',
			'Function Executor Validate', 'Dependency Validate', 'Runtime Address Validate', 'Renderer Validate', 'Asset Validate',
		]);
	});

	test('Build Configuration contract: normalized, input untouched', () => {
		const input = configuration({ output_path: './build//out/', seed_data: { include: true, raw_data: { tables: [PLAYER.toUpperCase()], exclude_rows: [] } } });
		const created = createBuildConfiguration(input);
		assert.strictEqual(created.output_path, 'build/out');
		assert.deepStrictEqual(created.seed_data.raw_data.tables, [PLAYER]);
		assert.strictEqual((input.seed_data as { raw_data: { tables: string[] } }).raw_data.tables[0], PLAYER.toUpperCase());
	});

	test('Build Configuration rejects unsupported target pairs, output_path outside build/, and malformed fields', () => {
		const stage = BuildValidationStage.BuildConfiguration;
		rejects(stage, () => createBuildConfiguration(configuration({ build_target: 'Other' })), /not provided/);
		rejects(stage, () => createBuildConfiguration(configuration({ runtime_storage_target: 'Rails / MySQL' })), /does not support/);
		for (const output of ['dist', 'buildx/out', '../build/out', 'build/../dist', '/build/out', 'C:/build', '']) {
			rejects(stage, () => createBuildConfiguration(configuration({ output_path: output })), /output_path/);
		}
		assert.strictEqual(createBuildConfiguration(configuration({ output_path: 'build' })).output_path, 'build');
		rejects(stage, () => createBuildConfiguration(configuration({ seed_data: { include: 'yes', raw_data: { tables: [], exclude_rows: [] } } })), /bool/);
		rejects(stage, () => createBuildConfiguration(configuration({ seed_data: { include: true, raw_data: { tables: ['x'], exclude_rows: [] } } })), /UUIDs/);
		rejects(stage, () => createBuildConfiguration(configuration({ seed_data: { include: true, raw_data: { tables: [PLAYER, PLAYER], exclude_rows: [] } } })), /more than once/);
		rejects(stage, () => createBuildConfiguration(configuration({ include: { assets: [], functions: ['../x'], scripts: [], config: [] } })), /relative paths/);
		rejects(stage, () => createBuildConfiguration(null), /object/);
	});

	test('Build Target Filter: Raw Data by include/tables/exclude_rows, content by include.*, Registry and Bindings whole, read-only', () => {
		const data = authoring();
		const snapshot = JSON.stringify(data);
		const view = applyBuildTargetFilter(data, createBuildConfiguration(configuration()));
		assert.deepStrictEqual(view.rawData.map(table => [table.table_uuid, table.rows.map(row => row.uuid)]), [[PLAYER, [ROW1]]]);
		assert.deepStrictEqual(view.assets.map(asset => asset.uuid), [ASSET]);
		assert.deepStrictEqual([view.functionPaths, view.scriptPaths, view.configPaths], [['functions/linear.ts'], ['scripts/start.ts'], ['config/app.json']]);
		assert.strictEqual(view.tables, data.tables);
		assert.strictEqual(view.bindings, data.bindings);
		assert.strictEqual(view.rendererBindings, data.rendererBindings);
		assert.strictEqual(view.functions, data.functions);
		assert.strictEqual(JSON.stringify(data), snapshot);

		const none = applyBuildTargetFilter(data, createBuildConfiguration(configuration({ seed_data: { include: false, raw_data: { tables: [PLAYER], exclude_rows: [] } } })));
		assert.deepStrictEqual(none.rawData, []);
		const unlisted = applyBuildTargetFilter(data, createBuildConfiguration(configuration({ seed_data: { include: true, raw_data: { tables: [], exclude_rows: [] } } })));
		assert.deepStrictEqual(unlisted.rawData, []);
		// deterministic
		assert.deepStrictEqual(applyBuildTargetFilter(data, createBuildConfiguration(configuration())), view);
	});

	test('a valid Build passes every stage and returns the Selected Authoring View', () => {
		const result = validateBuild(authoring(), configuration());
		assert.strictEqual(result.configuration.output_path, 'build/out');
		assert.deepStrictEqual(result.view.rawData[0].rows.map(row => row.uuid), [ROW1]);
	});

	test('Build Configuration Validate: listed Table / Row / Asset / Path must exist', () => {
		const stage = BuildValidationStage.BuildConfiguration;
		rejects(stage, () => validateBuild(authoring(), configuration({ seed_data: { include: true, raw_data: { tables: [MISSING], exclude_rows: [] } } })), /table_registry/);
		rejects(stage, () => validateBuild(authoring(), configuration({ seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [MISSING] } } })), /row/);
		rejects(stage, () => validateBuild(authoring(), configuration({ include: { assets: [MISSING], functions: ['functions/linear.ts'], scripts: [], config: [] } })), /Asset Registry/);
		rejects(stage, () => validateBuild(authoring(), configuration({ include: { assets: [ASSET], functions: ['functions/linear.ts'], scripts: ['scripts/nope.ts'], config: [] } })), /Working Directory/);
	});

	test('Function Executor Validate: the Program of every required executor must be in include.functions', () => {
		const stage = BuildValidationStage.FunctionExecutor;
		const noFunctions = { assets: [ASSET], functions: [], scripts: [], config: [] };
		rejects(stage, () => validateBuild(authoring(), configuration({ include: noFunctions })), /not in include\.functions/);
		rejects(stage, () => validateBuild(authoring({ resolveExecutorProgram: () => undefined }), configuration()), /has no Program/);
		rejects(stage, () => validateBuild(authoring({ executorCatalog: { has: () => false } }), configuration()), /does not exist in Code/);
		// An executor no binding uses is not required.
		assert.ok(validateBuild(authoring({ bindings: [] }), configuration({ include: noFunctions })));
	});

	test('Registry / Dependency / Relation stages reject through their existing validators', () => {
		const data = authoring();
		const dropped = { ...data.bindings[0], function: { uuid: MISSING } };
		rejects(BuildValidationStage.FunctionExecutor, () => validateBuild(authoring({ bindings: [dropped] }), configuration()), /Missing Definition/);
		const unknownTable = { ...data.bindings[0], target: { ...data.bindings[0].target, address: { ...data.bindings[0].target.address, table_uuid: MISSING } } };
		rejects(BuildValidationStage.Dependency, () => validateBuild(authoring({ bindings: [unknownTable] }), configuration()), /table_registry/);
		rejects(BuildValidationStage.Registry, () => validateBuild(authoring({ tables: [data.tables[0], data.tables[0]] }), configuration()), /duplicate|more than once|unique/i);
	});

	test('Relation Validate: a relation referencing a missing column rejects', () => {
		const relation = createRelationRegistryEntry({
			index: 0, main_table: PLAYER,
			relations: [{ join_table: ENEMY, main_column: { column_uuid: MISSING }, join_column: { column_uuid: FATIGUE }, relation_type: RelationType.Inner }],
		}, undefined, () => new Date(NOW));
		rejects(BuildValidationStage.Relation, () => validateBuild(authoring({ relations: [relation] }), configuration()), /./);
	});

	test('Runtime Address Validate: a Binding must not reference a Row removed by the Build Target Filter', () => {
		const stage = BuildValidationStage.RuntimeAddress;
		// ROW1 is bound; excluding it, leaving its table out, or turning Seed off removes it.
		rejects(stage, () => validateBuild(authoring(), configuration({ seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [ROW1] } } })), /excluded by the Build Target Filter/);
		rejects(stage, () => validateBuild(authoring(), configuration({ seed_data: { include: true, raw_data: { tables: [ENEMY], exclude_rows: [] } } })), /excluded/);
		rejects(stage, () => validateBuild(authoring(), configuration({ seed_data: { include: false, raw_data: { tables: [PLAYER], exclude_rows: [] } } })), /excluded/);
		// A Row that never existed in Raw Data is not the Filter's doing.
		assert.ok(validateBuild(authoring({ rawData: [] }), configuration({ seed_data: { include: false, raw_data: { tables: [], exclude_rows: [] } } })));
		// An excluded Row nobody references is fine.
		assert.ok(validateBuild(authoring(), configuration({ seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [ROW2] } } })));
	});

	test('Renderer Validate: Renderer Binding is checked against renderer_registry', () => {
		const data = authoring();
		const broken = { ...data.rendererBindings[0], renderer: { uuid: MISSING } };
		rejects(BuildValidationStage.Renderer, () => validateBuild(authoring({ rendererBindings: [broken] }), configuration()), /Missing Definition/);
	});

	test('Asset Validate: an asset a Renderer Binding references must be in include.assets', () => {
		const stage = BuildValidationStage.Asset;
		rejects(stage, () => validateBuild(authoring(), configuration({ include: { assets: [ASSET2], functions: ['functions/linear.ts'], scripts: [], config: [] } })), /not in include\.assets/);
		rejects(stage, () => validateBuild(authoring({}, { sprite: { asset_uuid: MISSING } }), configuration()), /not in the Asset Registry/);
		const address = { table_uuid: PLAYER, row_uuid: ROW1, column_uuid: FATIGUE };
		assert.ok(validateBuild(authoring({}, { sprite: { address } }), configuration({ include: { assets: [], functions: ['functions/linear.ts'], scripts: [], config: [] } })));
	});

	test('validation never writes Authoring Data', () => {
		const data = authoring();
		const before = JSON.stringify(data);
		validateBuild(data, configuration());
		assert.strictEqual(JSON.stringify(data), before);
	});
});
