/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Build / Export Configuration surface model (build.deploy)
 *  Specification SSOT: docs/primitive-app-editor/Editor UI.md (13. Export / Build Configuration)
 *  docs/primitive-app-editor/Deploy Configuration.md (4. UI / Registrar Integration)
 *--------------------------------------------------------------------------------------------*/

import { BuildValidationError, buildTargetRuntimeStorageTargets, IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT, POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE } from './buildValidation.js';
import {
	DeployHost, DeployTemplateOrigin, DeployValidationError, DEPLOY_COMPOSE_FILE, IDeployScaffoldFile, IDeployTemplate, IDeployTemplateRegistry, projectDeployScaffold,
} from './deployProjection.js';
import { localize } from '../../../../nls.js';
import { getRegistryDisplayText } from './registryIdentity.js';

/**
 * The Build / Export Configuration Surface is Derived UI state: a draft of the Build Configuration
 * (Build / Export Selection) plus the Deploy Selection (`template_id` / `host`). It never writes to the
 * Registry / Raw Data / Binding, and it never runs a generated file. The Editor Area tab of this surface
 * is one per project (a fixed tab identity), so the Workbench reuses it.
 */
export const buildExportTabUuid = '00000000-0000-0000-0000-000000000002';

/** Working Directory prefixes that classify the files the Build can include. */
const FUNCTIONS_PREFIX = 'functions/';
const SCRIPTS_PREFIX = 'scripts/';
const CONFIG_PREFIX = 'config/';

export const enum BuildItemState {
	Included = 'Included',
	/** Not selected / explicitly excluded: never exported to the Production Application Seed. */
	Excluded = 'Excluded',
}

export interface IBuildChecklistItem {
	/** Item identity (`table_registry.uuid`, `asset.uuid`, Row uuid or Working Directory path). */
	readonly id: string;
	readonly label: string;
	readonly state: BuildItemState;
}

/**
 * A Build / Export Surface checklist. `marker` is the kind-fixed UI Marker (Editor UI 19): one per Surface,
 * never per item. Item identity is `IBuildChecklistItem.id` (rendered as `data-pae-item`). `groups` splits a
 * checklist by Raw Data table: each group is identified by the table uuid, not by a Marker.
 */
export interface IBuildChecklistSection {
	readonly marker: string;
	readonly title: string;
	readonly items: readonly IBuildChecklistItem[];
	readonly groups?: readonly { readonly id: string; readonly title: string; readonly items: readonly IBuildChecklistItem[] }[];
}

/** A Build Target / Runtime-Storage Target as displayed: read-only when one is resolvable, a select when two or more. */
export interface IBuildTargetDisplay {
	readonly value: string;
	/** The resolvable Targets; the select candidates when `selectable`. */
	readonly choices: readonly string[];
	readonly selectable: boolean;
}

/**
 * The DOM structure of the checklists / Target controls as data, so the Marker / Item Identity regulation
 * (Editor UI 19) is verifiable without a DOM. The browser layer mounts it one to one and only attaches the
 * listeners named by `action`.
 */
export interface IBuildSurfaceNode {
	readonly tag: string;
	readonly attrs?: Readonly<Record<string, string | boolean>>;
	readonly text?: string;
	readonly children?: readonly IBuildSurfaceNode[];
	/** `toggle`: a checklist checkbox of `id` in `marker`'s checklist; `select-target`: a Target select of `marker`. */
	readonly action?: { readonly kind: 'toggle'; readonly marker: string; readonly id: string } | { readonly kind: 'select-target'; readonly marker: string };
}

const EXCLUDED_HINT = localize('primitiveAppEditor.build.excludedHint', "Not exported to the Production Application. Select it to include it.");

function itemNodes(itemMarker: string, sectionMarker: string, items: readonly IBuildChecklistItem[]): IBuildSurfaceNode {
	return {
		tag: 'ul',
		children: items.map((item): IBuildSurfaceNode => ({
			tag: 'li',
			attrs: { 'data-pae-marker': itemMarker, 'data-pae-item': item.id },
			children: [{
				tag: 'label',
				children: [
					{ tag: 'input', attrs: { type: 'checkbox', checked: item.state === BuildItemState.Included }, action: { kind: 'toggle', marker: sectionMarker, id: item.id } },
					{ tag: 'span', text: ` ${item.label} ` },
					{ tag: 'span', attrs: { class: 'pae-badge', 'data-pae-state': item.state, title: item.state === BuildItemState.Excluded ? EXCLUDED_HINT : '' }, text: item.state },
				],
			}],
		})),
	};
}

/** One kind-fixed Marker per checklist; item / table identity is `data-pae-item`, never a Marker. */
export function checklistSurfaceNodes(section: IBuildChecklistSection): readonly IBuildSurfaceNode[] {
	const title: IBuildSurfaceNode = { tag: 'h3', text: section.title };
	const groups = section.groups;
	if (groups ? groups.length === 0 : section.items.length === 0) {
		return [title, { tag: 'div', attrs: { class: 'pae-empty' }, text: localize('primitiveAppEditor.build.none', "None") }];
	}
	const itemMarker = `${section.marker}.item`;
	const children = groups
		? groups.map((group): IBuildSurfaceNode => ({ tag: 'div', attrs: { 'data-pae-item': group.id }, children: [{ tag: 'h4', text: group.title }, itemNodes(itemMarker, section.marker, group.items)] }))
		: [itemNodes(itemMarker, section.marker, section.items)];
	return [title, { tag: 'div', attrs: { 'data-pae-marker': section.marker }, children }];
}

/** Build Target / Runtime-Storage Target: read-only identifier for one resolvable Target, a select for two or more. */
export function targetSurfaceNodes(marker: string, title: string, display: IBuildTargetDisplay): readonly IBuildSurfaceNode[] {
	const heading: IBuildSurfaceNode = { tag: 'h3', text: title };
	if (!display.selectable) {
		return [heading, { tag: 'p', attrs: { 'data-pae-marker': marker }, text: display.value }];
	}
	return [heading, {
		tag: 'select',
		attrs: { 'data-pae-marker': marker },
		action: { kind: 'select-target', marker },
		children: display.choices.map(choice => ({ tag: 'option', attrs: { value: choice, selected: choice === display.value }, text: choice })),
	}];
}

export interface IBuildSeedTable extends IBuildChecklistItem {
	readonly rows: readonly IBuildChecklistItem[];
}

/** The Deploy Template as listed in the Surface. */
export interface IDeployTemplateChoice {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly origin: DeployTemplateOrigin;
	readonly selected: boolean;
}

/** One Registry entry for Discovery (Primary Side Bar). Invalid entries are listed with the diagnostic and are never selectable. */
export interface IDeployTemplateListing {
	readonly id: string;
	readonly origin: DeployTemplateOrigin;
	readonly valid: boolean;
	readonly label: string;
	readonly diagnostic?: string;
}

export function listDeployTemplates(registry: IDeployTemplateRegistry): readonly IDeployTemplateListing[] {
	return Object.freeze(registry.entries.map(entry => Object.freeze({
		id: entry.id,
		origin: entry.origin,
		valid: entry.valid,
		label: entry.template?.label ?? entry.id,
		diagnostic: entry.diagnostic,
	})));
}

/** The supplementary information of a Deploy Template as the Inspector (Secondary Side Bar) shows it. Read-only. */
export interface IDeployTemplateInspectorView {
	readonly header: string;
	readonly origin: DeployTemplateOrigin;
	readonly valid: boolean;
	/** Label / value pairs of the Template's declared values; empty for an Invalid Template. */
	readonly rows: readonly (readonly [string, string])[];
	/** An Invalid Template's diagnostic. */
	readonly diagnostic?: string;
}

/** Supplementary information of the selected Deploy Template; `undefined` when the id is not in the Registry. */
export function createDeployTemplateInspectorView(registry: IDeployTemplateRegistry, templateId: string, referencedBySelection = false): IDeployTemplateInspectorView | undefined {
	const entry = registry.resolve(templateId);
	if (!entry) {
		return undefined;
	}
	const template = entry.valid ? entry.template : undefined;
	if (!template) {
		return Object.freeze({ header: entry.id, origin: entry.origin, valid: false, rows: Object.freeze([]), diagnostic: entry.diagnostic });
	}
	const rows: (readonly [string, string])[] = [
		[localize('primitiveAppEditor.inspector.template.id', "Template ID"), template.id],
		[localize('primitiveAppEditor.inspector.template.description', "Description"), template.description],
		[localize('primitiveAppEditor.inspector.template.provider', "Provider"), template.provider],
		[localize('primitiveAppEditor.inspector.template.hosts', "Supported hosts"), template.supported_hosts.join(', ')],
		[localize('primitiveAppEditor.inspector.template.targets', "Compatible build targets"), template.compatible_build_targets.join(', ')],
		[localize('primitiveAppEditor.inspector.template.api', "API port"), `${template.services.api.host_port} → ${template.services.api.internal_port}`],
		[localize('primitiveAppEditor.inspector.template.ui', "UI port"), `${template.services.ui.host_port} → ${template.services.ui.internal_port}`],
		[localize('primitiveAppEditor.inspector.template.database', "Database"), `${template.services.database.image} · ${template.services.database.data_volume}`],
		[localize('primitiveAppEditor.inspector.template.selection', "Referenced by Selection"), referencedBySelection ? localize('primitiveAppEditor.inspector.template.selectionYes', "Yes (Build / Export Configuration)") : localize('primitiveAppEditor.inspector.template.selectionNo', "No")],
	];
	return Object.freeze({ header: template.label, origin: entry.origin, valid: true, rows: Object.freeze(rows.map(row => Object.freeze(row))) });
}

export interface IBuildValidationReport {
	readonly valid: boolean;
	/** The failed stage, when a Build Validation stage rejected. */
	readonly stage?: string;
	readonly diagnostics: readonly string[];
}

export interface IBuildExportPlanFile {
	/** Working Directory relative path, under `output_path`. */
	readonly path: string;
	readonly content: string;
	/** Scaffold files are never overwritten; the other Application Output files are Derived and regenerated. */
	readonly scaffold: boolean;
}

export interface IBuildExportPreview {
	readonly valid: boolean;
	readonly report: IBuildValidationReport;
	/** Scaffold files with the adopted names (after collision avoidance), sorted by path. Empty until valid. */
	readonly scaffoldFiles: readonly IDeployScaffoldFile[];
	/** Every file the Build / Export writes (Application Output + Scaffold), relative to the Working Directory. */
	readonly plan: readonly IBuildExportPlanFile[];
	/** The launch command the Editor shows but never executes, e.g. `docker compose -f compose-001.yml up -d`. */
	readonly startCommand: string | undefined;
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function state(included: boolean): BuildItemState {
	return included ? BuildItemState.Included : BuildItemState.Excluded;
}

function joinOutput(outputPath: string, path: string): string {
	return `${outputPath.replace(/\/+$/, '')}/${path}`;
}

function toggle(set: Set<string>, value: string, included: boolean): void {
	if (included) {
		set.add(value);
	} else {
		set.delete(value);
	}
}

/**
 * Executor -> Program: a Program under `functions/` whose file name (without extension, case-insensitive)
 * is the Registry `executor` name (e.g. `Linear` -> `functions/linear.ts`). `programs` are paths relative
 * to `functions/`. No Program -> `undefined` (Function Executor Validate rejects it).
 */
export function createExecutorProgramResolver(programs: readonly { readonly path: string }[]): (executor: string) => string | undefined {
	return executor => {
		const wanted = executor.toLowerCase();
		const match = [...programs].map(program => program.path).sort().find(path => {
			const name = path.slice(path.lastIndexOf('/') + 1);
			const dot = name.lastIndexOf('.');
			return (dot > 0 ? name.slice(0, dot) : name).toLowerCase() === wanted;
		});
		return match === undefined ? undefined : `${FUNCTIONS_PREFIX}${match}`;
	};
}

/** The Compose launch guidance for the adopted Compose file name. */
export function composeStartCommand(composeFile: string): string {
	return `docker compose -f ${composeFile} up -d`;
}

function invalid(stage: string | undefined, diagnostics: readonly string[]): IBuildExportPreview {
	return Object.freeze({
		valid: false,
		report: Object.freeze({ valid: false, stage, diagnostics: Object.freeze([...diagnostics]) }),
		scaffoldFiles: Object.freeze([]),
		plan: Object.freeze([]),
		startCommand: undefined,
	});
}

/** The current Deploy Selection (`template_id` / `host`); `templateId` `undefined` is "not selected". */
export interface IDeploySelection {
	readonly templateId: string | undefined;
	readonly host: DeployHost;
}

/**
 * Holder of the Deploy Selection for the lifetime of the open Project (Deploy Configuration 3.3). It is the only
 * source of "Referenced by Selection"; the Surface Model restores from it and writes changes back.
 */
export class DeploySelectionHolder {

	private selection: IDeploySelection = Object.freeze({ templateId: undefined, host: DeployHost.Linux });

	get(): IDeploySelection {
		return this.selection;
	}

	set(selection: IDeploySelection): void {
		this.selection = Object.freeze({ templateId: selection.templateId, host: selection.host });
	}

	/** Project switch / Close: back to "not selected". */
	reset(): void {
		this.set({ templateId: undefined, host: DeployHost.Linux });
	}

	/**
	 * Applies a Project Open state change through `views`; a Project switch / Close (views reset) also clears the
	 * Selection, while a re-Ready of the same Project keeps it. Returns whether the Project state was reset.
	 */
	applyProjectState(views: { applyProjectState(ready: boolean, project: string | undefined): boolean }, ready: boolean, project: string | undefined): boolean {
		const reset = views.applyProjectState(ready, project);
		if (reset) {
			this.reset();
		}
		return reset;
	}

	/** True only when the Selection is exactly this Template id. */
	isReferenced(templateId: string): boolean {
		return this.selection.templateId === templateId;
	}
}

export class BuildExportConfigurationModel {

	buildTarget = POSTGRESQL_WEB_APPLICATION_OUTPUT;
	runtimeStorageTarget = POSTGRESQL_WEB_APPLICATION_RUNTIME_STORAGE;
	outputPath = 'build/output';
	templateId: string | undefined;
	host: DeployHost = DeployHost.Linux;

	private seedInclude: boolean;
	private readonly seedTables: Set<string>;
	private readonly excludedRows = new Set<string>();
	private readonly assets: Set<string>;
	private readonly functions: Set<string>;
	private readonly scripts: Set<string>;
	private readonly config: Set<string>;

	constructor(private readonly authoring: IBuildAuthoringData, private registry: IDeployTemplateRegistry, private readonly targets: ReadonlyMap<string, readonly string[]> = buildTargetRuntimeStorageTargets, initialSelection?: IDeploySelection) {
		if (initialSelection) {
			this.templateId = initialSelection.templateId;
			this.host = initialSelection.host;
		}
		this.seedInclude = authoring.rawData.length > 0;
		this.seedTables = new Set(authoring.rawData.map(table => table.table_uuid));
		this.assets = new Set(authoring.assets.map(asset => asset.uuid));
		const paths = authoring.workingDirectoryPaths;
		this.functions = new Set(paths.filter(path => path.startsWith(FUNCTIONS_PREFIX)));
		this.scripts = new Set(paths.filter(path => path.startsWith(SCRIPTS_PREFIX)));
		this.config = new Set(paths.filter(path => path.startsWith(CONFIG_PREFIX)));
	}

	// #region Selection (explicit Controls)

	setSeedInclude(include: boolean): void {
		this.seedInclude = include;
	}

	setSeedTable(tableUuid: string, included: boolean): void {
		toggle(this.seedTables, tableUuid, included);
	}

	setRowExcluded(rowUuid: string, excluded: boolean): void {
		toggle(this.excludedRows, rowUuid, excluded);
	}

	setAsset(assetUuid: string, included: boolean): void {
		toggle(this.assets, assetUuid, included);
	}

	setFunction(path: string, included: boolean): void {
		toggle(this.functions, path, included);
	}

	setScript(path: string, included: boolean): void {
		toggle(this.scripts, path, included);
	}

	setConfig(path: string, included: boolean): void {
		toggle(this.config, path, included);
	}

	/**
	 * Replaces the Editor-wide Registry the Surface reads after the Registrar changed it. The Selection is never
	 * rewritten: a Template that is gone or Invalid makes the Selection fail Deploy Validation ("Template unresolved").
	 */
	updateRegistry(registry: IDeployTemplateRegistry): void {
		this.registry = registry;
	}

	/** Selects the Deploy Template (`undefined`: no Deploy). Validation rejects an id that is not a Valid Template. */
	selectTemplate(templateId: string | undefined): void {
		this.templateId = templateId;
	}

	selectHost(host: DeployHost): void {
		this.host = host;
	}

	// #endregion

	// #region Target (resolved from Build Target and Registry; never a UI-side fixed enumeration)

	/** Build Targets the Build implementation provides. */
	private resolveBuildTargets(): readonly string[] {
		return [...this.targets.keys()];
	}

	private resolveRuntimeStorageTargets(): readonly string[] {
		return this.targets.get(this.buildTarget) ?? [];
	}

	buildTargetDisplay(): IBuildTargetDisplay {
		const choices = this.resolveBuildTargets();
		return Object.freeze({ value: this.buildTarget, choices: Object.freeze(choices), selectable: choices.length >= 2 });
	}

	runtimeStorageTargetDisplay(): IBuildTargetDisplay {
		const choices = this.resolveRuntimeStorageTargets();
		return Object.freeze({ value: this.runtimeStorageTarget, choices: Object.freeze([...choices]), selectable: choices.length >= 2 });
	}

	/** Selects a resolvable Build Target; its Runtime / Storage Target resets to the first one it supports. */
	selectBuildTarget(target: string): void {
		if (!this.resolveBuildTargets().includes(target)) {
			throw new Error(`Build Target '${target}' is not resolvable`);
		}
		this.buildTarget = target;
		const runtime = this.resolveRuntimeStorageTargets();
		if (!runtime.includes(this.runtimeStorageTarget)) {
			this.runtimeStorageTarget = runtime[0];
		}
	}

	selectRuntimeStorageTarget(target: string): void {
		if (!this.resolveRuntimeStorageTargets().includes(target)) {
			throw new Error(`Runtime / Storage Target '${target}' is not resolvable for Build Target '${this.buildTarget}'`);
		}
		this.runtimeStorageTarget = target;
	}

	// #endregion

	// #region Views

	/** The checklists in display order, each with one kind-fixed Marker. Raw Data rows are one Marker grouped per table. */
	checklistSections(): readonly IBuildChecklistSection[] {
		const seed = this.seed();
		return Object.freeze([
			{ marker: 'build.export.raw-data', title: localize('primitiveAppEditor.build.rawData', "Raw Data tables"), items: seed.tables },
			{
				marker: 'build.export.rows', title: localize('primitiveAppEditor.build.rows', "Raw Data rows"), items: [],
				groups: seed.tables.filter(table => table.state === BuildItemState.Included).map(table => ({ id: table.id, title: table.label, items: table.rows })),
			},
			{ marker: 'build.export.assets', title: localize('primitiveAppEditor.build.assets', "Assets"), items: this.assetItems() },
			{ marker: 'build.export.functions', title: localize('primitiveAppEditor.build.functions', "Functions"), items: this.functionItems() },
			{ marker: 'build.export.scripts', title: localize('primitiveAppEditor.build.scripts', "Scripts"), items: this.scriptItems() },
			{ marker: 'build.export.config', title: localize('primitiveAppEditor.build.config', "Config"), items: this.configItems() },
		].map(section => Object.freeze(section)));
	}

	seed(): { readonly include: boolean; readonly tables: readonly IBuildSeedTable[] } {
		const tables = this.authoring.rawData.map((data): IBuildSeedTable => {
			const entry = this.authoring.tables.find(table => table.uuid === data.table_uuid);
			const selected = this.seedInclude && this.seedTables.has(data.table_uuid);
			return Object.freeze({
				id: data.table_uuid,
				label: entry ? getRegistryDisplayText(entry) : data.table_uuid,
				state: state(selected),
				rows: Object.freeze(data.rows.map((row, index) => Object.freeze({
					id: row.uuid,
					label: `Row ${index + 1}`,
					state: state(selected && !this.excludedRows.has(row.uuid)),
				}))),
			});
		});
		return Object.freeze({ include: this.seedInclude, tables: Object.freeze(tables) });
	}

	assetItems(): readonly IBuildChecklistItem[] {
		return this.authoring.assets.map(asset => Object.freeze({ id: asset.uuid, label: getRegistryDisplayText(asset), state: state(this.assets.has(asset.uuid)) }));
	}

	functionItems(): readonly IBuildChecklistItem[] {
		return this.pathItems(FUNCTIONS_PREFIX, this.functions);
	}

	scriptItems(): readonly IBuildChecklistItem[] {
		return this.pathItems(SCRIPTS_PREFIX, this.scripts);
	}

	configItems(): readonly IBuildChecklistItem[] {
		return this.pathItems(CONFIG_PREFIX, this.config);
	}

	private pathItems(prefix: string, selected: ReadonlySet<string>): readonly IBuildChecklistItem[] {
		return sortedUnique(this.authoring.workingDirectoryPaths.filter(path => path.startsWith(prefix)))
			.map(path => Object.freeze({ id: path, label: path, state: state(selected.has(path)) }));
	}

	/** Valid Templates compatible with the Build Target and the chosen host. */
	templateChoices(): readonly IDeployTemplateChoice[] {
		const choices: IDeployTemplateChoice[] = [];
		for (const entry of this.registry.entries) {
			const template = entry.template;
			if (entry.valid && template && this.isCompatible(template)) {
				choices.push(Object.freeze({ id: template.id, label: template.label, description: template.description, origin: entry.origin, selected: template.id === this.templateId }));
			}
		}
		return Object.freeze(choices);
	}

	private isCompatible(template: IDeployTemplate): boolean {
		return template.compatible_build_targets.includes(this.buildTarget) && template.supported_hosts.includes(this.host);
	}

	/** The selected Template's declared values the Surface shows read-only (no parameter Control). */
	selectedTemplate(): IDeployTemplate | undefined {
		const entry = this.templateId ? this.registry.resolve(this.templateId) : undefined;
		return entry?.valid ? entry.template : undefined;
	}

	// #endregion

	/** The Build Configuration input (`build_configuration`) of the current Selection. */
	configuration(): Record<string, unknown> {
		const configuration: Record<string, unknown> = {
			build_target: this.buildTarget,
			runtime_storage_target: this.runtimeStorageTarget,
			seed_data: {
				include: this.seedInclude,
				raw_data: { tables: sortedUnique([...this.seedTables]), exclude_rows: sortedUnique([...this.excludedRows]) },
			},
			include: {
				assets: sortedUnique([...this.assets]),
				functions: sortedUnique([...this.functions]),
				scripts: sortedUnique([...this.scripts]),
				config: sortedUnique([...this.config]),
			},
			output_path: this.outputPath,
		};
		if (this.templateId !== undefined) {
			configuration.deploy = { template_id: this.templateId, host: this.host };
		}
		return configuration;
	}

	/**
	 * Build Validation + Deploy Validation + Scaffold preview. `existingFiles` lists the files already in the
	 * output directory (relative to `output_path`); the Scaffold adopts unused names and never overwrites.
	 * Nothing is written.
	 */
	preview(existingFiles: readonly string[] = []): IBuildExportPreview {
		if (this.templateId === undefined) {
			return invalid(undefined, ['Select a Deploy Template to validate and Scaffold the deployment.']);
		}
		try {
			const { output, result, scaffold } = projectDeployScaffold(this.authoring, this.configuration(), this.registry, existingFiles);
			const applicationFiles = [...result.webProgram.files, ...result.postgresql.files];
			const plan: IBuildExportPlanFile[] = [
				...applicationFiles.map(file => ({ path: joinOutput(output.output_path, file.path), content: file.content, scaffold: false })),
				...scaffold.files.map(file => ({ path: joinOutput(output.output_path, file.path), content: file.content, scaffold: true })),
			].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
			const compose = scaffold.files.find(file => file.requested === DEPLOY_COMPOSE_FILE);
			return Object.freeze({
				valid: true,
				report: Object.freeze({ valid: true, diagnostics: Object.freeze([]) }),
				scaffoldFiles: scaffold.files,
				plan: Object.freeze(plan.map(file => Object.freeze(file))),
				startCommand: compose ? composeStartCommand(compose.path) : undefined,
			});
		} catch (error) {
			if (error instanceof BuildValidationError) {
				return invalid(error.stage, [error.message]);
			}
			if (error instanceof DeployValidationError) {
				return invalid('Deploy Validate', [error.message]);
			}
			throw error;
		}
	}
}
