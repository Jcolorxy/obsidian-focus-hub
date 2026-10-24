import { Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, normalizePath } from "obsidian";
import { DEFAULT_DATA, Filter, HubData, HubSettings, SCHEMA_VERSION, Status, Task, basename, newId, schedulingGap, tasksForDay, todayISO } from "./types";
import { rollover } from "./today";
import Anthropic from "@anthropic-ai/sdk";
import { generateSuggestion } from "./brief";
import { HISTORY_VIEW_TYPE, HistoryView } from "./historyview";
import { CompletionModal } from "./completion";
import { TODAY_VIEW_TYPE, TodayView } from "./todayview";
import type { Calendar } from "./schedule";
import { TaskHubView, VIEW_TYPE } from "./view";
import { BackupPickerModal, ScheduleModal, TaskModal } from "./modals";
import { TaskHubSettingTab } from "./settings";
import { NoteSync } from "./notesync";
import { hideMarkerExtension } from "./hidemarker";
import { renderRatio } from "./ratio";
import { parseGanttBlock, renderGanttBlock } from "./ganttview";

const BACKUPS_KEPT = 7;
const TOMBSTONE_DAYS = 30;

export default class TaskHubPlugin extends Plugin {
	data: HubData = DEFAULT_DATA;
	/** mtime of data.json as last seen by us; used to detect writes by Obsidian Sync. */
	private knownMtime: number | null = null;
	private saving = false;
	/** Set when data.json could not be read safely; all writes are refused until restored. */
	readOnlyReason: string | null = null;
	noteSync = new NoteSync(this);
	/** Notes whose tasks appear on some timeline; "*" when a chart covers everything. */
	timelineNotes = new Set<string>();
	/** Progress of this device's attempt at the morning suggestion. */
	briefState: { running: boolean; error: string | null } = { running: false, error: null };
	private startedAt = Date.now();
	private scanTimer: number | null = null;

	async onload() {
		await this.retireOldPlugin();
		await this.reload();
		// Obsidian Sync replaces data.json on disk when another device edits tasks.
		// Poll its mtime so those edits show up here instead of being overwritten on our next save.
		this.registerInterval(window.setInterval(() => void this.checkExternalChange(), 3000));
		this.app.workspace.onLayoutReady(async () => {
			void this.healPaths();
			await this.scanTimelines();
			await this.ensureToday();
			if (this.data.settings.openTodayOnStartup) void this.activateView(TODAY_VIEW_TYPE);
			// give Sync a moment to bring in a suggestion another device already made
			window.setTimeout(() => void this.maybeSuggest(), SYNC_GRACE_MS);
		});

		this.registerView(VIEW_TYPE, (leaf) => new TaskHubView(leaf, this));
		this.registerView(TODAY_VIEW_TYPE, (leaf) => new TodayView(leaf, this));
		this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf, this));
		this.addRibbonIcon("history", "Work history", () => this.activateView(HISTORY_VIEW_TYPE));
		this.addCommand({ id: "open-history", name: "Work history", callback: () => this.activateView(HISTORY_VIEW_TYPE) });
		this.addRibbonIcon("list-checks", "Open Focus Hub", () => this.activateView());
		this.addRibbonIcon("sun", "Open Today", () => this.activateView(TODAY_VIEW_TYPE));

		this.addCommand({ id: "open", name: "Open Focus Hub", callback: () => this.activateView() });
		this.addCommand({ id: "open-today", name: "Open Today", callback: () => this.activateView(TODAY_VIEW_TYPE) });
		this.addCommand({ id: "new-task", name: "New task", callback: () => new TaskModal(this.app, this).open() });
		this.addCommand({
			id: "new-task-current-note",
			name: "New task linked to current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) new TaskModal(this.app, this, { note: file.path }).open();
				return true;
			},
		});
		this.addCommand({
			id: "insert-timeline",
			name: "Insert timeline here",
			editorCallback: (editor) => editor.replaceSelection("```gantt\nzoom: week\n```\n"),
		});
		this.addCommand({
			id: "timeline-note",
			name: "Create timeline note for this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.createTimelineNote(file);
				return true;
			},
		});
		this.addCommand({ id: "backup-now", name: "Back up task data now", callback: () => void this.writeBackup(true) });
		this.addCommand({
			id: "restore-backup",
			name: "Restore task data from a backup…",
			callback: async () => new BackupPickerModal(this.app, await this.listBackups(), (p) => void this.restoreBackup(p)).open(),
		});

		this.addSettingTab(new TaskHubSettingTab(this.app, this));
		this.registerEditorExtension(hideMarkerExtension);
		this.registerMarkdownCodeBlockProcessor("ratio", (source, el, ctx) => renderRatio(source, el, ctx));
		this.registerMarkdownCodeBlockProcessor("gantt", (source, el, ctx) => renderGanttBlock(this, el, source, ctx.sourcePath));

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onDelete(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (!(file instanceof TFile)) return;
			void this.noteSync.pull(file);
			this.scheduleTimelineScan();
		}));
	}

	onunload() {}

	/**
	 * An earlier copy of this plugin installed under a different id (it was renamed)
	 * registers the same view types. When Sync enables this copy on a device where the
	 * old one is still running, registering those views throws and this copy fails to
	 * load — so switch the old one off first. It is recognised by its own machinery
	 * rather than by id. Uses Obsidian's internal plugin manager, guarded.
	 */
	private async retireOldPlugin() {
		const manager = (this.app as unknown as {
			plugins?: { plugins?: Record<string, unknown>; disablePlugin?(id: string): Promise<void> };
		}).plugins;
		const isOlderCopy = (p: unknown) => {
			const o = p as { noteSync?: unknown; ensureToday?: unknown; refreshViews?: unknown } | null;
			return !!o && !!o.noteSync && typeof o.ensureToday === "function" && typeof o.refreshViews === "function";
		};
		const stale = Object.entries(manager?.plugins ?? {})
			.filter(([id, p]) => id !== this.manifest.id && isOlderCopy(p))
			.map(([id]) => id);
		if (!stale.length) return;
		const stillRunning = "Focus Hub: an older copy of this plugin (Task Hub) is still running. Turn it off in Community plugins, or restart Obsidian.";
		if (!manager?.disablePlugin) { new Notice(stillRunning, 0); return; }
		for (const id of stale) {
			try {
				await manager.disablePlugin(id);
				console.info(`Focus Hub: switched off the older copy "${id}"`);
			} catch (e) {
				console.error(`Focus Hub: could not switch off "${id}"`, e);
				new Notice(stillRunning, 0);
			}
		}
	}

	// ---------- persistence ----------

	private get dataPath(): string {
		return `${this.manifest.dir}/data.json`;
	}

	private get backupDir(): string {
		return `${this.manifest.dir}/backups`;
	}

	private async statMtime(): Promise<number | null> {
		const st = await this.app.vault.adapter.stat(this.dataPath);
		return st?.mtime ?? null;
	}

	/** (Re)load data.json from disk, normalising and migrating older shapes. */
	async reload() {
		let stored: Partial<HubData> | null = null;
		this.readOnlyReason = null;
		try {
			stored = (await this.loadData()) as Partial<HubData> | null;
		} catch (e) {
			this.readOnlyReason = "data.json could not be parsed";
			console.error("Focus Hub: failed to read data.json", e);
			new Notice("Focus Hub: data.json is unreadable. Saving is disabled — use \"Restore task data from a backup\".", 0);
			this.knownMtime = await this.statMtime();
			return;
		}
		if (stored && typeof stored.version === "number" && stored.version > SCHEMA_VERSION) {
			this.readOnlyReason = `data.json is from a newer Focus Hub (v${stored.version}); this is v${SCHEMA_VERSION}`;
			new Notice(`Focus Hub: ${this.readOnlyReason}. Update the plugin on this device; saving is disabled until then.`, 0);
		}
		this.data = normalise(stored);
		this.knownMtime = await this.statMtime();
	}

	private async checkExternalChange() {
		if (this.saving) return;
		const mtime = await this.statMtime();
		if (mtime === null || mtime === this.knownMtime) return;
		await this.reload();
		this.refreshViews();
	}

	async save() {
		if (this.readOnlyReason) {
			new Notice(`Focus Hub: not saved — ${this.readOnlyReason}`);
			return;
		}
		this.saving = true;
		try {
			// If Sync changed the file since we last read it, merge over that version so we
			// don't clobber another device's edits with our stale in-memory copy.
			const mtime = await this.statMtime();
			if (mtime !== null && this.knownMtime !== null && mtime !== this.knownMtime) {
				const mine = this.data;
				const theirs = normalise((await this.loadData()) as Partial<HubData> | null);
				this.data = mergeData(theirs, mine);
			}
			pruneTombstones(this.data);
			await this.saveData(this.data);
			this.knownMtime = await this.statMtime();
		} finally {
			this.saving = false;
		}
		this.refreshViews();
		void this.writeBackup(false);
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			// a leaf that has not been opened yet holds a deferred placeholder, not our view
			if (leaf.view instanceof TaskHubView) leaf.view.render();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
			if (leaf.view instanceof HistoryView) leaf.view.render();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(TODAY_VIEW_TYPE)) {
			if (leaf.view instanceof TodayView) leaf.view.render();
		}
	}

	// ---------- backups ----------

	private backupName(d = new Date()): string {
		return `data-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
	}

	async listBackups(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.backupDir))) return [];
		const { files } = await adapter.list(this.backupDir);
		return files.filter((f) => f.endsWith(".json")).sort().reverse();
	}

	/** Write today's backup once per day (or always when forced); keep the newest few. */
	async writeBackup(force: boolean) {
		if (this.readOnlyReason) return;
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.backupDir))) await adapter.mkdir(this.backupDir);
			const path = `${this.backupDir}/${this.backupName()}`;
			if (!force && (await adapter.exists(path))) return;
			await adapter.write(path, JSON.stringify(this.data, null, 2));
			const backups = await this.listBackups();
			for (const old of backups.slice(BACKUPS_KEPT)) await adapter.remove(old);
			if (force) new Notice(`Focus Hub: backed up to ${path}`);
		} catch (e) {
			console.error("Focus Hub: backup failed", e);
			if (force) new Notice("Focus Hub: backup failed — see console");
		}
	}

	async restoreBackup(path: string) {
		const adapter = this.app.vault.adapter;
		try {
			const raw = await adapter.read(path);
			JSON.parse(raw); // validate before touching data.json
			if (!this.readOnlyReason) await this.writeBackup(true); // keep what we're replacing
			await adapter.write(this.dataPath, raw);
			await this.reload();
			this.refreshViews();
			new Notice(`Focus Hub: restored ${this.data.tasks.length} tasks from ${basename(path)}`);
		} catch (e) {
			console.error("Focus Hub: restore failed", e);
			new Notice("Focus Hub: restore failed — that backup is not valid JSON");
		}
	}

	// ---------- view ----------

	async activateView(type: string = VIEW_TYPE) {
		const existing = this.app.workspace.getLeavesOfType(type);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	// ---------- tasks ----------

	private touch(task: Task) {
		task.updated = Date.now();
	}

	async addTask(partial: { title: string; type?: string | null; note?: string | null; due?: string | null }): Promise<Task> {
		const now = Date.now();
		const task: Task = {
			id: newId(),
			title: partial.title.trim(),
			status: "open",
			type: partial.type ?? null,
			note: partial.note ?? null,
			images: [],
			comments: [],
			due: partial.due ?? null,
			start: null,
			durationDays: null,
			deps: [],
			order: null,
			depLags: {},
			milestone: false,
			percent: null,
			phase: null,
			owner: null,
			baseline: null,
			collapsed: false,
			created: now,
			updated: now,
			closedAt: null,
		};
		if (task.type && !this.data.types.includes(task.type)) this.data.types.push(task.type);
		if (task.note && !this.data.notes.includes(task.note)) this.data.notes.push(task.note);
		this.data.tasks.push(task);
		await this.save();
		await this.noteSync.ensure(task);
		return task;
	}

	getTask(id: string): Task | undefined {
		return this.data.tasks.find((t) => t.id === id);
	}

	async updateTask(id: string, patch: Partial<Task>) {
		const task = this.getTask(id);
		if (!task) return;
		const oldNote = task.note;
		Object.assign(task, patch);
		this.touch(task);
		if (patch.type && !this.data.types.includes(patch.type)) this.data.types.push(patch.type);
		if (patch.note && !this.data.notes.includes(patch.note)) this.data.notes.push(patch.note);
		await this.save();
		if ("note" in patch && patch.note !== oldNote) {
			await this.noteSync.remove(oldNote, task.id);
			await this.noteSync.ensure(task);
		} else if ("title" in patch || "due" in patch) {
			await this.noteSync.update(task);
		}
	}

	async setStatus(id: string, status: Status) {
		const task = this.getTask(id);
		if (!task || task.status === status) return;
		task.status = status;
		if (status === "closed") task.closedAt = Date.now();
		this.touch(task);
		await this.save();
		await this.noteSync.update(task);
		if (status === "closed" && this.data.settings.closeOutPrompt) {
			new CompletionModal(this.app, task.title, (text) => {
				if (text) void this.addComment(task.id, text, true);
			}).open();
		}
	}

	async deleteTask(id: string) {
		const task = this.getTask(id);
		this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
		for (const t of this.data.tasks) {
			if (t.deps?.includes(id)) { t.deps = t.deps.filter((d) => d !== id); this.touch(t); }
		}
		this.data.deleted[id] = Date.now();
		await this.save();
		if (task) await this.noteSync.remove(task.note, task.id);
	}

	/** Set planned start / duration; both may be null to clear. */
	async setSchedule(id: string, patch: { start?: string | null; durationDays?: number | null }) {
		const task = this.getTask(id);
		if (!task) return;
		if ("start" in patch) task.start = patch.start ?? null;
		if ("durationDays" in patch) task.durationDays = patch.durationDays ?? null;
		this.touch(task);
		await this.save();
		await this.noteSync.update(task);
	}

	/** Replace a task's prerequisites, dropping self-links and duplicates. */
	async setDeps(id: string, deps: string[]) {
		const task = this.getTask(id);
		if (!task) return;
		task.deps = Array.from(new Set(deps.filter((d) => d !== id && this.getTask(d))));
		task.depLags = Object.fromEntries(Object.entries(task.depLags ?? {}).filter(([d]) => task.deps.includes(d)));
		this.touch(task);
		await this.save();
	}

	/** The working-day calendar the timeline schedules against. */
	get calendar(): Calendar {
		return {
			workingDaysOnly: this.data.settings.workingDaysOnly,
			holidays: new Set(this.data.settings.holidays ?? []),
		};
	}

	/** Snapshot the current dates of these tasks as the agreed plan. */
	async setBaseline(entries: { id: string; start: string; end: string }[]) {
		for (const { id, start, end } of entries) {
			const task = this.getTask(id);
			if (!task) continue;
			task.baseline = { start, end };
			this.touch(task);
		}
		await this.save();
	}

	async clearBaseline(ids: string[]) {
		for (const id of ids) {
			const task = this.getTask(id);
			if (!task || !task.baseline) continue;
			task.baseline = null;
			this.touch(task);
		}
		await this.save();
	}

	/** Waiting time between a prerequisite finishing and this task starting. */
	async setDepLag(id: string, depId: string, lagDays: number) {
		const task = this.getTask(id);
		if (!task) return;
		const lags = { ...task.depLags };
		if (lagDays > 0) lags[depId] = Math.round(lagDays);
		else delete lags[depId];
		task.depLags = lags;
		this.touch(task);
		await this.save();
	}

	// ---------- today ----------

	/** Roll the focus list onto today if the day has changed since it was last used. */
	async ensureToday() {
		const next = rollover(this.data.today, this.data.tasks, todayISO());
		if (next !== this.data.today) {
			this.data.today = next;
			await this.save();
		}
	}

	async addToFocus(id: string): Promise<boolean> {
		await this.ensureToday();
		const { today, settings } = this.data;
		if (today.focus.includes(id)) return true;
		// at the weekend, set-aside work tasks don't use up focus slots
		const byId = new Map(this.data.tasks.map((t) => [t.id, t]));
		const shown = tasksForDay(today.focus.map((f) => byId.get(f)).filter((t): t is Task => !!t), todayISO());
		if (shown.length >= settings.focusLimit) {
			new Notice(`Focus is full (${settings.focusLimit}). Finish or remove one first.`);
			return false;
		}
		today.focus = [...today.focus, id];
		await this.save();
		return true;
	}

	async removeFromFocus(id: string) {
		const { today } = this.data;
		today.focus = today.focus.filter((f) => f !== id);
		today.carried = today.carried.filter((f) => f !== id);
		await this.save();
	}

	async moveFocus(id: string, delta: number) {
		const list = [...this.data.today.focus];
		const at = list.indexOf(id);
		const to = at + delta;
		if (at < 0 || to < 0 || to >= list.length) return;
		list.splice(to, 0, list.splice(at, 1)[0]);
		this.data.today.focus = list;
		await this.save();
	}

	/** True once Sync has had its chance to deliver another device's suggestion. */
	get syncGraceOver(): boolean {
		return Date.now() - this.startedAt >= SYNC_GRACE_MS;
	}

	/**
	 * Make today's suggestion if nobody has yet — on whichever device opens Obsidian
	 * first, so it no longer depends on one PC being on. `force` regenerates.
	 */
	async maybeSuggest(force = false) {
		const s = this.data.settings;
		const today = todayISO();
		if (this.briefState.running) return;
		if (!force) {
			if (!s.briefEnabled) return;
			if (s.briefPausedUntil && today < s.briefPausedUntil) return;
			if (this.data.today.suggestion?.date === today) return;
			// one attempt per device per day, so a failure doesn't retry on every open
			if (this.app.loadLocalStorage(BRIEF_ATTEMPT_KEY) === today) return;
		}
		const key = s.briefKeychainId ? this.app.secretStorage.getSecret(s.briefKeychainId) : null;
		if (!key) {
			if (force) new Notice("Choose your Anthropic API key under Settings → Focus Hub → Morning suggestion first.");
			return;
		}
		this.app.saveLocalStorage(BRIEF_ATTEMPT_KEY, today);
		this.briefState = { running: true, error: null };
		this.refreshViews();
		try {
			const suggestion = await generateSuggestion(this.data, this.calendar, key);
			// another device may have finished while this one was waiting on Claude
			if (!force && this.data.today.suggestion?.date === today) return;
			await this.ensureToday();
			this.data.today = { ...this.data.today, suggestion };
			await this.save();
		} catch (e) {
			this.briefState.error = describeBriefError(e);
			console.error("Focus Hub: morning suggestion failed", e);
		} finally {
			this.briefState.running = false;
			this.refreshViews();
		}
	}

	async markReviewed() {
		this.data.today.reviewed = todayISO();
		await this.save();
	}

	/** Give these tasks, in this sequence, consecutive manual positions. */
	async reorderTasks(ids: string[]) {
		ids.forEach((id, i) => {
			const task = this.getTask(id);
			if (!task || task.order === i) return;
			task.order = i;
			this.touch(task);
		});
		await this.save();
	}

	async setFilter(patch: Partial<Filter>) {
		this.data.filter = { ...this.data.filter, ...patch };
		await this.save();
	}

	async setSettings(patch: Partial<HubSettings>) {
		this.data.settings = { ...this.data.settings, ...patch };
		await this.save();
	}

	// ---------- comments ----------

	async addComment(taskId: string, text: string, closeOut = false) {
		const task = this.getTask(taskId);
		text = text.trim();
		if (!task || !text) return;
		task.comments.push({ id: newId(), text, time: Date.now(), closeOut });
		task.collapsed = false;
		this.touch(task);
		await this.save();
		await this.noteSync.syncComments(task);
	}

	async updateComment(taskId: string, commentId: string, text: string) {
		const task = this.getTask(taskId);
		const c = task?.comments.find((c) => c.id === commentId);
		if (!task || !c || !text.trim()) return;
		c.text = text.trim();
		this.touch(task);
		await this.save();
		await this.noteSync.syncComments(task);
	}

	async removeComment(taskId: string, commentId: string) {
		const task = this.getTask(taskId);
		if (!task) return;
		task.comments = task.comments.filter((c) => c.id !== commentId);
		this.touch(task);
		await this.save();
		await this.noteSync.syncComments(task);
	}

	// ---------- master lists ----------

	async addType(name: string): Promise<boolean> {
		name = name.trim();
		if (!name || this.data.types.includes(name)) return false;
		this.data.types.push(name);
		await this.save();
		return true;
	}

	async renameType(oldName: string, newName: string) {
		newName = newName.trim();
		if (!newName || oldName === newName || this.data.types.includes(newName)) return;
		this.data.types = this.data.types.map((t) => (t === oldName ? newName : t));
		for (const task of this.data.tasks) if (task.type === oldName) { task.type = newName; this.touch(task); }
		if (this.data.filter.kind === "type" && this.data.filter.value === oldName) this.data.filter.value = newName;
		await this.save();
	}

	async removeType(name: string) {
		this.data.types = this.data.types.filter((t) => t !== name);
		for (const task of this.data.tasks) if (task.type === name) { task.type = null; this.touch(task); }
		if (this.data.filter.kind === "type" && this.data.filter.value === name) this.data.filter = { ...this.data.filter, kind: "all", value: "" };
		await this.save();
	}

	async addNote(path: string): Promise<boolean> {
		if (!path || this.data.notes.includes(path)) return false;
		this.data.notes.push(path);
		await this.save();
		return true;
	}

	async removeNote(path: string) {
		this.data.notes = this.data.notes.filter((n) => n !== path);
		const unlinked = this.data.tasks.filter((t) => t.note === path);
		for (const task of unlinked) { await this.noteSync.remove(path, task.id); task.note = null; this.touch(task); }
		if (this.data.filter.kind === "note" && this.data.filter.value === path) this.data.filter = { ...this.data.filter, kind: "all", value: "" };
		await this.save();
	}

	// ---------- images ----------

	async addImagePath(taskId: string, path: string) {
		const task = this.getTask(taskId);
		if (!task || task.images.includes(path)) return;
		task.images.push(path);
		task.collapsed = false;
		this.touch(task);
		await this.save();
	}

	async removeImage(taskId: string, path: string) {
		const task = this.getTask(taskId);
		if (!task) return;
		task.images = task.images.filter((p) => p !== path);
		this.touch(task);
		await this.save();
	}

	/** Save a pasted/dropped/picked image blob into the vault's attachment folder and attach it. */
	async importImage(taskId: string, blob: Blob, suggestedName?: string) {
		const task = this.getTask(taskId);
		if (!task) return;
		const ext = (blob.type.split("/")[1] || suggestedName?.split(".").pop() || "png").replace("jpeg", "jpg");
		const base = (suggestedName ?? `task-${task.id}-${Date.now()}`).replace(/\.[^.]+$/, "");
		const source = task.note ?? this.app.workspace.getActiveFile()?.path;
		const path = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, source));
		const file = await this.app.vault.createBinary(path, await blob.arrayBuffer());
		await this.addImagePath(taskId, file.path);
		new Notice(`Attached ${file.name}`);
	}

	// ---------- vault events ----------

	private async onRename(file: TAbstractFile, oldPath: string) {
		const remap = (p: string | null): string | null => {
			if (p === null) return null;
			if (p === oldPath) return file.path;
			if (file instanceof TFolder && p.startsWith(oldPath + "/")) return file.path + p.slice(oldPath.length);
			return p;
		};
		let changed = false;
		const notes = this.data.notes.map(remap) as string[];
		if (notes.some((n, i) => n !== this.data.notes[i])) { this.data.notes = notes; changed = true; }
		for (const task of this.data.tasks) {
			const note = remap(task.note);
			const images = task.images.map(remap) as string[];
			if (note !== task.note || images.some((p, i) => p !== task.images[i])) {
				task.note = note; task.images = images; this.touch(task); changed = true;
			}
		}
		if (this.data.filter.kind === "note") {
			const v = remap(this.data.filter.value);
			if (v !== this.data.filter.value) { this.data.filter.value = v ?? ""; changed = true; }
		}
		if (changed) await this.save();
	}

	private async onDelete(file: TAbstractFile) {
		const gone = (p: string | null) => p !== null && (p === file.path || (file instanceof TFolder && p.startsWith(file.path + "/")));
		let changed = false;
		if (this.data.notes.some(gone)) { this.data.notes = this.data.notes.filter((n) => !gone(n)); changed = true; }
		for (const task of this.data.tasks) {
			if (gone(task.note) || task.images.some(gone)) {
				if (gone(task.note)) task.note = null;
				task.images = task.images.filter((p) => !gone(p));
				this.touch(task); changed = true;
			}
		}
		if (this.data.filter.kind === "note" && gone(this.data.filter.value)) {
			this.data.filter = { ...this.data.filter, kind: "all", value: "" }; changed = true;
		}
		if (changed) await this.save();
	}

	/**
	 * Repair note/image paths that no longer exist (e.g. files moved while Obsidian was
	 * closed) by finding a file with the same name elsewhere in the vault.
	 */
	private async healPaths() {
		const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof TFile;
		const find = (p: string): string | null => {
			const name = p.split("/").pop() ?? p;
			const hit = this.app.metadataCache.getFirstLinkpathDest(name, "") ?? this.app.vault.getFiles().find((f) => f.name === name);
			return hit ? hit.path : null;
		};
		const fix = (p: string): string => (exists(p) ? p : find(p) ?? p);
		let changed = 0;
		const notes = this.data.notes.map(fix);
		if (notes.some((n, i) => n !== this.data.notes[i])) { this.data.notes = Array.from(new Set(notes)); changed++; }
		for (const task of this.data.tasks) {
			const note = task.note && fix(task.note);
			const images = task.images.map(fix);
			if (note !== task.note || images.some((p, i) => p !== task.images[i])) {
				task.note = note; task.images = images; this.touch(task); changed++;
			}
		}
		if (changed) {
			await this.save();
			new Notice(`Focus Hub: repaired ${changed} moved file reference(s)`);
		}
	}

	/**
	 * Make a separate note holding the timeline for `parent`, charting that note's
	 * tasks, and link the two together. Keeping the chart out of the project note
	 * leaves the project note readable and the chart free to be rearranged.
	 */
	async createTimelineNote(parent: TFile): Promise<TFile | null> {
		const path = normalizePath(`${parent.parent?.path === "/" ? "" : `${parent.parent?.path}/`}${parent.basename} — Timeline.md`);
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			const body = [
				`Timeline for [[${parent.basename}]]. Drag a row by its handle to change the order.`,
				"",
				"```gantt",
				`note: ${parent.path}`,
				"zoom: week",
				"```",
				"",
			].join("\n");
			file = await this.app.vault.create(path, body);
			new Notice(`Created ${path}`);
		}
		// link from the project note, once
		const link = `[[${(file as TFile).basename}]]`;
		await this.app.vault.process(parent, (content) =>
			content.includes(link) ? content : `${content.replace(/\s*$/, "")}\n\nTimeline: ${link}\n`,
		);
		await this.app.workspace.getLeaf(false).openFile(file as TFile);
		return file as TFile;
	}

	/**
	 * Find every note charted by a ```gantt block, so the task list can point out
	 * tasks that belong to a plan but have no dates yet.
	 */
	async scanTimelines() {
		const found = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const content = await this.app.vault.cachedRead(file);
			if (!content.includes("```gantt")) continue;
			for (const match of content.matchAll(/```gantt\r?\n([\s\S]*?)```/g)) {
				const options = parseGanttBlock(match[1], file.path);
				found.add(options.note ?? "*");
			}
		}
		const changed = found.size !== this.timelineNotes.size || [...found].some((n) => !this.timelineNotes.has(n));
		this.timelineNotes = found;
		if (changed) this.refreshViews();
	}

	private scheduleTimelineScan() {
		if (this.scanTimer) window.clearTimeout(this.scanTimer);
		this.scanTimer = window.setTimeout(() => { this.scanTimer = null; void this.scanTimelines(); }, 1500);
	}

	/** True when this task is charted somewhere but is not properly placed on it. */
	needsScheduling(task: Task): boolean {
		const charted = this.timelineNotes.has("*") || (!!task.note && this.timelineNotes.has(task.note));
		return charted && schedulingGap(task) !== null;
	}

	// ---------- helpers ----------

	async openPath(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
		else new Notice(`Not found: ${path}`);
	}
}

/** Fill defaults and migrate older data shapes into the current schema. */
function normalise(stored: Partial<HubData> | null): HubData {
	const data: HubData = {
		...DEFAULT_DATA,
		...(stored ?? {}),
		version: SCHEMA_VERSION,
		filter: { ...DEFAULT_DATA.filter, ...(stored?.filter ?? {}) },
		settings: { ...DEFAULT_DATA.settings, ...(stored?.settings ?? {}) },
		deleted: { ...(stored?.deleted ?? {}) },
		tasks: [...(stored?.tasks ?? [])],
		today: { ...DEFAULT_DATA.today, ...(stored?.today ?? {}) },
	};
	// v1: done:boolean / completed:number / filter.showDone; v2 adds status, updated, due, comments
	type Legacy = Task & { done?: boolean; completed?: number | null };
	for (const task of data.tasks as Legacy[]) {
		task.comments ??= [];
		task.images ??= [];
		task.due ??= null;
		task.start ??= null;
		task.durationDays ??= null;
		task.deps ??= [];
		task.order ??= null;
		task.depLags ??= {};
		task.milestone ??= false;
		task.percent ??= null;
		task.phase ??= null;
		task.owner ??= null;
		task.baseline ??= null;
		if (!task.status) task.status = task.done ? "closed" : "open";
		if (task.closedAt === undefined) task.closedAt = task.completed ?? null;
		task.updated ??= Math.max(task.created ?? 0, task.closedAt ?? 0, ...task.comments.map((c) => c.time));
		delete task.done;
		delete task.completed;
	}
	const legacyFilter = data.filter as Filter & { showDone?: boolean };
	if (!legacyFilter.status) legacyFilter.status = "open";
	delete legacyFilter.showDone;
	return data;
}

function pruneTombstones(data: HubData) {
	const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
	for (const [id, ts] of Object.entries(data.deleted)) if (ts < cutoff) delete data.deleted[id];
}

/**
 * Merge our in-memory state (which contains the change we are about to save) over a
 * version of the file written by another device. Per task the most recently updated
 * copy wins; a tombstone newer than the task removes it; master lists are unioned.
 */
function mergeData(theirs: HubData, mine: HubData): HubData {
	const deleted: Record<string, number> = { ...theirs.deleted };
	for (const [id, ts] of Object.entries(mine.deleted)) deleted[id] = Math.max(ts, deleted[id] ?? 0);

	const byId = new Map<string, Task>();
	for (const t of theirs.tasks) byId.set(t.id, t);
	for (const t of mine.tasks) {
		const other = byId.get(t.id);
		if (!other || t.updated >= other.updated) byId.set(t.id, t);
	}
	const tasks = Array.from(byId.values()).filter((t) => !(deleted[t.id] > t.updated));

	const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
	// Today: the device on the later day wins the focus list; the newest suggestion
	// wins regardless, since the morning job writes it straight into the file.
	const newer = (theirs.today?.date ?? "") > (mine.today?.date ?? "") ? theirs.today : mine.today;
	const suggestions = [theirs.today?.suggestion, mine.today?.suggestion].filter((x): x is NonNullable<typeof x> => !!x);
	const suggestion = suggestions.sort((a, b) => b.generatedAt - a.generatedAt)[0] ?? null;

	return {
		...theirs,
		types: union(theirs.types, mine.types),
		notes: union(theirs.notes, mine.notes),
		tasks,
		deleted,
		filter: mine.filter,
		settings: mine.settings,
		today: { ...newer, suggestion },
	};
}

const SYNC_GRACE_MS = 30_000;
const BRIEF_ATTEMPT_KEY = "task-hub-brief-attempt";

/** A sentence for the Today view; the full error goes to the console. */
function describeBriefError(e: unknown): string {
	if (e instanceof Anthropic.AuthenticationError) return "the API key was rejected — check it in Settings";
	if (e instanceof Anthropic.PermissionDeniedError) return "this API key isn't allowed to use Claude Opus 5";
	if (e instanceof Anthropic.RateLimitError) return "rate limited — try again in a minute";
	if (e instanceof Anthropic.APIConnectionError) return "couldn't reach Anthropic — check the connection";
	if (e instanceof Anthropic.APIError) return `Anthropic returned an error (${e.status ?? "unknown"})`;
	return e instanceof Error ? e.message : String(e);
}
