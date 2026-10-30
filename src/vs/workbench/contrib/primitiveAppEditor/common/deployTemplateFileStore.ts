/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Editor-wide Deploy Template storage (build.deploy-template-registrar)
 *  Specification SSOT: docs/primitive-app-editor/Deploy Configuration.md (3.3 Editor Template Registry)
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IUserDeployTemplateDocument } from './deployProjection.js';
import { IDeployTemplateStore } from './deployTemplateService.js';

/**
 * Stores user-defined Deploy Templates as `<id>.yml` documents in one directory of the Editor's global
 * storage: project independent, and separate from `project.sqlite`, the Application Registry and the project
 * `config/`. Writes go to a temporary file first and replace the target by a move, so a reader sees the previous
 * or the new document and never a partial one.
 */
export class DeployTemplateFileStore implements IDeployTemplateStore {

	constructor(private readonly fileService: IFileService, private readonly directory: URI) { }

	async list(): Promise<readonly IUserDeployTemplateDocument[]> {
		let stat;
		try {
			stat = await this.fileService.resolve(this.directory);
		} catch (error) {
			if (toFileOperationResult(error as Error) === FileOperationResult.FILE_NOT_FOUND) {
				return [];
			}
			throw error;
		}
		const documents: IUserDeployTemplateDocument[] = [];
		const files = (stat.children ?? []).filter(child => child.isFile && /\.ya?ml$/.test(child.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const file of files) {
			const content = await this.fileService.readFile(file.resource);
			documents.push({ source: file.name.replace(/\.ya?ml$/, ''), text: content.value.toString() });
		}
		return documents;
	}

	async write(source: string, text: string): Promise<void> {
		this.checkSource(source);
		const target = joinPath(this.directory, `${source}.yml`);
		const temporary = joinPath(this.directory, `${source}.yml.tmp`);
		await this.fileService.writeFile(temporary, VSBuffer.fromString(text));
		await this.fileService.move(temporary, target, true);
	}

	async delete(source: string): Promise<void> {
		this.checkSource(source);
		for (const extension of ['yml', 'yaml']) {
			const resource = joinPath(this.directory, `${source}.${extension}`);
			if (await this.fileService.exists(resource)) {
				await this.fileService.del(resource);
			}
		}
	}

	private checkSource(source: string): void {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(source) || source.includes('..')) {
			throw new Error(`Primitive App Editor deploy: '${source}' is not a valid Template storage name`);
		}
	}
}
