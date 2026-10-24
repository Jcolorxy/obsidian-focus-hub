import { ItemView, WorkspaceLeaf } from "obsidian";
import type TaskHubPlugin from "./main";
import type { Task } from "./types";
import { completionDay, historyModel, HISTORY_TIMEZONE, HistoryFilters } from "./history";

export const HISTORY_VIEW_TYPE = "task-hub-history";
const timestamp = new Intl.DateTimeFormat("en-GB", {
	timeZone: HISTORY_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric",
	hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

/** Read-only projection of saved tasks; filters are ephemeral view state. */
export class HistoryView extends ItemView {
	private filters: HistoryFilters = {};
	private results!: HTMLElement;
	constructor(leaf: WorkspaceLeaf, private plugin: TaskHubPlugin) { super(leaf); }
	getViewType() { return HISTORY_VIEW_TYPE; }
	getDisplayText() { return "Work history"; }
	getIcon() { return "history"; }
	async onOpen() { this.render(); }
	async onClose() { this.contentEl.empty(); }

	render() {
		this.contentEl.empty();
		const root = this.contentEl.createDiv({ cls: "th-history" });
		root.createEl("h2", { text: "Work history" });
		root.createEl("p", { cls: "th-history-help", text: `Completed work, not planned work. Read-only · ${HISTORY_TIMEZONE}. Only notes inside Work/ and its subfolders are included.` });
		const controls = root.createDiv({ cls: "th-history-filters" });
		const model = historyModel(this.plugin.data.tasks.filter(task => task.note?.startsWith("Work/")));
		const select = (label: string, options: [string, string][], value: string, change: (value: string) => void) => {
			const wrap = controls.createEl("label", { text: label });
			const el = wrap.createEl("select", { attr: { "aria-label": label } });
			for (const [value, text] of options) el.createEl("option", { text, attr: { value } });
			el.value = value;
			el.addEventListener("change", () => { change(el.value); this.renderResults(); });
		};
		select("Year", [["", "All years"], ...model.years.map(y => [y, y] as [string, string])], this.filters.year ?? "", v => this.filters.year = v);
		for (const [key, label] of [["from", "From date"], ["to", "To date"]] as const) {
			const wrap = controls.createEl("label", { text: label });
			const input = wrap.createEl("input", { type: "date", attr: { "aria-label": label } });
			input.value = this.filters[key] ?? "";
			input.addEventListener("change", () => { this.filters[key] = input.value; this.renderResults(); });
		}
		// Prefix paths to avoid collisions with the all/unlinked sentinel values.
		select("Linked project / note", [["", "All Work projects / notes"], ...model.notes.map(n => ["note:" + n, n] as [string, string])],
			this.filters.note === undefined ? "" : this.filters.note === null ? "unlinked" : "note:" + this.filters.note,
			v => this.filters.note = v === "" ? undefined : v === "unlinked" ? null : v.slice(5));
		controls.createEl("button", { text: "Clear filters" }).addEventListener("click", () => {
			this.filters = {};
			for (const el of Array.from(controls.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"))) el.value = "";
			this.renderResults();
		});
		this.results = root.createDiv({ cls: "th-history-results" });
		this.renderResults();
	}

	private renderResults() {
		this.results.empty();
		const model = historyModel(this.plugin.data.tasks.filter(task => task.note?.startsWith("Work/")), this.filters);
		const dated = model.months.reduce((sum, m) => sum + m.tasks.length, 0);
		this.results.createDiv({ cls: "th-history-summary", attr: { role: "status", "aria-live": "polite" },
			text: `${dated} dated completions shown · ${model.undated.length} with unknown dates · ${model.total} closed in total` });
		if (model.invalidRange) this.results.createEl("p", { attr: { role: "alert" }, text: "From date must be on or before To date." });
		if (!dated) this.results.createEl("p", { cls: "th-history-help", text: "No dated completions match these filters." });
		for (const month of model.months) {
			const label = new Date(month.month + "-15T12:00:00Z").toLocaleDateString("en-GB", { timeZone: HISTORY_TIMEZONE, month: "long", year: "numeric" });
			this.group(label, month.tasks);
		}
		if (model.undated.length) {
			this.results.createEl("p", { cls: "th-history-help", text: "Completion date unknown — these records match the note filter but cannot be placed in a month. They are not included in date-filtered counts; no dates have been inferred." });
			this.group("Completion date unknown", model.undated);
		}
	}

	private group(label: string, tasks: Task[]) {
		const section = this.results.createEl("section", { cls: "th-history-month", attr: { "aria-label": label } });
		section.createEl("h3", { text: `${label} · ${tasks.length}` });
		const list = section.createEl("ul", { cls: "th-history-timeline" });
		for (const task of tasks) {
			const card = list.createEl("li", { cls: "th-history-card" });
			card.createEl("h4", { text: task.title });
			if (completionDay(task)) card.createEl("time", { text: timestamp.format(task.closedAt!), attr: { datetime: new Date(task.closedAt!).toISOString() } });
			else card.createDiv({ cls: "th-history-help", text: "Completion date unknown" });
			if (task.note) {
				const note = task.note;
				card.createEl("button", { cls: "th-history-note", text: note }).addEventListener("click", () => void this.plugin.openPath(note));
			} else card.createDiv({ cls: "th-history-help", text: "No linked note" });
			const comments = (task.comments ?? []).filter(c => c.closeOut);
			if (!comments.length) card.createDiv({ cls: "th-history-help", text: "No close-out reflection recorded." });
			for (const comment of comments) {
				const evidence = card.createDiv({ cls: "th-history-evidence" });
				evidence.createEl("strong", { text: "Close-out reflection" });
				// Deliberately plain text, not HTML/Markdown: legacy evidence is untrusted.
				evidence.createEl("p", { text: comment.text });
			}
		}
	}
}
