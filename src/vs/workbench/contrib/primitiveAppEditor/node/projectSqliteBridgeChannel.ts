/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite bridge channel, Node side (workbench.project-bridge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Working Directory Integration)
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	IProjectSqliteDatabase,
	IProjectSqliteDatabaseFactory,
	IProjectSqliteStatements,
	ProjectSqliteError,
	ProjectSqliteOpenMode,
	ProjectSqliteValue,
} from '../common/projectSqlite.js';
import { ProjectSqliteBridgeArgs, ProjectSqliteBridgeCommand } from '../common/projectSqliteBridge.js';
import { ProjectSqliteDatabaseFactory } from './projectSqliteDatabase.js';

interface IOpenTransaction {
	/** Statements of the transaction run here, inside the database's own serialized transaction. */
	readonly statements: Promise<IProjectSqliteStatements>;
	readonly finish: (commit: boolean) => Promise<void>;
}

/**
 * Hosts the Node-side ProjectSqlite adapter for renderers. A database is addressed by the handle
 * returned from `open`; a renderer transaction maps to one transaction of the adapter, so the
 * adapter's serialization (no interleaving outside the transaction) is preserved across the bridge.
 */
export class ProjectSqliteBridgeChannel implements IServerChannel, IDisposable {

	private nextHandle = 1;
	/** Handle table per client (ctx): a client can only operate on the handles it opened. */
	private readonly clients = new Map<string, Map<number, IProjectSqliteDatabase>>();
	private readonly transactions = new Map<number, IOpenTransaction>();

	constructor(private readonly factory: IProjectSqliteDatabaseFactory = new ProjectSqliteDatabaseFactory()) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		if (command === ProjectSqliteBridgeCommand.Open) {
			const [resource, mode] = arg as readonly [string, ProjectSqliteOpenMode];
			const database = await this.factory.open(URI.parse(resource), mode);
			const handle = this.nextHandle++;
			let databases = this.clients.get(ctx);
			if (!databases) {
				databases = new Map();
				this.clients.set(ctx, databases);
			}
			databases.set(handle, database);
			return handle as T;
		}

		const [handle, sql, params] = arg as readonly [number, string?, (readonly ProjectSqliteValue[])?] & ProjectSqliteBridgeArgs;
		const database = this.clients.get(ctx)?.get(handle);
		if (!database) {
			throw new ProjectSqliteError(`project.sqlite handle is not open: ${handle}`, undefined);
		}
		const transaction = this.transactions.get(handle);
		const statements: IProjectSqliteStatements = transaction ? await transaction.statements : database;

		switch (command) {
			case ProjectSqliteBridgeCommand.Exec: return await statements.exec(sql!) as T;
			case ProjectSqliteBridgeCommand.Run: return await statements.run(sql!, params) as T;
			case ProjectSqliteBridgeCommand.Get: return await statements.get(sql!, params) as T;
			case ProjectSqliteBridgeCommand.All: return await statements.all(sql!, params) as T;
			case ProjectSqliteBridgeCommand.Begin: return await this.begin(handle, database) as T;
			case ProjectSqliteBridgeCommand.Commit: return await this.end(ctx, handle, true) as T;
			case ProjectSqliteBridgeCommand.Rollback: return await this.end(ctx, handle, false) as T;
			case ProjectSqliteBridgeCommand.Close: return await this.close(ctx, handle, database) as T;
		}
		throw new Error(`Call not found: ${command}`);
	}

	private async begin(handle: number, database: IProjectSqliteDatabase): Promise<void> {
		if (this.transactions.has(handle)) {
			throw new ProjectSqliteError('project.sqlite transaction is already running', database.resource);
		}
		let resolveStatements!: (statements: IProjectSqliteStatements) => void;
		let rejectStatements!: (error: unknown) => void;
		const statements = new Promise<IProjectSqliteStatements>((resolve, reject) => { resolveStatements = resolve; rejectStatements = reject; });
		let release!: (commit: boolean) => void;
		const finished = new Promise<boolean>(resolve => release = resolve);
		const done = database.transaction(async inner => {
			resolveStatements(inner);
			if (!await finished) {
				throw new RolledBack();
			}
		}).catch(error => {
			if (!(error instanceof RolledBack)) {
				throw error;
			}
		});
		// `BEGIN` failing rejects `done` without ever calling the work: surface it to `begin` instead of hanging.
		// After `begin` resolved this is a no-op; `end` still observes `done` itself (commit failure).
		done.catch(error => rejectStatements(error));
		this.transactions.set(handle, { statements, finish: async commit => { release(commit); await done; } });
		try {
			await statements;
		} catch (error) {
			this.transactions.delete(handle);
			throw error;
		}
	}

	private async end(ctx: string, handle: number, commit: boolean): Promise<void> {
		const transaction = this.transactions.get(handle);
		if (!transaction) {
			throw new ProjectSqliteError('project.sqlite has no running transaction', this.clients.get(ctx)?.get(handle)?.resource);
		}
		this.transactions.delete(handle);
		await transaction.finish(commit);
	}

	private async close(ctx: string, handle: number, database: IProjectSqliteDatabase): Promise<void> {
		try {
			if (this.transactions.has(handle)) {
				await this.end(ctx, handle, false);
			}
		} finally {
			this.clients.get(ctx)?.delete(handle);
			await database.close();
		}
	}

	/**
	 * A client disconnected (close / reload / crash): roll back its running transactions and close its
	 * handles so the project.sqlite lock is released. Other clients are unaffected.
	 */
	async onDidDisconnect(ctx: string): Promise<void> {
		const databases = this.clients.get(ctx);
		if (!databases) {
			return;
		}
		this.clients.delete(ctx);
		await Promise.allSettled([...databases].map(async ([handle, database]) => {
			try {
				const transaction = this.transactions.get(handle);
				if (transaction) {
					this.transactions.delete(handle);
					await transaction.finish(false);
				}
			} finally {
				await database.close();
			}
		}));
	}

	dispose(): void {
		for (const ctx of [...this.clients.keys()]) {
			void this.onDidDisconnect(ctx);
		}
	}
}

class RolledBack extends Error { }
