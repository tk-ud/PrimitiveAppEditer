/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - roadmap Agent Tool
 *  Specification SSOT: docs/primitive-app-editor/Agent tool.md
 *--------------------------------------------------------------------------------------------*/

/**
 * An ATX heading of a Markdown document. `number` / `title` are set for numbered
 * headings such as `## 23. Runtime Addressing`.
 */
export interface IHeading {
	readonly line: number;
	readonly level: number;
	readonly text: string;
	readonly number: string | undefined;
	readonly title: string;
	/** Exclusive line index where this heading's section ends (next heading of the same or a higher level). */
	readonly end: number;
}

export interface IResolvedSection {
	readonly reference: string;
	readonly heading: IHeading;
	readonly content: string;
}

export class SectionResolutionError extends Error {
	constructor(readonly reference: string, readonly reason: string) {
		super(`${reference}: ${reason}`);
	}
}

const headingPattern = /^ {0,3}(?<hashes>#{1,6})[ \t]+(?<text>.*?)(?:[ \t]+#+)?[ \t]*$/;
const numberedTitlePattern = /^(?<number>\d+)\.[ \t]+(?<title>.+)$/;
const fencePattern = /^ {0,3}(?<fence>`{3,}|~{3,})/;
const sectionReferencePattern = /^§(?<number>\d+)[ \t]+(?<rest>.+)$/;

/**
 * Parse ATX headings, ignoring lines inside fenced code blocks.
 */
export function parseHeadings(lines: readonly string[]): IHeading[] {
	const found: { line: number; level: number; text: string }[] = [];
	let fence: string | undefined;
	lines.forEach((line, index) => {
		const fenceMatch = fencePattern.exec(line);
		if (fence) {
			if (fenceMatch?.groups && fenceMatch.groups.fence[0] === fence[0] && fenceMatch.groups.fence.length >= fence.length && line.trim() === fenceMatch.groups.fence) {
				fence = undefined;
			}
			return;
		}
		if (fenceMatch?.groups) {
			fence = fenceMatch.groups.fence;
			return;
		}
		const match = headingPattern.exec(line);
		if (match?.groups) {
			found.push({ line: index, level: match.groups.hashes.length, text: match.groups.text.trim() });
		}
	});

	return found.map((heading, index) => {
		let end = lines.length;
		for (let next = index + 1; next < found.length; next++) {
			if (found[next].level <= heading.level) {
				end = found[next].line;
				break;
			}
		}
		const numbered = numberedTitlePattern.exec(heading.text);
		return {
			...heading,
			number: numbered?.groups?.number,
			title: numbered?.groups ? numbered.groups.title.trim() : heading.text,
			end,
		};
	});
}

/**
 * read_markdown_sections: resolve each section reference of a roadmap bundle reference.
 *
 * Supported reference forms (as used by roadmap.yaml):
 * - `§N Title`        -> the numbered heading `N. Title`
 * - `§N Sub`          -> the unique heading `Sub` nested inside the numbered section N
 * - `§N Title / Sub`  -> the unique heading `Sub` nested inside the numbered section `N. Title`
 * - `Title`           -> the unique heading whose text is exactly `Title`
 *
 * A reference that does not resolve to exactly one heading is an error; nothing is guessed.
 */
export function resolveSections(markdown: string, references: readonly string[]): IResolvedSection[] {
	const lines = splitLines(markdown);
	const headings = parseHeadings(lines);
	return references.map(reference => {
		const heading = resolveHeading(headings, reference);
		return { reference, heading, content: sectionContent(lines, heading) };
	});
}

function resolveHeading(headings: readonly IHeading[], reference: string): IHeading {
	const trimmed = reference.trim();
	const sectionMatch = sectionReferencePattern.exec(trimmed);
	if (!sectionMatch?.groups) {
		return unique(headings.filter(heading => heading.text === trimmed), reference, `no heading '${trimmed}'`);
	}

	const { number, rest } = sectionMatch.groups;
	const numbered = headings.filter(heading => heading.number === number);
	const section = unique(numbered, reference, `no numbered heading '${number}.'`);
	if (section.title === rest) {
		return section;
	}

	const descendants = headings.filter(heading => heading.line > section.line && heading.line < section.end);
	const direct = descendants.filter(heading => heading.text === rest);
	if (direct.length) {
		return unique(direct, reference, '');
	}

	const prefix = `${section.title} / `;
	if (rest.startsWith(prefix)) {
		const sub = rest.slice(prefix.length);
		return unique(descendants.filter(heading => heading.text === sub), reference, `section '${section.text}' has no nested heading '${sub}'`);
	}

	throw new SectionResolutionError(reference, `section ${number} is '${section.text}', which is neither '${rest}' nor contains a nested heading '${rest}'`);
}

function unique(matches: readonly IHeading[], reference: string, notFound: string): IHeading {
	if (matches.length === 1) {
		return matches[0];
	}
	if (!matches.length) {
		throw new SectionResolutionError(reference, notFound);
	}
	throw new SectionResolutionError(reference, `ambiguous: matches headings at lines ${matches.map(heading => heading.line + 1).join(', ')}`);
}

function sectionContent(lines: readonly string[], heading: IHeading): string {
	const body = lines.slice(heading.line, heading.end);
	while (body.length && !body[body.length - 1].trim()) {
		body.pop();
	}
	return body.join('\n');
}

function splitLines(markdown: string): string[] {
	return markdown.replace(/\r\n?/g, '\n').split('\n');
}
