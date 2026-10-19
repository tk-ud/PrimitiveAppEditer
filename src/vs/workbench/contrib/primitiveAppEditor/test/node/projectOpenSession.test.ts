/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Project Open wiring for the Workbench (workbench.integration)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (3. Open, 39. Working Directory Integration)
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
import { editorDdlResources } from '../../common/editorDdlResources.js';
import { createFunctionPrimitiveExecutorCatalog } from '../../common/functionPrimitive.js';
import { ProjectOpenMode, ProjectOpenPhase, ProjectOpenStatus } from '../../common/projectDirectory.js';
import { ProjectOpenSession, ProjectOpenState } from '../../common/projectOpenSession.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

suite('Primitive App Editor - Project Open wiring (workbench.integration)', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	let tempRoot: string;
	let root: URI;
	let session: ProjectOpenSession;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new DiskFileSystemProvider(new NullLogService()))));
		tempRoot = await fs.mkdtemp(join(tmpdir(), 'pae-open-'));
		root = URI.file(join(tempRoot, 'game'));
		session = new ProjectOpenSession(fileService, new ProjectSqliteDatabaseFactory(), editorDdlResources, createFunctionPrimitiveExecutorCatalog());
	});

	teardown(async () => {
		await session.close();
		disposables.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Create: opening a folder runs every Open phase to Editor Ready with an empty Registry', async () => {
		const seen: ProjectOpenState[] = [];
		session.onDidChangeState(state => seen.push(state.state));

		const state = await session.open(root);

		assert.strictEqual(state.state, ProjectOpenState.Ready);
		assert.strictEqual(state.result?.status, ProjectOpenStatus.Ready);
		assert.strictEqual(state.result?.mode, ProjectOpenMode.Create);
		assert.ok(state.result?.phases.includes(ProjectOpenPhase.RegistryLoad));
		assert.ok(state.result?.phases.includes(ProjectOpenPhase.FunctionScan));
		assert.ok(state.result?.phases.includes(ProjectOpenPhase.AssetScan));
		assert.strictEqual(state.result?.phases[state.result.phases.length - 1], ProjectOpenPhase.EditorReady);
		assert.deepStrictEqual(state.registry?.tables, []);
		assert.deepStrictEqual(state.functionScan?.programs, []);
		assert.deepStrictEqual(state.assets, []);
		assert.ok(session.database);
		assert.deepStrictEqual(seen, [ProjectOpenState.Opening, ProjectOpenState.Ready]);
	});

	test('Open: reopening an existing project.sqlite takes the Open path', async () => {
		await session.open(root);
		await session.close();
		assert.strictEqual(session.state.state, ProjectOpenState.None);
		assert.strictEqual(session.database, undefined);

		const state = await session.open(root);
		assert.strictEqual(state.state, ProjectOpenState.Ready);
		assert.strictEqual(state.result?.mode, ProjectOpenMode.Open);
	});

	test('Asset Scan discovers the assets of the Working Directory', async () => {
		await fs.mkdir(join(root.fsPath, 'assets', 'image'), { recursive: true });
		await fs.writeFile(join(root.fsPath, 'assets', 'image', 'hero.png'), 'x');

		const state = await session.open(root);

		assert.strictEqual(state.state, ProjectOpenState.Ready);
		assert.deepStrictEqual(state.assets?.map(asset => asset.name), ['hero.png']);
	});

	test('a rejecting step ends in Failed and never reaches Editor Ready', async () => {
		// project.sqlite that is not a SQLite database makes the Open step reject.
		await fs.mkdir(root.fsPath, { recursive: true });
		await fs.writeFile(join(root.fsPath, 'project.sqlite'), 'not a database');

		const state = await session.open(root);

		assert.strictEqual(state.state, ProjectOpenState.Failed);
		assert.ok(state.error);
		assert.strictEqual(session.database, undefined);
	});

	test('concurrent opens of the same root share one open and keep one storage', async () => {
		const first = session.open(root);
		const second = session.open(root);
		assert.strictEqual(first, second);

		const state = await first;
		assert.strictEqual(state.state, ProjectOpenState.Ready);
		assert.strictEqual(state.result?.mode, ProjectOpenMode.Create);

		await session.close();
		await fs.rm(join(root.fsPath, 'project.sqlite'));
	});

	test('opening root A then B ends in B and releases the storage of A', async () => {
		const rootA = URI.file(join(tempRoot, 'a'));
		const rootB = URI.file(join(tempRoot, 'b'));
		const seen: string[] = [];
		session.onDidChangeState(state => seen.push(`${state.state}:${state.root?.path.split('/').pop()}`));

		const a = session.open(rootA);
		const b = session.open(rootB);
		const [stateA, stateB] = await Promise.all([a, b]);

		assert.strictEqual(stateA.root?.toString(), rootB.toString());
		assert.strictEqual(stateB.state, ProjectOpenState.Ready);
		assert.strictEqual(session.state.root?.toString(), rootB.toString());
		assert.ok(!seen.includes('ready:a'));
		// A never reached Ready, so its storage was never kept and project.sqlite of A can be removed.
		await fs.rm(join(rootA.fsPath, 'project.sqlite'), { force: true });
	});

	test('close() during an open discards the open result', async () => {
		const opening = session.open(root);
		const closing = session.close();
		await Promise.all([opening, closing]);
		assert.strictEqual(session.state.state, ProjectOpenState.None);
		assert.strictEqual(session.database, undefined);
	});
});
