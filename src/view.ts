import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type TaskHubPlugin from "./main";
import { CommentModal, DueDateModal, ImagePickerModal, NotePickerModal, ScheduleModal } from "./modals";
import { Comment, GAP_LABEL, STATUSES, Status, Task, basename, daysUntil, dueLabel, formatDate, formatDateTime, schedulingGap } from "./types";
import { parseBlocks } from "./tables";
import { countProgress, renderMeter } from "./progress";

export const VIEW_TYPE = "task-hub-view";

/** Comment body: plain text, with tab-separated runs shown as tables. */
function renderCommentText(parent: HTMLElement, text: string) {
	for (const block of parseBlocks(text)) {
		if (block.kind === "text") {
			const t = block.lines.join("\n").trim();
			if (t) parent.createDiv({ cls: "task-hub-comment-para", text: t });
			continue;
		}
		const [head, ...rows] = block.rows;
		const table = parent.createEl("table", { cls: "task-hub-comment-table" });
		const hr = table.createEl("thead").createEl("tr");
		for (const cell of head) hr.createEl("th", { text: cell });
		const tbody = table.createEl("tbody");
		for (const row of rows) {
			const tr = tbody.createEl("tr");
			for (const cell of row) tr.createEl("td", { text: cell });
		}
	}
}

export class TaskHubView extends ItemView {
	private root!: HTMLElement;
	private draftTitle = "";
	private draftType: string | null = null;
	private draftNote: string | null = null;
	private draftDue: string | null = null;
	private editingId: string | null = null;
	private query = "";
	private searchTimer: number | null = null;
	/** Task whose comment box should receive focus after the next render. */
	private focusCommentFor: string | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TaskHubPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return "Focus Hub"; }
	getIcon() { return "list-checks"; }

	async onOpen() {
		this.contentEl.empty();
		this.root = this.contentEl.createDiv({ cls: "task-hub" });
		this.render();
	}

	async onClose() {
		this.root.empty();
	}

	// ---------- rendering ----------

	render() {
		if (!this.root) return;
		const input = this.root.querySelector<HTMLInputElement>(".task-hub-new-title");
		if (input) this.draftTitle = input.value;
		const hadFocus = input && document.activeElement === input;

		const search = this.root.querySelector<HTMLInputElement>(".task-hub-search");
		const searchFocus = search && document.activeElement === search;
		const caret = search?.selectionStart ?? null;

		this.root.empty();
		if (this.plugin.readOnlyReason) {
			this.root.createDiv({ cls: "task-hub-banner", text: `Read-only: ${this.plugin.readOnlyReason}. Changes will not be saved.` });
		}
		this.renderToolbar();
		this.renderFilters();
		this.renderProgress();
		this.renderList();

		if (hadFocus) this.root.querySelector<HTMLInputElement>(".task-hub-new-title")?.focus();
		if (searchFocus) {
			const el = this.root.querySelector<HTMLInputElement>(".task-hub-search");
			el?.focus();
			if (el && caret !== null) el.setSelectionRange(caret, caret);
		}
		if (this.focusCommentFor) {
			const id = this.focusCommentFor;
			this.focusCommentFor = null;
			this.root.querySelector<HTMLTextAreaElement>(`.task-hub-card[data-id="${id}"] .task-hub-comment-add`)?.focus();
		}
	}

	private renderToolbar() {
		const bar = this.root.createDiv({ cls: "task-hub-toolbar" });

		const title = bar.createEl("input", { cls: "task-hub-new-title", type: "text", placeholder: "New task…" });
		title.value = this.draftTitle;
		title.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); void this.submitNew(); }
		});

		const type = bar.createEl("select", { cls: "task-hub-select dropdown" });
		type.createEl("option", { value: "", text: "No type" });
		for (const t of this.plugin.data.types) type.createEl("option", { value: t, text: t });
		type.value = this.draftType ?? "";
		type.addEventListener("change", () => (this.draftType = type.value || null));

		const note = bar.createEl("button", { cls: "task-hub-note-pick" });
		const paintNote = () => {
			note.empty();
			const icon = note.createSpan({ cls: "task-hub-icon" });
			setIcon(icon, this.draftNote ? "file-check" : "file-plus");
			note.createSpan({ text: this.draftNote ? basename(this.draftNote) : "Link note" });
			note.toggleClass("is-set", !!this.draftNote);
		};
		paintNote();
		note.title = "Link this task to a note page (right-click to clear)";
		note.addEventListener("click", () =>
			new NotePickerModal(this.app, this.plugin, (f) => { this.draftNote = f.path; paintNote(); }).open(),
		);
		note.addEventListener("contextmenu", (e) => { e.preventDefault(); this.draftNote = null; paintNote(); });

		const due = bar.createEl("button", { cls: "task-hub-due-pick" });
		const paintDue = () => {
			due.empty();
			const icon = due.createSpan({ cls: "task-hub-icon" });
			setIcon(icon, this.draftDue ? "calendar-check" : "calendar-plus");
			due.createSpan({ text: this.draftDue ? dueLabel(this.draftDue) : "Due date" });
			due.toggleClass("is-set", !!this.draftDue);
		};
		paintDue();
		due.title = "Due date (optional; right-click to clear)";
		due.addEventListener("click", () => new DueDateModal(this.app, this.draftDue, (v) => { this.draftDue = v; paintDue(); }).open());
		due.addEventListener("contextmenu", (e) => { e.preventDefault(); this.draftDue = null; paintDue(); });

		const add = bar.createEl("button", { cls: "mod-cta task-hub-add", text: "Add" });
		add.addEventListener("click", () => void this.submitNew());
	}

	private async submitNew() {
		const input = this.root.querySelector<HTMLInputElement>(".task-hub-new-title");
		const text = (input?.value ?? "").trim();
		if (!text) { new Notice("Type a task title first"); return; }
		this.draftTitle = "";
		if (input) input.value = "";
		const due = this.draftDue;
		this.draftDue = null;
		await this.plugin.addTask({ title: text, type: this.draftType, note: this.draftNote, due });
	}

	private renderFilters() {
		const { data } = this.plugin;
		const bar = this.root.createDiv({ cls: "task-hub-filters" });

		const sel = bar.createEl("select", { cls: "task-hub-select dropdown" });
		sel.createEl("option", { value: "all", text: "All tasks" });
		sel.createEl("option", { value: "uncategorised", text: "Uncategorised" });
		if (data.types.length) {
			const g = sel.createEl("optgroup", { attr: { label: "Type" } });
			for (const t of data.types) g.createEl("option", { value: `type:${t}`, text: t });
		}
		if (data.notes.length) {
			const g = sel.createEl("optgroup", { attr: { label: "Note page" } });
			for (const n of [...data.notes].sort((a, b) => basename(a).localeCompare(basename(b))))
				g.createEl("option", { value: `note:${n}`, text: basename(n) });
		}
		const f = data.filter;
		sel.value = f.kind === "type" || f.kind === "note" ? `${f.kind}:${f.value}` : f.kind;
		if (sel.value === "") sel.value = "all";
		sel.addEventListener("change", () => {
			const v = sel.value;
			if (v.startsWith("type:")) void this.plugin.setFilter({ kind: "type", value: v.slice(5) });
			else if (v.startsWith("note:")) void this.plugin.setFilter({ kind: "note", value: v.slice(5) });
			else void this.plugin.setFilter({ kind: v as "all" | "uncategorised", value: "" });
		});

		const searchWrap = bar.createDiv({ cls: "task-hub-search-wrap" });
		const searchIcon = searchWrap.createSpan({ cls: "task-hub-icon task-hub-search-icon" });
		setIcon(searchIcon, "search");
		const search = searchWrap.createEl("input", { cls: "task-hub-search", type: "search", placeholder: "Search…" });
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			if (this.searchTimer) window.clearTimeout(this.searchTimer);
			this.searchTimer = window.setTimeout(() => { this.searchTimer = null; this.render(); }, 120);
		});
		search.addEventListener("keydown", (e) => {
			if (e.key === "Escape") { e.preventDefault(); this.query = ""; search.value = ""; this.render(); }
		});

		const tabs = bar.createDiv({ cls: "task-hub-tabs" });
		const matching = this.matchesCategory();
		for (const st of [...STATUSES, { value: "all" as const, label: "All" }]) {
			const n = st.value === "all" ? matching.length : matching.filter((t) => t.status === st.value).length;
			const tab = tabs.createEl("button", { cls: "task-hub-tab" });
			tab.toggleClass("is-active", f.status === st.value);
			tab.createSpan({ text: st.label });
			tab.createSpan({ cls: "task-hub-tab-count", text: String(n) });
			tab.addEventListener("click", () => void this.plugin.setFilter({ status: st.value }));
		}

		const gear = bar.createEl("button", { cls: "clickable-icon task-hub-gear", attr: { "aria-label": "Manage types & note pages" } });
		setIcon(gear, "settings");
		gear.addEventListener("click", () => {
			// app.setting is not part of the public API; degrade to a notice if it changes.
			const setting = (this.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
			try {
				setting?.open?.();
				setting?.openTabById?.(this.plugin.manifest.id);
			} catch {
				new Notice("Open Settings → Focus Hub to manage types and note pages");
			}
		});
	}

	/** Share of the current category that is closed — ignores the status tab and search. */
	private renderProgress() {
		const { tasks, filter } = this.plugin.data;
		const inScope = tasks.filter((t) => {
			switch (filter.kind) {
				case "type": return t.type === filter.value;
				case "note": return t.note === filter.value;
				case "uncategorised": return !t.type && !t.note;
				default: return true;
			}
		});
		if (!inScope.length) return;
		const p = countProgress(inScope);
		const scope = filter.kind === "type" ? filter.value : filter.kind === "note" ? basename(filter.value) : filter.kind === "uncategorised" ? "Uncategorised" : "All tasks";
		renderMeter(this.root, {
			label: scope,
			pct: p.pct,
			detail: `${p.closed} of ${p.total} closed`,
		});
	}

	/** Tasks matching the category filter, regardless of status. */
	private matchesCategory(): Task[] {
		const { tasks, filter } = this.plugin.data;
		const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
		return tasks.filter((t) => {
			if (terms.length) {
				const hay = [t.title, t.type ?? "", t.note ? basename(t.note) : "", t.due ?? "", ...t.comments.map((c) => c.text)].join("\n").toLowerCase();
				if (!terms.every((term) => hay.includes(term))) return false;
			}
			switch (filter.kind) {
				case "type": return t.type === filter.value;
				case "note": return t.note === filter.value;
				case "uncategorised": return !t.type && !t.note;
				default: return true;
			}
		});
	}

	private visibleTasks(): Task[] {
		const { status } = this.plugin.data.filter;
		const rank: Record<Status, number> = { open: 0, hold: 1, closed: 2 };
		return this.matchesCategory()
			.filter((t) => status === "all" || t.status === status)
			.sort((a, b) => {
				if (status === "all" && a.status !== b.status) return rank[a.status] - rank[b.status];
				if (a.status === "closed") return (b.closedAt ?? b.created) - (a.closedAt ?? a.created);
				// dated tasks first (soonest due on top), then undated newest-first
				if (a.due && b.due) return a.due.localeCompare(b.due) || b.created - a.created;
				if (a.due !== b.due) return a.due ? -1 : 1;
				return b.created - a.created;
			});
	}

	private renderList() {
		const list = this.root.createDiv({ cls: "task-hub-list" });
		const tasks = this.visibleTasks();
		if (tasks.length === 0) {
			const label = STATUSES.find((s) => s.value === this.plugin.data.filter.status)?.label ?? "";
			const msg = !this.plugin.data.tasks.length ? "No tasks yet — add one above."
				: this.query ? `No ${label.toLowerCase()} tasks match "${this.query}".`
				: `No ${label.toLowerCase()} tasks match this filter.`;
			list.createDiv({ cls: "task-hub-empty", text: msg });
			return;
		}
		for (const task of tasks) this.renderCard(list, task);
	}

	private renderCard(list: HTMLElement, task: Task) {
		const card = list.createDiv({ cls: "task-hub-card", attr: { "data-id": task.id, tabindex: "0" } });
		card.addClass(`is-${task.status}`);

		// drop / paste images onto the card
		card.addEventListener("dragover", (e) => {
			if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); card.addClass("is-dragover"); }
		});
		card.addEventListener("dragleave", () => card.removeClass("is-dragover"));
		card.addEventListener("drop", (e) => {
			card.removeClass("is-dragover");
			const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
			if (!files.length) return;
			e.preventDefault();
			for (const f of files) void this.plugin.importImage(task.id, f, f.name);
		});
		card.addEventListener("paste", (e) => {
			if (this.editingId === task.id) return;
			const items = Array.from(e.clipboardData?.items ?? []).filter((i) => i.type.startsWith("image/"));
			if (!items.length) return;
			e.preventDefault();
			for (const i of items) { const f = i.getAsFile(); if (f) void this.plugin.importImage(task.id, f); }
		});
		card.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showMenu(task, e); });

		const row = card.createDiv({ cls: "task-hub-row" });

		const cb = row.createEl("input", { type: "checkbox", cls: "task-hub-check" });
		cb.checked = task.status === "closed";
		cb.title = task.status === "closed" ? "Reopen" : "Close";
		cb.addEventListener("change", () => void this.setStatus(task, cb.checked ? "closed" : "open"));

		const title = row.createDiv({ cls: "task-hub-title", text: task.title });
		title.title = "Click to edit";
		title.addEventListener("click", () => this.editTitle(task, title));

		const badges = row.createDiv({ cls: "task-hub-badges" });
		if (task.due) {
			const n = daysUntil(task.due);
			const b = badges.createSpan({ cls: "task-hub-badge task-hub-badge-due" });
			if (task.status !== "closed") {
				b.toggleClass("is-overdue", n < 0);
				b.toggleClass("is-today", n === 0);
				b.toggleClass("is-soon", n > 0 && n <= 3);
			}
			const ic = b.createSpan({ cls: "task-hub-icon" });
			setIcon(ic, "calendar");
			b.createSpan({ text: dueLabel(task.due) });
			b.title = `Due ${formatDate(task.due)} — click to change`;
			b.addEventListener("click", () => this.editDue(task));
		}
		if (this.plugin.needsScheduling(task)) {
			const b = badges.createSpan({ cls: "task-hub-badge task-hub-badge-unscheduled" });
			setIcon(b.createSpan({ cls: "task-hub-icon" }), "calendar-off");
			b.createSpan({ text: "Not scheduled" });
			const gap = schedulingGap(task);
			b.title = `On a timeline but has ${gap ? GAP_LABEL[gap] : "no dates"} — click to schedule`;
			b.addEventListener("click", () => new ScheduleModal(this.app, this.plugin, task, () => this.render()).open());
		}
		if (task.status === "hold") badges.createSpan({ cls: "task-hub-badge task-hub-badge-hold", text: "On Hold" });
		if (task.status === "closed" && this.plugin.data.filter.status === "all") badges.createSpan({ cls: "task-hub-badge task-hub-badge-closed", text: "Closed" });
		if (task.type) {
			const b = badges.createSpan({ cls: "task-hub-badge task-hub-badge-type", text: task.type });
			b.title = "Filter by this type";
			b.addEventListener("click", () => void this.plugin.setFilter({ kind: "type", value: task.type! }));
		}
		if (task.note) {
			const b = badges.createSpan({ cls: "task-hub-badge task-hub-badge-note" });
			const ic = b.createSpan({ cls: "task-hub-icon" });
			setIcon(ic, "file-text");
			b.createSpan({ text: basename(task.note) });
			b.title = `Open ${task.note}`;
			b.addEventListener("click", () => void this.plugin.openPath(task.note!));
		}

		const actions = row.createDiv({ cls: "task-hub-actions" });
		const iconBtn = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
			const btn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(btn, icon);
			btn.addEventListener("click", onClick);
			return btn;
		};
		const hasDetails = task.images.length > 0 || task.comments.length > 0;
		if (hasDetails) {
			const parts: string[] = [];
			if (task.images.length) parts.push(`${task.images.length} image${task.images.length === 1 ? "" : "s"}`);
			if (task.comments.length) parts.push(`${task.comments.length} comment${task.comments.length === 1 ? "" : "s"}`);
			const btn = iconBtn(task.collapsed ? "chevron-right" : "chevron-down", (task.collapsed ? "Show " : "Hide ") + parts.join(", "), () =>
				void this.plugin.updateTask(task.id, { collapsed: !task.collapsed }),
			);
			if (task.images.length) { const c = btn.createSpan({ cls: "task-hub-icon task-hub-count-icon" }); setIcon(c, "image"); btn.createSpan({ cls: "task-hub-imgcount", text: String(task.images.length) }); }
			if (task.comments.length) { const c = btn.createSpan({ cls: "task-hub-icon task-hub-count-icon" }); setIcon(c, "message-square"); btn.createSpan({ cls: "task-hub-imgcount", text: String(task.comments.length) }); }
		}
		if (task.status === "open") iconBtn("pause", "Put on hold", () => void this.setStatus(task, "hold"));
		else if (task.status === "hold") iconBtn("play", "Resume (move to Open)", () => void this.setStatus(task, "open"));
		if (!task.due) iconBtn("calendar-plus", "Set due date", () => this.editDue(task));
		iconBtn("message-square-plus", "Add comment", () => this.startComment(task));
		iconBtn("image-plus", "Attach image from vault", () =>
			new ImagePickerModal(this.app, (f) => void this.plugin.addImagePath(task.id, f.path)).open(),
		);
		iconBtn("more-horizontal", "More", (e) => this.showMenu(task, e));

		if (task.collapsed) return;
		const showAdd = this.focusCommentFor === task.id;
		if (!hasDetails && !showAdd) return;

		const details = card.createDiv({ cls: "task-hub-details" });
		if (task.images.length) {
			const strip = details.createDiv({ cls: "task-hub-images" });
			for (const path of task.images) {
				const wrap = strip.createDiv({ cls: "task-hub-thumb" });
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					const img = wrap.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: file.name, loading: "lazy" } });
					img.title = path;
					img.addEventListener("click", () => void this.plugin.openPath(path));
				} else {
					wrap.createDiv({ cls: "task-hub-thumb-missing", text: `missing: ${basename(path)}` });
				}
				const rm = wrap.createEl("button", { cls: "task-hub-thumb-remove clickable-icon", attr: { "aria-label": "Detach image" } });
				setIcon(rm, "x");
				rm.addEventListener("click", (e) => { e.stopPropagation(); void this.plugin.removeImage(task.id, path); });
			}
		}

		const comments = details.createDiv({ cls: "task-hub-comments" });
		for (const c of task.comments) this.renderComment(comments, task, c);

		if (showAdd) {
			const ta = comments.createEl("textarea", { cls: "task-hub-comment-add", attr: { rows: "2", placeholder: "Add a comment… (Enter to save, Esc to cancel)" } });
			let finished = false;
			const done = (commit: boolean) => {
				if (finished) return;
				finished = true;
				const v = ta.value.trim();
				if (commit && v) void this.plugin.addComment(task.id, v);
				else this.render();
			};
			ta.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); }
				if (e.key === "Escape") { e.preventDefault(); done(false); }
			});
			ta.addEventListener("blur", () => done(true));
		}
	}

	/** Open the OS file/camera picker (works on mobile, where drag-drop and paste do not). */
	private pickFromDevice(task: Task) {
		const input = createEl("input", { type: "file", attr: { accept: "image/*", multiple: "" } });
		input.addEventListener("change", () => {
			for (const f of Array.from(input.files ?? [])) void this.plugin.importImage(task.id, f, f.name);
		});
		input.click();
	}

	private editDue(task: Task) {
		new DueDateModal(this.app, task.due, (v) => void this.plugin.updateTask(task.id, { due: v })).open();
	}

	private startComment(task: Task) {
		this.focusCommentFor = task.id;
		if (task.collapsed) void this.plugin.updateTask(task.id, { collapsed: false });
		else this.render();
	}

	private renderComment(parent: HTMLElement, task: Task, c: Comment) {
		const el = parent.createDiv({ cls: "task-hub-comment" });
		el.toggleClass("is-closeout", c.closeOut);
		const meta = el.createDiv({ cls: "task-hub-comment-meta" });
		if (c.closeOut) meta.createSpan({ cls: "task-hub-comment-tag", text: "Close-out" });
		meta.createSpan({ text: formatDateTime(c.time) });
		const edit = meta.createEl("button", { cls: "clickable-icon task-hub-comment-btn", attr: { "aria-label": "Edit comment" } });
		setIcon(edit, "pencil");
		const rm = meta.createEl("button", { cls: "clickable-icon task-hub-comment-btn", attr: { "aria-label": "Delete comment" } });
		setIcon(rm, "x");
		rm.addEventListener("click", () => void this.plugin.removeComment(task.id, c.id));
		const body = el.createDiv({ cls: "task-hub-comment-text" });
		renderCommentText(body, c.text);
		edit.addEventListener("click", () =>
			new CommentModal(this.app, c.closeOut ? "Edit close-out comment" : "Edit comment", { initial: c.text, skipLabel: "Cancel" }, (v) => {
				if (v !== null) void this.plugin.updateComment(task.id, c.id, v);
			}).open(),
		);
		body.addEventListener("dblclick", () => edit.click());
	}

	private async setStatus(task: Task, status: Status) {
		await this.plugin.setStatus(task.id, status);
	}

	private editTitle(task: Task, el: HTMLElement) {
		if (this.editingId) return;
		this.editingId = task.id;
		const input = createEl("input", { type: "text", cls: "task-hub-title-edit" });
		input.value = task.title;
		el.replaceWith(input);
		input.focus();
		input.select();
		let finished = false;
		const finish = async (commit: boolean) => {
			if (finished) return;
			finished = true;
			this.editingId = null;
			const v = input.value.trim();
			if (commit && v && v !== task.title) await this.plugin.updateTask(task.id, { title: v });
			else this.render();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); void finish(true); }
			if (e.key === "Escape") { e.preventDefault(); void finish(false); }
		});
		input.addEventListener("blur", () => void finish(true));
	}

	private showMenu(task: Task, e: MouseEvent) {
		const menu = new Menu();
		const { data } = this.plugin;

		menu.addItem((i) => i.setTitle("Status").setIsLabel(true));
		for (const st of STATUSES) {
			menu.addItem((i) =>
				i.setTitle(st.label).setChecked(task.status === st.value).onClick(() => void this.setStatus(task, st.value)),
			);
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Type").setIsLabel(true));
		menu.addItem((i) =>
			i.setTitle("None").setChecked(task.type === null).onClick(() => void this.plugin.updateTask(task.id, { type: null })),
		);
		for (const t of data.types) {
			menu.addItem((i) =>
				i.setTitle(t).setChecked(task.type === t).onClick(() => void this.plugin.updateTask(task.id, { type: t })),
			);
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Note page").setIsLabel(true));
		menu.addItem((i) =>
			i.setTitle(task.note ? `Change note (${basename(task.note)})…` : "Link note…").setIcon("file-plus").onClick(() =>
				new NotePickerModal(this.app, this.plugin, (f) => void this.plugin.updateTask(task.id, { note: f.path })).open(),
			),
		);
		if (task.note) {
			menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => void this.plugin.openPath(task.note!)));
			menu.addItem((i) => i.setTitle("Add to note (as checkbox line)").setIcon("list-plus").onClick(() => void this.plugin.noteSync.ensure(task, true)));
			menu.addItem((i) => i.setTitle("Filter by this note").setIcon("filter").onClick(() => void this.plugin.setFilter({ kind: "note", value: task.note! })));
			menu.addItem((i) => i.setTitle("Unlink note").setIcon("unlink").onClick(() => void this.plugin.updateTask(task.id, { note: null })));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(task.due ? `Due ${formatDate(task.due)} — change…` : "Set due date…").setIcon("calendar").onClick(() => this.editDue(task)));
		if (task.due) menu.addItem((i) => i.setTitle("Clear due date").setIcon("calendar-x").onClick(() => void this.plugin.updateTask(task.id, { due: null })));
		menu.addItem((i) =>
			i.setTitle("Schedule & prerequisites…").setIcon("calendar-range").onClick(() =>
				new ScheduleModal(this.app, this.plugin, task).open(),
			),
		);
		menu.addItem((i) => i.setTitle("Add comment").setIcon("message-square-plus").onClick(() => this.startComment(task)));
		menu.addItem((i) =>
			i.setTitle("Attach image from vault…").setIcon("image-plus").onClick(() =>
				new ImagePickerModal(this.app, (f) => void this.plugin.addImagePath(task.id, f.path)).open(),
			),
		);
		menu.addItem((i) => i.setTitle("Attach image from device / camera…").setIcon("camera").onClick(() => this.pickFromDevice(task)));
		menu.addItem((i) =>
			i.setTitle("Delete task").setIcon("trash").setWarning(true).onClick(() => void this.plugin.deleteTask(task.id)),
		);
		menu.showAtMouseEvent(e);
	}
}
