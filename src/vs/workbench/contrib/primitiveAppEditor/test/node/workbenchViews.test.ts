/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Workbench views over a Ready Project (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure / Side Bar), Editor UI.md (9, 10)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { DataEditorTarget } from '../../common/dataEditor.js';
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { FunctionBindingService, readFunctionBindings } from '../../common/functionBinding.js';
import { FunctionDependencyService } from '../../common/functionDependency.js';
import { createFunctionPrimitiveExecutorCatalog } from '../../common/functionPrimitive.js';
import { ProjectOpenSession, ProjectOpenState } from '../../common/projectOpenSession.js';
import { LogicalNamespace } from '../../common/projectSqlite.js';
import { RawDataService } from '../../common/rawData.js';
import { RegistryService } from '../../common/registryService.js';
import { RendererBindingService } from '../../common/rendererRegistry.js';
import { Resolver } from '../../common/resolver.js';
import { TableColumnKind } from '../../common/tableRegistry.js';
import { ActivityBarItem, createSideBarTree, EditorTabKind, ISideBarContext, WorkbenchViewsModel } from '../../common/workbenchViews.js';
import { ProjectSqliteBridgeDatabaseFactory } from '../../common/projectSqliteBridge.js';
import { ProjectSqliteBridgeChannel } from '../../node/projectSqliteBridgeChannel.js';

const ENEMY = '00000000-0000-4000-8000-0000000000a1';
const HP = '00000000-0000-4000-8000-0000000000c1';
const NAME = '00000000-0000-4000-8000-0000000000c2';

/** Serializes arguments like the IPC does, so only JSON-safe values cross the bridge. */
function bridgeFactory(server: ProjectSqliteBridgeChannel, connection = server.connect()): ProjectSqliteBridgeDatabaseFactory {
	const channel: IChannel = {
		call: <T>(command: string, arg?: unknown) => connection.call<T>('window', command, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))).then(result => result === undefined ? result : JSON.parse(JSON.stringify(result))),
		listen: <T>() => Event.None as Event<T>,
	};
	return new ProjectSqliteBridgeDatabaseFactory(channel);
}

suite('Primitive App Editor - Workbench views over a Ready Project (workbench.views)', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;
	let server: ProjectSqliteBridgeChannel;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = join(tmpdir(), `pae-views-${generateUuid()}`);
		root = URI.file(join(tempRoot, 'game'));
		await fs.mkdir(tempRoot, { recursive: true });
		server = new ProjectSqliteBridgeChannel();
	});

	teardown(async () => {
		server.dispose();
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Side Bar trees list the Registry of the opened Project and activating a node selects and opens one reused tab', async () => {
		const catalog = createFunctionPrimitiveExecutorCatalog();
		const session = new ProjectOpenSession(fileService, bridgeFactory(server), editorDdlResources, catalog);
		try {
			// First Open creates project.sqlite; define a table through the generic Resolver, then reopen so Registry Load sees it.
			assert.strictEqual((await session.open(root)).state, ProjectOpenState.Ready);
			const database = session.database!;
			const resolver = new Resolver({
				database,
				registry: new RegistryService(database),
				rawData: new RawDataService(database),
				functionBinding: new FunctionBindingService(database, catalog),
				functionDependency: new FunctionDependencyService(database),
				rendererBinding: new RendererBindingService(database),
			});
			const column = (uuid: string, index: number, name: string, kind: TableColumnKind) => ({ uuid, index, name, kind, not_null: false, writable: true, searchable: true });
			await resolver.create({ target: { kind: 'table' }, payload: { uuid: ENEMY, index: 0, schema: LogicalNamespace.Items, name: 'enemy', label: 'Enemy', columns: [column(NAME, 0, 'name', TableColumnKind.Text), column(HP, 1, 'hp', TableColumnKind.Int)] } });
			await session.close();
			await fs.mkdir(join(tempRoot, 'game', 'functions'), { recursive: true });
			await fs.writeFile(join(tempRoot, 'game', 'functions', 'enemy.cs'), '// program');

			const state = await session.open(root);
			assert.strictEqual(state.state, ProjectOpenState.Ready);
			const context: ISideBarContext = {
				registry: state.registry,
				functionBindings: await session.database!.transaction(statements => readFunctionBindings(statements)),
				assets: state.assets ?? [],
				programs: state.functionScan?.programs ?? [],
				rootName: 'game',
			};

			const explorer = createSideBarTree(ActivityBarItem.Explorer, context);
			assert.deepStrictEqual(explorer[0].children.map(node => [node.label, node.open]), [['enemy.cs', { kind: 'file', path: 'functions/enemy.cs' }]]);
			const registry = createSideBarTree(ActivityBarItem.Registry, context);
			assert.deepStrictEqual(registry[0].children.map(node => [node.label, node.uuid]), [['Enemy', ENEMY]]);
			assert.deepStrictEqual(registry[1].children[0].children.map(node => [node.label, node.description]), [['name', 'text'], ['hp', 'int']]);

			const views = new WorkbenchViewsModel();
			const raw = createSideBarTree(ActivityBarItem.Data, context)[1].children[0];
			const first = views.activate(raw);
			const second = views.activate(raw);
			assert.deepStrictEqual(views.selection.selection, { uuid: ENEMY });
			assert.ok(first.kind === 'tab' && second.kind === 'tab');
			assert.strictEqual(first.tab.target, DataEditorTarget.DataGrid);
			assert.strictEqual(first.tabKind, EditorTabKind.DataEditor);
			assert.deepStrictEqual([first.reused, second.reused], [false, true]);
			assert.strictEqual(views.tabs.openTabs.length, 1);
		} finally {
			await session.close();
		}
	});

	test('without a Ready Project the Side Bar trees are empty', async () => {
		const session = new ProjectOpenSession(fileService, bridgeFactory(server), editorDdlResources, createFunctionPrimitiveExecutorCatalog());
		assert.strictEqual(session.state.state, ProjectOpenState.None);
		const context: ISideBarContext = { registry: session.state.registry, functionBindings: [], assets: [], programs: [], rootName: '' };
		assert.deepStrictEqual(createSideBarTree(ActivityBarItem.Registry, context), []);
		await session.close();
	});
});
