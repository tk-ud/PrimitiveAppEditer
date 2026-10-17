/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Registry-driven generic editor controls on project.sqlite (editor.registry-ui)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (25. Editor UI, Kind Dispatch)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { createEditorControls, createRelationSource, dispatchEditorControl, EditorControlType, saveEditorValue } from '../../common/editorControls.js';
import { EditorDdlMigrator } from '../../common/editorDdl.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { EnumRegistryIndex, readEnumRegistry } from '../../common/enumRegistry.js';
import { FunctionBindingService } from '../../common/functionBinding.js';
import { FunctionDependencyService } from '../../common/functionDependency.js';
import { createFunctionExecutorCatalog } from '../../common/functionRegistry.js';
import { openProjectDirectory, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { LogicalNamespace, ProjectSqliteStorage } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { readRelationRegistry } from '../../common/relationRegistry.js';
import { RendererBindingService } from '../../common/rendererRegistry.js';
import { IResolverServices, Resolver } from '../../common/resolver.js';
import { readTableRegistry, TableColumnKind } from '../../common/tableRegistry.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

const ENEMY = '00000000-0000-4000-8000-0000000000a1';
const PLAYER = '00000000-0000-4000-8000-0000000000a2';
const ELEMENT = '00000000-0000-4000-8000-0000000000e1';
const HP = '00000000-0000-4000-8000-0000000000c1';
const ELEM_COL = '00000000-0000-4000-8000-0000000000c3';
const OWNER = '00000000-0000-4000-8000-0000000000c4';
const NAME = '00000000-0000-4000-8000-0000000000c6';
const PID = '00000000-0000-4000-8000-0000000000c8';
const LOCKED = '00000000-0000-4000-8000-0000000000c9';
const R1 = '00000000-0000-4000-8000-0000000000b1';
const P1 = '00000000-0000-4000-8000-0000000000b2';
const REL = '00000000-0000-4000-8000-0000000000d5';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');
const col = (uuid: string, index: number, name: string, kind: TableColumnKind, extra: object = {}) => ({ uuid, index, name, kind, not_null: false, writable: true, searchable: true, ...extra });

suite('Primitive App Editor - generic Resolver primitives on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-resolver-'));
		root = URI.file(join(tempRoot, 'game'));
	});

	teardown(async () => {
		await Promise.all(storages.splice(0).map(storage => storage.close()));
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** An opened project with an EMPTY Registry: every definition below is created through the Resolver itself. */
	async function open() {
		const storage = new ProjectSqliteStorage(factory);
		storages.push(storage);
		const migrator = new EditorDdlMigrator(storage, editorDdlResources);
		const done = async () => { };
		const result = await openProjectDirectory(fileService, root, {
			createStorage: context => storage.createStorage(context),
			openStorage: context => storage.openStorage(context),
			editorDdlScan: context => migrator.editorDdlScan(context),
			schemaVersionResolve: context => migrator.schemaVersionResolve(context),
			migrationApply: context => migrator.migrationApply(context),
			registryLoad: done,
			functionScan: done,
			assetScan: done,
		});
		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		const services: IResolverServices = {
			database: storage.database,
			registry: new RegistryService(storage.database),
			rawData: new RawDataService(storage.database),
			functionBinding: new FunctionBindingService(storage.database, catalog, { now }),
			functionDependency: new FunctionDependencyService(storage.database, { now }),
			rendererBinding: new RendererBindingService(storage.database, { now }),
		};
		return { storage, services, resolver: new Resolver(services) };
	}

	test('controls are derived from the Registry, saved through update, and relation values resolve to a human label', async () => {
		const { storage, resolver } = await open();
		await resolver.create({ target: { kind: 'enum' }, payload: { uuid: ELEMENT, index: 0, name: 'element', values: [{ value: 'fire', label: 'Fire' }, { value: 'water' }] } });
		await resolver.create({ target: { kind: 'table' }, payload: { uuid: PLAYER, index: 1, schema: LogicalNamespace.Items, name: 'player', columns: [col(NAME, 0, 'name', TableColumnKind.Text), col(PID, 1, 'pid', TableColumnKind.Uuid)] } });
		await resolver.create({
			target: { kind: 'table' }, payload: {
				uuid: ENEMY, index: 0, schema: LogicalNamespace.Items, name: 'enemy', label: 'Enemy', columns: [
					col(HP, 0, 'hp', TableColumnKind.Int, { not_null: true }),
					col(ELEM_COL, 1, 'element', TableColumnKind.Enum, { enum: ELEMENT }),
					col(OWNER, 2, 'owner', TableColumnKind.Uuid, { label: 'Owner' }),
					col(LOCKED, 3, 'locked', TableColumnKind.Bool, { writable: false }),
				],
			},
		});
		await resolver.create({ target: { kind: 'relation', uuid: REL }, payload: { index: 0, main_table: ENEMY, relations: [{ join_table: PLAYER, main_column: { column_uuid: OWNER }, join_column: { column_uuid: PID }, relation_type: 'left' }] } });
		await resolver.insert({ target: { kind: 'raw', uuid: PLAYER }, address: { row_uuid: P1 }, payload: { name: 'Alice' } });
		await resolver.insert({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 }, payload: { hp: 50, element: 'fire', owner: P1 } });

		const tables = await readTableRegistry(storage.database);
		const enemy = tables.find(table => table.uuid === ENEMY)!;
		const enums = new EnumRegistryIndex(await readEnumRegistry(storage.database));
		const relations = await readRelationRegistry(storage.database);
		const source = createRelationSource(resolver, enemy, tables, relations);
		const load = async () => {
			const rows = (await resolver.select({ target: { kind: 'raw', uuid: ENEMY }, address: { row_uuid: R1 } })).result as { values: Record<string, unknown> }[];
			return createEditorControls(enemy, rows[0].values, enums, source);
		};

		const controls = await load();
		assert.deepStrictEqual(controls.map(control => control.control), [EditorControlType.NumberField, EditorControlType.Select, EditorControlType.RelationSelect, EditorControlType.Checkbox]);
		assert.strictEqual(controls[1].displayValue, 'Fire');
		assert.strictEqual(controls[2].label, 'Owner');
		assert.strictEqual(controls[2].displayValue, 'Alice');
		assert.deepStrictEqual(controls[2].options, [{ value: P1, label: 'Alice' }]);
		assert.strictEqual(controls[3].readOnly, true);

		// Save -> update(request); the component is re-derived from Raw Data
		const address = { tableUuid: ENEMY, rowUuid: R1 };
		const column = (uuid: string) => enemy.columns.find(candidate => candidate.uuid === uuid)!;
		await saveEditorValue(resolver, address, column(HP), 45, enums);
		await saveEditorValue(resolver, address, column(ELEM_COL), 'water', enums);
		const saved = await load();
		assert.strictEqual(saved[0].value, 45);
		assert.strictEqual(saved[1].displayValue, 'water');

		// invalid / read-only values are rejected, Raw Data is unchanged
		await assert.rejects(saveEditorValue(resolver, address, column(HP), 'x', enums), /Not a valid int value/);
		await assert.rejects(saveEditorValue(resolver, address, column(ELEM_COL), 'earth', enums), /Not a valid enum value/);
		await assert.rejects(saveEditorValue(resolver, address, column(LOCKED), true, enums), /not writable/);
		assert.strictEqual((await load())[0].value, 45);

		// Empty Selection: no row, no Mutation Target
		assert.deepStrictEqual(await createEditorControls(enemy, undefined, enums, source), []);
		assert.strictEqual(dispatchEditorControl(TableColumnKind.Json), EditorControlType.JsonEditor);
	});
});
