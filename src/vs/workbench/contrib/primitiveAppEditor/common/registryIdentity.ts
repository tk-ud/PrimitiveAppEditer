/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - UUID identity and human naming (registry.identity)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (7. UUID Identity)
 *--------------------------------------------------------------------------------------------*/

import { generateUuid as generateRandomUuid, isUUID } from '../../../../base/common/uuid.js';

/**
 * `UUID = Machine Identity`, `name = Human Identifier`, `label = Human Display`.
 *
 * `Storage = UUID`: Registry entries and references between them are stored by UUID.
 * `Editor Display = name / label`: the Editor shows name / label and, in principle, never the UUID.
 * `Runtime = UUID -> Memory Address resolve` is owned by Runtime Addressing; this module only
 * guarantees that every Registry entry carries a stable UUID for it to resolve.
 */

// #region Identity

/** A Registry entry identity as stored. */
export interface IRegistryIdentity {
	/** Machine Identity. Stable across renames; never shown in the Editor in principle. */
	readonly uuid: string;
	/** Human Identifier. */
	readonly name: string;
	/** Human Display. Falls back to `name` when absent. */
	readonly label?: string;
}

/** A Registry INSERT / Seed input. The UUID is optional: Seed never requires UUID hand entry. */
export interface IRegistryIdentityInput {
	readonly uuid?: string;
	readonly name: string;
	readonly label?: string;
}

export class RegistryIdentityError extends Error {
	constructor(message: string) {
		super(`Primitive App Editor registry identity: ${message}`);
		this.name = 'RegistryIdentityError';
	}
}

export function isRegistryUuid(value: unknown): value is string {
	return typeof value === 'string' && isUUID(value);
}

/** Machine Identities are compared case-insensitively and stored lower-case. */
export function normalizeRegistryUuid(uuid: string): string {
	if (!isRegistryUuid(uuid)) {
		throw new RegistryIdentityError(`'${uuid}' is not a UUID`);
	}
	return uuid.toLowerCase();
}

function validateName(name: unknown): string {
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new RegistryIdentityError('name (Human Identifier) is required');
	}
	if (name !== name.trim()) {
		throw new RegistryIdentityError(`name '${name}' must not have leading or trailing whitespace`);
	}
	return name;
}

function validateLabel(label: unknown): string | undefined {
	if (label === undefined) {
		return undefined;
	}
	if (typeof label !== 'string') {
		throw new RegistryIdentityError('label (Human Display) must be a string');
	}
	return label.length > 0 ? label : undefined;
}

// #endregion

// #region Generate

/**
 * `Registry INSERT -> UUID missing? -> yes: Generate / no: Keep`.
 * A supplied UUID is kept (validated and normalized), never regenerated.
 */
export function ensureRegistryIdentity(input: IRegistryIdentityInput, generateUuid: () => string = generateRandomUuid): IRegistryIdentity {
	const name = validateName(input.name);
	const label = validateLabel(input.label);
	const uuid = input.uuid === undefined || input.uuid === '' ? normalizeRegistryUuid(generateUuid()) : normalizeRegistryUuid(input.uuid);
	return Object.freeze(label === undefined ? { uuid, name } : { uuid, name, label });
}

/**
 * Prepares a set of Registry INSERT / Seed rows: missing UUIDs are generated, supplied UUIDs
 * are kept, and the Machine Identity must be unique against the batch and `existing`.
 * Name uniqueness is not part of this contract.
 */
export function prepareRegistryInsert<T extends IRegistryIdentityInput>(
	rows: readonly T[],
	existing: readonly IRegistryIdentity[] = [],
	generateUuid: () => string = generateRandomUuid,
): (Omit<T, 'uuid' | 'name' | 'label'> & IRegistryIdentity)[] {
	const uuids = new Set(existing.map(identity => normalizeRegistryUuid(identity.uuid)));
	return rows.map(row => {
		const identity = ensureRegistryIdentity(row, generateUuid);
		if (uuids.has(identity.uuid)) {
			throw new RegistryIdentityError(`duplicate uuid for '${identity.name}'`);
		}
		uuids.add(identity.uuid);
		const prepared: Omit<T, 'uuid' | 'name' | 'label'> & { uuid: string; name: string; label?: string } = { ...row, uuid: identity.uuid, name: identity.name };
		if (identity.label === undefined) {
			delete prepared.label;
		} else {
			prepared.label = identity.label;
		}
		return prepared;
	});
}

// #endregion

// #region Rename

export const enum RegistryIdentityChangeKind {
	/** Same uuid, same name and label. */
	Keep = 'keep',
	/** `uuid same -> rename`: the Human Identifier changed, Machine Identity kept. */
	Rename = 'rename',
	/** Same uuid and name, only the Human Display changed. */
	Relabel = 'relabel',
	/** `uuid different -> delete + add`: the before uuid no longer exists. */
	Delete = 'delete',
	/** `uuid different -> delete + add`: a new uuid appeared. */
	Add = 'add',
}

export type RegistryIdentityChange =
	| { readonly kind: RegistryIdentityChangeKind.Keep | RegistryIdentityChangeKind.Rename | RegistryIdentityChangeKind.Relabel; readonly uuid: string; readonly before: IRegistryIdentity; readonly after: IRegistryIdentity }
	| { readonly kind: RegistryIdentityChangeKind.Delete; readonly uuid: string; readonly before: IRegistryIdentity }
	| { readonly kind: RegistryIdentityChangeKind.Add; readonly uuid: string; readonly after: IRegistryIdentity };

function indexByUuid(identities: readonly IRegistryIdentity[], side: string): Map<string, IRegistryIdentity> {
	const index = new Map<string, IRegistryIdentity>();
	for (const identity of identities) {
		const uuid = normalizeRegistryUuid(identity.uuid);
		if (index.has(uuid)) {
			throw new RegistryIdentityError(`duplicate uuid in ${side}`);
		}
		index.set(uuid, identity);
	}
	return index;
}

/**
 * Classifies the OLD / NEW identity diff of one naming scope by Machine Identity only:
 * a matching uuid is a rename (or keep / relabel) regardless of the name; a different uuid is
 * delete + add even when the name is the same. Names are never used to pair entries.
 *
 * Order: kept / renamed / relabeled and deleted entries in `before` order, then added entries
 * in `after` order.
 */
export function diffRegistryIdentities(before: readonly IRegistryIdentity[], after: readonly IRegistryIdentity[]): RegistryIdentityChange[] {
	const beforeIndex = indexByUuid(before, 'before');
	const afterIndex = indexByUuid(after, 'after');
	const changes: RegistryIdentityChange[] = [];
	for (const [uuid, old] of beforeIndex) {
		const next = afterIndex.get(uuid);
		if (!next) {
			changes.push({ kind: RegistryIdentityChangeKind.Delete, uuid, before: old });
		} else if (old.name !== next.name) {
			changes.push({ kind: RegistryIdentityChangeKind.Rename, uuid, before: old, after: next });
		} else if (getRegistryDisplayText(old) !== getRegistryDisplayText(next)) {
			changes.push({ kind: RegistryIdentityChangeKind.Relabel, uuid, before: old, after: next });
		} else {
			changes.push({ kind: RegistryIdentityChangeKind.Keep, uuid, before: old, after: next });
		}
	}
	for (const [uuid, next] of afterIndex) {
		if (!beforeIndex.has(uuid)) {
			changes.push({ kind: RegistryIdentityChangeKind.Add, uuid, after: next });
		}
	}
	return changes;
}

/**
 * Applies a rename: the Machine Identity is kept, only the Human Identifier changes.
 */
export function renameRegistryIdentity<T extends IRegistryIdentity>(identity: T, name: string): T {
	return Object.freeze({ ...identity, name: validateName(name) });
}

// #endregion

// #region Editor Display / Storage

/** `Editor Display = name / label`: label when present, otherwise name. Never the UUID. */
export function getRegistryDisplayText(identity: Pick<IRegistryIdentity, 'name' | 'label'>): string {
	return identity.label ? identity.label : identity.name;
}

/**
 * Looks up Registry identities by stored Machine Identity.
 * `Storage = UUID`: a stored UUID resolves to its identity and is displayed as name / label,
 * so a rename never rewrites what is stored. Names are not a lookup key.
 */
export class RegistryIdentityIndex {
	private readonly byUuid = new Map<string, IRegistryIdentity>();

	constructor(identities: readonly IRegistryIdentity[]) {
		for (const identity of identities) {
			const uuid = normalizeRegistryUuid(identity.uuid);
			if (this.byUuid.has(uuid)) {
				throw new RegistryIdentityError(`duplicate uuid for '${identity.name}'`);
			}
			this.byUuid.set(uuid, identity);
		}
	}

	/** Stored Machine Identity -> identity. */
	get(uuid: string): IRegistryIdentity | undefined {
		return isRegistryUuid(uuid) ? this.byUuid.get(uuid.toLowerCase()) : undefined;
	}

	/** Stored Machine Identity -> Editor Display. */
	display(uuid: string): string | undefined {
		const identity = this.get(uuid);
		return identity ? getRegistryDisplayText(identity) : undefined;
	}
}

// #endregion
