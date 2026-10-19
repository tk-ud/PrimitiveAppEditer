/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite bridge contract (workbench.project-bridge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Working Directory Integration)
 *--------------------------------------------------------------------------------------------*/

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import {
	IProjectSqliteDatabase,
	IProjectSqliteDatabaseFactory,
	IProjectSqliteStatements,
	ProjectSqliteError,
	ProjectSqliteOpenMode,
	ProjectSqliteRow,
	ProjectSqliteValue,
} from './projectSqlite.js';

/**
 * `Renderer (sandbox) -> main / shared process bridge -> Node-side ProjectSqlite adapter -> project.sqlite`.
 * The bridge only forwards the database contract of `projectSqlite.ts`; it adds no Authority,
 * Schema or SQL of its own.
 */
export const PROJECT_SQLITE_BRIDGE_CHANNEL = 'primitiveAppEditorProjectSqlite';

export const enum ProjectSqliteBridgeCommand {
	Open = 'open',
	Exec = 'exec',
	Run = 'run',
	Get = 'get',
	All = 'all',
	Begin = 'begin',
	Commit = 'commit',
	Rollback = 'rollback',
	Close = 'close',
}

/** Every request after `open` names the database handle returned by `open`. */
export type ProjectSqliteBridgeArgs = readonly [handle: number, ...rest: unknown[]];

/** Renderer-side `project.sqlite` factory: every database is a handle held by the bridge channel. */
export class ProjectSqliteBridgeDatabaseFactory implements IProjectSqliteDatabaseFactory {

	constructor(private readonly channel: IChannel) { }

	async open(resource: URI, mode: ProjectSqliteOpenMode): Promise<IProjectSqliteDatabase> {
		const handle = await this.channel.call<number>(ProjectSqliteBridgeCommand.Open, [resource.toString(), mode]);
		return new ProjectSqliteBridgeDatabase(this.channel, resource, handle);
	}
}

class ProjectSqliteBridgeDatabase implements IProjectSqliteDatabase {

	private closed: Promise<void> | undefined;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly channel: IChannel, readonly resource: URI, private readonly handle: number) { }

	exec(sql: string): Promise<void> {
		return this.request(ProjectSqliteBridgeCommand.Exec, sql);
	}

	run(sql: string, params?: readonly ProjectSqliteValue[]): Promise<{ readonly changes: number }> {
		return this.request(ProjectSqliteBridgeCommand.Run, sql, params);
	}

	get(sql: string, params?: readonly ProjectSqliteValue[]): Promise<ProjectSqliteRow | undefined> {
		return this.request(ProjectSqliteBridgeCommand.Get, sql, params);
	}

	all(sql: string, params?: readonly ProjectSqliteValue[]): Promise<readonly ProjectSqliteRow[]> {
		return this.request(ProjectSqliteBridgeCommand.All, sql, params);
	}

	/**
	 * The transaction runs `work` in the renderer, so its statements cannot be interleaved by the
	 * Node side alone: transactions are serialized here and the Node side holds the database lock
	 * (`begin` .. `commit` / `rollback`) while statements outside the transaction wait for it.
	 */
	transaction<T>(work: (statements: IProjectSqliteStatements) => Promise<T>): Promise<T> {
		const run = this.chain.then(async () => {
			await this.call(ProjectSqliteBridgeCommand.Begin);
			const statements: IProjectSqliteStatements = Object.freeze({
				exec: (sql: string) => this.call<void>(ProjectSqliteBridgeCommand.Exec, sql),
				run: (sql: string, params?: readonly ProjectSqliteValue[]) => this.call<{ readonly changes: number }>(ProjectSqliteBridgeCommand.Run, sql, params),
				get: (sql: string, params?: readonly ProjectSqliteValue[]) => this.call<ProjectSqliteRow | undefined>(ProjectSqliteBridgeCommand.Get, sql, params),
				all: (sql: string, params?: readonly ProjectSqliteValue[]) => this.call<readonly ProjectSqliteRow[]>(ProjectSqliteBridgeCommand.All, sql, params),
			});
			let result: T;
			try {
				result = await work(statements);
			} catch (error) {
				await this.call(ProjectSqliteBridgeCommand.Rollback);
				throw error;
			}
			await this.call(ProjectSqliteBridgeCommand.Commit);
			return result;
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	close(): Promise<void> {
		if (!this.closed) {
			this.closed = this.chain.then(() => this.channel.call<void>(ProjectSqliteBridgeCommand.Close, [this.handle]));
		}
		return this.closed;
	}

	/** Statement outside a transaction: waits for a running transaction, then runs. */
	private request<T>(command: ProjectSqliteBridgeCommand, sql: string, params?: readonly ProjectSqliteValue[]): Promise<T> {
		if (this.closed) {
			return Promise.reject(new ProjectSqliteError(`project.sqlite is closed: ${this.resource.toString()}`, this.resource));
		}
		const run = this.chain.then(() => this.call<T>(command, sql, params));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private call<T = void>(command: ProjectSqliteBridgeCommand, sql?: string, params?: readonly ProjectSqliteValue[]): Promise<T> {
		const args: ProjectSqliteBridgeArgs = sql === undefined ? [this.handle] : [this.handle, sql, params ?? []];
		return this.channel.call<T>(command, args);
	}
}
