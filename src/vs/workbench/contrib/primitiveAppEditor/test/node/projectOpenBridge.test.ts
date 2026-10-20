/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Project Open through the project.sqlite bridge (workbench.integration)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (3. Open, 39. Working Directory Integration)
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
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { createFunctionPrimitiveExecutorCatalog } from '../../common/functionPrimitive.js';
import { ProjectOpenMode, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { ProjectOpenSession, ProjectOpenState } from '../../common/projectOpenSession.js';
import { IProjectStatusEntry, PROJECT_STATUS_ENTRY_ID, toProjectStatusEntry } from '../../common/projectStatusEntry.js';
import { ProjectSqliteBridgeDatabaseFactory } from '../../common/projectSqliteBridge.js';
import { ProjectSqliteBridgeChannel } from '../../node/projectSqliteBridgeChannel.js';

/** Serializes arguments like the IPC does, so only JSON-safe values cross the bridge. */
function bridgeFactory(server: ProjectSqliteBridgeChannel): ProjectSqliteBridgeDatabaseFactory {
	const channel: IChannel = {
		call: <T>(command: string, arg?: unknown) => server.call<T>('window', command, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))).then(result => result === undefined ? result : JSON.parse(JSON.stringify(result))),
		listen: <T>() => Event.None as Event<T>,
	};
	return new ProjectSqliteBridgeDatabaseFactory(channel);
}

suite('Primitive App Editor - Project Open through the project.sqlite bridge (workbench.integration)', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;
	let server: ProjectSqliteBridgeChannel;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = join(tmpdir(), `pae-open-bridge-${generateUuid()}`);
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

	test('ProjectOpenSession reaches Ready through the bridge adapter (Create, then Open)', async () => {
		const session = new ProjectOpenSession(fileService, bridgeFactory(server), editorDdlResources, createFunctionPrimitiveExecutorCatalog());

		const created = await session.open(root);
		assert.strictEqual(created.state, ProjectOpenState.Ready);
		assert.strictEqual(created.result?.status, ProjectOpenStatus.Ready);
		assert.strictEqual(created.result?.mode, ProjectOpenMode.Create);
		await session.close();
		assert.strictEqual(session.state.state, ProjectOpenState.None);

		const reopened = await session.open(root);
		assert.strictEqual(reopened.state, ProjectOpenState.Ready);
		assert.strictEqual(reopened.result?.mode, ProjectOpenMode.Open);
		await session.close();
	});

	test('Status Bar entry content reflects Opening then Ready for a folder opened through the bridge', async () => {
		const session = new ProjectOpenSession(fileService, bridgeFactory(server), editorDdlResources, createFunctionPrimitiveExecutorCatalog());
		const entries: IProjectStatusEntry[] = [];
		session.onDidChangeState(state => entries.push(toProjectStatusEntry(state)));

		await session.open(root);
		await session.close();

		assert.strictEqual(PROJECT_STATUS_ENTRY_ID, 'status.primitiveAppEditor.project');
		assert.strictEqual(entries.length, 3);
		assert.ok(entries[0].text.includes('Project: Opening'));
		assert.ok(entries[1].text.includes('Project: Ready'));
		assert.strictEqual(entries[1].kind, undefined);
	});

	test('Status Bar entry content shows Failed when the bridge cannot open project.sqlite', async () => {
		const failing = bridgeFactory(server);
		await fs.writeFile(join(tempRoot, 'game'), 'not a directory');
		const session = new ProjectOpenSession(fileService, failing, editorDdlResources, createFunctionPrimitiveExecutorCatalog());
		const state = await session.open(root);

		assert.strictEqual(state.state, ProjectOpenState.Failed);
		assert.strictEqual(toProjectStatusEntry(state).kind, 'error');
		await session.close();
	});
});
