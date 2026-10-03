/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Project working directory lifecycle (foundation.project-directory)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Artifact } from '../../common/authority.js';
import {
	AssetCategory,
	getRequiredOpenPhases,
	IProjectOpenContext,
	IProjectOpenSteps,
	openProjectDirectory,
	PROJECT_SQLITE_FILE_NAME,
	ProjectDirectoryError,
	ProjectEntryKind,
	ProjectEntryRole,
	projectLayout,
	ProjectOpenMode,
	ProjectOpenPhase,
	ProjectOpenStatus,
	resolveProjectPaths,
	scanProjectDirectory,
} from '../../common/projectDirectory.js';

suite('Primitive App Editor - Project Working Directory (3. Project Working Directory)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('layout matches the canonical <Project>/ tree', () => {
		assert.deepStrictEqual(projectLayout.map(entry => entry.path), [
			'project.sqlite',
			'functions',
			'assets',
			'assets/image',
			'assets/audio',
			'assets/font',
			'assets/shader',
			'assets/other',
			'scripts',
			'config',
			'build',
		]);
		assert.strictEqual(projectLayout.filter(entry => entry.kind === ProjectEntryKind.File).length, 1);
	});

	test('entry roles: Structured Data / Program / Binary Asset / Output', () => {
		const role = (path: string) => projectLayout.find(entry => entry.path === path)?.role;
		assert.strictEqual(role(PROJECT_SQLITE_FILE_NAME), ProjectEntryRole.StructuredData);
		assert.strictEqual(role('functions'), ProjectEntryRole.Program);
		assert.strictEqual(role('scripts'), ProjectEntryRole.Program);
		assert.strictEqual(role('assets'), ProjectEntryRole.BinaryAsset);
		assert.strictEqual(role('assets/shader'), ProjectEntryRole.BinaryAsset);
		assert.strictEqual(role('build'), ProjectEntryRole.Output);
		assert.strictEqual(projectLayout.find(entry => entry.path === 'build')?.artifact, undefined);
		assert.strictEqual(projectLayout.find(entry => entry.path === PROJECT_SQLITE_FILE_NAME)?.artifact, Artifact.ProjectSqlite);
	});

	test('paths resolve inside the working directory', () => {
		const paths = resolveProjectPaths(URI.file('/work/game'));
		assert.strictEqual(paths.sqlite.path, '/work/game/project.sqlite');
		assert.strictEqual(paths.assetCategories[AssetCategory.Font].path, '/work/game/assets/font');
		assert.strictEqual(paths.build.path, '/work/game/build');
	});
});

suite('Primitive App Editor - Project Open (3. Open)', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	const root = URI.from({ scheme: 'pae-test', path: '/project' });

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('pae-test', disposables.add(new InMemoryFileSystemProvider())));
	});

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
		try {
			await fn();
		} catch (error) {
			return error;
		}
		return undefined;
	}

	function recordingSteps(log: string[]): Required<IProjectOpenSteps> {
		const step = (name: string) => async (context: IProjectOpenContext) => { log.push(`${name}:${context.mode}`); };
		return {
			createStorage: async (context: IProjectOpenContext) => {
				log.push(`createStorage:${context.mode}`);
				await fileService.writeFile(context.paths.sqlite, VSBuffer.fromString('sqlite'));
			},
			openStorage: step('openStorage'),
			editorDdlScan: step('editorDdlScan'),
			schemaVersionResolve: step('schemaVersionResolve'),
			migrationApply: step('migrationApply'),
			registryLoad: step('registryLoad'),
			functionScan: step('functionScan'),
			assetScan: step('assetScan'),
		};
	}

	test('missing project.sqlite -> Create, layout created, Editor Ready', async () => {
		const log: string[] = [];
		const result = await openProjectDirectory(fileService, root, recordingSteps(log));

		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		assert.strictEqual(result.mode, ProjectOpenMode.Create);
		assert.deepStrictEqual(result.phases, [
			ProjectOpenPhase.WorkingDirectorySelect,
			ProjectOpenPhase.DirectoryScan,
			ProjectOpenPhase.Create,
			ProjectOpenPhase.EditorDdlScan,
			ProjectOpenPhase.SchemaVersionResolve,
			ProjectOpenPhase.MigrationApply,
			ProjectOpenPhase.RegistryLoad,
			ProjectOpenPhase.FunctionScan,
			ProjectOpenPhase.AssetScan,
			ProjectOpenPhase.EditorReady,
		]);
		assert.deepStrictEqual(log.slice(0, 5), ['createStorage:create', 'editorDdlScan:create', 'schemaVersionResolve:create', 'migrationApply:create', 'registryLoad:create']);
		assert.deepStrictEqual([...log.slice(5)].sort(), ['assetScan:create', 'functionScan:create']);

		for (const entry of projectLayout) {
			const stat = await fileService.stat(joinPath(root, ...entry.path.split('/')));
			assert.strictEqual(stat.isDirectory, entry.kind === ProjectEntryKind.Directory, entry.path);
		}
		assert.strictEqual(result.createdDirectories.length, projectLayout.length - 1);
	});

	test('existing project.sqlite -> Open, existing content untouched', async () => {
		await openProjectDirectory(fileService, root, recordingSteps([]));
		const script = joinPath(root, 'scripts', 'main.ts');
		await fileService.writeFile(script, VSBuffer.fromString('keep'));

		const log: string[] = [];
		const result = await openProjectDirectory(fileService, root, recordingSteps(log));

		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		assert.strictEqual(result.mode, ProjectOpenMode.Open);
		assert.deepStrictEqual(result.phases, [
			ProjectOpenPhase.WorkingDirectorySelect,
			ProjectOpenPhase.DirectoryScan,
			ProjectOpenPhase.Open,
			ProjectOpenPhase.EditorDdlScan,
			ProjectOpenPhase.SchemaVersionResolve,
			ProjectOpenPhase.MigrationApply,
			ProjectOpenPhase.RegistryLoad,
			ProjectOpenPhase.FunctionScan,
			ProjectOpenPhase.AssetScan,
			ProjectOpenPhase.EditorReady,
		]);
		assert.ok(!result.phases.includes(ProjectOpenPhase.Create));
		assert.strictEqual(log[0], 'openStorage:open');
		assert.deepStrictEqual(result.createdDirectories, []);
		assert.strictEqual((await fileService.readFile(result.paths.sqlite)).value.toString(), 'sqlite');
		assert.strictEqual((await fileService.readFile(script)).value.toString(), 'keep');
	});

	test('Open restores missing layout directories without creating project.sqlite', async () => {
		await fileService.writeFile(joinPath(root, PROJECT_SQLITE_FILE_NAME), VSBuffer.fromString('sqlite'));
		const openSteps: IProjectOpenSteps = { ...recordingSteps([]), createStorage: undefined };

		const result = await openProjectDirectory(fileService, root, openSteps);

		assert.strictEqual(result.status, ProjectOpenStatus.Ready);
		assert.strictEqual(result.mode, ProjectOpenMode.Open);
		assert.deepStrictEqual(result.createdDirectories.map(entry => entry.path), projectLayout.filter(entry => entry.kind === ProjectEntryKind.Directory).map(entry => entry.path));
		assert.strictEqual(result.phases[result.phases.length - 1], ProjectOpenPhase.EditorReady);
		assert.strictEqual((await fileService.readFile(result.paths.sqlite)).value.toString(), 'sqlite');
	});

	test('no steps supplied -> incomplete, nothing written, never Editor Ready', async () => {
		const result = await openProjectDirectory(fileService, root);

		assert.strictEqual(result.status, ProjectOpenStatus.Incomplete);
		assert.strictEqual(result.mode, ProjectOpenMode.Create);
		assert.deepStrictEqual(result.phases, [ProjectOpenPhase.WorkingDirectorySelect, ProjectOpenPhase.DirectoryScan]);
		assert.ok(!result.phases.includes(ProjectOpenPhase.EditorReady));
		if (result.status === ProjectOpenStatus.Incomplete) {
			assert.deepStrictEqual(result.missingPhases, getRequiredOpenPhases(ProjectOpenMode.Create));
		}
		assert.deepStrictEqual(result.createdDirectories, []);
		assert.strictEqual(await fileService.exists(root), false);
	});

	test('each missing required step makes the open incomplete without running any step', async () => {
		const stepByPhase: [ProjectOpenPhase, keyof IProjectOpenSteps][] = [
			[ProjectOpenPhase.Create, 'createStorage'],
			[ProjectOpenPhase.EditorDdlScan, 'editorDdlScan'],
			[ProjectOpenPhase.SchemaVersionResolve, 'schemaVersionResolve'],
			[ProjectOpenPhase.MigrationApply, 'migrationApply'],
			[ProjectOpenPhase.RegistryLoad, 'registryLoad'],
			[ProjectOpenPhase.FunctionScan, 'functionScan'],
			[ProjectOpenPhase.AssetScan, 'assetScan'],
		];
		for (const [phase, stepName] of stepByPhase) {
			const log: string[] = [];
			const steps: IProjectOpenSteps = { ...recordingSteps(log), [stepName]: undefined };

			const result = await openProjectDirectory(fileService, root, steps);

			assert.strictEqual(result.status, ProjectOpenStatus.Incomplete, stepName);
			assert.ok(!result.phases.includes(ProjectOpenPhase.EditorReady), stepName);
			if (result.status === ProjectOpenStatus.Incomplete) {
				assert.deepStrictEqual(result.missingPhases, [phase], stepName);
			}
			assert.deepStrictEqual(log, [], stepName);
			assert.strictEqual(await fileService.exists(joinPath(root, PROJECT_SQLITE_FILE_NAME)), false, stepName);
		}
	});

	test('the storage step required follows the mode', async () => {
		const created = await openProjectDirectory(fileService, root, { ...recordingSteps([]), openStorage: undefined });
		assert.strictEqual(created.status, ProjectOpenStatus.Ready);
		assert.strictEqual(created.mode, ProjectOpenMode.Create);

		const reopened = await openProjectDirectory(fileService, root, { ...recordingSteps([]), createStorage: undefined });
		assert.strictEqual(reopened.status, ProjectOpenStatus.Ready);
		assert.strictEqual(reopened.mode, ProjectOpenMode.Open);

		const incomplete = await openProjectDirectory(fileService, root, { ...recordingSteps([]), openStorage: undefined });
		assert.strictEqual(incomplete.status, ProjectOpenStatus.Incomplete);
		if (incomplete.status === ProjectOpenStatus.Incomplete) {
			assert.deepStrictEqual(incomplete.missingPhases, [ProjectOpenPhase.Open]);
		}
	});

	test('Directory Scan performs no writes', async () => {
		const scan = await scanProjectDirectory(fileService, root);
		assert.strictEqual(scan.rootExists, false);
		assert.strictEqual(scan.sqliteExists, false);
		assert.strictEqual(scan.missing.length, projectLayout.length);
		assert.strictEqual(await fileService.exists(root), false);
	});

	test('wrong entry kinds are rejected', async () => {
		await fileService.writeFile(root, VSBuffer.fromString('not a directory'));
		assert.ok(await rejection(() => scanProjectDirectory(fileService, root)) instanceof ProjectDirectoryError);

		const other = URI.from({ scheme: 'pae-test', path: '/other' });
		await fileService.createFolder(joinPath(other, PROJECT_SQLITE_FILE_NAME));
		assert.ok(await rejection(() => openProjectDirectory(fileService, other, recordingSteps([]))) instanceof ProjectDirectoryError);
	});

	test('a failing step stops the lifecycle before Editor Ready', async () => {
		const log: string[] = [];
		const steps = {
			...recordingSteps(log),
			migrationApply: async () => { throw new Error('migration failed'); },
		};
		assert.strictEqual((await rejection(() => openProjectDirectory(fileService, root, steps)) as Error | undefined)?.message, 'migration failed');
		assert.ok(!log.some(entry => entry.startsWith('registryLoad')));
	});
});
