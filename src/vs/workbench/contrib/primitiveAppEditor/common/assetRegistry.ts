/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Asset model and directory scan (asset.registry)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (29. Asset)
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid as generateRandomUuid } from '../../../../base/common/uuid.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { AssetCategory, assetCategories, IProjectOpenContext, IProjectOpenSteps } from './projectDirectory.js';
import { ensureRegistryIdentity, IRegistryIdentity, normalizeRegistryUuid, RegistryIdentityError } from './registryIdentity.js';

/**
 * `<Project>/assets/ -> Directory Scan -> Asset Resolve -> Asset Registry`.
 *
 * An Asset is the Registry entry of one Binary Asset under `<Project>/assets/`. The binary stays
 * in the Working Directory; the Registry holds identity (`uuid`, `name`, `label`), `index`, `kind`,
 * the `source` path and `metadata`. The scan only reads: it never creates, edits or deletes an asset.
 */

export const enum AssetKind {
	Image = 'image',
	Sprite = 'sprite',
	Audio = 'audio',
	Font = 'font',
	Shader = 'shader',
	Other = 'other',
}

const assetKinds: ReadonlySet<string> = new Set<string>([AssetKind.Image, AssetKind.Sprite, AssetKind.Audio, AssetKind.Font, AssetKind.Shader, AssetKind.Other]);

export function isAssetKind(value: unknown): value is AssetKind {
	return typeof value === 'string' && assetKinds.has(value);
}

/** One Asset (29). */
export interface IAsset extends IRegistryIdentity {
	readonly index: number;
	readonly kind: AssetKind;
	/** Path relative to the Working Directory, `/` separated (e.g. `assets/image/a.png`). */
	readonly source: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface IAssetInput {
	readonly uuid?: string;
	readonly index: number;
	readonly name: string;
	readonly label?: string;
	readonly kind: AssetKind;
	readonly source: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export class AssetRegistryError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor asset: ${message}`);
		this.name = 'AssetRegistryError';
	}
}

/** Builds a validated Asset: missing UUID generated / supplied kept, `index` int, `kind` in the 29 set, `source` non-empty, `metadata` a JSON object. */
export function createAsset(input: IAssetInput, generateUuid: () => string = generateRandomUuid): IAsset {
	let identity: IRegistryIdentity;
	try {
		identity = ensureRegistryIdentity(input, generateUuid);
	} catch (error) {
		throw error instanceof RegistryIdentityError ? new AssetRegistryError(error.message) : error;
	}
	const where = `asset '${identity.name}'`;
	if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) {
		throw new AssetRegistryError(`${where}: index must be an int`);
	}
	if (!isAssetKind(input.kind)) {
		throw new AssetRegistryError(`${where}: kind '${String(input.kind)}' must be image | sprite | audio | font | shader | other`);
	}
	if (typeof input.source !== 'string' || input.source === '') {
		throw new AssetRegistryError(`${where}: source must be non-empty text`);
	}
	const metadata = input.metadata ?? {};
	if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
		throw new AssetRegistryError(`${where}: metadata must be a json object`);
	}
	return Object.freeze({
		uuid: identity.uuid,
		index: input.index,
		name: identity.name,
		...(identity.label === undefined || identity.label === '' ? {} : { label: identity.label }),
		kind: input.kind,
		source: input.source,
		metadata: Object.freeze({ ...metadata }),
	});
}

/** Validates an Asset Registry: UUIDs are unique and every `source` is registered once. */
export function validateAssetRegistry(assets: readonly IAsset[]): void {
	const uuids = new Set<string>();
	const sources = new Set<string>();
	for (const asset of assets) {
		const uuid = normalizeRegistryUuid(asset.uuid);
		if (uuids.has(uuid)) {
			throw new AssetRegistryError(`duplicate asset uuid '${uuid}'`);
		}
		uuids.add(uuid);
		if (sources.has(asset.source)) {
			throw new AssetRegistryError(`duplicate asset source '${asset.source}'`);
		}
		sources.add(asset.source);
	}
}

// #region Directory Scan

/** One file discovered under `<Project>/assets/<category>/`. */
export interface IDiscoveredAsset {
	readonly category: AssetCategory;
	/** Path relative to `assets/<category>/`, `/` separated. */
	readonly path: string;
	/** Path relative to the Working Directory, `/` separated. */
	readonly source: string;
	readonly resource: URI;
	readonly size?: number;
}

/**
 * `Directory Scan`: every file under `assetsDirectory/<category>/` (recursively), ordered by
 * source path. Only a missing directory (file not found) discovers nothing; any other resolve
 * failure and a directory entry that is a file are rejected, so a failed scan never reaches Editor Ready.
 */
export async function discoverAssets(fileService: IFileService, assetsDirectory: URI): Promise<readonly IDiscoveredAsset[]> {
	const found: IDiscoveredAsset[] = [];
	for (const category of assetCategories) {
		const directory = joinPath(assetsDirectory, category);
		let stat;
		try {
			stat = await fileService.resolve(directory, { resolveMetadata: true });
		} catch (error) {
			if (toFileOperationResult(error as Error) === FileOperationResult.FILE_NOT_FOUND) {
				continue;
			}
			throw error;
		}
		if (!stat.isDirectory) {
			throw new AssetRegistryError(`assets/${category} entry is not a directory: ${directory.toString()}`);
		}
		const visit = async (current: URI, prefix: string): Promise<void> => {
			const children = (await fileService.resolve(current, { resolveMetadata: true })).children ?? [];
			for (const child of children) {
				const path = prefix ? `${prefix}/${child.name}` : child.name;
				if (child.isDirectory) {
					await visit(joinPath(current, child.name), path);
				} else if (child.isFile) {
					found.push(Object.freeze({
						category,
						path,
						source: `assets/${category}/${path}`,
						resource: child.resource,
						...(typeof child.size === 'number' ? { size: child.size } : {}),
					}));
				}
			}
		};
		await visit(directory, '');
	}
	found.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
	return Object.freeze(found);
}

// #endregion

// #region Asset Resolve

/** `assets/<category>/` -> `kind`; `sprite` is an image the Registry already classified as a sprite. */
function kindOfCategory(category: AssetCategory): AssetKind {
	switch (category) {
		case AssetCategory.Image: return AssetKind.Image;
		case AssetCategory.Audio: return AssetKind.Audio;
		case AssetCategory.Font: return AssetKind.Font;
		case AssetCategory.Shader: return AssetKind.Shader;
		case AssetCategory.Other: return AssetKind.Other;
	}
}

function extensionOf(path: string): string | undefined {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * `Asset Resolve`: maps discovered files to Assets. `kind` follows the `assets/<category>/`
 * directory; an `existing` Registry entry with the same `source` keeps its `uuid` / `name` / `label`
 * (Machine Identity survives rescans), a new file gets a generated UUID and its path as `name`.
 * `index` is the position in source order. Registry entries whose file is gone are not carried over.
 */
export function resolveAssets(
	discovered: readonly IDiscoveredAsset[],
	existing: readonly IAsset[] = [],
	generateUuid: () => string = generateRandomUuid,
): readonly IAsset[] {
	validateAssetRegistry(existing);
	const bySource = new Map(existing.map(asset => [asset.source, asset]));
	const assets = discovered.map((file, index) => {
		const known = bySource.get(file.source);
		const extension = extensionOf(file.path);
		return createAsset({
			uuid: known?.uuid,
			index,
			name: known?.name ?? file.path,
			label: known?.label,
			kind: known?.kind === AssetKind.Sprite && file.category === AssetCategory.Image ? AssetKind.Sprite : kindOfCategory(file.category),
			source: file.source,
			metadata: { ...known?.metadata, ...(extension === undefined ? {} : { extension }), ...(file.size === undefined ? {} : { size: file.size }) },
		}, generateUuid);
	});
	validateAssetRegistry(assets);
	return Object.freeze(assets);
}

// #endregion

// #region Asset Scan

/** Directory Scan -> Asset Resolve -> Asset Registry. */
export async function scanAssets(fileService: IFileService, assetsDirectory: URI, existing: readonly IAsset[] = []): Promise<readonly IAsset[]> {
	return resolveAssets(await discoverAssets(fileService, assetsDirectory), existing);
}

/**
 * The `assetScan` step of {@link IProjectOpenSteps}. `loadEntries` supplies the Assets known after
 * `Registry Load`; a rejection of the scan rejects the whole open before Editor Ready.
 */
export function createAssetScanStep(
	fileService: IFileService,
	loadEntries: (context: IProjectOpenContext) => Promise<readonly IAsset[]> = async () => [],
	onScanned?: (assets: readonly IAsset[], context: IProjectOpenContext) => void,
): NonNullable<IProjectOpenSteps['assetScan']> {
	return async context => {
		const assets = await scanAssets(fileService, context.paths.assets, await loadEntries(context));
		onScanned?.(assets, context);
	};
}

// #endregion
