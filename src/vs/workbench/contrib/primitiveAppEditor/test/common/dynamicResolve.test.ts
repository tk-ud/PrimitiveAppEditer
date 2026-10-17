/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Dynamic Resolve (resolver.dynamic)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (Dynamic Resolve)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createDynamicUpdateAction, defaultDynamicResolveDefinition, DynamicActionType, DynamicResolveError, DynamicResolver, DynamicSurface, dispatchDynamicAction, IDynamicInspector, IDynamicResolveContext, parseDynamicResolveDefinition } from '../../common/dynamicResolve.js';
import { EditorControlType } from '../../common/editorControls.js';
import { createEnumRegistryEntry, EnumRegistryIndex } from '../../common/enumRegistry.js';
import { createRelationRegistryEntry } from '../../common/relationRegistry.js';
import { IAppEditorApi, IResolverOperationRequest, IResolverResult, ResolverOperation } from '../../common/resolver.js';
import { createTableRegistryEntry, TableColumnKind } from '../../common/tableRegistry.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ELEMENT = id(1);
const ENEMY = id(0xa1);
const PLAYER = id(0xa2);
const R1 = id(0xb1);
const P1 = id(0xb2);
const R2 = id(0xb3);
const BINDING_R2 = id(0xe6);
const FUNCTION = id(0xe1);
const BINDING = id(0xe2);
const RENDERER = id(0xe3);
const RENDERER_BINDING = id(0xe4);
const ASSET = id(0xe5);

const col = (n: number, index: number, name: string, kind: TableColumnKind, extra: object = {}) => ({ uuid: id(n), index, name, kind, not_null: false, writable: true, searchable: true, ...extra });
const enumEntry = createEnumRegistryEntry({ uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water' }] });
const player = createTableRegistryEntry({ uuid: PLAYER, index: 1, schema: 'items', name: 'player', label: 'Player', columns: [col(0xc6, 0, 'name', TableColumnKind.Text)] });
const enemy = createTableRegistryEntry({
	uuid: ENEMY, index: 0, schema: 'items', name: 'enemy', label: 'Enemy', columns: [
		col(0xc1, 0, 'hp', TableColumnKind.Int, { label: 'HP', not_null: true }),
		col(0xc7, 1, 'name', TableColumnKind.Text, { label: 'Name' }),
		col(0xc9, 2, 'element', TableColumnKind.Enum, { enum: ELEMENT }),
		col(0xca, 3, 'owner', TableColumnKind.Uuid, { label: 'Owner' }),
	],
});
const relation = createRelationRegistryEntry({ index: 0, main_table: ENEMY, relations: [{ join_table: PLAYER, main_column: { column_uuid: id(0xca) }, join_column: { column_uuid: id(0xc6) }, relation_type: 'left' }] });

function context(overrides: Partial<IDynamicResolveContext> = {}): IDynamicResolveContext {
	const address = { table_uuid: ENEMY, row_uuid: R1, column_uuid: id(0xc1) };
	return {
		tables: [enemy, player],
		enums: new EnumRegistryIndex([enumEntry]),
		enumEntries: [enumEntry],
		relations: [relation],
		functions: [{ uuid: FUNCTION, name: 'damage', label: 'Damage', index: 0, executor: 'builtin.damage', input: [], constructor: [], parameters: [], output: { kind: 'int' }, created_at: '2026-01-01T00:00:00.000Z' }],
		renderers: [{ uuid: RENDERER, name: 'sprite', index: 0, executor: 'builtin.sprite', inputs: [{ name: 'x', kind: 'int' }], created_at: '2026-01-01T00:00:00.000Z' }],
		assets: [{ uuid: ASSET, name: 'goblin', index: 0, kind: 'image' as never, source: 'assets/image/goblin.png', metadata: {} }],
		functionBindings: [{
			uuid: BINDING, index: 0, function: { uuid: FUNCTION }, constructor: {}, execution: { kind: 'frame' as never }, inputs: {}, parameters: {},
			target: { address, merge: { kind: 'overwrite' as never } }, created_at: '2026-01-01T00:00:00.000Z',
		}],
		rendererBindings: [{ uuid: RENDERER_BINDING, renderer: { uuid: RENDERER }, bindings: { x: { asset_uuid: ASSET } }, created_at: '2026-01-01T00:00:00.000Z' }],
		...overrides,
	};
}

function fakeApi(requests: IResolverOperationRequest[] = [], rows: Record<string, readonly { uuid: string; values: Record<string, unknown> }[]> = {}): IAppEditorApi {
	const dispatch = (operation: ResolverOperation) => async (request: IResolverOperationRequest): Promise<IResolverResult> => {
		requests.push(request);
		const found = operation === ResolverOperation.Select ? rows[request.target.uuid ?? ''] ?? [] : 'ok';
		return { operation, kind: request.target.kind ?? 'raw', result: found };
	};
	return {
		create: dispatch(ResolverOperation.Create), alter: dispatch(ResolverOperation.Alter), truncate: dispatch(ResolverOperation.Truncate), drop: dispatch(ResolverOperation.Drop),
		insert: dispatch(ResolverOperation.Insert), delete: dispatch(ResolverOperation.Delete), update: dispatch(ResolverOperation.Update), upsert: dispatch(ResolverOperation.Upsert), select: dispatch(ResolverOperation.Select),
	};
}

const rows = {
	[ENEMY]: [{ uuid: R1, values: { [id(0xc1)]: 50, [id(0xc7)]: 'Enemy_001', [id(0xc9)]: 'fire', [id(0xca)]: P1 } }],
	[PLAYER]: [{ uuid: P1, values: { [id(0xc6)]: 'Alice' } }],
};

suite('Primitive App Editor - Dynamic Resolve', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const resolver = new DynamicResolver();

	test('Empty Selection is neutral and has no Mutation Target', async () => {
		assert.deepStrictEqual(await resolver.resolve(undefined, context(), fakeApi()), { empty: true });
	});

	test('a Row Selection resolves to Registry-driven components, labelled without the UUID', async () => {
		const inspector = await resolver.resolve({ uuid: R1.toUpperCase(), table_uuid: ENEMY }, context(), fakeApi([], rows)) as IDynamicInspector;
		assert.strictEqual(inspector.kind, 'row');
		assert.strictEqual(inspector.label, 'Enemy_001');
		assert.deepStrictEqual(inspector.address, { tableUuid: ENEMY, rowUuid: R1 });
		assert.strictEqual(inspector.properties?.surface, DynamicSurface.SecondarySideBar);
		assert.deepStrictEqual(inspector.properties?.components.map(component => [component.label, component.control]), [
			['HP', EditorControlType.NumberField], ['Name', EditorControlType.TextField], ['element', EditorControlType.Select], ['Owner', EditorControlType.RelationSelect],
		]);
		assert.strictEqual(inspector.properties?.components[2].displayValue, 'Fire');
		assert.strictEqual(inspector.properties?.components[3].displayValue, 'Alice');
		assert.deepStrictEqual(inspector.binding?.entries.map(entry => [entry.kind, entry.label]), [['function_binding', 'Damage → Enemy > HP']]);
		assert.deepStrictEqual(inspector.navigation?.actions.map(action => [action.type, action.surface]), [[DynamicActionType.Open, DynamicSurface.EditorArea]]);
		assert.ok(!JSON.stringify(inspector.properties?.components.map(component => component.label)).includes('0000'));
	});

	test('a Row Selection lists only the Bindings addressing that Row', async () => {
		const base = context();
		const other = { ...base.functionBindings[0], uuid: BINDING_R2, target: { ...base.functionBindings[0].target, address: { table_uuid: ENEMY, row_uuid: R2, column_uuid: id(0xc1) } } };
		const shared = context({ functionBindings: [...base.functionBindings, other] });
		const twoRows = { ...rows, [ENEMY]: [...rows[ENEMY], { uuid: R2, values: { [id(0xc1)]: 7, [id(0xc7)]: 'Enemy_002', [id(0xc9)]: 'fire', [id(0xca)]: P1 } }] };
		for (const [row, expected] of [[R1, BINDING], [R2, BINDING_R2]]) {
			const inspector = await resolver.resolve({ uuid: row, table_uuid: ENEMY }, shared, fakeApi([], twoRows)) as IDynamicInspector;
			assert.deepStrictEqual(inspector.binding?.entries.map(entry => entry.uuid), [expected]);
			assert.deepStrictEqual(inspector.binding?.entries.map(entry => entry.remove.request?.target.uuid), [expected]);
		}
	});

	test('a stale Row or unknown table is rejected, never guessed', async () => {
		await assert.rejects(resolver.resolve({ uuid: id(0xff), table_uuid: ENEMY }, context(), fakeApi([], rows)), /stale Selection/);
		await assert.rejects(resolver.resolve({ uuid: R1, table_uuid: id(0xfe) }, context(), fakeApi([], rows)), /Missing Definition/);
	});

	test('a display label is not a Persistent Identity', async () => {
		await assert.rejects(resolver.resolve({ uuid: 'Enemy' }, context(), fakeApi()), /must be a UUID/);
		await assert.rejects(resolver.resolve({ uuid: R1, table_uuid: 'Enemy' }, context(), fakeApi()), /must be a UUID/);
	});

	test('definition and binding Selections resolve by UUID to one Kind', async () => {
		const table = await resolver.resolve({ uuid: ENEMY }, context(), fakeApi()) as IDynamicInspector;
		assert.deepStrictEqual([table.kind, table.label, table.binding], ['table', 'Enemy', undefined]);
		assert.strictEqual(table.properties?.definition[0].value, 'HP, Name, element, Owner');

		const fn = await resolver.resolve({ uuid: FUNCTION }, context(), fakeApi()) as IDynamicInspector;
		assert.deepStrictEqual([fn.kind, fn.label], ['function', 'Damage']);
		assert.deepStrictEqual(fn.binding?.entries.map(entry => entry.uuid), [BINDING]);

		const asset = await resolver.resolve({ uuid: ASSET }, context(), fakeApi()) as IDynamicInspector;
		assert.deepStrictEqual([asset.kind, asset.label, asset.binding?.entries.map(entry => entry.label)], ['asset', 'goblin', ['sprite']]);

		const renderer = await resolver.resolve({ uuid: RENDERER }, context(), fakeApi()) as IDynamicInspector;
		assert.strictEqual(renderer.binding?.entries[0].kind, 'renderer_binding');

		const enumeration = await resolver.resolve({ uuid: ELEMENT }, context(), fakeApi()) as IDynamicInspector;
		assert.deepStrictEqual([enumeration.kind, enumeration.properties?.definition[0].value], ['enum', 'Fire, water']);

		const binding = await resolver.resolve({ uuid: BINDING }, context(), fakeApi()) as IDynamicInspector;
		assert.deepStrictEqual([binding.kind, binding.label], ['function_binding', 'Damage → Enemy > HP']);
	});

	test('a missing or ambiguous UUID is rejected', async () => {
		await assert.rejects(resolver.resolve({ uuid: id(0xee) }, context(), fakeApi()), /Missing Definition/);
		const duplicate = context({ renderers: [{ ...context().renderers[0], uuid: ENEMY }], rendererBindings: [] });
		await assert.rejects(resolver.resolve({ uuid: ENEMY }, duplicate, fakeApi()), /Ambiguous Target/);
	});

	test('a Binding that references a missing Definition is rejected, not labelled by UUID', async () => {
		await assert.rejects(resolver.resolve({ uuid: BINDING }, context({ functions: [] }), fakeApi()), /Missing Definition/);
	});

	test('Mutation is a Primitive request dispatched to the Resolver', async () => {
		const requests: IResolverOperationRequest[] = [];
		const api = fakeApi(requests, rows);
		const inspector = await resolver.resolve({ uuid: R1, table_uuid: ENEMY }, context(), api) as IDynamicInspector;
		requests.length = 0;

		const save = createDynamicUpdateAction(inspector, id(0xc1), 9);
		assert.strictEqual(save.request?.operation, ResolverOperation.Update);
		assert.strictEqual(await dispatchDynamicAction(api, save), 'ok');
		assert.deepStrictEqual(requests, [{ target: { kind: 'raw', uuid: ENEMY }, address: { table_uuid: ENEMY, row_uuid: R1, column_uuid: id(0xc1) }, payload: { [id(0xc1)]: 9 } }]);

		requests.length = 0;
		const remove = inspector.binding!.entries[0].remove;
		await dispatchDynamicAction(api, remove);
		assert.deepStrictEqual(requests, [{ target: { kind: 'function_binding', uuid: BINDING } }]);

		assert.throws(() => dispatchDynamicAction(api, inspector.navigation!.actions[0]), DynamicResolveError);
		const definitionInspector = await resolver.resolve({ uuid: ENEMY }, context(), api) as IDynamicInspector;
		assert.throws(() => createDynamicUpdateAction(definitionInspector, id(0xc1), 1), /no Mutation Target/);
	});

	test('the resolver is generated from a Structured Definition and the Definition is validated', async () => {
		const narrow = new DynamicResolver(parseDynamicResolveDefinition({ selections: [{ kind: 'entity', source: 'table', sections: { properties: 'editor_area' } }] }));
		assert.deepStrictEqual(narrow.kinds, ['entity']);
		const inspector = await narrow.resolve({ uuid: ENEMY }, context(), fakeApi()) as IDynamicInspector;
		assert.deepStrictEqual([inspector.kind, inspector.properties?.surface, inspector.binding, inspector.navigation], ['entity', DynamicSurface.EditorArea, undefined, undefined]);
		await assert.rejects(narrow.resolve({ uuid: FUNCTION }, context(), fakeApi()), /Missing Definition/);

		assert.doesNotThrow(() => parseDynamicResolveDefinition(defaultDynamicResolveDefinition));
		for (const bad of [
			null, {}, { selections: [null] },
			{ selections: [{ kind: '', source: 'table', sections: {} }] },
			{ selections: [{ kind: 'a', source: 'nope', sections: {} }] },
			{ selections: [{ kind: 'a', source: 'table', sections: { properties: 'moon' } }] },
			{ selections: [{ kind: 'a', source: 'table', sections: { binding_inspector: 'editor_area' } }] },
			{ selections: [{ kind: 'a', source: 'table', sections: {}, open: 'moon' }] },
			{ selections: [{ kind: 'a', source: 'table', sections: {} }, { kind: 'a', source: 'enum', sections: {} }] },
			{ selections: [{ kind: 'a', source: 'table', sections: {} }, { kind: 'b', source: 'table', sections: {} }] },
		]) {
			assert.throws(() => parseDynamicResolveDefinition(bad), DynamicResolveError);
		}
	});

	test('the resolver holds no Application name', () => {
		const text = JSON.stringify(defaultDynamicResolveDefinition);
		for (const name of ['enemy', 'player', 'hp', 'damage']) {
			assert.ok(!text.toLowerCase().includes(name), name);
		}
	});
});
