/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Deploy Template Registry read, Deploy Selection, Docker Scaffold and Deploy Validation (build.deploy-projection)
 *  Specification SSOT: docs/primitive-app-editor/Deploy Configuration.md (3. Definition Schema, 5. Docker Projection / Scaffold, 7.1 Build / Deploy Validation)
 *--------------------------------------------------------------------------------------------*/

import { parse as parseYaml, YamlNode, YamlParseError } from '../../../../base/common/yaml.js';
import { ApplicationOutputProjection, IApplicationOutput, projectApplicationOutput } from './applicationOutput.js';
import { BuildValidationError, BuildValidationStage, IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT } from './buildValidation.js';
import { IPostgresqlProjection, postgresqlApplicationOutputProjection, POSTGRESQL_INIT_FILE, POSTGRESQL_SEED_FILE } from './postgresqlProjection.js';
import { IWebProgramProjection, webProgramApplicationOutputProjection, WEB_PROGRAM_DEFINITION_FILE } from './webProgramProjection.js';

/**
 * ```text
 * Application Output + Deploy Template (Editor Template Registry) + Deploy Selection
 *        -> Validate -> Scaffold (Dockerfile / compose.yml / .env.example, never overwriting)
 * ```
 *
 * The Editor-wide Template Registry is the Authority of Deploy Templates; it is separate from the
 * Application Registry / `project.sqlite` / project `config/`. This module only *reads* it (the
 * caller supplies the user-registered Template documents; where they live is the Registrar's
 * `build.deploy-template-registrar`). Generated files are Derived Output: nothing is written to
 * Authoring Data, nothing is executed, and the Template - not the Selection - owns every value.
 */

// #region Deploy Template Definition Schema (3.1)

export const enum DeployProvider {
	DockerCompose = 'docker_compose',
}

export const enum DeployHost {
	Linux = 'linux',
	WindowsWsl2 = 'windows_wsl2',
	MacOs = 'macos',
}

const deployHosts: readonly string[] = ['linux', 'windows_wsl2', 'macos'];

export interface IDeployTemplate {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly provider: DeployProvider;
	readonly supported_hosts: readonly DeployHost[];
	readonly compatible_build_targets: readonly string[];
	readonly services: {
		readonly api: IDeployWebService;
		readonly ui: IDeployWebService;
		readonly database: {
			readonly image: string;
			readonly data_volume: string;
			readonly password_env: string;
		};
	};
	readonly capabilities: {
		readonly compose: true;
		readonly prerequisites_check: boolean;
		readonly installer_assistance: boolean;
		readonly setup_script: boolean;
	};
}

export interface IDeployWebService {
	readonly dockerfile: 'generated';
	readonly internal_port: number;
	readonly host_port: number;
}

export const enum DeployTemplateOrigin {
	Builtin = 'builtin',
	User = 'user',
}

export class DeployValidationError extends Error {
	constructor(readonly path: string, message: string) {
		super(`Primitive App Editor deploy (${path}): ${message}`);
		this.name = 'DeployValidationError';
	}
}

function fail(path: string, message: string): never {
	throw new DeployValidationError(path, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const TEMPLATE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const DATA_VOLUME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const PASSWORD_ENV = /^[A-Z][A-Z0-9_]{0,62}$/;
const IMAGE_TAG = /^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/;

/** Rejects every key outside `allowed` (at every level; unknown keys are never ignored or kept). */
function requireKeys(path: string, value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	for (const key of Object.keys(value)) {
		if (!required.includes(key) && !optional.includes(key)) {
			fail(`${path}.${key}`, 'unknown key');
		}
	}
	for (const key of required) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) {
			fail(`${path}.${key}`, 'required key is missing');
		}
	}
}

function requireRecord(path: string, value: unknown): Record<string, unknown> {
	if (!isPlainRecord(value)) {
		fail(path, 'must be a mapping');
	}
	return value;
}

function requireString(path: string, value: unknown): string {
	if (typeof value !== 'string') {
		fail(path, 'must be a string');
	}
	return value;
}

function requirePort(path: string, value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
		fail(path, 'must be an integer in 1..65535');
	}
	return value;
}

function requireUniqueStrings(path: string, value: unknown, allowed?: readonly string[]): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail(path, 'must be a non-empty list');
	}
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string' || item.length === 0) {
			fail(path, 'must contain non-empty strings');
		}
		if (allowed && !allowed.includes(item)) {
			fail(path, `'${item}' is not one of ${allowed.join(' / ')}`);
		}
		if (seen.has(item)) {
			fail(path, `'${item}' is listed more than once`);
		}
		seen.add(item);
	}
	return Object.freeze([...value as string[]]);
}

function requireWebService(path: string, value: unknown): IDeployWebService {
	const service = requireRecord(path, value);
	requireKeys(path, service, ['dockerfile', 'internal_port', 'host_port']);
	if (service.dockerfile !== 'generated') {
		fail(`${path}.dockerfile`, `must be 'generated'`);
	}
	return Object.freeze({
		dockerfile: 'generated',
		internal_port: requirePort(`${path}.internal_port`, service.internal_port),
		host_port: requirePort(`${path}.host_port`, service.host_port),
	});
}

function optionalCapability(path: string, value: unknown): boolean {
	if (value === undefined) {
		return false;
	}
	if (typeof value !== 'boolean') {
		fail(path, 'must be bool');
	}
	return value;
}

/**
 * Template self-consistency (3.3): the 3.1 key definitions, types and unknown-key boundary, no port
 * collision and a valid `password_env`. Returns the normalized Template; the input is not modified.
 * Built-in and user-defined Templates are validated by this same function.
 */
export function createDeployTemplate(input: unknown): IDeployTemplate {
	const root = requireRecord('', input);
	requireKeys('', root, ['deploy_template']);
	const path = 'deploy_template';
	const template = requireRecord(path, root.deploy_template);
	requireKeys(path, template, ['id', 'label', 'provider', 'supported_hosts', 'compatible_build_targets', 'services', 'capabilities'], ['description']);

	const id = requireString(`${path}.id`, template.id);
	if (!TEMPLATE_ID.test(id)) {
		fail(`${path}.id`, `'${id}' does not match ${TEMPLATE_ID.source}`);
	}
	const label = requireString(`${path}.label`, template.label);
	if (label.length < 1 || label.length > 128 || /[\r\n]/.test(label)) {
		fail(`${path}.label`, 'must be 1..128 characters without line breaks');
	}
	const description = template.description === undefined ? '' : requireString(`${path}.description`, template.description);
	if (template.provider !== 'docker_compose') {
		fail(`${path}.provider`, `must be 'docker_compose'`);
	}
	const supportedHosts = requireUniqueStrings(`${path}.supported_hosts`, template.supported_hosts, deployHosts) as readonly DeployHost[];
	const buildTargets = requireUniqueStrings(`${path}.compatible_build_targets`, template.compatible_build_targets);

	const services = requireRecord(`${path}.services`, template.services);
	requireKeys(`${path}.services`, services, ['api', 'ui', 'database']);
	const api = requireWebService(`${path}.services.api`, services.api);
	const ui = requireWebService(`${path}.services.ui`, services.ui);
	if (api.internal_port === ui.internal_port) {
		fail(`${path}.services`, 'api and ui must use different internal_port values');
	}
	if (api.host_port === ui.host_port) {
		fail(`${path}.services`, 'api and ui must use different host_port values');
	}
	const database = requireRecord(`${path}.services.database`, services.database);
	requireKeys(`${path}.services.database`, database, ['image', 'data_volume', 'password_env']);
	const image = requireString(`${path}.services.database.image`, database.image);
	if (!IMAGE_TAG.test(image) && !IMAGE_DIGEST.test(image)) {
		fail(`${path}.services.database.image`, `'${image}' must be '<name>:<tag>' or '<name>@sha256:<64 hex>'`);
	}
	if (IMAGE_TAG.test(image) && image.endsWith(':latest')) {
		fail(`${path}.services.database.image`, `tag 'latest' is not reproducible`);
	}
	const dataVolume = requireString(`${path}.services.database.data_volume`, database.data_volume);
	if (!DATA_VOLUME.test(dataVolume)) {
		fail(`${path}.services.database.data_volume`, `'${dataVolume}' does not match ${DATA_VOLUME.source}`);
	}
	const passwordEnv = requireString(`${path}.services.database.password_env`, database.password_env);
	if (!PASSWORD_ENV.test(passwordEnv)) {
		fail(`${path}.services.database.password_env`, `'${passwordEnv}' does not match ${PASSWORD_ENV.source}`);
	}

	const capabilities = requireRecord(`${path}.capabilities`, template.capabilities);
	requireKeys(`${path}.capabilities`, capabilities, ['compose'], ['prerequisites_check', 'installer_assistance', 'setup_script']);
	if (capabilities.compose !== true) {
		fail(`${path}.capabilities.compose`, 'must be true');
	}
	const prerequisitesCheck = optionalCapability(`${path}.capabilities.prerequisites_check`, capabilities.prerequisites_check);
	const installerAssistance = optionalCapability(`${path}.capabilities.installer_assistance`, capabilities.installer_assistance);
	const setupScript = optionalCapability(`${path}.capabilities.setup_script`, capabilities.setup_script);
	if (installerAssistance && !prerequisitesCheck) {
		fail(`${path}.capabilities.installer_assistance`, 'requires prerequisites_check: true');
	}

	return Object.freeze({
		id,
		label,
		description,
		provider: DeployProvider.DockerCompose,
		supported_hosts: supportedHosts,
		compatible_build_targets: buildTargets,
		services: Object.freeze({
			api,
			ui,
			database: Object.freeze({ image, data_volume: dataVolume, password_env: passwordEnv }),
		}),
		capabilities: Object.freeze({ compose: true, prerequisites_check: prerequisitesCheck, installer_assistance: installerAssistance, setup_script: setupScript }),
	} as IDeployTemplate);
}

// #endregion

// #region YAML document boundary

function nodeToValue(node: YamlNode): unknown {
	switch (node.type) {
		case 'map': {
			const result: Record<string, unknown> = {};
			for (const { key, value } of node.properties) {
				result[key.value] = nodeToValue(value);
			}
			return result;
		}
		case 'sequence':
			return node.items.map(nodeToValue);
		case 'scalar': {
			if (node.format !== 'none') {
				return node.value;
			}
			if (node.value === 'true') {
				return true;
			}
			if (node.value === 'false') {
				return false;
			}
			if (/^-?\d+$/.test(node.value)) {
				return Number(node.value);
			}
			return node.value;
		}
	}
}

/** Rejects multiple documents, anchors / aliases / merge keys and explicit tags; comments are allowed. */
function checkDocumentBoundary(text: string): void {
	let content = false;
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}
		if (trimmed === '---' || trimmed.startsWith('--- ') || trimmed === '...') {
			if (content || trimmed === '...') {
				fail(`line ${index + 1}`, 'multiple YAML documents are not allowed');
			}
			continue;
		}
		content = true;
		if (/(^|[\s{,\-])<<\s*:/.test(trimmed)) {
			fail(`line ${index + 1}`, `merge key '<<' is not allowed`);
		}
		let quote: string | undefined;
		let previous = ' ';
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (quote) {
				if (char === '\\' && quote === '"') {
					i++;
				} else if (char === quote) {
					quote = undefined;
				}
			} else if ((char === '"' || char === '\'') && /[\s:\-\[{,]/.test(previous)) {
				quote = char;
			} else if (char === '#' && /\s/.test(previous)) {
				break;
			} else if ((char === '&' || char === '*' || char === '!') && /[\s:\-\[{,]/.test(previous)) {
				fail(`line ${index + 1}`, `'${char}' (anchor / alias / tag) is not allowed`);
			}
			previous = char;
		}
	}
}

/** Parses a Deploy Template document (UTF-8 YAML 1.2 single document) and validates it with {@link createDeployTemplate}. */
export function parseDeployTemplate(text: string): IDeployTemplate {
	checkDocumentBoundary(text);
	const errors: YamlParseError[] = [];
	const node = parseYaml(text, errors);
	if (errors.length > 0 || !node) {
		fail('document', errors.length > 0 ? errors.map(error => error.message).join('; ') : 'empty document');
	}
	return createDeployTemplate(nodeToValue(node));
}

function scalar(value: string): string {
	return /^[A-Za-z0-9_-]+$/.test(value) && value !== 'true' && value !== 'false' ? value : JSON.stringify(value);
}

/**
 * Deterministic writer: the 3.1 key order, 2 space indent, optional keys only when they differ from
 * the default. The same Definition always yields the same bytes; comments are not preserved.
 */
export function serializeDeployTemplate(template: IDeployTemplate): string {
	const lines: string[] = [
		'deploy_template:',
		`  id: ${scalar(template.id)}`,
		`  label: ${JSON.stringify(template.label)}`,
	];
	if (template.description !== '') {
		lines.push(`  description: ${JSON.stringify(template.description)}`);
	}
	lines.push(
		`  provider: ${template.provider}`,
		`  supported_hosts: [${template.supported_hosts.join(', ')}]`,
		`  compatible_build_targets: [${template.compatible_build_targets.map(target => JSON.stringify(target)).join(', ')}]`,
		'  services:',
	);
	for (const name of ['api', 'ui'] as const) {
		const service = template.services[name];
		lines.push(`    ${name}:`, `      dockerfile: ${service.dockerfile}`, `      internal_port: ${service.internal_port}`, `      host_port: ${service.host_port}`);
	}
	const { database } = template.services;
	lines.push(
		'    database:',
		`      image: ${JSON.stringify(database.image)}`,
		`      data_volume: ${scalar(database.data_volume)}`,
		`      password_env: ${scalar(database.password_env)}`,
		'  capabilities:',
		'    compose: true',
	);
	for (const key of ['prerequisites_check', 'installer_assistance', 'setup_script'] as const) {
		if (template.capabilities[key]) {
			lines.push(`    ${key}: true`);
		}
	}
	return `${lines.join('\n')}\n`;
}

// #endregion

// #region Editor-wide Template Registry (read)

/** The built-in Template (`docker-compose-default`): ASP.NET Core API + Next.js UI + PostgreSQL. */
export const BUILTIN_DEPLOY_TEMPLATE_ID = 'docker-compose-default';

/** Image / dependency versions are pinned for reproducibility (5); they match the generated `net8.0` API and Next.js 14 UI. */
export const BUILTIN_DEPLOY_TEMPLATE_DOCUMENT = `deploy_template:
  id: docker-compose-default
  label: "Docker Compose (default)"
  description: "ASP.NET Core API + Next.js UI + PostgreSQL"
  provider: docker_compose
  supported_hosts: [linux, windows_wsl2, macos]
  compatible_build_targets: [${JSON.stringify(POSTGRESQL_WEB_APPLICATION_OUTPUT)}]
  services:
    api:
      dockerfile: generated
      internal_port: 8080
      host_port: 8080
    ui:
      dockerfile: generated
      internal_port: 3000
      host_port: 3000
    database:
      image: "postgres:16.4"
      data_volume: application-db
      password_env: DB_PASSWORD
  capabilities:
    compose: true
`;

/** One Registry entry: a Valid Template, or an `Invalid` document listed with its diagnostic (never selectable). */
export interface IDeployTemplateRegistryEntry {
	/** The Template id, or the document's `source` name when no id could be read. */
	readonly id: string;
	readonly origin: DeployTemplateOrigin;
	readonly valid: boolean;
	readonly template?: IDeployTemplate;
	readonly diagnostic?: string;
}

/** A user-registered Template document as the Registry store hands it over. */
export interface IUserDeployTemplateDocument {
	readonly source: string;
	readonly text: string;
}

export interface IDeployTemplateRegistry {
	/** Built-in first, then user-registered in the given order. */
	readonly entries: readonly IDeployTemplateRegistryEntry[];
	/** Exact-match resolution: one entry or undefined ("Template unresolved"). There is no priority between origins. */
	resolve(id: string): IDeployTemplateRegistryEntry | undefined;
	/** Templates a Selection can pick. */
	selectable(): readonly IDeployTemplate[];
}

function readId(text: string): string | undefined {
	return /^\s{2}id:\s*"?([a-z][a-z0-9-]{0,62})"?\s*(#.*)?$/m.exec(text)?.[1];
}

/**
 * Reads the Editor-wide Registry: the built-in Template plus the user-registered documents. Every
 * document gets the same validation; the id is unique across origins and a user Template can never
 * shadow a built-in id (it is listed `Invalid`). Pure: nothing is written.
 */
export function createDeployTemplateRegistry(userDocuments: readonly IUserDeployTemplateDocument[] = []): IDeployTemplateRegistry {
	const entries: IDeployTemplateRegistryEntry[] = [];
	const taken = new Set<string>();
	const add = (origin: DeployTemplateOrigin, source: string, text: string) => {
		try {
			const template = parseDeployTemplate(text);
			if (taken.has(template.id)) {
				fail('deploy_template.id', `'${template.id}' is already registered (built-in ids are reserved; ids are unique)`);
			}
			taken.add(template.id);
			entries.push(Object.freeze({ id: template.id, origin, valid: true, template }));
		} catch (error) {
			entries.push(Object.freeze({ id: readId(text) ?? source, origin, valid: false, diagnostic: error instanceof Error ? error.message : String(error) }));
		}
	};
	add(DeployTemplateOrigin.Builtin, BUILTIN_DEPLOY_TEMPLATE_ID, BUILTIN_DEPLOY_TEMPLATE_DOCUMENT);
	for (const document of userDocuments) {
		add(DeployTemplateOrigin.User, document.source, document.text);
	}
	return Object.freeze({
		entries: Object.freeze(entries),
		resolve: (id: string) => entries.find(entry => entry.valid && entry.id === id) ?? entries.find(entry => entry.id === id),
		selectable: () => entries.flatMap(entry => entry.valid && entry.template ? [entry.template] : []),
	});
}

// #endregion

// #region Deploy Selection (3.2)

/** `build_configuration.deploy`: the Template id and the target host only. */
export interface IDeploySelection {
	readonly template_id: string;
	readonly host: DeployHost;
}

/** Shape of `build_configuration.deploy`. `parameters` (and any other key) is rejected. */
export function createDeploySelection(input: unknown): IDeploySelection {
	const selection = requireRecord('deploy', input);
	requireKeys('deploy', selection, ['template_id', 'host']);
	const templateId = requireString('deploy.template_id', selection.template_id);
	if (!TEMPLATE_ID.test(templateId)) {
		fail('deploy.template_id', `'${templateId}' does not match ${TEMPLATE_ID.source}`);
	}
	const host = requireString('deploy.host', selection.host);
	if (!deployHosts.includes(host)) {
		fail('deploy.host', `'${host}' is not one of ${deployHosts.join(' / ')}`);
	}
	return Object.freeze({ template_id: templateId, host: host as DeployHost });
}

// #endregion

// #region Scaffold file naming (5)

export const DEPLOY_COMPOSE_FILE = 'compose.yml';
export const DEPLOY_ENV_EXAMPLE_FILE = '.env.example';
export const DEPLOY_API_DOCKERFILE = 'api/Dockerfile';
export const DEPLOY_UI_DOCKERFILE = 'ui/Dockerfile';

const MAX_SCAFFOLD_SEQUENCE = 999;

/** Names that count as the same file as `name`: `.yml` and `.yaml` collide. */
function collisionNames(name: string): readonly string[] {
	if (name.endsWith('.yml')) {
		return [name, `${name.slice(0, -4)}.yaml`];
	}
	if (name.endsWith('.yaml')) {
		return [name, `${name.slice(0, -5)}.yml`];
	}
	return [name];
}

/**
 * The unused file name for `name`: `name` itself, else the first free `<base>-NNN<ext>` (001..999)
 * with the sequence before the extension. Existing files are never overwritten, moved or deleted;
 * an exhausted sequence is a diagnostic.
 */
export function chooseScaffoldFileName(name: string, existing: ReadonlySet<string>): string {
	const isFree = (candidate: string) => collisionNames(candidate).every(alias => !existing.has(alias));
	if (isFree(name)) {
		return name;
	}
	const slash = name.lastIndexOf('/');
	const directory = name.slice(0, slash + 1);
	const file = name.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	const base = dot > 0 ? file.slice(0, dot) : file;
	const extension = dot > 0 ? file.slice(dot) : '';
	for (let sequence = 1; sequence <= MAX_SCAFFOLD_SEQUENCE; sequence++) {
		const candidate = `${directory}${base}-${String(sequence).padStart(3, '0')}${extension}`;
		if (isFree(candidate)) {
			return candidate;
		}
	}
	fail('scaffold', `no unused file name left for '${name}' (-001..-${MAX_SCAFFOLD_SEQUENCE} are taken); existing files are left untouched`);
}

// #endregion

// #region Deploy Validation (7.1)

/** Files the Scaffold requires in the Application Output (paths relative to the Output root). */
export const DEPLOY_REQUIRED_OUTPUT_FILES: readonly string[] = Object.freeze([
	WEB_PROGRAM_DEFINITION_FILE,
	POSTGRESQL_INIT_FILE,
	'api/PrimitiveApplication.Api.csproj',
	'ui/package.json',
]);

/**
 * Selection + Template + Application Output checks of 7.1: the Template resolves and is Valid, the
 * Build Target and `host` are declared by it (never guessed), and the required API / UI / SQL files
 * exist. Returns the Template.
 */
export function validateDeploy(registry: IDeployTemplateRegistry, selection: IDeploySelection, buildTarget: string, outputFiles: readonly string[]): IDeployTemplate {
	const entry = registry.resolve(selection.template_id);
	if (!entry) {
		fail('deploy.template_id', `Template '${selection.template_id}' is unresolved (not in the Editor Template Registry)`);
	}
	if (!entry.valid || !entry.template) {
		fail('deploy.template_id', `Template '${selection.template_id}' is Invalid: ${entry.diagnostic ?? 'unknown'}`);
	}
	const template = entry.template;
	if (!template.compatible_build_targets.includes(buildTarget)) {
		fail('deploy.template_id', `Template '${template.id}' does not support build_target '${buildTarget}'`);
	}
	if (!template.supported_hosts.includes(selection.host)) {
		fail('deploy.host', `Template '${template.id}' does not support host '${selection.host}'`);
	}
	const present = new Set(outputFiles);
	for (const required of DEPLOY_REQUIRED_OUTPUT_FILES) {
		if (!present.has(required)) {
			fail('output', `required Application Output file '${required}' is missing`);
		}
	}
	return template;
}

// #endregion

// #region Scaffold

export interface IDeployScaffoldFile {
	/** Adopted path relative to the Application Output root. */
	readonly path: string;
	readonly content: string;
	/** The Template's name for this file; differs from `path` when an existing file forced a sequence. */
	readonly requested: string;
}

export interface IDeployScaffold {
	readonly template_id: string;
	readonly host: DeployHost;
	/** Sorted by path. Includes `api/Dockerfile`, `ui/Dockerfile`, `compose.yml` and `.env.example` (adopted names). */
	readonly files: readonly IDeployScaffoldFile[];
}

const API_ASSEMBLY = 'PrimitiveApplication.Api.dll';
const API_CSPROJ = 'api/PrimitiveApplication.Api.csproj';

function apiDockerfile(template: IDeployTemplate): string {
	const port = template.services.api.internal_port;
	return `# Generated by Primitive App Editor. Build context: the Application Output root.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ${WEB_PROGRAM_DEFINITION_FILE} ./
COPY api/ api/
RUN dotnet publish ${API_CSPROJ} -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish ./
ENV ASPNETCORE_URLS=http://+:${port}
EXPOSE ${port}
ENTRYPOINT ["dotnet", "${API_ASSEMBLY}"]
`;
}

function uiDockerfile(template: IDeployTemplate): string {
	const port = template.services.ui.internal_port;
	return `# Generated by Primitive App Editor. Build context: ui/.
FROM node:20.15-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
RUN npm run build

FROM node:20.15-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE ${port}
CMD ["npm", "run", "start", "--", "-p", "${port}"]
`;
}

function envExample(template: IDeployTemplate, composeFile: string): string {
	return `# Generated by Primitive App Editor. Copy to '.env' and set a real value; never commit '.env'.
# Start with: docker compose -f ${composeFile} up -d
${template.services.database.password_env}=<set-a-database-password>
`;
}

function composeYaml(template: IDeployTemplate, apiDockerfilePath: string, uiDockerfilePath: string, envFile: string, sqlFiles: readonly string[]): string {
	const { api, ui, database } = template.services;
	const password = '${' + database.password_env + ':?set ' + database.password_env + ' in .env (see ' + envFile + ')}';
	const connection = `Host=database;Database=application;Username=application;Password=\${${database.password_env}}`;
	const lines = [
		'# Generated by Primitive App Editor from the Deploy Template. Edit freely; re-scaffolding never overwrites this file.',
		`# Start with: docker compose -f <this file> up -d  (copy ${envFile} to .env first)`,
		'services:',
		'  database:',
		`    image: ${JSON.stringify(database.image)}`,
		'    environment:',
		'      POSTGRES_DB: application',
		'      POSTGRES_USER: application',
		`      POSTGRES_PASSWORD: ${JSON.stringify(password)}`,
		'    volumes:',
		`      - ${database.data_volume}:/var/lib/postgresql/data`,
		...sqlFiles.map(file => `      - ./${file}:/docker-entrypoint-initdb.d/${file}:ro`),
		'    healthcheck:',
		'      test: ["CMD-SHELL", "pg_isready -U application -d application"]',
		'      interval: 5s',
		'      timeout: 5s',
		'      retries: 12',
		'  api:',
		'    build:',
		'      context: .',
		`      dockerfile: ${apiDockerfilePath}`,
		'    environment:',
		`      ConnectionStrings__Application: ${JSON.stringify(connection)}`,
		`      ASPNETCORE_URLS: "http://+:${api.internal_port}"`,
		'    depends_on:',
		'      database:',
		'        condition: service_healthy',
		'    ports:',
		`      - "${api.host_port}:${api.internal_port}"`,
		'  ui:',
		'    build:',
		'      context: ./ui',
		`      dockerfile: ${uiDockerfilePath.slice('ui/'.length)}`,
		'      args:',
		`        NEXT_PUBLIC_API_BASE: "http://localhost:${api.host_port}"`,
		'    environment:',
		`      API_BASE_URL: "http://api:${api.internal_port}"`,
		`      NEXT_PUBLIC_API_BASE: "http://localhost:${api.host_port}"`,
		'    depends_on:',
		'      - api',
		'    ports:',
		`      - "${ui.host_port}:${ui.internal_port}"`,
		'volumes:',
		`  ${database.data_volume}:`,
	];
	return `${lines.join('\n')}\n`;
}

/**
 * Pure Scaffold: the same Template + Selection + Application Output file set + existing files yield
 * byte-identical files. Names that already exist get an unused `-NNN` sequence and every file that
 * refers to another uses the *adopted* name. Nothing is executed or written.
 */
export function createDeployScaffold(template: IDeployTemplate, selection: IDeploySelection, outputFiles: readonly string[], existingFiles: readonly string[]): IDeployScaffold {
	const existing = new Set([...existingFiles, ...outputFiles]);
	const apiPath = chooseScaffoldFileName(DEPLOY_API_DOCKERFILE, existing);
	const uiPath = chooseScaffoldFileName(DEPLOY_UI_DOCKERFILE, existing);
	const composePath = chooseScaffoldFileName(DEPLOY_COMPOSE_FILE, existing);
	const envPath = chooseScaffoldFileName(DEPLOY_ENV_EXAMPLE_FILE, existing);
	const sqlFiles = [POSTGRESQL_INIT_FILE, POSTGRESQL_SEED_FILE].filter(file => outputFiles.includes(file));
	const files: IDeployScaffoldFile[] = [
		{ path: apiPath, requested: DEPLOY_API_DOCKERFILE, content: apiDockerfile(template) },
		{ path: uiPath, requested: DEPLOY_UI_DOCKERFILE, content: uiDockerfile(template) },
		{ path: composePath, requested: DEPLOY_COMPOSE_FILE, content: composeYaml(template, apiPath, uiPath, envPath, sqlFiles) },
		{ path: envPath, requested: DEPLOY_ENV_EXAMPLE_FILE, content: envExample(template, composePath) },
	];
	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return Object.freeze({ template_id: template.id, host: selection.host, files: Object.freeze(files.map(file => Object.freeze(file))) });
}

// #endregion

// #region Integration

export interface IDeployProjection {
	readonly webProgram: IWebProgramProjection;
	readonly postgresql: IPostgresqlProjection;
}

const deployOutputProjection: ApplicationOutputProjection<IDeployProjection> = (output: IApplicationOutput) => Object.freeze({
	webProgram: webProgramApplicationOutputProjection(output),
	postgresql: postgresqlApplicationOutputProjection(output),
});

/**
 * `Authoring Data + Build Configuration (with its `deploy` Selection) -> Build Validation ->
 * Application Output -> Deploy Validation -> Scaffold`. `existingFiles` lists the files already
 * present in the output directory (relative); the Scaffold never overwrites them. Failures raise a
 * {@link BuildValidationError} (Build Configuration stage) or {@link DeployValidationError}.
 */
export function projectDeployScaffold(authoring: IBuildAuthoringData, input: unknown, registry: IDeployTemplateRegistry, existingFiles: readonly string[] = []): {
	readonly output: IApplicationOutput;
	readonly result: IDeployProjection;
	readonly scaffold: IDeployScaffold;
} {
	if (!isPlainRecord(input) || input.deploy === undefined) {
		throw new BuildValidationError(BuildValidationStage.BuildConfiguration, 'build_configuration.deploy (template_id / host) is required for Deploy');
	}
	const selection = createDeploySelection(input.deploy);
	const { output, result } = projectApplicationOutput(authoring, input, new Map([[POSTGRESQL_WEB_APPLICATION_OUTPUT, deployOutputProjection]]));
	const outputFiles = [...result.webProgram.files, ...result.postgresql.files].map(file => file.path);
	const template = validateDeploy(registry, selection, output.build_target, outputFiles);
	return Object.freeze({ output, result, scaffold: createDeployScaffold(template, selection, outputFiles, existingFiles) });
}

// #endregion
