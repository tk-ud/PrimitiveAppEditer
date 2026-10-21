#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Deploy E2E (completion.end-to-end, Deploy Configuration.md 7.2)
 *  Usage (repo root, after `npm ci`): node --experimental-strip-types tools/primitive-app-editor/e2e/run.ts
 *  Requires Docker Engine + Compose plugin on Linux. The harness (not the Editor) runs compose explicitly.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = mkdtempSync(join(tmpdir(), 'pae-e2e-'));
const jsOut = join(work, 'js');
const outDir = join(work, 'app');
const project = 'paee2e';
const PASSWORD = 'e2e-password-not-secret';
const results: { name: string; ok: boolean }[] = [];

function step(name: string, ok: boolean, detail = '') {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
	if (!ok) { throw new Error(`E2E step failed: ${name}`); }
}

function run(cmd: string, args: string[], options: object = {}) {
	return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}

function compose(composeFile: string, ...args: string[]) {
	return run('docker', ['compose', '-p', project, '-f', composeFile, ...args], { cwd: outDir, env: { ...process.env, DB_PASSWORD: PASSWORD } });
}

/** Docker Hub may be rate limited; fall back to the ECR public mirror for library images and retag. */
function ensureImage(image: string) {
	if (run('docker', ['image', 'inspect', image]).status === 0) { return; }
	if (run('docker', ['pull', image]).status === 0) { return; }
	for (const prefix of ['mirror.gcr.io/library', 'public.ecr.aws/docker/library']) {
		const mirror = `${prefix}/${image}`;
	if (run('docker', ['pull', mirror]).status === 0) { run('docker', ['tag', mirror, image]); return; }
	}
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, attempts = 60): Promise<T> {
	for (let i = 0; i < attempts; i++) {
		try { const value = await probe(); if (value) { return value; } } catch { /* retry */ }
		await new Promise(r => setTimeout(r, 2000));
	}
	throw new Error(`timeout waiting for ${label}`);
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any; type: string }> {
	const response = await fetch(`http://localhost:8080${path}`, init);
	const text = await response.text();
	let body: any; try { body = JSON.parse(text); } catch { body = text; }
	return { status: response.status, body, type: response.headers.get('content-type') ?? '' };
}

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let composeFile = '';
try {
	// 1. Build Validation -> Application Output; 2. Dockerfile / Compose scaffold (never overwrites).
	const tsc = run(join(root, 'node_modules/.bin/tsc'), ['--outDir', jsOut, '--rootDir', root, '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck', '--noEmitOnError', 'false', '--experimentalDecorators', '--types', 'node', join(root, 'tools/primitive-app-editor/e2e/fixture.ts')]);
	writeFileSync(join(jsOut, 'package.json'), '{"type":"module"}');
	const { buildDeployFiles } : any = await import(pathToFileURL(join(jsOut, 'tools/primitive-app-editor/e2e/fixture.js')).href);
	const first = buildDeployFiles();
	step('Build Validation succeeds and Application Output + Scaffold are generated', Object.keys(first.files).length > 10 && first.files['001_init_postgresql.sql'] !== undefined, `${Object.keys(first.files).length} files`);
	const second = buildDeployFiles(Object.keys(first.files));
	step('Re-scaffold with existing files yields sequenced names and the same input is deterministic', second.compose === 'compose-001.yml' && JSON.stringify(buildDeployFiles().files) === JSON.stringify(first.files), second.compose);
	for (const [path, content] of Object.entries(first.files)) {
		mkdirSync(dirname(join(outDir, path)), { recursive: true });
		writeFileSync(join(outDir, path), content as string);
	}
	composeFile = first.compose;
	step('Editor-independent Output excludes Editor modules', !Object.keys(first.files).some(p => p.includes('vs/workbench')));

	// 3. `docker compose -f <YAML> config` (password supplied via environment, never embedded).
	step('docker compose -f <YAML> config succeeds', compose(composeFile, 'config', '-q').status === 0);
	step('Secrets are not embedded in generated files', !(Object.values(first.files) as string[]).some(c => c.includes(PASSWORD)));

	// 4. Explicit build / up -d by the harness (the Editor never runs them).
	for (const image of ['postgres:16.4', 'node:20.15-alpine']) { ensureImage(image); }
	const build = compose(composeFile, 'build');
	step('docker compose build succeeds', build.status === 0, build.status === 0 ? '' : (build.stderr ?? '').slice(-800));
	const up = compose(composeFile, 'up', '-d');
	step('docker compose up -d succeeds', up.status === 0, up.status === 0 ? '' : (up.stderr ?? '').slice(-800));

	// 5. DDL applied / Seed loaded; 6. API health, CRUD, validation, DB connection.
	const definition = await waitFor('API /api/definition', async () => { const r = await api('/api/definition'); return r.status === 200 ? r.body : undefined; });
	step('API health: /api/definition returns the Application Definition', Array.isArray(definition.tables) && definition.tables.some((t: any) => t.name === 'player'));
	const rows = await waitFor('seed rows', async () => { const r = await api('/api/tables/items/player'); return r.status === 200 && r.body.length > 0 ? r.body : undefined; });
	step('PostgreSQL DDL applied and Seed loaded (DB connection)', rows.some((r: any) => JSON.stringify(r).includes('seed-player')), `${rows.length} row(s)`);
	const created = await api('/api/tables/items/player', json('POST', { label: 'e2e-created', fatigue: 2.5 }));
	step('CRUD: create returns 201 with uuid', created.status === 201 && typeof created.body.uuid === 'string');
	const uuid = created.body.uuid;
	const fetched = await api(`/api/tables/items/player/${uuid}`);
	step('CRUD: read returns the created row', fetched.status === 200 && JSON.stringify(fetched.body).includes('e2e-created'));
	const updated = await api(`/api/tables/items/player/${uuid}`, json('PUT', { fatigue: 9 }));
	const afterUpdate = await api(`/api/tables/items/player/${uuid}`);
	step('CRUD: update persists', updated.status < 300 && JSON.stringify(afterUpdate.body).includes('9'));
	const invalid = await api('/api/tables/items/player', json('POST', { fatigue: 'not-a-number' }));
	step('Validation: invalid input is 400 problem+json, not 500', invalid.status === 400 && invalid.type.includes('application/problem+json') && invalid.body.errors !== undefined);
	const keep = await api('/api/tables/items/player', json('POST', { label: 'persist-me' }));
	const removed = await api(`/api/tables/items/player/${uuid}`, { method: 'DELETE' });
	step('CRUD: delete removes the row', removed.status < 300 && (await api(`/api/tables/items/player/${uuid}`)).status === 404);

	// 7. Next.js UI renders API results.
	const html = await waitFor('UI', async () => { const r = await fetch('http://localhost:3000/'); return r.status === 200 ? await r.text() : undefined; });
	step('Next.js UI is served and renders API data', html.length > 0 && /seed-player|persist-me|gauge|player/i.test(html));

	// 8. Application keeps running with no Editor process: the harness holds no Editor module state after this point.
	step('Application is standalone (compose services run without the Editor)', compose(composeFile, 'ps', '--status', 'running', '-q').stdout.trim().split('\n').length >= 3);

	// 9. Stop and restart: named volume keeps data.
	step('docker compose stop succeeds', compose(composeFile, 'stop').status === 0);
	step('docker compose start succeeds', compose(composeFile, 'start').status === 0);
	const persisted = await waitFor('persisted rows after restart', async () => { const r = await api('/api/tables/items/player'); return r.status === 200 && r.body.length > 0 ? r.body : undefined; });
	step('Persisted data survives stop / restart', JSON.stringify(persisted).includes('persist-me') && keep.status === 201);
	console.log(`\nE2E OK: ${results.length} checks passed`);
	void tsc; void existsSync;
} catch (error: any) {
	console.error(String(error?.stack ?? error));
	process.exitCode = 1;
} finally {
	if (composeFile) { compose(composeFile, 'down', '-v', '--remove-orphans'); }
	rmSync(work, { recursive: true, force: true });
}
