/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - generated setup.sh behavior (build.deploy-setup-script)
 *  Specification SSOT: docs/primitive-app-editor/Deploy Configuration.md (6. Setup Script / Docker Prerequisites)
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createDeployScaffold, createDeploySelection, DEPLOY_SETUP_SH_FILE, parseDeployTemplate, BUILTIN_DEPLOY_TEMPLATE_DOCUMENT } from '../../common/deployProjection.js';

const isPosix = process.platform !== 'win32';

suite('Primitive App Editor - generated setup.sh', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	setup(() => { root = mkdtempSync(join(tmpdir(), 'pae-setup-')); });
	teardown(() => rmSync(root, { recursive: true, force: true }));

	function generate(assist: boolean): string {
		const text = BUILTIN_DEPLOY_TEMPLATE_DOCUMENT.replace('    compose: true\n', `    compose: true\n    prerequisites_check: true\n${assist ? '    installer_assistance: true\n' : ''}    setup_script: true\n`);
		const template = parseDeployTemplate(text);
		const scaffold = createDeployScaffold(template, createDeploySelection({ template_id: template.id, host: 'linux' }), ['application.definition.json', '001_init_postgresql.sql'], ['compose.yml']);
		return scaffold.files.find(file => file.requested === DEPLOY_SETUP_SH_FILE)!.content;
	}

	/** A work directory with setup.sh and a PATH holding only the basic tools plus an optional fake `docker`. */
	function prepare(assist: boolean, fakeDocker?: string): { dir: string; bin: string } {
		const dir = join(root, 'out');
		const bin = join(root, 'bin');
		mkdirSync(dir);
		mkdirSync(bin);
		writeFileSync(join(dir, 'setup.sh'), generate(assist));
		for (const tool of ['uname', 'dirname', 'printf', 'cat']) {
			const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
			symlinkSync(found, join(bin, tool));
		}
		if (fakeDocker !== undefined) {
			writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${fakeDocker}\n`);
			chmodSync(join(bin, 'docker'), 0o755);
		}
		return { dir, bin };
	}

	function run(dir: string, bin: string) {
		return spawnSync('/bin/sh', [join(dir, 'setup.sh')], { env: { PATH: bin }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
	}

	(isPosix ? test : test.skip)('without Docker and non-interactively: no consent, nothing changed, non-zero exit', () => {
		for (const assist of [false, true]) {
			const { dir, bin } = prepare(assist);
			const before = readdirSync(dir);
			const result = run(dir, bin);
			assert.ok(result.status === 2 || result.status === 3, `exit ${result.status}`);
			assert.deepStrictEqual(readdirSync(dir), before);
			assert.ok(result.stdout.includes('docker'), result.stdout);
			rmSync(dir, { recursive: true });
			rmSync(bin, { recursive: true });
		}
	});

	(isPosix ? test : test.skip)('with Docker: refuses without .env, then starts the adopted Compose file', () => {
		const { dir, bin } = prepare(true, `if [ "$1" = compose ] && [ "$2" = -f ]; then echo "$*" >> "${join(root, 'calls')}"; fi\nexit 0`);
		const missing = run(dir, bin);
		assert.strictEqual(missing.status, 5);
		assert.ok(missing.stderr.includes('.env.example'));

		writeFileSync(join(dir, '.env'), 'DB_PASSWORD=x\n');
		const started = run(dir, bin);
		assert.strictEqual(started.status, 0, started.stderr);
		assert.strictEqual(readFileSync(join(root, 'calls'), 'utf8').trim(), 'compose -f compose-001.yml up -d');
		assert.strictEqual(readFileSync(join(dir, '.env'), 'utf8'), 'DB_PASSWORD=x\n', '.env is never overwritten');
	});

	(isPosix ? test : test.skip)('a failing `docker compose up` exits non-zero with its own code', () => {
		const { dir, bin } = prepare(false, `[ "$1" = compose ] && [ "$2" = -f ] && exit 1\nexit 0`);
		writeFileSync(join(dir, '.env'), '');
		assert.strictEqual(run(dir, bin).status, 4);
	});
});
