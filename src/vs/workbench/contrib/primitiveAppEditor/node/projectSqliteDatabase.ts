/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite database on @vscode/sqlite3 (foundation.sqlite)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (4. SQLite)
 *--------------------------------------------------------------------------------------------*/

import type { Database, RunResult } from '@vscode/sqlite3';
import { promises as fs } from 'fs';
import { Sequencer } from '../../../../base/common/async.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import {
	IProjectSqliteDatabase,
	IProjectSqliteDatabaseFactory,
	IProjectSqliteStatements,
	ProjectSqliteError,
	ProjectSqliteOpenMode,
	ProjectSqliteRow,
	ProjectSqliteValue,
} from '../common/projectSqlite.js';

function dbExec(db: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()));
}

function dbRun(db: Database, sql: string, params: readonly ProjectSqliteValue[]): Promise<{ changes: number }> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (this: RunResult, err: Error | null) {
			if (err) {
				return reject(err);
			}
			resolve({ changes: this.changes });
		});
	});
}

function dbGet(db: Database, sql: string, params: readonly ProjectSqliteValue[]): Promise<ProjectSqliteRow | undefined> {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err: Error | null, row: ProjectSqliteRow | undefined) => err ? reject(err) : resolve(row));
	});
}

function dbAll(db: Database, sql: string, params: readonly ProjectSqliteValue[]): Promise<ProjectSqliteRow[]> {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err: Error | null, rows: ProjectSqliteRow[]) => err ? reject(err) : resolve(rows));
	});
}

function dbClose(db: Database): Promise<void> {
	return new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
}

async function dbOpen(path: string, mode: ProjectSqliteOpenMode): Promise<Database> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const flags = mode === ProjectSqliteOpenMode.Create
		? sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
		: sqlite3.OPEN_READWRITE;
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(path, flags, (err: Error | null) => err ? reject(err) : resolve(db));
	});
}

function directStatements(db: Database): IProjectSqliteStatements {
	return Object.freeze({
		exec: (sql: string) => dbExec(db, sql),
		run: (sql: string, params: readonly ProjectSqliteValue[] = []) => dbRun(db, sql, params),
		get: (sql: string, params: readonly ProjectSqliteValue[] = []) => dbGet(db, sql, params),
		all: (sql: string, params: readonly ProjectSqliteValue[] = []) => dbAll(db, sql, params),
	});
}

/**
 * `project.sqlite` connection. Every statement and transaction is serialized so a statement
 * issued outside a transaction never interleaves with it.
 */
export class ProjectSqliteDatabase implements IProjectSqliteDatabase {

	private readonly sequencer = new Sequencer();
	private readonly statements: IProjectSqliteStatements;
	private closed: Promise<void> | undefined;

	constructor(readonly resource: URI, private readonly db: Database) {
		this.statements = directStatements(db);
	}

	exec(sql: string): Promise<void> {
		return this.queue(() => this.statements.exec(sql));
	}

	run(sql: string, params?: readonly ProjectSqliteValue[]): Promise<{ readonly changes: number }> {
		return this.queue(() => this.statements.run(sql, params));
	}

	get(sql: string, params?: readonly ProjectSqliteValue[]): Promise<ProjectSqliteRow | undefined> {
		return this.queue(() => this.statements.get(sql, params));
	}

	all(sql: string, params?: readonly ProjectSqliteValue[]): Promise<readonly ProjectSqliteRow[]> {
		return this.queue(() => this.statements.all(sql, params));
	}

	transaction<T>(work: (statements: IProjectSqliteStatements) => Promise<T>): Promise<T> {
		return this.queue(async () => {
			await this.statements.exec('BEGIN IMMEDIATE TRANSACTION');
			let result: T;
			try {
				result = await work(this.statements);
			} catch (error) {
				await this.statements.exec('ROLLBACK');
				throw error;
			}
			await this.statements.exec('COMMIT');
			return result;
		});
	}

	close(): Promise<void> {
		if (!this.closed) {
			this.closed = this.sequencer.queue(() => dbClose(this.db));
		}
		return this.closed;
	}

	private queue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) {
			return Promise.reject(new ProjectSqliteError(`project.sqlite is closed: ${this.resource.toString()}`, this.resource));
		}
		return this.sequencer.queue(operation);
	}
}

/** Opens `project.sqlite` files on the local file system. */
export class ProjectSqliteDatabaseFactory implements IProjectSqliteDatabaseFactory {

	async open(resource: URI, mode: ProjectSqliteOpenMode): Promise<IProjectSqliteDatabase> {
		if (resource.scheme !== Schemas.file) {
			throw new ProjectSqliteError(`project.sqlite must be a local file: ${resource.toString()}`, resource);
		}
		const path = resource.fsPath;
		const exists = await fs.stat(path).then(stat => {
			if (!stat.isFile()) {
				throw new ProjectSqliteError(`project.sqlite is not a file: ${resource.toString()}`, resource);
			}
			return true;
		}, () => false);
		if (mode === ProjectSqliteOpenMode.Create && exists) {
			throw new ProjectSqliteError(`project.sqlite already exists: ${resource.toString()}`, resource);
		}
		if (mode === ProjectSqliteOpenMode.Open && !exists) {
			throw new ProjectSqliteError(`project.sqlite does not exist: ${resource.toString()}`, resource);
		}

		const db = await dbOpen(path, mode);
		try {
			// SQLite opens lazily: reading the header rejects a file that is not a database.
			await dbGet(db, 'PRAGMA schema_version', []);
		} catch (error) {
			await dbClose(db);
			throw new ProjectSqliteError(`project.sqlite is not a SQLite database: ${resource.toString()} (${error instanceof Error ? error.message : String(error)})`, resource);
		}
		return new ProjectSqliteDatabase(resource, db);
	}
}
