/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Data Editor and Raw Data authoring on project.sqlite (editor.data-ui)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (26. Editor)
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
import { createDataEditorNavigation, DataEditorSection, DataEditorSelection, DataEditorTabs, DataEditorTarget, DataGridModel, selectDataEditorEntry } from '../../common/dataEditor.js';
import { DynamicResolver } from '../../common/dynamicResolve.js';
import { createRelationSource, EditorControlType } from '../../common/editorControls.js';
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
const MISSING = '00000000-0000-4000-8000-0000000000f9';
const REL = '00000000-0000-4000-8000-0000000000d5';

const catalog = createFunctionExecutorCatalog(['math.identity']);
const now = () => new Date('2026-10-15T00:00:00Z');
const col = (uuid: string, index: number, name: string, kind: TableColumnKind, extra: object = {}) => ({ uuid, index, name, kind, not_null: false, writable: true, searchable: true, ...extra });

suite('Primitive App Editor - Data Editor on project.sqlite', () => {
	const disposables = new DisposableStore();
	const factory = new ProjectSqliteDatabaseFactory();
	const storages: ProjectSqliteStorage[] = [];
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-data-editor-'));
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

	test('Data Editor lists, selects and authors Raw Data through generic Primitives with a Shared Selection Context', async () => {
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

		const tables = await readTableRegistry(storage.database);
		const enemy = tables.find(table => table.uuid === ENEMY)!;
		const enums = new EnumRegistryIndex(await readEnumRegistry(storage.database));
		const relations = await readRelationRegistry(storage.database);

		// Primary Side Bar: Discovery / List / Selection in Registry order; labels, never UUIDs
		const navigation = createDataEditorNavigation({ tables, relations, functions: [], renderers: [], functionBindings: [], rendererBindings: [] });
		assert.deepStrictEqual(navigation.map(section => section.section), [DataEditorSection.PhysicalTable, DataEditorSection.RawData, DataEditorSection.Relation, DataEditorSection.FunctionBinding, DataEditorSection.RendererBinding]);
		const rawEntries = navigation[1].entries;
		assert.deepStrictEqual(rawEntries.map(entry => entry.label), ['Enemy', 'player']);
		assert.deepStrictEqual(navigation[2].entries.map(entry => [entry.label, entry.description]), [['Enemy', 'player']]);

		// Selecting opens the Data Grid tab once (no duplicate tabs) and sets the Shared Selection Context
		const selection = new DataEditorSelection();
		const tabs = new DataEditorTabs();
		const seen: unknown[] = [];
		selection.onDidChange(value => seen.push(value));
		const first = selectDataEditorEntry(rawEntries[0], selection, tabs);
		const second = selectDataEditorEntry(rawEntries[0], selection, tabs);
		assert.strictEqual(first.reused, false);
		assert.strictEqual(second.reused, true);
		assert.strictEqual(first.tab, second.tab);
		assert.strictEqual(tabs.openTabs.length, 1);
		assert.strictEqual(first.tab!.target, DataEditorTarget.DataGrid);
		assert.deepStrictEqual(selection.selection, { uuid: ENEMY });

		// Data Grid: columns by Kind Dispatch from the Registry
		const grid = new DataGridModel(resolver, enemy, enums, createRelationSource(resolver, enemy, tables, relations));
		assert.deepStrictEqual(grid.columns.map(column => [column.header, column.control, column.readOnly]), [
			['hp', EditorControlType.NumberField, false], ['element', EditorControlType.Select, false],
			['Owner', EditorControlType.RelationSelect, false], ['locked', EditorControlType.Checkbox, true],
		]);

		// insert -> reload through the generic Primitive
		assert.strictEqual(await grid.insertRow({ hp: 50, element: 'fire', owner: P1 }, R1), R1);
		const generated = await grid.insertRow({ hp: 7 });
		assert.strictEqual(grid.rows.length, 2);
		assert.notStrictEqual(generated, R1);
		const row = grid.rows.find(candidate => candidate.uuid === R1)!;
		assert.deepStrictEqual(row.cells.map(cell => cell.displayValue), [undefined, 'Fire', 'Alice', undefined]);
		await assert.rejects(grid.insertRow({ hp: 'x' }), /Not a valid int value/);
		assert.strictEqual(grid.rows.length, 2);

		// Grid selection writes the same Shared Selection Context, and the single Inspector resolves it
		grid.selectRow(R1, selection);
		assert.deepStrictEqual(selection.selection, { uuid: R1, table_uuid: ENEMY });
		assert.strictEqual(seen.length, 3);
		const inspector = await new DynamicResolver().resolve(selection.selection, {
			tables, enums, enumEntries: await readEnumRegistry(storage.database), relations, functions: [], renderers: [], assets: [], functionBindings: [], rendererBindings: [],
		}, resolver);
		assert.ok(!(inspector as { empty?: boolean }).empty);
		assert.deepStrictEqual((inspector as { address: unknown }).address, { tableUuid: ENEMY, rowUuid: R1 });
		assert.throws(() => grid.selectRow(MISSING, selection), /not in the loaded Raw Data/);

		// cell edit -> update; invalid / read-only edits are rejected and Raw Data is unchanged
		await grid.editCell(R1, HP, 45);
		await grid.editCell(R1, ELEM_COL, 'water');
		assert.strictEqual(grid.rows.find(candidate => candidate.uuid === R1)!.cells[0].value, 45);
		await assert.rejects(grid.editCell(R1, HP, 'x'), /Not a valid int value/);
		await assert.rejects(grid.editCell(R1, LOCKED, true), /not writable/);
		assert.strictEqual(grid.validateCell(ELEM_COL, 'earth'), 'Not a valid enum value.');
		assert.strictEqual(grid.rows.find(candidate => candidate.uuid === R1)!.cells[0].value, 45);

		// delete -> Raw Data row removed, Registry Definition kept
		await grid.deleteRow(generated);
		assert.deepStrictEqual(grid.rows.map(candidate => candidate.uuid), [R1]);
		assert.strictEqual((await readTableRegistry(storage.database)).length, 2);
	});
});
