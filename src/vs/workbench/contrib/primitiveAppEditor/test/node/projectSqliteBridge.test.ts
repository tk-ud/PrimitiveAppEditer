/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - project.sqlite bridge (workbench.project-bridge)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Working Directory Integration)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ProjectSqliteOpenMode } from '../../common/projectSqlite.js';
import { ProjectSqliteBridgeDatabaseFactory } from '../../common/projectSqliteBridge.js';
import { ProjectSqliteBridgeChannel } from '../../node/projectSqliteBridgeChannel.js';

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
		// Serialize arguments like the IPC does, so only JSON-safe values cross the bridge.
		const channel: IChannel = {
			call: <T>(command: string, arg?: unknown) => server.call<T>('window', command, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))).then(result => result === undefined ? result : JSON.parse(JSON.stringify(result))),
			listen: <T>() => Event.None as Event<T>,
		};
		factory = new ProjectSqliteBridgeDatabaseFactory(channel);
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
});
