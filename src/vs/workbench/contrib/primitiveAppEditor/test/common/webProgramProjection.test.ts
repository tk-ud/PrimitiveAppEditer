/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - ASP.NET Core API and Next.js application projection (build.web-program)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. Web Application Program)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BuildValidationError, IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE } from '../../common/buildValidation.js';
import { createFunctionBindingEntry } from '../../common/functionBinding.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { createFunctionRegistryEntry } from '../../common/functionRegistry.js';
import { POSTGRESQL_INIT_FILE, projectPostgresqlApplicationOutput } from '../../common/postgresqlProjection.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { createRendererBindingEntry, createRendererRegistryEntry } from '../../common/rendererRegistry.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';
import { projectWebProgramApplicationOutput, WEB_PROGRAM_DEFINITION_FILE } from '../../common/webProgramProjection.js';

const PLAYER = '00000000-0000-4000-8000-0000000000a1';
const FATIGUE = '00000000-0000-4000-8000-0000000000c1';
const ROW1 = '00000000-0000-4000-8000-0000000000b1';
const FN = '00000000-0000-4000-8000-0000000000f1';
const BIND = '00000000-0000-4000-8000-0000000000d1';
const RENDERER = '00000000-0000-4000-8000-0000000000e1';
const RBIND = '00000000-0000-4000-8000-0000000000e2';
const NOW = '2026-10-18T00:00:00.000Z';

function authoring(tableName = 'player'): IBuildAuthoringData {
	const column = { uuid: FATIGUE, index: 0, name: 'fatigue', kind: TableColumnKind.Double, not_null: false, writable: true, searchable: true };
	const player = createTableRegistryEntry({ uuid: PLAYER, index: 0, schema: LogicalNamespace.Items, name: tableName, columns: [column], created_at: NOW });
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
		rawData: [{ table_uuid: PLAYER, rows: [{ uuid: ROW1, values: { [FATIGUE]: 1 } }] }],
		workingDirectoryPaths: ['functions/linear.ts'],
		executorCatalog: createFunctionPrimitiveExecutorCatalog(),
		resolveExecutorProgram: executor => executor === 'Linear' ? 'functions/linear.ts' : undefined,
	};
}

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build_target: POSTGRESQL_WEB_APPLICATION_OUTPUT,
		runtime_storage_target: POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE,
		seed_data: { include: true, raw_data: { tables: [PLAYER], exclude_rows: [] } },
		include: { assets: [], functions: ['functions/linear.ts'], scripts: [], config: [] },
		output_path: 'build/out',
		...overrides,
	};
}

suite('Primitive App Editor - ASP.NET Core API and Next.js application projection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects the C# API, the Next.js UI and the Application Definition, sorted by path', () => {
		const { result } = projectWebProgramApplicationOutput(authoring(), configuration());
		const paths = result.files.map(file => file.path);
		assert.deepStrictEqual(paths, [...paths].sort());
		for (const expected of [WEB_PROGRAM_DEFINITION_FILE, 'api/Program.cs', 'api/TableRuntime.cs', 'api/RequestValidation.cs', 'api/FunctionRuntime.cs', 'api/PrimitiveApplication.Api.csproj', 'ui/package.json', 'ui/app/page.tsx', 'ui/lib/renderers.tsx', 'ui/lib/api.ts']) {
			assert.ok(paths.includes(expected), `missing ${expected}`);
		}
	});

	test('Application Definition carries Registry / Binding but no Seed Raw Data', () => {
		const { result } = projectWebProgramApplicationOutput(authoring(), configuration());
		const definition = JSON.parse(result.files.find(file => file.path === WEB_PROGRAM_DEFINITION_FILE)!.content);
		assert.deepStrictEqual(Object.keys(definition).sort(), ['bindings', 'functions', 'relations', 'renderers', 'tables']);
		assert.deepStrictEqual(definition.tables.map((t: { uuid: string; schema: string; name: string }) => [t.uuid, t.schema, t.name]), [[PLAYER, 'items', 'player']]);
		assert.deepStrictEqual(definition.tables[0].columns.map((c: { name: string; kind: string }) => [c.name, c.kind]), [['uuid', 'uuid'], ['fatigue', 'double']]);
		assert.strictEqual(definition.bindings.functions[0].uuid, BIND);
		assert.strictEqual(definition.bindings.renderers[0].uuid, RBIND);
		assert.ok(!JSON.stringify(definition).includes('rows'));
	});

	test('API table identifiers are those of 001_init_postgresql.sql (same schema projection)', () => {
		const data = authoring();
		const web = projectWebProgramApplicationOutput(data, configuration()).result;
		const pg = projectPostgresqlApplicationOutput(data, configuration()).result;
		assert.deepStrictEqual(web.schema, pg.schema);
		assert.ok(pg.files.find(file => file.path === POSTGRESQL_INIT_FILE)!.content.includes('"items"."player"'));
	});

	test('API reaches PostgreSQL by parameters only and quotes identifiers from the Definition', () => {
		const api = projectWebProgramApplicationOutput(authoring(), configuration()).result.files.filter(file => file.path.startsWith('api/')).map(file => file.content).join('\n');
		assert.ok(api.includes(`Include="../${WEB_PROGRAM_DEFINITION_FILE}"`), 'API project links the shared Application Definition');
		assert.match(api, /NpgsqlDataSource/);
		assert.match(api, /interface IApplicationFunction/);
		assert.match(api, /MapPost\("\/api\/functions\/\{binding\}"/);
		assert.ok(api.includes('${i + 1}'));
		// Boundary: no dependency on the Node-side Editor API or a fixed transport to it.
		assert.ok(!/primitiveAppEditor|workbench|vscode/i.test(api));
	});

	test('API validates Insert / Update bodies against the Definition and answers 400 ProblemDetails before any SQL', () => {
		const files = projectWebProgramApplicationOutput(authoring(), configuration()).result.files;
		const program = files.find(file => file.path === 'api/Program.cs')!.content;
		const validation = files.find(file => file.path === 'api/RequestValidation.cs')!.content;
		assert.match(program, /RequestValidation\.Validate\(t, values, isInsert: true\)[\s\S]*Results\.ValidationProblem\(errors\)[\s\S]*runtime\.InsertAsync/);
		assert.match(program, /RequestValidation\.Validate\(t, values, isInsert: false\)[\s\S]*Results\.ValidationProblem\(errors\)[\s\S]*runtime\.UpdateAsync/);
		assert.match(validation, /JsonValueKind\.Object/);
		assert.match(validation, /isInsert && column\.NotNull/);
		for (const kind of ['uuid', 'int', 'double', 'bool', 'date', 'timestamp']) {
			assert.ok(validation.includes(`"${kind}" =>`), `kind ${kind}`);
		}
		assert.ok(!/primitiveAppEditor|workbench|vscode/i.test(validation));
	});

	test('UUID validation uses JsonElement.TryGetGuid so it accepts exactly what GetGuid converts (Issue #85)', () => {
		const validation = projectWebProgramApplicationOutput(authoring(), configuration()).result.files.find(file => file.path === 'api/RequestValidation.cs')!.content;
		assert.match(validation, /"uuid" => value\.ValueKind == JsonValueKind\.String && value\.TryGetGuid\(out _\)/);
		assert.ok(!/Guid\.TryParse/.test(validation));
	});

	test('UI resolves Renderer Binding values through the C# API', () => {
		const files = projectWebProgramApplicationOutput(authoring(), configuration()).result.files;
		const page = files.find(file => file.path === 'ui/app/page.tsx')!.content;
		const api = files.find(file => file.path === 'ui/lib/api.ts')!.content;
		assert.match(page, /selectRows/);
		assert.match(page, /rendererComponents\[renderer\.executor\]/);
		assert.match(api, /\/api\/tables\//);
		assert.ok(api.includes('`${API_BASE}${path}`'));
	});

	test('is deterministic and does not modify Authoring Data', () => {
		const data = authoring();
		const snapshot = JSON.stringify(data);
		const first = projectWebProgramApplicationOutput(data, configuration()).result;
		const second = projectWebProgramApplicationOutput(data, configuration()).result;
		assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
		assert.strictEqual(JSON.stringify(data), snapshot);
	});

	test('rejects an invalid Build and an invalid Registry before producing anything', () => {
		assert.throws(() => projectWebProgramApplicationOutput(authoring(), configuration({ build_target: 'Unknown' })), BuildValidationError);
		assert.throws(() => projectWebProgramApplicationOutput(authoring('x'.repeat(64)), configuration()), /exceeds 63 bytes/);
	});
});
