/** A run of tab-separated lines inside a comment, rendered as a table. */
export interface TableBlock {
	kind: "table";
	rows: string[][];
}
export interface TextBlock {
	kind: "text";
	lines: string[];
}
export type Block = TableBlock | TextBlock;

const cells = (line: string) => line.split("\t");
const isTabular = (line: string) => line.includes("\t") && cells(line).filter((c) => c.trim()).length >= 2;

/** Split comment text into plain-text runs and tab-separated table runs. */
export function parseBlocks(text: string): Block[] {
	const out: Block[] = [];
	let run: string[] = [];
	const flushText = () => {
		if (run.length) out.push({ kind: "text", lines: run });
		run = [];
	};
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!isTabular(lines[i])) { run.push(lines[i]); continue; }
		// collect the whole tabular run, allowing blank lines between rows
		const rows: string[][] = [];
		let j = i;
		for (; j < lines.length; j++) {
			if (isTabular(lines[j])) rows.push(cells(lines[j]));
			else if (lines[j].trim() === "" && j + 1 < lines.length && isTabular(lines[j + 1])) continue;
			else break;
		}
		if (rows.length < 2) { run.push(lines[i]); continue; } // a lone tabbed line is just text
		flushText();
		out.push({ kind: "table", rows: normalise(rows) });
		i = j - 1;
	}
	flushText();
	return out;
}

/** Pad rows to equal width and drop columns that are empty everywhere. */
function normalise(rows: string[][]): string[][] {
	const width = Math.max(...rows.map((r) => r.length));
	const padded = rows.map((r) => [...r.map((c) => c.trim()), ...Array(width - r.length).fill("")]);
	const keep = Array.from({ length: width }, (_, c) => padded.some((r) => r[c] !== ""));
	return padded.map((r) => r.filter((_, c) => keep[c]));
}

/** Markdown table lines (first row is the header), each prefixed with `indent`. */
export function tableToMarkdown(rows: string[][], indent: string): string[] {
	const esc = (c: string) => c.replace(/\|/g, "\\|") || " ";
	const [head, ...body] = rows;
	return [
		`${indent}| ${head.map(esc).join(" | ")} |`,
		`${indent}| ${head.map(() => "---").join(" | ")} |`,
		...body.map((r) => `${indent}| ${r.map(esc).join(" | ")} |`),
	];
}
