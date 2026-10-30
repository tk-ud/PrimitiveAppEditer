/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Deploy Template Service and Template Editor model (build.deploy-template-registrar)
 *  Specification SSOT: docs/primitive-app-editor/Deploy Configuration.md (3.1 Definition Schema, 3.3 Editor Template Registry, 4 Template Registrar)
 *--------------------------------------------------------------------------------------------*/

import {
	BUILTIN_DEPLOY_TEMPLATE_ID, createDeployTemplate, createDeployTemplateRegistry, DeployHost, DeployTemplateOrigin, DeployValidationError, IDeployTemplate,
	IDeployTemplateRegistry, IDeployTemplateRegistryEntry, IUserDeployTemplateDocument, parseDeployTemplate, readDeployTemplateDocumentId, serializeDeployTemplate
} from './deployProjection.js';

/**
 * ```text
 * Deploy Template Editor / Side Bar
 *        -> DeployTemplateService (create / update / duplicate / delete)
 *        -> validate (Template self-consistency, 3.3) -> IDeployTemplateStore (atomic write)
 * ```
 *
 * The Editor-wide Template Registry is the only Authority of Deploy Templates. Every Mutation goes
 * through this Service and only validated content is written; nothing here touches the Application
 * Registry, `project.sqlite` or the project `config/`, and the Build Selection is never rewritten
 * (a Template edit / delete leaves a referencing Selection "unresolved" or Invalid; already
 * scaffolded files are not affected).
 */

/** The Editor-wide storage of user-defined Template documents. The caller of the Service decides where they physically live. */
export interface IDeployTemplateStore {
	/** Every stored document; `source` is the stable storage name (the Template id for documents the Service wrote). */
	list(): Promise<readonly IUserDeployTemplateDocument[]>;
	/** Writes the document of `source` atomically: a reader sees the previous or the new text, never a partial one. */
	write(source: string, text: string): Promise<void>;
	/** Removes the document of `source`; removing a missing document is not an error. */
	delete(source: string): Promise<void>;
}

/** An in-memory store (tests, and the Service's fallback when nothing else is wired). */
export class InMemoryDeployTemplateStore implements IDeployTemplateStore {

	private readonly documents = new Map<string, string>();

	constructor(initial: readonly IUserDeployTemplateDocument[] = []) {
		for (const document of initial) {
			this.documents.set(document.source, document.text);
		}
	}

	async list(): Promise<readonly IUserDeployTemplateDocument[]> {
		return [...this.documents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([source, text]) => ({ source, text }));
	}

	async write(source: string, text: string): Promise<void> {
		this.documents.set(source, text);
	}

	async delete(source: string): Promise<void> {
		this.documents.delete(source);
	}
}

/** A delete of a Template a Selection references needs the caller's confirmation. */
export class DeployTemplateConfirmationRequired extends Error {
	constructor(readonly templateId: string) {
		super(`Primitive App Editor deploy (${templateId}): the Template is referenced by the current Selection; deleting it makes the Selection 'Template unresolved' (confirmation required)`);
		this.name = 'DeployTemplateConfirmationRequired';
	}
}

function fail(path: string, message: string): never {
	throw new DeployValidationError(path, message);
}

export class DeployTemplateService {

	private documents: readonly IUserDeployTemplateDocument[] = [];
	private current: IDeployTemplateRegistry = createDeployTemplateRegistry();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<() => void>();

	/**
	 * @param isReferenced whether the current Build Selection points at the Template id (deleting it then needs confirmation)
	 */
	constructor(private readonly store: IDeployTemplateStore = new InMemoryDeployTemplateStore(), private readonly isReferenced: (templateId: string) => boolean = () => false) { }

	/** The Registry as of the last load / Mutation. Replaced (never mutated) on change. */
	get registry(): IDeployTemplateRegistry {
		return this.current;
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Reads the stored documents into the Registry. */
	load(): Promise<void> {
		return this.serialize(async () => {
			this.apply(await this.store.list());
		});
	}

	/**
	 * Registers a new user Template. `body` is the content of `deploy_template` (3.1). The id must be new
	 * (built-in ids are reserved; a user Template never shadows one).
	 */
	create(body: unknown): Promise<IDeployTemplate> {
		return this.serialize(async () => {
			const template = this.validate(body);
			if (this.current.entries.some(entry => entry.id === template.id) || this.documents.some(document => document.source === template.id)) {
				fail('deploy_template.id', `'${template.id}' is already registered (built-in ids are reserved; ids are unique)`);
			}
			await this.commit(template.id, template);
			return template;
		});
	}

	/** Replaces the user Template `id`. The id is immutable (a new id is a duplicate); built-in Templates are read-only. */
	update(id: string, body: unknown): Promise<IDeployTemplate> {
		return this.serialize(async () => {
			const source = this.userSource(id);
			const template = this.validate(body);
			if (template.id !== id) {
				fail('deploy_template.id', `the id of '${id}' cannot be changed; duplicate the Template to create one with a new id`);
			}
			if (id === BUILTIN_DEPLOY_TEMPLATE_ID) {
				fail('deploy_template.id', `'${id}' is a reserved built-in id`);
			}
			await this.commit(source, template);
			return template;
		});
	}

	/** Creates the user Template `newId` from any Valid Template (built-in or user). */
	duplicate(sourceId: string, newId: string, label?: string): Promise<IDeployTemplate> {
		return this.serialize(async () => {
			const entry = this.current.entries.find(candidate => candidate.valid && candidate.id === sourceId);
			if (!entry?.template) {
				fail('deploy_template.id', `Template '${sourceId}' is not a Valid Template in the Registry`);
			}
			const duplicated = this.validate({ ...templateBody(entry.template), id: newId, label: label ?? duplicateLabel(entry.template.label) });
			if (this.current.entries.some(candidate => candidate.id === duplicated.id) || this.documents.some(document => document.source === duplicated.id)) {
				fail('deploy_template.id', `'${duplicated.id}' is already registered (built-in ids are reserved; ids are unique)`);
			}
			await this.commit(duplicated.id, duplicated);
			return duplicated;
		});
	}

	/**
	 * Deletes the user Template `id` (also an Invalid one). A Template the current Selection references is
	 * deleted only with `confirmed`; the Selection itself is never rewritten.
	 */
	delete(id: string, options: { readonly confirmed?: boolean } = {}): Promise<void> {
		return this.serialize(async () => {
			const source = this.userSource(id);
			if (this.isReferenced(id) && !options.confirmed) {
				throw new DeployTemplateConfirmationRequired(id);
			}
			await this.store.delete(source);
			this.apply(this.documents.filter(document => document.source !== source));
		});
	}

	private userSource(id: string): string {
		const entry = this.current.entries.find(candidate => candidate.origin === DeployTemplateOrigin.User && candidate.id === id);
		if (!entry) {
			if (id === BUILTIN_DEPLOY_TEMPLATE_ID) {
				fail('deploy_template.id', `'${id}' is a built-in Template and is read-only; duplicate it to change it`);
			}
			fail('deploy_template.id', `Template '${id}' is not registered`);
		}
		const document = this.documents.find(candidate => candidate.source === id || readDeployTemplateDocumentId(candidate.text) === id);
		if (!document) {
			fail('deploy_template.id', `Template '${id}' has no stored document`);
		}
		return document.source;
	}

	/** Validates the content of `deploy_template` with the same function that validates every Registry document. */
	private validate(body: unknown): IDeployTemplate {
		return createDeployTemplate({ deploy_template: body });
	}

	/** Writes the canonical document (validated again from the written text) and reloads the Registry. */
	private async commit(source: string, template: IDeployTemplate): Promise<void> {
		const text = serializeDeployTemplate(template);
		parseDeployTemplate(text);
		await this.store.write(source, text);
		this.apply([...this.documents.filter(document => document.source !== source), { source, text }]);
	}

	private apply(documents: readonly IUserDeployTemplateDocument[]): void {
		this.documents = documents;
		this.current = createDeployTemplateRegistry(documents);
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	/** One Mutation at a time; a failed one does not block the next and leaves the Registry as it was. */
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}
}

function duplicateLabel(label: string): string {
	const suffix = ' (copy)';
	return `${label.slice(0, 128 - suffix.length)}${suffix}`;
}

/** The content of `deploy_template` of a Template (the Editor's draft starts from this). */
export function templateBody(template: IDeployTemplate): Record<string, unknown> {
	const capabilities: Record<string, boolean> = { compose: true };
	for (const key of ['prerequisites_check', 'installer_assistance', 'setup_script'] as const) {
		if (template.capabilities[key]) {
			capabilities[key] = true;
		}
	}
	const body: Record<string, unknown> = {
		id: template.id,
		label: template.label,
		provider: template.provider,
		supported_hosts: [...template.supported_hosts],
		compatible_build_targets: [...template.compatible_build_targets],
		services: {
			api: { ...template.services.api },
			ui: { ...template.services.ui },
			database: { ...template.services.database },
		},
		capabilities,
	};
	if (template.description !== '') {
		body.description = template.description;
	}
	return body;
}

// #region Deploy Template Editor model

/** The Editor Area tab uuid that opens the Editor on a blank new Template. */
export const NEW_DEPLOY_TEMPLATE_TAB = '00000000-0000-0000-0000-000000000003';

/** 128 bit FNV-1a style digest (four lanes) of `text`, formatted as an RFC 4122 v4-shaped UUID. */
function digestUuid(text: string): string {
	const lanes = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x9e3779b9];
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		for (let lane = 0; lane < lanes.length; lane++) {
			lanes[lane] = Math.imul((lanes[lane] ^ (code + lane)) >>> 0, 0x01000193 + 2 * lane) >>> 0;
		}
	}
	const hex = lanes.map(lane => lane.toString(16).padStart(8, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The Editor Area tab uuid of one Registry entry. Tab identity is a UUID, so it is derived deterministically from
 * `<origin>:<id>` (the origin keeps an Invalid user document apart from a built-in id); the Editor resolves it back
 * with {@link findDeployTemplateTabEntry}.
 */
export function deployTemplateTabUuid(origin: DeployTemplateOrigin, id: string): string {
	return digestUuid(`${origin}:${id}`);
}

/** The Registry entry the tab uuid names; `undefined` for {@link NEW_DEPLOY_TEMPLATE_TAB} or a Template that is gone. */
export function findDeployTemplateTabEntry(registry: IDeployTemplateRegistry, uuid: string): IDeployTemplateRegistryEntry | undefined {
	return registry.entries.find(entry => deployTemplateTabUuid(entry.origin, entry.id) === uuid);
}

/** The Control kinds the Editor derives from the 3.1 Schema. */
export const enum DeployTemplateControlKind {
	Text = 'text',
	Number = 'number',
	Select = 'select',
	/** A set of values chosen from `options` (checkbox list). */
	MultiSelect = 'multi-select',
	Checkbox = 'checkbox',
	/** Fixed by the Schema (for example `provider` / `dockerfile` have one value, `compose` is `true`). */
	Fixed = 'fixed',
}

export interface IDeployTemplateControl {
	/** The Schema path (also the diagnostic path and the `data-pae-item` of the Control). */
	readonly path: string;
	readonly label: string;
	readonly kind: DeployTemplateControlKind;
	readonly value: string | number | boolean | readonly string[];
	/** Choices of a Select / MultiSelect Control. */
	readonly options?: readonly string[];
	readonly required: boolean;
	/** Why the Control cannot be changed (built-in Template, immutable id, Schema constant); `undefined` when editable. */
	readonly readonlyReason?: string;
}

const hostOptions: readonly string[] = [DeployHost.Linux, DeployHost.WindowsWsl2, DeployHost.MacOs];

type ControlSpec = Omit<IDeployTemplateControl, 'value' | 'readonlyReason'>;

/** The Schema (3.1) as Control specifications; the Editor shows no input the Schema does not define. */
function controlSpecs(buildTargets: readonly string[]): readonly ControlSpec[] {
	const text = (path: string, label: string, required = true): ControlSpec => ({ path, label, kind: DeployTemplateControlKind.Text, required });
	const port = (path: string, label: string): ControlSpec => ({ path, label, kind: DeployTemplateControlKind.Number, required: true });
	const flag = (path: string, label: string): ControlSpec => ({ path, label, kind: DeployTemplateControlKind.Checkbox, required: false });
	return [
		text('id', 'id'),
		text('label', 'label'),
		text('description', 'description', false),
		{ path: 'provider', label: 'provider', kind: DeployTemplateControlKind.Fixed, required: true },
		{ path: 'supported_hosts', label: 'supported_hosts', kind: DeployTemplateControlKind.MultiSelect, options: hostOptions, required: true },
		{ path: 'compatible_build_targets', label: 'compatible_build_targets', kind: DeployTemplateControlKind.MultiSelect, options: buildTargets, required: true },
		{ path: 'services.api.dockerfile', label: 'services.api.dockerfile', kind: DeployTemplateControlKind.Fixed, required: true },
		port('services.api.internal_port', 'services.api.internal_port'),
		port('services.api.host_port', 'services.api.host_port'),
		{ path: 'services.ui.dockerfile', label: 'services.ui.dockerfile', kind: DeployTemplateControlKind.Fixed, required: true },
		port('services.ui.internal_port', 'services.ui.internal_port'),
		port('services.ui.host_port', 'services.ui.host_port'),
		text('services.database.image', 'services.database.image'),
		text('services.database.data_volume', 'services.database.data_volume'),
		text('services.database.password_env', 'services.database.password_env'),
		{ path: 'capabilities.compose', label: 'capabilities.compose', kind: DeployTemplateControlKind.Fixed, required: true },
		flag('capabilities.prerequisites_check', 'capabilities.prerequisites_check'),
		flag('capabilities.installer_assistance', 'capabilities.installer_assistance'),
		flag('capabilities.setup_script', 'capabilities.setup_script'),
	];
}

/** The draft body a new Template starts from: a Valid shape the author edits (no secret values; `latest` is not used). */
export function newDeployTemplateBody(buildTargets: readonly string[]): Record<string, unknown> {
	return {
		id: '',
		label: '',
		provider: 'docker_compose',
		supported_hosts: [DeployHost.Linux],
		compatible_build_targets: buildTargets.slice(0, 1),
		services: {
			api: { dockerfile: 'generated', internal_port: 8080, host_port: 8080 },
			ui: { dockerfile: 'generated', internal_port: 3000, host_port: 3000 },
			database: { image: 'postgres:16.4', data_volume: 'application-db', password_env: 'DB_PASSWORD' },
		},
		capabilities: { compose: true },
	};
}

function getPath(body: Record<string, unknown>, path: string): unknown {
	let value: unknown = body;
	for (const part of path.split('.')) {
		if (typeof value !== 'object' || value === null) {
			return undefined;
		}
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split('.');
	let target = body;
	for (const part of parts.slice(0, -1)) {
		const next = target[part];
		if (typeof next !== 'object' || next === null) {
			target[part] = {};
		}
		target = target[part] as Record<string, unknown>;
	}
	const last = parts[parts.length - 1];
	if (value === undefined) {
		delete target[last];
	} else {
		target[last] = value;
	}
}

/** The outcome of validating a draft: the Template, or the diagnostic with its Schema path. */
export type DeployTemplateDraftValidation =
	| { readonly valid: true; readonly template: IDeployTemplate; readonly text: string }
	| { readonly valid: false; readonly path: string; readonly diagnostic: string };

/**
 * The draft behind the Deploy Template Editor (Editor Area). Controls are derived from the 3.1 Schema; a
 * built-in Template (`readOnly`) and the id of an existing Template are not editable. Saving is possible only
 * for a draft that validates.
 */
export class DeployTemplateDraft {

	private readonly body: Record<string, unknown>;

	constructor(body: Record<string, unknown>, private readonly options: { readonly readOnly: boolean; readonly idLocked: boolean; readonly buildTargets: readonly string[] }) {
		this.body = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	}

	get readOnly(): boolean {
		return this.options.readOnly;
	}

	/** The draft content (a copy) as `deploy_template`. */
	toBody(): Record<string, unknown> {
		return JSON.parse(JSON.stringify(this.body)) as Record<string, unknown>;
	}

	controls(): readonly IDeployTemplateControl[] {
		return controlSpecs(this.options.buildTargets).map(spec => {
			const raw = getPath(this.body, spec.path);
			let readonlyReason: string | undefined;
			if (this.options.readOnly) {
				readonlyReason = 'built-in';
			} else if (spec.kind === DeployTemplateControlKind.Fixed) {
				readonlyReason = 'fixed';
			} else if (spec.path === 'id' && this.options.idLocked) {
				readonlyReason = 'id';
			}
			let value: IDeployTemplateControl['value'];
			switch (spec.kind) {
				case DeployTemplateControlKind.MultiSelect: value = Array.isArray(raw) ? raw.map(String) : []; break;
				case DeployTemplateControlKind.Checkbox: value = raw === true; break;
				case DeployTemplateControlKind.Number: value = typeof raw === 'number' ? raw : String(raw ?? ''); break;
				default: value = typeof raw === 'string' ? raw : raw === undefined ? '' : String(raw);
			}
			return Object.freeze({ ...spec, value, readonlyReason });
		});
	}

	/** Sets a Control value. Rejects an unknown or non-editable path (the Editor never writes outside the Schema). */
	set(path: string, value: string | number | boolean | readonly string[]): void {
		const control = this.controls().find(candidate => candidate.path === path);
		if (!control) {
			fail(path, 'is not a Deploy Template Schema path');
		}
		if (control.readonlyReason) {
			fail(path, `is read-only (${control.readonlyReason})`);
		}
		switch (control.kind) {
			case DeployTemplateControlKind.Number: {
				const number = typeof value === 'number' ? value : Number(String(value));
				setPath(this.body, path, Number.isNaN(number) ? String(value) : number);
				break;
			}
			case DeployTemplateControlKind.Checkbox:
				// Optional capabilities are omitted when false (the writer outputs only values that differ from the default).
				setPath(this.body, path, value === true ? true : undefined);
				break;
			case DeployTemplateControlKind.MultiSelect:
				setPath(this.body, path, Array.isArray(value) ? [...value] : []);
				break;
			default:
				setPath(this.body, path, path === 'description' && value === '' ? undefined : value);
		}
	}

	/** Validates with the same function as every Registry document; never throws. */
	validate(): DeployTemplateDraftValidation {
		try {
			const template = createDeployTemplate({ deploy_template: this.body });
			return Object.freeze({ valid: true, template, text: serializeDeployTemplate(template) });
		} catch (error) {
			if (error instanceof DeployValidationError) {
				return Object.freeze({ valid: false, path: error.path, diagnostic: error.message });
			}
			throw error;
		}
	}
}

/** The draft of a Registry entry: read-only for a built-in Template; the id of an existing user Template is locked. */
export function draftForTemplate(template: IDeployTemplate, origin: DeployTemplateOrigin, buildTargets: readonly string[]): DeployTemplateDraft {
	return new DeployTemplateDraft(templateBody(template), { readOnly: origin === DeployTemplateOrigin.Builtin, idLocked: true, buildTargets });
}

/** The draft of a new Template. */
export function draftForNewTemplate(buildTargets: readonly string[]): DeployTemplateDraft {
	return new DeployTemplateDraft(newDeployTemplateBody(buildTargets), { readOnly: false, idLocked: false, buildTargets });
}

// #endregion
