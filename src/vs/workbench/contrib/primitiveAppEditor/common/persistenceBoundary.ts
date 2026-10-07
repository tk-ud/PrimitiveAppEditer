/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Persistence boundary (foundation.project-directory)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md
 *  (32. Authoring Persistent, Runtime Transient, Rule, Runtime Save Data, Save Identity,
 *  Application Responsibility, Save Payload, Static / Initial Data Boundary)
 *--------------------------------------------------------------------------------------------*/

import { Artifact, ArtifactLifecycle, getArtifactLifecycle } from './authority.js';
import { getProjectEntry, IProjectEntry, PROJECT_SQLITE_FILE_NAME } from './projectDirectory.js';

/**
 * `Authoring Save = Working Directory + SQLite`, `Runtime State = Memory`,
 * `Runtime State Persistence = explicit only`, `Every Frame Persistence = prohibited`.
 *
 * The Runtime Save Data model (`registry.current` / `logs.savedata`) is encoded as a contract
 * plus its UPSERT semantics. `project.sqlite` (foundation.sqlite) provides the storage; the physical
 * `registry.current` / `logs.savedata` tables are created by the Editor Built-in DDL
 * (foundation.editor-ddl, `001_savedata.sql`). What / when / scope of a save is Application
 * Responsibility and is not decided here.
 */

// #region Authoring Persistent / Runtime Transient

/** `Authoring Persistent`: Working Directory entries saved by Authoring Save. `build/` is derived output and excluded. */
export const authoringPersistentPaths: readonly string[] = Object.freeze([
	PROJECT_SQLITE_FILE_NAME,
	'functions',
	'assets',
	'scripts',
	'config',
]);

export function isAuthoringPersistentPath(path: string): boolean {
	const topLevel = path.split('/')[0];
	return authoringPersistentPaths.includes(topLevel);
}

export function getAuthoringPersistentEntries(): readonly IProjectEntry[] {
	return authoringPersistentPaths.map(path => getProjectEntry(path)!);
}

/** `Runtime Transient`: lives in Runtime Memory only. */
export const runtimeTransientArtifacts: readonly Artifact[] = Object.freeze([
	Artifact.RuntimeState,
	Artifact.FunctionInstance,
	Artifact.FunctionOutput,
	Artifact.Input,
	Artifact.Timer,
	Artifact.Progress,
	Artifact.EventState,
	Artifact.FrameState,
]);

export function isRuntimeTransientArtifact(artifact: Artifact): boolean {
	return getArtifactLifecycle(artifact) === ArtifactLifecycle.TransientRuntime;
}

// #endregion

// #region Rule

export const enum PersistenceTarget {
	WorkingDirectory = 'workingDirectory',
	SQLite = 'sqlite',
	Memory = 'memory',
}

export const persistenceRule = Object.freeze({
	authoringSave: Object.freeze([PersistenceTarget.WorkingDirectory, PersistenceTarget.SQLite] as const),
	runtimeState: PersistenceTarget.Memory,
	runtimeStatePersistence: 'explicit only',
	everyFramePersistence: 'prohibited',
} as const);

/** What initiates a persistence request. */
export const enum PersistenceTrigger {
	/** An explicit Save requested by the Editor (authoring) or by the Application (runtime save data). */
	Explicit = 'explicit',
	/** Automatic persistence policy (e.g. save on change, autosave of runtime state). */
	Automatic = 'automatic',
	/** Persistence driven by the runtime frame loop. */
	EveryFrame = 'everyFrame',
}

export const enum PersistenceVerdict {
	Allowed = 'allowed',
	Forbidden = 'forbidden',
}

export interface IPersistenceDecision {
	readonly verdict: PersistenceVerdict;
	readonly reason: string;
}

/**
 * Decides whether `artifact` may be persisted by `trigger`:
 * Every Frame Persistence is prohibited for everything; Runtime Transient artifacts are
 * persisted only by an explicit save (as Runtime Save Data); authoring artifacts by Authoring Save.
 */
export function checkPersistence(artifact: Artifact, trigger: PersistenceTrigger): IPersistenceDecision {
	if (trigger === PersistenceTrigger.EveryFrame) {
		return { verdict: PersistenceVerdict.Forbidden, reason: 'Every Frame Persistence = prohibited' };
	}
	if (isRuntimeTransientArtifact(artifact)) {
		return trigger === PersistenceTrigger.Explicit
			? { verdict: PersistenceVerdict.Allowed, reason: 'Runtime State Persistence = explicit only (registry.current)' }
			: { verdict: PersistenceVerdict.Forbidden, reason: 'Runtime State Persistence = explicit only' };
	}
	return { verdict: PersistenceVerdict.Allowed, reason: 'Authoring Save = Working Directory + SQLite' };
}

export class PersistenceBoundaryError extends Error {
	constructor(readonly artifact: Artifact, readonly trigger: PersistenceTrigger, reason: string) {
		super(`Primitive App Editor persistence boundary violation: ${artifact} (${trigger}): ${reason}`);
		this.name = 'PersistenceBoundaryError';
	}
}

export function assertPersistence(artifact: Artifact, trigger: PersistenceTrigger): void {
	const decision = checkPersistence(artifact, trigger);
	if (decision.verdict === PersistenceVerdict.Forbidden) {
		throw new PersistenceBoundaryError(artifact, trigger, decision.reason);
	}
}

// #endregion

// #region Runtime Save Data

export const enum SaveDataColumnType {
	Uuid = 'uuid',
	Text = 'text',
	Json = 'json',
	Timestamptz = 'timestamptz',
}

export interface ISaveDataColumn {
	readonly name: string;
	readonly type: SaveDataColumnType;
	/** Logical reference `<schema>.<table>.<column>`. */
	readonly references?: string;
}

export interface ISaveDataTable {
	readonly schema: string;
	readonly table: string;
	readonly columns: readonly ISaveDataColumn[];
	readonly unique: readonly string[];
}

/** `registry.current`: Save Data current, one row per Application-defined `key`. */
export const registryCurrentTable: ISaveDataTable = Object.freeze({
	schema: 'registry',
	table: 'current',
	columns: Object.freeze([
		Object.freeze({ name: 'uuid', type: SaveDataColumnType.Uuid }),
		Object.freeze({ name: 'saveId', type: SaveDataColumnType.Uuid, references: 'logs.savedata.uuid' }),
		Object.freeze({ name: 'key', type: SaveDataColumnType.Text }),
		Object.freeze({ name: 'data', type: SaveDataColumnType.Json }),
	]),
	unique: Object.freeze(['key']),
});

/** `logs.savedata`: Save Event only (not a Save Payload History Store). */
export const logsSaveDataTable: ISaveDataTable = Object.freeze({
	schema: 'logs',
	table: 'savedata',
	columns: Object.freeze([
		Object.freeze({ name: 'uuid', type: SaveDataColumnType.Uuid }),
		Object.freeze({ name: 'timestamptz', type: SaveDataColumnType.Timestamptz }),
	]),
	unique: Object.freeze([]),
});

/** `UPSERT conflict target = key` (never `(saveId, key)`). */
export const registryCurrentUpsertConflictTarget: readonly string[] = Object.freeze(['key']);

export type SaveDataJson = string | number | boolean | null | readonly SaveDataJson[] | { readonly [key: string]: SaveDataJson };

/** A Save Event. `uuid` is the only Save Identity. */
export interface ISaveEvent {
	readonly uuid: string;
	readonly timestamptz: string;
}

/** A `registry.current` row. */
export interface ISaveDataCurrent {
	/** Machine Identity of the current record; stable across saves. */
	readonly uuid: string;
	/** Save Event that last updated this current. */
	readonly saveId: string;
	/** Application-defined current identity; naming and scope are Application Responsibility. */
	readonly key: string;
	/** Application-defined JSON payload. */
	readonly data: SaveDataJson;
}

export interface ISaveDataWrite {
	readonly key: string;
	readonly data: SaveDataJson;
}

export function createSaveEvent(uuid: string, timestamp: Date): ISaveEvent {
	if (!uuid) {
		throw new Error('Save Event requires a uuid');
	}
	return Object.freeze({ uuid, timestamptz: timestamp.toISOString() });
}

/**
 * `registry.current` UPSERT on `key`: an existing current keeps its `uuid` and gets the new
 * `saveId` and `data`; a new key gets a fresh Machine Identity from `generateUuid`.
 */
export function upsertSaveDataCurrent(existing: ISaveDataCurrent | undefined, saveEvent: ISaveEvent, write: ISaveDataWrite, generateUuid: () => string): ISaveDataCurrent {
	if (!write.key) {
		throw new Error('registry.current requires an Application-defined key');
	}
	if (existing && existing.key !== write.key) {
		throw new Error(`registry.current UPSERT conflict target is key: '${existing.key}' != '${write.key}'`);
	}
	if (write.data === undefined) {
		throw new Error(`registry.current data for '${write.key}' must be JSON`);
	}
	return Object.freeze({
		uuid: existing ? existing.uuid : generateUuid(),
		saveId: saveEvent.uuid,
		key: write.key,
		data: write.data,
	});
}

// #endregion
