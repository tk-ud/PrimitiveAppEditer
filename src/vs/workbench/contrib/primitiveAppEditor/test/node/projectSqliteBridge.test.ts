/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite bridge (workbench.project-bridge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Working Directory Integration)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IChannel, IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IProjectSqliteDatabase, IProjectSqliteDatabaseFactory, ProjectSqliteOpenMode } from '../../common/projectSqlite.js';
import { PROJECT_SQLITE_BRIDGE_CHANNEL, ProjectSqliteBridgeDatabaseFactory } from '../../common/projectSqliteBridge.js';
import { ProjectSqliteBridgeChannel, registerProjectSqliteBridge } from '../../node/projectSqliteBridgeChannel.js';
import { ProjectSqliteDatabaseFactory } from '../../node/projectSqliteDatabase.js';

/** Serializes arguments like the IPC does, so only JSON-safe values cross the bridge. */
function bridgeFactory(server: ProjectSqliteBridgeChannel, connection = server.connect()): ProjectSqliteBridgeDatabaseFactory {
	const channel: IChannel = {
		call: <T>(command: string, arg?: unknown) => connection.call<T>('window', command, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))).then(result => result === undefined ? result : JSON.parse(JSON.stringify(result))),
		listen: <T>() => Event.None as Event<T>,
	};
	return new ProjectSqliteBridgeDatabaseFactory(channel);
}

suite('Primitive App Editor - project.sqlite bridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let tempRoot: string;
	let resource: URI;
	let server: ProjectSqliteBridgeChannel;
	let factory: ProjectSqliteBridgeDatabaseFactory;

	setup(async () => {
		tempRoot = join(tmpdir(), `primitive-app-editor-bridge-${generateUuid()}`);
		await fs.mkdir(tempRoot, { recursive: true });
		resource = URI.file(join(tempRoot, 'project.sqlite'));
		server = new ProjectSqliteBridgeChannel();
		factory = bridgeFactory(server);
	});

	teardown(async () => {
		server.dispose();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test('Create then statements reach project.sqlite through the bridge', async () => {
		const database = await factory.open(resource, ProjectSqliteOpenMode.Create);
		await database.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
		assert.strictEqual((await database.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1])).changes, 1);
		assert.deepStrictEqual(await database.get('SELECT id, n FROM t WHERE id = ?', ['a']), { id: 'a', n: 1 });
		assert.strictEqual(await database.get('SELECT id FROM t WHERE id = ?', ['missing']), undefined);
		assert.deepStrictEqual(await database.all('SELECT id FROM t'), [{ id: 'a' }]);
		await database.close();

		const reopened = await factory.open(resource, ProjectSqliteOpenMode.Open);
		assert.deepStrictEqual(await reopened.all('SELECT id FROM t'), [{ id: 'a' }]);
		await reopened.close();
	});

	test('adapter errors reject through the bridge', async () => {
		await assert.rejects(() => factory.open(resource, ProjectSqliteOpenMode.Open), /does not exist/);
		const database = await factory.open(resource, ProjectSqliteOpenMode.Create);
		await assert.rejects(() => factory.open(resource, ProjectSqliteOpenMode.Create), /already exists/);
		await assert.rejects(() => database.exec('NOT SQL'));
		await database.close();
		await assert.rejects(() => database.exec('SELECT 1'), /closed/);
	});

	test('transaction commits on resolve and rolls back on reject', async () => {
		const database = await factory.open(resource, ProjectSqliteOpenMode.Create);
		await database.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

		await database.transaction(async statements => {
			await statements.run('INSERT INTO t (id) VALUES (?)', ['committed']);
			assert.deepStrictEqual(await statements.all('SELECT id FROM t'), [{ id: 'committed' }]);
		});
		await assert.rejects(() => database.transaction(async statements => {
			await statements.run('INSERT INTO t (id) VALUES (?)', ['rolledback']);
			throw new Error('abort');
		}), /abort/);

		assert.deepStrictEqual(await database.all('SELECT id FROM t'), [{ id: 'committed' }]);
		await database.close();
	});

	test('statements outside a transaction wait until it finished', async () => {
		const database = await factory.open(resource, ProjectSqliteOpenMode.Create);
		await database.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		const transaction = database.transaction(async statements => {
			await statements.run('INSERT INTO t (id) VALUES (?)', ['in-tx']);
			await gate;
		});
		const outside = database.all('SELECT id FROM t');
		release();
		await transaction;
		assert.deepStrictEqual(await outside, [{ id: 'in-tx' }]);
		await database.close();
	});

	test('close waits for a running transaction', async () => {
		const database = await factory.open(resource, ProjectSqliteOpenMode.Create);
		await database.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		const transaction = database.transaction(async statements => {
			await statements.run('INSERT INTO t (id) VALUES (?)', ['x']);
			await gate;
		});
		const closing = database.close();
		release();
		await transaction;
		await closing;
		const reopened = await factory.open(resource, ProjectSqliteOpenMode.Open);
		assert.deepStrictEqual(await reopened.all('SELECT id FROM t'), [{ id: 'x' }]);
		await reopened.close();
	});

	test('a failing BEGIN rejects the transaction and leaves the handle usable', async () => {
		let failBegin = true;
		const real = new ProjectSqliteDatabaseFactory();
		const failing: IProjectSqliteDatabaseFactory = {
			async open(resource, mode) {
				const database = await real.open(resource, mode);
				return new Proxy(database, {
					get(target, property) {
						if (property === 'transaction') {
							return (work: Parameters<IProjectSqliteDatabase['transaction']>[0]) => {
								if (failBegin) {
									failBegin = false;
									return Promise.reject(new Error('database is locked'));
								}
								return target.transaction(work);
							};
						}
						const value = Reflect.get(target, property);
						return typeof value === 'function' ? value.bind(target) : value;
					},
				});
			},
		};
		const failingServer = new ProjectSqliteBridgeChannel(failing);
		try {
			const database = await bridgeFactory(failingServer).open(resource, ProjectSqliteOpenMode.Create);
			await database.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

			await assert.rejects(() => database.transaction(async () => assert.fail('work must not run')), /database is locked/);

			// The handle is not stuck in a transaction: statements, a new transaction and close all complete.
			assert.deepStrictEqual(await database.all('SELECT id FROM t'), []);
			await database.transaction(async statements => { await statements.run('INSERT INTO t (id) VALUES (?)', ['after']); });
			assert.deepStrictEqual(await database.all('SELECT id FROM t'), [{ id: 'after' }]);
			await database.close();
		} finally {
			failingServer.dispose();
		}
	});
	test('disconnect rolls back the transaction and releases the handle and lock for other clients', async () => {
		const connectionA = server.connect();
		const a = bridgeFactory(server, connectionA);
		const b = bridgeFactory(server);
		const databaseA = await a.open(resource, ProjectSqliteOpenMode.Create);
		await databaseA.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

		// Leave a transaction running (BEGIN IMMEDIATE) on A's handle, then drop the client.
		let leave!: () => void;
		const left = new Promise<void>(resolve => leave = resolve);
		const running = databaseA.transaction(async statements => {
			await statements.run('INSERT INTO t (id) VALUES (?)', ['uncommitted']);
			leave();
			await new Promise(() => { });
		});
		running.catch(() => { });
		await left;
		connectionA.dispose();

		const databaseB = await b.open(resource, ProjectSqliteOpenMode.Open);
		assert.deepStrictEqual(await databaseB.all('SELECT id FROM t'), []);
		await databaseB.transaction(async statements => { await statements.run('INSERT INTO t (id) VALUES (?)', ['b']); });
		assert.deepStrictEqual(await databaseB.all('SELECT id FROM t'), [{ id: 'b' }]);
		await databaseB.close();
		// The disconnected client's handle is gone on the Node side.
		await assert.rejects(() => connectionA.call('window', 'exec', [1, 'SELECT 1']), /not open/);
	});

	test('disconnect of one client leaves the handles of another client usable', async () => {
		const connectionA = server.connect();
		const a = bridgeFactory(server, connectionA);
		const b = bridgeFactory(server);
		const databaseA = await a.open(resource, ProjectSqliteOpenMode.Create);
		await databaseA.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
		const databaseB = await b.open(URI.file(join(tempRoot, 'other.sqlite')), ProjectSqliteOpenMode.Create);
		await databaseB.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

		connectionA.dispose();
		await databaseB.run('INSERT INTO t (id) VALUES (?)', ['b']);
		assert.deepStrictEqual(await databaseB.all('SELECT id FROM t'), [{ id: 'b' }]);
		await databaseB.close();
	});

	test('a client cannot use a handle opened by another client, even with the same ctx', async () => {
		const connectionA = server.connect();
		const connectionB = server.connect();
		const handle = await connectionA.call<number>('window:1', 'open', [resource.toString(), ProjectSqliteOpenMode.Create]);
		await assert.rejects(() => connectionB.call('window:1', 'exec', [handle, 'SELECT 1']), /not open/);
		await assert.rejects(() => connectionB.call('window:1', 'close', [handle]), /not open/);
		await connectionA.call('window:1', 'exec', [handle, 'SELECT 1']);
		await connectionA.call('window:1', 'close', [handle]);
	});

	test('a late disconnect of the old connection does not reclaim the handles of the reloaded window (same ctx)', async () => {
		const oldConnection = server.connect();
		const oldDatabase = await bridgeFactory(server, oldConnection).open(resource, ProjectSqliteOpenMode.Create);
		await oldDatabase.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
		await oldDatabase.run('INSERT INTO t (id) VALUES (?)', ['old']);

		const newConnection = server.connect();
		const newDatabase = await bridgeFactory(server, newConnection).open(resource, ProjectSqliteOpenMode.Open);
		let leave!: () => void;
		const left = new Promise<void>(resolve => leave = resolve);
		const running = newDatabase.transaction(async statements => {
			await statements.run('INSERT INTO t (id) VALUES (?)', ['new']);
			leave();
			await new Promise(resolve => setTimeout(resolve, 50));
		});
		await left;

		// The removal of the old connection arrives after the new connection opened and began a transaction.
		oldConnection.dispose();
		await running;
		assert.deepStrictEqual(await newDatabase.all('SELECT id FROM t ORDER BY id'), [{ id: 'new' }, { id: 'old' }]);
		await newDatabase.close();
	});

	test('a disconnect while open is in flight does not leak the handle or the lock', async () => {
		const real = new ProjectSqliteDatabaseFactory();
		let releaseOpen!: () => void;
		const gate = new Promise<void>(resolve => releaseOpen = resolve);
		let opened: IProjectSqliteDatabase | undefined;
		const delayed: IProjectSqliteDatabaseFactory = {
			open: async (res, mode) => {
				const database = await real.open(res, mode);
				opened = database;
				await gate;
				return database;
			}
		};
		const delayedServer = new ProjectSqliteBridgeChannel(delayed);
		try {
			const connection = delayedServer.connect();
			const opening = connection.call<number>('window', 'open', [resource.toString(), ProjectSqliteOpenMode.Create]);
			opening.catch(() => { });
			while (!opened) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			connection.dispose();
			releaseOpen();
			await assert.rejects(() => opening, /disconnected/);
			// The database was closed by the bridge, not left registered for a gone client.
			await assert.rejects(() => opened!.exec('SELECT 1'), /closed/);
			await assert.rejects(() => connection.call('window', 'open', [resource.toString(), ProjectSqliteOpenMode.Open]), /disconnected/);
		} finally {
			delayedServer.dispose();
		}
	});

	test('registerProjectSqliteBridge owns handles per connection and reclaims them when the connection is removed', async () => {
		interface IFakeConnection { readonly ctx: string; readonly channelServer: { registerChannel(name: string, channel: IServerChannel<string>): void } }
		const added = new Emitter<IFakeConnection>();
		const removed = new Emitter<IFakeConnection>();
		const registrations = new Map<IFakeConnection, IServerChannel<string>>();
		const makeConnection = (): IFakeConnection => {
			const connection: IFakeConnection = { ctx: 'window:1', channelServer: { registerChannel: (name, channel) => { assert.strictEqual(name, PROJECT_SQLITE_BRIDGE_CHANNEL); registrations.set(connection, channel); } } };
			added.fire(connection);
			return connection;
		};
		const registration = registerProjectSqliteBridge({ onDidAddConnection: added.event, onDidRemoveConnection: removed.event }, server);
		try {
			const oldConnection = makeConnection();
			const oldHandle = await registrations.get(oldConnection)!.call<number>(oldConnection.ctx, 'open', [resource.toString(), ProjectSqliteOpenMode.Create]);
			const reloaded = makeConnection();
			const newHandle = await registrations.get(reloaded)!.call<number>(reloaded.ctx, 'open', [resource.toString(), ProjectSqliteOpenMode.Open]);

			removed.fire(oldConnection);
			await new Promise(resolve => setTimeout(resolve, 20));
			await assert.rejects(() => registrations.get(oldConnection)!.call(oldConnection.ctx, 'exec', [oldHandle, 'SELECT 1']), /not open/);
			await registrations.get(reloaded)!.call(reloaded.ctx, 'exec', [newHandle, 'SELECT 1']);

			removed.fire(reloaded);
			await new Promise(resolve => setTimeout(resolve, 20));
			await assert.rejects(() => registrations.get(reloaded)!.call(reloaded.ctx, 'exec', [newHandle, 'SELECT 1']), /not open/);
		} finally {
			registration.dispose();
			added.dispose();
			removed.dispose();
		}
	});
});
