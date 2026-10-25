import { App, FuzzyMatch, FuzzySuggestModal, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type TaskHubPlugin from "./main";
import { Task, basename, formatDate, isImagePath, todayISO } from "./types";
import { computeSchedule } from "./schedule";

/** Sentinel item in the note picker that opens the "create note" dialog. */
const NEW_NOTE = Symbol("new-note");
type NoteChoice = TFile | typeof NEW_NOTE;

/** A value the date field is clearly finished with: full ISO date, sensible year. */
export function isCompleteDate(v: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	if (!m) return false;
	const year = Number(m[1]);
	return year >= 1900 && year <= 2100;
}

/**
 * Date fields report every keystroke — typing "2027" passes through 0002, 0020 and
 * 0202 on the way — so saving on each change stored those and redrew the dialog
 * under the cursor. A value is only committed when the field is left or Enter is
 * pressed, and only if its year is plausible.
 */
export function bindDate(input: HTMLInputElement, initial: string | null, commit: (v: string | null) => void): () => boolean {
	input.type = "date";
	input.value = initial ?? "";
	let last = input.value;
	const done = (): boolean => {
		const v = input.value;
		if (v === last) return true;
		if (v && !isCompleteDate(v)) {
			new Notice("That date doesn't look finished — check the year.");
			input.value = last;
			return false;
		}
		last = v;
		commit(v || null);
		return true;
	};
	input.addEventListener("blur", () => void done());
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") done();
	});
	return done;
}

/** Pick a markdown note from the vault (master-list notes first), or create a new one. */
export class NotePickerModal extends FuzzySuggestModal<NoteChoice> {
	private query = "";
	constructor(app: App, private plugin: TaskHubPlugin, private onPick: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Link to note page… (or type a name to create one)");
	}
	getItems(): NoteChoice[] {
		const files = this.app.vault.getMarkdownFiles();
		const master = new Set(this.plugin.data.notes);
		return files.sort((a, b) => {
			const am = master.has(a.path) ? 0 : 1;
			const bm = master.has(b.path) ? 0 : 1;
			return am - bm || a.basename.localeCompare(b.basename);
		});
	}
	getItemText(item: NoteChoice): string {
		if (item === NEW_NOTE) return "";
		return this.plugin.data.notes.includes(item.path) ? `★ ${item.path}` : item.path;
	}
	getSuggestions(query: string): FuzzyMatch<NoteChoice>[] {
		this.query = query.trim();
		const res = super.getSuggestions(query);
		res.push({ item: NEW_NOTE, match: { score: -Infinity, matches: [] } });
		return res;
	}
	renderSuggestion(item: FuzzyMatch<NoteChoice>, el: HTMLElement) {
		if (item.item === NEW_NOTE) {
			el.addClass("task-hub-new-note-suggestion");
			el.setText(this.query ? `＋ Create new note "${this.query}"…` : "＋ Create new note…");
			return;
		}
		super.renderSuggestion(item, el);
	}
	onChooseItem(item: NoteChoice) {
		if (item === NEW_NOTE) {
			new NewNoteModal(this.app, this.plugin, this.query, this.onPick).open();
			return;
		}
		this.onPick(item);
	}
}

/** Create a new markdown note: name + folder, then hand the file back. */
export class NewNoteModal extends Modal {
	private name: string;
	private folder: string;
	constructor(app: App, private plugin: TaskHubPlugin, initialName: string, private onCreated: (file: TFile) => void) {
		super(app);
		this.name = initialName;
		const active = this.app.workspace.getActiveFile();
		this.folder = this.app.fileManager.getNewFileParent(active?.path ?? "").path;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "New note" });
		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("Note name").setValue(this.name).onChange((v) => (this.name = v));
			t.inputEl.addClass("task-hub-modal-title");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); void this.submit(); }
			});
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		new Setting(contentEl).setName("Folder").addDropdown((d) => {
			const folders = this.app.vault.getAllFolders(true).sort((a, b) => a.path.localeCompare(b.path));
			for (const f of folders) d.addOption(f.path, f.path === "/" || f.path === "" ? "/ (vault root)" : f.path);
			d.setValue(this.folder).onChange((v) => (this.folder = v));
		});
		new Setting(contentEl).addButton((b) => b.setButtonText("Create & link").setCta().onClick(() => void this.submit()));
	}
	private async submit() {
		const name = this.name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\.md$/i, "");
		if (!name) { new Notice("Note needs a name"); return; }
		const dir = this.folder === "/" ? "" : this.folder;
		const path = normalizePath(dir ? `${dir}/${name}.md` : `${name}.md`);
		const existing = this.app.vault.getAbstractFileByPath(path);
		let file: TFile;
		if (existing instanceof TFile) {
			new Notice(`"${name}" already exists there — linking to it`);
			file = existing;
		} else if (existing) {
			new Notice(`A folder named "${name}" is in the way`);
			return;
		} else {
			file = await this.app.vault.create(path, "");
			new Notice(`Created ${path}`);
		}
		await this.plugin.addNote(file.path);
		this.close();
		this.onCreated(file);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Pick an existing image file from the vault. */
export class ImagePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Attach image from vault…");
	}
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => isImagePath(f.path)).sort((a, b) => b.stat.mtime - a.stat.mtime);
	}
	getItemText(file: TFile): string {
		return file.path;
	}
	onChooseItem(file: TFile) {
		this.onPick(file);
	}
}

/** Create-task dialog used by the commands. */
export class TaskModal extends Modal {
	private title = "";
	private type: string | null = null;
	private note: string | null;
	private due: string | null = null;

	constructor(app: App, private plugin: TaskHubPlugin, preset: { note?: string; type?: string } = {}) {
		super(app);
		this.note = preset.note ?? null;
		this.type = preset.type ?? null;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "New task" });

		new Setting(contentEl).setName("Title").addText((t) => {
			t.setPlaceholder("What needs doing?").onChange((v) => (this.title = v));
			t.inputEl.addClass("task-hub-modal-title");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); this.submit(); }
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(contentEl).setName("Type").addDropdown((d) => {
			d.addOption("", "— none —");
			for (const t of this.plugin.data.types) d.addOption(t, t);
			d.setValue(this.type ?? "").onChange((v) => (this.type = v || null));
		});

		const noteSetting = new Setting(contentEl).setName("Note page");
		const renderNote = () => {
			noteSetting.setDesc(this.note ? basename(this.note) : "Not linked");
		};
		renderNote();
		noteSetting.addButton((b) =>
			b.setButtonText("Choose…").onClick(() =>
				new NotePickerModal(this.app, this.plugin, (f) => { this.note = f.path; renderNote(); }).open(),
			),
		);
		noteSetting.addExtraButton((b) => b.setIcon("x").setTooltip("Unlink").onClick(() => { this.note = null; renderNote(); }));

		new Setting(contentEl).setName("Due date").addText((t) => {
			bindDate(t.inputEl, this.due, (v) => (this.due = v));
		});

		new Setting(contentEl).addButton((b) => b.setButtonText("Add task").setCta().onClick(() => this.submit()));
	}

	private async submit() {
		if (!this.title.trim()) { new Notice("Task needs a title"); return; }
		await this.plugin.addTask({ title: this.title, type: this.type, note: this.note, due: this.due });
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Simple single-line text prompt. */
export class PromptModal extends Modal {
	private value: string;
	constructor(app: App, private heading: string, initial: string, private onSubmit: (v: string) => void) {
		super(app);
		this.value = initial;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.heading });
		new Setting(contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.addClass("task-hub-modal-title");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); this.submit(); }
			});
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		new Setting(contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(() => this.submit()));
	}
	private submit() {
		if (this.value.trim()) this.onSubmit(this.value.trim());
		this.close();
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Multi-line comment prompt; resolves with null when skipped. */
export class CommentModal extends Modal {
	private value: string;
	private submitted = false;
	constructor(
		app: App,
		private heading: string,
		private opts: { initial?: string; placeholder?: string; submitLabel?: string; skipLabel?: string },
		private onSubmit: (v: string | null) => void,
	) {
		super(app);
		this.value = opts.initial ?? "";
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.heading });
		const ta = contentEl.createEl("textarea", { cls: "task-hub-comment-input", attr: { rows: "5", placeholder: this.opts.placeholder ?? "" } });
		ta.value = this.value;
		ta.addEventListener("input", () => (this.value = ta.value));
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.submit(this.value); }
			if (e.key === "Escape") { e.preventDefault(); this.submit(null); }
		});
		window.setTimeout(() => ta.focus(), 0);
		const row = new Setting(contentEl);
		row.addButton((b) => b.setButtonText(this.opts.skipLabel ?? "Skip").onClick(() => this.submit(null)));
		row.addButton((b) => b.setButtonText(this.opts.submitLabel ?? "Save").setCta().onClick(() => this.submit(this.value)));
		contentEl.createDiv({ cls: "setting-item-description", text: "Ctrl+Enter to save · Esc to skip" });
	}
	private submit(v: string | null) {
		if (this.submitted) return;
		this.submitted = true;
		this.onSubmit(v && v.trim() ? v.trim() : null);
		this.close();
	}
	onClose() {
		if (!this.submitted) { this.submitted = true; this.onSubmit(null); }
		this.contentEl.empty();
	}
}

/** Pick or clear a due date, with quick presets. */
export class DueDateModal extends Modal {
	private value: string;
	constructor(app: App, initial: string | null, private onSubmit: (v: string | null) => void) {
		super(app);
		this.value = initial ?? "";
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Due date" });
		const presets = contentEl.createDiv({ cls: "task-hub-due-presets" });
		const preset = (label: string, days: number) =>
			presets.createEl("button", { text: label }).addEventListener("click", () => this.done(todayISO(days)));
		preset("Today", 0);
		preset("Tomorrow", 1);
		preset("In 3 days", 3);
		preset("Next week", 7);
		preset("In 2 weeks", 14);
		let input!: HTMLInputElement;
		new Setting(contentEl).setName("Pick a date").addText((t) => {
			input = t.inputEl;
			const commit = bindDate(input, this.value || null, (v) => (this.value = v ?? ""));
			input.addEventListener("keydown", (e) => {
				if (e.key !== "Enter") return;
				e.preventDefault();
				if (commit()) this.done(this.value || null);
			});
			window.setTimeout(() => input.focus(), 0);
		});
		const row = new Setting(contentEl);
		row.addButton((b) => b.setButtonText("Clear").setWarning().onClick(() => this.done(null)));
		row.addButton((b) => b.setButtonText("Set").setCta().onClick(() => this.done(this.value || null)));
	}
	private done(v: string | null) {
		this.onSubmit(v);
		this.close();
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Choose a backup file to restore from. */
export class BackupPickerModal extends FuzzySuggestModal<string> {
	constructor(app: App, private backups: string[], private onPick: (path: string) => void) {
		super(app);
		this.setPlaceholder(backups.length ? "Restore which backup? (replaces current data)" : "No backups found yet");
	}
	getItems(): string[] {
		return this.backups;
	}
	getItemText(path: string): string {
		return formatDate(basename(path).replace(/^data-/, "").replace(/\.json$/, ""));
	}
	onChooseItem(path: string) {
		this.onPick(path);
	}
}

/** Pick another task (for prerequisites). */
export class TaskPickerModal extends FuzzySuggestModal<Task> {
	constructor(app: App, private tasks: Task[], private onPick: (task: Task) => void, placeholder = "Choose a task…") {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): Task[] {
		return this.tasks;
	}
	getItemText(task: Task): string {
		return [task.title, task.type, task.note ? basename(task.note) : ""].filter(Boolean).join(" · ");
	}
	onChooseItem(task: Task) {
		this.onPick(task);
	}
}

/** Start date, duration and prerequisites for one task. */
export class ScheduleModal extends Modal {
	constructor(app: App, private plugin: TaskHubPlugin, private task: Task, private onDone?: () => void) {
		super(app);
	}

	onOpen() {
		this.draw();
	}

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		const task = this.plugin.getTask(this.task.id) ?? this.task;
		contentEl.createEl("h3", { text: task.title });

		const startSetting = new Setting(contentEl)
			.setName("Start")
			.setDesc(this.startDescription(task))
			.addText((t) => {
				bindDate(t.inputEl, task.start, async (v) => {
					await this.plugin.setSchedule(task.id, { start: v });
					this.onDone?.();
					// refresh just the explanation, so tabbing on to the next field keeps focus
					startSetting.setDesc(this.startDescription(this.plugin.getTask(task.id) ?? task));
				});
			});

		new Setting(contentEl)
			.setName("Duration (days)")
			.setDesc("Leave empty for one day, or for the span between start and due.")
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.setValue(task.durationDays ? String(task.durationDays) : "").onChange(async (v) => {
					const n = Number(v);
					await this.plugin.setSchedule(task.id, { durationDays: v && n > 0 ? Math.round(n) : null });
					this.onDone?.();
				});
			});

		new Setting(contentEl).setName("Due").addText((t) => {
			bindDate(t.inputEl, task.due, async (v) => {
				await this.plugin.updateTask(task.id, { due: v });
				this.onDone?.();
			});
		});

		new Setting(contentEl)
			.setName("Milestone")
			.setDesc("A dated marker with no duration — an approval, a delivery, a gate.")
			.addToggle((t) => t.setValue(task.milestone).onChange(async (v) => { await this.plugin.updateTask(task.id, { milestone: v }); this.onDone?.(); }));

		new Setting(contentEl)
			.setName("Progress")
			.setDesc("Percent complete. Closed tasks always count as 100%.")
			.addSlider((sl) =>
				sl.setLimits(0, 100, 5).setValue(task.percent ?? 0).setDynamicTooltip().onChange(async (v) => {
					await this.plugin.updateTask(task.id, { percent: v });
					this.onDone?.();
				}),
			);

		new Setting(contentEl)
			.setName("Phase")
			.setDesc("Groups rows on the timeline, with a summary bar per phase.")
			.addText((t) => {
				t.setPlaceholder("e.g. Quoting").setValue(task.phase ?? "");
				t.inputEl.setAttr("list", "task-hub-phases");
				const list = contentEl.createEl("datalist");
				list.id = "task-hub-phases";
				for (const ph of Array.from(new Set(this.plugin.data.tasks.map((x) => x.phase).filter(Boolean))) as string[]) {
					list.createEl("option", { value: ph });
				}
				t.onChange(async (v) => { await this.plugin.updateTask(task.id, { phase: v.trim() || null }); this.onDone?.(); });
			});

		new Setting(contentEl).setName("Owner").addText((t) => {
			t.setPlaceholder("Who is doing it").setValue(task.owner ?? "");
			t.inputEl.setAttr("list", "task-hub-owners");
			const list = contentEl.createEl("datalist");
			list.id = "task-hub-owners";
			for (const ow of Array.from(new Set(this.plugin.data.tasks.map((x) => x.owner).filter(Boolean))) as string[]) {
				list.createEl("option", { value: ow });
			}
			t.onChange(async (v) => { await this.plugin.updateTask(task.id, { owner: v.trim() || null }); this.onDone?.(); });
		});

		if (task.baseline) {
			new Setting(contentEl)
				.setName("Baseline")
				.setDesc(`Agreed ${formatDate(task.baseline.start)} → ${formatDate(task.baseline.end)}`)
				.addExtraButton((b) => b.setIcon("x").setTooltip("Clear baseline").onClick(async () => { await this.plugin.clearBaseline([task.id]); this.onDone?.(); this.draw(); }));
		}

		new Setting(contentEl).setName("Prerequisites").setHeading();
		const deps = task.deps ?? [];
		if (!deps.length) contentEl.createEl("p", { cls: "setting-item-description", text: "None — this task can start straight away." });
		for (const id of deps) {
			const dep = this.plugin.getTask(id);
			const lag = task.depLags?.[id] ?? 0;
			new Setting(contentEl)
				.setName(dep?.title ?? "(deleted task)")
				.setDesc(dep ? [dep.type, dep.due ? `due ${formatDate(dep.due)}` : ""].filter(Boolean).join(" · ") : "")
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "0";
					t.inputEl.addClass("task-hub-lag");
					t.inputEl.title = "Waiting days after this prerequisite finishes";
					t.setPlaceholder("lag").setValue(lag ? String(lag) : "").onChange(async (v) => {
						await this.plugin.setDepLag(task.id, id, Number(v) || 0);
						this.onDone?.();
					});
				})
				.addExtraButton((b) => b.setIcon("x").setTooltip("Remove").onClick(async () => {
					await this.plugin.setDeps(task.id, deps.filter((d) => d !== id));
					this.onDone?.();
					this.draw();
				}));
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Add prerequisites…").onClick(() => {
				const candidates = this.plugin.data.tasks.filter((t) => t.id !== task.id && !deps.includes(t.id) && !this.wouldCycle(task.id, t.id));
				new PrerequisitePickerModal(this.app, task, candidates, async (picked) => {
					await this.plugin.setDeps(task.id, [...deps, ...picked]);
					this.onDone?.();
					this.draw();
				}).open();
			}),
		);
	}

	/**
	 * With no start date the task starts the working day after its last prerequisite
	 * finishes. Say which date that is, and which prerequisite sets it, rather than
	 * leaving the field blank as if nothing were planned.
	 */
	private startDescription(task: Task): string {
		if (task.start) return "Clear it to start automatically when the prerequisites finish.";
		if (!task.deps?.length) return "Leave empty to start when the prerequisites finish.";
		const rows = computeSchedule(this.plugin.data.tasks, todayISO(), this.plugin.calendar);
		const me = rows.find((r) => r.task.id === task.id);
		if (!me) return "Starts when the prerequisites finish.";
		const byId = new Map(rows.map((r) => [r.task.id, r]));
		const driver = me.deps
			.map((id) => byId.get(id))
			.filter((r): r is NonNullable<typeof r> => !!r)
			.reduce<{ title: string; end: string } | null>((acc, r) => (!acc || r.end > acc.end ? { title: r.task.title, end: r.end } : acc), null);
		return driver
			? `Automatic: ${formatDate(me.start)} — the working day after “${driver.title}” finishes (${formatDate(driver.end)}).`
			: `Automatic: ${formatDate(me.start)}.`;
	}

	/** True when making `candidate` a prerequisite of `id` would close a loop. */
	private wouldCycle(id: string, candidate: string): boolean {
		const seen = new Set<string>();
		const walk = (from: string): boolean => {
			if (from === id) return true;
			if (seen.has(from)) return false;
			seen.add(from);
			return (this.plugin.getTask(from)?.deps ?? []).some(walk);
		};
		return walk(candidate);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Choose one or more prerequisites, narrowed by note. */
export class PrerequisitePickerModal extends Modal {
	private chosen = new Set<string>();
	private note: string | "*";
	private query = "";

	constructor(app: App, private task: Task, private candidates: Task[], private onAdd: (ids: string[]) => void) {
		super(app);
		// most prerequisites live in the same project, so start there
		this.note = task.note && candidates.some((c) => c.note === task.note) ? task.note : "*";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("task-hub-prereq");
		contentEl.createEl("h3", { text: `“${this.task.title}” starts after…` });

		const controls = contentEl.createDiv({ cls: "task-hub-prereq-controls" });

		const noteSelect = controls.createEl("select", { cls: "dropdown" });
		const notes = Array.from(new Set(this.candidates.map((c) => c.note).filter((n): n is string => !!n))).sort((a, b) =>
			basename(a).localeCompare(basename(b)),
		);
		noteSelect.createEl("option", { value: "*", text: "All notes" });
		for (const n of notes) {
			const count = this.candidates.filter((c) => c.note === n).length;
			noteSelect.createEl("option", { value: n, text: `${basename(n)} (${count})` });
		}
		noteSelect.value = this.note;
		noteSelect.addEventListener("change", () => { this.note = noteSelect.value as string; this.drawList(); });

		const search = controls.createEl("input", { type: "search", placeholder: "Search tasks…" });
		search.addEventListener("input", () => { this.query = search.value; this.drawList(); });

		contentEl.createDiv({ cls: "task-hub-prereq-list" });

		const footer = new Setting(contentEl);
		footer.addExtraButton((b) => b.setIcon("x-circle").setTooltip("Clear selection").onClick(() => { this.chosen.clear(); this.drawList(); }));
		footer.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		footer.addButton((b) => {
			this.addBtn = b;
			b.setButtonText("Add").setCta().onClick(() => {
				if (!this.chosen.size) return;
				this.onAdd(Array.from(this.chosen));
				this.close();
			});
		});

		this.drawList();
		window.setTimeout(() => search.focus(), 0);
	}

	private addBtn?: { setButtonText(t: string): unknown; setDisabled(v: boolean): unknown };

	private visible(): Task[] {
		const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
		return this.candidates
			.filter((t) => this.note === "*" || t.note === this.note)
			.filter((t) => {
				if (!terms.length) return true;
				const hay = [t.title, t.type ?? "", t.note ? basename(t.note) : ""].join(" ").toLowerCase();
				return terms.every((term) => hay.includes(term));
			})
			.sort((a, b) => a.title.localeCompare(b.title));
	}

	private drawList() {
		const list = this.contentEl.querySelector<HTMLElement>(".task-hub-prereq-list");
		if (!list) return;
		list.empty();
		const rows = this.visible();
		if (!rows.length) {
			list.createDiv({ cls: "task-hub-prereq-empty", text: "No tasks match." });
		}
		for (const t of rows) {
			const row = list.createDiv({ cls: "task-hub-prereq-row" });
			const label = row.createEl("label");
			const cb = label.createEl("input", { type: "checkbox" });
			cb.checked = this.chosen.has(t.id);
			cb.addEventListener("change", () => {
				if (cb.checked) this.chosen.add(t.id);
				else this.chosen.delete(t.id);
				this.updateButton();
			});
			const text = label.createDiv({ cls: "task-hub-prereq-text" });
			text.createDiv({ cls: "task-hub-prereq-title", text: t.title });
			const meta = [t.type, t.note && this.note === "*" ? basename(t.note) : "", t.due ? `due ${formatDate(t.due)}` : "", t.status === "closed" ? "closed" : ""]
				.filter(Boolean)
				.join(" · ");
			if (meta) text.createDiv({ cls: "task-hub-prereq-meta", text: meta });
		}
		this.updateButton();
	}

	private updateButton() {
		const n = this.chosen.size;
		this.addBtn?.setButtonText(n ? `Add ${n} prerequisite${n === 1 ? "" : "s"}` : "Add");
		this.addBtn?.setDisabled(n === 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
