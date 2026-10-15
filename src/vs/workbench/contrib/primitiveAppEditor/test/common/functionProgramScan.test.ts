/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function / Program Scan (function.program-scan)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (30. Function / Program Scan)
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
import { createFunctionScanStep, discoverFunctionPrograms, FunctionScanError, resolveFunctionExecutors, scanFunctions } from '../../common/functionProgramScan.js';
import { createFunctionRegistryEntry, FunctionRegistryError } from '../../common/functionRegistry.js';
import { createFunctionPrimitiveExecutorCatalog, linearDefinition, toFunctionRegistryEntryInput } from '../../common/functionPrimitive.js';
import { openProjectDirectory, ProjectOpenPhase, ProjectOpenStatus } from '../../common/projectDirectory.js';

const F = '00000000-0000-4000-8000-0000000000f1';
const now = () => new Date('2026-10-15T00:00:00Z');
const linearEntry = () => createFunctionRegistryEntry({ ...toFunctionRegistryEntryInput(linearDefinition, 0), uuid: F }, undefined, now);
const missingEntry = () => createFunctionRegistryEntry({ ...toFunctionRegistryEntryInput({ ...linearDefinition, name: 'ghost', executor: 'Ghost' }, 1), uuid: '00000000-0000-4000-8000-0000000000f2' }, undefined, now);

suite('Primitive App Editor - Function / Program Scan (30. Function / Program Scan)', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.from({ scheme: 'mem', path: '/project' });

	function createFileService(): FileService {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('mem', disposables.add(new InMemoryFileSystemProvider())));
		return fileService;
	}

	test('Program Discovery lists files under functions/ recursively in path order', async () => {
		const fileService = createFileService();
		const functions = joinPath(root, 'functions');
		await fileService.writeFile(joinPath(functions, 'b.js'), VSBuffer.fromString(''));
		await fileService.writeFile(joinPath(functions, 'sub', 'a.js'), VSBuffer.fromString(''));
		await fileService.writeFile(joinPath(functions, 'a.js'), VSBuffer.fromString(''));
		const programs = await discoverFunctionPrograms(fileService, functions);
		assert.deepStrictEqual(programs.map(program => program.path), ['a.js', 'b.js', 'sub/a.js']);
	});

	test('missing functions/ discovers nothing and is not created; a file named functions is rejected', async () => {
		const fileService = createFileService();
		const functions = joinPath(root, 'functions');
		assert.deepStrictEqual(await discoverFunctionPrograms(fileService, functions), []);
		assert.strictEqual(await fileService.exists(functions), false);
		await fileService.writeFile(functions, VSBuffer.fromString(''));
		await assert.rejects(() => discoverFunctionPrograms(fileService, functions), (error: Error) => error instanceof FunctionScanError);
	});

	test('Executor Resolve maps Registry executor to a Code Primitive', () => {
		const resolutions = resolveFunctionExecutors([linearEntry()], createFunctionPrimitiveExecutorCatalog());
		assert.deepStrictEqual(resolutions.map(resolution => [resolution.entry.name, resolution.executor]), [['linear', 'Linear']]);
	});

	test('Missing executor rejects', async () => {
		const catalog = createFunctionPrimitiveExecutorCatalog();
		assert.throws(() => resolveFunctionExecutors([linearEntry(), missingEntry()], catalog), (error: Error) => error instanceof FunctionRegistryError && /Ghost/.test(error.message));
		await assert.rejects(() => scanFunctions(createFileService(), joinPath(root, 'functions'), [missingEntry()], catalog), /Ghost/);
	});

	test('scanFunctions returns programs and resolutions', async () => {
		const fileService = createFileService();
		const functions = joinPath(root, 'functions');
		await fileService.writeFile(joinPath(functions, 'x.js'), VSBuffer.fromString(''));
		const result = await scanFunctions(fileService, functions, [linearEntry()], createFunctionPrimitiveExecutorCatalog());
		assert.strictEqual(result.programs.length, 1);
		assert.strictEqual(result.resolutions.length, 1);
	});

	test('functionScan open step plugs into Open: Ready with valid executors, rejects before Editor Ready otherwise', async () => {
		const noop = async () => { };
		const catalog = createFunctionPrimitiveExecutorCatalog();
		const stepsFor = (fileService: FileService, entries: () => ReturnType<typeof linearEntry>[]) => ({
			createStorage: noop, openStorage: noop, editorDdlScan: noop, schemaVersionResolve: noop, migrationApply: noop, registryLoad: noop, assetScan: noop,
			functionScan: createFunctionScanStep(fileService, catalog, async () => entries()),
		});

		const okFs = createFileService();
		const ready = await openProjectDirectory(okFs, root, stepsFor(okFs, () => [linearEntry()]));
		assert.strictEqual(ready.status, ProjectOpenStatus.Ready);
		assert.ok(ready.phases.includes(ProjectOpenPhase.FunctionScan));

		const badFs = createFileService();
		await assert.rejects(() => openProjectDirectory(badFs, root, stepsFor(badFs, () => [missingEntry()])), /Ghost/);
	});
});
