import { TFile } from "obsidian";
import type TaskHubPlugin from "./main";
import { Task } from "./types";
import { parseBlocks, tableToMarkdown } from "./tables";

/**
 * Marker that ties a note line to a task. An Obsidian comment (%% %%) is hidden in
 * reading view and in Live Preview unless the cursor is on the line.
 * Lines written by older versions used a block ID (^th-id); both forms are recognised.
 */
export const markFor = (id: string) => `%%th:${id}%%`;
/** Marker on a mirrored comment bullet. */
export const commentMarkFor = (id: string) => `%%thc:${id}%%`;
const COMMENT_MARK_RE = /%%thc:([a-z0-9-]+)%%/;
const LINE_RE = /^(\s*)- \[([ xX])\] (.*)$/;
const MARK_RE = /\s*(?:%%th:([a-z0-9-]+)%%|\^th-([a-z0-9-]+))/;
/** Task id on a checkbox line, wherever the marker sits (other plugins may append after it). */
const lineId = (l: string): string | undefined => {
	if (!LINE_RE.test(l)) return undefined;
	const m = MARK_RE.exec(l);
	return m ? m[1] ?? m[2] : undefined;
};

function fmtDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function lineFor(task: Task, indent = ""): string {
	const box = task.status === "closed" ? "x" : " ";
	let text = task.title;
	if (task.status === "hold") text += " ⏸";
	if (task.due) text += ` 📅 ${task.due}`;
	if (task.status === "closed" && task.closedAt) text += ` ✅ ${fmtDate(task.closedAt)}`;
	return `${indent}- [${box}] ${text} ${markFor(task.id)}`;
}

/**
 * The lines that mirror a task's comments: bullets indented under the task line,
 * followed by any tables. Obsidian does not render a table nested inside a list
 * item, so tables are emitted at the top level right after the bullets.
 */
function commentLinesFor(task: Task, taskIndent: string): string[] {
	const indent = `${taskIndent}\t`;
	const bullets: string[] = [];
	const tables: string[] = [];
	for (const c of task.comments) {
		const prefix = c.closeOut ? "✅ **Close-out:** " : "💬 ";
		let headline = "";
		const extra: string[] = [];
		for (const block of parseBlocks(c.text)) {
			if (block.kind === "text") {
				const lines = [...block.lines];
				if (!headline && lines.length) headline = lines.shift()!;
				// continuation lines stay part of the bullet, and are markerless so they
				// are recognised as ours when the block is rewritten
				for (const line of lines) extra.push(`${indent}  ${line}`);
			} else {
				if (!headline) headline = "(table)";
				if (tables.length) tables.push("");
				tables.push(...tableToMarkdown(block.rows, ""));
			}
		}
		bullets.push(`${indent}- ${prefix}${headline} ${commentMarkFor(c.id)}`);
		bullets.push(...extra);
	}
	return tables.length ? [...bullets, "", ...tables] : bullets;
}

/** Indentation width of a line, counting a tab as 4 columns. */
function indentWidth(line: string): number {
	const ws = /^[ \t]*/.exec(line)![0];
	return ws.replace(/\t/g, "    ").length;
}

const BULLET_RE = /^[ \t]*(?:[-*+]|\d+\.)\s/;

/**
 * Length of the mirrored comment block that follows the task line at `taskIdx`.
 * Only lines we wrote are counted: a bullet carrying a comment marker, plus the
 * deeper-indented, non-bullet continuation lines of such a bullet. Anything else
 * stops the scan, so hand-written sub-bullets in the note are left alone.
 */
function commentBlockLength(lines: string[], taskIdx: number): number {
	let n = 0;
	let bulletIndent = -1;
	const isTableRow = (line: string) => /^[ \t]*\|.*\|\s*$/.test(line);
	const isOurs = (line: string) =>
		COMMENT_MARK_RE.test(line) ||
		isTableRow(line) ||
		(!BULLET_RE.test(line) && line.trim() !== "" && indentWidth(line) > bulletIndent);
	for (let i = taskIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (COMMENT_MARK_RE.test(line)) {
			bulletIndent = indentWidth(line);
			n = i - taskIdx;
			continue;
		}
		if (bulletIndent < 0) break;
		if (line.trim() === "") {
			// a blank line is ours only when more of the block follows it
			const rest = lines.slice(i + 1).findIndex((l) => l.trim() !== "");
			if (rest < 0) break;
			if (isOurs(lines[i + 1 + rest])) continue;
			break;
		}
		if (!isOurs(line)) break;
		n = i - taskIdx;
	}
	return n;
}

/** Mirrors tasks into their linked notes and reads checkbox changes back. */
export class NoteSync {
	constructor(private plugin: TaskHubPlugin) {}

	private get enabled() {
		return this.plugin.data.settings.mirrorToNote;
	}

	private file(path: string | null): TFile | null {
		if (!path) return null;
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile && f.extension === "md" ? f : null;
	}

	/** Add the task's line to its note if not already there; update it if it is. */
	async ensure(task: Task, force = false) {
		if (!this.enabled && !force) return;
		const file = this.file(task.note);
		if (!file) return;
		const heading = this.plugin.data.settings.noteHeading.trim();
		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const idx = lines.findIndex((l) => lineId(l) === task.id);
			if (idx >= 0) {
				lines[idx] = lineFor(task, LINE_RE.exec(lines[idx])![1]);
				return lines.join("\n");
			}
			if (!heading) {
				// no heading configured: append to end of note
				return content.replace(/\s*$/, "") + `\n${lineFor(task)}\n`;
			}
			const headRe = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
			const h = lines.findIndex((l) => headRe.test(l));
			if (h < 0) {
				return content.replace(/\s*$/, "") + `\n\n## ${heading}\n${lineFor(task)}\n`;
			}
			// insert after the last task line directly under the heading (before the next heading)
			let end = h + 1;
			while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
			let insertAt = end;
			while (insertAt > h + 1 && lines[insertAt - 1].trim() === "") insertAt--;
			lines.splice(insertAt, 0, lineFor(task));
			return lines.join("\n");
		});
		await this.syncComments(task);
	}

	/** Rewrite the comment bullets under a task's mirrored line. */
	async syncComments(task: Task) {
		if (!this.enabled || !this.plugin.data.settings.mirrorComments) return;
		const file = this.file(task.note);
		if (!file) return;
		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const idx = lines.findIndex((l) => lineId(l) === task.id);
			if (idx < 0) return content;
			const indent = LINE_RE.exec(lines[idx])![1];
			lines.splice(idx + 1, commentBlockLength(lines, idx), ...commentLinesFor(task, indent));
			return lines.join("\n");
		});
	}

	/** Update an existing mirrored line; does nothing if the note has no line for this task. */
	async update(task: Task) {
		if (!this.enabled) return;
		const file = this.file(task.note);
		if (!file) return;
		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const idx = lines.findIndex((l) => lineId(l) === task.id);
			if (idx < 0) return content;
			lines[idx] = lineFor(task, LINE_RE.exec(lines[idx])![1]);
			return lines.join("\n");
		});
	}

	/** Remove the mirrored line for a task id from a note. */
	async remove(notePath: string | null, taskId: string) {
		if (!this.enabled) return;
		const file = this.file(notePath);
		if (!file) return;
		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const idx = lines.findIndex((l) => lineId(l) === taskId);
			if (idx < 0) return content;
			// take the task's comment bullets with it
			lines.splice(idx, 1 + commentBlockLength(lines, idx));
			return lines.join("\n");
		});
	}

	/** Called on vault 'modify': pull checkbox state from the note back into the hub. */
	async pull(file: TFile) {
		if (!this.enabled) return;
		if (!this.plugin.data.tasks.some((t) => t.note === file.path)) return;
		const content = await this.plugin.app.vault.cachedRead(file);
		let changed = false;
		const touched: Task[] = [];
		for (const line of content.split("\n")) {
			const id = lineId(line);
			const m = LINE_RE.exec(line);
			if (!id || !m) continue;
			const task = this.plugin.getTask(id);
			if (!task || task.note !== file.path) continue;
			const checked = m[2] !== " ";
			if (checked && task.status !== "closed") {
				task.status = "closed";
				task.closedAt = task.updated = Date.now();
				changed = true;
				touched.push(task);
			} else if (!checked && task.status === "closed") {
				task.status = "open";
				task.updated = Date.now();
				changed = true;
				touched.push(task);
			}
		}
		if (!changed) return;
		await this.plugin.save();
		// write back so the line gains/loses its ✅ date
		for (const t of touched) await this.update(t);
	}
}
