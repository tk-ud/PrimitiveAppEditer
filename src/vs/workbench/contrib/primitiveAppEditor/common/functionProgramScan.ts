/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Function / Program Scan (function.program-scan)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (30. Function / Program Scan)
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IFunctionExecutorCatalog, IFunctionRegistryEntry, validateFunctionRegistry, validateFunctionRegistryExecutors } from './functionRegistry.js';
import { IProjectOpenContext, IProjectOpenSteps } from './projectDirectory.js';

/**
 * `Function Scan` (Open step): Directory Scan of `<Project>/functions/` -> Program Discovery ->
 * Executor Resolve -> function_registry Validate.
 *
 * `Registry executor -> Code Primitive`; `Missing executor -> Build / Load reject`. The scan
 * only reads: it never creates, edits or deletes a program and never adds an executor to Code.
 */

export class FunctionScanError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor function scan: ${message}`);
		this.name = 'FunctionScanError';
	}
}

// #region Directory Scan / Program Discovery

/** One program file discovered under `<Project>/functions/`. */
export interface IFunctionProgram {
	/** Path relative to `functions/`, `/` separated. */
	readonly path: string;
	readonly resource: URI;
}

/**
 * `Directory Scan` + `Program Discovery`: every file under `functionsDirectory` (recursively), in
 * path order. Only a missing `functions/` directory (file not found) discovers nothing; any other
 * resolve failure (permission denied, unavailable, I/O) and a `functions` entry that is a file are
 * rejected, so a failed scan can never reach Editor Ready.
 */
export async function discoverFunctionPrograms(fileService: IFileService, functionsDirectory: URI): Promise<readonly IFunctionProgram[]> {
	let root;
	try {
		root = await fileService.resolve(functionsDirectory);
	} catch (error) {
		if (toFileOperationResult(error as Error) === FileOperationResult.FILE_NOT_FOUND) {
			return Object.freeze([]);
		}
		throw error;
	}
	if (!root.isDirectory) {
		throw new FunctionScanError(`functions entry is not a directory: ${functionsDirectory.toString()}`);
	}

	const programs: IFunctionProgram[] = [];
	const visit = async (directory: URI, prefix: string): Promise<void> => {
		const stat = await fileService.resolve(directory);
		for (const child of stat.children ?? []) {
			const path = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.isDirectory) {
				await visit(joinPath(directory, child.name), path);
			} else if (child.isFile) {
				programs.push(Object.freeze({ path, resource: child.resource }));
			}
		}
	};
	await visit(functionsDirectory, '');
	programs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return Object.freeze(programs);
}

// #endregion

// #region Executor Resolve / function_registry Validate

/** `Registry executor -> Code Primitive`: one Registry entry with its executor resolved in Code. */
export interface IFunctionExecutorResolution {
	readonly entry: IFunctionRegistryEntry;
	readonly executor: string;
}

/**
 * `Executor Resolve` + `function_registry Validate`: validates the Registry entries and resolves every entry's `executor` to the Code Primitive of `catalog`. An
 * executor that is missing from Code rejects (`Missing executor -> Build / Load reject`).
 */
export function resolveFunctionExecutors(entries: readonly IFunctionRegistryEntry[], catalog: IFunctionExecutorCatalog): readonly IFunctionExecutorResolution[] {
	// function_registry Validate: Registry itself (unique UUIDs), then every executor exists in Code.
	validateFunctionRegistry(entries);
	validateFunctionRegistryExecutors(entries, catalog);
	return Object.freeze(entries.map(entry => Object.freeze({ entry, executor: entry.executor })));
}

// #endregion

// #region Function Scan

export interface IFunctionScanResult {
	readonly programs: readonly IFunctionProgram[];
	readonly resolutions: readonly IFunctionExecutorResolution[];
}

/** Runs Directory Scan -> Program Discovery -> Executor Resolve -> function_registry Validate. */
export async function scanFunctions(
	fileService: IFileService,
	functionsDirectory: URI,
	entries: readonly IFunctionRegistryEntry[],
	catalog: IFunctionExecutorCatalog,
): Promise<IFunctionScanResult> {
	const programs = await discoverFunctionPrograms(fileService, functionsDirectory);
	const resolutions = resolveFunctionExecutors(entries, catalog);
	return Object.freeze({ programs, resolutions });
}

/**
 * The `functionScan` step of {@link IProjectOpenSteps}. `loadEntries` supplies the Registry
 * entries loaded by `Registry Load` (e.g. `readFunctionRegistry`); a rejection of the scan rejects
 * the whole open, so Editor Ready is never reached with a missing executor.
 */
export function createFunctionScanStep(
	fileService: IFileService,
	catalog: IFunctionExecutorCatalog,
	loadEntries: (context: IProjectOpenContext) => Promise<readonly IFunctionRegistryEntry[]>,
	onScanned?: (result: IFunctionScanResult, context: IProjectOpenContext) => void,
): NonNullable<IProjectOpenSteps['functionScan']> {
	return async context => {
		const result = await scanFunctions(fileService, context.paths.functions, await loadEntries(context), catalog);
		onScanned?.(result, context);
	};
}

// #endregion
