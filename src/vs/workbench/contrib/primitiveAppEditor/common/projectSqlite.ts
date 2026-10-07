/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite authoring storage (foundation.sqlite)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md
 *  (4. SQLite, 4. Logical Namespace, 32. Save / Load Operation, 32. Transaction / Integrity)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { Artifact, assertBoundaryFlow, AuthorityConcern, AuthoritySource, BoundaryNode, isAuthorityFor } from './authority.js';
import {
	ISaveDataCurrent,
	ISaveDataWrite,
	ISaveEvent,
	logsSaveDataTable,
	registryCurrentTable,
	registryCurrentUpsertConflictTarget,
	SaveDataJson,
	upsertSaveDataCurrent,
} from './persistenceBoundary.js';
import { IProjectOpenContext, IProjectOpenSteps, ProjectOpenMode } from './projectDirectory.js';

/**
 * `SQLite = Authoring Storage`, `SQLite != Runtime Loop Storage`.
 *
 * This module owns the `project.sqlite` storage: its role and content areas, the logical
 * namespaces (independent of the SQLite schema feature), physical table name resolution for
 * Core storage tables, the database contract used by every service writing to `project.sqlite`,
 * the `Create` / `Open` storage steps of the project `Open` lifecycle (create / open only), and
 * the Runtime Save Data (`registry.current`, `logs.savedata`) physical names with their UPSERT /
 * Save Event primitives. Editor DDL (including the Save Data tables), schema versions, migrations
 * and Registry contents are owned by later services that use this storage.
 */

// #region 4. SQLite

/** Content areas stored in `project.sqlite`, in specification order. */
export const enum ProjectSqliteContent {
	EditorInternalSchema = 'editorInternalSchema',
	Registry = 'registry',
	PhysicalTables = 'physicalTables',
	RawData = 'rawData',
	FunctionBinding = 'functionBinding',
	FunctionDependency = 'functionDependency',
	RendererBinding = 'rendererBinding',
	ProjectMetadata = 'projectMetadata',
}

export const projectSqliteContents: readonly ProjectSqliteContent[] = Object.freeze([
	ProjectSqliteContent.EditorInternalSchema,
	ProjectSqliteContent.Registry,
	ProjectSqliteContent.PhysicalTables,
	ProjectSqliteContent.RawData,
	ProjectSqliteContent.FunctionBinding,
	ProjectSqliteContent.FunctionDependency,
	ProjectSqliteContent.RendererBinding,
	ProjectSqliteContent.ProjectMetadata,
]);

export const projectSqliteRole = Object.freeze({
	authoringStorage: true,
	runtimeLoopStorage: false,
} as const);

/** Who accesses `project.sqlite`. */
export const enum ProjectSqliteAccessor {
	/** Editor authoring operations (Authoring Save, open, DDL, Registry). */
	Authoring = 'authoring',
	/** Application-requested explicit Save / Load of Runtime Save Data. */
	ExplicitSave = 'explicitSave',
	/** The runtime frame loop. */
	RuntimeLoop = 'runtimeLoop',
}

/** `SQLite != Runtime Loop Storage`: the runtime loop never queries `project.sqlite` (`Runtime Loop -X-> SQLite per-frame query`). */
export function assertProjectSqliteAccess(accessor: ProjectSqliteAccessor): void {
	if (accessor === ProjectSqliteAccessor.RuntimeLoop) {
		assertBoundaryFlow(BoundaryNode.RuntimeLoop, BoundaryNode.SQLitePerFrameQuery);
	}
}

// #endregion

// #region 4. Logical Namespace

/** `table_registry.schema`: logical namespace of an application table (`items | logs`). */
export const enum LogicalNamespace {
	/** existence space */
	Items = 'items',
	/** time-series space */
	Logs = 'logs',
}

export const logicalNamespaces: readonly LogicalNamespace[] = Object.freeze([LogicalNamespace.Items, LogicalNamespace.Logs]);

export function isLogicalNamespace(value: string): value is LogicalNamespace {
	return (logicalNamespaces as readonly string[]).includes(value);
}

/**
 * Physical schema names used by tables in `project.sqlite`: the logical namespaces plus the
 * `registry` schema of the Registry system. They are logical names, never SQLite schemas
 * (`ATTACH DATABASE` / `schema.table` qualification is not used).
 */
export const REGISTRY_SCHEMA = 'registry';

const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PHYSICAL_TABLE_SEPARATOR = '__';

export class ProjectSqliteNameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectSqliteNameError';
	}
}

function assertIdentifier(kind: string, value: string): void {
	if (!identifierPattern.test(value)) {
		throw new ProjectSqliteNameError(`Primitive App Editor ${kind} name must match ${identifierPattern.source}: '${value}'`);
	}
}

/**
 * Resolves `<schema>.<table>` to a physical table name in `project.sqlite`.
 * Physical table names of application tables are resolved by the Registry Service; Core storage
 * tables of this module use {@link corePhysicalTableNameResolver}.
 */
export interface IPhysicalTableNameResolver {
	resolve(schema: string, table: string): string;
}

/** `<schema>__<table>`: one flat SQLite namespace, no dependency on the SQLite schema feature. */
export const corePhysicalTableNameResolver: IPhysicalTableNameResolver = Object.freeze({
	resolve(schema: string, table: string): string {
		assertIdentifier('schema', schema);
		assertIdentifier('table', table);
		return `${schema}${PHYSICAL_TABLE_SEPARATOR}${table}`;
	},
});

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

// #endregion

// #region Database contract

export type ProjectSqliteValue = string | number | null;
export type ProjectSqliteRow = Readonly<Record<string, ProjectSqliteValue>>;

/** Statements on `project.sqlite`. Inside a transaction they run on the transaction. */
export interface IProjectSqliteStatements {
	exec(sql: string): Promise<void>;
	run(sql: string, params?: readonly ProjectSqliteValue[]): Promise<{ readonly changes: number }>;
	get(sql: string, params?: readonly ProjectSqliteValue[]): Promise<ProjectSqliteRow | undefined>;
	all(sql: string, params?: readonly ProjectSqliteValue[]): Promise<readonly ProjectSqliteRow[]>;
}

export interface IProjectSqliteDatabase extends IProjectSqliteStatements {
	readonly resource: URI;
	/**
	 * Runs `work` in one transaction: `COMMIT` when it resolves, `ROLLBACK` when it rejects.
	 * Statements issued outside the transaction wait until it finished.
	 */
	transaction<T>(work: (statements: IProjectSqliteStatements) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export const enum ProjectSqliteOpenMode {
	/** Create a new `project.sqlite`; fails when the file already exists. */
	Create = 'create',
	/** Open an existing `project.sqlite`; fails when it is missing or not a SQLite database. */
	Open = 'open',
}

export interface IProjectSqliteDatabaseFactory {
	open(resource: URI, mode: ProjectSqliteOpenMode): Promise<IProjectSqliteDatabase>;
}

export class ProjectSqliteError extends Error {
	constructor(message: string, readonly resource: URI | undefined) {
		super(message);
		this.name = 'ProjectSqliteError';
	}
}

// #endregion

// #region Runtime Save Data storage (32. Save / Load Operation; contract: 32. Runtime Save Data)

export const registryCurrentPhysicalTable = corePhysicalTableNameResolver.resolve(registryCurrentTable.schema, registryCurrentTable.table);
export const logsSaveDataPhysicalTable = corePhysicalTableNameResolver.resolve(logsSaveDataTable.schema, logsSaveDataTable.table);

/** Physical tables present in `project.sqlite`. */
export async function listPhysicalTables(database: IProjectSqliteStatements): Promise<readonly string[]> {
	const rows = await database.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
	return rows.map(row => String(row.name));
}

/** Save Event `INSERT` into `logs.savedata`. The Save Event carries no payload. */
export async function insertSaveEvent(database: IProjectSqliteStatements, event: ISaveEvent): Promise<void> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.ExplicitSave);
	await database.run(`INSERT INTO ${quoteIdentifier(logsSaveDataPhysicalTable)} ("uuid", "timestamptz") VALUES (?, ?)`, [event.uuid, event.timestamptz]);
}

export async function getSaveEvent(database: IProjectSqliteStatements, uuid: string): Promise<ISaveEvent | undefined> {
	const row = await database.get(`SELECT "uuid", "timestamptz" FROM ${quoteIdentifier(logsSaveDataPhysicalTable)} WHERE "uuid" = ?`, [uuid]);
	return row ? Object.freeze({ uuid: String(row.uuid), timestamptz: String(row.timestamptz) }) : undefined;
}

function toSaveDataCurrent(row: ProjectSqliteRow): ISaveDataCurrent {
	return Object.freeze({
		uuid: String(row.uuid),
		saveId: String(row.saveId),
		key: String(row.key),
		data: JSON.parse(String(row.data)) as SaveDataJson,
	});
}

/** `registry.current` lookup by its current identity `key`. */
export async function loadSaveDataCurrent(database: IProjectSqliteStatements, key: string): Promise<ISaveDataCurrent | undefined> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.ExplicitSave);
	const row = await database.get(`SELECT "uuid", "saveId", "key", "data" FROM ${quoteIdentifier(registryCurrentPhysicalTable)} WHERE "key" = ?`, [key]);
	return row ? toSaveDataCurrent(row) : undefined;
}

export async function listSaveDataCurrent(database: IProjectSqliteStatements): Promise<readonly ISaveDataCurrent[]> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.ExplicitSave);
	const rows = await database.all(`SELECT "uuid", "saveId", "key", "data" FROM ${quoteIdentifier(registryCurrentPhysicalTable)} ORDER BY "key"`);
	return rows.map(toSaveDataCurrent);
}

/**
 * `registry.current` UPSERT with conflict target `key`: an existing current keeps its `uuid` and
 * gets `saveId` / `data` of this save; a new key gets a fresh Machine Identity. `saveId` must
 * name a Save Event already in `logs.savedata`. Which keys are saved, when, and in which order
 * relative to the Save Event is Application Responsibility; callers that need atomicity run the
 * statements inside {@link IProjectSqliteDatabase.transaction}.
 */
export async function upsertSaveDataCurrentRow(database: IProjectSqliteStatements, saveEvent: ISaveEvent, write: ISaveDataWrite, generateId: () => string = generateUuid): Promise<ISaveDataCurrent> {
	assertProjectSqliteAccess(ProjectSqliteAccessor.ExplicitSave);
	if (!await getSaveEvent(database, saveEvent.uuid)) {
		throw new ProjectSqliteError(`registry.current saveId '${saveEvent.uuid}' does not reference a logs.savedata Save Event`, undefined);
	}
	const existing = await loadSaveDataCurrent(database, write.key);
	const current = upsertSaveDataCurrent(existing, saveEvent, write, generateId);
	const data = JSON.stringify(current.data);
	if (data === undefined) {
		throw new ProjectSqliteError(`registry.current data for '${write.key}' must be JSON`, undefined);
	}
	const conflictTarget = registryCurrentUpsertConflictTarget.map(quoteIdentifier).join(', ');
	await database.run(
		`INSERT INTO ${quoteIdentifier(registryCurrentPhysicalTable)} ("uuid", "saveId", "key", "data") VALUES (?, ?, ?, ?) `
		+ `ON CONFLICT (${conflictTarget}) DO UPDATE SET "saveId" = excluded."saveId", "data" = excluded."data"`,
		[current.uuid, current.saveId, current.key, data],
	);
	return current;
}

// #endregion

// #region Open storage steps

/**
 * The `Create` / `Open` steps of the project `Open` lifecycle: `project.sqlite exists?` decides
 * the mode, `Create` creates the file and `Open` opens it. Both only create / open the database
 * and keep it open for the following steps; no DDL is applied here. Editor fixed-schema DDL
 * (including the Runtime Save Data tables) is applied by `Editor DDL Scan` / `Migration Apply`.
 */
export class ProjectSqliteStorage implements Required<Pick<IProjectOpenSteps, 'createStorage' | 'openStorage'>> {

	private _database: IProjectSqliteDatabase | undefined;

	constructor(private readonly factory: IProjectSqliteDatabaseFactory) {
		if (!isAuthorityFor(AuthorityConcern.ProjectStorage, AuthoritySource.ProjectSqlite)) {
			throw new Error('project.sqlite is not a Project Storage authority');
		}
	}

	readonly artifact = Artifact.ProjectSqlite;

	get isOpen(): boolean {
		return !!this._database;
	}

	get database(): IProjectSqliteDatabase {
		if (!this._database) {
			throw new ProjectSqliteError('project.sqlite is not open', undefined);
		}
		return this._database;
	}

	createStorage(context: IProjectOpenContext): Promise<void> {
		if (context.mode !== ProjectOpenMode.Create) {
			throw new ProjectSqliteError(`project.sqlite Create requires open mode '${ProjectOpenMode.Create}', got '${context.mode}'`, context.paths.sqlite);
		}
		return this.openDatabase(context.paths.sqlite, ProjectSqliteOpenMode.Create);
	}

	openStorage(context: IProjectOpenContext): Promise<void> {
		if (context.mode !== ProjectOpenMode.Open) {
			throw new ProjectSqliteError(`project.sqlite Open requires open mode '${ProjectOpenMode.Open}', got '${context.mode}'`, context.paths.sqlite);
		}
		return this.openDatabase(context.paths.sqlite, ProjectSqliteOpenMode.Open);
	}

	async close(): Promise<void> {
		const database = this._database;
		this._database = undefined;
		await database?.close();
	}

	private async openDatabase(resource: URI, mode: ProjectSqliteOpenMode): Promise<void> {
		assertProjectSqliteAccess(ProjectSqliteAccessor.Authoring);
		if (this._database) {
			throw new ProjectSqliteError(`project.sqlite is already open: ${this._database.resource.toString()}`, resource);
		}
		this._database = await this.factory.open(resource, mode);
	}
}

// #endregion
